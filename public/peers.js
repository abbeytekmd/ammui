// Peer link: Settings → Peer Link (connections to other AMMUI servers, and letting them connect
// here), and what's shared. A connected server shows up as a media server in its own right
// (served by lib/peer-services/media.js), so it's browsed in Media like any other.

async function peerApi(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code, fingerprint: data.fingerprint });
    return data;
}

const peerAgo = ms => {
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    return `${Math.round(mins / 60)} h ago`;
};

// --- What this server shares ---------------------------------------------------------------
// Each folder and file in music, pictures and videos is On, Off or As Parent (the default: it
// takes its folder's setting). The sections themselves are off unless switched on, so nothing is
// shared until something is. Set from the ⋯ menu in Media; listed in Settings → Peer Link.

const PEER_SHARE_SECTIONS = ['music', 'pictures', 'videos'];
let peerShareFlags = null; // { "music/Artist": "on" | "off" }, null until loaded

const peerShareable = id => typeof id === 'string' && PEER_SHARE_SECTIONS.includes(id.split('/')[0]);

// { value: 'on' | 'off', explicit, from }: `from` is the path the setting comes from (null for
// the default off at the top)
function peerShareState(id) {
    const flags = peerShareFlags || {};
    const parts = String(id).split('/').filter(Boolean);
    for (let i = parts.length; i > 0; i--) {
        const p = parts.slice(0, i).join('/');
        if (flags[p] === 'on' || flags[p] === 'off') return { value: flags[p], explicit: i === parts.length, from: p };
    }
    return { value: 'off', explicit: false, from: null };
}

const peerShareAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const PEER_SHARE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"></line></svg>';

function peerShareBadgeInner(id) {
    const st = peerShareState(id);
    // Only what's been set On or Off here is marked; As Parent (the default) isn't, so a shared
    // folder's contents don't each carry the icon
    if (!st.explicit) return '';
    const title = st.value === 'on'
        ? 'Shared on the peer link, with everything in it unless switched off there'
        : 'Not shared on the peer link (switched off here)';
    return `<span class="peer-share-badge ${st.value}${st.explicit ? ' explicit' : ''}" title="${peerShareAttr(title)}">${PEER_SHARE_ICON}</span>`;
}

function peerShareBadgeHtml(id) {
    if (!peerShareable(id)) return '';
    return `<span class="peer-share-slot" data-share-path="${peerShareAttr(id)}">${peerShareFlags ? peerShareBadgeInner(id) : ''}</span>`;
}

function peerShareMenuHtml(id) {
    if (!peerShareable(id)) return '';
    const parentHint = id.includes('/') ? 'Same as the folder it is in' : 'Off (the top of the library is not shared)';
    return `<div class="dropdown-item peer-share-row" onclick="event.stopPropagation()" data-share-path="${peerShareAttr(id)}">
        ${PEER_SHARE_ICON.replace('width="12" height="12"', 'width="14" height="14"')}
        <span class="peer-share-label">Peer Share</span>
        <span class="peer-share-seg" role="group" aria-label="Share on the peer link">
            <button type="button" data-v="on" onclick="setPeerShareFromMenu(this, event)" title="Shared, with everything in it unless switched off there">On</button>
            <button type="button" data-v="off" onclick="setPeerShareFromMenu(this, event)" title="Not shared, nor anything in it unless switched on there">Off</button>
            <button type="button" data-v="inherit" onclick="setPeerShareFromMenu(this, event)" title="${peerShareAttr(parentHint)}">As Parent</button>
        </span>
    </div>`;
}

