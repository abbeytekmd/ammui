import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { mediaKey, toStoredUrl, fromStoredUrl } from './media-key.js';
import { photoDateString } from './photo-date.js';

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
        found      INTEGER NOT NULL DEFAULT 1,
        -- 0 none, 1 half star (hand-picked / other channel), 2 full star (the artist's own channel)
        official   INTEGER NOT NULL DEFAULT 0
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
        fetched_at INTEGER NOT NULL,
        -- Uploads are read a page at a time: where we got to, and whether the whole list is in
        next_page_token TEXT,
        uploads_done    INTEGER NOT NULL DEFAULT 0
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
        -- A photo's date (YYYY-MM-DD) and its MM-DD, so Day mode is one indexed lookup
        photo_date  TEXT,
        photo_md    TEXT,
        PRIMARY KEY (server_udn, id)
    );
    CREATE INDEX IF NOT EXISTS idx_library_index_photo_md ON library_index(server_udn, photo_md);
    CREATE INDEX IF NOT EXISTS idx_library_index_photo_date ON library_index(server_udn, photo_date);

    -- Entries added on the Calendar tab, one per day (date is YYYY-MM-DD, no time). An entry can
    -- repeat every N days/weeks/months, until an optional date. A meal (is_meal) is its one item in
    -- calendar_entry_parts, with no title of its own; people is how many it was for when saved.
    CREATE TABLE IF NOT EXISTS calendar_entries (
        id              TEXT PRIMARY KEY,
        date            TEXT NOT NULL,
        title           TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        times           REAL NOT NULL DEFAULT 1,     -- how many of a meal (2 x Mince & Gravy)
        repeat_unit     TEXT,
        repeat_interval INTEGER NOT NULL DEFAULT 1,
        repeat_until    TEXT,
        people          INTEGER,
        is_meal         INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_entries_date ON calendar_entries(date);

    CREATE TABLE IF NOT EXISTS calendar_entry_tags (
        entry_id TEXT NOT NULL REFERENCES calendar_entries(id) ON DELETE CASCADE,
        tag      TEXT NOT NULL,
        PRIMARY KEY (entry_id, tag)
    );

    -- Dates a repeating entry skips: that occurrence was deleted, or changed into an entry of its own
    CREATE TABLE IF NOT EXISTS calendar_entry_skips (
        entry_id TEXT NOT NULL REFERENCES calendar_entries(id) ON DELETE CASCADE,
        date     TEXT NOT NULL,
        PRIMARY KEY (entry_id, date)
    );

    -- Meals tab: the items. Each is either a single item, with its quantity for one person (and
    -- calories and picture), or made of other items (its rows in item_parts). Meals refer to these by id.
    -- Calories are kcal per 100 g, with the weight of one of each unit (cup, tbsp, each, pack...) so
    -- any amount converts; protein, carbs, fat and alcohol are grams per 100 g, each null if not known.
    -- nutrition_source/source_id/source_name are the food it was looked up from ('cofid', 'off' or
    -- 'usda'), if any. confirmed is ticked once the item's been checked.
    CREATE TABLE IF NOT EXISTS ingredients (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
        amount           TEXT NOT NULL DEFAULT '',
        unit             TEXT NOT NULL DEFAULT '',
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        kcal_per_100g    REAL,
        grams_per_unit   TEXT NOT NULL DEFAULT '{}',
        nutrition_source TEXT NOT NULL DEFAULT '',
        source_id        TEXT NOT NULL DEFAULT '',
        source_name      TEXT NOT NULL DEFAULT '',
        protein_per_100g REAL,
        carbs_per_100g   REAL,
        fat_per_100g     REAL,
        alcohol_per_100g REAL,
        confirmed        INTEGER NOT NULL DEFAULT 0
    );

    -- The items an item is made of, in order, each with the amount it uses: for a single item its
    -- amount and unit, for an item made of other items how many of it (amount only; '' is one).
    -- An item can't be deleted while another is made of it.
    CREATE TABLE IF NOT EXISTS item_parts (
        parent_id TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
        position  INTEGER NOT NULL,
        child_id  TEXT NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
        amount    TEXT NOT NULL DEFAULT '',
        unit      TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (parent_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_item_parts_child ON item_parts(child_id);

    -- Games tab: the players, and each one's game for each day played. day is days since
    -- 1970 for the player's local date; the word itself is worked out by the browser.
    -- Meals tab: the Open Food Facts product found for a shopping list item (key is the item
    -- reduced to its search words), so each picture is looked up once. product is null when none matched.
    CREATE TABLE IF NOT EXISTS shopping_products (
        key        TEXT PRIMARY KEY,
        product    TEXT,
        fetched_at INTEGER NOT NULL
    );

    -- The picture chosen by hand for a shopping list item (key is the item's search words, whatever
    -- the supermarket); product is null for "no picture". Kept until changed, and wins over the above.
    CREATE TABLE IF NOT EXISTS shopping_product_picks (
        key       TEXT PRIMARY KEY,
        product   TEXT,
        picked_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_players (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS word_games (
        user_id    TEXT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
        day        INTEGER NOT NULL,
        guesses    TEXT NOT NULL DEFAULT '[]',
        status     TEXT NOT NULL DEFAULT 'playing', -- playing | won | lost
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, day)
    );

    -- The item each meal on the Meals tab's calendar is, with its own quantity per person if it
    -- has one ('' uses the item's): for a single item an amount and unit, for one made of others how
    -- many of it; times is how many of that. An item that's deleted drops out of its meals (a meal
    -- left with none is deleted with it).
    CREATE TABLE IF NOT EXISTS calendar_entry_parts (
        entry_id      TEXT NOT NULL REFERENCES calendar_entries(id) ON DELETE CASCADE,
        position      INTEGER NOT NULL,
        ingredient_id TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
        amount        TEXT NOT NULL DEFAULT '',
        unit          TEXT NOT NULL DEFAULT '',
        times         REAL NOT NULL DEFAULT 1,
        PRIMARY KEY (entry_id, position)
    );

    -- The family members (game_players, shown as Family in Settings) a meal is for
    CREATE TABLE IF NOT EXISTS calendar_entry_family (
        entry_id  TEXT NOT NULL REFERENCES calendar_entries(id) ON DELETE CASCADE,
        player_id TEXT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
        PRIMARY KEY (entry_id, player_id)
    );

    -- Meals tab's Meal Plan: a meal proposed for each day of a block of weeks that rotates on the
    -- calendar (its length and start date are the mealPlan setting). day counts from 0.
    -- A day can repeat every so many days or weeks within the plan; a day with a meal of its own
    -- keeps it, and a later repeating day takes over from an earlier one.
    -- A skipped day has no parts: it's left empty where a repeat would have filled it.
    CREATE TABLE IF NOT EXISTS meal_plan_days (
        day             INTEGER PRIMARY KEY,
        title           TEXT NOT NULL DEFAULT '',
        repeat_unit     TEXT,
        repeat_interval INTEGER NOT NULL DEFAULT 1,
        skipped         INTEGER NOT NULL DEFAULT 0,
        updated_at      INTEGER NOT NULL
    );

    -- The item each planned day is, as for calendar_entry_parts (a deleted one drops out)
    CREATE TABLE IF NOT EXISTS meal_plan_day_parts (
        day           INTEGER NOT NULL REFERENCES meal_plan_days(day) ON DELETE CASCADE,
        position      INTEGER NOT NULL,
        ingredient_id TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
        amount        TEXT NOT NULL DEFAULT '',
        unit          TEXT NOT NULL DEFAULT '',
        times         REAL NOT NULL DEFAULT 1,
        PRIMARY KEY (day, position)
    );

    CREATE TABLE IF NOT EXISTS library_index_meta (
        server_udn  TEXT PRIMARY KEY,
        server_name TEXT,
        built_at    INTEGER NOT NULL,
        item_count  INTEGER NOT NULL,
        duration_ms INTEGER
    );
`);


// ─── Settings ─────────────────────────────────────────────────────────────────

const _getSetting  = db.prepare('SELECT value FROM settings WHERE key = ?');
const _setSetting  = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
const _getAllSettings = db.prepare('SELECT key, value FROM settings');

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

// ─── Faces ────────────────────────────────────────────────────────────────────
// The browser finds faces in photos and turns each into a descriptor (128 numbers; faces of the
// same person are close together). People are named from a few of their faces (samples), and a
// photo's faces are cached by its key and a stamp of its size and date, so a folder scanned before
// only needs its new or changed photos looked at again.

db.exec(`
    CREATE TABLE IF NOT EXISTS face_people (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );

    CREATE TABLE IF NOT EXISTS face_samples (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id  INTEGER NOT NULL REFERENCES face_people(id) ON DELETE CASCADE,
        descriptor TEXT NOT NULL,
        source     TEXT,
        created    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_face_samples_person ON face_samples(person_id);

    CREATE TABLE IF NOT EXISTS face_scans (
        uri   TEXT PRIMARY KEY,
        stamp TEXT NOT NULL,
        faces TEXT NOT NULL
    );
`);

const _getFacePeople    = db.prepare(`SELECT p.id, p.name, COUNT(s.id) AS samples FROM face_people p
                                      LEFT JOIN face_samples s ON s.person_id = p.id GROUP BY p.id ORDER BY p.name`);
const _getFacePerson    = db.prepare('SELECT id, name FROM face_people WHERE name = ?');
const _insertFacePerson = db.prepare('INSERT INTO face_people (name) VALUES (?)');
const _deleteFacePerson = db.prepare('DELETE FROM face_people WHERE id = ?');
const _deleteFaceSamplesFor = db.prepare('DELETE FROM face_samples WHERE person_id = ?');
const _insertFaceSample = db.prepare('INSERT INTO face_samples (person_id, descriptor, source, created) VALUES (?, ?, ?, ?)');
const _deleteFaceSample = db.prepare('DELETE FROM face_samples WHERE id = ?');
const _getFaceSamples   = db.prepare(`SELECT s.id, s.person_id, p.name, s.descriptor FROM face_samples s
                                      JOIN face_people p ON p.id = s.person_id`);
const _getFaceScan      = db.prepare('SELECT stamp, faces FROM face_scans WHERE uri = ?');
const _setFaceScan      = db.prepare('INSERT OR REPLACE INTO face_scans (uri, stamp, faces) VALUES (?, ?, ?)');

// [{ id, name, samples }]
export function getFacePeople() {
    return _getFacePeople.all().map(r => ({ id: Number(r.id), name: r.name, samples: Number(r.samples) }));
}

// [{ id, personId, name, descriptor: [128 numbers] }]
export function getFaceSamples() {
    return _getFaceSamples.all().map(r => ({ id: Number(r.id), personId: Number(r.person_id), name: r.name, descriptor: JSON.parse(r.descriptor) }));
}

// Enough to know someone from many angles and ages; past it, more faces add little.
export const FACE_MAX_SAMPLES = 200;
const _countFaceSamples = db.prepare('SELECT COUNT(*) AS n FROM face_samples WHERE person_id = ?');

// Adds faces (each { descriptor, source }) to the person called `name`, who is added if new, up to
// FACE_MAX_SAMPLES in all. Returns the person as getFacePeople() gives them, and the ids of the
// samples added (in order; null for any over the limit).
export function addFaceSamples(name, samples) {
    const now = new Date().toISOString();
    let id;
    const sampleIds = [];
    runInTransaction(() => {
        id = Number(_getFacePerson.get(name)?.id ?? _insertFacePerson.run(name).lastInsertRowid);
        let room = FACE_MAX_SAMPLES - Number(_countFaceSamples.get(id).n);
        for (const s of samples) {
            if (room-- <= 0) { sampleIds.push(null); continue; }
            sampleIds.push(Number(_insertFaceSample.run(id, JSON.stringify(s.descriptor), s.source ? mediaKey(s.source) : null, now).lastInsertRowid));
        }
    });
    return { person: getFacePeople().find(p => p.id === id), sampleIds };
}

export function deleteFaceSample(id) {
    _deleteFaceSample.run(id);
}

export function deleteFacePerson(id) {
    runInTransaction(() => {
        _deleteFaceSamplesFor.run(id);
        _deleteFacePerson.run(id);
    });
}

// The faces cached for a photo, or null when there are none for this stamp.
export function getFaceScan(uri, stamp) {
    const row = _getFaceScan.get(mediaKey(uri));
    return row && row.stamp === stamp ? JSON.parse(row.faces) : null;
}

// items: [{ uri, stamp, faces }]
export function setFaceScans(items) {
    runInTransaction(() => {
        for (const { uri, stamp, faces } of items) _setFaceScan.run(mediaKey(uri), stamp, JSON.stringify(faces));
    });
}

// ─── Photo fingerprints (finding duplicates) ─────────────────────────────────
// dhash: 16 hex digits ('' if the photo couldn't be read), w/h: its pixel size, sha1: of its
// bytes, only worked out for photos that might be exact copies. Kept against the file's stamp.

db.exec(`
    CREATE TABLE IF NOT EXISTS photo_hashes (
        uri   TEXT PRIMARY KEY,
        stamp TEXT NOT NULL,
        dhash TEXT,
        w     INTEGER,
        h     INTEGER,
        sha1  TEXT
    );
`);

const _getPhotoHash = db.prepare('SELECT stamp, dhash, w, h, sha1 FROM photo_hashes WHERE uri = ?');
const _setPhotoHash = db.prepare('INSERT OR REPLACE INTO photo_hashes (uri, stamp, dhash, w, h, sha1) VALUES (?, ?, ?, ?, ?, ?)');

// { dhash, w, h, sha1 } for the photo as it is now, or null
export function getPhotoHash(uri, stamp) {
    const row = _getPhotoHash.get(mediaKey(uri));
    if (!row || row.stamp !== stamp) return null;
    return { dhash: row.dhash, w: Number(row.w) || 0, h: Number(row.h) || 0, sha1: row.sha1 || null };
}

export function setPhotoHash(uri, stamp, { dhash, w, h, sha1 }) {
    _setPhotoHash.run(mediaKey(uri), stamp, dhash ?? null, w || 0, h || 0, sha1 || null);
}

// ─── File Tags ────────────────────────────────────────────────────────────────
// Tags, rotations and deleted markers are stored against mediaKey(uri) ("<server name>/<path>"),
// never the URL itself, so they survive the server's address or http/https changing. Every
// function here accepts either a URL or a key.

const _insertTag          = db.prepare('INSERT OR IGNORE INTO file_tags (uri, tag) VALUES (?, ?)');
const _deleteTag          = db.prepare('DELETE FROM file_tags WHERE uri = ? AND tag = ?');
const _deleteAllTagsForUri = db.prepare('DELETE FROM file_tags WHERE uri = ?');
const _getAllFileTags      = db.prepare('SELECT uri, tag FROM file_tags');
const _getAllTags          = db.prepare('SELECT DISTINCT tag FROM file_tags ORDER BY tag');
const _getUrisByTag       = db.prepare('SELECT uri FROM file_tags WHERE tag = ?');

export function setFileTags(uri, tags) {
    const key = mediaKey(uri);
    runInTransaction(() => {
        _deleteAllTagsForUri.run(key);
        for (const tag of tags) _insertTag.run(key, tag);
    });
}

export function addFileTag(uri, tag) {
    _insertTag.run(mediaKey(uri), tag);
}

export function removeFileTag(uri, tag) {
    _deleteTag.run(mediaKey(uri), tag);
}

// { key: [tags] }
export function getAllFileTags() {
    const out = {};
    for (const { uri, tag } of _getAllFileTags.all()) {
        if (!out[uri]) out[uri] = [];
        out[uri].push(tag);
    }
    return out;
}

// `kind` 'music' leaves out the names of the people face tagging knows (wherever they're tagged),
// and tags only ever put on photos and videos; 'photo' leaves out tags only on music. A file whose
// type can't be told from its key (a media server URL with no extension) counts for both.
const PICTURE_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|mp4|m4v|mov|webm|mkv|avi)$/i;
const AUDIO_EXT = /\.(mp3|flac|m4a|aac|wav|ogg|opus|wma|aiff|alac)$/i;

export function getAllTags(kind) {
    if (kind !== 'music' && kind !== 'photo') return _getAllTags.all().map(r => r.tag);
    const other = kind === 'music' ? PICTURE_EXT : AUDIO_EXT;
    const people = kind === 'music' ? new Set(getPeopleTagNames()) : null;
    const tags = new Set();
    for (const { uri, tag } of _getAllFileTags.all()) {
        if (tags.has(tag) || people?.has(tag.toLowerCase())) continue;
        if (!other.test(uri.replace(/[?#].*$/, ''))) tags.add(tag);
    }
    return [...tags].sort();
}

// The names of the people face tagging knows, lower-cased: a tag with one of these names is a person
const _getFacePeopleNames = db.prepare('SELECT name FROM face_people');
export function getPeopleTagNames() {
    return _getFacePeopleNames.all().map(r => r.name.toLowerCase());
}

// [{ tag, files, music, photos }]: every tag, how many files have it, and how many of those are
// music and how many photos or videos (files that can't be told apart count in neither)
export function getTagUsage() {
    const usage = new Map();
    for (const { uri, tag } of _getAllFileTags.all()) {
        let u = usage.get(tag);
        if (!u) usage.set(tag, u = { tag, files: 0, music: 0, photos: 0 });
        const path = uri.replace(/[?#].*$/, '');
        u.files++;
        if (AUDIO_EXT.test(path)) u.music++;
        else if (PICTURE_EXT.test(path)) u.photos++;
    }
    return [...usage.values()].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' }));
}

const _copyTag        = db.prepare('INSERT OR IGNORE INTO file_tags (uri, tag) SELECT uri, ? FROM file_tags WHERE tag = ?');
const _deleteTagAll   = db.prepare('DELETE FROM file_tags WHERE tag = ?');
const _countTag       = db.prepare('SELECT COUNT(*) AS n FROM file_tags WHERE tag = ?');
const _renamePerson   = db.prepare('UPDATE face_people SET name = ? WHERE id = ?');
const _moveFaceSamples = db.prepare('UPDATE face_samples SET person_id = ? WHERE person_id = ?');

// Renames a tag on every file that has it; files that already have the new name keep just the one.
// When the old name is a person face tagging knows, they're renamed too, or merged into the person
// already called the new name. Returns how many files had the tag.
export function renameTag(from, to) {
    let files = 0;
    runInTransaction(() => {
        files = Number(_countTag.get(from).n);
        if (from !== to) {
            _copyTag.run(to, from);
            _deleteTagAll.run(from);
        }
        const person = _getFacePerson.get(from); // names are compared ignoring case
        if (!person) return;
        const existing = _getFacePerson.get(to);
        if (existing && Number(existing.id) !== Number(person.id)) {
            _moveFaceSamples.run(existing.id, person.id);
            _deleteFacePerson.run(person.id);
        } else {
            _renamePerson.run(to, person.id);
        }
    });
    return files;
}

// Takes a tag off every file. A person face tagging knows stays known; they're removed there.
export function deleteTag(tag) {
    return Number(_deleteTagAll.run(tag).changes);
}

// Keys, not URLs - see mediaUrlFromKey() to play one.
export function getKeysByTag(tag) {
    return _getUrisByTag.all(tag).map(r => r.uri);
}

// ─── Photo Rotations ──────────────────────────────────────────────────────────

const _getRotation    = db.prepare('SELECT angle FROM photo_rotations WHERE uri = ?');
const _upsertRotation = db.prepare('INSERT OR REPLACE INTO photo_rotations (uri, angle) VALUES (?, ?)');
const _getAllRotations = db.prepare('SELECT uri, angle FROM photo_rotations');

export function getPhotoRotation(uri) {
    const row = _getRotation.get(mediaKey(uri));
    return row ? row.angle : 0;
}

export function setPhotoRotation(uri, angle) {
    _upsertRotation.run(mediaKey(uri), Number(angle));
}

// { key: angle }
export function getAllPhotoRotations() {
    const out = {};
    for (const { uri, angle } of _getAllRotations.all()) out[uri] = angle;
    return out;
}

// ─── Deleted Photos ───────────────────────────────────────────────────────────

const _markDeleted  = db.prepare('INSERT OR IGNORE INTO deleted_photos (uri) VALUES (?)');
const _getAllDeleted = db.prepare('SELECT uri FROM deleted_photos');
const _unmarkDeleted = db.prepare('DELETE FROM deleted_photos WHERE uri = ?');

export function markPhotoDeleted(uri) {
    _markDeleted.run(mediaKey(uri));
}

export function unmarkPhotoDeleted(uri) {
    _unmarkDeleted.run(mediaKey(uri));
}

// { key: true }
export function getAllDeletedPhotos() {
    const out = {};
    for (const { uri } of _getAllDeleted.all()) out[uri] = true;
    return out;
}

// ─── Media key upkeep ─────────────────────────────────────────────────────────

const MEDIA_KEY_TABLES = [
    { table: 'file_tags', cols: ['tag'], rowId: ['uri', 'tag'] },
    { table: 'photo_rotations', cols: ['angle'], rowId: ['uri'] },
    { table: 'deleted_photos', cols: [], rowId: ['uri'] },
];

// Keys saved for a server that wasn't known yet are "host:port/..."; once it's been identified,
// they become "<server name>/...". Run at startup, once the device list is loaded, and whenever a
// new server is identified. Returns how many rows changed.
export function resolveMediaKeys() {
    let changed = 0;
    runInTransaction(() => {
        for (const { table, cols, rowId } of MEDIA_KEY_TABLES) {
            const all = ['uri', ...cols];
            const insert = db.prepare(`INSERT OR REPLACE INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`);
            const del = db.prepare(`DELETE FROM ${table} WHERE ${rowId.map(c => `${c} = ?`).join(' AND ')}`);
            for (const row of db.prepare(`SELECT ${all.join(', ')} FROM ${table}`).all()) {
                const key = mediaKey(row.uri);
                if (!key || key === row.uri) continue;
                del.run(...rowId.map(c => row[c]));
                insert.run(key, ...cols.map(c => row[c]));
                changed++;
            }
        }
    });
    return changed;
}

// The file itself is gone for good: drop everything saved against it (tags, rotation, hidden marker).
export function forgetMediaKey(uri) {
    const key = mediaKey(uri);
    runInTransaction(() => {
        for (const { table } of MEDIA_KEY_TABLES) db.prepare(`DELETE FROM ${table} WHERE uri = ?`).run(key);
    });
}

// A media server was renamed (e.g. this app's Device Name): move its saved keys to the new name.
export function renameMediaKeyServer(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    const prefix = oldName + '/';
    runInTransaction(() => {
        for (const { table } of MEDIA_KEY_TABLES) {
            db.prepare(`UPDATE OR REPLACE ${table} SET uri = ? || substr(uri, ?) WHERE substr(uri, 1, ?) = ?`)
                .run(newName, oldName.length + 1, prefix.length, prefix);
        }
    });
}

// ─── Play History ─────────────────────────────────────────────────────────────

const _insertPlay = db.prepare(`
    INSERT OR IGNORE INTO play_history (id, timestamp, title, artist, album, server_name, player_name)
    VALUES (@id, @timestamp, @title, @artist, @album, @server_name, @player_name)
`);

const _getTopTracks = db.prepare(`
    SELECT title, artist, COUNT(*) as count
    FROM play_history
    WHERE title IS NOT NULL
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

// Index rows hold this machine's own URLs without a host (see toStoredUrl): its address changes.
function storedIndexItem(it) {
    return JSON.stringify({ ...it, uri: toStoredUrl(it.uri), albumArtUrl: toStoredUrl(it.albumArtUrl) });
}

function readIndexItem(data) {
    const it = JSON.parse(data);
    if (it.uri) it.uri = fromStoredUrl(it.uri);
    if (it.albumArtUrl) it.albumArtUrl = fromStoredUrl(it.albumArtUrl);
    return it;
}

// Replaces a server's whole index in one transaction, so searches never see a half-built one.
export function replaceLibraryIndex(udn, serverName, items, durationMs) {
    const ins = db.prepare('INSERT OR REPLACE INTO library_index (server_udn, id, title, album, disc, track, path_ids, search_text, data, photo_date, photo_md) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    runInTransaction(() => {
        db.prepare('DELETE FROM library_index WHERE server_udn = ?').run(udn);
        for (const it of items) {
            let ids = [];
            try { ids = JSON.parse(it._path || '[]').map(p => p.id); } catch (e) { }
            const date = photoDateString(it);
            ins.run(udn, String(it.id), it.title || '', it.album || '', it.discNumber || 1, it.trackNumber || 0,
                '|' + ids.join('|') + '|',
                normSearch([it.title, it.artist, it.albumArtist, it.album].filter(Boolean).join(' ')),
                storedIndexItem(it), date, date ? date.slice(5) : null);
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
    return { items: rows.slice(0, limit).map(r => readIndexItem(r.data)), truncated };
}

// Every indexed item on a server, for callers that do their own (fuzzy) matching.
export function getLibraryIndexItems(udn) {
    return db.prepare('SELECT data FROM library_index WHERE server_udn = ?').all(udn).map(r => readIndexItem(r.data));
}

// One indexed item by its id, or null.
export function getLibraryIndexItem(udn, id) {
    const row = db.prepare('SELECT data FROM library_index WHERE server_udn = ? AND id = ?').get(udn, String(id));
    return row ? readIndexItem(row.data) : null;
}

// Drops the indexed items whose URL has one of the given media keys (files deleted from the
// library), so they leave searches and slideshows straight away rather than at the next rebuild.
export function removeFromLibraryIndex(udn, keys) {
    const wanted = new Set([...keys].map(k => mediaKey(k)));
    if (wanted.size === 0) return 0;
    const del = db.prepare('DELETE FROM library_index WHERE server_udn = ? AND id = ?');
    let removed = 0;
    runInTransaction(() => {
        for (const row of db.prepare("SELECT id, json_extract(data, '$.uri') AS uri FROM library_index WHERE server_udn = ?").all(udn)) {
            if (row.uri && wanted.has(mediaKey(fromStoredUrl(row.uri)))) removed += del.run(udn, row.id).changes;
        }
    });
    return removed;
}

// Every indexed item somewhere below a folder ('0' or empty = the whole server).
export function getLibraryIndexItemsUnder(udn, scopeId) {
    if (!scopeId || scopeId === '0') return getLibraryIndexItems(udn);
    return db.prepare("SELECT data FROM library_index WHERE server_udn = ? AND path_ids LIKE ? ESCAPE '!'")
        .all(udn, `%|${likeEscape(String(scopeId))}|%`).map(r => readIndexItem(r.data));
}

// The indexed photos below a folder matching a condition on the photo date columns
function getLibraryIndexPhotosWhere(udn, scopeId, condition, value) {
    let sql = `SELECT data FROM library_index WHERE server_udn = ? AND ${condition}`;
    const args = [udn, value];
    if (scopeId && scopeId !== '0') {
        sql += " AND path_ids LIKE ? ESCAPE '!'";
        args.push(`%|${likeEscape(String(scopeId))}|%`);
    }
    return db.prepare(sql).all(...args).map(r => readIndexItem(r.data));
}

// The indexed photos below a folder taken on a given day of the year ("MM-DD"), any year.
export function getLibraryIndexPhotosOnDay(udn, scopeId, md) {
    return getLibraryIndexPhotosWhere(udn, scopeId, 'photo_md = ?', md);
}

// The indexed photos below a folder taken on or after a date ("YYYY-MM-DD").
export function getLibraryIndexPhotosSince(udn, scopeId, date) {
    return getLibraryIndexPhotosWhere(udn, scopeId, 'photo_date >= ?', date);
}

// ─── Database overview (for the Database Stats dialog) ───────────────────────

const TABLE_DESCRIPTIONS = {
    settings: 'Application settings',
    devices: 'Known renderers / servers',
    file_tags: 'Tags applied to files',
    photo_rotations: 'Manual photo rotations',
    deleted_photos: 'Photos marked as deleted',
    face_people: 'People named for face tagging',
    face_samples: 'Faces each named person was learned from',
    face_scans: 'Faces found in each photo (cache)',
    photo_hashes: 'Photo fingerprints for finding duplicates (cache)',
    play_history: 'Tracks played',
    album_art: 'Cached album art images',
    lyrics_cache: 'Cached lyrics lookups',
    youtube_video_cache: 'Cached YouTube video matches',
    youtube_candidates_cache: 'Cached YouTube candidate lists',
    youtube_artist_channel: 'Artist YouTube channels resolved',
    youtube_channel_videos: 'Uploads indexed from artist channels',
    library_index: 'Searchable copy of the media library',
    library_index_meta: 'When each library index was built',
    calendar_entries: 'Entries added on the Calendar tab',
    calendar_entry_tags: 'Tags on calendar entries',
    calendar_entry_parts: 'Items in each planned meal',
    calendar_entry_family: 'Family members each planned meal is for',
    meal_plan_days: 'Days of the meal plan',
    meal_plan_day_parts: 'Items on each day of the meal plan',
    ingredients: 'Items (quantity for one person)',
    item_parts: 'The items each item is made of',
    shopping_products: 'Cached product pictures for shopping list items',
    shopping_product_picks: 'Product pictures chosen for shopping list items',
};

// ─── Items ────────────────────────────────────────────────────────────────────

const INGREDIENT_COLS = 'id, name, amount, unit, kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, alcohol_per_100g, grams_per_unit, nutrition_source, source_id, source_name, confirmed';
const _listIngredients    = db.prepare(`SELECT ${INGREDIENT_COLS} FROM ingredients ORDER BY name COLLATE NOCASE`);
const _ingredientById     = db.prepare(`SELECT ${INGREDIENT_COLS} FROM ingredients WHERE id = ?`);
const _ingredientByName   = db.prepare('SELECT id FROM ingredients WHERE name = ? COLLATE NOCASE');
const _insertIngredientDef = db.prepare('INSERT INTO ingredients (id, name, amount, unit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
const _updateIngredientDef = db.prepare('UPDATE ingredients SET name = ?, amount = ?, unit = ?, updated_at = ? WHERE id = ?');
const _setIngredientNutrition = db.prepare(`UPDATE ingredients SET kcal_per_100g = ?, protein_per_100g = ?, carbs_per_100g = ?, fat_per_100g = ?,
    alcohol_per_100g = ?, grams_per_unit = ?, nutrition_source = ?, source_id = ?, source_name = ?, updated_at = ? WHERE id = ?`);
const _setIngredientMacros = db.prepare('UPDATE ingredients SET protein_per_100g = ?, carbs_per_100g = ?, fat_per_100g = ? WHERE id = ?');
const _setIngredientAlcohol = db.prepare('UPDATE ingredients SET alcohol_per_100g = ? WHERE id = ?');
const _setIngredientConfirmed = db.prepare('UPDATE ingredients SET confirmed = ?, updated_at = ? WHERE id = ?');
const _deleteIngredientDef = db.prepare('DELETE FROM ingredients WHERE id = ?');
const PARTS_SELECT = 'SELECT p.parent_id, p.child_id, p.amount, p.unit, i.name FROM item_parts p JOIN ingredients i ON i.id = p.child_id';
const _allParts    = db.prepare(`${PARTS_SELECT} ORDER BY p.parent_id, p.position`);
const _itemParts   = db.prepare(`${PARTS_SELECT} WHERE p.parent_id = ? ORDER BY p.position`);
const _clearParts  = db.prepare('DELETE FROM item_parts WHERE parent_id = ?');
const _insertPart  = db.prepare('INSERT INTO item_parts (parent_id, position, child_id, amount, unit) VALUES (?, ?, ?, ?, ?)');
const _partChildren = db.prepare('SELECT child_id FROM item_parts WHERE parent_id = ?');
const _itemsUsing  = db.prepare(`SELECT DISTINCT i.name FROM item_parts p JOIN ingredients i ON i.id = p.parent_id
    WHERE p.child_id = ? ORDER BY i.name COLLATE NOCASE`);

const partRowOut = r => ({ itemId: r.child_id, name: r.name, amount: r.amount, unit: r.unit });

// nutrition is null until calories are set: { kcalPer100g, proteinPer100g, carbsPer100g, fatPer100g, alcoholPer100g,
// gramsPerUnit: { unit: grams }, source, sourceId, sourceName } (a macro is null if not known;
// source is '' when the calories were typed in). parts is null for a single item, else the items
// it's made of: [{ itemId, name, amount, unit }].
const ingredientOut = (row, parts) => row && ({
    id: row.id, name: row.name, amount: row.amount, unit: row.unit, confirmed: !!row.confirmed,
    nutrition: row.kcal_per_100g == null ? null : {
        kcalPer100g: row.kcal_per_100g,
        proteinPer100g: row.protein_per_100g,
        carbsPer100g: row.carbs_per_100g,
        fatPer100g: row.fat_per_100g,
        alcoholPer100g: row.alcohol_per_100g,
        gramsPerUnit: JSON.parse(row.grams_per_unit || '{}'),
        source: row.nutrition_source,
        sourceId: row.source_id,
        sourceName: row.source_name,
    },
    parts: parts && parts.length ? parts : null,
});

// [{ id, name, amount, unit, confirmed, nutrition, parts }] sorted by name; amount/unit are the quantity for one person
export function listIngredients() {
    const parts = new Map();
    for (const r of _allParts.all()) {
        if (!parts.has(r.parent_id)) parts.set(r.parent_id, []);
        parts.get(r.parent_id).push(partRowOut(r));
    }
    return _listIngredients.all().map(row => ingredientOut(row, parts.get(row.id)));
}

export function getIngredient(id) {
    const row = _ingredientById.get(id);
    return row ? ingredientOut(row, _itemParts.all(id).map(partRowOut)) : undefined;
}

// Id of the ingredient with this name (ignoring case), if any
export function findIngredientIdByName(name) {
    return _ingredientByName.get(name)?.id;
}

// Whether making item id out of childIds would make it part of itself (directly or further down)
export function itemPartsLoop(id, childIds) {
    const seen = new Set();
    const stack = [...childIds];
    while (stack.length) {
        const next = stack.pop();
        if (next === id) return true;
        if (seen.has(next)) continue;
        seen.add(next);
        for (const r of _partChildren.all(next)) stack.push(r.child_id);
    }
    return false;
}

// Leaving nutrition, confirmed or parts out keeps what's saved; null nutrition clears it.
// parts: [{ id, amount, unit }] makes it an item made of those; [] makes it a single item.
export function saveIngredient({ id, name, amount, unit, nutrition, confirmed, parts }) {
    const now = Date.now();
    runInTransaction(() => {
        if (_ingredientById.get(id)) _updateIngredientDef.run(name, amount, unit, now, id);
        else _insertIngredientDef.run(id, name, amount, unit, now, now);
        if (nutrition !== undefined) {
            _setIngredientNutrition.run(nutrition?.kcalPer100g ?? null,
                nutrition?.proteinPer100g ?? null, nutrition?.carbsPer100g ?? null, nutrition?.fatPer100g ?? null, nutrition?.alcoholPer100g ?? null,
                JSON.stringify(nutrition?.gramsPerUnit || {}),
                nutrition?.source || '', nutrition?.sourceId || '', nutrition?.sourceName || '', now, id);
        }
        if (confirmed !== undefined) _setIngredientConfirmed.run(confirmed ? 1 : 0, now, id);
        if (parts !== undefined) {
            _clearParts.run(id);
            parts.forEach((part, i) => _insertPart.run(id, i, part.id, part.amount || '', part.unit || ''));
        }
    });
    return getIngredient(id);
}

// Fills in protein, carbs and fat looked up later for an ingredient saved with only calories
export function setIngredientMacros(id, { proteinPer100g, carbsPer100g, fatPer100g }) {
    _setIngredientMacros.run(proteinPer100g ?? null, carbsPer100g ?? null, fatPer100g ?? null, id);
}

// Fills in the alcohol looked up later for an ingredient saved before alcohol was kept
export function setIngredientAlcohol(id, alcoholPer100g) {
    _setIngredientAlcohol.run(alcoholPer100g ?? null, id);
}

// Names of the items made of this one (it can't be deleted while there are any)
export function itemsUsingIngredient(id) {
    return _itemsUsing.all(id).map(r => r.name);
}

// The calendar meals it's on, by date (it can't be deleted while there are any): [{ id, date, title,
// parts: [names], repeat: { unit, interval, until } | null }]
const _mealsUsing = db.prepare(`SELECT e.id, e.date, e.title, e.repeat_unit, e.repeat_interval, e.repeat_until,
        (SELECT GROUP_CONCAT(i.name, '\u001f') FROM (SELECT ingredient_id FROM calendar_entry_parts
            WHERE entry_id = e.id ORDER BY position) p2 JOIN ingredients i ON i.id = p2.ingredient_id) AS part_names
    FROM calendar_entries e
    WHERE e.is_meal = 1 AND EXISTS (SELECT 1 FROM calendar_entry_parts p WHERE p.entry_id = e.id AND p.ingredient_id = ?)
    ORDER BY e.date, e.title COLLATE NOCASE`);
export function mealsUsingIngredient(id) {
    return _mealsUsing.all(id).map(r => ({
        id: r.id, date: r.date, title: r.title,
        parts: r.part_names ? r.part_names.split('\u001f') : [],
        repeat: r.repeat_unit ? { unit: r.repeat_unit, interval: r.repeat_interval, until: r.repeat_until } : null,
    }));
}

// It drops out of the meal plan days it's on; a meal or day left with nothing goes too
const _deleteEmptyMeals = db.prepare(`DELETE FROM calendar_entries WHERE is_meal = 1
    AND NOT EXISTS (SELECT 1 FROM calendar_entry_parts p WHERE p.entry_id = calendar_entries.id)`);
const _deleteEmptyPlanDays = db.prepare(`DELETE FROM meal_plan_days WHERE skipped = 0
    AND NOT EXISTS (SELECT 1 FROM meal_plan_day_parts p WHERE p.day = meal_plan_days.day)`);
export function deleteIngredient(id) {
    return runInTransaction(() => {
        const deleted = Number(_deleteIngredientDef.run(id).changes) > 0;
        _deleteEmptyMeals.run();
        _deleteEmptyPlanDays.run();
        return deleted;
    });
}

// ─── Shopping list product pictures ───────────────────────────────────────────

const _getShoppingProduct = db.prepare('SELECT product, fetched_at FROM shopping_products WHERE key = ?');
const _setShoppingProduct = db.prepare('INSERT OR REPLACE INTO shopping_products (key, product, fetched_at) VALUES (?, ?, ?)');

// { product: { code, name, brand, image } | null, fetchedAt } or null if never looked up
export function getCachedShoppingProduct(key) {
    const row = _getShoppingProduct.get(key);
    return row ? { product: row.product ? JSON.parse(row.product) : null, fetchedAt: row.fetched_at } : null;
}

export function setCachedShoppingProduct(key, product) {
    _setShoppingProduct.run(key, product ? JSON.stringify(product) : null, Date.now());
}

const _getShoppingPick = db.prepare('SELECT product FROM shopping_product_picks WHERE key = ?');
const _setShoppingPick = db.prepare('INSERT OR REPLACE INTO shopping_product_picks (key, product, picked_at) VALUES (?, ?, ?)');
const _deleteShoppingPick = db.prepare('DELETE FROM shopping_product_picks WHERE key = ?');

// { product: { code, name, brand, image } | null } if a picture was chosen for the item, otherwise null
export function getShoppingProductPick(key) {
    const row = _getShoppingPick.get(key);
    return row ? { product: row.product ? JSON.parse(row.product) : null } : null;
}

export function setShoppingProductPick(key, product) {
    _setShoppingPick.run(key, product ? JSON.stringify(product) : null, Date.now());
}

export function deleteShoppingProductPick(key) {
    _deleteShoppingPick.run(key);
}

// ─── Calendar Entries ─────────────────────────────────────────────────────────

// One-off entries inside the range, plus every repeating one that starts before its end
const ENTRY_SELECT = 'SELECT e.* FROM calendar_entries e';
const _entriesInRange   = db.prepare(`${ENTRY_SELECT}
    WHERE e.date < ? AND (e.date >= ? OR (e.repeat_unit IS NOT NULL AND (e.repeat_until IS NULL OR e.repeat_until >= ?)))
    ORDER BY e.created_at`);
const _entryById        = db.prepare(`${ENTRY_SELECT} WHERE e.id = ?`);
const _entryExists      = db.prepare('SELECT 1 FROM calendar_entries WHERE id = ?');
const _insertEntry      = db.prepare(`INSERT INTO calendar_entries (id, date, title, description, repeat_unit, repeat_interval, repeat_until, is_meal, people, times, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const _updateEntry      = db.prepare(`UPDATE calendar_entries SET date = ?, title = ?, description = ?, repeat_unit = ?, repeat_interval = ?, repeat_until = ?, is_meal = ?, people = ?, times = ?, updated_at = ?
    WHERE id = ?`);
// A meal's part is an item, with any quantity of its own: { id, name, amount, unit, times } (amount
// and unit '' for the item's; times how many of that quantity)
const PART_SELECT = 'i.id AS id, i.name AS name, p.amount AS amount, p.unit AS unit, p.times AS times';
const PART_JOINS = 'JOIN ingredients i ON i.id = p.ingredient_id';
const partOut = r => ({ id: r.id, name: r.name, amount: r.amount, unit: r.unit, times: r.times });
const _entryParts       = db.prepare(`SELECT ${PART_SELECT} FROM calendar_entry_parts p ${PART_JOINS}
    WHERE p.entry_id = ? ORDER BY p.position`);
const _insertEntryPart  = db.prepare('INSERT INTO calendar_entry_parts (entry_id, position, ingredient_id, amount, unit, times) VALUES (?, ?, ?, ?, ?, ?)');
const _clearEntryParts  = db.prepare('DELETE FROM calendar_entry_parts WHERE entry_id = ?');
const _entryFamily      = db.prepare(`SELECT g.id, g.name FROM calendar_entry_family f JOIN game_players g ON g.id = f.player_id
    WHERE f.entry_id = ? ORDER BY g.name COLLATE NOCASE`);
const _insertEntryFamily = db.prepare('INSERT OR IGNORE INTO calendar_entry_family (entry_id, player_id) VALUES (?, ?)');
const _clearEntryFamily = db.prepare('DELETE FROM calendar_entry_family WHERE entry_id = ?');
const _lastMealFamily   = db.prepare(`SELECT player_id FROM calendar_entry_family WHERE entry_id = (
    SELECT e.id FROM calendar_entries e WHERE e.is_meal = 1
        AND EXISTS (SELECT 1 FROM calendar_entry_family f WHERE f.entry_id = e.id)
    ORDER BY e.updated_at DESC LIMIT 1)`);
const _deleteEntry      = db.prepare('DELETE FROM calendar_entries WHERE id = ?');
const _entryTags        = db.prepare('SELECT tag FROM calendar_entry_tags WHERE entry_id = ? ORDER BY rowid');
const _insertEntryTag   = db.prepare('INSERT OR IGNORE INTO calendar_entry_tags (entry_id, tag) VALUES (?, ?)');
const _clearEntryTags   = db.prepare('DELETE FROM calendar_entry_tags WHERE entry_id = ?');
// Meal entries live on the Meals tab's calendar, which doesn't use tags
const _allEntryTags     = db.prepare(`SELECT DISTINCT t.tag FROM calendar_entry_tags t
    JOIN calendar_entries e ON e.id = t.entry_id WHERE e.is_meal = 0 ORDER BY t.tag`);
const _entrySkips       = db.prepare('SELECT date FROM calendar_entry_skips WHERE entry_id = ?');
const _insertEntrySkip  = db.prepare('INSERT OR IGNORE INTO calendar_entry_skips (entry_id, date) VALUES (?, ?)');

// repeat is null or { unit: 'day'|'week'|'month', interval, until: YYYY-MM-DD|null }.
// meal is null, or for a meal { name (may be ''), times (how many of it), parts: [{ id, name, ... }] (items), family: [{ id, name }] };
// people is how many it was for when saved (still there if its family members have been deleted).
const entryOut = row => row && ({
    id: row.id, date: row.date, title: row.title, description: row.description,
    repeat: row.repeat_unit ? { unit: row.repeat_unit, interval: row.repeat_interval || 1, until: row.repeat_until || null } : null,
    meal: row.is_meal ? {
        name: row.title,
        times: row.times || 1,
        parts: _entryParts.all(row.id).map(partOut),
        family: _entryFamily.all(row.id).map(r => ({ id: r.id, name: r.name }))
    } : null,
    people: row.people ?? null,
    tags: _entryTags.all(row.id).map(r => r.tag)
});

// Date-only arithmetic in UTC, so no timezone or DST shifts creep in
const DAY_MS = 86400000;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; };
const ymdToDays = s => { const { y, m, d } = parseYmd(s); return Date.UTC(y, m - 1, d) / DAY_MS; };
const daysToYmd = n => new Date(n * DAY_MS).toISOString().slice(0, 10);

// The dates (YYYY-MM-DD) an entry falls on within [start, end). Monthly repeats from
// the 29th-31st land on the last day of shorter months.
function occurrenceDates(entry, start, end) {
    if (!entry.repeat) return entry.date >= start && entry.date < end ? [entry.date] : [];
    const { unit, interval, until } = entry.repeat;
    const last = until && until < end ? until : null; // inclusive
    const out = [];
    const keep = d => d >= start && d < end && (!last || d <= last);
    if (unit === 'month') {
        const { y, m, d } = parseYmd(entry.date);
        const s = parseYmd(start);
        // Skip whole steps that end before the range starts
        let n = Math.max(0, Math.floor(((s.y - y) * 12 + (s.m - m)) / interval) - 1);
        for (; ; n++) {
            const monthIndex = (m - 1) + n * interval;
            const yy = y + Math.floor(monthIndex / 12);
            const mm = monthIndex % 12;
            const dim = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
            const date = daysToYmd(Date.UTC(yy, mm, Math.min(d, dim)) / DAY_MS);
            if (date >= end || (last && date > last)) break;
            if (keep(date)) out.push(date);
        }
    } else {
        const step = interval * (unit === 'week' ? 7 : 1);
        const first = ymdToDays(entry.date);
        const endDays = ymdToDays(end);
        let n = Math.max(0, Math.ceil((ymdToDays(start) - first) / step));
        for (let day = first + n * step; day < endDays; day += step) {
            const date = daysToYmd(day);
            if (last && date > last) break;
            if (keep(date)) out.push(date);
        }
    }
    return out;
}

// start inclusive, end exclusive, both YYYY-MM-DD. A repeating entry appears once per
// occurrence: `date` is that occurrence, `startDate` the date the series began.
export function getCalendarEntries(start, end) {
    const out = [];
    for (const entry of _entriesInRange.all(end, start, start).map(entryOut)) {
        const skips = entry.repeat ? new Set(_entrySkips.all(entry.id).map(r => r.date)) : null;
        for (const date of occurrenceDates(entry, start, end)) {
            if (!skips?.has(date)) out.push({ ...entry, startDate: entry.date, date });
        }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function getCalendarEntry(id) {
    return entryOut(_entryById.get(id));
}

// meal: null, or { parts: [{ id, amount, unit, times }] (items, in order), family: [player ids], times (how many of the meal) }
// (its name is the title).
// Call inside a transaction.
function writeCalendarEntry({ id, date, title, description, repeat, meal = null, tags }) {
    const now = Date.now();
    const [unit, interval, until] = repeat ? [repeat.unit, repeat.interval, repeat.until || null] : [null, 1, null];
    const people = meal && meal.family.length ? meal.family.length : null;
    const times = meal?.times || 1;
    if (_entryExists.get(id)) _updateEntry.run(date, title, description, unit, interval, until, meal ? 1 : 0, people, times, now, id);
    else _insertEntry.run(id, date, title, description, unit, interval, until, meal ? 1 : 0, people, times, now, now);
    _clearEntryTags.run(id);
    for (const tag of tags) _insertEntryTag.run(id, tag);
    _clearEntryParts.run(id);
    _clearEntryFamily.run(id);
    if (meal) {
        meal.parts.forEach((part, i) => _insertEntryPart.run(id, i, part.id, part.amount || '', part.unit || '', part.times || 1));
        for (const playerId of meal.family) _insertEntryFamily.run(id, playerId);
    }
}

export function saveCalendarEntry(entry) {
    runInTransaction(() => writeCalendarEntry(entry));
    return getCalendarEntry(entry.id);
}

// The family members on the most recently saved meal that has any, to start a new meal with
export function getLastMealFamily() {
    return _lastMealFamily.all().map(r => r.player_id);
}

// ─── Meal Plan ────────────────────────────────────────────────────────────────

const _planDays       = db.prepare('SELECT day, title, repeat_unit, repeat_interval, skipped FROM meal_plan_days ORDER BY day');
const _planDayParts   = db.prepare(`SELECT p.day, ${PART_SELECT} FROM meal_plan_day_parts p ${PART_JOINS}
    ORDER BY p.day, p.position`);
const _upsertPlanDay  = db.prepare(`INSERT INTO meal_plan_days (day, title, repeat_unit, repeat_interval, skipped, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET title = excluded.title, repeat_unit = excluded.repeat_unit,
        repeat_interval = excluded.repeat_interval, skipped = excluded.skipped, updated_at = excluded.updated_at`);
const _clearPlanParts = db.prepare('DELETE FROM meal_plan_day_parts WHERE day = ?');
const _insertPlanPart = db.prepare('INSERT INTO meal_plan_day_parts (day, position, ingredient_id, amount, unit, times) VALUES (?, ?, ?, ?, ?, ?)');
const _deletePlanDay  = db.prepare('DELETE FROM meal_plan_days WHERE day = ?');

const MEAL_PLAN_DEFAULTS = { weeks: 2, startDate: null };

// { weeks, startDate: YYYY-MM-DD|null (the date day 0 falls on), days: [{ day, name, parts: [{ id, name }],
// repeat: null|{ unit: 'day'|'week', interval }, skipped }] }. A skipped day has no name or parts.
// Days past the plan's length are kept (so making it longer again brings them back) but not listed.
export function getMealPlan() {
    const { weeks, startDate } = { ...MEAL_PLAN_DEFAULTS, ...(getSetting('mealPlan', {}) || {}) };
    const parts = new Map();
    for (const r of _planDayParts.all()) {
        if (!parts.has(r.day)) parts.set(r.day, []);
        parts.get(r.day).push(partOut(r));
    }
    const days = _planDays.all()
        .filter(r => r.day < weeks * 7 && (r.skipped || parts.has(r.day)))
        .map(r => r.skipped ? { day: r.day, name: '', parts: [], repeat: null, skipped: true } : {
            day: r.day, name: r.title, parts: parts.get(r.day),
            repeat: r.repeat_unit ? { unit: r.repeat_unit, interval: r.repeat_interval || 1 } : null, skipped: false
        });
    return { weeks, startDate, days };
}

export function setMealPlanSettings({ weeks, startDate }) {
    setSetting('mealPlan', { weeks, startDate });
}

// parts: [{ id, amount, unit, times }] in order, as for a meal; none clears the day, unless it's skipped (left empty in a repeat)
export function saveMealPlanDay(day, { name, parts, repeat = null, skipped = false }) {
    runInTransaction(() => {
        _clearPlanParts.run(day);
        if (!parts.length && !skipped) { _deletePlanDay.run(day); return; }
        _upsertPlanDay.run(day, skipped ? '' : name, repeat ? repeat.unit : null, repeat ? repeat.interval : 1, skipped ? 1 : 0, Date.now());
        if (!skipped) parts.forEach((part, i) => _insertPlanPart.run(day, i, part.id, part.amount || '', part.unit || '', part.times || 1));
    });
}

export function deleteCalendarEntry(id) {
    return Number(_deleteEntry.run(id).changes) > 0;
}

// True when a repeating entry falls on date (ignoring any dates it already skips)
export function calendarEntryOccursOn(entry, date) {
    return occurrenceDates(entry, date, daysToYmd(ymdToDays(date) + 1)).length > 0;
}

// Leave one occurrence of a repeating entry out; with `replacement`, an entry of its own takes its place
export function skipCalendarEntryOccurrence(id, date, replacement = null) {
    runInTransaction(() => {
        _insertEntrySkip.run(id, date);
        if (replacement) writeCalendarEntry(replacement);
    });
    return replacement ? getCalendarEntry(replacement.id) : null;
}

export function getAllCalendarEntryTags() {
    return _allEntryTags.all().map(r => r.tag);
}

// --- Games tab ---
const _gamePlayers = db.prepare('SELECT id, name FROM game_players ORDER BY name COLLATE NOCASE');
const _gamePlayer = db.prepare('SELECT id, name FROM game_players WHERE id = ?');
const _gamePlayerByName = db.prepare('SELECT id FROM game_players WHERE name = ?');
const _addGamePlayer = db.prepare('INSERT INTO game_players (id, name, created_at) VALUES (?, ?, ?)');
const _deleteGamePlayer = db.prepare('DELETE FROM game_players WHERE id = ?');
const _wordGame = db.prepare('SELECT guesses, status FROM word_games WHERE user_id = ? AND day = ?');
const _saveWordGame = db.prepare(`
    INSERT INTO word_games (user_id, day, guesses, status, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, day) DO UPDATE SET guesses = excluded.guesses, status = excluded.status, updated_at = excluded.updated_at`);
const _wordGamesFinished = db.prepare(`SELECT day, guesses, status FROM word_games WHERE user_id = ? AND status != 'playing' ORDER BY day`);

export function listGamePlayers() {
    return _gamePlayers.all().map(r => ({ ...r }));
}

export function getGamePlayer(id) {
    const row = _gamePlayer.get(id);
    return row ? { ...row } : null;
}

export function findGamePlayerByName(name) {
    return _gamePlayerByName.get(name)?.id || null;
}

export function addGamePlayer(id, name) {
    _addGamePlayer.run(id, name, Date.now());
    return { id, name };
}

// Their games go too
export function deleteGamePlayer(id) {
    return Number(_deleteGamePlayer.run(id).changes) > 0;
}

export function getWordGame(userId, day) {
    const row = _wordGame.get(userId, day);
    return row ? { guesses: JSON.parse(row.guesses), status: row.status } : { guesses: [], status: 'playing' };
}

export function saveWordGame(userId, day, guesses, status) {
    _saveWordGame.run(userId, day, JSON.stringify(guesses), status, Date.now());
}

// ─── Passwords (Passwords tab) ────────────────────────────────────────────────
// The password column holds them encrypted (lib/secret-box.js); the server locks and unlocks them.
// Not in RESTORE_GROUPS: their key stays on this server, so they'd be no use restored elsewhere.

db.exec(`
    CREATE TABLE IF NOT EXISTS passwords (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        username   TEXT NOT NULL DEFAULT '',
        password   TEXT NOT NULL DEFAULT '',
        url        TEXT NOT NULL DEFAULT '',
        notes      TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
`);

const _passwords = db.prepare('SELECT id, name, username, password, url, notes, updated_at FROM passwords ORDER BY name COLLATE NOCASE, id');
const _password = db.prepare('SELECT id, name, username, password, url, notes, updated_at FROM passwords WHERE id = ?');
const _addPassword = db.prepare('INSERT INTO passwords (name, username, password, url, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const _updatePassword = db.prepare('UPDATE passwords SET name = ?, username = ?, password = ?, url = ?, notes = ?, updated_at = ? WHERE id = ?');
const _deletePassword = db.prepare('DELETE FROM passwords WHERE id = ?');

export function listPasswords() {
    return _passwords.all().map(r => ({ ...r }));
}

export function getPassword(id) {
    const row = _password.get(id);
    return row ? { ...row } : null;
}

// Adds an entry ({ name, username, password, url, notes }, password already encrypted) or, with
// an id, replaces that one. Returns the id, or null when there's no entry with that id.
export function savePassword(entry, id = null) {
    const now = Date.now();
    const values = [entry.name, entry.username, entry.password, entry.url, entry.notes];
    if (id === null) return Number(_addPassword.run(...values, now, now).lastInsertRowid);
    return Number(_updatePassword.run(...values, now, id).changes) > 0 ? id : null;
}

export function deletePassword(id) {
    return Number(_deletePassword.run(id).changes) > 0;
}

// Played, won, guess distribution, and streaks of wins on consecutive days. The current
// streak still stands if the last win was today or yesterday (today's game may not be done yet).
export function getWordGameStats(userId, today) {
    const games = _wordGamesFinished.all(userId);
    const dist = Array(6).fill(0);
    let won = 0, best = 0, run = 0, lastWonDay = null;
    for (const g of games) {
        if (g.status === 'won') {
            won++;
            dist[Math.min(JSON.parse(g.guesses).length, 6) - 1]++;
            run = lastWonDay === g.day - 1 ? run + 1 : 1;
            lastWonDay = g.day;
        } else {
            run = 0;
            lastWonDay = null;
        }
        best = Math.max(best, run);
    }
    const streak = lastWonDay !== null && lastWonDay >= today - 1 ? run : 0;
    return { played: games.length, won, streak, best, dist };
}

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

// ─── Backup snapshot ──────────────────────────────────────────────────────────

// What a restore can bring back from a snapshot, by group. Settings that belong with a group go
// with it; 'settings' is every other one. This install's own devices list, library index, name,
// network id and S3 connection are never restored.
export const RESTORE_GROUPS = {
    meals: {
        tables: ['calendar_entries', 'calendar_entry_parts', 'calendar_entry_family', 'calendar_entry_skips', 'calendar_entry_tags',
            'ingredients', 'item_parts', 'meal_plan_days', 'meal_plan_day_parts',
            'shopping_products', 'shopping_product_picks', 'game_players', 'word_games'],
        settings: ['mealPlan', 'shoppingLists', 'calendars', 'calendarTagColors', 'calendarEntriesColor'],
    },
    tags: { tables: ['file_tags', 'photo_rotations', 'deleted_photos', 'face_people', 'face_samples'] },
    settings: { tables: [], otherSettings: true },
    history: { tables: ['play_history'] },
    lookups: { tables: ['album_art', 'lyrics_cache', 'youtube_artist_channel', 'youtube_candidates_cache', 'youtube_channel_videos', 'youtube_video_cache'] },
};
const KEPT_SETTINGS = ['dlnaUdn', 'deviceName', 's3'];
const GROUPED_SETTINGS = Object.values(RESTORE_GROUPS).flatMap(g => g.settings || []);

// A copy of the database in file, without what's only of use on this machine (and rebuilt anyway)
export function snapshotDatabase(file) {
    fs.rmSync(file, { force: true });
    db.prepare('VACUUM INTO ?').run(file);
    const snap = new DatabaseSync(file);
    try {
        snap.exec('DELETE FROM devices; DELETE FROM library_index; DELETE FROM library_index_meta; DELETE FROM face_scans; DELETE FROM photo_hashes; VACUUM');
    } finally {
        snap.close();
    }
}

// Replaces the chosen groups (keys of RESTORE_GROUPS) with what's in a snapshot, taking the
// columns both have, so a snapshot from an older or newer version still restores. Returns the
// rows restored per table, and the name of the server the snapshot came from.
export function restoreFromSnapshot(file, groups) {
    const chosen = groups.map(g => RESTORE_GROUPS[g]).filter(Boolean);
    const counts = {};
    let deviceName = '';
    db.exec('PRAGMA foreign_keys = OFF'); // the tables go back one at a time (and can't be changed inside a transaction)
    try {
        db.prepare('ATTACH DATABASE ? AS backup').run(file);
        try {
            const theirTables = new Set(db.prepare("SELECT name FROM backup.sqlite_master WHERE type = 'table'").all().map(r => r.name));
            if (theirTables.has('settings')) {
                const row = db.prepare("SELECT value FROM backup.settings WHERE key = 'deviceName'").get();
                try { deviceName = row ? JSON.parse(row.value) || '' : ''; } catch { deviceName = row.value || ''; }
            }
            runInTransaction(() => {
                for (const table of chosen.flatMap(g => g.tables)) {
                    if (!theirTables.has(table)) continue;
                    const theirs = new Set(db.prepare(`PRAGMA backup.table_info(${table})`).all().map(c => c.name));
                    const cols = db.prepare(`PRAGMA main.table_info(${table})`).all().map(c => c.name).filter(c => theirs.has(c))
                        .map(c => `"${c}"`).join(', ');
                    db.exec(`DELETE FROM main.${table}`);
                    counts[table] = Number(db.prepare(`INSERT INTO main.${table} (${cols}) SELECT ${cols} FROM backup.${table}`).run().changes);
                }
                if (!theirTables.has('settings')) return;
                const all = db.prepare('SELECT key FROM main.settings UNION SELECT key FROM backup.settings').all().map(r => r.key);
                const keys = all.filter(k => !KEPT_SETTINGS.includes(k) && chosen.some(g =>
                    (g.settings || []).includes(k) || (g.otherSettings && !GROUPED_SETTINGS.includes(k))));
                const del = db.prepare('DELETE FROM main.settings WHERE key = ?');
                const copy = db.prepare('INSERT INTO main.settings (key, value) SELECT key, value FROM backup.settings WHERE key = ?');
                for (const key of keys) {
                    del.run(key);
                    copy.run(key);
                }
                if (keys.length) counts.settings = keys.length;
            });
        } finally {
            db.exec('DETACH DATABASE backup');
        }
    } finally {
        db.exec('PRAGMA foreign_keys = ON');
    }
    return { counts, deviceName };
}

export default db;
