import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const isPkg = typeof process.pkg !== 'undefined';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseDataDir = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

const DB_PATH = path.join(baseDataDir, 'ammui.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
`);

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

            db.transaction(() => {
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
            })();

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
            db.transaction(() => {
                for (const d of list) {
                    if (d.udn) upsert.run(d.udn, JSON.stringify(d));
                }
            })();
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
            db.transaction(() => {
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
            })();
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
    db.transaction(() => {
        db.prepare('DELETE FROM devices').run();
        for (const d of deviceList) {
            if (d.udn) _upsertDevice.run(d.udn, JSON.stringify(d));
        }
    })();
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
    db.transaction(() => {
        _deleteAllTagsForUri.run(uri);
        for (const tag of tags) _insertTag.run(uri, tag);
    })();
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

export function isPhotoDeleted(uri) {
    return !!_isDeleted.get(uri);
}

export function markPhotoDeleted(uri) {
    _markDeleted.run(uri);
}

export function getAllDeletedPhotos() {
    const out = {};
    for (const { uri } of _getAllDeleted.all()) out[uri] = true;
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

export function getCachedArt(artist, album) {
    return _getArt.get(_artKey(artist, album)) || null; // { data: Buffer, content_type: string }
}

export function getCachedArtByKey(key) {
    return _getArt.get(key) || null;
}

export function setCachedArt(artist, album, data, contentType = 'image/jpeg') {
    _setArt.run(_artKey(artist, album), data, contentType);
}

export default db;
