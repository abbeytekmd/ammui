// Turns a spoken request ("play wish you were here by pink floyd", "play the album rumours",
// "play something by queen") into a list of tracks from a server's library index.
//
// Speech recognition rarely reproduces tags exactly ("AC DC" for "AC/DC", "and" for "&",
// "rumors" for "Rumours"), so everything is compared as normalised words with a little
// spelling tolerance rather than as exact strings.
import { getLibraryIndexItems, getLibraryIndexMeta } from './db.js';

const MIN_SCORE = 0.6;          // below this a match is treated as "not found"
const ARTIST_TRACK_LIMIT = 200; // "play something by X" queues at most this many (shuffled)

// ─── Text helpers ────────────────────────────────────────────────────────────

function norm(s) {
    return String(s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')   // "(Remastered 2011)", "[Live]"
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

const STOP_WORDS = new Set(['the', 'a', 'an']);

function words(s) {
    return norm(s).split(' ').filter(w => w && !STOP_WORDS.has(w));
}

function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            rowMin = Math.min(rowMin, cur[j]);
        }
        if (rowMin > max) return max + 1;
        prev = cur;
    }
    return prev[b.length];
}

function wordsMatch(a, b) {
    if (a === b) return true;
    const len = Math.min(a.length, b.length);
    if (len < 4) return false;
    return editDistance(a, b, len >= 8 ? 2 : 1) <= (len >= 8 ? 2 : 1);
}

// 0..1: how well the spoken words cover the tag's words (Dice coefficient over fuzzy word matches).
function similarity(spokenWords, tagWords) {
    if (!spokenWords.length || !tagWords.length) return 0;
    if (spokenWords.join('') === tagWords.join('')) return 1; // "ac dc" vs "acdc"
    const used = new Set();
    let matched = 0;
    for (const s of spokenWords) {
        const i = tagWords.findIndex((t, idx) => !used.has(idx) && wordsMatch(s, t));
        if (i >= 0) { used.add(i); matched++; }
    }
    return (2 * matched) / (spokenWords.length + tagWords.length);
}

// ─── Parsing the request ─────────────────────────────────────────────────────

const NUMBER_WORDS = {
    zero: 0, ten: 10, fifteen: 15, twenty: 20, 'twenty five': 25, thirty: 30, forty: 40, fifty: 50, half: 50,
    sixty: 60, seventy: 70, 'seventy five': 75, eighty: 80, ninety: 90, hundred: 100, 'a hundred': 100,
    'one hundred': 100, max: 100, maximum: 100, full: 100,
};

// Playback controls said on their own ("stop", "next song", "volume 30"). Returns null for
// anything else - including "play stop", which is a request for a song called Stop.
export function parseControlCommand(text) {
    const t = norm(text)
        .replace(/^(hey |ok |okay )?(please )?(can you |could you |would you )?(please )?/, '')
        .replace(/ please$/, '')
        .replace(/ (the )?(music|song|track|playback|playing|it|this)$/, '');

    if (/^(stop|stop playing|halt|end)$/.test(t)) return { action: 'stop' };
    if (/^(pause|hold|hold on|wait)$/.test(t)) return { action: 'pause' };
    if (/^(resume|continue|unpause|carry on|play|start|start playing|go)$/.test(t)) return { action: 'resume' };
    if (/^(next|skip|next one|skip (this|it|ahead|forward)|forward)$/.test(t)) return { action: 'next' };
    if (/^(previous|prev|back|go back|last|previous one|last one|skip back|backwards?)$/.test(t)) return { action: 'previous' };

    if (/^((turn )?(the )?volume up|turn (it )?up|(a bit |a little |little )?louder|increase (the )?volume|up)$/.test(t)) return { action: 'volume', delta: 10 };
    if (/^((turn )?(the )?volume down|turn (it )?down|(a bit |a little |little )?(quieter|softer)|decrease (the )?volume|lower (the )?volume|down)$/.test(t)) return { action: 'volume', delta: -10 };
    const vol = t.match(/^(?:set |turn |change )?(?:the )?volume (?:to |at )?(.+?)(?: percent| %)?$/);
    if (vol) {
        const n = /^\d+$/.test(vol[1]) ? Number(vol[1]) : NUMBER_WORDS[vol[1]];
        if (n !== undefined) return { action: 'volume', volume: Math.max(0, Math.min(100, n)) };
    }
    return null;
}

