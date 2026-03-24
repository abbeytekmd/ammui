import { serverLogs, terminalLog, clearServerLogs } from './lib/logger-init.js';
global.serverLogs = serverLogs; // Expose for internal debugging log tracking

import express from 'express';
import dns from 'dns';
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
import NodeID3 from 'node-id3';

import sizeOf from 'image-size';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { promises as fsp } from 'fs';
import VirtualRenderer from './lib/virtual-renderer.js';
import exifr from 'exifr';
import { logPlay, getTopTracks, getTopAlbums } from './lib/stats-db.js';
import AirPlayManager from './lib/airplay-manager.js';
import https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';
import AdmZip from 'adm-zip';

const execAsync = promisify(exec);

// setupLocalDlna will be called after settings are loaded below

const { Client } = ssdp;
const { DeviceDiscovery } = sonos;
const hostIp = getLocalIp();
export const BROWSER_PLAYER_UDN = 'uuid:ammui-browser-player';

const isPkg = typeof process.pkg !== 'undefined';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// When packaged with pkg, we want to store mutable files (settings, devices, stats) 
// in the same directory as the executable, not inside the read-only snapshot.
const baseDataDir = isPkg ? path.dirname(process.execPath) : __dirname;

const DEVICES_FILE = path.join(baseDataDir, 'devices.json');
const SETTINGS_FILE = path.join(baseDataDir, 'settings.json');

const app = express();
const port = 3000;

// Ensure directories exist
if (!fs.existsSync(path.join(baseDataDir, 'uploads'))) fs.mkdirSync(path.join(baseDataDir, 'uploads'), { recursive: true });
if (!fs.existsSync(path.join(baseDataDir, 'local'))) fs.mkdirSync(path.join(baseDataDir, 'local'), { recursive: true });

app.use(express.json());


app.use((req, res, next) => {
    terminalLog(`${req.method} ${req.url}`);
    next();
});

// setupLocalDlna will be called after settings are loaded below

// Store discovered devices
let devices = new Map();
let airplayManager = null;

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

                // Merge volume from settings storage when hydrating the list
                if (settings && settings.devices && settings.devices[d.udn] && settings.devices[d.udn].volume !== undefined) {
                    d.volume = settings.devices[d.udn].volume;
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
    deviceName: 'AMMUI',
    screensaver: {
        serverUdn: null,
        objectId: null,
        pathName: 'Not Set'
    },
    manualRotations: {},
    deletedPhotos: {},
    fileTags: {}
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
                deviceName: loaded.deviceName || settings.deviceName,
                screensaver: { ...settings.screensaver, ...(loaded.screensaver || {}) },
                manualRotations: loaded.manualRotations || {},
                deletedPhotos: loaded.deletedPhotos || {},
                fileTags: loaded.fileTags || {}
            };

            // Migrate legacy favourites to tags
            if (Object.keys(settings.favouritePhotos || {}).length > 0) {
                let migrated = 0;
                for (const url in settings.favouritePhotos) {
                    if (settings.favouritePhotos[url]) {
                        if (!settings.fileTags[url]) settings.fileTags[url] = [];
                        if (!settings.fileTags[url].includes('fav')) {
                            settings.fileTags[url].push('fav');
                            migrated++;
                        }
                    }
                }
                if (migrated > 0) {
                    console.log(`[MIGRATION] Migrated ${migrated} legacy favorites to tags.`);
                    saveSettings();
                }
                delete settings.favouritePhotos;
            }

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

// stats.json migration completed to play_history.db

