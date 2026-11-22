// Peer link: one AMMUI server talking to another, on the same network or over the internet.
//
// This file is the link itself: the listener, the login, sessions and the connections to other
// servers. What the link is used for is up to services, each in its own module (see
// lib/peer-services/), so new things can be added without touching any of this:
//
//   - The listening side registers a service with addService({ name, version, router }). Its
//     routes are served at /peer/v1/<name>/..., only to a logged-in session (req.peerSession).
//   - Both hello and the login reply list the services this server offers ({ media: 1, ... }).
//     The connecting side keeps that list with the connection, so it knows what the other end
//     can do (and which version) without asking again.
//   - The connecting side reaches a service through service(id, name), which gives getJson(),
//     postJson() and open() for its routes, logging in again when the session has lapsed.
//
// The listener is a separate HTTPS server on its own port (not the app's own ports), because the
// app itself has no login: forwarding the peer port on a router exposes only what's here - the
// services, behind a password - and switching it off closes the port.
//
// Security:
//   - TLS with a self-signed certificate of its own (peer.crt/peer.key, kept for 10 years so its
//     fingerprint doesn't change when the server's address or name does). The connecting side
//     pins the fingerprint the first time it connects and refuses a different one afterwards.
//   - The password never crosses the wire. Both ends hold K = scrypt(password, salt) and prove
//     they know it with an HMAC over fresh nonces from each side and the certificate fingerprint
//     the client actually saw. A man in the middle presents a different certificate, so a proof
//     relayed through it doesn't match. The client proves first, so a stranger who connects
//     learns nothing but the salt. Failed attempts are limited per address and overall.
//   - A successful login gets a random session token (an hour), which the client renews itself.
//   - Neither end stores the password, only K, encrypted with the server's own key (secret-box.js).
//   - Each service decides what it gives out (the media service: only what's been shared).
//
// Links: a connection is one link, shown at both ends. The connecting side makes a link id when it
// connects (newLink) and sends it with every login; the listening side saves a record of it. Either
// end can remove it, and the other end then removes it too:
//   - Removed on the connecting side: it says bye with the link id, and the listening side drops
//     its record. If the other server can't be reached, the bye is retried until it can.
//   - Removed on the listening side: its record goes, and so do its sessions. The next login with
//     that link id (on the next use, or the regular check) is refused with LINK_REMOVED - after
//     the password proof, and with the server's own proof so it can't be faked - and the
//     connecting side drops the connection. Making it again needs the password.
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import tls from 'tls';
import express from 'express';
import forge from 'node-forge';

export const PEER_PROTOCOL = 1;
export const DEFAULT_PEER_PORT = 7443;
export const MIN_PEER_PASSWORD = 8;

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_MS = 60 * 60 * 1000;
const CHALLENGE_MS = 60 * 1000;
const MAX_CHALLENGES = 500;
const FAIL_LIMIT = 5;                      // per address...
const FAIL_WINDOW_MS = 15 * 60 * 1000;     // ...in this long, then blocked for as long again
const GLOBAL_FAIL_LIMIT = 50;              // from everywhere in an hour, then all logins wait
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_NAMES = new Set(['hello', 'auth', 'bye', 'ping']);
const LINK_ID = /^[A-Za-z0-9-]{8,64}$/;
const GONE_KEEP_MS = 30 * 24 * 3600 * 1000;   // how long to keep trying to tell a server its link was removed
const DROPPED_SHOW_MS = 24 * 3600 * 1000;     // how long "X removed this connection" is shown

export class PeerError extends Error {
    constructor(message, code = 'PEER_ERROR', status = 502, extra = {}) {
        super(message);
        this.code = code;
        this.status = status;
        Object.assign(this, extra);
    }
}

// --- Shared helpers -------------------------------------------------------------------------

export function derivePeerKey(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(String(password), Buffer.from(salt, 'base64'), 32, SCRYPT, (err, key) => err ? reject(err) : resolve(key));
    });
}

function proof(key, role, serverNonce, clientNonce, fingerprint) {
    return crypto.createHmac('sha256', key)
        .update(`ammui-peer-v${PEER_PROTOCOL}|${role}|${serverNonce}|${clientNonce}|${fingerprint}`)
        .digest('base64');
}

function sameText(a, b) {
    const x = Buffer.from(String(a ?? ''));
    const y = Buffer.from(String(b ?? ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// { name: version } from the other end, keeping only well-formed entries
function cleanServices(value) {
    const out = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, version] of Object.entries(value)) {
            if (SERVICE_NAME.test(name) && Number.isInteger(version) && version > 0) out[name] = version;
        }
    }
    return out;
}

const sameServices = (a, b) => JSON.stringify(cleanServices(a)) === JSON.stringify(cleanServices(b));

// --- The listener's certificate ------------------------------------------------------------

