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
const manageAirPlayList = document.getElementById('manage-airplay-list');
const castModal = document.getElementById('cast-modal');
const modalCastList = document.getElementById('modal-cast-list');
const floatingBtn = document.getElementById('floating-nav-btn');
const navBtnLabel = document.getElementById('nav-btn-label');

let currentDevices = [];
let selectedRendererUdn = localStorage.getItem('selectedRendererUdn');
let selectedServerUdn = localStorage.getItem('selectedServerUdn');
let browsePath = [{ id: '0', title: 'Root' }];
let currentBrowserMode = localStorage.getItem('currentBrowserMode') || 'music';
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
let triedArtworkUrls = []; // URLs already tried for the current track (for retry skipping)
let triedArtworkQueryKey = ''; // which query the triedArtworkUrls belong to
let currentLyrics = null; // { lines: [{time, text}] } or null when unavailable/unsynced
let lyricsTrackKey = ''; // artist|title|album for the track currentLyrics was fetched for
let lyricsActiveLineIndex = -1;
const artworkOverrides = new Map(JSON.parse(localStorage.getItem('artworkOverrides') || '[]')); // uri → manually chosen url, persisted across refreshes
let browseScrollPositions = {}; // Store scroll position by folder ID
let rendererFailureCount = 0;
const MAX_RENDERER_FAILURES = 2;
let currentInfoUri = null;
let currentFileTags = [];
let allLibraryTags = [];
let isRendererOffline = false;

function setRendererOffline(state, caller = 'unknown') {
    if (isRendererOffline === state) return;
    isRendererOffline = state;
    console.log(`[OFFLINE-SYNC] Renderer offline state changed to: ${state} for ${selectedRendererUdn} (triggered by ${caller})`);

    if (state) {
        console.warn(`[OFFLINE-SYNC] Device ${selectedRendererUdn} is now OFFLINE. (Source: ${caller})`);
        // When going offline, also update UI immediately
        const playlistItems = document.getElementById('playlist-items');
        if (playlistItems) {
            playlistItems.innerHTML = `<div class="error">Device offline or unreachable. <button class="btn-control primary" style="margin-top: 0.5rem; padding: 0.4rem 1rem;" onclick="handleRetry()">Retry</button></div>`;
        }
    } else {
        console.log(`[OFFLINE-SYNC] Device ${selectedRendererUdn} is now ONLINE. (Source: ${caller})`);
    }

    renderDevices();
    updateTransportControls();
}

async function handleRetry() {
    if (!selectedRendererUdn) return;
    console.log(`[OFFLINE-SYNC] Manual retry initiated for ${selectedRendererUdn}`);

    // Clear failure count
    rendererFailureCount = 0;

    // Instead of immediately turning green, we try to fetch status first.
    // If it succeeds, THEN we turn green.
    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/status`);
        if (response.ok) {
            setRendererOffline(false, 'HandleRetrySuccess');
            fetchPlaylist(selectedRendererUdn);
            fetchVolume();
        } else {
            console.warn(`[OFFLINE-SYNC] Retry failed: Status endpoint returned ${response.status}`);
            showToast('Device still unreachable', 'error', 2000);
        }
    } catch (err) {
        console.error(`[OFFLINE-SYNC] Retry failed: ${err.message}`);
        showToast('Device still unreachable', 'error', 2000);
    }
}
let stopAfterTrack = false; // When true, stop playback after current track ends
let lastTransportActionTime = 0; // Timestamp to prevent stale status overrides
let currentDeviceName = 'AMMUI';
let slideshow;
let screensaverConfig = { serverUdn: null, objectId: null };
const IDLE_TIMEOUT_MS = 60000; // 1 minute
let lastReportedTrackKey = null;

let manualRotations = {}; // Client-side cache of saved photo rotations

let browserViewMode = localStorage.getItem('browserViewMode') || 'list';
let selectedPhotos = new Set(); // URIs of selected photos for batch operations
let airplayScanInterval = null;
let isAirPlayScanRunning = false;
let pendingCastIndex = null;

function isImageItem(item) {
    return item && item.type === 'item' && ((item.class && item.class.includes('imageItem')) || (item.protocolInfo && item.protocolInfo.includes('image/')));
}

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

            // Also refresh the management UI if it's currently open
            if (manageModal && manageModal.style.display === 'flex') {
                renderManageDevices();
            }
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
    document.querySelectorAll('input[name="browser-mode"]').forEach(r => { r.checked = r.value === currentBrowserMode; });
    updateLocalOnlyUI();

    if (window.innerWidth <= 1100) {
        switchView('browser');
    }

    browserContainer.style.display = 'flex';

    // Prioritize last browsed path, then home location, then root
    let lastPaths = {};
    let homeLocations = {};
    const mode = currentBrowserMode || 'music';
    try {
        const storedLast = localStorage.getItem(`serverLastPaths_${mode}`);
        if (storedLast) lastPaths = JSON.parse(storedLast);

        const storedHome = localStorage.getItem(`serverHomeLocations_${mode}`);
        if (storedHome) homeLocations = JSON.parse(storedHome);
        else if (mode === 'music') {
            // Check old key for music migration
            const oldHome = localStorage.getItem('serverHomeLocations');
            if (oldHome) homeLocations = JSON.parse(oldHome);
        }
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

    // Reset offline state BEFORE rendering
    rendererFailureCount = 0;
    setRendererOffline(false, 'selectDevice');
    stopAfterTrack = false;

    renderDevices();
    updateTransportControls();

    if (window.innerWidth <= 1100) {
        switchView('playlist');
    }

    playlistItems.innerHTML = '<div class="loading">Loading playlist...</div>';

    currentArtworkQuery = '';
    currentArtworkUrl = '';
    failedArtworkQueries.clear();
    hideAllPlayerArt();
    await fetchPlaylist(udn);
    await fetchVolume();
}


function normalizeTitle(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function enrichWithDiscogs(items) {
    const audioTracks = items.filter(i => i.type === 'item' && !isImageItem(i));
    if (audioTracks.length === 0) return;
    if (audioTracks.some(t => t.trackNumber > 0)) return; // already have track numbers

    const album = audioTracks[0].album;
    const artist = audioTracks[0].artist;
    if (!album || !artist) return;
    // Only enrich if all tracks share the same album
    if (!audioTracks.every(t => t.album === album)) return;

    try {
        const resp = await fetch(`/api/discogs/tracklist?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (!data.tracks || data.tracks.length === 0) return;

        for (const item of audioTracks) {
            const norm = normalizeTitle(item.title);
            const match = data.tracks.find(t => normalizeTitle(t.title) === norm);
            if (match) {
                item.trackNumber = match.trackNumber;
                item.discNumber = match.discNumber;
            }
        }
    } catch (e) {
        console.warn('[Discogs] enrichment failed:', e);
    }
}

async function browse(udn, objectId) {
    browserItems.innerHTML = '<div class="loading">Browsing...</div>';
    try {
        const response = await fetch(`/api/browse/${encodeURIComponent(udn)}?objectId=${encodeURIComponent(objectId)}`);
        if (!response.ok) throw new Error('Failed to browse server');
        const data = await response.json();
        await enrichWithDiscogs(data.items);
        renderBrowser(data.items);
    } catch (err) {
        console.error('Browse error:', err);
        browserItems.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    }
}

function updateBreadcrumbs() {
    const mode = currentBrowserMode || 'music';
    const homeIndicator = `
        <button id="btn-go-${mode}-home" class="btn-control home-breadcrumb-btn" onclick="goHome('${mode}')" title="Go to ${mode} home">
            ${mode === 'music' ? `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 18V5l12-2v13"></path>
                    <circle cx="6" cy="18" r="3"></circle>
                    <circle cx="18" cy="16" r="3"></circle>
                </svg>
            ` : `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
            `}
            <span class="home-btn-label">Home</span>
        </button>
        <span class="breadcrumb-separator" style="margin-right: 0.5rem"></span>
    `;

    const separator = '<span class="breadcrumb-separator">/</span>';
    const ellipsis = '<span class="breadcrumb-separator" style="opacity:0.5; margin:0 0.3rem">...</span>';

    // 1. Try rendering full path
    browserBreadcrumbs.innerHTML = homeIndicator + browsePath.map((item, index) => `
        <span class="breadcrumb-item" onclick="navigateToPath(${index})">${item.title}</span>
    `).join(separator);

    // 2. Check for overflow
    if (browserBreadcrumbs.scrollWidth <= browserBreadcrumbs.clientWidth) return;

    // 3. Truncate if overflowing
    // Keep Root (index 0) and try to fit as many from the end as possible
    if (browsePath.length >= 2) {
        // Start by trying to keep (length-2) items at the end (so [Root] ... [2nd item] ... [Last item])
        // Iterate reducing k (number of items to keep at end)
        for (let k = browsePath.length - 2; k >= 1; k--) {
            const lastK = browsePath.slice(browsePath.length - k);

            const truncatedHtml = homeIndicator +
                `<span class="breadcrumb-item" onclick="navigateToPath(0)">${browsePath[0].title}</span>` +
                separator +
                ellipsis +
                separator +
                lastK.map((item, i) => {
                    // Correct index mapping: start from (length - k)
                    const originalIndex = browsePath.length - k + i;
                    return `<span class="breadcrumb-item" onclick="navigateToPath(${originalIndex})">${item.title}</span>`;
                }).join(separator);

            browserBreadcrumbs.innerHTML = truncatedHtml;

            if (browserBreadcrumbs.scrollWidth <= browserBreadcrumbs.clientWidth) return;
        }
    }

    // Fallback: Just Home > ... > Current
    // Or even just Home > Current if really tight
    const minimalHtml = homeIndicator +
        ellipsis +
        separator +
        `<span class="breadcrumb-item" onclick="navigateToPath(${browsePath.length - 1})">${browsePath[browsePath.length - 1].title}</span>`;

    browserBreadcrumbs.innerHTML = minimalHtml;
}

function saveLastPath() {
    if (!selectedServerUdn) return;
    const mode = currentBrowserMode || 'music';
    let lastPaths = {};
    try {
        const stored = localStorage.getItem(`serverLastPaths_${mode}`);
        if (stored) lastPaths = JSON.parse(stored);
    } catch (e) { }
    lastPaths[selectedServerUdn] = browsePath;
    localStorage.setItem(`serverLastPaths_${mode}`, JSON.stringify(lastPaths));
}

let breadcrumbResizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(breadcrumbResizeTimeout);
    breadcrumbResizeTimeout = setTimeout(() => {
        updateBreadcrumbs();
    }, 100);
});

async function navigateToPath(index) {
    browsePath = browsePath.slice(0, index + 1);
    saveLastPath();
    updateBreadcrumbs();
    const item = browsePath[index];
    await browse(selectedServerUdn, item.id);
}

async function goUpFolder() {
    if (browsePath.length > 1) {
        // Go to the second to last item in the path (parent)
        await navigateToPath(browsePath.length - 2);
    }
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

async function addToPlaylist(uri, title, artist, album, duration, protocolInfo, albumArtUrl, autoSwitch = true, pathStr = '') {
    if (!selectedRendererUdn) {
        alert('Please select a Renderer on the left first!');
        return;
    }

    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/insert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri, title, artist, album, duration, protocolInfo, albumArtUrl, pathStr })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to add track');
        }

        showToast(`Added: ${title}`, 'success', 2000);
        await fetchPlaylist(selectedRendererUdn);

        // On mobile, switch to playlist view after adding if requested
        if (autoSwitch && window.innerWidth <= 1100) {
            switchView('playlist');
        }
    } catch (err) {
        console.error('Client: Error adding track:', err);
        showToast(`Failed to add track: ${err.message}`);
        throw err;
    }
}

async function queueFolder(objectId, title, pathStr = '') {
    if (!selectedRendererUdn) {
        alert('Please select a Renderer on the left first!');
        return;
    }

    showToast(`Queuing folder: ${title}...`, 'info', 3000);
    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/queue-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverUdn: selectedServerUdn, objectId, title, pathStr })
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

async function playFolder(objectId, title, pathStr = '') {
    if (!selectedRendererUdn) {
        alert('Please select a Renderer on the left first!');
        return;
    }

    showToast(`Playing folder: ${title}...`, 'info', 3000);
    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/play-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverUdn: selectedServerUdn, objectId, title, pathStr })
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

async function playFolderSlideshow(objectId, title) {
    if (!selectedServerUdn) return;
    showToast(`Loading slideshow from: ${title}...`, 'info', 3000);
    try {
        const response = await fetch(`/api/browse-recursive/${encodeURIComponent(selectedServerUdn)}?objectId=${encodeURIComponent(objectId)}`);
        if (!response.ok) throw new Error('Failed to fetch folder items');
        const data = await response.json();
        const images = (data.items || []).filter(item => isImageItem(item));
        if (images.length === 0) {
            showToast('No photos found in this folder.', 'info', 3000);
            return;
        }
        if (slideshow) slideshow.start(images, -1);
    } catch (err) {
        console.error('Folder slideshow error:', err);
        showToast(`Failed to start slideshow: ${err.message}`);
    }
}


async function downloadTrack(uri, title, artist, album, albumArtist) {
    showToast(`Downloading: ${title}...`, 'info', 3000);
    try {
        const response = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri, title, artist, album, albumArtist })
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

let _dlEventSource = null;
let _dlLastLogLen = 0;

async function downloadFolder(udn, objectId, title, artist, album, albumArtist) {
    try {
        const response = await fetch('/api/download-folder-start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ udn, objectId, title, artist, album, albumArtist })
        });
        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to start download');
        }
        const { jobId } = await response.json();
        localStorage.setItem('activeDownloadJob', jobId);
        openDownloadProgressModal(jobId, title);
    } catch (err) {
        showToast(`Download failed: ${err.message}`, 'error');
    }
}

function openDownloadProgressModal(jobId, folderTitle) {
    const modal = document.getElementById('download-progress-modal');
    const titleEl = document.getElementById('download-progress-title');
    const bar = document.getElementById('download-progress-bar');
    const current = document.getElementById('download-progress-current');
    const log = document.getElementById('download-progress-log');
    const stats = document.getElementById('download-progress-stats');
    const closeBtn = document.getElementById('download-progress-close');

    if (folderTitle) titleEl.textContent = `Downloading: ${folderTitle}`;
    bar.style.width = '0%';
    current.textContent = 'Starting...';
    log.innerHTML = '';
    log.style.cssText = 'font-size:14px;color:#e2e8f0;max-height:240px;min-height:60px;overflow-y:auto;background:rgba(0,0,0,0.35);border-radius:0.5rem;padding:0.6rem 0.75rem;display:flex;flex-direction:column;gap:2px;';
    stats.textContent = '';
    closeBtn.disabled = true;
    modal.style.display = 'flex';

    _dlLastLogLen = 0;
    if (_dlEventSource) { _dlEventSource.close(); _dlEventSource = null; }
    _dlEventSource = new EventSource(`/api/download-job/${jobId}/stream`);
    _dlEventSource.onmessage = (e) => applyDownloadJobUpdate(JSON.parse(e.data));
    _dlEventSource.onerror = () => { _dlEventSource.close(); _dlEventSource = null; };
}

function applyDownloadJobUpdate(job) {
    const bar = document.getElementById('download-progress-bar');
    const current = document.getElementById('download-progress-current');
    const log = document.getElementById('download-progress-log');
    const stats = document.getElementById('download-progress-stats');
    const titleEl = document.getElementById('download-progress-title');
    const closeBtn = document.getElementById('download-progress-close');

    // Append only new log entries
    const newEntries = job.log.slice(_dlLastLogLen);
    _dlLastLogLen = job.log.length;
    const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
    for (const entry of newEntries) {
        const icon = entry.status === 'done' ? '✓' : entry.status === 'skipped' ? '—' : '✗';
        const cls = entry.status === 'done' ? 'dl-done' : entry.status === 'skipped' ? 'dl-skipped' : 'dl-failed';
        const el = document.createElement('div');
        el.className = `dl-log-entry ${cls}`;
        el.textContent = `${icon} ${entry.title}${entry.error ? ': ' + entry.error : ''}`;
        const entryColor = entry.status === 'done' ? '#4ade80' : entry.status === 'skipped' ? '#94a3b8' : '#f87171';
        el.style.cssText = `font-size:14px;line-height:1.6;color:${entryColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 0;flex-shrink:0;`;
        log.appendChild(el);
    }
    while (log.children.length > 500) log.removeChild(log.firstChild);
    if (newEntries.length && wasAtBottom) log.scrollTop = log.scrollHeight;

    const done = job.downloadCount + job.skippedCount + job.failCount;
    if (job.total > 0) bar.style.width = Math.round((done / job.total) * 100) + '%';

    if (job.done || job.error) {
        if (_dlEventSource) { _dlEventSource.close(); _dlEventSource = null; }
        localStorage.removeItem('activeDownloadJob');
        bar.style.width = '100%';
        current.textContent = job.error ? `Error: ${job.error}` : 'Complete';
        stats.textContent = job.error ? '' : `${job.downloadCount} downloaded, ${job.skippedCount} skipped, ${job.failCount} failed`;
        if (!job.error) titleEl.textContent = titleEl.textContent.replace('Downloading:', 'Complete:');
        closeBtn.disabled = false;
    } else {
        current.textContent = job.current || (job.total ? `${done} / ${job.total}` : 'Working...');
    }
}

function closeDownloadProgressModal() {
    document.getElementById('download-progress-modal').style.display = 'none';
}

// On page load, reconnect to any in-progress download job
async function checkActiveDownloadJob() {
    const jobId = localStorage.getItem('activeDownloadJob');
    if (!jobId) return;
    try {
        const res = await fetch(`/api/download-job/${jobId}`);
        if (!res.ok) { localStorage.removeItem('activeDownloadJob'); return; }
        const job = await res.json();
        if (job.done) { localStorage.removeItem('activeDownloadJob'); return; }
        openDownloadProgressModal(jobId, job.title);
    } catch (e) {
        localStorage.removeItem('activeDownloadJob');
    }
}

