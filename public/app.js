(function () {
    window.appLogs = [];
    const MAX_LOGS = 500;

    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

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

    function captureLog(type, source, ...args) {
        const timestamp = getTimestamp();
        const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');

        // Don't log DEBUG messages to the app console modal
        if (message.includes('[DEBUG]')) return;

        window.appLogs.push({ type, timestamp, message, source });
        if (window.appLogs.length > MAX_LOGS) {
            window.appLogs.shift();
        }

        const consoleList = document.getElementById('console-log-list');
        if (consoleList && document.getElementById('console-modal').style.display === 'flex') {
            appendLogToUI({ type, timestamp, message, source });
        }
    }

    console.log = (...args) => {
        captureLog('log', 'CLIENT', ...args);
        originalLog(`[${getTimestamp()}]`, ...args);
    };

    console.error = (...args) => {
        captureLog('error', 'CLIENT', ...args);
        originalError(`[${getTimestamp()}]`, ...args);
    };

    console.warn = (...args) => {
        captureLog('warn', 'CLIENT', ...args);
        originalWarn(`[${getTimestamp()}]`, ...args);
    };
})();

// Constants
const LOCAL_SERVER_UDN = 'uuid:ammui-local-media-server';

const deviceListElement = document.getElementById('device-list');
const serverListElement = document.getElementById('server-list');
const rendererCount = document.getElementById('renderer-count');
const serverCount = document.getElementById('server-count');
const tabRendererCount = document.getElementById('tab-renderer-count');
const tabServerCount = document.getElementById('tab-server-count');

const playlistItems = document.getElementById('playlist-items');
const playlistCount = document.getElementById('playlist-count');

const browserContainer = document.getElementById('browser-container');
const browserItems = document.getElementById('browser-items');
const browserBreadcrumbs = document.getElementById('browser-breadcrumbs');

const serverModal = document.getElementById('server-modal');
const rendererModal = document.getElementById('renderer-modal');
const manageModal = document.getElementById('manage-modal');
const aboutModal = document.getElementById('about-modal');
const manageRendererList = document.getElementById('manage-renderer-list');
const manageServerList = document.getElementById('manage-server-list');

let currentDevices = [];
let selectedRendererUdn = localStorage.getItem('selectedRendererUdn');
let selectedServerUdn = localStorage.getItem('selectedServerUdn');
let browsePath = [{ id: '0', title: 'Root' }];
let currentBrowserItems = [];
let currentPlaylistItems = [];
let currentTrackId = null;
let currentTransportState = 'Stopped';
let currentPositionSeconds = 0;
let durationSeconds = 0;
let lastStatusFetchTime = 0; // Initialize to 0 to prevent interpolation before first sync
let lastStatusPositionSeconds = 0;
let isUserDraggingSlider = false;
let currentExistingLetters = [];
let currentArtworkQuery = '';
let currentArtworkUrl = '';
let failedArtworkQueries = new Set(); // Track failed artwork queries to avoid retrying
let browseScrollPositions = {}; // Store scroll position by folder ID

function showToast(message, type = 'error', duration = 5000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    if (type === 'error') {
        icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
    } else {
        icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
    }

    const msgEl = document.createElement('div');
    msgEl.className = 'toast-message';
    msgEl.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.innerHTML = '✕';
    closeBtn.onclick = () => {
        toast.classList.add('toast-fade-out');
        setTimeout(() => toast.remove(), 300);
    };

    toast.appendChild(icon);
    toast.appendChild(msgEl);
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    if (duration > 0) {
        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.add('toast-fade-out');
                setTimeout(() => toast.remove(), 300);
            }
        }, duration);
    }
}

async function fetchDevices() {
    try {
        const response = await fetch('/api/devices');
        const devices = await response.json();

        if (JSON.stringify(devices) !== JSON.stringify(currentDevices)) {
            currentDevices = devices;
            renderDevices();
        }

    } catch (err) {
        console.error('Failed to fetch devices:', err);
    }
}

async function selectServer(udn) {
    if (!udn) return;
    selectedServerUdn = udn;
    localStorage.setItem('selectedServerUdn', udn);
    closeServerModal();
    renderDevices();
    updateLocalOnlyUI();

    browserContainer.style.display = 'flex';

    // Prioritize last browsed path, then home location, then root
    let lastPaths = {};
    let homeLocations = {};
    try {
        const storedLast = localStorage.getItem('serverLastPaths');
        if (storedLast) lastPaths = JSON.parse(storedLast);

        const storedHome = localStorage.getItem('serverHomeLocations');
        if (storedHome) homeLocations = JSON.parse(storedHome);
    } catch (e) {
        console.error('Failed to parse paths:', e);
    }

    const pathToUse = lastPaths[udn] || homeLocations[udn] || [{ id: '0', title: 'Root' }];

    try {
        browsePath = pathToUse;
        updateBreadcrumbs();
        const lastFolder = browsePath[browsePath.length - 1];
        await browse(udn, lastFolder.id);
    } catch (e) {
        console.error('Failed to navigate to saved path:', e);
        browsePath = [{ id: '0', title: 'Root' }];
        updateBreadcrumbs();
        await browse(udn, '0');
    }
}

async function selectDevice(udn) {
    selectedRendererUdn = udn;
    localStorage.setItem('selectedRendererUdn', udn);
    closeRendererModal();
    renderDevices();

    playlistItems.innerHTML = '<div class="loading">Loading playlist...</div>';

    currentArtworkQuery = '';
    currentArtworkUrl = '';
    failedArtworkQueries.clear(); // Clear failed queries when switching devices
    hideAllPlayerArt();
    await fetchPlaylist(udn);
    await fetchVolume();
}


async function browse(udn, objectId) {
    browserItems.innerHTML = '<div class="loading">Browsing...</div>';
    try {
        const response = await fetch(`/api/browse/${encodeURIComponent(udn)}?objectId=${encodeURIComponent(objectId)}`);
        if (!response.ok) throw new Error('Failed to browse server');
        const data = await response.json();
        renderBrowser(data.items);
    } catch (err) {
        console.error('Browse error:', err);
        browserItems.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    }
}

function updateBreadcrumbs() {
    const homeIndicator = `
        <button id="btn-go-home" class="btn-control home-breadcrumb-btn" onclick="goHome()" title="Go to home folder">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                <polyline points="9 22 9 12 15 12 15 22"></polyline>
            </svg>
        </button>
        <span class="breadcrumb-separator" style="margin-right: 0.5rem"></span>
    `;

    browserBreadcrumbs.innerHTML = homeIndicator + browsePath.map((item, index) => `
        <span class="breadcrumb-item" onclick="navigateToPath(${index})">${item.title}</span>
    `).join('<span class="breadcrumb-separator">/</span>');
}

function saveLastPath() {
    if (!selectedServerUdn) return;
    let lastPaths = {};
    try {
        const stored = localStorage.getItem('serverLastPaths');
        if (stored) lastPaths = JSON.parse(stored);
    } catch (e) { }
    lastPaths[selectedServerUdn] = browsePath;
    localStorage.setItem('serverLastPaths', JSON.stringify(lastPaths));
}

async function navigateToPath(index) {
    browsePath = browsePath.slice(0, index + 1);
    saveLastPath();
    updateBreadcrumbs();
    const item = browsePath[index];
    await browse(selectedServerUdn, item.id);
}

async function enterFolder(id, title) {
    saveCurrentScrollPosition();
    browsePath.push({ id, title });
    saveLastPath();
    updateBreadcrumbs();
    await browse(selectedServerUdn, id);
}

function saveCurrentScrollPosition() {
    if (browsePath.length > 0 && browserItems) {
        const currentFolder = browsePath[browsePath.length - 1];
        browseScrollPositions[currentFolder.id] = browserItems.scrollTop;

        // Prune any saved positions that are no longer in our current path
        // (Ensures we only remember "parents" of where we are going)
        const pathIds = new Set(browsePath.map(p => p.id));
        Object.keys(browseScrollPositions).forEach(id => {
            if (!pathIds.has(id)) {
                delete browseScrollPositions[id];
            }
        });

        console.log(`[DEBUG] Saved scroll for parent ${currentFolder.title}. Cache size: ${Object.keys(browseScrollPositions).length}`);
    }
}

async function addToPlaylist(uri, title, artist, album, duration, protocolInfo, autoSwitch = true) {
    if (!selectedRendererUdn) {
        alert('Please select a Renderer on the left first!');
        return;
    }

    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/insert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri, title, artist, album, duration, protocolInfo })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to add track');
        }

        showToast(`Added: ${title}`, 'success', 2000);
        await fetchPlaylist(selectedRendererUdn);

        // On mobile, switch to playlist view after adding if requested
        if (autoSwitch && window.innerWidth <= 800) {
            switchView('playlist');
        }
    } catch (err) {
        console.error('Client: Error adding track:', err);
        showToast(`Failed to add track: ${err.message}`);
        throw err;
    }
}

async function queueFolder(objectId, title) {
    if (!selectedRendererUdn) {
        alert('Please select a Renderer on the left first!');
        return;
    }

    showToast(`Queuing folder: ${title}...`, 'info', 3000);
    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/queue-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverUdn: selectedServerUdn, objectId })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to queue folder');
        }

        const data = await response.json();
        showToast(`Queued ${data.count} tracks from: ${title}`, 'success', 3000);
        await fetchPlaylist(selectedRendererUdn);
    } catch (err) {
        console.error('Queue folder error:', err);
        showToast(`Failed to queue folder: ${err.message}`);
    }
}

async function playFolder(objectId, title) {
    if (!selectedRendererUdn) {
        alert('Please select a Renderer on the left first!');
        return;
    }

    showToast(`Playing folder: ${title}...`, 'info', 3000);
    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/play-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverUdn: selectedServerUdn, objectId })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to play folder');
        }

        const data = await response.json();
        showToast(`Playing ${data.count} tracks from: ${title}`, 'success', 3000);
        await fetchPlaylist(selectedRendererUdn);
    } catch (err) {
        console.error('Play folder error:', err);
        showToast(`Failed to play folder: ${err.message}`);
    }
}


async function downloadTrack(uri, title, artist, album) {
    showToast(`Downloading: ${title}...`, 'info', 3000);
    try {
        const response = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri, title, artist, album })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Download failed');
        }

        const data = await response.json();
        const msg = data.skipped ? `Already exists: ${data.filename}` : `Saved: ${data.filename}`;
        showToast(msg, 'success', 3000);
    } catch (err) {
        console.error('Download error:', err);
        showToast(`Download failed: ${err.message}`);
    }
}

async function downloadFolder(udn, objectId, title, artist, album) {
    showToast(`Downloading folder: ${title}...`, 'info', 5000);
    try {
        const response = await fetch('/api/download-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ udn, objectId, title, artist, album })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Folder download failed');
        }

        const data = await response.json();
        showToast(`Folder download complete! Saved ${data.downloadCount} tracks.`, 'success', 5000);
    } catch (err) {
        console.error('Folder download error:', err);
        showToast(`Folder download failed: ${err.message}`);
    }
}

async function deleteTrack(id, title) {
    if (!confirm(`Are you sure you want to delete "${title}"?`)) return;

    try {
        const response = await fetch('/api/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Delete failed');
        }

        showToast(`Deleted: ${title}`, 'success', 2000);
        // Refresh the browser view
        const lastFolder = browsePath[browsePath.length - 1];
        await browse(selectedServerUdn, lastFolder.id);
    } catch (err) {
        console.error('Delete error:', err);
        showToast(`Delete failed: ${err.message}`);
    }
}

async function playTrack(uri, title, artist, album, duration, protocolInfo) {
    if (!selectedRendererUdn) {
        alert('Please select a Renderer on the left first!');
        return;
    }

    try {
        await clearPlaylist();
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/insert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri, title, artist, album, duration, protocolInfo })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to add track');
        }

        const data = await response.json();
        const newId = data.newId;

        showToast(`Playing: ${title}`, 'success', 2000);
        await fetchPlaylist(selectedRendererUdn);

        if (newId) {
            await playPlaylistItem(newId);
        }

        if (window.innerWidth <= 800) {
            switchView('playlist');
        }
    } catch (err) {
        console.error('Play track from browser error:', err);
    }
}

