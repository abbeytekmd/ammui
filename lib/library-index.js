// Keeps a searchable copy of each media server's library in SQLite (see library_index in db.js),
// so "Find" is a database query instead of a crawl of every folder on the server.
//
// An index is (re)built:
//   - the first time a server is searched (or, for the local server, shortly after startup)
//   - once a day, by the scheduler below
//   - a short while after the user imports/deletes/moves files through the UI (markDirty)
//   - on demand from the Database Stats dialog
import MediaServer from './media-server.js';
import { replaceLibraryIndex, getLibraryIndexMeta, getAllLibraryIndexMeta } from './db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DIRTY_DELAY_MS = 20 * 1000;      // let a burst of uploads/deletes settle before recrawling
const SCHEDULER_TICK_MS = 60 * 60 * 1000;

const building = new Map();            // udn -> Promise of the build in progress
const dirtyTimers = new Map();         // udn -> pending debounce timer

export function isBuilding(udn) {
    return building.has(udn);
}

// Crawls the whole server and swaps the result into the database. Concurrent calls for the
// same server share one crawl. A crawl that hit errors never replaces an existing index, so a
// server that is half-offline can't leave the index emptier than it was.
export function buildIndex(device, reason = 'manual') {
    const udn = device.udn;
    if (building.has(udn)) return building.get(udn);

    const job = (async () => {
        const started = Date.now();
        console.log(`[INDEX] Building index for "${device.friendlyName}" (${reason})...`);
        try {
            const server = new MediaServer(device);
            const items = await server.browseRecursive('0', 'Home');
            const hadIndex = !!getLibraryIndexMeta(udn);
            if (hadIndex && server.lastCrawlErrors > 0) {
                console.warn(`[INDEX] "${device.friendlyName}": ${server.lastCrawlErrors} folder(s) failed to browse - keeping the existing index.`);
                return null;
            }
            replaceLibraryIndex(udn, device.friendlyName, items, Date.now() - started);
            console.log(`[INDEX] "${device.friendlyName}": ${items.length} items indexed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
            return items.length;
        } catch (err) {
            console.error(`[INDEX] Build failed for "${device.friendlyName}":`, err.message);
            throw err;
        } finally {
            building.delete(udn);
        }
    })();

    building.set(udn, job);
    return job;
}

// The library changed (upload, delete, move...): rebuild after things go quiet.
export function markDirty(udn, getDevice) {
    clearTimeout(dirtyTimers.get(udn));
    dirtyTimers.set(udn, setTimeout(() => {
        dirtyTimers.delete(udn);
        const device = getDevice(udn);
        if (device) buildIndex(device, 'library changed').catch(() => { });
    }, DIRTY_DELAY_MS));
}

// Rebuilds any index older than a day. `getDevice(udn)` returns the live device or undefined
// (servers that are offline are simply skipped until the next tick).
export function startIndexScheduler(getDevice) {
    const tick = () => {
        for (const meta of getAllLibraryIndexMeta()) {
            if (Date.now() - meta.built_at < DAY_MS) continue;
            const device = getDevice(meta.server_udn);
            if (device) buildIndex(device, 'daily refresh').catch(() => { });
        }
    };
    setInterval(tick, SCHEDULER_TICK_MS).unref?.();
    setTimeout(tick, 60 * 1000).unref?.();
}
