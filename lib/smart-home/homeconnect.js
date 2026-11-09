// Bosch (and Siemens, Neff, Gaggenau...) appliances through Home Connect's cloud API: every kind it
// supports (dishwashers, ovens, washing machines, dryers, fridges, coffee machines, hoods, hobs,
// cleaning robots...). What each is doing, how long it has left, starting and stopping programs,
// switching it on or off, and changing its settings (a fridge's temperature, a hood's light...). Home Connect has no local API, so everything goes through their servers.
//
// Home Connect doesn't hand out a shared client id, so each install needs its own: registered
// free at developer.home-connect.com as an application using the "Device Flow". Signing in is
// then the device code flow, as with tado°: the person opens a link, logs in with their Home
// Connect account and confirms a code, and we're given a refresh token (saved, with the client
// id, in the "homeConnectAccount" setting).
//
// Home Connect allows 1000 calls a day per account, so states aren't polled: they're read once
// (and again every few hours, or after the appliance reconnects) and then kept up to date from
// Home Connect's event stream, which pushes every change as it happens.
//
// An appliance is shown as:
//   { id, type, name, brand, model, connected, on, canPower, operation, busy, door, openDoors,
//     remoteStart, program, details: [..], cavity, battery, charging, progress, endsAt, startsAt,
//     startedAt, alerts: [{ text, level }], programs: [{ key, name }], homeProgram,
//     settings: [{ key, label, kind, choices, value, main }], error }
// Starting a program from here only works once Remote Start has been pressed on the appliance
// itself (a safety rule of Home Connect's): `remoteStart` says whether it has been.
//
// What can be chosen when starting a program (an oven's temperature and timer, a wash's
// temperature and spin, a coffee's strength and size, a delayed start or finish) differs by
// program and model, so each program's options are read from Home Connect the first time it's
// picked, and turned into lists of choices (see describe). Settings are read the same way, once.
// Hobs and some others only report: Home Connect doesn't allow controlling them.
import axios from 'axios';

const API = 'https://api.home-connect.com';
const SCOPE = 'IdentifyAppliance Monitor Control Settings';
const LANG = 'en-GB';
const MEDIA = 'application/vnd.bsh.sdk.v1+json';
const DEVICE_GRANTS = ['urn:ietf:params:oauth:grant-type:device_code', 'device_code'];
const RESYNC = 4 * 60 * 60 * 1000; // in case an event was missed
const RESYNC_AFTER_GAP = 2 * 60 * 1000; // the stream was down long enough to have missed something
const STREAM_SILENCE = 150 * 1000; // Home Connect sends a keep-alive every 55s
const MAX_BACKOFF = 10 * 60 * 1000;
const KEEPALIVE = 24 * 60 * 60 * 1000;
const MAX_DELAY_HOURS = 24;

// Program states in which the appliance is busy with a program
const RUNNING = new Set(['DelayedStart', 'Run', 'Pause', 'ActionRequired', 'Aborting']);
// Events worth showing on a card, with better words than their keys. Any other event that's
// present is shown too, named from its key, apart from those in QUIET_EVENTS.
const ALERTS = {
    'Dishcare.Dishwasher.Event.SaltNearlyEmpty': { text: 'Salt low', level: 'warn' },
    'Dishcare.Dishwasher.Event.RinseAidNearlyEmpty': { text: 'Rinse aid low', level: 'warn' },
    'Cooking.Oven.Event.PreheatFinished': { text: 'Preheated', level: 'info' },
    'BSH.Common.Event.AlarmClockElapsed': { text: 'Timer finished', level: 'info' },
    'BSH.Common.Event.SoftwareUpdateAvailable': { text: 'Update available', level: 'info' },
    'LaundryCare.Washer.Event.IDos1FillLevelPoor': { text: 'i-Dos 1 low', level: 'warn' },
    'LaundryCare.Washer.Event.IDos2FillLevelPoor': { text: 'i-Dos 2 low', level: 'warn' },
    'LaundryCare.Dryer.Event.FilterCleaningRequired': { text: 'Clean the filter', level: 'warn' },
    'LaundryCare.Dryer.Event.CondensedWaterContainerFull': { text: 'Empty the water container', level: 'warn' },
    'ConsumerProducts.CoffeeMaker.Event.BeanContainerEmpty': { text: 'Beans empty', level: 'warn' },
    'ConsumerProducts.CoffeeMaker.Event.WaterTankEmpty': { text: 'Water tank empty', level: 'warn' },
    'ConsumerProducts.CoffeeMaker.Event.DripTrayFull': { text: 'Drip tray full', level: 'warn' },
    'ConsumerProducts.CoffeeMaker.Event.KeepMilkTankCool': { text: 'Keep the milk cool', level: 'info' },
    'ConsumerProducts.CoffeeMaker.Event.DescalingIn20Cups': { text: 'Descale soon', level: 'info' },
    'ConsumerProducts.CoffeeMaker.Event.DeviceDescalingOverdue': { text: 'Descaling overdue', level: 'warn' },
    'ConsumerProducts.CoffeeMaker.Event.DeviceCleaningOverdue': { text: 'Cleaning overdue', level: 'warn' },
    'Refrigeration.FridgeFreezer.Event.DoorAlarmRefrigerator': { text: 'Fridge door open', level: 'warn' },
    'Refrigeration.FridgeFreezer.Event.DoorAlarmFreezer': { text: 'Freezer door open', level: 'warn' },
    'Refrigeration.FridgeFreezer.Event.TemperatureAlarmFreezer': { text: 'Freezer too warm', level: 'warn' },
    'ConsumerProducts.CleaningRobot.Event.EmptyDustBoxAndCleanFilter': { text: 'Empty the dust box', level: 'warn' },
    'ConsumerProducts.CleaningRobot.Event.RobotIsStuck': { text: 'Stuck', level: 'warn' },
    'ConsumerProducts.CleaningRobot.Event.DockingStationNotFound': { text: "Can't find its dock", level: 'warn' },
    'Cooking.Hood.Event.GreaseFilterMaxSaturationNearlyReached': { text: 'Grease filter nearly full', level: 'info' },
    'Cooking.Hood.Event.GreaseFilterMaxSaturationReached': { text: 'Clean the grease filter', level: 'warn' },
};
const QUIET_EVENTS = new Set(['ProgramFinished', 'ProgramAborted']);

