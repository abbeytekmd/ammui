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
// What's read for each person, for the last DAYS days in their own timezone (see readPerson):
//   activity: steps, distance, floors, elevation, total and active calories, active zone minutes,
//     active minutes by level, sedentary time, time in each heart rate zone, and workouts;
//   heart: average/min/max and resting heart rate, heart rate variability, sleeping heart rate, zone limits;
//   sleep: the last week's nights with their stages, breathing rate, blood oxygen, skin temperature change;
//   body (over LONG_DAYS): weight, body fat, height and BMI, cardio fitness (VO2 max);
//   logged water and food.
// A figure Google won't give (not recorded, or a scope not granted) is left out rather than failing
// the whole card. Results are kept for TTL so the tab can be left open.
import axios from 'axios';
import crypto from 'crypto';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://health.googleapis.com/v4/users/me';
export const REDIRECT_URI = 'https://www.google.com';
const STATE_MS = 15 * 60 * 1000; // how long a sign-in that's been started can be finished
const SCOPES = [
    'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
    'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
    'https://www.googleapis.com/auth/googlehealth.nutrition.readonly', // water and food logged in the Fitbit app
];
export const DAYS = 14; // total calories, heart rate and active minutes roll-ups can't span more than 14 days
const LONG_DAYS = 90; // weight, body fat and cardio fitness, which change slowly and aren't measured daily
const SLEEP_NIGHTS = 7;
const TTL = 15 * 60 * 1000;

let store = null;
let secrets = null; // { encrypt, decrypt }
let client = null; // { clientId, clientSecret }
let accounts = {}; // playerId -> { refreshToken, connectedAt }
const access = new Map(); // playerId -> { token, exp }
const cache = new Map(); // playerId -> { at, data }
const reading = new Map(); // playerId -> the read in progress
const pending = new Map(); // state -> { playerId, redirectUri, at }: sign-ins started and not yet finished
let callbackUri = null; // where Google sends a sign-in done on this machine (https://localhost/api/health/callback)

const log = (...args) => console.log('[HEALTH]', ...args);
const fail = (message, extra) => Object.assign(new Error(message), extra);

export function init({ getSetting, setSetting, encrypt, decrypt, callback }) {
    store = { getSetting, setSetting };
    callbackUri = callback;
    secrets = { encrypt, decrypt };
    client = getSetting('googleHealthClient', null);
    accounts = getSetting('googleHealthAccounts', {}) || {};
}

const isConfigured = () => !!(client?.clientId && client?.clientSecret);
const saveAccounts = () => store.setSetting('googleHealthAccounts', accounts);

// ─── The OAuth client ────────────────────────────────────────────────────────

export function getClient() {
    return { clientId: client?.clientId || '', hasSecret: !!client?.clientSecret, redirectUri: REDIRECT_URI, callbackUri };
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

// The Google sign-in page for one person. Google sends them on afterwards with a code: to callbackUri when
// the browser is on this machine (Google only allows localhost or a public domain, not a home network's
// addresses), where it's picked up without anyone doing anything, or else to google.com, from where the
// address is pasted back. state is who it's for and a random part, so only a sign-in started here is accepted.
export function connectUrl(playerId, { callback = false } = {}) {
    if (!isConfigured()) throw fail('Add the Google Health client id and secret in Settings first', { status: 400 });
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > STATE_MS) pending.delete(k);
    const redirectUri = callback && callbackUri ? callbackUri : REDIRECT_URI;
    const state = `${playerId}.${crypto.randomBytes(12).toString('base64url')}`;
    pending.set(state, { playerId, redirectUri, at: now });
    const params = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent', // always hands back a refresh token, even for an account linked before
        include_granted_scopes: 'true',
        state,
    });
    return { url: `${AUTH_URL}?${params}`, callback: redirectUri !== REDIRECT_URI };
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
    const state = params.get('state');
    if (state && state.slice(0, state.lastIndexOf('.')) !== playerId && state !== playerId) {
        throw fail('That sign-in was started for someone else', { status: 400 });
    }
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

// From a pasted google.com address (or just its code)
export async function connect(playerId, pasted) {
    if (!isConfigured()) throw fail('Add the Google Health client id and secret in Settings first', { status: 400 });
    return finishLink(playerId, codeFrom(pasted, playerId), REDIRECT_URI);
}

