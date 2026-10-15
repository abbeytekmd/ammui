// Twinkly LED lights, over the controller's local HTTP API ("xled"). They answer a discovery
// broadcast on UDP 5555, and need no account: a challenge/verify handshake gives a token that
// lasts a few hours. There's no plain "on" - the lights are on in whatever mode they're showing
// (movie, playlist, colour, effect), so turning them on restores the last of those seen.
// Units paired in the Twinkly app report a group ({ mode: 'master'|'slave', uid }); index.js
// shows each group as one device.
import dgram from 'dgram';
import crypto from 'crypto';

const TIMEOUT = 4000;
const ON_MODES = ['movie', 'playlist', 'color', 'effect'];

// Broadcasts the discovery probe and calls onFound({ ip, id, mac, model, name, group }) for each
// controller that replies within `waitMs`. The details come from its gestalt, which needs no
// login; the group needs one, so it's left out if that fails.
export function discover(onFound, waitMs = 3000) {
    return new Promise(resolve => {
        const seen = new Set();
        const lookups = [];
        const sock = dgram.createSocket('udp4');
        sock.on('message', (msg, rinfo) => {
            // Reply: 4 bytes of IP address, "OK", then the device name
            if (msg.length < 6 || msg.subarray(4, 6).toString() !== 'OK' || seen.has(rinfo.address)) return;
            seen.add(rinfo.address);
            lookups.push(request(rinfo.address, 'GET', 'gestalt').then(async g => onFound({
                ip: rinfo.address, id: g.uuid, mac: g.mac, model: g.product_code, name: g.device_name,
                group: await call({ ip: rinfo.address }, 'GET', 'summary').then(groupOf, () => null),
            })).catch(() => { }));
        });
        sock.on('error', err => {
            console.warn('[SMART-HOME] Twinkly discovery failed:', err.message);
            try { sock.close(); } catch (e) { }
            resolve();
        });
        sock.bind(() => {
            sock.setBroadcast(true);
            const probe = Buffer.from('\x01discover');
            for (let i = 0; i < 3; i++) setTimeout(() => sock.send(probe, 5555, '255.255.255.255', () => { }), i * 400);
        });
        setTimeout(async () => {
            try { sock.close(); } catch (e) { }
            await Promise.all(lookups);
            resolve();
        }, waitMs);
    });
}

async function request(ip, method, path, body, token) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers['X-Auth-Token'] = token;
    let res;
    try {
        res = await fetch(`http://${ip}/xled/v1/${path}`, {
            method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT),
        });
    } catch (err) {
        throw new Error(err.name === 'TimeoutError' ? 'No reply from the lights' : err.message);
    }
    if (res.status === 401) throw Object.assign(new Error('Login expired'), { expired: true });
    if (!res.ok) throw new Error(`The lights replied ${res.status}`);
    const data = await res.json();
    if (data.code != null && data.code !== 1000) throw new Error(`The lights refused (code ${data.code})`);
    return data;
}

const tokens = new Map();   // ip -> { token, expires } | { pending }
const lastMode = new Map(); // plug id -> the last "on" mode seen

function login(ip) {
    const cached = tokens.get(ip);
    if (cached?.pending) return cached.pending;
    if (cached && Date.now() < cached.expires) return Promise.resolve(cached.token);
    const pending = (async () => {
        const challenge = crypto.randomBytes(32).toString('base64');
        const r = await request(ip, 'POST', 'login', { challenge });
        await request(ip, 'POST', 'verify', { 'challenge-response': r['challenge-response'] }, r.authentication_token);
        // Renew a minute early rather than have a request bounce
        const expires = Date.now() + ((r.authentication_token_expires_in || 14400) - 60) * 1000;
        tokens.set(ip, { token: r.authentication_token, expires });
        return r.authentication_token;
    })();
    tokens.set(ip, { pending });
    pending.catch(() => tokens.delete(ip));
    return pending;
}

