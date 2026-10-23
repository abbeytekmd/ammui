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

function renderTimerList() {
    const list = document.getElementById('timer-list');
    list.innerHTML = !timers.length
        ? '<p class="alarms-empty">No timers running. Press a shortcut, or enter the minutes and press Go.</p>'
        : timers.map(t => `
            <div class="alarms-row">
                <span class="alarms-big" data-timer-left="${t.id}">${formatTimeLeft(t.endsAt - Date.now())}</span>
                <span class="alarms-about">${escapeHtml(timerLabel(t))}</span>
                <button type="button" class="btn-control ghost btn-small" onclick="cancelTimer('${t.id}')">Cancel</button>
            </div>`).join('');
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

// "Today", "Tomorrow", or "Off"
function alarmWhen(alarm) {
    if (!alarm.at) return 'Off';
    const day = new Date(alarm.at).toDateString();
    return day === new Date().toDateString() ? 'Today' : 'Tomorrow';
}

function renderAlarmList() {
    const list = document.getElementById('alarm-list');
    list.innerHTML = !alarms.length
        ? '<p class="alarms-empty">No alarms set. Choose a time and press Set.</p>'
        : alarms.map(a => `
            <div class="alarms-row${a.at ? '' : ' off'}">
                <span class="alarms-big">${escapeHtml(a.time)}</span>
                <span class="alarms-about">${alarmWhen(a)}</span>
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
    document.querySelectorAll('[data-timer-left]').forEach(el => {
        const t = timers.find(t => t.id === el.dataset.timerLeft);
        if (t) el.textContent = formatTimeLeft(t.endsAt - now);
    });
}

document.getElementById('timer-shortcuts').innerHTML = TIMER_SHORTCUTS.map(m =>
    `<button type="button" class="timer-shortcut" onclick="startTimer(${m})">${m}<span>min</span></button>`).join('');
renderAlarmsView();
checkAlarms();
setInterval(checkAlarms, 1000);
