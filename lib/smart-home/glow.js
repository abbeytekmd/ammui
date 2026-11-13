// Smart meter readings through Hildebrand's Glowmarkt API, the service behind the Bright app.
// Bright fetches the meter's half-hourly readings from the national smart meter network (DCC), so
// they arrive with a lag of an hour or more: this is history, not a live power reading.
//
// The login is the Bright app's, saved as { username, password } in the "glowAccount" setting.
// Readings are summed per period by the API; consumption is in kWh and cost in pence. Daily and
// monthly costs already include the standing charge (half-hourly ones are the units alone).
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

// [[unixSeconds, value], ...] summed per `period` (PT30M for up to 10 days, P1D for up to 31, P1M for up to 365)
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

// The tariff the supplier has put on the meter (through the DCC), in pence:
// { type, from, standingCharge, rates: [{ tier, rate, ratePerM3 }] }. More than one rate is a
// multi-rate tariff such as Economy 7. It rarely changes, so it's only asked for a few times a day.
const TARIFF_TTL = 6 * 60 * 60 * 1000;
const tariffs = new Map(); // resourceId -> { at, data }

async function getTariff(resourceId) {
    const cached = tariffs.get(resourceId);
    if (cached && Date.now() - cached.at < TARIFF_TTL) return cached.data;
    let data = null;
    try {
        const reply = await api('get', `/resource/${resourceId}/tariff`);
        const t = reply?.data?.[0];
        if (t) {
            const details = (t.structure || t.plan || []).flatMap(s => s.planDetail || []);
            const standing = t.currentRates?.standingCharge ?? details.find(d => d.standing != null)?.standing;
            const rates = details.filter(d => d.rate != null)
                .map(d => ({ tier: d.tier ?? null, rate: Number(d.rate), ratePerM3: d.ratem3 != null ? Number(d.ratem3) : null }));
            if (!rates.length && t.currentRates?.rate != null) rates.push({ tier: null, rate: Number(t.currentRates.rate), ratePerM3: null });
            data = {
                type: t.type || null,
                from: t.from ? String(t.from).slice(0, 10) : null,
                standingCharge: standing != null ? Number(standing) : null,
                rates,
            };
        }
    } catch (err) {
        log(`Couldn't get the tariff: ${err.message}`);
        if (cached) return cached.data; // keep the last one rather than lose it
    }
    tariffs.set(resourceId, { at: Date.now(), data });
    return data;
}

const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const sumRange = (days, from, to) => days.filter(d => d.date >= from && d.date <= to)
    .reduce((acc, d) => ({ kwh: acc.kwh + d.kwh, pence: acc.pence + d.pence }), { kwh: 0, pence: 0 });
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const COMPARE_DAYS = 7; // today against the 7 days before it
const COMPARE_WEEKS = 7; // this week (from Monday) against the 7 weeks before it
const RECENT_DAYS = 30; // the last 30 days day by day, against the 30 before them
const CHART_MONTHS = 12; // monthly totals, up to and including last month

// Daily readings over any span, asked for in chunks under the API's 31-day P1D limit
async function dailyReadings(resourceId, from, to) {
    const chunks = [];
    for (let start = from; start <= to; start = addDays(start, 28)) {
        const end = addDays(start, 27);
        chunks.push(readings(resourceId, start, end < to ? new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59) : to, 'P1D'));
    }
    return (await Promise.all(chunks)).flat();
}

// Monthly readings over any span, asked for six months at a time: the API's P1M limit is 365 days, which a
// whole year including 29 February would go over
async function monthlyReadings(resourceId, from, to) {
    const chunks = [];
    for (let start = from; start <= to; start = new Date(start.getFullYear(), start.getMonth() + 6, 1)) {
        const end = new Date(start.getFullYear(), start.getMonth() + 6, 0, 23, 59, 59);
        chunks.push(readings(resourceId, start, end < to ? end : to, 'P1M'));
    }
    return (await Promise.all(chunks)).flat();
}

