// ─── Find Duplicates dialog ──────────────────────────────────────────────────
// Finds photos in a library folder (and the folders inside it) that are copies of each other, and
// offers to delete the extra copies. The server works out each photo's fingerprint (a 64-bit
// "difference hash" of a tiny grey shrink of it, which survives resizing and re-saving) and, for
// photos that might be byte-for-byte copies, a SHA-1. Here they're compared and grouped:
//   Identical files: same bytes.
//   Same photo:      fingerprints at most DUP_SAME_BITS apart (a resized or re-saved copy).
//   Look-alikes:     at most DUP_ALIKE_BITS apart (burst shots, small edits), only if asked for.
// In each group the best copy (most pixels, then biggest file, then oldest, then the plainest name)
// is kept; the others are ticked for deleting where it's safe to guess (identical files, and smaller
// copies of the same photo). Nothing is deleted until Delete is pressed.

const DUP_SAME_BITS = 4;
const DUP_ALIKE_BITS = 10;
const DUP_BATCH = 24;
const DUP_GROUPS_SHOWN = 200;

let _dup = null;

function dupThumbUrl(relPath) {
    const uri = '/local-files/' + relPath.split('/').map(encodeURIComponent).join('/');
    return `/api/thumb?uri=${encodeURIComponent(uri)}&w=400`;
}

function dupSetStatus(text, fraction, isError = false) {
    const status = document.getElementById('dup-status');
    status.textContent = text;
    status.classList.toggle('error', isError);
    document.getElementById('dup-bar').style.width = `${Math.round((fraction || 0) * 100)}%`;
}

async function openDuplicatesModal(index, event) {
    if (event) event.stopPropagation();
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));
    const item = currentBrowserItems[index];
    if (!item) return;
    _dup = { item, photos: [], groups: [], marked: new Set(), working: false, stop: false };
    document.getElementById('dup-desc').textContent = `Photos in "${item.title}" and the folders inside it.`;
    try { document.getElementById('dup-mode').value = localStorage.getItem('dupMode') || 'same'; } catch (e) { }
    document.getElementById('dup-results').innerHTML = '';
    document.getElementById('duplicates-modal').style.display = 'flex';
    dupSetStatus('Finding photos...', 0);
    dupUpdateButtons();

    const state = _dup;
    try {
        const res = await fetch(`/api/local/photo-hashes?id=${encodeURIComponent(item.id)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        if (state !== _dup) return;
        state.photos = data.photos;
        if (!state.photos.length) return dupSetStatus('No photos in this folder.', 0);
        await dupFingerprint();
    } catch (err) {
        if (state === _dup) dupSetStatus(`Couldn't read the folder: ${err.message}`, 0, true);
    }
}

function closeDuplicatesModal() {
    if (_dup) _dup.stop = true;
    _dup = null;
    document.getElementById('duplicates-modal').style.display = 'none';
    document.getElementById('dup-results').innerHTML = '';
}

function stopDuplicates() {
    if (_dup?.working) _dup.stop = true;
}

// Asks the server for the fingerprints (and SHA-1s) still missing, a batch at a time.
async function dupFetchHashes(items, label) {
    const state = _dup;
    const byPath = new Map(state.photos.map(p => [p.path, p]));
    for (let i = 0; i < items.length; i += DUP_BATCH) {
        if (state.stop || state !== _dup) return false;
        dupSetStatus(`${label} ${i + 1}-${Math.min(i + DUP_BATCH, items.length)} of ${items.length}...`, i / items.length);
        const res = await fetch('/api/local/photo-hashes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: items.slice(i, i + DUP_BATCH) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        for (const r of data.items) {
            const photo = byPath.get(r.path);
            if (photo && r.hash) { photo.hash = r.hash; photo.stamp = r.stamp; }
        }
    }
    return true;
}

async function dupFingerprint() {
    const state = _dup;
    state.working = true;
    dupUpdateButtons();
    try {
        const missing = state.photos.filter(p => !p.hash || p.hash.dhash == null).map(p => ({ path: p.path }));
        if (missing.length && !await dupFetchHashes(missing, 'Looking at photo')) return dupStopped();
        // Same file size and same fingerprint: might be byte-for-byte copies, so check their bytes
        const buckets = new Map();
        for (const p of state.photos) {
            const k = `${p.size}|${p.hash?.dhash ?? ''}`;
            if (!buckets.has(k)) buckets.set(k, []);
            buckets.get(k).push(p);
        }
        const toCheck = [...buckets.values()].filter(b => b.length > 1).flat().filter(p => !p.hash?.sha1).map(p => ({ path: p.path, sha1: true }));
        if (toCheck.length && !await dupFetchHashes(toCheck, 'Checking possible copy')) return dupStopped();
        if (state !== _dup) return;
        dupFindGroups();
    } catch (err) {
        if (state === _dup) dupSetStatus(`Couldn't look at the photos: ${err.message}`, 0, true);
    } finally {
        state.working = false;
        if (state === _dup) dupUpdateButtons();
    }
}