// Program options with their own handling; every other option a program lists is offered too
const SETPOINT = 'Cooking.Oven.Option.SetpointTemperature';
const DURATION = 'BSH.Common.Option.Duration';
const START_IN = 'BSH.Common.Option.StartInRelative';
const FINISH_IN = 'BSH.Common.Option.FinishInRelative';
const WASH_TEMP = 'LaundryCare.Washer.Option.Temperature';
const SPIN = 'LaundryCare.Washer.Option.SpinSpeed';
// Shown first, in this order; delays go last
const FIRST = [SETPOINT, DURATION, WASH_TEMP, SPIN];
const LAST = [START_IN, FINISH_IN];
// Options that report on a running program rather than set it up
const NOT_OFFERED = new Set([
    'BSH.Common.Option.RemainingProgramTime', 'BSH.Common.Option.RemainingProgramTimeIsEstimated',
    'BSH.Common.Option.ElapsedProgramTime', 'BSH.Common.Option.ProgramProgress',
    'BSH.Common.Option.EstimatedTotalProgramTime', 'BSH.Common.Option.EnergyForecast', 'BSH.Common.Option.WaterForecast',
    'BSH.Common.Option.BaseProgram', 'LaundryCare.Common.Option.ProcessPhase',
    'ConsumerProducts.CleaningRobot.Option.ProcessPhase', 'Cooking.Oven.Option.FastPreHeat.Status',
]);
const TIMER_MINUTES = [5, 10, 15, 20, 25, 30, 40, 45, 50, 60, 75, 90, 105, 120, 150, 180, 210, 240];
const MAX_CHOICES = 60;

// Settings shown on the card itself (the rest are under More settings), with better names
const MAIN_SETTINGS = {
    'Refrigeration.FridgeFreezer.Setting.SetpointTemperatureRefrigerator': 'Fridge',
    'Refrigeration.FridgeFreezer.Setting.SetpointTemperatureFreezer': 'Freezer',
    'Refrigeration.FridgeFreezer.Setting.SuperModeRefrigerator': 'Super cool',
    'Refrigeration.FridgeFreezer.Setting.SuperModeFreezer': 'Super freeze',
    'Refrigeration.Common.Setting.WineCompartment.SetpointTemperature': 'Wine compartment',
    'Refrigeration.Common.Setting.WineCompartment2.SetpointTemperature': 'Wine compartment 2',
    'Refrigeration.Common.Setting.WineCompartment3.SetpointTemperature': 'Wine compartment 3',
    'Refrigeration.Common.Setting.BottleCooler.SetpointTemperature': 'Bottle cooler',
    'Refrigeration.Common.Setting.ChillerLeft.SetpointTemperature': 'Chiller (left)',
    'Refrigeration.Common.Setting.ChillerRight.SetpointTemperature': 'Chiller (right)',
    'Refrigeration.Common.Setting.ChillerCommon.SetpointTemperature': 'Chiller',
    'Refrigeration.Common.Setting.EcoMode': 'Eco mode',
    'Refrigeration.Common.Setting.VacationMode': 'Holiday mode',
    'Cooking.Common.Setting.Lighting': 'Light',
    'Cooking.Common.Setting.LightingBrightness': 'Brightness',
};
const SETTING_NAMES = {
    'BSH.Common.Setting.ChildLock': 'Child lock',
    'BSH.Common.Setting.AlarmClock': 'Kitchen timer',
    'Refrigeration.Common.Setting.SabbathMode': 'Sabbath mode',
    'Refrigeration.Common.Setting.FreshMode': 'Fresh mode',
    'Refrigeration.Common.Setting.Dispenser.Enabled': 'Dispenser',
    'Refrigeration.Common.Setting.Light.Internal.Power': 'Inside light',
    'Refrigeration.Common.Setting.Light.Internal.Brightness': 'Inside light brightness',
    'Refrigeration.Common.Setting.Light.External.Power': 'Outside light',
    'Refrigeration.Common.Setting.Light.External.Brightness': 'Outside light brightness',
    'ConsumerProducts.CoffeeMaker.Setting.CupWarmer': 'Cup warmer',
};
// Settings with their own control, or that aren't for changing here
const HIDDEN_SETTINGS = new Set(['BSH.Common.Setting.PowerState']);

// Used when a program's options can't be read: what most models of each kind take
const FALLBACK_OPTIONS = {
    Dishwasher: [{ key: START_IN, unit: 'seconds', constraints: { min: 0, max: MAX_DELAY_HOURS * 3600, stepsize: 3600 } }],
    Oven: [
        { key: SETPOINT, unit: '°C', constraints: { min: 30, max: 250, stepsize: 5, default: 180 } },
        { key: DURATION, unit: 'seconds', constraints: { min: 60, max: 4 * 3600 } },
    ],
};

