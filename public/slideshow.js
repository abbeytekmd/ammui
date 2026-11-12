// Idle Screensaver Logic - Now handled by Slideshow class
let currentScreensaverFolder = null; // Used for folder navigation

/*
 * Slide transitions. Each one pairs an exit (old photo) with an enter (new photo).
 * Only transform and opacity are animated, so the compositor does the work and
 * nothing is repainted per frame (keeps it smooth on a Raspberry Pi).
 * `out` is the state the old photo animates to; `in` is the state the new photo
 * animates from. Keys: x/y translate, rx/ry/rz rotate (deg), s scale, o opacity.
 * Every outMs must be >= fade.outMs (panoramas always fade out on the same timer).
 */
const SS_TRANSITIONS = {
    fade:       { outMs: 500, inMs: 1000, out: { o: 0 }, in: { o: 0 } },
    zoomIn:     { outMs: 600, inMs: 1100, out: { s: 1.3, o: 0 }, in: { s: 0.75, o: 0 }, easeIn: 'cubic-bezier(.16,1,.3,1)' },
    zoomOut:    { outMs: 600, inMs: 1100, out: { s: 0.7, o: 0 }, in: { s: 1.35, o: 0 }, easeIn: 'cubic-bezier(.16,1,.3,1)' },
    slideLeft:  { outMs: 700, inMs: 900,  out: { x: '-100%', o: 0.4 }, in: { x: '100%', o: 0.4 }, easeIn: 'cubic-bezier(.22,1,.36,1)' },
    slideRight: { outMs: 700, inMs: 900,  out: { x: '100%', o: 0.4 }, in: { x: '-100%', o: 0.4 }, easeIn: 'cubic-bezier(.22,1,.36,1)' },
    slideUp:    { outMs: 700, inMs: 900,  out: { y: '-100%', o: 0.4 }, in: { y: '100%', o: 0.4 }, easeIn: 'cubic-bezier(.22,1,.36,1)' },
    flip:       { outMs: 600, inMs: 800,  out: { ry: 90 }, in: { ry: -90 } },
    tumble:     { outMs: 600, inMs: 800,  out: { rx: -90 }, in: { rx: 90 } },
    door:       { outMs: 700, inMs: 1000, out: { x: '-35%', ry: 75, o: 0 }, in: { x: '35%', ry: -75, o: 0 } },
    swirl:      { outMs: 700, inMs: 1200, out: { rz: 90, s: 0.2, o: 0 }, in: { rz: -90, s: 0.2, o: 0 }, easeIn: 'cubic-bezier(.22,1,.36,1)' },
    drop:       { outMs: 600, inMs: 1100, out: { y: '15%', s: 0.9, o: 0 }, in: { y: '-100%' }, easeIn: 'cubic-bezier(.34,1.4,.64,1)' },
    pop:        { outMs: 500, inMs: 900,  out: { s: 0.85, o: 0 }, in: { s: 0.3, o: 0 }, easeIn: 'cubic-bezier(.34,1.56,.64,1)' },
};

