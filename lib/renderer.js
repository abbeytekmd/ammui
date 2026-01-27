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
        this.volumeService = services.find(s => s.serviceType.indexOf('Volume') !== -1);
        this.renderingControlService = services.find(s => s.serviceType.indexOf('RenderingControl') !== -1);

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

        console.error(`[DEBUG] Renderer for ${device.friendlyName}: sonosQueueService=${!!this.sonosQueueService}, sonosDevice=${!!this.sonosDevice}, playlistService=${!!this.playlistService}, volumeService=${!!this.volumeService}, renderingControlService=${!!this.renderingControlService}`);

        if (!this.playlistService && !this.sonosDevice && !this.sonosQueueService) {
            console.warn(`Renderer created for ${device.friendlyName} but no playlist service found. Services:`, services.map(s => s.serviceType));
        }
    }

    async getVolume() {
        if (this.volumeService) {
            const res = await soapCall(this.volumeService.controlURL, this.volumeService.serviceType, 'Volume');
            return parseInt(res.Value || res.Volume, 10);
        } else if (this.sonosDevice) {
            return await this.sonosDevice.getVolume();
        } else if (this.renderingControlService) {
            const res = await soapCall(this.renderingControlService.controlURL, this.renderingControlService.serviceType, 'GetVolume', { InstanceID: 0, Channel: 'Master' });
            return parseInt(res.CurrentVolume, 10);
        }
        return 0;
    }

    async setVolume(volume) {
        if (this.volumeService) {
            return await soapCall(this.volumeService.controlURL, this.volumeService.serviceType, 'SetVolume', { Value: volume });
        } else if (this.sonosDevice) {
            return await this.sonosDevice.setVolume(volume);
        } else if (this.renderingControlService) {
            return await soapCall(this.renderingControlService.controlURL, this.renderingControlService.serviceType, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: volume });
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
                    uri: entry.Uri || this._getText(item.res),
                    duration: (() => {
                        const resDuration = (item.res && item.res.$ && item.res.$.duration) ? item.res.$.duration : null;
                        const itemDuration = this._getText(item.duration || item['upnp:duration'] || item['dc:duration']);
                        return resDuration || itemDuration || null;
                    })()
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

            if (!queue || !queue.items) {
                console.error('[DEBUG] Sonos queue is empty or undefined');
                return [];
            }

            console.error(`[DEBUG] Sonos queue has ${queue.items.length} items`);

            const result = queue.items.map((item, index) => {
                return {
                    id: index + 1,
                    title: item.title || 'Unknown Title',
                    artist: item.artist || '',
                    album: item.album || '',
                    uri: item.uri,
                    duration: item.duration || 0
                };
            });

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
                    id: index + 1, // Use index + 1 as the ID for Sonos SOAP browse
                    title: title,
                    artist: this._getText(item.artist || item['upnp:artist']),
                    album: this._getText(item.album || item['upnp:album']),
                    uri: this._getText(item.res),
                    duration: (() => {
                        const resDuration = (item.res && item.res.$ && item.res.$.duration) ? item.res.$.duration : null;
                        const itemDuration = this._getText(item.duration || item['upnp:duration'] || item['dc:duration']);
                        return resDuration || itemDuration || null;
                    })()
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
            const { uri, title, artist, album, duration, protocolInfo } = track;
            // Build complete DIDL-Lite metadata for Sonos
            const metadata = `
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="f0002000s0" parentID="Q:0" restricted="1">
    <dc:title>${xmlEscape(title || 'Unknown Title')}</dc:title>
    <dc:creator>${xmlEscape(artist || 'Unknown Artist')}</dc:creator>
    <upnp:artist>${xmlEscape(artist || 'Unknown Artist')}</upnp:artist>
    <upnp:album>${xmlEscape(album || 'Unknown Album')}</upnp:album>
    <upnp:class>object.item.audioItem.musicTrack</upnp:class>
    <res protocolInfo="${xmlEscape(protocolInfo || 'http-get:*:audio/mpeg:*')}" ${duration ? `duration="${xmlEscape(duration)}"` : ''}>${xmlEscape(uri)}</res>
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
                console.log(`[DEBUG] Sonos queue result (with metadata):`, JSON.stringify(result));
                return result ? result.FirstTrackNumberEnqueued : null;
            } catch (err) {
                console.warn('Sonos Lib Queue with metadata failed, retrying with URI only:', err.message);
                try {
                    const position = afterId > 0 ? (parseInt(afterId, 10) + 1) : 0;
                    const result = await this.sonosDevice.queue(uri, position);
                    console.log(`[DEBUG] Sonos queue result (uri only):`, JSON.stringify(result));
                    return result ? result.FirstTrackNumberEnqueued : null;
                } catch (retryErr) {
                    console.error('Sonos Lib Queue total failure:', retryErr.message);
                    throw retryErr;
                }
            }
        } else if (this.playlistService) {
            const { uri, title, artist, album, duration, protocolInfo } = track;
            const metadata = `
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="0" parentID="-1" restricted="1">
    <dc:title>${xmlEscape(title)}</dc:title>
    <upnp:artist>${xmlEscape(artist)}</upnp:artist>
    <upnp:album>${xmlEscape(album)}</upnp:album>
    <upnp:class>object.item.audioItem.musicTrack</upnp:class>
    <res ${protocolInfo ? `protocolInfo="${xmlEscape(protocolInfo)}"` : ''} ${duration ? `duration="${xmlEscape(duration)}"` : ''}>${xmlEscape(uri)}</res>
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
            const { uri, title, artist, album, duration, protocolInfo } = track;
            const metadata = `
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="0" parentID="-1" restricted="1">
    <dc:title>${xmlEscape(title)}</dc:title>
    <upnp:artist>${xmlEscape(artist)}</upnp:artist>
    <upnp:album>${xmlEscape(album)}</upnp:album>
    <upnp:class>object.item.audioItem.musicTrack</upnp:class>
    <res ${protocolInfo ? `protocolInfo="${xmlEscape(protocolInfo)}"` : ''} ${duration ? `duration="${xmlEscape(duration)}"` : ''}>${xmlEscape(uri)}</res>
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
                // Sonos removeTracksFromQueue (index is 1-based)
                return await this.sonosDevice.removeTracksFromQueue(trackIndex, 1);
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
            const result = await this.sonosDevice.play();
            console.log(`[DEBUG] Sonos play() result:`, JSON.stringify(result));
            return result;
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
            try {
                // Use the Sonos library's getTransportInfo which returns more detail than getCurrentState
                const info = await this.sonosDevice.avTransportService().GetTransportInfo({ InstanceID: 0 });
                const position = await this.sonosDevice.currentTrack();

                const state = info.CurrentTransportState;
                const status = info.CurrentTransportStatus;

                if (status !== 'OK') {
                    console.warn(`[DEBUG] Sonos Transport Status for ${this.device.friendlyName}: ${status} (State: ${state})`);
                }

                return {
                    trackId: position ? position.queuePosition : null,
                    transportState: state === 'PLAYING' ? 'Playing' : (state === 'PAUSED_PLAYBACK' ? 'Paused' : (state === 'STOPPED' ? 'Stopped' : state)),
                    transportStatus: status,
                    duration: position ? this._parseTime(position.duration) : 0,
                    relTime: position ? this._parseTime(position.position) : 0
                };
            } catch (err) {
                console.error('Sonos status fetch error:', err.message);
                // Fallback to simpler method if service call fails
                try {
                    const state = await this.sonosDevice.getCurrentState();
                    const position = await this.sonosDevice.currentTrack();
                    return {
                        trackId: position ? position.queuePosition : null,
                        transportState: state === 'playing' ? 'Playing' : (state === 'paused' ? 'Paused' : 'Stopped'),
                        duration: position ? this._parseTime(position.duration) : 0,
                        relTime: position ? this._parseTime(position.position) : 0
                    };
                } catch (innerErr) {
                    return { transportState: 'Error', error: err.message };
                }
            }
        } else if (this.playlistService) {
            try {
                const [idRes, stateRes] = await Promise.all([
                    soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'Id'),
                    soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'TransportState')
                ]);

                let duration = 0;
                let relTime = 0;

                // Try to get time from Time service if available
                const timeService = this.device.services.find(s => s.serviceType.includes('Time'));
                if (timeService) {
                    try {
                        const timeRes = await soapCall(timeService.controlURL, timeService.serviceType, 'Time');
                        // OpenHome Time service usually provides seconds directly as integers
                        duration = parseInt(timeRes.Duration || timeRes.Value || 0, 10);
                        relTime = parseInt(timeRes.Seconds || timeRes.Value || 0, 10);
                    } catch (e) { /* fallback */ }
                }

                return {
                    trackId: idRes ? idRes.Value || idRes.Id : null,
                    transportState: stateRes ? stateRes.Value || stateRes.TransportState : 'Stopped',
                    duration,
                    relTime
                };
            } catch (err) {
                console.error('OpenHome status error:', err.message);
                return { transportState: 'Error' };
            }
        } else if (this.avTransportService) {
            try {
                const info = await soapCall(this.avTransportService.controlURL, this.avTransportService.serviceType, 'GetTransportInfo', { InstanceID: 0 });
                const pos = await soapCall(this.avTransportService.controlURL, this.avTransportService.serviceType, 'GetPositionInfo', { InstanceID: 0 });
                return {
                    trackId: pos ? pos.Track : null,
                    transportState: info ? info.CurrentTransportState : 'Stopped',
                    transportStatus: info ? info.CurrentTransportStatus : 'OK',
                    duration: pos ? this._parseTime(pos.TrackDuration) : 0,
                    relTime: pos ? this._parseTime(pos.RelTime) : 0
                };
            } catch (err) {
                console.error('AVTransport status error:', err.message);
                return { transportState: 'Error' };
            }
        }
        throw new Error('Status service not found');
    }

    _parseTime(time) {
        if (time === null || time === undefined || time === false) return 0;
        if (typeof time === 'number') return Math.floor(time);
        if (typeof time !== 'string') return 0;

        const parts = time.split(':');
        if (parts.length === 3) {
            return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
        } else if (parts.length === 2) {
            return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        }
        return parseInt(time, 10) || 0;
    }

    async seekId(id) {
        if (this.sonosDevice) {
            try {
                const trackIndex = parseInt(id, 10);
                console.log(`[DEBUG] Sonos seeking to index ${trackIndex} on ${this.device.friendlyName}`);

                // Step 1: Stop current playback to avoid "glitch" where first track plays briefly
                try {
                    await this.sonosDevice.stop();
                } catch (e) {
                    // Ignore stop error if already stopped
                }

                // Step 2: Ensure we are in queue mode
                // Note: Only call selectQueue if we are not already in it, as it can cause hiccups
                try {
                    const currentTrack = await this.sonosDevice.currentTrack();
                    if (!currentTrack || !currentTrack.uri || !currentTrack.uri.includes('x-rincon-queue')) {
                        console.log(`[DEBUG] Sonos not in queue mode, selecting queue...`);
                        await this.sonosDevice.selectQueue();
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                } catch (e) {
                    await this.sonosDevice.selectQueue();
                }

                // Step 3: Select the track (1-based index)
                try {
                    await this.sonosDevice.selectTrack(trackIndex);
                } catch (seekErr) {
                    console.warn(`[DEBUG] Initial Sonos selectTrack failed, retrying in 500ms: ${seekErr.message}`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await this.sonosDevice.selectTrack(trackIndex);
                }

                // Step 4: Small delay to ensure the device has buffered the new track
                await new Promise(resolve => setTimeout(resolve, 200));

                // Step 5: Start playback
                const result = await this.sonosDevice.play();
                console.log(`[DEBUG] Sonos seekId play result:`, JSON.stringify(result));
                return result;
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
    async seekTime(seconds) {
        if (this.sonosDevice) {
            try {
                const result = await this.sonosDevice.seek(seconds);
                console.log(`[DEBUG] Sonos seekTime result:`, JSON.stringify(result));
                return result;
            } catch (err) {
                console.error('Sonos seekTime failed:', err.message);
                throw err;
            }
        }

        // Try OpenHome Time service
        const timeService = this.device.services.find(s => s.serviceType.includes('Time'));
        if (timeService) {
            try {
                return await soapCall(timeService.controlURL, timeService.serviceType, 'Seek', { Value: seconds });
            } catch (err) { /* fallback */ }
        }

        // Try AVTransport
        if (this.avTransportService) {
            try {
                const target = this._formatRelTime(seconds);
                return await soapCall(this.avTransportService.controlURL, this.avTransportService.serviceType, 'Seek', {
                    InstanceID: 0,
                    Unit: 'REL_TIME',
                    Target: target
                });
            } catch (err) {
                console.error('AVTransport seekTime failed:', err.message);
                throw err;
            }
        }
        throw new Error('Seeking not supported on this device');
    }

    _formatRelTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return `${h.toString().padStart(1, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
}