let store = null;
let account = null; // { clientId, clientSecret, refreshToken, deviceGrant }
let access = null; // { token, exp }
let refreshing = null;
let pairing = null; // { deviceCode, userCode, url, expiresAt, interval, error? }
let appliances = new Map(); // haId -> state
let syncing = null;
let lastSync = 0;
let lastError = null; // { message, needsLogin }
let blockedUntil = 0; // after a 429, until Home Connect allows calls again
let stream = null; // { controller, watchdog }
let streamBackoff = 0;
let streamDownAt = 0;
let reopenTimer = null;

const log = (...args) => console.log('[HOME-CONNECT]', ...args);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = (message, extra) => Object.assign(new Error(message), extra);
const tail = v => typeof v === 'string' ? v.slice(v.lastIndexOf('.') + 1) : v;

export function init({ getSetting, setSetting }) {
    store = { getSetting, setSetting };
    account = getSetting('homeConnectAccount', null);
    if (isConfigured()) setTimeout(start, 3000);
    setInterval(() => { if (account?.refreshToken) accessToken().catch(() => { }); }, KEEPALIVE);
    setInterval(() => { if (isConfigured()) sync().catch(() => { }); }, RESYNC);
}

const save = () => store.setSetting('homeConnectAccount', account);
export const isConfigured = () => !!(account?.clientId && account.refreshToken);

// ─── Signing in ──────────────────────────────────────────────────────────────

function clientForm() {
    const form = { client_id: account.clientId };
    if (account.clientSecret) form.client_secret = account.clientSecret;
    return form;
}

async function tokenRequest(form) {
    try {
        const body = new URLSearchParams({ ...clientForm(), ...form });
        return (await axios.post(`${API}/security/oauth/token`, body, { timeout: 20000 })).data;
    } catch (err) {
        const d = err.response?.data;
        const code = d?.error;
        throw fail(d?.error_description || code || err.message, { code });
    }
}

function keepTokens(reply) {
    access = { token: reply.access_token, exp: Date.now() + (reply.expires_in || 3600) * 1000 };
    if (reply.refresh_token && reply.refresh_token !== account?.refreshToken) {
        account = { ...account, refreshToken: reply.refresh_token };
        save();
    }
}

async function accessToken() {
    if (access && access.exp - Date.now() > 60000) return access.token;
    if (!account?.refreshToken) throw fail('Connect Home Connect in Settings', { status: 401, needsLogin: true });
    refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refreshToken })
        .then(keepTokens)
        .catch(err => {
            if (err.code !== 'invalid_grant') throw err;
            account = { ...account, refreshToken: null, signedOut: true };
            save();
            stopStream();
            log('Signed out by Home Connect');
            throw fail('Home Connect has signed this device out. Connect again in Settings.', { status: 401, needsLogin: true });
        })
        .finally(() => { refreshing = null; });
    await refreshing;
    return access.token;
}

// Starts signing in with the client id given (or the one saved): gives the link and code to
// confirm on Home Connect's site, and waits for it in the background.
export async function startPairing({ clientId, clientSecret } = {}) {
    const id = String(clientId ?? account?.clientId ?? '').trim();
    if (!id) throw fail('Enter the client id of your Home Connect application first', { status: 400 });
    // A blank secret keeps the saved one, unless the client id has changed
    const secret = clientSecret ? String(clientSecret).trim()
        : id === account?.clientId ? account?.clientSecret || '' : '';
    stopStream();
    access = null;
    account = { clientId: id, clientSecret: secret, refreshToken: null };
    save();
    let reply;
    try {
        const body = new URLSearchParams({ client_id: id, scope: SCOPE });
        reply = (await axios.post(`${API}/security/oauth/device_authorization`, body, { timeout: 20000 })).data;
    } catch (err) {
        const d = err.response?.data;
        const why = d?.error_description || d?.error?.description || d?.error || err.message;
        throw fail(`Home Connect didn't accept that: ${why}`, { status: 502 });
    }
    const p = pairing = {
        deviceCode: reply.device_code,
        userCode: reply.user_code,
        url: reply.verification_uri_complete || reply.verification_uri,
        expiresAt: Date.now() + (reply.expires_in || 300) * 1000,
        interval: reply.interval || 5,
        grant: 0, // which of DEVICE_GRANTS Home Connect takes
    };
    waitForPairing(p);
    return getAccount();
}

async function waitForPairing(p) {
    while (pairing === p && Date.now() < p.expiresAt) {
        await sleep(p.interval * 1000);
        if (pairing !== p) return;
        try {
            const reply = await tokenRequest({ grant_type: DEVICE_GRANTS[p.grant], device_code: p.deviceCode });
            keepTokens(reply);
            if (pairing === p) pairing = null;
            log('Connected');
            appliances = new Map();
            start();
            return;
        } catch (err) {
            if (err.code === 'authorization_pending') continue;
            if (err.code === 'slow_down') { p.interval += 5; continue; }
            if (err.code === 'unsupported_grant_type' && p.grant < DEVICE_GRANTS.length - 1) { p.grant++; continue; }
            p.error = err.code === 'access_denied' ? 'Signing in was cancelled.' : err.message;
            return;
        }
    }
    if (pairing === p) p.error = 'The code expired before it was confirmed. Try connecting again.';
}

