// The peer link's media service: another AMMUI's shared library, shown here as one more media
// server alongside the DLNA ones, browsed, played, queued, searched and downloaded the same way.
//
// On the server that shares (mediaServiceRouter, served by the PeerListener at /peer/v1/media):
//   GET /browse?path=music/Artist  -> { path, items: [...] }   one folder, as the local DLNA
//                                     server lists it (tags, sizes, album folders), shared only
//   GET /file?path=...              -> the file (Range supported)
//   GET /art?path=music/Artist/Album -> the album's cover
//
// On the server that connects:
//   - PeerMediaServer has MediaServer's browse()/browseRecursive(), so everything that takes a
//     media server takes a peer as it is (see createMediaServer in media-server.js).
//   - Items' URLs point at this server (/peer-media/<peer id>/file/<path>), which streams them
//     from the peer (mountPeerMediaRoutes). DLNA renderers on this network can't reach the
//     other server, nor speak the peer link, but they can reach this one.
import { promises as fsp } from 'fs';
import path from 'path';
import express from 'express';
import MediaServer from '../media-server.js';
import { mediaKey } from '../media-key.js';
import { PeerError } from '../peer-link.js';

export const MEDIA_SERVICE = 'media';
export const MEDIA_SERVICE_VERSION = 1;

const SECTIONS = ['music', 'pictures', 'videos'];
const HIDDEN_NAMES = /^(\.|thumbs\.db$|desktop\.ini$)/i;
const MAX_ITEMS = 20000;

