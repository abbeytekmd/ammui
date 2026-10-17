import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

// Everything logged also goes to logs/ammui.log (next to the data, as in server.js), so a
// crash leaves a trace. Written synchronously so the last lines before a crash aren't lost.
// Rotated at LOG_FILE_MAX bytes: ammui.log → ammui.log.1 → ... → ammui.log.<LOG_FILE_KEEP>, then dropped.
const LOG_FILE_MAX = 5 * 1024 * 1024;
const LOG_FILE_KEEP = 5;
const logFilePath = path.join(
    typeof process.pkg !== 'undefined' ? path.dirname(process.execPath) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
    'logs', 'ammui.log');
let logFd = null;
let logFileSize = 0;

function openLogFile() {
    try {
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
        logFd = fs.openSync(logFilePath, 'a');
        logFileSize = fs.fstatSync(logFd).size;
    } catch (err) {
        logFd = null;
        originalError(`[LOG] Can't write ${logFilePath}: ${err.message}`);
    }
}

function rotateLogFile() {
    try { fs.closeSync(logFd); } catch { }
    logFd = null;
    try {
        fs.rmSync(`${logFilePath}.${LOG_FILE_KEEP}`, { force: true });
        for (let i = LOG_FILE_KEEP - 1; i >= 1; i--) {
            if (fs.existsSync(`${logFilePath}.${i}`)) fs.renameSync(`${logFilePath}.${i}`, `${logFilePath}.${i + 1}`);
        }
        fs.renameSync(logFilePath, `${logFilePath}.1`);
    } catch (err) {
        originalError(`[LOG] Couldn't rotate ${logFilePath}: ${err.message}`);
    }
    openLogFile();
}

function writeLogFile(type, timestamp, args) {
    if (logFd === null) return;
    const message = args.map(arg => arg instanceof Error ? (arg.stack || arg.message)
        : typeof arg === 'object' ? safeStringify(arg) : String(arg)).join(' ');
    const line = `[${timestamp}] ${type === 'log' ? '' : type.toUpperCase() + ' '}${message}
`;
    try {
        logFileSize += fs.writeSync(logFd, line);
        if (logFileSize >= LOG_FILE_MAX) rotateLogFile();
    } catch { }
}

function safeStringify(value) {
    try { return JSON.stringify(value); } catch { return String(value); }
}

openLogFile();
writeLogFile('log', getTimestamp(), [`[SYSTEM] ---- Server starting (pid ${process.pid}) ----`]);
process.on('exit', code => writeLogFile('log', getTimestamp(), [`[SYSTEM] ---- Server exiting (code ${code}) ----`]));

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
    writeLogFile(type, timestamp, args);
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