function toggleFolderMenu(event) {
    if (event) event.stopPropagation();

    const btn = event.currentTarget;
    const container = btn.closest('.menu-container');
    const dropdown = container ? container.querySelector('.dropdown-menu') : null;
    const row = btn.closest('.playlist-item');

    if (!dropdown) {
        console.warn('[MENU] Could not find dropdown menu from button');
        return;
    }

    const wasActive = dropdown.classList.contains('active');

    // Close all other dropdowns and reset row z-indices
    document.querySelectorAll('.dropdown-menu.active').forEach(d => d.classList.remove('active'));
    document.querySelectorAll('.playlist-item').forEach(r => r.style.zIndex = '');

    if (!wasActive) {
        dropdown.classList.add('active');
        if (row) {
            row.style.zIndex = '3000';
            console.log(`[MENU] Opened menu and lifted row to front`);
        }
    } else {
        console.log(`[MENU] Closed menu`);
    }
}

async function renameFolder(index, event) {
    if (event) event.stopPropagation();
    const item = currentBrowserItems[index];
    if (!item) return;

    const oldName = item.title;
    const newName = prompt(`Enter new name for "${oldName}":`, oldName);

    if (!newName || newName === oldName) return;

    console.log(`[RENAME] Attempting to rename "${oldName}" to "${newName}"`);

    // Close the dropdown immediately
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));

    try {
        let response = await fetch('/api/local/rename-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldId: item.id, newTitle: newName })
        });

        if (response.status === 409) {
            // Conflict - folder exists
            if (confirm(`A folder named "${newName}" already exists. Do you want to merge "${oldName}" into it?`)) {
                response = await fetch('/api/local/rename-folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ oldId: item.id, newTitle: newName, merge: true })
                });
            } else {
                return;
            }
        }

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Rename failed');
        }

        showToast(`Renamed to ${newName}`, 'success', 2000);

        // Refresh the browser view
        const lastFolder = browsePath[browsePath.length - 1];
        if (lastFolder) {
            await browse(selectedServerUdn, lastFolder.id);
        }
    } catch (err) {
        console.error('[RENAME] Error:', err);
        showToast(`Rename failed: ${err.message}`);
    }
}

let _mergeSourceItem = null;

async function openMergeIntoModal(index, event) {
    if (event) event.stopPropagation();
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));

    const item = currentBrowserItems[index];
    if (!item) return;
    _mergeSourceItem = item;

    const desc = document.getElementById('merge-into-desc');
    const input = document.getElementById('merge-into-input');
    const datalist = document.getElementById('merge-into-siblings');
    const modal = document.getElementById('merge-into-modal');

    desc.textContent = `Move all contents of "${item.title}" into:`;
    input.value = '';
    datalist.innerHTML = '';

    modal.style.display = 'flex';
    input.focus();

    try {
        const res = await fetch(`/api/local/sibling-folders?id=${encodeURIComponent(item.id)}`);
        if (res.ok) {
            const { siblings } = await res.json();
            datalist.innerHTML = siblings.map(s => `<option value="${s.replace(/"/g, '&quot;')}"></option>`).join('');
        }
    } catch (e) { /* non-fatal */ }
}

function closeMergeIntoModal() {
    document.getElementById('merge-into-modal').style.display = 'none';
    _mergeSourceItem = null;
}

async function executeMergeInto() {
    const input = document.getElementById('merge-into-input');
    const targetName = input.value.trim();
    if (!targetName || !_mergeSourceItem) return;

    const btn = document.getElementById('merge-into-confirm-btn');
    btn.disabled = true;
    btn.textContent = '...';

    try {
        const res = await fetch('/api/local/merge-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceId: _mergeSourceItem.id, targetName })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        const { moved } = await res.json();
        showToast(`Merged ${moved} item${moved !== 1 ? 's' : ''} into "${targetName}"`, 'success', 3000);
        closeMergeIntoModal();

        // Refresh current browser view
        const lastFolder = browsePath[browsePath.length - 1];
        if (lastFolder) await browse(selectedServerUdn, lastFolder.id);
    } catch (err) {
        showToast(`Merge failed: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Merge';
    }
}

async function syncFileTags(index, event) {
    if (event) event.stopPropagation();
    const item = currentBrowserItems[index];
    if (!item) return;

    const isContainer = item.isContainer === true || item.isContainer === 'true' || item.type === 'container';
    const typeLabel = isContainer ? 'folder' : 'file';
    console.log(`[TAGS] Requesting tag sync for ${typeLabel}: ${item.title} (${item.id})`);

    // Close the dropdown immediately
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));

    try {
        const response = await fetch('/api/local/update-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Tag sync failed');
        }

        const data = await response.json();
        if (isContainer) {
            showToast(`Synced tags for ${data.count || 0} files in "${item.title}"`, 'success', 3000);
        } else {
            showToast(`Synced tags: Artist="${data.artist}", Album="${data.album}"`, 'success', 3000);
        }
    } catch (err) {
        console.error('[TAGS] Error:', err);
        showToast(`Tag sync failed: ${err.message}`);
    }
}

let currentVATargetAlbum = null;

function closeVAModal() {
    const modal = document.getElementById('va-modal');
    if (modal) modal.style.display = 'none';
    currentVATargetAlbum = null;
    const sel = document.getElementById('va-album-name-select');
    if (sel) sel.innerHTML = '';
    const nameInput = document.getElementById('va-album-name-input');
    if (nameInput) { nameInput.value = ''; nameInput.style.display = 'none'; }
}

/** Returns the currently chosen artist name from select or custom input */
function getVAAlbumArtist() {
    const sel = document.getElementById('va-album-name-select');
    if (sel && sel.value === '__custom__') {
        return (document.getElementById('va-album-name-input')?.value || '').trim();
    }
    return sel ? sel.value.trim() : '';
}

/** Called when the select changes */
function onVAAlbumSelectChange() {
    const sel = document.getElementById('va-album-name-select');
    const nameInput = document.getElementById('va-album-name-input');
    if (!sel || !nameInput) return;
    if (sel.value === '__custom__') {
        nameInput.style.display = 'block';
        nameInput.focus();
    } else {
        nameInput.style.display = 'none';
    }
    updateVAMoveButton();
}

function updateVAMoveButton() {
    const btn = document.getElementById('btn-move-va');
    const checked = document.querySelectorAll('.va-track-checkbox:checked');
    const artistName = getVAAlbumArtist();
    if (btn) {
        btn.disabled = checked.length === 0 || !artistName;
        btn.textContent = `Move Selected (${checked.length})`;
    }
}

async function moveToVAAlbum(index, event) {
    if (event) event.stopPropagation();
    const item = currentBrowserItems[index];
    if (!item) return;
    const { id, title } = item;

    console.log(`Build Album clicked for folder: ${title} (${id})`);
    currentVATargetAlbum = title;

    // Pre-populate the album name input
    const nameInput = document.getElementById('va-album-name-input');
    if (nameInput) nameInput.value = title || 'Various Artists';

    // Close the dropdown immediately
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));

    const modal = document.getElementById('va-modal');
    const list = document.getElementById('va-tracks-list');

    if (list) list.innerHTML = '<div class="empty-state">Scanning local folders...</div>';
    if (modal) modal.style.display = 'flex';

    try {
        const response = await fetch(`/api/local/va-candidates?albumTitle=${encodeURIComponent(title)}`);
        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to fetch VA candidates');
        }

        const data = await response.json();
        const tracks = data.tracks || [];

        // Populate the select with unique artist folders + Various Artists + Custom option
        const artistFolders = [...new Set(tracks.map(t => t.artistFolder).filter(a => a && a !== 'Root'))];
        const suggestions = ['Various Artists', ...artistFolders.filter(a => a !== 'Various Artists')];
        const sel = document.getElementById('va-album-name-select');
        if (sel) {
            sel.innerHTML = suggestions.map(s =>
                `<option value="${s.replace(/"/g, '&quot;')}">${s}</option>`
            ).join('') + '<option value="__custom__">✏️ Enter custom name...</option>';
            // Pre-select the folder title if it matches an option, else pick Various Artists
            const matchingOption = suggestions.find(s => s.toLowerCase() === (title || '').toLowerCase());
            sel.value = matchingOption || 'Various Artists';
            onVAAlbumSelectChange();
        }

        if (tracks.length === 0) {
            list.innerHTML = `<div class="empty-state">No matching tracks found for "${title}"</div>`;
        } else {
            list.innerHTML = tracks.map((track, i) => {
                const escAttr = (s) => (s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                const checkboxId = `va-track-${i}`;
                return `
                <div class="browser-item file" style="padding-left: 0.5rem; cursor: pointer; margin-bottom: 0.2rem; border-radius: 0.4rem; background: rgba(255, 255, 255, 0.02);" onclick="const cb = document.getElementById('${checkboxId}'); cb.checked = !cb.checked; updateVAMoveButton();">
                    <input type="checkbox" id="${checkboxId}" class="va-track-checkbox" style="margin-right: 0.75rem;" value="${escAttr(track.folderId + '/' + track.title)}" checked onclick="event.stopPropagation(); updateVAMoveButton();">
                    <div class="item-info">
                        <div class="item-title">${escAttr(track.title)}</div>
                        <div class="item-artist" style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.2rem;">Folder: ${escAttr(track.artistFolder)}</div>
                    </div>
                </div>
                `;
            }).join('');
            updateVAMoveButton();
        }
    } catch (err) {
        if (list) list.innerHTML = `<div class="empty-state" style="color: var(--accent);">Error: ${err.message}</div>`;
        showToast(`Failed to load candidates: ${err.message}`);
    }
}

async function submitVAMove() {
    if (!currentVATargetAlbum) return;

    const checkedBoxes = Array.from(document.querySelectorAll('.va-track-checkbox:checked'));
    if (checkedBoxes.length === 0) return;

    const filePaths = checkedBoxes.map(cb => cb.value);

    try {
        const btn = document.getElementById('btn-move-va');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Moving...';
        }

        let targetBaseFolder = '';
        try {
            const stored = localStorage.getItem('serverHomeLocations_music');
            if (stored) {
                const homeLocs = JSON.parse(stored);
                if (homeLocs[LOCAL_SERVER_UDN] && Array.isArray(homeLocs[LOCAL_SERVER_UDN])) {
                    const homePath = homeLocs[LOCAL_SERVER_UDN];
                    if (homePath.length > 0) {
                        targetBaseFolder = homePath[homePath.length - 1].id;
                        if (targetBaseFolder === '0') targetBaseFolder = '';
                    }
                }
            }
        } catch (e) { }

        const response = await fetch('/api/local/move-va', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                albumTitle: currentVATargetAlbum,
                artistName: getVAAlbumArtist() || 'Various Artists',
                files: filePaths,
                targetBaseFolder: targetBaseFolder
            })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to move files');
        }

        const result = await response.json();
        showToast(`Successfully moved ${result.movedCount} files to VA folder.`, 'success', 3000);
        closeVAModal();

        // Navigate to the newly created folder
        if (result.targetFolderId) {
            const parts = result.targetFolderId.split('/');
            // Reset and build the new path for breadcrumbs
            browsePath = [{ id: '0', title: 'Root' }];
            let buildId = '';
            for (const part of parts) {
                if (!part) continue;
                buildId += (buildId ? '/' : '') + part;
                browsePath.push({ id: buildId, title: part });
            }
            saveLastPath();
            updateBreadcrumbs();
            await browse(selectedServerUdn, result.targetFolderId);
        } else {
            // Fallback refresh view
            if (browsePath.length > 0) {
                const lastFolder = browsePath[browsePath.length - 1];
                await browse(selectedServerUdn, lastFolder.id);
            }
        }

    } catch (err) {
        showToast(`Move error: ${err.message}`);
        const btn = document.getElementById('btn-move-va');
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Move Selected';
        }
    }
}

async function deleteTrack(index, event) {
    if (event) event.stopPropagation();

    const item = currentBrowserItems[index];
    if (!item) return;
    const { id, title } = item;

    console.log(`[DELETE] Requested deletion of: ${title} (index: ${index}, id: ${id})`);

    if (!confirm(`Are you sure you want to delete "${title}"?`)) {
        console.log(`[DELETE] User cancelled deletion of: ${title}`);
        return;
    }

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

        console.log(`[DELETE] Successfully deleted: ${title}`);
        showToast(`Deleted: ${title}`, 'success', 2000);

        // Refresh the browser view
        const lastFolder = browsePath[browsePath.length - 1];
        if (lastFolder) {
            await browse(selectedServerUdn, lastFolder.id);
        }
    } catch (err) {
        console.error('[DELETE] Error:', err);
        showToast(`Delete failed: ${err.message}`);
    } finally {
        // Close any open menus
        document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));
    }
}

async function playTrack(uri, title, artist, album, duration, protocolInfo, albumArtUrl, pathStr = '') {
    if (!selectedRendererUdn) {
        alert('Please select a Renderer on the left first!');
        return;
    }

    if (window._isProcessingPlayAction) return;
    window._isProcessingPlayAction = true;

    try {
        await clearPlaylist();
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/insert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri, title, artist, album, duration, protocolInfo, albumArtUrl, pathStr })
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
            await playPlaylistItem(newId, false, true);
        }

        if (window.innerWidth <= 800) {
            switchView('playlist');
        }
    } catch (err) {
        console.error('Play track from browser error:', err);
        showToast(`Error: ${err.message}`);
    } finally {
        window._isProcessingPlayAction = false;
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
    const containers = currentBrowserItems.filter(item => item.type === 'container');

    // If we are in photo mode and have no images but have containers, do a recursive slideshow
    if (currentBrowserMode === 'photo' && images.length === 0 && containers.length > 0) {
        const currentFolder = browsePath[browsePath.length - 1];
        if (currentFolder && currentFolder.id !== '0') {
            playFolderSlideshow(currentFolder.id, currentFolder.title);
            return;
        }
    }

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

    if (window._isProcessingPlayAction) return;
    window._isProcessingPlayAction = true;

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
                    protocolInfo: track.protocolInfo,
                    albumArtUrl: track.albumArtUrl
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
            await playPlaylistItem(firstTrackId, false, true);
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
        window._isProcessingPlayAction = false;
    }
}

function playAllPhotos(images) {
    if (slideshow) slideshow.start(images, -1);
}

async function transportAction(action) {
    if (!selectedRendererUdn) return;
    if (isRendererOffline) return; // Silently ignore when offline

    // Optimistic UI Update
    lastTransportActionTime = Date.now();
    const oldState = currentTransportState;
    if (action === 'play') currentTransportState = 'Playing';
    else if (action === 'pause') currentTransportState = 'Paused';
    else if (action === 'stop') currentTransportState = 'Stopped';

    // Stopping manually disarms stop-after-track
    if (action === 'stop') {
        stopAfterTrack = false;
        updateStopAfterTrackButton();
    }

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

function toggleStopAfterTrack() {
    if (isRendererOffline) return;
    stopAfterTrack = !stopAfterTrack;
    updateStopAfterTrackButton();
}

function updateStopAfterTrackButton() {
    const label = stopAfterTrack ? 'Stop after track: ON — click to cancel' : 'Stop after current track';
    ['btn-stop-after', 'btn-ss-stop-after'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.title = label;
        if (stopAfterTrack) {
            btn.classList.add('armed');
        } else {
            btn.classList.remove('armed');
        }
    });
}

