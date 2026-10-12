// TPAP: how current Tapo firmware is logged in to and talked to on the local network.
// The login is SPAKE2+ (RFC 9383) on P-256 with the TP-Link account password; requests and
// responses are then encrypted with AES-128-CCM under a per-request sequence number.
// Ported from the Rust `tapo` crate (tapo/src/api/protocol/tpap_*.rs),
// Copyright (c) 2022-2025 Mihai Dinculescu, MIT License (see LICENSE).
//
// The plugs count failed logins and lock themselves for a while after too many, so a wrong
// password is reported as TpapAuthError and must not be retried with the same password.
import crypto from 'crypto';
import http from 'http';
import * as ec from './p256.js';

// The points RFC 9383 assigns to P-256
const M = ec.decode(Buffer.from('02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f', 'hex'));
const N = ec.decode(Buffer.from('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49', 'hex'));

const CIPHER_SUITE = 1;          // P-256, SHA-256, HMAC-SHA256: the only one the app offers
const ENCRYPTION = 'aes_128_ccm';
const MAX_ITERATIONS = 100000;

const ERRORS = {
    '-1501': 'LOGIN', '9999': 'SESSION_TIMEOUT', '-40401': 'SESSION_EXPIRED',
    '-2101': 'TPAP_AUTH_ATTEMPTS_LIMIT', '-2201': 'TPAP_CIPHER_SUITES_UNSUPPORTED',
    '-2202': 'TPAP_PASSCODE_TYPE_UNSUPPORTED', '-2203': 'TPAP_CREDENTIALS', '-2402': 'TPAP_SESSION_INVALID',
};

export class TpapError extends Error { }
// The password was refused or the plug has locked itself: don't log in again with the same password.
export class TpapAuthError extends TpapError { }
// The session is gone (expired, or the plug restarted): logging in again fixes it.
export class TpapSessionError extends TpapError { }

function deviceError(code, what) {
    const kind = ERRORS[code] || 'UNKNOWN';
    if (kind === 'TPAP_CREDENTIALS' || kind === 'LOGIN') return new TpapAuthError('Wrong TP-Link password');
    if (kind === 'TPAP_AUTH_ATTEMPTS_LIMIT') return new TpapAuthError('Locked after too many failed logins; try again later');
    if (/SESSION/.test(kind)) return new TpapSessionError(`Session expired (${code})`);
    return new TpapError(`${what} failed: error ${code} ${kind}`);
}

const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// ─── SPAKE2+ (prover side) ───────────────────────────────────────────────────

// What stands in for the password, as the plug's pake_register `extra_crypt` asks.
export function credential(password, extraCrypt) {
    if (extraCrypt?.type === 'password_shadow' && extraCrypt.params?.passwd_id === 2) {
        return crypto.createHash('sha1').update(password, 'utf8').digest('hex');
    }
    throw new TpapError(`The plug asks for a password transform that isn't supported: ${JSON.stringify(extraCrypt ?? null)}`);
}

// w0 and w1: the halves of the PBKDF2 output, each reduced modulo the group order.
export function deriveW0W1(cred, salt, iterations) {
    const key = crypto.pbkdf2Sync(Buffer.from(cred, 'utf8'), salt, iterations, 80, 'sha256');
    return [ec.bytesToBig(key.subarray(0, 40)) % ec.ORDER, ec.bytesToBig(key.subarray(40)) % ec.ORDER];
}

// Each item behind its length as 8 little-endian bytes.
function transcript(items) {
    return Buffer.concat(items.flatMap(item => {
        const len = Buffer.alloc(8);
        len.writeBigUInt64LE(BigInt(item.length));
        return [len, Buffer.from(item)];
    }));
}

