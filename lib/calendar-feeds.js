// Reads iCal (.ics) feeds — e.g. a Google Calendar's "secret address in iCal format" —
// and expands their events (recurrences included) for a date range.
import axios from 'axios';
import ICAL from 'ical.js';

const CACHE_MS = 10 * 60 * 1000;
const feedCache = new Map(); // url -> { at, vcalendar }

// webcal:// is just an http(s) feed with a different scheme
export function normaliseFeedUrl(url) {
  const trimmed = String(url || '').trim().replace(/^webcals?:\/\//i, 'https://');
  const parsed = new URL(trimmed); // throws on garbage
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('The address must start with https://');
  return parsed.toString();
}

async function loadFeed(url, { fresh = false } = {}) {
  const cached = feedCache.get(url);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.vcalendar;

  const resp = await axios.get(url, { responseType: 'text', timeout: 15000, maxContentLength: 20 * 1024 * 1024 });
  if (!/BEGIN:VCALENDAR/.test(resp.data)) throw new Error('That address did not return an iCal calendar');
  const vcalendar = new ICAL.Component(ICAL.parse(resp.data));

  // Feeds carry their own VTIMEZONE blocks; register them so TZID times convert correctly
  for (const vtz of vcalendar.getAllSubcomponents('vtimezone')) {
    const tz = new ICAL.Timezone(vtz);
    if (!ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz);
  }

  feedCache.set(url, { at: Date.now(), vcalendar });
  return vcalendar;
}

// Fetch and parse a feed now (bypassing the cache), returning its own name if it has one
export async function checkFeed(url) {
  const vcalendar = await loadFeed(url, { fresh: true });
  return { name: vcalendar.getFirstPropertyValue('x-wr-calname') || '' };
}

export function forgetFeed(url) {
  feedCache.delete(url);
}

// All-day events are returned as plain YYYY-MM-DD dates (end exclusive), timed
// events as ISO instants, so the browser places them in its own timezone.
function toOutput(time) {
  if (time.isDate) {
    const p = n => String(n).padStart(2, '0');
    return `${time.year}-${p(time.month)}-${p(time.day)}`;
  }
  return time.toJSDate().toISOString();
}

function eventsFromFeed(vcalendar, rangeStart, rangeEnd) {
  const vevents = vcalendar.getAllSubcomponents('vevent');
  const masters = new Map();
  const exceptions = [];
  for (const vevent of vevents) {
    const event = new ICAL.Event(vevent);
    if (!event.uid || !event.startDate) continue;
    if (event.isRecurrenceException()) exceptions.push(event);
    else masters.set(event.uid, event);
  }
  // Moved/edited single instances of a recurring event replace the generated one
  for (const ex of exceptions) {
    const master = masters.get(ex.uid);
    if (master) master.relateException(ex);
    else masters.set(`${ex.uid}#${ex.recurrenceId}`, ex);
  }

  const out = [];
  const add = (event, start, end) => {
    if (!end) end = start.clone();
    const startJs = start.toJSDate();
    const endJs = end.toJSDate();
    // Zero-length events still occupy their start moment
    if (startJs >= rangeEnd || (endJs <= rangeStart && startJs < rangeStart)) return;
    if (event.component.getFirstPropertyValue('status') === 'CANCELLED') return;
    out.push({
      title: event.summary || '(No title)',
      location: event.location || '',
      allDay: start.isDate,
      start: toOutput(start),
      end: toOutput(end)
    });
  };

  for (const event of masters.values()) {
    if (!event.isRecurring()) {
      add(event, event.startDate, event.endDate);
      continue;
    }
    const iter = event.iterator();
    let next;
    let guard = 0;
    // The iterator can't skip ahead, so old daily series step through their history first
    while ((next = iter.next()) && guard++ < 50000) {
      if (next.toJSDate() >= rangeEnd) break;
      const details = event.getOccurrenceDetails(next);
      add(details.item, details.startDate, details.endDate);
    }
  }
  return out;
}

// calendars: [{ id, url }]; start/end: Date. Feeds that fail are reported, not fatal.
export async function getCalendarEvents(calendars, rangeStart, rangeEnd) {
  const events = [];
  const errors = [];
  await Promise.all(calendars.map(async cal => {
    try {
      const vcalendar = await loadFeed(cal.url);
      for (const ev of eventsFromFeed(vcalendar, rangeStart, rangeEnd)) {
        events.push({ ...ev, calendarId: cal.id });
      }
    } catch (err) {
      console.warn(`[CALENDAR] ${cal.name || cal.id}: ${err.message}`);
      errors.push({ calendarId: cal.id, error: err.message });
    }
  }));
  events.sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
  return { events, errors };
}
