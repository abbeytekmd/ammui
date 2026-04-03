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
        this.lastStartTime = 0;

        // UI binds
        this.overlay = document.getElementById('screensaver-overlay');
        this.img = document.getElementById('screensaver-img');
        this.bg = document.getElementById('screensaver-bg');
        this.info = document.getElementById('screensaver-info');
        this.favBtn = document.getElementById('btn-ss-favourite');
        this.modeLabel = document.getElementById('ss-mode-label');
        this.nowPlayingLabel = document.getElementById('ss-now-playing-label');
        this.mapWindow = document.getElementById('ss-map-window');
        this.leafletMap = null;
        this.leafletMarker = null;
        this.resumeIndex = -1;
        this.resumeUrl = null;
        this.resumeMode = null;
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
        clearTimeout(this.timer);
        if (!this.isActive && !document.hidden) {
            const isVideoVisible = document.getElementById('video-modal')?.style.display === 'flex';
            if (!isVideoVisible) {
                this.timer = setTimeout(() => {
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
        this.lastStartTime = Date.now();
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
        clearTimeout(this._modeRetryTimer);
        console.log('[SLIDESHOW] Stopping...');
        this.isActive = false;
        if ((this.mode === 'onThisDay' || this.mode === 'favourites') && this.items.length > 0 && this.index >= 0) {
            const currentItem = this.items[this.index];
            this.resumeUrl = currentItem ? (currentItem.uri || currentItem.res) : null;
            this.resumeIndex = this.index;
            this.resumeMode = this.mode;
        } else {
            this.resumeIndex = -1;
            this.resumeUrl = null;
            this.resumeMode = null;
        }
        this.items = [];
        this.index = -1;

        if (this.interval) clearInterval(this.interval);

        if (this.overlay) {
            this.overlay.classList.remove('active');
            const popover = document.getElementById('ss-volume-popover');
            if (popover) popover.classList.remove('active');
            if (this.nowPlayingLabel) this.nowPlayingLabel.style.display = 'none';
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
        if (!this.isActive || (typeof document !== 'undefined' && document.hidden)) {
            this.resetInterval();
            return;
        }

        try {
            let data;
            if (this.items.length > 0) {
                this.index = (this.index + 1) % this.items.length;
                const item = this.items[this.index];
                const originalUrl = item.uri || item.res;
                data = {
                    url: originalUrl,
                    originalUrl: originalUrl,
                    title: item.title,
                    date: item.year || item.date || item['dc:date'] || '',
                    location: item.artist || item.creator || '',
                    latitude: item.latitude,
                    longitude: item.longitude,
                    camera: item.camera || '',
                    tags: item.tags || [],
                    manualRotation: manualRotations[originalUrl] || 0,
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
                    localStorage.setItem('screensaverMode', 'all');
                    this.updateModeUI();
                    return this.next();
                }
            } else if (this.mode === 'onThisDay' || this.mode === 'favourites') {
                // Load all matching photos into items array and cycle sequentially
                const listRes = await fetch(`/api/slideshow/list?mode=${this.mode}`);
                if (listRes.ok) {
                    const items = await listRes.json();
                    if (items.length > 0) {
                        clearTimeout(this._modeRetryTimer);
                        this.items = items;
                        if (this.resumeMode === this.mode) {
                            // Try to resume by URL so deleted items don't shift position
                            let resumePos = -1;
                            if (this.resumeUrl) {
                                resumePos = items.findIndex(i => (i.uri || i.res) === this.resumeUrl);
                            }
                            // Fallback to saved index if URL not found (e.g. it was deleted)
                            if (resumePos === -1 && this.resumeIndex >= 0 && this.resumeIndex < items.length) {
                                resumePos = this.resumeIndex;
                            }
                            this.index = resumePos - 1; // next() will increment
                        } else {
                            this.index = -1;
                        }
                        this.resumeIndex = -1;
                        this.resumeUrl = null;
                        this.resumeMode = null;
                        return this.next();
                    }
                }
                // Keep the selected mode — just wait if preparing, or show toast if no photos
                const label = this.mode === 'onThisDay' ? 'Day' : 'Favs';
                if (listRes.status === 503) {
                    showToast(`Preparing ${label} mode…`, 'info', 3000);
                    clearTimeout(this._modeRetryTimer);
                    this._modeRetryTimer = setTimeout(() => { if (this.isActive) this.next(); }, 5000);
                } else {
                    showToast(`No photos for ${label}`, 'info', 3000);
                }
                return; // Keep current slide, don't advance
            } else {
                const res = await fetch(`/api/slideshow/random?mode=${this.mode}`);
                if (res.ok) {
                    data = await res.json();
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

        const doTransition = (naturalWidth, naturalHeight) => {
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
                this.originalUrl = data.originalUrl || data.url;
                this.currentPhotoData = data;
                this.rotation = data.manualRotation || 0;

                if (this.favBtn) {
                    const isFav = data.tags && data.tags.includes('fav');
                    this.favBtn.classList.toggle('is-favourite', !!isFav);
                }

                this.img.style.setProperty('--ss-rotation', `${this.rotation}deg`);

                this.updateInfoUI(data);

                const applyDisplay = (w, h) => {
                    this.img.style.opacity = 1;
                    if (this.info) this.info.style.opacity = 1;
                    const ratio = w / h;
                    const isPanorama = ratio > 2.2;
                    this.img.classList.toggle('panorama', isPanorama);
                    this.img.style.animation = 'none';
                    void this.img.offsetWidth; // force reflow
                    if (isPanorama) {
                        const dur = Math.max((this.duration || 60000) / 1000, 20);
                        this._panoramaDir = (this._panoramaDir === undefined) ? false : !this._panoramaDir;
                        const animName = this._panoramaDir ? 'panoramaPanRL' : 'panoramaPanLR';
                        this.img.style.animation = `${animName} ${dur}s ease-in-out forwards`;
                    } else {
                        this.img.style.animation = '';
                    }
                };

                if (this.img.complete) {
                    applyDisplay(naturalWidth || this.img.naturalWidth, naturalHeight || this.img.naturalHeight);
                } else {
                    this.img.onload = () => applyDisplay(this.img.naturalWidth, this.img.naturalHeight);
                }
            }, 500);
        };

        // Preload the image so the current photo stays visible until the new one is ready
        const preload = new Image();
        preload.onload = () => doTransition(preload.naturalWidth, preload.naturalHeight);
        preload.onerror = () => doTransition(0, 1);
        preload.src = data.url;
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
            <div class="ss-camera">${cameraStr}</div>
            ${this.items.length > 0 ? `<div class="ss-pic-counter">${this.index + 1} of ${this.items.length}</div>` : ''}`;

        if (this.nowPlayingLabel) {
            this.refreshNowPlayingLabel();
        }

        currentScreensaverFolder = { id: data.folderId, title: data.folderTitle };

        // Always fetch full metadata to get camera info (and GPS fallback).
        // The server's 64KB range-fetch often misses EXIF data deeper in the file.
        this.fetchMetadataFallback(data);
    }

    refreshNowPlayingLabel() {
        if (!this.nowPlayingLabel) return;
        const playingTrack = currentTransportState === 'Playing'
            ? currentPlaylistItems.find(item => item.id == currentTrackId)
            : null;
        if (playingTrack) {
            const title = playingTrack.title || '';
            const artist = playingTrack.artist || '';
            const text = artist ? `${title} — ${artist}` : title;
            this.nowPlayingLabel.innerHTML = `<span class="ss-np-label">Now Playing</span>${text}`;
            this.nowPlayingLabel.style.display = '';
        } else {
            this.nowPlayingLabel.style.display = 'none';
        }
    }

    fetchMetadataFallback(data) {
        const rawUrl = this.currentPhoto;
        if (!rawUrl) {
            this.hideMap();
            return;
        }
        // Album art URLs have no EXIF/GPS metadata — skip
        if (rawUrl.startsWith('/api/art/')) {
            this.hideMap();
            return;
        }
        const fetchUrl = (rawUrl.startsWith('/api/proxy-image') || rawUrl.startsWith('/api/art/proxy'))
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
                dragging: true,
                scrollWheelZoom: true,
                doubleClickZoom: true,
                boxZoom: true,
                keyboard: true,
                touchZoom: true
            }).setView([lat, lng], 13);

            // Toggle size only on click (Leaflet won't trigger this if dragged)
            this.leafletMap.on('click', () => this.toggleMapSize());

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap',
                maxZoom: 18
            }).addTo(this.leafletMap);
            this.leafletMarker = L.circleMarker([lat, lng], {
                radius: 8,
                fillColor: '#6366f1',
                color: '#6366f1',
                weight: 2.5,
                opacity: 0.9,
                fillOpacity: 0.15
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
        if (!this.mapWindow || !this.leafletMarker) return;
        const isExpanding = !this.mapWindow.classList.contains('expanded');
        this.mapWindow.classList.toggle('expanded');

        // After CSS transition, resize Leaflet and snap back to marker
        setTimeout(() => {
            if (this.leafletMap) {
                this.leafletMap.invalidateSize();
                const pos = this.leafletMarker.getLatLng();
                const currentZoom = this.leafletMap.getZoom();
                this.leafletMap.setView(pos, isExpanding ? currentZoom - 3 : currentZoom + 3, { animate: true });
            }
        }, 420);
    }

    toggleMode() {
        clearTimeout(this._modeRetryTimer);
        const modes = ['all', 'onThisDay', 'favourites', 'nowPlaying'];
        this.mode = modes[(modes.indexOf(this.mode) + 1) % modes.length];
        localStorage.setItem('screensaverMode', this.mode);
        this.updateModeUI();
        this.items = [];
        this.index = -1;
        this.next();
    }

    updateModeUI() {
        if (this.modeLabel) {
            const labels = { all: 'All', onThisDay: 'Day', favourites: 'Favs', nowPlaying: 'Music' };
            this.modeLabel.textContent = labels[this.mode] || 'All';
        }
        const retryBtn = document.getElementById('btn-ss-retry-art');
        if (retryBtn) retryBtn.style.display = this.mode === 'nowPlaying' ? '' : 'none';
    }

    async rotate(delta) {
        if (!this.currentPhoto) return;
        this.rotation = (this.rotation + delta) % 360;
        if (this.rotation < 0) this.rotation += 360;
        this.img.style.setProperty('--ss-rotation', `${this.rotation}deg`);

        const urlForSave = this.originalUrl || this.currentPhoto;
        try {
            await fetch('/api/slideshow/rotate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: urlForSave, rotation: this.rotation })
            });
            // Update client-side cache
            manualRotations[urlForSave] = this.rotation;
        } catch (e) {
            console.error('Rotate save failed:', e);
        }
        this.resetInterval();
    }

    async toggleFavourite() {
        if (!this.currentPhoto) return;
        const newState = !this.favBtn.classList.contains('is-favourite');
        this.favBtn.classList.toggle('is-favourite', newState);

        const urlToFav = this.originalUrl || this.currentPhoto;
        try {
            const res = await fetch('/api/slideshow/favourite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: urlToFav, favourite: newState })
            });
            if (res.ok) {
                showToast(newState ? 'Added to Favourites' : 'Removed', 'success', 2000);
                // Update in-memory item so the heart stays correct next time around
                if (this.items && this.index >= 0 && this.index < this.items.length) {
                    const item = this.items[this.index];
                    if (!item.tags) item.tags = [];
                    if (newState) {
                        if (!item.tags.includes('fav')) item.tags.push('fav');
                    } else {
                        item.tags = item.tags.filter(t => t !== 'fav');
                    }
                }
            }
        } catch (e) {
            console.error('Fav toggle failed:', e);
            this.favBtn.classList.toggle('is-favourite', !newState);
        }
        this.resetButtonStates();
        this.resetInterval();
    }

    async delete() {
        if (!this.currentPhoto || !confirm('Hide this photo forever?')) return;
        const urlToDelete = this.originalUrl || this.currentPhoto;
        try {
            const res = await fetch('/api/slideshow/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: urlToDelete })
            });
            if (res.ok) {
                showToast('Photo hidden', 'success', 2000);
                // Remove from local items if present to prevent it reappearing in this session
                if (this.items && this.items.length > 0 && this.index >= 0) {
                    this.items.splice(this.index, 1);
                    this.index--; // Back up so next() advances to the new item at this index
                }
                // Reset button states to prevent stuck highlighting on touch devices
                this.resetButtonStates();
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

        // Reset browser path
        browsePath = [{ id: '0', title: 'Home' }];

        // Reconstruct path from location metadata (JSON string of path array)
        if (data.location && data.location.startsWith('[')) {
            try {
                const parts = JSON.parse(data.location);
                // Parts are [{id, title}, ...]
                parts.forEach(p => {
                    if (p.id !== '0') {
                        browsePath.push(p);
                    }
                });
            } catch (e) {
                console.warn('[SLIDESHOW] Failed to parse path location:', e);
                if (data.folderId && data.folderId !== '0') {
                    browsePath.push({ id: data.folderId, title: data.folderTitle });
                }
            }
        } else if (data.folderId && data.folderId !== '0') {
            // Fallback for older cache entries
            browsePath.push({ id: data.folderId, title: data.folderTitle });
        }

        saveLastPath();
        updateBreadcrumbs();
        await browse(selectedServerUdn, data.folderId);

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

    resetButtonStates() {
        // Reset button active states to prevent stuck highlighting on touch devices
        const buttons = document.querySelectorAll('.ss-control-item button');
        buttons.forEach(button => {
            button.blur(); // Remove focus
            button.classList.remove('active'); // Remove any active classes
        });
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