export function ensurePeerCertificate(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const keyPath = path.join(dir, 'peer.key');
    const certPath = path.join(dir, 'peer.crt');
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        const cert = fs.readFileSync(certPath, 'utf8');
        const x509 = new crypto.X509Certificate(cert);
        if (new Date(x509.validTo).getTime() - Date.now() > 30 * 24 * 3600 * 1000) {
            return { key: fs.readFileSync(keyPath, 'utf8'), cert, fingerprint: x509.fingerprint256 };
        }
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
    cert.serialNumber = '01' + crypto.randomBytes(15).toString('hex');
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 3650 * 24 * 3600 * 1000);
    const attrs = [{ name: 'commonName', value: 'AMMUI Peer Link' }, { name: 'organizationName', value: 'AMMUI' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
    ]);
    cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
    fs.writeFileSync(certPath, certPem);
    const fingerprint = new crypto.X509Certificate(certPem).fingerprint256;
    console.log(`[PEER] Made the peer link certificate (${fingerprint}).`);
    return { key: privateKey, cert: certPem, fingerprint };
}

// --- The listening side ---------------------------------------------------------------------

// getConfig() -> { enabled, port, salt, key: Buffer | null }
// linkStore = { load() -> [{ id, clientId, name, ip, createdAt, lastLogin }], save(list) }
//
// Emits 'change' when a link is made or removed.
export class PeerListener extends EventEmitter {
    constructor({ certDir, getConfig, getName, getServerId, linkStore }) {
        super();
        this.certDir = certDir;
        this.getConfig = getConfig;
        this.getName = getName;
        this.getServerId = getServerId || (() => null);
        this.linkStore = linkStore || { load: () => [], save: () => { } };
        this.linkSeen = new Map();     // link id -> last request (not saved: changes too often)
        this.server = null;
        this.listeningPort = null;
        this.error = null;
        this.fingerprint = null;
        this.services = new Map();     // name -> { name, version, router }
        this.sessions = new Map();     // token -> { name, ip, created, lastUsed }
        this.challenges = new Map();   // server nonce -> expires at
        this.failures = new Map();     // ip -> { count, first, blockedUntil }
        this.globalFailures = [];      // times of recent failures from anywhere
        this.app = this.buildApp();
    }

    // A service's routes, served at /peer/v1/<name>/... to logged-in sessions. `router` is an
    // express router (or any (req, res, next) handler); req.peerSession says who's asking.
    // Bump `version` when the service changes in a way the other end needs to know about.
    addService({ name, version = 1, router }) {
        if (!SERVICE_NAME.test(name) || RESERVED_NAMES.has(name)) throw new Error(`Bad peer service name: ${name}`);
        if (this.services.has(name)) throw new Error(`Peer service ${name} is already registered`);
        this.services.set(name, { name, version, router });
    }

    offered() {
        return Object.fromEntries([...this.services.values()].map(s => [s.name, s.version]));
    }

    status() {
        const cfg = this.getConfig();
        this.prune();
        return {
            enabled: !!cfg.enabled,
            port: cfg.port,
            hasPassword: !!cfg.key,
            running: !!this.server && this.listeningPort !== null,
            error: this.error,
            fingerprint: this.fingerprint || this.peekFingerprint(),
            services: this.offered(),
            links: this.links().map(l => ({
                id: l.id, name: l.name, ip: l.ip, since: l.createdAt,
                lastUsed: Math.max(l.lastLogin || 0, this.linkSeen.get(l.id) || 0) || null,
                active: [...this.sessions.values()].some(s => s.linkId === l.id),
            })),
            // Servers on an older version, which connect without a link
            sessions: [...this.sessions.values()].filter(s => !s.linkId)
                .map(s => ({ name: s.name, ip: s.ip, since: s.created, lastUsed: s.lastUsed })),
        };
    }

    links() {
        const list = this.linkStore.load();
        return Array.isArray(list) ? list : [];
    }

    // The ids of the servers connected to this one: from their links, and for an older version
    // without links, whatever its session was tagged with (session.serverId)
    serverIds() {
        this.prune();
        return [
            ...this.links().map(l => l.clientId),
            ...[...this.sessions.values()].filter(s => !s.linkId).map(s => s.serverId),
        ].filter(Boolean);
    }

    // Removes a link made to this server; that server finds out the next time it logs in
    removeLink(id) {
        const list = this.links();
        const link = list.find(l => l.id === id);
        if (!link) return false;
        this.linkStore.save(list.filter(l => l.id !== id));
        this.linkSeen.delete(id);
        for (const [t, s] of this.sessions) if (s.linkId === id) this.sessions.delete(t);
        this.emit('change');
        return link;
    }

    peekFingerprint() {
        try {
            const pem = fs.readFileSync(path.join(this.certDir, 'peer.crt'), 'utf8');
            return new crypto.X509Certificate(pem).fingerprint256;
        } catch (e) { return null; }
    }