export function getAccount() {
    return {
        clientId: account?.clientId || '',
        hasSecret: !!account?.clientSecret,
        connected: isConfigured(),
        signedOut: !!account?.signedOut && !pairing,
        appliances: [...appliances.values()].map(a => a.name),
        pairing: pairing ? { userCode: pairing.userCode, url: pairing.url, error: pairing.error || null } : null,
    };
}

// Forgets the sign-in, keeping the client id so connecting again needs only the sign-in.
export function disconnect() {
    stopStream();
    account = account?.clientId ? { clientId: account.clientId, clientSecret: account.clientSecret, refreshToken: null } : null;
    access = pairing = lastError = null;
    appliances = new Map();
    save();
    log('Disconnected');
    return getAccount();
}

// ─── Calls ───────────────────────────────────────────────────────────────────

async function call(method, path, data, retried = false) {
    if (Date.now() < blockedUntil) {
        throw fail(`Home Connect's limit on requests has been reached. Try again in ${Math.ceil((blockedUntil - Date.now()) / 60000)} min.`, { status: 429 });
    }
    const token = await accessToken();
    try {
        const res = await axios({
            method, url: `${API}${path}`, data,
            headers: { Authorization: `Bearer ${token}`, Accept: MEDIA, 'Accept-Language': LANG, ...(data ? { 'Content-Type': MEDIA } : {}) },
            timeout: 20000,
        });
        return res.data;
    } catch (err) {
        const status = err.response?.status;
        if (status === 401 && !retried) {
            access = null;
            return call(method, path, data, true);
        }
        if (status === 429) {
            blockedUntil = Date.now() + (Number(err.response.headers?.['retry-after']) || 60) * 1000;
            throw fail("Home Connect's limit on requests has been reached. It resets within a day.", { status: 429 });
        }
        const e = err.response?.data?.error;
        throw fail(e?.description || e?.key || err.message, { status: status >= 400 && status < 500 ? status : 502, key: e?.key });
    }
}

const base = a => `/api/homeappliances/${encodeURIComponent(a.id)}`;

// ─── States ──────────────────────────────────────────────────────────────────

function blank(h) {
    return {
        id: h.haId, alerts: {}, programs: null, power: null, powerOff: null, operation: null, door: null, doors: {},
        remoteStart: null, program: null, selected: null, remaining: null, progress: null, delay: null,
        elapsed: null, cavity: null, battery: null, charging: false, shown: {}, options: new Map(),
        settings: {}, settingDefs: new Map(), error: null,
    };
}

// "Dishcare.Dishwasher.Program.Eco50" -> "Eco 50", for programs Home Connect hasn't named
const programLabel = key => String(tail(key)).replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');
const programName = (a, key) => a.programs?.find(p => p.key === key)?.name || programLabel(key);
// "Refrigeration.Common.Setting.Light.Internal.Power" -> "Light Internal Power"
const settingLabel = key => MAIN_SETTINGS[key] || SETTING_NAMES[key]
    || String(key).split('.Setting.').pop().split('.').map(programLabel).join(' ');

// A value of a listed option, for options Home Connect hasn't given words for:
// "LaundryCare.Washer.EnumType.Temperature.GC40" -> "40°C", "...SpinSpeed.RPM1400" -> "1400 rpm"
function valueLabel(key, value) {
    const t = String(tail(value)).replace(/^Ul(?=[A-Z0-9])/, '');
    if (key === SPIN && t === 'Off') return 'No spin';
    const m = /^(GC|RPM)(\d+)$/.exec(t);
    if (m) return m[1] === 'GC' ? `${m[2]}°C` : `${m[2]} rpm`;
    const stage = /^(FanStage|HoodIntensiveLevel|IntensiveStage)0*(\d+)$/.exec(t);
    if (stage) return `${stage[1] === 'FanStage' ? 'Level' : 'Intensive'} ${stage[2]}`;
    return programLabel(t);
}

const round2 = v => Math.round(v * 100) / 100;
function numberLabel(v, unit) {
    if (!unit) return String(v);
    if (/^°|%$/.test(unit)) return `${v}${unit}`;
    return `${v} ${unit}`;
}

// How a running program's option reads on its card ("40°C", "1400 rpm", "Strong"), or null
function shownValue(key, { value, unit, displayvalue }) {
    if (displayvalue) return displayvalue;
    if (typeof value === 'number') return numberLabel(round2(value), unit || (key === SETPOINT ? '°C' : ''));
    if (typeof value === 'string') return valueLabel(key, value);
    return null;
}