// A photo's tags. Items from the file browser keep their favourite apart (item.fav), so it's put
// back with the rest: saving the tags from the slideshow mustn't lose it.
function slideshowItemTags(item) {
    const tags = [...(item.tags || [])];
    if (item.fav && !tags.includes('fav')) tags.unshift('fav');
    return tags;
}

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
        this.video = document.getElementById('screensaver-video');
        this.videoMaxSeconds = 60; // longest a video slide plays (0 = to its end)
        this.videoSound = false;
        this.videosEnabled = false; // "Include videos": slideshows started from the library take in the folder's videos too
        this.sky = null; // the sky's settings (slideshowSky): the Sky button switches between it and the photos
        this.skyShowing = false;
        this.skyAfterSunset = false; // the sky is up because it's just after sunset, and goes when that's over
        this.sunsetHandled = null; // the sunset the sky has been put up for already (so switching it off sticks)
        this.videoShowing = false; // the video element is up instead of the photo
        this.slideIsVideo = false; // the slide being shown (or faded to) is a video
        this.soundBtn = document.getElementById('ss-video-sound'); // floats over a playing video slide
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
        this.listVersion = null; // server delete-version of this.items when it came from a Day/Recent/Favs list, else null
        this.browserOpen = false; // grid of this.items is showing; the slideshow is paused under it
        this.ticker = null; // the news ticker's settings (slideshowTicker)
        this.tickerEl = document.getElementById('ss-ticker');
        this.tickerKey = ''; // the headlines the ticker is showing, so a reload that changes nothing doesn't restart it
        this.peopleEl = document.getElementById('ss-people');
        this.peopleNames = []; // everyone Tag Faces knows, for the people bar along the bottom
        this.peopleOpen = false; // the bar is showing everyone, to tag them, not just who's in the photo
        this.peopleTouched = new Set(); // names switched on this photo, kept on the bar (dimmed if off) until it moves on
        this.peoplePhoto = null;
    }

    init() {
        // Activity listeners for idle timer
        ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(name => {
            window.addEventListener(name, (e) => this.resetIdleTimer(e), { passive: true });
        });
        this.resetIdleTimer();
        this.updateModeUI();

        // Holding a Live Photo plays its clip again, with sound, as on an iPhone; tapping it (or its
        // clip while it plays) runs the clip again from the start. Tapping any other photo zooms in on
        // the tapped spot, and tapping again zooms back out.
        let holdTimer = null, held = false;
        this.img.addEventListener('pointerdown', () => {
            clearTimeout(holdTimer);
            held = false;
            holdTimer = setTimeout(() => { held = true; this.playLive(this.currentPhotoData, true); }, 400);
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(name => this.img.addEventListener(name, () => clearTimeout(holdTimer)));
        this.img.addEventListener('contextmenu', (e) => { if (this.currentPhotoData?.liveVideo) e.preventDefault(); });
        // A zoomed-in photo can be dragged around; only a tap that didn't drag zooms back out
        let drag = null, dragged = false;
        this.img.addEventListener('dragstart', (e) => e.preventDefault());
        this.img.addEventListener('pointerdown', (e) => {
            dragged = false;
            if (!this.zoomed) return;
            drag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: this.zoomPan.x, ty: this.zoomPan.y };
        });
        this.img.addEventListener('pointermove', (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (!dragged) {
                if (Math.hypot(dx, dy) < 8) return;
                dragged = true;
                clearTimeout(holdTimer);
                this.img.setPointerCapture(e.pointerId);
                this.img.classList.add('dragging');
            }
            this.setZoomPan(drag.tx + dx, drag.ty + dy);
        });
        ['pointerup', 'pointercancel'].forEach(name => this.img.addEventListener(name, (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            drag = null;
            this.img.classList.remove('dragging');
        }));
        this.img.addEventListener('click', (e) => {
            if (held || dragged) return;
            if (this.currentPhotoData?.liveVideo) this.playLive(this.currentPhotoData);
            else this.toggleZoom(e.clientX, e.clientY);
        });
        this.video.addEventListener('click', () => {
            if (this.videoShowing && !this.slideIsVideo) this.playLive(this.currentPhotoData, !this.video.muted);
        });
        // The sound button's icon follows the video, including when the browser forces it muted
        this.video.addEventListener('volumechange', () => this.updateSoundButton());
    }

    // The sound button shows only while a video slide is up, crossed out when it's muted
    updateSoundButton() {
        if (!this.soundBtn) return;
        this.soundBtn.hidden = !(this.isActive && this.videoShowing && this.slideIsVideo);
        this.soundBtn.classList.toggle('is-muted', this.video.muted);
    }

    // The sound button: on or off for this video, and for the videos after it in this slideshow
    // (until the General settings are applied again)
    toggleVideoSound() {
        if (!this.videoShowing) return;
        const v = this.video;
        v.muted = !v.muted;
        this.videoSound = !v.muted;
        if (v.paused && !v.ended) v.play().catch(() => { });
        this.updateSoundButton();
    }

    resetIdleTimer(e) {
        clearTimeout(this.timer);
        if (!this.isActive && !document.hidden && this.idleTimeout > 0 && !gameInProgress()) {
            const isVideoVisible = document.getElementById('video-modal')?.style.display === 'flex';
            if (!isVideoVisible) {
                this.timer = setTimeout(() => {
                    if (!gameInProgress()) this.start();
                }, this.idleTimeout);
            }
        }
    }

    // Seconds from the General settings. 0 = never start when idle / never auto-advance.
    setTimings(idleSeconds, photoSeconds) {
        if (idleSeconds >= 0) this.idleTimeout = idleSeconds * 1000;
        if (photoSeconds >= 0) this.duration = photoSeconds * 1000;
        if (this.isActive) this.resetInterval();
        else this.resetIdleTimer();
    }

    // From the General settings: how long videos play and whether they're heard
    setVideoOptions({ enabled, maxSeconds, sound }) {
        this.videosEnabled = !!enabled;
        if (maxSeconds >= 0) this.videoMaxSeconds = maxSeconds;
        this.videoSound = !!sound;
        if (this.videoShowing) this.video.muted = !this.videoSound;
    }

    // From the General settings: the sky (slideshowSky)
    setSkyOptions(sky) {
        this.sky = sky;
        if (this.skyShowing && !skySlideAvailable(sky)) this.hideSky(false, true);
        else if (this.skyShowing) showSkySlide(sky); // looking another way, or turning now
        this.updateSkyButton();
        if (this.isActive) { this.loadSun(); this.checkSunsetSky(); }
    }

    // From the General settings: the news ticker (slideshowTicker)
    setTickerOptions(ticker) {
        const feedsChanged = JSON.stringify(ticker?.feeds) !== JSON.stringify(this.ticker?.feeds);
        this.ticker = ticker;
        if (!this.isActive) return;
        if (!ticker?.enabled) this.showTicker([]);
        else if (feedsChanged || !this.tickerKey) this.loadTicker();
    }

    async loadTicker() {
        if (!this.ticker?.enabled || !this.tickerEl) return this.showTicker([]);
        try {
            const data = await fetch('/api/news-ticker').then(r => r.json());
            if (this.isActive) this.showTicker(data.headlines || []);
        } catch (err) {
            console.warn('[SLIDESHOW] News ticker load failed:', err.message); // keeps what it was showing
        }
    }

    // Scrolls the headlines from right to left at a steady speed, however many there are. The track
    // holds them twice, so moving it left by half its width brings it back to where it started.
    showTicker(headlines) {
        const el = this.tickerEl;
        if (!el) return;
        this.tickerHeadlines = headlines; // what a tap on one opens (its summary shows straight away)
        const key = JSON.stringify(headlines.map(h => [h.title, h.source]));
        if (key === this.tickerKey) return;
        this.tickerKey = headlines.length ? key : '';
        const on = headlines.length > 0;
        el.hidden = !on;
        this.overlay?.classList.toggle('has-ticker', on);
        const track = el.querySelector('.ss-ticker-track');
        if (!track.onclick) {
            // A tap on a headline opens its story
            track.onclick = (e) => {
                const item = e.target.closest('.ss-ticker-item');
                if (!item) return;
                e.stopPropagation();
                const headline = this.tickerHeadlines?.[Number(item.dataset.index)];
                if (headline) openTickerStory(headline);
            };
        }
        if (!on) { track.innerHTML = ''; return; }
        const sources = new Set(headlines.map(h => h.source).filter(Boolean));
        const items = headlines.map((h, i) => `<span class="ss-ticker-item" data-index="${i}">${sources.size > 1 && h.source
            ? `<b class="ss-ticker-source">${escapeHtml(h.source)}</b>` : ''}${escapeHtml(h.title)}</span>`).join('');
        track.innerHTML = items + items;
        track.style.animation = 'none';
        this.tickerWidth = 0;
        this.sizeTicker(track);
        // While the ticker is hidden (the sky is up) it has no width to time the scroll by, so it's
        // timed again once it shows, and whenever its width changes (fonts loading, say)
        if (!this.tickerObserver && window.ResizeObserver) {
            this.tickerObserver = new ResizeObserver(() => this.sizeTicker(track));
            this.tickerObserver.observe(track);
        }
    }

    // The scroll's duration from the track's width, so it moves at a steady speed
    sizeTicker(track) {
        const width = track.scrollWidth; // reading its width lays it out, restarting the animation
        if (!width || width === this.tickerWidth || !track.innerHTML) return;
        this.tickerWidth = width;
        const pxPerSecond = 90;
        const seconds = Math.max(width / 2 / pxPerSecond, 10);
        track.style.animation = `ss-ticker-scroll ${seconds}s linear infinite`;
    }

    // For the set time after sunset the sky shows instead of the photos, and then they come back.
    // Switched back to the photos meanwhile, they stay; the next slideshow in that time starts on the sky again.
    checkSunsetSky() {
        if (!this.isActive) return;
        const minutes = this.sky?.afterSunsetMinutes || 0;
        let sunset = null;
        if (minutes > 0 && skySlideAvailable(this.sky)) {
            const now = Date.now();
            const set = skyNextSunriseSunset(now - minutes * 60000, this.sky).set; // the sunset in the last `minutes`, if any
            if (set !== null && set <= now) sunset = set;
        }
        if (sunset !== null) {
            if (this.sunsetHandled === sunset) return;
            this.sunsetHandled = sunset;
            if (this.skyShowing || this.browserOpen) return;
            this.showSky();
            this.skyAfterSunset = true;
            this.resetInterval();
        } else if (this.skyAfterSunset && this.skyShowing) {
            this.hideSky(false, true);
            this.resetInterval();
        }
    }

    // The Sky button: switches between the sky and the photos. The choice is remembered, so the
    // next slideshow starts the same way.
    toggleSky() {
        if (this.skyShowing) this.hideSky(false, true);
        else if (skySlideAvailable(this.sky)) this.showSky();
        try { localStorage.setItem('slideshowSkyOn', this.skyShowing ? '1' : ''); } catch { }
        this.resetInterval();
    }

    // Shown once the sky has a place to be seen from, lit while the sky is up
    updateSkyButton() {
        const item = document.getElementById('ss-sky-item');
        if (!item) return;
        item.style.display = skySlideAvailable(this.sky) ? '' : 'none';
        item.querySelector('button')?.classList.toggle('is-on', this.skyShowing); // not 'active', which resetButtonStates clears
    }

    // The sky in place of the photos, which wait under it until it's switched off. It fills the
    // screen, with the side panel and the other controls put away and just a button back to the photos.
    showSky() {
        this.skyShowing = true;
        this.overlay?.classList.add('sky-mode'); // first, so the sky is drawn the size of the whole screen
        this.clearZoom();
        this.stopVideo();
        if (this.info) this.info.style.opacity = 0;
        this.hideMap();
        showSkySlide(this.sky);
        this.updateSkyButton();
    }

    // Takes the sky down; `uncover` brings back the details of the photo under it, when that's what shows next
    hideSky(now = false, uncover = false) {
        if (!this.skyShowing) return;
        this.skyShowing = false;
        this.skyAfterSunset = false;
        this.overlay?.classList.remove('sky-mode');
        hideSkySlide(now);
        this.updateSkyButton();
        if (!uncover || !this.currentPhotoData) return;
        if (this.info) this.info.style.opacity = 1;
        this.updateMapUI(this.currentPhotoData);
    }

    async start(items = null, index = -1) {
        this.loadPeople();
        // Photos picked from the library (a folder, a selection) show as Custom until the mode is
        // changed or the slideshow stops; the saved mode is left alone.
        if (items) {
            this.mode = 'custom';
            this.updateModeUI();
        }
        if (this.isActive) {
            if (items) {
                this.listVersion = null;
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
        this.clearStage();
        this.isActive = true;
        this.lastStartTime = Date.now();
        this.listVersion = null;
        this.items = items || [];
        this.index = index;

        if (this.overlay) {
            this.overlay.style.display = 'flex';
            setTimeout(() => this.overlay.classList.add('active'), 0);
        }

        // 15-minutely, which also moves the calendar on to the new day after midnight
        this.loadAgenda();
        this.loadShopping();
        clearInterval(this._agendaTimer);
        this._agendaTimer = setInterval(() => { this.loadAgenda(); this.loadShopping(); }, 15 * 60 * 1000);
        this.loadTicker();
        clearInterval(this._tickerTimer);
        this._tickerTimer = setInterval(() => this.loadTicker(), 10 * 60 * 1000);
        this.loadSun();
        clearInterval(this._sunTimer);
        this._sunTimer = setInterval(() => { this.loadSun(); this.checkSunsetSky(); }, 60 * 1000);

        if (this.info) {
            this.info.style.cursor = 'pointer';
            this.info.onclick = (e) => {
                e.stopPropagation();
                this.gotoFolder();
            };
        }

        await this.next();
        // Left on the sky last time: back to it (photos picked from the library are shown instead)
        let skyOn = false;
        try { skyOn = localStorage.getItem('slideshowSkyOn') === '1'; } catch { }
        if (skyOn && !items && this.isActive && !this.skyShowing && skySlideAvailable(this.sky)) {
            this.showSky();
            this.resetInterval();
        }
        this.checkSunsetSky();
        this.updateSkyButton();
    }

    // Takes the photo left from last time off the screen, so the first slide appears on its own
    // rather than transitioning from it.
    clearStage() {
        if (this._imgAnim) { this._imgAnim.cancel(); this._imgAnim = null; }
        if (this.img) {
            this.img.onload = null;
            this.img.removeAttribute('src');
            this.img.style.opacity = 0;
            this.img.style.animation = '';
            this.img.classList.remove('panorama');
        }
        if (this.bg) {
            this.bg.style.backgroundImage = 'none';
            this.bg.style.opacity = 0;
        }
        if (this.info) this.info.style.opacity = 0;
        this.currentPhoto = null;
        this._showNextAtOnce = true;
    }

    stop() {
        if (!this.isActive) return;
        clearTimeout(this._modeRetryTimer);
        clearInterval(this._agendaTimer);
        clearInterval(this._sunTimer);
        clearInterval(this._tickerTimer);
        if (this.storyOpen) closeTickerStory();
        console.log('[SLIDESHOW] Stopping...');
        this._browserCurrentHidden = false;
        this.closeBrowser();
        this.isActive = false;
        this.hideSky(true);
        this.sunsetHandled = null;
        this.clearZoom();
        this.stopVideo();
        this.slideIsVideo = false;
        if (typeof updateSsLyricsVisibility === 'function') updateSsLyricsVisibility();
        if ((this.mode === 'onThisDay' || this.mode === 'recent' || this.mode === 'favourites') && this.items.length > 0 && this.index >= 0) {
            const currentItem = this.items[this.index];
            this.resumeUrl = currentItem ? (currentItem.uri || currentItem.res) : null;
            this.resumeIndex = this.index;
            this.resumeMode = this.mode;
            this.resumeOrder = this.items;
        } else {
            this.resumeIndex = -1;
            this.resumeUrl = null;
            this.resumeMode = null;
            this.resumeOrder = null;
        }
        this.items = [];
        this.index = -1;
        if (this.mode === 'custom') {
            this.mode = localStorage.getItem('screensaverMode') || 'all';
            this.updateModeUI();
        }

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

    // Today's and tomorrow's entries (from the Calendar tab, not meals) and events (from subscribed
    // calendars) in the side panel, which only shows on landscape screens and scrolls when they don't
    // fit. A day with nothing on is left out, and the panel is left empty, and so hidden, when neither has anything.
    async loadAgenda() {
        const el = document.getElementById('ss-agenda');
        if (!el) return;
        const now = new Date();
        const AGENDA_DAYS = 2;
        const range = `start=${calendarDateKey(now)}&end=${calendarDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + AGENDA_DAYS))}`;
        try {
            const [cals, entryData, tagData, feedData] = await Promise.all([
                fetch('/api/calendars').then(r => r.json()),
                fetch(`/api/calendar-entries?${range}`).then(r => r.json()),
                fetch('/api/calendar-entries/tags').then(r => r.json()),
                fetch(`/api/calendars/events?${range}`).then(r => r.ok ? r.json() : { events: [] }),
            ]);
            const calsById = Object.fromEntries(cals.map(c => [c.id, c]));
            // This app's entries aren't in a calendar, so they're labelled with the tag their colour comes
            // from. Meals stay on the Meals tab.
            const entries = (entryData.entries || []).filter(e => !e.meal).map(e => ({
                title: e.title, allDay: true, startKey: e.date, endKey: e.date,
                source: e.tags?.[0] || '', color: tagData.colors?.[e.tags?.[0]],
            }));
            // All-day events carry date keys with an exclusive end; timed ones carry ISO times
            const events = (feedData.events || []).map(ev => ({
                title: ev.title, allDay: ev.allDay,
                startKey: ev.allDay ? ev.start : null, endKey: ev.allDay ? ev.end : null,
                start: ev.allDay ? null : new Date(ev.start), end: ev.allDay ? null : new Date(ev.end),
                source: calsById[ev.calendarId]?.name || '', color: calsById[ev.calendarId]?.color,
            }));
            const all = [...entries, ...events];
            const time = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            // Each day lists what overlaps it (so a multi-day event shows on each), all-day first, then by time
            const days = Array.from({ length: AGENDA_DAYS }, (_, offset) => {
                const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
                const label = offset === 0 ? 'Today' : 'Tomorrow';
                const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset + 1);
                const key = calendarDateKey(dayStart);
                const items = all.filter(it => it.allDay
                    ? (it.endKey === it.startKey ? it.startKey === key : it.startKey <= key && it.endKey > key)
                    : it.start < dayEnd && (it.end > dayStart || +it.start === +dayStart))
                    .sort((a, b) => (a.allDay === b.allDay ? (a.start || 0) - (b.start || 0) : a.allDay ? -1 : 1));
                return { label, items };
            }).filter(d => d.items.length);
            if (!days.length) {
                el.innerHTML = '';
                if (typeof updateSsLyricsVisibility === 'function') updateSsLyricsVisibility(); // more or less beside the lyrics
                return;
            }
            el.innerHTML = days.map(({ label, items }) => `<div class="ss-agenda-title">${label}</div><ul class="ss-agenda-list">${items.map(it => `
                <li class="${it.end && it.end < now ? 'past' : ''}">
                    <span class="ss-agenda-dot" style="background:${it.color || 'var(--accent)'}"></span>
                    <span class="ss-agenda-time">${it.allDay ? 'All day' : time(it.start)}</span>
                    <span class="ss-agenda-text">${escapeHtml(it.title)}</span>
                    ${it.source ? `<span class="ss-agenda-source" style="color:${it.color || 'var(--accent)'}">${escapeHtml(it.source)}</span>` : ''}
                </li>`).join('')}</ul>`).join('');
            if (typeof updateSsLyricsVisibility === 'function') updateSsLyricsVisibility(); // more or less beside the lyrics
        } catch (err) {
            console.warn('[SLIDESHOW] Calendar load failed:', err.message);
        }
    }

    // The next sunrise and sunset above the calendar, soonest first, from the night sky's location
    // (whether or not the sky itself is on); left empty, and so hidden, without a location
    loadSun() {
        const el = document.getElementById('ss-sun');
        if (!el) return;
        const loc = this.sky;
        if (loc?.lat == null || loc?.lon == null) { el.innerHTML = ''; return; }
        const now = Date.now();
        const { rise, set } = skyNextSunriseSunset(now, loc);
        // A sun on the horizon with an arrow: up for sunrise, down for sunset
        const icon = up => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 18a5 5 0 0 0-10 0"/>
            <line x1="2" y1="22" x2="22" y2="22"/><path d="${up ? 'M12 2v7M9 5l3-3 3 3' : 'M12 9V2M9 6l3 3 3-3'}"/></svg>`;
        const time = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        const event = (t, up) => `<span class="ss-sun-event">${icon(up)}<span class="ss-sun-label">${up ? 'Sunrise' : 'Sunset'}</span>
            <b>${time(t)}</b></span>`;
        el.innerHTML = [[rise, true], [set, false]].filter(([t]) => t !== null).sort((a, b) => a[0] - b[0])
            .map(([t, up]) => event(t, up)).join('');
    }

    // The shopping list in the side panel, one item per line, left empty (and so hidden) when there's
    // nothing on any list. With more than one list, a tab for each switches between them.
    async loadShopping() {
        if (!document.getElementById('ss-shopping')) return;
        try {
            const res = await fetch('/api/shopping-lists');
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load the shopping lists');
            this.shoppingLists = data.lists;
            this.renderShopping();
        } catch (err) {
            console.warn('[SLIDESHOW] Shopping list load failed:', err.message);
        }
    }

    renderShopping() {
        const el = document.getElementById('ss-shopping');
        const lists = this.shoppingLists || [];
        const linesOf = list => list.text.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lists.some(l => linesOf(l).length)) {
            el.innerHTML = '';
            if (typeof updateSsLyricsVisibility === 'function') updateSsLyricsVisibility(); // more or less beside the lyrics
            return;
        }
        const current = currentShoppingList(lists);
        const lines = linesOf(current);
        const header = lists.length < 2 ? `<div class="ss-agenda-title">${escapeHtml(current.name)}</div>`
            : `<div class="ss-shopping-tabs" role="tablist">${lists.map(l => `
                <button type="button" role="tab" class="ss-shopping-tab${l === current ? ' active' : ''}" aria-selected="${l === current}"
                    onclick="event.stopPropagation(); slideshow.showShoppingList('${escapeHtml(l.id)}')">${escapeHtml(l.name)}</button>`).join('')}</div>`;
        el.innerHTML = header + (lines.length ? `<ul class="ss-shopping-list">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
            : '<div class="ss-shopping-empty">Nothing on this list</div>');
        if (typeof updateSsLyricsVisibility === 'function') updateSsLyricsVisibility(); // more or less beside the lyrics
    }

    // A tab's list, which the shopping list dialog then opens on too
    showShoppingList(id) {
        setShoppingListId(id);
        this.renderShopping();
        loadShoppingList();
    }

    resetInterval() {
        if (this.interval) clearInterval(this.interval);
        // A playing video moves the slideshow on itself, when it ends or runs out of time
        const videoPlaying = this.slideIsVideo && this.videoShowing && !this.video.ended;
        // A zoomed-in photo stays up until it's tapped back out, and the photos wait while the sky
        // or a news story is up
        if (this.isActive && this.duration > 0 && !videoPlaying && !this.zoomed && !this.skyShowing && !this.storyOpen) {
            this.interval = setInterval(() => this.next(), this.duration);
        }
    }

    async next() {
        if (this.browserOpen) return;
        if (!this.isActive || (typeof document !== 'undefined' && document.hidden)) {
            this.resetInterval();
            return;
        }

        // Moving on from the sky goes back to the photos
        if (this.skyShowing) {
            this.hideSky();
            try { localStorage.setItem('slideshowSkyOn', ''); } catch { }
        }

        try {
            let data;
            if (this.items.length > 0 && this.listVersion !== null) await this.refreshListIfStale();
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
                    tags: slideshowItemTags(item),
                    key: item.key,
                    isVideo: !!item.isVideo,
                    liveVideo: item.liveVideo || null,
                    manualRotation: manualRotations[item.key || originalUrl] || 0,
                    folderId: item.folderId || (browsePath.length > 0 ? browsePath[browsePath.length - 1].id : '0'),
                    folderTitle: item.folderTitle || (browsePath.length > 0 ? browsePath[browsePath.length - 1].title : 'Library')
                };

                // Proxy if remote
                if (!data.isVideo && data.url && data.url.startsWith('http') && !data.url.includes(window.location.host)) {
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
            } else if (this.mode === 'onThisDay' || this.mode === 'recent' || this.mode === 'favourites') {
                // Load all matching photos into items array and cycle sequentially
                const listRes = await fetch(`/api/slideshow/list?mode=${this.mode}`);
                if (listRes.ok) {
                    const items = await listRes.json();
                    if (items.length > 0) {
                        clearTimeout(this._modeRetryTimer);
                        const resuming = this.resumeMode === this.mode;
                        // Shuffle once; when resuming, keep the order already being cycled
                        this.items = this.shuffleInto(resuming ? (this.resumeOrder || []) : [], items, resuming ? this.resumeUrl : null);
                        this.listVersion = this.listVersionOf(listRes, 0);
                        if (resuming) {
                            // Try to resume by URL so deleted items don't shift position
                            let resumePos = -1;
                            if (this.resumeUrl) {
                                resumePos = this.items.findIndex(i => (i.uri || i.res) === this.resumeUrl);
                            }
                            // Fallback to saved index if URL not found (e.g. it was deleted)
                            if (resumePos === -1 && this.resumeIndex >= 0 && this.resumeIndex < this.items.length) {
                                resumePos = this.resumeIndex;
                            }
                            this.index = resumePos - 1; // next() will increment
                        } else {
                            this.index = -1;
                        }
                        this.resumeIndex = -1;
                        this.resumeUrl = null;
                        this.resumeMode = null;
                        this.resumeOrder = null;
                        return this.next();
                    }
                }
                // Keep the selected mode — just wait if preparing, or show toast if no photos
                const labels = { onThisDay: 'Day', recent: 'Recent', favourites: 'Favs' };
                const label = labels[this.mode] || this.mode;
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

    // Another browser may have deleted photos since this Day/Recent/Favs list was fetched.
    // If the server's delete counter has moved on, re-fetch the list and carry on from
    // the photo currently on screen so the sequence isn't restarted.
    async refreshListIfStale() {
        try {
            const vRes = await fetch('/api/slideshow/deleted-version');
            if (!vRes.ok) return;
            const { version } = await vRes.json();
            if (version === this.listVersion) return;

            const listRes = await fetch(`/api/slideshow/list?mode=${this.mode}`);
            // 404 = nothing left in this mode; anything else (e.g. 503 while the server
            // rebuilds its cache) keeps the current list and retries on the next slide
            if (!listRes.ok && listRes.status !== 404) return;
            const current = this.index >= 0 ? this.items[this.index] : null;
            const currentUrl = current ? (current.uri || current.res) : null;
            const items = this.shuffleInto(this.items, listRes.ok ? await listRes.json() : [], currentUrl);
            let pos = currentUrl ? items.findIndex(i => (i.uri || i.res) === currentUrl) : -1;
            // Current photo is gone: the one after it has slid down into its slot
            if (pos === -1) pos = Math.max(-1, Math.min(this.index, items.length) - 1);

            this.items = items;
            this.index = pos;
            this.listVersion = listRes.ok ? this.listVersionOf(listRes, version) : null;
        } catch (e) {
            console.warn('[SLIDESHOW] List refresh failed:', e);
        }
    }

    // Day/Recent/Favs lists are shuffled once and then cycled in that order. Photos already in
    // `order` keep their places (dropping any no longer in `items`); new ones are slotted in at
    // random points after `currentUrl`, so they still turn up this time round.
    shuffleInto(order, items, currentUrl) {
        const urlOf = i => i.uri || i.res;
        const fresh = new Map(items.map(i => [urlOf(i), i]));
        const merged = order.filter(i => fresh.has(urlOf(i))).map(i => fresh.get(urlOf(i)));
        const known = new Set(merged.map(urlOf));
        const start = currentUrl ? merged.findIndex(i => urlOf(i) === currentUrl) + 1 : 0;
        for (const item of fresh.values()) {
            if (known.has(urlOf(item))) continue;
            merged.splice(start + Math.floor(Math.random() * (merged.length - start + 1)), 0, item);
        }
        return merged;
    }

    // A list sent while the server is still scanning holds only the photos found so far:
    // give it a version the server never uses so refreshListIfStale re-fetches it every slide.
    listVersionOf(listRes, fallback) {
        if (listRes.headers.get('X-Scan-Partial') === '1') return -1;
        return Number(listRes.headers.get('X-Deleted-Version')) || fallback;
    }

    async previous() {
        // Back from the sky is the photo still under it
        if (this.skyShowing) {
            this.toggleSky();
            return;
        }
        if (this.items.length > 0) {
            this.index = (this.index - 1 + this.items.length) % this.items.length;
            const item = this.items[this.index];
            const originalUrl = item.uri || item.res;
            const data = {
                url: originalUrl,
                originalUrl: originalUrl,
                title: item.title,
                date: item.year || item.date || item['dc:date'] || '',
                location: item.artist || item.creator || '',
                latitude: item.latitude,
                longitude: item.longitude,
                camera: item.camera || '',
                tags: slideshowItemTags(item),
                key: item.key,
                isVideo: !!item.isVideo,
                liveVideo: item.liveVideo || null,
                manualRotation: manualRotations[item.key || originalUrl] || 0,
                folderId: item.folderId || (browsePath.length > 0 ? browsePath[browsePath.length - 1].id : '0'),
                folderTitle: item.folderTitle || (browsePath.length > 0 ? browsePath[browsePath.length - 1].title : 'Library')
            };
            if (!data.isVideo && data.url && data.url.startsWith('http') && !data.url.includes(window.location.host)) {
                data.url = `/api/proxy-image?url=${encodeURIComponent(data.url)}`;
            }
            this.renderPhoto(data);
            this.resetInterval();
            return;
        }

        // Fallback for single-photo mode: swap with stored previous
        if (!this.previousPhoto) return;
        const temp = {
            url: this.currentPhoto,
            rotation: this.rotation,
            data: this.currentPhotoData
        };
        this.renderPhoto({
            ...this.previousPhoto.data,
            url: this.previousPhoto.url,
            manualRotation: this.previousPhoto.rotation
        });
        this.previousPhoto = temp;
        this.resetInterval();
    }

    // Random transition, never the same one twice in a row; plain fade if the user prefers reduced motion
    pickTransition() {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return SS_TRANSITIONS.fade;
        const names = Object.keys(SS_TRANSITIONS).filter(n => n !== this._lastTransition);
        this._lastTransition = names[Math.floor(Math.random() * names.length)];
        return SS_TRANSITIONS[this._lastTransition];
    }

    // Runs one half ('out' or 'in') of a transition on the slideshow image
    animateImg(fx, phase) {
        if (!this.img.animate) return;
        if (this._imgAnim) this._imgAnim.cancel();

        // Every keyframe uses the same function list so the browser interpolates each
        // part directly. The effect comes first so it acts in screen space, and the
        // photo's own rotation comes last.
        const frame = ({ x = 0, y = 0, rx = 0, ry = 0, rz = 0, s = 1, o = 1 } = {}) => ({
            transform: `perspective(1400px) translate3d(${x}, ${y}, 0) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${s}) rotate(${this.rotation}deg)`,
            opacity: o
        });

        const keyframes = phase === 'out' ? [frame(), frame(fx.out)] : [frame(fx.in), frame()];
        this._imgAnim = this.img.animate(keyframes, {
            duration: phase === 'out' ? fx.outMs : fx.inMs,
            easing: phase === 'out' ? (fx.easeOut || 'cubic-bezier(.55,0,.75,.2)') : (fx.easeIn || 'cubic-bezier(.25,.8,.35,1)'),
            // Hold the exit's end state until the new photo is ready to enter
            fill: phase === 'out' ? 'forwards' : 'none'
        });
    }

    // Zooms the photo in on a screen point (kept under the finger), or back out if it's zoomed.
    // Uses the scale/translate properties, which sit outside the transform that the rotation,
    // transitions and panorama pan own; a uniform scale about the centre commutes with the rotation.
    toggleZoom(x, y) {
        if (this.zoomed) {
            this.clearZoom();
            this.resetInterval();
            return;
        }
        if (this.slideIsVideo || this.img.classList.contains('panorama')) return;
        const r = this.img.getBoundingClientRect();
        const s = 3.5;
        // Clamped to the photo's box, so a tap in the margin doesn't zoom into black
        const dx = Math.min(Math.max(x, r.left), r.right) - (r.left + r.width / 2);
        const dy = Math.min(Math.max(y, r.top), r.bottom) - (r.top + r.height / 2);
        this.zoomed = true;
        // Dragging stops at the photo's edges, so it always fills the space it had before zooming.
        // The element is the whole screen (object-fit: contain), so work out the photo's own size in it.
        const bw = this.img.offsetWidth, bh = this.img.offsetHeight;
        const fit = Math.min(bw / (this.img.naturalWidth || bw), bh / (this.img.naturalHeight || bh));
        let pw = (this.img.naturalWidth || bw) * fit, ph = (this.img.naturalHeight || bh) * fit;
        if (this.rotation % 180) [pw, ph] = [ph, pw];
        this.zoomLimit = { x: (s - 1) * pw / 2, y: (s - 1) * ph / 2 };
        this.img.classList.add('zoomed');
        // Rotating would leave the zoom and its drag limits the wrong way round
        document.getElementById('ss-rotate-item')?.classList.add('disabled');
        this.img.style.scale = s;
        this.setZoomPan((1 - s) * dx, (1 - s) * dy);
        this.resetInterval();
    }

    setZoomPan(x, y) {
        const clamp = (v, max) => Math.min(Math.max(v, -max), max);
        this.zoomPan = { x: clamp(x, this.zoomLimit.x), y: clamp(y, this.zoomLimit.y) };
        this.img.style.translate = `${this.zoomPan.x}px ${this.zoomPan.y}px`;
    }

    clearZoom() {
        this.zoomed = false;
        this.img.classList.remove('zoomed', 'dragging');
        document.getElementById('ss-rotate-item')?.classList.remove('disabled');
        this.img.style.scale = '';
        this.img.style.translate = '';
    }

    renderPhoto(data) {
        // The first slide after starting appears straight away, with no transition. If it's the
        // photo clicked in the file browser, the thumbnail already loaded there stands in for it
        // while the full-size photo loads.
        const atOnce = this._showNextAtOnce;
        this._showNextAtOnce = false;
        const placeholder = atOnce && this.placeholder?.url === (data.originalUrl || data.url) ? this.placeholder.src : null;
        this.placeholder = null;
        // Moving on (or off) a photo zooms it back out first
        if (data.url !== this.currentPhoto) this.clearZoom();
        if (data.isVideo) return this.renderVideo(data);
        if (data.url === this.currentPhoto && this.img.style.opacity == 1) {
            if (this.mode === 'nowPlaying') this.updateInfoUI(data);
            return;
        }
        this.slideIsVideo = false;
        this._videoToken = null; // a video still fading in gives way to this photo

        // instant: no exit or entrance (the first slide). src: what to show, if not the photo itself.
        const doTransition = (naturalWidth, naturalHeight, { instant = false, src = null } = {}) => {
            const fx = this.pickTransition();
            // Coming from a video: fade it out while the transition's exit runs
            if (this.videoShowing) this.video.style.opacity = 0;
            if (!instant) {
                // A panning panorama's transform belongs to its CSS animation, so only fade it out
                this.animateImg(this.img.classList.contains('panorama') ? SS_TRANSITIONS.fade : fx, 'out');
            }
            this.img.style.opacity = 0;
            if (this.info) this.info.style.opacity = 0;

            const showNew = () => {
                if (this.currentPhoto) {
                    this.previousPhoto = {
                        url: this.currentPhoto,
                        rotation: this.rotation,
                        data: this.currentPhotoData
                    };
                }
                this.stopVideo();

                const shown = src || mediaUrl(data.url);
                if (this.bg) {
                    const setBg = () => {
                        this.bg.style.backgroundImage = `url("${shown.replace(/"/g, '%22')}")`;
                        this.bg.style.opacity = 1;
                    };
                    if (instant) setBg();
                    else {
                        this.bg.style.opacity = 0;
                        setTimeout(setBg, 500);
                    }
                }

                this.img.onload = null;
                this.img.src = shown;
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
                    const ratio = w / h;
                    const isPanorama = ratio > 2.2;
                    if (!instant) this.animateImg(isPanorama ? SS_TRANSITIONS.fade : fx, 'in');
                    this.img.style.opacity = 1;
                    if (this.info) this.info.style.opacity = 1;
                    this.img.classList.toggle('panorama', isPanorama);
                    this.img.style.animation = 'none';
                    void this.img.offsetWidth; // force reflow
                    if (isPanorama) {
                        const dur = Math.max((this.duration || 60000) / 1000, 20);
                        // How far the full-height image overflows the viewport; we
                        // slide it half that distance each way. Pure transform =>
                        // compositor-only, no per-frame repaint (smooth on a Pi).
                        // (On a landscape screen the side panel takes part of the width.)
                        const sidePanel = document.getElementById('ss-side-panel');
                        const visibleWidth = (this.img.parentElement?.clientWidth || window.innerWidth) - (sidePanel?.offsetWidth || 0);
                        const overflowX = Math.max(this.img.getBoundingClientRect().width - visibleWidth, 0);
                        this.img.style.setProperty('--pano-shift', `${overflowX / 2}px`);
                        this._panoramaDir = (this._panoramaDir === undefined) ? false : !this._panoramaDir;
                        const animName = this._panoramaDir ? 'panoramaPanRL' : 'panoramaPanLR';
                        this.img.style.animation = `${animName} ${dur}s ease-in-out forwards`;
                    } else {
                        this.img.style.removeProperty('--pano-shift');
                        this.img.style.animation = '';
                    }
                };

                if (this.img.complete) {
                    applyDisplay(naturalWidth || this.img.naturalWidth, naturalHeight || this.img.naturalHeight);
                } else {
                    this.img.onload = () => applyDisplay(this.img.naturalWidth, this.img.naturalHeight);
                }
                if (data.liveVideo) setTimeout(() => this.playLive(data), instant ? 0 : fx.inMs);
            };
            if (instant) showNew();
            else setTimeout(showNew, fx.outMs);
        };

        if (placeholder) {
            // Up at once from the browser's cache; the full-size photo replaces it, unanimated, when
            // it arrives (unless the slideshow has moved on by then).
            doTransition(0, 0, { instant: true, src: placeholder });
            const full = new Image();
            full.onload = () => {
                if (this.currentPhoto !== data.url || !this.isActive) return;
                this.img.onload = null;
                this.img.src = full.src;
                // In case it beat the thumbnail, whose onload would have shown it
                if (this.img.style.opacity !== '1') {
                    this.img.style.opacity = 1;
                    if (this.info) this.info.style.opacity = 1;
                }
                if (this.bg) this.bg.style.backgroundImage = `url("${full.src.replace(/"/g, '%22')}")`;
            };
            full.src = mediaUrl(data.url);
            return;
        }

        // Preload the image so the current photo stays visible until the new one is ready
        const preload = new Image();
        preload.onload = () => doTransition(preload.naturalWidth, preload.naturalHeight, { instant: atOnce });
        preload.onerror = () => doTransition(0, 1, { instant: atOnce });
        preload.src = mediaUrl(data.url);
    }

    // A video slide (usually a Live Photo) fades in once it's playing, muted unless video sound is
    // on, and plays once. With photos moving on by themselves it stays up for the photo time,
    // holding on its last frame if it's shorter, and a longer one is cut short at the video limit.
    renderVideo(data) {
        this.slideIsVideo = true;
        const fx = SS_TRANSITIONS.fade;
        if (this.videoShowing) this.video.style.opacity = 0;
        else {
            this.animateImg(this.img.classList.contains('panorama') ? fx : this.pickTransition(), 'out');
            this.img.style.opacity = 0;
        }
        if (this.info) this.info.style.opacity = 0;
        const token = this._videoToken = {};

        setTimeout(() => {
            if (this._videoToken !== token || !this.isActive) return;
            if (this.currentPhoto) {
                this.previousPhoto = { url: this.currentPhoto, rotation: this.rotation, data: this.currentPhotoData };
            }
            this.stopVideo();
            this.img.style.display = 'none';
            this.img.classList.remove('panorama');
            this.img.style.animation = '';

            const src = data.originalUrl || data.url;
            if (this.bg) {
                const thumb = photoGridThumbUrl(src);
                this.bg.style.backgroundImage = thumb ? `url("${thumb.replace(/"/g, '%22')}")` : 'none';
            }
            this.currentPhoto = data.url;
            this.originalUrl = src;
            this.currentPhotoData = data;
            this.rotation = data.manualRotation || 0;
            if (this.favBtn) this.favBtn.classList.toggle('is-favourite', !!data.tags?.includes('fav'));
            this.updateInfoUI(data);

            const v = this.video;
            const autoAdvance = this.duration > 0;
            this.videoShowing = true;
            if (this.interval) clearInterval(this.interval);
            v.style.display = '';
            v.style.opacity = 0;
            v.style.transform = this.rotation ? `rotate(${this.rotation}deg)` : '';
            v.muted = !this.videoSound;
            this.updateSoundButton();
            let startedAt = 0;
            v.onplaying = () => {
                v.onplaying = null;
                startedAt = Date.now();
                v.style.opacity = 1;
                if (this.info) this.info.style.opacity = 1;
                if (!autoAdvance) return;
                // Up for at least the photo time, and cut short at the video limit
                this._videoTimer = setTimeout(() => { if (v.ended) this.next(); }, this.duration);
                if (this.videoMaxSeconds > 0) {
                    this._videoMaxTimer = setTimeout(() => this.next(), Math.max(this.videoMaxSeconds * 1000, this.duration));
                }
            };
            v.onended = () => { if (autoAdvance && Date.now() - startedAt >= this.duration) this.next(); };
            v.onerror = () => {
                console.warn('[SLIDESHOW] Video failed to play:', src);
                if (autoAdvance) this._videoTimer = setTimeout(() => this.next(), 3000);
            };
            v.src = mediaUrl(browserPlayableVideoUrl(src));
            // Browsers can refuse to start a video with sound until the page has been used; play it silently then
            v.play().catch(() => {
                if (v.muted) return;
                v.muted = true;
                v.play().catch(() => { });
            });
        }, fx.outMs);
    }

    // A Live Photo's clip, played once in place of its photo and then back to the still: when the
    // photo comes up (heard only with video sound on), and again when it's held down
    playLive(data, withSound = this.videoSound) {
        if (!data?.liveVideo || this.currentPhotoData !== data || this.slideIsVideo || !this.isActive) return;
        this.stopVideo();
        const v = this.video;
        this.videoShowing = true;
        v.muted = !withSound;
        // Swapped in at once rather than faded, so the photo doesn't dip to black
        v.style.transition = 'none';
        v.style.opacity = 1;
        v.style.transform = this.rotation ? `rotate(${this.rotation}deg)` : '';
        v.onplaying = () => {
            v.onplaying = null;
            this.img.style.display = 'none';
            v.style.display = '';
        };
        v.onended = v.onerror = () => this.stopVideo();
        v.src = mediaUrl(browserPlayableVideoUrl(data.liveVideo));
        v.play().catch(() => {
            if (v.muted) return this.stopVideo();
            v.muted = true;
            v.play().catch(() => this.stopVideo());
        });
    }

    // Takes down the video slide (or Live Photo clip), if one is up, and puts the photo back in its place
    stopVideo() {
        clearTimeout(this._videoTimer);
        clearTimeout(this._videoMaxTimer);
        if (!this.videoShowing) return;
        this.videoShowing = false;
        const v = this.video;
        v.onplaying = v.onended = v.onerror = null;
        v.pause();
        v.removeAttribute('src');
        v.load();
        v.style.display = 'none';
        v.style.transition = '';
        this.img.style.display = '';
        this.updateSoundButton();
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

        const browseItem = document.getElementById('ss-browse-item');
        if (browseItem) browseItem.style.display = this.items.length > 1 ? '' : 'none';

        if (typeof updateSsLyricsVisibility === 'function') updateSsLyricsVisibility();

        currentScreensaverFolder = { id: data.folderId, title: data.folderTitle };
        this.renderPeople();

        // Always fetch full metadata to get camera info (and GPS fallback).
        // The server's 64KB range-fetch often misses EXIF data deeper in the file.
        this.fetchMetadataFallback(data);
    }

    // ─── People bar ──────────────────────────────────────────────────────────
    // Along the bottom: the people (from Tag Faces) tagged in the photo showing. Tap one to take
    // them off it, or + to show everyone and tap them on. Saved straight away.

    async loadPeople() {
        try {
            const res = await fetch('/api/faces/people');
            if (!res.ok) return;
            const data = await res.json();
            this.peopleNames = (data.people || []).map(p => p.name).sort((a, b) => a.localeCompare(b));
            this.renderPeople();
        } catch (e) { }
    }

    renderPeople() {
        const el = this.peopleEl;
        if (!el) return;
        const data = this.currentPhotoData;
        const photoKey = data ? (data.originalUrl || data.url) : null;
        if (photoKey !== this.peoplePhoto) {
            this.peoplePhoto = photoKey;
            this.peopleOpen = false;
            this.peopleTouched.clear();
        }
        if (!data || !this.peopleNames.length || this.mode === 'nowPlaying') {
            this.overlay?.classList.remove('people-open');
            el.hidden = true;
            return;
        }
        const tags = new Set((data.tags || []).map(t => t.toLowerCase()));
        const isIn = name => tags.has(name.toLowerCase());
        const names = this.peopleOpen ? this.peopleNames : this.peopleNames.filter(n => isIn(n) || this.peopleTouched.has(n));
        el.innerHTML = names.map(n =>
            `<button class="ss-person${isIn(n) ? ' on' : ''}" data-name="${escapeHtml(n)}" aria-pressed="${isIn(n)}" title="${isIn(n) ? `Take ${escapeHtml(n)} off this photo` : `Tag ${escapeHtml(n)} in this photo`}">${escapeHtml(n)}</button>`).join('') +
            (this.peopleOpen ? `<button class="ss-person ss-person-new" data-new title="Someone not on the list yet">New...</button>` : '') +
            `<button class="ss-person ss-person-more" data-more title="${this.peopleOpen ? 'Just the people in this photo' : 'Tag someone in this photo'}">${this.peopleOpen ? 'Done' : '+'}</button>`;
        el.classList.toggle('open', this.peopleOpen);
        this.overlay?.classList.toggle('people-open', this.peopleOpen);
        el.hidden = false;
    }

    peopleClick(event) {
        event.stopPropagation();
        const btn = event.target.closest('button');
        if (!btn) return;
        if (btn.dataset.more != null) {
            this.peopleOpen = !this.peopleOpen;
            this.renderPeople();
        } else if (btn.dataset.new != null) {
            this.addNewPerson();
        } else if (btn.dataset.name) {
            this.togglePerson(btn.dataset.name);
        }
        this.resetInterval();   // time to tap more than one
    }

    // Someone not on the list: added to the people Tag Faces knows (with no faces yet, so it can be
    // shown who they are later) and tagged in this photo.
    async addNewPerson() {
        const data = this.currentPhotoData;
        const typed = prompt('Who is in this photo?', '')?.trim();
        this.resetInterval();
        if (!typed || !data) return;
        let name = this.peopleNames.find(n => n.toLowerCase() === typed.toLowerCase());
        if (!name) {
            try {
                const res = await fetch('/api/faces/people', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: typed, samples: [] }),
                });
                const result = await res.json();
                if (!res.ok) throw new Error(result.error || res.statusText);
                name = result.person.name;
                if (!this.peopleNames.includes(name)) this.peopleNames = [...this.peopleNames, name].sort((a, b) => a.localeCompare(b));
            } catch (err) {
                return showToast(`Couldn't add ${typed}: ${err.message}`, 'error', 4000);
            }
        }
        if (this.currentPhotoData !== data) return;
        if ((data.tags || []).some(t => t.toLowerCase() === name.toLowerCase())) return this.renderPeople();
        await this.togglePerson(name);
    }

    async togglePerson(name) {
        const data = this.currentPhotoData;
        if (!data) return;
        const uri = data.originalUrl || data.url;
        const before = data.tags || [];
        const on = before.some(t => t.toLowerCase() === name.toLowerCase());
        const tags = on ? before.filter(t => t.toLowerCase() !== name.toLowerCase()) : [...before, name];
        const setTags = list => {
            data.tags = list;
            // The same photo in the slideshow's list, so it's right next time round
            for (const item of this.items || []) {
                if (!((data.key && item.key === data.key) || (item.uri || item.res) === uri)) continue;
                if (item.tagKey) {
                    // A file browser item, which keeps its favourite apart from its other tags
                    item.fav = list.includes('fav') || undefined;
                    item.tags = list.filter(t => t !== 'fav');
                } else item.tags = [...list];
            }
        };
        setTags(tags);
        this.peopleTouched.add(name);
        this.renderPeople();
        try {
            const res = await fetch('/api/file-tags', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uri, tags }),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
            if (typeof showBrowserTags === 'function') showBrowserTags(i => i.uri === uri || (data.key && i.tagKey === data.key), tags);
            if (!on && typeof allLibraryTags !== 'undefined' && !allLibraryTags.includes(name)) allLibraryTags = [...allLibraryTags, name].sort();
        } catch (err) {
            if (this.currentPhotoData === data) { setTags(before); this.renderPeople(); }
            showToast(`Couldn't save the tags: ${err.message}`, 'error', 4000);
        }
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
        // Videos have no photo metadata to read
        if (!rawUrl || data.isVideo) {
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
        const modes = ['all', 'onThisDay', 'recent', 'favourites', 'nowPlaying'];
        this.mode = modes[(modes.indexOf(this.mode) + 1) % modes.length];
        localStorage.setItem('screensaverMode', this.mode);
        this.updateModeUI();
        this.items = [];
        this.index = -1;
        this.next();
    }

    updateModeUI() {
        if (this.modeLabel) {
            const labels = { all: 'All', onThisDay: 'Day', recent: 'Recent', favourites: 'Favs', nowPlaying: 'Music', custom: 'Custom' };
            this.modeLabel.textContent = labels[this.mode] || 'All';
            this.modeLabel.classList.toggle('long', this.modeLabel.textContent.length > 4);
        }
        const retryBtn = document.getElementById('btn-ss-retry-art');
        if (retryBtn) retryBtn.style.display = this.mode === 'nowPlaying' ? '' : 'none';
        if (typeof updateSsLyricsVisibility === 'function') updateSsLyricsVisibility();
    }

    async rotate(delta) {
        if (!this.currentPhoto || this.zoomed) return;
        this.rotation = (this.rotation + delta) % 360;
        if (this.rotation < 0) this.rotation += 360;
        this.img.style.setProperty('--ss-rotation', `${this.rotation}deg`);
        if (this.videoShowing) this.video.style.transform = this.rotation ? `rotate(${this.rotation}deg)` : '';

        const urlForSave = this.originalUrl || this.currentPhoto;
        try {
            const res = await fetch('/api/slideshow/rotate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: urlForSave, rotation: this.rotation })
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
            // Update client-side cache
            manualRotations[this.currentPhotoData?.key || urlForSave] = this.rotation;
        } catch (e) {
            console.error('Rotate save failed:', e);
            showToast('Rotate failed: ' + e.message, 'error', 4000);
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
                // The photo showing too, so tagging someone next saves the favourite as it is now
                const shown = this.currentPhotoData;
                if (shown && (shown.originalUrl || shown.url) === urlToFav) {
                    const others = (shown.tags || []).filter(t => t !== 'fav');
                    shown.tags = newState ? ['fav', ...others] : others;
                }
                // Update in-memory item so the heart stays correct next time around
                if (this.items && this.index >= 0 && this.index < this.items.length) {
                    const item = this.items[this.index];
                    if (!item.tags) item.tags = [];
                    if (item.tagKey) {
                        // A file browser item keeps its favourite apart from its other tags
                        item.fav = newState || undefined;
                        item.tags = item.tags.filter(t => t !== 'fav');
                    } else if (newState) {
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

    // ─── Browser: grid of the photos in the current list ─────────────────────

    openBrowser() {
        if (!this.isActive || this.items.length === 0 || this.browserOpen) return;
        this.browserOpen = true;
        this._browserCurrentHidden = false;
        this.browserSelection = new Set(); // items (not indices, which shift as photos are hidden)
        this._browserLastPicked = null;
        this.updateBrowserSelectionUI();
        if (this.interval) clearInterval(this.interval); // paused while browsing
        if (this.videoShowing) this.video.pause();

        const labels = { onThisDay: 'Day', recent: 'Recent', favourites: 'Favs', custom: 'Custom' };
        document.getElementById('ss-browser-title').textContent = labels[this.mode] || 'Slideshow';
        this.browserGrid = document.getElementById('ss-browser-grid');
        this.browserGrid.innerHTML = '';
        this.attachBrowserLongPress();
        this.browserRendered = 0;
        this.updateBrowserCount();
        do this.renderBrowserBatch(); while (this.browserRendered <= this.index && this.browserRendered < this.items.length);

        document.getElementById('ss-browser').style.display = 'flex';
        // Scroll only the grid's own body: scrollIntoView would also scroll the slideshow overlay and page
        // (even overflow:hidden ones), pushing the header with the close/quit controls off the top
        const body = document.getElementById('ss-browser-body');
        const tile = this.browserGrid.querySelector('.photo-tile.current');
        if (tile) {
            const offset = tile.getBoundingClientRect().top - body.getBoundingClientRect().top;
            body.scrollTop += offset - (body.clientHeight - tile.offsetHeight) / 2;
        }

        // Add the next batch of tiles as the bottom of the grid scrolls into view
        this._browserObserver = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) this.renderBrowserBatch();
        }, { root: document.getElementById('ss-browser-body'), rootMargin: '600px' });
        this._browserObserver.observe(document.getElementById('ss-browser-more'));

        this._browserKey = (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            if (this.browserSelection.size > 0) this.clearBrowserSelection();
            else this.closeBrowser();
        };
        document.addEventListener('keydown', this._browserKey);
    }

    closeBrowser() {
        if (!this.browserOpen) return;
        this.browserOpen = false;
        document.getElementById('ss-browser').style.display = 'none';
        this._browserObserver?.disconnect();
        document.removeEventListener('keydown', this._browserKey);
        this.browserGrid.innerHTML = '';
        this.browserSelection.clear();
        if (!this.isActive) return;
        // The photo that was on screen got hidden: move on to the one that took its place
        if (this._browserCurrentHidden) this.next();
        else {
            if (this.videoShowing && !this.video.ended) this.video.play().catch(() => { });
            this.resetInterval();
        }
    }

    // Carry on the slideshow from the chosen photo
    jumpTo(i) {
        if (i < 0 || i >= this.items.length) return;
        this._browserCurrentHidden = false;
        this.closeBrowser();
        this.index = i - 1; // next() will increment
        this.next();
    }

    updateBrowserCount() {
        document.getElementById('ss-browser-count').textContent = `(${this.items.length})`;
    }

    renderBrowserBatch() {
        if (!this.browserOpen || this.browserRendered >= this.items.length) return;
        const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const end = Math.min(this.items.length, this.browserRendered + 200);
        let html = '';
        for (let i = this.browserRendered; i < end; i++) {
            const item = this.items[i];
            const url = item.uri || item.res;
            const thumb = photoGridThumbUrl(url);
            const rot = manualRotations[item.key || url] || 0;
            const img = thumb
                ? `<img src="${escAttr(thumb)}" loading="lazy" decoding="async" alt=""${rot ? ` style="transform: rotate(${rot}deg)"` : ''} onerror="onPhotoGridThumbError(this)">`
                : '<span class="photo-tile-missing">Unavailable</span>';
            const selected = this.browserSelection.has(item);
            html += `<div class="photo-tile${i === this.index ? ' current' : ''}${selected ? ' selected' : ''}${item.isVideo ? ' video' : ''}" data-index="${i}" title="${escAttr(item.title || '')}">
                <button class="photo-tile-view" onclick="slideshow.onBrowserTileClick(+this.parentElement.dataset.index, event)">${img}</button>
                <button class="photo-tile-select" onclick="slideshow.toggleBrowserSelection(+this.parentElement.dataset.index, event.shiftKey)" title="Select (shift-click for a range)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
                </button>
                <div class="photo-tile-actions">
                    <button class="danger" onclick="slideshow.hideFromBrowser(+this.closest('.photo-tile').dataset.index)" title="Hide from slideshow">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
                    </button>
                </div>
            </div>`;
        }
        this.browserGrid.insertAdjacentHTML('beforeend', html);
        this.browserRendered = end;
    }

    // Touch: holding a tile selects it, the way phone galleries start a selection
    attachBrowserLongPress() {
        const grid = this.browserGrid;
        if (grid._longPress) return;
        grid._longPress = true;
        let timer = null, startX = 0, startY = 0, suppressClick = false;
        const cancel = () => { clearTimeout(timer); timer = null; };

        grid.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' || e.target.closest('.photo-tile-select, .photo-tile-actions')) return;
            const tile = e.target.closest('.photo-tile');
            if (!tile) return;
            suppressClick = false;
            startX = e.clientX; startY = e.clientY;
            cancel();
            timer = setTimeout(() => {
                timer = null;
                suppressClick = true;
                navigator.vibrate?.(30);
                const i = +tile.dataset.index;
                if (!this.browserSelection.has(this.items[i])) this.toggleBrowserSelection(i);
            }, 500);
        });
        grid.addEventListener('pointermove', (e) => {
            if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel();
        });
        grid.addEventListener('pointerup', cancel);
        grid.addEventListener('pointercancel', cancel);
        // The tap that ends a long-press mustn't also toggle/jump
        grid.addEventListener('click', (e) => {
            if (!suppressClick) return;
            suppressClick = false;
            e.stopPropagation();
            e.preventDefault();
        }, true);
        grid.addEventListener('contextmenu', (e) => {
            if (e.pointerType !== 'mouse' && (timer || suppressClick)) e.preventDefault();
        });
    }

    // Once anything is selected, tapping a tile adds to the selection instead of leaving the browser
    onBrowserTileClick(i, e) {
        if (this.browserSelection.size > 0 || e.shiftKey || e.ctrlKey || e.metaKey) this.toggleBrowserSelection(i, e.shiftKey);
        else this.jumpTo(i);
    }

    // Shift selects every tile from the last one picked up to this one
    toggleBrowserSelection(i, range = false) {
        const item = this.items[i];
        if (!item) return;
        const last = range && this._browserLastPicked ? this.items.indexOf(this._browserLastPicked) : -1;
        if (last >= 0) {
            const [from, to] = last < i ? [last, i] : [i, last];
            for (let t = from; t <= to; t++) this.browserSelection.add(this.items[t]);
        } else if (this.browserSelection.has(item)) {
            this.browserSelection.delete(item);
        } else {
            this.browserSelection.add(item);
        }
        this._browserLastPicked = item;
        this.refreshBrowserSelectionTiles();
    }

    clearBrowserSelection() {
        this.browserSelection.clear();
        this._browserLastPicked = null;
        this.refreshBrowserSelectionTiles();
    }

    refreshBrowserSelectionTiles() {
        this.browserGrid?.querySelectorAll('.photo-tile').forEach(tile => {
            tile.classList.toggle('selected', this.browserSelection.has(this.items[+tile.dataset.index]));
        });
        this.updateBrowserSelectionUI();
    }

    updateBrowserSelectionUI() {
        const count = this.browserSelection.size;
        document.getElementById('ss-browser-selection').style.display = count > 0 ? '' : 'none';
        document.getElementById('ss-browser-hide-selected').textContent = `Hide (${count})`;
        document.getElementById('ss-browser').classList.toggle('selecting', count > 0);
    }

    hideFromBrowser(i) {
        const item = this.items[i];
        if (item) this.hideBrowserItems([item]);
    }

    hideSelectedFromBrowser() {
        const items = [...this.browserSelection];
        if (items.length === 0 || !confirm(`Hide ${items.length} photo${items.length > 1 ? 's' : ''} from the slideshow?`)) return;
        this.hideBrowserItems(items);
    }

    async hideBrowserItems(items) {
        try {
            const res = await fetch('/api/slideshow/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls: items.map(item => item.uri || item.res) })
            });
            if (!res.ok) throw new Error(res.statusText);
        } catch (e) {
            showToast('Failed to hide: ' + e.message, 'error', 4000);
            return;
        }
        showToast(items.length > 1 ? `${items.length} photos hidden` : 'Photo hidden', 'success', 2000);

        // The list may have changed while the request was out, so work from the items themselves
        const gone = new Set(items);
        const oldItems = this.items;
        const current = this.items[this.index];
        const before = this.items.slice(0, Math.max(this.index, 0)).filter(item => gone.has(item)).length;
        this.items = this.items.filter(item => !gone.has(item));
        if (gone.has(current)) { this.index -= before + 1; this._browserCurrentHidden = true; }
        else this.index -= before;
        for (const item of items) this.browserSelection.delete(item);

        if (!this.browserOpen) return;
        if (this.items.length === 0) { this.closeBrowser(); return; }
        const tiles = this.browserGrid.querySelectorAll('.photo-tile');
        let n = 0;
        tiles.forEach(tile => {
            if (gone.has(oldItems[+tile.dataset.index])) tile.remove();
            else tile.dataset.index = n++;
        });
        this.browserRendered = n;
        this.updateBrowserCount();
        this.updateBrowserSelectionUI();
        this.renderBrowserBatch();
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

