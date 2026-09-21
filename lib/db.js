import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const isPkg = typeof process.pkg !== 'undefined';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseDataDir = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

const DB_PATH = path.join(baseDataDir, 'ammui.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// node:sqlite has no built-in transaction() wrapper (unlike better-sqlite3) — roll our own.
function runInTransaction(fn) {
    db.exec('BEGIN');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
        udn  TEXT PRIMARY KEY,
        data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_tags (
        uri TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (uri, tag)
    );

    CREATE TABLE IF NOT EXISTS photo_rotations (
        uri   TEXT PRIMARY KEY,
        angle INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS deleted_photos (
        uri TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS play_history (
        id          TEXT PRIMARY KEY,
        timestamp   TEXT NOT NULL,
        title       TEXT,
        artist      TEXT,
        album       TEXT,
        server_name TEXT,
        player_name TEXT
    );

    CREATE TABLE IF NOT EXISTS album_art (
        key          TEXT PRIMARY KEY,
        data         BLOB NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'image/jpeg'
    );

    CREATE TABLE IF NOT EXISTS lyrics_cache (
        key    TEXT PRIMARY KEY,
        synced TEXT,
        plain  TEXT,
        found  INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS youtube_video_cache (
        key        TEXT PRIMARY KEY,
        video_id   TEXT,
        embeddable INTEGER NOT NULL DEFAULT 1,
        found      INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS youtube_candidates_cache (
        key  TEXT PRIMARY KEY,
        json TEXT NOT NULL
    );

    -- One row per artist: the channel we resolved for them (a 100-unit search, done once)
    CREATE TABLE IF NOT EXISTS youtube_artist_channel (
        key        TEXT PRIMARY KEY,
        channel_id TEXT,
        found      INTEGER NOT NULL DEFAULT 1,
        fetched_at INTEGER NOT NULL
    );

    -- Every upload on those channels, so any track can be matched later at no API cost
    CREATE TABLE IF NOT EXISTS youtube_channel_videos (
        channel_id TEXT NOT NULL,
        video_id   TEXT NOT NULL,
        title      TEXT NOT NULL,
        embeddable INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (channel_id, video_id)
    );

    -- Flat searchable copy of each media server's library, rebuilt by lib/library-index.js
    CREATE TABLE IF NOT EXISTS library_index (
        server_udn  TEXT NOT NULL,
        id          TEXT NOT NULL,
        title       TEXT,
        album       TEXT,
        disc        INTEGER,
        track       INTEGER,
        path_ids    TEXT NOT NULL,
        search_text TEXT NOT NULL,
        data        TEXT NOT NULL,
        PRIMARY KEY (server_udn, id)
    );

    CREATE TABLE IF NOT EXISTS library_index_meta (
        server_udn  TEXT PRIMARY KEY,
        server_name TEXT,
        built_at    INTEGER NOT NULL,
        item_count  INTEGER NOT NULL,
        duration_ms INTEGER
    );
`);

// Migrate youtube_video_cache if it predates the embeddable column
{
    const cols = db.prepare('PRAGMA table_info(youtube_video_cache)').all();
    if (cols.length > 0 && !cols.some(c => c.name === 'embeddable')) {
        db.exec('ALTER TABLE youtube_video_cache ADD COLUMN embeddable INTEGER NOT NULL DEFAULT 1');
    }
}

// Migrate youtube_video_cache: official level — 0 none, 1 half star (hand-picked / other channel), 2 full star (artist's own channel)
{
    const cols = db.prepare('PRAGMA table_info(youtube_video_cache)').all();
    if (cols.length > 0 && !cols.some(c => c.name === 'official')) {
        db.exec('ALTER TABLE youtube_video_cache ADD COLUMN official INTEGER NOT NULL DEFAULT 0');
    }
}

// Migrate youtube_artist_channel: uploads are now ingested a page at a time, so remember
// where we got to (next page token) and whether the whole playlist has been read.
{
    const cols = db.prepare('PRAGMA table_info(youtube_artist_channel)').all();
    if (cols.length > 0 && !cols.some(c => c.name === 'next_page_token')) {
        db.exec('ALTER TABLE youtube_artist_channel ADD COLUMN next_page_token TEXT');
        db.exec('ALTER TABLE youtube_artist_channel ADD COLUMN uploads_done INTEGER NOT NULL DEFAULT 0');
        // Channels ingested by the old all-at-once code already hold their full list.
        db.exec('UPDATE youtube_artist_channel SET uploads_done = 1 WHERE channel_id IN (SELECT DISTINCT channel_id FROM youtube_channel_videos)');
    }
}

// Migrate album_art if it still has the old url-only schema
{
    const cols = db.prepare('PRAGMA table_info(album_art)').all();
    if (cols.length > 0 && !cols.some(c => c.name === 'data')) {
        db.exec('DROP TABLE album_art');
        db.exec(`CREATE TABLE album_art (
            key          TEXT PRIMARY KEY,
            data         BLOB NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'image/jpeg'
        )`);
        console.log('[DB] Recreated album_art table with blob schema.');
    }
}

// ─── One-time migration from JSON files ──────────────────────────────────────

function migrateIfNeeded() {
    const settingsFile  = path.join(baseDataDir, 'settings.json');
    const devicesFile   = path.join(baseDataDir, 'devices.json');
    const historyFile   = path.join(baseDataDir, 'play_history.json');

    const alreadyMigrated = db.prepare("SELECT value FROM settings WHERE key = '_migrated'").get();
    if (alreadyMigrated) return;

    console.log('[DB] Running one-time migration from JSON files...');

    // ── settings.json ──
    if (fs.existsSync(settingsFile)) {
        try {
            const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
            const insertTag = db.prepare('INSERT OR IGNORE INTO file_tags (uri, tag) VALUES (?, ?)');
            const insertRot = db.prepare('INSERT OR REPLACE INTO photo_rotations (uri, angle) VALUES (?, ?)');
            const insertDel = db.prepare('INSERT OR IGNORE INTO deleted_photos (uri) VALUES (?)');

            runInTransaction(() => {
                if (s.discogsToken) set.run('discogsToken', s.discogsToken);
                if (s.deviceName)   set.run('deviceName',   s.deviceName);
                if (s.screensaver)  set.run('screensaver',  JSON.stringify(s.screensaver));
                if (s.s3)           set.run('s3',           JSON.stringify(s.s3));

                for (const [uri, tags] of Object.entries(s.fileTags || {})) {
                    for (const tag of (Array.isArray(tags) ? tags : [])) {
                        insertTag.run(uri, tag);
                    }
                }
                for (const [uri, angle] of Object.entries(s.manualRotations || {})) {
                    insertRot.run(uri, Number(angle));
                }
                for (const uri of Object.keys(s.deletedPhotos || {})) {
                    insertDel.run(uri);
                }
            });

            fs.renameSync(settingsFile, settingsFile + '.migrated');
            console.log('[DB] Migrated settings.json');
        } catch (e) {
            console.error('[DB] Failed to migrate settings.json:', e.message);
        }
    }

    // ── devices.json ──
    if (fs.existsSync(devicesFile)) {
        try {
            const list = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
            const upsert = db.prepare('INSERT OR REPLACE INTO devices (udn, data) VALUES (?, ?)');
            runInTransaction(() => {
                for (const d of list) {
                    if (d.udn) upsert.run(d.udn, JSON.stringify(d));
                }
            });
            fs.renameSync(devicesFile, devicesFile + '.migrated');
            console.log('[DB] Migrated devices.json');
        } catch (e) {
            console.error('[DB] Failed to migrate devices.json:', e.message);
        }
    }

    // ── play_history.json ──
    if (fs.existsSync(historyFile)) {
        try {
            const entries = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
            const insert = db.prepare(`
                INSERT OR IGNORE INTO play_history (id, timestamp, title, artist, album, server_name, player_name)
                VALUES (@id, @timestamp, @title, @artist, @album, @server_name, @player_name)
            `);
            runInTransaction(() => {
                for (const e of entries) {
                    insert.run({
                        id:          e.id || (Date.now() + Math.random().toString(36).substr(2, 5)),
                        timestamp:   e.timestamp || new Date().toISOString(),
                        title:       e.title || null,
                        artist:      e.artist || null,
                        album:       e.album || null,
                        server_name: e.serverName || null,
                        player_name: e.playerName || null,
                    });
                }
            });
            fs.renameSync(historyFile, historyFile + '.migrated');
            console.log('[DB] Migrated play_history.json');
        } catch (e) {
            console.error('[DB] Failed to migrate play_history.json:', e.message);
        }
    }

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('_migrated', '1')").run();
    console.log('[DB] Migration complete.');
}

migrateIfNeeded();

// ─── Settings ─────────────────────────────────────────────────────────────────

const _getSetting  = db.prepare('SELECT value FROM settings WHERE key = ?');
const _setSetting  = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
const _getAllSettings = db.prepare("SELECT key, value FROM settings WHERE key != '_migrated'");

export function getSetting(key, defaultValue = null) {
    const row = _getSetting.get(key);
    if (!row) return defaultValue;
    try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setSetting(key, value) {
    _setSetting.run(key, typeof value === 'string' ? value : JSON.stringify(value));
}

export function getAllSettings() {
    const out = {};
    for (const { key, value } of _getAllSettings.all()) {
        try { out[key] = JSON.parse(value); } catch { out[key] = value; }
    }
    return out;
}

// ─── Devices ──────────────────────────────────────────────────────────────────

const _upsertDevice  = db.prepare('INSERT OR REPLACE INTO devices (udn, data) VALUES (?, ?)');
const _deleteDevice  = db.prepare('DELETE FROM devices WHERE udn = ?');
const _getAllDevices  = db.prepare('SELECT data FROM devices');

export function upsertDevice(device) {
    if (!device.udn) return;
    _upsertDevice.run(device.udn, JSON.stringify(device));
}

export function deleteDevice(udn) {
    _deleteDevice.run(udn);
}

export function getAllDevices() {
    return _getAllDevices.all().map(r => JSON.parse(r.data));
}

export function saveAllDevices(deviceList) {
    runInTransaction(() => {
        db.prepare('DELETE FROM devices').run();
        for (const d of deviceList) {
            if (d.udn) _upsertDevice.run(d.udn, JSON.stringify(d));
        }
    });
}

// ─── File Tags ────────────────────────────────────────────────────────────────

const _getFileTags        = db.prepare('SELECT tag FROM file_tags WHERE uri = ?');
const _insertTag          = db.prepare('INSERT OR IGNORE INTO file_tags (uri, tag) VALUES (?, ?)');
const _deleteTag          = db.prepare('DELETE FROM file_tags WHERE uri = ? AND tag = ?');
const _deleteAllTagsForUri = db.prepare('DELETE FROM file_tags WHERE uri = ?');
const _getAllFileTags      = db.prepare('SELECT uri, tag FROM file_tags');
const _getAllTags          = db.prepare('SELECT DISTINCT tag FROM file_tags ORDER BY tag');
const _getUrisByTag       = db.prepare('SELECT uri FROM file_tags WHERE tag = ?');

export function getFileTags(uri) {
    return _getFileTags.all(uri).map(r => r.tag);
}

export function setFileTags(uri, tags) {
    runInTransaction(() => {
        _deleteAllTagsForUri.run(uri);
        for (const tag of tags) _insertTag.run(uri, tag);
    });
}

export function addFileTag(uri, tag) {
    _insertTag.run(uri, tag);
}

export function removeFileTag(uri, tag) {
    _deleteTag.run(uri, tag);
}

export function getAllFileTags() {
    const out = {};
    for (const { uri, tag } of _getAllFileTags.all()) {
        if (!out[uri]) out[uri] = [];
        out[uri].push(tag);
    }
    return out;
}

export function getAllTags() {
    return _getAllTags.all().map(r => r.tag);
}

export function getUrisByTag(tag) {
    return _getUrisByTag.all(tag).map(r => r.uri);
}

// ─── Photo Rotations ──────────────────────────────────────────────────────────

const _getRotation    = db.prepare('SELECT angle FROM photo_rotations WHERE uri = ?');
const _upsertRotation = db.prepare('INSERT OR REPLACE INTO photo_rotations (uri, angle) VALUES (?, ?)');
const _getAllRotations = db.prepare('SELECT uri, angle FROM photo_rotations');

export function getPhotoRotation(uri) {
    const row = _getRotation.get(uri);
    return row ? row.angle : 0;
}

export function setPhotoRotation(uri, angle) {
    _upsertRotation.run(uri, Number(angle));
}

export function getAllPhotoRotations() {
    const out = {};
    for (const { uri, angle } of _getAllRotations.all()) out[uri] = angle;
    return out;
}

// ─── Deleted Photos ───────────────────────────────────────────────────────────

const _isDeleted    = db.prepare('SELECT 1 FROM deleted_photos WHERE uri = ?');
const _markDeleted  = db.prepare('INSERT OR IGNORE INTO deleted_photos (uri) VALUES (?)');
const _getAllDeleted = db.prepare('SELECT uri FROM deleted_photos');

// Local-file URIs embed the host/port the browser used, so the same photo has a different
// URI per address. Key on the host-free path so hiding applies to every browser.
export function normalizePhotoKey(uri) {
    if (typeof uri !== 'string') return uri;
    const i = uri.indexOf('/local-files/');
    return i > 0 ? uri.slice(i) : uri;
}

export function isPhotoDeleted(uri) {
    return !!_isDeleted.get(normalizePhotoKey(uri));
}

export function markPhotoDeleted(uri) {
    _markDeleted.run(normalizePhotoKey(uri));
}

export function getAllDeletedPhotos() {
    const out = {};
    for (const { uri } of _getAllDeleted.all()) out[normalizePhotoKey(uri)] = true;
    return out;
}

// ─── Play History ─────────────────────────────────────────────────────────────

const _insertPlay = db.prepare(`
    INSERT OR IGNORE INTO play_history (id, timestamp, title, artist, album, server_name, player_name)
    VALUES (@id, @timestamp, @title, @artist, @album, @server_name, @player_name)
`);

const _getTopTracks = db.prepare(`
    SELECT title, artist, COUNT(*) as count
    FROM play_history
    WHERE title IS NOT NULL AND title != 'Migrated Album Play'
    GROUP BY title, artist
    ORDER BY count DESC
    LIMIT ?
`);

const _getTopAlbums = db.prepare(`
    SELECT album, artist, COUNT(*) as count
    FROM play_history
    WHERE album IS NOT NULL AND album != ''
    GROUP BY album, artist
    ORDER BY count DESC
    LIMIT ?
`);

export function logPlay(details) {
    _insertPlay.run({
        id:          Date.now() + Math.random().toString(36).substr(2, 5),
        timestamp:   new Date().toISOString(),
        title:       details.title || null,
        artist:      details.artist || null,
        album:       details.album || null,
        server_name: details.serverName || null,
        player_name: details.playerName || null,
    });
    console.log(`[STATS] Logged play: ${details.title}`);
}

export function getTopTracks(limit = 20) {
    return _getTopTracks.all(limit);
}

export function getTopAlbums(limit = 20) {
    return _getTopAlbums.all(limit);
}

// ─── Album Art Cache ──────────────────────────────────────────────────────────

function _artKey(artist, album) {
    const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return `${norm(artist)}|${norm(album)}`;
}

export function artCacheKey(artist, album) {
    return _artKey(artist, album);
}

const _getArt = db.prepare('SELECT data, content_type FROM album_art WHERE key = ?');
const _setArt = db.prepare('INSERT OR REPLACE INTO album_art (key, data, content_type) VALUES (?, ?, ?)');

// node:sqlite returns BLOB columns as Uint8Array rather than Buffer; wrap so callers
// (e.g. res.send()) keep getting the Buffer they'd get from better-sqlite3.
function _rowWithBufferData(row) {
    if (!row) return null;
    return { ...row, data: Buffer.from(row.data) };
}

export function getCachedArt(artist, album) {
    return _rowWithBufferData(_getArt.get(_artKey(artist, album))); // { data: Buffer, content_type: string }
}

export function getCachedArtByKey(key) {
    return _rowWithBufferData(_getArt.get(key));
}

export function setCachedArt(artist, album, data, contentType = 'image/jpeg') {
    _setArt.run(_artKey(artist, album), data, contentType);
}

// ─── Lyrics Cache ─────────────────────────────────────────────────────────────

function _lyricsKey(artist, title, album) {
    const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return `${norm(artist)}|${norm(title)}|${norm(album)}`;
}

const _getLyrics = db.prepare('SELECT synced, plain, found FROM lyrics_cache WHERE key = ?');
const _setLyrics = db.prepare('INSERT OR REPLACE INTO lyrics_cache (key, synced, plain, found) VALUES (?, ?, ?, ?)');

export function getCachedLyrics(artist, title, album) {
    return _getLyrics.get(_lyricsKey(artist, title, album)) || null; // { synced, plain, found }
}

export function setCachedLyrics(artist, title, album, { synced = null, plain = null, found = true } = {}) {
    _setLyrics.run(_lyricsKey(artist, title, album), synced, plain, found ? 1 : 0);
}

// ─── YouTube Video Cache ────────────────────────────────────────────────────

function _youtubeKey(artist, title) {
    const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return `${norm(artist)}|${norm(title)}`;
}

const _getYoutubeVideo = db.prepare('SELECT video_id, embeddable, found, official FROM youtube_video_cache WHERE key = ?');
const _setYoutubeVideo = db.prepare('INSERT OR REPLACE INTO youtube_video_cache (key, video_id, embeddable, found, official) VALUES (?, ?, ?, ?, ?)');

export function getCachedYoutubeVideo(artist, title) {
    const row = _getYoutubeVideo.get(_youtubeKey(artist, title));
    if (!row) return null;
    return { videoId: row.video_id, embeddable: !!row.embeddable, found: !!row.found, official: row.official || 0 };
}

export function setCachedYoutubeVideo(artist, title, { videoId = null, embeddable = true, found = true, official = 0 } = {}) {
    _setYoutubeVideo.run(_youtubeKey(artist, title), videoId, embeddable ? 1 : 0, found ? 1 : 0, Number(official) || 0);
}

// Full candidate list (several search results) for the "pick a video" modal — cached
// separately so the cheap single-result lookup above stays untouched.
const _getYoutubeCandidates = db.prepare('SELECT json FROM youtube_candidates_cache WHERE key = ?');
const _setYoutubeCandidates = db.prepare('INSERT OR REPLACE INTO youtube_candidates_cache (key, json) VALUES (?, ?)');

export function getCachedYoutubeCandidates(artist, title) {
    const row = _getYoutubeCandidates.get(_youtubeKey(artist, title));
    return row ? JSON.parse(row.json) : null;
}

export function setCachedYoutubeCandidates(artist, title, candidates) {
    _setYoutubeCandidates.run(_youtubeKey(artist, title), JSON.stringify(candidates));
}

// ─── YouTube artist channels + their uploads ────────────────────────────────

const _artistKey = artist => _youtubeKey(artist, '').slice(0, -1);
const _getArtistChannel = db.prepare('SELECT channel_id, found, next_page_token, uploads_done FROM youtube_artist_channel WHERE key = ?');
const _setChannelProgress = db.prepare('UPDATE youtube_artist_channel SET next_page_token = ?, uploads_done = ? WHERE key = ?');
const _setArtistChannel = db.prepare('INSERT OR REPLACE INTO youtube_artist_channel (key, channel_id, found, fetched_at) VALUES (?, ?, ?, ?)');
const _countChannelLookupsSince = db.prepare('SELECT COUNT(*) AS n FROM youtube_artist_channel WHERE fetched_at >= ?');
const _insertChannelVideo = db.prepare('INSERT OR REPLACE INTO youtube_channel_videos (channel_id, video_id, title, embeddable) VALUES (?, ?, ?, ?)');
const _getChannelVideos = db.prepare('SELECT video_id, title, embeddable FROM youtube_channel_videos WHERE channel_id = ?');

export function getArtistChannel(artist) {
    const row = _getArtistChannel.get(_artistKey(artist));
    return row ? { channelId: row.channel_id, found: !!row.found, nextPageToken: row.next_page_token, uploadsDone: !!row.uploads_done } : null;
}

// Records how far through the channel's uploads playlist we've read
export function setChannelProgress(artist, nextPageToken, done) {
    _setChannelProgress.run(nextPageToken || null, done ? 1 : 0, _artistKey(artist));
}

export function setArtistChannel(artist, channelId, found = true) {
    _setArtistChannel.run(_artistKey(artist), channelId || null, found ? 1 : 0, Date.now());
}

// How many channel searches (the expensive call) have been made since the given time
export function countChannelLookupsSince(ts) {
    return _countChannelLookupsSince.get(ts).n;
}

export function saveChannelVideos(channelId, videos) {
    runInTransaction(() => {
        for (const v of videos) _insertChannelVideo.run(channelId, v.videoId, v.title, v.embeddable ? 1 : 0);
    });
}

export function getChannelVideos(channelId) {
    return _getChannelVideos.all(channelId).map(r => ({ videoId: r.video_id, title: r.title, embeddable: !!r.embeddable }));
}


// ─── Library search index ────────────────────────────────────────────────────

const normSearch = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const likeEscape = (v) => v.replace(/[!%_]/g, m => '!' + m);

// Replaces a server's whole index in one transaction, so searches never see a half-built one.
export function replaceLibraryIndex(udn, serverName, items, durationMs) {
    const ins = db.prepare('INSERT OR REPLACE INTO library_index (server_udn, id, title, album, disc, track, path_ids, search_text, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    runInTransaction(() => {
        db.prepare('DELETE FROM library_index WHERE server_udn = ?').run(udn);
        for (const it of items) {
            let ids = [];
            try { ids = JSON.parse(it._path || '[]').map(p => p.id); } catch (e) { }
            ins.run(udn, String(it.id), it.title || '', it.album || '', it.discNumber || 1, it.trackNumber || 0,
                '|' + ids.join('|') + '|',
                normSearch([it.title, it.artist, it.albumArtist, it.album].filter(Boolean).join(' ')),
                JSON.stringify(it));
        }
        db.prepare('INSERT OR REPLACE INTO library_index_meta (server_udn, server_name, built_at, item_count, duration_ms) VALUES (?, ?, ?, ?, ?)')
            .run(udn, serverName || '', Date.now(), items.length, durationMs || 0);
    });
}

export function getLibraryIndexMeta(udn) {
    return db.prepare('SELECT * FROM library_index_meta WHERE server_udn = ?').get(udn) || null;
}

export function getAllLibraryIndexMeta() {
    return db.prepare('SELECT * FROM library_index_meta').all();
}

// Every term must appear in the title/artist/album text. scopeId limits results to items
// somewhere below that folder ('0' or empty = the whole server).
export function searchLibraryIndex(udn, query, scopeId, limit = 5000) {
    const terms = normSearch(query).split(/\s+/).filter(Boolean);
    let sql = 'SELECT data FROM library_index WHERE server_udn = ?';
    const args = [udn];
    if (scopeId && scopeId !== '0') {
        sql += " AND path_ids LIKE ? ESCAPE '!'";
        args.push(`%|${likeEscape(String(scopeId))}|%`);
    }
    for (const t of terms) {
        sql += " AND search_text LIKE ? ESCAPE '!'";
        args.push(`%${likeEscape(t)}%`);
    }
    sql += ' ORDER BY album COLLATE NOCASE, disc, track, title COLLATE NOCASE LIMIT ?';
    args.push(limit + 1);
    const rows = db.prepare(sql).all(...args);
    const truncated = rows.length > limit;
    return { items: rows.slice(0, limit).map(r => JSON.parse(r.data)), truncated };
}

// ─── Database overview (for the Database Stats dialog) ───────────────────────

const TABLE_DESCRIPTIONS = {
    settings: 'Application settings',
    devices: 'Known renderers / servers',
    file_tags: 'Tags applied to files',
    photo_rotations: 'Manual photo rotations',
    deleted_photos: 'Photos marked as deleted',
    play_history: 'Tracks played',
    album_art: 'Cached album art images',
    lyrics_cache: 'Cached lyrics lookups',
    youtube_video_cache: 'Cached YouTube video matches',
    youtube_candidates_cache: 'Cached YouTube candidate lists',
    youtube_artist_channel: 'Artist YouTube channels resolved',
    youtube_channel_videos: 'Uploads indexed from artist channels',
    library_index: 'Searchable copy of the media library',
    library_index_meta: 'When each library index was built',
};

// Forgets matched (found) videos that aren't official so they re-match from the stored
// channel uploads on next view. Costs no API quota. "Not found" rows are left alone.
export function clearNonOfficialYoutubeMatches() {
    return Number(db.prepare('DELETE FROM youtube_video_cache WHERE found = 1 AND official = 0').run().changes);
}

export function getDbStats() {
    const one = (sql) => db.prepare(sql).get();
    const fileSize = (f) => { try { return fs.statSync(f).size; } catch (e) { return 0; } };

    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);

    // Per-table on-disk size needs the dbstat virtual table, which not every build has.
    let sizes = {};
    try {
        for (const r of db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all()) sizes[r.name] = r.bytes;
    } catch (e) { sizes = null; }

    const tables = names.map(name => ({
        name,
        description: TABLE_DESCRIPTIONS[name] || '',
        rows: one(`SELECT COUNT(*) AS n FROM "${name}"`).n,
        bytes: sizes ? (sizes[name] ?? null) : null,
    }));

    const overview = {};
    const safe = (key, fn) => { try { overview[key] = fn(); } catch (e) { } };
    safe('history', () => one("SELECT MIN(timestamp) AS first, MAX(timestamp) AS last, COUNT(DISTINCT artist) AS artists, COUNT(DISTINCT album) AS albums, COUNT(DISTINCT title || char(0) || artist) AS tracks FROM play_history"));
    safe('tags', () => ({
        distinctTags: one('SELECT COUNT(DISTINCT tag) AS n FROM file_tags').n,
        taggedFiles: one('SELECT COUNT(DISTINCT uri) AS n FROM file_tags').n,
    }));
    safe('art', () => ({ bytes: one('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM album_art').n }));
    safe('lyrics', () => ({
        found: one('SELECT COUNT(*) AS n FROM lyrics_cache WHERE found = 1').n,
        missing: one('SELECT COUNT(*) AS n FROM lyrics_cache WHERE found = 0').n,
        synced: one("SELECT COUNT(*) AS n FROM lyrics_cache WHERE synced IS NOT NULL AND synced != ''").n,
    }));
    safe('youtube', () => ({
        videosFound: one('SELECT COUNT(*) AS n FROM youtube_video_cache WHERE found = 1').n,
        videosMissing: one('SELECT COUNT(*) AS n FROM youtube_video_cache WHERE found = 0').n,
        channelsFound: one('SELECT COUNT(*) AS n FROM youtube_artist_channel WHERE found = 1').n,
        channelsMissing: one('SELECT COUNT(*) AS n FROM youtube_artist_channel WHERE found = 0').n,
        channelsComplete: one('SELECT COUNT(*) AS n FROM youtube_artist_channel WHERE uploads_done = 1').n,
    }));

    safe('library', () => getAllLibraryIndexMeta());

    return {
        file: {
            path: DB_PATH,
            dbBytes: fileSize(DB_PATH),
            walBytes: fileSize(DB_PATH + '-wal'),
            pageSize: Object.values(one('PRAGMA page_size'))[0],
            pageCount: Object.values(one('PRAGMA page_count'))[0],
            freePages: Object.values(one('PRAGMA freelist_count'))[0],
            sqliteVersion: one('SELECT sqlite_version() AS v').v,
        },
        tables,
        overview,
    };
}

export default db;
