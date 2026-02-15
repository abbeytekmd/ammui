import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logPlay } from './lib/stats-db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATS_FILE = path.join(__dirname, 'stats.json');
const HISTORY_FILE = path.join(__dirname, 'play_history.json');

async function migrate() {
    if (!fs.existsSync(STATS_FILE)) {
        console.log('No stats.json found, skipping migration.');
        return;
    }

    try {
        // Clear history before migration
        fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));

        const data = fs.readFileSync(STATS_FILE, 'utf8');
        const playStats = JSON.parse(data);

        console.log('Starting total migration from stats.json to play_history.json...');

        let trackPlayCount = 0;
        let albumPlayCount = 0;

        // Migrating standalone album stats (since original stats.json tracked them separately)
        if (playStats.albums) {
            console.log('Migrating album stats...');
            for (const [key, details] of Object.entries(playStats.albums)) {
                for (let i = 0; i < details.count; i++) {
                    logPlay({
                        title: 'Migrated Album Play',
                        artist: details.artist || 'Unknown Artist',
                        album: details.album || '',
                        serverName: 'Migration',
                        playerName: 'Migration'
                    });
                    albumPlayCount++;
                }
            }
        }

        // Migrating track stats (for track history)
        if (playStats.tracks) {
            console.log('Migrating track stats...');
            for (const [key, details] of Object.entries(playStats.tracks)) {
                for (let i = 0; i < details.count; i++) {
                    logPlay({
                        title: details.title,
                        artist: details.artist || 'Unknown Artist',
                        album: '', // Track stats in original file didn't link to albums
                        serverName: 'Migration',
                        playerName: 'Migration'
                    });
                    trackPlayCount++;
                }
            }
        }

        console.log(`Successfully migrated ${trackPlayCount} track plays and ${albumPlayCount} album plays.`);
    } catch (err) {
        console.error('Migration failed:', err);
    }
}

migrate();
