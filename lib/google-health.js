// Steps and health figures for each family member from the Google Health API (the successor to the
// Fitbit Web API and Google Fit), shown on the Health tab.
//
// Setting up needs a Google Cloud project with the Google Health API switched on and an OAuth client
// of the "Web application" kind, its client id and secret saved as { clientId, clientSecret } in the
// "googleHealthClient" setting. Google's own setup guide has https://www.google.com as the client's
// redirect address, which suits a hub on a home network with no public address of its own: the person
// signs in to Google, lands on google.com with ?code=... on the end, and pastes that address back here.
// While the project's consent screen is in "Testing", each person's Google account has to be on its
// Test users list, and Google lets a sign-in last only 7 days before it has to be done again.
//
// Each family member (game_players) links their own Google account. Their refresh tokens are kept in
// the "googleHealthAccounts" setting as { [playerId]: { refreshToken (encrypted), connectedAt } }.
//
// What's read for each person, for the last DAYS days in their own timezone:
//   steps, distance, total calories, active zone minutes, average heart rate (daily roll-ups),
//   resting heart rate (one a day), sleep sessions, and their most recent weight.
// A figure Google won't give (not recorded, or a scope not granted) is left out rather than failing
// the whole card. Results are kept for TTL so the tab can be left open.
import axios from 'axios';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://health.googleapis.com/v4/users/me';
export const REDIRECT_URI = 'https://www.google.com';
const SCOPES = [
    'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
    'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
];
export const DAYS = 14; // total calories and heart rate roll-ups can't span more than 14 days
const WEIGHT_DAYS = 90;
const TTL = 15 * 60 * 1000;

let store = null;
let secrets = null; // { encrypt, decrypt }
let client = null; // { clientId, clientSecret }
let accounts = {}; // playerId -> { refreshToken, connectedAt }
const access = new Map(); // playerId -> { token, exp }
const cache = new Map(); // playerId -> { at, data }
const reading = new Map(); // playerId -> the read in progress

const log = (...args) => console.log('[HEALTH]', ...args);
const fail = (message, extra) => Object.assign(new Error(message), extra);

export function init({ getSetting, setSetting, encrypt, decrypt }) {
    store = { getSetting, setSetting };
    secrets = { encrypt, decrypt };
    client = getSetting('googleHealthClient', null);
    accounts = getSetting('googleHealthAccounts', {}) || {};
}

const isConfigured = () => !!(client?.clientId && client?.clientSecret);
const saveAccounts = () => store.setSetting('googleHealthAccounts', accounts);

// ─── The OAuth client ────────────────────────────────────────────────────────

export function getClient() {
    return { clientId: client?.clientId || '', hasSecret: !!client?.clientSecret, redirectUri: REDIRECT_URI };
}

// The whole client, for copying to another install
export function getCredentials() {
    return isConfigured() ? { clientId: client.clientId, clientSecret: client.clientSecret } : null;
}

// A blank secret keeps the saved one. A different client can't use the old one's sign-ins, so they're dropped.
export function setClient({ clientId, clientSecret }) {
    const id = String(clientId ?? client?.clientId ?? '').trim();
    const changed = id !== (client?.clientId || '');
    client = { clientId: id, clientSecret: clientSecret ? String(clientSecret).trim() : client?.clientSecret || '' };
    store.setSetting('googleHealthClient', client);
    if (changed && Object.keys(accounts).length) {
        accounts = {};
        saveAccounts();
        log('Client id changed: everyone will need to connect again');
    }
    access.clear();
    cache.clear();
    return getClient();
}

// ─── Linking a person ────────────────────────────────────────────────────────

// The Google sign-in page for one person; state carries who it's for so a pasted code can be checked
export function connectUrl(playerId) {
    if (!isConfigured()) throw fail('Add the Google Health client id and secret in Settings first', { status: 400 });
    const params = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent', // always hands back a refresh token, even for an account linked before
        include_granted_scopes: 'true',
        state: playerId,
    });
    return `${AUTH_URL}?${params}`;
}

// Takes the code from what was pasted: the whole google.com address it landed on, or just the code
function codeFrom(text, playerId) {
    const raw = String(text || '').trim();
    if (!raw) throw fail('Paste the address Google sent you to', { status: 400 });
    if (!/^https?:\/\//i.test(raw) && !raw.includes('code=')) return raw;
    let params;
    try {
        params = new URL(raw.includes('://') ? raw : `https://www.google.com/?${raw.replace(/^[?#]/, '')}`).searchParams;
    } catch {
        throw fail("That doesn't look like the address Google sent you to", { status: 400 });
    }
    if (params.get('error')) throw fail(`Google said: ${params.get('error')}`, { status: 400 });
    if (params.get('state') && params.get('state') !== playerId) throw fail('That sign-in was started for someone else', { status: 400 });
    const code = params.get('code');
    if (!code) throw fail("There's no code in that address. Copy the whole address from the browser's address bar.", { status: 400 });
    return code;
}

async function tokenRequest(form) {
    try {
        const body = new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...form });
        return (await axios.post(TOKEN_URL, body, { timeout: 20000 })).data;
    } catch (err) {
        const code = err.response?.data?.error;
        throw fail(err.response?.data?.error_description || code || err.message, { code, status: 502 });
    }
}

