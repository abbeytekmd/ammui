import express from 'express';
import ssdp from 'node-ssdp';
const { Client } = ssdp;
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import xml2js from 'xml2js';
import Renderer from './lib/renderer.js';
import MediaServer from './lib/media-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

// Store discovered devices
let devices = new Map();

const ssdpClient = new Client();

// Search targets for OpenHome Renderers and DLNA Media Servers
const SEARCH_TARGETS = [
    'urn:av-openhome-org:service:Product:1',
    'urn:linn-co-uk:device:NetReceiver:1',
    'urn:schemas-upnp-org:device:MediaServer:1'
];

async function parseDescription(url, isServer, isRenderer) {
    try {
        const response = await axios.get(url, { timeout: 2000 });
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(response.data);
        const device = result.root.device;

        const services = [];
        if (device.serviceList && device.serviceList.service) {
            const list = Array.isArray(device.serviceList.service) ? device.serviceList.service : [device.serviceList.service];
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

        let type = 'unknown';
        if (isServer) {
            type = 'server';
        } else if (isRenderer) {
            type = 'renderer';
        }
        else {
            const hasOpenHome = services.some(s => s.serviceType.includes('Playlist'));
            type = hasOpenHome ? 'renderer' : 'server';
        }

        return {
            friendlyName: device.friendlyName,
            manufacturer: device.manufacturer,
            modelName: device.modelName,
            location: url,
            udn: device.UDN,
            services: services,
            type: type
        };
    } catch (err) {
        console.error(`Failed to fetch description from ${url}:`, err.message);
        return null;
    }
}

ssdpClient.on('response', async (headers, statusCode, rinfo) => {
    const location = headers.LOCATION;
    if (location && !devices.has(location)) {
        const isServer = headers.ST.includes('MediaServer');
        const isRenderer = headers.ST.includes('MediaRenderer');
        devices.set(location, { location, friendlyName: 'Discovering...', loading: true, type: 'unknown' });

        const deviceDetails = await parseDescription(location, isServer, isRenderer);
        if (deviceDetails) {
            devices.set(location, { ...deviceDetails, lastSeen: Date.now() });
            if (deviceDetails.udn) {
                devices.set(deviceDetails.udn, devices.get(location));
            }
        } else {
            devices.delete(location);
        }
    } else if (location) {
        const device = devices.get(location);
        if (device) {
            device.lastSeen = Date.now();
            if (device.udn) {
                const udnDevice = devices.get(device.udn);
                if (udnDevice) udnDevice.lastSeen = Date.now();
            }
        }
    }
});

function startDiscovery() {
    console.log('Starting SSDP discovery...');
    for (const target of SEARCH_TARGETS) {
        ssdpClient.search(target);
    }
}

setInterval(startDiscovery, 10000);
startDiscovery();

setInterval(() => {
    const now = Date.now();
    for (const [location, device] of devices) {
        if (now - device.lastSeen > 30000) {
            devices.delete(location);
        }
    }
}, 5000);

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
    if (!device) return res.status(404).json({ error: 'Device not found' });

    try {
        const renderer = new Renderer(device);
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
    if (!device) return res.status(404).json({ error: 'Device not found' });

    try {
        const renderer = new Renderer(device);
        await renderer.clearPlaylist();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/delete/:id', async (req, res) => {
    const { udn, id } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    try {
        const renderer = new Renderer(device);
        await renderer.deleteTrack(id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/play', async (req, res) => {
    const { udn } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    try {
        const renderer = new Renderer(device);
        await renderer.play();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/pause', async (req, res) => {
    const { udn } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    try {
        const renderer = new Renderer(device);
        await renderer.pause();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/stop', async (req, res) => {
    const { udn } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    try {
        const renderer = new Renderer(device);
        await renderer.stop();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlist/:udn/seek/:id', async (req, res) => {
    const { udn, id } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    try {
        const renderer = new Renderer(device);
        await renderer.seekId(id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/playlist/:udn/status', async (req, res) => {
    const { udn } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    try {
        const renderer = new Renderer(device);
        const status = await renderer.getCurrentStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/playlist/:udn', async (req, res) => {
    const { udn } = req.params;
    const device = Array.from(devices.values()).find(d => d.udn === udn);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    try {
        const renderer = new Renderer(device);
        const items = await renderer.getPlaylist();
        res.json(items);
    } catch (err) {
        console.error('Playlist fetch failed:', err.message);
        res.status(500).json({ error: err.message });
    }
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

app.listen(port, () => {
    console.log(`AMCUI server listening at http://localhost:${port}`);
});