// Bring the badges and menu buttons on screen up to date (a change to a folder changes
// everything shown inside it)
function refreshPeerShareUi() {
    if (!peerShareFlags) return;
    document.querySelectorAll('.peer-share-slot[data-share-path]').forEach(slot => {
        slot.innerHTML = peerShareBadgeInner(slot.dataset.sharePath);
    });
    document.querySelectorAll('.peer-share-row[data-share-path]').forEach(row => {
        const st = peerShareState(row.dataset.sharePath);
        const current = st.explicit ? st.value : 'inherit';
        row.querySelectorAll('button[data-v]').forEach(b => {
            const on = b.dataset.v === current;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        // "As Parent" says what that comes to when it's on
        const inheritBtn = row.querySelector('button[data-v="inherit"]');
        if (inheritBtn) inheritBtn.classList.toggle('inherits-on', !st.explicit && st.value === 'on');
    });
}

async function loadPeerShares() {
    try {
        peerShareFlags = (await peerApi('/api/peer-shares')).flags || {};
        refreshPeerShareUi();
        renderPeerShareList();
    } catch (e) {
        console.warn('[PEER] Could not load sharing settings:', e.message);
    }
}

async function setPeerShare(id, value) {
    try {
        peerShareFlags = (await peerApi('/api/peer-shares', { method: 'POST', body: JSON.stringify({ path: id, value }) })).flags || {};
        refreshPeerShareUi();
        renderPeerShareList();
    } catch (e) {
        showToast(`Couldn't change sharing: ${e.message}`);
    }
}

function setPeerShareFromMenu(btn, event) {
    if (event) event.stopPropagation();
    const row = btn.closest('[data-share-path]');
    if (row) setPeerShare(row.dataset.sharePath, btn.dataset.v);
}

// Settings → Peer Link: everything with a setting of its own
function renderPeerShareList() {
    const list = document.getElementById('peer-share-list');
    if (!list || !peerShareFlags) return;
    const entries = Object.entries(peerShareFlags)
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    list.innerHTML = '';
    if (!entries.length) {
        const li = document.createElement('li');
        li.className = 'settings-hint';
        li.textContent = 'Nothing is shared yet.';
        list.appendChild(li);
        return;
    }
    for (const [p, value] of entries) {
        const li = document.createElement('li');
        li.className = 'peer-link-item';
        li.innerHTML = `<div class="peer-link-info"><b></b><span class="settings-hint"></span></div>
            <div class="peer-link-actions"><button class="btn-control btn-small">Remove</button></div>`;
        li.querySelector('b').textContent = p;
        li.querySelector('.settings-hint').textContent = value === 'on'
            ? 'Shared, with everything in it unless switched off there'
            : 'Switched off, with everything in it unless switched on there';
        const btn = li.querySelector('button');
        btn.title = 'Remove this setting, so it goes back to being the same as its folder';
        btn.onclick = () => setPeerShare(p, 'inherit');
        list.appendChild(li);
    }
}

loadPeerShares();

// --- Settings → Peer Link -------------------------------------------------------------------

async function loadPeerLinkSettings() {
    await Promise.all([loadPeerListener(), loadPeerLinks(), loadPeerShares()]);
}

async function loadPeerListener() {
    try {
        renderPeerListener(await peerApi('/api/settings/peer-listener'));
    } catch (e) {
        document.getElementById('peer-listener-status').textContent = `Couldn't load: ${e.message}`;
    }
}

function renderPeerListener(s) {
    document.getElementById('peer-listener-enabled').checked = s.enabled;
    document.getElementById('peer-listener-port').value = s.port;
    const pw = document.getElementById('peer-listener-password');
    pw.value = '';
    pw.placeholder = s.hasPassword ? 'Leave empty to keep the current password' : 'At least 8 characters';
    const status = document.getElementById('peer-listener-status');
    status.style.color = '';
    if (!s.enabled) status.textContent = s.hasPassword ? 'Switched off.' : 'Switched off. Set a password to switch it on.';
    else if (s.error) { status.textContent = `Not running: ${s.error}`; status.style.color = '#f87171'; }
    else if (s.running) status.textContent = `Listening on port ${s.port}.`;
    else status.textContent = 'Starting...';
    if (s.fingerprint) status.textContent += ` Certificate fingerprint: ${s.fingerprint.slice(0, 23)}…`;

    const list = document.getElementById('peer-session-list');
    list.innerHTML = '';
    for (const sess of s.sessions || []) {
        const li = document.createElement('li');
        li.className = 'peer-link-item';
        li.innerHTML = `<div class="peer-link-info"><b></b><span class="settings-hint"></span></div>`;
        li.querySelector('b').textContent = sess.name;
        li.querySelector('.settings-hint').textContent = `Connected from ${sess.ip}, last active ${peerAgo(sess.lastUsed)}`;
        list.appendChild(li);
    }
}

async function savePeerListener({ toggle = false } = {}) {
    const box = document.getElementById('peer-listener-enabled');
    const body = { enabled: box.checked };
    if (!toggle) {
        body.port = document.getElementById('peer-listener-port').value;
        const pw = document.getElementById('peer-listener-password').value;
        if (pw) body.password = pw;
    } else if (box.checked && document.getElementById('peer-listener-password').value) {
        body.password = document.getElementById('peer-listener-password').value;
    }
    try {
        const s = await peerApi('/api/settings/peer-listener', { method: 'POST', body: JSON.stringify(body) });
        renderPeerListener(s);
        showToast(s.enabled ? (s.error ? `Peer link: ${s.error}` : 'Peer link saved') : 'Peer link switched off', s.error ? 'error' : 'success', 3000);
    } catch (e) {
        if (toggle) box.checked = !box.checked;
        showToast(e.message);
    }
}

async function loadPeerLinks() {
    try {
        const { peers } = await peerApi('/api/peer-links');
        renderPeerLinks(peers);
    } catch (e) { }
    // A connection added, removed or renamed changes the list of media servers
    if (typeof fetchDevices === 'function') fetchDevices();
}

// Show that server in Media
async function openPeerInMedia(p) {
    if (typeof fetchDevices === 'function') await fetchDevices();
    if (!currentDevices.some(d => d.udn === p.udn && d.isServer)) {
        return showToast(`${p.name} doesn't share media (it may need updating)`);
    }
    if (document.getElementById('server-settings-modal').style.display === 'flex') closeServerSettingsModal();
    selectServer(p.udn);
}

function renderPeerLinks(peers) {
    const list = document.getElementById('peer-link-list');
    list.innerHTML = '';
    for (const p of peers) {
        const li = document.createElement('li');
        li.className = 'peer-link-item';
        li.innerHTML = `
            <div class="peer-link-info"><b></b><span class="settings-hint peer-link-address"></span><span class="settings-hint peer-link-error"></span></div>
            <div class="peer-link-actions">
                <button class="btn-control btn-small primary" data-act="open" title="Browse it in Media">Open in Media</button>
                <button class="btn-control btn-small ghost" data-act="remove">Remove</button>
            </div>`;
        li.querySelector('b').textContent = p.name;
        li.querySelector('.peer-link-address').textContent = `${p.host}:${p.port}`;
        const err = li.querySelector('.peer-link-error');
        if (p.error) { err.textContent = p.error; err.style.color = '#f87171'; } else err.remove();
        li.querySelector('[data-act="open"]').onclick = () => openPeerInMedia(p);
        li.querySelector('[data-act="remove"]').onclick = () => removePeerLink(p);

        if (p.code === 'FINGERPRINT_CHANGED' && p.newFingerprint) {
            const box = document.createElement('div');
            box.className = 'peer-link-fix';
            box.innerHTML = `<p class="settings-hint"></p><button class="btn-control btn-small">Trust the New Certificate</button>`;
            box.querySelector('p').textContent = `Its certificate changed. That happens if it was reinstalled or its certs folder was deleted; otherwise something may be intercepting the connection. Was ${p.fingerprint.slice(0, 23)}…, now ${p.newFingerprint.slice(0, 23)}…`;
            box.querySelector('button').onclick = () => trustPeerCertificate(p);
            li.appendChild(box);
        } else if (p.code === 'NEEDS_PASSWORD') {
            const box = document.createElement('div');
            box.className = 'peer-link-fix input-with-button';
            box.innerHTML = `<input type="password" placeholder="Password" autocomplete="new-password"><button class="btn-control btn-small primary">Save</button>`;
            const input = box.querySelector('input');
            const save = () => setPeerPassword(p, input.value);
            box.querySelector('button').onclick = save;
            input.onkeydown = e => { if (e.key === 'Enter') save(); };
            li.appendChild(box);
        }
        list.appendChild(li);
    }
}

function setPeerAddStatus(text, isError) {
    const el = document.getElementById('peer-add-status');
    el.style.display = text ? '' : 'none';
    el.textContent = text || '';
    el.style.color = isError ? '#f87171' : '';
}

async function addPeerLink() {
    const address = document.getElementById('peer-add-address').value.trim();
    const port = document.getElementById('peer-add-port').value;
    const passwordEl = document.getElementById('peer-add-password');
    const btn = document.getElementById('peer-add-btn');
    if (!address) return setPeerAddStatus('Enter the other server\'s address.', true);
    if (!passwordEl.value) return setPeerAddStatus('Enter its peer link password.', true);
    btn.disabled = true;
    setPeerAddStatus('Connecting...');
    try {
        const { peer } = await peerApi('/api/peer-links', { method: 'POST', body: JSON.stringify({ address, port, password: passwordEl.value }) });
        passwordEl.value = '';
        document.getElementById('peer-add-address').value = '';
        document.getElementById('peer-add-port').value = '';
        setPeerAddStatus(`Connected to ${peer.name}: it's now in the list of media servers. Its certificate (${peer.fingerprint.slice(0, 23)}…) is trusted.`);
        await loadPeerLinks();
    } catch (e) {
        setPeerAddStatus(e.message, true);
    } finally {
        btn.disabled = false;
    }
}

async function removePeerLink(p) {
    if (!confirm(`Remove the connection to ${p.name}?`)) return;
    await peerApi(`/api/peer-links/${encodeURIComponent(p.id)}`, { method: 'DELETE' }).catch(e => showToast(e.message));
    loadPeerLinks();
}

async function trustPeerCertificate(p) {
    try {
        await peerApi(`/api/peer-links/${encodeURIComponent(p.id)}/trust`, { method: 'POST' });
        showToast(`Now trusting ${p.name}'s new certificate`, 'success', 3000);
    } catch (e) { showToast(e.message); }
    loadPeerLinks();
}

async function setPeerPassword(p, password) {
    if (!password) return;
    try {
        await peerApi(`/api/peer-links/${encodeURIComponent(p.id)}/password`, { method: 'POST', body: JSON.stringify({ password }) });
        showToast(`Connected to ${p.name}`, 'success', 3000);
    } catch (e) { showToast(e.message); }
    loadPeerLinks();
}