export async function connect(playerId, pasted) {
    if (!isConfigured()) throw fail('Add the Google Health client id and secret in Settings first', { status: 400 });
    const code = codeFrom(pasted, playerId);
    const reply = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
    if (!reply.refresh_token) throw fail("Google didn't give a lasting sign-in. Try connecting again.", { status: 502 });
    access.set(playerId, { token: reply.access_token, exp: Date.now() + (reply.expires_in || 3600) * 1000 });
    // Checks the account has Google Health set up (the person has to have signed in to the Google Health app)
    try {
        await api(playerId, 'get', '/identity');
    } catch (err) {
        access.delete(playerId);
        throw fail(`Signed in, but Google Health isn't set up on that account: ${err.message}. ` +
            'Sign in to the Google Health app on a phone with that account first.', { status: 400 });
    }
    accounts[playerId] = { refreshToken: secrets.encrypt(reply.refresh_token), connectedAt: new Date().toISOString() };
    saveAccounts();
    cache.delete(playerId);
    log(`Connected an account for ${playerId}`);
    return { connected: true };
}

export function disconnect(playerId) {
    const had = !!accounts[playerId];
    const token = had ? refreshTokenOf(playerId) : null;
    delete accounts[playerId];
    access.delete(playerId);
    cache.delete(playerId);
    if (had) saveAccounts();
    // Tell Google too, so the link disappears from the person's account; fine if it fails
    if (token) axios.post('https://oauth2.googleapis.com/revoke', new URLSearchParams({ token }), { timeout: 10000 }).catch(() => { });
    return { connected: false };
}

function refreshTokenOf(playerId) {
    try {
        return secrets.decrypt(accounts[playerId]?.refreshToken) || null;
    } catch {
        return null; // locked with another server's key (a database restored from elsewhere)
    }
}

async function accessToken(playerId) {
    const a = access.get(playerId);
    if (a && a.exp - Date.now() > 60000) return a.token;
    const refreshToken = refreshTokenOf(playerId);
    if (!refreshToken) throw fail('Connect again to Google Health', { needsLogin: true });
    try {
        const reply = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
        access.set(playerId, { token: reply.access_token, exp: Date.now() + (reply.expires_in || 3600) * 1000 });
        return reply.access_token;
    } catch (err) {
        if (err.code !== 'invalid_grant') throw err;
        delete accounts[playerId];
        saveAccounts();
        log(`Sign-in for ${playerId} has expired or been withdrawn`);
        throw fail('The Google sign-in has expired (in testing, Google ends them after 7 days). Connect again.', { needsLogin: true });
    }
}

async function api(playerId, method, path, { params, data } = {}) {
    const token = await accessToken(playerId);
    try {
        return (await axios({
            method, url: `${API}${path}`, params, data, timeout: 20000,
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        })).data;
    } catch (err) {
        const e = err.response?.data?.error;
        throw fail(e?.message || err.message, { status: err.response?.status });
    }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

const pad = n => String(n).padStart(2, '0');
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const civilDate = d => ({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
const keyOfCivil = c => c?.date ? `${c.date.year}-${pad(c.date.month)}-${pad(c.date.day)}` : null;
const keyOfDate = d => d ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : null;
const num = v => v == null || v === '' ? null : Number(v);

function daysBack(n) {
    const today = new Date();
    return Array.from({ length: n }, (_, i) => dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - i))));
}

// Daily totals of one data type from the first day shown through today: { 'YYYY-MM-DD': value object }
async function dailyRollUp(playerId, dataType, days) {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const reply = await api(playerId, 'post', `/dataTypes/${dataType}/dataPoints:dailyRollUp`, {
        data: {
            range: { start: { date: civilDate(start), time: { hours: 0 } }, end: { date: civilDate(end), time: { hours: 0 } } },
            windowSizeDays: 1,
        },
    });
    const out = {};
    for (const p of reply.rollupDataPoints || reply.dailyRollupDataPoints || []) {
        const key = keyOfCivil(p.civilStartTime);
        if (key) out[key] = p;
    }
    return out;
}

// Data points of one type, newest first where Google allows; filter is tried first and dropped if refused
async function listPoints(playerId, dataType, filter, pageSize) {
    try {
        return (await api(playerId, 'get', `/dataTypes/${dataType}/dataPoints`, { params: { filter, pageSize } })).dataPoints || [];
    } catch (err) {
        if (err.status !== 400) throw err;
        return (await api(playerId, 'get', `/dataTypes/${dataType}/dataPoints`, { params: { pageSize } })).dataPoints || [];
    }
}

// Runs one reading; a failure leaves that figure out (and is logged once per read)
async function optional(label, fn, problems) {
    try {
        return await fn();
    } catch (err) {
        if (err.needsLogin) throw err;
        problems.push(`${label}: ${err.message}`);
        return null;
    }
}

