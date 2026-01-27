(function () {
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

    console.log = (...args) => {
        originalLog(`[${getTimestamp()}]`, ...args);
    };

    console.error = (...args) => {
        originalError(`[${getTimestamp()}]`, ...args);
    };

    console.warn = (...args) => {
        originalWarn(`[${getTimestamp()}]`, ...args);
    };
})();

const deviceListElement = document.getElementById('device-list');
const serverListElement = document.getElementById('server-list');
const rendererCount = document.getElementById('renderer-count');
const serverCount = document.getElementById('server-count');
const tabRendererCount = document.getElementById('tab-renderer-count');
const tabServerCount = document.getElementById('tab-server-count');

const playlistContainer = document.getElementById('playlist-container');
const playlistItems = document.getElementById('playlist-items');
const playlistCount = document.getElementById('playlist-count');

const browserContainer = document.getElementById('browser-container');
const browserItems = document.getElementById('browser-items');
const browserBreadcrumbs = document.getElementById('browser-breadcrumbs');

const serverModal = document.getElementById('server-modal');
const modalServerList = document.getElementById('modal-server-list');
const rendererModal = document.getElementById('renderer-modal');
const modalRendererList = document.getElementById('modal-renderer-list');
const manageModal = document.getElementById('manage-modal');
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

    browserContainer.style.display = 'flex';

    // Check if this server has a saved home location
    let homeLocations = {};
    try {
        const stored = localStorage.getItem('serverHomeLocations');
        if (stored) {
            homeLocations = JSON.parse(stored);
        }
    } catch (e) {
        console.error('Failed to parse home locations:', e);
    }

    const homeBrowsePath = homeLocations[udn];

    // If home location exists, navigate there; otherwise go to root
    if (homeBrowsePath && Array.isArray(homeBrowsePath)) {
        try {
            browsePath = homeBrowsePath;
            updateBreadcrumbs();
            const lastFolder = browsePath[browsePath.length - 1];
            await browse(udn, lastFolder.id);
        } catch (e) {
            console.error('Failed to navigate to home:', e);
            browsePath = [{ id: '0', title: 'Root' }];
            updateBreadcrumbs();
            await browse(udn, '0');
        }
    } else {
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

async function navigateToPath(index) {
    browsePath = browsePath.slice(0, index + 1);
    updateBreadcrumbs();
    const item = browsePath[index];
    await browse(selectedServerUdn, item.id);
}

async function enterFolder(id, title) {
    browsePath.push({ id, title });
    updateBreadcrumbs();
    await browse(selectedServerUdn, id);
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

        await fetchPlaylist(selectedRendererUdn);

        // On mobile, switch to playlist view after adding if requested
        if (autoSwitch && window.innerWidth <= 800) {
            switchView('playlist');
        }
    } catch (err) {
        console.error('Client: Error adding track:', err);
        throw err;
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

    if (!selectedRendererUdn) {
        alert('Please select a Renderer on the left first!');
        return;
    }

    const btn = document.getElementById('btn-add-all');
    btn.classList.add('disabled');
    btn.textContent = 'Adding...';

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
        btn.textContent = 'Add All';
    }
}

async function playAll() {
    const tracks = currentBrowserItems.filter(item => item.type === 'item');
    if (tracks.length === 0) return;

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
        if (!response.ok) throw new Error(`Failed to ${action}`);

        // Instant update of status and playlist to reflect the new state
        await fetchPlaylist(selectedRendererUdn);
    } catch (err) {
        console.error(`${action} error:`, err);
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
        alert('Failed to clear playlist');
    }
}

function selectPlaylistItem(id) {
    playPlaylistItem(id);
}


