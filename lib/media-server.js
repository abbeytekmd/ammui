import { soapCall } from './upnp.js';
import xml2js from 'xml2js';

export default class MediaServer {
    constructor(device) {
        this.device = device;
        this.browseService = device.services?.find(s => s.serviceType.includes('ContentDirectory'));
    }

    _getText(node) {
        if (!node) return '';
        if (typeof node === 'string') return node;
        if (typeof node === 'object') {
            if (node._ !== undefined) return node._;
            if (Object.keys(node).every(k => k === '$')) return '';
        }
        return String(node);
    }

    async browse(objectId = '0') {
        if (!this.browseService) {
            throw new Error('ContentDirectory service not found on this device');
        }

        const browseResponse = await soapCall(this.browseService.controlURL, this.browseService.serviceType, 'Browse', {
            ObjectID: objectId,
            BrowseFlag: 'BrowseDirectChildren',
            Filter: '*',
            StartingIndex: 0,
            RequestedCount: 0,
            SortCriteria: ''
        });

        const resultXml = browseResponse.Result;
        if (!resultXml) {
            return [];
        }

        let browseResult;

        // Check if the result is already a parsed object (some servers return JSON)
        if (typeof resultXml === 'object' && resultXml !== null) {
            browseResult = resultXml;
        } else if (typeof resultXml === 'string') {
            // Clean the XML to handle Windows 11 DLNA servers that may include BOM or other issues
            let cleanedXml = resultXml;

            // Remove BOM (Byte Order Mark) if present
            cleanedXml = cleanedXml.replace(/^\uFEFF/, '');
            // Trim any leading/trailing whitespace
            cleanedXml = cleanedXml.trim();

            // Check if it's actually JSON
            if (cleanedXml.startsWith('{') || cleanedXml.startsWith('[')) {
                try {
                    browseResult = JSON.parse(cleanedXml);
                } catch (jsonError) {
                    console.error('[BROWSE] JSON Parse Error:', jsonError.message);
                    throw new Error(`Failed to parse JSON browse response: ${jsonError.message}`);
                }
            } else {
                // It's XML - remove any non-XML characters before the first '<'
                const firstTag = cleanedXml.indexOf('<');
                if (firstTag > 0) {
                    cleanedXml = cleanedXml.substring(firstTag);
                }

                const parser = new xml2js.Parser({
                    explicitArray: false,
                    tagNameProcessors: [xml2js.processors.stripPrefix]
                });

                try {
                    browseResult = await parser.parseStringPromise(cleanedXml);
                } catch (parseError) {
                    console.error('[BROWSE] XML Parse Error:', parseError.message);
                    console.error('[BROWSE] First 200 chars of data:', cleanedXml.substring(0, 200));
                    throw new Error(`Failed to parse browse response: ${parseError.message}`);
                }
            }
        } else {
            throw new Error(`Unexpected result type: ${typeof resultXml}`);
        }


        const didl = browseResult.DIDL_Lite || browseResult['DIDL-Lite'] || browseResult;

        const items = [];

        // Handle Containers
        if (didl.container) {
            const containers = Array.isArray(didl.container) ? didl.container : [didl.container];
            containers.forEach(c => {
                items.push({
                    id: c.$.id || c.id,
                    type: 'container',
                    title: this._getText(c.title) || 'Unknown Folder',
                    artist: this._getText(c.artist),
                    class: this._getText(c.class)
                });
            });
        }

        // Handle Items
        if (didl.item) {
            const entries = Array.isArray(didl.item) ? didl.item : [didl.item];
            entries.forEach(item => {
                items.push({
                    id: item.$.id || item.id,
                    type: 'item',
                    title: this._getText(item.title) || 'Unknown Item',
                    artist: this._getText(item.artist),
                    album: this._getText(item.album),
                    uri: this._getText(item.res),
                    trackNumber: parseInt(this._getText(item.originalTrackNumber || item.trackNumber)) || 0,
                    discNumber: parseInt(this._getText(item.originalDiscNumber || item.discNumber)) || 1,
                    duration: (() => {
                        const resDuration = (item.res && item.res.$ && item.res.$.duration) ? item.res.$.duration : null;
                        const itemDuration = this._getText(item.duration || item['upnp:duration']);
                        return resDuration || itemDuration || null;
                    })(),
                    protocolInfo: (item.res && item.res.$ && item.res.$.protocolInfo) || 'http-get:*:audio/mpeg:*'
                });
            });
        }

        return items;
    }
    async browseRecursive(objectId) {
        let allItems = [];
        const queue = [objectId];
        const visited = new Set();

        while (queue.length > 0) {
            const currentId = queue.shift();
            if (visited.has(currentId)) continue;
            visited.add(currentId);

            try {
                const items = await this.browse(currentId);
                for (const item of items) {
                    if (item.type === 'item') {
                        allItems.push(item);
                    } else if (item.type === 'container') {
                        queue.push(item.id);
                    }
                }
            } catch (err) {
                console.error(`Recursive browse error at ${currentId}:`, err.message);
            }
        }
        allItems.sort((a, b) => {
            // Sort by Album first (if multiple albums in one folder/tree)
            if (a.album !== b.album) {
                return (a.album || '').localeCompare(b.album || '');
            }
            // Sort by Disc
            if (a.discNumber !== b.discNumber) {
                return (a.discNumber || 1) - (b.discNumber || 1);
            }
            // Sort by Track
            if (a.trackNumber !== b.trackNumber) {
                return (a.trackNumber || 0) - (b.trackNumber || 0);
            }
            // Finally by Title
            return (a.title || '').localeCompare(b.title || '');
        });

        return allItems;
    }
}