async function addAllToPlaylist() {
    const tracks = currentBrowserItems.filter(item => item.type === 'item');
    if (tracks.length === 0) return;

    // Sort by disc then track
    tracks.sort((a, b) => {
        if (a.discNumber !== b.discNumber) return (a.discNumber || 1) - (b.discNumber || 1);
        return (a.trackNumber || 0) - (b.trackNumber || 0);
    });

    if (!selectedRendererUdn) {
        alert('Please select a Renderer on the left first!');
        return;
    }

    const btn = document.getElementById('btn-add-all');
    btn.classList.add('disabled');
    const originalContent = btn.innerHTML;
    btn.textContent = 'Queuing...';

    try {
        for (const track of tracks) {
            await addToPlaylist(track.uri, track.title, track.artist, track.album, track.duration, track.protocolInfo, false);
        }

        // Switch once at the end for mobile
        if (window.innerWidth <= 800) {
            switchView('playlist');
        }
    } catch (err) {
        console.error('Failed to add some tracks:', err);
    } finally {
        btn.classList.remove('disabled');
        btn.innerHTML = originalContent; // Restore icon and text
    }
}

async function playAll() {
    const tracks = currentBrowserItems.filter(item => item.type === 'item');
    if (tracks.length === 0) return;

    // Sort by disc then track
    tracks.sort((a, b) => {
        if (a.discNumber !== b.discNumber) return (a.discNumber || 1) - (b.discNumber || 1);
        return (a.trackNumber || 0) - (b.trackNumber || 0);
    });

    if (!selectedRendererUdn) {
        alert('Please select a Renderer on the left first!');
        return;
    }

    const btn = document.getElementById('btn-play-all');
    btn.classList.add('disabled');
    btn.textContent = 'Preparing...';

    try {
        await clearPlaylist();

        let firstTrackId = null;
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/insert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    uri: track.uri,
                    title: track.title,
                    artist: track.artist,
                    album: track.album,
                    duration: track.duration,
                    protocolInfo: track.protocolInfo
                })
            });

            if (response.ok) {
                const data = await response.json();
                if (i === 0) firstTrackId = data.newId;
            }
        }

        await fetchPlaylist(selectedRendererUdn);

        if (firstTrackId) {
            await playPlaylistItem(firstTrackId);
        }

        // On mobile, switch to playlist view
        if (window.innerWidth <= 800) {
            switchView('playlist');
        }
    } catch (err) {
        console.error('Play All error:', err);
    } finally {
        btn.classList.remove('disabled');
        btn.textContent = 'Play All';
    }
}

async function transportAction(action) {
    if (!selectedRendererUdn) return;

    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/${action}`, {
            method: 'POST'
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || `Failed to ${action}`);
        }

        // Instant update of status and playlist to reflect the new state
        await fetchPlaylist(selectedRendererUdn);
    } catch (err) {
        console.error(`${action} error:`, err);
        showToast(`Playback Error: ${err.message}`);
    }
}

async function playPlaylistItem(id) {
    if (!selectedRendererUdn) return;

    try {
        // If clicking the current track and it's paused, just resume
        if (currentTrackId != null && id != null && currentTrackId == id && currentTransportState === 'Paused') {
            await transportAction('play'); // transportAction now triggers a refresh
            return;
        }

        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/seek/${id}`, {
            method: 'POST'
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to play track');
        }

        // Force a full playlist and status refresh to show playing icon immediately
        await fetchPlaylist(selectedRendererUdn);
    } catch (err) {
        console.error('Play track error:', err);
        showToast(`Failed to play track: ${err.message}`);
    }
}

async function clearPlaylist() {
    if (!selectedRendererUdn) return;

    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/clear`, {
            method: 'POST'
        });

        if (!response.ok) throw new Error('Failed to clear playlist');

        await fetchPlaylist(selectedRendererUdn);
    } catch (err) {
        console.error('Clear error:', err);
        showToast(`Failed to clear playlist: ${err.message}`);
    }
}

function selectPlaylistItem(id) {
    playPlaylistItem(id);
}


function scrollToLetter(letter) {
    const el = document.getElementById(`letter-${letter}`);
    if (el) {
        // Find the scrollable container
        const container = document.getElementById('browser-items');
        if (container) {
            const topPos = el.offsetTop - container.offsetTop;
            container.scrollTo({
                top: topPos,
                behavior: 'auto'
            });
        }
    }
}

function renderBrowser(items) {
    currentBrowserItems = items;

    // Restore scroll position
    const currentId = browsePath.length > 0 ? browsePath[browsePath.length - 1].id : '0';
    const savedScrollTop = browseScrollPositions[currentId] || 0;

    //    console.log(`[DEBUG] Rendering browser, restoring scroll ${savedScrollTop} for ${currentId}`);
    const tracks = items.filter(item => item.type === 'item');
    const addAllBtn = document.getElementById('btn-add-all');
    const playAllBtn = document.getElementById('btn-play-all');

    if (addAllBtn) {
        if (tracks.length > 0) {
            addAllBtn.classList.remove('disabled');
        } else {
            addAllBtn.classList.add('disabled');
        }
    }

    if (playAllBtn) {
        if (tracks.length > 0) {
            playAllBtn.classList.remove('disabled');
        } else {
            playAllBtn.classList.add('disabled');
        }
    }

    updateHomeButtons();

    // Alphabet logic
    const alphabetScroll = document.getElementById('alphabet-scroll');
    if (alphabetScroll) {
        // Only consider items that start with a letter
        currentExistingLetters = [...new Set(items
            .filter(i => i.title && /^[a-zA-Z]/.test(i.title))
            .map(i => i.title[0].toUpperCase())
        )];

        alphabetScroll.classList.add('visible');
        renderAlphabet();
    }

    if (items.length === 0) {
        browserItems.innerHTML = '<div class="empty-state">Folder is empty</div>';
        return;
    }

    let lastLetter = null;
    browserItems.innerHTML = items.map((item, index) => {
        const isContainer = item.type === 'container';
        const firstLetter = (item.title || '')[0].toUpperCase();
        let letterIdAttr = '';

        if (/^[A-Z]$/.test(firstLetter) && firstLetter !== lastLetter) {
            letterIdAttr = `id="letter-${firstLetter}"`;
            lastLetter = firstLetter;
        }

        // Check if this is an image item (by class or MIME type)
        const isImage = (item.class && item.class.includes('imageItem')) ||
            (item.protocolInfo && item.protocolInfo.includes('image/'));

        const icon = isContainer ? `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
        ` : isImage ? `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <path d="M21 15l-5-5L5 21"></path>
            </svg>
        ` : `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M10 8l6 4-6 4V8z"></path>
            </svg>
        `;

        const esc = (s) => (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');

        const isLocalServer = selectedServerUdn === LOCAL_SERVER_UDN;
        return `
            <div ${letterIdAttr} class="playlist-item browser-item ${isContainer ? 'folder' : 'file'}" 
                 onclick="${isContainer ?
                `enterFolder('${item.id}', '${esc(item.title)}')` :
                isImage ?
                    `openArtModal('${esc(item.uri)}', '${esc(item.title)}')` :
                    `playTrack('${esc(item.uri)}', '${esc(item.title)}', '${esc(item.artist)}', '${esc(item.album)}', '${esc(item.duration)}', '${esc(item.protocolInfo)}')`}">
                <div class="item-icon">${icon}</div>
                <div class="item-info">
                    <div class="item-title">${item.title}</div>
                </div>
                ${!isLocalServer || isLocalServer || !isContainer ? `
                    <div class="item-actions">
                        ${!isContainer ? `
                        <button class="btn-control ghost info-btn" onclick="event.stopPropagation(); showTrackInfoFromBrowser(${index})" title="View track metadata">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <path d="M12 16v-4"></path>
                                <path d="M12 8h.01"></path>
                            </svg>
                        </button>
                        <button class="btn-control queue-btn" onclick="event.stopPropagation(); addToPlaylist('${esc(item.uri)}', '${esc(item.title)}', '${esc(item.artist)}', '${esc(item.album)}', '${esc(item.duration)}', '${esc(item.protocolInfo)}', false)" title="Add to queue">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 5v14M5 12h14"></path>
                            </svg>
                            Queue
                        </button>
                        ` : `
                        <button class="btn-control play-btn" onclick="event.stopPropagation(); playFolder('${esc(item.id)}', '${esc(item.title)}')" title="Play Whole Folder Recursively">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z"></path>
                            </svg>
                            Play
                        </button>
                        <button class="btn-control queue-btn" onclick="event.stopPropagation(); queueFolder('${esc(item.id)}', '${esc(item.title)}')" title="Queue Whole Folder Recursively">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 5v14M5 12h14"></path>
                            </svg>
                            Queue
                        </button>
                        `}
                        
                        ${isLocalServer ? `
                        <button class="btn-control delete-btn" onclick="event.stopPropagation(); deleteTrack('${esc(item.id)}', '${esc(item.title)}')" title="Delete from local folder">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"></path>
                            </svg>
                            Delete
                        </button>
                        ` : `
                        <button class="btn-control download-btn" onclick="event.stopPropagation(); ${isContainer ? `downloadFolder('${selectedServerUdn}', '${esc(item.id)}', '${esc(item.title)}', '${esc(item.artist)}', '${esc(item.album)}')` : `downloadTrack('${esc(item.uri)}', '${esc(item.title)}', '${esc(item.artist)}', '${esc(item.album)}')`}" title="Download to local media library">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                <polyline points="7 10 12 15 17 10"></polyline>
                                <line x1="12" y1="15" x2="12" y2="3"></line>
                            </svg>
                        </button>
                        `}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');

    // Restore scroll position after DOM update
    if (savedScrollTop > 0) {
        setTimeout(() => {
            browserItems.scrollTop = savedScrollTop;
        }, 10);
    } else {
        browserItems.scrollTop = 0;
    }
}

async function fetchPlaylist(udn) {
    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(udn)}`);
        if (!response.ok) throw new Error('Failed to fetch playlist');
        const playlist = await response.json();

        // Update the global state immediately before status is updated
        // so that metadata lookups in updateStatus use the fresh playlist.
        currentPlaylistItems = playlist;

        // Update status and track info before rendering
        const statusRes = await fetch(`/api/playlist/${encodeURIComponent(udn)}/status`);
        if (statusRes.ok) {
            const status = await statusRes.json();
            updateStatus(status);
        }

        renderPlaylist(playlist);
    } catch (err) {
        console.error('Playlist fetch error:', err);
        playlistItems.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    }
}

