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

// ─── Timers ──────────────────────────────────────────────────────────────────
// Kept on the plug itself, so they run whether or not this server is up. The getters answer
// -1008/-1001 without params, so they're always sent at least {}. A plug holds one countdown
// rule ("C1"), which the app leaves in place, disabled, once it has fired or been cancelled.
// Schedules are in the plug's local time; week_day is a bit mask with bit 0 = Sunday, the order
// the Tapo app's day picker uses. A repeating rule carries the date of its next run, as the app's do.

async function deviceClock(plug, account) {
    const t = await call(plug, account, 'get_device_time', {});
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: t.region || undefined, hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(t.timestamp * 1000)).map(p => [p.type, +p.value]));
    return { ...parts, minute: parts.hour * 60 + parts.minute };
}

// The date a rule at `minute` (every day in `days`) next runs, on the plug's clock.
function nextRunDate(clock, minute, days) {
    const today = Date.UTC(clock.year, clock.month - 1, clock.day);
    for (let ahead = 0; ahead < 8; ahead++) {
        const d = new Date(today + ahead * 86400000);
        if (days[d.getUTCDay()] && (ahead > 0 || minute > clock.minute)) {
            return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
        }
    }
    return { year: clock.year, month: clock.month, day: clock.day };
}

const daysFromMask = mask => [0, 1, 2, 3, 4, 5, 6].map(i => !!(mask & (1 << i)));
const maskFromDays = days => days.reduce((m, on, i) => on ? m | (1 << i) : m, 0);

function publicRule(r) {
    return {
        id: r.id, on: !!r.desired_states?.on, minute: r.s_min, enabled: !!r.enable,
        days: r.mode === 'repeat' ? daysFromMask(r.week_day) : null,
        // Sunrise/sunset rules made in the app: shown, but their time can't be edited here
        at: r.s_type && r.s_type !== 'normal' ? { type: r.s_type, offset: r.time_offset || 0 } : null,
    };
}

async function scheduleRules(plug, account) {
    const rules = [];
    let page;
    do {
        page = await call(plug, account, 'get_schedule_rules', { start_index: rules.length });
        rules.push(...(page.rule_list || []));
    } while (page.rule_list?.length && rules.length < (page.sum || 0));
    return { rules, max: page.schedule_rule_max_count || 32 };
}

export async function getTimers(plug, account) {
    const [countdown, schedules] = await Promise.all([
        call(plug, account, 'get_countdown_rules', {}),
        scheduleRules(plug, account),
    ]);
    const c = countdown.rule_list?.find(r => r.enable && r.remain > 0);
    return {
        countdown: c ? { on: !!c.desired_states?.on, endsAt: Date.now() + c.remain * 1000 } : null,
        schedules: schedules.rules.map(publicRule),
        limits: { countdown: true, days: true, maxSchedules: schedules.max },
    };
}

// `minutes` 0 cancels.
export async function setCountdown(plug, { on, minutes }, account) {
    const existing = (await call(plug, account, 'get_countdown_rules', {})).rule_list?.[0];
    const delay = Math.round(minutes * 60);
    if (!delay) {
        if (existing?.enable) await call(plug, account, 'edit_countdown_rule', { ...existing, enable: false, remain: 0 });
    } else {
        const rule = { delay, desired_states: { on }, enable: true, remain: delay };
        if (existing) await call(plug, account, 'edit_countdown_rule', { ...existing, ...rule });
        else await call(plug, account, 'add_countdown_rule', rule);
    }
    return getTimers(plug, account);
}

// Adds a rule, or changes the one with `id`. Only the fields given are changed.
export async function saveSchedule(plug, { id, on, minute, days, enabled }, account) {
    const clock = await deviceClock(plug, account);
    const { rules } = await scheduleRules(plug, account);
    const old = id ? rules.find(r => r.id === id) : null;
    if (id && !old) throw Object.assign(new Error('That schedule has gone; it may have been changed in the Tapo app'), { status: 404 });
    const rule = old ? { ...old } : {
        enable: true, mode: 'repeat', s_type: 'normal', s_min: 0, e_type: 'normal', e_min: 0, e_action: 'none',
        time_offset: 0, week_day: 127, desired_states: { on: true },
    };
    if (on !== undefined) rule.desired_states = { ...rule.desired_states, on };
    if (minute !== undefined) Object.assign(rule, { s_type: 'normal', s_min: minute, time_offset: 0 });
    if (days !== undefined) Object.assign(rule, { mode: 'repeat', week_day: maskFromDays(days) });
    if (enabled !== undefined) rule.enable = enabled;
    if (rule.mode === 'repeat') Object.assign(rule, nextRunDate(clock, rule.s_min, daysFromMask(rule.week_day)));
    await call(plug, account, old ? 'edit_schedule_rule' : 'add_schedule_rule', rule);
    return getTimers(plug, account);
}

export async function deleteSchedule(plug, id, account) {
    await call(plug, account, 'remove_schedule_rules', { remove_all: false, rule_list: [{ id }] });
    return getTimers(plug, account);
}
