// "Fix Track Order" on a music folder: finds the album's release (MusicBrainz, then Discogs with a
// token), matches each audio file in the folder to a track on it by title, length and disc, and
// works out the track and disc numbers to tag it with. Discs after the first carry on numbering
// from the ones before (disc 2 of 12 + 10 tracks starts at 13), so the tracks sort in album order
// by track number alone, whether the discs share one folder or are in folders of their own.
// Nothing is written here: see the /api/local/track-order endpoints in server.js.
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { parseFile } from 'music-metadata';

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma', '.aiff']);
const USER_AGENT = 'AMMUI/1.0 (home media app)';

// ─── Folders and files ─────────────────────────────────────────────────────────

// "Aerial CD2", "Disc 3", "Singing The Spirit Home - CD 1", "Hits (Disc 2 of 3)" -> the disc number
const DISC_SUFFIX = /(?:^|[\s\-_.,:([])(?:cd|disc|disk)\s*[-_.]?\s*(\d{1,2})(?:\s*(?:of|\/)\s*\d{1,2})?\s*[)\]]?\s*$/i;
export const discFromName = name => {
    const m = String(name || '').match(DISC_SUFFIX);
    return m ? Number(m[1]) : null;
};
// The same name without the disc: "Aerial CD2" -> "Aerial"
const withoutDisc = name => String(name || '').replace(DISC_SUFFIX, '').replace(/[\s\-_:,([]+$/, '').trim();

// The audio files of an album folder: its own, and those in any subfolders named as discs (CD1,
// Disc 2), each with the disc its folder's name gives (or null). otherFolders are subfolders that
// aren't discs, so aren't included.
async function collectFiles(dir) {
    const files = [];
    const otherFolders = [];
    const add = async (folder, discHint, label) => {
        const entries = await fs.promises.readdir(folder, { withFileTypes: true });
        for (const e of entries) {
            if (e.isFile() && AUDIO_EXTS.has(path.extname(e.name).toLowerCase()) && !e.name.startsWith('.')) {
                files.push({ path: path.join(folder, e.name), name: e.name, folder: label, discHint });
            }
        }
        return entries;
    };
    const entries = await add(dir, discFromName(path.basename(dir)), '');
    for (const e of entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
        const disc = discFromName(e.name);
        if (disc) await add(path.join(dir, e.name), disc, e.name);
        else otherFolders.push(e.name);
    }
    return { files, otherFolders };
}

// A file's tags: { title, artist, albumArtist, album, track, disc, duration (seconds) }
async function readTags(file) {
    try {
        const { common: c = {}, format = {} } = await parseFile(file.path, { duration: true, skipCovers: true });
        return {
            title: c.title || '', artist: c.artist || '', albumArtist: c.albumartist || '', album: c.album || '',
            track: c.track?.no || null, disc: c.disk?.no || null, duration: format.duration || null,
        };
    } catch {
        return { title: '', artist: '', albumArtist: '', album: '', track: null, disc: null, duration: null };
    }
}

// The commonest of some names, or '' (and how many different ones there were)
function commonest(values) {
    const counts = new Map();
    for (const v of values.map(v => (v || '').trim()).filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    return { value: best ? best[0] : '', distinct: counts.size };
}

// What to search for: the album and artist the tags mostly say, else the folder names
// (Music/Artist/Album CD1)
function albumAndArtist(dir, files) {
    const album = withoutDisc(commonest(files.map(f => f.tags.album)).value) || withoutDisc(path.basename(dir));
    const albumArtist = commonest(files.map(f => f.tags.albumArtist));
    const artists = commonest(files.map(f => f.tags.artist));
    let artist = albumArtist.value || (artists.distinct <= 2 ? artists.value : '');
    if (/^various( artists)?$/i.test(artist)) artist = '';
    if (!artist && artists.distinct <= 2) artist = path.basename(path.dirname(dir));
    if (/^(music|local)$/i.test(artist)) artist = '';
    return { album, artist };
}

// ─── Titles ────────────────────────────────────────────────────────────────────

// For comparing titles: no accents, case, punctuation, "(Remastered 2011)" and the like, or "feat. ..."
const normTitle = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\s*[([][^)\]]*(remaster|live|version|edit|mix|mono|stereo|bonus|feat|demo|single|take)[^)\]]*[)\]]/g, '')
    .replace(/\s+(feat|ft|featuring)\.?\s.*$/, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// A file's title: its tag, else its name without a track number ("01 - ", "1-03 ") or artist
function fileTitle(file, artist) {
    if (file.tags.title) return file.tags.title;
    let name = path.basename(file.name, path.extname(file.name)).replace(/^\s*\d{1,2}[-.]\d{1,3}\s*[-._ )]\s*/, '').replace(/^\s*\d{1,3}\s*[-._ )]\s*/, '');
    const parts = name.split(/\s+-\s+/);
    if (parts.length > 1 && artist && normTitle(parts[0]) === normTitle(artist)) name = parts.slice(1).join(' - ');
    return name.trim();
}