async function fetchStatus() {
    if (!selectedRendererUdn) return;
    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/status`);
        if (!response.ok) throw new Error('Failed to fetch status');
        const status = await response.json();
        updateStatus(status);
    } catch (err) {
        console.error('Status fetch error:', err);
    }
}

function updateStatus(status) {
    const trackChanged = status.trackId !== currentTrackId;
    const transportChanged = status.transportState !== currentTransportState;

    if (trackChanged || transportChanged) {
        currentTrackId = status.trackId;
        currentTransportState = status.transportState;
        renderPlaylist(currentPlaylistItems);

        // Update modal track info if modal is open
        updateModalTrackInfo();
    }

    // Handle Transport Status (Errors)
    if (status.transportStatus && status.transportStatus !== 'OK' && status.transportStatus !== 'ERROR_OCCURRED') {
        const s = status.transportStatus;
        // Known Sonos non-OK statuses that represent failures
        const errorConditions = [
            'ERROR', 'FAILED', 'NOT_FOUND', 'UNSUPPORTED', 'INVALID',
            'DENIED', 'FORBIDDEN', 'ILLEGAL', 'EXPIRED'
        ];

        if (errorConditions.some(cond => s.includes(cond))) {
            console.warn(`[DEBUG] Transport Error Status: ${s}`);
            showToast(`Device Status: ${s.replace(/_/g, ' ')}`);
        }
    }

    // If status itself has an error message
    if (status.error) {
        showToast(`Renderer Error: ${status.error}`);
    }

    // Update position only if it differs by more than 2 second, or track/transport changed
    if (status.relTime !== undefined) {
        const diff = Math.abs(status.relTime - currentPositionSeconds);
        if (diff > 2 || trackChanged || transportChanged) {
            lastStatusPositionSeconds = status.relTime;
            lastStatusFetchTime = Date.now();
            currentPositionSeconds = status.relTime;
        }
    }

    // Duration handling: use status duration if valid, otherwise fallback to playlist metadata
    let newDuration = status.duration || 0;

    if (newDuration <= 0 && currentTrackId != null) {
        // Fallback: Try to find duration in the already loaded playlist items
        const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);
        if (currentTrack && currentTrack.duration) {
            newDuration = formatToSeconds(currentTrack.duration);
            console.log(`[DEBUG] Found fallback duration: ${newDuration}s for track ${currentTrackId}`);
        }
    } else if (newDuration > 0) {
        //        console.log(`[DEBUG] Device reported duration: ${newDuration}s`);
    }

    durationSeconds = newDuration;
    //    lastStatusFetchTime = Date.now();

    // Update Now Playing label and fetch artwork
    const nowPlayingLabel = document.getElementById('now-playing-label');
    if (currentTrackId != null) {
        const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);
        if (currentTrack) {
            if (nowPlayingLabel) {
                nowPlayingLabel.textContent = `${currentTrack.title} - ${currentTrack.artist || 'Unknown Artist'}`;
                nowPlayingLabel.title = nowPlayingLabel.textContent;
            }
            // Fetch artwork if track changed or query differs
            const query = `${currentTrack.artist || ''} ${currentTrack.album || ''}`.trim();
            const safeUdn = selectedRendererUdn ? selectedRendererUdn.replace(/:/g, '-') : '';
            const artContainer = safeUdn ? document.getElementById(`player-art-container-${safeUdn}`) : null;
            const isArtVisible = artContainer && artContainer.classList.contains('visible');

            // Only fetch if query changed and hasn't failed before
            if (query && query !== currentArtworkQuery && !failedArtworkQueries.has(query)) {
                updatePlayerArtwork(currentTrack.artist, currentTrack.album);
            }
        } else if (nowPlayingLabel) {
            nowPlayingLabel.textContent = `Track ${currentTrackId}`;
        }
    } else if (nowPlayingLabel) {
        nowPlayingLabel.textContent = 'Not Playing';
        currentArtworkQuery = '';
        currentArtworkUrl = '';
        hideAllPlayerArt();
    }

    updatePositionUI();
}

async function updatePlayerArtwork(artist, album) {
    if (!artist && !album) return;
    const query = `${artist || ''} ${album || ''}`.trim();
    currentArtworkQuery = query;

    try {
        const res = await fetch(`/api/art/search?artist=${encodeURIComponent(artist || '')}&album=${encodeURIComponent(album || '')}`);
        if (res.ok) {
            const data = await res.json();
            currentArtworkUrl = data.url;
            showPlayerArt(data.url);
        } else {
            console.warn('[ART] No artwork found, will not retry this query');
            failedArtworkQueries.add(query);
            currentArtworkUrl = '';
            hideAllPlayerArt();
        }
    } catch (e) {
        console.warn('[ART] Failed to fetch player artwork:', e);
        failedArtworkQueries.add(query);
        currentArtworkUrl = '';
        hideAllPlayerArt();
    }
}

async function saveDiscogsToken() {
    const tokenInput = document.getElementById('discogs-token-input');
    if (tokenInput) {
        const token = tokenInput.value.trim();
        // If it's the masked token, don't re-save it
        if (token.includes('****')) return;

        try {
            const response = await fetch('/api/settings/discogs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            });

            if (response.ok) {
                if (token) {
                    showToast('Discogs token saved to server', 'success', 2000);
                } else {
                    showToast('Discogs token removed from server', 'success', 2000);
                }
            } else {
                throw new Error('Failed to save token');
            }
        } catch (err) {
            console.error('Save settings error:', err);
            showToast('Failed to save settings to server');
        }
    }
}

function showPlayerArt(url) {
    if (!selectedRendererUdn) return;
    const safeUdn = selectedRendererUdn.replace(/:/g, '-');
    const container = document.getElementById(`player-art-container-${safeUdn}`);
    const img = document.getElementById(`player-art-${safeUdn}`);

    if (container && img) {
        console.log(`[ART] Loading artwork: ${url}`);
        // Set onload before src to avoid missing cached loads
        img.onload = () => {
            console.log(`[ART] Loaded successfully: ${url}`);
            container.classList.add('visible');
        };
        img.onerror = (err) => {
            console.error(`[ART] Failed to load image: ${url}`, err);
            // Mark this query as failed so we don't retry
            if (currentArtworkQuery) {
                failedArtworkQueries.add(currentArtworkQuery);
            }
            container.classList.remove('visible');
        };
        img.src = url;
    }
}

function hideAllPlayerArt() {
    document.querySelectorAll('.player-artwork-container').forEach(el => {
        el.classList.remove('visible');
        const img = el.querySelector('img');
        if (img) img.src = ''; // Clear src to avoid stale art in modal
    });
}

function openArtModal(url, title = '', artist = '', album = '') {
    if (!url) return;
    const modal = document.getElementById('album-art-modal');
    const img = document.getElementById('modal-art-img');
    const titleEl = document.getElementById('modal-track-title');
    const artistEl = document.getElementById('modal-track-artist');
    const albumEl = document.getElementById('modal-track-album');

    if (modal && img) {
        console.log(`[ART] Opening modal for: ${url}`);

        // Use proxy for remote images to avoid CORS issues
        const finalUrl = (url.startsWith('http') && !url.includes(window.location.host))
            ? `/api/proxy-image?url=${encodeURIComponent(url)}`
            : url;

        img.src = ''; // Clear previous
        img.src = finalUrl;

        // If specific metadata is passed (e.g. clicking an image in the browser)
        if (title) {
            if (titleEl) titleEl.textContent = title;
            if (artistEl) artistEl.textContent = artist || '';
            if (albumEl) albumEl.textContent = album || '';
        } else if (currentTrackId != null) {
            // Fallback to current track info if no metadata passed
            const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);
            if (currentTrack) {
                if (titleEl) titleEl.textContent = currentTrack.title || 'Unknown Title';
                if (artistEl) artistEl.textContent = currentTrack.artist || 'Unknown Artist';
                if (albumEl) albumEl.textContent = currentTrack.album || '';
            } else {
                if (titleEl) titleEl.textContent = '';
                if (artistEl) artistEl.textContent = '';
                if (albumEl) albumEl.textContent = '';
            }
        } else {
            if (titleEl) titleEl.textContent = '';
            if (artistEl) artistEl.textContent = '';
            if (albumEl) albumEl.textContent = '';
        }

        modal.style.display = 'flex';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
    }
}

function closeArtModal() {
    const modal = document.getElementById('album-art-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function updateModalTrackInfo() {
    const modal = document.getElementById('album-art-modal');
    // Only update if modal is currently visible
    if (!modal || modal.style.display !== 'flex') return;

    const titleEl = document.getElementById('modal-track-title');
    const artistEl = document.getElementById('modal-track-artist');
    const albumEl = document.getElementById('modal-track-album');

    // Get current track info
    if (currentTrackId != null) {
        const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);
        if (currentTrack) {
            if (titleEl) titleEl.textContent = currentTrack.title || 'Unknown Title';
            if (artistEl) artistEl.textContent = currentTrack.artist || 'Unknown Artist';
            if (albumEl) albumEl.textContent = currentTrack.album || '';
        } else {
            // Clear track info if no track found
            if (titleEl) titleEl.textContent = '';
            if (artistEl) artistEl.textContent = '';
            if (albumEl) albumEl.textContent = '';
        }
    } else {
        // Clear track info if nothing is playing
        if (titleEl) titleEl.textContent = '';
        if (artistEl) artistEl.textContent = '';
        if (albumEl) albumEl.textContent = '';
    }
}


// Helper to convert HH:MM:SS to seconds on the client side
function formatToSeconds(time) {
    if (!time) return 0;
    if (typeof time === 'number') return Math.floor(time);
    const parts = time.split(':');
    if (parts.length === 3) {
        return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
    } else if (parts.length === 2) {
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }
    return parseInt(time, 10) || 0;
}

function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function updatePositionUI() {
    const posCurrent = document.getElementById('pos-current');
    const posDuration = document.getElementById('pos-duration');
    const posSlider = document.getElementById('position-slider');

    if (posCurrent) posCurrent.textContent = formatTime(currentPositionSeconds);
    if (posDuration) posDuration.textContent = formatTime(durationSeconds);

    if (posSlider && !isUserDraggingSlider) {
        if (durationSeconds > 0) {
            posSlider.max = durationSeconds;
            posSlider.value = currentPositionSeconds;
            posSlider.disabled = false;
        } else {
            posSlider.max = 100;
            posSlider.value = 0;
            posSlider.disabled = true;
        }
    }
}

async function seekTo(seconds) {
    if (!selectedRendererUdn || durationSeconds <= 0) return;

    isUserDraggingSlider = false; // Release lock
    const targetSeconds = parseFloat(seconds);

    // Optimistically update local state
    currentPositionSeconds = targetSeconds;
    lastStatusPositionSeconds = targetSeconds;
    lastStatusFetchTime = Date.now();
    updatePositionUI();

    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/seek-time/${Math.floor(targetSeconds)}`, {
            method: 'POST'
        });
        if (!response.ok) throw new Error('Seek failed');

        // After seek, force a status refresh after a short delay
        setTimeout(fetchStatus, 1000);
    } catch (err) {
        console.error('Seek error:', err);
        showToast(`Seek Error: ${err.message}`);
    }
}

function updatePositionDisplay(seconds) {
    isUserDraggingSlider = true;
    const posCurrent = document.getElementById('pos-current');
    if (posCurrent) {
        posCurrent.textContent = formatTime(parseFloat(seconds));
    }
}

setInterval(() => {
    if (isPageVisible && !isUserDraggingSlider && lastStatusFetchTime > 0) {
        if (currentTransportState === 'Playing') {
            const now = Date.now();
            const elapsed = (now - lastStatusFetchTime) / 1000;
            let currentPos = lastStatusPositionSeconds + elapsed;

            if (durationSeconds > 0 && currentPos > durationSeconds) {
                currentPos = durationSeconds;
            }

            currentPositionSeconds = currentPos;
        } else {
            currentPositionSeconds = lastStatusPositionSeconds;
        }
        updatePositionUI();
    }
}, 1000);

function renderPlaylist(items) {
    currentPlaylistItems = items;
    playlistCount.textContent = items.length;

    if (items.length === 0) {
        playlistItems.innerHTML = '<div class="empty-state">Playlist is empty</div>';
        updateTransportControls();
        return;
    }

    const esc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    playlistItems.innerHTML = items.map((item, index) => {
        // Track is highlighted if it's the current track AND the transport is moving (or paused)
        const isCurrent = currentTrackId != null && item.id != null && currentTrackId == item.id;
        const isHighlightActive = isCurrent && currentTransportState !== 'Stopped';

        let icon = '';
        if (isCurrent) {
            if (currentTransportState === 'Playing') {
                icon = `
                    <div class="playing-icon">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z"></path>
                        </svg>
                    </div>`;
            } else if (currentTransportState === 'Paused') {
                icon = `
                    <div class="playing-icon" style="animation: none; opacity: 0.7;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path>
                        </svg>
                    </div>`;
            }
        }

        return `
            <div class="playlist-item ${isHighlightActive ? 'playing' : ''}" onclick="playPlaylistItem('${esc(item.id)}')">
                <div class="item-index">${index + 1}</div>
                <div class="item-status">${icon}</div>
                <div class="item-info">
                    <div class="item-title">${esc(item.title) || 'Unknown Title'}</div>
                    <div class="item-artist">${esc(item.artist) || ''}</div>
                </div>
                <div class="item-actions">
                    <button class="btn-control ghost info-btn" onclick="event.stopPropagation(); showTrackInfoFromPlaylist('${esc(item.id)}')" title="View track metadata">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"></circle>
                            <path d="M12 16v-4"></path>
                            <path d="M12 8h.01"></path>
                        </svg>
                    </button>
                    <button class="btn-control delete-btn" onclick="event.stopPropagation(); deleteTrackFromPlaylist('${esc(item.id)}')" title="Remove from playlist">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M18 6L6 18M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    updateTransportControls();
    updateDocumentTitle();

    // Scroll currently playing track into view
    scrollToCurrentTrack();
}

function scrollToCurrentTrack() {
    // Find the currently playing item
    const playingItem = playlistItems.querySelector('.playlist-item.playing');
    if (playingItem) {
        // Use setTimeout to ensure DOM is fully rendered
        setTimeout(() => {
            playingItem.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
                inline: 'nearest'
            });
        }, 100);
    }
}

async function deleteTrackFromPlaylist(id) {
    if (!selectedRendererUdn) return;

    // Visual feedback (optional, but good for UX)
    console.log('Attempting to delete track:', id);

    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/delete/${encodeURIComponent(id)}`, {
            method: 'POST'
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || 'Failed to delete track');
        }

        await fetchPlaylist(selectedRendererUdn);
    } catch (err) {
        console.error('Delete track error:', err);
        showToast(`Failed to delete track: ${err.message}`);
    }
}