async function readPerson(playerId) {
    const dates = daysBack(DAYS);
    const first = dates[0];
    const problems = [];
    await accessToken(playerId); // a sign-in that's lapsed fails the lot, once
    const [steps, distance, calories, azm, heart, resting, sleep, weight] = await Promise.all([
        optional('steps', () => dailyRollUp(playerId, 'steps', DAYS), problems),
        optional('distance', () => dailyRollUp(playerId, 'distance', DAYS), problems),
        optional('calories', () => dailyRollUp(playerId, 'total-calories', DAYS), problems),
        optional('active zone minutes', () => dailyRollUp(playerId, 'active-zone-minutes', DAYS), problems),
        optional('heart rate', () => dailyRollUp(playerId, 'heart-rate', DAYS), problems),
        optional('resting heart rate', () => listPoints(playerId, 'daily-resting-heart-rate',
            `daily_resting_heart_rate.date >= "${first}"`, DAYS * 2), problems),
        optional('sleep', () => listPoints(playerId, 'sleep',
            `sleep.interval.civil_end_time >= "${dates[dates.length - 8]}T00:00:00"`, 25), problems),
        optional('weight', () => dailyRollUp(playerId, 'weight', WEIGHT_DAYS), problems),
    ]);
    if (problems.length) log(`Some figures for ${playerId} couldn't be read: ${problems.join('; ')}`);

    const restingByDay = {};
    for (const p of resting || []) {
        const r = p.dailyRestingHeartRate;
        const key = keyOfDate(r?.date);
        if (key && key >= first) restingByDay[key] = num(r.beatsPerMinute);
    }

    const days = dates.map(date => {
        const azmValue = azm?.[date]?.activeZoneMinutes;
        const azmSum = azmValue ? ['sumInFatBurnHeartZone', 'sumInCardioHeartZone', 'sumInPeakHeartZone']
            .reduce((s, k) => s + (num(azmValue[k]) || 0), 0) : null;
        const mm = num(distance?.[date]?.distance?.millimetersSum);
        return {
            date,
            steps: num(steps?.[date]?.steps?.countSum),
            distanceKm: mm == null ? null : mm / 1e6,
            kcal: num(calories?.[date]?.totalCalories?.kcalSum),
            activeZoneMinutes: azmSum,
            heartRateAvg: num(heart?.[date]?.heartRate?.beatsPerMinuteAvg),
            heartRateMin: num(heart?.[date]?.heartRate?.beatsPerMinuteMin),
            heartRateMax: num(heart?.[date]?.heartRate?.beatsPerMinuteMax),
            restingHeartRate: restingByDay[date] ?? null,
        };
    });

    const nights = (sleep || []).map(p => p.sleep).filter(s => s?.interval?.endTime).map(s => {
        const stages = {};
        for (const st of s.stages || []) {
            const mins = (new Date(st.endTime) - new Date(st.startTime)) / 60000;
            if (mins > 0) stages[st.type] = (stages[st.type] || 0) + mins;
        }
        return {
            start: s.interval.startTime,
            end: s.interval.endTime,
            minutesAsleep: num(s.summary?.minutesAsleep),
            minutesAwake: num(s.summary?.minutesAwake),
            stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, Math.round(v)])),
        };
    }).sort((a, b) => a.end.localeCompare(b.end));

    let latestWeight = null;
    for (const [date, p] of Object.entries(weight || {})) {
        const grams = num(p.weight?.weightGramsAvg);
        if (grams && (!latestWeight || date > latestWeight.date)) latestWeight = { date, kg: grams / 1000 };
    }

    return { days, sleep: nights, weight: latestWeight, missing: problems.length ? problems.map(p => p.split(':')[0]) : [] };
}

async function personSummary(playerId, refresh) {
    const hit = cache.get(playerId);
    if (hit && !refresh && Date.now() - hit.at < TTL) return hit.data;
    if (!reading.has(playerId)) {
        reading.set(playerId, readPerson(playerId)
            .then(data => {
                const result = { ...data, updated: new Date().toISOString() };
                cache.set(playerId, { at: Date.now(), data: result });
                return result;
            })
            .finally(() => reading.delete(playerId)));
    }
    return reading.get(playerId);
}

// Everyone in the family: those linked with their figures, the rest so they can be linked
export async function getSummary(players, { refresh = false } = {}) {
    if (!isConfigured()) return { configured: false, people: [] };
    // A family member deleted since linking: forget their sign-in
    const ids = new Set(players.map(p => p.id));
    for (const id of Object.keys(accounts)) if (!ids.has(id)) disconnect(id);
    const people = await Promise.all(players.map(async p => {
        if (!accounts[p.id]) return { id: p.id, name: p.name, connected: false };
        try {
            return { id: p.id, name: p.name, connected: true, ...(await personSummary(p.id, refresh)) };
        } catch (err) {
            if (err.needsLogin) return { id: p.id, name: p.name, connected: false, error: err.message };
            const stale = cache.get(p.id)?.data;
            return { id: p.id, name: p.name, connected: true, ...(stale || {}), error: err.message };
        }
    }));
    return { configured: true, days: DAYS, people };
}