// From Google sending the browser to callbackUri: { code, state, error }. Returns who was linked.
export async function connectFromCallback({ code, state, error }) {
    const started = pending.get(String(state || ''));
    if (!started || Date.now() - started.at > STATE_MS) {
        throw fail("This sign-in wasn't started here, or it's too old. Start again from the Health tab.", { status: 400 });
    }
    pending.delete(state);
    if (error) throw fail(error === 'access_denied' ? 'Access was not allowed.' : `Google said: ${error}`, { status: 400, playerId: started.playerId });
    if (!code) throw fail('Google sent no code back.', { status: 400, playerId: started.playerId });
    if (!isConfigured()) throw fail('Add the Google Health client id and secret in Settings first', { status: 400 });
    await finishLink(started.playerId, String(code), started.redirectUri);
    return started.playerId;
}

async function finishLink(playerId, code, redirectUri) {
    const reply = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
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
const seconds = d => d == null ? null : parseFloat(String(d)); // a protobuf duration, "3600s"
// A reading in a unit Google uses converted to the one shown (null stays null, rather than becoming 0)
const per = (v, by, digits = 0) => v == null || Number.isNaN(v) ? null : round(v / by, digits);
const round = (v, digits = 0) => v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits;
const sampleTime = s => s?.physicalTime || s?.time || s?.civilTime || null;

function daysBack(n) {
    const today = new Date();
    return Array.from({ length: n }, (_, i) => dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - i))));
}

// At most a few requests to Google at once for each person
function limiter(max) {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= max || !queue.length) return;
        active++;
        const { fn, resolve, reject } = queue.shift();
        fn().then(resolve, reject).finally(() => { active--; next(); });
    };
    return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// Daily totals of one data type from `days` ago through today: { 'YYYY-MM-DD': value object }
async function dailyRollUp(playerId, dataType, days) {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const out = {};
    let pageToken;
    do {
        const reply = await api(playerId, 'post', `/dataTypes/${dataType}/dataPoints:dailyRollUp`, {
            data: {
                range: { start: { date: civilDate(start), time: { hours: 0 } }, end: { date: civilDate(end), time: { hours: 0 } } },
                windowSizeDays: 1,
                ...(pageToken ? { pageToken } : {}),
            },
        });
        for (const p of reply.rollupDataPoints || reply.dailyRollupDataPoints || []) {
            const key = keyOfCivil(p.civilStartTime);
            if (key) out[key] = p;
        }
        pageToken = reply.nextPageToken;
    } while (pageToken);
    return out;
}

// Data points of one type; the filter is tried first and dropped if Google refuses it
async function listPoints(playerId, dataType, filter, pageSize) {
    try {
        return (await api(playerId, 'get', `/dataTypes/${dataType}/dataPoints`, { params: { filter, pageSize } })).dataPoints || [];
    } catch (err) {
        if (err.status !== 400 || !filter) throw err;
        return (await api(playerId, 'get', `/dataTypes/${dataType}/dataPoints`, { params: { pageSize } })).dataPoints || [];
    }
}

// One-a-day summaries (resting heart rate, HRV...) since `first`: { 'YYYY-MM-DD': its value object }
async function dailySummaries(playerId, dataType, first, days) {
    const field = dataType.replace(/-/g, '_');
    const member = field.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    const points = await listPoints(playerId, dataType, `${field}.date >= "${first}"`, Math.min(days * 2, 1000));
    const out = {};
    for (const p of points) {
        const v = p[member] || Object.values(p).find(x => x && typeof x === 'object' && x.date);
        const key = keyOfDate(v?.date);
        if (key && key >= first) out[key] = v;
    }
    return out;
}

// Runs one reading; a failure leaves that figure out (noted, and logged once per read)
async function optional(label, fn, problems) {
    try {
        return await fn();
    } catch (err) {
        if (err.needsLogin) throw err;
        problems.push({ label, message: err.message });
        return null;
    }
}

const latestOf = map => {
    const keys = Object.keys(map || {}).sort();
    return keys.length ? { date: keys[keys.length - 1], value: map[keys[keys.length - 1]] } : null;
};