function updateDocumentTitle() {
    const defaultTitle = 'AMMUI | OpenHome Explorer';

    if (!currentPlaylistItems || currentPlaylistItems.length === 0) {
        document.title = defaultTitle;
        return;
    }

    const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);

    // Only show track info if something is playing or paused (and we have a valid track)
    if (currentTrack && (currentTransportState === 'Playing' || currentTransportState === 'Paused')) {
        let titleText = currentTrack.title || 'Unknown Title';
        if (currentTrack.artist) {
            titleText += ` - ${currentTrack.artist}`;
        }

        // Add a play/pause indicator
        const stateIcon = currentTransportState === 'Playing' ? '▶' : '❘❘';
        document.title = `${stateIcon} ${titleText}`;
    } else {
        document.title = defaultTitle;
    }
}

function updateTransportControls() {
    const btnPlay = document.getElementById('btn-play');
    const btnPause = document.getElementById('btn-pause');
    const btnStop = document.getElementById('btn-stop');
    const btnClear = document.getElementById('btn-clear');

    if (!btnPlay) return;

    const isPlaylistEmpty = currentPlaylistItems.length === 0;
    const isPlaying = currentTransportState === 'Playing';
    const isPaused = currentTransportState === 'Paused';

    // Play: enabled if not empty and not already playing
    if (isPlaylistEmpty || isPlaying) {
        btnPlay.classList.add('disabled');
    } else {
        btnPlay.classList.remove('disabled');
    }

    // Pause: enabled only if playing
    if (isPlaying) {
        btnPause.classList.remove('disabled');
    } else {
        btnPause.classList.add('disabled');
    }

    // Stop: enabled if playing or paused
    if (isPlaying || isPaused) {
        btnStop.classList.remove('disabled');
    } else {
        btnStop.classList.add('disabled');
    }

    // Clear: enabled if playlist not empty
    if (isPlaylistEmpty) {
        btnClear.classList.add('disabled');
    } else {
        btnClear.classList.remove('disabled');
    }
}

async function triggerDiscovery(btn) {
    const originalContent = btn ? btn.innerHTML : null;
    if (btn) {
        btn.classList.add('scanning');
        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            Seeking...
        `;
    }

    try {
        console.log('Triggering manual SSDP discovery...');
        await fetch('/api/discover', { method: 'POST' });

        // Initial fetch to show immediate results
        await fetchDevices();

        // Sequence of fetches to catch SSDP responses as they come in
        let count = 0;
        const interval = setInterval(async () => {
            count++;
            await fetchDevices();
            if (count >= 5) clearInterval(interval);
        }, 1000);

        if (btn) {
            setTimeout(() => {
                console.log('Manual discovery period ended.');
                btn.classList.remove('scanning');
                btn.innerHTML = originalContent;
            }, 6000);
        }
    } catch (err) {
        console.error('Failed to trigger discovery:', err);
        if (btn) {
            btn.classList.remove('scanning');
            btn.innerHTML = originalContent;
        }
    }
}

function openServerModal() {
    serverModal.style.display = 'flex';
}

function closeServerModal() {
    serverModal.style.display = 'none';
}

function openRendererModal() {
    rendererModal.style.display = 'flex';
}

function closeRendererModal() {
    rendererModal.style.display = 'none';
}

function openManageModal() {
    manageModal.style.display = 'flex';
    renderManageDevices();

    // Load saved Discogs token status from server
    const tokenInput = document.getElementById('discogs-token-input');
    if (tokenInput) {
        fetch('/api/settings/discogs')
            .then(res => res.json())
            .then(data => {
                if (data.hasToken) {
                    tokenInput.value = data.maskedToken;
                } else {
                    tokenInput.value = '';
                }
            })
            .catch(err => console.error('Failed to fetch settings:', err));
    }
}

function closeManageModal() {
    manageModal.style.display = 'none';
}

function renderManageDevices() {
    const renderers = currentDevices.filter(d => d.isRenderer);
    const servers = currentDevices.filter(d => d.isServer);

    const renderItem = (device, role) => {
        let host = 'unknown';
        try { host = new URL(device.location).hostname; } catch (e) { host = device.location; }
        const isDisabled = role === 'server' ? !!device.disabledServer : !!device.disabledPlayer;
        const isActive = role === 'server' ? selectedServerUdn === device.udn : selectedRendererUdn === device.udn;

        const displayName = device.customName || device.friendlyName;
        const iconHtml = device.iconUrl
            ? `<img src="${device.iconUrl}" class="manage-item-icon" alt="">`
            : `<div class="manage-item-icon-placeholder">${displayName.charAt(0)}</div>`;

        return `
            <div class="manage-item ${isDisabled ? 'item-disabled' : ''} ${isActive ? 'item-active' : ''}">
                ${iconHtml}
                <div class="manage-item-info">
                    <div class="manage-item-name-row" id="name-row-${device.udn?.replace(/:/g, '-')}">
                        <span class="manage-item-name">${displayName}</span>
                        <button class="btn-rename" onclick="startRename('${device.udn}')" title="Rename device">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                            </svg>
                        </button>
                    </div>
                    <span class="manage-item-host">${host} ${isDisabled ? '<span class="disabled-tag">(Disabled as ' + role + ')</span>' : ''}</span>
                </div>
                <div class="manage-item-actions">
                    ${!isDisabled ? (isActive ? `
                        <span class="active-badge">Active</span>
                    ` : '') : ''}
                    <button class="btn-toggle ${isDisabled ? 'btn-enable' : 'btn-disable'}" onclick="toggleDeviceDisabled('${device.udn}', '${role}')">
                        ${isDisabled ? 'Enable' : 'Disable'}
                    </button>
                    <button class="btn-delete" onclick="deleteDevice('${device.udn}')">Forget</button>
                </div>
            </div>
        `;
    };

    if (manageRendererList) {
        manageRendererList.innerHTML = renderers.length ? renderers.map(d => renderItem(d, 'player')).join('') : '<div class="empty-state-mini">No players saved</div>';
    }
    if (manageServerList) {
        manageServerList.innerHTML = servers.length ? servers.map(d => renderItem(d, 'server')).join('') : '<div class="empty-state-mini">No servers saved</div>';
    }
}

async function toggleDeviceDisabled(udn, role) {
    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udn)}/toggle-disabled/${role}`, {
            method: 'POST'
        });
        if (!response.ok) throw new Error('Failed to toggle device state');

        await fetchDevices();
        renderManageDevices();
        renderDevices();
    } catch (err) {
        console.error('Toggle error:', err);
    }
}

async function deleteDevice(udn) {
    if (!confirm('Are you sure you want to forget this device? It will be removed from the saved database.')) {
        return;
    }

    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udn)}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to forget device');

        // Fetch fresh list and update UI
        await fetchDevices();
        renderManageDevices();
        renderDevices(); // Update the main dashboard cards too
    } catch (err) {
        console.error('Forget error:', err);
        alert('Failed to forget device');
    }
}


function startRename(udn) {
    const nameRow = document.getElementById(`name-row-${udn.replace(/:/g, '-')}`);
    if (!nameRow) return;

    const device = currentDevices.find(d => d.udn === udn);
    if (!device) return;

    const currentName = device.customName || device.friendlyName;

    nameRow.innerHTML = `
        <input type="text" class="manage-name-input" id="input-${udn.replace(/:/g, '-')}" value="${currentName.replace(/"/g, '&quot;')}" onkeydown="handleRenameKey(event, '${udn}')">
        <button class="btn-toggle btn-enable" onclick="saveRename('${udn}')" style="padding: 0.2rem 0.5rem">Save</button>
        <button class="btn-toggle btn-disable" onclick="cancelRename('${udn}')" style="padding: 0.2rem 0.5rem">Cancel</button>
    `;

    const input = document.getElementById(`input-${udn.replace(/:/g, '-')}`);
    input.focus();
    input.select();
}

function handleRenameKey(event, udn) {
    if (event.key === 'Enter') {
        saveRename(udn);
    } else if (event.key === 'Escape') {
        cancelRename(udn);
    }
}

function cancelRename(udn) {
    renderManageDevices();
}