const bigrams = s => { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; };
// 0-1, how alike two normalized titles are
function titleSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const [short, long] = a.length < b.length ? [a, b] : [b, a];
    if (short.length >= 4 && long.includes(short)) return 0.9;
    const x = bigrams(a.replace(/ /g, '')), y = bigrams(b.replace(/ /g, ''));
    if (!x.length || !y.length) return 0;
    const pool = new Map();
    for (const g of y) pool.set(g, (pool.get(g) || 0) + 1);
    let hits = 0;
    for (const g of x) if (pool.get(g) > 0) { hits++; pool.set(g, pool.get(g) - 1); }
    return (2 * hits) / (x.length + y.length);
}

// ─── Looking up releases ───────────────────────────────────────────────────────
// A release here: { source, id, title, artist, date, country, url, discs: [{ title, format,
// tracks: [{ title, length (seconds or null) }] }] } with the discs in order.

// MusicBrainz allows one request a second
let mbChain = Promise.resolve();
let mbLast = 0;
function mbGet(endpoint, params) {
    const run = mbChain.then(async () => {
        const wait = mbLast + 1100 - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        // A busy server answers 503: wait longer each time and try again
        for (let attempt = 0; ; attempt++) {
            mbLast = Date.now();
            try {
                const res = await axios.get(`https://musicbrainz.org/ws/2/${endpoint}`, {
                    params: { ...params, fmt: 'json' }, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeout: 15000,
                });
                return res.data;
            } catch (err) {
                if (err.response?.status !== 503 || attempt >= 4) throw err;
                await new Promise(r => setTimeout(r, 1500 * 2 ** attempt));
            }
        }
    });
    mbChain = run.catch(() => { });
    return run;
}

const luceneEscape = s => String(s).replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
const VIDEO_MEDIA = /dvd|blu-ray|video|vhs/i;

const releaseCache = new Map(); // `${source}:${id}` -> release

async function musicBrainzRelease(id) {
    const key = `musicbrainz:${id}`;
    if (releaseCache.has(key)) return releaseCache.get(key);
    const r = await mbGet(`release/${encodeURIComponent(id)}`, { inc: 'recordings+artist-credits' });
    const release = {
        source: 'musicbrainz', id: r.id, title: r.title,
        artist: (r['artist-credit'] || []).map(a => a.name + (a.joinphrase || '')).join('') || '',
        date: r.date || '', country: r.country || '', url: `https://musicbrainz.org/release/${r.id}`,
        discs: (r.media || []).filter(m => m.tracks?.length && !VIDEO_MEDIA.test(m.format || '')).map(m => ({
            title: m.title || '', format: m.format || '',
            tracks: m.tracks.map(t => ({ title: t.title || t.recording?.title || '', length: (t.length ?? t.recording?.length) ? (t.length ?? t.recording.length) / 1000 : null })),
        })),
    };
    releaseCache.set(key, release);
    return release;
}

// The likeliest few MusicBrainz releases for an album: [{ source, id }], best first, without
// near-identical pressings (same name, discs and track counts)
async function musicBrainzSearch(query) {
    const data = await mbGet('release/', { query, limit: 15 });
    const seen = new Set();
    const out = [];
    for (const r of (data.releases || []).filter(r => r.score >= 70)) {
        const media = (r.media || []).filter(m => !VIDEO_MEDIA.test(m.format || ''));
        const shape = `${normTitle(r.title)}|${media.map(m => m['track-count']).join(',')}`;
        if (seen.has(shape)) continue;
        seen.add(shape);
        out.push({ source: 'musicbrainz', id: r.id });
    }
    return out;
}

// "Hits [VINYL]", "(Remastered)", "Name: The Subtitle" -> "Hits", "Name"
const plainAlbum = album => album.replace(/\s*[[(][^\])]*[\])]/g, '').replace(/\s*[:_]\s.*$/, '').trim();
const words = s => normTitle(s).split(' ').filter(w => w.length > 1).map(luceneEscape).join(' ');

