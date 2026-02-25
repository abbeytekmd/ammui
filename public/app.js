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
let browseScrollPositions = {}; // Store scroll position by folder ID
let rendererFailureCount = 0;
const MAX_RENDERER_FAILURES = 2;
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
        if (autoSwitch && window.innerWidth <= 1100) {
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

async function playPlaylistItem(id) {
    if (!selectedRendererUdn) return;
    if (isRendererOffline) return; // Silently ignore when offline

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

    const showMusicControls = tracks.length > 0;
    const hasContainers = items.some(item => item.type === 'container');
    const showPhotoControls = images.length > 0 || (currentBrowserMode === 'photo' && hasContainers);

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
            icon = `<img src="${escThumb}" loading="lazy" alt="" data-thumb-url="${escThumb}">`;
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

        const esc = (s) => (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const isLocalServer = selectedServerUdn === LOCAL_SERVER_UDN;

        return `
            <div ${letterIdAttr} class="playlist-item browser-item ${isContainer ? 'folder' : 'file'}" 
                 onclick="${isContainer ?
                `enterFolder('${item.id}', '${esc(item.title)}')` :
                isImage ?
                    `event.stopPropagation(); startPhotoSlideshow('${esc(item.uri)}', '${esc(item.title)}', '${esc(item.date)}', '${esc(item.artist)}', '${esc(item.parentID)}', '${esc(pathStr)}')` :
                    isVideo ?
                        `handleVideoClick('${esc(item.uri)}', '${esc(item.title)}', '${esc(item.artist)}', '${esc(item.album)}', '${esc(item.duration)}', '${esc(item.protocolInfo)}', ${index})` :
                        `playTrack('${esc(item.uri)}', '${esc(item.title)}', '${esc(item.artist)}', '${esc(item.album)}', '${esc(item.duration)}', '${esc(item.protocolInfo)}')`}">
                <div class="item-icon">${icon}</div>
                <div class="item-info">
                    <div class="item-title">${item.title}</div>
                </div>
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
                    <button class="btn-control play-btn" onclick="event.stopPropagation(); ${currentBrowserMode === 'photo' ? `playFolderSlideshow('${esc(item.id)}', '${esc(item.title)}')` : `playFolder('${esc(item.id)}', '${esc(item.title)}')`}" title="${currentBrowserMode === 'photo' ? 'Start slideshow of this folder' : 'Play Whole Folder Recursively'}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="${currentBrowserMode === 'photo' ? 'none' : 'currentColor'}" stroke="currentColor" stroke-width="2">
                            ${currentBrowserMode === 'photo' ?
                '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>' :
                '<path d="M8 5v14l11-7z"></path>'}
                        </svg>
                        <span class="btn-label" data-mobile="">${currentBrowserMode === 'photo' ? 'Slideshow' : 'Play'}</span>
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

async function fetchStatus() {
    if (!selectedRendererUdn || isRendererOffline) return;
    try {
        const response = await fetch(`/api/playlist/${encodeURIComponent(selectedRendererUdn)}/status`);
        if (!response.ok) throw new Error('Failed to fetch status');
        const status = await response.json();
        updateStatus(status);
        rendererFailureCount = 0;
        setRendererOffline(false, 'fetchStatus');
    } catch (err) {
        console.error(`Status fetch error for ${selectedRendererUdn}:`, err);
        setRendererOffline(true, 'fetchStatus');
    }
}

function updateStatus(status) {
    const now = Date.now();
    const isLocked = (now - lastTransportActionTime) < 3000; // 3 second lockout

    const trackChanged = status.trackId !== currentTrackId;
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

            // Only fetch if query changed and hasn't failed before
            if (query && query !== currentArtworkQuery && !failedArtworkQueries.has(query)) {
                updatePlayerArtwork(currentTrack.artist, currentTrack.album);
            }
        } else {
            updateCardNowPlaying();
        }
    } else {
        updateCardNowPlaying();
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

            // Trigger screensaver update if in music mode
            if (slideshow && slideshow.isActive && slideshow.mode === 'nowPlaying') {
                slideshow.next();
            }
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
        img.onerror = (err) => {
            console.error(`[ART] Failed to load image element ${idx}: ${url}`);
            if (containers[idx]) containers[idx].classList.remove('visible');
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
    }
}

function closeManageModal() {
    if (manageModal) manageModal.style.display = 'none';
}

function switchSettingsTab(tab) {
    // Update tab buttons
    document.querySelectorAll('.settings-tab').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.trim().toLowerCase() === tab.toLowerCase());
    });
    // Update panels
    document.querySelectorAll('.settings-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `settings-${tab}`);
    });
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

                </div>
                ${(!asServer && isStatic) ? `
                    <div class="device-now-playing" id="card-now-playing">
                        <div class="card-track-title"></div>
                        <div class="card-track-artist-album"></div>
                    </div>
                ` : ''}
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
    const layout = document.querySelector('.main-layout');
    const floatingBtn = document.getElementById('floating-nav-btn');

    if (view === 'playlist') {
        playerCol ? playerCol.classList.add('active') : null;
        browserCol ? browserCol.classList.remove('active') : null;
        if (layout) layout.classList.add('show-playlist');
        if (floatingBtn) floatingBtn.classList.add('on-left');
    } else {
        playerCol ? playerCol.classList.remove('active') : null;
        browserCol ? browserCol.classList.add('active') : null;
        if (layout) layout.classList.remove('show-playlist');
        if (floatingBtn) floatingBtn.classList.remove('on-left');
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

    // Update Tab UI
    document.querySelectorAll('.browser-tab').forEach(btn => {
        btn.classList.remove('active');
    });

    const activeTabId = mode === 'music' ? 'tab-browser-music' : 'tab-browser-photo';
    const activeTab = document.getElementById(activeTabId);
    if (activeTab) activeTab.classList.add('active');

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
    if (ssModeLabel && slideshow) {
        if (slideshow.mode === 'all') ssModeLabel.textContent = 'All';
        else if (slideshow.mode === 'onThisDay') ssModeLabel.textContent = 'Day';
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
            document.querySelectorAll('.browser-tab').forEach(btn => btn.classList.remove('active'));
            const activeTabId = mode === 'music' ? 'tab-browser-music' : 'tab-browser-photo';
            const activeTab = document.getElementById(activeTabId);
            if (activeTab) activeTab.classList.add('active');

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
        switchView(savedView);
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
                { label: 'Location', sKey: '', eKey: 'format.latitude' }
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

// Idle Screensaver Logic - Now handled by Slideshow class
let currentScreensaverFolder = null; // Used for folder navigation

class Slideshow {
    constructor() {
        this.items = [];
        this.index = -1;
        this.isActive = false;
        this.interval = null;
        this.timer = null;
        this.currentPhoto = null;
        this.currentPhotoData = null;
        this.previousPhoto = null;
        this.rotation = 0;
        this.mode = localStorage.getItem('screensaverMode') || 'all';
        this.duration = 60000;
        this.idleTimeout = 60000;

        // UI binds
        this.overlay = document.getElementById('screensaver-overlay');
        this.img = document.getElementById('screensaver-img');
        this.bg = document.getElementById('screensaver-bg');
        this.info = document.getElementById('screensaver-info');
        this.favBtn = document.getElementById('btn-ss-favourite');
        this.modeLabel = document.getElementById('ss-mode-label');
        this.mapWindow = document.getElementById('ss-map-window');
        this.leafletMap = null;
        this.leafletMarker = null;
    }

    init() {
        // Activity listeners for idle timer
        ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(name => {
            window.addEventListener(name, (e) => this.resetIdleTimer(e), { passive: true });
        });
        this.resetIdleTimer();
        this.updateModeUI();
    }

    resetIdleTimer(e) {
        // Don't stop if it's just mouse move, but DO reset the timer
        const isMouseMove = e && e.type === 'mousemove';

        if (this.isActive && !isMouseMove) {
            // Stop if user interacts (clicks/keys) while active
            // BUT ignore if interacting with screensaver controls or triggers
            if (e && e.target && e.target.closest && (
                e.target.closest('.screensaver-controls') ||
                e.target.closest('.screensaver-music-bar') ||
                e.target.closest('.ss-volume-popover') ||
                e.target.closest('.screensaver-info') ||
                e.target.closest('.ss-map-window') ||
                e.target.closest('#btn-start-slideshow') ||
                e.target.closest('#btn-play-all') ||
                e.target.closest('.playlist-item')
            )) {
                return;
            }
            this.stop();
        }

        clearTimeout(this.timer);
        if (!this.isActive) {
            const isVideoVisible = document.getElementById('video-modal')?.style.display === 'flex';
            if (!isVideoVisible) {
                this.timer = setTimeout(() => {
                    // Start in music mode if music is playing
                    if (currentTransportState === 'Playing' && currentArtworkUrl) {
                        this.mode = 'nowPlaying';
                        this.updateModeUI();
                    }
                    this.start();
                }, this.idleTimeout);
            }
        }
    }

    async start(items = null, index = -1) {
        if (this.isActive) {
            if (items) {
                this.items = items;
                this.index = index;
                await this.next();
            }
            return;
        }

        // Config check
        if (!items && this.mode !== 'nowPlaying' && (!screensaverConfig.serverUdn || !screensaverConfig.objectId)) {
            // Only show toast if it was a manual start attempt without items
            if (items === null) showToast('Screensaver source not configured.', 'info', 5000);
            return;
        }

        console.log('[SLIDESHOW] Starting...');
        this.isActive = true;
        this.items = items || [];
        this.index = index;

        if (this.overlay) {
            this.overlay.style.display = 'flex';
            setTimeout(() => this.overlay.classList.add('active'), 0);
        }

        if (this.info) {
            this.info.style.cursor = 'pointer';
            this.info.onclick = (e) => {
                e.stopPropagation();
                this.gotoFolder();
            };
        }

        await this.next();
    }

    stop() {
        if (!this.isActive) return;
        console.log('[SLIDESHOW] Stopping...');
        this.isActive = false;
        this.items = [];
        this.index = -1;

        if (this.interval) clearInterval(this.interval);

        if (this.overlay) {
            this.overlay.classList.remove('active');
            const popover = document.getElementById('ss-volume-popover');
            if (popover) popover.classList.remove('active');
            setTimeout(() => {
                if (!this.isActive) this.overlay.style.display = 'none';
            }, 500);
        }
        this.resetIdleTimer();
    }

    resetInterval() {
        if (this.interval) clearInterval(this.interval);
        if (this.isActive) {
            this.interval = setInterval(() => this.next(), this.duration);
        }
    }

    async next() {
        try {
            let data;
            if (this.items.length > 0) {
                this.index = (this.index + 1) % this.items.length;
                const item = this.items[this.index];
                data = {
                    url: item.uri || item.res,
                    title: item.title,
                    date: item.year || item.date || item['dc:date'] || '',
                    location: item.artist || item.creator || '',
                    latitude: item.latitude,
                    longitude: item.longitude,
                    camera: item.camera || '',
                    manualRotation: manualRotations[item.uri || item.res] || 0,
                    folderId: item.folderId || (browsePath.length > 0 ? browsePath[browsePath.length - 1].id : '0'),
                    folderTitle: item.folderTitle || (browsePath.length > 0 ? browsePath[browsePath.length - 1].title : 'Library')
                };

                // Proxy if remote
                if (data.url && data.url.startsWith('http') && !data.url.includes(window.location.host)) {
                    data.url = `/api/proxy-image?url=${encodeURIComponent(data.url)}`;
                }
            } else if (this.mode === 'nowPlaying') {
                if (currentArtworkUrl) {
                    const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);
                    data = {
                        url: currentArtworkUrl,
                        trackTitle: currentTrack ? currentTrack.title : '',
                        title: currentTrack ? (currentTrack.album || '') : '',
                        date: '',
                        location: currentTrack ? (currentTrack.artist || '') : '',
                        manualRotation: 0,
                        folderId: '0',
                        folderTitle: 'Now Playing'
                    };
                } else {
                    this.mode = 'all';
                    this.updateModeUI();
                    return this.next();
                }
            } else {
                const res = await fetch(`/api/slideshow/random?mode=${this.mode}`);
                if (res.ok) {
                    data = await res.json();
                } else {
                    const err = await res.json();
                    if (this.mode === 'onThisDay' || this.mode === 'favourites') {
                        showToast(err.error || `No photos for ${this.mode}`, 'info', 3000);
                        this.mode = 'all';
                        this.updateModeUI();
                        return this.next();
                    }
                }
            }

            if (data && data.url) this.renderPhoto(data);
            this.resetInterval();
        } catch (e) {
            console.error('[SLIDESHOW] Next failed:', e);
        }
    }

    async previous() {
        if (!this.previousPhoto) return;

        // Save current to swap back later
        const temp = {
            url: this.currentPhoto,
            rotation: this.rotation,
            data: this.currentPhotoData
        };

        // Render previous
        this.renderPhoto({
            ...this.previousPhoto.data,
            url: this.previousPhoto.url,
            manualRotation: this.previousPhoto.rotation
        });

        this.previousPhoto = temp;
        this.resetInterval();
    }

    renderPhoto(data) {
        if (data.url === this.currentPhoto && this.img.style.opacity == 1) {
            if (this.mode === 'nowPlaying') this.updateInfoUI(data);
            return;
        }

        this.img.style.opacity = 0;
        if (this.info) this.info.style.opacity = 0;

        setTimeout(() => {
            if (this.currentPhoto) {
                this.previousPhoto = {
                    url: this.currentPhoto,
                    rotation: this.rotation,
                    data: this.currentPhotoData
                };
            }

            if (this.bg) {
                this.bg.style.opacity = 0;
                setTimeout(() => {
                    this.bg.style.backgroundImage = `url("${data.url.replace(/"/g, '%22')}")`;
                    this.bg.style.opacity = 1;
                }, 500);
            }

            this.img.src = data.url;
            this.currentPhoto = data.url;
            this.currentPhotoData = data;
            this.rotation = data.manualRotation || 0;

            if (this.favBtn) {
                this.favBtn.classList.toggle('is-favourite', !!data.isFavourite);
            }

            this.img.style.setProperty('--ss-rotation', `${this.rotation}deg`);
            this.img.style.animation = 'none';
            void this.img.offsetWidth;
            this.img.style.animation = '';

            this.updateInfoUI(data);

            this.img.onload = () => {
                this.img.style.opacity = 1;
                if (this.info) this.info.style.opacity = 1;
                const ratio = this.img.naturalWidth / this.img.naturalHeight;
                this.img.classList.toggle('panorama', ratio > 2.2);
            };
            if (this.img.complete) this.img.onload();
        }, 500);
    }

    updateInfoUI(data) {
        if (!this.info) return;

        // trackTitle is used in nowPlaying mode — render it raw, never date-parse it
        const trackTitle = data.trackTitle || '';

        let dateStr = '';
        if (data.date) {
            let d = new Date(data.date);
            if (!isNaN(d.getTime()) && !/^\d{4}$/.test(String(data.date))) {
                dateStr = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
            } else {
                dateStr = String(data.date).split('T')[0];
            }
        }

        const isCamera = (val) => {
            if (!val) return false;
            const v = String(val).toLowerCase();
            return ['iphone', 'samsung', 'pixel', 'apple', 'canon', 'nikon', 'sony'].some(kw => v.includes(kw));
        };

        let path = data.folderTitle || data.location || '';
        if (isCamera(path)) path = '';

        const cameraStr = data.camera || '';

        this.info.innerHTML = `
            ${trackTitle ? `<div class="ss-track-title">${trackTitle}</div>` : ''}
            <div class="ss-date">${dateStr || data.title || ''}</div>
            <div class="ss-location">
                <span class="ss-folder-link" onclick="event.stopPropagation(); slideshow.stop(); browse(selectedServerUdn, '${data.folderId}')">
                    ${path || 'Library'}
                </span>
            </div>
            <div class="ss-camera">${cameraStr}</div>`;

        currentScreensaverFolder = { id: data.folderId, title: data.folderTitle };

        // Always fetch full metadata to get camera info (and GPS fallback).
        // The server's 64KB range-fetch often misses EXIF data deeper in the file.
        this.fetchMetadataFallback(data);
    }

    fetchMetadataFallback(data) {
        const rawUrl = this.currentPhoto;
        if (!rawUrl) {
            this.hideMap();
            return;
        }
        const fetchUrl = rawUrl.startsWith('/api/proxy-image')
            ? new URLSearchParams(rawUrl.split('?')[1]).get('url')
            : rawUrl;
        if (!fetchUrl) {
            this.hideMap();
            return;
        }

        fetch(`/api/track-metadata?uri=${encodeURIComponent(fetchUrl)}`)
            .then(r => r.ok ? r.json() : null)
            .then(meta => {
                if (!meta) { this.hideMap(); return; }

                // Update camera label if we got make/model
                const make = (meta.common && meta.common.make) || '';
                const model = (meta.common && meta.common.model) || '';
                if (model) {
                    const camera = model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`.trim();
                    const el = this.info && this.info.querySelector('.ss-camera');
                    if (el) el.textContent = camera;
                }

                // Update map if GPS available
                if (meta.format && meta.format.latitude != null) {
                    this.updateMapUI({ latitude: meta.format.latitude, longitude: meta.format.longitude });
                } else if (!data.latitude) {
                    this.hideMap();
                }
            })
            .catch(() => this.hideMap());
    }

    updateMapUI(data) {
        if (!this.mapWindow) return;

        const lat = parseFloat(data.latitude);
        const lng = parseFloat(data.longitude);
        const hasGps = !isNaN(lat) && !isNaN(lng);

        if (!hasGps) {
            this.hideMap();
            return;
        }

        // Show the map window
        this.mapWindow.style.display = 'block';
        requestAnimationFrame(() => this.mapWindow.classList.add('visible'));

        if (!this.leafletMap) {
            this.leafletMap = L.map('ss-map', {
                zoomControl: false,
                attributionControl: true,
                dragging: false,
                scrollWheelZoom: false,
                doubleClickZoom: false,
                boxZoom: false,
                keyboard: false,
                touchZoom: false
            }).setView([lat, lng], 13);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap',
                maxZoom: 18
            }).addTo(this.leafletMap);
            this.leafletMarker = L.circleMarker([lat, lng], {
                radius: 7,
                fillColor: '#6366f1',
                color: '#fff',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.95
            }).addTo(this.leafletMap);
        } else {
            this.leafletMap.setView([lat, lng], 13);
            this.leafletMarker.setLatLng([lat, lng]);
        }

        // Force Leaflet to recalculate size after display:block
        setTimeout(() => { if (this.leafletMap) this.leafletMap.invalidateSize(); }, 50);
    }

    hideMap() {
        if (!this.mapWindow) return;
        this.mapWindow.classList.remove('visible');
        setTimeout(() => {
            if (!this.mapWindow.classList.contains('visible')) {
                this.mapWindow.style.display = 'none';
            }
        }, 500);
    }

    toggleMapSize() {
        if (!this.mapWindow) return;
        const isExpanding = !this.mapWindow.classList.contains('expanded');
        this.mapWindow.classList.toggle('expanded');
        // After CSS transition, resize Leaflet and adjust zoom
        setTimeout(() => {
            if (this.leafletMap) {
                this.leafletMap.invalidateSize();
                const currentZoom = this.leafletMap.getZoom();
                this.leafletMap.setZoom(isExpanding ? currentZoom - 3 : currentZoom + 3);
            }
        }, 420);
    }

    toggleMode() {
        const modes = ['all', 'onThisDay', 'favourites', 'nowPlaying'];
        this.mode = modes[(modes.indexOf(this.mode) + 1) % modes.length];
        localStorage.setItem('screensaverMode', this.mode);
        this.updateModeUI();
        showToast(`Mode: ${this.mode}`, 'info', 2000);
        this.next();
    }

    updateModeUI() {
        if (this.modeLabel) {
            const labels = { all: 'All', onThisDay: 'Day', favourites: 'Favs', nowPlaying: 'Music' };
            this.modeLabel.textContent = labels[this.mode] || 'All';
        }
    }

    async rotate(delta) {
        if (!this.currentPhoto) return;
        this.rotation = (this.rotation + delta) % 360;
        if (this.rotation < 0) this.rotation += 360;
        this.img.style.setProperty('--ss-rotation', `${this.rotation}deg`);

        try {
            await fetch('/api/slideshow/rotate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: this.currentPhoto, rotation: this.rotation })
            });
            // Update client-side cache
            manualRotations[this.currentPhoto] = this.rotation;
        } catch (e) {
            console.error('Rotate save failed:', e);
        }
        this.resetInterval();
    }

    async toggleFavourite() {
        if (!this.currentPhoto) return;
        const newState = !this.favBtn.classList.contains('is-favourite');
        this.favBtn.classList.toggle('is-favourite', newState);

        try {
            const res = await fetch('/api/slideshow/favourite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: this.currentPhoto, favourite: newState })
            });
            if (res.ok) showToast(newState ? 'Added to Favourites' : 'Removed', 'success', 2000);
        } catch (e) {
            console.error('Fav toggle failed:', e);
            this.favBtn.classList.toggle('is-favourite', !newState);
        }
        this.resetInterval();
    }

    async delete() {
        if (!this.currentPhoto || !confirm('Hide this photo forever?')) return;
        try {
            const res = await fetch('/api/slideshow/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: this.currentPhoto })
            });
            if (res.ok) {
                showToast('Photo hidden', 'success', 2000);
                // Remove from local items if present to prevent it reappearing in this session
                if (this.items && this.items.length > 0 && this.index >= 0) {
                    this.items.splice(this.index, 1);
                    this.index--; // Back up so next() advances to the new item at this index
                }
                this.next();
            }
        } catch (e) {
            console.error('Delete failed:', e);
        }
    }

    async gotoFolder() {
        const data = this.currentPhotoData;
        if (!data || !data.folderId || !selectedServerUdn) {
            console.warn('[SLIDESHOW] No folder info available to navigate');
            return;
        }

        console.log('[SLIDESHOW] Navigating to folder:', data.folderTitle);
        this.stop();

        // Ensure we are in grid mode
        browserViewMode = 'grid';
        localStorage.setItem('browserViewMode', 'grid');

        // Select the server (use the one from screensaver config or current)
        if (screensaverConfig && screensaverConfig.serverUdn) {
            selectedServerUdn = screensaverConfig.serverUdn;
            localStorage.setItem('selectedServerUdn', selectedServerUdn);
        }

        // Reset browser path to root first to ensure clean breadcrumbs
        browsePath = [{ id: '0', title: 'Home' }];

        // Trigger navigation
        if (typeof enterFolder === 'function') {
            await enterFolder(data.folderId, data.folderTitle);
        } else {
            await browse(selectedServerUdn, data.folderId);
        }

        // If on mobile, switch to browser tab
        if (typeof switchView === 'function') {
            switchView('browser');
        }
    }

    async startPhoto(url, title, date, location, folderId, folderTitle) {
        console.log('[SLIDESHOW] Starting single photo view:', url);

        // Fetch background meta for coordinates
        let latitude, longitude;
        try {
            const res = await fetch(`/api/track-metadata?uri=${encodeURIComponent(url)}`);
            if (res.ok) {
                const meta = await res.json();
                latitude = meta.format?.latitude;
                longitude = meta.format?.longitude;
            }
        } catch (e) { }

        const item = {
            uri: url,
            title,
            date,
            artist: location,
            latitude,
            longitude,
            folderId,
            folderTitle
        };
        this.start([item], 0);
    }
}

// Global instance
slideshow = new Slideshow();
slideshow.init();

// Compatibility wrappers for existing HTML/Logic
function resetIdleTimer(e) { if (slideshow) slideshow.resetIdleTimer(e); }
function startSlideshow() { if (slideshow) slideshow.start(); }
function stopSlideshow() { if (slideshow) slideshow.stop(); }
function showNextPhoto() { if (slideshow) slideshow.next(); }
function previousSlideshow() { if (slideshow) slideshow.previous(); }
function rotateSlideshow(delta) { if (slideshow) slideshow.rotate(delta); }
function toggleSlideshowMode() { if (slideshow) slideshow.toggleMode(); }
function toggleFavouriteCurrentPhoto() { if (slideshow) slideshow.toggleFavourite(); }
function deleteCurrentPhoto() { if (slideshow) slideshow.delete(); }

// Slideshow music bar: play/pause toggle
function toggleSlideshowPlayback(event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    if (currentTransportState === 'Playing') {
        transportAction('pause');
    } else {
        transportAction('play');
    }
}

// Slideshow music bar: show/hide volume popover
function toggleSSVolumeSlider(event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    const popover = document.getElementById('ss-volume-popover');
    if (!popover) return;
    // Sync value from main slider before showing
    const mainSlider = document.getElementById('volume-slider');
    const ssSlider = document.getElementById('ss-volume-slider');
    if (mainSlider && ssSlider) ssSlider.value = mainSlider.value;
    popover.classList.toggle('active');
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