// Returns { action: 'play'|'queue', kind: 'track'|'album'|'artist'|null, what, who, shuffle }.
export function parseVoiceCommand(text) {
    let t = norm(text)
        .replace(/^(hey |ok |okay )?(please )?(can you |could you |would you )?(please )?/, '')
        .replace(/ please$/, '');

    // The mic button mostly plays, so "wonderwall by oasis" on its own is fine too.
    // Recognisers usually hear "queue" as "cue" or "Q", so those count as queue too.
    const verb = t.match(/^(play|put on|listen to|shuffle|(?:queue|cue|q|kew|queued|cued) up|queue|enqueue|cue|q|kew|queued|cued|add|append)\b ?/);
    if (verb) t = t.slice(verb[0].length);
    const action = verb && !/^(play|put on|listen to|shuffle)$/.test(verb[1]) ? 'queue' : 'play';
    const shuffle = verb?.[1] === 'shuffle';
    if (action === 'queue') t = t.replace(/ (to|on|onto|at the end of) (the |my )?(queue|playlist|list)$/, '');

    // "something by the beatles" could also be the song "Something", so `title` keeps that reading.
    const someBy = t.match(/^(something|anything|some music|some songs|songs|tracks|music|all songs) (by|from) (.+)$/);
    if (someBy) return { action, kind: 'artist', what: '', who: someBy[3], title: someBy[2] === 'by' ? someBy[1] : null, shuffle };
    const theArtist = t.match(/^(?:the )?(?:artist|band) (.+)$/);
    if (theArtist) return { action, kind: 'artist', what: '', who: theArtist[1], shuffle };

    let kind = null;
    const kindPrefix = t.match(/^(the )?(album|record|lp|song|track|single) (called |named )?/);
    if (kindPrefix) {
        kind = /album|record|lp/.test(kindPrefix[2]) ? 'album' : 'track';
        t = t.slice(kindPrefix[0].length);
    }
    t = t.replace(/ (album|record)$/, () => { kind = 'album'; return ''; });

    return { action, kind, what: t.trim(), who: '', shuffle };
}

// Every way of reading "x by y by z": no artist, or split at any " by ".
function interpretations(parsed) {
    if (parsed.kind === 'artist') {
        // A real song of that name by that artist wins; the song reading goes first so it takes a tie.
        return parsed.title ? [{ ...parsed, kind: 'track', what: parsed.title }, parsed] : [parsed];
    }
    const out = [{ ...parsed }];
    const parts = parsed.what.split(' by ');
    for (let i = 1; i < parts.length; i++) {
        out.push({ ...parsed, what: parts.slice(0, i).join(' by '), who: parts.slice(i).join(' by ') });
    }
    return out;
}

// ─── Library cache ───────────────────────────────────────────────────────────

const cache = new Map(); // udn -> { builtAt, tracks }

function isAudio(it) {
    const cls = it.class || '';
    const proto = it.protocolInfo || '';
    if (cls.includes('imageItem') || cls.includes('videoItem') || proto.includes('image/') || proto.includes('video/')) return false;
    return cls.includes('audioItem') || proto.includes('audio/');
}

function loadTracks(udn) {
    const meta = getLibraryIndexMeta(udn);
    if (!meta) return null;
    const hit = cache.get(udn);
    if (hit && hit.builtAt === meta.built_at) return hit.tracks;

    // Many DLNA servers show the same file under several views (Artist, Album, Genre...).
    const seen = new Set();
    const tracks = [];
    for (const it of getLibraryIndexItems(udn)) {
        if (!isAudio(it) || !it.uri || seen.has(it.uri)) continue;
        seen.add(it.uri);
        tracks.push({
            item: it,
            titleWords: words(it.title),
            albumWords: words(it.album),
            artistKeys: [...new Set([norm(it.artist), norm(it.albumArtist)].filter(Boolean))],
            albumKey: norm(it.album) + '|' + (norm(it.albumArtist) || it.folderId || ''),
        });
    }
    cache.set(udn, { builtAt: meta.built_at, tracks });
    return tracks;
}

// ─── Resolving ───────────────────────────────────────────────────────────────

const byDiscAndTrack = (a, b) => ((a.discNumber || 1) - (b.discNumber || 1)) || ((a.trackNumber || 0) - (b.trackNumber || 0));

