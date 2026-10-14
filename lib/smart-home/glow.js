// Smart meter readings through Hildebrand's Glowmarkt API, the service behind the Bright app.
// Bright fetches the meter's half-hourly readings from the national smart meter network (DCC), so
// they arrive with a lag of an hour or more: this is history, not a live power reading.
//
// The login is the Bright app's, saved as { username, password } in the "glowAccount" setting.
// Readings are summed per period by the API; consumption is in kWh and cost in pence.
import axios from 'axios';

const API = 'https://api.glowmarkt.com/api/v0-1';
const APPLICATION_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d'; // the Bright app's, which every client uses
const SUMMARY_TTL = 10 * 60 * 1000;
const CATCHUP_INTERVAL = 30 * 60 * 1000;
const FUELS = ['electricity', 'gas'];

let store = null;
let account = null;
let session = null; // { token, exp } (exp in ms)
let resources = null; // { electricity: { consumption, cost }, gas: {...} } resource ids
let summary = null; // { at, data }
let lastCatchup = 0;

const log = (...args) => console.log('[ENERGY]', ...args);

export function init({ getSetting, setSetting }) {
    store = { getSetting, setSetting };
    account = getSetting('glowAccount', null);
}

export function getAccount() {
    return { username: account?.username || '', hasPassword: !!account?.password };
}

// A blank password keeps the saved one. Logs in straight away so a wrong password shows up here.
export async function setAccount({ username, password }) {
    account = {
        username: String(username ?? account?.username ?? '').trim(),
        password: password ? String(password) : account?.password || '',
    };
    store.setSetting('glowAccount', account);
    session = resources = summary = null;
    if (account.username && account.password) await getSummary();
    return getAccount();
}

const isConfigured = () => !!(account?.username && account?.password);

async function request(method, path, { data, params } = {}) {
    const headers = { applicationId: APPLICATION_ID, 'Content-Type': 'application/json' };
    if (session) headers.token = session.token;
    try {
        return (await axios({ method, url: API + path, data, params, headers, timeout: 20000 })).data;
    } catch (err) {
        const msg = err.response?.data?.error || err.response?.data?.message || err.message;
        const e = new Error(typeof msg === 'string' ? msg : err.message);
        e.status = err.response?.status;
        throw e;
    }
}

async function login() {
    if (session && session.exp - Date.now() > 60 * 60 * 1000) return;
    session = null;
    const refused = () => Object.assign(new Error('Bright login was refused. Check the email and password.'), { status: 401 });
    const reply = await request('post', '/auth', { data: { username: account.username, password: account.password } })
        .catch(err => { throw err.status === 401 ? refused() : err; });
    if (!reply?.valid || !reply.token) throw refused();
    session = { token: reply.token, exp: (reply.exp || 0) * 1000 || Date.now() + 24 * 60 * 60 * 1000 };
}

// Calls the API, logging in again once if the token has stopped working
async function api(method, path, opts) {
    await login();
    try {
        return await request(method, path, opts);
    } catch (err) {
        if (err.status !== 401) throw err;
        session = null;
        await login();
        return request(method, path, opts);
    }
}

async function findResources() {
    if (resources) return resources;
    // The entity list leaves out each resource's classifier, so the resources are asked for per entity
    const entities = await api('get', '/virtualentity');
    const lists = await Promise.all((entities || []).map(e => api('get', `/virtualentity/${e.veId}/resources`)));
    const found = {};
    for (const list of lists) {
        for (const r of list?.resources || []) {
            const [fuel, kind, extra] = String(r.classifier || '').split('.');
            if (!FUELS.includes(fuel) || kind !== 'consumption') continue;
            const field = extra === 'cost' ? 'cost' : extra ? null : 'consumption';
            if (!field) continue;
            found[fuel] ??= {};
            found[fuel][field] ??= r.resourceId;
        }
    }
    if (!Object.keys(found).length) throw new Error('The Bright account has no smart meter readings yet');
    resources = found;
    log(`Found readings for ${Object.keys(found).join(' and ')}.`);
    return found;
}