function dupStopped() {
    if (!_dup) return;
    _dup.stop = false;
    dupFindGroups('Stopped. Showing what was found so far; open it again to carry on.');
}

// ─── Grouping ────────────────────────────────────────────────────────────────

function dupPopcount(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Higher is the copy to keep
function dupKeepScore(p) {
    const pixels = (p.hash?.w || 0) * (p.hash?.h || 0);
    const name = p.path.split('/').pop();
    const copyName = /copy|kopie|\(\d+\)|[-_ ]\d{1,2}\.[^.]+$/i.test(name) ? 1 : 0;
    return [pixels, p.size, -(p.mtime || 0), -copyName, -p.path.length];
}

function dupCompareKeep(a, b) {
    const sa = dupKeepScore(a), sb = dupKeepScore(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
    return a.path.localeCompare(b.path);
}

function dupFindGroups(message) {
    const state = _dup;
    const mode = document.getElementById('dup-mode').value;
    const photos = state.photos;
    const n = photos.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

    // Identical files
    const bySha = new Map();
    photos.forEach((p, i) => {
        const sha = p.hash?.sha1;
        if (!sha) return;
        if (bySha.has(sha)) join(bySha.get(sha), i); else bySha.set(sha, i);
    });

    // Close fingerprints
    const bits = mode === 'alike' ? DUP_ALIKE_BITS : mode === 'same' ? DUP_SAME_BITS : -1;
    const hi = new Uint32Array(n), lo = new Uint32Array(n), has = new Uint8Array(n);
    photos.forEach((p, i) => {
        const h = p.hash?.dhash;
        if (!h || h.length !== 16) return;
        hi[i] = parseInt(h.slice(0, 8), 16) >>> 0;
        lo[i] = parseInt(h.slice(8), 16) >>> 0;
        has[i] = 1;
    });
    if (bits >= 0) {
        for (let i = 0; i < n; i++) {
            if (!has[i]) continue;
            for (let j = i + 1; j < n; j++) {
                if (!has[j]) continue;
                const d = dupPopcount(hi[i] ^ hi[j]) + dupPopcount(lo[i] ^ lo[j]);
                if (d <= bits) join(i, j);
            }
        }
    }

    const groups = new Map();
    photos.forEach((p, i) => {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(i);
    });

    state.marked.clear();
    state.groups = [];
    for (const members of groups.values()) {
        if (members.length < 2) continue;
        const list = members.map(i => photos[i]).sort(dupCompareKeep);
        const keep = list[0];
        const identical = list.every(p => p.hash?.sha1 && p.hash.sha1 === keep.hash?.sha1);
        // How far apart the furthest two are, to say what kind of group it is
        let spread = 0;
        for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) {
            const [i, j] = members[a] < members[b] ? [members[a], members[b]] : [members[b], members[a]];
            if (has[i] && has[j]) spread = Math.max(spread, dupPopcount(hi[i] ^ hi[j]) + dupPopcount(lo[i] ^ lo[j]));
        }
        const kind = identical ? 'identical' : spread <= DUP_SAME_BITS ? 'same' : 'alike';
        const group = { photos: list, kind };
        state.groups.push(group);
        // Safe guesses: identical files, and smaller copies of the same photo
        const keepPixels = (keep.hash?.w || 0) * (keep.hash?.h || 0);
        for (const p of list.slice(1)) {
            const sameBytes = p.hash?.sha1 && p.hash.sha1 === keep.hash?.sha1;
            const smaller = kind === 'same' && (p.hash?.w || 0) * (p.hash?.h || 0) < keepPixels;
            if (sameBytes || smaller) state.marked.add(p.path);
        }
    }
    const order = { identical: 0, same: 1, alike: 2 };
    state.groups.sort((a, b) => order[a.kind] - order[b.kind] || b.photos.length - a.photos.length);

    const extra = state.groups.reduce((s, g) => s + g.photos.length - 1, 0);
    dupSetStatus(message || (state.groups.length
        ? `${state.groups.length} group${state.groups.length === 1 ? '' : 's'} of copies in ${n} photos (${extra} extra cop${extra === 1 ? 'y' : 'ies'}).`
        : `No duplicates in ${n} photos.`), 1);
    dupRender();
}

function setDuplicatesMode(value) {
    try { localStorage.setItem('dupMode', value); } catch (e) { }
    if (_dup && !_dup.working && _dup.photos.length) dupFindGroups();
}

// ─── Showing ─────────────────────────────────────────────────────────────────

function dupFormatSize(bytes) {
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function dupRender() {
    const state = _dup;
    if (!state) return;
    const kinds = {
        identical: ['Identical files', 'exactly the same file'],
        same: ['Same photo', 'resized or re-saved copies'],
        alike: ['Look-alikes', 'very similar, check before deleting'],
    };
    let html = '';
    state.groups.slice(0, DUP_GROUPS_SHOWN).forEach((g, gi) => {
        const [title, hint] = kinds[g.kind];
        html += `<div class="dup-group dup-${g.kind}"><div class="dup-group-head"><strong>${title}</strong><span>${hint}</span>` +
            `<button class="btn-control ghost" onclick="dupKeepOnly(${gi}, 0)" title="Tick all but the best copy">Keep Best</button></div><div class="dup-tiles">`;
        g.photos.forEach((p, pi) => {
            const marked = state.marked.has(p.path);
            const parts = p.path.split('/');
            const name = parts.pop();
            const folder = parts.slice(1).join('/') || parts.join('/');
            const dims = p.hash?.w ? `${p.hash.w}×${p.hash.h}` : '';
            html += `<div class="dup-tile${marked ? ' marked' : ''}" role="checkbox" aria-checked="${marked}" tabindex="0" data-group="${gi}" data-photo="${pi}"` +
                ` onclick="dupToggle(${gi}, ${pi})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();dupToggle(${gi}, ${pi})}" title="${escapeHtml(p.path)}">` +
                `<div class="dup-thumb"><img loading="lazy" src="${dupThumbUrl(p.path)}" alt="">${pi === 0 ? '<span class="dup-best">Best</span>' : ''}<span class="dup-mark">Delete</span></div>` +
                `<div class="dup-name">${escapeHtml(name)}</div>` +
                `<div class="dup-meta">${escapeHtml(folder)}</div>` +
                `<div class="dup-meta">${[dims, dupFormatSize(p.size)].filter(Boolean).join(' · ')}</div></div>`;
        });
        html += `</div></div>`;
    });
    if (state.groups.length > DUP_GROUPS_SHOWN) html += `<p class="settings-hint">${state.groups.length - DUP_GROUPS_SHOWN} more groups not shown. Delete these first, then look again.</p>`;
    const results = document.getElementById('dup-results');
    const scroll = results.scrollTop;
    results.innerHTML = html;
    results.scrollTop = scroll;
    dupUpdateButtons();
}

function dupToggle(gi, pi) {
    const state = _dup;
    const group = state?.groups[gi];
    const photo = group?.photos[pi];
    if (!photo) return;
    if (state.marked.has(photo.path)) state.marked.delete(photo.path);
    else {
        // At least one copy is always kept
        if (group.photos.every(p => p === photo || state.marked.has(p.path))) {
            return showToast('One copy is always kept: untick another first', 'info', 2500);
        }
        state.marked.add(photo.path);
    }
    const el = document.querySelector(`.dup-tile[data-group="${gi}"][data-photo="${pi}"]`);
    el?.classList.toggle('marked', state.marked.has(photo.path));
    el?.setAttribute('aria-checked', state.marked.has(photo.path));
    dupUpdateButtons();
}

function dupKeepOnly(gi, keepIndex) {
    const group = _dup?.groups[gi];
    if (!group) return;
    group.photos.forEach((p, i) => i === keepIndex ? _dup.marked.delete(p.path) : _dup.marked.add(p.path));
    dupRender();
}

function dupUpdateButtons() {
    const state = _dup;
    document.getElementById('dup-stop').style.display = state?.working ? '' : 'none';
    const n = state?.marked.size || 0;
    const btn = document.getElementById('dup-delete');
    btn.disabled = !n || !!state?.working || !!state?.deleting;
    btn.textContent = n ? `Delete ${n} Photo${n === 1 ? '' : 's'}` : 'Delete';
}

async function deleteDuplicates() {
    const state = _dup;
    const paths = [...(state?.marked || [])];
    if (!paths.length) return;
    const bytes = paths.reduce((s, p) => s + (state.photos.find(x => x.path === p)?.size || 0), 0);
    if (!confirm(`Delete ${paths.length} photo${paths.length === 1 ? '' : 's'} (${dupFormatSize(bytes)}) from the library? This can't be undone.`)) return;
    state.deleting = true;
    dupUpdateButtons();
    const deleted = [];
    const failed = [];
    for (let i = 0; i < paths.length; i++) {
        if (state !== _dup) break;
        dupSetStatus(`Deleting ${i + 1} of ${paths.length}...`, i / paths.length);
        try {
            const res = await fetch('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: paths[i] }) });
            if (!res.ok && res.status !== 404) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
            deleted.push(paths[i]);
        } catch (err) {
            failed.push(`${paths[i]}: ${err.message}`);
        }
    }
    state.deleting = false;
    // The file browser forgets them too
    if (typeof rememberDeleted === 'function') deleted.forEach(rememberDeleted);
    const lastFolder = typeof browsePath !== 'undefined' ? browsePath[browsePath.length - 1] : null;
    if (lastFolder && typeof browse === 'function' && selectedServerUdn === LOCAL_SERVER_UDN) browse(selectedServerUdn, lastFolder.id);
    if (failed.length) console.warn('[DUPES] Couldn\'t delete:', failed);
    showToast(`Deleted ${deleted.length} photo${deleted.length === 1 ? '' : 's'}` + (failed.length ? `; ${failed.length} couldn't be deleted` : ''), failed.length ? 'error' : 'success', 4000);
    if (state !== _dup) return;
    const gone = new Set(deleted);
    state.photos = state.photos.filter(p => !gone.has(p.path));
    dupFindGroups();
}
