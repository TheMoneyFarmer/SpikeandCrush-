'use strict';

// Date ranges for admin reports, in the admin's own time zone (IANA name,
// e.g. "Asia/Dubai", "America/New_York"). Daylight saving is handled by the
// zone itself: "today" is local midnight to local midnight, which can be 23
// or 25 hours, and day buckets follow local days.
//
// resolveRange({ preset, from, to, tz, compare }, nowMs) returns
//   { preset, tz, start, end, prevStart, prevEnd, unit, buckets: [{ start, end, label }] }
// with start inclusive and end exclusive (ms since epoch).

const PRESETS = ['today', 'yesterday', '7d', '14d', '30d', '90d', 'this_month', 'last_month', 'ytd', 'custom'];
const DAY = 86400000;
const MAX_SPAN = 3 * 366 * DAY;

function validTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return true;
  } catch (e) {
    return false;
  }
}

const fmtCache = new Map();
function partsIn(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o; // { year, month (1-12), day, hour, minute, second }
}

// Offset of the zone from UTC at that instant, in ms (local = utc + offset).
function offsetAt(ms, tz) {
  const p = partsIn(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// The instant of local wall-clock time y-m-d hh:mm in tz. Two passes settle
// the offset across a DST change; a time that doesn't exist (spring forward)
// lands just after the gap.
function zonedTime(y, m, d, hh = 0, mm = 0, tz = 'UTC') {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let t = wall - offsetAt(wall, tz);
  t = wall - offsetAt(t, tz);
  return t;
}

function localDate(ms, tz) {
  const p = partsIn(ms, tz);
  return { y: p.year, m: p.month, d: p.day };
}

// Calendar arithmetic on a local date (Date.UTC normalises overflow).
function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const midnight = (ld, tz) => zonedTime(ld.y, ld.m, ld.d, 0, 0, tz);

// Parse a custom bound: an ISO instant (with Z or offset), or a local
// "YYYY-MM-DD" / "YYYY-MM-DDTHH:mm" read in the admin's zone.
function parseBound(v, tz) {
  if (v == null || v === '') return null;
  const s = String(v);
  const local = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
  if (local) return zonedTime(+local[1], +local[2], +local[3], +(local[4] || 0), +(local[5] || 0), tz);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function unitFor(span) {
  if (span <= 2 * DAY + 3600000) return 'hour';
  if (span <= 120 * DAY) return 'day';
  if (span <= 400 * DAY) return 'week';
  return 'month';
}

function buildBuckets(start, end, unit, tz) {
  const out = [];
  if (unit === 'hour') {
    for (let t = start; t < end; t += 3600000) out.push({ start: t, end: Math.min(end, t + 3600000) });
  } else {
    // Local calendar steps, so a 23- or 25-hour day is still one bucket.
    let ld = localDate(start, tz);
    let t = start;
    while (t < end) {
      let next;
      if (unit === 'day') next = addDays(ld, 1);
      else if (unit === 'week') next = addDays(ld, 7);
      else next = { y: ld.m === 12 ? ld.y + 1 : ld.y, m: ld.m === 12 ? 1 : ld.m + 1, d: 1 };
      const nt = Math.min(end, midnight(next, tz));
      out.push({ start: t, end: nt <= t ? end : nt });
      if (nt <= t) break;
      t = nt;
      ld = next;
    }
  }
  return out.map((b) => ({ ...b, label: new Date(b.start).toISOString() }));
}

function resolveRange(q = {}, now = Date.now()) {
  const tz = q.tz && validTz(q.tz) ? q.tz : 'UTC';
  let preset = PRESETS.includes(q.preset) ? q.preset : null;
  // Old callers send ?days=1|7|30|90.
  if (!preset && q.days) preset = { 1: 'today', 7: '7d', 30: '30d', 90: '90d' }[Number(q.days)] || '7d';
  if (!preset) preset = q.from || q.to ? 'custom' : '7d';
  const today = localDate(now, tz);
  const startOfToday = midnight(today, tz);
  const endOfToday = midnight(addDays(today, 1), tz);
  let start;
  let end;
  switch (preset) {
    case 'today': start = startOfToday; end = endOfToday; break;
    case 'yesterday': start = midnight(addDays(today, -1), tz); end = startOfToday; break;
    case '7d': case '14d': case '30d': case '90d': {
      const n = Number(preset.replace('d', ''));
      start = midnight(addDays(today, -(n - 1)), tz);
      end = endOfToday;
      break;
    }
    case 'this_month': start = zonedTime(today.y, today.m, 1, 0, 0, tz); end = endOfToday; break;
    case 'last_month': {
      const ly = today.m === 1 ? today.y - 1 : today.y;
      const lm = today.m === 1 ? 12 : today.m - 1;
      start = zonedTime(ly, lm, 1, 0, 0, tz);
      end = zonedTime(today.y, today.m, 1, 0, 0, tz);
      break;
    }
    case 'ytd': start = zonedTime(today.y, 1, 1, 0, 0, tz); end = endOfToday; break;
    default: {
      start = parseBound(q.from, tz);
      end = parseBound(q.to, tz);
      // A date-only "to" means the whole of that day.
      if (end != null && /^\d{4}-\d{2}-\d{2}$/.test(String(q.to))) end = midnight(addDays(localDate(end, tz), 1), tz);
      if (start == null && end == null) { start = midnight(addDays(today, -6), tz); end = endOfToday; }
      if (start == null) start = end - 7 * DAY;
      if (end == null) end = Math.max(start + 3600000, endOfToday);
    }
  }
  if (!(end > start)) throw Object.assign(new Error('The end of the range must be after its start'), { status: 400 });
  if (end - start > MAX_SPAN) throw Object.assign(new Error('Ranges can be at most three years'), { status: 400 });
  const span = end - start;
  const unit = unitFor(span);
  return {
    preset,
    tz,
    start,
    end,
    prevStart: q.compare === false || q.compare === '0' ? null : start - span,
    prevEnd: q.compare === false || q.compare === '0' ? null : start,
    unit,
    buckets: buildBuckets(start, end, unit, tz),
  };
}

// Index of the bucket holding ms, or -1 (binary search).
function bucketIndex(buckets, ms) {
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ms < buckets[mid].start) hi = mid - 1;
    else if (ms >= buckets[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

module.exports = { PRESETS, resolveRange, bucketIndex, zonedTime, offsetAt, validTz };