function renderBrowser(items) {
    currentBrowserItems = items;
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


    if (items.length === 0) {
        browserItems.innerHTML = '<div class="empty-state">Folder is empty</div>';
        return;
    }

    browserItems.innerHTML = items.map(item => {
        const isContainer = item.type === 'container';
        const icon = isContainer ? `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
        ` : `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M10 8l6 4-6 4V8z"></path>
            </svg>
        `;

        const esc = (s) => (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');

        return `
            <div class="playlist-item browser-item ${isContainer ? 'folder' : 'file'}" 
                 onclick="${isContainer ?
                `enterFolder('${item.id}', '${esc(item.title)}')` :
                `playTrack('${esc(item.uri)}', '${esc(item.title)}', '${esc(item.artist)}', '${esc(item.album)}', '${esc(item.duration)}', '${esc(item.protocolInfo)}')`}">
                <div class="item-icon">${icon}</div>
                <div class="item-info">
                    <div class="item-title">${item.title}</div>
                </div>
                ${!isContainer ? `
                    <button class="btn-control queue-btn" onclick="event.stopPropagation(); addToPlaylist('${esc(item.uri)}', '${esc(item.title)}', '${esc(item.artist)}', '${esc(item.album)}', '${esc(item.duration)}', '${esc(item.protocolInfo)}', false)" title="Add to queue">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 5v14M5 12h14"></path>
                        </svg>
                        Queue
                    </button>
                ` : ''}
            </div>
        `;
    }).join('');
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
        // If playlist is empty, try to fetch it first
        if (currentPlaylistItems.length === 0 && selectedRendererUdn) {
            console.log('[DEBUG] Playlist empty during status check, fetching...');
            fetchPlaylist(selectedRendererUdn);
        }

        const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);
        if (currentTrack && currentTrack.duration) {
            newDuration = formatToSeconds(currentTrack.duration);
            console.log(`[DEBUG] Found fallback duration: ${newDuration}s for track ${currentTrackId}`);
        } else {
            console.log(`[DEBUG] No duration found for track ${currentTrackId} in playlist`);
        }
    } else if (newDuration > 0) {
        console.log(`[DEBUG] Device reported duration: ${newDuration}s`);
    }

    durationSeconds = newDuration;
    //    lastStatusFetchTime = Date.now();

    // Update Now Playing label
    const nowPlayingLabel = document.getElementById('now-playing-label');
    if (nowPlayingLabel) {
        if (currentTrackId != null) {
            const currentTrack = currentPlaylistItems.find(item => item.id == currentTrackId);
            if (currentTrack) {
                nowPlayingLabel.textContent = `${currentTrack.title} - ${currentTrack.artist || 'Unknown Artist'}`;
                nowPlayingLabel.title = nowPlayingLabel.textContent; // Tooltip for full name
            } else {
                nowPlayingLabel.textContent = `Track ${currentTrackId}`;
            }
        } else {
            nowPlayingLabel.textContent = 'Not Playing';
        }
    }

    updatePositionUI();
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
                <button class="btn-control delete-btn" onclick="event.stopPropagation(); deleteTrackFromPlaylist('${esc(item.id)}')" title="Remove from playlist">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"></path>
                    </svg>
                </button>
            </div>
        `;
    }).join('');

    updateTransportControls();
    updateDocumentTitle();
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
        alert('Failed to delete track: ' + err.message);
    }
}

function updateDocumentTitle() {
    const defaultTitle = 'AMCUI | OpenHome Explorer';

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
                    ` : `
                        <button class="btn-select ${role === 'server' ? 'btn-select-server' : 'btn-select-player'}" onclick="${role === 'server' ? `selectServer('${device.udn}')` : `selectDevice('${device.udn}')`}; renderManageDevices();">
                            ${role === 'server' ? `
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                                </svg>
                            ` : `
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="#4ade80">
                                    <path d="M6 9h5l7-7v20l-7-7H6V9z"></path>
                                </svg>
                            `}
                            <span>Select</span>
                        </button>
                    `) : ''}
                    <button class="btn-toggle ${isDisabled ? 'btn-enable' : 'btn-disable'}" onclick="toggleDeviceDisabled('${device.udn}', '${role}')">
                        ${isDisabled ? 'Enable' : 'Disable'}
                    </button>
                    <button class="btn-delete" onclick="deleteDevice('${device.udn}')">Delete</button>
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
    if (!confirm('Are you sure you want to delete this device? It will be removed from the saved database.')) {
        return;
    }

    try {
        const response = await fetch(`/api/devices/${encodeURIComponent(udn)}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete device');

        // Fetch fresh list and update UI
        await fetchDevices();
        renderManageDevices();
        renderDevices(); // Update the main dashboard cards too
    } catch (err) {
        console.error('Delete error:', err);
        alert('Failed to delete device');
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

    if (rendererCount) rendererCount.textContent = `${renderers.length} found`;
    if (serverCount) serverCount.textContent = `${servers.length} found`;
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
            updateBreadcrumbs();
            const lastFolder = browsePath[browsePath.length - 1];
            await browse(selectedServerUdn, lastFolder.id);
        } catch (e) {
            console.error('Failed to go home:', e);
            await browse(selectedServerUdn, '0');
        }
    } else {
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
                    updateBreadcrumbs();
                    const lastFolder = browsePath[browsePath.length - 1];
                    await browse(selectedServerUdn, lastFolder.id);
                } catch (e) {
                    console.error('Failed to parse saved home path:', e);
                    await browse(selectedServerUdn, '0');
                }
            } else {
                await browse(selectedServerUdn, '0');
            }

            // On mobile, auto-expand the browser since we just loaded content
            if (window.innerWidth <= 800 && browserItems && !browserItems.classList.contains('expanded')) {
                toggleBrowser();
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


