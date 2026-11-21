// The browser half of a Linux install where the server runs as a system service, started at boot.
// The service has no desktop to open a browser on, so this runs when the user logs in instead.
//
//   node scripts/startup-browser.js            waits for the server, then runs the Settings > Startup
//                                              command on this desktop (or, on a server not yet named,
//                                              opens the page to name it)
//   node scripts/startup-browser.js --default  sets Settings > Startup to the browser found here
//                                              (Firefox first) when it is still unset, and prints
//                                              the browser's name. Run while the server is stopped.
//   node scripts/startup-browser.js --show     prints the Settings > Startup command, if any
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(root, 'ammui.db');

function readSettings(db, keys) {
    const get = db.prepare('SELECT value FROM settings WHERE key = ?');
    const out = {};
    for (const key of keys) {
        const row = get.get(key);
        if (!row) continue;
        try { out[key] = JSON.parse(row.value); } catch { out[key] = row.value; }
    }
    return out;
}

// As startupCommand in server.js, for Linux
const BROWSERS = [
    { id: 'firefox', exes: ['firefox'] },
    { id: 'chrome', exes: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'] },
    { id: 'edge', exes: ['microsoft-edge', 'microsoft-edge-stable'] },
];

function onPath(name) {
    return (process.env.PATH || '').split(':').some(dir => {
        try { fs.accessSync(path.join(dir || '.', name), fs.constants.X_OK); return true; } catch { return false; }
    });
}

function setDefault() {
    const db = new DatabaseSync(dbFile);
    try {
        db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
        const { startup, httpPort } = readSettings(db, ['startup', 'httpPort']);
        if (startup?.command) return; // already chosen in Settings
        for (const { id, exes } of BROWSERS) {
            const exe = exes.find(onPath);
            if (!exe) continue;
            const command = `${exe} --new-window http://localhost:${Number(httpPort) || 80}`;
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
                .run('startup', JSON.stringify({ browser: id, kiosk: false, command }));
            process.stdout.write(exe);
            return;
        }
    } finally {
        db.close();
    }
}

// Resolves once something accepts connections on the port, or false after `ms`
function waitForPort(port, ms) {
    const until = Date.now() + ms;
    return new Promise(resolve => {
        const attempt = () => {
            const sock = net.connect(port, '127.0.0.1');
            sock.once('connect', () => { sock.destroy(); resolve(true); });
            sock.once('error', () => {
                sock.destroy();
                if (Date.now() > until) resolve(false);
                else setTimeout(attempt, 2000);
            });
        };
        attempt();
    });
}

async function openOnLogin() {
    if (!fs.existsSync(dbFile)) return;
    const db = new DatabaseSync(dbFile, { readOnly: true });
    let settings;
    try { settings = readSettings(db, ['startup', 'httpPort', 'deviceName']); } finally { db.close(); }
    const port = Number(settings.httpPort) || 80;
    const command = settings.startup?.command
        || (!settings.deviceName ? `xdg-open http://localhost:${port}/` : '');
    if (!command) return;
    // At boot the service may still be starting as the desktop appears
    if (!await waitForPort(port, 3 * 60 * 1000)) {
        console.error(`AMMUI is not answering on port ${port}, so the browser was not opened.`);
        process.exit(1);
    }
    console.log(`Running: ${command}`);
    spawn(command, { shell: true, detached: true, stdio: 'ignore' }).unref();
}

function show() {
    if (!fs.existsSync(dbFile)) return;
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try { process.stdout.write(readSettings(db, ['startup']).startup?.command || ''); }
    catch { /* no settings yet */ } finally { db.close(); }
}

if (process.argv[2] === '--default') setDefault();
else if (process.argv[2] === '--show') show();
else await openOnLogin();
