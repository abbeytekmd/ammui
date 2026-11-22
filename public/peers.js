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

// A folder switched On can also have a tag filter: then only the files in it with one of those
// tags are shared.

// There's a set of these for everyone, and one for each server linked to this one. They add up:
// a linked server gets what's shared with everyone, and what's shared with it alone as well. The
// set being changed is picked with "Share with" (in the ⋯ menu and in Settings → Peer Link).

const PEER_SHARE_SECTIONS = ['music', 'pictures', 'videos'];
let peerShareFlags = null; // everyone's: { "music/Artist": "on" | "off" }, null until loaded
let peerShareTags = {};    // everyone's: { "music/Artist": ["tag", ...] }: tag filters on folders switched on
let peerShareLinks = [];   // [{ key, name, flags, tags }]: each linked server's own set
// The set being changed: '' for everyone, or a linked server's key. Remembered in this browser.
const PEER_SHARE_SCOPE_KEY = 'peerShareScope';
let peerShareScope = (() => { try { return localStorage.getItem(PEER_SHARE_SCOPE_KEY) || ''; } catch { return ''; } })();

const peerShareTagText = tags => tags.length
    ? `only files tagged ${tags.map(t => `“${t}”`).join(' or ')}`
    : 'a tag filter with no tags left, so nothing in it';

const peerShareable = id => typeof id === 'string' && PEER_SHARE_SECTIONS.includes(id.split('/')[0]);

const peerShareScopeLink = () => peerShareScope ? peerShareLinks.find(l => l.key === peerShareScope) || null : null;
const peerShareScopeName = () => peerShareScopeLink()?.name || 'Everyone';
// { flags, tags } of the set being changed
const peerShareScopeSet = () => peerShareScopeLink() || { flags: peerShareFlags || {}, tags: peerShareTags };

// { value: 'on' | 'off', explicit, from } in one set's flags: `from` is the path the setting comes
// from (null for the default off at the top)
function peerShareState(id, flags = peerShareFlags || {}) {
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
    if (!st.explicit) {
        // Switched on for some linked servers alone
        const names = peerShareLinks.filter(l => l.flags[id] === 'on').map(l => l.name);
        if (!names.length || st.value === 'on') return '';
        return `<span class="peer-share-badge on explicit links" title="${peerShareAttr(`Shared on the peer link with ${names.join(', ')} only`)}">${PEER_SHARE_ICON}</span>`;
    }
    const filter = st.value === 'on' ? peerShareTags[st.from] : null;
    const title = filter
        ? `Shared on the peer link: ${peerShareTagText(filter)}`
        : st.value === 'on'
            ? 'Shared on the peer link, with everything in it unless switched off there'
            : 'Not shared on the peer link (switched off here)';
    return `<span class="peer-share-badge ${st.value}${st.explicit ? ' explicit' : ''}${filter ? ' filtered' : ''}" title="${peerShareAttr(title)}">${PEER_SHARE_ICON}</span>`;
}

function peerShareBadgeHtml(id) {
    if (!peerShareable(id)) return '';
    return `<span class="peer-share-slot" data-share-path="${peerShareAttr(id)}">${peerShareFlags ? peerShareBadgeInner(id) : ''}</span>`;
}

// "Share with": everyone, or one of the servers linked to this one (shown only when there are some)
function peerShareScopeSelectHtml() {
    return `<select class="alarms-input peer-share-scope" onchange="setPeerShareScope(this.value)" onclick="event.stopPropagation()"
        aria-label="Share with" title="Whose sharing to change: everyone's, or one linked server's own (on top of everyone's)"></select>`;
}

function fillPeerShareScopeSelect(select) {
    select.innerHTML = '<option value="">Everyone</option>' + peerShareLinks
        .map(l => `<option value="${peerShareAttr(l.key)}">${peerShareAttr(l.name)} only</option>`).join('');
    select.value = peerShareScopeLink() ? peerShareScope : '';
}

function setPeerShareScope(key) {
    peerShareScope = key || '';
    try { localStorage.setItem(PEER_SHARE_SCOPE_KEY, peerShareScope); } catch { }
    refreshPeerShareUi();
    renderPeerShareList();
}

