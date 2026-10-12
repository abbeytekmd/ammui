// Smart plugs: finds TP-Link plugs on the local network, remembers them, and switches them.
// kasa.js drives Kasa plugs on the original local protocol; tapo.js drives Tapo (and newer Kasa)
// plugs, which need the TP-Link account login. This keeps the saved list and the login, runs
// discovery, and turns plugs into what the UI shows.
//
// A plug is saved as { id, type, ip, ... } in the "smartPlugs" setting. Ids are stable per device
// (device id or MAC address) so a plug that moves address is updated rather than duplicated.
import * as kasa from './kasa.js';
import * as tapo from './tapo.js';

const DRIVERS = { kasa, tapo };
const BRANDS = { kasa: 'Kasa', tapo: 'Tapo' };
const STATUS_TTL = 5000;
const DISCOVERY_INTERVAL = 10 * 60 * 1000; // plugs can change address

let store = null;
let plugs = [];
let account = null; // TP-Link account: { username, password }
const statusCache = new Map(); // id -> { at, outlets } | { at, error }
let discovery = null; // the run in progress

const log = (...args) => console.log('[SMART-HOME]', ...args);

export function init({ getSetting, setSetting }) {
    store = { getSetting, setSetting };
    plugs = (getSetting('smartPlugs', []) || []).filter(p => DRIVERS[p.type]);
    account = getSetting('tplinkAccount', null);
}

function save() {
    store.setSetting('smartPlugs', plugs);
}

// Adds a newly found plug, or updates a known one (its address may have changed).
function upsert(found) {
    const existing = plugs.find(p => p.id === found.id);
    if (!existing) {
        plugs.push({ ...found, firstSeen: Date.now() });
        log(`Found ${BRANDS[found.type]} ${found.model || 'device'} at ${found.ip}`);
        save();
        return;
    }
    let changed = false;
    for (const [k, v] of Object.entries(found)) {
        if (v != null && JSON.stringify(existing[k]) !== JSON.stringify(v)) { existing[k] = v; changed = true; }
    }
    if (changed) {
        statusCache.delete(existing.id);
        save();
    }
}

// ─── Discovery ───────────────────────────────────────────────────────────────

export function startBackgroundDiscovery() {
    setTimeout(() => discover().catch(() => { }), 5000);
    setInterval(() => discover().catch(() => { }), DISCOVERY_INTERVAL);
}

// Both TP-Link discovery broadcasts; joins a run already in progress.
export function discover() {
    if (discovery) return discovery;
    discovery = (async () => {
        const before = plugs.length;
        await Promise.all([
            kasa.discover(({ ip, sysinfo }) => upsert({
                id: `kasa:${(sysinfo.deviceId || sysinfo.mac || ip).toLowerCase()}`, type: 'kasa', ip,
                model: sysinfo.model, discoveredName: sysinfo.alias, mac: sysinfo.mac || sysinfo.mic_mac,
            })),
            tapo.discover(d => upsert({
                id: `tapo:${(d.mac || d.id || d.ip).toLowerCase()}`, type: 'tapo', ip: d.ip,
                model: d.model, deviceType: d.type, mac: d.mac, encryptType: d.encryptType, tpap: d.tpap,
            })),
        ]);
        if (plugs.length > before) log(`Discovery found ${plugs.length - before} new device(s)`);
    })().finally(() => { discovery = null; });
    return discovery;
}

// ─── Status and control ──────────────────────────────────────────────────────

// Why a plug can't be switched from here at all, or null if it can.
function unsupportedReason(p) {
    return p.type === 'tapo' ? tapo.unsupportedReason(p) : null;
}

async function refreshStatus(p, force) {
    const cached = statusCache.get(p.id);
    if (!force && cached && Date.now() - cached.at < STATUS_TTL) return cached;
    const entry = await DRIVERS[p.type].getStatus(p, account)
        .then(s => {
            // Keep the name set in the Tapo app
            if (s.name && s.name !== p.discoveredName) { p.discoveredName = s.name; save(); }
            return { at: Date.now(), outlets: s.outlets };
        })
        .catch(err => ({ at: Date.now(), error: err.message, needsLogin: !!err.needsLogin }));
    statusCache.set(p.id, entry);
    return entry;
}

function publicPlug(p, status) {
    const reason = unsupportedReason(p);
    const outletNames = p.outletNames || {};
    return {
        id: p.id,
        type: p.type,
        brand: BRANDS[p.type],
        name: p.name || p.discoveredName || `${BRANDS[p.type]} ${p.model || 'plug'}`,
        customName: p.name || null,
        model: p.model || null,
        ip: p.ip,
        hidden: !!p.hidden,
        supported: !reason,
        reason,
        online: status ? !status.error : null,
        error: status?.error || null,
        needsLogin: !!status?.needsLogin,
        outlets: (status?.outlets || []).map(o => ({ ...o, name: outletNames[o.id] || o.name || null })),
    };
}

// Every saved plug; with `live`, switchable ones are asked for their current state.
export async function listPlugs({ live = false } = {}) {
    return Promise.all(plugs.map(async p => {
        if (unsupportedReason(p)) return publicPlug(p, null);
        const status = live ? await refreshStatus(p, false) : statusCache.get(p.id);
        return publicPlug(p, status);
    }));
}

export async function setOutlet(id, outletId, on) {
    const p = plugs.find(x => x.id === id);
    if (!p) throw Object.assign(new Error('Unknown plug'), { status: 404 });
    const reason = unsupportedReason(p);
    if (reason) throw Object.assign(new Error(reason), { status: 400 });
    const s = await DRIVERS[p.type].setOutlet(p, String(outletId), !!on, account);
    const entry = { at: Date.now(), outlets: s.outlets };
    statusCache.set(p.id, entry);
    log(`${publicPlug(p).name} turned ${on ? 'on' : 'off'}`);
    return publicPlug(p, entry);
}

// Rename, or hide from the Smart Home tab.
export async function updatePlug(id, { name, hidden }) {
    const p = plugs.find(x => x.id === id);
    if (!p) throw Object.assign(new Error('Unknown plug'), { status: 404 });
    if (name !== undefined) p.name = String(name).trim() || null;
    if (hidden !== undefined) p.hidden = !!hidden;
    save();
    return publicPlug(p, statusCache.get(p.id));
}

export function forgetPlug(id) {
    const before = plugs.length;
    plugs = plugs.filter(p => p.id !== id);
    statusCache.delete(id);
    tapo.forget(id);
    if (plugs.length !== before) save();
    return plugs.length !== before;
}

// ─── TP-Link account ─────────────────────────────────────────────────────────

export function getAccount() {
    return { username: account?.username || '', hasPassword: !!account?.password };
}

// A blank password keeps the saved one.
export function setAccount({ username, password }) {
    account = {
        username: String(username ?? account?.username ?? '').trim(),
        password: password ? String(password) : account?.password || '',
    };
    store.setSetting('tplinkAccount', account);
    statusCache.clear();
    return getAccount();
}
