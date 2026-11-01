// Passwords tab: a table of name, username, password and website (the notes are in the form, and
// searched), added to, changed and deleted here. The list from the server never carries the passwords themselves (they're kept
// encrypted, see lib/secret-box.js); each is fetched on its own to show, copy or change it, so
// the table shows them as asterisks. Each row's Email button sends that entry to the address below.

const PASSWORD_MASK = '********';
const PASSWORD_SHOW_MS = 15000; // a shown password hides itself again after this

let passwordEntries = []; // [{ id, name, username, url, notes, hasPassword }]
let passwordEditing = null; // the id of the entry in the form, or null for a new one
const passwordsShown = new Map(); // id -> timer, for passwords showing in the table

async function showPasswords() {
    setAppView('passwords');
    closePasswordForm();
    await loadPasswords();
}

async function loadPasswords() {
    try {
        const res = await fetch('/api/passwords');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        passwordEntries = data.entries;
        const email = document.getElementById('passwords-email-input');
        if (document.activeElement !== email) email.value = data.emailTo || '';
        email.placeholder = data.fallbackEmailTo ? `${data.fallbackEmailTo} (the shopping list's)` : 'you@example.com';
        renderPasswords();
    } catch (err) {
        showToast(`Couldn't load the passwords: ${err.message}`, 'error');
    }
}

// A website as typed ("example.com") as a link that can only open a web page
const passwordLink = url => /^https?:\/\//i.test(url) ? url : `https://${url}`;