// `isFolder` adds the tag filter button, shown while the folder is switched On
function peerShareMenuHtml(id, isFolder = false) {
    if (!peerShareable(id)) return '';
    return `<div class="dropdown-item peer-share-row" onclick="event.stopPropagation()" data-share-path="${peerShareAttr(id)}">
        ${PEER_SHARE_ICON.replace('width="12" height="12"', 'width="14" height="14"')}
        <span class="peer-share-label">Peer Share</span>
        <span class="peer-share-seg" role="group" aria-label="Share on the peer link">
            <button type="button" data-v="on" onclick="setPeerShareFromMenu(this, event)">On</button>
            <button type="button" data-v="off" onclick="setPeerShareFromMenu(this, event)">Off</button>
            <button type="button" data-v="inherit" onclick="setPeerShareFromMenu(this, event)">As Parent</button>
        </span>
        <span class="peer-share-scope-wrap" hidden><span class="peer-share-scope-label">With</span>${peerShareScopeSelectHtml()}</span>
        <span class="peer-share-scope-note settings-hint" hidden></span>
    </div>${isFolder ? `
    <button type="button" class="dropdown-item peer-share-tags-row" data-share-tags-path="${peerShareAttr(id)}" onclick="event.stopPropagation(); openPeerShareTags(this.dataset.shareTagsPath)" style="display: none;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>
        <span class="peer-share-tags-label">Share Only Tagged…</span>
    </button>` : ''}`;
}

// Bring the badges and menu buttons on screen up to date (a change to a folder changes
// everything shown inside it). The menu shows the set chosen in "Share with".
function refreshPeerShareUi() {
    if (!peerShareFlags) return;
    const link = peerShareScopeLink();
    const set = peerShareScopeSet();
    document.querySelectorAll('.peer-share-slot[data-share-path]').forEach(slot => {
        slot.innerHTML = peerShareBadgeInner(slot.dataset.sharePath);
    });
    document.querySelectorAll('.peer-share-row[data-share-path]').forEach(row => {
        const id = row.dataset.sharePath;
        const st = peerShareState(id, set.flags);
        const everyone = link ? peerShareState(id) : null;
        const current = st.explicit ? st.value : 'inherit';
        const who = link ? ` for ${link.name}` : '';
        const titles = {
            on: `Shared${who}, with everything in it unless switched off there`,
            off: `Not shared${who}, nor anything in it unless switched on there`,
            inherit: id.includes('/') ? `Same as the folder it is in${who}` : `Off${who} (the top of the library is not shared)`,
        };
        row.querySelectorAll('button[data-v]').forEach(b => {
            const on = b.dataset.v === current;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.title = titles[b.dataset.v];
        });
        // "As Parent" says what that comes to when it's on
        const inheritBtn = row.querySelector('button[data-v="inherit"]');
        if (inheritBtn) inheritBtn.classList.toggle('inherits-on', !st.explicit && st.value === 'on');
        const wrap = row.querySelector('.peer-share-scope-wrap');
        if (wrap) {
            wrap.hidden = !peerShareLinks.length;
            if (peerShareLinks.length) fillPeerShareScopeSelect(wrap.querySelector('select'));
        }
        // A linked server sees everyone's too, so its own Off can't hide what everyone gets
        const note = row.querySelector('.peer-share-scope-note');
        if (note) {
            note.hidden = !(everyone?.value === 'on');
            note.textContent = everyone?.value === 'on' ? `Already shared with everyone, so ${link.name} sees it whatever is set here.` : '';
        }
    });
    // The tag filter is for a folder switched On here
    document.querySelectorAll('.peer-share-tags-row[data-share-tags-path]').forEach(btn => {
        const p = btn.dataset.shareTagsPath;
        btn.style.display = set.flags[p] === 'on' ? '' : 'none';
        const filter = set.tags[p];
        btn.querySelector('.peer-share-tags-label').textContent = filter
            ? `Only Tagged: ${filter.length ? filter.join(', ') : '(none)'}`
            : 'Share Only Tagged…';
        btn.title = filter ? `Shares ${peerShareTagText(filter)}. Click to change.` : 'Share only the files in this folder with one of the tags you choose';
    });
}

function applyPeerShareData(data) {
    peerShareFlags = data.flags || {};
    peerShareTags = data.tags || {};
    peerShareLinks = Array.isArray(data.links) ? data.links : [];
    refreshPeerShareUi();
    renderPeerShareList();
}

async function loadPeerShares() {
    try {
        applyPeerShareData(await peerApi('/api/peer-shares'));
    } catch (e) {
        console.warn('[PEER] Could not load sharing settings:', e.message);
    }
}

// Changes the set chosen in "Share with". `tags` (only with 'on'): the folder's tag filter, [] for
// none; left out, it's kept.
async function setPeerShare(id, value, tags) {
    const link = peerShareScopeLink();
    try {
        applyPeerShareData(await peerApi('/api/peer-shares', {
            method: 'POST', body: JSON.stringify({ path: id, value, tags, link: link?.key }),
        }));
        return true;
    } catch (e) {
        showToast(`Couldn't change sharing: ${e.message}`);
        loadPeerShares(); // a linked server may have gone
        return false;
    }
}