async function saveRename(udn) {
    const input = document.getElementById(`input-${udn.replace(/:/g, '-')}`);
    if (!input) return;

    const newName = input.value.trim();
    if (!newName) {
        alert('Name cannot be empty');
        return;
    }

    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udn)}/name`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
        });

        if (!response.ok) throw new Error('Failed to rename device');

        await fetchDevices();
        renderManageDevices();
        renderDevices();
    } catch (err) {
        console.error('Rename error:', err);
        alert('Failed to rename device');
    }
}

function renderDevices() {
    // Filter out disabled devices for the main dashboard and modals
    const renderers = currentDevices.filter(d => d.isRenderer && !d.disabledPlayer);
    const servers = currentDevices.filter(d => d.isServer && !d.disabledServer);

    if (rendererCount) rendererCount.textContent = `${renderers.length} active`;
    if (serverCount) serverCount.textContent = `${servers.length} active`;
    if (tabRendererCount) tabRendererCount.textContent = renderers.length;
    if (tabServerCount) tabServerCount.textContent = servers.length;

    // Renderers (Single Primary Card)
    if (deviceListElement) {
        if (renderers.length === 0) {
            deviceListElement.innerHTML = `<div class="empty-state">No renderers found...</div>`;
        } else {
            // Ensure we have a valid selection if devices are available
            const activeRenderer = renderers.find(r => r.udn === selectedRendererUdn) || renderers[0];

            // If the active renderer changed or if we haven't loaded its playlist yet
            if (activeRenderer.udn !== selectedRendererUdn || (currentPlaylistItems.length === 0 && !activeRenderer.loading)) {
                const oldUdn = selectedRendererUdn;
                selectedRendererUdn = activeRenderer.udn;
                localStorage.setItem('selectedRendererUdn', selectedRendererUdn);

                // Only fetch if UDN changed OR if we are literally at the empty state
                if (oldUdn !== activeRenderer.udn || playlistItems.querySelector('.empty-state')) {
                    fetchPlaylist(selectedRendererUdn);
                }
            }

            deviceListElement.innerHTML = renderDeviceCard(activeRenderer, true, false, true);

            // Show/hide and enable/disable Sonos EQ button
            const eqBtn = document.getElementById('id-sonos-eq');
            if (eqBtn) {
                const canDoEq = activeRenderer.isSonos;
                eqBtn.style.display = canDoEq ? 'flex' : 'none';
                eqBtn.disabled = !canDoEq;
                eqBtn.classList.toggle('disabled', !canDoEq);
            }
        }
    }

    // Media Server (Single Primary Card)
    if (serverListElement) {
        if (servers.length === 0) {
            serverListElement.innerHTML = `<div class="empty-state">No media servers found...</div>`;
        } else {
            // Ensure we have a valid selection if servers are available
            const serverExists = servers.some(s => s.udn === selectedServerUdn);
            if (!selectedServerUdn || !serverExists) {
                selectedServerUdn = servers[0].udn;
                browse(selectedServerUdn, '0');
            }

            const activeServer = servers.find(s => s.udn === selectedServerUdn) || servers[0];

            serverListElement.innerHTML = renderDeviceCard(activeServer, true, true, true);
        }
    }

    // Populate Modal Lists
    updateModalDeviceLists();
}

function updateModalDeviceLists() {
    const modalServerList = document.getElementById('modal-server-list');
    const modalRendererList = document.getElementById('modal-renderer-list');

    const renderers = currentDevices.filter(d => d.isRenderer && !d.disabledPlayer);
    const servers = currentDevices.filter(d => d.isServer && !d.disabledServer);

    if (modalServerList) {
        modalServerList.innerHTML = servers.map(device => renderModalDeviceItem(device, true)).join('');
    }
    if (modalRendererList) {
        modalRendererList.innerHTML = renderers.map(device => renderModalDeviceItem(device, false)).join('');
    }
}

function renderModalDeviceItem(device, asServer) {
    const isSelected = asServer ? (device.udn === selectedServerUdn) : (device.udn === selectedRendererUdn);
    const clickAction = asServer ? `selectServer('${device.udn}')` : `selectDevice('${device.udn}')`;

    const displayName = device.customName || device.friendlyName;
    const iconHtml = device.iconUrl
        ? `<img src="${device.iconUrl}" class="modal-device-icon" alt="">`
        : `<div class="modal-device-icon-placeholder">${displayName.charAt(0)}</div>`;

    return `
        <div class="modal-device-item ${isSelected ? 'selected' : ''}" 
             onclick="${clickAction}"
             id="modal-device-${asServer ? 'srv-' : 'ren-'}${device.udn?.replace(/:/g, '-') || Math.random()}">
            <div class="modal-device-item-left">
                ${iconHtml}
                <div class="modal-device-name">${displayName}</div>
            </div>
            ${isSelected ? '<div class="selected-indicator">✓</div>' : ''}
        </div>
    `;
}

function renderDeviceCard(device, forceHighlight = false, asServer = false, isStatic = false) {
    const isSelected = forceHighlight || (asServer ? (device.udn === selectedServerUdn) : (device.udn === selectedRendererUdn));

    // Different icon for servers
    const isSonos = device.isSonos;
    let icon = '';

    if (device.iconUrl) {
        icon = `<img src="${device.iconUrl}" class="device-card-img" alt="">`;
    } else if (asServer) {
        icon = `
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
        `;
    } else if (isSonos) {
        icon = `
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <circle cx="12" cy="12" r="4"></circle>
                <line x1="12" y1="8" x2="12" y2="8.01"></line>
                <line x1="12" y1="16" x2="12" y2="16.01"></line>
            </svg>
        `;
    } else {
        icon = `
            <svg width="52" height="52" viewBox="0 0 24 24" fill="#4ade80">
                <path d="M6 9h5l7-7v20l-7-7H6V9z"></path>
            </svg>
        `;
    }

    const clickAction = isStatic ? (asServer ? 'handleServerClick()' : 'handleRendererClick()') : (asServer ? `selectServer('${device.udn}')` : `selectDevice('${device.udn}')`);

    const transportHtml = (!asServer && isStatic) ? `
        <div class="transport-group card-transport">
            <button id="btn-play" onclick="event.stopPropagation(); transportAction('play')"
                class="btn-control primary btn-transport-play" title="Play">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"></path>
                </svg>
            </button>
            <button id="btn-pause" onclick="event.stopPropagation(); transportAction('pause')"
                class="btn-control btn-transport-pause" title="Pause">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path>
                </svg>
            </button>
            <button id="btn-stop" onclick="event.stopPropagation(); transportAction('stop')"
                class="btn-control btn-transport-stop" title="Stop">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 6h12v12H6z"></path>
                </svg>
            </button>
        </div>
    ` : '';

    return `
        <div class="device-card ${isSelected ? 'selected' : ''} ${asServer ? 'server-card' : ''}" 
             onclick="${clickAction}"
             id="device-${asServer ? 'srv-' : 'ren-'}${device.udn?.replace(/:/g, '-') || Math.random()}">
            <div class="device-icon ${asServer ? 'server-icon' : 'player-icon'}">
                ${asServer ? `
                    <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                ` : `
                    <svg viewBox="0 0 24 24" fill="white">
                        <path d="M6 9h5l7-7v20l-7-7H6V9z"></path>
                    </svg>
                `}
            </div>
            <div class="device-info">
                <div class="device-name-container">
                    <div class="device-name">${device.customName || device.friendlyName}</div>
                    ${device.iconUrl ? `<img src="${device.iconUrl}" class="device-brand-icon" alt="">` : ''}
                </div>
                <div class="device-meta">
                    <span style="font-family: monospace; opacity: 0.7;">${(() => {
            try {
                return new URL(device.location).hostname;
            } catch (e) {
                return device.location || 'unknown';
            }
        })()}</span>
                </div>
            </div>
            ${asServer ? `<div class="media-library-label">Media Library</div>` : ''}
            ${transportHtml ? `
                <div class="card-transport-wrapper">
                    ${transportHtml}
                    <div id="player-art-container-${device.udn?.replace(/:/g, '-')}" class="player-artwork-container" 
                         onclick="event.stopPropagation(); openArtModal(document.getElementById('player-art-${device.udn?.replace(/:/g, '-')}').src)">
                        <img id="player-art-${device.udn?.replace(/:/g, '-')}" class="player-artwork" alt="">
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

function switchView(view) {
    const playerCol = document.querySelector('.player-column');
    const browserCol = document.querySelector('.browser-column');
    const tabPlaylist = document.getElementById('tab-playlist');
    const tabBrowser = document.getElementById('tab-browser');

    if (view === 'playlist') {
        playerCol.classList.add('active');
        browserCol.classList.remove('active');
        tabPlaylist ? tabPlaylist.classList.add('active') : null;
        tabBrowser ? tabBrowser.classList.remove('active') : null;
    } else {
        playerCol.classList.remove('active');
        browserCol.classList.add('active');
        tabPlaylist ? tabPlaylist.classList.remove('active') : null;
        tabBrowser ? tabBrowser.classList.add('active') : null;
    }
}

function setHome() {
    if (!selectedServerUdn) return;

    // Get existing home locations map
    let homeLocations = {};
    try {
        const stored = localStorage.getItem('serverHomeLocations');
        if (stored) {
            homeLocations = JSON.parse(stored);
        }
    } catch (e) {
        console.error('Failed to parse home locations:', e);
    }

    // Store home path for this specific server
    homeLocations[selectedServerUdn] = browsePath;
    localStorage.setItem('serverHomeLocations', JSON.stringify(homeLocations));

    // Visual feedback
    const btn = document.getElementById('btn-set-home');
    const originalContent = btn.innerHTML;
    btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Home Set!
    `;
    btn.style.color = '#4ade80';
    setTimeout(() => {
        btn.innerHTML = originalContent;
        btn.style.color = '';
    }, 2000);

    updateHomeButtons();
}

async function goHome() {
    if (!selectedServerUdn) return;
    // Don't save current scroll here because the current folder won't be a parent of Home
    // We only want to go back to Home's previously saved position if it was a parent.

    // Get home path for this specific server
    let homeLocations = {};
    try {
        const stored = localStorage.getItem('serverHomeLocations');
        if (stored) {
            homeLocations = JSON.parse(stored);
        }
    } catch (e) {
        console.error('Failed to parse home locations:', e);
    }

    const homeBrowsePath = homeLocations[selectedServerUdn];

    if (homeBrowsePath && Array.isArray(homeBrowsePath)) {
        try {
            browsePath = homeBrowsePath;
            saveLastPath();
            updateBreadcrumbs();
            const lastFolder = browsePath[browsePath.length - 1];
            await browse(selectedServerUdn, lastFolder.id);
        } catch (e) {
            console.error('Failed to go home:', e);
            browsePath = [{ id: '0', title: 'Root' }];
            saveLastPath();
            updateBreadcrumbs();
            await browse(selectedServerUdn, '0');
        }
    } else {
        browsePath = [{ id: '0', title: 'Root' }];
        saveLastPath();
        updateBreadcrumbs();
        await browse(selectedServerUdn, '0');
    }
}

function updateHomeButtons() {
    const btnSetHome = document.getElementById('btn-set-home');
    const btnGoHome = document.getElementById('btn-go-home');

    if (!selectedServerUdn) return;

    // Get home path for this specific server
    let homeLocations = {};
    try {
        const stored = localStorage.getItem('serverHomeLocations');
        if (stored) {
            homeLocations = JSON.parse(stored);
        }
    } catch (e) {
        console.error('Failed to parse home locations:', e);
    }

    const homeBrowsePath = homeLocations[selectedServerUdn];
    const isAtHome = homeBrowsePath && JSON.stringify(homeBrowsePath) === JSON.stringify(browsePath);

    if (btnSetHome) {
        if (isAtHome) {
            btnSetHome.classList.add('disabled');
            btnSetHome.title = "This folder is already your home";
        } else {
            btnSetHome.classList.remove('disabled');
            btnSetHome.title = "Set current folder as home";
        }
    }

    if (btnGoHome) {
        if (isAtHome) {
            btnGoHome.classList.add('disabled');
        } else {
            btnGoHome.classList.remove('disabled');
        }
    }
}

// Initial fetch
async function init() {
    // Migrate Discogs token to server if it exists locally
    const localToken = localStorage.getItem('discogsToken');
    if (localToken) {
        console.log('Migrating Discogs token to server...');
        try {
            await fetch('/api/settings/discogs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: localToken })
            });
            localStorage.removeItem('discogsToken');
            console.log('Discogs token migrated and removed from localStorage');
        } catch (e) {
            console.error('Migration failed:', e);
        }
    }

    await fetchDevices();

    // Auto-select and fetch playlist if a renderer was previously selected
    if (selectedRendererUdn) {
        const renderer = currentDevices.find(d => d.udn === selectedRendererUdn && d.isRenderer);
        if (renderer) {
            await fetchStatus();
            await fetchPlaylist(selectedRendererUdn);
            await fetchVolume();
        }
    }

    // Auto-browse if a server was previously selected
    if (selectedServerUdn) {
        const server = currentDevices.find(d => d.udn === selectedServerUdn && d.isServer);
        if (server) {
            // Prioritize last browsed path, then home location, then root
            let lastPaths = {};
            let homeLocations = {};
            try {
                const storedLast = localStorage.getItem('serverLastPaths');
                if (storedLast) lastPaths = JSON.parse(storedLast);

                const storedHome = localStorage.getItem('serverHomeLocations');
                if (storedHome) homeLocations = JSON.parse(storedHome);
            } catch (e) {
                console.error('Failed to parse paths:', e);
            }

            const pathToUse = lastPaths[selectedServerUdn] || homeLocations[selectedServerUdn] || [{ id: '0', title: 'Root' }];

            try {
                browsePath = pathToUse;
                updateBreadcrumbs();
                const lastFolder = browsePath[browsePath.length - 1];
                await browse(selectedServerUdn, lastFolder.id);
            } catch (e) {
                console.error('Failed to navigate to saved path:', e);
                browsePath = [{ id: '0', title: 'Root' }];
                updateBreadcrumbs();
                await browse(selectedServerUdn, '0');
            }

            // On mobile, auto-expand if browser is the active tab
            if (window.innerWidth <= 800) {
                const tabBrowser = document.getElementById('tab-browser');
                if (tabBrowser && tabBrowser.classList.contains('active')) {
                    if (browserItems && !browserItems.classList.contains('expanded')) {
                        toggleBrowser();
                    }
                }
            }
        }
    }

    // Also handle renderer auto-expansion if that tab is active
    if (window.innerWidth <= 800 && selectedRendererUdn) {
        const tabPlaylist = document.getElementById('tab-playlist');
        if (tabPlaylist && tabPlaylist.classList.contains('active')) {
            if (playlistItems && !playlistItems.classList.contains('expanded')) {
                togglePlaylist();
            }
        }
    }
}

init();

// Track page visibility to avoid polling when page is hidden
let isPageVisible = !document.hidden;

document.addEventListener('visibilitychange', () => {
    isPageVisible = !document.hidden;

    // When page becomes visible again, immediately fetch latest data
    if (isPageVisible) {
        window.scrollTo(0, 0);
        fetchDevices();
        if (selectedRendererUdn) {
            fetchStatus();
            fetchPlaylist(selectedRendererUdn);
        }
    }
});

/*
// Poll devices every 3 seconds (only when page is visible)
setInterval(() => {
    if (isPageVisible) {
        fetchDevices();
    }
}, 3000);
*/

// Volume Control Logic
let volumeDebounceTimeout = null;

