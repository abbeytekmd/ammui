import { soapCall, xmlEscape } from './upnp.js';
import xml2js from 'xml2js';

export default class Renderer {
    constructor(device) {
        this.device = device;
        this.playlistService = device.services.find(s => s.serviceType.indexOf('Playlist') !== -1);
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

    async insertTrack(track, afterId = 0) {
        if (!this.playlistService) {
            throw new Error('Playlist service not found');
        }

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
    }

    async deleteTrack(id) {
        if (!this.playlistService) {
            throw new Error('Playlist service not found');
        }
        return await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'Delete', { Id: id });
    }

    async clearPlaylist() {
        if (!this.playlistService) {
            throw new Error('Playlist service not found');
        }
        return await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'DeleteAll');
    }

    async getIdArray() {
        if (!this.playlistService) {
            throw new Error('Playlist service not found');
        }
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
    }

    async play() {
        if (!this.playlistService) throw new Error('Playlist service not found');
        return await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'Play');
    }

    async pause() {
        if (!this.playlistService) throw new Error('Playlist service not found');
        return await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'Pause');
    }

    async stop() {
        if (!this.playlistService) throw new Error('Playlist service not found');
        return await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'Stop');
    }

    async getCurrentStatus() {
        if (!this.playlistService) throw new Error('Playlist service not found');
        const [idRes, stateRes] = await Promise.all([
            soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'Id'),
            soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'TransportState')
        ]);
        return {
            trackId: idRes ? idRes.Value || idRes.Id : null,
            transportState: stateRes ? stateRes.Value || stateRes.TransportState : 'Stopped'
        };
    }

    async seekId(id) {
        if (!this.playlistService) throw new Error('Playlist service not found');
        return await soapCall(this.playlistService.controlURL, this.playlistService.serviceType, 'SeekId', { Value: id });
    }
}