// --- A news ticker headline's story, in a modal over the slideshow. The feed's summary shows at
// once, then the opening paragraphs from the story's page replace it when they arrive. The photos
// and the ticker wait while it's open, and it closes itself after a while untouched. ---
const TICKER_STORY_IDLE_MS = 2 * 60 * 1000;
let tickerStoryLink = null;
let tickerStoryTimer = null;

function tickerStoryTouched() {
    clearTimeout(tickerStoryTimer);
    tickerStoryTimer = setTimeout(closeTickerStory, TICKER_STORY_IDLE_MS);
}

function renderTickerStory(story, loading) {
    const modal = document.getElementById('ticker-story-modal');
    const when = story.date ? new Date(story.date) : null;
    const meta = [story.source, when && !isNaN(when)
        ? when.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '']
        .filter(Boolean).map(escapeHtml).join(' · ');
    modal.querySelector('.ticker-story-meta').innerHTML = meta;
    modal.querySelector('.ticker-story-title').textContent = story.title;
    const img = modal.querySelector('.ticker-story-image');
    if (story.image) {
        if (img.getAttribute('src') !== story.image) img.src = story.image;
        img.hidden = false;
    } else {
        img.hidden = true;
        img.removeAttribute('src');
    }
    const paragraphs = story.paragraphs || [];
    modal.querySelector('.ticker-story-body').innerHTML =
        (story.summary ? `<p class="ticker-story-standfirst">${escapeHtml(story.summary)}</p>` : '') +
        paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('') +
        (loading ? '<div class="energy-loading"><span class="spinner"></span>Loading the story…</div>' : '') +
        (!loading && !story.summary && !paragraphs.length ? '<p class="settings-hint">There\'s no summary of this story.</p>' : '');
    const link = modal.querySelector('.ticker-story-link');
    link.hidden = !story.link;
    if (story.link) link.href = story.link;
}

