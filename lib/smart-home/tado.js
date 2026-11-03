// Heating through tado°'s cloud API: the rooms of a tado home, their temperatures, and the
// target each is heating to. tado has no local API, so everything goes through their servers.
//
// Signing in uses tado's device code flow: the person opens a link, logs in on tado's site and
// confirms a code, and we're given a refresh token. tado replaces the refresh token every time
// it's used, so the newest is saved each time (in the "tadoAccount" setting); for the same reason
// it isn't shared with other installs, as the two would sign each other out.
//
// tado limits how many calls an account may make a day (a small allowance without an Auto-Assist
// subscription), and says how many are left in every reply. All rooms are read in one call and
// kept for a share of what's left of the day, with some held back for changes made from here.
//
// Two generations of home: V3+ uses my.tado.com (zones, changed with an "overlay"); tado X uses
// hops.tado.com (rooms, changed with "manual control"). Both are shown as rooms of one shape:
//   { id, name, temperature, humidity, heating (% of power), on, target, manual, until,
//     next: { at, on, target } | null, openWindow, online }
// A change made here lasts until the room's next scheduled change.
import axios from 'axios';

const AUTH = 'https://login.tado.com/oauth2';
const CLIENT_ID = '1bb50063-6b0c-4d11-bd99-387f4a91cc46'; // tado's web app's, which every client uses
const API = 'https://my.tado.com/api/v2';
const HOPS = 'https://hops.tado.com';
const MIN_TTL = 2 * 60 * 1000;
const DEFAULT_TTL = 10 * 60 * 1000; // until tado has said how many calls are left
const ZONES_TTL = 6 * 60 * 60 * 1000; // V3+ room names, which rarely change
const RESERVE = 15; // calls held back for changes made from here
const KEEPALIVE = 24 * 60 * 60 * 1000; // an unused refresh token expires after 30 days
export const MIN_TARGET = 5;
export const MAX_TARGET = 25;

let store = null;
let account = null; // { refreshToken, homeId, homeName, generation: 'PRE_LINE_X' | 'LINE_X' }
let access = null; // { token, exp }
let refreshing = null;
let pairing = null; // { deviceCode, userCode, url, expiresAt, interval, error? }
let zones = null; // { at, list: [{ id, name }] }
let rooms = null; // { at, list }
let reading = null;
let allowance = null; // { remaining, resetAt }

const log = (...args) => console.log('[TADO]', ...args);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isX = () => account?.generation === 'LINE_X';
const fail = (message, extra) => Object.assign(new Error(message), extra);

export function init({ getSetting, setSetting }) {
    store = { getSetting, setSetting };
    account = getSetting('tadoAccount', null);
    setInterval(() => { if (account?.refreshToken) accessToken().catch(() => { }); }, KEEPALIVE);
}

const save = () => store.setSetting('tadoAccount', account);
export const isConfigured = () => !!(account?.refreshToken && account.homeId);

// ─── Signing in ──────────────────────────────────────────────────────────────

async function tokenRequest(form) {
    try {
        const body = new URLSearchParams({ client_id: CLIENT_ID, ...form });
        return (await axios.post(`${AUTH}/token`, body, { timeout: 20000 })).data;
    } catch (err) {
        const code = err.response?.data?.error;
        throw fail(err.response?.data?.error_description || code || err.message, { code });
    }
}

function keepTokens(reply) {
    access = { token: reply.access_token, exp: Date.now() + (reply.expires_in || 600) * 1000 };
    if (reply.refresh_token && reply.refresh_token !== account?.refreshToken) {
        account = { ...account, refreshToken: reply.refresh_token };
        save();
    }
}

async function accessToken() {
    if (access && access.exp - Date.now() > 30000) return access.token;
    if (!account?.refreshToken) throw fail('Connect your tado° account in Settings', { status: 401, needsLogin: true });
    refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refreshToken })
        .then(keepTokens)
        .catch(err => {
            if (err.code !== 'invalid_grant') throw err;
            account = { ...account, refreshToken: null };
            save();
            log('Signed out by tado');
            throw fail('tado° has signed this device out. Connect again in Settings.', { status: 401, needsLogin: true });
        })
        .finally(() => { refreshing = null; });
    await refreshing;
    return access.token;
}

// Starts signing in: gives the link and code to confirm on tado's site, and waits for it in the background.
export async function startPairing() {
    let reply;
    try {
        const body = new URLSearchParams({ client_id: CLIENT_ID, scope: 'offline_access' });
        reply = (await axios.post(`${AUTH}/device_authorize`, body, { timeout: 20000 })).data;
    } catch (err) {
        throw fail(`Couldn't reach tado°: ${err.response?.data?.error_description || err.message}`, { status: 502 });
    }
    const p = pairing = {
        deviceCode: reply.device_code,
        userCode: reply.user_code,
        url: reply.verification_uri_complete || reply.verification_uri,
        expiresAt: Date.now() + (reply.expires_in || 300) * 1000,
        interval: reply.interval || 5,
    };
    waitForPairing(p);
    return getAccount();
}

