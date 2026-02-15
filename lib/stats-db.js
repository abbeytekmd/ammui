import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'play_history.json');

// Initialize the file if it doesn't exist
if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify([], null, 2));
}

function readEntries() {
    try {
        const data = fs.readFileSync(dbPath, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        console.error('Failed to read play history:', e);
        return [];
    }
}

function writeEntries(entries) {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(entries, null, 2));
    } catch (e) {
        console.error('Failed to write play history:', e);
    }
}

export function logPlay(details) {
    const entries = readEntries();
    const entry = {
        id: Date.now() + Math.random().toString(36).substr(2, 5),
        timestamp: new Date().toISOString(),
        ...details
    };
    entries.push(entry);
    writeEntries(entries);
    console.log(`[STATS] Logged play: ${details.title}`);
}

export function getTopTracks(limit = 20) {
    const entries = readEntries();
    const counts = {};

    entries.forEach(entry => {
        if (entry.title === 'Migrated Album Play') return;
        const key = `${entry.title} - ${entry.artist || 'Unknown Artist'}`.trim();
        if (!counts[key]) {
            counts[key] = { title: entry.title, artist: entry.artist, count: 0 };
        }
        counts[key].count++;
    });

    return Object.values(counts)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

export function getTopAlbums(limit = 20) {
    const entries = readEntries();
    const counts = {};

    entries.forEach(entry => {
        if (!entry.album) return;
        const key = `${entry.album} - ${entry.artist || 'Unknown Artist'}`.trim();
        if (!counts[key]) {
            counts[key] = { album: entry.album, artist: entry.artist, count: 0 };
        }
        counts[key].count++;
    });

    return Object.values(counts)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

export default { logPlay, getTopTracks, getTopAlbums };