// One value from a read or an event
function apply(a, item) {
    const { key, value, name } = item;
    switch (key) {
        case 'BSH.Common.Status.OperationState':
            a.operation = tail(value);
            if (!RUNNING.has(a.operation)) a.delay = null;
            break;
        case 'BSH.Common.Status.DoorState': a.door = tail(value); break;
        case 'BSH.Common.Status.RemoteControlStartAllowed': a.remoteStart = !!value; break;
        case 'BSH.Common.Status.BatteryLevel': a.battery = typeof value === 'number' ? Math.round(value) : null; break;
        case 'BSH.Common.Status.BatteryChargingState': a.charging = tail(value) === 'Charging'; break;
        case 'BSH.Common.Setting.PowerState': a.power = tail(value); break;
        case 'BSH.Common.Root.SelectedProgram': a.selected = value || null; break;
        case 'BSH.Common.Root.ActiveProgram':
            a.program = value ? { key: value, name: name || programName(a, value) } : null;
            if (!value) {
                a.remaining = a.progress = a.delay = a.elapsed = null;
                a.shown = {};
            }
            break;
        case 'BSH.Common.Option.RemainingProgramTime':
            a.remaining = typeof value === 'number' && value > 0 ? { seconds: value, at: Date.now() } : null;
            break;
        case 'BSH.Common.Option.ElapsedProgramTime':
            a.elapsed = typeof value === 'number' ? { seconds: value, at: Date.now() } : null;
            break;
        case 'BSH.Common.Option.ProgramProgress': a.progress = typeof value === 'number' ? value : null; break;
        case START_IN:
            a.delay = typeof value === 'number' ? { seconds: value, at: Date.now() } : null;
            break;
        case 'Cooking.Oven.Status.CurrentCavityTemperature':
            a.cavity = typeof value === 'number' ? Math.round(value) : null;
            break;
        default:
            if (key.includes('.Event.')) {
                if (QUIET_EVENTS.has(tail(key))) return;
                if (tail(value) === 'Present') a.alerts[key] = true;
                else delete a.alerts[key];
            } else if (key.startsWith('Refrigeration.Common.Status.Door.')) {
                a.doors[tail(key)] = tail(value);
            } else if (key.includes('.Setting.')) {
                if (!HIDDEN_SETTINGS.has(key)) a.settings[key] = value;
            } else if (key.includes('.Option.') && !NOT_OFFERED.has(key) && key !== DURATION && key !== FINISH_IN) {
                const shown = shownValue(key, item);
                if (shown) a.shown[key] = shown;
                else delete a.shown[key];
            }
    }
}

const items = (list, a) => (list || []).forEach(item => apply(a, item));

async function readPrograms(a) {
    const reply = await call('get', `${base(a)}/programs/available`).catch(() => null);
    const list = reply?.data?.programs?.filter(p => !['selectonly', 'none'].includes(p.constraints?.execution));
    if (list?.length) a.programs = list.map(p => ({ key: p.key, name: p.name || programLabel(p.key) }));
}

// Which value turns it off: most take Off, ovens only go to Standby
async function readPowerValues(a) {
    const reply = await call('get', `${base(a)}/settings/BSH.Common.Setting.PowerState`).catch(() => null);
    const allowed = (reply?.data?.constraints?.allowedvalues || []).map(tail);
    a.powerOff = allowed.includes('Off') ? 'Off' : allowed.includes('Standby') ? 'Standby'
        : allowed.length ? false : a.type === 'Oven' ? 'Standby' : 'Off';
}

// What each of the appliance's settings can be set to, read once each (in the background)
async function readSettingDefs(a) {
    const missing = Object.keys(a.settings).filter(k => !a.settingDefs.has(k));
    await Promise.all(missing.map(async key => {
        const reply = await call('get', `${base(a)}/settings/${encodeURIComponent(key)}`).catch(() => null);
        if (!reply?.data) return; // tried again at the next read
        const d = reply.data;
        a.settingDefs.set(key, describe({ ...d, key, name: MAIN_SETTINGS[key] || SETTING_NAMES[key] || d.name || settingLabel(key) }, { setting: true }));
    }));
}

async function readAppliance(a) {
    const noProgram = err => [404, 409].includes(err.status) ? null : Promise.reject(err);
    const [status, settings, active] = await Promise.all([
        call('get', `${base(a)}/status`),
        call('get', `${base(a)}/settings`).catch(noProgram),
        call('get', `${base(a)}/programs/active`).catch(noProgram),
    ]);
    items(status?.data?.status, a);
    if (settings?.data?.settings) {
        a.settings = {};
        items(settings.data.settings, a);
    }
    if (active?.data?.key) {
        a.program = { key: active.data.key, name: active.data.name || programName(a, active.data.key) };
        a.shown = {};
        items(active.data.options, a);
    } else {
        a.program = a.remaining = a.progress = a.delay = a.elapsed = null;
        a.shown = {};
    }
    if (!a.programs) await readPrograms(a);
    if (a.power && a.powerOff == null) await readPowerValues(a);
    readSettingDefs(a).catch(() => { });
    a.error = null;
}

// ─── Choices ─────────────────────────────────────────────────────────────────
// A program option or a setting, described as what the card offers for it:
//   { key, label, kind: 'select' | 'toggle', optional, numeric, boolean, unit,
//     delay: 'start' | 'finish' | undefined, choices: [{ value, label, seconds? }], default }
// Values are strings on the card. `value` '' (on an optional one) means leave it out. For delays,
// `seconds` lets the card show the time it comes to.

function numberChoices(c, unit, current) {
    if (c.min == null || c.max == null || c.max < c.min) return null;
    let step = c.stepsize > 0 ? c.stepsize : 1;
    while ((c.max - c.min) / step > MAX_CHOICES) step *= 2;
    const values = [];
    for (let v = c.min; v <= c.max + 1e-9; v += step) values.push(round2(v));
    if (typeof current === 'number' && !values.includes(round2(current))) values.push(round2(current));
    return values.sort((x, y) => x - y).map(v => ({ value: String(v), label: numberLabel(v, unit) }));
}

const minutesLabel = m => m < 60 || m % 60 ? `${m} min` : `${m / 60} h`;

