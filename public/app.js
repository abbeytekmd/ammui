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
const BROWSER_PLAYER_UDN = 'uuid:ammui-browser-player';

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
let rendererFailureCount = 0;
const MAX_RENDERER_FAILURES = 3;
let isRendererOffline = false;
let lastTransportActionTime = 0; // Timestamp to prevent stale status overrides
let currentDeviceName = 'AMMUI';
let screensaverTimeout = null;
let screensaverInterval = null;
let isScreensaverActive = false;
let screensaverConfig = { serverUdn: null, objectId: null };
let currentScreensaverPhoto = null;
let previousScreensaverPhoto = null; // Track the previous photo
let currentScreensaverRotation = 0;
let currentScreensaverFolder = null;
let screensaverMode = localStorage.getItem('screensaverMode') || 'all'; // 'all' or 'onThisDay'
const IDLE_TIMEOUT_MS = 60000; // 1 minute
let lastReportedTrackKey = null;

let browserViewMode = localStorage.getItem('browserViewMode') || 'list';

function isImageItem(item) {
    return item && item.type === 'item' && ((item.class && item.class.includes('imageItem')) || (item.protocolInfo && item.protocolInfo.includes('image/')));
}

let customSlideshowItems = [];
let customSlideshowIndex = -1;

// Local Disabling
let localDisabledDevices = new Set();
try {
    const storedLocalDisabled = localStorage.getItem('localDisabledDevices');
    if (storedLocalDisabled) {
        localDisabledDevices = new Set(JSON.parse(storedLocalDisabled));
    }
} catch (e) {
    console.warn('Failed to load local disabled devices:', e);
}

function isLocalDisabled(udn) {
    if (!udn) return false;
    return localDisabledDevices.has(udn);
}

function toggleLocalDisabled(udn) {
    if (localDisabledDevices.has(udn)) {
        localDisabledDevices.delete(udn);
    } else {
        localDisabledDevices.add(udn);
    }
    localStorage.setItem('localDisabledDevices', JSON.stringify(Array.from(localDisabledDevices)));
    renderManageDevices();
    renderDevices();
}

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
    rendererFailureCount = 0;
    isRendererOffline = false;
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
        <button id="btn-go-music-home" class="btn-control home-breadcrumb-btn" onclick="goHome('music')" title="Go to Music home">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 18V5l12-2v13"></path>
                <circle cx="6" cy="18" r="3"></circle>
                <circle cx="18" cy="16" r="3"></circle>
            </svg>
            <span class="home-btn-label">Music</span>
        </button>
        <button id="btn-go-photo-home" class="btn-control home-breadcrumb-btn" onclick="goHome('photo')" title="Go to Photo home">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
            </svg>
            <span class="home-btn-label">Photos</span>
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
    const tracks = currentBrowserItems.filter(item => item.type === 'item' && !isImageItem(item));
    const images = currentBrowserItems.filter(item => isImageItem(item));

    if (tracks.length === 0 && images.length > 0) {
        playAllPhotos(images);
        return;
    }

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
    const originalContent = btn.innerHTML;
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

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || `Failed to add track ${i + 1}`);
            }

            const data = await response.json();
            if (i === 0) firstTrackId = data.newId;
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
        showToast(`Play All failed: ${err.message}. Stopped remaining tracks.`);
    } finally {
        btn.classList.remove('disabled');
        btn.innerHTML = originalContent; // Restore icon and text
    }
}

function playAllPhotos(images) {
    customSlideshowItems = images;
    customSlideshowIndex = -1;
    startSlideshow();
}