async function playPlaylistItem(id, forceRestart = false, skipLock = false) {
    if (!selectedRendererUdn) return;
    if (isRendererOffline) return; // Silently ignore when offline

    // If clicking the current track:
    if (currentTrackId != null && id != null && currentTrackId == id) {
        if (currentTransportState === 'Paused') {
            await transportAction('play');
            return;
        } else if (currentTransportState === 'Playing' && !forceRestart) {
            // Already playing this track, skip redundant play command to avoid "double start" glitch
            return;
        }
    }

    // Lock to prevent multiple simultaneous play actions
    if (!skipLock) {
        if (window._isProcessingPlayAction) return;
        window._isProcessingPlayAction = true;
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
    } finally {
        if (!skipLock) {
            window._isProcessingPlayAction = false;
        }
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

let currentBrowserFindText = '';
let currentBrowserRecursiveItems = null;
let currentBrowserRecursiveFolderId = null;

function toggleBrowserFind() {
    const input = document.getElementById('input-browser-find');
    if (input.style.display === 'none' || input.style.display === '') {
        input.style.display = 'inline-block';
        input.focus();
    } else {
        input.style.display = 'none';
        input.value = '';
        executeBrowserFind();
    }
}

async function executeBrowserFind() {
    const input = document.getElementById('input-browser-find');
    currentBrowserFindText = (input.value || '').toLowerCase();
    const currentFolderId = browsePath.length > 0 ? browsePath[browsePath.length - 1].id : '0';

    if (!currentBrowserFindText || input.style.display === 'none') {
        currentBrowserRecursiveItems = null;
        currentBrowserRecursiveFolderId = null;
        await browse(selectedServerUdn, currentFolderId);
        return;
    }

    if (currentBrowserRecursiveFolderId !== currentFolderId || !currentBrowserRecursiveItems) {
        browserItems.innerHTML = '<div class="loading">Searching recursively... This may take a moment.</div>';
        try {
            const res = await fetch(`/api/browse-recursive/${encodeURIComponent(selectedServerUdn)}?objectId=${encodeURIComponent(currentFolderId)}`);
            if (res.ok) {
                const data = await res.json();
                currentBrowserRecursiveItems = data.items || [];
                currentBrowserRecursiveFolderId = currentFolderId;
            } else {
                throw new Error('Failed to fetch recursive items');
            }
        } catch (e) {
            console.error('Recursive search error:', e);
            browserItems.innerHTML = `<div class="error">Search failed: ${e.message}</div>`;
            return;
        }
    }

    const filtered = currentBrowserRecursiveItems.filter(item => {
        const title = (item.title || '').toLowerCase();
        return title.includes(currentBrowserFindText);
    });

    renderBrowser(filtered);

    if (filtered.length === 0) {
        browserItems.innerHTML = '<div class="empty-state">No matches found in this folder or subfolders</div>';
    }
}

function updateBrowserControls(items) {
    const tracks = items.filter(item => item.type === 'item' && !isImageItem(item));
    const images = items.filter(item => isImageItem(item));

    const btnPlayAll = document.getElementById('btn-play-all');
    const btnAddAll = document.getElementById('btn-add-all');
    const btnToggleView = document.getElementById('btn-toggle-view');

    const showMusicControls = tracks.length > 0;
    const hasContainers = items.some(item => item.type === 'container');
    const showPhotoControls = images.length > 0 || (currentBrowserMode === 'photo' && hasContainers);

    const inPhotoMode = currentBrowserMode === 'photo';

    if (btnPlayAll) {
        const canPlay = inPhotoMode ? showPhotoControls : showMusicControls;
        btnPlayAll.classList.toggle('disabled', !canPlay);
        const label = btnPlayAll.querySelector('.btn-label');
        if (label) {
            label.textContent = inPhotoMode ? 'Slideshow' : 'Play All';
            label.setAttribute('data-mobile', inPhotoMode ? 'SS' : 'All');
        }
    }
    if (btnAddAll) {
        btnAddAll.style.display = inPhotoMode ? 'none' : '';
        if (!inPhotoMode) btnAddAll.classList.toggle('disabled', !showMusicControls);
    }

    if (btnToggleView) {
        btnToggleView.style.display = inPhotoMode ? '' : 'none';
        if (inPhotoMode) {
            btnToggleView.classList.toggle('disabled', !showPhotoControls);
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
    }

    // Filter Set Home buttons based on current mode
    const btnSetMusic = document.getElementById('btn-set-music-home');
    const btnSetPhoto = document.getElementById('btn-set-photo-home');
    const divSetMusic = null;
    const divSetPhoto = null;

    if (btnSetMusic) btnSetMusic.style.display = (currentBrowserMode === 'music') ? 'flex' : 'none';
    if (btnSetPhoto) btnSetPhoto.style.display = (currentBrowserMode === 'photo') ? 'flex' : 'none';

    // Filter Screensaver button (only for photos)
    const btnSetSS = document.getElementById('btn-set-screensaver');
    const divSetSS = null;

    if (btnSetSS) btnSetSS.style.display = (currentBrowserMode === 'photo') ? 'flex' : 'none';

    const showDeleteSelected = inPhotoMode && browserViewMode === 'grid';
    ['btn-delete-selected', 'btn-setdate-selected'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.style.display = showDeleteSelected ? '' : 'none';
    });
    if (showDeleteSelected) updatePhotoSelectionUI();

    const btnPlayTag = document.getElementById('btn-play-tag');
    if (btnPlayTag) btnPlayTag.style.display = inPhotoMode ? 'none' : '';

    // Show/hide the entire menu button if no actions available
    const menuBtn = document.getElementById('btn-browser-menu');
    if (menuBtn) {
        const hasActions = (currentBrowserMode === 'music' || currentBrowserMode === 'photo');
        menuBtn.style.display = hasActions ? 'flex' : 'none';
    }

    // Hide empty control groups to avoid "empty box" look
    const controlGroup = document.querySelector('.browser-control-group');
    if (controlGroup) {
        const visibleButtons = Array.from(controlGroup.children).filter(child =>
            child.tagName === 'BUTTON' && child.style.display !== 'none'
        );
        controlGroup.style.display = visibleButtons.length > 0 ? 'flex' : 'none';
    }

    const headerControls = document.querySelector('.header-controls');
    if (headerControls) {
        const anyVisible = Array.from(headerControls.children).some(child =>
            child.style.display !== 'none' && (child.offsetHeight > 0 || child.tagName === 'DIV' && Array.from(child.children).some(c => c.style.display !== 'none'))
        );
        headerControls.style.display = anyVisible ? 'flex' : 'none';
    }
}

function renderBrowser(items) {
    selectedPhotos.clear();
    updatePhotoSelectionUI();

    // Sort items: folders first, then alphabetically ignoring case
    items.sort((a, b) => {
        const isFolderA = a.type === 'container';
        const isFolderB = b.type === 'container';
        if (isFolderA && !isFolderB) return -1;
        if (!isFolderA && isFolderB) return 1;

        // Audio tracks: match the disc/track-number order they get queued in (see addAllToPlaylist/playAll)
        if (!isFolderA && !isFolderB && !isImageItem(a) && !isImageItem(b)) {
            if (a.discNumber !== b.discNumber) return (a.discNumber || 1) - (b.discNumber || 1);
            if (a.trackNumber !== b.trackNumber) return (a.trackNumber || 0) - (b.trackNumber || 0);
        }

        const titleA = String(a.title || '');
        const titleB = String(b.title || '');

        // Primary sort: case-insensitive, numeric-aware
        const result = titleA.localeCompare(titleB, undefined, { numeric: true, sensitivity: 'base' });

        // Tie-breaker: case-sensitive sort to ensure stable formatting if identical but different casing
        if (result === 0) {
            return titleA.localeCompare(titleB, undefined, { numeric: true });
        }
        return result;
    });

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

        if (effectiveViewMode === 'list' && !currentBrowserFindText) {
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

    const pathStr = browsePath.map(p => p.title).filter(t => t !== 'Root').join(' / ');

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
            (item.protocolInfo && item.protocolInfo.includes('image/')) ||
            (item.type === 'item' && ['jpg', 'jpeg', 'png', 'webp'].some(ext => (item.uri || '').toLowerCase().endsWith(ext)));

        const isVideo = (item.class && item.class.includes('videoItem')) ||
            (item.protocolInfo && item.protocolInfo.includes('video/'));

        let icon = '';
        const thumbUrl = item.albumArtUrl || (isImage ? item.uri : null);
        if (thumbUrl) {
            const escThumb = (thumbUrl || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const rot = isImage ? (manualRotations[item.uri] || 0) : 0;
            const rotStyle = rot ? ` style="transform: rotate(${rot}deg)"` : '';
            icon = `<img src="${escThumb}" loading="lazy" alt="" data-thumb-url="${escThumb}"${rotStyle}>`;
        }


        if (!icon) {
            icon = isContainer ? `
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
            ` : isImage ? `
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <path d="M21 15l-5-5L5 21"></path>
                </svg>
            ` : isVideo ? `
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                    <path d="M8 21h8"></path>
                    <path d="M12 17v4"></path>
                    <path d="M10 8l5 3-5 3V8z"></path>
                </svg>
            ` : `
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M10 8l6 4-6 4V8z"></path>
                </svg>
            `;
        }

        const escJs = (s) => (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const isLocalServer = selectedServerUdn === LOCAL_SERVER_UDN;

        return `
            <div ${letterIdAttr} class="playlist-item browser-item ${isContainer ? 'folder' : 'file'}${isImage && currentBrowserMode === 'photo' && selectedPhotos.has(item.uri) ? ' photo-selected' : ''}" data-item-index="${index}"
                 onclick="${isContainer ?
                `enterFolder('${escJs(item.id)}', '${escJs(item.title)}')` :
                isImage ?
                    `event.stopPropagation(); startPhotoSlideshow('${escJs(item.uri)}', '${escJs(item.title)}', '${escJs(item.date)}', '${escJs(item.artist)}', '${escJs(item.parentID)}', '${escJs(pathStr)}')` :
                    isVideo ?
                        `handleVideoClick('${escJs(item.uri)}', '${escJs(item.title)}', '${escJs(item.artist)}', '${escJs(item.album)}', '${escJs(item.duration)}', '${escJs(item.protocolInfo)}', ${index})` :
                        `playTrack('${escJs(item.uri)}', '${escJs(item.title)}', '${escJs(item.artist)}', '${escJs(item.album)}', '${escJs(item.duration)}', '${escJs(item.protocolInfo)}', '${escJs(item.albumArtUrl)}', '${escJs(pathStr)}')`}">
                <div class="item-icon">${icon}</div>
                <div class="item-info">
                    <div class="item-title">${item.title}</div>
                </div>
                <div class="item-actions">
                    ${!isContainer ? `
                    <button class="btn-control ghost info-btn${detectFolderMismatch(item) ? ' info-btn-conflict' : ''}" onclick="event.stopPropagation(); showFileInfoFromBrowser(${index})" title="View file information">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"></circle>
                            <path d="M12 16v-4"></path>
                            <path d="M12 8h.01"></path>
                        </svg>
                    </button>
                    ${isImage && currentBrowserMode === 'photo' ? `
                    <button class="btn-control ghost" onclick="event.stopPropagation(); rotatePhotoFromBrowser(${index})" title="Rotate 90°">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 2v6h-6"></path>
                            <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
                            <path d="M3 22v-6h6"></path>
                            <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
                        </svg>
                    </button>
                    <button class="btn-control ghost photo-select-btn${selectedPhotos.has(item.uri) ? ' active' : ''}" onclick="event.stopPropagation(); togglePhotoSelection('${escJs(item.uri)}', ${index})" title="${selectedPhotos.has(item.uri) ? 'Deselect photo' : 'Select photo'}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="${selectedPhotos.has(item.uri) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.5">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    </button>
                    ` : `
                    <button class="btn-control queue-btn" onclick="event.stopPropagation(); addToPlaylist('${escJs(item.uri)}', '${escJs(item.title)}', '${escJs(item.artist)}', '${escJs(item.album)}', '${escJs(item.duration)}', '${escJs(item.protocolInfo)}', '${escJs(item.albumArtUrl)}', false, '${escJs(pathStr)}')" title="Add to queue">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 5v14M5 12h14"></path>
                        </svg>
                        <span class="btn-label" data-mobile="">Queue</span>
                    </button>
                    `}
                    ` : `
                    <button class="btn-control play-btn" onclick="event.stopPropagation(); ${currentBrowserMode === 'photo' ? `playFolderSlideshow('${escJs(item.id)}', '${escJs(item.title)}')` : `playFolder('${escJs(item.id)}', '${escJs(item.title)}', '${escJs(pathStr)}')`}" title="${currentBrowserMode === 'photo' ? 'Start slideshow of this folder' : 'Play Whole Folder Recursively'}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="${currentBrowserMode === 'photo' ? 'none' : 'currentColor'}" stroke="currentColor" stroke-width="2">
                            ${currentBrowserMode === 'photo' ?
                '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>' :
                '<path d="M8 5v14l11-7z"></path>'}
                        </svg>
                        <span class="btn-label" data-mobile="">${currentBrowserMode === 'photo' ? 'Slideshow' : 'Play'}</span>
                    </button>
                    <button class="btn-control queue-btn" onclick="event.stopPropagation(); queueFolder('${escJs(item.id)}', '${escJs(item.title)}', '${escJs(pathStr)}')" title="Queue Whole Folder Recursively">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 5v14M5 12h14"></path>
                        </svg>
                        <span class="btn-label" data-mobile="">Queue</span>
                    </button>
                    `}
                    <div class="menu-container folder-menu" onclick="event.stopPropagation();" style="margin-left: 0.25rem;">
                        <button class="btn-control ghost burger-btn" onclick="toggleFolderMenu(event)" title="More actions">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="3" y1="12" x2="21" y2="12"></line>
                                <line x1="3" y1="6" x2="21" y2="6"></line>
                                <line x1="3" y1="18" x2="21" y2="18"></line>
                            </svg>
                        </button>
                        <div class="dropdown-menu" style="top: 100%; right: 0; min-width: 12rem;">
                            ${isLocalServer ? `
                                ${isContainer && currentBrowserMode === 'photo' ? `
                                <button class="dropdown-item" onclick="moveFolderPicturesToDateFolder(${index}, event)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                        <line x1="16" y1="2" x2="16" y2="6"></line>
                                        <line x1="8" y1="2" x2="8" y2="6"></line>
                                        <line x1="3" y1="10" x2="21" y2="10"></line>
                                        <path d="M8 14h.01M12 14h.01M16 14h.01"/>
                                    </svg>
                                    Place in Date Folders
                                </button>
                                ` : ''}
                                ${isContainer ? `
                                <button class="dropdown-item" onclick="moveToVAAlbum(${index}, event)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                                        <polyline points="9 14 12 17 15 14"></polyline>
                                        <line x1="12" y1="9" x2="12" y2="17"></line>
                                    </svg>
                                    Build Album
                                </button>
                                <button class="dropdown-item" onclick="renameFolder(${index}, event)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                                    </svg>
                                    Rename
                                </button>
                                <button class="dropdown-item" onclick="openMergeIntoModal(${index}, event)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"></path>
                                        <polyline points="15 3 21 3 21 9"></polyline>
                                        <line x1="10" y1="14" x2="21" y2="3"></line>
                                    </svg>
                                    Merge Into
                                </button>
                                ${currentBrowserMode === 'music' ? `
                                <button class="dropdown-item" style="color: #10b981;" onclick="moveFolderToTagsLocation(${index}, event)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M5 12h14M12 5l7 7-7 7"/>
                                    </svg>
                                    Reimport (Move to Tag Locations)
                                </button>
                                <button class="dropdown-item" onclick="identifyTracksFromFilename(${index}, event)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <circle cx="11" cy="11" r="8"></circle>
                                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                    </svg>
                                    Identify Tags from Filename
                                </button>
                                ` : ''}
                                ` : ''}
                                <button class="dropdown-item" onclick="syncFileTags(${index}, event)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                                        <line x1="12" y1="5" x2="12" y2="19"></line>
                                    </svg>
                                    Sync File Tags
                                </button>
                                ${!isContainer && detectFolderMismatch(item) ? `
                                <button class="dropdown-item" style="color: #10b981;" onclick="moveFileToTagsLocationFromBrowser(${index}, event)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M5 12h14M12 5l7 7-7 7"/>
                                    </svg>
                                    Move to Tag Location
                                </button>
                                ` : ''}
                                ${!isContainer && isImage ? `
                                <button class="dropdown-item" onclick="movePictureToDateFolder(${index}, event)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                        <line x1="16" y1="2" x2="16" y2="6"></line>
                                        <line x1="8" y1="2" x2="8" y2="6"></line>
                                        <line x1="3" y1="10" x2="21" y2="10"></line>
                                        <path d="M8 14h.01M12 14h.01M16 14h.01"/>
                                    </svg>
                                    Place in Date Folder
                                </button>
                                ` : ''}
                                <button class="dropdown-item" style="color: var(--accent);" onclick="deleteTrack(${index}, event)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"></path>
                                    </svg>
                                    Delete
                                </button>
                            ` : ''}
                            <button class="dropdown-item" onclick="event.stopPropagation(); ${isContainer ? `downloadFolder('${selectedServerUdn}', '${escJs(item.id)}', '${escJs(item.title)}', '${escJs(item.artist)}', '${escJs(item.album)}', '${escJs(item.albumArtist)}')` : `downloadTrack('${escJs(item.uri)}', '${escJs(item.title)}', '${escJs(item.artist)}', '${escJs(item.album)}', '${escJs(item.albumArtist)}')`}" title="Download to local media library">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                    <polyline points="7 10 12 15 17 10"></polyline>
                                    <line x1="12" y1="15" x2="12" y2="3"></line>
                                </svg>
                                Download
                            </button>
                        </div>
                    </div>
                </div>
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

    // Re-apply find filter if input has text
    const findInput = document.getElementById('input-browser-find');
    if (findInput && findInput.value) {
        const currentFolderId = browsePath.length > 0 ? browsePath[browsePath.length - 1].id : '0';
        if (currentBrowserRecursiveFolderId !== currentFolderId) {
            setTimeout(executeBrowserFind, 10);
        }
    }
}

async function fetchPlaylist(udn) {
    if (isRendererOffline) return; // Silently ignore when offline
    try {
        // Fetch playlist and status in parallel
        const [playlistRes, statusRes] = await Promise.all([
            fetch(`/api/playlist/${encodeURIComponent(udn)}`),
            fetch(`/api/playlist/${encodeURIComponent(udn)}/status`)
        ]);

        if (!playlistRes.ok) throw new Error('Failed to fetch playlist');
        const playlist = await playlistRes.json();
        currentPlaylistItems = playlist;

        if (statusRes.ok) {
            const status = await statusRes.json();
            updateStatus(status);
        }

        sessionStorage.setItem('lastPlaylist', JSON.stringify(playlist));
        renderPlaylist(playlist);
        rendererFailureCount = 0;
    } catch (err) {
        console.error(`Playlist fetch error for ${udn}:`, err);
        setRendererOffline(true, 'fetchPlaylist');
    }
}

async function fetchStatus(includePlaylist = false) {
    if (!selectedRendererUdn || isRendererOffline) return;
    try {
        const url = `/api/playlist/${encodeURIComponent(selectedRendererUdn)}/status${includePlaylist ? '?includePlaylist=true' : ''}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch status');
        const status = await response.json();

        if (includePlaylist && status.playlist) {
            currentPlaylistItems = status.playlist;
            sessionStorage.setItem('lastPlaylist', JSON.stringify(status.playlist));
            renderPlaylist(currentPlaylistItems);
        }

        updateStatus(status);
        rendererFailureCount = 0;
    } catch (err) {
        console.error(`Status fetch error for ${selectedRendererUdn}:`, err);
        if (selectedRendererUdn !== BROWSER_PLAYER_UDN) {
            rendererFailureCount++;
            if (rendererFailureCount >= 3) {
                setRendererOffline(true, 'fetchStatus');
            }
        }
    }
}

function updateStatus(status) {
    const now = Date.now();
    const isLocked = (now - lastTransportActionTime) < 3000; // 3 second lockout

    const trackChanged = (status.trackId != null && currentTrackId != null) ?
        String(status.trackId) !== String(currentTrackId) :
        status.trackId !== currentTrackId;
    const transportChanged = status.transportState !== currentTransportState;

    // Stop After Track: if a track change is detected while armed, stop immediately
    if (stopAfterTrack && trackChanged && status.trackId != null && currentTrackId != null) {
        stopAfterTrack = false;
        updateStopAfterTrackButton();
        transportAction('stop');
        return;
    }

    if (!isLocked && (trackChanged || transportChanged)) {
        currentTrackId = status.trackId;
        currentTransportState = status.transportState;
        renderPlaylist(currentPlaylistItems);

        // Update screensaver if in Music mode
        if (slideshow && slideshow.isActive && slideshow.mode === 'nowPlaying') {
            slideshow.next();
        }

        // Refresh now-playing label in slideshow (all modes)
        if (slideshow && slideshow.isActive) {
            slideshow.refreshNowPlayingLabel();
        }

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
                            album: currentTrack.album,
                            serverUdn: selectedServerUdn,
                            playerUdn: selectedRendererUdn
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

    /* 
    // Suppressed technical error messages per user request
    if (status.error) {
        console.warn(`[DEBUG] Suppressed Renderer Error Toast: ${status.error}`);
    }
    */

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

    // Update Now Playing labels and fetch artwork
    if (currentTrackId != null) {
        const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);
        if (currentTrack) {
            updateCardNowPlaying();
            // Fetch artwork if track changed or query differs
            const query = `${currentTrack.artist || ''} ${currentTrack.album || ''}`.trim();
            const safeUdn = selectedRendererUdn ? selectedRendererUdn.replace(/:/g, '-') : '';
            const artContainer = safeUdn ? document.getElementById(`player-art-container-${safeUdn}`) : null;
            const isArtVisible = artContainer && artContainer.classList.contains('visible');

            // Only fetch if (query changed and hasn't failed before) OR we have a direct url
            if ((query && query !== currentArtworkQuery && !failedArtworkQueries.has(query)) || (currentTrack.albumArtUrl && currentTrack.albumArtUrl !== currentArtworkUrl)) {
                updatePlayerArtwork(currentTrack.artist, currentTrack.album, currentTrack.uri, currentTrack.albumArtUrl);
            }

            fetchLyricsForTrack(currentTrack);
        } else {
            updateCardNowPlaying();
        }
    } else {
        updateCardNowPlaying();
        currentArtworkQuery = '';
        currentArtworkUrl = '';
        hideAllPlayerArt();
        clearLyrics();
    }

    updatePositionUI();
    syncLocalPlayback(status);

    // Update volume UI from status poll to save requests
    if (status.volume !== undefined && status.volume !== null) {
        const slider = document.getElementById('volume-slider');
        const ssSlider = document.getElementById('ss-volume-slider');
        const valueSpan = document.getElementById('volume-value');
        if (slider && document.activeElement !== slider) slider.value = status.volume;
        if (ssSlider && document.activeElement !== ssSlider) ssSlider.value = status.volume;
        if (valueSpan) valueSpan.textContent = `${status.volume}%`;
    }
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
        // If the URI has a loopback host (server couldn't detect its LAN IP), rewrite it
        // to the current page's host so the browser can always reach it.
        const resolvedUri = (() => {
            try {
                const u = new URL(currentTrack.uri);
                if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1') {
                    u.host = window.location.host;
                    return u.toString();
                }
            } catch (e) {}
            return currentTrack.uri;
        })();
        video.src = resolvedUri;
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

async function updatePlayerArtwork(artist, album, uri, albumArtUrl) {
    if (!artist && !album && !albumArtUrl && !uri) return;
    const query = `${artist || ''} ${album || ''}`.trim();
    currentArtworkQuery = query;

    // Reset tried-URLs list when the track changes
    if (query !== triedArtworkQueryKey) {
        triedArtworkUrls = [];
        triedArtworkQueryKey = query;
    }

    // If the user manually chose artwork for this track, always use it
    const override = uri && artworkOverrides.get(uri);
    if (override) {
        if (override !== currentArtworkUrl) {
            currentArtworkUrl = override;
            showPlayerArt(override);
            if (slideshow && slideshow.isActive && slideshow.mode === 'nowPlaying') slideshow.next();
        }
        return;
    }

    // Try Discogs / DB cache first (higher quality than DLNA thumbnails)
    if (artist || album || uri) {
        try {
            const res = await fetch(`/api/art/search?artist=${encodeURIComponent(artist || '')}&album=${encodeURIComponent(album || '')}&uri=${encodeURIComponent(uri || '')}`);
            if (res.ok) {
                const data = await res.json();
                currentArtworkUrl = data.url;
                if (!triedArtworkUrls.includes(data.url)) triedArtworkUrls.push(data.url);
                showPlayerArt(data.url);
                if (slideshow && slideshow.isActive && slideshow.mode === 'nowPlaying') slideshow.next();
                return;
            }
        } catch (e) {
            console.warn('[ART] Discogs search failed, trying DLNA art fallback:', e);
        }
    }

    // Fall back to DLNA-provided art if Discogs had nothing
    if (albumArtUrl) {
        currentArtworkUrl = albumArtUrl;
        if (!triedArtworkUrls.includes(albumArtUrl)) triedArtworkUrls.push(albumArtUrl);
        showPlayerArt(albumArtUrl);
        if (slideshow && slideshow.isActive && slideshow.mode === 'nowPlaying') slideshow.next();
        return;
    }

    // Nothing worked
    console.warn('[ART] No artwork found, will not retry this query');
    failedArtworkQueries.add(query);
    currentArtworkUrl = '/no-artwork.svg';
    showPlayerArt('/no-artwork.svg');
}

async function loadDiscogsToken() {
    try {
        const res = await fetch('/api/settings/discogs');
        if (res.ok) {
            const data = await res.json();
            const tokenInput = document.getElementById('discogs-token-input');
            if (tokenInput) {
                tokenInput.value = data.maskedToken || '';
                tokenInput.dataset.loaded = '1';
            }
        }
    } catch (e) {
        console.warn('Failed to load Discogs token status:', e);
    }
}

async function saveDiscogsToken() {
    const tokenInput = document.getElementById('discogs-token-input');
    if (!tokenInput) return;
    const token = tokenInput.value.trim();
    // If the value is the masked placeholder loaded from the server, nothing changed
    if (token.includes('****')) return;

    try {
        const response = await fetch('/api/settings/discogs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });

        if (response.ok) {
            showToast(token ? 'Discogs token saved' : 'Discogs token removed', 'success', 2000);
            // Reload masked value so field reflects current state
            await loadDiscogsToken();
        } else {
            throw new Error('Failed to save token');
        }
    } catch (err) {
        console.error('Save settings error:', err);
        showToast('Failed to save settings to server');
    }
}

function showPlayerArt(url) {
    if (!selectedRendererUdn) return;
    const safeUdn = selectedRendererUdn.replace(/:/g, '-');
    const containers = [
        document.getElementById(`player-art-container-${safeUdn}`)
    ];
    const imgs = [
        document.getElementById(`player-art-${safeUdn}`)
    ];

    console.log(`[ART] Loading artwork: ${url}`);
    let legacyHandled = false;

    const onLoaded = (container) => {
        legacyHandled = true;
        if (container) container.classList.add('visible');
        updateCardNowPlaying();
    };

    imgs.forEach((img, idx) => {
        if (!img) return;
        img.onload = () => onLoaded(containers[idx]);
        img.onerror = () => {
            console.error(`[ART] Failed to load image element ${idx}: ${url}`);
            if (url !== '/no-artwork.svg') {
                img.onload = () => onLoaded(containers[idx]);
                img.onerror = () => { if (containers[idx]) containers[idx].classList.remove('visible'); };
                img.src = '/no-artwork.svg';
            } else {
                if (containers[idx]) containers[idx].classList.remove('visible');
            }
        };
        img.src = url;
    });

    // Directly sync the card UI
    updateCardNowPlaying();
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
    currentArtworkUrl = '';
    updateCardNowPlaying();
}

// Custom artwork modal removed in favor of Screensaver Music Mode

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

// updateModalTrackInfo removed


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

            // If stopAfterTrack is armed, aggressively poll the device status near the end
            // of the track. This lets the hardware naturally finish the current track,
            // and allows us to catch the transition and stop it within 500ms.
            if (stopAfterTrack && durationSeconds > 0 && (durationSeconds - currentPos <= 10)) {
                if (!window.lastAggressivePoll || Date.now() - window.lastAggressivePoll > 500) {
                    window.lastAggressivePoll = Date.now();
                    fetchStatus();
                }
            }

            if (durationSeconds > 0 && currentPos > durationSeconds) {
                currentPos = durationSeconds;
            }

            currentPositionSeconds = currentPos;
        } else {
            currentPositionSeconds = lastStatusPositionSeconds;
        }
        updatePositionUI();
        updateLyricsHighlight(currentPositionSeconds);
    }
}, 250);

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
                    <button class="btn-control ghost info-btn${detectFolderMismatch(item) ? ' info-btn-conflict' : ''}" onclick="event.stopPropagation(); showFileInfoFromPlaylist('${esc(item.id)}')" title="View file information">
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
    // On mobile, only scroll if the player column is currently active
    if (window.innerWidth <= 800) {
        const playerCol = document.querySelector('.player-column');
        if (!playerCol || !playerCol.classList.contains('active')) return;
    }

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
    const defaultTitle = `${currentDeviceName}`;

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

    // When renderer is offline, disable all transport AND volume controls
    if (isRendererOffline) {
        btnPlay.classList.add('disabled');
        btnPause.classList.add('disabled');
        btnStop.classList.add('disabled');
        btnClear.classList.add('disabled');

        const volumeSlider = document.getElementById('volume-slider');
        if (volumeSlider) volumeSlider.disabled = true;
        document.querySelectorAll('.btn-volume-step').forEach(b => b.disabled = true);
        const eqBtn = document.getElementById('id-sonos-eq');
        if (eqBtn) eqBtn.disabled = true;

        const ssMusicBar = document.getElementById('ss-music-bar');
        if (ssMusicBar) ssMusicBar.style.display = 'none';
        return;
    }

    // Re-enable volume controls (in case recovering from offline)
    const volumeSlider = document.getElementById('volume-slider');
    if (volumeSlider) volumeSlider.disabled = false;
    document.querySelectorAll('.btn-volume-step').forEach(b => b.disabled = false);

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

    // Update Screensaver Play/Pause Button
    const ssPlayPauseBar = document.getElementById('btn-ss-playpause-bar');
    const ssSvgPlayBar = document.getElementById('svg-ss-play-bar');
    const ssSvgPauseBar = document.getElementById('svg-ss-pause-bar');
    const ssMusicBar = document.getElementById('ss-music-bar');

    if (ssMusicBar) {
        if (!selectedRendererUdn || isPlaylistEmpty) {
            ssMusicBar.style.display = 'none';
        } else {
            ssMusicBar.style.display = 'flex';
            if (isPlaying) {
                if (ssSvgPlayBar) ssSvgPlayBar.style.display = 'none';
                if (ssSvgPauseBar) ssSvgPauseBar.style.display = 'block';
            } else {
                if (ssSvgPlayBar) ssSvgPlayBar.style.display = 'block';
                if (ssSvgPauseBar) ssSvgPauseBar.style.display = 'none';
            }
        }
    }

    // Sync stop-after-track armed state on the freshly rendered button
    updateStopAfterTrackButton();
}



