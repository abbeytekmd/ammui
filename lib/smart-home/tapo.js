// TP-Link Tapo plugs (and newer Kasa firmware). They answer a discovery broadcast on UDP 20002 and
// are switched over TPAP (tpap.js) with the TP-Link account password. Devices still on the older
// KLAP or AES logins are found and listed, but not switched yet.
import dgram from 'dgram';
import crypto from 'crypto';
import { Session, TpapAuthError } from './tpap.js';

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let n = 0; n < buf.length; n++) {
        let c = (crc ^ buf[n]) & 0xFF;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

let probe = null;

// The request carries an RSA public key (the reply doesn't use it for anything we need).
function discoveryPacket() {
    if (probe) return probe;
    const { publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 1024,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const body = Buffer.from(JSON.stringify({ params: { rsa_key: publicKey } }));
    const head = Buffer.alloc(16);
    head.writeUInt8(2, 0);
    head.writeUInt16BE(1, 2);
    head.writeUInt16BE(body.length, 4);
    head.writeUInt8(17, 6);
    head.writeUInt32BE(crypto.randomBytes(4).readUInt32BE(0), 8);
    head.writeUInt32BE(0x5A6B7C8D, 12);
    probe = Buffer.concat([head, body]);
    probe.writeUInt32BE(crc32(probe), 12);
    return probe;
}

// onFound({ ip, id, mac, model, type, encryptType, tpap }) for each reply within `waitMs`.
export function discover(onFound, waitMs = 3000) {
    return new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        sock.on('message', (msg, rinfo) => {
            try {
                const r = JSON.parse(msg.subarray(16).toString('utf8')).result;
                if (r) onFound({
                    ip: r.ip || rinfo.address, id: r.device_id, mac: r.mac, model: r.device_model, type: r.device_type,
                    encryptType: r.mgt_encrypt_schm?.encrypt_type, tpap: r.tpap || null,
                });
            } catch (e) { }
        });
        sock.on('error', err => {
            console.warn('[SMART-HOME] TP-Link discovery failed:', err.message);
            try { sock.close(); } catch (e) { }
            resolve();
        });
        sock.bind(() => {
            sock.setBroadcast(true);
            const pkt = discoveryPacket();
            for (let i = 0; i < 3; i++) setTimeout(() => sock.send(pkt, 20002, '255.255.255.255', () => { }), i * 400);
        });
        setTimeout(() => { try { sock.close(); } catch (e) { } resolve(); }, waitMs);
    });
}

// Why this device can't be switched from here (besides a missing login), or null.
export function unsupportedReason(plug) {
    if (!/^SMART\./.test(plug.deviceType || '')) return `${plug.deviceType || 'This device type'} isn't supported yet`;
    if (plug.encryptType !== 'TPAP' || !plug.tpap) return `TP-Link ${plug.encryptType || 'this'} login isn't supported yet`;
    return null;
}

const sessions = new Map(); // plug id -> { key, session }
// Plugs whose login was refused, by the password that was refused, so it isn't tried again
// (they lock themselves after too many failures). Cleared when the password changes.
const refused = new Map();  // plug id -> { password, message }

function sessionFor(plug, account) {
    if (!account?.password) throw Object.assign(new Error('Needs the TP-Link account login (Devices → Plugs)'), { needsLogin: true });
    const blocked = refused.get(plug.id);
    if (blocked && blocked.password === account.password) throw Object.assign(new Error(blocked.message), { needsLogin: true });
    const key = `${plug.ip}|${JSON.stringify(plug.tpap)}|${account.password}`;
    let entry = sessions.get(plug.id);
    if (entry?.key !== key) {
        entry = { key, session: new Session(plug.ip, plug.tpap, account.password) };
        sessions.set(plug.id, entry);
    }
    return entry.session;
}

async function call(plug, account, method, params) {
    const session = sessionFor(plug, account);
    try {
        return await session.request(method, params);
    } catch (err) {
        if (err instanceof TpapAuthError) {
            refused.set(plug.id, { password: account.password, message: err.message });
            sessions.delete(plug.id);
            err.needsLogin = true;
        }
        throw err;
    }
}

export function forget(id) {
    sessions.delete(id);
    refused.delete(id);
}

const decodeName = s => {
    try { return s ? Buffer.from(s, 'base64').toString('utf8') : null; } catch (e) { return null; }
};

// One outlet ("0") for a single plug. `info` also carries the name set in the Tapo app.
export async function getStatus(plug, account) {
    const info = await call(plug, account, 'get_device_info');
    const outlet = { id: '0', on: !!info.device_on };
    if (/^P11/.test(plug.model || '')) {
        try {
            const p = await call(plug, account, 'get_current_power');
            if (typeof p?.current_power === 'number') outlet.power = p.current_power;
        } catch (e) { }
    }
    return { outlets: [outlet], name: decodeName(info.nickname) };
}

export async function setOutlet(plug, outletId, on, account) {
    await call(plug, account, 'set_device_info', { device_on: on });
    return getStatus(plug, account);
}