    // Start, stop or move the listener to match the settings. Resolves once it's settled.
    async apply() {
        const cfg = this.getConfig();
        const want = cfg.enabled && cfg.key ? cfg.port : null;
        if (this.server && this.listeningPort === want) return;
        await this.stop();
        this.error = null;
        if (want === null) return;

        const { key, cert, fingerprint } = ensurePeerCertificate(this.certDir);
        this.fingerprint = fingerprint;
        const server = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, this.app);
        server.requestTimeout = 0;            // long downloads
        server.headersTimeout = 20 * 1000;
        server.keepAliveTimeout = 5 * 1000;
        this.server = server;
        await new Promise(resolve => {
            server.once('error', err => {
                this.error = err.code === 'EADDRINUSE' ? `Port ${want} is in use by another program`
                    : err.code === 'EACCES' ? `Not allowed to use port ${want}` : err.message;
                console.error(`[PEER] Could not listen on port ${want}: ${this.error}`);
                this.server = null;
                this.listeningPort = null;
                resolve();
            });
            server.listen(want, () => {
                this.listeningPort = want;
                console.log(`[PEER] Peer link listening on port ${want} (certificate ${fingerprint}).`);
                resolve();
            });
        });
    }

    async stop() {
        this.sessions.clear();
        this.challenges.clear();
        const server = this.server;
        this.server = null;
        this.listeningPort = null;
        if (!server) return;
        await new Promise(resolve => {
            server.close(() => resolve());
            server.closeAllConnections?.();
        });
        console.log('[PEER] Peer link stopped.');
    }

    // After a password change: everyone has to log in again
    endSessions() {
        this.sessions.clear();
        this.challenges.clear();
    }

    prune() {
        const now = Date.now();
        for (const [t, s] of this.sessions) if (now - s.created > SESSION_MS) this.sessions.delete(t);
        for (const [n, exp] of this.challenges) if (exp < now) this.challenges.delete(n);
        for (const [ip, f] of this.failures) if (now - f.first > FAIL_WINDOW_MS && f.blockedUntil < now) this.failures.delete(ip);
        this.globalFailures = this.globalFailures.filter(t => now - t < 60 * 60 * 1000);
    }

    blocked(ip) {
        const now = Date.now();
        if ((this.failures.get(ip)?.blockedUntil || 0) > now) return true;
        return this.globalFailures.length >= GLOBAL_FAIL_LIMIT;
    }

    recordFailure(ip) {
        const now = Date.now();
        let f = this.failures.get(ip);
        if (!f || now - f.first > FAIL_WINDOW_MS) f = { count: 0, first: now, blockedUntil: 0 };
        f.count++;
        if (f.count >= FAIL_LIMIT) {
            f.blockedUntil = now + FAIL_WINDOW_MS;
            console.warn(`[PEER] ${ip}: ${f.count} wrong passwords - blocked for ${FAIL_WINDOW_MS / 60000} minutes.`);
        }
        this.failures.set(ip, f);
        this.globalFailures.push(now);
        if (this.globalFailures.length === GLOBAL_FAIL_LIMIT) {
            console.warn(`[PEER] ${GLOBAL_FAIL_LIMIT} wrong passwords in the last hour - logins paused.`);
        }
    }

    buildApp() {
        const app = express();
        app.disable('x-powered-by');
        app.set('etag', false);
        const ipOf = req => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        const smallJson = express.json({ limit: '4kb' });

        app.post('/peer/v1/hello', smallJson, (req, res) => {
            this.prune();
            const cfg = this.getConfig();
            if (!cfg.key) return res.status(503).json({ error: 'No password is set on that server' });
            if (this.blocked(ipOf(req))) return res.status(429).json({ error: 'Too many wrong passwords. Try again later.' });
            if (this.challenges.size >= MAX_CHALLENGES) this.challenges.delete(this.challenges.keys().next().value);
            const nonce = randomToken(24);
            this.challenges.set(nonce, Date.now() + CHALLENGE_MS);
            res.json({ protocol: PEER_PROTOCOL, name: this.getName(), salt: cfg.salt, nonce, services: this.offered() });
        });

        app.post('/peer/v1/auth', smallJson, async (req, res) => {
            this.prune();
            const ip = ipOf(req);
            const cfg = this.getConfig();
            if (!cfg.key) return res.status(503).json({ error: 'No password is set on that server' });
            if (this.blocked(ip)) return res.status(429).json({ error: 'Too many wrong passwords. Try again later.' });
            const { nonce, clientNonce, proof: clientProof, clientName, linkId, newLink, clientId } = req.body || {};
            const valid = typeof nonce === 'string' && this.challenges.has(nonce)
                && typeof clientNonce === 'string' && clientNonce.length >= 16 && clientNonce.length <= 128;
            if (valid) this.challenges.delete(nonce);
            if (!valid || !sameText(clientProof, proof(cfg.key, 'client', nonce, clientNonce, this.fingerprint))) {
                this.recordFailure(ip);
                console.warn(`[PEER] Wrong password from ${ip}.`);
                await new Promise(r => setTimeout(r, 1000));
                return res.status(401).json({ error: 'Wrong password' });
            }
            this.failures.delete(ip);
            const serverProof = proof(cfg.key, 'server', nonce, clientNonce, this.fingerprint);
            const name = String(clientName || ip).replace(/[\x00-\x1f]/g, '').slice(0, 80);
            const link = typeof linkId === 'string' && LINK_ID.test(linkId) ? linkId : null;
            if (link) {
                const owner = typeof clientId === 'string' && LINK_ID.test(clientId) ? clientId : null;
                const list = this.links();
                const existing = list.find(l => l.id === link);
                const now = Date.now();
                if (newLink === true) {
                    // A new link from a server replaces any it had before
                    const kept = list.filter(l => l.id !== link && !(owner && l.clientId === owner));
                    this.linkStore.save([...kept, { id: link, clientId: owner, name, ip, createdAt: existing?.createdAt || now, lastLogin: now }]);
                    if (!existing) {
                        console.log(`[PEER] "${name}" (${ip}) made a link to this server.`);
                        this.emit('change');
                    }
                } else if (!existing) {
                    console.log(`[PEER] "${name}" (${ip}) tried a link that was removed here; it has to be made again.`);
                    return res.status(403).json({ error: 'This connection was removed on the other server', code: 'LINK_REMOVED', serverProof });
                } else {
                    const changed = existing.name !== name || existing.ip !== ip;
                    this.linkStore.save(list.map(l => l.id === link ? { ...l, name, ip, lastLogin: now, clientId: owner || l.clientId } : l));
                    if (changed) this.emit('change');
                }
            }
            const token = randomToken();
            this.sessions.set(token, { name, ip, linkId: link, created: Date.now(), lastUsed: Date.now() });
            console.log(`[PEER] "${name}" (${ip}) connected.`);
            res.json({
                token,
                expiresIn: SESSION_MS,
                name: this.getName(),
                services: this.offered(),
                links: true,   // knows about links (see above): an older version leaves this out
                serverId: this.getServerId() || undefined,
                serverProof,
            });
        });

        // Everything below needs a session
        app.use('/peer/v1', (req, res, next) => {
            this.prune();
            const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
            const session = m && this.sessions.get(m[1]);
            if (!session) return res.status(401).json({ error: 'Not logged in', code: 'NO_SESSION' });
            session.lastUsed = Date.now();
            if (session.linkId) this.linkSeen.set(session.linkId, session.lastUsed);
            req.peerSession = session;
            req.peerToken = m[1];
            next();
        });

        // Still connected? (the connecting side checks now and then, so a removed link is noticed)
        app.get('/peer/v1/ping', (req, res) => res.json({ ok: true }));

        // The connecting side removed the link (or, from an older version, just logs out)
        app.post('/peer/v1/bye', (req, res) => {
            this.sessions.delete(req.peerToken);
            const { linkId, name, ip } = req.peerSession;
            if (linkId && this.removeLink(linkId)) console.log(`[PEER] "${name}" (${ip}) removed its link to this server.`);
            res.json({ ok: true });
        });

        // The services, each under its own name
        app.use('/peer/v1/:service', (req, res, next) => {
            const service = this.services.get(req.params.service);
            if (!service) return res.status(404).json({ error: 'That server doesn\'t offer this', code: 'NO_SERVICE' });
            service.router(req, res, next);
        });

        app.use((req, res) => res.status(404).json({ error: 'Not found' }));
        // eslint-disable-next-line no-unused-vars
        app.use((err, req, res, next) => {
            const status = err.status || err.statusCode || 500;
            if (status >= 500) console.error('[PEER] Request failed:', err.message);
            if (res.headersSent) return res.destroy();
            res.status(status).json({ error: status >= 500 ? 'Server error' : err.message, code: err.code });
        });
        return app;
    }
}