// A library path from the other end ("music/Artist/Album"), checked: no "..", nothing hidden,
// inside one of the three sections. Throws a 400 for anything else. '' is the top.
export function cleanLibraryPath(p) {
    const text = String(p ?? '');
    if (text.includes('\0') || text.length > 4096) throw new PeerError('Bad path', 'BAD_PATH', 400);
    const parts = text.replace(/\\/g, '/').split('/').filter(Boolean);
    const badPart = s => s === '.' || s === '..' || HIDDEN_NAMES.test(s) || (process.platform === 'win32' && /[<>:"|?*]/.test(s));
    if (parts.some(badPart) || (parts.length && !SECTIONS.includes(parts[0]))) throw new PeerError('Bad path', 'BAD_PATH', 400);
    return parts.join('/');
}

// --- What's shared -------------------------------------------------------------------------

// Share flags: { "music/Artist": "on", "music/Artist/Live": "off" }. Anything without a flag of
// its own takes its folder's, and the top of the library is off, so nothing is shared until a
// folder or file is switched on. Paths compare case-insensitively on Windows, as its files do.
const shareKey = p => {
    const s = String(p ?? '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
    return process.platform === 'win32' ? s.toLowerCase() : s;
};

export class ShareRules {
    constructor(flags = {}) {
        this.flags = new Map();
        for (const [p, v] of Object.entries(flags || {})) {
            if (v === 'on' || v === 'off') this.flags.set(shareKey(p), v === 'on');
        }
        this.onPaths = [...this.flags].filter(([, on]) => on).map(([k]) => k);
    }

    shared(rel) {
        const parts = shareKey(rel).split('/').filter(Boolean);
        for (let i = parts.length; i > 0; i--) {
            const on = this.flags.get(parts.slice(0, i).join('/'));
            if (on !== undefined) return on;
        }
        return false;
    }

    // A folder that isn't shared but has something shared inside it is still listed (showing only
    // the shared things), so the other server can get down to them
    visibleFolder(rel) {
        if (this.shared(rel)) return true;
        const k = shareKey(rel);
        const prefix = k ? k + '/' : '';
        return this.onPaths.some(p => p.startsWith(prefix) && p !== k);
    }
}

// --- The sharing side -----------------------------------------------------------------------

const notFound = () => new PeerError('Not found', 'NOT_FOUND', 404);

// The real path of `rel` under `root`, which must stay inside its section's folder (the section
// folder itself may be a link elsewhere, such as to another drive; links below it may not leave it).
// `canonical` is the path as it really is on disk ("music/Artist" however it was asked for, such
// as in another case or by a short 8.3 name on Windows), which is what share flags are checked on.
async function resolveInLibrary(root, rel) {
    if (!rel) throw notFound();
    const [section] = rel.split('/');
    try {
        const sectionReal = await fsp.realpath(path.join(root, section));
        const real = await fsp.realpath(path.join(root, ...rel.split('/')));
        if (real !== sectionReal && !real.startsWith(sectionReal + path.sep)) throw new Error('outside');
        const below = path.relative(sectionReal, real).split(path.sep).filter(Boolean);
        return { real, canonical: [section, ...below].join('/') };
    } catch (e) {
        throw notFound();
    }
}

// One library item as it goes over the wire: the local DLNA listing without its URLs (which
// point at this server's own address), and nothing the other end doesn't need.
function toWire(item) {
    const base = { path: item.id, title: item.title, class: item.class };
    if (item.isContainer) {
        const v = item.albumArtUrl && /[?&]v=(\d+)/.exec(item.albumArtUrl);
        return { ...base, type: 'container', art: !!item.albumArtUrl, artVersion: v ? Number(v[1]) : undefined };
    }
    return {
        ...base, type: 'item', mime: item.mime,
        artist: item.artist || undefined, albumArtist: item.albumArtist || undefined, album: item.album || undefined,
        genre: item.genre || undefined, year: item.year || undefined, trackNumber: item.trackNumber || undefined,
        duration: item.duration || undefined, size: item.size || undefined, resolution: item.resolution || undefined,
    };
}

// `listChildren(objectId, baseUrl, { include })` is the local DLNA server's folder listing;
// `resolveArt(dir)` its album art lookup ({ path } | { data, contentType } | null);
// `getShares()` the current ShareRules.
export function mediaServiceRouter({ libraryRoot, getShares, listChildren, resolveArt }) {
    const router = express.Router();

    router.get('/browse', async (req, res, next) => {
        try {
            const rel = cleanLibraryPath(req.query.path);
            const rules = getShares();
            if (!rel) {
                const items = [];
                for (const name of SECTIONS) {
                    try {
                        if (rules.visibleFolder(name) && (await fsp.stat(path.join(libraryRoot, name))).isDirectory()) {
                            items.push({ type: 'container', path: name, title: name, class: 'object.container.storageFolder' });
                        }
                    } catch (e) { }
                }
                return res.json({ path: '', items });
            }
            const { real, canonical } = await resolveInLibrary(libraryRoot, rel);
            if (!rules.visibleFolder(canonical) || !(await fsp.stat(real)).isDirectory()) throw notFound();
            const include = d => {
                if (HIDDEN_NAMES.test(d.name) || d.isSymbolicLink()) return false;
                const child = `${canonical}/${d.name}`;
                return d.isDirectory() ? rules.visibleFolder(child) : d.isFile() && rules.shared(child);
            };
            const items = (await listChildren(canonical, '', { include })).map(toWire);
            res.json({ path: canonical, items: items.slice(0, MAX_ITEMS), truncated: items.length > MAX_ITEMS });
        } catch (e) { next(e); }
    });

    router.get('/file', async (req, res, next) => {
        try {
            const rel = cleanLibraryPath(req.query.path);
            const { real, canonical } = await resolveInLibrary(libraryRoot, rel);
            if (!getShares().shared(canonical)) throw notFound();
            if (!(await fsp.stat(real)).isFile()) throw notFound();
            if (!req.headers.range) console.log(`[PEER] "${req.peerSession.name}" is fetching ${rel}`);
            res.sendFile(real, { dotfiles: 'allow', lastModified: true, cacheControl: false }, err => {
                if (err && !res.headersSent) next(err);
            });
        } catch (e) { next(e); }
    });

    // The cover of a folder that's shared, or has shared files in it
    router.get('/art', async (req, res, next) => {
        try {
            const rel = cleanLibraryPath(req.query.path);
            const { real, canonical } = await resolveInLibrary(libraryRoot, rel);
            const rules = getShares();
            let allowed = rules.shared(canonical);
            if (!allowed && rules.visibleFolder(canonical)) {
                const names = await fsp.readdir(real).catch(() => []);
                allowed = names.some(n => !HIDDEN_NAMES.test(n) && rules.shared(`${canonical}/${n}`));
            }
            if (!allowed || !(await fsp.stat(real)).isDirectory()) throw notFound();
            const art = await resolveArt(real);
            if (!art) throw notFound();
            if (art.path) return res.sendFile(art.path, { dotfiles: 'allow', cacheControl: false }, err => { if (err && !res.headersSent) next(err); });
            res.type(art.contentType || 'image/jpeg').send(art.data);
        } catch (e) { next(e); }
    });

    return router;
}

// --- The connecting side --------------------------------------------------------------------

const encodePath = rel => rel.split('/').map(encodeURIComponent).join('/');
const text = (v, max = 500) => typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, '').slice(0, max) : '';
const MIME = /^(audio|video|image)\/[\w.+-]{1,64}$/;

// A peer's library as a media server. `peers` is the PeerConnections; `origin()` is this
// server's own http://<lan address>:<port>, which items' URLs are on.
export class PeerMediaServer extends MediaServer {
    constructor(device, { peers, origin }) {
        super(device);
        this.peerId = device.peerId;
        this.peers = peers;
        this.origin = origin;
    }

    fileUrl(rel) { return `${this.origin()}/peer-media/${encodeURIComponent(this.peerId)}/file/${encodePath(rel)}`; }
    artUrl(rel, version) { return `${this.origin()}/peer-media/${encodeURIComponent(this.peerId)}/art/${encodePath(rel)}${version ? `?v=${version}` : ''}`; }

    async browse(objectId = '0', timeoutMs = 30000) {
        const svc = this.peers.service(this.peerId, MEDIA_SERVICE);
        if (!svc.version()) throw new PeerError(`${this.device.friendlyName} doesn't share media over the peer link`, 'NO_SERVICE', 502);
        const rel = objectId === '0' ? '' : cleanLibraryPath(objectId);
        // Over the internet, and the other end reads every track's tags the first time: allow time
        const data = await svc.getJson('/browse', { path: rel }, { timeout: Math.max(timeoutMs, 60000) });
        let parent;
        try { parent = cleanLibraryPath(data.path); } catch (e) { parent = rel; }
        const folderArt = this.artUrl(parent);

        // Never trust what comes from the other end further than it needs to go: every path
        // must be a direct child of the folder asked for, inside the library
        const items = [];
        for (const it of Array.isArray(data.items) ? data.items : []) {
            let p;
            try { p = cleanLibraryPath(it?.path); } catch (e) { continue; }
            const slash = p.lastIndexOf('/');
            if (!p || (slash === -1 ? '' : p.slice(0, slash)) !== parent) continue;
            const title = text(it.title) || p.slice(slash + 1);
            const cls = /^object\.[\w.]{1,80}$/.test(it.class || '') ? it.class : '';
            if (it.type === 'container') {
                items.push({
                    id: p, type: 'container', title, artist: '', albumArtist: '',
                    class: cls || 'object.container.storageFolder',
                    albumArtUrl: it.art ? this.artUrl(p, Number.isFinite(it.artVersion) ? it.artVersion : 0) : '',
                });
            } else if (it.type === 'item') {
                const mime = MIME.test(it.mime || '') ? it.mime : 'application/octet-stream';
                const uri = this.fileUrl(p);
                items.push({
                    id: p, type: 'item', title,
                    artist: text(it.artist), albumArtist: text(it.albumArtist), album: text(it.album),
                    genre: text(it.genre), year: text(it.year, 32), class: cls || 'object.item',
                    uri,
                    // Tracks show their album's cover; photos are their own picture
                    albumArtUrl: mime.startsWith('audio/') ? folderArt : mime.startsWith('image/') ? uri : '',
                    trackNumber: Number.isInteger(it.trackNumber) ? it.trackNumber : 0,
                    discNumber: 1,
                    duration: text(it.duration, 32) || null,
                    size: Number.isFinite(it.size) ? it.size : null,
                    resolution: /^\d{1,6}x\d{1,6}$/.test(it.resolution || '') ? it.resolution : null,
                    bitrate: null,
                    protocolInfo: `http-get:*:${mime}:*`,
                    key: mediaKey(uri),
                });
            }
        }
        return items;
    }
}

// --- Streaming to this network ---------------------------------------------------------------

// Pictures, music and video are served as what they are; anything else as a download, so nothing
// from the other server can run as a page on this one.
const INLINE_TYPES = /\.(mp3|flac|m4a|aac|wav|ogg|opus|wma|aiff|jpe?g|png|webp|gif|bmp|heic|mp4|m4v|mov|webm|mkv|avi)$/i;

// GET /peer-media/<peer id>/file/<path> and /peer-media/<peer id>/art/<folder path>: the files
// PeerMediaServer's items point at, fetched from the peer as they're asked for (Range passed on,
// so seeking works). On the app's own port, as /local-files is, for the renderers on this network.
export function mountPeerMediaRoutes(app, peers) {
    const relOf = req => cleanLibraryPath([].concat(req.params.rel || []).join('/'));

    const pipeFrom = async (req, res, open, decorate) => {
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableFinished) ac.abort(); });
        try {
            const r = await open(ac.signal);
            res.status(r.status);
            for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
                if (r.headers[h]) res.setHeader(h, r.headers[h]);
            }
            decorate?.(res);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            if (req.method === 'HEAD') {
                res.end();
                r.res.destroy();
                return;
            }
            r.res.on('error', () => res.destroy());
            r.res.pipe(res);
        } catch (err) {
            if (err.code === 'CANCELLED') return;
            if (res.headersSent) return res.destroy();
            if (!(err instanceof PeerError)) console.error('[PEER]', err);
            res.status(err.status || 502).json({ error: err.message, code: err.code });
        }
    };

    app.get('/peer-media/:id/file/*rel', (req, res) => {
        let rel;
        try { rel = relOf(req); } catch (err) { return res.status(400).json({ error: err.message }); }
        const name = rel.split('/').pop();
        pipeFrom(req, res,
            signal => peers.service(req.params.id, MEDIA_SERVICE).open('/file', { path: rel }, { range: req.headers.range, signal }),
            r => {
                if (!INLINE_TYPES.test(name)) r.attachment(name);
                else if (!r.getHeader('content-type')) r.type(path.extname(name));
                r.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
            });
    });

    app.get('/peer-media/:id/art/*rel', (req, res) => {
        let rel;
        try { rel = relOf(req); } catch (err) { return res.status(400).json({ error: err.message }); }
        pipeFrom(req, res,
            signal => peers.service(req.params.id, MEDIA_SERVICE).open('/art', { path: rel }, { signal, timeout: 30000 }),
            r => {
                r.setHeader('Cache-Control', req.query.v ? 'public, max-age=86400' : 'no-cache');
                if (!/^image\//.test(String(r.getHeader('content-type') || ''))) r.setHeader('Content-Type', 'image/jpeg');
            });
    });
}