// The tag filter of a folder switched on: tick the tags whose files are shared, none to share all
async function openPeerShareTags(id) {
    document.querySelectorAll('.dropdown-menu.show, .dropdown-menu.active').forEach(m => m.classList.remove('show', 'active'));
    let all = [];
    try {
        all = (await peerApi('/api/tags')).tags || [];
    } catch (e) {
        return showToast(`Couldn't load tags: ${e.message}`);
    }
    const current = new Set(peerShareScopeSet().tags[id] || []);
    // Tags in the filter that no file has any more still show, so they can be taken off
    const names = [...new Set([...all, ...current])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    document.getElementById('peer-share-tags-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'peer-share-tags-modal';
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
        <div class="modal-content" style="max-width: 460px;">
            <div class="modal-header">
                <div class="modal-title-group">
                    <h2>Share Only Tagged</h2>
                    <p class="modal-subtitle"></p>
                </div>
                <button class="btn-close" data-act="close" aria-label="Close">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>
            <p class="settings-hint">Only files in this folder (and the folders in it) with at least one of the ticked
                tags are shared. Tick none to share everything in it.</p>
            <input type="search" class="peer-share-tags-search" placeholder="Find a tag">
            <div class="peer-share-tags-list"></div>
            <div class="peer-share-tags-actions">
                <button class="btn-control" data-act="close">Cancel</button>
                <button class="btn-control primary" data-act="save">Save</button>
            </div>
        </div>`;
    overlay.querySelector('.modal-subtitle').textContent = `${id} · shared with ${peerShareScopeLink() ? `${peerShareScopeName()} only` : 'everyone'}`;
    const list = overlay.querySelector('.peer-share-tags-list');
    if (!names.length) {
        list.innerHTML = '<p class="settings-hint">No files are tagged yet.</p>';
    }
    for (const tag of names) {
        const label = document.createElement('label');
        label.className = 'peer-share-tag-option';
        label.innerHTML = '<input type="checkbox"><span></span>';
        label.querySelector('input').value = tag;
        label.querySelector('input').checked = current.has(tag);
        label.querySelector('span').textContent = tag === 'fav' ? 'fav (favourites)' : tag;
        list.appendChild(label);
    }
    overlay.querySelector('.peer-share-tags-search').addEventListener('input', e => {
        const q = e.target.value.trim().toLowerCase();
        list.querySelectorAll('.peer-share-tag-option').forEach(l => {
            l.style.display = !q || l.querySelector('input').value.toLowerCase().includes(q) ? '' : 'none';
        });
    });
    const close = () => overlay.remove();
    overlay.addEventListener('click', async e => {
        if (e.target === overlay) return close();
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'close') return close();
        if (act === 'save') {
            const tags = [...list.querySelectorAll('input:checked')].map(i => i.value);
            if (await setPeerShare(id, 'on', tags)) {
                close();
                showToast(tags.length ? `Sharing only files tagged ${tags.join(', ')} in ${id}` : `Sharing everything in ${id}`);
            }
        }
    });
    document.body.appendChild(overlay);
}

function setPeerShareFromMenu(btn, event) {
    if (event) event.stopPropagation();
    const row = btn.closest('[data-share-path]');
    if (row) setPeerShare(row.dataset.sharePath, btn.dataset.v);
}

// Settings → Peer Link: everything with a setting of its own in the set chosen in "Share with"
function renderPeerShareList() {
    const list = document.getElementById('peer-share-list');
    if (!list || !peerShareFlags) return;
    const scopeRow = document.getElementById('peer-share-scope-row');
    if (scopeRow) {
        scopeRow.hidden = !peerShareLinks.length;
        if (peerShareLinks.length) fillPeerShareScopeSelect(scopeRow.querySelector('select'));
    }
    const link = peerShareScopeLink();
    const set = peerShareScopeSet();
    const entries = Object.entries(set.flags)
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    list.innerHTML = '';
    if (!entries.length) {
        const li = document.createElement('li');
        li.className = 'settings-hint';
        li.textContent = link ? `Nothing is shared with ${link.name} alone. It sees what's shared with everyone.` : 'Nothing is shared with everyone yet.';
        list.appendChild(li);
        return;
    }
    for (const [p, value] of entries) {
        const li = document.createElement('li');
        li.className = 'peer-link-item';
        li.innerHTML = `<div class="peer-link-info"><b></b><span class="settings-hint"></span></div>
            <div class="peer-link-actions">${value === 'on' ? '<button class="btn-control btn-small" data-act="tags">Tags…</button>' : ''}<button class="btn-control btn-small" data-act="remove">Remove</button></div>`;
        li.querySelector('b').textContent = p;
        const filter = value === 'on' ? set.tags[p] : null;
        li.querySelector('.settings-hint').textContent = filter
            ? `Shared: ${peerShareTagText(filter)}, unless switched off there`
            : value === 'on'
                ? 'Shared, with everything in it unless switched off there'
                : 'Switched off, with everything in it unless switched on there';
        const tagsBtn = li.querySelector('[data-act="tags"]');
        if (tagsBtn) {
            tagsBtn.title = 'Share only the files in it with one of the tags you choose (a filter on a single file only shares it if it has one)';
            tagsBtn.onclick = () => openPeerShareTags(p);
        }
        const btn = li.querySelector('[data-act="remove"]');
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

// While Settings → Peer Link is open, keep both lists up to date: a connection made or removed by
// the other server shows here without reopening it
const peerLinkPanelOpen = () => document.getElementById('server-settings-modal')?.style.display === 'flex'
    && document.getElementById('settings-peerlink')?.classList.contains('active');
let peerLinkPollSig = '';
setInterval(async () => {
    // Each time it's opened, the first look only notes what was loaded with it
    if (!peerLinkPanelOpen()) { peerLinkPollSig = ''; return; }
    if (document.hidden) return;
    // Not while typing in one of its fields (rendering clears the password boxes)
    if (document.activeElement?.closest?.('#settings-peerlink') && document.activeElement.tagName === 'INPUT') return;
    try {
        const [listener, links] = await Promise.all([peerApi('/api/settings/peer-listener'), peerApi('/api/peer-links')]);
        const sig = JSON.stringify([listener.links?.map(l => l.id), listener.sessions?.length,
            links.peers.map(p => [p.id, p.name, p.error]), links.droppedByOther.length]);
        if (sig === peerLinkPollSig) return;
        const first = !peerLinkPollSig;
        peerLinkPollSig = sig;
        if (first) return;
        renderPeerListener(listener);
        renderPeerLinks(links.peers, links.droppedByOther || []);
        loadPeerShares();
        if (typeof fetchDevices === 'function') fetchDevices();
    } catch (e) { }
}, 10000);

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
    const links = s.links || [];
    if (links.length || (s.sessions || []).length) {
        const head = document.createElement('li');
        head.className = 'settings-hint';
        head.textContent = 'Servers connected to this one:';
        list.appendChild(head);
    }
    for (const link of links) {
        const li = document.createElement('li');
        li.className = 'peer-link-item';
        li.innerHTML = `<div class="peer-link-info"><b></b><span class="settings-hint"></span></div>
            <div class="peer-link-actions"><button class="btn-control btn-small ghost" data-act="remove">Remove</button></div>`;
        li.querySelector('b').textContent = link.name;
        li.querySelector('.settings-hint').textContent = `From ${link.ip}, connected since ${new Date(link.since).toLocaleDateString()}`
            + (link.lastUsed ? `, last active ${peerAgo(link.lastUsed)}` : '');
        const btn = li.querySelector('[data-act="remove"]');
        btn.title = 'End this connection. It is removed on the other server too, and has to be made again there with the password.';
        btn.onclick = () => removePeerIncoming(link);
        list.appendChild(li);
    }
    for (const sess of s.sessions || []) {
        const li = document.createElement('li');
        li.className = 'peer-link-item';
        li.innerHTML = `<div class="peer-link-info"><b></b><span class="settings-hint"></span></div>`;
        li.querySelector('b').textContent = sess.name;
        li.querySelector('.settings-hint').textContent = `Connected from ${sess.ip}, last active ${peerAgo(sess.lastUsed)} (an older version: update it to manage this connection here)`;
        list.appendChild(li);
    }
}

async function removePeerIncoming(link) {
    if (!confirm(`Remove the connection from ${link.name}? It's removed there too, and has to be made again with the password.`)) return;
    try {
        renderPeerListener(await peerApi(`/api/peer-incoming/${encodeURIComponent(link.id)}`, { method: 'DELETE' }));
        loadPeerShares(); // what was shared with it alone went with it
    } catch (e) {
        showToast(e.message);
        loadPeerListener();
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
        const { peers, droppedByOther } = await peerApi('/api/peer-links');
        renderPeerLinks(peers, droppedByOther || []);
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

function renderPeerLinks(peers, droppedByOther = []) {
    const list = document.getElementById('peer-link-list');
    list.innerHTML = '';
    // Removed at the other end, so removed here too: say so, as they've vanished from the list
    for (const d of droppedByOther) {
        const li = document.createElement('li');
        li.className = 'settings-hint peer-link-dropped';
        li.textContent = `${d.name} (${d.host}:${d.port}) removed the connection ${peerAgo(d.at)}, so it was removed here too. Connect again with its password to make it again.`;
        list.appendChild(li);
    }
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