async function startAirPlayScan() {
    if (isAirPlayScanRunning) return;
    isAirPlayScanRunning = true;

    const indicator = document.getElementById('airplay-status-indicator');
    if (indicator) indicator.classList.add('active');

    try {
        console.log('[AirPlay] Starting automatic discovery...');
        await fetch('/api/airplay/discover', { method: 'POST' });

        // Initial fetch
        await fetchDevices();
        renderManageDevices();

        // Continuous refresh while tab is open
        if (airplayScanInterval) clearInterval(airplayScanInterval);
        airplayScanInterval = setInterval(async () => {
            if (!isAirPlayScanRunning) {
                clearInterval(airplayScanInterval);
                return;
            }
            await fetchDevices();
            renderManageDevices();
        }, 3000); // Efficient polling while viewing
    } catch (err) {
        console.error('Failed to start AirPlay scan:', err);
    }
}

async function stopAirPlayScan() {
    isAirPlayScanRunning = false;
    if (airplayScanInterval) {
        clearInterval(airplayScanInterval);
        airplayScanInterval = null;
    }

    const indicator = document.getElementById('airplay-status-indicator');
    if (indicator) indicator.classList.remove('active');

    try {
        console.log('[AirPlay] Stopping automatic discovery...');
        await fetch('/api/airplay/stop-discovery', { method: 'POST' });
    } catch (err) {
        console.error('Failed to stop AirPlay scan:', err);
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

function handleServerClick() {
    console.log('[DEBUG] Server card clicked');
    if (window.innerWidth <= 1100) {
        switchView('browser');
    }
    openServerModal();
}

function handleRendererClick() {
    console.log('[DEBUG] Renderer card clicked');
    if (window.innerWidth <= 1100) {
        switchView('playlist');
    }
    openRendererModal();
}

function closeRendererModal() {
    rendererModal.style.display = 'none';
}

function openManageModal() {
    if (manageModal) {
        renderManageDevices();
        manageModal.style.display = 'flex';
        loadDiscogsToken();
        const s3Enabled = document.getElementById('s3-enabled')?.checked;
        if (s3Enabled) startS3StatusPolling();
        loadLocalStats();
    }
}

function closeManageModal() {
    if (manageModal) {
        manageModal.style.display = 'none';
        stopS3StatusPolling();
        stopAirPlayScan(); // Ensure scan stops when modal closes
    }
}

const playTagModal = document.getElementById('play-tag-modal');
const tagSelectionList = document.getElementById('tag-selection-list');

async function openPlayTagModal() {
    if (!playTagModal) return;
    tagSelectionList.innerHTML = '<div class="loading">Loading tags...</div>';
    playTagModal.style.display = 'flex';

    try {
        const response = await fetch('/api/tags');
        if (!response.ok) throw new Error('Failed to load tags');
        const data = await response.json();

        if (!data.tags || data.tags.length === 0) {
            tagSelectionList.innerHTML = '<div class="empty-state">No tags found in the library.</div>';
            return;
        }

        tagSelectionList.innerHTML = data.tags.map(tag => `
            <div class="tag-selection-item" onclick="playTag('${tag.replace(/'/g, "\\'")}')">
                ${tag}
            </div>
        `).join('');
    } catch (err) {
        console.error('Error fetching tags:', err);
        tagSelectionList.innerHTML = `<div class="error">Failed to load tags: ${err.message}</div>`;
    }
}

function closePlayTagModal() {
    if (playTagModal) playTagModal.style.display = 'none';
}

function openCastModal(index) {
    pendingCastIndex = index;
    const track = currentBrowserItems[index];
    if (!track) return;

    const titleEl = document.getElementById('cast-track-title');
    if (titleEl) titleEl.textContent = `Set playback to: ${track.title}`;

    if (castModal) {
        updateCastDeviceList();
        castModal.style.display = 'flex';
    }
}

function closeCastModal() {
    if (castModal) castModal.style.display = 'none';
    pendingCastIndex = null;
}

function updateCastDeviceList() {
    if (!modalCastList) return;
    const renderers = currentDevices.filter(d => d.isRenderer && !d.disabledPlayer && !isLocalDisabled(d.udn));

    modalCastList.innerHTML = renderers.map(device => {
        const isSelected = (device.udn === selectedRendererUdn);
        const displayName = device.customName || device.friendlyName;
        const iconHtml = `<div class="modal-device-icon">${getDeviceIcon(device, false, 24)}</div>`;

        return `
            <div class="modal-device-item ${isSelected ? 'selected' : ''}" 
                 onclick="castToDevice('${device.udn}')"
                 id="modal-cast-${device.udn?.replace(/:/g, '-')}">
                <div class="modal-device-item-left">
                    ${iconHtml}
                    <div class="modal-device-info-stack">
                        <div class="modal-device-name">${displayName}</div>
                        <div class="modal-device-protocol">${device.protocol || (device.isAirPlay ? 'AirPlay' : (device.isSonos ? 'Sonos' : 'DLNA'))}</div>
                    </div>
                </div>
                ${isSelected ? '<div class="selected-indicator">Active</div>' : ''}
            </div>
        `;
    }).join('');
}

async function castToDevice(deviceUdn) {
    if (pendingCastIndex === null) return;
    const track = currentBrowserItems[pendingCastIndex];
    if (!track) return;

    // First stop the scan if it's running (user might be in AirPlay tab)
    stopAirPlayScan();

    // Select the device
    selectedRendererUdn = deviceUdn;
    localStorage.setItem('selectedRendererUdn', selectedRendererUdn);
    renderDevices();
    closeCastModal();

    // Play the track
    await playTrack(track.uri, track.title, track.artist, track.album, track.duration, track.protocolInfo, track.albumArtUrl);

    // Close dropdowns
    document.querySelectorAll('.dropdown-menu.active').forEach(d => d.classList.remove('active'));
}

async function playTag(tagName) {
    if (!selectedRendererUdn) {
        showToast('Please select a player first.', 'error');
        return;
    }

    closePlayTagModal();
    showToast(`Playing tracks tagged with "${tagName}"...`, 'info', 3000);

    try {
        const res = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/queue-tag`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: tagName })
        });

        if (!res.ok) throw new Error('Failed to play tag');
        const data = await res.json();

        showToast(`Playing ${data.count} tracks for "${tagName}"`, 'success', 3000);
        await fetchPlaylist(selectedRendererUdn);

        if (window.innerWidth <= 1100 && typeof switchView === 'function') {
            switchView('playlist');
        }
    } catch (err) {
        console.error('Error playing tag:', err);
        showToast(`Failed to play tag: ${err.message}`, 'error');
    }
}

function switchSettingsTab(tab) {
    // Stop scanning if switching away from airplay
    const currentTab = document.querySelector('.settings-tab.active')?.textContent.trim().toLowerCase();
    if (currentTab === 'airplay' && tab.toLowerCase() !== 'airplay') {
        stopAirPlayScan();
    }

    // Update tab buttons
    document.querySelectorAll('.settings-tab').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.trim().toLowerCase() === tab.toLowerCase());
    });
    // Update panels
    document.querySelectorAll('.settings-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `settings-${tab}`);
    });

    // Auto-trigger AirPlay scan when entering the tab
    if (tab.toLowerCase() === 'airplay') {
        startAirPlayScan();
    }

}

function renderManageDevices() {
    const renderers = currentDevices.filter(d => d.isRenderer);
    const servers = currentDevices.filter(d => d.isServer);

    const getProtocol = (device) => {
        if (device.isAirPlay || device.protocol === 'AirPlay') return 'AirPlay';
        if (device.isSonos || device.protocol === 'Sonos') return 'Sonos';
        if (device.isVirtual || device.udn === BROWSER_PLAYER_UDN) return 'Browser';
        return 'DLNA';
    };

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
                    <span class="manage-item-host">${statusTags.join(' ')}</span>
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
        const nonAirPlayRenderers = renderers.filter(d => !d.isAirPlay && d.protocol !== 'AirPlay');
        if (nonAirPlayRenderers.length === 0) {
            manageRendererList.innerHTML = '<div class="empty-state-mini">No players saved</div>';
        } else {
            // Group by protocol
            const protocolOrder = ['Browser', 'DLNA', 'Sonos'];
            const groups = {};
            for (const d of nonAirPlayRenderers) {
                const proto = getProtocol(d);
                if (!groups[proto]) groups[proto] = [];
                groups[proto].push(d);
            }

            // Also include any unknown protocols not in our predefined order
            for (const proto of Object.keys(groups)) {
                if (!protocolOrder.includes(proto)) protocolOrder.push(proto);
            }

            const protocolIcons = {
                'DLNA': '📡',
                'Sonos': '🎵',
                'Browser': '🌐',
            };

            manageRendererList.innerHTML = protocolOrder
                .filter(proto => groups[proto] && groups[proto].length > 0)
                .map(proto => `
                    <div class="manage-section" style="margin-bottom: 1rem;">
                        <h3>${protocolIcons[proto] || '🔌'} ${proto}</h3>
                        ${groups[proto].map(d => renderItem(d, 'player')).join('')}
                    </div>
                `).join('');
        }
    }

    if (manageAirPlayList) {
        const airplayDevices = renderers.filter(d => d.isAirPlay || d.protocol === 'AirPlay');
        if (airplayDevices.length === 0) {
            manageAirPlayList.innerHTML = '<div class="empty-state-mini">No AirPlay devices found. </div>';
        } else {
            manageAirPlayList.innerHTML = airplayDevices.map(d => renderItem(d, 'player')).join('');
        }
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

function updateCardNowPlaying() {
    const cardTrackTitle = document.querySelector('.card-track-title');
    const cardTrackArtistAlbum = document.querySelector('.card-track-artist-album');
    const cardNowPlaying = document.getElementById('card-now-playing');
    const cardAlbumArt = document.getElementById('card-album-art');
    const cardDefaultIcon = document.getElementById('card-default-icon');

    if (currentTrackId != null && currentPlaylistItems.length > 0) {
        const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);
        if (currentTrack) {
            if (cardTrackTitle) cardTrackTitle.textContent = currentTrack.title;
            if (cardTrackArtistAlbum) {
                const artist = currentTrack.artist || 'Unknown Artist';
                const album = currentTrack.album ? ` • ${currentTrack.album}` : '';
                cardTrackArtistAlbum.textContent = `${artist}${album}`;
            }
            if (cardNowPlaying) cardNowPlaying.classList.add('visible');

            if (cardAlbumArt && currentArtworkUrl) {
                // Only update src if it's actually different to avoid reload loops
                // Note: comparison with .src might fail if currentArtworkUrl is relative, 
                // but for our proxy URLs it's usually stable enough.
                const currentSrc = cardAlbumArt.getAttribute('src');
                if (currentSrc !== currentArtworkUrl) {
                    console.log(`[ART-SYNC] Updating card art src to: ${currentArtworkUrl}`);
                    cardAlbumArt.src = currentArtworkUrl;
                }
                cardAlbumArt.style.display = 'block';
                if (cardDefaultIcon) cardDefaultIcon.style.display = 'none';
                const parent = cardAlbumArt.parentElement;
                if (parent) parent.style.background = 'none';
            } else if (cardAlbumArt) {
                cardAlbumArt.removeAttribute('src');
                cardAlbumArt.style.display = 'none';
                if (cardDefaultIcon) cardDefaultIcon.style.display = 'block';
                const parent = cardAlbumArt.parentElement;
                if (parent) parent.style.background = '';
            }
            return;
        }
    }
    if (cardNowPlaying) cardNowPlaying.classList.remove('visible');
    if (cardAlbumArt) {
        cardAlbumArt.style.display = 'none';
        const parent = cardAlbumArt.parentElement;
        if (parent) parent.style.background = '';
    }
    if (cardDefaultIcon) cardDefaultIcon.style.display = 'block';
}

// ─── Lyrics ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

window.addEventListener('resize', () => {
    const panel = document.getElementById('ss-lyrics-panel');
    if (panel && panel.style.display !== 'none') {
        syncLyricsSpacerPadding(panel);
        updateLyricsHighlight(currentPositionSeconds, true);
    }
});

function parseLRC(lrcText) {
    const lines = [];
    const timeTag = /\[(\d{2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    for (const rawLine of lrcText.split(/\r?\n/)) {
        const matches = [...rawLine.matchAll(timeTag)];
        if (matches.length === 0) continue;
        const text = rawLine.replace(timeTag, '').trim();
        for (const m of matches) {
            const minutes = parseInt(m[1], 10);
            const seconds = parseInt(m[2], 10);
            const fraction = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0;
            lines.push({ time: minutes * 60 + seconds + fraction, text });
        }
    }
    lines.sort((a, b) => a.time - b.time);
    return lines;
}

// Lyrics only ever appear in the screensaver's Music ("nowPlaying") mode, not in the file-list playlist view.
function isLyricsDisplayActive() {
    return !!(currentLyrics && slideshow && slideshow.isActive && slideshow.mode === 'nowPlaying');
}

async function fetchLyricsForTrack(track) {
    if (!track || !track.title || !track.artist) {
        clearLyrics();
        return;
    }

    const key = `${track.artist}|${track.title}|${track.album || ''}`;
    if (key === lyricsTrackKey) return; // Already fetched (or fetching) for this track
    lyricsTrackKey = key;

    // Drop any lyrics from the previous track so the highlighter/panel don't show stale content
    currentLyrics = null;
    lyricsActiveLineIndex = -1;
    updateSsLyricsVisibility();

    try {
        const durationSecondsForTrack = track.duration ? formatToSeconds(track.duration) : durationSeconds;
        const params = new URLSearchParams({ artist: track.artist, title: track.title });
        if (track.album) params.set('album', track.album);
        if (durationSecondsForTrack) params.set('duration', String(Math.round(durationSecondsForTrack)));

        console.log(`[LYRICS] Fetching lyrics for: ${track.artist} - ${track.title}`);
        const response = await fetch(`/api/lyrics?${params.toString()}`);
        // A newer track change may have started a different fetch while this one was in flight
        if (key !== lyricsTrackKey) return;

        if (!response.ok) {
            console.warn(`[LYRICS] No lyrics found for: ${track.artist} - ${track.title}`);
            currentLyrics = null;
            updateSsLyricsVisibility();
            return;
        }

        const data = await response.json();
        // Without time tags there's no way to keep the panel in sync with playback, so
        // unsynced (plain-only) results are treated the same as no lyrics found.
        if (data.synced) {
            const parsedLines = parseLRC(data.synced);
            currentLyrics = parsedLines.length > 0 ? { lines: parsedLines } : null;
            console.log(`[LYRICS] Synced lyrics found for: ${track.artist} - ${track.title} (${parsedLines.length} lines, source: ${data.source})`);
        } else {
            currentLyrics = null;
            console.warn(`[LYRICS] No synced lyrics found for: ${track.artist} - ${track.title}`);
        }

        renderLyricsPanel();
        updateSsLyricsVisibility();
    } catch (err) {
        console.error('[LYRICS] Failed to fetch lyrics:', err);
        currentLyrics = null;
        updateSsLyricsVisibility();
    }
}

function clearLyrics() {
    currentLyrics = null;
    lyricsTrackKey = '';
    lyricsActiveLineIndex = -1;
    updateSsLyricsVisibility();
}

// Called whenever the track, the lyrics fetch result, or the slideshow mode/active state changes
function updateSsLyricsVisibility() {
    const panel = document.getElementById('ss-lyrics-panel');
    if (!panel) return;
    if (isLyricsDisplayActive()) {
        panel.style.display = 'block';
        syncLyricsSpacerPadding(panel);
        updateLyricsHighlight(currentPositionSeconds, true);
    } else {
        panel.style.display = 'none';
    }
}

// The first and last lyric lines can't be scrolled to the panel's vertical center unless there's
// as much empty scroll room above the first line and below the last as there is panel height —
// otherwise the browser clamps the scroll and the line sits pinned near the top edge, hidden by
// the fade mask. Pad the content by half the panel's own (fixed) height to guarantee that room.
function syncLyricsSpacerPadding(panel) {
    const content = document.getElementById('ss-lyrics-content');
    if (!content || !panel) return;
    const half = Math.round(panel.clientHeight / 2);
    content.style.paddingTop = `${half}px`;
    content.style.paddingBottom = `${half}px`;
}

function renderLyricsPanel() {
    const content = document.getElementById('ss-lyrics-content');
    if (!content) return;

    lyricsActiveLineIndex = -1;
    if (!currentLyrics || currentLyrics.lines.length === 0) {
        content.innerHTML = '';
    } else {
        content.innerHTML = currentLyrics.lines
            .map((line, i) => `<div class="ss-lyrics-line" data-index="${i}">${escapeHtml(line.text) || '&nbsp;'}</div>`)
            .join('');
    }
}

function updateLyricsHighlight(positionSeconds, forceScroll = false) {
    if (!isLyricsDisplayActive() || currentLyrics.lines.length === 0) return;

    const content = document.getElementById('ss-lyrics-content');
    if (!content) return;

    const lines = currentLyrics.lines;
    let activeIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].time <= positionSeconds) activeIndex = i;
        else break;
    }

    const indexChanged = activeIndex !== lyricsActiveLineIndex;
    lyricsActiveLineIndex = activeIndex;

    // Re-assert the active class on every tick (not just on change) so a stale/cleared
    // DOM state (e.g. from a re-render elsewhere) can never leave the panel stuck grey.
    content.querySelectorAll('.ss-lyrics-line.active').forEach(el => {
        if (!el.dataset.index || Number(el.dataset.index) !== activeIndex) el.classList.remove('active');
    });

    if (activeIndex >= 0) {
        const el = content.querySelector(`.ss-lyrics-line[data-index="${activeIndex}"]`);
        if (el) {
            el.classList.add('active');
            if (indexChanged || forceScroll) centerLyricsLine(el, content, !forceScroll);
        }
    } else if (forceScroll) {
        // Before the first line's timestamp (e.g. an instrumental intro): center the upcoming
        // first line so the panel shows something meaningful instead of a blank gap.
        const el = content.querySelector('.ss-lyrics-line[data-index="0"]');
        if (el) centerLyricsLine(el, content, false);
    }
}

// Manually centers the active line within the scrollable lyrics container using bounding-rect math
// rather than scrollIntoView(), which can miscompute against an absolutely-positioned ancestor and
// leave the highlighted line scrolled off the top edge of the panel.
function centerLyricsLine(el, content, smooth = true) {
    const contentRect = content.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const delta = (elRect.top + elRect.height / 2) - (contentRect.top + contentRect.height / 2);
    const targetTop = Math.max(0, Math.min(content.scrollHeight - content.clientHeight, content.scrollTop + delta));
    content.scrollTo({ top: targetTop, behavior: smooth ? 'smooth' : 'auto' });
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
            updateCardNowPlaying();

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
        const isExternal = device.iconUrl.startsWith('http');
        const proxyUrl = isExternal ? `/api/proxy-image?url=${encodeURIComponent(device.iconUrl)}` : device.iconUrl;
        return `<img src="${proxyUrl}" class="${size === 32 ? 'device-card' : 'modal-device'}-img" alt="" style="width: ${size}px; height: ${size}px; object-fit: contain;">`;
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

    if (device.isAirPlay || device.protocol === 'AirPlay') {
        return `
            <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 16.6q-2-2-2-4.6 0-3.1 2.2-5.1t5.3-2h3q3.1 0 5.3 2t2.2 5.1q0 2.6-2 4.6"></path>
                <path d="M12 12v9"></path>
                <path d="m9 15 3-3 3 3"></path>
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
                <div class="modal-device-info-stack">
                    <div class="modal-device-name">${displayName}</div>
                    <div class="modal-device-protocol">${device.protocol || (device.isAirPlay ? 'AirPlay' : (device.isSonos ? 'Sonos' : 'DLNA'))}</div>
                </div>
            </div>
            ${isSelected ? '<div class="selected-indicator">✓</div>' : ''}
        </div>
    `;
}

function renderDeviceCard(device, forceHighlight = false, asServer = false, isStatic = false) {
    const isSelected = forceHighlight || (asServer ? (device.udn === selectedServerUdn) : (device.udn === selectedRendererUdn));
    const isOffline = !asServer && isSelected && isRendererOffline;

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
            <button id="btn-stop-after" onclick="event.stopPropagation(); toggleStopAfterTrack()"
                class="btn-control btn-stop-after" title="Stop after current track">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <path d="M6 6h12v12H6z" fill="currentColor" stroke="none"/>
                    <line x1="4" y1="22" x2="20" y2="22"/>
                    <line x1="12" y1="17" x2="12" y2="22"/>
                </svg>
            </button>
        </div>
    ` : '';

    return `
        <div class="device-card ${isSelected ? 'selected' : ''} ${asServer ? 'server-card' : ''} ${isStatic ? 'is-static' : ''} ${isOffline ? 'renderer-offline' : ''}" 
             onclick="${clickAction}"
             id="device-${asServer ? 'srv-' : 'ren-'}${device.udn?.replace(/:/g, '-') || Math.random()}">
            ${isOffline ? `
            <div class="offline-badge">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <line x1="1" y1="1" x2="23" y2="23"></line>
                    <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path>
                    <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path>
                    <path d="M10.71 5.05A16 16 0 0 1 22.56 9"></path>
                    <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path>
                    <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
                    <line x1="12" y1="20" x2="12.01" y2="20"></line>
                </svg>
                Offline
            </div>` : ''}
            <div class="device-icon ${asServer ? 'server-icon' : 'player-icon'}" style="${(device.iconUrl) ? 'background: none; box-shadow: none;' : ''}">
                ${isStatic && !asServer ? `<img id="card-album-art" onclick="event.stopPropagation(); startMusicSlideshow()" style="display: none; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; cursor: pointer;" alt="">` : ''}
                <div id="${isStatic ? (asServer ? 'card-server-icon' : 'card-default-icon') : ''}" style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
                    ${device.iconUrl ?
            `<img src="${device.iconUrl}" style="width: 100%; height: 100%; object-fit: contain; padding: 2px;" alt="">` :
            (asServer ? `
                            <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                            </svg>
                        ` : `
                            <svg viewBox="0 0 24 24" fill="white">
                                <path d="M6 9h5l7-7v20l-7-7H6V9z"></path>
                            </svg>
                        `)
        }
                </div>
            </div>
            <div class="device-info">
                <div class="device-name-container">
                    <div class="device-name">${device.customName || device.friendlyName}</div>
                    <div class="device-protocol-label">${device.protocol || (device.isAirPlay ? 'AirPlay' : (device.isSonos ? 'Sonos' : 'DLNA'))}</div>
                </div>
                ${(!asServer && isStatic) ? `
                    <div class="device-now-playing" id="card-now-playing">
                        <div class="card-track-title"></div>
                        <div class="card-track-artist-album"></div>
                    </div>
                ` : ''}
            </div>
            ${asServer ? `<div class="media-library-label">Media Library</div>` : ''}
            ${(asServer && isStatic) ? `
            <div class="browser-mode-radios" onclick="event.stopPropagation()">
                <label><input type="radio" name="browser-mode" value="music" onchange="switchBrowserMode('music')"> Music</label>
                <label><input type="radio" name="browser-mode" value="photo" onchange="switchBrowserMode('photo')"> Photos</label>
            </div>` : ''}
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
    const layout = document.querySelector('.main-layout');

    if (view === 'playlist') {
        playerCol ? playerCol.classList.add('active') : null;
        browserCol ? browserCol.classList.remove('active') : null;
        if (layout) layout.classList.add('show-playlist');
        if (floatingBtn) floatingBtn.classList.add('on-left');
        if (navBtnLabel) navBtnLabel.textContent = 'Library';
    } else {
        playerCol ? playerCol.classList.remove('active') : null;
        browserCol ? browserCol.classList.add('active') : null;
        if (layout) layout.classList.remove('show-playlist');
        if (floatingBtn) floatingBtn.classList.remove('on-left');
        if (navBtnLabel) navBtnLabel.textContent = 'Player';
    }
    localStorage.setItem('currentView', view);
}

function toggleMobileView() {
    const layout = document.querySelector('.main-layout');
    if (layout) {
        if (layout.classList.contains('show-playlist')) {
            switchView('browser');
        } else {
            switchView('playlist');
        }
    }
}

let touchStartX = 0;
let touchStartY = 0;
function initSwipeHandling() {
    const layout = document.querySelector('.main-layout');
    if (!layout) return;

    layout.addEventListener('touchstart', e => {
        touchStartX = e.changedTouches[0].clientX;
        touchStartY = e.changedTouches[0].clientY;
    }, { passive: true });

    layout.addEventListener('touchend', e => {
        // Only allow swipe switching if we are in the single-column layout
        if (window.innerWidth > 1100) return;
        const touchEndX = e.changedTouches[0].clientX;
        const touchEndY = e.changedTouches[0].clientY;
        const dx = touchEndX - touchStartX;
        const dy = touchEndY - touchStartY;

        // Ensure it's mostly a horizontal swipe and exceeds threshold
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 60) {
            if (dx < -60) {
                // Swipe Left (finger moves left) -> Playlist
                switchView('playlist');
            } else if (dx > 60) {
                // Swipe Right (finger moves right) -> Browser
                switchView('browser');
            }
        }
    }, { passive: true });
}

async function setHome(type = 'music') {
    if (!selectedServerUdn) return;
    const btnIdCheck = type === 'music' ? 'btn-set-music-home' : 'btn-set-photo-home';
    if (document.getElementById(btnIdCheck)?.classList.contains('disabled')) return;

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
            Home Set!
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
    if (document.getElementById('btn-set-screensaver')?.classList.contains('disabled')) return;

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


async function switchBrowserMode(mode) {
    if (selectedServerUdn) {
        saveLastPath(); // Save current path for old mode
    }

    currentBrowserMode = mode;
    localStorage.setItem('currentBrowserMode', mode);

    // Update radio UI
    document.querySelectorAll('input[name="browser-mode"]').forEach(r => { r.checked = r.value === mode; });

    if (selectedServerUdn) {
        // Load path for new mode
        let lastPaths = {};
        try {
            const stored = localStorage.getItem(`serverLastPaths_${mode}`);
            if (stored) lastPaths = JSON.parse(stored);
        } catch (e) { }

        const pathToRestore = lastPaths[selectedServerUdn];

        if (pathToRestore && Array.isArray(pathToRestore)) {
            browsePath = pathToRestore;
            updateBreadcrumbs();
            const lastFolder = browsePath[browsePath.length - 1];
            await browse(selectedServerUdn, lastFolder.id);
        } else {
            // If no path saved for this mode yet, go to home
            await goHome(mode);
        }
    }
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

    // Seed client-side rotation cache from server DB
    try {
        const rotRes = await fetch('/api/slideshow/rotations');
        if (rotRes.ok) manualRotations = await rotRes.json();
    } catch (e) { console.warn('Failed to fetch photo rotations'); }

    // Fetch screensaver settings
    try {
        const res = await fetch('/api/settings/screensaver');
        if (res.ok) {
            screensaverConfig = await res.json();
        }
    } catch (e) { console.warn('Failed to fetch screensaver settings'); }

    // Reconnect to any in-progress download job
    checkActiveDownloadJob();

    // Start idle timer
    resetIdleTimer();

    // Initialize screensaver mode label
    const ssModeLabel = document.getElementById('ss-mode-label');
    if (ssModeLabel && slideshow) {
        if (slideshow.mode === 'all') ssModeLabel.textContent = 'All';
        else if (slideshow.mode === 'onThisDay') ssModeLabel.textContent = 'Day';
        else if (slideshow.mode === 'recent') ssModeLabel.textContent = 'Recent';
        else if (slideshow.mode === 'favourites') ssModeLabel.textContent = 'Favs';
        else if (slideshow.mode === 'nowPlaying') ssModeLabel.textContent = 'Music';
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
            // Do not await these; let them run in background so init() can finish and the 
            // browser "loading" symbol can stop.
            fetchStatus();
            fetchPlaylist(selectedRendererUdn);
            fetchVolume();
        }
    }

    // Auto-browse if a server was previously selected
    if (selectedServerUdn) {
        const server = currentDevices.find(d => d.udn === selectedServerUdn && d.isServer);
        if (server) {
            // Set initial mode UI
            const mode = localStorage.getItem('currentBrowserMode') || 'music';
            currentBrowserMode = mode;
            document.querySelectorAll('input[name="browser-mode"]').forEach(r => { r.checked = r.value === mode; });

            // Prioritize last browsed path, then home location, then root
            let lastPaths = {};
            let homeLocations = {};
            try {
                const storedLast = localStorage.getItem(`serverLastPaths_${mode}`);
                if (storedLast) lastPaths = JSON.parse(storedLast);

                const storedHome = localStorage.getItem(`serverHomeLocations_${mode}`);
                if (storedHome) homeLocations = JSON.parse(storedHome);
                else if (mode === 'music') {
                    const oldHome = localStorage.getItem('serverHomeLocations');
                    if (oldHome) homeLocations = JSON.parse(oldHome);
                }
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
        }
    }

    // Initialize swipe handling and sync slider position on mobile
    initSwipeHandling();
    if (window.innerWidth <= 1100) {
        const savedView = localStorage.getItem('currentView') || 'browser';
        // Use a short timeout to ensure the DOM is fully interactive and styles are applied 
        // before switching view on initial load.
        setTimeout(() => {
            switchView(savedView);
        }, 50);
    }

    // Global click listener to close dropdowns
    window.addEventListener('click', (e) => {
        if (!e.target.closest('.menu-container')) {
            document.querySelectorAll('.dropdown-menu').forEach(d => d.classList.remove('active'));
        }
    });
}

function toggleBrowserMenu(event) {
    if (event) event.stopPropagation();
    const dropdown = document.getElementById('browser-menu-dropdown');
    if (dropdown) {
        dropdown.classList.toggle('active');
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
        if (selectedRendererUdn && !isRendererOffline) {
            fetchStatus();
            fetchPlaylist(selectedRendererUdn);
        }
        // If screensaver activated while page was hidden, load the first image now
        if (slideshow && slideshow.isActive) {
            slideshow.next();
        } else if (slideshow) {
            slideshow.resetIdleTimer();
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
    if (!selectedRendererUdn || isRendererOffline) return;
    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/volume`);
        if (!response.ok) throw new Error('Failed to fetch volume');
        const data = await response.json();
        const slider = document.getElementById('volume-slider');
        const ssSlider = document.getElementById('ss-volume-slider');
        const valueSpan = document.getElementById('volume-value');
        if (slider) slider.value = data.volume;
        if (ssSlider) ssSlider.value = data.volume;
        if (valueSpan) valueSpan.textContent = `${data.volume}%`;
        rendererFailureCount = 0;
        // setRendererOffline(false, 'fetchVolume'); // Only fetchStatus should turn it online
    } catch (err) {
        console.error('Failed to fetch volume:', err);
        setRendererOffline(true, 'fetchVolume');
    }
}

async function updateVolume(value) {
    if (isRendererOffline) return; // Silently ignore when offline
    const slider = document.getElementById('volume-slider');
    const ssSlider = document.getElementById('ss-volume-slider');
    const valueSpan = document.getElementById('volume-value');
    if (slider) slider.value = value;
    if (ssSlider) ssSlider.value = value;
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
    if (isRendererOffline) return; // Silently ignore when offline
    const slider = document.getElementById('volume-slider');
    if (!slider) return;
    let newValue = parseInt(slider.value, 10) + delta;
    if (newValue < 0) newValue = 0;
    if (newValue > 100) newValue = 100;
    slider.value = newValue;
    updateVolume(newValue);
}

let pollCounter = 0;
// Poll status every 5s always (keeps tab title current in background); playlist only when visible
setInterval(() => {
    if (selectedRendererUdn && !isRendererOffline) {
        pollCounter++;
        const includePlaylist = isPageVisible && (pollCounter % 3 === 0);
        fetchStatus(includePlaylist);
    }
}, 5000);

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
    if (!selectedRendererUdn || isRendererOffline) return;
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

        rendererFailureCount = 0;
        // setRendererOffline(false, 'fetchEq'); // Only fetchStatus should turn it online
    } catch (err) {
        console.error('EQ fetch error:', err);
        setRendererOffline(true, 'fetchEq');
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

function triggerFolderUpload() {
    const input = document.getElementById('upload-folder-input');
    if (input) input.click();
}

function openUploadFolderModal(folderName, total) {
    const modal = document.getElementById('upload-folder-modal');
    document.getElementById('upload-folder-title').textContent = `Uploading: ${folderName} (${total} files)`;
    document.getElementById('upload-folder-bar').style.width = '0%';
    document.getElementById('upload-folder-current').textContent = 'Starting...';
    document.getElementById('upload-folder-log').innerHTML = '';
    document.getElementById('upload-folder-stats').textContent = '';
    document.getElementById('upload-folder-close').disabled = true;
    modal.style.display = 'flex';
}

function closeUploadFolderModal() {
    document.getElementById('upload-folder-modal').style.display = 'none';
}

async function handleFolderUpload(event) {
    const files = Array.from(event.target.files);
    event.target.value = '';
    if (!files.length) return;

    const audioExts = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus']);
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.heif', '.tiff', '.tif']);

    const eligible = files.filter(f => {
        const dot = f.name.lastIndexOf('.');
        if (dot === -1) return false;
        const ext = f.name.slice(dot).toLowerCase();
        return audioExts.has(ext) || imageExts.has(ext);
    });

    if (!eligible.length) {
        showToast('No supported audio or image files found in the selected folder', 'warning');
        return;
    }

    const folderName = (eligible[0].webkitRelativePath || eligible[0].name).split('/')[0];
    openUploadFolderModal(folderName, eligible.length);

    let uploaded = 0, skipped = 0, failed = 0;
    const MAX_LOG_ENTRIES = 500;

    for (const file of eligible) {
        // Everything for this file — including DOM lookups and building the request — lives in
        // one try/catch. A single bad file (stale File handle, transient DOM hiccup) must not be
        // able to throw out of the loop and silently abandon the rest of a huge import.
        let outcome;
        try {
            const current = document.getElementById('upload-folder-current');
            if (current) current.textContent = file.name;

            const formData = new FormData();
            formData.append('file', file);
            formData.append('relativePath', file.webkitRelativePath || file.name);

            const res = await fetch('/api/upload-local-file', { method: 'POST', body: formData });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Upload failed');

            if (data.skipped) {
                skipped++;
                outcome = { text: `— ${file.name}`, color: '#94a3b8' };
            } else {
                uploaded++;
                outcome = { text: `✓ ${file.name}`, color: '#4ade80' };
            }
        } catch (err) {
            failed++;
            console.error(`[Upload Folder] Failed on ${file.name}:`, err);
            outcome = { text: `✗ ${file.name}: ${err && err.message ? err.message : 'Unknown error'}`, color: '#f87171' };
        }

        const log = document.getElementById('upload-folder-log');
        if (log) {
            const entry = document.createElement('div');
            entry.textContent = outcome.text;
            entry.style.cssText = `font-size:14px;line-height:1.6;color:${outcome.color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 0;flex-shrink:0;`;
            const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
            log.appendChild(entry);
            while (log.children.length > MAX_LOG_ENTRIES) log.removeChild(log.firstChild);
            if (wasAtBottom) log.scrollTop = log.scrollHeight;
        }

        const done = uploaded + skipped + failed;
        const bar = document.getElementById('upload-folder-bar');
        if (bar) bar.style.width = Math.round((done / eligible.length) * 100) + '%';
    }

    document.getElementById('upload-folder-current').textContent = 'Complete';
    document.getElementById('upload-folder-stats').textContent = `${uploaded} uploaded, ${skipped} skipped, ${failed} failed`;
    document.getElementById('upload-folder-title').textContent =
        document.getElementById('upload-folder-title').textContent.replace('Uploading:', 'Complete:');
    document.getElementById('upload-folder-close').disabled = false;

    if (selectedServerUdn === LOCAL_SERVER_UDN && uploaded > 0) {
        const currentFolder = browsePath[browsePath.length - 1];
        if (currentFolder) await browse(selectedServerUdn, currentFolder.id);
    }
}

function updateLocalOnlyUI() {
    const isLocalServer = selectedServerUdn === LOCAL_SERVER_UDN;
    const noServer = !selectedServerUdn;
    const uploadBtn = document.getElementById('btn-upload');
    if (uploadBtn) {
        const disable = isLocalServer || noServer;
        uploadBtn.classList.toggle('disabled', disable);
        uploadBtn.title = isLocalServer
            ? 'Upload not available when browsing the local library'
            : 'Upload to local server';
    }
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

    // Snapshot which IPs are currently expanded so we can restore after re-render
    const openIps = new Set();
    ips.forEach((ip, i) => {
        const existingRow = document.getElementById(`ssdp-row-${i}`);
        if (existingRow && existingRow.style.display !== 'none') {
            openIps.add(ip);
        }
    });

    let html = `
        <table class="ssdp-table">
            <thead>
                <tr>
                    <th style="width: 24px;"></th>
                    <th style="width: 110px;">IP Address</th>
                    <th style="width: 160px;">Device</th>
                    <th style="width: 100px;">Last Seen</th>
                </tr>
            </thead>
            <tbody>
    `;

    ips.forEach((ip, i) => {
        const entry = ssdp[ip];
        const services = entry.services || [];
        const rowId = `ssdp-row-${i}`;
        const isOpen = openIps.has(ip);
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

        html += `
            <tr class="ssdp-device-row" onclick="toggleSSDPRow('${rowId}')">
                <td class="ssdp-expand-cell">
                    <span class="ssdp-chevron" id="${rowId}-chevron">${isOpen ? '&#9660;' : '&#9654;'}</span>
                </td>
                <td class="ssdp-ip">${ip}</td>
                <td class="ssdp-name" style="font-weight: 600; color: var(--primary);">${entry.name || 'Unknown'}</td>
                <td class="ssdp-time">${entry.lastSeen}</td>
            </tr>
            <tr class="ssdp-services-row" id="${rowId}" style="display: ${isOpen ? 'table-row' : 'none'};">
                <td colspan="4" class="ssdp-services-cell">
                    <div class="ssdp-services-list">${servicesHtml || '<span style="color:var(--text-muted);font-size:0.75rem;">No services advertised</span>'}</div>
                </td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}


function toggleSSDPRow(rowId) {
    const row = document.getElementById(rowId);
    const chevron = document.getElementById(`${rowId}-chevron`);
    if (!row) return;
    const isOpen = row.style.display !== 'none';
    row.style.display = isOpen ? 'none' : 'table-row';
    if (chevron) chevron.textContent = isOpen ? '\u25BA' : '\u25BC';
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

async function openFileInfoModal(trackData) {
    const modal = document.getElementById('track-info-modal');
    const container = document.getElementById('track-metadata-list');
    if (!modal || !container) return;

    currentInfoUri = trackData.uri;
    currentFileTags = [];
    updateFileFavUI();
    renderFileTags();

    // Reset and hide suggestions
    const suggestionsContainer = document.getElementById('tag-suggestions');
    if (suggestionsContainer) {
        suggestionsContainer.innerHTML = '';
        suggestionsContainer.style.display = 'none';
    }

    // Fetch all library tags for auto-complete
    try {
        const tagRes = await fetch('/api/tags');
        if (tagRes.ok) {
            const tagData = await tagRes.json();
            allLibraryTags = tagData.tags || [];
            updateTagSuggestions();
        }
    } catch (e) {
        console.warn('Failed to fetch all library tags:', e);
    }

    modal.style.display = 'flex';
    container.innerHTML = `
        <div class="metadata-grid">
            <div class="metadata-header">Field</div>
            <div class="metadata-header">Media Server</div>
            <div class="metadata-header">File Tags (Deep Scan)</div>
            <div class="metadata-header">Folder Path</div>
            
            <div class="metadata-loading-row" id="metadata-loading-spinner">
                <div class="spinner"></div>
                <span style="margin-left: 1rem; color: var(--text-muted);">Analyzing track file...</span>
            </div>
            
            <div id="metadata-rows" style="display: contents;"></div>
        </div>
    `;

    const rowsContainer = document.getElementById('metadata-rows');

    // Derive artist and album from folder structure (Artist/Album/Track convention)
    const folderMeta = { artist: null, album: null };
    if (trackData.uri) {
        try {
            const uriPath = decodeURIComponent(new URL(trackData.uri).pathname);
            // Strip leading /local-files/ or similar prefix
            const cleanPath = uriPath.replace(/^\/local-files\//, '').replace(/^\//, '');
            const parts = cleanPath.split('/').filter(p => p);
            // Expect: Artist / Album / Track.ext  (at least 3 parts)
            if (parts.length >= 3) {
                folderMeta.artist = parts[parts.length - 3];
                folderMeta.album = parts[parts.length - 2];
            } else if (parts.length === 2) {
                folderMeta.album = parts[0];
            }
        } catch (e) { /* not a parseable URL */ }
    }

    // Fetch Deep Metadata early
    let embeddedMeta = null;
    let fetchError = null;
    try {
        if (trackData.uri) {
            const response = await fetch(`/api/track-metadata?uri=${encodeURIComponent(trackData.uri)}`);
            if (response.ok) {
                embeddedMeta = await response.json();
                if (embeddedMeta.tags) {
                    currentFileTags = embeddedMeta.tags;
                    updateFileFavUI();
                    renderFileTags();
                }
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

        if (key === 'format.latitude' && value !== undefined) {
            const lat = parseFloat(value);
            const lon = embeddedMeta?.format?.longitude;
            if (lon !== undefined) {
                return `${lat.toFixed(4)}, ${parseFloat(lon).toFixed(4)}`;
            }
            return lat.toFixed(4);
        }

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
        if (key === 'format.orientation' && typeof value === 'number') {
            const labels = {
                1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°',
                4: 'Mirrored, Rotated 180°', 5: 'Mirrored, Rotated 90° CW',
                6: 'Rotated 90° CW', 7: 'Mirrored, Rotated 90° CCW', 8: 'Rotated 90° CCW'
            };
            return labels[value] ? `${value} — ${labels[value]}` : String(value);
        }
        if (key === 'common.date' && value) {
            try {
                const d = new Date(value);
                if (!isNaN(d.getTime())) {
                    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                }
            } catch (e) { }
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
                { label: 'Created', sKey: 'date', eKey: 'common.date' },
                { label: 'Width', sKey: 'width', eKey: 'format.width' },
                { label: 'Height', sKey: 'height', eKey: 'format.height' },
                { label: 'Format', sKey: '', eKey: 'format.container' },
                { label: 'File Size', sKey: 'size', eKey: 'format.size' },
                { label: 'Location', sKey: '', eKey: 'format.latitude' },
                { label: 'Orientation', sKey: '', eKey: 'format.orientation' }
            ]
        },
        {
            title: 'Camera Info',
            fields: [
                { label: 'Make', sKey: '', eKey: 'common.make' },
                { label: 'Model', sKey: '', eKey: 'common.model' },
                { label: 'Software', sKey: '', eKey: 'common.software' }
            ]
        }
    ] : [
        {
            title: 'Primary Metadata',
            fields: [
                { label: 'Title', sKey: 'title', eKey: 'common.title' },
                { label: 'Artist', sKey: 'artist', eKey: 'common.artist' },
                { label: 'Album Artist', sKey: 'albumArtist', eKey: 'common.albumartist' },
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

    let hasFolderMismatch = false;

    // Decide whether the folder-derived artist reflects the Artist tag or the Album Artist tag,
    // so it's shown alongside whichever one it actually corresponds to
    let folderArtistRow = 'Artist';
    if (folderMeta.artist) {
        const nf = normalizeForComparison(folderMeta.artist);
        const artistMatches = !!nf && (nf === normalizeForComparison(trackData.artist) || nf === normalizeForComparison(getEmbeddedValue('common.artist')));
        const albumArtistMatches = !!nf && (nf === normalizeForComparison(trackData.albumArtist) || nf === normalizeForComparison(getEmbeddedValue('common.albumartist')));
        if (!artistMatches && albumArtistMatches) {
            folderArtistRow = 'Album Artist';
        }
    }

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

            // Folder-derived value (only meaningful for Artist and Album)
            let folderVal = '-';
            let folderValRaw = null;
            let isFolderMismatch = false;
            if (f.label === folderArtistRow && folderMeta.artist) {
                folderValRaw = folderMeta.artist;
                folderVal = folderMeta.artist;
            } else if (f.label === 'Album' && folderMeta.album) {
                folderValRaw = folderMeta.album;
                folderVal = folderMeta.album;
            }

            if (folderValRaw) {
                const nf = normalizeForComparison(folderValRaw);
                const ns = normalizeForComparison(sValRaw);
                const ne = normalizeForComparison(eValRaw);
                // Highlight if folder value differs from either source
                if ((ns && nf !== ns) || (ne && nf !== ne)) {
                    isFolderMismatch = true;
                    hasFolderMismatch = true;
                }
            }

            const folderMismatchClass = isFolderMismatch ? 'mismatch' : '';
            const folderMismatchIcon = isFolderMismatch ? '<div class="mismatch-badge" title="Folder name mismatch">!</div>' : '';

            const isLocalFile = trackData.uri && trackData.uri.includes('/local-files/');
            const isEditable = (f.label === 'Artist' || f.label === 'Album Artist' || f.label === 'Album' || f.label === 'Created') && isLocalFile;
            const editField = f.label === 'Artist' ? 'artist' : f.label === 'Album Artist' ? 'albumartist' : 'album';

            let editCell;
            if (!isEditable) {
                editCell = `<div class="metadata-cell metadata-value-cell secondary ${mismatchClass}">${eVal}${mismatchIcon}</div>`;
            } else if (f.label === 'Created') {
                let dateInputVal = '';
                if (eValRaw) {
                    try {
                        const d = new Date(eValRaw);
                        if (!isNaN(d.getTime())) dateInputVal = d.toISOString().slice(0, 10);
                    } catch (e) {}
                }
                editCell = `<div class="metadata-cell metadata-value-cell secondary ${mismatchClass} metadata-editable-cell">
                       <input class="metadata-edit-input" type="date" value="${dateInputVal}" />
                       <button class="metadata-save-btn" onclick="savePhotoDate(this)">Save</button>
                   </div>`;
            } else {
                editCell = `<div class="metadata-cell metadata-value-cell secondary ${mismatchClass} metadata-editable-cell">
                       <input class="metadata-edit-input" data-field="${editField}" value="${(eValRaw || '').toString().replace(/"/g, '&quot;')}" placeholder="Enter ${f.label.toLowerCase()}..." />
                       <button class="metadata-save-btn" onclick="saveTrackTag('${editField}', this)">Save</button>
                       <button class="metadata-save-btn metadata-copy-folder-btn" onclick="copyTagToFolderAll('${editField}', this)" title="Copy to all tracks in this folder">All</button>
                   </div>`;
            }

            rowsContainer.innerHTML += `
                <div class="metadata-cell metadata-label-cell">${f.label}</div>
                <div class="metadata-cell metadata-value-cell ${mismatchClass}">${sVal}</div>
                ${editCell}
                <div class="metadata-cell metadata-value-cell tertiary ${folderMismatchClass}">${folderVal}${folderMismatchIcon}</div>
            `;
        });
    });

    if (fetchError) {
        rowsContainer.innerHTML += `
            <div class="metadata-cell" style="grid-column: span 4; color: #f87171; text-align: center; padding: 1rem;">
                Note: File scan was limited: ${fetchError}
            </div>
        `;
    }
}

async function moveFileToTagsLocationFromBrowser(index, event) {
    if (event) event.stopPropagation();

    // Close the dropdown immediately
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));

    const item = currentBrowserItems[index];
    if (!item) return;

    if (!confirm('Are you sure you want to move this file to match its tags?')) {
        return;
    }

    try {
        const res = await fetch('/api/local/move-to-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri: item.uri })
        });

        if (res.ok) {
            // Reload whatever folder we are currently viewing
            if (browsePath && browsePath.length > 0 && selectedServerUdn) {
                await browse(selectedServerUdn, browsePath[browsePath.length - 1].id);
            }
        } else {
            const err = await res.json();
            alert('Failed to move file: ' + (err.error || 'Unknown error'));
        }
    } catch (e) {
        console.error(e);
        alert('Failed to move file: ' + e.message);
    }
}

async function moveFolderToTagsLocation(index, event) {
    if (event) event.stopPropagation();

    // Close the dropdown immediately
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));

    const item = currentBrowserItems[index];
    if (!item) return;

    if (!confirm(`Reimport "${item.title}"? Every track inside will be moved to match its own Artist/Album tags, same as a fresh import.`)) {
        return;
    }

    try {
        const res = await fetch('/api/local/move-folder-to-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Unknown error');

        const parts = [`${data.moved} moved`];
        if (data.skipped) parts.push(`${data.skipped} already correct`);
        if (data.duplicatesRemoved) parts.push(`${data.duplicatesRemoved} duplicates removed`);
        if (data.failed) parts.push(`${data.failed} failed`);
        showToast(`Reimported "${item.title}": ${parts.join(', ')}`, data.failed ? 'error' : 'success', 4000);
        if (data.failed && data.errors?.length) console.warn('[Reimport] Failures:', data.errors);

        // Reload whatever folder we are currently viewing (the moved-out folder may now be gone)
        if (browsePath && browsePath.length > 0 && selectedServerUdn) {
            await browse(selectedServerUdn, browsePath[browsePath.length - 1].id);
        }
    } catch (e) {
        console.error(e);
        showToast('Reimport failed: ' + e.message);
    }
}

async function identifyTracksFromFilename(index, event) {
    if (event) event.stopPropagation();

    // Close the dropdown immediately
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));

    const item = currentBrowserItems[index];
    if (!item) return;

    if (!confirm(`Scan "${item.title}" for mp3 files with missing Artist/Title/Album tags, guess artist/title from the filename, and confirm each guess against Discogs (requires internet and a Discogs token in Settings) before tagging? Files that already have tags are left untouched.`)) {
        return;
    }

    try {
        const res = await fetch('/api/local/identify-tags-from-filename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Unknown error');

        const parts = [`${data.tagged || 0} tagged`];
        if (data.alreadyTagged) parts.push(`${data.alreadyTagged} already tagged`);
        if (data.noMatch) parts.push(`${data.noMatch} unclear filename`);
        if (data.noResults) parts.push(`${data.noResults} not found on Discogs`);
        if (data.noTrackMatch) parts.push(`${data.noTrackMatch} no matching track`);
        if (data.ambiguous) parts.push(`${data.ambiguous} ambiguous match`);
        if (data.lookupError) parts.push(`${data.lookupError} lookup errors`);
        if (data.errors) parts.push(`${data.errors} failed`);
        const hadProblems = data.errors || data.lookupError;
        showToast(`Identify from filename in "${item.title}": ${parts.join(', ')}`, hadProblems ? 'error' : 'success', 5000);
        if (data.tagged) console.log('[IDENTIFY-TAGS] Tagged:', data.details);

        // Reload the current folder so newly-tagged titles/artists show up
        if (browsePath && browsePath.length > 0 && selectedServerUdn) {
            await browse(selectedServerUdn, browsePath[browsePath.length - 1].id);
        }
    } catch (e) {
        console.error(e);
        showToast('Identify from filename failed: ' + e.message);
    }
}

async function moveFolderPicturesToDateFolder(index, event) {
    if (event) event.stopPropagation();
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));

    const item = currentBrowserItems[index];
    if (!item) return;

    try {
        const res = await fetch('/api/local/move-folder-pictures-to-date', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ objectId: item.id })
        });

        const data = await res.json();
        if (res.ok) {
            const parts = [`Moved: ${data.moved}`];
            if (data.duplicates) parts.push(`Duplicates: ${data.duplicates}`);
            if (data.skipped) parts.push(`Skipped: ${data.skipped}`);
            if (data.failed) parts.push(`Failed: ${data.failed}`);
            showToast(parts.join(', '), data.failed ? 'error' : 'success', 4000);
            if (browsePath && browsePath.length > 0 && selectedServerUdn) {
                await browse(selectedServerUdn, browsePath[browsePath.length - 1].id);
            }
        } else {
            showToast('Failed: ' + (data.error || 'Unknown error'), 'error', 4000);
        }
    } catch (e) {
        console.error(e);
        showToast('Failed: ' + e.message, 'error', 4000);
    }
}

async function movePictureToDateFolder(index, event) {
    if (event) event.stopPropagation();
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));

    const item = currentBrowserItems[index];
    if (!item) return;

    try {
        const res = await fetch('/api/local/move-picture-to-date', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri: item.uri })
        });

        const data = await res.json();
        if (res.ok) {
            const msg = data.isDuplicate
                ? `Duplicate — moved to _deleted`
                : `Moved to ${data.year}/${data.month}`;
            showToast(msg, 'success', 3000);
            if (browsePath && browsePath.length > 0 && selectedServerUdn) {
                await browse(selectedServerUdn, browsePath[browsePath.length - 1].id);
            }
        } else {
            showToast('Failed: ' + (data.error || 'Unknown error'), 'error', 4000);
        }
    } catch (e) {
        console.error(e);
        showToast('Failed: ' + e.message, 'error', 4000);
    }
}

async function rotatePhotoFromBrowser(index) {
    const item = currentBrowserItems[index];
    if (!item || !item.uri) return;

    const current = manualRotations[item.uri] || 0;
    const next = (current + 90) % 360;

    // Update thumbnail in DOM immediately
    const browserItems = document.querySelectorAll('.browser-item');
    const el = browserItems[index];
    if (el) {
        const img = el.querySelector('.item-icon img');
        if (img) img.style.transform = next ? `rotate(${next}deg)` : '';
    }

    try {
        await fetch('/api/slideshow/rotate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: item.uri, rotation: next })
        });
        manualRotations[item.uri] = next;
    } catch (e) {
        showToast('Rotate failed: ' + e.message, 'error', 3000);
    }
}

function updatePhotoSelectionUI() {
    const count = selectedPhotos.size;

    const delBtn = document.getElementById('btn-delete-selected');
    if (delBtn) {
        delBtn.classList.toggle('disabled', count === 0);
        const label = delBtn.querySelector('.btn-label');
        if (label) label.textContent = `Delete (${count})`;
        delBtn.title = count > 0 ? `Delete ${count} selected photo${count > 1 ? 's' : ''}` : 'Delete selected photos';
    }

    const localCount = [...selectedPhotos].filter(u => u.includes('/local-files/')).length;

    const dateBtn = document.getElementById('btn-setdate-selected');
    if (dateBtn) {
        dateBtn.classList.toggle('disabled', localCount === 0);
        const label = dateBtn.querySelector('.btn-label');
        if (label) label.textContent = `Set Date (${localCount})`;
        dateBtn.title = localCount > 0 ? `Set created date on ${localCount} local photo${localCount > 1 ? 's' : ''}` : 'Set created date (local photos only)';
    }

}

function togglePhotoSelection(uri, index) {
    if (selectedPhotos.has(uri)) {
        selectedPhotos.delete(uri);
    } else {
        selectedPhotos.add(uri);
    }
    const selected = selectedPhotos.has(uri);
    const el = document.querySelector(`.browser-item[data-item-index="${index}"]`);
    if (el) {
        el.classList.toggle('photo-selected', selected);
        const btn = el.querySelector('.photo-select-btn');
        if (btn) {
            btn.classList.toggle('active', selected);
            btn.title = selected ? 'Deselect photo' : 'Select photo';
            const svg = btn.querySelector('svg');
            if (svg) svg.setAttribute('fill', selected ? 'currentColor' : 'none');
        }
    }
    updatePhotoSelectionUI();
}

async function deleteSelectedPhotos() {
    if (selectedPhotos.size === 0) return;
    const uris = [...selectedPhotos];
    let successCount = 0;
    let failCount = 0;
    for (const uri of uris) {
        try {
            const res = await fetch('/api/local/photo-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uri })
            });
            if (res.ok) successCount++;
            else failCount++;
        } catch (e) {
            failCount++;
        }
    }
    selectedPhotos.clear();
    if (successCount > 0) showToast(`Moved ${successCount} photo${successCount > 1 ? 's' : ''} to _deleted`, 'success', 2000);
    if (failCount > 0) showToast(`Failed to delete ${failCount} photo${failCount > 1 ? 's' : ''}`, 'error', 4000);
    if (browsePath && browsePath.length > 0 && selectedServerUdn) {
        await browse(selectedServerUdn, browsePath[browsePath.length - 1].id);
    }
}

async function setDateSelectedPhotos() {
    const localUris = [...selectedPhotos].filter(u => u.includes('/local-files/'));
    if (localUris.length === 0) return;

    const date = prompt(`Set created date for ${localUris.length} photo${localUris.length > 1 ? 's' : ''} (YYYY-MM-DD):`);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        if (date !== null) showToast('Invalid date — use YYYY-MM-DD format', 'error', 3000);
        return;
    }

    let successCount = 0;
    let failCount = 0;
    for (const url of localUris) {
        try {
            const res = await fetch('/api/slideshow/set-date', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, date })
            });
            if (res.ok) successCount++;
            else failCount++;
        } catch (e) {
            failCount++;
        }
    }

    if (successCount > 0) showToast(`Date set on ${successCount} photo${successCount > 1 ? 's' : ''}`, 'success', 2000);
    if (failCount > 0) showToast(`Failed on ${failCount} photo${failCount > 1 ? 's' : ''}`, 'error', 4000);
}

async function dateFolderSelectedPhotos() {
    const localUris = [...selectedPhotos].filter(u => u.includes('/local-files/'));
    if (localUris.length === 0) return;

    let successCount = 0, failCount = 0, dupCount = 0;
    for (const uri of localUris) {
        try {
            const res = await fetch('/api/local/move-picture-to-date', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uri })
            });
            const data = await res.json();
            if (res.ok) {
                if (data.isDuplicate) dupCount++;
                else successCount++;
            } else {
                failCount++;
            }
        } catch (e) {
            failCount++;
        }
    }

    selectedPhotos.clear();
    updatePhotoSelectionUI();

    const parts = [];
    if (successCount > 0) parts.push(`${successCount} moved`);
    if (dupCount > 0) parts.push(`${dupCount} duplicate${dupCount > 1 ? 's' : ''} deleted`);
    if (failCount > 0) parts.push(`${failCount} failed`);
    showToast(parts.join(', '), failCount > 0 ? 'error' : 'success', 3000);

    if (browsePath && browsePath.length > 0 && selectedServerUdn) {
        await browse(selectedServerUdn, browsePath[browsePath.length - 1].id);
    }
}

async function deletePhotoFromBrowser(index, event) {
    if (event) event.stopPropagation();

    const item = currentBrowserItems[index];
    if (!item) return;

    try {
        const res = await fetch('/api/local/photo-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri: item.uri })
        });

        const data = await res.json();
        if (res.ok) {
            showToast('Moved to _deleted', 'success', 2000);
            if (browsePath && browsePath.length > 0 && selectedServerUdn) {
                await browse(selectedServerUdn, browsePath[browsePath.length - 1].id);
            }
        } else {
            showToast('Failed: ' + (data.error || 'Unknown error'), 'error', 4000);
        }
    } catch (e) {
        showToast('Failed: ' + e.message, 'error', 4000);
    }
}

function closeFileInfoModal() {
    const modal = document.getElementById('track-info-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

async function saveTrackTag(field, btn) {
    const cell = btn.closest('.metadata-editable-cell');
    const input = cell.querySelector('.metadata-edit-input');
    const value = input.value.trim();

    btn.disabled = true;
    btn.textContent = '...';

    try {
        const res = await fetch('/api/local/write-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri: currentInfoUri, [field]: value })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed');
        }
        btn.textContent = 'Saved!';
        btn.style.color = '#4ade80';
        setTimeout(() => { btn.textContent = 'Save'; btn.style.color = ''; btn.disabled = false; }, 2000);
    } catch (e) {
        btn.textContent = 'Error';
        btn.style.color = '#f87171';
        setTimeout(() => { btn.textContent = 'Save'; btn.style.color = ''; btn.disabled = false; }, 2000);
        showToast(`Failed to save ${field}: ${e.message}`, 'error');
    }
}

async function savePhotoDate(btn) {
    const cell = btn.closest('.metadata-editable-cell');
    const input = cell.querySelector('.metadata-edit-input');
    const value = input.value;
    if (!value) return;

    btn.disabled = true;
    btn.textContent = '...';

    try {
        const res = await fetch('/api/slideshow/set-date', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: currentInfoUri, date: value })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed');
        }
        btn.textContent = 'Saved!';
        btn.style.color = '#4ade80';
        setTimeout(() => { btn.textContent = 'Save'; btn.style.color = ''; btn.disabled = false; }, 2000);
    } catch (e) {
        btn.textContent = 'Error';
        btn.style.color = '#f87171';
        setTimeout(() => { btn.textContent = 'Save'; btn.style.color = ''; btn.disabled = false; }, 2000);
        showToast(`Failed to save date: ${e.message}`, 'error');
    }
}

function updateTagSuggestions() {
    const input = document.getElementById('new-tag-input');
    const container = document.getElementById('tag-suggestions');
    if (!input || !container) return;

    const val = input.value.trim().toLowerCase();

    // Filter all library tags that match input AND aren't already on this file
    // If val is empty, we just show all tags not already on this file
    const matches = allLibraryTags.filter(tag => {
        const notApplied = !currentFileTags.includes(tag);
        if (!val) return notApplied;
        return notApplied && tag.toLowerCase().includes(val);
    }).slice(0, 20); // Show more when browsing (up to 20)

    if (matches.length === 0) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
    }

    container.style.display = 'flex';
    container.innerHTML = matches.map(tag => `
        <div class="tag-suggestion" onclick="addSuggestion('${tag.replace(/'/g, "\\'")}')">
            ${tag}
        </div>
    `).join('');
}

async function addSuggestion(tag) {
    const input = document.getElementById('new-tag-input');
    if (input) input.value = tag;
    await addFileTag();
}

async function addFileTag() {
    const input = document.getElementById('new-tag-input');
    if (!input) return;
    const tag = input.value.trim();
    if (!tag || !currentInfoUri) return;

    if (currentFileTags.includes(tag)) {
        input.value = '';
        updateTagSuggestions();
        return;
    }

    currentFileTags.push(tag);
    input.value = '';
    updateFileFavUI();
    renderFileTags();
    updateTagSuggestions();
    await saveFileTags();
}

async function removeFileTag(tag) {
    currentFileTags = currentFileTags.filter(t => t !== tag);
    updateFileFavUI();
    renderFileTags();
    updateTagSuggestions();
    await saveFileTags();
}

function renderFileTags() {
    const container = document.getElementById('file-tags-container');
    if (!container) return;

    container.innerHTML = currentFileTags.map(tag => `
        <div class="tag-badge">
            ${tag}
            <span class="tag-remove" onclick="removeFileTag('${tag.replace(/'/g, "\\'")}')">✕</span>
        </div>
    `).join('');
}

function updateFileFavUI() {
    const btn = document.getElementById('file-fav-btn');
    if (!btn) return;
    const isFav = currentFileTags.includes('fav');
    if (isFav) {
        btn.classList.add('active');
    } else {
        btn.classList.remove('active');
    }
}

async function toggleFileFav() {
    if (!currentInfoUri) return;

    const index = currentFileTags.indexOf('fav');
    if (index === -1) {
        currentFileTags.push('fav');
    } else {
        currentFileTags.splice(index, 1);
    }

    updateFileFavUI();
    renderFileTags();
    await saveFileTags();
}

async function saveFileTags() {
    if (!currentInfoUri) return;
    try {
        await fetch('/api/file-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri: currentInfoUri, tags: currentFileTags })
        });
    } catch (err) {
        console.error('Failed to save tags:', err);
    }
}

async function copyTagToFolderAll(field, btn) {
    const cell = btn.closest('.metadata-editable-cell');
    const input = cell.querySelector('.metadata-edit-input');
    const value = input.value.trim();
    if (!value || !currentInfoUri) return;

    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = '...';

    try {
        const res = await fetch('/api/local/write-tags-to-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri: currentInfoUri, field, value })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        const { updated } = await res.json();
        btn.textContent = 'Done!';
        btn.style.color = '#4ade80';
        showToast(`${field} copied to ${updated} track${updated !== 1 ? 's' : ''} in folder`, 'success', 3000);
        setTimeout(() => { btn.textContent = origText; btn.style.color = ''; btn.disabled = false; }, 2000);
    } catch (err) {
        btn.textContent = origText;
        btn.disabled = false;
        showToast(`Copy failed: ${err.message}`);
    }
}

/**
 * Synchronously checks if a track's folder structure (Artist/Album/Track)
 * conflicts with its Media Server metadata. Returns true if so.
 */
function detectFolderMismatch(item) {
    if (!item || !item.uri) return false;
    // Only meaningful for audio files
    const isAudio = !(item.class && (item.class.includes('imageItem') || item.class.includes('videoItem') || item.class.includes('container')));
    if (!isAudio) return false;

    try {
        const uriPath = decodeURIComponent(new URL(item.uri).pathname);
        const cleanPath = uriPath.replace(/^\/local-files\//, '').replace(/^\//, '');
        const parts = cleanPath.split('/').filter(p => p);
        if (parts.length < 3) return false;

        const folderArtist = parts[parts.length - 3];
        const folderAlbum = parts[parts.length - 2];

        const norm = (v) => (v || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

        const normFolderArtist = norm(folderArtist);
        const artistMismatch = normFolderArtist
            && (item.artist || item.albumArtist)
            && normFolderArtist !== norm(item.artist)
            && normFolderArtist !== norm(item.albumArtist);
        const albumMismatch = item.album && norm(folderAlbum) && norm(folderAlbum) !== norm(item.album);

        return !!(artistMismatch || albumMismatch);
    } catch (e) {
        return false;
    }
}

function showFileInfoFromBrowser(index) {
    const item = currentBrowserItems[index];
    if (item) {
        openFileInfoModal(item);
    }
}

function showFileInfoFromPlaylist(id) {
    const item = currentPlaylistItems.find(i => i.id == id);
    if (item) {
        openFileInfoModal(item);
    }
}

// Slideshow class is in slideshow.js

function retryAlbumArt() {
    const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);
    if (!currentTrack) return;

    document.getElementById('art-search-album-artist').value = currentTrack.albumArtist || '';
    document.getElementById('art-search-artist').value = currentTrack.artist || '';
    document.getElementById('art-search-album').value = currentTrack.album || '';
    document.getElementById('art-search-modal').dataset.uri = currentTrack.uri || '';
    document.getElementById('art-search-results').style.display = 'none';
    document.getElementById('art-search-results-list').innerHTML = '';
    document.getElementById('art-search-modal').style.display = 'flex';
    document.getElementById('art-search-album-artist').focus();
}

function closeArtSearchModal() {
    document.getElementById('art-search-modal').style.display = 'none';
    document.getElementById('art-search-results').style.display = 'none';
    document.getElementById('art-search-results-list').innerHTML = '';
}

async function submitArtSearch() {
    const albumArtist = document.getElementById('art-search-album-artist').value.trim();
    const artist = document.getElementById('art-search-artist').value.trim();
    const album = document.getElementById('art-search-album').value.trim();
    const uri = document.getElementById('art-search-modal').dataset.uri || '';

    const btn = document.getElementById('btn-art-search-submit');
    const resultsList = document.getElementById('art-search-results-list');
    const resultsPanel = document.getElementById('art-search-results');

    if (btn) btn.disabled = true;
    resultsList.innerHTML = '';
    resultsPanel.style.display = 'block';

    const loadingEl = document.createElement('div');
    loadingEl.style.cssText = 'padding:1rem;text-align:center;opacity:0.6;';
    loadingEl.textContent = 'Searching Discogs…';
    resultsList.appendChild(loadingEl);

    try {
        const params = new URLSearchParams();
        if (albumArtist) params.set('albumArtist', albumArtist);
        if (artist) params.set('artist', artist);
        if (album) params.set('album', album);
        if (uri) params.set('uri', uri);

        const res = await fetch(`/api/art/candidates?${params}`);
        resultsList.innerHTML = '';

        if (!res.ok) {
            resultsList.innerHTML = '<div style="padding:1rem;opacity:0.6;">Search failed.</div>';
            return;
        }

        const data = await res.json();
        if (!data.candidates || data.candidates.length === 0) {
            resultsList.innerHTML = '<div style="padding:1rem;opacity:0.6;">No results found.</div>';
            return;
        }

        for (const candidate of data.candidates) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:0.75rem;align-items:center;cursor:pointer;padding:0.5rem;border-radius:6px;transition:background 0.15s;';
            row.onmouseenter = () => row.style.background = 'var(--card-hover, rgba(255,255,255,0.07))';
            row.onmouseleave = () => row.style.background = '';

            const img = document.createElement('img');
            img.src = candidate.thumb;
            img.style.cssText = 'width:56px;height:56px;object-fit:cover;border-radius:4px;flex-shrink:0;background:var(--card-bg);';
            img.onerror = () => { img.style.display = 'none'; };

            const info = document.createElement('div');
            info.style.cssText = 'min-width:0;flex:1;';
            const title = document.createElement('div');
            title.style.cssText = 'font-size:0.9rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            title.textContent = candidate.title;
            const sub = document.createElement('div');
            sub.style.cssText = 'font-size:0.75rem;opacity:0.55;margin-top:2px;';
            sub.textContent = [candidate.year, candidate.format].filter(Boolean).join(' · ');
            info.appendChild(title);
            info.appendChild(sub);

            row.appendChild(img);
            row.appendChild(info);

            const coverUrl = candidate.coverImage;
            row.onclick = () => selectArtCandidate(coverUrl, artist, album, uri);
            resultsList.appendChild(row);
        }
    } catch (e) {
        resultsList.innerHTML = '<div style="padding:1rem;opacity:0.6;">Search failed.</div>';
        console.warn('[ART] Candidates search failed:', e);
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function selectArtCandidate(coverUrl, artist, album, uri) {
    const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);
    const trackUri = uri || currentTrack?.uri || '';
    const trackArtist = artist || currentTrack?.artist || '';
    const trackAlbum = album || currentTrack?.album || '';

    closeArtSearchModal();

    try {
        const res = await fetch('/api/art/cache-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ artist: trackArtist, album: trackAlbum, coverUrl })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        currentArtworkUrl = data.url;
        const query = `${trackArtist} ${trackAlbum}`.trim();
        currentArtworkQuery = query;
        failedArtworkQueries.delete(query);
        if (trackUri) {
            artworkOverrides.set(trackUri, data.url);
            localStorage.setItem('artworkOverrides', JSON.stringify([...artworkOverrides]));
        }
        showPlayerArt(data.url);
        if (slideshow && slideshow.isActive && slideshow.mode === 'nowPlaying') {
            slideshow.next();
        }
    } catch (e) {
        console.warn('[ART] Select candidate failed:', e);
        showToast('Failed to save artwork', 'error', 3000);
    }
}

// Slideshow music bar: play/pause toggle
function toggleSlideshowPlayback(event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    if (currentTransportState === 'Playing') {
        transportAction('pause');
    } else {
        transportAction('play');
    }
}


function manualStartSlideshow() {
    if (slideshow) slideshow.start();
}

async function startPhotoSlideshow(u, t, d, l, fid, ft) {
    if (slideshow) {
        // Find current images to allow navigation
        const images = currentBrowserItems.filter(item => isImageItem(item));
        if (images.length > 0) {
            const index = images.findIndex(img => img.uri === u);
            if (index !== -1) {
                // slideshow.start calls slideshow.next() which increments the index.
                // To start at index, we must pass index - 1.
                slideshow.start(images, index - 1);
                return;
            }
        }
        await slideshow.startPhoto(u, t, d, l, fid, ft);
    }
}

function startMusicSlideshow() {
    if (currentArtworkUrl && slideshow) {
        slideshow.mode = 'nowPlaying';
        localStorage.setItem('screensaverMode', 'nowPlaying');
        slideshow.updateModeUI();
        slideshow.start();
    } else {
        showToast('No artwork available', 'info', 2000);
    }
}

async function goToScreensaverFolder() {
    if (slideshow) await slideshow.gotoFolder();
}




function fmtBytes(bytes) {
    if (bytes === null || bytes === undefined) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function loadLocalStats() {
    const el = document.getElementById('local-stats-content');
    if (!el) return;
    try {
        const res = await fetch('/api/local-stats');
        if (!res.ok) throw new Error('Failed');
        const { music, photos, freeBytes } = await res.json();
        el.innerHTML = `
            <span class="local-stats-label">Tracks</span>
            <span class="local-stats-value">${music.count.toLocaleString()}</span>
            <span class="local-stats-label">Music size</span>
            <span class="local-stats-value">${fmtBytes(music.bytes)}</span>
            <hr class="local-stats-divider">
            <span class="local-stats-label">Photos</span>
            <span class="local-stats-value">${photos.count.toLocaleString()}</span>
            <span class="local-stats-label">Photos size</span>
            <span class="local-stats-value">${fmtBytes(photos.bytes)}</span>
            <hr class="local-stats-divider">
            <span class="local-stats-label">Free disk space</span>
            <span class="local-stats-value">${fmtBytes(freeBytes)}</span>
        `;
    } catch (e) {
        el.innerHTML = '<span class="settings-hint">Could not load stats.</span>';
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

async function exportFavourites() {
    try {
        const response = await fetch('/api/favourites/export');
        if (!response.ok) throw new Error('Export failed');
        const data = await response.json();

        if (!data.favourites.length) {
            showToast('No favourites to export', 'warning', 3000);
            return;
        }

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ammui-favourites-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        showToast(`Exported ${data.favourites.length} favourite${data.favourites.length === 1 ? '' : 's'}`, 'success', 2500);
    } catch (err) {
        console.error('Failed to export favourites:', err);
        showToast('Failed to export favourites');
    }
}

async function importFavourites(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;

    try {
        const text = await file.text();
        const data = JSON.parse(text);
        const favourites = Array.isArray(data) ? data : data.favourites;
        if (!Array.isArray(favourites)) throw new Error('Not a valid favourites file');

        const response = await fetch('/api/favourites/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favourites })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Import failed');

        let msg = `Imported ${result.added} favourite${result.added === 1 ? '' : 's'}`;
        const extras = [];
        if (result.fixed) extras.push(`${result.fixed} path${result.fixed === 1 ? '' : 's'} fixed up`);
        if (result.ambiguous) extras.push(`${result.ambiguous} ambiguous match${result.ambiguous === 1 ? '' : 'es'}`);
        if (result.alreadyFav) extras.push(`${result.alreadyFav} already favourited`);
        if (result.missing) extras.push(`${result.missing} not found locally`);
        if (result.invalid) extras.push(`${result.invalid} invalid`);
        if (extras.length) msg += ` (${extras.join(', ')})`;
        showToast(msg, 'success', 4000);
    } catch (err) {
        console.error('Failed to import favourites:', err);
        showToast('Failed to import favourites: ' + err.message);
    }
}

async function exportDeleted() {
    try {
        const response = await fetch('/api/deleted/export');
        if (!response.ok) throw new Error('Export failed');
        const data = await response.json();

        if (!data.deleted.length) {
            showToast('No deleted photos to export', 'warning', 3000);
            return;
        }

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ammui-deleted-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        showToast(`Exported ${data.deleted.length} deleted photo${data.deleted.length === 1 ? '' : 's'}`, 'success', 2500);
    } catch (err) {
        console.error('Failed to export deleted photos:', err);
        showToast('Failed to export deleted photos');
    }
}

async function importDeleted(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;

    try {
        const text = await file.text();
        const data = JSON.parse(text);
        const deleted = Array.isArray(data) ? data : data.deleted;
        if (!Array.isArray(deleted)) throw new Error('Not a valid deleted-photos file');

        const response = await fetch('/api/deleted/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deleted })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Import failed');

        let msg = `Imported ${result.added} deleted photo${result.added === 1 ? '' : 's'}`;
        const extras = [];
        if (result.fixed) extras.push(`${result.fixed} path${result.fixed === 1 ? '' : 's'} fixed up`);
        if (result.ambiguous) extras.push(`${result.ambiguous} ambiguous match${result.ambiguous === 1 ? '' : 'es'}`);
        if (result.alreadyDeleted) extras.push(`${result.alreadyDeleted} already deleted`);
        if (result.missing) extras.push(`${result.missing} not found locally`);
        if (result.invalid) extras.push(`${result.invalid} invalid`);
        if (extras.length) msg += ` (${extras.join(', ')})`;
        showToast(msg, 'success', 4000);
    } catch (err) {
        console.error('Failed to import deleted photos:', err);
        showToast('Failed to import deleted photos: ' + err.message);
    }
}

async function exportTags() {
    try {
        const response = await fetch('/api/tags/export');
        if (!response.ok) throw new Error('Export failed');
        const data = await response.json();

        if (!data.tags.length) {
            showToast('No tags to export', 'warning', 3000);
            return;
        }

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ammui-tags-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        showToast(`Exported tags for ${data.tags.length} file${data.tags.length === 1 ? '' : 's'}`, 'success', 2500);
    } catch (err) {
        console.error('Failed to export tags:', err);
        showToast('Failed to export tags');
    }
}

async function importTags(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;

    try {
        const text = await file.text();
        const data = JSON.parse(text);
        const tags = Array.isArray(data) ? data : data.tags;
        if (!Array.isArray(tags)) throw new Error('Not a valid tags file');

        const response = await fetch('/api/tags/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Import failed');

        let msg = `Imported ${result.tagsAdded} tag${result.tagsAdded === 1 ? '' : 's'} on ${result.filesProcessed} file${result.filesProcessed === 1 ? '' : 's'}`;
        const extras = [];
        if (result.fixed) extras.push(`${result.fixed} path${result.fixed === 1 ? '' : 's'} fixed up`);
        if (result.ambiguous) extras.push(`${result.ambiguous} ambiguous match${result.ambiguous === 1 ? '' : 'es'}`);
        if (result.alreadyPresent) extras.push(`${result.alreadyPresent} already tagged`);
        if (result.missing) extras.push(`${result.missing} not found locally`);
        if (result.invalid) extras.push(`${result.invalid} invalid`);
        if (extras.length) msg += ` (${extras.join(', ')})`;
        showToast(msg, 'success', 4000);
    } catch (err) {
        console.error('Failed to import tags:', err);
        showToast('Failed to import tags: ' + err.message);
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
    document.title = `${currentDeviceName}`;
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
        const fieldsContainer = document.getElementById('s3-settings-fields');
        if (fieldsContainer) {
            fieldsContainer.style.display = data.enabled ? 'block' : 'none';
        }
        if (data.enabled) {
            updateS3Status(); // Fetch status once to initialize UI, but don't poll until modal is opened
        } else {
            stopS3StatusPolling(); // Safety measure
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
            const fieldsContainer = document.getElementById('s3-settings-fields');
            if (fieldsContainer) fieldsContainer.style.display = enabled ? 'block' : 'none';
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

function openS3SyncLogModal() {
    const modal = document.getElementById('s3-sync-log-modal');
    if (modal) modal.style.display = 'flex';
    loadS3SyncLog();
}

function closeS3SyncLogModal() {
    const modal = document.getElementById('s3-sync-log-modal');
    if (modal) modal.style.display = 'none';
}

async function loadS3SyncLog() {
    const contentEl = document.getElementById('s3-sync-log-content');
    if (!contentEl) return;
    contentEl.textContent = 'Loading...';
    try {
        const response = await fetch('/api/sync/s3/log');
        const data = await response.json();
        if (!data.exists || !data.log) {
            contentEl.textContent = 'No sync has been run yet.';
        } else {
            contentEl.textContent = data.log;
            contentEl.scrollTop = contentEl.scrollHeight;
        }
    } catch (err) {
        console.error('Failed to load S3 sync log:', err);
        contentEl.textContent = 'Failed to load sync log.';
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




// Update functions
async function checkForUpdates() {
    const statusText = document.getElementById('update-status-text');
    if (statusText) statusText.textContent = 'Checking...';
    try {
        const res = await fetch('/api/updates/check');
        if (!res.ok) throw new Error('Check failed');
        const data = await res.json();
        if (statusText) {
            statusText.textContent = data.available
                ? `${data.behind} commit${data.behind !== 1 ? 's' : ''} behind`
                : 'Up to date';
        }
    } catch (err) {
        if (statusText) statusText.textContent = 'Check failed';
        console.error('Update check failed:', err);
    }
}

async function performUpdate() {
    const updateBtn = document.getElementById('btn-update-now');
    const progressContainer = document.getElementById('update-progress-container');
    const progressText = document.getElementById('update-progress-text');
    const progressBar = document.getElementById('update-progress-bar');

    if (updateBtn) updateBtn.disabled = true;
    if (progressContainer) progressContainer.style.display = 'block';
    if (progressText) progressText.textContent = 'Running git pull...';
    if (progressBar) progressBar.style.width = '30%';

    try {
        const response = await fetch('/api/updates/apply', { method: 'POST' });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.message && progressText) progressText.textContent = data.message;
                    if (data.progress !== null && progressBar) progressBar.style.width = `${data.progress}%`;
                    if (data.error) throw new Error(data.error);
                    if (data.complete) {
                        if (progressBar) progressBar.style.width = '100%';
                        showToast('Update complete — reloading...', 'success', 5000);
                        setTimeout(() => window.location.reload(), 3000);
                        return;
                    }
                } catch (e) {
                    if (e.message !== 'Unexpected end of JSON input') throw e;
                }
            }
        }
    } catch (err) {
        console.error('Update failed:', err);
        if (progressText) progressText.textContent = `Failed: ${err.message}`;
        showToast(`Update failed: ${err.message}`, 'error', 5000);
    } finally {
        if (updateBtn) updateBtn.disabled = false;
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