// loadStats(); // Migrated to DB

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
airplayManager = new AirPlayManager(devices, saveDevices);
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
        lastSeen: Date.now(),
        services: [
            {
                serviceType: 'urn:schemas-upnp-org:service:ContentDirectory:1',
                controlURL: `http://${hostIp}:${port}/dlna/ContentDirectory/control`,
                eventSubURL: `http://${hostIp}:${port}/dlna/ContentDirectory/event`,
                SCPDURL: `http://${hostIp}:${port}/dlna/ContentDirectory.xml`
            },
            {
                serviceType: 'urn:schemas-upnp-org:service:ConnectionManager:1',
                controlURL: `http://${hostIp}:${port}/dlna/ConnectionManager/control`,
                eventSubURL: `http://${hostIp}:${port}/dlna/ConnectionManager/event`,
                SCPDURL: `http://${hostIp}:${port}/dlna/ConnectionManager.xml`
            }
        ]
    };
    devices.set(localLocation, localServer);
    devices.set(SERVER_UDN, localServer);
    console.log(`[DEBUG] Manually injected local server at ${localLocation}`);

    // Inject Browser Player
    const browserPlayer = {
        udn: BROWSER_PLAYER_UDN,
        location: `http://${hostIp}:${port}/virtual/browser-player`,
        friendlyName: 'Direct in the Browser',
        type: 'renderer',
        isServer: false,
        isRenderer: true,
        lastSeen: Date.now(),
        isVirtual: true
    };
    devices.set(BROWSER_PLAYER_UDN, browserPlayer);
    devices.set(browserPlayer.location, browserPlayer);
    console.log(`[DEBUG] Manually injected virtual browser player`);
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

        const localDir = path.join(baseDataDir, 'local');
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
            isRenderer: isRendererType,
            isServer: isServerType,
            isSonos: hasSonos,
            protocol: hasSonos ? 'Sonos' : 'DLNA'
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

    // PREVENT SELF-OVERWRITE: If this is our own local server (match by UDN), 
    // ignore the SSDP announcement. We handle our own server via manual injection 
    // to ensure it's always available with the correct services list.
    const usn = (headers.USN || '').toLowerCase();
    if (usn.includes(SERVER_UDN.toLowerCase())) {
        return;
    }

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

        const isLocalPath = location && location.includes('/dlna/description.xml');
        if (isLocalPath) {
            const url = new URL(location);
            if (url.hostname === hostIp || url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
                return; // our own server
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
            protocol: isSonosSSDP ? 'Sonos' : 'DLNA',
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

            // Preserve custom name and disabled states if they exist
            if (existingByUdn) {
                if (existingByUdn.customName) merged.customName = existingByUdn.customName;
                if (existingByUdn.disabledPlayer !== undefined) merged.disabledPlayer = existingByUdn.disabledPlayer;
                if (existingByUdn.disabledServer !== undefined) merged.disabledServer = existingByUdn.disabledServer;
                if (existingByUdn.volume !== undefined) merged.volume = existingByUdn.volume;
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
        console.log(`Device left: ${device ? device.friendlyName : location}`);
        devices.delete(location);
        if (device && device.udn) devices.delete(device.udn);
        saveDevices();
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

                // Preserve custom name and disabled states if they exist
                if (existing) {
                    if (existing.customName) merged.customName = existing.customName;
                    if (existing.disabledPlayer !== undefined) merged.disabledPlayer = existing.disabledPlayer;
                    if (existing.disabledServer !== undefined) merged.disabledServer = existing.disabledServer;
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

app.post('/api/airplay/discover', async (_req, res) => {
    if (airplayManager) {
        const result = await airplayManager.triggerDiscovery();
        return res.json(result);
    }
    res.status(500).json({ error: 'AirPlay Manager not initialized' });
});

app.post('/api/airplay/stop-discovery', async (_req, res) => {
    if (airplayManager) {
        const result = await airplayManager.stopDiscovery();
        return res.json(result);
    }
    res.status(500).json({ error: 'AirPlay Manager not initialized' });
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
    if (device.udn === BROWSER_PLAYER_UDN) {
        if (!rendererCache.has(BROWSER_PLAYER_UDN)) {
            rendererCache.set(BROWSER_PLAYER_UDN, new VirtualRenderer(device));
        }
        return rendererCache.get(BROWSER_PLAYER_UDN);
    }

    if (device.isAirPlay || device.protocol === 'AirPlay') {
        if (airplayManager) {
            return airplayManager.getRenderer(device);
        }
        return new Renderer(device);
    }

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

app.get('/api/stats', (req, res) => {
    try {
        const topTracks = getTopTracks(20);
        const topAlbums = getTopAlbums(20);
        res.json({ tracks: topTracks, albums: topAlbums });
    } catch (err) {
        console.error('Failed to get stats:', err);
        res.status(500).json({ error: 'Failed to retrieve statistics' });
    }
});

app.post('/api/stats/track-played', express.json(), (req, res) => {
    const { title, artist, album, serverUdn, playerUdn } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    // Resolve names from UDNs if possible
    let serverName = 'Unknown Server';
    let playerName = 'Unknown Player';

    if (serverUdn) {
        const server = devices.get(serverUdn);
        if (server) serverName = server.friendlyName;
    }

    if (playerUdn) {
        const player = devices.get(playerUdn);
        if (player) playerName = player.friendlyName;
    }

    try {
        logPlay({
            title,
            artist,
            album,
            serverUdn,
            serverName,
            playerUdn,
            playerName
        });
        res.json({ success: true });
    } catch (err) {
        console.error('Failed to log play:', err);
        res.status(500).json({ error: 'Failed to record play history' });
    }
});

// Proxy endpoint for images from DLNA servers (to avoid CORS issues)
app.get('/api/proxy-image', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).send('Missing url parameter');
    }

    if (!url.startsWith('http')) {
        // Skip proxying for local relative paths
        return res.status(400).send('Invalid URL: must be absolute (http/https)');
    }

    try {
        console.log(`[PROXY] Fetching image from: ${url}`);
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 5000, // 5s is plenty for a thumbnail
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
        console.warn(`[PROXY] Failed to fetch image from ${url}:`, err.code || err.message);
        res.status(502).send('Failed to fetch image from remote device'); // 502 Bad Gateway is more appropriate
    }
});

const uriPathCache = new Map();
const MAX_URI_CACHE = 10000;

function normalizeUriForCache(uri) {
    if (!uri) return '';
    try {
        const u = new URL(uri);
        return u.pathname + u.search;
    } catch (e) {
        return uri.replace(/^[a-zA-Z0-9+-]+:\/\/[^\/]+/, '');
    }
}

function cacheUriPath(uri, pathStr) {
    if (!uri || !pathStr) return;
    if (uriPathCache.size >= MAX_URI_CACHE) {
        const firstKey = uriPathCache.keys().next().value;
        uriPathCache.delete(firstKey);
    }
    uriPathCache.set(normalizeUriForCache(uri), pathStr);
}

app.post('/api/playlist/:udn/insert', express.json(), async (req, res) => {
    const { udn } = req.params;
    const { uri, title, artist, album, duration, protocolInfo, albumArtUrl, pathStr } = req.body;

    cacheUriPath(uri, pathStr);
    console.log(`[DEBUG] API Insert for ${udn}: uri="${uri}", title="${title}"`);

    const device = Array.from(devices.values())
        .filter(d => d.udn === udn)
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];

    if (!device || device.loading) return res.status(404).json({ error: 'Device not found or still discovering' });

    try {
        const renderer = getRenderer(device);
        const ids = await renderer.getIdArray();
        const afterId = ids.length > 0 ? ids[ids.length - 1] : 0;

        const newId = await renderer.insertTrack({ uri, title, artist, album, duration, protocolInfo, albumArtUrl }, afterId);
        res.json({ success: true, newId });
    } catch (err) {
        console.error('Insert failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/browse-recursive/:udn', async (req, res) => {
    const { udn } = req.params;
    const { objectId = '0' } = req.query;

    const device = Array.from(devices.values())
        .filter(d => d.udn === udn)
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];

    if (!device) return res.status(404).json({ error: 'Device not found' });

    try {
        const server = new MediaServer(device);
        const items = await server.browseRecursive(objectId);
        res.json({ objectId, items });
    } catch (err) {
        console.error('Failed to browse recursively:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/play-folder', express.json(), async (req, res) => {
    const { udn } = req.params;
    const { serverUdn, objectId, title, pathStr } = req.body;

    const rendererDevice = Array.from(devices.values()).find(d => d.udn === udn);
    const serverDevice = Array.from(devices.values()).find(d => d.udn === serverUdn);

    if (!rendererDevice) return res.status(404).json({ error: 'Renderer not found' });
    if (!serverDevice) return res.status(404).json({ error: 'Media Server not found' });

    try {
        const server = new MediaServer(serverDevice);
        const tracks = await server.browseRecursive(objectId, title);

        if (tracks.length === 0) {
            return res.json({ success: true, count: 0 });
        }

        const renderer = getRenderer(rendererDevice);

        // Clear playlist first for "Play Folder"
        await renderer.clearPlaylist();

        let lastId = 0;
        for (const track of tracks) {
            try {
                if (track._path) {
                    const parsedPath = JSON.parse(track._path);
                    const fullPathStr = (pathStr ? pathStr + ' / ' : '') + parsedPath.map(p => p.title).join(' / ');
                    cacheUriPath(track.uri, fullPathStr);
                } else {
                    cacheUriPath(track.uri, pathStr);
                }
            } catch (e) {
                cacheUriPath(track.uri, pathStr);
            }
            lastId = await renderer.insertTrack(track, lastId);
        }

        // Start playing the first track
        let ids = await renderer.getIdArray();
        if (ids.length > 0) {
            await renderer.seekId(ids[0]);
        }

        res.json({ success: true, count: tracks.length });
    } catch (err) {
        console.error('Play folder failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/queue-folder', express.json(), async (req, res) => {
    const { udn } = req.params;
    const { serverUdn, objectId, title, pathStr } = req.body;

    const rendererDevice = Array.from(devices.values()).find(d => d.udn === udn);
    const serverDevice = Array.from(devices.values()).find(d => d.udn === serverUdn);

    if (!rendererDevice) return res.status(404).json({ error: 'Renderer not found' });
    if (!serverDevice) return res.status(404).json({ error: 'Media Server not found' });

    try {
        const server = new MediaServer(serverDevice);
        const tracks = await server.browseRecursive(objectId, title);

        if (tracks.length === 0) {
            return res.json({ success: true, count: 0 });
        }

        const renderer = getRenderer(rendererDevice);
        let ids = await renderer.getIdArray();
        let lastId = ids.length > 0 ? ids[ids.length - 1] : 0;

        for (const track of tracks) {
            try {
                if (track._path) {
                    const parsedPath = JSON.parse(track._path);
                    const fullPathStr = (pathStr ? pathStr + ' / ' : '') + parsedPath.map(p => p.title).join(' / ');
                    cacheUriPath(track.uri, fullPathStr);
                } else {
                    cacheUriPath(track.uri, pathStr);
                }
            } catch (e) {
                cacheUriPath(track.uri, pathStr);
            }
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
    const includePlaylist = req.query.includePlaylist === 'true';
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found' });
    try {
        const renderer = getRenderer(device);

        const tasks = [
            renderer.getCurrentStatus().catch(e => { throw e; }),
            renderer.getVolume().catch(e => {
                console.warn(`[DEBUG] Failed to fetch volume during status poll for ${device.friendlyName}: ${e.message}`);
                return null;
            })
        ];

        if (includePlaylist) {
            tasks.push(renderer.getPlaylist().catch(e => {
                console.warn(`[DEBUG] Failed to fetch playlist during status poll for ${device.friendlyName}: ${e.message}`);
                return null;
            }));
        }

        const results = await Promise.all(tasks);
        const status = results[0];
        const volume = results[1];

        if (volume !== null) {
            status.volume = volume;
        }

        if (includePlaylist && results[2] !== null) {
            status.playlist = await enrichPlaylistMetadata(results[2]);
        }

        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function enrichPlaylistMetadata(playlist) {
    if (!Array.isArray(playlist)) return playlist;

    const enriched = [];
    for (const track of playlist) {
        // Only enrich local tracks that are missing artist or album
        if (track.uri && track.uri.includes('/local-files/') && (!track.artist || track.artist === 'Unknown Artist')) {
            try {
                const url = new URL(track.uri);
                const localPath = decodeURIComponent(url.pathname).replace('/local-files/', '');
                const fullPath = path.join(__dirname, 'local', localPath);

                if (fs.existsSync(fullPath)) {
                    // Try to read actual tags first
                    const tags = await mm.parseFile(fullPath);
                    if (tags.common && tags.common.artist) {
                        track.artist = tags.common.artist;
                        if (tags.common.album) track.album = tags.common.album;
                    } else {
                        // Fallback to path derivation: Artist/Album/Song
                        const pathParts = localPath.split(/[/\\]/).filter(p => p);
                        if (pathParts.length >= 3) {
                            const folderArtist = pathParts[pathParts.length - 3];
                            const folderAlbum = pathParts[pathParts.length - 2];
                            if (folderArtist !== 'local' && folderArtist !== '.') {
                                track.artist = folderArtist;
                                if (!track.album || track.album === 'Unknown Album') track.album = folderAlbum;
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn(`[ENRICH] Failed to enrich metadata for ${track.uri}:`, err.message);
            }
        }
        enriched.push(track);
    }
    return enriched;
}


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

        // Persist volume to prevent resetting back to 50% on AirPlay or Virtual devices
        device.volume = volume;
        devices.set(device.location, device);
        devices.set(device.udn, device);
        saveDevices();

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

    // If we deleted the browser player, re-inject it immediately
    // This allows users to "reset" it by forgetting, but ensures it comes back
    if (udn === BROWSER_PLAYER_UDN) {
        console.log('Re-injecting browser player after deletion');
        const browserPlayer = {
            udn: BROWSER_PLAYER_UDN,
            location: `http://${hostIp}:${port}/virtual/browser-player`,
            friendlyName: 'Direct in the Browser',
            type: 'renderer',
            isServer: false,
            isRenderer: true,
            lastSeen: Date.now(),
            isVirtual: true
        };
        devices.set(BROWSER_PLAYER_UDN, browserPlayer);
        devices.set(browserPlayer.location, browserPlayer);
    }

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
        const ext = path.extname(req.file.originalname).toLowerCase();
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.heic', '.webp'];
        const isImage = imageExtensions.includes(ext);

        let artist = 'Unknown Artist';
        let album = 'Unknown Album';
        let title = path.basename(req.file.originalname, ext);
        let targetSubDir = 'music';

        if (isImage) {
            targetSubDir = 'photos';
            try {
                const exifData = await exifr.parse(req.file.path, {
                    gps: true,
                    ifd0: true
                });
                if (exifData) {
                    if (exifData.Model) artist = exifData.Model;
                    if (exifData.DateTimeOriginal) {
                        const date = new Date(exifData.DateTimeOriginal);
                        album = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                    }
                    // For photos, we can put GPS in 'location' if available
                    if (exifData.latitude !== undefined && exifData.longitude !== undefined) {
                        // We'll store it as metadata if we had a database, for now just for pathing
                    }
                }
            } catch (exifErr) {
                console.warn(`[UPLOAD] exifr failed for ${req.file.originalname}:`, exifErr.message);
            }
        } else {
            try {
                const metadata = await mm.parseFile(req.file.path);
                artist = metadata.common.artist || 'Unknown Artist';
                album = metadata.common.album || 'Unknown Album';
                title = metadata.common.title || title;
            } catch (mmErr) {
                console.warn(`[UPLOAD] music-metadata failed for ${req.file.originalname}:`, mmErr.message);
            }
        }

        const localDir = path.join(__dirname, 'local');
        const baseDir = path.join(localDir, targetSubDir);

        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }

        const safeArtist = artist.replace(/[<>:"/\\|?*]/g, '_');
        const safeAlbum = album.replace(/[<>:"/\\|?*]/g, '_');
        const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_');

        const artistDir = findCaseInsensitivePath(baseDir, safeArtist);
        const targetDir = findCaseInsensitivePath(artistDir, safeAlbum);

        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const targetPath = path.join(targetDir, `${safeTitle}${ext}`);

        // Move the file from temp to target
        fs.copyFileSync(req.file.path, targetPath);
        fs.unlinkSync(req.file.path);

        console.log(`Uploaded and saved: ${targetPath}`);
        res.json({ success: true, path: targetPath, artist, album, title, type: isImage ? 'photo' : 'music' });
    } catch (err) {
        console.error('Upload processing error:', err);
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

    // Get extension from URI or default to .mp3
    let ext = '.mp3';
    try {
        const url = new URL(uri);
        const pathname = url.pathname;
        const foundExt = path.extname(pathname).toLowerCase();
        if (foundExt && foundExt.length >= 3 && foundExt.length <= 5) ext = foundExt;
    } catch (e) { }

    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext);
    const safeTitle = (title || (isImage ? 'Photo' : 'Track')).replace(/[<>:"/\\|?*]/g, '_');
    const filename = `${safeTitle}${ext}`;

    let targetDir;
    let tempPath = null;

    if (isImage) {
        // For pictures, we download to a temp location first to extract EXIF data
        const tempFilename = `download_${Date.now()}${ext}`;
        tempPath = path.join(__dirname, 'uploads', tempFilename);
        console.log(`Downloading image ${uri} to temp ${tempPath}...`);
    } else {
        // Music logic: local/music/[Artist]/[Album]
        const musicDir = path.join(localDir, 'music');
        const safeArtist = (artist || 'Unknown Artist').replace(/[<>:"/\\|?*]/g, '_');
        const safeAlbum = (album || 'Unknown Album').replace(/[<>:"/\\|?*]/g, '_');

        const artistDir = findCaseInsensitivePath(musicDir, safeArtist);
        targetDir = findCaseInsensitivePath(artistDir, safeAlbum);

        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
    }

    const downloadPath = tempPath || path.join(targetDir, filename);

    if (fs.existsSync(downloadPath)) {
        console.log(`Skipping download, file already exists: ${filename}`);
        return { success: true, filename, skipped: true };
    }

    console.log(`Downloading ${uri} to ${downloadPath}...`);

    const response = await axios({
        method: 'get',
        url: uri,
        responseType: 'stream',
        timeout: 60000
    });

    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(downloadPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    if (isImage) {
        // Post-process image: determine Year/Month
        let year = new Date().getFullYear().toString();
        let month = (new Date().getMonth() + 1).toString().padStart(2, '0');

        if (ext === '.jpg' || ext === '.jpeg') {
            try {
                const buffer = fs.readFileSync(downloadPath);
                const parser = exifParser.create(buffer);
                const result = parser.parse();
                if (result.tags && (result.tags.DateTimeOriginal || result.tags.CreateDate)) {
                    const timestamp = result.tags.DateTimeOriginal || result.tags.CreateDate;
                    const date = new Date(timestamp * 1000);
                    year = date.getFullYear().toString();
                    month = (date.getMonth() + 1).toString().padStart(2, '0');
                }
            } catch (e) {
                console.log(`[DOWNLOAD] EXIF parse failed for ${filename}, using current date`);
            }
        }

        const finalDir = path.join(localDir, 'pictures', year, month);
        if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

        const finalPath = path.join(finalDir, filename);
        if (fs.existsSync(finalPath)) {
            fs.unlinkSync(downloadPath);
            return { success: true, filename: filename, skipped: true };
        }

        fs.renameSync(downloadPath, finalPath);
        console.log(`Picture saved to ${finalPath}`);
        return { success: true, filename };
    }

    console.log(`Download finished: ${filename}`);
    return { success: true, filename };
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

// Screensaver Routes

// Screensaver Cache
let screensaverCache = {
    udn: null,
    objectId: null,
    images: [],
    status: 'idle', // idle, loading, ready
    timestamp: 0,
    refreshTriggered: false
};

async function refreshScreensaverCache(device, objectId) {
    if (screensaverCache.status === 'loading') return;

    console.log('[SCREENSAVER] Starting background recursive scan for', objectId);
    screensaverCache.udn = device.udn;
    screensaverCache.objectId = objectId;
    screensaverCache.status = 'loading';
    screensaverCache.images = [];

    try {
        const mediaServer = new MediaServer(device);
        // Use browseRecursive from MediaServer class
        const allItems = await mediaServer.browseRecursive(objectId, settings.screensaver.pathName || 'Home');

        // Filter for images and NOT deleted
        const images = allItems.filter(i => {
            const isImage = i.type === 'item' && (
                (i.class && i.class.toLowerCase().indexOf('imageitem') >= 0) ||
                (i.protocolInfo && i.protocolInfo.includes('image/')) ||
                (i.title && i.title.match(/\.(jpg|jpeg|png|gif|webp)$/i))
            );
            if (!isImage) return false;
            const url = i.uri || i.res;
            return !settings.deletedPhotos[url];
        });

        screensaverCache.images = images;
        screensaverCache.status = 'ready';
        screensaverCache.timestamp = Date.now();
        console.log(`[SCREENSAVER] Scan complete. Found ${images.length} images.`);
    } catch (err) {
        console.error('[SCREENSAVER] Scan failed:', err);
        screensaverCache.status = 'error';
    }
}

app.post('/api/settings/screensaver', (req, res) => {
    const { serverUdn, objectId, pathName } = req.body;
    settings.screensaver = { serverUdn, objectId, pathName };
    saveSettings();

    // Reset cache on new setting
    screensaverCache = { udn: null, objectId: null, images: [], status: 'idle', timestamp: 0 };

    console.log('[SCREENSAVER] Updated settings:', settings.screensaver);
    res.json({ success: true });
});

app.get('/api/settings/screensaver', (req, res) => {
    res.json(settings.screensaver);
});

app.get('/api/slideshow/random', async (req, res) => {
    if (!settings.screensaver || !settings.screensaver.serverUdn || !settings.screensaver.objectId) {
        return res.status(400).json({ error: 'Screensaver not configured' });
    }

    const { serverUdn, objectId } = settings.screensaver;

    // Find the device
    let device = devices.get(serverUdn);
    if (!device) {
        for (const d of devices.values()) {
            if (d.udn === serverUdn) {
                device = d;
                break;
            }
        }
    }

    if (!device) {
        return res.status(404).json({ error: 'Screensaver source device not found' });
    }

    const { mode } = req.query;

    try {
        let foundImage = null;

        // CHECK CACHE STRATEGY
        const cacheValid = screensaverCache.udn === serverUdn && screensaverCache.objectId === objectId;

        // If cache is ready and has images, use it!
        if (cacheValid && screensaverCache.status === 'ready' && screensaverCache.images.length > 0) {
            let imagesToUse = screensaverCache.images;

            if (mode === 'onThisDay') {
                const today = new Date();
                const month = today.getMonth() + 1;
                const day = today.getDate();

                imagesToUse = imagesToUse.filter(img => {
                    const dateStr = img.year || img.date || img['dc:date'];
                    if (!dateStr) return false;
                    const d = new Date(dateStr);
                    if (isNaN(d.getTime())) return false;
                    return (d.getMonth() + 1) === month && d.getDate() === day;
                });

                if (imagesToUse.length === 0) {
                    console.log(`[SCREENSAVER] No images found for "On This Day" (${month}/${day})`);
                    return res.status(404).json({ error: 'No images found for this day' });
                }
            } else if (mode === 'favourites') {
                imagesToUse = imagesToUse.filter(img => {
                    const url = img.uri || img.res;
                    return settings.fileTags?.[url]?.includes('fav');
                });

                if (imagesToUse.length === 0) {
                    console.log(`[SCREENSAVER] No images found for "Favourites"`);
                    return res.status(404).json({ error: 'No favourite photos found' });
                }
            }

            const index = Math.floor(Math.random() * imagesToUse.length);
            foundImage = imagesToUse[index];

            // HACK: If we just updated the code but the cache is old, trigger refresh
            const isLegacyPath = typeof foundImage._path === 'string' && foundImage._path && !foundImage._path.startsWith('[');
            if ((!foundImage.folderId || isLegacyPath) && !screensaverCache.refreshTriggered) {
                console.log('[SCREENSAVER] Cache is stale (missing folderId or structured path), triggering refresh');
                screensaverCache.refreshTriggered = true;
                refreshScreensaverCache(device, objectId);
            }
        } else {
            // Trigger build if needed
            if (!cacheValid || screensaverCache.status === 'idle') {
                refreshScreensaverCache(device, objectId); // Background, do not await
            }

            if (mode === 'onThisDay') {
                // On This Day requires a full scan
                return res.status(503).json({ error: 'Preparing On This Day slideshow...' });
            }

            if (mode === 'favourites') {
                // Favourites requires a full scan
                return res.status(503).json({ error: 'Preparing Favourites slideshow...' });
            }

            // FALLBACK: RANDOM WALK
            // console.log('[SCREENSAVER] Cache not ready, using Random Walk fallback');
            const mediaServer = new MediaServer(device);
            let currentId = objectId;
            let currentTitle = settings.screensaver.pathName || '';
            let attempts = 0;
            const maxAttempts = 10;
            const maxDepth = 20; // Deep dive allowed

            const randomInt = (max) => Math.floor(Math.random() * max);

            while (!foundImage && attempts < maxAttempts) {
                attempts++;
                let depth = 0;
                currentId = objectId;
                currentTitle = settings.screensaver.pathName || '';

                while (depth < maxDepth) {
                    const result = await mediaServer.browse(currentId);

                    const containers = result.filter(i => i.type === 'container');
                    const images = result.filter(i => i.type === 'item' && (
                        (i.class && i.class.toLowerCase().indexOf('imageitem') >= 0) ||
                        (i.protocolInfo && i.protocolInfo.includes('image/')) ||
                        (i.title && i.title.match(/\.(jpg|jpeg|png|gif|webp)$/i))
                    ));

                    if (images.length > 0) {
                        // If we are deep, or probabilistic stop
                        if (containers.length === 0 || Math.random() > 0.4) {
                            const candidate = images[randomInt(images.length)];
                            const url = candidate.uri || candidate.res;
                            if (!settings.deletedPhotos[url]) {
                                foundImage = candidate;
                                foundImage.folderId = currentId;
                                foundImage.folderTitle = currentTitle;
                                break;
                            }
                        }
                    }

                    if (containers.length > 0) {
                        const randomContainer = containers[randomInt(containers.length)];
                        currentId = randomContainer.id;
                        currentTitle = randomContainer.title;
                        depth++;
                    } else {
                        break;
                    }
                }
                if (foundImage) break;
            }
        }

        if (foundImage) {
            let imgUrl = foundImage.uri || foundImage.res;
            let date = foundImage.year || foundImage.date || foundImage['dc:date'] || '';
            let orientation = 1;

            // Try to detect orientation via EXIF for better display
            try {
                // Fetch first 64KB to read EXIF
                const response = await axios({
                    method: 'get',
                    url: imgUrl,
                    responseType: 'arraybuffer',
                    headers: { 'Range': 'bytes=0-65535' },
                    timeout: 2000
                });

                if (response.data) {
                    const exifData = await exifr.parse(response.data, {
                        gps: true,
                        ifd0: true
                    });
                    if (exifData) {
                        if (exifData.Orientation) orientation = exifData.Orientation;
                        if (!date && exifData.DateTimeOriginal) {
                            date = exifData.DateTimeOriginal.toISOString();
                        }
                        if (exifData.latitude !== undefined && exifData.longitude !== undefined) {
                            foundImage.lat = exifData.latitude;
                            foundImage.lon = exifData.longitude;
                        }
                        // Camera make/model
                        const make = (exifData.Make || '').trim();
                        const model = (exifData.Model || '').trim();
                        if (model) {
                            // Avoid duplicating the make if it's already in the model string
                            foundImage.camera = model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`.trim();
                        }
                        console.log(`[SCREENSAVER] exifr Parsed. Orientation: ${orientation}, Date: ${date || 'None'}, GPS: ${foundImage.lat},${foundImage.lon}, Camera: ${foundImage.camera || 'None'}`);
                    }
                }
            } catch (e) {
                // Ignore range request errors or timeouts, just show image as-is
                console.warn('[SCREENSAVER] Failed to check orientation:', e.message);
            }

            res.json({
                url: imgUrl,
                title: foundImage.title,
                date: date,
                orientation: orientation,
                manualRotation: (settings.manualRotations && settings.manualRotations[imgUrl]) || 0,
                tags: settings.fileTags?.[imgUrl] || [],
                location: foundImage._path || foundImage.location || '',
                latitude: foundImage.lat,
                longitude: foundImage.lon,
                folderId: foundImage.folderId,
                folderTitle: foundImage.folderTitle,
                camera: foundImage.camera || ''
            });
        } else {
            res.status(404).json({ error: 'No images found' });
        }

    } catch (err) {
        console.error('[SCREENSAVER] Error ignoring photo:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/slideshow/list', async (req, res) => {
    if (!settings.screensaver || !settings.screensaver.serverUdn || !settings.screensaver.objectId) {
        return res.status(400).json({ error: 'Screensaver not configured' });
    }

    const { serverUdn, objectId } = settings.screensaver;
    const { mode } = req.query;

    const cacheValid = screensaverCache.udn === serverUdn && screensaverCache.objectId === objectId;
    if (!cacheValid || screensaverCache.status !== 'ready' || screensaverCache.images.length === 0) {
        let device = devices.get(serverUdn);
        if (!device) {
            for (const d of devices.values()) {
                if (d.udn === serverUdn) { device = d; break; }
            }
        }
        if (device && (!cacheValid || screensaverCache.status === 'idle')) {
            refreshScreensaverCache(device, objectId);
        }
        return res.status(503).json({ error: 'Cache not ready yet' });
    }

    let images = screensaverCache.images;

    if (mode === 'onThisDay') {
        const today = new Date();
        const month = today.getMonth() + 1;
        const day = today.getDate();
        images = images.filter(img => {
            const dateStr = img.year || img.date || img['dc:date'];
            if (!dateStr) return false;
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return false;
            return (d.getMonth() + 1) === month && d.getDate() === day;
        });
        if (images.length === 0) {
            return res.status(404).json({ error: 'No images found for this day' });
        }
    } else if (mode === 'favourites') {
        images = images.filter(img => {
            const url = img.uri || img.res;
            return settings.fileTags?.[url]?.includes('fav');
        });
        if (images.length === 0) {
            return res.status(404).json({ error: 'No favourite photos found' });
        }
    }

    res.json(images);
});

app.post('/api/slideshow/rotate', (req, res) => {
    const { url, rotation } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    if (!settings.manualRotations) settings.manualRotations = {};

    // rotation should be 0, 90, 180, or 270
    settings.manualRotations[url] = Number(rotation);
    saveSettings();

    console.log(`[SCREENSAVER] Saved manual rotation for ${url}: ${rotation}`);
    res.json({ success: true, rotation });
});

app.post('/api/slideshow/delete', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    if (!settings.deletedPhotos) settings.deletedPhotos = {};
    settings.deletedPhotos[url] = true;
    saveSettings();

    // Also remove from current cache if present
    if (screensaverCache.images && screensaverCache.images.length > 0) {
        const initialCount = screensaverCache.images.length;
        screensaverCache.images = screensaverCache.images.filter(img => {
            const imgUrl = img.uri || img.res;
            return imgUrl !== url;
        });
        if (screensaverCache.images.length < initialCount) {
            console.log(`[SCREENSAVER] Removed deleted photo from cache. New count: ${screensaverCache.images.length}`);
        }
    }

    console.log(`[SCREENSAVER] Marked photo as deleted: ${url}`);
    res.json({ success: true });
});

app.post('/api/slideshow/favourite', (req, res) => {
    const { url, favourite } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    if (!settings.fileTags) settings.fileTags = {};
    if (!settings.fileTags[url]) settings.fileTags[url] = [];

    if (favourite) {
        if (!settings.fileTags[url].includes('fav')) settings.fileTags[url].push('fav');
    } else {
        settings.fileTags[url] = settings.fileTags[url].filter(t => t !== 'fav');
    }
    saveSettings();

    console.log(`[SCREENSAVER] Set favourite for ${url}: ${favourite}`);
    res.json({ success: true, favourite });
});

// Helper function for Discogs search
async function findDiscogsArtUrl(artist, album) {
    const DISCOGS_TOKEN = settings.discogsToken;
    if (!DISCOGS_TOKEN || (!artist && !album)) return null;

    const queryStr = `${artist || ''} ${album || ''}`.trim();
    const normalize = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, '');

    const cleanAlbumName = (albumName) => {
        if (!albumName) return '';
        return albumName
            .replace(/\s*\[.*?\]\s*/g, ' ')
            .replace(/\s*\(.*?\)\s*/g, ' ')
            .replace(/\s*-\s*(Deluxe|Special|Limited|Remaster|Edition|Expanded|Anniversary).*$/i, '')
            .replace(/\s+/g, ' ')
            .trim();
    };

    const getAlbumVariations = (albumName) => {
        if (!albumName) return [];
        const variations = new Set();
        variations.add(albumName);
        const cleaned = cleanAlbumName(albumName);
        if (cleaned) variations.add(cleaned);
        if (albumName.includes(':')) {
            const beforeColon = albumName.split(':')[0].trim();
            variations.add(beforeColon);
            variations.add(cleanAlbumName(beforeColon));
        }
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

    const fetchDiscogs = async (url) => {
        dns.setDefaultResultOrder('ipv4first');
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                },
                signal: AbortSignal.timeout(10000)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (e) {
            let detail = e.message;
            if (e.cause) detail += ` (Cause: ${e.cause.message || e.cause.code || e.cause})`;
            throw new Error(detail);
        }
    };

    const albumVariations = getAlbumVariations(album);
    for (let attempt = 0; attempt < albumVariations.length; attempt++) {
        const searchAlbum = albumVariations[attempt];
        try {
            console.log(`[ART] Discogs attempt ${attempt + 1}/${albumVariations.length}: "${artist}" - "${searchAlbum}"...`);
            const discogsUrl = `https://api.discogs.com/database/search?artist=${encodeURIComponent(artist)}&release_title=${encodeURIComponent(searchAlbum)}&token=${DISCOGS_TOKEN}`;

            const data = await fetchDiscogs(discogsUrl);

            if (data.results && data.results.length > 0) {
                const scoredResults = data.results.map(item => {
                    let score = 0;
                    const titleParts = item.title.split(' - ');
                    const itemArtist = titleParts[0];
                    const itemAlbum = titleParts[titleParts.length - 1];
                    const artistMatch = isFuzzyMatch(itemArtist, artist);
                    const albumMatch = isFuzzyMatch(itemAlbum, album) ||
                        isFuzzyMatch(itemAlbum, searchAlbum) ||
                        isFuzzyMatch(cleanAlbumName(itemAlbum), cleanAlbumName(album));

                    if (!artistMatch || !albumMatch) return { item, score: -1 };
                    if (normalize(itemArtist) === normalize(artist)) score += 20;
                    if (normalize(itemAlbum) === normalize(album) ||
                        normalize(itemAlbum) === normalize(searchAlbum) ||
                        normalize(cleanAlbumName(itemAlbum)) === normalize(cleanAlbumName(album))) {
                        score += 20;
                    }
                    if (item.type === 'master') score += 50;
                    const format = (item.format || []).join(' ').toLowerCase();
                    if (format.includes('album')) score += 15;
                    if (format.includes('lp') || format.includes('vinyl')) score += 10;
                    if (format.includes('cd')) score += 8;
                    if (format.includes('unofficial') || format.includes('bootleg')) score -= 30;
                    return { item, score };
                }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);

                if (scoredResults.length > 0) {
                    return scoredResults[0].item.cover_image;
                }
            }
        } catch (e) {
            let errorMsg = `[ART] Discogs attempt ${attempt + 1} failed: ${e.message}`;
            if (e.code) errorMsg += ` (Code: ${e.code})`;
            if (e.response) {
                // If it's an axios error with a response
                errorMsg += ` (Status: ${e.response.status}, Data: ${JSON.stringify(e.response.data)})`;
            }
            if (e.config && e.config.url) {
                errorMsg += ` | URL: ${e.config.url}`;
            }
            console.warn(errorMsg);
        }

        // Fallback: search just by album name if Artist+Album failed
        if (artist && searchAlbum) {
            try {
                console.log(`[ART] Discogs attempt ${attempt + 1} fallback (Album Only): "${searchAlbum}"...`);
                const fallbackUrl = `https://api.discogs.com/database/search?release_title=${encodeURIComponent(searchAlbum)}&token=${DISCOGS_TOKEN}`;
                const data = await fetchDiscogs(fallbackUrl);

                if (data.results && data.results.length > 0) {
                    const scoredFallbackResults = data.results.map(item => {
                        let score = 0;
                        const titleParts = item.title.split(' - ');
                        const itemAlbum = titleParts[titleParts.length - 1];

                        // For an album-only fallback search, we are much more lenient on artist matching, but we still heavily weigh exact album matches.
                        const albumMatch = isFuzzyMatch(itemAlbum, album) ||
                            isFuzzyMatch(itemAlbum, searchAlbum) ||
                            isFuzzyMatch(cleanAlbumName(itemAlbum), cleanAlbumName(album));

                        if (!albumMatch) return { item, score: -1 };

                        if (normalize(itemAlbum) === normalize(album) ||
                            normalize(itemAlbum) === normalize(searchAlbum) ||
                            normalize(cleanAlbumName(itemAlbum)) === normalize(cleanAlbumName(album))) {
                            score += 20;
                        }

                        if (item.type === 'master') score += 50;
                        const format = (item.format || []).join(' ').toLowerCase();
                        if (format.includes('album')) score += 15;
                        if (format.includes('lp') || format.includes('vinyl')) score += 10;
                        if (format.includes('cd')) score += 8;
                        if (format.includes('unofficial') || format.includes('bootleg')) score -= 30;
                        return { item, score };
                    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);

                    if (scoredFallbackResults.length > 0) {
                        return scoredFallbackResults[0].item.cover_image;
                    }
                }
            } catch (e) {
                console.warn(`[ART] Discogs fallback attempt (Album Only) failed: ${e.message}`);
            }
        }
    }
    return null;
}

app.get('/api/art/search', async (req, res) => {
    let { artist, album, uri } = req.query;

    if (uri && (!artist || !album)) {
        try {
            const metadata = await getTrackMetadata(uri);
            if (metadata && metadata.common) {
                if (metadata.common.artist) artist = metadata.common.artist;
                if (metadata.common.album) album = metadata.common.album;
            }
        } catch (e) { }
    }

    if (!artist && !album && (!uri || uri.startsWith('http'))) return res.status(400).json({ error: 'Artist or Album is required' });

    try {
        let coverUrl = null;
        if (artist || album) {
            coverUrl = await findDiscogsArtUrl(artist, album);
        }

        if (!coverUrl && uri && !uri.startsWith('http://') && !uri.startsWith('https://')) {
            const parts = uri.split(/[/\\]+/).filter(Boolean);
            if (parts.length >= 3) {
                const folderArtist = parts[parts.length - 3].trim();
                const folderAlbum = parts[parts.length - 2].trim();
                const normalize = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, '');
                if (folderArtist && normalize(folderArtist) !== normalize(artist)) {
                    console.log(`[ART] Search falling back to local folder artist: "${folderArtist}" for album "${album || folderAlbum}"`);
                    coverUrl = await findDiscogsArtUrl(folderArtist, album || folderAlbum);
                }
            }
        }

        if (!coverUrl && uri) {
            const cachedPath = uriPathCache.get(normalizeUriForCache(uri));
            if (cachedPath) {
                const parts = cachedPath.split(' / ').filter(Boolean);
                if (parts.length >= 2) {
                    const folderArtist = parts[parts.length - 2].trim();
                    const folderAlbum = parts[parts.length - 1].trim();
                    const normalize = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, '');
                    if (folderArtist && folderArtist.length > 0 && normalize(folderArtist) !== normalize(artist)) {
                        console.log(`[ART] Search falling back to UI path string artist: "${folderArtist}" for album "${album || folderAlbum}"`);
                        coverUrl = await findDiscogsArtUrl(folderArtist, album || folderAlbum);
                    }
                }
            }
        }

        if (coverUrl) {
            return res.json({ url: coverUrl, source: 'discogs' });
        }
        res.status(404).json({ error: 'No artwork found' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/art/proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        console.log(`[PROXY] Fetching: ${url}`);
        const response = await fetch(url, {
            headers: { 'User-Agent': `${settings.deviceName}/1.0` },
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        // Copy relevant headers
        if (response.headers.get('content-type')) res.setHeader('Content-Type', response.headers.get('content-type'));
        if (response.headers.get('content-length')) res.setHeader('Content-Length', response.headers.get('content-length'));
        res.setHeader('Cache-Control', 'public, max-age=31536000');

        const blob = await response.blob();
        const buffer = Buffer.from(await blob.arrayBuffer());
        res.send(buffer);
    } catch (err) {
        console.error(`[PROXY] Error fetching ${url}:`, err.message);
        res.status(500).json({ error: 'Failed to proxy image', details: err.message, url: url });
    }
});

app.get('/api/art/local', async (req, res) => {
    let { uri } = req.query;
    if (!uri) return res.status(400).json({ error: 'URI is required' });

    try {
        // 1. If it's already an image URL, redirect to proxy for efficiency
        const isImageUrl = /\.(jpg|jpeg|png|gif|webp)$/i.test(uri);
        if (isImageUrl) {
            if (uri.startsWith('http')) {
                return res.redirect(`/api/art/proxy?url=${encodeURIComponent(uri)}`);
            } else {
                // Determine absolute local path
                let localPath = uri;
                if (!fs.existsSync(localPath)) {
                    const localDir = path.join(__dirname, 'local');
                    const absoluteLocal = path.join(localDir, uri);
                    if (fs.existsSync(absoluteLocal)) localPath = absoluteLocal;
                }
                if (fs.existsSync(localPath)) {
                    return res.sendFile(path.resolve(localPath));
                }
            }
        }

        // 2. Try to look for "folder.jpg" or "cover.jpg" next to the file if it's local
        if (!uri.startsWith('http')) {
            let localPath = uri;
            if (!fs.existsSync(localPath)) {
                const localDir = path.join(__dirname, 'local');
                const absoluteLocal = path.join(localDir, uri);
                if (fs.existsSync(absoluteLocal)) localPath = absoluteLocal;
            }

            if (fs.existsSync(localPath)) {
                const dir = path.dirname(localPath);
                const artFiles = ['folder.jpg', 'cover.jpg', 'folder.png', 'cover.png', 'album.jpg', 'artwork.jpg'];
                for (const artFile of artFiles) {
                    const artPath = path.join(dir, artFile);
                    if (fs.existsSync(artPath)) {
                        console.log(`[ART] Found sidecar artwork: ${artPath}`);
                        return res.sendFile(path.resolve(artPath));
                    }
                }
            }
        }

        // 3. Fallback to extracting embedded art using getTrackMetadata
        console.log(`[ART] Analyzing file: ${uri}`);
        const metadata = await getTrackMetadata(uri);
        if (metadata && metadata.common) {
            const artist = metadata.common.artist || '';
            const album = metadata.common.album || '';
            console.log(`[ART] Metadata tags found - Artist: "${artist}", Album: "${album}"`);

            // Try embedded picture first
            if (metadata.common.picture && metadata.common.picture.length > 0) {
                const pic = metadata.common.picture[0];
                const mimeType = pic.format || pic.mime || 'image/jpeg';
                res.setHeader('Content-Type', mimeType);
                res.setHeader('Cache-Control', 'public, max-age=31536000');
                console.log(`[ART] Success: Extracted embedded art for ${uri}`);
                return res.send(pic.data);
            }

            // 4. Final Fallback: Search Discogs using extracted tags
            let searchArtist = artist;
            let searchAlbum = album;
            let coverUrl = null;

            if (searchArtist || searchAlbum) {
                console.log(`[ART] No embedded art. Attempting Discogs search for: "${searchArtist}" - "${searchAlbum}"`);
                coverUrl = await findDiscogsArtUrl(searchArtist, searchAlbum);
            }

            if (!coverUrl && uri && !uri.startsWith('http://') && !uri.startsWith('https://')) {
                const parts = uri.split(/[/\\]+/).filter(Boolean);
                if (parts.length >= 3) {
                    const folderArtist = parts[parts.length - 3].trim();
                    const folderAlbum = parts[parts.length - 2].trim();
                    const normalize = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, '');

                    if (folderArtist && (!searchArtist || normalize(folderArtist) !== normalize(searchArtist))) {
                        console.log(`[ART] Local attempting Discogs search with folder artist: "${folderArtist}" and album "${searchAlbum || folderAlbum}"`);
                        coverUrl = await findDiscogsArtUrl(folderArtist, searchAlbum || folderAlbum);
                    }
                }
            }

            if (!coverUrl && uri) {
                const cachedPath = uriPathCache.get(normalizeUriForCache(uri));
                if (cachedPath) {
                    const parts = cachedPath.split(' / ').filter(Boolean);
                    if (parts.length >= 2) {
                        const folderArtist = parts[parts.length - 2].trim();
                        const folderAlbum = parts[parts.length - 1].trim();
                        const normalize = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (folderArtist && folderArtist.length > 0 && (!searchArtist || normalize(folderArtist) !== normalize(searchArtist))) {
                            console.log(`[ART] Local proxy falling back to UI path string artist: "${folderArtist}" for album "${searchAlbum || folderAlbum}"`);
                            coverUrl = await findDiscogsArtUrl(folderArtist, searchAlbum || folderAlbum);
                        }
                    }
                }
            }

            if (coverUrl) {
                console.log(`[ART] Success: Found Discogs art for ${uri}`);
                return res.redirect(coverUrl);
            } else {
                console.log(`[ART] Skipping Discogs or no result found for ${uri}`);
            }
        }

        console.log(`[ART] No art found for: ${uri}`);
        res.status(404).json({ error: 'No artwork found' });
    } catch (err) {
        console.error(`[ART] Error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Update API routes
app.get('/api/version', async (req, res) => {
    try {
        const packageJson = JSON.parse(await fsp.readFile(path.join(__dirname, 'package.json'), 'utf8'));
        res.json({ version: packageJson.version });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read version' });
    }
});

app.get('/api/updates/check', async (req, res) => {
    let currentVersion = 'unknown';
    try {
        const packageJson = JSON.parse(await fsp.readFile(path.join(__dirname, 'package.json'), 'utf8'));
        currentVersion = packageJson.version;

        console.log('[UPDATES] Checking for updates from GitHub...');

        // Get latest release from GitHub
        const response = await axios.get('https://api.github.com/repos/abbeytekmd/ammui/releases/latest', {
            headers: {
                'User-Agent': 'AMMUI-Update-Checker'
            },
            timeout: 10000 // 10 second timeout
        });

        console.log('[UPDATES] GitHub API response received');

        if (!response.data || !response.data.tag_name) {
            console.error('[UPDATES] Invalid response from GitHub API:', response.data);
            return res.status(500).json({ error: 'Invalid response from GitHub API' });
        }

        const latestVersion = response.data.tag_name.replace('v', '');
        const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

        console.log(`[UPDATES] Current: ${currentVersion}, Latest: ${latestVersion}, Update available: ${updateAvailable}`);

        res.json({
            currentVersion,
            latestVersion,
            updateAvailable,
            releaseUrl: response.data.html_url,
            releaseNotes: response.data.body
        });
    } catch (err) {
        console.error('[UPDATES] CAUGHT ERROR in catch block');
        console.error('[UPDATES] Failed to check for updates - FULL ERROR:', err);
        console.error('[UPDATES] Error details:', {
            message: err.message,
            code: err.code,
            status: err.response?.status,
            statusText: err.response?.statusText,
            url: err.config?.url,
            isAxiosError: err.isAxiosError,
            stack: err.stack?.substring(0, 500)
        });

        // Handle specific error cases
        let errorMessage = err.message || 'Failed to check for updates';
        if (err.isAxiosError && err.response?.status === 404) {
            // No releases found - this is normal for a repository without releases
            console.log('[UPDATES] No releases found in repository - this is normal');
            return res.json({
                currentVersion,
                latestVersion: currentVersion,
                updateAvailable: false,
                releaseUrl: 'https://github.com/abbeytekmd/ammui/releases',
                releaseNotes: 'No releases available yet. Check back later for updates.',
                message: 'No releases available in the repository yet.'
            });
        } else if (err.isAxiosError && err.response?.status === 403) {
            errorMessage = 'GitHub API rate limit exceeded or access denied';
        }

        res.status(500).json({
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

app.post('/api/updates/apply', async (req, res) => {
    try {
        // Set headers for SSE
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control'
        });

        const sendProgress = (message, progress = null) => {
            res.write(`data: ${JSON.stringify({ message, progress })}\n\n`);
        };

        sendProgress('Checking for updates...', 10);

        // Get latest release info
        const releaseResponse = await axios.get('https://api.github.com/repos/abbeytekmd/ammui/releases/latest', {
            headers: { 'User-Agent': 'AMMUI-Update-Checker' }
        });

        const packageJson = JSON.parse(await fsp.readFile(path.join(__dirname, 'package.json'), 'utf8'));
        const currentVersion = packageJson.version;
        const latestVersion = releaseResponse.data.tag_name.replace('v', '');

        if (compareVersions(latestVersion, currentVersion) <= 0) {
            sendProgress('Already up to date', 100);
            res.write(`data: ${JSON.stringify({ complete: true })}\n\n`);
            res.end();
            return;
        }

        sendProgress('Downloading update...', 20);

        // Find the zip asset
        const zipAsset = releaseResponse.data.assets.find(asset =>
            asset.name.endsWith('.zip') && !asset.name.includes('pkg')
        );

        if (!zipAsset) {
            throw new Error('No update package found');
        }

        // Download the zip file
        const zipPath = path.join(baseDataDir, 'update.zip');
        const file = fs.createWriteStream(zipPath);

        const downloadResponse = await axios({
            method: 'GET',
            url: zipAsset.browser_download_url,
            responseType: 'stream',
            headers: { 'User-Agent': 'AMMUI-Update-Checker' }
        });

        let downloaded = 0;
        const totalSize = parseInt(downloadResponse.headers['content-length'], 10);

        downloadResponse.data.on('data', (chunk) => {
            downloaded += chunk.length;
            const progress = Math.round((downloaded / totalSize) * 30) + 20; // 20-50%
            sendProgress(`Downloading... ${Math.round(downloaded / 1024 / 1024)}MB`, progress);
        });

        downloadResponse.data.pipe(file);

        await new Promise((resolve, reject) => {
            file.on('finish', resolve);
            file.on('error', reject);
        });

        sendProgress('Extracting update...', 60);

        // Extract the zip file
        const zip = new AdmZip(zipPath);
        const extractPath = path.join(baseDataDir, 'update_temp');

        // Clear temp directory if it exists
        if (fs.existsSync(extractPath)) {
            fs.rmSync(extractPath, { recursive: true, force: true });
        }

        zip.extractAllTo(extractPath, true);

        sendProgress('Installing update...', 80);

        // Find the extracted directory (should be the repo name)
        const extractedDirs = fs.readdirSync(extractPath).filter(item =>
            fs.statSync(path.join(extractPath, item)).isDirectory()
        );

        if (extractedDirs.length === 0) {
            throw new Error('Invalid update package structure');
        }

        const sourceDir = path.join(extractPath, extractedDirs[0]);
        const appDir = path.dirname(__dirname);

        // Copy files (excluding certain directories)
        const excludeDirs = ['node_modules', '.git', 'local', 'uploads', 'update_temp'];
        const excludeFiles = ['devices.json', 'settings.json', 'play_history.json', 'stats.json', 'db.json'];

        await copyDirectory(sourceDir, appDir, excludeDirs, excludeFiles, (progress) => {
            sendProgress('Installing update...', 80 + Math.round(progress * 0.15));
        });

        sendProgress('Cleaning up...', 95);

        // Clean up
        fs.unlinkSync(zipPath);
        fs.rmSync(extractPath, { recursive: true, force: true });

        sendProgress('Update completed! Restarting...', 100);
        res.write(`data: ${JSON.stringify({ complete: true })}\n\n`);
        res.end();

        // Restart the application after a short delay
        setTimeout(() => {
            console.log('Update completed, restarting application...');
            process.exit(0); // The process manager should restart it
        }, 2000);

    } catch (err) {
        console.error('Update failed:', err);
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
    }
});

// Helper functions
function compareVersions(version1, version2) {
    const v1 = version1.split('.').map(Number);
    const v2 = version2.split('.').map(Number);

    for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
        const num1 = v1[i] || 0;
        const num2 = v2[i] || 0;

        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
    }

    return 0;
}

async function copyDirectory(source, destination, excludeDirs = [], excludeFiles = [], progressCallback = null) {
    const items = fs.readdirSync(source);
    let processed = 0;

    for (const item of items) {
        if (excludeDirs.includes(item)) continue;

        const sourcePath = path.join(source, item);
        const destPath = path.join(destination, item);
        const stat = fs.statSync(sourcePath);

        if (stat.isDirectory()) {
            if (!fs.existsSync(destPath)) {
                fs.mkdirSync(destPath, { recursive: true });
            }
            await copyDirectory(sourcePath, destPath, excludeDirs, excludeFiles);
        } else {
            if (!excludeFiles.includes(item)) {
                fs.copyFileSync(sourcePath, destPath);
            }
        }

        processed++;
        if (progressCallback) {
            progressCallback(processed / items.length);
        }
    }
}

app.listen(port, () => {
    console.log(`AMMUI server listening at http://localhost:${port}`);
});

process.on('SIGINT', () => {
    console.log('Shutting down AMMUI...');
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
    const isImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(uri);
    let metadata;

    if (uri.startsWith('http')) {
        const response = await axios.get(uri, { responseType: 'arraybuffer', timeout: 10000, family: 4 });
        const buffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'];

        if (isImage || (contentType && contentType.startsWith('image/'))) {
            try {
                const dimensions = sizeOf(buffer);
                metadata = {
                    common: { title: path.basename(uri) },
                    format: {
                        container: dimensions.type,
                        width: dimensions.width,
                        height: dimensions.height,
                        isImage: true
                    }
                };

                // Try to get EXIF data
                try {
                    const exif = await exifr.parse(buffer, {
                        gps: true,
                        translateKeys: true,
                        translateValues: true
                    });
                    if (exif) {
                        if (exif.DateTimeOriginal) metadata.common.date = exif.DateTimeOriginal;
                        if (exif.latitude !== undefined) metadata.format.latitude = exif.latitude;
                        if (exif.longitude !== undefined) metadata.format.longitude = exif.longitude;
                        if (exif.Make) metadata.common.make = exif.Make;
                        if (exif.Model) metadata.common.model = exif.Model;
                        if (exif.Software) metadata.common.software = exif.Software;
                    }
                } catch (e) {
                    console.warn(`[METADATA] EXIF parse failed for ${uri}: ${e.message}`);
                }
            } catch (e) {
                console.warn(`[METADATA] Failed to get image dimensions for ${uri}: ${e.message}`);
                metadata = { common: {}, format: {} };
            }
        } else {
            metadata = await mm.parseBuffer(buffer, { mimeType: contentType });
        }
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
            if (isImage) {
                try {
                    const dimensions = sizeOf(localPath);
                    const stats = fs.statSync(localPath);
                    metadata = {
                        common: { title: path.basename(localPath) },
                        format: {
                            container: dimensions.type,
                            width: dimensions.width,
                            height: dimensions.height,
                            size: stats.size,
                            isImage: true
                        }
                    };

                    // Try to get EXIF data from local file
                    try {
                        const exif = await exifr.parse(localPath, {
                            gps: true,
                            translateKeys: true,
                            translateValues: true
                        });
                        if (exif) {
                            if (exif.DateTimeOriginal) metadata.common.date = exif.DateTimeOriginal;
                            if (exif.latitude !== undefined) metadata.format.latitude = exif.latitude;
                            if (exif.longitude !== undefined) metadata.format.longitude = exif.longitude;
                            if (exif.Make) metadata.common.make = exif.Make;
                            if (exif.Model) metadata.common.model = exif.Model;
                            if (exif.Software) metadata.common.software = exif.Software;
                        }
                    } catch (e) {
                        console.warn(`[METADATA] EXIF parse failed for ${localPath}: ${e.message}`);
                    }
                } catch (e) {
                    metadata = { common: {}, format: {} };
                }
            } else {
                metadata = await mm.parseFile(localPath);
            }
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
            common: {
                ...metadata.common,
                // Ensure date is included if it was found in EXIF
                date: metadata.common.date || metadata.common.year
            },
            format: {
                duration: metadata.format.duration,
                bitrate: metadata.format.bitrate,
                sampleRate: metadata.format.sampleRate,
                bitsPerSample: metadata.format.bitsPerSample,
                numberOfChannels: metadata.format.numberOfChannels,
                codec: metadata.format.codec,
                container: metadata.format.container,
                width: metadata.format.width,
                height: metadata.format.height,
                size: metadata.format.size,
                isImage: metadata.format.isImage,
                latitude: metadata.format.latitude,
                longitude: metadata.format.longitude
            },
            tags: settings.fileTags?.[uri] || []
        };

        res.json(result);
    } catch (err) {
        terminalLog(`[METADATA] ERROR: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/file-tags', (req, res) => {
    const { uri, tags } = req.body;
    if (!uri) return res.status(400).json({ error: 'URI is required' });
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'Tags must be an array' });

    settings.fileTags[uri] = tags;
    saveSettings();
    terminalLog(`[TAGS] Updated tags for ${uri}: ${tags.join(', ')}`);
    res.json({ success: true });
});

app.get('/api/tags', (req, res) => {
    const tagsSet = new Set();
    Object.values(settings.fileTags).forEach(tags => {
        if (Array.isArray(tags)) {
            tags.forEach(t => tagsSet.add(t));
        }
    });
    const tags = Array.from(tagsSet).sort();
    res.json({ tags });
});

app.get('/api/local/va-candidates', async (req, res) => {
    const { albumTitle } = req.query;
    if (!albumTitle) return res.status(400).json({ error: 'Album title required' });

    const localDir = path.join(__dirname, 'local');
    const results = [];

    async function scan(dir, artistFolder) {
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name.toLowerCase() === albumTitle.toLowerCase()) {
                        // Found an album folder, get its tracks
                        try {
                            const trackEntries = await fs.promises.readdir(fullPath, { withFileTypes: true });
                            for (const t of trackEntries) {
                                if (t.isFile() && t.name.match(/\.(mp3|flac|wav|m4a|aac|ogg|alac)$/i)) {
                                    results.push({
                                        title: t.name,
                                        artistFolder: artistFolder,
                                        folderId: fullPath.replace(localDir, '').replace(/\\/g, '/').replace(/^\//, '')
                                    });
                                }
                            }
                        } catch (e) {
                            console.warn(`[VA Candidates] Error reading album folder ${fullPath}: ${e.message}`);
                        }
                    } else {
                        // Keep searching deeper
                        await scan(fullPath, entry.name);
                    }
                }
            }
        } catch (e) {
            console.warn(`[VA Candidates] Error reading dir ${dir}: ${e.message}`);
        }
    }

    try {
        await scan(localDir, 'Root');
        res.json({ tracks: results });
    } catch (e) {
        console.error('[VA Candidates] Scan error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/local/move-to-tags', express.json(), async (req, res) => {
    const { uri } = req.body;
    if (!uri) return res.status(400).json({ error: 'URI is required' });

    try {
        const localDir = path.join(__dirname, 'local');

        let localPath = uri;
        if (uri.startsWith('http') && uri.includes('/local-files/')) {
            try {
                const url = new URL(uri);
                const relPath = decodeURIComponent(url.pathname).replace('/local-files/', '');
                localPath = path.join(localDir, relPath);
            } catch (e) {
                console.warn(`[Move to Tags] URL parsing failed for ${uri}:`, e.message);
            }
        }

        if (!fs.existsSync(localPath)) {
            // Fallback: try direct join if not found
            const absoluteLocal = path.join(localDir, uri);
            if (fs.existsSync(absoluteLocal)) localPath = absoluteLocal;
        }

        if (!fs.existsSync(localPath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Get metadata
        const metadata = await getTrackMetadata(uri);
        const artist = metadata?.common?.artist;
        const album = metadata?.common?.album;

        if (!artist || !album) {
            return res.status(400).json({ error: 'Track must have both Artist and Album tags' });
        }

        const safeArtist = artist.replace(/[<>:"/\\|?*]+/g, '_').trim();
        const safeAlbum = album.replace(/[<>:"/\\|?*]+/g, '_').trim();
        const fileName = path.basename(localPath);

        // Preserve the base folder (the folder containing the Artist folder)
        // We assume the structure is .../Base/Artist/Album/File
        const currentAlbumDir = path.dirname(localPath);
        const currentArtistDir = path.dirname(currentAlbumDir);
        const baseDir = path.dirname(currentArtistDir);

        const artistDir = path.join(baseDir, safeArtist);
        const targetAlbumDir = path.join(artistDir, safeAlbum);
        const targetPath = path.join(targetAlbumDir, fileName);

        if (localPath.toLowerCase() === targetPath.toLowerCase()) {
            return res.status(400).json({ error: 'File is already in the correct folder.' });
        }

        if (fs.existsSync(targetPath)) {
            return res.status(400).json({ error: 'Target file already exists.' });
        }

        if (!fs.existsSync(artistDir)) await fs.promises.mkdir(artistDir, { recursive: true });
        if (!fs.existsSync(targetAlbumDir)) await fs.promises.mkdir(targetAlbumDir, { recursive: true });

        const sourceDir = path.dirname(localPath);
        await fs.promises.rename(localPath, targetPath);

        // Clean up empty directories
        let currentDir = sourceDir;
        while (currentDir && currentDir.length > baseDir.length && currentDir.startsWith(baseDir)) {
            try {
                const remaining = await fs.promises.readdir(currentDir);
                if (remaining.length === 0) {
                    await fs.promises.rmdir(currentDir);
                    currentDir = path.dirname(currentDir);
                } else {
                    break;
                }
            } catch (e) {
                break;
            }
        }

        const targetFolderId = targetAlbumDir.replace(localDir, '').replace(/\\/g, '/').replace(/^\//, '');
        res.json({ success: true, targetFolderId, newUri: encodeURI((targetFolderId + '/' + fileName).replace(/\\/g, '/')) });
    } catch (e) {
        console.error('[Move to Tags] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/local/move-va', async (req, res) => {
    const { albumTitle, artistName, files, targetBaseFolder } = req.body;
    if (!albumTitle || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'Album title and a non-empty files list are required' });
    }

    const localDir = path.join(__dirname, 'local');

    // Default to root 'local' if no targetBaseFolder or if it's unsafe
    let baseDir = localDir;
    if (targetBaseFolder) {
        const safeBase = path.normalize(targetBaseFolder).replace(/^(\.\.(\/|\\|$))+/, '');
        baseDir = path.join(localDir, safeBase);
    }

    const effectiveArtist = (artistName || 'Various Artists').trim();
    const artistDir = path.join(baseDir, effectiveArtist);
    const targetAlbumDir = path.join(artistDir, albumTitle);

    try {
        if (!fs.existsSync(artistDir)) await fs.promises.mkdir(artistDir, { recursive: true });
        if (!fs.existsSync(targetAlbumDir)) await fs.promises.mkdir(targetAlbumDir, { recursive: true });

        let movedCount = 0;
        const parentDirsToCheck = new Set();

        for (const file of files) {
            // Keep it safe: prevent directory traversal attacks
            const safeFile = path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, '');
            const sourcePath = path.join(localDir, safeFile);
            const targetPath = path.join(targetAlbumDir, path.basename(safeFile));

            if (fs.existsSync(sourcePath)) {
                await fs.promises.rename(sourcePath, targetPath);
                movedCount++;
                parentDirsToCheck.add(path.dirname(sourcePath));
            }
        }

        // Clean up empty directories that an album might have left behind (and their parents)
        for (const startDir of parentDirsToCheck) {
            let currentDir = startDir;
            // Don't accidentally wipe out the local root or the base music home
            while (currentDir && currentDir.length > baseDir.length && currentDir.startsWith(baseDir)) {
                try {
                    const remaining = await fs.promises.readdir(currentDir);
                    if (remaining.length === 0) {
                        await fs.promises.rmdir(currentDir);
                        currentDir = path.dirname(currentDir); // Go up one level (e.g., to the Artist folder)
                    } else {
                        break; // Not empty, stop climbing
                    }
                } catch (e) {
                    break; // Ignore errors and stop climbing
                }
            }
        }

        const targetFolderId = targetAlbumDir.replace(localDir, '').replace(/\\/g, '/').replace(/^\//, '');
        res.json({ success: true, movedCount, targetFolderId });
    } catch (e) {
        console.error('[Move to VA] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/local/rename-folder', express.json(), async (req, res) => {
    const { oldId, newTitle, merge } = req.body;
    if (!oldId || !newTitle) return res.status(400).json({ error: 'oldId and newTitle are required' });

    try {
        const localDir = path.join(__dirname, 'local');
        const safeOldId = path.normalize(oldId).replace(/^(\.\.(\/|\\|$))+/, '');
        const oldDirPath = path.join(localDir, safeOldId);

        if (!fs.existsSync(oldDirPath)) {
            return res.status(404).json({ error: 'Source folder not found' });
        }

        const parentDir = path.dirname(oldDirPath);
        const newDirPath = path.join(parentDir, newTitle);

        console.log(`[RENAME] Request: ${oldDirPath} -> ${newDirPath} (merge: ${merge})`);

        if (fs.existsSync(newDirPath)) {
            if (!merge) {
                // Return 409 Conflict so the frontend can ask about merging
                return res.status(409).json({ error: 'Folder already exists' });
            }

            // Perform Merge
            const items = await fs.promises.readdir(oldDirPath);
            for (const item of items) {
                const src = path.join(oldDirPath, item);
                const dest = path.join(newDirPath, item);

                if (fs.existsSync(dest)) {
                    // If target file exists, check if it's the same or if we should skip/overwrite
                    // For simplicity, we'll rename the incoming file if there's a collision
                    const ext = path.extname(item);
                    const base = path.basename(item, ext);
                    const timestamp = Date.now();
                    const newDest = path.join(newDirPath, `${base}_${timestamp}${ext}`);
                    await fs.promises.rename(src, newDest);
                } else {
                    await fs.promises.rename(src, dest);
                }
            }

            // Remove the now empty old directory
            await fs.promises.rmdir(oldDirPath);
            console.log(`[RENAME] Merge complete: ${oldDirPath} removed`);
        } else {
            // Simple rename
            await fs.promises.rename(oldDirPath, newDirPath);
            console.log(`[RENAME] Simple rename complete`);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[RENAME] Server error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/local/update-tags', express.json(), async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });

    try {
        const localDir = path.join(__dirname, 'local');
        const safeId = path.normalize(id).replace(/^(\.\.(\/|\\|$))+/, '');
        const targetPath = path.join(localDir, safeId);

        if (!fs.existsSync(targetPath)) {
            return res.status(404).json({ error: 'Target not found' });
        }

        const stats = fs.statSync(targetPath);
        if (stats.isDirectory()) {
            console.log(`[TAGS] Recursively syncing tags for folder: ${targetPath}`);
            const count = await processDirectory(targetPath);
            res.json({ success: true, count });
        } else {
            console.log(`[TAGS] Syncing tags for file: ${targetPath}`);
            const result = await syncSingleFile(targetPath);
            res.json({ success: true, ...result });
        }
    } catch (err) {
        console.error('[TAGS] Server error:', err);
        res.status(500).json({ error: err.message });
    }
});

async function syncSingleFile(filePath) {
    const albumDir = path.dirname(filePath);
    const artistDir = path.dirname(albumDir);

    const album = path.basename(albumDir);
    const artist = path.basename(artistDir);

    if (artist === 'local' || artist === '.') {
        throw new Error('Could not determine artist/album from path structure. Expected: Artist/Album/File.mp3');
    }

    const tags = { artist, album };
    const success = NodeID3.update(tags, filePath);
    if (success !== true) throw new Error('Failed to update tags in file');
    return { artist, album };
}

async function processDirectory(dirPath) {
    let count = 0;
    const items = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        if (item.isDirectory()) {
            count += await processDirectory(fullPath);
        } else if (item.isFile()) {
            const ext = path.extname(item.name).toLowerCase();
            if (['.mp3', '.flac', '.m4a', '.aac', '.wav'].includes(ext)) {
                try {
                    await syncSingleFile(fullPath);
                    count++;
                } catch (e) {
                    console.warn(`[TAGS] Skipping file ${item.name}: ${e.message}`);
                }
            }
        }
    }
    return count;
}


app.post('/api/playlist/:udn/queue-tag', express.json(), async (req, res) => {
    const { udn } = req.params;
    const { tag } = req.body;

    if (!tag) return res.status(400).json({ error: 'Tag is required' });

    const rendererDevice = Array.from(devices.values()).find(d => d.udn === udn);
    if (!rendererDevice || rendererDevice.loading) return res.status(404).json({ error: 'Renderer not found or still discovering' });

    const uris = Object.keys(settings.fileTags).filter(uri => {
        if (!Array.isArray(settings.fileTags[uri]) || !settings.fileTags[uri].includes(tag)) return false;
        // Only include music/audio files
        return uri.match(/\.(mp3|flac|wav|aac|m4a|ogg|wma|aiff|alac)$/i);
    });

    if (uris.length === 0) {
        return res.json({ success: true, count: 0 });
    }

    try {
        const renderer = getRenderer(rendererDevice);

        // Clear playlist and start fresh like play-folder
        await renderer.clearPlaylist();

        let lastId = 0;

        for (const uri of uris) {
            let title = 'Unknown Item';
            let artist = '';
            let album = '';

            try {
                // Try grabbing metadata for correct track name and artist presentation
                const metadata = await getTrackMetadata(uri);
                if (metadata && metadata.common) {
                    if (metadata.common.title) title = metadata.common.title;
                    if (metadata.common.artist) artist = metadata.common.artist;
                    if (metadata.common.album) album = metadata.common.album;
                }
            } catch (e) {
                // Fallback to extraction from URI
                const filenameRegex = /[^\/\\]+$/;
                const match = uri.match(filenameRegex);
                if (match) title = decodeURIComponent(match[0].split('?')[0]);
            }

            const track = {
                uri,
                title,
                artist,
                album,
                albumArtUrl: `http://${hostIp}:${port}/api/art/local?uri=${encodeURIComponent(uri)}`,
                class: title.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? 'object.item.imageItem.photo'
                    : title.match(/\.(mp4|mkv|avi|mov)$/i) ? 'object.item.videoItem'
                        : 'object.item.audioItem.musicTrack'
            };
            console.log(`[TAGS] Queued: ${title} - Art: ${track.albumArtUrl}`);
            lastId = await renderer.insertTrack(track, lastId);
        }

        // Play the first track added
        let ids = await renderer.getIdArray();
        if (ids.length > 0) {
            await renderer.seekId(ids[0]);
        }

        res.json({ success: true, count: uris.length });
    } catch (err) {
        console.error('Queue tag failed:', err.message);
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

app.post('/api/logs/clear', (req, res) => {
    clearServerLogs();
    res.json({ success: true });
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
