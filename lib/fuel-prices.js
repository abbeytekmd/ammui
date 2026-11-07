// Petrol station prices from the UK government's Fuel Finder scheme (The Motor Fuel Price (Open Data)
// Regulations 2025): every forecourt has to publish its pump prices within 30 minutes of a change.
// Reading them needs a free client id and secret from the Fuel Finder developer portal, saved as
// { clientId, clientSecret } in the "fuelFinderAccount" setting.
//
// The API has no search by location, only the whole country in batches of 500. So the first time
// prices are asked for around a place, every station is read once and only those within KEEP_MILES
// of it are kept. After that only changes are asked for ("effective-start-timestamp"): prices
// changed since the last check, at most every quarter of an hour and only while someone's looking,
// and new or closed stations once a day. That's usually one small request. What's kept is saved on
// disk so a restart carries on from there.
// Prices are pence per litre. The API only answers UK addresses (others get 403).
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const API = 'https://www.fuel-finder.service.gov.uk/api/v1';
const BATCH_SIZE = 500;
const MAX_BATCHES = 60;
const BATCH_GAP = 2100; // the API allows about 30 requests a minute, one at a time
const STATIONS_TTL = 24 * 60 * 60 * 1000;
const PRICES_TTL = 15 * 60 * 1000;
const OVERLAP = 10 * 60 * 1000; // changes are asked for from a little before the last check
export const KEEP_MILES = 30; // stations kept around each place asked about
export const MAX_RADIUS = 20; // so a device can move about 10 miles before its area needs reading again
const MAX_AREAS = 4;
const FIRST_LOAD_WAIT = 8000; // a request waits this long for a first read before replying "loading"
export const FUELS = ['E10', 'E5', 'B7_STANDARD', 'B7_PREMIUM', 'B10', 'HVO'];

let store = null;
let cacheFile = null;
let account = null;
let token = null; // { value, exp }
// { areas: [{ lat, lon }], stations: { id: station }, stationsAt, pricesAt } (times are when each read began)
let data = null;
let loading = null; // the refresh in progress
let lastError = null;

const log = (...args) => console.log('[FUEL]', ...args);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = (message, status) => Object.assign(new Error(message), { status });

export function init({ getSetting, setSetting, cachePath }) {
    store = { getSetting, setSetting };
    cacheFile = cachePath;
    account = getSetting('fuelFinderAccount', null);
    try {
        data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (!Array.isArray(data?.areas)) data = null; // saved by an earlier version, which kept the whole country
    } catch (e) { /* none yet */ }
}

const isConfigured = () => !!(account?.clientId && account?.clientSecret);

export function getAccount() {
    return { clientId: account?.clientId || '', hasSecret: !!account?.clientSecret };
}

// The whole login, for copying to another install
export function getCredentials() {
    return isConfigured() ? { clientId: account.clientId, clientSecret: account.clientSecret } : null;
}

// A blank secret keeps the saved one. Signs in straight away so a wrong id or secret shows up here.
export async function setAccount({ clientId, clientSecret }) {
    account = {
        clientId: String(clientId ?? account?.clientId ?? '').trim(),
        clientSecret: clientSecret ? String(clientSecret).trim() : account?.clientSecret || '',
    };
    store.setSetting('fuelFinderAccount', account);
    token = null;
    lastError = null;
    if (isConfigured()) await getToken();
    return getAccount();
}

const HEADERS = { Accept: 'application/json', 'User-Agent': 'AMMUI' };

function apiError(err) {
    const status = err.response?.status;
    if (status === 403) return fail('Fuel Finder refused the request. It only answers from UK internet addresses, and needs a valid client id and secret.', 403);
    const body = err.response?.data;
    const msg = body?.message || body?.error_description || body?.error || err.message;
    return fail(typeof msg === 'string' ? msg : err.message, status);
}