// Local wall-clock time as the API wants it: 2026-10-13T00:00:00
const pad = n => String(n).padStart(2, '0');
const localStamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const localDate = d => localStamp(d).slice(0, 10);
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// [[unixSeconds, value], ...] summed per `period` (PT30M for up to 10 days, P1D for up to 31)
async function readings(resourceId, from, to, period) {
    const reply = await api('get', `/resource/${resourceId}/readings`, {
        params: { from: localStamp(from), to: localStamp(to), period, function: 'sum', offset: from.getTimezoneOffset() },
    });
    return (reply?.data || []).map(([t, v]) => [t, Number(v) || 0]);
}

// Asks Glowmarkt to fetch anything new from the meter; the readings turn up on a later request
function catchup() {
    if (Date.now() - lastCatchup < CATCHUP_INTERVAL) return;
    lastCatchup = Date.now();
    for (const r of Object.values(resources || {})) {
        if (r.consumption) api('get', `/resource/${r.consumption}/catchup`).catch(() => { });
    }
}

const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const sumRange = (days, from, to) => days.filter(d => d.date >= from && d.date <= to)
    .reduce((acc, d) => ({ kwh: acc.kwh + d.kwh, pence: acc.pence + d.pence }), { kwh: 0, pence: 0 });
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const COMPARE_WEEKS = 6;

// Daily readings over any span, asked for in chunks under the API's 31-day P1D limit
async function dailyReadings(resourceId, from, to) {
    const chunks = [];
    for (let start = from; start <= to; start = addDays(start, 28)) {
        const end = addDays(start, 27);
        chunks.push(readings(resourceId, start, end < to ? new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59) : to, 'P1D'));
    }
    return (await Promise.all(chunks)).flat();
}

async function fuelSummary(fuel, ids, now) {
    const today = startOfDay(now);
    const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    // "Last week" is the seven whole days before today, compared with the six seven-day blocks before it
    const from = addDays(today, -7 * (COMPARE_WEEKS + 1));

    const [halfHours, dailyKwh, dailyCost] = await Promise.all([
        readings(ids.consumption, today, endOfToday, 'PT30M'),
        dailyReadings(ids.consumption, from, endOfToday),
        ids.cost ? dailyReadings(ids.cost, from, endOfToday) : Promise.resolve([]),
    ]);
    const costByDate = new Map(dailyCost.map(([t, v]) => [localDate(new Date(t * 1000)), v]));
    const kwhByDate = new Map(dailyKwh.map(([t, v]) => [localDate(new Date(t * 1000)), v]));
    const days = [];
    for (let d = from; d <= today; d = addDays(d, 1)) {
        const date = localDate(d);
        days.push({ date, kwh: kwhByDate.get(date) || 0, pence: costByDate.get(date) || 0 });
    }
    // Slots the meter hasn't reported yet come back as 0, so the last non-zero one is how far the data goes
    const lastReported = [...halfHours].reverse().find(([, v]) => v > 0);
    const tidy = ({ kwh, pence }) => ({ kwh: round(kwh), pence: round(pence) });
    const weeks = [];
    for (let w = COMPARE_WEEKS; w >= 0; w--) {
        const start = localDate(addDays(today, -7 * (w + 1)));
        const end = localDate(addDays(today, -7 * w - 1));
        weeks.push({ from: start, to: end, ...tidy(sumRange(days, start, end)) });
    }
    const lastWeekFrom = localDate(addDays(today, -7));
    return {
        fuel,
        hasCost: !!ids.cost,
        today: { ...tidy(sumRange(days, localDate(today), localDate(today))), dataTo: lastReported ? (lastReported[0] + 1800) * 1000 : null },
        lastWeek: days.filter(d => d.date >= lastWeekFrom && d.date < localDate(today)).map(d => ({ ...d, ...tidy(d) })),
        weeks, // oldest first; the last one is lastWeek's total
        month: tidy(sumRange(days, localDate(monthStart), localDate(today))),
    };
}

// { configured, fuels: [...], at } — cached for a few minutes, since the readings only move half-hourly
export async function getSummary({ refresh = false } = {}) {
    if (!isConfigured()) return { configured: false };
    if (!refresh && summary && Date.now() - summary.at < SUMMARY_TTL) return summary.data;
    const ids = await findResources();
    catchup();
    const now = new Date();
    const fuels = await Promise.all(FUELS.filter(f => ids[f]?.consumption).map(f => fuelSummary(f, ids[f], now)));
    const data = { configured: true, fuels, at: Date.now() };
    summary = { at: Date.now(), data };
    return data;
}
