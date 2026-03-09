import { Bonjour } from 'bonjour-service';
import AirPlayRenderer from './airplay-renderer.js';

export default class AirPlayManager {
    constructor(devicesMap, saveDevicesCallback) {
        this.devicesMap = devicesMap;
        this.saveDevices = saveDevicesCallback;
        this.bonjour = new Bonjour();
        this.airplaySearch = null;
        this.raopSearch = null;
        this.airplayTimeout = null;
        this.rendererCache = new Map();

        console.log('[AirPlay] Manager initialized.');
    }

    async triggerDiscovery() {
        if (this.airplaySearch) this.airplaySearch.stop();
        if (this.raopSearch) this.raopSearch.stop();

        console.log('[AirPlay] Starting 30-second discovery scan...');

        const onUp = (service) => {
            try {
                this.handleService(service);
            } catch (err) {
                console.error('[AirPlay] Error processing service:', err.message);
            }
        };

        this.airplaySearch = this.bonjour.find({ type: 'airplay' }, onUp);
        this.raopSearch = this.bonjour.find({ type: 'raop' }, onUp);

        if (this.airplayTimeout) clearTimeout(this.airplayTimeout);

        this.airplayTimeout = setTimeout(() => {
            console.log('[AirPlay] Ending discovery scan period.');
            if (this.airplaySearch) this.airplaySearch.stop();
            if (this.raopSearch) this.raopSearch.stop();
            this.airplaySearch = null;
            this.raopSearch = null;
            this.airplayTimeout = null;
        }, 30000);

        return { success: true };
    }

    handleService(service) {
        if (!service || !service.addresses || service.addresses.length === 0) return;

        const ip = service.addresses.find(addr => addr.includes('.')) || service.addresses[0];
        const port = service.port || 7000;
        const rawName = service.name || `AirPlay-${ip}`;
        let name = rawName;

        if (name.includes('.local')) name = name.replace('.local', '');

        // Strip RAOP MAC prefix "MAC@Name" for a cleaner friendly name
        if (name.includes('@')) {
            const parts = name.split('@');
            if (parts.length > 1 && parts[0].match(/^[0-9A-F]{12,16}$/i)) {
                name = parts.slice(1).join('@');
            }
        }

        // Friendly name from txt records
        if (service.txt) {
            const txt = service.txt;
            const fn = txt.fn || txt.FN;
            const am = txt.am || txt.AM;
            if (am) name = am;
            else if (fn) name = fn;
        }

        const udn = `uuid:airplay-${rawName.replace(/[@\.\s+]/g, '-')}-${ip.replace(/\./g, '-')}`;

        const device = {
            udn: udn,
            location: `airplay://${ip}:${port}`,
            friendlyName: name,
            type: 'renderer',
            isRenderer: true,
            isServer: false,
            isAirPlay: true,
            protocol: 'AirPlay',
            lastSeen: Date.now(),
            disabledPlayer: false
        };

        const existing = this.devicesMap.get(udn);
        if (!existing || existing.location !== device.location || existing.friendlyName !== device.friendlyName) {
            console.log(`[AirPlay] Discovered: "${name}" at ${ip}:${port}`);
            this.devicesMap.set(udn, device);
            this.devicesMap.set(device.location, device);
            this.saveDevices();
        } else {
            existing.lastSeen = Date.now();
        }
    }

    stopDiscovery() {
        console.log('[AirPlay] Stopping discovery scan...');
        if (this.airplayTimeout) {
            clearTimeout(this.airplayTimeout);
            this.airplayTimeout = null;
        }
        if (this.airplaySearch) {
            this.airplaySearch.stop();
            this.airplaySearch = null;
        }
        if (this.raopSearch) {
            this.raopSearch.stop();
            this.raopSearch = null;
        }
        return { success: true };
    }

    getRenderer(device) {
        if (!this.rendererCache.has(device.udn)) {
            this.rendererCache.set(device.udn, new AirPlayRenderer(device));
        }
        return this.rendererCache.get(device.udn);
    }
}