async function fetchVolume() {
    if (!selectedRendererUdn) return;
    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/volume`);
        if (response.ok) {
            const data = await response.json();
            const slider = document.getElementById('volume-slider');
            const valueSpan = document.getElementById('volume-value');
            if (slider && valueSpan) {
                slider.value = data.volume;
                valueSpan.textContent = `${data.volume}%`;
            }
        }
    } catch (err) {
        console.error('Failed to fetch volume:', err);
    }
}

async function updateVolume(value) {
    const valueSpan = document.getElementById('volume-value');
    if (valueSpan) valueSpan.textContent = `${value}%`;

    // Debounce volume updates to avoid flooding the network
    if (volumeDebounceTimeout) clearTimeout(volumeDebounceTimeout);
    volumeDebounceTimeout = setTimeout(async () => {
        if (!selectedRendererUdn) return;
        try {
            await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/volume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ volume: parseInt(value, 10) })
            });
        } catch (err) {
            console.error('Failed to update volume:', err);
        }
    }, 100);
}

function adjustVolume(delta) {
    const slider = document.getElementById('volume-slider');
    if (!slider) return;
    let newValue = parseInt(slider.value, 10) + delta;
    if (newValue < 0) newValue = 0;
    if (newValue > 100) newValue = 100;
    slider.value = newValue;
    updateVolume(newValue);
}

// Poll status and volume every 5 seconds (only when page is visible)
setInterval(() => {
    if (isPageVisible && selectedRendererUdn) {
        fetchStatus();
        fetchVolume();
    }
}, 5000);

// Poll playlist every 15 seconds (less frequent)
setInterval(() => {
    if (isPageVisible && selectedRendererUdn) {
        fetchPlaylist(selectedRendererUdn);
    }
}, 15000);

function togglePlaylist() {
    const items = document.getElementById('playlist-items');
    const container = document.getElementById('playlist-container');

    if (items) {
        items.classList.toggle('expanded');
    }
    if (container) {
        container.classList.toggle('expanded');
    }
}

function toggleBrowser() {
    const items = document.getElementById('browser-items');
    const container = document.getElementById('browser-container');

    if (items) {
        items.classList.toggle('expanded');
    }
    if (container) {
        container.classList.toggle('expanded');
    }
}

function handleRendererClick() {
    if (window.innerWidth <= 800) {
        if (playlistItems && playlistItems.classList.contains('expanded')) {
            openRendererModal();
            return;
        }
        if (browserItems && browserItems.classList.contains('expanded')) toggleBrowser();
        if (playlistItems && !playlistItems.classList.contains('expanded')) togglePlaylist();
        return;
    }
    openRendererModal();
}

function handleServerClick() {
    // On desktop, always open the modal immediately
    if (window.innerWidth > 800) {
        openServerModal();
        return;
    }

    // On mobile, check expansion state
    if (browserItems && browserItems.classList.contains('expanded')) {
        openServerModal();
        return;
    }
    if (playlistItems && playlistItems.classList.contains('expanded')) togglePlaylist();
    if (browserItems && !browserItems.classList.contains('expanded')) toggleBrowser();
}

// Sonos EQ Modal logic
function openSonosEqModal() {
    if (!selectedRendererUdn) return;
    const modal = document.getElementById('sonos-eq-modal');
    if (modal) {
        modal.style.display = 'flex';
        fetchEq();
    }
}

function closeSonosEqModal() {
    const modal = document.getElementById('sonos-eq-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

async function fetchEq() {
    if (!selectedRendererUdn) return;
    try {
        console.log('[DEBUG] Fetching EQ for:', selectedRendererUdn);
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/eq`);
        if (!response.ok) throw new Error('Failed to fetch EQ');
        const eq = await response.json();
        console.log('[DEBUG] Received EQ:', eq);

        const bassSlider = document.getElementById('bass-slider');
        const bassValue = document.getElementById('bass-value');
        const trebleSlider = document.getElementById('treble-slider');
        const trebleValue = document.getElementById('treble-value');

        if (bassSlider) bassSlider.value = eq.bass;
        if (bassValue) bassValue.textContent = eq.bass;
        if (trebleSlider) trebleSlider.value = eq.treble;
        if (trebleValue) trebleValue.textContent = eq.treble;
    } catch (err) {
        console.error('EQ fetch error:', err);
    }
}

function updateEqValue(type, value) {
    const el = document.getElementById(`${type}-value`);
    if (el) el.textContent = value;
}

async function applyEq(type, value) {
    if (!selectedRendererUdn) return;
    const val = parseInt(value, 10);
    try {
        console.log(`[DEBUG] Applying EQ: ${type} = ${val}`);
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/eq`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, value: val })
        });
        if (!response.ok) throw new Error('Failed to apply EQ');

        // Short delay then refresh to confirm
        setTimeout(fetchEq, 500);
    } catch (err) {
        console.error(`Failed to set ${type}:`, err);
        showToast(`Failed to set ${type}`);
    }
}

// Upload functionality
function triggerUpload() {
    const input = document.getElementById('upload-input');
    if (input) input.click();
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const btn = document.getElementById('btn-upload');
    const originalContent = btn ? btn.innerHTML : '';

    try {
        if (btn) {
            btn.classList.add('disabled');
            btn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                </svg>
                Uploading...
            `;
        }

        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Upload failed');
        }

        const result = await response.json();
        showToast(`Successfully uploaded: ${result.title} by ${result.artist}`, 'success');

        // Refresh current folder if we are browsing local server
        if (selectedServerUdn === LOCAL_SERVER_UDN) {
            const currentFolder = browsePath[browsePath.length - 1];
            await browse(selectedServerUdn, currentFolder.id);
        }
    } catch (err) {
        console.error('Upload error:', err);
        showToast(`Upload failed: ${err.message}`);
    } finally {
        if (btn) {
            btn.classList.remove('disabled');
            btn.innerHTML = originalContent;
        }
        event.target.value = ''; // Reset input
    }
}

function updateLocalOnlyUI() {
    const isLocalServer = selectedServerUdn === LOCAL_SERVER_UDN;
    const localOnlyElements = document.querySelectorAll('.local-only');
    localOnlyElements.forEach(el => {
        if (el.tagName === 'SPAN' && el.classList.contains('divider')) {
            el.style.display = isLocalServer ? 'inline-block' : 'none';
        } else {
            el.style.display = isLocalServer ? 'flex' : 'none';
        }
    });
}

// Initial update
updateLocalOnlyUI();

function renderAlphabet() {
    const alphabetScroll = document.getElementById('alphabet-scroll');
    if (!alphabetScroll || !alphabetScroll.classList.contains('visible')) return;

    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const containerHeight = alphabetScroll.clientHeight;
    // Each letter height in CSS is 1.5rem ≈ 24px
    const letterHeight = 24;
    const maxLettersAvailable = Math.floor(containerHeight / letterHeight);

    let displayLetters = letters;

    if (maxLettersAvailable < 26 && maxLettersAvailable > 5) {
        // Calculate a subset of letters to show, spreading them equally
        displayLetters = [];
        // Always include A (0) and Z (25)
        for (let i = 0; i < maxLettersAvailable; i++) {
            const index = Math.min(25, Math.floor((i / (maxLettersAvailable - 1)) * 25));
            const letter = letters[index];
            if (!displayLetters.includes(letter)) {
                displayLetters.push(letter);
            }
        }
    } else if (maxLettersAvailable <= 5) {
        // Very tight space, just show first/middle/last or something minimal
        displayLetters = ['A', 'M', 'Z'];
    }

    alphabetScroll.innerHTML = displayLetters.map(letter => {
        const hasLetter = currentExistingLetters.includes(letter);
        return `<div class="alphabet-letter ${hasLetter ? '' : 'disabled'}" 
                     onclick="${hasLetter ? `event.stopPropagation(); scrollToLetter('${letter}')` : ''}">${letter}</div>`;
    }).join('');
}

// Setup ResizeObserver to handle vertical space changes dynamically
const alphabetObserver = new ResizeObserver(() => {
    if (document.getElementById('alphabet-scroll')?.classList.contains('visible')) {
        renderAlphabet();
    }
});

const alphabetEl = document.getElementById('alphabet-scroll');
if (alphabetEl) {
    alphabetObserver.observe(alphabetEl);
}

let consolePollInterval = null;
let lastServerLogTimestamp = null;

async function fetchServerLogs() {
    try {
        const response = await fetch('/api/logs');
        if (!response.ok) return;
        const data = await response.json();
        const logs = data.logs || [];
        const ssdp = data.ssdp || {};

        if (document.getElementById('console-modal').style.display === 'flex') {
            renderSSDPRegistry(ssdp);
        }

        const newLogs = logs.filter(log => {
            if (!lastServerLogTimestamp) return true;
            return log.timestamp > lastServerLogTimestamp;
        });

        if (newLogs.length > 0) {
            newLogs.forEach(log => {
                log.source = 'SERVER';
                window.appLogs.push(log);
                if (window.appLogs.length > 1000) window.appLogs.shift();

                if (document.getElementById('console-modal').style.display === 'flex') {
                    appendLogToUI(log);
                }
            });
            lastServerLogTimestamp = newLogs[newLogs.length - 1].timestamp;
        }
    } catch (err) {
        console.error('Failed to fetch server logs:', err);
    }
}

function getFriendlyServiceName(urn) {
    // Map common UPnP/DLNA/OpenHome service URNs to friendly names
    const serviceMap = {
        // Generic/Root
        'ssdp:all': 'All Services',
        'upnp:rootdevice': 'Root Device',

        // Media Server
        'urn:schemas-upnp-org:device:MediaServer:1': 'Media Server',
        'urn:schemas-upnp-org:device:MediaServer:2': 'Media Server v2',
        'urn:schemas-upnp-org:service:ContentDirectory:1': 'Content Directory',
        'urn:schemas-upnp-org:service:ContentDirectory:2': 'Content Directory v2',
        'urn:schemas-upnp-org:service:ContentDirectory:3': 'Content Directory v3',
        'urn:schemas-upnp-org:service:ConnectionManager:1': 'Connection Manager',
        'urn:schemas-upnp-org:service:ConnectionManager:2': 'Connection Manager v2',

        // Media Renderer
        'urn:schemas-upnp-org:device:MediaRenderer:1': 'Media Renderer',
        'urn:schemas-upnp-org:device:MediaRenderer:2': 'Media Renderer v2',
        'urn:schemas-upnp-org:service:AVTransport:1': 'AV Transport',
        'urn:schemas-upnp-org:service:AVTransport:2': 'AV Transport v2',
        'urn:schemas-upnp-org:service:RenderingControl:1': 'Rendering Control',
        'urn:schemas-upnp-org:service:RenderingControl:2': 'Rendering Control v2',

        // OpenHome
        'urn:av-openhome-org:service:Product:1': 'OpenHome Product',
        'urn:av-openhome-org:service:Product:2': 'OpenHome Product v2',
        'urn:av-openhome-org:service:Playlist:1': 'OpenHome Playlist',
        'urn:av-openhome-org:service:Radio:1': 'OpenHome Radio',
        'urn:av-openhome-org:service:Volume:1': 'OpenHome Volume',
        'urn:av-openhome-org:service:Info:1': 'OpenHome Info',
        'urn:av-openhome-org:service:Time:1': 'OpenHome Time',
        'urn:av-openhome-org:service:Sender:1': 'OpenHome Sender',
        'urn:av-openhome-org:service:Receiver:1': 'OpenHome Receiver',

        // Linn/OpenHome devices
        'urn:linn-co-uk:device:Source:1': 'Linn Source',
        'urn:linn-co-uk:device:NetReceiver:1': 'Linn Network Receiver',

        // Sonos
        'urn:schemas-upnp-org:device:ZonePlayer:1': 'Sonos Zone Player',
        'urn:schemas-sonos-com:service:Queue:1': 'Sonos Queue',
        'urn:schemas-sonos-com:service:GroupManagement:1': 'Sonos Group Management',
        'urn:schemas-sonos-com:service:AlarmClock:1': 'Sonos Alarm',
        'urn:schemas-sonos-com:service:MusicServices:1': 'Sonos Music Services',

        // Other common services
        'urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1': 'WAN Interface',
        'urn:schemas-upnp-org:service:WANIPConnection:1': 'WAN IP Connection',
        'urn:schemas-upnp-org:device:InternetGatewayDevice:1': 'Internet Gateway',
        'urn:schemas-upnp-org:device:WANDevice:1': 'WAN Device',
        'urn:schemas-upnp-org:device:WANConnectionDevice:1': 'WAN Connection Device',
    };

    // Return mapped name if found, otherwise try to extract a readable name from the URN
    if (serviceMap[urn]) {
        return serviceMap[urn];
    }

    // Try to extract meaningful parts from unknown URNs
    // e.g., "urn:schemas-upnp-org:service:SomeService:1" -> "SomeService"
    const match = urn.match(/:(service|device):([^:]+):/i);
    if (match) {
        return match[2].replace(/([A-Z])/g, ' $1').trim();
    }

    // Fallback: return the URN as-is
    return urn;
}