// --- The connecting side --------------------------------------------------------------------

// "host", "host:port", "[v6]:port" or "https://host:port/..." -> { host, port }
export function parsePeerAddress(address, port) {
    let text = String(address || '').trim();
    if (!text) throw new PeerError('Enter the other server\'s address', 'BAD_ADDRESS', 400);
    if (!/^[a-z]+:\/\//i.test(text)) text = 'https://' + text;
    let u;
    try { u = new URL(text); } catch (e) { throw new PeerError('That address isn\'t valid', 'BAD_ADDRESS', 400); }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const p = Number(port) || Number(u.port) || DEFAULT_PEER_PORT;
    if (!host || !Number.isInteger(p) || p < 1 || p > 65535) throw new PeerError('That address isn\'t valid', 'BAD_ADDRESS', 400);
    return { host, port: p };
}

// One HTTP request over TLS to a peer. With `fingerprint`, the connection is refused unless the
// certificate matches it, before anything is sent. Resolves { status, headers, res, fingerprint };
// `res` is the response stream (read it or call res.resume()).
function rawRequest({ host, port, fingerprint, method = 'GET', urlPath, headers = {}, body, timeout = 15000, signal }) {
    return new Promise((resolve, reject) => {
        let seen = null;
        const createConnection = (opts, done) => {
            const sock = tls.connect({
                host, port,
                servername: net.isIP(host) ? undefined : host,
                rejectUnauthorized: false, // the certificate is self-signed: checked by fingerprint below
                minVersion: 'TLSv1.2',
            });
            let settled = false;
            const fail = err => {
                if (settled) return;
                settled = true;
                sock.destroy();
                done(err);
            };
            sock.setTimeout(timeout, () => fail(new PeerError(`No answer from ${host}:${port}`, 'UNREACHABLE', 504)));
            sock.once('error', err => fail(new PeerError(`Couldn't connect to ${host}:${port}: ${err.code === 'ECONNREFUSED' ? 'nothing is listening there (is the peer link switched on?)' : err.message}`, 'UNREACHABLE', 502)));
            sock.once('secureConnect', () => {
                seen = sock.getPeerCertificate()?.fingerprint256 || null;
                if (!seen) return fail(new PeerError('The other server sent no certificate', 'UNREACHABLE', 502));
                if (fingerprint && seen !== fingerprint) {
                    return fail(new PeerError(`The certificate of ${host}:${port} has changed`, 'FINGERPRINT_CHANGED', 409, { fingerprint: seen }));
                }
                settled = true;
                sock.removeAllListeners('error');
                done(null, sock);
            });
        };
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({
            host, port, method, path: urlPath, createConnection,
            headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
        }, res => resolve({ status: res.statusCode, headers: res.headers, res, fingerprint: seen }));
        req.setTimeout(timeout, () => req.destroy(new PeerError(`No answer from ${host}:${port}`, 'UNREACHABLE', 504)));
        req.on('error', err => reject(err instanceof PeerError ? err : new PeerError(`Connection to ${host}:${port} failed: ${err.message}`, 'UNREACHABLE', 502)));
        if (signal) {
            if (signal.aborted) req.destroy(new PeerError('Cancelled', 'CANCELLED', 499));
            else signal.addEventListener('abort', () => req.destroy(new PeerError('Cancelled', 'CANCELLED', 499)), { once: true });
        }
        req.end(data || undefined);
    });
}

export async function readJson(res, maxBytes = MAX_JSON_BYTES) {
    const chunks = [];
    let size = 0;
    for await (const chunk of res) {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(); throw new PeerError('The other server sent too much', 'BAD_REPLY', 502); }
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) {
        throw new PeerError('The other server sent something unexpected (is that port really an AMMUI peer link?)', 'BAD_REPLY', 502);
    }
}

