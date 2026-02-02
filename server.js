import { serverLogs, terminalLog } from './lib/logger-init.js';
import express from 'express';
import ssdp from 'node-ssdp';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import xml2js from 'xml2js';
import Renderer from './lib/renderer.js';
import MediaServer from './lib/media-server.js';
import sonos from 'sonos';
import fs from 'fs';
import { setupLocalDlna, getLocalIp, SERVER_UDN, updateLocalDlnaName } from './lib/local-dlna-server.js';
import multer from 'multer';
import * as mm from 'music-metadata';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { promises as fsp } from 'fs';

const { Client } = ssdp;
const { DeviceDiscovery } = sonos;
const hostIp = getLocalIp();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEVICES_FILE = path.join(__dirname, 'devices.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const app = express();
const port = 3000;

// Ensure directories exist
if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
if (!fs.existsSync(path.join(__dirname, 'local'))) fs.mkdirSync(path.join(__dirname, 'local'), { recursive: true });

app.use(express.json());


app.use((req, res, next) => {
    terminalLog(`${req.method} ${req.url}`);
    next();
});

// setupLocalDlna will be called after settings are loaded below

// Store discovered devices
let devices = new Map();

function loadDevices() {
    try {
        if (fs.existsSync(DEVICES_FILE)) {
            const data = fs.readFileSync(DEVICES_FILE, 'utf8');
            const list = JSON.parse(data);
            list.forEach(d => {
                // Skip any stale entries for the local server from previous runs on different IPs
                if (d.udn === SERVER_UDN || (d.friendlyName && d.friendlyName.includes('Media Library'))) {
                    return;
                }
                if (d.location) devices.set(d.location, d);
                if (d.udn) devices.set(d.udn, d);
            });
            console.log(`Loaded ${devices.size / 2} devices from storage (filtered).`);
        }
    } catch (err) {
        console.error('Failed to load devices:', err.message);
    }
}

function saveDevices() {
    try {
        const uniqueDevices = [];
        const seenUdns = new Set();
        for (const device of devices.values()) {
            if (device.udn && !seenUdns.has(device.udn)) {
                uniqueDevices.push(device);
                seenUdns.add(device.udn);
            }
        }
        fs.writeFileSync(DEVICES_FILE, JSON.stringify(uniqueDevices, null, 2));
    } catch (err) {
        console.error('Failed to save devices:', err.message);
    }
}

let settings = {
    discogsToken: '',
    s3: {
        endpoint: '',
        region: 'auto',
        accessKeyId: '',
        secretAccessKey: '',
        bucket: '',
        enabled: false
    },
    deviceName: 'AMMUI'
};

let s3SyncStatus = {
    running: false,
    lastSync: null,
    lastError: null,
    currentFile: '',
    syncedCount: 0,
    totalCount: 0
};

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            const loaded = JSON.parse(data);
            settings = {
                ...settings,
                ...loaded,
                s3: { ...settings.s3, ...(loaded.s3 || {}) },
                deviceName: loaded.deviceName || settings.deviceName
            };
            console.log('Loaded settings from storage.');
        }
    } catch (err) {
        console.error('Failed to load settings:', err.message);
    }
}

function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (err) {
        console.error('Failed to save settings:', err.message);
    }
}

function findCaseInsensitivePath(parent, name) {
    if (!fs.existsSync(parent)) return path.join(parent, name);
    try {
        const files = fs.readdirSync(parent);
        const match = files.find(f => f.toLowerCase() === name.toLowerCase());
        if (match) {
            const fullPath = path.join(parent, match);
            if (fs.statSync(fullPath).isDirectory()) {
                return fullPath;
            }
        }
    } catch (e) {
        // Fallback
    }
    return path.join(parent, name);
}

loadDevices();
loadSettings();
setupLocalDlna(app, port, settings.deviceName);

// Manually inject the local server into the devices map on startup
// so it's always available even if SSDP discovery is slow or blocked.
(function injectLocalServer() {
    const localLocation = `http://${hostIp}:${port}/dlna/description.xml`;
    const localServer = {
        udn: SERVER_UDN,
        location: localLocation,
        friendlyName: `${settings.deviceName} Media Library`,
        type: 'server',
        isServer: true,
        isRenderer: false,
        iconUrl: '/amm-icon.png',
        lastSeen: Date.now()
    };
    devices.set(localLocation, localServer);
    devices.set(SERVER_UDN, localServer);
    console.log(`[DEBUG] Manually injected local server at ${localLocation}`);
})();

