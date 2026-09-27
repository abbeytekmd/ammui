// Things saved against a media file (tags, favourites, photo rotations, hidden photos) are keyed
// by "<server name>/<path>" - e.g. "abbeysrv1 Media Library/local-files/pictures/x.jpg" - rather
// than by URL, so they survive the server's address, port or http/https changing.
//
// The server name is the media server's DLNA friendlyName. MediaServer.browse() reports which
// server each URL came from, which is how a bare URL posted by the browser is mapped back to it.
import os from 'os';

const originToServer = new Map();  // "host:port" -> server name
const hostToServers = new Map();   // "host" -> Set of server names (fallback when the port differs)
const serverToOrigin = new Map();  // server name -> "http://host:port"

let local = { name: () => 'AMMUI Media Library', origin: () => 'http://127.0.0.1:3000', ports: ['3000'] };

let onLearned = null;

// Describes this app's own library, whose URLs can arrive via any of the machine's addresses.
export function setLocalMediaServer({ name, origin, ports }) {
    local = { name, origin, ports: ports.map(String) };
}

// Called (with no arguments) whenever a server is identified that wasn't known before.
export function onNewMediaServer(fn) {
    onLearned = fn;
}

let localHosts = null;
let localHostsAt = 0;
function isLocalHost(u) {
    if (!local.ports.includes(u.port || (u.protocol === 'https:' ? '443' : '80'))) return false;
    if (!localHosts || Date.now() - localHostsAt > 60000) {
        const name = os.hostname().toLowerCase();
        localHosts = new Set(['localhost', '127.0.0.1', '::1', name, `${name}.local`]);
        for (const addrs of Object.values(os.networkInterfaces())) {
            for (const a of addrs || []) localHosts.add(a.address.toLowerCase());
        }
        localHostsAt = Date.now();
    }
    return localHosts.has(u.hostname.replace(/^\[|\]$/g, '').toLowerCase());
}

// Remembers that URLs on this origin belong to `serverName`. `weak` is for a device's description
// address, which may not be where it serves media from, so it never overrides a browsed URL.
export function registerMediaOrigin(url, serverName, { weak = false } = {}) {
    if (!url || !serverName) return;
    let u;
    try { u = new URL(url); } catch (e) { return; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || isLocalHost(u)) return;
    if (!weak) serverToOrigin.set(serverName, u.origin);
    else if (!serverToOrigin.has(serverName)) serverToOrigin.set(serverName, u.origin);
    if (originToServer.get(u.host) === serverName || (weak && originToServer.has(u.host))) return;

    originToServer.set(u.host, serverName);
    if (!hostToServers.has(u.hostname)) hostToServers.set(u.hostname, new Set());
    hostToServers.get(u.hostname).add(serverName);
    onLearned?.();
}

function serverForUrl(u) {
    if (isLocalHost(u)) return local.name();
    const exact = originToServer.get(u.host);
    if (exact) return exact;
    const onHost = hostToServers.get(u.hostname);
    return onHost && onHost.size === 1 ? [...onHost][0] : null;
}

// URL (or an existing key) -> key. Anything that isn't an http(s) URL is assumed to already be a key.
export function mediaKey(uri) {
    if (typeof uri !== 'string' || !uri) return uri;
    if (uri.startsWith('/local-files/')) return local.name() + uri; // older host-free keys
    if (/^[\w.-]+:\d+\//.test(uri)) uri = 'http://' + uri;          // "host:port/..." from a then-unknown server
    if (!/^https?:\/\//i.test(uri)) return uri;
    let u;
    try { u = new URL(uri); } catch (e) { return uri; }
    const pathPart = u.pathname + u.search;
    const server = serverForUrl(u);
    // A server we've never browsed: still drop the scheme so http/https don't make two keys.
    return (server || u.host) + pathPart;
}

// Key -> { server, path }, matching the longest known server name.
export function splitMediaKey(key) {
    if (typeof key !== 'string') return null;
    const names = [local.name(), ...serverToOrigin.keys()].sort((a, b) => b.length - a.length);
    const server = names.find(n => key.startsWith(n + '/'));
    if (server) return { server, path: key.slice(server.length), isLocal: server === local.name() };
    const m = key.match(/^([\w.-]+(?::\d+)?)(\/.*)$/); // unknown server: "host:port/path"
    return m ? { server: m[1], path: m[2], isLocal: false, isHost: true } : null;
}

// Key -> a URL that works now (always http, which is what DLNA renderers can play), or null.
export function mediaUrlFromKey(key) {
    if (typeof key !== 'string') return null;
    if (/^https?:\/\//i.test(key)) return key;
    const parts = splitMediaKey(key);
    if (!parts) return null;
    if (parts.isLocal) return local.origin() + parts.path;
    if (parts.isHost) return `http://${parts.server}${parts.path}`;
    const origin = serverToOrigin.get(parts.server);
    return origin ? origin + parts.path : null;
}