function describe(o, { setting = false } = {}) {
    const c = o.constraints || {};
    if (c.access && !/write/i.test(c.access)) return null; // read only
    const between = v => (c.min == null || v >= c.min) && (c.max == null || v <= c.max);
    const label = o.name || (setting ? settingLabel(o.key) : programLabel(o.key));
    const base = { key: o.key, label, kind: 'select' };
    if (o.key === SETPOINT) {
        const step = Math.max(c.stepsize || 5, 5);
        const min = Math.ceil((c.min ?? 30) / step) * step, max = c.max ?? 250;
        const choices = [];
        for (let v = min; v <= max; v += step) choices.push({ value: String(v), label: numberLabel(v, o.unit || '°C') });
        if (!choices.length) return null;
        const want = c.default ?? 180;
        const def = choices.reduce((best, x) => Math.abs(x.value - want) < Math.abs(best.value - want) ? x : best);
        return { ...base, label: 'Temperature', unit: o.unit || '°C', numeric: true, choices, default: def.value };
    }
    if (o.key === START_IN || o.key === FINISH_IN) {
        const start = o.key === START_IN;
        const first = Math.max(1, Math.ceil((c.min || 0) / 3600));
        const last = Math.min(MAX_DELAY_HOURS, Math.floor((c.max ?? MAX_DELAY_HOURS * 3600) / 3600));
        const choices = [];
        for (let h = first; h <= last; h++) choices.push({ value: String(h * 3600), label: start ? `In ${h} h` : `Done in ${h} h`, seconds: h * 3600 });
        if (!choices.length) return null;
        return {
            ...base, label: start ? 'Start' : 'Finish', delay: start ? 'start' : 'finish', unit: 'seconds', numeric: true, optional: true,
            choices: [{ value: '', label: start ? 'Now' : 'As soon as possible' }, ...choices], default: '',
        };
    }
    if (o.type === 'Boolean' || typeof o.value === 'boolean' || typeof c.default === 'boolean') {
        if (setting) return { ...base, kind: 'toggle', boolean: true };
        return {
            ...base, boolean: true, optional: true,
            choices: [{ value: '', label: 'Program default' }, { value: 'true', label: 'On' }, { value: 'false', label: 'Off' }], default: '',
        };
    }
    if (c.allowedvalues?.length) {
        const choices = c.allowedvalues.map((v, i) => ({ value: String(v), label: c.displayvalues?.[i] || valueLabel(o.key, v) }));
        const named = o.key === SPIN ? 'Spin' : o.key === WASH_TEMP ? 'Temperature' : label;
        // Without a default given, left to the program unless something is picked
        if (!setting && (c.default == null || !c.allowedvalues.includes(c.default))) {
            return { ...base, label: named, optional: true, choices: [{ value: '', label: 'Program default' }, ...choices], default: '' };
        }
        return { ...base, label: named, choices, default: String(c.default ?? c.allowedvalues[0]) };
    }
    if (o.unit === 'seconds') {
        // Timers: an oven's cooking time, a kitchen timer...
        const choices = TIMER_MINUTES.filter(m => between(m * 60)).map(m => ({ value: String(m * 60), label: minutesLabel(m) }));
        if (setting && typeof o.value === 'number' && o.value > 0 && !choices.some(x => +x.value === o.value)) {
            choices.unshift({ value: String(o.value), label: `${Math.ceil(o.value / 60)} min left` });
        }
        const none = setting ? { value: '0', label: 'Off' } : { value: '', label: o.key === DURATION ? 'No timer' : 'Program default' };
        return { ...base, label: o.key === DURATION ? 'Timer' : label, unit: 'seconds', numeric: true, optional: !setting, choices: [none, ...choices], default: none.value };
    }
    if (typeof o.value === 'number' || c.min != null) {
        const choices = numberChoices(c, o.unit, o.value);
        if (!choices?.length) return null;
        const def = c.default != null ? String(round2(c.default)) : null;
        if (!setting && !choices.some(x => x.value === def)) {
            return { ...base, unit: o.unit, numeric: true, optional: true, choices: [{ value: '', label: 'Program default' }, ...choices], default: '' };
        }
        return { ...base, unit: o.unit, numeric: true, choices, default: def ?? choices[0].value };
    }
    return null;
}

// A card's choice turned back into what Home Connect takes
const wireValue = (d, v) => d.boolean ? v === true || v === 'true' : d.numeric ? Number(v) : String(v);

// The options of one of an appliance's programs that can be set when starting it, read once and kept.
export async function programOptions(id, programKey) {
    const a = appliances.get(String(id));
    if (!a) throw fail('Unknown appliance', { status: 404 });
    if (!a.programs?.some(p => p.key === programKey)) throw fail('Unknown program', { status: 404 });
    if (a.options.has(programKey)) return a.options.get(programKey);
    const reply = await call('get', `${base(a)}/programs/available/${encodeURIComponent(programKey)}`).catch(() => null);
    const read = reply?.data?.options;
    const raw = (read || FALLBACK_OPTIONS[a.type] || []).filter(o => !NOT_OFFERED.has(o.key));
    const rank = o => FIRST.includes(o.key) ? FIRST.indexOf(o.key) - 100 : LAST.includes(o.key) ? 100 + LAST.indexOf(o.key) : 0;
    const list = raw.sort((x, y) => rank(x) - rank(y)).map(o => describe(o)).filter(Boolean);
    if (read) a.options.set(programKey, list); // a failed read is tried again next time
    return list;
}