// The token reply is { data: { access_token, expires_in } }; the OAuth-standard flat form is accepted too
async function getToken() {
    if (token && Date.now() < token.exp - 60000) return token.value;
    token = null;
    let reply;
    try {
        reply = (await axios.post(`${API}/oauth/generate_access_token`,
            { client_id: account.clientId, client_secret: account.clientSecret },
            { headers: { ...HEADERS, 'Content-Type': 'application/json' }, timeout: 20000 })).data;
    } catch (err) {
        const e = apiError(err);
        if (e.status === 400 || e.status === 401) throw fail('Fuel Finder refused the client id and secret', 401);
        throw e;
    }
    const t = reply?.data || reply;
    if (!t?.access_token) throw fail('Fuel Finder didn\'t send a sign-in token', 502);
    token = { value: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
    return token.value;
}

async function getBatch(what, n, since) {
    const params = { 'batch-number': n };
    if (since) params['effective-start-timestamp'] = since;
    for (let attempt = 0; ; attempt++) {
        const auth = `Bearer ${await getToken()}`; // a refused login isn't retried
        try {
            const reply = await axios.get(`${API}/${what}`, { params, headers: { ...HEADERS, Authorization: auth }, timeout: 60000 });
            const body = reply.data;
            return Array.isArray(body) ? body : body?.data || body?.items || [];
        } catch (err) {
            const status = err.response?.status;
            // Past the last batch (or when nothing has changed) some deployments answer 404 rather than an empty list
            if (status === 404 && (n > 1 || since)) return [];
            if (status === 401 && attempt === 0) { token = null; continue; }
            if ((status === 429 || status >= 500 || !status) && attempt < 3) { await sleep(status === 429 ? 60000 : 5000 * (attempt + 1)); continue; }
            throw apiError(err);
        }
    }
}

// Every batch; with `since` (ms), only what's changed from then
async function getAll(what, since) {
    // UTC. Were it taken as UK time instead, that only asks for up to an hour more.
    const stamp = since ? new Date(since - OVERLAP).toISOString().slice(0, 19).replace('T', ' ') : null;
    const all = [];
    for (let n = 1; n <= MAX_BATCHES; n++) {
        if (n > 1) await sleep(BATCH_GAP);
        const batch = await getBatch(what, n, stamp);
        all.push(...batch);
        if (batch.length < BATCH_SIZE) break;
    }
    return all;
}

const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const inUk = (lat, lon) => lat > 49 && lat < 61.5 && lon > -9 && lon < 2.5;

// Some coordinates arrive swapped or with the longitude's sign lost; fixed only when that lands in the UK
function fixLocation(lat, lon) {
    if (inUk(lat, lon)) return [lat, lon];
    for (const [a, b] of [[lon, lat], [lat, -lon], [lon, -lat]]) if (inUk(a, b)) return [a, b];
    return null;
}

const MILES_PER_DEGREE = 69.09;
function miles(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * rad / 2) ** 2
        + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
    return 2 * Math.asin(Math.sqrt(a)) / rad * MILES_PER_DEGREE;
}

const isLocal = (s, areas) => areas.some(a => miles(a.lat, a.lon, s.lat, s.lon) <= KEEP_MILES);

function toStation(s, old) {
    const loc = s.location || {};
    const at = fixLocation(num(loc.latitude), num(loc.longitude));
    if (!s.node_id || !at || s.permanent_closure === true) return null;
    return {
        id: s.node_id,
        name: String(s.trading_name || s.brand_name || 'Petrol station').trim(),
        brand: String(s.brand_name || '').trim(),
        address: [loc.address_line_1, loc.address_line_2, loc.city].map(x => String(x || '').trim()).filter(Boolean).join(', '),
        postcode: String(loc.postcode || '').trim().toUpperCase(),
        phone: s.public_phone_number || '',
        lat: at[0], lon: at[1],
        motorway: !!s.is_motorway_service_station,
        supermarket: !!s.is_supermarket_service_station,
        closed: !!s.temporary_closure,
        prices: old?.prices || {},
    };
}

// Adds, updates or (when closed for good or out of the areas) drops stations
function applyStations(stations, list, areas) {
    for (const s of list) {
        const st = toStation(s, stations[s.node_id]);
        if (st && isLocal(st, areas)) stations[st.id] = st;
        else delete stations[s.node_id];
    }
}

// Pence per litre; a few forecourts send pounds. Anything else implausible is left out.
function cleanPrice(p) {
    let v = num(p);
    if (v > 0.5 && v < 3.5) v *= 100;
    return v >= 50 && v <= 350 ? Math.round(v * 10) / 10 : null;
}