async function syncToS3() {
    if (s3SyncStatus.running) return;
    if (!settings.s3.enabled || !settings.s3.bucket || !settings.s3.accessKeyId) {
        console.log('[S3] Sync skipped: Not configured or disabled.');
        return;
    }

    try {
        console.log('[S3] Starting sync...');
        s3SyncStatus.running = true;
        s3SyncStatus.syncedCount = 0;
        s3SyncStatus.totalCount = 0;
        s3SyncStatus.lastError = null;

        const s3 = new S3Client({
            endpoint: settings.s3.endpoint || undefined,
            region: settings.s3.region || 'auto',
            credentials: {
                accessKeyId: settings.s3.accessKeyId,
                secretAccessKey: settings.s3.secretAccessKey
            },
            forcePathStyle: false
        });

        const localDir = path.join(__dirname, 'local');
        if (!fs.existsSync(localDir)) return;

        const allFiles = [];
        async function walk(dir) {
            const files = await fsp.readdir(dir, { withFileTypes: true });
            for (const file of files) {
                const res = path.resolve(dir, file.name);
                if (file.isDirectory()) {
                    await walk(res);
                } else {
                    allFiles.push(res);
                }
            }
        }

        await walk(localDir);
        s3SyncStatus.totalCount = allFiles.length;

        for (const filePath of allFiles) {
            const devicePrefix = settings.deviceName.replace(/[<>:"/\\|?*]/g, '_');
            const relativePath = `${devicePrefix}/${path.relative(localDir, filePath).replace(/\\/g, '/')}`;
            s3SyncStatus.currentFile = relativePath;

            try {
                // Check if file already exists in S3 (basic check)
                try {
                    await s3.send(new HeadObjectCommand({
                        Bucket: settings.s3.bucket,
                        Key: relativePath
                    }));
                    // console.log(`[S3] Skipping ${relativePath} (exists)`);
                    s3SyncStatus.syncedCount++;
                    continue;
                } catch (e) {
                    // Not found, proceed with upload
                }

                console.log(`[S3] Uploading ${relativePath}...`);
                const fileStream = fs.createReadStream(filePath);
                const parallelUploads3 = new Upload({
                    client: s3,
                    params: {
                        Bucket: settings.s3.bucket,
                        Key: relativePath,
                        Body: fileStream,
                        ContentType: 'audio/mpeg' // fallback, could be better
                    },
                    queueSize: 4,
                    partSize: 5 * 1024 * 1024,
                    leavePartsOnError: false,
                });

                await parallelUploads3.done();
                s3SyncStatus.syncedCount++;
            } catch (err) {
                console.error(`[S3] Failed to upload ${relativePath}:`, err.message);
                s3SyncStatus.lastError = `Upload failed for ${relativePath}: ${err.message}`;
                // Continue with next file
            }
        }

        s3SyncStatus.lastSync = new Date().toISOString();
        console.log(`[S3] Sync complete! ${s3SyncStatus.syncedCount}/${s3SyncStatus.totalCount} files processed.`);
    } catch (err) {
        console.error('[S3] Global Sync Error:', err);
        s3SyncStatus.lastError = err.message;
    } finally {
        s3SyncStatus.running = false;
        s3SyncStatus.currentFile = '';
    }
}

// Daily Sync (every 24 hours)
setInterval(syncToS3, 86400000);
// Run first sync after 24 hours
setTimeout(syncToS3, 86400000);
// Cache renderer instances to avoid recreating them on every API call
let rendererCache = new Map();
let ssdpRegistry = new Map(); // ip -> { services: Set, lastSeen: timestamp }

const ssdpClient = new Client({
    // Explicitly bind to help on multi-NIC systems
    explicitSocketBind: true,
    reuseAddr: true
});

// Search targets for OpenHome/DLNA Renderers and Media Servers
const SEARCH_TARGETS_SERVERS = [
    'urn:schemas-upnp-org:device:MediaServer:1',
    'urn:schemas-upnp-org:service:ContentDirectory:1',
    'upnp:rootdevice',
    'ssdp:all'
];

const SEARCH_TARGETS_RENDERERS = [
    'urn:schemas-upnp-org:device:MediaRenderer:1',
    'urn:schemas-upnp-org:service:AVTransport:1',
    'urn:av-openhome-org:service:Product:1',
    'urn:linn-co-uk:device:NetReceiver:1',
    'urn:schemas-upnp-org:device:ZonePlayer:1'
];

async function parseDescription(url, isServer, isRenderer) {
    try {
        console.log(`Fetching description from ${url}...`, isServer, isRenderer);
        const response = await axios.get(url, { timeout: 10000 });
        let result;
        if (typeof response.data === 'object' && response.data !== null) {
            result = response.data;
        } else if (typeof response.data === 'string' && response.data.trim().startsWith('<')) {
            const parser = new xml2js.Parser({ explicitArray: false });
            result = await parser.parseStringPromise(response.data);
        } else if (typeof response.data === 'string' && (response.data.trim().startsWith('{') || response.data.trim().startsWith('['))) {
            result = JSON.parse(response.data);
        } else {
            throw new Error(`Invalid description format: starts with ${typeof response.data === 'string' ? response.data.trim().substring(0, 5) : typeof response.data}`);
        }

        const device = result.root ? result.root.device : (result.device || result);

        const services = [];
        const extractServices = (dev, depth = 0) => {
            if (depth > 5) return; // Prevent infinite recursion
            if (!dev) return;

            if (dev.serviceList && dev.serviceList.service) {
                const list = Array.isArray(dev.serviceList.service) ? dev.serviceList.service : [dev.serviceList.service];
                list.forEach(s => {
                    services.push({
                        serviceType: s.serviceType,
                        serviceId: s.serviceId,
                        controlURL: new URL(s.controlURL, url).toString(),
                        eventSubURL: new URL(s.eventSubURL, url).toString(),
                        SCPDURL: new URL(s.SCPDURL, url).toString()
                    });
                });
            }
            if (dev.deviceList && dev.deviceList.device) {
                const subDevices = Array.isArray(dev.deviceList.device) ? dev.deviceList.device : [dev.deviceList.device];
                subDevices.forEach(d => extractServices(d, depth + 1));
            }
        };
        extractServices(device);
        console.log(`Extracted ${services.length} services from ${url}`);
        for (const service of services) {
            console.log(`Service: ${service.serviceType}`);
        }

        let type = 'unknown';
        const hasOpenHome = services.some(s => s.serviceType.includes('Playlist'));
        const manufacturer = (device.manufacturer || '').toLowerCase();
        const model = (device.modelName || '').toLowerCase();
        const hasSonos = manufacturer.includes('sonos') || model.includes('sonos') || services.some(s => s.serviceType.includes('Queue'));
        const hasAVTransport = services.some(s => s.serviceType.includes('AVTransport'));
        const hasContentDirectory = services.some(s => s.serviceType.includes('ContentDirectory'));

        const isRendererType = isRenderer || hasOpenHome || hasSonos || hasAVTransport;
        const isServerType = isServer || hasContentDirectory;

        if (isRendererType && isServerType) {
            type = 'both';
        } else if (isRendererType) {
            type = 'renderer';
        } else if (isServerType) {
            type = 'server';
        }

        let iconUrl = null;
        const iconList = device.iconList || device.IconList;
        if (iconList) {
            console.log(`[DEBUG] Found iconList for ${device.friendlyName}`);
            const icons = iconList.icon || iconList.Icon;
            if (icons) {
                const iconArray = Array.isArray(icons) ? icons : [icons];
                const bestIcon = iconArray.sort((a, b) => (parseInt(b.width) || 0) - (parseInt(a.width) || 0))[0];
                if (bestIcon && (bestIcon.url || bestIcon.URL)) {
                    iconUrl = new URL(bestIcon.url || bestIcon.URL, url).toString();
                    console.log(`[DEBUG] Selected iconUrl: ${iconUrl}`);
                }
            }
        }

        return {
            friendlyName: device.friendlyName,
            manufacturer: device.manufacturer,
            modelName: device.modelName,
            location: url,
            udn: device.UDN,
            iconUrl: iconUrl,
            services: services,
            type: type,
            isRenderer: isRendererType,
            isServer: isServerType,
            isSonos: hasSonos
        };
    } catch (err) {
        console.error(`Failed to fetch description from ${url}:`, err.message);
        return null;
    }
}

async function handleSSDPMessage(headers, rinfo) {
    const location = headers.LOCATION;
    if (!location) return;

    const st = (headers.ST || headers.NT || '').toLowerCase();
    const serverHeader = (headers.SERVER || '').toLowerCase();
    const ip = rinfo.address;

    // Track in registry
    if (!ssdpRegistry.has(ip)) {
        ssdpRegistry.set(ip, { services: new Set(), lastSeen: Date.now() });
    }
    const regEntry = ssdpRegistry.get(ip);
    regEntry.services.add(st);
    regEntry.lastSeen = Date.now();

    // Log only if it's a first discovery of a high-value target
    const isNewHost = regEntry.services.size === 1;

    if (!devices.has(location)) {
        // Broad initial detection
        const isServer = st.includes('mediaserver') || st.includes('contentdirectory');
        const isSonosSSDP = st.includes('zoneplayer') || serverHeader.includes('sonos') || serverHeader.includes('play:');
        const isRenderer = st.includes('mediarenderer') || st.includes('avtransport') || st.includes('playlist') || isSonosSSDP;
        const isGeneric = st.includes('rootdevice') || st.includes('upnp:rootdevice');

        if (!isServer && !isRenderer && !isGeneric) {
            return;
        }

        // PREVENT HIJACKING: If this is our own local server discovered on a different IP/interface, 
        // normally we'd ignore it to favor the primary hostIp. However, we allow it if the location
        // matches our local DLNA server structure.
        const isLocalPath = location && location.includes('/dlna/description.xml');
        if (st.includes('ammui-local-media-server') || isLocalPath) {
            const url = new URL(location);
            if (url.hostname !== hostIp) {
                console.log(`[DEBUG] Local server discovered on secondary interface/IP: ${url.hostname} (Primary: ${hostIp}). Allowing.`);
            }
        }

        const msgType = headers.ST ? 'Response' : (headers.NTS === 'ssdp:alive' ? 'Alive' : 'Announcement');
        console.log(`Discovered candidate via ${msgType} from ${rinfo.address} (Type: ${st})`);

        devices.set(location, {
            location,
            friendlyName: 'Discovering...',
            loading: true,
            type: isRenderer ? (isServer ? 'both' : 'renderer') : (isServer ? 'server' : 'unknown'),
            isSonos: isSonosSSDP,
            isRenderer,
            isServer
        });

        const deviceDetails = await parseDescription(location, isServer, isRenderer);
        if (deviceDetails) {
            const udn = deviceDetails.udn;
            const existingByUdn = udn ? devices.get(udn) : null;

            // If we already know this device by UDN, and it has moved location,
            // clean up the old location key to prevent stale "ghost" devices.
            if (existingByUdn && existingByUdn.location !== location) {
                console.log(`[DEBUG] Device ${deviceDetails.friendlyName} moved: ${existingByUdn.location} -> ${location}`);
                devices.delete(existingByUdn.location);
            }

            const merged = { ...deviceDetails, lastSeen: Date.now(), isSonos: deviceDetails.isSonos || isSonosSSDP };

            // Preserve custom name if it exists
            if (existingByUdn && existingByUdn.customName) {
                merged.customName = existingByUdn.customName;
            }

            devices.set(location, merged);
            if (udn) {
                devices.set(udn, merged);
            }
            saveDevices();
        } else {
            console.log("Removing device: " + location);
            devices.delete(location);
        }
    } else {
        const device = devices.get(location);
        if (device) {
            device.lastSeen = Date.now();

            // Re-fetch description if iconUrl is missing or if it was marked as loading previously
            // This ensures existing saved devices get their icons updated
            if (!device.iconUrl && !device.loading && (!device.lastIconCheck || Date.now() - device.lastIconCheck > 3600000)) {
                device.lastIconCheck = Date.now();
                console.log(`Re-fetching description for ${device.friendlyName} to check for icons...`);
                // We use a separate async function to not block the SSDP handler
                (async () => {
                    const details = await parseDescription(location, device.isServer, device.isRenderer);
                    if (details && details.iconUrl) {
                        console.log(`Found missing icon for ${device.friendlyName}: ${details.iconUrl}`);
                        Object.assign(device, details);
                        saveDevices();
                    }
                })();
            }

            if (device.udn) {
                const udnDevice = devices.get(device.udn);
                if (udnDevice) udnDevice.lastSeen = Date.now();
            }
        }
    }
}

ssdpClient.on('response', (headers, statusCode, rinfo) => handleSSDPMessage(headers, rinfo));
ssdpClient.on('advertise-alive', (headers, rinfo) => handleSSDPMessage(headers, rinfo));

ssdpClient.on('advertise-bye', (headers, rinfo) => {
    const location = headers.LOCATION;
    if (location && devices.has(location)) {
        const device = devices.get(location);
        console.log(`Device leaving network (bye-bye): ${device.friendlyName || location} - keeping in database.`);
        // We no longer delete on bye-bye to maintain a persistent database
    }
});

console.log('Initializing Sonos discovery listener...');
try {
    const sonosDiscovery = DeviceDiscovery();
    sonosDiscovery.on('DeviceAvailable', async (sonosDevice) => {
        const host = sonosDevice.host;
        const location = `http://${host}:1400/xml/device_description.xml`;
        const existingDevice = devices.get(location);

        if (!existingDevice || existingDevice.loading || !existingDevice.isRenderer) {
            console.log(`Sonos library found/updated candidate: ${host}`);
            devices.set(location, {
                location,
                friendlyName: `Discovering Sonos (${host})...`,
                loading: true,
                type: 'both',
                isSonos: true,
                isRenderer: true,
                isServer: true
            });
            const deviceDetails = await parseDescription(location, true, true);
            if (deviceDetails) {
                console.log(`Successfully discovered Sonos: ${deviceDetails.friendlyName}`);
                const existing = devices.get(location) || (deviceDetails.udn ? devices.get(deviceDetails.udn) : null);
                const merged = { ...deviceDetails, loading: false, lastSeen: Date.now() };

                // Preserve custom name if it exists
                if (existing && existing.customName) {
                    merged.customName = existing.customName;
                }

                devices.set(location, merged);
                if (deviceDetails.udn) {
                    devices.set(deviceDetails.udn, merged);
                }
                saveDevices();
            } else {
                console.warn(`Failed to discover Sonos details for ${host}`);
                if (!existingDevice) devices.delete(location);
                else existingDevice.loading = false;
            }
        } else {
            // Update last seen
            existingDevice.lastSeen = Date.now();
        }
    });

    sonosDiscovery.on('error', (err) => {
        console.error('Sonos discovery error:', err.message);
    });
} catch (err) {
    console.error('Failed to start Sonos discovery:', err.message);
}

app.post('/api/discover', async (_req, res) => {
    console.log('Manual discovery triggered - Searching for specific targets...');
    ssdpClient.search('ssdp:all');
    // Search for specific targets as well
    SEARCH_TARGETS_SERVERS.forEach(t => ssdpClient.search(t));
    SEARCH_TARGETS_RENDERERS.forEach(t => ssdpClient.search(t));
    res.json({ success: true });
});

// Perform initial discovery on startup
console.log('Performing startup SSDP discovery...');
ssdpClient.search('ssdp:all');
SEARCH_TARGETS_SERVERS.forEach(t => ssdpClient.search(t));
SEARCH_TARGETS_RENDERERS.forEach(t => ssdpClient.search(t));

/*setInterval(() => {
    const now = Date.now();
    for (const [location, device] of devices) {
        if (now - device.lastSeen > 5 * 60000) {
            console.log(`Device ${device.friendlyName} (${location}) has not been seen in 5 minutes, removing...`);
            devices.delete(location);
            // Also remove from renderer cache if it exists
            if (device.udn && rendererCache.has(device.udn)) {
                rendererCache.delete(device.udn);
            }
        }
    }
}, 5000);*/

// Helper function to get or create a cached renderer
function getRenderer(device) {
    if (!device.udn) {
        // If no UDN, create a new instance (shouldn't happen normally)
        return new Renderer(device);
    }

    if (!rendererCache.has(device.udn)) {
        rendererCache.set(device.udn, new Renderer(device));
    }

    return rendererCache.get(device.udn);
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/browse/:udn', async (req, res) => {
    const { udn } = req.params;
    const { objectId = '0' } = req.query;

    const device = Array.from(devices.values())
        .filter(d => d.udn === udn)
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];

    if (!device) return res.status(404).json({ error: 'Device not found' });

    if (device.loading) {
        return res.status(503).json({ error: 'Device is still being discovered, please try again' });
    }

    if (!device.services || device.services.length === 0) {
        return res.status(400).json({ error: 'Device has no services available. Try refreshing the device list.' });
    }

    try {
        const server = new MediaServer(device);
        const items = await server.browse(objectId);
        res.json({ objectId, items });
    } catch (err) {
        console.error('Failed to browse device:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Proxy endpoint for images from DLNA servers (to avoid CORS issues)
app.get('/api/proxy-image', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).send('Missing url parameter');
    }

    try {
        console.log(`[PROXY] Fetching image from: ${url}`);
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: {
                'User-Agent': 'AMMUI/1.0'
            }
        });

        // Forward the content type
        const contentType = response.headers['content-type'] || 'image/jpeg';
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        res.send(response.data);
    } catch (err) {
        console.error(`[PROXY] Failed to fetch image from ${url}:`, err.message);
        res.status(500).send('Failed to fetch image');
    }
});