// Reads the account's appliances and what each is doing.
function sync() {
    syncing ||= (async () => {
        const reply = await call('get', '/api/homeappliances');
        const next = new Map();
        for (const h of reply?.data?.homeappliances || []) {
            const a = appliances.get(h.haId) || blank(h);
            Object.assign(a, { name: h.name || h.type, brand: h.brand || null, type: h.type, model: h.enumber || h.vib || null, connected: !!h.connected });
            next.set(h.haId, a);
        }
        appliances = next;
        await Promise.all([...next.values()].filter(a => a.connected).map(a => readAppliance(a).catch(err => { a.error = err.message; })));
        lastSync = Date.now();
        lastError = null;
    })()
        .catch(err => {
            lastError = { message: err.message, needsLogin: !!err.needsLogin };
            throw err;
        })
        .finally(() => { syncing = null; });
    return syncing;
}

function start() {
    sync().catch(err => log(`Couldn't read the appliances: ${err.message}`));
    openStream();
}

// ─── Event stream ────────────────────────────────────────────────────────────
// Server-sent events for every appliance on the account: STATUS, NOTIFY and EVENT carry changed
// values; CONNECTED / DISCONNECTED say an appliance came or went; PAIRED / DEPAIRED that the
// account's appliances changed.

function stopStream() {
    clearTimeout(reopenTimer);
    const s = stream;
    stream = null;
    if (s) { clearTimeout(s.watchdog); s.controller.abort(); }
}

function openStream() {
    clearTimeout(reopenTimer);
    if (stream || !isConfigured()) return;
    const s = stream = { controller: new AbortController(), watchdog: null };
    const quiet = () => {
        clearTimeout(s.watchdog);
        s.watchdog = setTimeout(() => s.controller.abort(), STREAM_SILENCE);
    };
    (async () => {
        try {
            const token = await accessToken();
            const res = await axios.get(`${API}/api/homeappliances/events`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Accept-Language': LANG },
                responseType: 'stream', signal: s.controller.signal, timeout: 0,
            });
            quiet();
            streamBackoff = 0;
            if (streamDownAt && Date.now() - lastSync > RESYNC_AFTER_GAP) sync().catch(() => { });
            streamDownAt = 0;
            await readEvents(res.data, quiet);
        } catch (err) {
            if (stream !== s) return;
            const status = err.response?.status;
            if (status === 401) access = null;
            if (status === 429) blockedUntil = Date.now() + (Number(err.response.headers?.['retry-after']) || 60) * 1000;
            if (!s.controller.signal.aborted) log(`Event stream: ${err.message}`);
        } finally {
            clearTimeout(s.watchdog);
            if (stream === s) {
                stream = null;
                streamDownAt ||= Date.now();
                streamBackoff = Math.min(MAX_BACKOFF, streamBackoff ? streamBackoff * 2 : 5000);
                const wait = Math.max(streamBackoff, blockedUntil - Date.now());
                reopenTimer = setTimeout(openStream, wait);
            }
        }
    })();
}

function readEvents(body, onData) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        let event = { type: '', data: '', id: '' };
        body.setEncoding('utf8');
        body.on('data', chunk => {
            onData();
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            for (const line of lines) {
                if (!line) {
                    if (event.type || event.data) handleEvent(event);
                    event = { type: '', data: '', id: '' };
                } else if (line.startsWith('event:')) event.type = line.slice(6).trim();
                else if (line.startsWith('data:')) event.data += line.slice(5).trim();
                else if (line.startsWith('id:')) event.id = line.slice(3).trim();
            }
        });
        body.on('end', resolve);
        body.on('close', resolve);
        body.on('error', reject);
    });
}

function handleEvent({ type, data, id }) {
    if (type === 'KEEP-ALIVE') return;
    let payload = null;
    try { payload = data ? JSON.parse(data) : null; } catch { /* not JSON */ }
    const a = appliances.get(payload?.haId || id);
    switch (type) {
        case 'STATUS':
        case 'NOTIFY':
        case 'EVENT':
            if (a) items(payload?.items, a);
            break;
        case 'CONNECTED':
            if (a) {
                a.connected = true;
                readAppliance(a).catch(err => { a.error = err.message; });
            }
            break;
        case 'DISCONNECTED':
            if (a) a.connected = false;
            break;
        case 'PAIRED':
        case 'DEPAIRED':
            sync().catch(() => { });
            break;
    }
}

// ─── Showing and controlling ─────────────────────────────────────────────────

function publicAppliance(a) {
    const busy = RUNNING.has(a.operation);
    const at = v => v ? v.at + v.seconds * 1000 : null;
    return {
        id: a.id,
        name: a.name,
        brand: a.brand,
        type: a.type,
        model: a.model,
        connected: a.connected,
        // Without a power setting, it's on whenever Home Connect can see it
        on: a.power ? a.power === 'On' : a.operation !== 'Inactive',
        canPower: !!a.power && a.powerOff !== false,
        operation: a.operation,
        busy,
        door: a.door,
        // Appliances that don't report it are let try, and Home Connect says if it's refused
        remoteStart: a.remoteStart !== false,
        program: busy ? a.program?.name || null : null,
        details: busy ? Object.values(a.shown) : [],
        cavity: a.cavity,
        battery: a.battery,
        charging: a.charging,
        openDoors: Object.keys(a.doors).filter(k => a.doors[k] === 'Open').map(programLabel),
        // A robot can be sent back to its dock while it's cleaning
        homeProgram: a.programs?.find(p => /.GoHome$/.test(p.key))?.key || null,
        selected: a.selected,
        progress: busy ? a.progress : null,
        // A dishwasher waiting to start says when it starts; a washer set to finish later, when it's done
        startsAt: a.operation === 'DelayedStart' ? at(a.delay) : null,
        endsAt: busy && !(a.operation === 'DelayedStart' && a.delay) ? at(a.remaining) : null,
        startedAt: busy && a.elapsed ? a.elapsed.at - a.elapsed.seconds * 1000 : null,
        alerts: Object.keys(a.alerts).map(k => ALERTS[k] || { text: programLabel(k), level: 'info' }),
        programs: a.programs || [],
        settings: publicSettings(a),
        error: a.error,
    };
}