async function openTickerStory(headline) {
    const modal = document.getElementById('ticker-story-modal');
    bringModalToFront('ticker-story-modal');
    modal.style.display = 'flex';
    modal.querySelector('.ticker-story-scroll').scrollTop = 0;
    tickerStoryLink = headline.link;
    renderTickerStory(headline, !!headline.link);
    if (slideshow) {
        slideshow.storyOpen = true;
        slideshow.resetInterval();
        slideshow.overlay?.classList.add('ticker-paused');
    }
    tickerStoryTouched();
    if (!headline.link) return;
    try {
        const res = await fetch(`/api/news-ticker/story?link=${encodeURIComponent(headline.link)}`);
        const story = await res.json();
        if (!res.ok) throw new Error(story.error || `HTTP ${res.status}`);
        if (tickerStoryLink === headline.link) renderTickerStory(story, false);
    } catch (err) {
        console.warn('[SLIDESHOW] News story load failed:', err.message);
        if (tickerStoryLink === headline.link) renderTickerStory(headline, false);
    }
}

function closeTickerStory() {
    clearTimeout(tickerStoryTimer);
    tickerStoryLink = null;
    const modal = document.getElementById('ticker-story-modal');
    if (modal) modal.style.display = 'none';
    if (slideshow) {
        slideshow.storyOpen = false;
        slideshow.overlay?.classList.remove('ticker-paused');
        slideshow.resetInterval();
    }
}

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
function toggleSlideshowSky() { if (slideshow) slideshow.toggleSky(); }
function openSlideshowBrowser() { if (slideshow) slideshow.openBrowser(); }
function closeSlideshowBrowser() { if (slideshow) slideshow.closeBrowser(); }
