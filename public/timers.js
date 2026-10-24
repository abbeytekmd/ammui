// Alarms tab: countdown timers on one side, alarms at a time of day on the other. Both are kept in
// this browser and ring on this screen: a beeping sound and a dialog with a Stop button.
const TIMER_SHORTCUTS = [1, 2, 3, 4, 5, 10, 15]; // minutes
const ALARM_LATE_LIMIT = 10 * 60000; // one that went off longer ago than this (the screen was off) is dropped without ringing

const loadAlarmList = key => {
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
};
let timers = loadAlarmList('alarmTimers'); // [{ id, minutes, endsAt }]
let alarms = loadAlarmList('alarmTimes');  // [{ id, time: 'HH:MM', at: when it next rings, or null when off }]
let ringing = []; // what's going off: ['5 min timer', 'Alarm 07:30']
let ringInterval = null;
let alarmAudio = null;

function saveAlarmLists() {
    try {
        localStorage.setItem('alarmTimers', JSON.stringify(timers));
        localStorage.setItem('alarmTimes', JSON.stringify(alarms));
    } catch { }
}

function showAlarms() {
    setAppView('alarms');
    renderAlarmsView();
}

function renderAlarmsView() {
    renderTimerList();
    renderAlarmList();
}

// --- Timers ---

function startTimer(minutes) {
    if (!(minutes > 0)) return;
    unlockAlarmSound();
    timers.push({ id: crypto.randomUUID(), minutes, endsAt: Date.now() + minutes * 60000 });
    timers.sort((a, b) => a.endsAt - b.endsAt);
    saveAlarmLists();
    renderTimerList();
}

function startTimerFromForm() {
    const input = document.getElementById('timer-minutes');
    const minutes = Number(input.value);
    if (!(minutes > 0)) return;
    startTimer(minutes);
    input.value = '';
}

function cancelTimer(id) {
    timers = timers.filter(t => t.id !== id);
    saveAlarmLists();
    renderTimerList();
}

const timerLabel = t => `${Number(t.minutes.toFixed(2))} min timer`;