// An authenticated request; logs in again once if the token has run out.
async function call(plug, method, path, body) {
    try {
        return await request(plug.ip, method, path, body, await login(plug.ip));
    } catch (err) {
        if (!err.expired) throw err;
        tokens.delete(plug.ip);
        return request(plug.ip, method, path, body, await login(plug.ip));
    }
}

export function forget(id) {
    lastMode.delete(id);
}

// { mode, uid } from a summary. Ungrouped is { mode: 'none' } rather than null, so that it
// replaces a group that's been split up in the app.
function groupOf(summary) {
    const g = summary.group;
    return g?.uid && g.mode !== 'none' ? { mode: g.mode, uid: g.uid } : { mode: 'none' };
}

// One outlet ("0"), on unless the mode is "off", with its brightness (1-100), plus its group.
export async function getStatus(plug) {
    const summary = await call(plug, 'GET', 'summary');
    const mode = summary.led_mode?.mode;
    if (ON_MODES.includes(mode)) lastMode.set(plug.id, mode);
    // Brightness "disabled" means it isn't dimmed at all
    const bright = summary.filters?.find(f => f.filter === 'brightness')?.config;
    const brightness = !bright || bright.mode === 'disabled' ? 100 : bright.value;
    return { outlets: [{ id: '0', on: mode !== 'off', brightness }], group: groupOf(summary) };
}

export async function setOutlet(plug, outletId, on) {
    await call(plug, 'POST', 'led/mode', { mode: on ? lastMode.get(plug.id) || 'movie' : 'off' });
    return getStatus(plug);
}

export async function setBrightness(plug, value) {
    await call(plug, 'POST', 'led/out/brightness', { mode: 'enabled', type: 'A', value });
    return getStatus(plug);
}

// ─── Timers ──────────────────────────────────────────────────────────────────
// The controller has one daily on time and one daily off time (seconds after midnight, -1 for
// none), with no countdown and no choice of days. They're shown as up to two schedules, "on" and
// "off". Its clock is whatever it was last given as time_now, so every change sends this server's
// local time; units that the Twinkly app hasn't given a timezone won't follow clock changes by
// themselves until the timer is next saved.

const EVERY_DAY = [true, true, true, true, true, true, true];

const secondsToday = () => {
    const d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
};

export async function getTimers(plug) {
    const t = await call(plug, 'GET', 'timer');
    const rule = (id, at) => at >= 0 ? [{ id, on: id === 'on', minute: Math.floor(at / 60), enabled: true, days: EVERY_DAY, at: null }] : [];
    return {
        countdown: null,
        schedules: [...rule('on', t.time_on), ...rule('off', t.time_off)],
        limits: { countdown: false, days: false, maxSchedules: 2, onePerAction: true },
    };
}

async function setTimer(plug, changes) {
    const t = await call(plug, 'GET', 'timer');
    await call(plug, 'POST', 'timer', { time_now: secondsToday(), time_on: t.time_on, time_off: t.time_off, ...changes });
}

// A rule is the on time or the off time; saving one with the other action moves it across.
export async function saveSchedule(plug, { id, on, minute, enabled }) {
    const action = on ?? id === 'on';
    const t = await call(plug, 'GET', 'timer');
    const current = id ? t[`time_${id}`] : -1;
    const at = minute !== undefined ? minute * 60 : current;
    if (!(at >= 0)) throw Object.assign(new Error('Pick a time'), { status: 400 });
    const changes = { [`time_${action ? 'on' : 'off'}`]: enabled === false ? -1 : at };
    if (id && id !== (action ? 'on' : 'off')) changes[`time_${id}`] = -1;
    await setTimer(plug, changes);
    return getTimers(plug);
}

export async function deleteSchedule(plug, id) {
    if (id !== 'on' && id !== 'off') throw Object.assign(new Error('Unknown schedule'), { status: 404 });
    await setTimer(plug, { [`time_${id}`]: -1 });
    return getTimers(plug);
}