function renderSSDPRegistry(ssdp) {
    const container = document.getElementById('ssdp-registry-container');
    if (!container) return;

    const ips = Object.keys(ssdp).sort();
    if (ips.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.8rem; padding: 0.5rem;">Waiting for SSDP advertisements...</div>';
        return;
    }

    let html = `
        <table class="ssdp-table">
            <thead>
                <tr>
                    <th style="width: 110px;">IP Address</th>
                    <th style="width: 160px;">Device</th>
                    <th style="width: 100px;">Last Seen</th>
                    <th>Advertised Services</th>
                </tr>
            </thead>
            <tbody>
    `;

    ips.forEach(ip => {
        const entry = ssdp[ip];
        const services = entry.services || [];
        // Map services to friendly names for display, keep original for tooltip
        const servicesHtml = services.map(s => {
            const friendlyName = getFriendlyServiceName(s);
            return `<span class="ssdp-service-tag" title="${s}">${friendlyName}</span>`;
        }).join('');
        const tooltip = services.join('\n');
        html += `
            <tr>
                <td class="ssdp-ip">${ip}</td>
                <td class="ssdp-name" style="font-weight: 600; color: var(--primary);">${entry.name || 'Unknown'}</td>
                <td class="ssdp-time">${entry.lastSeen}</td>
                <td title="${tooltip}"><div class="ssdp-services-list">${servicesHtml}</div></td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

function openConsoleModal() {
    const modal = document.getElementById('console-modal');
    if (modal) {
        modal.style.display = 'flex';
        renderLogs();
        fetchServerLogs(); // Initial fetch
        if (!consolePollInterval) {
            consolePollInterval = setInterval(fetchServerLogs, 2000);
        }
    }
}

function closeConsoleModal() {
    const modal = document.getElementById('console-modal');
    if (modal) {
        modal.style.display = 'none';
        if (consolePollInterval) {
            clearInterval(consolePollInterval);
            consolePollInterval = null;
        }
    }
}

function renderLogs() {
    const container = document.getElementById('console-log-list');
    if (!container) return;

    container.innerHTML = '';
    // Sort all logs by timestamp before rendering
    const allLogs = [...window.appLogs].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    allLogs.forEach(log => appendLogToUI(log));
}

function appendLogToUI(log) {
    const container = document.getElementById('console-log-list');
    if (!container) return;

    const entry = document.createElement('div');
    entry.className = `log-entry log-${log.type}`;
    const sourceClass = log.source === 'SERVER' ? 'source-server' : 'source-client';
    entry.innerHTML = `<span class="log-time">[${log.timestamp}]</span> <span class="log-source ${sourceClass}">${log.source}</span> <span class="log-msg">${log.message}</span>`;
    container.appendChild(entry);

    container.scrollTop = container.scrollHeight;
}

function clearLogs() {
    window.appLogs = [];
    lastServerLogTimestamp = null;
    renderLogs();
}

async function openTrackInfoModal(trackData) {
    const modal = document.getElementById('track-info-modal');
    const container = document.getElementById('track-metadata-list');
    if (!modal || !container) return;

    modal.style.display = 'flex';
    container.innerHTML = `
        <div class="metadata-grid">
            <div class="metadata-header">Field</div>
            <div class="metadata-header">Media Server</div>
            <div class="metadata-header">File Tags (Deep Scan)</div>
            
            <div class="metadata-loading-row" id="metadata-loading-spinner">
                <div class="spinner"></div>
                <span style="margin-left: 1rem; color: var(--text-muted);">Analyzing track file...</span>
            </div>
            
            <div id="metadata-rows" style="display: contents;"></div>
        </div>
    `;

    const rowsContainer = document.getElementById('metadata-rows');

    // Fetch Deep Metadata early
    let embeddedMeta = null;
    let fetchError = null;
    try {
        if (trackData.uri) {
            const response = await fetch(`/api/track-metadata?uri=${encodeURIComponent(trackData.uri)}`);
            if (response.ok) {
                embeddedMeta = await response.json();
            } else {
                fetchError = "Deep scan failed";
            }
        }
    } catch (e) {
        fetchError = e.message;
    }

    // Hide loader
    const loader = document.getElementById('metadata-loading-spinner');
    if (loader) loader.style.display = 'none';

    function getEmbeddedValue(path) {
        if (!embeddedMeta) return undefined;
        const keys = path.split('.');
        let val = embeddedMeta;
        for (const k of keys) {
            val = val ? val[k] : undefined;
        }
        return val;
    }

    function normalizeForComparison(val) {
        if (val === undefined || val === null) return '';
        return String(val).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function formatValue(key, value) {
        if (value === undefined || value === null || value === '') return '-';
        if (key.includes('bitrate') && typeof value === 'number' && value > 0) {
            return (value / 1000).toFixed(0) + ' kbps';
        }
        if (key.includes('sampleRate') && typeof value === 'number') {
            return (value / 1000).toFixed(1) + ' kHz';
        }
        if (key.includes('duration') && typeof value === 'number') {
            const mins = Math.floor(value / 60);
            const secs = Math.floor(value % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        }
        if ((key === 'format.size' || key === 'size') && typeof value === 'number') {
            if (value >= 1048576) return (value / 1048576).toFixed(2) + ' MB';
            if (value >= 1024) return (value / 1024).toFixed(1) + ' KB';
            return value + ' B';
        }
        if ((key === 'format.width' || key === 'format.height' || key === 'width' || key === 'height') && (typeof value === 'number' || (typeof value === 'string' && value !== ''))) {
            return value + ' px';
        }
        return value;
    }

    const isImage = (trackData.class && trackData.class.includes('imageItem')) ||
        (trackData.protocolInfo && trackData.protocolInfo.includes('image/')) ||
        (embeddedMeta && embeddedMeta.format && embeddedMeta.format.isImage);

    // If we have resolution string from server, parse it for display
    if (trackData.resolution && typeof trackData.resolution === 'string') {
        const parts = trackData.resolution.split('x');
        if (parts.length === 2) {
            trackData.width = parts[0];
            trackData.height = parts[1];
        }
    }

    const fieldGroups = isImage ? [
        {
            title: 'Image Information',
            fields: [
                { label: 'Name', sKey: 'title', eKey: 'common.title' },
                { label: 'Width', sKey: 'width', eKey: 'format.width' },
                { label: 'Height', sKey: 'height', eKey: 'format.height' },
                { label: 'Format', sKey: '', eKey: 'format.container' },
                { label: 'File Size', sKey: 'size', eKey: 'format.size' }
            ]
        }
    ] : [
        {
            title: 'Primary Metadata',
            fields: [
                { label: 'Title', sKey: 'title', eKey: 'common.title' },
                { label: 'Artist', sKey: 'artist', eKey: 'common.artist' },
                { label: 'Album', sKey: 'album', eKey: 'common.album' },
                { label: 'Year', sKey: 'year', eKey: 'common.year' },
                { label: 'Genre', sKey: 'genre', eKey: 'common.genre' }
            ]
        },
        {
            title: 'Technical Specs',
            fields: [
                { label: 'Codec', sKey: '', eKey: 'format.codec' },
                { label: 'Bitrate', sKey: 'bitrate', eKey: 'format.bitrate' },
                { label: 'Sample Rate', sKey: 'sampleRate', eKey: 'format.sampleRate' },
                { label: 'Bit Depth', sKey: '', eKey: 'format.bitsPerSample' },
                { label: 'Channels', sKey: 'channels', eKey: 'format.numberOfChannels' },
                { label: 'Duration', sKey: 'duration', eKey: 'format.duration' }
            ]
        }
    ];

    fieldGroups.forEach(group => {
        group.fields.forEach(f => {
            const sValRaw = f.sKey ? trackData[f.sKey] : undefined;
            const eValRaw = f.eKey ? getEmbeddedValue(f.eKey) : undefined;

            const sVal = formatValue(f.sKey || '', sValRaw);
            const eVal = formatValue(f.eKey || '', eValRaw);

            // Comparison
            let isMismatch = false;
            if (sValRaw && eValRaw) {
                if (f.label === 'Duration') {
                    const parseDuration = (val) => {
                        if (typeof val === 'number') return val;
                        if (typeof val === 'string') {
                            const parts = val.split(':').map(Number);
                            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
                            if (parts.length === 2) return parts[0] * 60 + parts[1];
                            if (parts.length === 1) return parts[0];
                        }
                        return 0;
                    };
                    const sSec = parseDuration(sValRaw);
                    const eSec = parseDuration(eValRaw);
                    // Allow 1 second difference
                    if (Math.abs(sSec - eSec) > 1.1) {
                        isMismatch = true;
                    }
                } else {
                    const ns = normalizeForComparison(sValRaw);
                    const ne = normalizeForComparison(eValRaw);
                    // Only compare if we have both
                    if (ns && ne && ns !== ne) {
                        isMismatch = true;
                    }
                }
            }

            const mismatchClass = isMismatch ? 'mismatch' : '';
            const mismatchIcon = isMismatch ? '<div class="mismatch-badge" title="Data Mismatch">!</div>' : '';

            rowsContainer.innerHTML += `
                <div class="metadata-cell metadata-label-cell">${f.label}</div>
                <div class="metadata-cell metadata-value-cell ${mismatchClass}">${sVal}</div>
                <div class="metadata-cell metadata-value-cell secondary ${mismatchClass}">${eVal}${mismatchIcon}</div>
            `;
        });
    });

    if (fetchError) {
        rowsContainer.innerHTML += `
            <div class="metadata-cell" style="grid-column: span 3; color: #f87171; text-align: center; padding: 1rem;">
                Note: File scan was limited: ${fetchError}
            </div>
        `;
    }
}


function closeTrackInfoModal() {
    const modal = document.getElementById('track-info-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function showTrackInfoFromBrowser(index) {
    const item = currentBrowserItems[index];
    if (item) {
        openTrackInfoModal(item);
    }
}

function showTrackInfoFromPlaylist(id) {
    const item = currentPlaylistItems.find(i => i.id == id);
    if (item) {
        openTrackInfoModal(item);
    }
}

// Idle Artwork Popup Logic
let idleTimer = null;
const IDLE_THRESHOLD = 60000; // 1 minute

function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, IDLE_THRESHOLD);
}

function onIdle() {
    const artModal = document.getElementById('album-art-modal');
    const isShowingArt = artModal && artModal.style.display === 'flex';

    if (!isShowingArt && currentTransportState === 'Playing' && currentArtworkUrl) {
        console.log('[IDLE] User inactive for 30s and music playing. Showing artwork.');
        openArtModal(currentArtworkUrl);
    }
}

// Activity listeners
['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(event => {
    window.addEventListener(event, resetIdleTimer, { passive: true });
});

// Initial start
resetIdleTimer();


// About Modal Functions
function openAboutModal() {
    console.log('[DEBUG] About modal clicked');
    const modal = aboutModal || document.getElementById('about-modal');
    console.log('[DEBUG] Modal element:', modal);
    if (modal) {
        modal.style.display = 'flex';
        console.log('[DEBUG] Modal display set to flex');
    } else {
        console.error('[DEBUG] About modal not found!');
    }
}

function closeAboutModal() {
    const modal = aboutModal || document.getElementById('about-modal');
    if (modal) modal.style.display = 'none';
}

// Global modal click-outside-to-close handler
// Track where mousedown occurred to prevent accidental closes
let mouseDownTarget = null;

window.addEventListener('mousedown', (event) => {
    mouseDownTarget = event.target;
});

window.addEventListener('mouseup', (event) => {
    // Only close if both mousedown and mouseup happened on the same modal overlay
    if (mouseDownTarget === event.target) {
        if (event.target === serverModal) closeServerModal();
        if (event.target === rendererModal) closeRendererModal();
        // Settings modal (manageModal) removed - only closes via close button
        if (event.target === aboutModal) closeAboutModal();
        if (event.target === document.getElementById('track-info-modal')) document.getElementById('track-info-modal').style.display = 'none';
        if (event.target === document.getElementById('sonos-eq-modal')) closeSonosEqModal();
        if (event.target === document.getElementById('album-art-modal')) closeArtModal();
    }
    mouseDownTarget = null;
});

// Settings Modal Functions added by assistant
function openManageModal() {
    manageModal.style.display = 'flex';
    switchSettingsTab('general');
    renderManageDevices();
    fetchGeneralSettings();
    const tokenInput = document.getElementById('discogs-token-input');
    if (tokenInput) {
        fetch('/api/settings/discogs')
            .then(res => res.json())
            .then(data => {
                if (data.hasToken) {
                    tokenInput.value = data.maskedToken;
                } else {
                    tokenInput.value = '';
                }
            })
            .catch(err => console.error('Failed to fetch settings:', err));
    }
    fetchS3Settings();
}

function closeManageModal() {
    manageModal.style.display = 'none';
}

function switchSettingsTab(tabName) {
    const tabs = document.querySelectorAll('.settings-tab');
    const contents = document.querySelectorAll('.settings-panel');
    tabs.forEach(t => t.classList.remove('active'));
    contents.forEach(c => c.classList.remove('active'));
    const activeTab = Array.from(tabs).find(t => t.textContent.toLowerCase() === tabName.toLowerCase());
    const activeContent = document.getElementById(`settings-${tabName}`);
    if (activeTab) activeTab.classList.add('active');
    if (activeContent) activeContent.classList.add('active');
}

function renderManageDevices() {
    const renderers = currentDevices.filter(d => d.isRenderer);
    const servers = currentDevices.filter(d => d.isServer);
    const renderItem = (device, role) => {
        let host = 'unknown';
        try { host = new URL(device.location).hostname; } catch (e) { host = device.location; }
        const isDisabled = role === 'server' ? !!device.disabledServer : !!device.disabledPlayer;
        const isActive = role === 'server' ? selectedServerUdn === device.udn : selectedRendererUdn === device.udn;
        const displayName = device.customName || device.friendlyName;
        const iconHtml = device.iconUrl
            ? `<img src="${device.iconUrl}" class="manage-item-icon" alt="">`
            : `<div class="manage-item-icon-placeholder">${displayName.charAt(0)}</div>`;
        return `
            <div class="manage-item ${isDisabled ? 'item-disabled' : ''} ${isActive ? 'item-active' : ''}">
                ${iconHtml}
                <div class="manage-item-info">
                    <div class="manage-item-name-row" id="name-row-${device.udn?.replace(/:/g, '-')}">
                        <span class="manage-item-name">${displayName}</span>
                        <button class="btn-rename" onclick="startRename('${device.udn}')" title="Rename device">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                            </svg>
                        </button>
                    </div>
                    <span class="manage-item-host">${host} ${isDisabled ? '<span class="disabled-tag">(Disabled as ' + role + ')</span>' : ''}</span>
                </div>
                <div class="manage-item-actions">
                    ${!isDisabled ? (isActive ? `<span class="active-badge">Active</span>` : '') : ''}
                    <button class="btn-toggle ${isDisabled ? 'btn-enable' : 'btn-disable'}" onclick="toggleDeviceDisabled('${device.udn}', '${role}')">
                        ${isDisabled ? 'Enable' : 'Disable'}
                    </button>
                    <button class="btn-delete" onclick="deleteDevice('${device.udn}')">Forget</button>
                </div>
            </div>
        `;
    };
    if (manageRendererList) {
        manageRendererList.innerHTML = renderers.length ? renderers.map(d => renderItem(d, 'player')).join('') : '<div class="empty-state-mini">No players saved</div>';
    }
    if (manageServerList) {
        manageServerList.innerHTML = servers.length ? servers.map(d => renderItem(d, 'server')).join('') : '<div class="empty-state-mini">No servers saved</div>';
    }
}

// Additional missing functions for settings and device management

async function toggleDeviceDisabled(udn, role) {
    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udn)}/toggle-disabled/${role}`, {
            method: 'POST'
        });
        if (!response.ok) throw new Error('Failed to toggle device state');
        await fetchDevices();
        renderManageDevices();
        renderDevices();
    } catch (err) {
        console.error('Failed to toggle device:', err);
        showToast('Failed to update device');
    }
}

