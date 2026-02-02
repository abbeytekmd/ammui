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

function captureLog(type, ...args) {
    const timestamp = getTimestamp();
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');

    // Don't log DEBUG messages to the app console buffer
    if (message.includes('[DEBUG]')) return;

    serverLogs.push({ type, timestamp, message });
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
