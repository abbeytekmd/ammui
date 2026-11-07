// The HTTP and HTTPS ports AMMUI listens on, for the installers: reads the saved settings, or saves them.
//   node scripts/ports.js            prints "HTTP HTTPS", e.g. "80 443" (the defaults when none are saved)
//   node scripts/ports.js 80 443     saves them
// Run while the server is stopped. Settings > Secure Access changes them from the app.
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULTS = { httpPort: 80, httpsPort: 443 }; // as in server.js
const db = new DatabaseSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ammui.db'));
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');

const wanted = process.argv.slice(2);
if (!wanted.length) {
    const get = db.prepare('SELECT value FROM settings WHERE key = ?');
    console.log(Object.keys(DEFAULTS).map(key => Number(get.get(key)?.value) || DEFAULTS[key]).join(' '));
} else {
    const ports = wanted.map(Number);
    if (ports.length !== 2 || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535) || ports[0] === ports[1]) {
        console.error(`Usage: node scripts/ports.js HTTP-PORT HTTPS-PORT (got ${wanted.join(' ')})`);
        process.exit(1);
    }
    const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    set.run('httpPort', JSON.stringify(ports[0]));
    set.run('httpsPort', JSON.stringify(ports[1]));
}
db.close();
