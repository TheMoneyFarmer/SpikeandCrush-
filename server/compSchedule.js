'use strict';

// Schedules for the recurring competitions, from each template's `schedule`
// (edited in admin). Times are wall-clock times in the template's timezone and
// stay correct across daylight-saving changes.
//
// Daily Open:   { days: [1..5], timezone, sessionName, open: 'HH:MM', close: 'HH:MM' }
//               (close <= open means the session ends the next day)
// Weekend Open: { timezone, startDay: 6, start: '00:00', endDay: 0, end: '23:59' }
//               Saturday 00:00 to Sunday 23:59: two days.

const DAY_MS = 86400000;

// Offset (ms) of `tz` from UTC at instant `ms`.
function tzOffset(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// The UTC instant of a wall-clock time in `tz` (y, m 1-12, d, "HH:MM").
function zonedToUtc(y, m, d, hhmm, tz) {
  const [hh, mm] = String(hhmm).split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // two passes settle the offset on either side of a DST change
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return t;
}

// Calendar date and weekday of instant `ms` in `tz`.
function zonedDate(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
      .formatToParts(new Date(ms))
      .filter((x) => x.type !== 'literal')
      .map((x) => [x.type, x.value])
  );
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), dow };
}

function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

function validTz(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

// Next (or current) Daily Open session that has not ended by `fromMs`.
function nextDaily(fromMs, s = {}) {
  const tz = validTz(s.timezone) ? s.timezone : 'UTC';
  const days = Array.isArray(s.days) && s.days.length ? s.days : [1, 2, 3, 4, 5];
  const open = s.open || '00:00';
  const close = s.close || '22:00';
  const overnight = close <= open;
  let day = addDays(zonedDate(fromMs, tz), -1);
  for (let i = 0; i < 10; i++, day = addDays(day, 1)) {
    if (!days.includes(day.dow)) continue;
    const startsAt = zonedToUtc(day.y, day.m, day.d, open, tz);
    const endDay = overnight ? addDays(day, 1) : day;
    const endsAt = zonedToUtc(endDay.y, endDay.m, endDay.d, close, tz);
    if (endsAt > fromMs) return { startsAt: new Date(startsAt), endsAt: new Date(endsAt), timezone: tz, sessionName: s.sessionName || 'Trading session' };
  }
  return null;
}

// Next (or current) Weekend Open window: Saturday 00:00 to Sunday 23:59 in tz.
function nextWeekend(fromMs, s = {}) {
  const tz = validTz(s.timezone) ? s.timezone : 'UTC';
  const startDay = Number.isInteger(s.startDay) ? s.startDay : 6;
  const endDay = Number.isInteger(s.endDay) ? s.endDay : 0;
  const start = s.start || '00:00';
  const end = s.end || '23:59';
  const span = (endDay - startDay + 7) % 7; // Sat -> Sun = 1 day later
  let day = addDays(zonedDate(fromMs, tz), -7);
  for (let i = 0; i < 16; i++, day = addDays(day, 1)) {
    if (day.dow !== startDay) continue;
    const e = addDays(day, span);
    const startsAt = zonedToUtc(day.y, day.m, day.d, start, tz);
    const endsAt = zonedToUtc(e.y, e.m, e.d, end, tz);
    if (endsAt > fromMs) return { startsAt: new Date(startsAt), endsAt: new Date(endsAt), timezone: tz, days: span + 1 };
  }
  return null;
}

function nextWindow(template, fromMs = Date.now()) {
  if (!template) return null;
  if (template.key === 'weekend') return nextWeekend(fromMs, template.schedule || {});
  if (template.key === 'daily') return nextDaily(fromMs, template.schedule || {});
  return null;
}

module.exports = { nextDaily, nextWeekend, nextWindow, zonedToUtc, zonedDate, tzOffset, validTz };