async function waitForPairing(p) {
    while (pairing === p && Date.now() < p.expiresAt) {
        await sleep(p.interval * 1000);
        if (pairing !== p) return;
        try {
            const reply = await tokenRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: p.deviceCode });
            account = { refreshToken: null };
            keepTokens(reply);
            await findHome();
            if (pairing === p) pairing = null;
            return;
        } catch (err) {
            if (err.code === 'authorization_pending') continue;
            if (err.code === 'slow_down') { p.interval += 5; continue; }
            p.error = err.message;
            return;
        }
    }
    if (pairing === p) p.error = 'The code expired before it was confirmed. Try connecting again.';
}

// The account's home (the first, if there are several) and which generation it is.
async function findHome() {
    const me = await call('get', `${API}/me`);
    const home = me.homes?.[0];
    if (!home) throw fail('This tado° account has no home set up');
    const details = await call('get', `${API}/homes/${home.id}`);
    account = { ...account, homeId: home.id, homeName: home.name, generation: details.generation || 'PRE_LINE_X' };
    zones = rooms = null;
    save();
    log(`Connected to ${home.name} (${account.generation === 'LINE_X' ? 'tado X' : 'V3+'})`);
}

export function getAccount() {
    return {
        connected: isConfigured(),
        signedOut: !!account?.homeId && !account.refreshToken,
        homeName: account?.homeName || null,
        generation: account?.generation === 'LINE_X' ? 'tado X' : account?.homeId ? 'V3+' : null,
        pairing: pairing ? { userCode: pairing.userCode, url: pairing.url, error: pairing.error || null } : null,
        allowance: allowance ? { remaining: allowance.remaining } : null,
    };
}

export function disconnect() {
    account = null;
    access = pairing = zones = rooms = allowance = null;
    store.setSetting('tadoAccount', null);
    log('Disconnected');
    return getAccount();
}

// ─── Calls ───────────────────────────────────────────────────────────────────

// tado's "RateLimit" header, e.g. `"perday";r=87;t=34200`: r calls left, t seconds until more.
function noteAllowance(headers) {
    const h = headers?.ratelimit;
    const r = /r=(\d+)/.exec(h || '');
    if (!r) return;
    const t = /t=(\d+)/.exec(h);
    const midnight = new Date().setHours(24, 0, 0, 0);
    allowance = { remaining: +r[1], resetAt: t ? Date.now() + t[1] * 1000 : midnight };
}