async function jsonRequest(opts) {
    const { status, res, fingerprint } = await rawRequest(opts);
    const data = await readJson(res);
    return { status, data, fingerprint };
}

const replyError = (status, data) => new PeerError(
    data?.error || `The other server said ${status}`,
    data?.code || 'REFUSED',
    status === 404 ? 404 : status === 416 ? 416 : 502);

const withQuery = (urlPath, query) => {
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString() : '';
    return qs ? `${urlPath}?${qs}` : urlPath;
};

// Saved peers: { id, linkId, host, port, name, fingerprint, salt, key (encrypted K), services }.
// `store` = { load(), save(list), loadGone(), saveGone(list), encrypt(text), decrypt(text),
//             clientName(), clientId() }
// The gone list holds connections removed here whose server hasn't been told yet (see Links above).
//
// Emits 'change' whenever the list, a peer's name or services, or whether it's reachable changes.
export class PeerConnections extends EventEmitter {
    constructor(store) {
        super();
        this.store = store;
        this.sessions = new Map(); // id -> { token, expiresAt }
        this.states = new Map();   // id -> { error, code, fingerprint, at }
        this.dropped = [];         // [{ name, host, port, at }]: removed by the other end
    }

    gone() {
        const list = this.store.loadGone?.();
        return Array.isArray(list) ? list : [];
    }
    saveGone(list) { this.store.saveGone?.(list); }

    all() { return this.store.load(); }
    get(id) {
        const peer = this.all().find(p => p.id === id);
        if (!peer) throw new PeerError('That connection no longer exists', 'NOT_FOUND', 404);
        return peer;
    }
    update(id, changes) {
        const list = this.all().map(p => p.id === id ? { ...p, ...changes } : p);
        this.store.save(list);
        this.emit('change');
        return list.find(p => p.id === id);
    }

    summary() {
        return this.all().map(p => {
            const state = this.states.get(p.id);
            const session = this.sessions.get(p.id);
            return {
                id: p.id, host: p.host, port: p.port, name: p.name || p.host, fingerprint: p.fingerprint,
                services: cleanServices(p.services),
                connected: !!session && session.expiresAt > Date.now(),
                error: state?.error || null, code: state?.code || null, newFingerprint: state?.fingerprint || null,
            };
        });
    }

    keyOf(peer) {
        try {
            const hex = peer.key && this.store.decrypt(peer.key);
            if (hex && hex.length === 64) return Buffer.from(hex, 'hex');
        } catch (e) { }
        throw new PeerError(`Enter the password for ${peer.name || peer.host} again`, 'NEEDS_PASSWORD', 401);
    }

