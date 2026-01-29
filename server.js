import './lib/logger-init.js';
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
import { setupLocalDlna, getLocalIp } from './lib/local-dlna-server.js';
import multer from 'multer';
import * as mm from 'music-metadata';

const { Client } = ssdp;
const { DeviceDiscovery } = sonos;
const hostIp = getLocalIp();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEVICES_FILE = path.join(__dirname, 'devices.json');

const app = express();
const port = 3000;

// Ensure directories exist
if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
if (!fs.existsSync(path.join(__dirname, 'local'))) fs.mkdirSync(path.join(__dirname, 'local'), { recursive: true });

app.use(express.json());

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

setupLocalDlna(app, port);

// Store discovered devices
let devices = new Map();

function loadDevices() {
    try {
        if (fs.existsSync(DEVICES_FILE)) {
            const data = fs.readFileSync(DEVICES_FILE, 'utf8');
            const list = JSON.parse(data);
            list.forEach(d => {
                // Skip any stale entries for the local server from previous runs on different IPs
                if (d.udn === 'uuid:amcui-local-media-server' || d.friendlyName === 'AMCUI Local Server') {
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

loadDevices();
// Cache renderer instances to avoid recreating them on every API call
let rendererCache = new Map();

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

    // Log the discovery type
    const msgType = headers.ST ? 'Response' : (headers.NTS === 'ssdp:alive' ? 'Alive' : 'Announcement');
    if (rinfo.address === '192.168.0.2') {
        console.log(`[DEBUG-LINUX] SSDP ${msgType} from ${rinfo.address}:${rinfo.port} (Type: ${st})`);
        console.log(`[DEBUG-LINUX] Headers:`, JSON.stringify(headers));
    } else {
        console.log(`SSDP ${msgType} from ${rinfo.address}:${rinfo.port} (Type: ${st})`);
    }

    if (!devices.has(location)) {
        // Broad initial detection
        const isServer = st.includes('mediaserver') || st.includes('contentdirectory');
        const isSonosSSDP = st.includes('zoneplayer') || serverHeader.includes('sonos') || serverHeader.includes('play:');
        const isRenderer = st.includes('mediarenderer') || st.includes('avtransport') || st.includes('playlist') || isSonosSSDP;
        const isGeneric = st.includes('rootdevice') || st.includes('upnp:rootdevice');

        if (!isServer && !isRenderer && !isGeneric) {
            if (rinfo.address === '192.168.0.2') {
                console.log(`[DEBUG-LINUX] Ignored 192.168.0.2 because it didn't match Server/Renderer/Generic filters.`);
            }
            return;
        }

        // PREVENT HIJACKING: If this is our own local server discovered on a VPN IP, IGNORE IT.
        if (st.includes('amcui-local-media-server') || (location && location.includes('amcui-local-media-server'))) {
            const url = new URL(location);
            if (url.hostname !== hostIp) {
                console.log(`[DEBUG] Ignoring local server discovered on non-primary IP: ${url.hostname} (Expected: ${hostIp})`);
                return;
            }
        }

        console.log(`Discovered candidate via ${msgType} at ${rinfo.address} (ST/NT: ${st})`);

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

    try {
        const server = new MediaServer(device);
        const items = await server.browse(objectId);
        res.json({ objectId, items });
    } catch (err) {
        console.error('Failed to browse device:', err.message);
        res.status(500).json({ error: err.message });
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

app.post('/api/devices/:udn/name', express.json(), (req, res) => {
    const { udn } = req.params;
    const { name } = req.body;

    const toggledObjects = new Set();
    let found = false;

    for (const [key, device] of devices.entries()) {
        if (device.udn === udn && !toggledObjects.has(device)) {
            device.customName = name;
            toggledObjects.add(device);
            found = true;
        }
    }

    if (!found) return res.status(404).json({ error: 'Device not found' });

    saveDevices();
    res.json({ success: true, customName: name });
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
        const targetDir = path.join(localDir, safeArtist, safeAlbum);

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
    const targetDir = path.join(localDir, safeArtist, safeAlbum);
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

        async function processRecursive(currentId, currentArtist, currentAlbum) {
            console.log(`Browsing folder ${currentId} for download...`);
            const items = await server.browse(currentId);
            for (const item of items) {
                if (item.type === 'item') {
                    try {
                        await downloadFileHelper(item.uri, item.title, item.artist || currentArtist, item.album || currentAlbum);
                        downloadCount++;
                    } catch (err) {
                        console.error(`Failed to download ${item.title}:`, err.message);
                        failCount++;
                    }
                } else if (item.type === 'container') {
                    await processRecursive(item.id, item.artist || currentArtist, item.album || currentAlbum);
                }
            }
        }

        // Start recursive download (not awaiting here to reply quickly, but user wants it to finish?
        // Actually, if we want to confirm when done, we should await. 
        // But for deep folders, it might timeout the HTTP request.
        // Let's do it and hope for the best, or suggest a progress mechanism later.
        await processRecursive(objectId, artist, album);

        res.json({ success: true, downloadCount, failCount });
    } catch (err) {
        console.error('Folder download error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/art/search', async (req, res) => {
    const { artist, album } = req.query;
    if (!artist && !album) return res.status(400).json({ error: 'Artist or Album is required' });

    const DISCOGS_TOKEN = 'dbNpCwbazWWlDDKqvRcZKnftKNxMwvjcPXNMrOIz';

    try {
        const query = `${artist || ''} ${album || ''}`.trim();
        console.log(`[ART] Deep Search for: "${query}" (Artist: ${artist}, Album: ${album})`);

        // 1. Try Discogs (User's preferred primary)
        try {
            const discogsUrl = `https://api.discogs.com/database/search?artist=${encodeURIComponent(artist || '')}&release_title=${encodeURIComponent(album || '')}&type=release&token=${DISCOGS_TOKEN}`;
            const discogsRes = await axios.get(discogsUrl, {
                timeout: 5000,
                headers: { 'User-Agent': 'AMCUI/1.0' }
            });

            if (discogsRes.data.results && discogsRes.data.results.length > 0) {
                // Discogs is usually quite accurate with artist/album filters
                const bestMatch = discogsRes.data.results[0];
                if (bestMatch.cover_image) {
                    console.log(`[ART] Found on Discogs: ${bestMatch.title}`);
                    return res.json({ url: bestMatch.cover_image, source: 'discogs' });
                }
            }
        } catch (e) {
            console.warn('[ART] Discogs search failed:', e.message);
        }

        // 2. Try iTunes with Artist Validation (Fallback 1)
        try {
            const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=album&limit=5`;
            const itunesRes = await axios.get(itunesUrl, { timeout: 5000 });

            if (itunesRes.data.results && itunesRes.data.results.length > 0) {
                const bestMatch = itunesRes.data.results.find(item => {
                    const resArtist = (item.artistName || '').toLowerCase();
                    const searchArtist = (artist || '').toLowerCase();
                    return resArtist.includes(searchArtist) || searchArtist.includes(resArtist);
                });

                if (bestMatch) {
                    const art = bestMatch.artworkUrl100.replace('100x100bb', '600x600bb');
                    console.log(`[ART] Confirmed Match on iTunes: ${bestMatch.artistName} - ${bestMatch.collectionName}`);
                    return res.json({ url: art, source: 'itunes' });
                }
            }
        } catch (e) {
            console.warn('[ART] iTunes search failed:', e.message);
        }

        // 3. Try Wikipedia Search (Fallback 2)
        try {
            const wikiSearchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&limit=1`;
            const wikiSearchRes = await axios.get(wikiSearchUrl, { timeout: 5000 });

            if (wikiSearchRes.data.query && wikiSearchRes.data.query.search && wikiSearchRes.data.query.search.length > 0) {
                const title = wikiSearchRes.data.query.search[0].title;
                const wikiArtUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&titles=${encodeURIComponent(title)}&pithumbsize=1000&redirects=1`;
                const wikiArtRes = await axios.get(wikiArtUrl, { timeout: 5000 });

                if (wikiArtRes.data.query && wikiArtRes.data.query.pages) {
                    const pages = wikiArtRes.data.query.pages;
                    const pageId = Object.keys(pages)[0];
                    if (pageId !== '-1' && pages[pageId].thumbnail) {
                        const art = pages[pageId].thumbnail.source;
                        console.log(`[ART] Found on Wikipedia: ${title}`);
                        return res.json({ url: art, source: 'wikipedia' });
                    }
                }
            }
        } catch (e) {
            console.warn('[ART] Wikipedia search failed:', e.message);
        }

        res.status(404).json({ error: 'No high-confidence artwork found' });
    } catch (err) {
        console.error('[ART] Search error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => {
    console.log(`AMCUI server listening at http://localhost:${port}`);
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

// 404 Handler - MUST BE LAST
app.use((req, res) => {
    console.error(`[404] ${req.method} ${req.url}`);
    res.status(404).json({ error: `Not Found: ${req.method} ${req.url}` });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(`[ERROR] ${err.stack}`);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
});