async function readPerson(playerId) {
    const dates = daysBack(DAYS);
    const first = dates[0];
    const longDates = daysBack(LONG_DAYS);
    const longFirst = longDates[0];
    const problems = [];
    const run = limiter(4);
    await accessToken(playerId); // a sign-in that's lapsed fails the lot, once
    const roll = (label, type, days = DAYS) => optional(label, () => run(() => dailyRollUp(playerId, type, days)), problems);
    const daily = (label, type, from = first, days = DAYS) => optional(label, () => run(() => dailySummaries(playerId, type, from, days)), problems);
    const list = (label, type, filter, size) => optional(label, () => run(() => listPoints(playerId, type, filter, size)), problems);

    const [
        steps, distance, calories, activeCalories, floors, altitude, azm, activeMinutes, sedentary, timeInZones,
        heart, resting, hrv, spo2, breathing, skinTemp, sleep, exercise,
        weight, bodyFat, vo2, zones, height, hydration, nutrition,
    ] = await Promise.all([
        roll('steps', 'steps'),
        roll('distance', 'distance'),
        roll('calories', 'total-calories'),
        roll('active calories', 'active-energy-burned'),
        roll('floors', 'floors'),
        roll('elevation', 'altitude'),
        roll('active zone minutes', 'active-zone-minutes'),
        roll('active minutes', 'active-minutes'),
        roll('sedentary time', 'sedentary-period'),
        roll('heart rate zones', 'time-in-heart-rate-zone'),
        roll('heart rate', 'heart-rate'),
        daily('resting heart rate', 'daily-resting-heart-rate'),
        daily('heart rate variability', 'daily-heart-rate-variability'),
        daily('oxygen saturation', 'daily-oxygen-saturation'),
        daily('breathing rate', 'daily-respiratory-rate'),
        daily('skin temperature', 'daily-sleep-temperature-derivations'),
        list('sleep', 'sleep', `sleep.interval.civil_end_time >= "${dates[dates.length - SLEEP_NIGHTS - 1]}T00:00:00"`, 25),
        list('exercise', 'exercise', `exercise.interval.civil_start_time >= "${first}T00:00:00"`, 25),
        roll('weight', 'weight', LONG_DAYS),
        roll('body fat', 'body-fat', LONG_DAYS),
        daily('cardio fitness', 'daily-vo2-max', longFirst, LONG_DAYS),
        daily('heart rate zone limits', 'daily-heart-rate-zones', first, DAYS),
        list('height', 'height', undefined, 100),
        roll('water', 'hydration-log'),
        roll('food log', 'nutrition-log'),
    ]);
    if (problems.length) log(`Some figures for ${playerId} couldn't be read: ${problems.map(p => `${p.label}: ${p.message}`).join('; ')}`);

    const days = dates.map(date => {
        const az = azm?.[date]?.activeZoneMinutes;
        const azmParts = az ? {
            fatBurn: num(az.sumInFatBurnHeartZone) || 0,
            cardio: num(az.sumInCardioHeartZone) || 0,
            peak: num(az.sumInPeakHeartZone) || 0,
        } : null;
        const levels = activeMinutes?.[date]?.activeMinutes?.activeMinutesRollupByActivityLevel;
        const zonesToday = timeInZones?.[date]?.timeInHeartRateZone?.timeInHeartRateZones;
        const hr = heart?.[date]?.heartRate;
        const r = resting?.[date];
        const v = hrv?.[date];
        const o = spo2?.[date];
        const t = skinTemp?.[date];
        const food = nutrition?.[date]?.nutritionLog;
        const nightly = num(t?.nightlyTemperatureCelsius), baseline = num(t?.baselineTemperatureCelsius);
        return {
            date,
            steps: num(steps?.[date]?.steps?.countSum),
            distanceKm: per(num(distance?.[date]?.distance?.millimetersSum), 1e6, 2),
            kcal: round(num(calories?.[date]?.totalCalories?.kcalSum)),
            activeKcal: round(num(activeCalories?.[date]?.activeEnergyBurned?.kcalSum)),
            floors: num(floors?.[date]?.floors?.countSum),
            elevationM: per(num(altitude?.[date]?.altitude?.gainMillimetersSum), 1000, 1),
            activeZoneMinutes: azmParts ? azmParts.fatBurn + azmParts.cardio + azmParts.peak : null,
            activeZoneParts: azmParts,
            activeMinutes: levels?.length ? Object.fromEntries(levels.map(l => [l.activityLevel, num(l.activeMinutesSum)])) : null,
            sedentaryMinutes: per(seconds(sedentary?.[date]?.sedentaryPeriod?.durationSum), 60),
            heartZoneMinutes: zonesToday?.length ? Object.fromEntries(zonesToday.map(z => [z.heartRateZone, per(seconds(z.duration), 60)])) : null,
            heartRateAvg: round(num(hr?.beatsPerMinuteAvg)),
            heartRateMin: round(num(hr?.beatsPerMinuteMin)),
            heartRateMax: round(num(hr?.beatsPerMinuteMax)),
            restingHeartRate: num(r?.beatsPerMinute),
            hrvMs: round(num(v?.averageHeartRateVariabilityMilliseconds), 1),
            hrvDeepSleepMs: round(num(v?.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds), 1),
            sleepingHeartRate: round(num(v?.nonRemHeartRateBeatsPerMinute)),
            spo2Avg: round(num(o?.averagePercentage), 1),
            spo2Low: round(num(o?.lowerBoundPercentage), 1),
            spo2High: round(num(o?.upperBoundPercentage), 1),
            breathingRate: round(num(breathing?.[date]?.breathsPerMinute), 1),
            skinTempChange: nightly != null && baseline != null ? round(nightly - baseline, 2) : null,
            waterMl: round(num(hydration?.[date]?.hydrationLog?.amountConsumed?.millilitersSum)),
            foodKcal: round(num(food?.energy?.kcalSum)),
            carbsG: round(num(food?.totalCarbohydrate?.gramsSum)),
            fatG: round(num(food?.totalFat?.gramsSum)),
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
            minutesInBed: num(s.summary?.minutesInSleepPeriod),
            awakenings: s.shortAwakenings?.length ?? null,
            stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, Math.round(v)])),
        };
    }).sort((a, b) => a.end.localeCompare(b.end)).slice(-SLEEP_NIGHTS);

    const workouts = (exercise || []).map(p => p.exercise).filter(e => e?.interval?.startTime).map(e => {
        const m = e.metricsSummary || {};
        const start = e.interval.startTime, end = e.interval.endTime;
        const active = seconds(e.activeDuration) ?? (end ? (new Date(end) - new Date(start)) / 1000 : null);
        return {
            name: e.displayName || e.exerciseType || 'Exercise',
            type: e.exerciseType || null,
            start, end,
            minutes: per(active, 60),
            kcal: round(num(m.caloriesKcal)),
            distanceKm: per(num(m.distanceMillimeters), 1e6, 2),
            steps: num(m.steps),
            heartRateAvg: round(num(m.averageHeartRateBeatsPerMinute)),
            activeZoneMinutes: num(m.activeZoneMinutes),
            elevationM: per(num(m.elevationGainMillimeters), 1000),
            paceSecPerKm: m.averagePaceSecondsPerMeter ? round(num(m.averagePaceSecondsPerMeter) * 1000) : null,
        };
    }).sort((a, b) => b.start.localeCompare(a.start));

    // Body: a reading on each day there was one over the longer period, and the latest of each
    const series = (map, pick) => Object.keys(map || {}).sort().map(date => ({ date, value: pick(map[date]) })).filter(p => p.value != null);
    const weights = series(weight, p => per(num(p.weight?.weightGramsAvg), 1000, 1));
    const fats = series(bodyFat, p => round(num(p.bodyFat?.bodyFatPercentageAvg), 1));
    const heights = (height || []).map(p => p.height).filter(h => h?.heightMillimeters)
        .sort((a, b) => String(sampleTime(a.sampleTime)).localeCompare(String(sampleTime(b.sampleTime))));
    const heightCm = heights.length ? per(num(heights[heights.length - 1].heightMillimeters), 10, 1) : null;
    const latestWeight = weights[weights.length - 1] || null;
    const fitness = latestOf(vo2);
    const zoneLimits = latestOf(zones)?.value?.heartRateZones;

    return {
        days,
        sleep: nights,
        exercise: workouts,
        body: {
            weights, // [{ date, value: kg }]
            bodyFats: fats, // [{ date, value: % }]
            heightCm,
            bmi: latestWeight && heightCm ? round(latestWeight.value / (heightCm / 100) ** 2, 1) : null,
            vo2Max: fitness ? { date: fitness.date, value: round(num(fitness.value.vo2Max), 1), level: fitness.value.cardioFitnessLevel || null } : null,
        },
        heartZones: zoneLimits?.length ? zoneLimits.map(z => ({ zone: z.heartRateZoneType, min: num(z.minBeatsPerMinute), max: num(z.maxBeatsPerMinute) })) : null,
        missing: problems.map(p => p.label),
    };
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