async function transportAction(action) {
    if (!selectedRendererUdn) return;

    // Optimistic UI Update
    lastTransportActionTime = Date.now();
    const oldState = currentTransportState;
    if (action === 'play') currentTransportState = 'Playing';
    else if (action === 'pause') currentTransportState = 'Paused';
    else if (action === 'stop') currentTransportState = 'Stopped';

    updateTransportControls();
    updateDocumentTitle();

    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/${action}`, {
            method: 'POST'
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || `Failed to ${action}`);
        }

        // Fetch status soon after to confirm
        setTimeout(fetchStatus, 500);
        await fetchPlaylist(selectedRendererUdn);
    } catch (err) {
        console.error(`${action} error:`, err);
        currentTransportState = oldState;
        updateTransportControls();
        updateDocumentTitle();
        showToast(`Playback Error: ${err.message}`);
    }
}

async function playPlaylistItem(id) {
    if (!selectedRendererUdn) return;

    // If clicking the current track and it's paused, just resume
    if (currentTrackId != null && id != null && currentTrackId == id && currentTransportState === 'Paused') {
        await transportAction('play'); // transportAction now triggers a refresh
        return;
    }

    // Optimistic UI Update
    lastTransportActionTime = Date.now();
    const oldTrackId = currentTrackId;
    const oldState = currentTransportState;
    currentTrackId = id;
    currentTransportState = 'Playing';
    updateTransportControls();
    updateDocumentTitle();

    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/seek/${id}`, {
            method: 'POST'
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to play track');
        }

        // Force a full playlist and status refresh to show playing icon immediately
        setTimeout(fetchStatus, 500);
        await fetchPlaylist(selectedRendererUdn);
    } catch (err) {
        console.error('Play track error:', err);
        currentTrackId = oldTrackId;
        currentTransportState = oldState;
        updateTransportControls();
        updateDocumentTitle();
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

function toggleBrowserView() {
    browserViewMode = browserViewMode === 'list' ? 'grid' : 'list';
    localStorage.setItem('browserViewMode', browserViewMode);
    renderBrowser(currentBrowserItems);
}

function updateBrowserControls(items) {
    const tracks = items.filter(item => item.type === 'item' && !isImageItem(item));
    const images = items.filter(item => isImageItem(item));

    const btnPlayAll = document.getElementById('btn-play-all');
    const btnAddAll = document.getElementById('btn-add-all');
    const btnToggleView = document.getElementById('btn-toggle-view');
    const divToggleView = document.getElementById('div-toggle-view');

    const showMusicControls = tracks.length > 0;
    const showPhotoControls = images.length > 0;

    if (btnPlayAll) {
        btnPlayAll.style.display = (showMusicControls || showPhotoControls) ? 'flex' : 'none';
        const label = btnPlayAll.querySelector('.btn-label');
        if (label) {
            const btnText = showMusicControls ? 'Play All' : 'Slideshow';
            label.textContent = btnText;
            label.setAttribute('data-mobile', showMusicControls ? 'All' : 'SS');
        }
    }
    if (btnAddAll) btnAddAll.style.display = showMusicControls ? 'flex' : 'none';

    if (btnToggleView) {
        btnToggleView.style.display = showPhotoControls ? 'flex' : 'none';
        const label = document.getElementById('label-view-mode');
        const svgGrid = document.getElementById('svg-view-grid');
        const svgList = document.getElementById('svg-view-list');

        if (browserViewMode === 'grid') {
            if (label) label.textContent = 'List';
            if (svgGrid) svgGrid.style.display = 'none';
            if (svgList) svgList.style.display = 'block';
        } else {
            if (label) label.textContent = 'Grid';
            if (svgGrid) svgGrid.style.display = 'block';
            if (svgList) svgList.style.display = 'none';
        }
    }
    if (divToggleView) divToggleView.style.display = showPhotoControls ? 'block' : 'none';

    // Enable/disable buttons based on tracks/images count
    if (btnPlayAll) {
        const canPlay = showMusicControls || showPhotoControls;
        if (canPlay) btnPlayAll.classList.remove('disabled');
        else btnPlayAll.classList.add('disabled');
    }
    if (btnAddAll) {
        if (showMusicControls) btnAddAll.classList.remove('disabled');
        else btnAddAll.classList.add('disabled');
    }
}

function renderBrowser(items) {
    currentBrowserItems = items;

    // Check if folder contains images
    const hasImages = items.some(item =>
        (item.class && item.class.includes('imageItem')) ||
        (item.protocolInfo && item.protocolInfo.includes('image/'))
    );

    // Force list view if no images are present
    const effectiveViewMode = hasImages ? browserViewMode : 'list';

    // Restore scroll position
    const currentId = browsePath.length > 0 ? browsePath[browsePath.length - 1].id : '0';
    const savedScrollTop = browseScrollPositions[currentId] || 0;

    updateBrowserControls(items);
    updateHomeButtons();

    // Alphabet logic
    const alphabetScroll = document.getElementById('alphabet-scroll');
    if (alphabetScroll) {
        // Only consider items that start with a letter
        currentExistingLetters = [...new Set(items
            .filter(i => i.title && /^[a-zA-Z]/.test(i.title))
            .map(i => i.title[0].toUpperCase())
        )];

        if (effectiveViewMode === 'list') {
            alphabetScroll.classList.add('visible');
            renderAlphabet();
        } else {
            alphabetScroll.classList.remove('visible');
        }
    }

    if (items.length === 0) {
        browserItems.innerHTML = '<div class="empty-state">Folder is empty</div>';
        return;
    }

    // Apply view mode class
    if (effectiveViewMode === 'grid') {
        browserItems.classList.add('grid-view');
    } else {
        browserItems.classList.remove('grid-view');
    }

    let lastLetter = null;
    browserItems.innerHTML = items.map((item, index) => {
        const isContainer = item.type === 'container';
        const firstLetter = (item.title || '')[0].toUpperCase();
        let letterIdAttr = '';

        if (effectiveViewMode === 'list' && /^[A-Z]$/.test(firstLetter) && firstLetter !== lastLetter) {
            letterIdAttr = `id="letter-${firstLetter}"`;
            lastLetter = firstLetter;
        }

        const isImage = (item.class && item.class.includes('imageItem')) ||
            (item.protocolInfo && item.protocolInfo.includes('image/'));

        const isVideo = (item.class && item.class.includes('videoItem')) ||
            (item.protocolInfo && item.protocolInfo.includes('video/'));

        let icon = '';
        if (effectiveViewMode === 'grid') {
            const thumbUrl = item.albumArtUrl || (isImage ? item.uri : null);
            if (thumbUrl) {
                const escThumb = (thumbUrl || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
                icon = `<img src="${escThumb}" loading="lazy" alt="">`;
            }
        }

        if (!icon) {
            icon = isContainer ? `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
            ` : isImage ? `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <path d="M21 15l-5-5L5 21"></path>
                </svg>
            ` : isVideo ? `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                    <path d="M8 21h8"></path>
                    <path d="M12 17v4"></path>
                    <path d="M10 8l5 3-5 3V8z"></path>
                </svg>
            ` : `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M10 8l6 4-6 4V8z"></path>
                </svg>
            `;
        }

        const esc = (s) => (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const isLocalServer = selectedServerUdn === LOCAL_SERVER_UDN;

        return `
            <div ${letterIdAttr} class="playlist-item browser-item ${isContainer ? 'folder' : 'file'}" 
                 onclick="${isContainer ?
                `enterFolder('${item.id}', '${esc(item.title)}')` :
                isImage ?
                    `openArtModal('${esc(item.uri)}', '${esc(item.title)}')` :
                    isVideo ?
                        `handleVideoClick('${esc(item.uri)}', '${esc(item.title)}', '${esc(item.artist)}', '${esc(item.album)}', '${esc(item.duration)}', '${esc(item.protocolInfo)}', ${index})` :
                        `playTrack('${esc(item.uri)}', '${esc(item.title)}', '${esc(item.artist)}', '${esc(item.album)}', '${esc(item.duration)}', '${esc(item.protocolInfo)}')`}">
                <div class="item-icon">${icon}</div>
                <div class="item-info">
                    <div class="item-title">${item.title}</div>
                </div>
                ${(effectiveViewMode !== 'grid') && (!isLocalServer || isLocalServer || !isContainer) ? `
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
                            <span class="btn-label" data-mobile="">Queue</span>
                        </button>
                        ` : `
                        <button class="btn-control play-btn" onclick="event.stopPropagation(); playFolder('${esc(item.id)}', '${esc(item.title)}')" title="Play Whole Folder Recursively">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z"></path>
                            </svg>
                            <span class="btn-label" data-mobile="">Play</span>
                        </button>
                        <button class="btn-control queue-btn" onclick="event.stopPropagation(); queueFolder('${esc(item.id)}', '${esc(item.title)}')" title="Queue Whole Folder Recursively">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 5v14M5 12h14"></path>
                            </svg>
                            <span class="btn-label" data-mobile="">Queue</span>
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

        sessionStorage.setItem('lastPlaylist', JSON.stringify(playlist));

        renderPlaylist(playlist);
        rendererFailureCount = 0;
        if (isRendererOffline) {
            isRendererOffline = false;
            console.log(`[DEBUG] Renderer ${udn} recovered.`);
        }
    } catch (err) {
        console.error('Playlist fetch error:', err);
        rendererFailureCount++;
        if (rendererFailureCount >= MAX_RENDERER_FAILURES) {
            isRendererOffline = true;
            playlistItems.innerHTML = `<div class="error">Device offline or unreachable. Polling suspended. <button class="btn-control primary" style="margin-top: 0.5rem; padding: 0.4rem 1rem;" onclick="rendererFailureCount=0; isRendererOffline=false; fetchPlaylist(selectedRendererUdn);">Retry Connection</button></div>`;
        } else {
            playlistItems.innerHTML = `<div class="error">Error: ${err.message}</div>`;
        }
    }
}

async function fetchStatus() {
    if (!selectedRendererUdn || isRendererOffline) return;
    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/status`);
        if (!response.ok) throw new Error('Failed to fetch status');
        const status = await response.json();
        updateStatus(status);
        rendererFailureCount = 0;
    } catch (err) {
        console.error('Status fetch error:', err);
        rendererFailureCount++;
        if (rendererFailureCount >= MAX_RENDERER_FAILURES) {
            isRendererOffline = true;
            console.warn(`[DEBUG] Suspending polling for ${selectedRendererUdn} due to repeated failures.`);
        }
    }
}

function updateStatus(status) {
    const now = Date.now();
    const isLocked = (now - lastTransportActionTime) < 3000; // 3 second lockout

    const trackChanged = status.trackId !== currentTrackId;
    const transportChanged = status.transportState !== currentTransportState;

    if (!isLocked && (trackChanged || transportChanged)) {
        currentTrackId = status.trackId;
        currentTransportState = status.transportState;
        renderPlaylist(currentPlaylistItems);

        // Update modal track info if modal is open
        updateModalTrackInfo();

        // Report play stats if playing a new track
        if (currentTransportState === 'Playing' && currentTrackId != null) {
            const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);
            if (currentTrack) {
                const trackKey = `${currentTrack.title} - ${currentTrack.artist || 'Unknown Artist'}`.trim();
                if (trackKey !== lastReportedTrackKey) {
                    lastReportedTrackKey = trackKey;
                    fetch('/api/stats/track-played', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: currentTrack.title,
                            artist: currentTrack.artist,
                            album: currentTrack.album
                        })
                    }).catch(e => console.warn('Failed to report play stats:', e));
                }
            }
        }
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
    syncLocalPlayback(status);
}

function syncLocalPlayback(status) {
    if (selectedRendererUdn !== BROWSER_PLAYER_UDN) {
        return;
    }

    const video = document.getElementById('video-player');
    if (!video) return;

    if (status.trackId == null) {
        if (video.src && video.getAttribute('data-is-local-player') === 'true') {
            video.pause();
            video.src = "";
            video.removeAttribute('data-track-id');
            video.removeAttribute('data-is-local-player');
        }
        return;
    }

    const currentTrack = currentPlaylistItems.find(item => item.id == status.trackId);
    if (!currentTrack) return;

    const isVideo = (currentTrack.protocolInfo && currentTrack.protocolInfo.includes('video/')) ||
        (currentTrack.class && currentTrack.class.includes('videoItem'));

    // Check if we need to load or change track
    if (video.getAttribute('data-track-id') != status.trackId) {
        console.log(`[LOCAL PLAYER] Loading: ${currentTrack.title}`);
        video.src = currentTrack.uri;
        video.setAttribute('data-track-id', status.trackId);
        video.setAttribute('data-is-local-player', 'true');

        if (isVideo) {
            document.getElementById('video-modal').style.display = 'flex';
            document.getElementById('video-modal-title').textContent = currentTrack.title;
        }

        if (status.transportState === 'Playing') {
            video.play().catch(e => console.warn("Local autoplay failed:", e));
        }
    }

    // Sync state
    if (status.transportState === 'Playing') {
        if (video.paused) video.play().catch(e => console.warn("Local play failed:", e));

        // Sync time if significantly off (Master-Slave logic: Server is Master for Slaves)
        const timeDiff = Math.abs(video.currentTime - (status.relTime || 0));
        if (timeDiff > 5) {
            video.currentTime = status.relTime || 0;
        }
    } else if (status.transportState === 'Paused') {
        if (!video.paused) video.pause();
    } else if (status.transportState === 'Stopped') {
        if (video.src && video.getAttribute('data-is-local-player') === 'true') {
            video.pause();
            video.src = "";
            video.removeAttribute('data-track-id');
            video.removeAttribute('data-is-local-player');
            document.getElementById('video-modal').style.display = 'none';
        }
    }
}

// Local player event listeners
document.addEventListener('DOMContentLoaded', () => {
    const video = document.getElementById('video-player');
    if (video) {
        video.addEventListener('timeupdate', () => {
            if (selectedRendererUdn === BROWSER_PLAYER_UDN && currentTransportState === 'Playing') {
                const now = Date.now();
                if (!window._lastLocalTimeUpdate || now - window._lastLocalTimeUpdate > 2000) {
                    window._lastLocalTimeUpdate = now;
                    const pos = Math.floor(video.currentTime);
                    fetch(`/api/playlist/${encodeURIComponent(BROWSER_PLAYER_UDN)}/seek-time/${pos}`, { method: 'POST' });
                }
            }
        });

        video.addEventListener('ended', () => {
            if (selectedRendererUdn === BROWSER_PLAYER_UDN) {
                console.log("[LOCAL PLAYER] Track ended, jumping to next...");
                transportAction('next');
            }
        });
    }
});

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
    const containers = [
        document.getElementById(`player-art-container-${safeUdn}`),
        document.getElementById('global-player-art-container')
    ];
    const imgs = [
        document.getElementById(`player-art-${safeUdn}`),
        document.getElementById('global-player-art')
    ];

    console.log(`[ART] Loading artwork: ${url}`);
    let loadedCount = 0;

    const onLoaded = (container) => {
        loadedCount++;
        if (container) container.classList.add('visible');
    };

    imgs.forEach((img, idx) => {
        if (!img) return;
        img.onload = () => onLoaded(containers[idx]);
        img.onerror = (err) => {
            console.error(`[ART] Failed to load image element ${idx}: ${url}`);
            if (containers[idx]) containers[idx].classList.remove('visible');
        };
        img.src = url;
    });
}

function hideAllPlayerArt() {
    document.querySelectorAll('.player-artwork-container').forEach(el => {
        el.classList.remove('visible');
        const img = el.querySelector('img');
        if (img) img.src = '';
    });
    // Explicitly hide global container too
    const globalContainer = document.getElementById('global-player-art-container');
    if (globalContainer) globalContainer.classList.remove('visible');
}

function openArtModal(url, title = '', artist = '', album = '') {
    if (!url) return;
    const modal = document.getElementById('album-art-modal');
    const img = document.getElementById('modal-art-img');
    const titleEl = document.getElementById('modal-track-title');
    const artistEl = document.getElementById('modal-track-artist');
    const albumEl = document.getElementById('modal-track-album');
    const container = document.getElementById('modal-art-container');
    const wrapper = document.getElementById('modal-art-wrapper');

    if (modal && img) {
        console.log(`[ART] Opening modal for: ${url}`);

        // Use proxy for remote images to avoid CORS issues
        const finalUrl = (url.startsWith('http') && !url.includes(window.location.host))
            ? `/api/proxy-image?url=${encodeURIComponent(url)}`
            : url;

        img.src = ''; // Clear previous

        img.onload = () => {
            const ratio = img.naturalWidth / img.naturalHeight;
            if (ratio > 2.2) {
                // Panorama mode
                if (container) container.style.maxWidth = '100vw';
                if (wrapper) wrapper.classList.add('panorama-wrapper');
                img.classList.add('panorama-img');
            } else {
                if (container) container.style.maxWidth = '90vw';
                if (wrapper) wrapper.classList.remove('panorama-wrapper');
                img.classList.remove('panorama-img');
            }
        };

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

        // Reset panorama states
        const container = document.getElementById('modal-art-container');
        const wrapper = document.getElementById('modal-art-wrapper');
        const img = document.getElementById('modal-art-img');
        if (container) container.style.maxWidth = '90vw';
        if (wrapper) wrapper.classList.remove('panorama-wrapper');
        if (img) img.classList.remove('panorama-img');
    }
}

function openVideoModal(url, title = 'Video Player') {
    if (!url) return;
    const modal = document.getElementById('video-modal');
    const video = document.getElementById('video-player');
    const titleEl = document.getElementById('video-modal-title');

    if (modal && video) {
        console.log(`[VIDEO] Playing locally: ${url}`);
        if (titleEl) titleEl.textContent = title;

        video.src = url;
        modal.style.display = 'flex';
        video.play().catch(err => {
            console.warn('[VIDEO] Auto-play failed:', err);
        });
    }
}

async function handleVideoClick(uri, title, artist, album, duration, protocolInfo, index) {
    if (!selectedRendererUdn) {
        console.log(`[VIDEO] No player selected. Playing locally.`);
        openVideoModal(uri, title);
        return;
    }

    try {
        console.log(`[VIDEO] Attempting to cast to player...`);
        // We try to play it on the remote device first.
        // We do a manual clear + insert sequence so we can swallow errors specifically for the cast attempt

        await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/clear`, { method: 'POST' });
        const insRes = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/insert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri, title, artist, album, duration, protocolInfo })
        });

        if (!insRes.ok) throw new Error('Player insertion failed');
        const insData = await insRes.json();

        // Final play command
        const playRes = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/seek/${insData.newId}`, {
            method: 'POST'
        });

        if (!playRes.ok) throw new Error('Player play command failed');

        console.log(`[VIDEO] Cast successful.`);
        // Optimistic UI Update
        lastTransportActionTime = Date.now();
        currentTrackId = insData.newId;
        currentTransportState = 'Playing';
        updateTransportControls();
        updateDocumentTitle();

        showToast(`Casting video: ${title}`, 'success', 3000);
        setTimeout(fetchStatus, 800);
        await fetchPlaylist(selectedRendererUdn);
    } catch (err) {
        console.warn(`[VIDEO] Casting failed or not supported by player: ${err.message}. Falling back to local playback.`);
        // Fallback to local UI player
        openVideoModal(uri, title);
    }
}

function closeVideoModal() {
    const modal = document.getElementById('video-modal');
    const video = document.getElementById('video-player');
    if (modal) {
        modal.style.display = 'none';
        if (video) {
            video.pause();
            video.src = "";
        }
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
    const defaultTitle = `${currentDeviceName} | OpenHome Explorer`;

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


function renderManageDevices() {
    const renderers = currentDevices.filter(d => d.isRenderer);
    const servers = currentDevices.filter(d => d.isServer);

    const renderItem = (device, role) => {
        let host = 'unknown';
        try { host = new URL(device.location).hostname; } catch (e) { host = device.location; }
        const isServerDisabled = role === 'server' ? !!device.disabledServer : !!device.disabledPlayer;
        const isLocallyDisabled = isLocalDisabled(device.udn);
        const isActive = role === 'server' ? selectedServerUdn === device.udn : selectedRendererUdn === device.udn;

        const displayName = device.customName || device.friendlyName;
        const iconHtml = `<div class="manage-item-icon">${getDeviceIcon(device, role === 'server', 24)}</div>`;

        let statusTags = [];
        if (isServerDisabled) statusTags.push(`<span class="disabled-tag">(Everywhere)</span>`);
        if (isLocallyDisabled) statusTags.push(`<span class="disabled-tag">(Here)</span>`);

        return `
            <div class="manage-item ${isServerDisabled || isLocallyDisabled ? 'item-disabled' : ''} ${isActive ? 'item-active' : ''}">
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
                    <span class="manage-item-host">${host} ${statusTags.join(' ')}</span>
                </div>
                <div class="manage-item-actions">
                    ${!(isServerDisabled || isLocallyDisabled) ? (isActive ? `
                        <span class="active-badge">Active</span>
                    ` : '') : ''}
                    <div class="toggle-group" style="display: flex; gap: 0.5rem;">
                        <button class="btn-toggle ${isServerDisabled ? 'btn-enable' : 'btn-disable'}" 
                                onclick="toggleDeviceDisabled('${device.udn}', '${role}')"
                                title="Disable for all users of this AMMUI server">
                            ${isServerDisabled ? 'Enable Everywhere' : 'Disable Everywhere'}
                        </button>
                        <button class="btn-toggle ${isLocallyDisabled ? 'btn-enable' : 'btn-disable'}" 
                                onclick="toggleLocalDisabled('${device.udn}')"
                                title="Hide only on this browser/device">
                            ${isLocallyDisabled ? 'Show Here' : 'Hide Here'}
                        </button>
                    </div>
                    <button class="btn-delete" onclick="deleteDevice('${device.udn}')" title="Completely remove device">Forget</button>
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
        const response = await fetch(`/api/devices/${encodeURIComponent(udn)}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customName: newName })
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
    const renderers = currentDevices.filter(d => d.isRenderer && !d.disabledPlayer && !isLocalDisabled(d.udn));
    const servers = currentDevices.filter(d => d.isServer && !d.disabledServer && !isLocalDisabled(d.udn));

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

function getDeviceIcon(device, asServer, size = 32) {
    if (device.iconUrl) {
        return `<img src="${device.iconUrl}" class="${size === 32 ? 'device-card' : 'modal-device'}-img" alt="" style="width: ${size}px; height: ${size}px; object-fit: contain;">`;
    }

    if (device.friendlyName === 'Direct in the Browser' && !device.udn) {
        // Fallback if UDN missing for some reason
        console.log('[DEBUG] Matched Browser Player by Name');
    }

    if (device.udn === BROWSER_PLAYER_UDN || device.udn?.trim() === BROWSER_PLAYER_UDN) {
        console.log('[DEBUG] Matched Browser Player UDN:', device.udn);
        return `
            <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
        `;
    }

    if (asServer) {
        return `
            <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
        `;
    }

    if (device.isSonos) {
        return `
            <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <circle cx="12" cy="12" r="4"></circle>
                <line x1="12" y1="8" x2="12" y2="8.01"></line>
                <line x1="12" y1="16" x2="12" y2="16.01"></line>
            </svg>
        `;
    }

    // Default Speaker icon for other renderers
    console.log('[DEBUG] Default icon for:', device.udn, device.friendlyName);
    return `
        <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 5L6 9H2v6h4l5 4V5z"></path>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        </svg>
    `;
}

function updateModalDeviceLists() {
    const modalServerList = document.getElementById('modal-server-list');
    const modalRendererList = document.getElementById('modal-renderer-list');

    const renderers = currentDevices.filter(d => d.isRenderer && !d.disabledPlayer && !isLocalDisabled(d.udn));
    const servers = currentDevices.filter(d => d.isServer && !d.disabledServer && !isLocalDisabled(d.udn));

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
    const iconHtml = `<div class="modal-device-icon">${getDeviceIcon(device, asServer, 24)}</div>`;

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
    const icon = getDeviceIcon(device, asServer, 32);

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

async function setHome(type = 'music') {
    if (!selectedServerUdn) return;

    // Get existing home locations map
    let homeLocations = {};
    try {
        const stored = localStorage.getItem(`serverHomeLocations_${type}`);
        if (!stored && type === 'music') {
            // Migration: check for old key
            const oldStored = localStorage.getItem('serverHomeLocations');
            if (oldStored) homeLocations = JSON.parse(oldStored);
        } else if (stored) {
            homeLocations = JSON.parse(stored);
        }
    } catch (e) {
        console.error('Failed to parse home locations:', e);
    }

    // Store home path for this specific server and type
    homeLocations[selectedServerUdn] = browsePath;
    localStorage.setItem(`serverHomeLocations_${type}`, JSON.stringify(homeLocations));

    // Visual feedback
    const btnId = type === 'music' ? 'btn-set-music-home' : 'btn-set-photo-home';
    const btn = document.getElementById(btnId);
    if (btn) {
        const originalContent = btn.innerHTML;
        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            ${type === 'music' ? 'Music' : 'Photo'} Set!
        `;
        btn.style.color = '#4ade80';
        setTimeout(() => {
            btn.innerHTML = originalContent;
            btn.style.color = '';
        }, 2000);
    }

    updateHomeButtons();
}