// Only the fuels listed for a station change; the others keep their last price
function applyPrices(stations, list) {
    let count = 0;
    for (const p of list) {
        const st = stations[p.node_id];
        if (!st) continue;
        for (const fp of p.fuel_prices || []) {
            const type = String(fp.fuel_type || '').toUpperCase();
            const price = cleanPrice(fp.price);
            if (!FUELS.includes(type)) continue;
            if (price === null) { delete st.prices[type]; continue; }
            st.prices[type] = { price, updated: fp.price_last_updated || fp.price_change_effective_timestamp || null };
            count++;
        }
    }
    return count;
}

function save() {
    try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(data));
    } catch (err) {
        log(`Couldn't save the prices: ${err.message}`);
    }
}

const covers = (area, lat, lon, radius) => miles(area.lat, area.lon, lat, lon) + radius <= KEEP_MILES;

// Brings the saved stations and prices up to date, first reading the whole country if `place`
// isn't in an area already kept. Joins a refresh in progress.
function refresh(place) {
    if (loading) return loading;
    loading = (async () => {
        const started = Date.now();
        const newArea = place && !data?.areas.some(a => covers(a, place.lat, place.lon, MAX_RADIUS));
        const next = data ? { ...data, stations: { ...data.stations } } : { areas: [], stations: {}, stationsAt: 0, pricesAt: 0 };
        const full = newArea || !data;
        if (full) {
            if (newArea) next.areas = [...next.areas, { lat: place.lat, lon: place.lon }].slice(-MAX_AREAS);
            log(`Reading every station once, to keep the ones within ${KEEP_MILES} miles of ${next.areas.length === 1 ? 'here' : 'the places asked about'}...`);
            const stations = {};
            applyStations(stations, await getAll('pfs'), next.areas);
            for (const s of Object.values(stations)) s.prices = next.stations[s.id]?.prices || {};
            next.stations = stations;
            next.stationsAt = started;
            await sleep(BATCH_GAP);
            applyPrices(next.stations, await getAll('pfs/fuel-prices'));
            next.pricesAt = started;
        } else {
            if (started - next.stationsAt > STATIONS_TTL) {
                applyStations(next.stations, await getAll('pfs', next.stationsAt), next.areas);
                next.stationsAt = started;
            }
            applyPrices(next.stations, await getAll('pfs/fuel-prices', next.pricesAt));
            next.pricesAt = started;
        }
        data = next;
        lastError = null;
        save();
        if (full) log(`Kept ${Object.keys(next.stations).length} stations in ${Math.round((Date.now() - started) / 1000)}s.`);
    })().catch(err => {
        lastError = err.message;
        log(`Couldn't read prices: ${err.message}`);
        throw err;
    }).finally(() => { loading = null; });
    return loading;
}

// Stations within `radius` miles of lat, lon, nearest first. When this place hasn't been read yet,
// this waits a little for it, then says it's still loading.
export async function nearby({ lat, lon, radius = 5 }) {
    if (!isConfigured()) return { configured: false };
    radius = Math.min(radius, MAX_RADIUS);
    const known = data?.areas.some(a => covers(a, lat, lon, radius));
    const stale = !known || Date.now() - data.pricesAt > PRICES_TTL || Date.now() - data.stationsAt > STATIONS_TTL;
    if (stale) {
        const run = refresh({ lat, lon });
        run.catch(() => { });
        if (!known) {
            const done = await Promise.race([run.then(() => true, () => true), sleep(FIRST_LOAD_WAIT).then(() => false)]);
            const ready = data?.areas.some(a => covers(a, lat, lon, radius));
            if (!ready) return done ? { configured: true, error: lastError || 'No prices yet' } : { configured: true, loading: true };
        }
    }
    const stations = Object.values(data.stations)
        .map(s => ({ ...s, miles: Math.round(miles(lat, lon, s.lat, s.lon) * 10) / 10 }))
        .filter(s => s.miles <= radius && Object.keys(s.prices).length)
        .sort((a, b) => a.miles - b.miles);
    return { configured: true, updated: data.pricesAt, refreshing: !!loading, error: lastError, stations };
}