async function deleteDevice(udn) {
    if (!confirm('Remove this device from saved devices?')) return;
    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udn)}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete device');
        await fetchDevices();
        renderManageDevices();
        renderDevices();
        showToast('Device removed', 'success', 2000);
    } catch (err) {
        console.error('Failed to delete device:', err);
        showToast('Failed to remove device');
    }
}

function startRename(udn) {
    const device = currentDevices.find(d => d.udn === udn);
    if (!device) return;
    const nameRow = document.getElementById(`name-row-${udn.replace(/:/g, '-')}`);
    if (!nameRow) return;
    const currentName = device.customName || device.friendlyName;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'rename-input';
    input.style.cssText = 'flex: 1; padding: 0.3rem 0.5rem; border: 1px solid var(--primary); border-radius: 4px; background: var(--bg-secondary); color: white;';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = '✓';
    saveBtn.className = 'btn-control primary';
    saveBtn.style.cssText = 'padding: 0.3rem 0.6rem; margin-left: 0.5rem;';
    saveBtn.onclick = () => saveRename(udn, input.value);
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '✕';
    cancelBtn.className = 'btn-control';
    cancelBtn.style.cssText = 'padding: 0.3rem 0.6rem; margin-left: 0.3rem;';
    cancelBtn.onclick = () => renderManageDevices();
    nameRow.innerHTML = '';
    nameRow.appendChild(input);
    nameRow.appendChild(saveBtn);
    nameRow.appendChild(cancelBtn);
    input.focus();
    input.select();
}

async function saveRename(udn, newName) {
    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udn)}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customName: newName.trim() })
        });
        if (!response.ok) throw new Error('Failed to rename device');
        await fetchDevices();
        renderManageDevices();
        renderDevices();
        showToast('Device renamed', 'success', 2000);
    } catch (err) {
        console.error('Failed to rename device:', err);
        showToast('Failed to rename device');
    }
}

async function saveGeneralSettings() {
    const nameInput = document.getElementById('device-name-input');
    if (!nameInput) return;
    const deviceName = nameInput.value.trim();
    if (!deviceName) return;
    try {
        const response = await fetch('/api/settings/general', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName })
        });
        if (response.ok) {
            currentDeviceName = deviceName;
            updateUIWithDeviceName();
            showToast('Settings saved', 'success', 2000);
        }
    } catch (err) {
        console.error('Failed to save general settings:', err);
        showToast('Failed to save settings');
    }
}

async function fetchGeneralSettings() {
    try {
        const response = await fetch('/api/settings/general');
        const data = await response.json();
        if (data.deviceName) {
            currentDeviceName = data.deviceName;
            const nameInput = document.getElementById('device-name-input');
            if (nameInput) nameInput.value = data.deviceName;
            updateUIWithDeviceName();
        }
    } catch (err) {
        console.error('Failed to fetch general settings:', err);
    }
}

function updateUIWithDeviceName() {
    const h1 = document.querySelector('.header-main h1');
    if (h1) h1.textContent = currentDeviceName;
    document.title = `${currentDeviceName} | OpenHome Explorer`;
}

async function fetchS3Settings() {
    try {
        const response = await fetch('/api/settings/s3');
        if (!response.ok) throw new Error('Failed to fetch S3 settings');
        const data = await response.json();
        const enabled = document.getElementById('s3-enabled');
        const endpoint = document.getElementById('s3-endpoint');
        const region = document.getElementById('s3-region');
        const bucket = document.getElementById('s3-bucket');
        const accessKey = document.getElementById('s3-access-key');
        const secretKey = document.getElementById('s3-secret-key');
        if (enabled) enabled.checked = !!data.enabled;
        if (endpoint) endpoint.value = data.endpoint || '';
        if (region) region.value = data.region || 'auto';
        if (bucket) bucket.value = data.bucket || '';
        if (accessKey) accessKey.value = data.accessKeyId || '';
        if (secretKey) secretKey.value = data.secretAccessKey || '';
        const statusContainer = document.getElementById('s3-sync-status-container');
        if (statusContainer) {
            statusContainer.style.display = data.enabled ? 'block' : 'none';
        }
        if (data.enabled) {
            startS3StatusPolling();
        } else {
            stopS3StatusPolling();
        }
    } catch (err) {
        console.error('Failed to fetch S3 settings:', err);
    }
}

async function saveS3Settings() {
    const enabled = document.getElementById('s3-enabled')?.checked;
    const endpoint = document.getElementById('s3-endpoint')?.value.trim();
    const region = document.getElementById('s3-region')?.value.trim();
    const bucket = document.getElementById('s3-bucket')?.value.trim();
    const accessKeyId = document.getElementById('s3-access-key')?.value.trim();
    const secretAccessKey = document.getElementById('s3-secret-key')?.value.trim();
    const settings = { enabled, endpoint, region, bucket, accessKeyId, secretAccessKey };
    try {
        const response = await fetch('/api/settings/s3', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        if (response.ok) {
            const statusContainer = document.getElementById('s3-sync-status-container');
            if (statusContainer) statusContainer.style.display = enabled ? 'block' : 'none';
            if (enabled) {
                startS3StatusPolling();
            } else {
                stopS3StatusPolling();
            }
            showToast('S3 settings saved', 'success', 2000);
        }
    } catch (err) {
        console.error('Failed to save S3 settings:', err);
        showToast('Failed to save S3 settings');
    }
}

let s3StatusInterval = null;

function startS3StatusPolling() {
    if (s3StatusInterval) return;
    updateS3Status();
    s3StatusInterval = setInterval(updateS3Status, 2000);
}

function stopS3StatusPolling() {
    if (s3StatusInterval) {
        clearInterval(s3StatusInterval);
        s3StatusInterval = null;
    }
}

async function updateS3Status() {
    try {
        const response = await fetch('/api/sync/s3/status');
        const status = await response.json();
        const stateEl = document.getElementById('s3-sync-state');
        const progressRow = document.getElementById('s3-sync-progress-row');
        const countEl = document.getElementById('s3-sync-count');
        const percentEl = document.getElementById('s3-sync-percent');
        const barEl = document.getElementById('s3-sync-bar');
        const fileEl = document.getElementById('s3-sync-file');
        const lastSyncEl = document.getElementById('s3-last-sync');
        const btnSync = document.getElementById('btn-s3-sync-now');
        if (stateEl) {
            if (status.running) {
                stateEl.textContent = 'Syncing...';
                stateEl.style.color = 'var(--primary)';
                if (progressRow) progressRow.style.display = 'block';
                if (btnSync) btnSync.classList.add('disabled');
            } else if (status.lastError) {
                stateEl.textContent = 'Error';
                stateEl.style.color = 'var(--accent)';
                if (progressRow) progressRow.style.display = 'none';
                if (btnSync) btnSync.classList.remove('disabled');
            } else {
                stateEl.textContent = 'Idle';
                stateEl.style.color = 'var(--text-muted)';
                if (progressRow) progressRow.style.display = 'none';
                if (btnSync) btnSync.classList.remove('disabled');
            }
        }
        if (status.running && status.totalCount > 0) {
            const percent = Math.round((status.syncedCount / status.totalCount) * 100);
            if (countEl) countEl.textContent = `${status.syncedCount}/${status.totalCount} files`;
            if (percentEl) percentEl.textContent = `${percent}%`;
            if (barEl) barEl.style.width = `${percent}%`;
            if (fileEl) fileEl.textContent = status.currentFile;
        }
        if (lastSyncEl && status.lastSync) {
            const date = new Date(status.lastSync);
            lastSyncEl.textContent = `Last sync: ${date.toLocaleTimeString()}`;
        }
    } catch (err) {
        console.error('Failed to update S3 status:', err);
    }
}

async function triggerS3Sync() {
    const btn = document.getElementById('btn-s3-sync-now');
    if (btn) btn.classList.add('disabled');
    try {
        const response = await fetch('/api/sync/s3/start', { method: 'POST' });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to start sync');
        }
        showToast('Cloud sync started', 'success', 2000);
        await updateS3Status();
    } catch (err) {
        console.error('S3 sync error:', err);
        showToast(`Sync Error: ${err.message}`);
        if (btn) btn.classList.remove('disabled');
    }
}

async function triggerDiscovery(btn) {
    const originalContent = btn ? btn.innerHTML : null;
    if (btn) {
        btn.classList.add('scanning');
        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            Seeking...
        `;
    }
    try {
        console.log('Triggering manual SSDP discovery...');
        await fetch('/api/discover', { method: 'POST' });
        await fetchDevices();
        let count = 0;
        const interval = setInterval(async () => {
            count++;
            await fetchDevices();
            if (manageModal && manageModal.style.display !== 'none') {
                renderManageDevices();
            }
            if (count >= 5) clearInterval(interval);
        }, 1000);
        if (btn) {
            setTimeout(() => {
                console.log('Manual discovery period ended.');
                btn.classList.remove('scanning');
                btn.innerHTML = originalContent;
            }, 6000);
        }
    } catch (err) {
        console.error('Failed to trigger discovery:', err);
        if (btn) {
            btn.classList.remove('scanning');
            btn.innerHTML = originalContent;
        }
    }
}


async function saveDiscogsToken() {
    const input = document.getElementById('discogs-token-input');
    if (!input) return;
    const token = input.value.trim();
    try {
        const response = await fetch('/api/settings/discogs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        if (response.ok) {
            showToast('Discogs token saved', 'success', 2000);
        }
    } catch (err) {
        console.error('Failed to save Discogs token:', err);
        showToast('Failed to save token');
    }
}