    // Connections the other end removed lately, for the settings page
    recentlyDropped() {
        this.dropped = this.dropped.filter(d => Date.now() - d.at < DROPPED_SHOW_MS);
        return this.dropped;
    }

    // hello + auth. `key` and `fingerprint` given for a new or re-trusted connection; otherwise the
    // saved ones. `newLink` makes the link (peer.linkId) on the other end; otherwise it has to be
    // there still, or this throws LINK_REMOVED.
    async login(peer, { key, password, fingerprint, newLink = false } = {}) {
        // Saved before links existed (or the other end didn't know about links yet): make one now.
        // The id is saved straight away so logins running at the same time all send the same one,
        // and it stays pending until the other end has taken it.
        const savedNow = this.all().find(p => p.id === peer.id);
        let linkId = savedNow?.linkId || peer.linkId;
        if (!linkId) {
            linkId = crypto.randomUUID();
            if (savedNow) this.store.save(this.all().map(p => p.id === peer.id ? { ...p, linkId, linkPending: true } : p));
        }
        const adopt = !!(savedNow ? savedNow.linkPending || !savedNow.linkId : peer.linkPending);
        const pinned = fingerprint !== undefined ? fingerprint : peer.fingerprint;
        const hello = await jsonRequest({ host: peer.host, port: peer.port, fingerprint: pinned, method: 'POST', urlPath: '/peer/v1/hello', body: {} });
        if (hello.status !== 200) throw new PeerError(hello.data.error || `The other server said ${hello.status}`, hello.status === 429 ? 'LOCKED' : 'REFUSED', hello.status === 429 ? 429 : 502);
        if (hello.data.protocol !== PEER_PROTOCOL || typeof hello.data.salt !== 'string' || typeof hello.data.nonce !== 'string') {
            throw new PeerError('That server runs a different version of the peer link; update both servers', 'BAD_REPLY', 502);
        }
        const seen = hello.fingerprint;
        let k = key;
        if (!k && password) k = await derivePeerKey(password, hello.data.salt);
        if (!k) {
            if (peer.salt && hello.data.salt !== peer.salt) {
                throw new PeerError(`The password on ${peer.name || peer.host} has been changed: enter the new one`, 'NEEDS_PASSWORD', 401);
            }
            k = this.keyOf(peer);
        }
        const clientNonce = randomToken(24);
        const auth = await jsonRequest({
            host: peer.host, port: peer.port, fingerprint: seen, method: 'POST', urlPath: '/peer/v1/auth',
            body: {
                nonce: hello.data.nonce, clientNonce, proof: proof(k, 'client', hello.data.nonce, clientNonce, seen),
                clientName: this.store.clientName(), clientId: this.store.clientId?.() || undefined,
                linkId, newLink: newLink || adopt,
            },
        });
        if (auth.status === 401) throw new PeerError('Wrong password', 'NEEDS_PASSWORD', 401);
        if (auth.status === 403 && auth.data.code === 'LINK_REMOVED') {
            if (!sameText(auth.data.serverProof, proof(k, 'server', hello.data.nonce, clientNonce, seen))) {
                throw new PeerError('The other server couldn\'t prove it knows the password - not connecting', 'BAD_SERVER', 502);
            }
            throw new PeerError(`${peer.name || peer.host} removed this connection`, 'LINK_REMOVED', 410);
        }
        if (auth.status === 429) throw new PeerError(auth.data.error || 'Too many wrong passwords; try again later', 'LOCKED', 429);
        if (auth.status !== 200 || typeof auth.data.token !== 'string') throw new PeerError(auth.data.error || `The other server said ${auth.status}`, 'REFUSED', 502);
        if (!sameText(auth.data.serverProof, proof(k, 'server', hello.data.nonce, clientNonce, seen))) {
            throw new PeerError('The other server couldn\'t prove it knows the password - not connecting', 'BAD_SERVER', 502);
        }
        this.sessions.set(peer.id, { token: auth.data.token, expiresAt: Date.now() + Math.min(Number(auth.data.expiresIn) || 0, SESSION_MS) - 60000 });
        // An older server ignores the link id: it stays pending until that server is updated
        const linkPending = auth.data.links !== true;
        const saved = this.all().find(p => p.id === peer.id);
        const serverId = typeof auth.data.serverId === 'string' && LINK_ID.test(auth.data.serverId)
            ? auth.data.serverId : (saved?.serverId || peer.serverId || null);
        const result = {
            key: k, salt: hello.data.salt, fingerprint: seen, linkId, linkPending, serverId,
            name: String(auth.data.name || hello.data.name || peer.host).replace(/[\x00-\x1f]/g, '').slice(0, 80),
            services: cleanServices(auth.data.services),
        };
        // An existing connection: keep its name and services up to date with the other end
        if (saved && (saved.name !== result.name || !sameServices(saved.services, result.services)
            || saved.linkId !== linkId || !!saved.linkPending !== linkPending || (saved.serverId || null) !== serverId)) {
            this.update(peer.id, { name: result.name, services: result.services, linkId, linkPending, serverId });
        }
        return result;
    }

