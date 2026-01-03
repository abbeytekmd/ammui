import { soapCall, xmlEscape } from './upnp.js';
import xml2js from 'xml2js';
import sonos from 'sonos';
const { Sonos } = sonos;

export default class Renderer {
    constructor(device) {
        this.device = device;
        const services = device.services || [];
        this.playlistService = services.find(s => s.serviceType.indexOf('Playlist') !== -1);
        this.sonosQueueService = services.find(s => s.serviceType.indexOf('Queue') !== -1);
        this.avTransportService = services.find(s => s.serviceType.indexOf('AVTransport') !== -1);

        const manufacturer = (device.manufacturer || '').toLowerCase();
        const model = (device.modelName || '').toLowerCase();
        // A device is Sonos if manufacturer or model says so, if it has a Sonos Queue service, or if we previously identified it as such.
        this.isSonos = device.isSonos || manufacturer.includes('sonos') || model.includes('sonos') || !!this.sonosQueueService;
        if (this.isSonos) {
            try {
                const host = new URL(device.location).hostname;
                this.sonosDevice = new Sonos(host);
                console.log(`[DEBUG] Initialized Sonos Library for ${device.friendlyName} (${host})`);
            } catch (err) {
                console.error(`Failed to initialize Sonos library for ${device.friendlyName}:`, err.message);
            }
        }

        console.error(`[DEBUG] Renderer for ${device.friendlyName}: sonosQueueService=${!!this.sonosQueueService}, sonosDevice=${!!this.sonosDevice}, playlistService=${!!this.playlistService}`);

        if (!this.playlistService && !this.sonosDevice && !this.sonosQueueService) {
            console.warn(`Renderer created for ${device.friendlyName} but no playlist service found. Services:`, services.map(s => s.serviceType));
        }
    }

    _getText(node) {
        if (!node) return '';
        if (typeof node === 'string') return node;
        if (typeof node === 'object') {
            if (node._ !== undefined) return node._;
            // If it's an object but doesn't have _, it might be an empty tag with attributes
            if (Object.keys(node).every(k => k === '$')) return '';
        }
        return String(node);
    }

    async getPlaylist() {
        if (this.sonosDevice) {
            return await this._getSonosPlaylistViaLib();
        } else if (this.playlistService) {
            return await this._getOpenHomePlaylist();
        } else if (this.sonosQueueService) {
            return await this._getSonosPlaylist();
        } else {
            throw new Error('No compatible playlist service found on this device');
        }
    }

    async _getOpenHomePlaylist() {
        if (!this.playlistService) {
            throw new Error('Playlist service not found on this device');
        }

        const idArrayResponse = await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'IdArray');
        const raw = idArrayResponse ? (idArrayResponse.Array !== undefined ? idArrayResponse.Array : idArrayResponse.IdArray) : null;
        const rawArray = this._getText(raw);

        if (!rawArray || rawArray.trim().length === 0) {
            return [];
        }

        const buffer = Buffer.from(rawArray, 'base64');
        const ids = [];
        for (let i = 0; i < buffer.length; i += 4) {
            ids.push(buffer.readUInt32BE(i));
        }

        if (ids.length === 0) {
            return [];
        }