// Tried in turn until one finds something: the album and artist as they are, the album without
// anything in brackets or after a colon, then their words in any order (so "Beatles" finds "The Beatles")
async function musicBrainzCandidates(album, artist) {
    const byArtist = a => (a ? ` AND artist:"${luceneEscape(a)}"` : '');
    const plain = plainAlbum(album);
    const queries = [
        `release:"${luceneEscape(album)}"${byArtist(artist)}`,
        plain && plain !== album ? `release:"${luceneEscape(plain)}"${byArtist(artist)}` : null,
        words(plain || album) ? `release:(${words(plain || album)})${artist && words(artist) ? ` AND artist:(${words(artist)})` : ''}` : null,
        artist ? `release:"${luceneEscape(plain || album)}"` : null,
    ].filter(Boolean);
    for (const q of [...new Set(queries)]) {
        const found = await musicBrainzSearch(q);
        if (found.length) return found;
    }
    return [];
}

// Discogs positions: "1-3", "2.5", "CD2-4" give the disc; vinyl sides and plain numbers are one run
const discogsDisc = pos => {
    const m = String(pos || '').match(/^(?:cd|disc)?\s*(\d+)[-.](\d+)/i);
    return m ? Number(m[1]) : 1;
};
const discogsLength = s => {
    const m = String(s || '').match(/^(?:(\d+):)?(\d+):(\d{2})$/);
    return m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : null;
};

async function discogsRelease(id, token) {
    const key = `discogs:${id}`;
    if (releaseCache.has(key)) return releaseCache.get(key);
    const { data: r } = await axios.get(`https://api.discogs.com/releases/${encodeURIComponent(id)}`, {
        params: { token }, headers: { 'User-Agent': USER_AGENT }, timeout: 15000,
    });
    const byDisc = new Map();
    for (const t of (r.tracklist || []).filter(t => !t.type_ || t.type_ === 'track')) {
        const d = discogsDisc(t.position);
        if (!byDisc.has(d)) byDisc.set(d, []);
        byDisc.get(d).push({ title: t.title || '', length: discogsLength(t.duration) });
    }
    const release = {
        source: 'discogs', id: String(r.id), title: r.title || '',
        artist: (r.artists || []).map(a => a.name.replace(/\s\(\d+\)$/, '') + (a.join ? ` ${a.join} ` : '')).join('').trim(),
        date: r.released || (r.year ? String(r.year) : ''), country: r.country || '', url: r.uri || `https://www.discogs.com/release/${r.id}`,
        discs: [...byDisc].sort((a, b) => a[0] - b[0]).map(([, tracks]) => ({ title: '', format: '', tracks })),
    };
    releaseCache.set(key, release);
    return release;
}

async function discogsCandidates(album, artist, token) {
    const { data } = await axios.get('https://api.discogs.com/database/search', {
        params: { release_title: album, ...(artist ? { artist } : {}), type: 'release', token, per_page: 10 },
        headers: { 'User-Agent': USER_AGENT }, timeout: 15000,
    });
    return (data.results || []).slice(0, 3).map(r => ({ source: 'discogs', id: String(r.id) }));
}

const fetchRelease = (c, token) => c.source === 'discogs' ? discogsRelease(c.id, token) : musicBrainzRelease(c.id);

// ─── Matching files to tracks ──────────────────────────────────────────────────

// How well a file fits a track (disc d, 1-based): its title most of all, then its length, and
// its folder's disc number if it has one (and the release has that many discs)
function fitScore(file, track, d, discCount) {
    let score = titleSimilarity(file.norm, normTitle(track.title));
    if (file.tags.duration && track.length) {
        const off = Math.abs(file.tags.duration - track.length);
        score += off <= 3 ? 0.25 : off <= 8 ? 0.1 : off > 30 ? -0.3 : 0;
    }
    if (file.discHint && file.discHint <= discCount) score += file.discHint === d ? 0.15 : -0.6;
    return score;
}

const ACCEPT_SCORE = 0.6;

// Each file's track on a release, best fits first, no track used twice: Map(file -> { d, t, score })
function matchFiles(files, release) {
    const pairs = [];
    release.discs.forEach((disc, di) => disc.tracks.forEach((track, ti) => {
        for (const file of files) {
            const score = fitScore(file, track, di + 1, release.discs.length);
            if (score >= ACCEPT_SCORE) pairs.push({ file, di, ti, score });
        }
    }));
    pairs.sort((a, b) => b.score - a.score);
    const out = new Map();
    const used = new Set();
    for (const p of pairs) {
        if (out.has(p.file) || used.has(`${p.di}:${p.ti}`)) continue;
        out.set(p.file, p);
        used.add(`${p.di}:${p.ti}`);
    }
    return out;
}