// The prover's share and confirmation, and the keys both sides now share. `x` is random in use;
// the RFC's test vectors fix it.
export function prove({ w0, w1, x, context, proverId = Buffer.alloc(0), verifierId = Buffer.alloc(0), verifierShare }) {
    x ??= ec.bytesToBig(crypto.randomBytes(48)) % (ec.ORDER - 1n) + 1n;
    const share = ec.add(ec.multiply(ec.G, x), ec.multiply(M, w0));
    const Y = ec.decode(verifierShare);
    if (!Y) throw new TpapError("The plug's share isn't a point on P-256");
    const unmasked = ec.add(Y, ec.negate(ec.multiply(N, w0)));
    const Z = ec.multiply(unmasked, x);
    const V = ec.multiply(unmasked, w1);
    if (!Z || !V) throw new TpapError("The plug's share leads to a key that isn't secret");

    const X = ec.encode(share), Yb = ec.encode(Y);
    const mainKey = sha256(transcript([context, proverId, verifierId, ec.encode(M), ec.encode(N), X, Yb, ec.encode(Z), ec.encode(V), ec.bigToBytes(w0)]));
    const confirmKeys = hkdf(mainKey, Buffer.alloc(0), 'ConfirmationKeys', 64);
    return {
        share: X,
        confirm: hmac(confirmKeys.subarray(0, 32), Yb),
        sharedKey: hkdf(mainKey, Buffer.alloc(0), 'SharedKey', 32),
        verify: deviceConfirm => {
            const expected = hmac(confirmKeys.subarray(32), X);
            return deviceConfirm.length === expected.length && crypto.timingSafeEqual(deviceConfirm, expected);
        },
    };
}

// ─── AES-128-CCM channel ─────────────────────────────────────────────────────

export class Cipher {
    constructor(sharedKey, startSeq) {
        this.key = hkdf(sharedKey, 'tp-kdf-salt-aes128-key', 'tp-kdf-info-aes128-key', 16);
        this.baseNonce = hkdf(sharedKey, 'tp-kdf-salt-aes128-iv', 'tp-kdf-info-aes128-iv', 12);
        this.seq = startSeq | 0;
    }

    nonce(seq) {
        const n = Buffer.from(this.baseNonce);
        n.writeInt32BE(seq, 8);
        return n;
    }

    // The sequence number, then the ciphertext and its 16-byte tag.
    encrypt(text) {
        const seq = this.seq;
        this.seq = (this.seq + 1) | 0;
        const c = crypto.createCipheriv('aes-128-ccm', this.key, this.nonce(seq), { authTagLength: 16 });
        const head = Buffer.alloc(4);
        head.writeInt32BE(seq);
        return { seq, body: Buffer.concat([head, c.update(text, 'utf8'), c.final(), c.getAuthTag()]) };
    }

    // The plug answers under the sequence number of the request.
    decrypt(seq, body) {
        if (body.length < 20) throw new TpapError(`Response of ${body.length} bytes is too short`);
        if (body.readInt32BE(0) !== seq) throw new TpapError('Response is for another request');
        const d = crypto.createDecipheriv('aes-128-ccm', this.key, this.nonce(seq), { authTagLength: 16 });
        d.setAuthTag(body.subarray(body.length - 16));
        const out = d.update(body.subarray(4, body.length - 16));
        d.final();
        return out.toString('utf8');
    }
}

// ─── Transport ───────────────────────────────────────────────────────────────

// A plain request: the plugs answer fetch()'s extra headers with an HTML page instead.
function post(url, body, contentType, timeout = 6000) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({
            host: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST',
            headers: { 'Content-Type': contentType, 'Content-Length': body.length },
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        });
        req.setTimeout(timeout, () => req.destroy(new Error('No reply from the plug')));
        req.on('error', reject);
        req.end(body);
    });
}

async function login(baseUrl, subMethod, params) {
    const res = await post(`${baseUrl}/`, Buffer.from(JSON.stringify({ method: 'login', params: { sub_method: subMethod, ...params } })), 'application/json');
    if (res.status !== 200) throw new TpapError(`${subMethod} failed: HTTP ${res.status}`);
    let reply;
    try { reply = JSON.parse(res.body.toString('utf8')); } catch (e) { throw new TpapError(`${subMethod} failed: the plug didn't answer in JSON`); }
    if (reply.error_code) throw deviceError(reply.error_code, subMethod);
    if (!reply.result) throw new TpapError(`${subMethod} failed: empty result`);
    return reply.result;
}