async function call(method, url, data, retried = false) {
    const token = await accessToken();
    try {
        const res = await axios({ method, url, data, headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
        noteAllowance(res.headers);
        return res.data;
    } catch (err) {
        noteAllowance(err.response?.headers);
        const status = err.response?.status;
        if (status === 401 && !retried) {
            access = null;
            return call(method, url, data, true);
        }
        if (status === 429) throw fail("tado°'s limit on requests for today has been reached. It resets within a day.", { status: 429 });
        const d = err.response?.data;
        const msg = d?.errors?.[0]?.title || d?.message || err.message;
        throw fail(`tado°: ${msg}`, { status: status >= 400 && status < 500 ? status : 502 });
    }
}

// How long to keep room states: the rest of the day's allowance spread over the time left.
function roomsTtl() {
    if (!allowance) return DEFAULT_TTL;
    const untilReset = Math.max(0, allowance.resetAt - Date.now());
    const spare = allowance.remaining - RESERVE;
    if (spare <= 0) return Math.max(DEFAULT_TTL, untilReset);
    return Math.max(MIN_TTL, untilReset / spare);
}

// ─── Rooms ───────────────────────────────────────────────────────────────────

async function readZones() {
    if (zones && Date.now() - zones.at < ZONES_TTL) return zones.list;
    const list = await call('get', `${API}/homes/${account.homeId}/zones`);
    zones = { at: Date.now(), list: list.filter(z => z.type === 'HEATING').map(z => ({ id: String(z.id), name: z.name })) };
    return zones.list;
}

const round1 = v => typeof v === 'number' ? Math.round(v * 10) / 10 : null;

function fromZoneState(zone, s = {}) {
    const on = s.setting?.power === 'ON';
    const next = s.nextScheduleChange;
    return {
        id: zone.id,
        name: zone.name,
        temperature: round1(s.sensorDataPoints?.insideTemperature?.celsius),
        humidity: round1(s.sensorDataPoints?.humidity?.percentage),
        heating: s.activityDataPoints?.heatingPower?.percentage ?? null,
        on,
        target: on ? s.setting?.temperature?.celsius ?? null : null,
        manual: !!s.overlay,
        until: s.overlay?.termination?.projectedExpiry || null,
        next: next ? { at: next.start, on: next.setting?.power === 'ON', target: next.setting?.temperature?.celsius ?? null } : null,
        openWindow: !!(s.openWindow || s.openWindowDetected),
        online: s.link?.state !== 'OFFLINE',
    };
}

function fromRoomX(r) {
    const on = r.setting?.power === 'ON';
    const next = r.nextScheduleChange;
    return {
        id: String(r.id),
        name: r.name,
        temperature: round1(r.sensorDataPoints?.insideTemperature?.value),
        humidity: round1(r.sensorDataPoints?.humidity?.percentage),
        heating: r.heatingPower?.percentage ?? null,
        on,
        target: on ? r.setting?.temperature?.value ?? null : null,
        manual: !!r.manualControlTermination,
        until: r.manualControlTermination?.projectedExpiry || null,
        next: next ? { at: next.start, on: next.setting?.power === 'ON', target: next.setting?.temperature?.value ?? null } : null,
        openWindow: !!r.openWindow?.activated,
        online: r.connection?.state !== 'DISCONNECTED',
    };
}

async function readRooms() {
    if (isX()) return (await call('get', `${HOPS}/homes/${account.homeId}/rooms`)).map(fromRoomX);
    const [list, states] = await Promise.all([readZones(), call('get', `${API}/homes/${account.homeId}/zoneStates`)]);
    return list.map(z => fromZoneState(z, states.zoneStates?.[z.id]));
}

// Room states, read again from tado once the kept copy is old (or with `force`).
async function getRooms(force = false) {
    if (!force && rooms && Date.now() - rooms.at < roomsTtl()) return rooms.list;
    reading ||= readRooms()
        .then(list => { rooms = { at: Date.now(), list }; return list; })
        .finally(() => { reading = null; });
    return reading;
}

// { configured, home, rooms, updatedAt, error?, needsLogin? }. A failed read still shows the last rooms known.
export async function listRooms() {
    if (!isConfigured()) return { configured: false, signedOut: getAccount().signedOut, rooms: [] };
    const result = { configured: true, home: account.homeName };
    try {
        await getRooms();
    } catch (err) {
        result.error = err.message;
        result.needsLogin = !!err.needsLogin;
    }
    return { ...result, rooms: rooms?.list || [], updatedAt: rooms?.at || null };
}

function findRoom(id) {
    if (!isConfigured()) throw fail('Connect your tado° account in Settings', { status: 400 });
    const room = rooms?.list.find(r => r.id === String(id));
    if (!room) throw fail('Unknown room', { status: 404 });
    return room;
}

// Heats a room to `target` (or turns it off) until its next scheduled change.
export async function setRoom(id, { on = true, target } = {}) {
    const room = findRoom(id);
    let t = null;
    if (on) {
        t = Math.round(Number(target ?? room.target ?? room.next?.target ?? 20) * 2) / 2;
        if (!(t >= MIN_TARGET && t <= MAX_TARGET)) throw fail(`The temperature must be ${MIN_TARGET}-${MAX_TARGET}°`, { status: 400 });
    }
    let until = room.next?.at || null;
    if (isX()) {
        await call('post', `${HOPS}/homes/${account.homeId}/rooms/${room.id}/manualControl`, {
            setting: { power: on ? 'ON' : 'OFF', temperature: on ? { value: t } : null },
            termination: { type: 'NEXT_TIME_BLOCK' },
        });
    } else {
        const overlay = await call('put', `${API}/homes/${account.homeId}/zones/${room.id}/overlay`, {
            setting: { type: 'HEATING', power: on ? 'ON' : 'OFF', temperature: on ? { celsius: t } : null },
            termination: { typeSkillBasedApp: 'NEXT_TIME_BLOCK' },
        });
        until = overlay?.termination?.projectedExpiry || until;
    }
    // Shown as set without reading every room again, to save calls
    Object.assign(room, { on, target: t, manual: true, until });
    log(`${room.name} ${on ? `set to ${t}°` : 'turned off'}`);
    return room;
}

// Drops a change made here (or in the tado app) so the room follows its schedule again.
export async function resumeSchedule(id) {
    const room = findRoom(id);
    if (isX()) await call('post', `${HOPS}/homes/${account.homeId}/rooms/${room.id}/resumeSchedule`);
    else await call('delete', `${API}/homes/${account.homeId}/zones/${room.id}/overlay`);
    log(`${room.name} back on its schedule`);
    // What the schedule wants now isn't known without asking
    const list = await getRooms(true).catch(() => null);
    return list?.find(r => r.id === room.id) || { ...room, manual: false, until: null };
}
