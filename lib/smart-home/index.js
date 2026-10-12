// Smart plugs and lights: finds them on the local network, remembers them, and switches them.
// kasa.js drives Kasa plugs on the original local protocol; tapo.js drives Tapo (and newer Kasa)
// plugs, which need the TP-Link account login; twinkly.js drives Twinkly lights, which can also be
// dimmed. This keeps the saved list and the login, runs discovery, and turns devices into what
// the UI shows.
//
// A plug is saved as { id, type, ip, ... } in the "smartPlugs" setting. Ids are stable per device
// (device id or MAC address) so a plug that moves address is updated rather than duplicated.
//
// Twinkly units paired in the Twinkly app share a group ({ mode, uid }). The group is listed once,
// as its master, and switching or dimming it reaches every unit.
import * as kasa from './kasa.js';
import * as tapo from './tapo.js';
import * as twinkly from './twinkly.js';

const DRIVERS = { kasa, tapo, twinkly };
const BRANDS = { kasa: 'Kasa', tapo: 'Tapo', twinkly: 'Twinkly' };
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

// All the discovery broadcasts; joins a run already in progress.
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
            twinkly.discover(d => upsert({
                id: `twinkly:${(d.mac || d.id || d.ip).toLowerCase()}`, type: 'twinkly', ip: d.ip,
                model: d.model, discoveredName: d.name, mac: d.mac, group: d.group,
            })),
        ]);
        if (plugs.length > before) log(`Discovery found ${plugs.length - before} new device(s)`);
    })().finally(() => { discovery = null; });
    return discovery;
}

// ─── Groups ──────────────────────────────────────────────────────────────────

// Every unit in p's group (master first), or just p.
function groupOf(p) {
    const uid = p.group?.uid;
    if (!uid) return [p];
    const members = plugs.filter(x => x.type === p.type && x.group?.uid === uid);
    return members.sort((a, b) => (b.group.mode === 'master') - (a.group.mode === 'master'));
}

// A unit that's listed as part of its master rather than on its own.
function isFollower(p) {
    return !!p.group?.uid && p.group.mode !== 'master' && groupOf(p).some(x => x.group.mode === 'master');
}

const displayName = p => p.name || p.discoveredName || `${BRANDS[p.type]} ${p.model || 'plug'}`;

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
            // Keep the name set in the Tapo app, and any pairing made in the Twinkly app
            if (s.name && s.name !== p.discoveredName) { p.discoveredName = s.name; save(); }
            if (s.group && JSON.stringify(s.group) !== JSON.stringify(p.group)) { p.group = s.group; save(); }
            return { at: Date.now(), outlets: s.outlets };
        })
        .catch(err => ({ at: Date.now(), error: err.message, needsLogin: !!err.needsLogin }));
    statusCache.set(p.id, entry);
    return entry;
}

function publicPlug(p, status) {
    const reason = unsupportedReason(p);
    const outletNames = p.outletNames || {};
    const group = groupOf(p);
    return {
        id: p.id,
        type: p.type,
        brand: BRANDS[p.type],
        name: displayName(p),
        // The other units paired with this one, whose names voice commands also answer to
        members: group.length > 1 ? group.filter(x => x !== p).map(displayName) : [],
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

// Every saved plug, with paired units folded into their master; with `live`, switchable ones are
// asked for their current state (followers too, so a pairing changed in the app is noticed).
export async function listPlugs({ live = false } = {}) {
    const listed = await Promise.all(plugs.map(async p => {
        if (unsupportedReason(p)) return publicPlug(p, null);
        const status = live ? await refreshStatus(p, false) : statusCache.get(p.id);
        return publicPlug(p, status);
    }));
    return listed.filter((_, i) => !isFollower(plugs[i]));
}

export async function setOutlet(id, outletId, on) {
    const p = plugs.find(x => x.id === id);
    if (!p) throw Object.assign(new Error('Unknown plug'), { status: 404 });
    const reason = unsupportedReason(p);
    if (reason) throw Object.assign(new Error(reason), { status: 400 });
    const s = await DRIVERS[p.type].setOutlet(p, String(outletId), !!on, account);
    const entry = { at: Date.now(), outlets: s.outlets };
    statusCache.set(p.id, entry);
    const followers = groupOf(p).filter(x => x !== p);
    if (followers.length) await bringIntoLine(followers, !!on);
    log(`${displayName(p)}${followers.length ? ` (and ${followers.length} paired)` : ''} turned ${on ? 'on' : 'off'}`);
    return publicPlug(p, entry);
}

// Paired units may follow their master by themselves; any that haven't after a moment are
// switched directly. A unit that can't be reached doesn't stop the rest.
async function bringIntoLine(followers, on) {
    await new Promise(r => setTimeout(r, 1000));
    await Promise.all(followers.map(async x => {
        try {
            const status = await refreshStatus(x, true);
            if (!status.error && status.outlets.every(o => o.on === on)) return;
            const s = await DRIVERS[x.type].setOutlet(x, '0', on, account);
            statusCache.set(x.id, { at: Date.now(), outlets: s.outlets });
        } catch (err) {
            log(`Couldn't switch paired ${displayName(x)}: ${err.message}`);
        }
    }));
}

// Dims lights that can be (1-100).
export async function setBrightness(id, value) {
    const p = plugs.find(x => x.id === id);
    if (!p) throw Object.assign(new Error('Unknown plug'), { status: 404 });
    if (!DRIVERS[p.type].setBrightness) throw Object.assign(new Error("This device can't be dimmed"), { status: 400 });
    const level = Math.round(Number(value));
    if (!(level >= 1 && level <= 100)) throw Object.assign(new Error('Brightness must be 1-100'), { status: 400 });
    const s = await DRIVERS[p.type].setBrightness(p, level, account);
    const entry = { at: Date.now(), outlets: s.outlets };
    statusCache.set(p.id, entry);
    // Brightness is per unit, so set it on every paired one
    await Promise.all(groupOf(p).filter(x => x !== p).map(x => DRIVERS[x.type].setBrightness(x, level, account)
        .then(st => statusCache.set(x.id, { at: Date.now(), outlets: st.outlets }))
        .catch(err => log(`Couldn't dim paired ${displayName(x)}: ${err.message}`))));
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

// Forgetting a group's master forgets the whole group, as it's listed as one device.
export function forgetPlug(id) {
    const p = plugs.find(x => x.id === id);
    const ids = new Set(p && !isFollower(p) ? groupOf(p).map(x => x.id) : [id]);
    const before = plugs.length;
    plugs = plugs.filter(x => !ids.has(x.id));
    for (const gone of ids) {
        statusCache.delete(gone);
        tapo.forget(gone);
        twinkly.forget(gone);
    }
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
