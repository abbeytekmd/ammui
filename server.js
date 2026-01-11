import './lib/logger-init.js';
import express from 'express';
import ssdp from 'node-ssdp';
const { Client } = ssdp;
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import xml2js from 'xml2js';
import Renderer from './lib/renderer.js';
import MediaServer from './lib/media-server.js';
import sonos from 'sonos';
const { Sonos, DeviceDiscovery } = sonos;
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEVICES_FILE = path.join(__dirname, 'devices.json');

const app = express();
const port = 3000;

// Store discovered devices
let devices = new Map();

function loadDevices() {
    try {
        if (fs.existsSync(DEVICES_FILE)) {
            const data = fs.readFileSync(DEVICES_FILE, 'utf8');
            const list = JSON.parse(data);
            list.forEach(d => {
                if (d.location) devices.set(d.location, d);
                if (d.udn) devices.set(d.udn, d);
            });
            console.log(`Loaded ${list.length} devices from storage.`);
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
            const existing = devices.get(location) || (deviceDetails.udn ? devices.get(deviceDetails.udn) : null);
            const merged = { ...deviceDetails, lastSeen: Date.now(), isSonos: deviceDetails.isSonos || isSonosSSDP };

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

app.post('/api/discover', async (req, res) => {
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
    const device = Array.from(devices.values()).find(d => d.udn === udn);

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
    const { uri, title, artist, album } = req.body;

    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device || device.loading) return res.status(404).json({ error: 'Device not found or still discovering' });

    try {
        const renderer = getRenderer(device);
        const ids = await renderer.getIdArray();
        const afterId = ids.length > 0 ? ids[ids.length - 1] : 0;

        const newId = await renderer.insertTrack({ uri, title, artist, album }, afterId);
        res.json({ success: true, newId });
    } catch (err) {
        console.error('Insert failed:', err.message);
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

app.get('/api/devices', (req, res) => {
    const uniqueDevices = [];
    const seenUdns = new Set();
    for (const device of devices.values()) {
        if (device.udn && !seenUdns.has(device.udn)) {
            uniqueDevices.push(device);
            seenUdns.add(device.udn);
        } else if (!device.udn && !device.loading) {
            uniqueDevices.push(device);
        }
    }
    res.json(uniqueDevices);
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

app.listen(port, () => {
    console.log(`AMCUI server listening at http://localhost:${port}`);
});
