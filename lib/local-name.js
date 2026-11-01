// Answers "<server name>.local" on the local network (mDNS), so the name given to the server in
// Settings is also its address: a server called "Kitchen" is https://kitchen.local/. Phones and
// computers look .local names up themselves. The computer's own name (its hostname) carries on
// working as well; that one is answered by the operating system.
import os from 'os';
import makeMdns from 'multicast-dns';

// The .local name for a server name: lower case, with anything but letters, digits and hyphens
// turned into hyphens ("Living Room" -> "living-room.local"). Null when nothing usable is left.
export function localNameFor(serverName) {
    const label = String(serverName || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
    return label ? `${label}.local` : null;
}

// This machine's IPv4 addresses, those on the same network as `from` first when it's given
function addressesFor(from) {
    const all = [];
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if ((a.family === 'IPv4' || a.family === 4) && !a.internal) all.push(a);
        }
    }
    const toInt = ip => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
    const same = from ? all.filter(a => ((toInt(a.address) ^ toInt(from)) & toInt(a.netmask)) === 0) : [];
    return (same.length ? same : all).map(a => a.address);
}

let mdns = null;

// Starts answering for the name getName() returns at the time (so a rename takes effect at once)
export function advertiseLocalName(getName) {
    if (mdns) return;
    try {
        mdns = makeMdns();
    } catch (err) {
        console.warn('[MDNS] Could not answer for this server\'s .local name:', err.message);
        return;
    }
    mdns.on('error', err => console.warn('[MDNS] .local name:', err.message));
    mdns.on('query', (query, rinfo) => {
        const name = localNameFor(getName());
        if (!name) return;
        const asked = query.questions.some(q => q.name.toLowerCase() === name && (q.type === 'A' || q.type === 'ANY'));
        if (!asked) return;
        const answers = addressesFor(rinfo?.address).map(data => ({ name, type: 'A', ttl: 120, data, flush: true }));
        if (answers.length) mdns.respond({ answers });
    });
}