// Its settings that can be changed here, main ones first, each with its value now
function publicSettings(a) {
    const main = Object.keys(MAIN_SETTINGS);
    const rank = k => main.includes(k) ? main.indexOf(k) : main.length;
    return Object.keys(a.settings)
        .filter(k => a.settingDefs.get(k))
        .sort((x, y) => rank(x) - rank(y))
        .map(k => ({ ...a.settingDefs.get(k), value: String(a.settings[k]), main: k in MAIN_SETTINGS }));
}

// { configured, appliances, error?, needsLogin? }. Only the first look waits on Home Connect;
// after that it's what the event stream has said.
export async function listAppliances() {
    if (!isConfigured()) return { configured: false, signedOut: getAccount().signedOut, appliances: [] };
    if (!lastSync) await (syncing || sync()).catch(() => { });
    if (!stream) openStream();
    return {
        configured: true,
        appliances: [...appliances.values()].map(publicAppliance),
        ...(lastError ? { error: lastError.message, needsLogin: lastError.needsLogin } : {}),
    };
}

function findAppliance(id) {
    if (!isConfigured()) throw fail('Connect Home Connect in Settings', { status: 400 });
    const a = appliances.get(String(id));
    if (!a) throw fail('Unknown appliance', { status: 404 });
    if (!a.connected) throw fail(`${a.name} is offline`, { status: 409 });
    return a;
}

async function setPowerState(a, on) {
    const value = on ? 'On' : a.powerOff || (a.type === 'Oven' ? 'Standby' : 'Off');
    await call('put', `${base(a)}/settings/BSH.Common.Setting.PowerState`, {
        data: { key: 'BSH.Common.Setting.PowerState', value: `BSH.Common.EnumType.PowerState.${value}` },
    });
    a.power = value;
}

export async function setPower(id, on) {
    const a = findAppliance(id);
    if (!a.power || a.powerOff === false) throw fail(`${a.name} can't be switched ${on ? 'on' : 'off'} from here`, { status: 400 });
    await setPowerState(a, !!on);
    log(`${a.name} turned ${on ? 'on' : 'off'}`);
    // The programs can often only be read once it's on
    if (on && !a.programs) await sleep(2000).then(() => readPrograms(a));
    return publicAppliance(a);
}

// Starts `program` with the `options` chosen ({ key: value } from programOptions' choices; any
// left out take their default, and '' leaves an optional one out).
export async function startProgram(id, { program, options = {} } = {}) {
    const a = findAppliance(id);
    if (RUNNING.has(a.operation) && !/.GoHome$/.test(program)) throw fail(`${a.name} is already running a program`, { status: 409 });
    if (a.remoteStart === false) throw fail(`Press Remote Start on ${a.name} first, then start it from here`, { status: 409 });
    if (!a.programs) await readPrograms(a);
    const chosen = a.programs?.find(p => p.key === program);
    if (!chosen) throw fail('Pick a program', { status: 400 });
    const sent = [];
    for (const o of await programOptions(a.id, chosen.key)) {
        const value = options?.[o.key] === undefined ? o.default : String(options[o.key]);
        if (value === '' && o.optional) continue;
        if (!o.choices.some(c => c.value === value)) throw fail(`Pick a ${o.label.toLowerCase()}`, { status: 400 });
        sent.push({ key: o.key, value: wireValue(o, value), ...(o.unit ? { unit: o.unit } : {}) });
    }
    if (a.power && a.power !== 'On') await setPowerState(a, true);
    await call('put', `${base(a)}/programs/active`, { data: { key: chosen.key, options: sent } });
    // Shown as started until the event stream says more
    const delay = sent.find(o => o.key === START_IN || o.key === FINISH_IN);
    a.program = { key: chosen.key, name: chosen.name };
    a.operation = delay ? 'DelayedStart' : 'Run';
    a.shown = {};
    a.remaining = a.progress = a.elapsed = null;
    items(sent, a);
    log(`${a.name} started ${chosen.name}${sent.length ? ` (${sent.map(o => `${tail(o.key)}=${o.value}`).join(', ')})` : ''}`);
    return publicAppliance(a);
}

export async function stopProgram(id) {
    const a = findAppliance(id);
    await call('delete', `${base(a)}/programs/active`);
    log(`${a.name} stopped`);
    return publicAppliance(a);
}

// Changes one of its settings (see publicSettings) to `value`.
export async function changeSetting(id, key, value) {
    const a = findAppliance(id);
    const d = a.settingDefs.get(key);
    if (!d || !(key in a.settings)) throw fail('Unknown setting', { status: 404 });
    if (d.kind === 'select' && !d.choices.some(c => c.value === String(value))) throw fail(`Pick a value for ${d.label}`, { status: 400 });
    const wire = wireValue(d, value);
    await call('put', `${base(a)}/settings/${encodeURIComponent(key)}`, { data: { key, value: wire, ...(d.unit ? { unit: d.unit } : {}) } });
    a.settings[key] = wire;
    log(`${a.name}: ${d.label} set to ${wire}`);
    return publicAppliance(a);
}
