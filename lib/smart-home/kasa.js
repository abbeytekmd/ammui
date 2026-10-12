// TP-Link Kasa plugs and power strips with the original local protocol: JSON "encrypted" with a
// rolling XOR, over UDP 9999 for discovery and TCP 9999 for commands. Newer Kasa firmware and
// Tapo devices use a different, authenticated protocol (see tplink-smart.js).
import dgram from 'dgram';
import net from 'net';

function encrypt(text) {
    const buf = Buffer.from(text);
    let key = 171;
    for (let i = 0; i < buf.length; i++) { buf[i] ^= key; key = buf[i]; }
    return buf;
}

function decrypt(buf) {
    const out = Buffer.alloc(buf.length);
    let key = 171;
    for (let i = 0; i < buf.length; i++) { out[i] = buf[i] ^ key; key = buf[i]; }
    return out.toString('utf8');
}

// Broadcasts a sysinfo request and calls onFound({ ip, sysinfo }) for each reply within `waitMs`.
export function discover(onFound, waitMs = 3000) {
    return new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        sock.on('message', (msg, rinfo) => {
            try {
                const sysinfo = JSON.parse(decrypt(msg)).system?.get_sysinfo;
                if (sysinfo) onFound({ ip: rinfo.address, sysinfo });
            } catch (e) { }
        });
        sock.on('error', err => {
            console.warn('[SMART-HOME] Kasa discovery failed:', err.message);
            try { sock.close(); } catch (e) { }
            resolve();
        });
        sock.bind(() => {
            sock.setBroadcast(true);
            const probe = encrypt('{"system":{"get_sysinfo":{}}}');
            for (let i = 0; i < 3; i++) setTimeout(() => sock.send(probe, 9999, '255.255.255.255', () => { }), i * 400);
        });
        setTimeout(() => { try { sock.close(); } catch (e) { } resolve(); }, waitMs);
    });
}

function send(ip, obj, timeout = 4000) {
    return new Promise((resolve, reject) => {
        const sock = net.connect({ host: ip, port: 9999 });
        const payload = encrypt(JSON.stringify(obj));
        const head = Buffer.alloc(4);
        head.writeUInt32BE(payload.length, 0);
        let buf = Buffer.alloc(0);
        const done = (err, val) => { clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(val); };
        const timer = setTimeout(() => done(new Error('No reply from the plug')), timeout);
        sock.on('connect', () => sock.write(Buffer.concat([head, payload])));
        sock.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
            if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
                try { done(null, JSON.parse(decrypt(buf.subarray(4, 4 + buf.readUInt32BE(0))))); } catch (e) { done(e); }
            }
        });
        sock.on('error', err => done(err));
    });
}

// Strips list their sockets as children; a single plug is outlet "0".
function childId(sysinfo, child) {
    return child.id.length <= 2 ? sysinfo.deviceId + child.id : child.id;
}

export async function getStatus(plug) {
    const sysinfo = (await send(plug.ip, { system: { get_sysinfo: {} } })).system.get_sysinfo;
    if (sysinfo.children?.length) {
        return { outlets: sysinfo.children.map(c => ({ id: childId(sysinfo, c), name: c.alias, on: c.state === 1 })) };
    }
    const outlet = { id: '0', on: sysinfo.relay_state === 1 };
    if (/ENE/.test(sysinfo.feature || '')) {
        try {
            const rt = (await send(plug.ip, { emeter: { get_realtime: {} } }, 2000)).emeter.get_realtime;
            const power = rt.power_mw != null ? rt.power_mw / 1000 : rt.power;
            if (typeof power === 'number') outlet.power = power;
        } catch (e) { }
    }
    return { outlets: [outlet] };
}

export async function setOutlet(plug, outletId, on) {
    const cmd = { system: { set_relay_state: { state: on ? 1 : 0 } } };
    if (outletId !== '0') cmd.context = { child_ids: [outletId] };
    const reply = await send(plug.ip, cmd);
    if (reply.system?.set_relay_state?.err_code) throw new Error(reply.system.set_relay_state.err_msg || 'The plug refused');
    return getStatus(plug);
}