async function fuelSummary(fuel, ids, now) {
    const today = startOfDay(now);
    const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    // "Last month" is the calendar month before this one
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const monthsFrom = new Date(today.getFullYear(), today.getMonth() - CHART_MONTHS, 1);
    const yearBefore = new Date(monthsFrom.getFullYear() - 1, monthsFrom.getMonth(), 1); // for each month's total a year earlier
    const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);
    // Weeks start on Monday. The daily readings cover the weeks being compared and the last 60 days.
    const weekStart = addDays(today, -((today.getDay() + 6) % 7));
    const weeksFrom = addDays(weekStart, -7 * COMPARE_WEEKS);
    const recentFrom = addDays(today, -2 * RECENT_DAYS);
    const from = weeksFrom < recentFrom ? weeksFrom : recentFrom;
    // Today is only part of a day, so it's compared with the other days up to the same time. Those are the
    // days before it, and the same weekday in each earlier week (for the week so far): half-hourly for both.
    const endOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
    const earlierWeekdays = Array.from({ length: COMPARE_WEEKS - 1 }, (_, i) => addDays(today, -7 * (i + 2)));

    const [tariff, halfHours, dailyKwh, dailyCost, monthlyKwh, monthlyCost, ...earlierHalfHours] = await Promise.all([
        getTariff(ids.consumption),
        readings(ids.consumption, addDays(today, -COMPARE_DAYS), endOfToday, 'PT30M'),
        dailyReadings(ids.consumption, from, endOfToday),
        ids.cost ? dailyReadings(ids.cost, from, endOfToday) : Promise.resolve([]),
        monthlyReadings(ids.consumption, yearBefore, endOfLastMonth),
        ids.cost ? monthlyReadings(ids.cost, yearBefore, endOfLastMonth) : Promise.resolve([]),
        ...earlierWeekdays.map(d => readings(ids.consumption, d, endOf(d), 'PT30M')),
    ]);
    const costByDate = new Map(dailyCost.map(([t, v]) => [localDate(new Date(t * 1000)), v]));
    const kwhByDate = new Map(dailyKwh.map(([t, v]) => [localDate(new Date(t * 1000)), v]));
    const days = [];
    for (let d = from; d <= today; d = addDays(d, 1)) {
        const date = localDate(d);
        days.push({ date, kwh: kwhByDate.get(date) || 0, pence: costByDate.get(date) || 0 });
    }
    // Slots the meter hasn't reported yet come back as 0, so today's last non-zero one is how far the data goes
    const todayKey = localDate(today);
    const lastReported = [...halfHours].reverse().find(([t, v]) => v > 0 && localDate(new Date(t * 1000)) === todayKey);
    // Each earlier day's kWh up to the same time of day (the half-hours before the cutoff, in minutes after midnight)
    const minuteOf = d => d.getHours() * 60 + d.getMinutes();
    const cutoff = lastReported ? minuteOf(new Date(lastReported[0] * 1000)) + 30 : 0;
    const byNow = new Map();
    for (const [t, v] of [halfHours, ...earlierHalfHours].flat()) {
        const d = new Date(t * 1000);
        if (minuteOf(d) < cutoff) byNow.set(localDate(d), (byNow.get(localDate(d)) || 0) + v);
    }
    const tidy = ({ kwh, pence }) => ({ kwh: round(kwh), pence: round(pence) });
    const recentDays = [];
    for (let i = COMPARE_DAYS; i >= 1; i--) {
        const date = localDate(addDays(today, -i));
        recentDays.push({ date, ...tidy(sumRange(days, date, date)), byNow: round(byNow.get(date) || 0) });
    }
    // Earlier weeks' totals, and how much they'd used by the same point (the same weekday and time)
    const weeks = [];
    for (let w = COMPARE_WEEKS; w >= 1; w--) {
        const start = addDays(weekStart, -7 * w);
        const sameDay = addDays(today, -7 * w);
        const sofar = sumRange(days, localDate(start), localDate(addDays(sameDay, -1))).kwh + (byNow.get(localDate(sameDay)) || 0);
        weeks.push({ from: localDate(start), to: localDate(addDays(start, 6)), ...tidy(sumRange(days, localDate(start), localDate(addDays(start, 6)))), byNow: round(sofar) });
    }
    // Monthly sums are stamped at the month's start; midday on that day is safely inside the month whatever the clocks did
    const monthKey = t => localDate(new Date(t * 1000 + 12 * 60 * 60 * 1000)).slice(0, 7);
    const kwhByMonth = new Map(monthlyKwh.map(([t, v]) => [monthKey(t), v]));
    const costByMonth = new Map(monthlyCost.map(([t, v]) => [monthKey(t), v]));
    const monthTotal = key => tidy({ kwh: kwhByMonth.get(key) || 0, pence: costByMonth.get(key) || 0 });
    const months = [];
    for (let m = monthsFrom; m <= lastMonthStart; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
        const month = localDate(m).slice(0, 7);
        const before = localDate(new Date(m.getFullYear() - 1, m.getMonth(), 1)).slice(0, 7);
        // lastYear is null when the meter has nothing for that month (before it was installed, say)
        months.push({ month, ...monthTotal(month), lastYear: kwhByMonth.get(before) > 0 ? monthTotal(before) : null });
    }
    return {
        fuel,
        hasCost: !!ids.cost,
        tariff, // null when the meter has none
        today: { ...tidy(sumRange(days, localDate(today), localDate(today))), dataTo: lastReported ? (lastReported[0] + 1800) * 1000 : null },
        recentDays, // the 7 days before today, oldest first; byNow is each one's kWh up to today's dataTo time
        thisWeek: { from: localDate(weekStart), ...tidy(sumRange(days, localDate(weekStart), todayKey)) },
        weeks, // the 7 weeks before this one, oldest first; byNow is each one's kWh by the same weekday and time
        last30: days.filter(d => d.date >= localDate(addDays(today, -RECENT_DAYS)) && d.date < todayKey).map(d => ({ ...d, ...tidy(d) })), // oldest first, today not included
        previous30: tidy(sumRange(days, localDate(recentFrom), localDate(addDays(today, -RECENT_DAYS - 1)))), // the 30 days before those
        months, // calendar months, oldest first; the last one is last month
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