    // The other server's own id (an older one doesn't send it at login; its game results carry it)
    setServerId(id, serverId) {
        const peer = this.all().find(p => p.id === id);
        if (peer && LINK_ID.test(serverId) && peer.serverId !== serverId) this.update(id, { serverId });
    }

    // The ids of the servers connected to from here
    serverIds() {
        return this.all().map(p => p.serverId).filter(Boolean);
    }

    // The other end removed the connection: remove it here too (no bye: it's gone there already)
    drop(id) {
        const peer = this.all().find(p => p.id === id);
        if (!peer) return;
        this.sessions.delete(id);
        this.states.delete(id);
        this.store.save(this.all().filter(p => p.id !== id));
        this.dropped = [...this.recentlyDropped().filter(d => !(d.host === peer.host && d.port === peer.port)),
            { name: peer.name || peer.host, host: peer.host, port: peer.port, at: Date.now() }];
        console.log(`[PEER] "${peer.name || peer.host}" (${peer.host}:${peer.port}) removed the connection; removed here too.`);
        this.emit('change');
    }

    remember(id, err) {
        if (err?.code === 'LINK_REMOVED') return this.drop(id);
        const before = this.states.get(id);
        if (err) this.states.set(id, { error: err.message, code: err.code, fingerprint: err.fingerprint || null, at: Date.now() });
        else this.states.delete(id);
        if ((before?.code || null) !== (err?.code || null) || (before?.error || null) !== (err?.message || null)) this.emit('change');
    }

    async add({ address, port, password }) {
        if (!password) throw new PeerError('Enter the other server\'s peer link password', 'NEEDS_PASSWORD', 400);
        const { host, port: p } = parsePeerAddress(address, port);
        const list = this.all();
        const existing = list.find(x => x.host.toLowerCase() === host.toLowerCase() && x.port === p);
        // Connecting makes a new link, even to a server already in the list
        const peer = { ...(existing || { id: crypto.randomUUID(), host, port: p, addedAt: Date.now() }), linkId: crypto.randomUUID(), linkPending: false };
        // A new connection trusts the certificate it first sees; an existing one keeps its pin.
        // Logging in with peer.id of an existing one would save the new link id before it's
        // made, so it logs in under an id of its own.
        const result = await this.login({ ...peer, id: `new:${peer.linkId}` }, { password, fingerprint: existing ? existing.fingerprint : null, newLink: true });
        const session = this.sessions.get(`new:${peer.linkId}`);
        this.sessions.delete(`new:${peer.linkId}`);
        if (session) this.sessions.set(peer.id, session);
        const saved = {
            ...peer, name: result.name, fingerprint: result.fingerprint, salt: result.salt,
            key: this.store.encrypt(result.key.toString('hex')), services: result.services,
            linkPending: result.linkPending, serverId: result.serverId,
        };
        this.dropped = this.recentlyDropped().filter(d => !(d.host === host && d.port === p));
        this.store.save(existing ? this.all().map(x => x.id === peer.id ? saved : x) : [...this.all(), saved]);
        this.remember(peer.id, null);
        this.emit('change');
        console.log(`[PEER] Connected to "${saved.name}" at ${host}:${p} (certificate ${saved.fingerprint}).`);
        return saved;
    }

    async setPassword(id, password) {
        const peer = this.get(id);
        try {
            const result = await this.login(peer, { password });
            this.update(id, { name: result.name, salt: result.salt, key: this.store.encrypt(result.key.toString('hex')) });
            this.remember(id, null);
        } catch (err) {
            this.remember(id, err);
            throw err;
        }
    }

    // Accept the certificate the server now has. The login still has to succeed with the saved
    // password, and the server has to prove it knows it, before the new one is kept.
    async trustNewCertificate(id) {
        const peer = this.get(id);
        const fingerprint = this.states.get(id)?.fingerprint;
        if (!fingerprint) throw new PeerError('There\'s no new certificate to trust', 'BAD_REQUEST', 400);
        try {
            const result = await this.login(peer, { key: this.keyOf(peer), fingerprint });
            this.update(id, { fingerprint: result.fingerprint, name: result.name });
            this.remember(id, null);
            console.log(`[PEER] Now trusting the new certificate of "${result.name}" (${result.fingerprint}).`);
        } catch (err) {
            this.remember(id, err.code === 'FINGERPRINT_CHANGED' ? err : { ...err, message: err.message, code: err.code, fingerprint });
            throw err;
        }
    }

    // Removes the connection here, and tells the other end so it removes it too. If it can't be
    // reached, it's told later (see sayByes).
    async remove(id) {
        const peer = this.all().find(p => p.id === id);
        const session = this.sessions.get(id);
        this.sessions.delete(id);
        this.states.delete(id);
        this.store.save(this.all().filter(p => p.id !== id));
        this.emit('change');
        if (!peer?.key) return;
        const entry = {
            id: `bye:${peer.linkId || peer.id}`, host: peer.host, port: peer.port, name: peer.name,
            fingerprint: peer.fingerprint, salt: peer.salt, key: peer.key,
            linkId: peer.linkId, linkPending: !peer.linkId || peer.linkPending, removedAt: Date.now(),
        };
        if (session) this.sessions.set(entry.id, session);
        this.saveGone([...this.gone().filter(g => g.id !== entry.id), entry]);
        this.sayBye(entry).catch(() => { });
    }

