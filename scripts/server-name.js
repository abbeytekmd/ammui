// The server's name, for the installers: prints it, or nothing when the server hasn't been named
// yet (it waits for that before starting its services, so the installer opens the page to do it).
//   node scripts/server-name.js
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ammui.db');
let name = '';
if (fs.existsSync(file)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'deviceName'").get();
        try { name = row ? JSON.parse(row.value) : ''; } catch (e) { name = row.value; }
    } catch (e) { /* no settings yet */ } finally {
        db.close();
    }
}
process.stdout.write(typeof name === 'string' ? name : '');