function shuffled(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// Returns { action, kind, label, tracks }, a control command ({ action: 'stop' } etc.) or { error }.
export function resolveVoiceCommand(udn, text) {
    const control = parseControlCommand(text);
    if (control) return control;
    const parsed = parseVoiceCommand(text);
    if (!parsed.what && !parsed.who) {
        return { error: `Didn't understand "${text}". Try "play <song or album> by <artist>".` };
    }
    const tracks = loadTracks(udn);
    if (!tracks) return { error: 'This server has no search index yet.' };

    // Artist similarity is computed once per distinct artist string.
    const artistMemo = new Map();
    const artistScore = (t, who) => {
        let best = 0;
        for (const key of t.artistKeys) {
            const k = who + '#' + key;
            if (!artistMemo.has(k)) artistMemo.set(k, similarity(words(who), words(key)));
            best = Math.max(best, artistMemo.get(k));
        }
        return best;
    };

    let best = { score: 0 };
    const consider = (candidate) => { if (candidate.score > best.score) best = candidate; };

    for (const interp of interpretations(parsed)) {
        const whatWords = words(interp.what);

        // Artist only: "play something by queen", or "play queen" where the whole phrase is an artist.
        const artistName = interp.kind === 'artist' ? interp.who : (!interp.who && !interp.kind ? interp.what : null);
        if (artistName) {
            const matches = tracks.filter(t => artistScore(t, artistName) >= 0.8);
            // Considered first, so a bare "play queen" goes to the band when a song is also called "Queen".
            if (matches.length) consider({ kind: 'artist', score: Math.max(...matches.map(t => artistScore(t, artistName))), tracks: matches });
        }
        if (interp.kind === 'artist' || !whatWords.length) continue;

        const albums = new Map(); // albumKey -> best album score
        for (const t of tracks) {
            const aScore = interp.who ? artistScore(t, interp.who) : 1;
            if (interp.who && aScore < 0.5) continue;
            const blend = (s) => interp.who ? s * 0.65 + aScore * 0.35 : s;

            if (interp.kind !== 'album') {
                consider({ kind: 'track', score: blend(similarity(whatWords, t.titleWords)), tracks: [t] });
            }
            if (interp.kind !== 'track' && t.albumWords.length) {
                const s = blend(similarity(whatWords, t.albumWords)) - 0.01; // a same-named song wins a tie unless "album" was said
                if (s > (albums.get(t.albumKey) || 0)) albums.set(t.albumKey, s);
            }
        }
        for (const [albumKey, score] of albums) consider({ kind: 'album', score, albumKey });
    }

    if (best.score < MIN_SCORE) {
        return { error: `Couldn't find "${[parsed.what, parsed.who].filter(Boolean).join(' by ')}" in the library.` };
    }

    if (best.kind === 'track') {
        const it = best.tracks[0].item;
        return { action: parsed.action, kind: 'track', label: `${it.title}${it.artist ? ' by ' + it.artist : ''}`, tracks: [it] };
    }
    if (best.kind === 'album') {
        const album = tracks.filter(t => t.albumKey === best.albumKey).map(t => t.item).sort(byDiscAndTrack);
        const items = parsed.shuffle ? shuffled(album) : album;
        const first = album[0];
        const by = first.albumArtist || first.artist;
        return { action: parsed.action, kind: 'album', label: `${first.album}${by ? ' by ' + by : ''}`, tracks: items };
    }
    const items = shuffled(best.tracks.map(t => t.item)).slice(0, ARTIST_TRACK_LIMIT);
    return { action: parsed.action, kind: 'artist', label: `Songs by ${items[0].albumArtist || items[0].artist}`, tracks: items };
}

// The "<song> by <artist>" readings of a play request, for looking it up on YouTube when the
// library has no match. Queue requests, albums and bare artist names don't qualify.
export function voiceSongRequests(text) {
    if (parseControlCommand(text)) return [];
    const parsed = parseVoiceCommand(text);
    if (parsed.action !== 'play' || parsed.kind === 'album') return [];
    return interpretations(parsed)
        .filter(i => i.kind !== 'artist' && i.kind !== 'album' && i.what && i.who)
        .map(i => ({ title: i.what, artist: i.who }));
}