// How well a release fits the folder: most files matched, then how well, then how few of its
// tracks are left over on the discs the files are from
function releaseFit(files, release, matches) {
    if (!files.length) return 0;
    const scores = [...matches.values()].map(m => m.score);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const discsUsed = new Set([...matches.values()].map(m => m.di));
    const tracksOnThem = [...discsUsed].reduce((n, di) => n + release.discs[di].tracks.length, 0);
    const spare = tracksOnThem ? Math.abs(tracksOnThem - files.length) / Math.max(tracksOnThem, files.length) : 1;
    return matches.size / files.length + 0.05 * avg - 0.2 * spare;
}

// The track and disc numbers for each matched file: later discs carry on from earlier ones
function proposals(files, release, matches) {
    const offsets = [];
    let total = 0;
    for (const disc of release.discs) { offsets.push(total); total += disc.tracks.length; }
    return files.map(file => {
        const m = matches.get(file);
        return {
            file,
            proposed: m ? {
                track: offsets[m.di] + m.ti + 1, trackOf: total, disc: m.di + 1, discOf: release.discs.length,
                discTrack: m.ti + 1, matchedTitle: release.discs[m.di].tracks[m.ti].title, score: Math.round(m.score * 100) / 100,
            } : null,
        };
    });
}

const describe = (c, release, fit) => ({
    source: c.source, id: c.id, title: release.title, artist: release.artist, date: release.date, country: release.country,
    url: release.url, discs: release.discs.map(d => d.tracks.length), fit: Math.round(fit * 100) / 100,
});

// Works out the track order for an album folder. choice: { source, id } to use that release
// instead of the best found (candidates are found again either way, from the cache when they
// can be). Returns { album, artist, release, candidates, files: [{ rel, name, folder, title,
// current: { track, disc }, proposed: {...} | null }], otherFolders } or { error }.
export async function previewTrackOrder(dir, { discogsToken = '', choice = null } = {}) {
    const { files, otherFolders } = await collectFiles(dir);
    if (!files.length) {
        return { error: otherFolders.length
            ? 'No tracks directly in this folder. Use it on an album folder (one with CD1, Disc 2... folders is fine).'
            : 'No audio files in this folder.' };
    }
    for (const f of files) f.tags = await readTags(f);
    const { album, artist } = albumAndArtist(dir, files);
    if (!album) return { error: "Couldn't tell which album this is from its tags or folder name." };
    for (const f of files) f.norm = normTitle(fileTitle(f, artist));

    // MusicBrainz first; Discogs too (with a token) if nothing there fits well
    const tried = [];
    const consider = async list => {
        for (const c of list) {
            if (tried.some(t => t.c.source === c.source && t.c.id === c.id)) continue;
            try {
                const release = await fetchRelease(c, discogsToken);
                if (!release.discs.length) continue;
                const matches = matchFiles(files, release);
                tried.push({ c, release, matches, fit: releaseFit(files, release, matches) });
            } catch (err) {
                console.warn(`[TRACK-ORDER] ${c.source} release ${c.id} failed: ${err.message}`);
            }
        }
    };
    const errors = [];
    try {
        await consider((await musicBrainzCandidates(album, artist)).slice(0, 4));
    } catch (err) {
        errors.push(`MusicBrainz: ${err.message}`);
    }
    const best = () => tried.slice().sort((a, b) => b.fit - a.fit)[0];
    if (discogsToken && (!best() || best().matches.size < files.length)) {
        try { await consider(await discogsCandidates(album, artist, discogsToken)); } catch (err) { errors.push(`Discogs: ${err.message}`); }
    }
    if (choice?.id && !tried.some(t => t.c.source === choice.source && t.c.id === String(choice.id))) {
        await consider([{ source: choice.source === 'discogs' ? 'discogs' : 'musicbrainz', id: String(choice.id) }]);
    }
    if (!tried.length) {
        return { error: `No release found for "${album}"${artist ? ` by ${artist}` : ''}${errors.length ? ` (${errors.join('; ')})` : ''}.`
            + (discogsToken ? '' : ' Adding a Discogs token in Settings lets it look there too.') };
    }

    const chosen = (choice?.id && tried.find(t => t.c.source === choice.source && t.c.id === String(choice.id))) || best();
    const candidates = tried.slice().sort((a, b) => b.fit - a.fit).map(t => describe(t.c, t.release, t.fit));
    const rows = proposals(files, chosen.release, chosen.matches)
        .map(({ file, proposed }) => ({
            rel: path.relative(dir, file.path).split(path.sep).join('/'), name: file.name, folder: file.folder,
            title: fileTitle(file, artist), current: { track: file.tags.track, disc: file.tags.disc }, proposed,
        }))
        .sort((a, b) => (a.proposed?.track ?? 1e9) - (b.proposed?.track ?? 1e9) || a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    return { album, artist, release: describe(chosen.c, chosen.release, chosen.fit), candidates, files: rows, otherFolders };
}
