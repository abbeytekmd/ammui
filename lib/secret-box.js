// Encrypts the Passwords tab's passwords before they go in the database, so the database (and
// the copies of it sent to S3 with each backup) never holds them readable. The key is a file of
// its own beside the database, made the first time it's needed. It isn't backed up: without it,
// a copy of the database can't be read, which is the point.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const PREFIX = 'v1:';
let key = null;
let keyPath = null;

// Where the key lives (the app's data folder); call before anything else
export function useSecretKeyIn(dir) {
    keyPath = path.join(dir, 'passwords.key');
    key = null;
}

function getKey() {
    if (key) return key;
    if (!keyPath) throw new Error('No place for the passwords key has been set');
    if (fs.existsSync(keyPath)) {
        key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
        if (key.length !== 32) throw new Error(`${keyPath} isn't a valid key`);
    } else {
        key = crypto.randomBytes(32);
        fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
        console.log(`[PASSWORDS] Made a new key for stored passwords: ${keyPath}`);
    }
    return key;
}

// AES-256-GCM: "v1:" then the nonce, tag and ciphertext, in base64
export function encryptSecret(text) {
    if (!text) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

// The text again; throws if it was locked with another key (such as one from another server)
export function decryptSecret(stored) {
    if (!stored) return '';
    if (!stored.startsWith(PREFIX)) return stored;
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