async function setScreensaver() {
    if (!selectedServerUdn) return;

    // Use current folder
    const currentFolder = browsePath[browsePath.length - 1];
    if (!currentFolder) return;

    try {
        const response = await fetch('/api/settings/screensaver', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                serverUdn: selectedServerUdn,
                objectId: currentFolder.id,
                pathName: currentFolder.title
            })
        });

        if (!response.ok) throw new Error('Failed to save settings');

        screensaverConfig = { serverUdn: selectedServerUdn, objectId: currentFolder.id };

        // Visual feedback
        const btn = document.getElementById('btn-set-screensaver');
        if (btn) {
            const originalContent = btn.innerHTML;
            btn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                SS Set!
            `;
            btn.style.color = '#4ade80';
            setTimeout(() => {
                btn.innerHTML = originalContent;
                btn.style.color = '';
            }, 2000);
        }

    } catch (err) {
        console.error('Failed to set screensaver:', err);
        showToast('Failed to set screensaver source');
    }
    updateHomeButtons();
}



async function goHome(type = 'music') {
    if (!selectedServerUdn) return;

    // Get home path for this specific server and type
    let homeLocations = {};
    try {
        const stored = localStorage.getItem(`serverHomeLocations_${type}`);
        if (!stored && type === 'music') {
            const oldStored = localStorage.getItem('serverHomeLocations');
            if (oldStored) homeLocations = JSON.parse(oldStored);
        } else if (stored) {
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
            console.error(`Failed to go to ${type} home:`, e);
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
    const btnSetMusicHome = document.getElementById('btn-set-music-home');
    const btnSetPhotoHome = document.getElementById('btn-set-photo-home');
    const btnSetScreensaver = document.getElementById('btn-set-screensaver');
    const btnGoMusicHome = document.getElementById('btn-go-music-home');
    const btnGoPhotoHome = document.getElementById('btn-go-photo-home');

    if (!selectedServerUdn) return;

    const currentFolder = browsePath[browsePath.length - 1];

    // Helper to check home state
    const checkHome = (type) => {
        let homeLocations = {};
        try {
            const stored = localStorage.getItem(`serverHomeLocations_${type}`);
            if (!stored && type === 'music') {
                const oldStored = localStorage.getItem('serverHomeLocations');
                if (oldStored) homeLocations = JSON.parse(oldStored);
            } else if (stored) {
                homeLocations = JSON.parse(stored);
            }
        } catch (e) {
            console.error(`Failed to parse ${type} home locations:`, e);
        }
        const homeBrowsePath = homeLocations[selectedServerUdn];
        return homeBrowsePath && JSON.stringify(homeBrowsePath) === JSON.stringify(browsePath);
    };

    const isAtMusicHome = checkHome('music');
    const isAtPhotoHome = checkHome('photo');
    const isAtScreensaver = currentFolder && screensaverConfig &&
        screensaverConfig.serverUdn === selectedServerUdn &&
        screensaverConfig.objectId === currentFolder.id;

    if (btnSetMusicHome) {
        if (isAtMusicHome) {
            btnSetMusicHome.classList.add('disabled');
            btnSetMusicHome.title = "Already Music Home";
        } else {
            btnSetMusicHome.classList.remove('disabled');
            btnSetMusicHome.title = "Set as Music Home";
        }
    }

    if (btnSetPhotoHome) {
        if (isAtPhotoHome) {
            btnSetPhotoHome.classList.add('disabled');
            btnSetPhotoHome.title = "Already Photo Home";
        } else {
            btnSetPhotoHome.classList.remove('disabled');
            btnSetPhotoHome.title = "Set as Photo Home";
        }
    }

    if (btnSetScreensaver) {
        if (isAtScreensaver) {
            btnSetScreensaver.classList.add('disabled');
            btnSetScreensaver.title = "Already Screensaver Source";
        } else {
            btnSetScreensaver.classList.remove('disabled');
            btnSetScreensaver.title = "Use this folder for Screensaver";
        }
    }

    if (btnGoMusicHome) {
        if (isAtMusicHome) btnGoMusicHome.classList.add('disabled');
        else btnGoMusicHome.classList.remove('disabled');
    }

    if (btnGoPhotoHome) {
        if (isAtPhotoHome) btnGoPhotoHome.classList.add('disabled');
        else btnGoPhotoHome.classList.remove('disabled');
    }
}

// Initial fetch
async function init() {
    await fetchGeneralSettings();
    await fetchS3Settings();

    // Fetch screensaver settings
    try {
        const res = await fetch('/api/settings/screensaver');
        if (res.ok) {
            screensaverConfig = await res.json();
        }
    } catch (e) { console.warn('Failed to fetch screensaver settings'); }

    // Start idle timer
    resetIdleTimer();

    // Initialize screensaver mode label
    const ssModeLabel = document.getElementById('ss-mode-label');
    if (ssModeLabel) {
        ssModeLabel.textContent = (screensaverMode === 'all') ? 'All' : 'On This Day';
    }

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
    if (isPageVisible && selectedRendererUdn && !isRendererOffline) {
        fetchStatus();
        fetchVolume();
    }
}, 5000);

// Poll playlist every 15 seconds (less frequent)
setInterval(() => {
    if (isPageVisible && selectedRendererUdn && !isRendererOffline) {
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
            const sLower = s.toLowerCase();
            const isMedia = sLower.includes('contentdirectory') || sLower.includes('connectionmanager') ||
                sLower.includes('avtransport') || sLower.includes('renderingcontrol') ||
                sLower.includes('playlist') || sLower.includes('radio') ||
                sLower.includes('volume') || sLower.includes('info') ||
                sLower.includes('product') || sLower.includes('time') ||
                sLower.includes('receiver') || sLower.includes('sender') ||
                sLower.includes('mediarenderer') || sLower.includes('mediaserver') ||
                sLower.includes('zoneplayer') || sLower.includes('musicservices');
            const mediaClass = isMedia ? ' media' : '';
            return `<span class="ssdp-service-tag${mediaClass}" title="${s}">${friendlyName}</span>`;
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

async function clearLogs() {
    try {
        await fetch('/api/logs/clear', { method: 'POST' });
        window.appLogs = [];
        // We don't reset lastServerLogTimestamp to null here, 
        // because we want the next fetch to only get NEW logs.
        renderLogs();
    } catch (err) {
        console.error('Failed to clear server logs:', err);
    }
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

function resetIdleTimer(e) {
    // If activity is on screensaver controls or the start slideshow button, don't stop the screensaver
    if (e && e.target && typeof e.target.closest === 'function' &&
        (e.target.closest('.screensaver-controls') || e.target.closest('#btn-play-all'))
    ) return;

    const isMouseMove = e && e.type === 'mousemove';

    // 1. Logic for Idle Artwork (Artwork Popup)
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, IDLE_THRESHOLD);

    // 2. Logic for Screensaver
    // If screensaver is active, stop it ONLY on non-mousemove events
    if (isScreensaverActive && !isMouseMove) {
        stopSlideshow();
    }

    if (screensaverTimeout) clearTimeout(screensaverTimeout);

    // Only start screensaver timer if we are NOT playing something (casting), 
    // screensaver is not already active, and no local video modal is open
    const isVideoVisible = document.getElementById('video-modal')?.style.display === 'flex';
    if (currentTransportState !== 'Playing' && !isScreensaverActive && !isVideoVisible) {
        screensaverTimeout = setTimeout(startSlideshow, IDLE_TIMEOUT_MS);
    }
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
['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(event => {
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
function switchSettingsTab(tabId) {
    // Update tabs
    const tabs = document.querySelectorAll('.settings-tab');
    tabs.forEach(tab => {
        if (tab.getAttribute('onclick').includes(`'${tabId}'`)) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    // Update panels
    const panels = document.querySelectorAll('.settings-panel');
    panels.forEach(panel => {
        if (panel.id === `settings-${tabId}`) {
            panel.classList.add('active');
        } else {
            panel.classList.remove('active');
        }
    });
}

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



async function startSlideshow() {
    if (!customSlideshowItems.length && (!screensaverConfig.serverUdn || !screensaverConfig.objectId)) return;
    if (isScreensaverActive) return;

    // Don't start if local video is playing
    const isVideoVisible = document.getElementById('video-modal')?.style.display === 'flex';
    if (isVideoVisible) return;

    console.log('Starting Screensaver...');
    isScreensaverActive = true;
    const overlay = document.getElementById('screensaver-overlay');
    const img = document.getElementById('screensaver-img');
    const info = document.getElementById('screensaver-info');

    if (overlay) {
        overlay.style.display = 'flex';
        // Force reflow
        void overlay.offsetWidth;
        overlay.classList.add('active');
    }

    if (info) {
        info.style.cursor = 'pointer';
        info.onclick = (e) => {
            e.stopPropagation();
            goToScreensaverFolder();
        };
    }

    await showNextPhoto();

    // Clear any existing interval before starting a new one
    if (screensaverInterval) clearInterval(screensaverInterval);
    screensaverInterval = setInterval(showNextPhoto, 60000);
}

async function showNextPhoto() {
    const img = document.getElementById('screensaver-img');
    const info = document.getElementById('screensaver-info');
    if (!img) return;

    try {
        let data;
        if (customSlideshowItems.length > 0) {
            customSlideshowIndex = (customSlideshowIndex + 1) % customSlideshowItems.length;
            const item = customSlideshowItems[customSlideshowIndex];
            data = {
                url: item.uri || item.res,
                title: item.title,
                date: item.year || item.date || '',
                location: item.artist || '',
                manualRotation: item.manualRotation || 0,
                folderId: item.folderId || (browsePath.length > 0 ? browsePath[browsePath.length - 1].id : '0'),
                folderTitle: item.folderTitle || (browsePath.length > 0 ? browsePath[browsePath.length - 1].title : 'Root')
            };
        } else {
            const res = await fetch(`/api/slideshow/random?mode=${screensaverMode}`);
            if (res.ok) {
                data = await res.json();
            } else {
                const errData = await res.json();
                if (screensaverMode === 'onThisDay') {
                    showToast(errData.error || 'No photos for today', 'info', 3000);
                }
            }
        }

        if (data && data.url && img) {
            img.style.opacity = 0;
            if (info) info.style.opacity = 0;

            setTimeout(() => {
                // Save current photo as previous before changing
                if (currentScreensaverPhoto) {
                    previousScreensaverPhoto = {
                        url: currentScreensaverPhoto,
                        rotation: currentScreensaverRotation,
                        date: info ? info.querySelector('.ss-date')?.textContent : null,
                        location: info ? info.querySelector('.ss-location')?.textContent : null
                    };
                }

                img.src = data.url;
                currentScreensaverPhoto = data.url;
                currentScreensaverRotation = data.manualRotation || 0;

                // Modern browsers automatically handle EXIF orientation. 
                // Manual rotation causes "double rotation".
                // We apply our manual rotation ADDITIVELY.
                img.style.transform = `rotate(${currentScreensaverRotation}deg)`;

                if (info) {
                    // Extract year/date if possible. Often date is YYYY-MM-DD or similar.
                    let dateStr = '<no date>';
                    if (data.date) {
                        const d = new Date(data.date);
                        if (!isNaN(d.getTime())) {
                            if (/^\d{4}$/.test(data.date)) {
                                dateStr = data.date;
                            } else {
                                dateStr = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
                            }
                        } else {
                            dateStr = data.date;
                        }
                    }

                    // Combine Date and Location
                    let displayHtml = `<div class="ss-date">${dateStr}</div>`;
                    if (data.location) {
                        displayHtml += `<div class="ss-location">${data.location}</div>`;
                    }
                    info.innerHTML = displayHtml;

                    // Store folder info for navigation
                    currentScreensaverFolder = {
                        id: data.folderId,
                        title: data.folderTitle
                    };
                }

                img.onload = () => {
                    img.style.opacity = 1;
                    if (info) info.style.opacity = 1;

                    // Check for panorama format
                    const ratio = img.naturalWidth / img.naturalHeight;
                    if (ratio > 2.2) {
                        img.classList.add('panorama');
                    } else {
                        img.classList.remove('panorama');
                    }
                };
                // Fallback in case onload doesn't fire (cached)
                if (img.complete) {
                    img.onload();
                }
            }, 500);
        }
    } catch (e) {
        console.error('Slideshow fetch failed', e);
    }
}

function toggleSlideshowMode() {
    screensaverMode = screensaverMode === 'all' ? 'onThisDay' : 'all';
    localStorage.setItem('screensaverMode', screensaverMode);

    // Update UI label
    const label = document.getElementById('ss-mode-label');
    if (label) {
        label.textContent = screensaverMode === 'all' ? 'All' : 'On This Day';
    }

    showToast(`Slideshow Mode: ${screensaverMode === 'all' ? 'All Photos' : 'On This Day'}`, 'info', 2000);

    // Immediately show a new photo in the new mode
    showNextPhoto();
}



async function rotateSlideshow(delta) {
    if (!currentScreensaverPhoto) return;

    // 180 is special (toggle/fixed), 90/-90 are relative
    if (delta === 180) {
        currentScreensaverRotation = (currentScreensaverRotation + 180) % 360;
    } else {
        currentScreensaverRotation = (currentScreensaverRotation + delta) % 360;
    }

    // Ensure positive degrees (e.g. -90 -> 270)
    if (currentScreensaverRotation < 0) currentScreensaverRotation += 360;

    // Apply visually
    const img = document.getElementById('screensaver-img');
    if (img) {
        img.style.transform = `rotate(${currentScreensaverRotation}deg)`;
    }

    console.log(`Rotating photo ${currentScreensaverPhoto} to ${currentScreensaverRotation}deg`);

    // Save to server
    try {
        await fetch('/api/slideshow/rotate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: currentScreensaverPhoto,
                rotation: currentScreensaverRotation
            })
        });
    } catch (e) {
        console.error('Failed to save rotation:', e);
    }

    // Reset interval when interacting
    if (screensaverInterval) {
        clearInterval(screensaverInterval);
        screensaverInterval = setInterval(showNextPhoto, 60000);
    }
}

function previousSlideshow() {
    if (!previousScreensaverPhoto) {
        console.log('No previous photo available');
        return;
    }

    const img = document.getElementById('screensaver-img');
    const info = document.getElementById('screensaver-info');

    if (!img) return;

    // Fade out
    img.style.opacity = 0;
    if (info) info.style.opacity = 0;

    setTimeout(() => {
        // Swap current and previous
        const temp = {
            url: currentScreensaverPhoto,
            rotation: currentScreensaverRotation,
            date: info ? info.querySelector('.ss-date')?.textContent : null,
            location: info ? info.querySelector('.ss-location')?.textContent : null
        };

        // Restore previous photo
        img.src = previousScreensaverPhoto.url;
        currentScreensaverPhoto = previousScreensaverPhoto.url;
        currentScreensaverRotation = previousScreensaverPhoto.rotation || 0;
        img.style.transform = `rotate(${currentScreensaverRotation}deg)`;

        // Update info
        if (info) {
            let displayHtml = '';
            if (previousScreensaverPhoto.date) {
                displayHtml += `<div class="ss-date">${previousScreensaverPhoto.date}</div>`;
            }
            if (previousScreensaverPhoto.location) {
                displayHtml += `<div class="ss-location">${previousScreensaverPhoto.location}</div>`;
            }
            info.innerHTML = displayHtml;
        }

        // Update previous to be the old current
        previousScreensaverPhoto = temp;

        // Fade in
        img.onload = () => {
            img.style.opacity = 1;
            if (info) info.style.opacity = 1;
        };
        if (img.complete) {
            img.style.opacity = 1;
            if (info) info.style.opacity = 1;
        }
    }, 500);

    // Reset interval when interacting
    if (screensaverInterval) {
        clearInterval(screensaverInterval);
        screensaverInterval = setInterval(showNextPhoto, 60000);
    }

    console.log('Going back to previous photo');
}

async function deleteCurrentPhoto() {
    if (!currentScreensaverPhoto) return;

    if (!confirm('Are you sure you want to mark this photo as deleted? It will not be shown again in the slideshow.')) {
        return;
    }

    console.log(`Deleting photo: ${currentScreensaverPhoto}`);

    try {
        const response = await fetch('/api/slideshow/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: currentScreensaverPhoto
            })
        });

        if (response.ok) {
            showToast('Photo marked as deleted', 'success', 2000);
            // Move to next photo immediately
            if (screensaverInterval) {
                clearInterval(screensaverInterval);
                screensaverInterval = setInterval(showNextPhoto, 60000);
            }
            await showNextPhoto();
        } else {
            const data = await response.json();
            showToast(`Failed to delete photo: ${data.error || 'Server error'}`);
        }
    } catch (e) {
        console.error('Failed to delete photo:', e);
        showToast('Failed to delete photo');
    }
}

function stopSlideshow() {
    if (!isScreensaverActive) return;

    console.log('Stopping Screensaver...');
    isScreensaverActive = false;
    customSlideshowItems = [];
    customSlideshowIndex = -1;
    if (screensaverTimeout) clearTimeout(screensaverTimeout);
    if (screensaverInterval) clearInterval(screensaverInterval);

    const overlay = document.getElementById('screensaver-overlay');
    if (overlay) {
        overlay.classList.remove('active');
        setTimeout(() => {
            if (!isScreensaverActive) overlay.style.display = 'none';
        }, 1000);
    }
}

async function goToScreensaverFolder() {
    if (!currentScreensaverFolder || !screensaverConfig.serverUdn) {
        console.warn('[SCREENSAVER] No folder info available to navigate');
        return;
    }

    console.log('[SCREENSAVER] Navigating to folder:', currentScreensaverFolder.title);
    const folderId = currentScreensaverFolder.id;
    const folderTitle = currentScreensaverFolder.title;

    stopSlideshow();

    // Ensure we are in grid mode
    browserViewMode = 'grid';
    localStorage.setItem('browserViewMode', 'grid');

    // Select the server
    selectedServerUdn = screensaverConfig.serverUdn;
    localStorage.setItem('selectedServerUdn', selectedServerUdn);

    // Reset browser path to root first to ensure clean breadcrumbs
    browsePath = [{ id: '0', title: 'Home' }];

    // Trigger navigation
    await enterFolder(folderId, folderTitle);

    // If on mobile, switch to browser tab
    if (typeof switchView === 'function') {
        switchView('browser');
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




// Stats Modal logic
async function openStatsModal() {
    const modal = document.getElementById('stats-modal');
    if (modal) {
        modal.style.display = 'flex';
        await fetchStats();
    }
}

function closeStatsModal() {
    const modal = document.getElementById('stats-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function switchStatsTab(tab) {
    const tracksBtn = document.getElementById('tab-stats-tracks');
    const albumsBtn = document.getElementById('tab-stats-albums');
    const tracksPanel = document.getElementById('stats-tracks');
    const albumsPanel = document.getElementById('stats-albums');

    if (tab === 'tracks') {
        tracksBtn.classList.add('active');
        albumsBtn.classList.remove('active');
        tracksPanel.classList.add('active');
        albumsPanel.classList.remove('active');
    } else {
        tracksBtn.classList.remove('active');
        albumsBtn.classList.add('active');
        tracksPanel.classList.remove('active');
        albumsPanel.classList.add('active');
    }
}

async function fetchStats() {
    try {
        const res = await fetch('/api/stats');
        if (res.ok) {
            const data = await res.json();
            renderStats(data);
        }
    } catch (err) {
        console.error('Failed to fetch stats:', err);
    }
}

function renderStats(data) {
    const tracksList = document.getElementById('stats-tracks-list');
    const albumsList = document.getElementById('stats-albums-list');

    if (tracksList) {
        tracksList.innerHTML = data.tracks.map((track, index) => `
            <div class="stats-item">
                <div class="stats-rank">#${index + 1}</div>
                <div class="stats-info">
                    <div class="stats-title">${track.title}</div>
                    <div class="stats-subtitle">${track.artist || 'Unknown Artist'}</div>
                </div>
                <div class="stats-count">${track.count} plays</div>
            </div>
        `).join('');
    }

    if (albumsList) {
        albumsList.innerHTML = data.albums.map((album, index) => `
            <div class="stats-item">
                <div class="stats-rank">#${index + 1}</div>
                <div class="stats-info">
                    <div class="stats-title">${album.album}</div>
                    <div class="stats-subtitle">${album.artist || 'Unknown Artist'}</div>
                </div>
                <div class="stats-count">${album.count} plays</div>
            </div>
        `).join('');
    }
}