// "4:05", "1:02:30"
function formatTimeLeft(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

const RING_LENGTH = 2 * Math.PI * 45; // circumference of the countdown rings (r=45 in a 100 box)
const TIMER_ENDING_MS = 60000; // the last minute shows in red

// How much of the timer is still to run, 1 → 0
const timerFraction = (t, now) => Math.min(1, Math.max(0, (t.endsAt - now) / (t.minutes * 60000)));

// A ring that drains as the timer runs down; an idle ring (no timer) is just the track
function countdownRing(t, now) {
    const progress = t ? `<circle class="countdown-progress" cx="50" cy="50" r="45" data-timer-ring="${t.id}"
            stroke-dasharray="${RING_LENGTH}" stroke-dashoffset="${RING_LENGTH * (1 - timerFraction(t, now))}"/>` : '';
    return `<svg class="countdown-ring" viewBox="0 0 100 100" aria-hidden="true">
            <circle class="countdown-track" cx="50" cy="50" r="45"/>${progress}
        </svg>`;
}

// The big dial shows the timer that ends first; the others are listed under the shortcuts
function renderTimerList() {
    const now = Date.now();
    const [first, ...rest] = timers;
    document.getElementById('timer-hero').innerHTML = first ? `
        <div class="countdown-dial" data-timer-dial="${first.id}">
            ${countdownRing(first, now)}
            <div class="countdown-face">
                <span class="countdown-time" data-timer-left="${first.id}">${formatTimeLeft(first.endsAt - now)}</span>
                <span class="countdown-label">${escapeHtml(timerLabel(first))}</span>
                <span class="countdown-ends">Ends ${clockTime(first.endsAt)}</span>
            </div>
        </div>
        <button type="button" class="btn-control ghost btn-small" onclick="cancelTimer('${first.id}')">Cancel</button>` : `
        <div class="countdown-dial idle">
            ${countdownRing(null, now)}
            <div class="countdown-face">
                <span class="countdown-time">0:00</span>
                <span class="countdown-label">No timer running</span>
            </div>
        </div>`;

    document.getElementById('timer-list').innerHTML = rest.map(t => `
            <div class="alarms-row" data-timer-dial="${t.id}">
                <span class="countdown-mini">${countdownRing(t, now)}</span>
                <span class="alarms-big" data-timer-left="${t.id}">${formatTimeLeft(t.endsAt - now)}</span>
                <span class="alarms-about">${escapeHtml(timerLabel(t))} · ends ${clockTime(t.endsAt)}</span>
                <button type="button" class="btn-control ghost btn-small" onclick="cancelTimer('${t.id}')">Cancel</button>
            </div>`).join('');
    updateCountdowns(now);
}

// Ticks the clocks, rings and "in 2h 5m"s along without rebuilding the lists
function updateCountdowns(now) {
    for (const t of timers) {
        const left = t.endsAt - now;
        document.querySelectorAll(`[data-timer-left="${t.id}"]`).forEach(el => {
            el.textContent = formatTimeLeft(left);
            el.classList.toggle('long', left >= 3600000);
        });
        document.querySelectorAll(`[data-timer-ring="${t.id}"]`).forEach(el =>
            el.setAttribute('stroke-dashoffset', RING_LENGTH * (1 - timerFraction(t, now))));
        document.querySelectorAll(`[data-timer-dial="${t.id}"]`).forEach(el =>
            el.classList.toggle('ending', left <= TIMER_ENDING_MS));
    }
    for (const a of alarms) {
        const el = document.querySelector(`[data-alarm-about="${a.id}"]`);
        if (el) el.textContent = alarmAbout(a, now);
    }
}

// --- Alarms at a time of day ---

// The next time the clock shows HH:MM: today if it's still to come, else tomorrow
function nextAlarmAt(time) {
    const [h, m] = time.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
}

function addAlarmFromForm() {
    const input = document.getElementById('alarm-time');
    if (!input.value) return;
    unlockAlarmSound();
    alarms.push({ id: crypto.randomUUID(), time: input.value, at: nextAlarmAt(input.value) });
    alarms.sort((a, b) => a.time.localeCompare(b.time));
    saveAlarmLists();
    renderAlarmList();
    input.value = '';
}

function setAlarmOn(id, on) {
    const alarm = alarms.find(a => a.id === id);
    if (!alarm) return;
    if (on) unlockAlarmSound();
    alarm.at = on ? nextAlarmAt(alarm.time) : null;
    saveAlarmLists();
    renderAlarmList();
}

function deleteAlarm(id) {
    alarms = alarms.filter(a => a.id !== id);
    saveAlarmLists();
    renderAlarmList();
}

// "Today · in 2h 5m", "Tomorrow · in 9h 30m", or "Off"
function alarmAbout(alarm, now) {
    if (!alarm.at) return 'Off';
    const day = new Date(alarm.at).toDateString() === new Date(now).toDateString() ? 'Today' : 'Tomorrow';
    const mins = Math.ceil((alarm.at - now) / 60000);
    const h = Math.floor(mins / 60), m = mins % 60;
    const until = mins <= 1 ? 'in under a minute' : h ? `in ${h}h ${m}m` : `in ${m}m`;
    return `${day} · ${until}`;
}

function renderAlarmList() {
    const list = document.getElementById('alarm-list');
    list.innerHTML = !alarms.length
        ? '<p class="alarms-empty">No alarms set. Choose a time and press Set.</p>'
        : alarms.map(a => `
            <div class="alarms-row${a.at ? '' : ' off'}">
                <span class="alarms-big">${escapeHtml(a.time)}</span>
                <span class="alarms-about" data-alarm-about="${a.id}">${alarmAbout(a, Date.now())}</span>
                <label class="switch" title="${a.at ? 'Turn off' : 'Turn on'}">
                    <input type="checkbox" ${a.at ? 'checked' : ''} onchange="setAlarmOn('${a.id}', this.checked)">
                    <span class="slider round"></span>
                </label>
                <button type="button" class="btn-control ghost btn-small calendar-entry-delete" onclick="deleteAlarm('${a.id}')">Delete</button>
            </div>`).join('');
}

// --- Ringing ---

// Browsers only let a page make sound once someone has pressed something on it, so the sound is
// readied on any press (setting a timer or alarm, or just using the screen)
function unlockAlarmSound() {
    try {
        alarmAudio ||= new (window.AudioContext || window.webkitAudioContext)();
        if (alarmAudio.state === 'suspended') alarmAudio.resume();
    } catch { }
}
document.addEventListener('pointerdown', unlockAlarmSound, { passive: true });

// Three short beeps; played every second while ringing
function playAlarmBeeps() {
    if (!alarmAudio) return;
    const start = alarmAudio.currentTime;
    for (let k = 0; k < 3; k++) {
        const t = start + k * 0.2;
        const osc = alarmAudio.createOscillator();
        const gain = alarmAudio.createGain();
        osc.type = 'square';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        osc.connect(gain).connect(alarmAudio.destination);
        osc.start(t);
        osc.stop(t + 0.13);
    }
}

function ring(labels) {
    ringing.push(...labels);
    document.getElementById('alarm-ring-list').innerHTML = ringing.map(l => `<div>${escapeHtml(l)}</div>`).join('');
    bringModalToFront('alarm-ring-modal');
    document.getElementById('alarm-ring-modal').style.display = 'flex';
    unlockAlarmSound();
    if (!ringInterval) {
        playAlarmBeeps();
        ringInterval = setInterval(playAlarmBeeps, 1000);
    }
}

function stopRinging() {
    clearInterval(ringInterval);
    ringInterval = null;
    ringing = [];
    document.getElementById('alarm-ring-modal').style.display = 'none';
}

// Every second: ring what's due, and count the timers down
function checkAlarms() {
    const now = Date.now();
    const due = [];
    const timersBefore = timers.length;
    timers = timers.filter(t => {
        if (t.endsAt > now) return true;
        if (now - t.endsAt < ALARM_LATE_LIMIT) due.push(timerLabel(t));
        return false;
    });
    let alarmsChanged = false;
    for (const a of alarms) {
        if (!a.at || a.at > now) continue;
        if (now - a.at < ALARM_LATE_LIMIT) due.push(`Alarm ${a.time}`);
        a.at = null; // rings once, then turns off
        alarmsChanged = true;
    }
    if (timers.length !== timersBefore || alarmsChanged) {
        saveAlarmLists();
        renderAlarmsView();
    }
    if (due.length) ring(due);
    updateCountdowns(now);
}

document.getElementById('timer-shortcuts').innerHTML = TIMER_SHORTCUTS.map(m =>
    `<button type="button" class="timer-shortcut" onclick="startTimer(${m})">${m}<span>min</span></button>`).join('');
renderAlarmsView();
checkAlarms();
setInterval(checkAlarms, 1000);