function renderPasswords() {
    const query = document.getElementById('passwords-search').value.trim().toLowerCase();
    const shown = !query ? passwordEntries : passwordEntries.filter(e =>
        [e.name, e.username, e.url, e.notes].some(v => v.toLowerCase().includes(query)));
    const icon = d => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    const ICONS = {
        show: icon('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
        copy: icon('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
        edit: icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
        delete: icon('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
        email: icon('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>'),
    };
    document.getElementById('passwords-body').innerHTML = shown.map(e => `
        <tr>
            <td class="pw-name">${escapeHtml(e.name)}</td>
            <td>${escapeHtml(e.username)}</td>
            <td class="pw-secret-cell">${e.hasPassword ? `
                <span class="pw-secret" id="pw-secret-${e.id}">${PASSWORD_MASK}</span>
                <button type="button" class="pw-icon-btn" title="Show the password" onclick="togglePasswordInTable(${e.id})">${ICONS.show}</button>
                <button type="button" class="pw-icon-btn" title="Copy the password" onclick="copyPassword(${e.id})">${ICONS.copy}</button>` : ''}
            </td>
            <td>${e.url ? `<a href="${escapeAttr(passwordLink(e.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.url)}</a>` : ''}</td>
            <td class="pw-actions">
                <button type="button" class="pw-icon-btn" title="Change" onclick="editPassword(${e.id})">${ICONS.edit}</button>
                <button type="button" class="pw-icon-btn pw-delete" title="Delete" onclick="deletePasswordEntry(${e.id})">${ICONS.delete}</button>
                <button type="button" class="pw-icon-btn" title="Email this entry" onclick="emailPasswordEntry(${e.id}, this)">${ICONS.email}</button>
            </td>
        </tr>`).join('');
    const empty = document.getElementById('passwords-empty');
    empty.hidden = shown.length > 0;
    empty.textContent = passwordEntries.length ? 'Nothing matches.' : 'No passwords yet. Press Add to save one.';
    passwordsShown.forEach(timer => clearTimeout(timer));
    passwordsShown.clear();
}

async function fetchPassword(id) {
    const res = await fetch(`/api/passwords/${id}/password`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data.password;
}

// Shows a password in its row for a while, or hides it again
async function togglePasswordInTable(id) {
    const el = document.getElementById(`pw-secret-${id}`);
    if (!el) return;
    if (passwordsShown.has(id)) {
        clearTimeout(passwordsShown.get(id));
        passwordsShown.delete(id);
        el.textContent = PASSWORD_MASK;
        el.classList.remove('shown');
        return;
    }
    try {
        el.textContent = await fetchPassword(id);
        el.classList.add('shown');
        passwordsShown.set(id, setTimeout(() => togglePasswordInTable(id), PASSWORD_SHOW_MS));
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function copyPassword(id) {
    try {
        await navigator.clipboard.writeText(await fetchPassword(id));
        showToast('Password copied', 'success', 2000);
    } catch (err) {
        showToast(window.isSecureContext ? `Couldn't copy it: ${err.message}` : 'Copying needs the app opened over HTTPS', 'error');
    }
}

// --- Adding and changing ---

const passwordField = name => document.getElementById(`password-${name}`);

// Opens the form for an entry (with its password), or empty for a new one (id null)
async function editPassword(id) {
    const entry = id === null ? null : passwordEntries.find(e => e.id === id);
    if (id !== null && !entry) return;
    let password = '';
    try {
        if (entry?.hasPassword) password = await fetchPassword(id);
    } catch (err) {
        return showToast(err.message, 'error');
    }
    passwordEditing = id;
    for (const name of ['name', 'username', 'url', 'notes']) passwordField(name).value = entry?.[name] || '';
    passwordField('password').value = password;
    setPasswordFieldShown(false);
    const form = document.getElementById('password-form');
    form.hidden = false;
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    passwordField('name').focus();
}

function closePasswordForm() {
    document.getElementById('password-form').hidden = true;
    passwordField('password').value = '';
    passwordEditing = null;
}

async function savePasswordForm() {
    const body = Object.fromEntries(['name', 'username', 'password', 'url', 'notes'].map(name => [name, passwordField(name).value]));
    const editing = passwordEditing;
    try {
        const res = await fetch(editing === null ? '/api/passwords' : `/api/passwords/${editing}`, {
            method: editing === null ? 'POST' : 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        closePasswordForm();
        showToast(editing === null ? `Saved ${data.name}` : `Changed ${data.name}`, 'success', 2000);
        await loadPasswords();
    } catch (err) {
        showToast(`Couldn't save it: ${err.message}`, 'error');
    }
}

async function deletePasswordEntry(id) {
    const entry = passwordEntries.find(e => e.id === id);
    if (!entry || !confirm(`Delete "${entry.name}"? This can't be undone.`)) return;
    try {
        const res = await fetch(`/api/passwords/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        if (passwordEditing === id) closePasswordForm();
        showToast(`Deleted ${entry.name}`, 'success', 2000);
        await loadPasswords();
    } catch (err) {
        showToast(`Couldn't delete it: ${err.message}`, 'error');
    }
}

function setPasswordFieldShown(show) {
    passwordField('password').type = show ? 'text' : 'password';
    document.getElementById('password-show-btn').textContent = show ? 'Hide' : 'Show';
}

function togglePasswordField() {
    setPasswordFieldShown(passwordField('password').type === 'password');
}

// A random 20-character password of letters, digits and a few symbols, shown so it can be checked
function generatePassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*+-=?@_';
    const limit = 256 - (256 % chars.length); // drop the bytes that would favour some characters
    let out = '';
    while (out.length < 20) {
        for (const b of crypto.getRandomValues(new Uint8Array(32))) {
            if (b < limit && out.length < 20) out += chars[b % chars.length];
        }
    }
    passwordField('password').value = out;
    setPasswordFieldShown(true);
}

// --- Email ---

async function emailPasswordEntry(id, btn) {
    const entry = passwordEntries.find(e => e.id === id);
    if (!entry) return;
    btn.disabled = true;
    try {
        const res = await fetch(`/api/passwords/${id}/email`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        showToast(`${entry.name} emailed to ${data.to}`, 'success', 3000);
    } catch (err) {
        showToast(`Couldn't email it: ${err.message}`, 'error', 6000);
    } finally {
        btn.disabled = false;
    }
}

async function savePasswordsEmail() {
    const input = document.getElementById('passwords-email-input');
    try {
        const res = await fetch('/api/settings/general', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passwordsEmail: input.value.trim() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText);
        showToast('Saved', 'success', 2000);
    } catch (err) {
        showToast(`Couldn't save the address: ${err.message}`, 'error');
    }
}
