const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

export const serverLogs = [];
const MAX_LOGS = 1000;

function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

export function terminalLog(...args) {
    originalLog(`[${getTimestamp()}]`, ...args);
}

// Leading "[TAG]" names of related sub-features are folded into one category so the
// log viewer's type list stays short. First match wins.
const CATEGORY_ALIASES = [
    [/^YOUTUBE/, 'YOUTUBE'],
    [/^IDENTIFY/, 'IDENTIFY'],
    [/^(WRITE-TAGS|MOVE-FOLDER-TO-TAGS|MOVE TO TAGS|TAGS)/, 'TAGS'],
    [/^(MOVE|PHOTO DELETE|SET-DATE)/, 'PHOTOS'],
    [/^(VA |MERGE)/, 'LIBRARY'],
    [/(IMPORT)$/, 'IMPORT'],
    [/^UPLOAD/, 'UPLOAD'],
    [/^(ERROR|FATAL)/, 'ERROR'],
];

// Fallbacks for the older, untagged messages — keyword guesses at what area they're from.
const CATEGORY_KEYWORDS = [
    [/upload/i, 'UPLOAD'],
    [/download/i, 'DOWNLOAD'],
    [/delet/i, 'FILES'],
    [/ssdp|discover|sonos|device|renderer|airplay|upnp|description|service:|icon/i, 'DEVICES'],
    [/api key|token|settings|from db|shutting down|listening at|sigterm/i, 'SYSTEM'],
    [/playlist|queue|play folder|browse|play/i, 'PLAYBACK'],
];

export function categorize(message) {
    const tag = /^\s*(?:\[\d{4}-[^\]]*\]\s*)?\[([^\]]{1,40})\]/.exec(message);
    if (tag) {
        const name = tag[1].trim().toUpperCase();
        const alias = CATEGORY_ALIASES.find(([re]) => re.test(name));
        return alias ? alias[1] : name.replace(/\s+/g, '-');
    }
    const kw = CATEGORY_KEYWORDS.find(([re]) => re.test(message));
    return kw ? kw[1] : 'GENERAL';
}

function captureLog(type, ...args) {
    const timestamp = getTimestamp();
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');

    serverLogs.push({ type, timestamp, message, category: categorize(message) });
    if (serverLogs.length > MAX_LOGS) {
        serverLogs.shift();
    }
}

export function clearServerLogs() {
    serverLogs.length = 0;
}

console.log = (...args) => {
    captureLog('log', ...args);
    originalLog(`[${getTimestamp()}]`, ...args);
};

console.error = (...args) => {
    captureLog('error', ...args);
    originalError(`[${getTimestamp()}]`, ...args);
};

console.warn = (...args) => {
    captureLog('warn', ...args);
    originalWarn(`[${getTimestamp()}]`, ...args);
};