app.post('/api/playlist/:udn/insert', express.json(), async (req, res) => {
    const { udn } = req.params;
    const { uri, title, artist, album, duration, protocolInfo } = req.body;
    console.log(`[DEBUG] API Insert for ${udn}: uri="${uri}", title="${title}"`);

    const device = Array.from(devices.values())
        .filter(d => d.udn === udn)
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];

    if (!device || device.loading) return res.status(404).json({ error: 'Device not found or still discovering' });

    try {
        const renderer = getRenderer(device);
        const ids = await renderer.getIdArray();
        const afterId = ids.length > 0 ? ids[ids.length - 1] : 0;

        const newId = await renderer.insertTrack({ uri, title, artist, album, duration, protocolInfo }, afterId);
        res.json({ success: true, newId });
    } catch (err) {
        console.error('Insert failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/play-folder', express.json(), async (req, res) => {
    const { udn } = req.params;
    const { serverUdn, objectId } = req.body;

    const rendererDevice = Array.from(devices.values()).find(d => d.udn === udn);
    const serverDevice = Array.from(devices.values()).find(d => d.udn === serverUdn);

    if (!rendererDevice) return res.status(404).json({ error: 'Renderer not found' });
    if (!serverDevice) return res.status(404).json({ error: 'Media Server not found' });

    try {
        const server = new MediaServer(serverDevice);
        const tracks = await server.browseRecursive(objectId);

        if (tracks.length === 0) {
            return res.json({ success: true, count: 0 });
        }

        const renderer = getRenderer(rendererDevice);

        // Clear playlist first for "Play Folder"
        await renderer.clearPlaylist();

        let lastId = 0;
        for (const track of tracks) {
            lastId = await renderer.insertTrack(track, lastId);
        }

        // Start playing the first track
        let ids = await renderer.getIdArray();
        if (ids.length > 0) {
            await renderer.seekId(ids[0]);
            await renderer.play();
        }

        res.json({ success: true, count: tracks.length });
    } catch (err) {
        console.error('Play folder failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/queue-folder', express.json(), async (req, res) => {
    const { udn } = req.params;
    const { serverUdn, objectId } = req.body;

    const rendererDevice = Array.from(devices.values()).find(d => d.udn === udn);
    const serverDevice = Array.from(devices.values()).find(d => d.udn === serverUdn);

    if (!rendererDevice) return res.status(404).json({ error: 'Renderer not found' });
    if (!serverDevice) return res.status(404).json({ error: 'Media Server not found' });

    try {
        const server = new MediaServer(serverDevice);
        const tracks = await server.browseRecursive(objectId);

        if (tracks.length === 0) {
            return res.json({ success: true, count: 0 });
        }

        const renderer = getRenderer(rendererDevice);
        let ids = await renderer.getIdArray();
        let lastId = ids.length > 0 ? ids[ids.length - 1] : 0;

        for (const track of tracks) {
            lastId = await renderer.insertTrack(track, lastId);
        }

        res.json({ success: true, count: tracks.length });
    } catch (err) {
        console.error('Queue folder failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});



app.post('/api/playlist/:udn/clear', async (req, res) => {
    const { udn } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found or still discovering' });

    try {
        const renderer = getRenderer(device);
        await renderer.clearPlaylist();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/delete/:id', async (req, res) => {
    const { udn, id } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found or still discovering' });

    try {
        const renderer = getRenderer(device);
        await renderer.deleteTrack(id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/play', async (req, res) => {
    const { udn } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found or still discovering' });
    try {
        const renderer = getRenderer(device);
        await renderer.play();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/pause', async (req, res) => {
    const { udn } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found or still discovering' });
    try {
        const renderer = getRenderer(device);
        await renderer.pause();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/stop', async (req, res) => {
    const { udn } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found or still discovering' });
    try {
        const renderer = getRenderer(device);
        await renderer.stop();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/seek/:id', async (req, res) => {
    const { udn, id } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found or still discovering' });
    try {
        const renderer = getRenderer(device);
        await renderer.seekId(id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/seek-time/:seconds', async (req, res) => {
    const { udn, seconds } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found' });
    try {
        const renderer = getRenderer(device);
        await renderer.seekTime(parseInt(seconds, 10));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/playlist/:udn/status', async (req, res) => {
    const { udn } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found' });
    try {
        const renderer = getRenderer(device);
        const status = await renderer.getCurrentStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/playlist/:udn/volume', async (req, res) => {
    const { udn } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found' });
    try {
        const renderer = getRenderer(device);
        const volume = await renderer.getVolume();
        res.json({ volume });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/volume', express.json(), async (req, res) => {
    const { udn } = req.params;
    const { volume } = req.body;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found' });
    try {
        const renderer = getRenderer(device);
        await renderer.setVolume(volume);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/playlist/:udn/eq', async (req, res) => {
    const { udn } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found' });
    try {
        const renderer = getRenderer(device);
        const eq = await renderer.getEQ();
        res.json(eq || { bass: 0, treble: 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/eq', express.json(), async (req, res) => {
    const { udn } = req.params;
    const { type, value } = req.body;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found' });
    try {
        const renderer = getRenderer(device);
        await renderer.setEQ(type, value);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/playlist/:udn', async (req, res) => {
    const { udn } = req.params;
    console.error(`[DEBUG] Playlist requested for UDN: ${udn}`);
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) {
        console.error(`[DEBUG] Device not found or loading for UDN: ${udn}`);
        return res.status(404).json({ error: 'Device not found or still discovering' });
    }

    console.error(`[DEBUG] Fetching playlist for device: ${device.friendlyName}`);
    try {
        const renderer = getRenderer(device);
        const items = await renderer.getPlaylist();
        console.error(`[DEBUG] Playlist fetch returned ${items.length} items`);
        res.json(items);
    } catch (err) {
        console.error('Playlist fetch failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/diag/probe/:ip', async (req, res) => {
    const { ip } = req.params;
    const paths = [
        ':8080/description.xml',
        ':4000/description.xml',
        ':2869/upnphost/udhisapi.dll?Controliee=1', // Windows Media
        ':8200/rootDesc.xml', // MiniDLNA
        ':4040/description.xml', // Subsonic usually
        ':1400/xml/device_description.xml' // Sonos
    ];

    let results = [];
    for (const p of paths) {
        const url = `http://${ip}${p}`;
        try {
            console.log(`Diagnostic: Probing ${url}...`);
            const response = await axios.get(url, { timeout: 2000 });
            results.push({ url, status: response.status, found: true });
        } catch (err) {
            results.push({ url, error: err.message, found: false });
        }
    }
    res.json({ ip, results });
});

app.get('/api/devices', (_req, res) => {
    const uniqueDevicesMap = new Map();

    // Sort devices by lastSeen descending so we keep the freshest one
    const devList = Array.from(devices.values()).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

    for (const device of devList) {
        if (!device.udn) {
            if (!device.loading) uniqueDevicesMap.set(device.location, device);
            continue;
        }
        if (!uniqueDevicesMap.has(device.udn)) {
            uniqueDevicesMap.set(device.udn, device);
        }
    }
    res.json(Array.from(uniqueDevicesMap.values()));
});

app.delete('/api/devices/:udn', (req, res) => {
    const { udn } = req.params;
    console.log(`Manually deleting device: ${udn}`);

    // Find device by UDN to get its location
    let locationToDelete = null;
    for (const device of devices.values()) {
        if (device.udn === udn) {
            locationToDelete = device.location;
            break;
        }
    }

    if (udn) devices.delete(udn);
    if (locationToDelete) devices.delete(locationToDelete);

    // Also remove from cache
    if (rendererCache.has(udn)) {
        rendererCache.delete(udn);
    }

    saveDevices();
    res.json({ success: true });
});

app.post('/api/devices/:udn/toggle-disabled/:role', (req, res) => {
    const { udn, role } = req.params;

    // role should be 'server' or 'player'
    const property = role === 'server' ? 'disabledServer' : 'disabledPlayer';

    // Use a Set to track objects we've already toggled, in case multiple keys point to the same object
    const toggledObjects = new Set();
    let found = false;
    let deviceRef = null;

    for (const [key, device] of devices.entries()) {
        if (device.udn === udn && !toggledObjects.has(device)) {
            device[property] = !device[property];
            deviceRef = device;
            toggledObjects.add(device);
            found = true;
        }
    }

    if (!found) return res.status(404).json({ error: 'Device not found' });

    saveDevices();
    res.json({ success: true, disabled: deviceRef[property] });
});

app.post('/api/devices/:udn/rename', express.json(), (req, res) => {
    const { udn } = req.params;
    const { customName } = req.body;

    const toggledObjects = new Set();
    let found = false;

    for (const [key, device] of devices.entries()) {
        if (device.udn === udn && !toggledObjects.has(device)) {
            device.customName = customName;
            toggledObjects.add(device);
            found = true;
        }
    }

    if (!found) return res.status(404).json({ error: 'Device not found' });

    saveDevices();
    res.json({ success: true, customName: customName });
});

app.get('/api/settings/discogs', (req, res) => {
    // We only return whether it's set and a masked version for UI
    const token = settings.discogsToken || '';
    const hasToken = token.length > 0;
    const maskedToken = hasToken ? token.substring(0, 4) + '****************' : '';
    res.json({ hasToken, maskedToken });
});

app.post('/api/settings/discogs', express.json(), (req, res) => {
    const { token } = req.body;
    settings.discogsToken = token || '';
    saveSettings();
    console.log(`Discogs token ${token ? 'updated' : 'removed'} on server.`);
    res.json({ success: true });
});

app.get('/api/settings/s3', (req, res) => {
    const s3 = { ...settings.s3 };
    // Mask secret
    if (s3.secretAccessKey) {
        s3.secretAccessKey = s3.secretAccessKey.substring(0, 4) + '****************';
    }
    res.json(s3);
});

app.post('/api/settings/s3', express.json(), (req, res) => {
    const newS3 = req.body;
    // If it's masked, preserve existing
    if (newS3.secretAccessKey && newS3.secretAccessKey.includes('****')) {
        newS3.secretAccessKey = settings.s3.secretAccessKey;
    }
    settings.s3 = { ...settings.s3, ...newS3 };
    saveSettings();
    console.log('[S3] Settings updated.');
    res.json({ success: true });
});

app.get('/api/settings/general', (req, res) => {
    res.json({ deviceName: settings.deviceName });
});

app.post('/api/settings/general', express.json(), (req, res) => {
    const { deviceName } = req.body;
    if (deviceName) {
        settings.deviceName = deviceName;
        saveSettings();
        console.log(`Device name updated to: ${deviceName}`);
        updateLocalDlnaName(deviceName);
    }
    res.json({ success: true });
});

app.get('/api/sync/s3/status', (req, res) => {
    res.json(s3SyncStatus);
});

app.post('/api/sync/s3/start', (req, res) => {
    if (s3SyncStatus.running) return res.status(400).json({ error: 'Sync already running' });
    syncToS3(); // Trigger async
    res.json({ success: true });
});

const upload = multer({ dest: 'uploads/' });

app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        console.log(`Processing upload: ${req.file.originalname}`);
        const metadata = await mm.parseFile(req.file.path);
        const artist = metadata.common.artist || 'Unknown Artist';
        const album = metadata.common.album || 'Unknown Album';
        const title = metadata.common.title || path.basename(req.file.originalname, path.extname(req.file.originalname));

        const localDir = path.join(__dirname, 'local');
        const safeArtist = artist.replace(/[<>:"/\\|?*]/g, '_');
        const safeAlbum = album.replace(/[<>:"/\\|?*]/g, '_');
        const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_');

        const ext = path.extname(req.file.originalname);
        const artistDir = findCaseInsensitivePath(localDir, safeArtist);
        const targetDir = findCaseInsensitivePath(artistDir, safeAlbum);

        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const targetPath = path.join(targetDir, `${safeTitle}${ext}`);

        // Move the file from temp to target (using copy + unlink because rename cross-device may fail)
        fs.copyFileSync(req.file.path, targetPath);
        fs.unlinkSync(req.file.path);

        console.log(`Uploaded and saved: ${targetPath}`);
        res.json({ success: true, path: targetPath, artist, album, title });
    } catch (err) {
        console.error('Upload processing error:', err);
        // Clean up temp file if it exists
        if (req.file && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch (e) { }
        }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/delete', express.json(), async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID (path) is required' });

    try {
        const localDir = path.join(__dirname, 'local');
        // Ensure id is a relative path and doesn't try to escape the local directory
        const safeId = path.normalize(id).replace(/^(\.\.(\/|\\|$))+/, '');
        const filePath = path.join(localDir, safeId);

        console.log(`Requested deletion of ${id} -> ${filePath}`);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
            console.log(`Deleted directory: ${filePath}`);
        } else {
            fs.unlinkSync(filePath);
            console.log(`Deleted file: ${filePath}`);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

async function downloadFileHelper(uri, title, artist, album) {
    const localDir = path.join(__dirname, 'local');

    // Sanitize components
    const safeArtist = (artist || 'Unknown Artist').replace(/[<>:"/\\|?*]/g, '_');
    const safeAlbum = (album || 'Unknown Album').replace(/[<>:"/\\|?*]/g, '_');
    const safeTitle = (title || 'Track').replace(/[<>:"/\\|?*]/g, '_');

    // Create target directory structure: local/[Artist]/[Album]
    const artistDir = findCaseInsensitivePath(localDir, safeArtist);
    const targetDir = findCaseInsensitivePath(artistDir, safeAlbum);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    // Get extension from URI or default to .mp3
    let ext = '.mp3';
    try {
        const url = new URL(uri);
        const pathname = url.pathname;
        const foundExt = path.extname(pathname);
        if (foundExt && foundExt.length >= 3 && foundExt.length <= 5) ext = foundExt;
    } catch (e) { }

    const filename = `${safeTitle}${ext}`;
    const filePath = path.join(targetDir, filename);

    if (fs.existsSync(filePath)) {
        console.log(`Skipping download, file already exists: ${filename}`);
        return { success: true, filename, skipped: true };
    }

    console.log(`Downloading ${uri} to ${filePath}...`);

    const response = await axios({
        method: 'get',
        url: uri,
        responseType: 'stream',
        timeout: 60000 // Increased timeout for larger files
    });

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        writer.on('finish', () => {
            console.log(`Download finished: ${filename}`);
            resolve({ success: true, filename });
        });

        writer.on('error', (err) => {
            console.error('Writer error:', err);
            reject(new Error(`Failed to write file ${filename}`));
        });
    });
}

app.post('/api/download', express.json(), async (req, res) => {
    const { uri, title, artist, album } = req.body;
    if (!uri) return res.status(400).json({ error: 'URI is required' });

    try {
        const result = await downloadFileHelper(uri, title, artist, album);
        res.json(result);
    } catch (err) {
        console.error('Download error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/download-folder', express.json(), async (req, res) => {
    const { udn, objectId, title, artist, album } = req.body;
    if (!udn || !objectId) return res.status(400).json({ error: 'UDN and ObjectID are required' });

    const device = Array.from(devices.values())
        .filter(d => d.udn === udn)
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];

    if (!device) return res.status(404).json({ error: 'Device not found' });

    try {
        const server = new MediaServer(device);
        let downloadCount = 0;
        let failCount = 0;

        const tracks = await server.browseRecursive(objectId);
        for (const track of tracks) {
            try {
                await downloadFileHelper(track.uri, track.title, track.artist || artist, track.album || album);
                downloadCount++;
            } catch (err) {
                console.error(`Failed to download ${track.title}:`, err.message);
                failCount++;
            }
        }

        res.json({ success: true, downloadCount, failCount });
    } catch (err) {
        console.error('Folder download error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/art/search', async (req, res) => {
    let { artist, album, uri } = req.query;

    // If uri is provided, try to get tags from the file to improve accuracy
    if (uri) {
        try {
            const metadata = await getTrackMetadata(uri);
            if (metadata && metadata.common) {
                if (metadata.common.artist) artist = metadata.common.artist;
                if (metadata.common.album) album = metadata.common.album;
                console.log(`[ART] Using tags from file for search: "${artist}" - "${album}"`);
            }
        } catch (e) {
            console.warn(`[ART] Failed to get tags from URI ${uri}: ${e.message}`);
        }
    }

    if (!artist && !album) return res.status(400).json({ error: 'Artist or Album is required' });

    const DISCOGS_TOKEN = settings.discogsToken;

    try {
        const queryStr = `${artist || ''} ${album || ''}`.trim();
        const normalize = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, '');

        // Clean album name by removing edition info in brackets/parentheses
        const cleanAlbumName = (albumName) => {
            if (!albumName) return '';
            // Remove content in brackets [], parentheses (), and common edition markers
            return albumName
                .replace(/\s*\[.*?\]\s*/g, ' ')  // Remove [anything]
                .replace(/\s*\(.*?\)\s*/g, ' ')  // Remove (anything)
                .replace(/\s*-\s*(Deluxe|Special|Limited|Remaster|Edition|Expanded|Anniversary).*$/i, '') // Remove edition suffixes
                .replace(/\s+/g, ' ')  // Normalize whitespace
                .trim();
        };

        // More aggressive cleaning for soundtracks and complex titles
        const getAlbumVariations = (albumName) => {
            if (!albumName) return [];

            const variations = new Set();
            variations.add(albumName); // Original

            // Clean brackets/parens
            const cleaned = cleanAlbumName(albumName);
            if (cleaned) variations.add(cleaned);

            // For soundtracks, try just the main title before the colon
            if (albumName.includes(':')) {
                const beforeColon = albumName.split(':')[0].trim();
                variations.add(beforeColon);
                variations.add(cleanAlbumName(beforeColon));
            }

            // Remove common soundtrack/compilation markers
            const withoutMarkers = albumName
                .replace(/\s*[:\-]\s*(Original|Motion Picture|Film|Movie)?\s*(Soundtrack|Score|OST).*$/i, '')
                .replace(/\s*\&\s*additional\s+music.*$/i, '')
                .replace(/\s*\[.*?\]\s*/g, ' ')
                .replace(/\s*\(.*?\)\s*/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (withoutMarkers) variations.add(withoutMarkers);

            return Array.from(variations).filter(v => v && v.length > 0);
        };

        const isFuzzyMatch = (s1, s2) => {
            const n1 = normalize(s1);
            const n2 = normalize(s2);
            if (!n1 || !n2) return false;
            if (n1 === n2) return true;

            const longer = n1.length > n2.length ? n1 : n2;
            const shorter = n1.length > n2.length ? n2 : n1;

            if (longer.includes(shorter)) {
                const ratio = shorter.length / longer.length;
                if (ratio >= 0.35) return true;
                if (shorter.length >= 15) return true;
            }
            return false;
        };

        // 1. Try Discogs
        if (DISCOGS_TOKEN) {
            // Prepare search variations
            const albumVariations = getAlbumVariations(album);

            for (let attempt = 0; attempt < albumVariations.length; attempt++) {
                const searchAlbum = albumVariations[attempt];

                try {
                    console.log(`[ART] Discogs attempt ${attempt + 1}/${albumVariations.length}: "${artist}" - "${searchAlbum}"...`);

                    // Search without type restriction to include Master releases
                    const discogsUrl = `https://api.discogs.com/database/search?artist=${encodeURIComponent(artist)}&release_title=${encodeURIComponent(searchAlbum)}&token=${DISCOGS_TOKEN}`;
                    const discogsRes = await axios.get(discogsUrl, {
                        timeout: 5000,
                        headers: { 'User-Agent': 'AMCUI/1.0' }
                    });

                    if (discogsRes.data.results && discogsRes.data.results.length > 0) {
                        console.log(`[ART] Discogs: Found ${discogsRes.data.results.length} potentials, scoring...`);

                        const scoredResults = discogsRes.data.results.map(item => {
                            let score = 0;
                            const titleParts = item.title.split(' - ');
                            const itemArtist = titleParts[0];
                            const itemAlbum = titleParts[titleParts.length - 1];

                            const artistMatch = isFuzzyMatch(itemArtist, artist);

                            // Try matching against both original and cleaned album names
                            const albumMatch = isFuzzyMatch(itemAlbum, album) ||
                                isFuzzyMatch(itemAlbum, searchAlbum) ||
                                isFuzzyMatch(cleanAlbumName(itemAlbum), cleanAlbumName(album));

                            if (!artistMatch || !albumMatch) return { item, score: -1 };

                            // Exact matches (after normalization) get high priority
                            if (normalize(itemArtist) === normalize(artist)) score += 20;
                            if (normalize(itemAlbum) === normalize(album) ||
                                normalize(itemAlbum) === normalize(searchAlbum) ||
                                normalize(cleanAlbumName(itemAlbum)) === normalize(cleanAlbumName(album))) {
                                score += 20;
                            }

                            // Master releases are usually the most "popular/official" entry
                            if (item.type === 'master') score += 50;

                            // Prefer Albums over singles/EPs
                            const format = (item.format || []).join(' ').toLowerCase();
                            if (format.includes('album')) score += 15;
                            if (format.includes('lp') || format.includes('vinyl')) score += 10;
                            if (format.includes('cd')) score += 8;

                            // Penalize things that look like bootlegs or unofficial
                            if (format.includes('unofficial') || format.includes('bootleg')) score -= 30;

                            return { item, score };
                        }).filter(r => r.score > 0)
                            .sort((a, b) => b.score - a.score);

                        // Log all scored results for debugging
                        if (scoredResults.length > 0) {
                            console.log(`[ART] Discogs: ${scoredResults.length} matches after scoring:`);
                            scoredResults.forEach((result, idx) => {
                                console.log(`[ART]   ${idx + 1}. [Score: ${result.score}] "${result.item.title}" (${result.item.type}) - ${(result.item.format || []).join(', ')}`);
                            });
                        }

                        if (scoredResults.length > 0) {
                            const bestMatch = scoredResults[0].item;
                            console.log(`[ART] SUCCESS: Selected Discogs match (Score: ${scoredResults[0].score}): "${bestMatch.title}" (${bestMatch.type})`);
                            const proxyUrl = `/api/art/proxy?url=${encodeURIComponent(bestMatch.cover_image)}`;
                            return res.json({ url: proxyUrl, source: 'discogs' });
                        }
                    }
                } catch (e) {
                    console.warn(`[ART] Discogs search attempt ${attempt + 1} failed: ${e.message}`);
                }
            }

            console.log(`[ART] Discogs: No high-confidence matches found after ${albumVariations.length} attempts.`);
        } else {
            console.log(`[ART] Discogs: Skipped (No token provided).`);
        }

        console.log(`[ART] FAILURE: No artwork found for "${queryStr}" on Discogs.`);
        res.status(404).json({ error: 'No high-confidence artwork found' });
    } catch (err) {
        console.error('[ART] Search error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/art/proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        console.log(`[PROXY] Fetching: ${url}`);
        const response = await axios.get(url, {
            responseType: 'stream',
            timeout: 10000,
            headers: {
                'User-Agent': 'AMCUI/1.0',
                'Accept': 'image/*'
            }
        });

        // Copy over relevant headers
        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for a year

        response.data.pipe(res);
    } catch (err) {
        console.error('[PROXY] Error:', err.message);
        res.status(500).json({ error: 'Failed to proxy image' });
    }
});

app.listen(port, () => {
    console.log(`AMMUI server listening at http://localhost:${port}`);
});

process.on('SIGINT', () => {
    console.log('Shutting down AMCUI...');
    ssdpClient.stop();
    // Give local DLNA server a chance to stop if it registered its own listener,
    // but force exit here as well to be sure.
    setTimeout(() => process.exit(0), 500);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, exiting...');
    ssdpClient.stop();
    process.exit(0);
});

async function getTrackMetadata(uri) {
    if (!uri) throw new Error('URI is required');
    let metadata;
    if (uri.startsWith('http')) {
        const response = await axios.get(uri, { responseType: 'stream', timeout: 10000 });
        metadata = await mm.parseStream(response.data, { mimeType: response.headers['content-type'] });
        response.data.destroy();
    } else {
        // Resolve local path if it's relative to our storage
        let localPath = uri;
        if (!fs.existsSync(localPath)) {
            // Try relative to local dir
            const localDir = path.join(__dirname, 'local');
            const absoluteLocal = path.join(localDir, uri);
            if (fs.existsSync(absoluteLocal)) localPath = absoluteLocal;
        }

        if (fs.existsSync(localPath)) {
            metadata = await mm.parseFile(localPath);
        } else {
            throw new Error(`File not found or invalid URI: ${uri}`);
        }
    }
    return metadata;
}

app.get('/api/track-metadata', async (req, res) => {
    const { uri } = req.query;
    if (!uri) return res.status(400).json({ error: 'URI is required' });

    try {
        terminalLog(`[METADATA] Fetching for: ${uri}`);

        const metadata = await getTrackMetadata(uri);

        // Flatten and simplify metadata for the client
        const result = {
            common: metadata.common,
            format: {
                duration: metadata.format.duration,
                bitrate: metadata.format.bitrate,
                sampleRate: metadata.format.sampleRate,
                bitsPerSample: metadata.format.bitsPerSample,
                numberOfChannels: metadata.format.numberOfChannels,
                codec: metadata.format.codec,
                container: metadata.format.container
            }
        };

        res.json(result);
    } catch (err) {
        terminalLog(`[METADATA] ERROR: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/logs', (req, res) => {
    const ssdpData = {};
    for (const [ip, data] of ssdpRegistry.entries()) {
        let name = 'Unknown Device';
        // Try to find a friendly name from our discovered devices
        for (const device of devices.values()) {
            try {
                if (device.location && new URL(device.location).hostname === ip) {
                    name = device.friendlyName;
                    if (name && name !== 'Discovering...') break;
                }
            } catch (e) { }
        }

        ssdpData[ip] = {
            name,
            lastSeen: new Date(data.lastSeen).toLocaleTimeString(),
            services: Array.from(data.services)
        };
    }
    res.json({ logs: serverLogs, ssdp: ssdpData });
});

// 404 Handler - MUST BE LAST
app.use((req, res) => {
    terminalLog(`[${new Date().toISOString()}] [404] ${req.method} ${req.url}`);
    res.status(404).json({ error: `Not Found: ${req.method} ${req.url}` });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(`[ERROR] ${err.stack}`);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
});
