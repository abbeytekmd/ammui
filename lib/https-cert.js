// Certificates for the HTTPS listener. Browsers only allow the microphone (voice commands) and
// some other features on secure pages, and there is no public certificate for a LAN address,
// so the app acts as its own little certificate authority:
//
//   ca.crt / ca.key          kept for 10 years, and named after the server it was made for ("AMMUI
//                            Local CA (Kitchen)"; this machine's name if it wasn't named yet).
//                            Installing ca.crt as a trusted root on a phone or PC removes the
//                            browser warning for good. It's kept when the server is named or
//                            renamed, so devices that trust it go on doing so.
//   server.crt / server.key  signed by that CA for localhost, this machine's name and every LAN
//                            address. Re-issued on startup when an address changes or it is
//                            close to expiring, which needs no action on devices that trust the CA.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import forge from 'node-forge';
import { localNameFor } from './local-name.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CA_DAYS = 3650;
const SERVER_DAYS = 397;   // Apple and Chrome reject server certificates valid for longer than this
const RENEW_DAYS = 30;

function newKeyPair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    return { privateKey: forge.pki.privateKeyFromPem(privateKey), publicKey: forge.pki.publicKeyFromPem(publicKey) };
}

function newCertificate(publicKey, days) {
    const cert = forge.pki.createCertificate();
    cert.publicKey = publicKey;
    cert.serialNumber = '01' + crypto.randomBytes(15).toString('hex'); // positive, unique per certificate
    cert.validity.notBefore = new Date(Date.now() - DAY_MS);           // tolerate clocks that are a little behind
    cert.validity.notAfter = new Date(Date.now() + days * DAY_MS);
    return cert;
}

// The names a browser might use to reach this machine, called serverName in Settings: its own
// name, and the server's .local name (see local-name.js).
export function localHostNames(serverName) {
    const dns = new Set(['localhost']);
    const host = os.hostname();
    if (host) {
        dns.add(host.toLowerCase());
        dns.add(`${host.toLowerCase()}.local`);
    }
    const local = localNameFor(serverName);
    if (local) dns.add(local);
    const ips = new Set(['127.0.0.1']);
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family === 'IPv4' || a.family === 4) ips.add(a.address);
        }
    }
    return { dns: [...dns].sort(), ips: [...ips].sort() };
}

// The CA's name for a server called serverName (this machine's name before the server is named)
const caName = serverName => `AMMUI Local CA (${serverName || os.hostname()})`;

function loadOrCreateCa(dir, serverName) {
    const keyPath = path.join(dir, 'ca.key');
    const certPath = path.join(dir, 'ca.crt');
    const name = caName(serverName);
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        const cert = forge.pki.certificateFromPem(fs.readFileSync(certPath, 'utf8'));
        // Kept until it's close to expiring, whatever the server is called now: a new one would
        // undo every device's trust in it (including the installer's, when a new server is named)
        if (cert.validity.notAfter.getTime() - Date.now() > RENEW_DAYS * DAY_MS) {
            return { key: forge.pki.privateKeyFromPem(fs.readFileSync(keyPath, 'utf8')), cert, created: false };
        }
    }

    const keys = newKeyPair();
    const cert = newCertificate(keys.publicKey, CA_DAYS);
    const attrs = [{ name: 'commonName', value: name }, { name: 'organizationName', value: 'AMMUI' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
    fs.writeFileSync(certPath, forge.pki.certificateToPem(cert));
    console.log(`[HTTPS] Created certificate authority "${name}".`);
    return { key: keys.privateKey, cert, created: true };
}

// Returns { key, cert } PEM strings for https.createServer, creating or renewing files in `dir`
// for a server called serverName.
export function ensureHttpsCertificate(dir, serverName) {
    fs.mkdirSync(dir, { recursive: true });
    const ca = loadOrCreateCa(dir, serverName);
    const names = localHostNames(serverName);
    const keyPath = path.join(dir, 'server.key');
    const certPath = path.join(dir, 'server.crt');

    if (!ca.created && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        const pem = fs.readFileSync(certPath, 'utf8');
        const cert = forge.pki.certificateFromPem(pem);
        const alt = cert.getExtension('subjectAltName')?.altNames || [];
        const covered = [...names.dns.map(v => ({ type: 2, v })), ...names.ips.map(v => ({ type: 7, v }))]
            .every(n => alt.some(a => a.type === n.type && (a.type === 7 ? a.ip : a.value) === n.v));
        const fresh = cert.validity.notAfter.getTime() - Date.now() > RENEW_DAYS * DAY_MS;
        if (covered && fresh && cert.issuer.hash === ca.cert.subject.hash) {
            return { key: fs.readFileSync(keyPath, 'utf8'), cert: pem + forge.pki.certificateToPem(ca.cert) };
        }
    }

    const keys = newKeyPair();
    const cert = newCertificate(keys.publicKey, SERVER_DAYS);
    cert.setSubject([{ name: 'commonName', value: os.hostname() || 'localhost' }, { name: 'organizationName', value: 'AMMUI' }]);
    cert.setIssuer(ca.cert.subject.attributes);
    cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [...names.dns.map(value => ({ type: 2, value })), ...names.ips.map(ip => ({ type: 7, ip }))] },
        { name: 'subjectKeyIdentifier' },
        { name: 'authorityKeyIdentifier', keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes() },
    ]);
    cert.sign(ca.key, forge.md.sha256.create());

    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const certPem = forge.pki.certificateToPem(cert);
    fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
    fs.writeFileSync(certPath, certPem);
    console.log(`[HTTPS] Issued server certificate for ${[...names.dns, ...names.ips].join(', ')}.`);
    return { key: keyPem, cert: certPem + forge.pki.certificateToPem(ca.cert) };
}

export function caCertificatePath(dir) {
    return path.join(dir, 'ca.crt');
}