    // Tells the other end a removed connection is gone; true once it knows (or never can)
    async sayBye(entry) {
        let done = false;
        try {
            for (let attempt = 0; ; attempt++) {
                const token = await this.token(entry, attempt > 0);
                const r = await rawRequest({ host: entry.host, port: entry.port, fingerprint: entry.fingerprint, method: 'POST', urlPath: '/peer/v1/bye', headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
                r.res.resume();
                if (r.status === 401 && attempt === 0) continue;
                done = r.status < 500;
                break;
            }
            if (done) console.log(`[PEER] Told "${entry.name || entry.host}" the connection was removed.`);
        } catch (err) {
            // Gone there already, or it can never be told (wrong password, different server)
            done = ['LINK_REMOVED', 'NEEDS_PASSWORD', 'BAD_SERVER', 'FINGERPRINT_CHANGED'].includes(err.code);
        }
        this.sessions.delete(entry.id);
        if (done || Date.now() - entry.removedAt > GONE_KEEP_MS) this.saveGone(this.gone().filter(g => g.id !== entry.id));
        return done;
    }

    async sayByes() {
        await Promise.all(this.gone().map(g => this.sayBye(g).catch(() => false)));
    }

    // Logs in to every saved peer, so what each offers (and its name) is up to date. A peer that
    // can't be reached keeps what it last offered, with the error remembered against it.
    async refreshAll() {
        await Promise.all([this.sayByes(), ...this.all().map(async peer => {
            try {
                await this.token(peer, true);
                this.remember(peer.id, null);
            } catch (err) {
                this.remember(peer.id, err);
            }
        })]);
    }

    // A quick check that each connection is still there at the other end, so one removed there
    // is removed here soon after, without waiting for it to be used
    async checkAll() {
        await Promise.all([this.sayByes(), ...this.all().map(async peer => {
            try {
                const r = await this.request(peer.id, { urlPath: '/peer/v1/ping', timeout: 10000 });
                r.res.resume();
            } catch (err) { /* remembered by request() */ }
        })]);
    }

    async token(peer, fresh = false) {
        const s = this.sessions.get(peer.id);
        if (!fresh && s && s.expiresAt > Date.now()) return s.token;
        this.sessions.delete(peer.id);
        await this.login(peer);
        return this.sessions.get(peer.id).token;
    }

    // An authenticated request, logging in again once if the session has lapsed on the other end
    async request(id, opts) {
        const peer = this.get(id);
        try {
            for (let attempt = 0; ; attempt++) {
                const token = await this.token(peer, attempt > 0);
                const r = await rawRequest({ ...opts, host: peer.host, port: peer.port, fingerprint: peer.fingerprint, headers: { ...opts.headers, Authorization: `Bearer ${token}` } });
                if (r.status === 401 && attempt === 0) { r.res.resume(); continue; }
                this.remember(id, null);
                return r;
            }
        } catch (err) {
            if (err.code !== 'CANCELLED') this.remember(id, err);
            throw err;
        }
    }

    // The version of `name` the peer offered when it last logged in (0 if it doesn't)
    serviceVersion(id, name) {
        return cleanServices(this.get(id).services)[name] || 0;
    }

    // Requests to one service on one peer, at /peer/v1/<name>/<path>:
    //   getJson(path, query, { timeout })        -> the reply's JSON (throws on anything but 200)
    //   postJson(path, body, { timeout, query }) -> likewise, sending JSON
    //   open(path, query, { range, signal, timeout }) -> { status, headers, res } for 200 or 206
    service(id, name) {
        if (!SERVICE_NAME.test(name)) throw new Error(`Bad peer service name: ${name}`);
        const base = `/peer/v1/${name}`;
        const json = async (opts) => {
            const r = await this.request(id, opts);
            const data = await readJson(r.res);
            if (r.status !== 200) throw replyError(r.status, data);
            return data;
        };
        return {
            id, name,
            version: () => this.serviceVersion(id, name),
            getJson: (p, query, { timeout = 30000 } = {}) => json({ urlPath: withQuery(base + p, query), timeout }),
            postJson: (p, body, { timeout = 30000, query } = {}) => json({ method: 'POST', urlPath: withQuery(base + p, query), body: body ?? {}, timeout }),
            open: async (p, query, { range, signal, timeout = 60000 } = {}) => {
                const r = await this.request(id, { urlPath: withQuery(base + p, query), headers: range ? { Range: range } : {}, timeout, signal });
                if (r.status !== 200 && r.status !== 206) {
                    const data = await readJson(r.res, 64 * 1024).catch(() => ({}));
                    throw replyError(r.status, data);
                }
                return r;
            },
        };
    }
}