// A logged-in connection to one plug. `info` is the `tpap` object the plug announces in discovery.
export class Session {
    constructor(ip, info, password) {
        if (info?.tls) throw new TpapError('TPAP over TLS isn\'t supported yet');
        if (!info?.pake?.includes(2) || info.pake.includes(0)) {
            throw new TpapError(`This plug's login (pake ${JSON.stringify(info?.pake)}) isn't supported yet`);
        }
        this.baseUrl = `http://${ip}:${info.port || 80}`;
        this.password = password;
        this.ready = null;
    }

    async handshake() {
        const userRandom = crypto.randomBytes(32);
        const reg = await login(this.baseUrl, 'pake_register', {
            username: crypto.createHash('md5').update('admin').digest('hex'), // always `admin`, never the account email
            user_random: userRandom.toString('base64'),
            cipher_suites: [CIPHER_SUITE],
            encryption: [ENCRYPTION],
            passcode_type: 'userpw',
        });
        if (reg.cipher_suites !== CIPHER_SUITE || reg.encryption !== ENCRYPTION) {
            throw new TpapError(`The plug picked ${reg.cipher_suites}/${reg.encryption}, which isn't supported`);
        }
        if (!(reg.iterations >= 1 && reg.iterations <= MAX_ITERATIONS)) throw new TpapError(`Unexpected PBKDF2 iterations: ${reg.iterations}`);
        const deviceRandom = Buffer.from(reg.dev_random, 'base64');
        if (deviceRandom.length !== 32) throw new TpapError('Unexpected dev_random length');

        const [w0, w1] = deriveW0W1(credential(this.password, reg.extra_crypt), Buffer.from(reg.dev_salt, 'base64'), reg.iterations);
        const proof = prove({
            w0, w1,
            context: sha256(Buffer.from('PAKE V1'), userRandom, deviceRandom),
            verifierShare: Buffer.from(reg.dev_share, 'base64'),
        });

        let share;
        try {
            share = await login(this.baseUrl, 'pake_share', {
                user_share: proof.share.toString('base64'),
                user_confirm: proof.confirm.toString('base64'),
            });
        } catch (err) {
            // A refused password can come back as an expired session; it mustn't be retried.
            if (err instanceof TpapSessionError) throw new TpapAuthError('Wrong TP-Link password');
            throw err;
        }
        if (!proof.verify(Buffer.from(share.dev_confirm || '', 'base64'))) {
            throw new TpapAuthError("The plug's confirmation didn't match (wrong password?)");
        }
        this.url = `${this.baseUrl}/stok=${share.stok}/ds`;
        this.cipher = new Cipher(proof.sharedKey, share.start_seq);
    }

    // Requests from several callers go out one at a time, after the login.
    request(method, params = null) {
        const run = async retried => {
            if (!this.cipher) await this.handshake();
            const { seq, body } = this.cipher.encrypt(JSON.stringify({ method, params }));
            const res = await post(this.url, body, 'application/octet-stream');
            if (res.status !== 200) throw new TpapError(`${method} failed: HTTP ${res.status}`);
            let text;
            try {
                text = this.cipher.decrypt(seq, res.body);
            } catch (err) {
                // A plug that has forgotten the session says so in plain JSON
                let plain = null;
                try { plain = JSON.parse(res.body.toString('utf8')); } catch (e) { }
                if (plain?.error_code && !retried) {
                    this.cipher = null;
                    return run(true);
                }
                throw new TpapError(`${method}: the response couldn't be decrypted`);
            }
            const reply = JSON.parse(text);
            if (reply.error_code) {
                const err = deviceError(reply.error_code, method);
                if (err instanceof TpapSessionError && !retried) {
                    this.cipher = null;
                    return run(true);
                }
                throw err;
            }
            return reply.result;
        };
        const next = (this.ready || Promise.resolve()).catch(() => { }).then(() => run(false));
        this.ready = next.catch(() => { });
        return next;
    }
}
