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

// ─── Timers ──────────────────────────────────────────────────────────────────
// The "count_down" and "schedule" modules, kept on the plug. A plug holds one countdown rule, so
// a new one replaces it. Schedule times are minutes after midnight on the plug's clock (set by
// the Kasa app); wday is Sunday first. Power strips keep timers per socket, which isn't offered here.

async function rules(plug, module, method, params = {}) {
    const reply = (await send(plug.ip, { [module]: { [method]: params } }))[module]?.[method];
    if (!reply) throw new Error("The plug doesn't have timers");
    if (reply.err_code) throw new Error(reply.err_msg || 'The plug refused');
    return reply;
}

async function assertSinglePlug(plug) {
    const sysinfo = (await send(plug.ip, { system: { get_sysinfo: {} } })).system.get_sysinfo;
    if (sysinfo.children?.length) throw Object.assign(new Error("Timers on power strips aren't supported yet"), { status: 400 });
}

const publicRule = r => ({
    id: r.id, on: r.sact === 1, minute: r.smin, enabled: !!r.enable,
    days: r.repeat ? r.wday.map(Boolean) : null,
    at: r.stime_opt === 1 ? { type: 'sunrise', offset: 0 } : r.stime_opt === 2 ? { type: 'sunset', offset: 0 } : null,
});

export async function getTimers(plug) {
    await assertSinglePlug(plug);
    const countdown = await rules(plug, 'count_down', 'get_rules');
    const schedule = await rules(plug, 'schedule', 'get_rules');
    const c = countdown.rule_list?.find(r => r.enable && r.remain > 0);
    return {
        countdown: c ? { on: c.act === 1, endsAt: Date.now() + c.remain * 1000 } : null,
        schedules: (schedule.rule_list || []).map(publicRule),
        limits: { countdown: true, days: true, maxSchedules: 32 },
    };
}

// `minutes` 0 cancels.
export async function setCountdown(plug, { on, minutes }) {
    await assertSinglePlug(plug);
    await rules(plug, 'count_down', 'delete_all_rules');
    const delay = Math.round(minutes * 60);
    if (delay) await rules(plug, 'count_down', 'add_rule', { enable: 1, delay, act: on ? 1 : 0, name: 'AMMUI' });
    return getTimers(plug);
}

export async function saveSchedule(plug, { id, on, minute, days, enabled }) {
    await assertSinglePlug(plug);
    const old = id ? (await rules(plug, 'schedule', 'get_rules')).rule_list?.find(r => r.id === id) : null;
    if (id && !old) throw Object.assign(new Error('That schedule has gone; it may have been changed in the Kasa app'), { status: 404 });
    const rule = old ? { ...old } : {
        name: 'AMMUI', enable: 1, wday: [1, 1, 1, 1, 1, 1, 1], repeat: 1, stime_opt: 0, smin: 0, sact: 1,
        etime_opt: -1, emin: 0, eact: -1, year: 0, month: 0, day: 0, longitude: 0, latitude: 0, force: 0,
    };
    if (on !== undefined) rule.sact = on ? 1 : 0;
    if (minute !== undefined) Object.assign(rule, { stime_opt: 0, smin: minute });
    if (days !== undefined) Object.assign(rule, { repeat: 1, wday: days.map(d => d ? 1 : 0) });
    if (enabled !== undefined) rule.enable = enabled ? 1 : 0;
    await rules(plug, 'schedule', old ? 'edit_rule' : 'add_rule', rule);
    if (!old) await rules(plug, 'schedule', 'set_overall_enable', { enable: 1 });
    return getTimers(plug);
}

export async function deleteSchedule(plug, id) {
    await assertSinglePlug(plug);
    await rules(plug, 'schedule', 'delete_rule', { id });
    return getTimers(plug);
}