        const readListResponse = await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'ReadList', {
            IdList: ids.join(' ')
        });

        const trackListXml = readListResponse.TrackList;
        if (!trackListXml) {
            return [];
        }

        const parser = new xml2js.Parser({
            explicitArray: false,
            tagNameProcessors: [xml2js.processors.stripPrefix]
        });
        const trackListResult = await parser.parseStringPromise(trackListXml);

        const items = [];
        const entries = trackListResult.TrackList && trackListResult.TrackList.Entry
            ? (Array.isArray(trackListResult.TrackList.Entry) ? trackListResult.TrackList.Entry : [trackListResult.TrackList.Entry])
            : [];

        for (const entry of entries) {
            if (!entry || !entry.Metadata) continue;

            try {
                const metadataResult = await parser.parseStringPromise(entry.Metadata);
                const didl = metadataResult['DIDL-Lite'] || metadataResult.DIDL_Lite || metadataResult;
                const item = didl.item || didl;

                items.push({
                    id: entry.Id || (item.$ && item.$.id) || item.id,
                    title: this._getText(item.title || item['dc:title']) || 'Unknown Title',
                    artist: this._getText(item.artist || item['upnp:artist']),
                    album: this._getText(item.album || item['upnp:album']),
                    uri: entry.Uri || this._getText(item.res)
                });
            } catch (mErr) {
                console.error('Failed to parse nested metadata for track:', entry.Id);
            }
        }

        return items;
    }

    async _getSonosPlaylistViaLib() {
        try {
            console.error('[DEBUG] Calling sonosDevice.getQueue()...');
            const queue = await this.sonosDevice.getQueue();

            console.error('[DEBUG] Raw queue object:', JSON.stringify(queue, null, 2));

            if (!queue || !queue.items) {
                console.error('[DEBUG] Sonos queue is empty or undefined');
                return [];
            }

            console.error(`[DEBUG] Sonos queue has ${queue.items.length} items`);

            const result = queue.items.map((item, index) => {
                console.error(`[DEBUG] Raw item ${index + 1}:`, JSON.stringify(item, null, 2));

                return {
                    id: index + 1,
                    title: item.title || 'Unknown Title',
                    artist: item.artist || '',
                    album: item.album || '',
                    uri: item.uri
                };
            });

            console.error('[DEBUG] Final result:', JSON.stringify(result, null, 2));

            // If the first item's title looks like a URI, fall back to SOAP method
            if (result.length > 0 && (result[0].title.includes('stream?id=') || result[0].title.includes('stream?') || result[0].title.startsWith('http://') || result[0].title.startsWith('x-'))) {
                console.error('[DEBUG] Sonos library returned URIs instead of titles, falling back to SOAP');
                return this.sonosQueueService ? await this._getSonosPlaylist() : result;
            }

            console.error('[DEBUG] Returning library results (no fallback needed)');
            return result;
        } catch (err) {
            console.error('Sonos Lib Playlist fetch failed:', err.message);
            console.error('Stack:', err.stack);
            // Fallback to manual if lib fails
            return this.sonosQueueService ? await this._getSonosPlaylist() : [];
        }
    }

    async _getSonosPlaylist() {
        try {
            console.error('[DEBUG] Fetching Sonos playlist via SOAP');
            console.error(`[DEBUG] Queue service URL: ${this.sonosQueueService.controlURL}`);

            const response = await soapCall(this.sonosQueueService.controlURL, this.sonosQueueService.serviceType, 'Browse', {
                QueueID: 0,
                StartingIndex: 0,
                RequestedCount: 100
            });

            console.error(`[DEBUG] SOAP Browse response keys: ${Object.keys(response || {}).join(', ')}`);

            const resultXml = response.Result;
            if (!resultXml) {
                console.error('[DEBUG] SOAP Browse returned no Result');
                console.error(`[DEBUG] Full response: ${JSON.stringify(response)}`);
                return [];
            }

            console.error(`[DEBUG] Result XML length: ${resultXml.length} chars`);

            const parser = new xml2js.Parser({
                explicitArray: false,
                tagNameProcessors: [xml2js.processors.stripPrefix]
            });
            const result = await parser.parseStringPromise(resultXml);
            const didl = result['DIDL-Lite'] || result.DIDL_Lite || result;
            const entries = didl.item ? (Array.isArray(didl.item) ? didl.item : [didl.item]) : [];

            console.error(`[DEBUG] SOAP returned ${entries.length} items`);

            return entries.map((item, index) => {
                const title = this._getText(item.title || item['dc:title'] || item['title']) || 'Unknown Title';
                console.error(`[DEBUG] SOAP Item ${index + 1}: title="${title}"`);

                return {
                    id: item.$?.id || item.id,
                    title: title,
                    artist: this._getText(item.artist || item['upnp:artist']),
                    album: this._getText(item.album || item['upnp:album']),
                    uri: this._getText(item.res)
                };
            });
        } catch (err) {
            console.error('Sonos Playlist fetch failed:', err.message);
            console.error('Stack:', err.stack);
            return [];
        }
    }

    async insertTrack(track, afterId = 0) {
        if (this.sonosDevice) {
            const { uri, title, artist, album } = track;
            // Build complete DIDL-Lite metadata for Sonos
            const metadata = `
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="f0002000s0" parentID="Q:0" restricted="1">
    <dc:title>${xmlEscape(title || 'Unknown Title')}</dc:title>
    <dc:creator>${xmlEscape(artist || 'Unknown Artist')}</dc:creator>
    <upnp:artist>${xmlEscape(artist || 'Unknown Artist')}</upnp:artist>
    <upnp:album>${xmlEscape(album || 'Unknown Album')}</upnp:album>
    <upnp:class>object.item.audioItem.musicTrack</upnp:class>
    <res protocolInfo="http-get:*:audio/mpeg:*">${xmlEscape(uri)}</res>
  </item>
</DIDL-Lite>`.trim();

            try {
                // Determine position (1-indexed). 0 means add to end or first if clear.
                // If afterId is provided, we want to insert at afterId + 1.
                const position = afterId > 0 ? (parseInt(afterId, 10) + 1) : 0;

                // Use sonos library queue method exclusively
                // Try with minimal metadata first
                const result = await this.sonosDevice.queue({
                    uri: uri,
                    metadata: metadata
                }, position);
                return result ? result.FirstTrackNumberEnqueued : null;
            } catch (err) {
                console.warn('Sonos Lib Queue with metadata failed, retrying with URI only:', err.message);
                try {
                    const position = afterId > 0 ? (parseInt(afterId, 10) + 1) : 0;
                    const result = await this.sonosDevice.queue(uri, position);
                    return result ? result.FirstTrackNumberEnqueued : null;
                } catch (retryErr) {
                    console.error('Sonos Lib Queue total failure:', retryErr.message);
                    throw retryErr;
                }
            }
        } else if (this.playlistService) {
            const { uri, title, artist, album } = track;
            const metadata = `
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="0" parentID="-1" restricted="1">
    <dc:title>${xmlEscape(title)}</dc:title>
    <upnp:artist>${xmlEscape(artist)}</upnp:artist>
    <upnp:album>${xmlEscape(album)}</upnp:album>
    <upnp:class>object.item.audioItem.musicTrack</upnp:class>
    <res>${xmlEscape(uri)}</res>
  </item>
</DIDL-Lite>`.trim();

            const insertRes = await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'Insert', {
                AfterId: afterId,
                Uri: uri,
                Metadata: metadata
            });

            return insertRes ? insertRes.NewId : null;
        } else if (this.sonosQueueService) {
            // Manual SOAP Fallback for Sonos-like devices without library support
            const { uri, title, artist, album } = track;
            const metadata = `
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="0" parentID="-1" restricted="1">
    <dc:title>${xmlEscape(title)}</dc:title>
    <upnp:artist>${xmlEscape(artist)}</upnp:artist>
    <upnp:album>${xmlEscape(album)}</upnp:album>
    <upnp:class>object.item.audioItem.musicTrack</upnp:class>
    <res>${xmlEscape(uri)}</res>
  </item>
</DIDL-Lite>`.trim();

            const response = await soapCall(this.sonosQueueService.controlURL, this.sonosQueueService.serviceType, 'AddURIToQueue', {
                QueueID: 0,
                EnqueuedURI: uri,
                EnqueuedURIMetadata: metadata,
                DesiredFirstTrackNumberEnqueued: 0,
                EnqueueAsNext: 0
            });
            return response ? response.FirstTrackNumberEnqueued : null;
        }
        throw new Error('Playlist service not found');
    }

    async deleteTrack(id) {
        if (this.sonosDevice) {
            try {
                const trackIndex = parseInt(id, 10);
                // Sonos removeTrackFromQueue (index is 1-based)
                return await this.sonosDevice.removeTrackFromQueue(trackIndex);
            } catch (err) {
                console.error(`Sonos deleteTrack(${id}) failed:`, err.message);
                throw err;
            }
        } else if (this.playlistService) {
            return await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'Delete', { Id: id });
        } else if (this.sonosQueueService) {
            return await soapCall(this.sonosQueueService.controlURL, this.sonosQueueService.serviceType, 'RemoveTrackFromQueue', {
                QueueID: 0,
                Index: id
            });
        }
        throw new Error('Playlist service not found');
    }

    async clearPlaylist() {
        if (this.sonosDevice) {
            await this.sonosDevice.flush();
            // Give the device a moment to refresh its internal state
            await new Promise(resolve => setTimeout(resolve, 500));
            return true;
        } else if (this.playlistService) {
            return await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'DeleteAll');
        } else if (this.sonosQueueService) {
            return await soapCall(this.sonosQueueService.controlURL, this.sonosQueueService.serviceType, 'RemoveAllTracksFromQueue', {
                QueueID: 0
            });
        }
        throw new Error('Playlist service not found');
    }

    async getIdArray() {
        if (this.sonosDevice) {
            const playlist = await this._getSonosPlaylistViaLib();
            return playlist.map(item => item.id);
        } else if (this.playlistService) {
            const idArrayRes = await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'IdArray');
            const raw = idArrayRes ? (idArrayRes.Array !== undefined ? idArrayRes.Array : idArrayRes.IdArray) : null;
            const rawArray = this._getText(raw);

            const ids = [];
            if (rawArray && rawArray.trim().length > 0) {
                const buffer = Buffer.from(rawArray, 'base64');
                for (let i = 0; i < buffer.length; i += 4) {
                    ids.push(buffer.readUInt32BE(i));
                }
            }
            return ids;
        } else if (this.sonosQueueService) {
            const playlist = await this._getSonosPlaylist();
            return playlist.map(item => item.id);
        }
        throw new Error('Playlist service not found');
    }

    async play() {
        if (this.sonosDevice) {
            return await this.sonosDevice.play();
        } else if (this.playlistService) {
            return await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'Play');
        } else if (this.avTransportService) {
            return await soapCall(this.avTransportService.controlURL, this.avTransportService.serviceType, 'Play', { InstanceID: 0, Speed: 1 });
        }
        throw new Error('Playback service not found');
    }

    async pause() {
        if (this.sonosDevice) {
            return await this.sonosDevice.pause();
        } else if (this.playlistService) {
            return await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'Pause');
        } else if (this.avTransportService) {
            return await soapCall(this.avTransportService.controlURL, this.avTransportService.serviceType, 'Pause', { InstanceID: 0 });
        }
        throw new Error('Playback service not found');
    }

    async stop() {
        if (this.sonosDevice) {
            return await this.sonosDevice.stop();
        } else if (this.playlistService) {
            return await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'Stop');
        } else if (this.avTransportService) {
            return await soapCall(this.avTransportService.controlURL, this.avTransportService.serviceType, 'Stop', { InstanceID: 0 });
        }
        throw new Error('Playback service not found');
    }

    async getCurrentStatus() {
        if (this.sonosDevice) {
            const state = await this.sonosDevice.getCurrentState();
            const position = await this.sonosDevice.currentTrack();
            return {
                trackId: position ? position.queuePosition : null,
                transportState: state === 'playing' ? 'Playing' : (state === 'paused' ? 'Paused' : 'Stopped')
            };
        } else if (this.playlistService) {
            const [idRes, stateRes] = await Promise.all([
                soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'Id'),
                soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'TransportState')
            ]);
            return {
                trackId: idRes ? idRes.Value || idRes.Id : null,
                transportState: stateRes ? stateRes.Value || stateRes.TransportState : 'Stopped'
            };
        } else if (this.avTransportService) {
            const info = await soapCall(this.avTransportService.controlURL, this.avTransportService.serviceType, 'GetTransportInfo', { InstanceID: 0 });
            const pos = await soapCall(this.avTransportService.controlURL, this.avTransportService.serviceType, 'GetPositionInfo', { InstanceID: 0 });
            return {
                trackId: pos ? pos.Track : null,
                transportState: info ? info.CurrentTransportState : 'Stopped'
            };
        }
        throw new Error('Status service not found');
    }

    async seekId(id) {
        if (this.sonosDevice) {
            try {
                const trackIndex = parseInt(id, 10);
                console.log(`[DEBUG] Sonos seeking to index ${trackIndex} on ${this.device.friendlyName}`);

                // Ensure we are in queue mode
                await this.sonosDevice.selectQueue();

                // Small delay to let the device switch source
                await new Promise(resolve => setTimeout(resolve, 500));

                try {
                    // Select the track (1-based index)
                    await this.sonosDevice.selectTrack(trackIndex);
                } catch (seekErr) {
                    console.warn(`[DEBUG] Initial Sonos selectTrack failed, retrying in 1s: ${seekErr.message}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await this.sonosDevice.selectTrack(trackIndex);
                }

                // Start playback
                return await this.sonosDevice.play();
            } catch (err) {
                console.error(`Sonos seekId(${id}) failed for ${this.device.friendlyName}:`, err.message);
                throw err;
            }
        } else if (this.playlistService) {
            return await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'SeekId', { Value: id });
        } else if (this.avTransportService && this.sonosQueueService) {
            // Sonos "seek" to a track in queue is usually done via Seek with Unit=TRACK_NR
            return await soapCall(this.avTransportService.controlURL, this.avTransportService.serviceType, 'Seek', {
                InstanceID: 0,
                Unit: 'TRACK_NR',
                Target: id
            });
        }
        throw new Error('Seek service not found');
    }
}
