'use strict';

// THE definitions every analytics number uses. One file, so a chart, a CSV and
// a sponsor report can never disagree. Pure functions over rows; the loaders
// (admin/lib/analyticsData.js) fetch the rows.
//
// ACTIVE PLAYER: a real human (not internal: not an admin/test account, not a
// computer persona, not flagged is_internal) who finished or played at least
// one match, or opened at least one trade, in the period. Logins do not count:
// a returning Google sign-in or a saved session is active the moment it plays.
//
// RETENTION (cohort = sign-up day): day N retention is the share of the cohort
// that was active on day N or any later day. A cohort is only reported for
// day N once N full days have passed, so young cohorts never drag the rate down.
//
// DAYS: Asia/Dubai (UTC+4, no daylight saving) by default; UTC on request.
//
// END REASONS (match_players.end_reason as stored -> what the dashboard says):
//   completed, loss_limit -> finished; left -> forfeited; disconnect ->
//   disconnected; timeout -> timed_out; null or unknown -> unknown.

const DAY_MS = 86400000;
const TZ_OFFSET_MS = { dubai: 4 * 3600000, utc: 0 };

function tzKey(tz) {
  return String(tz || 'dubai').toLowerCase() === 'utc' ? 'utc' : 'dubai';
}

// Calendar day (YYYY-MM-DD) of a timestamp in the chosen zone.
function dayOf(ts, tz = 'dubai') {
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + TZ_OFFSET_MS[tzKey(tz)]).toISOString().slice(0, 10);
}

// [fromMs, toMs) in UTC for whole days fromDay..toDay (inclusive) in the zone.
function rangeMs(fromDay, toDay, tz = 'dubai') {
  const off = TZ_OFFSET_MS[tzKey(tz)];
  return [Date.parse(`${fromDay}T00:00:00Z`) - off, Date.parse(`${toDay}T00:00:00Z`) + DAY_MS - off];
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

function addDays(d, n) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function dayList(fromDay, toDay) {
  const out = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) out.push(d);
  return out;
}

// Excluded from every metric unless the "include internal traffic" toggle is on.
function isInternalPlayer(p) {
  return Boolean(p && (p.is_internal || p.is_persona));
}
function countable(p, includeInternal = false) {
  if (!p) return false;
  return includeInternal || !isInternalPlayer(p);
}

// activity: [{ player_id, at }] from match results and trades.
// Returns Map(player_id -> Set(day)) for countable players only.
function activeDays(activity, playersById, { tz = 'dubai', includeInternal = false } = {}) {
  const out = new Map();
  for (const a of activity) {
    if (!a.player_id) continue; // computer seats have no player id
    if (!countable(playersById.get(a.player_id), includeInternal)) continue;
    const d = dayOf(a.at, tz);
    if (!d) continue;
    if (!out.has(a.player_id)) out.set(a.player_id, new Set());
    out.get(a.player_id).add(d);
  }
  return out;
}

// Active players on a day, and in the 7 and 30 days ending that day.
function activeCounts(days, onDay) {
  let dau = 0;
  let wau = 0;
  let mau = 0;
  const w0 = addDays(onDay, -6);
  const m0 = addDays(onDay, -29);
  for (const set of days.values()) {
    let w = false;
    let m = false;
    for (const d of set) {
      if (d === onDay) dau++;
      if (d >= w0 && d <= onDay) w = true;
      if (d >= m0 && d <= onDay) m = true;
    }
    if (w) wau++;
    if (m) mau++;
  }
  return { dau, wau, mau };
}

function activeSeries(days, fromDay, toDay) {
  return dayList(fromDay, toDay).map((d) => ({ day: d, ...activeCounts(days, d) }));
}

// Distinct active players in a period.
function activeInPeriod(days, fromDay, toDay) {
  let n = 0;
  for (const set of days.values()) for (const d of set) if (d >= fromDay && d <= toDay) { n++; break; }
  return n;
}

// Cohorts by sign-up week (Monday) or day: { cohort, size, d1, d7, d30 } where
// dN is { returned, eligible, rate } or null when the cohort is too young.
function retention(players, days, { tz = 'dubai', today, by = 'week', includeInternal = false, key = null } = {}) {
  const groups = new Map();
  for (const p of players) {
    if (!countable(p, includeInternal)) continue;
    const signup = dayOf(p.created_at, tz);
    if (!signup) continue;
    let cohort = signup;
    if (by === 'week') {
      const dow = (new Date(`${signup}T00:00:00Z`).getUTCDay() + 6) % 7;
      cohort = addDays(signup, -dow);
    }
    const g = key ? `${cohort}|${key(p) || 'unknown'}` : cohort;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ p, signup });
  }
  const rows = [];
  for (const [g, list] of [...groups.entries()].sort()) {
    const [cohort, segment] = g.split('|');
    const row = { cohort, segment: segment || null, size: list.length };
    for (const n of [1, 7, 30]) {
      let eligible = 0;
      let returned = 0;
      for (const { p, signup } of list) {
        if (daysBetween(signup, today) < n) continue;
        eligible++;
        const target = addDays(signup, n);
        const set = days.get(p.id);
        if (set && [...set].some((d) => d >= target)) returned++;
      }
      row[`d${n}`] = eligible ? { returned, eligible, rate: Math.round((returned / eligible) * 1000) / 10 } : null;
    }
    rows.push(row);
  }
  return rows;
}

// SESSIONS (visits): client events grouped by the browser's visit id; a gap
// longer than the idle timeout (default 30 minutes, ANALYTICS_SESSION_IDLE_MINUTES)
// starts a new session. Length = last event - first event (a one-page visit is 0 s).
function sessions(events, { idleMs = 30 * 60 * 1000, tz = 'dubai' } = {}) {
  const by = new Map();
  for (const e of events) {
    if (!e.session_id || e.source !== 'client') continue;
    if (!by.has(e.session_id)) by.set(e.session_id, []);
    by.get(e.session_id).push(e);
  }
  const out = [];
  for (const list of by.values()) {
    list.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
    let cur = null;
    for (const e of list) {
      const t = Date.parse(e.occurred_at);
      if (!cur || t - cur.endMs > idleMs) {
        cur = { session_id: e.session_id, startMs: t, endMs: t, pages: 0, device: e.device_class || 'unknown', user_id: e.user_id || null, visitor: e.anonymous_id || e.visitor_day_hash || null, is_internal: Boolean(e.is_internal), landing: e.page || null, source: e.utm_source || e.referrer || 'direct' };
        out.push(cur);
      }
      cur.endMs = t;
      if (e.event_name === 'page_view') cur.pages++;
      if (e.user_id) cur.user_id = e.user_id;
      if (e.is_internal) cur.is_internal = true;
    }
  }
  return out.map((x) => ({ ...x, start: new Date(x.startMs).toISOString(), day: dayOf(x.startMs, tz), lengthSec: Math.round((x.endMs - x.startMs) / 1000) }));
}

const END_REASON = { completed: 'finished', loss_limit: 'finished', left: 'forfeited', disconnect: 'disconnected', timeout: 'timed_out' };
function endReason(stored) {
  return END_REASON[stored] || 'unknown';
}

module.exports = { sessions, DAY_MS, TZ_OFFSET_MS, tzKey, dayOf, rangeMs, daysBetween, addDays, dayList, isInternalPlayer, countable, activeDays, activeCounts, activeSeries, activeInPeriod, retention, endReason, END_REASON };
