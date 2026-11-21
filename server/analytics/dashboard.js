'use strict';

// Admin Analytics dashboard: one pure function per tab, over rows loaded by
// admin/routes/insights.js. Every number uses server/analytics/definitions.js.
// Output shape (the page draws any tab from it, CSV exports the tables):
//   { tiles: [{ label, value, note }], series: [{ title, x: [days], lines: [{ name, values }] }],
//     tables: [{ title, columns, rows }], notes: [string] }

const def = require('./definitions');

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const hours = (ms) => (ms === null ? '-' : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${Math.round((ms / 3600000) * 10) / 10} h`);
const tile = (label, value, note = '') => ({ label, value, note });
const table = (title, columns, rows) => ({ title, columns, rows });
const count = (list, key) => { const m = new Map(); for (const x of list) { const k = typeof key === 'function' ? key(x) : x[key]; const kk = k === null || k === undefined || k === '' ? 'unknown' : k; m.set(kk, (m.get(kk) || 0) + 1); } return m; };
const sortedRows = (m, extra = () => []) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, ...extra(k, v)]);

// ---- shared filtering ---------------------------------------------------------------
function prepare(data, ctx) {
  const { tz, includeInternal, filters = {} } = ctx;
  const [fromMs, toMs] = def.rangeMs(ctx.fromDay, ctx.toDay, tz);
  const inRange = (ts) => { const t = Date.parse(ts); return t >= fromMs && t < toMs; };
  const playersById = new Map(data.players.map((p) => [p.id, p]));
  const playerOk = (p) => def.countable(p, includeInternal)
    && (!filters.source || (p.first_source || 'unknown') === filters.source)
    && (!filters.campaign || (p.first_campaign || 'none') === filters.campaign)
    && (!filters.country || (p.country || 'unknown') === filters.country);
  const players = data.players.filter(playerOk);
  const okIds = new Set(players.map((p) => p.id));
  const results = data.results.filter((r) => okIds.has(r.player_id) && (!filters.mode || r.mode === filters.mode) && (!filters.device || (r.device_class || 'unknown') === filters.device));
  const trades = data.trades.filter((t) => okIds.has(t.player_id));
  // A visit's source and campaign come from its landing page (only that page
  // carries the tags); a server event inherits its player's first touch.
  const sessionSrc = new Map();
  for (const e of [...data.events].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))) {
    if (e.source === 'client' && e.session_id && !sessionSrc.has(e.session_id)) sessionSrc.set(e.session_id, { source: e.utm_source || e.referrer || 'direct', campaign: e.utm_campaign || 'none' });
  }
  const attr = (e) => {
    if (e.source === 'client') return sessionSrc.get(e.session_id) || { source: e.utm_source || e.referrer || 'direct', campaign: e.utm_campaign || 'none' };
    const p = e.user_id && playersById.get(e.user_id);
    return p ? { source: p.first_source || 'unknown', campaign: p.first_campaign || 'none' } : { source: e.utm_source || 'unknown', campaign: e.utm_campaign || 'none' };
  };
  const eventOk = (e) => (includeInternal || !e.is_internal)
    && (!filters.device || (e.device_class || 'unknown') === filters.device)
    && (!filters.mode || !e.mode || e.mode === filters.mode)
    && (!filters.country || (e.coarse_country || 'unknown') === filters.country)
    && (!filters.source || attr(e).source === filters.source)
    && (!filters.campaign || attr(e).campaign === filters.campaign)
    && (!filters.page || e.page === filters.page);
  const events = data.events.filter(eventOk);
  const activity = [...results, ...trades];
  const days = def.activeDays(activity, playersById, { tz, includeInternal: true }); // players already filtered
  return { ...data, players, playersById, results, trades, events, days, inRange, fromMs, toMs, dayList: def.dayList(ctx.fromDay, ctx.toDay) };
}

const visitorOf = (e) => e.user_id ? `u:${e.user_id}` : e.anonymous_id ? `a:${e.anonymous_id}` : `v:${e.visitor_day_hash || e.session_id || e.id}`;
const byName = (events, name) => events.filter((e) => e.event_name === name);

// ---- tabs ---------------------------------------------------------------------------
function overview(d, ctx) {
  const last = ctx.toDay;
  const c = def.activeCounts(d.days, last);
  const signups = d.players.filter((p) => d.inRange(p.created_at));
  const matchIds = new Set(d.results.filter((r) => d.inRange(r.at)).map((r) => r.match_id));
  const active = def.activeInPeriod(d.days, ctx.fromDay, ctx.toDay);
  const newest = [...d.results.map((r) => r.at), ...d.trades.map((t) => t.at)].sort().pop() || null;
  const lastEvent = d.lastEventAt || null;
  const series = def.activeSeries(d.days, ctx.fromDay, ctx.toDay);
  const signupsByDay = count(signups, (p) => def.dayOf(p.created_at, ctx.tz));
  const matchesByDay = new Map();
  for (const r of d.results) if (d.inRange(r.at)) { const k = def.dayOf(r.at, ctx.tz); if (!matchesByDay.has(k)) matchesByDay.set(k, new Set()); matchesByDay.get(k).add(r.match_id); }
  return {
    tiles: [
      tile('Active today', c.dau, `players who played or traded on ${last}`), tile('Active 7 days', c.wau), tile('Active 30 days', c.mau),
      tile('New sign-ups', signups.length), tile('Matches', matchIds.size, 'with at least one real player'),
      tile('Matches per active player', active ? Math.round((d.results.filter((r) => d.inRange(r.at)).length / active) * 10) / 10 : 0),
      tile('Newest activity', newest ? newest.replace('T', ' ').slice(0, 16) + ' UTC' : '-'), tile('Last event received', lastEvent ? lastEvent.replace('T', ' ').slice(0, 16) + ' UTC' : '-', 'data freshness'),
    ],
    series: [
      { title: 'Active players', x: series.map((s) => s.day), lines: [{ name: 'Daily', values: series.map((s) => s.dau) }, { name: '7 days', values: series.map((s) => s.wau) }, { name: '30 days', values: series.map((s) => s.mau) }] },
      { title: 'Sign-ups and matches per day', x: d.dayList, lines: [{ name: 'Sign-ups', values: d.dayList.map((x) => signupsByDay.get(x) || 0) }, { name: 'Matches', values: d.dayList.map((x) => (matchesByDay.get(x) || new Set()).size) }] },
    ],
    tables: [table('Daily', ['Day', 'Active', 'Active 7d', 'Active 30d', 'Sign-ups', 'Matches'], series.map((s) => [s.day, s.dau, s.wau, s.mau, signupsByDay.get(s.day) || 0, (matchesByDay.get(s.day) || new Set()).size]))],
    notes: ['Active = a real player who played a match or opened a trade that day. Logins do not count.'],
  };
}

function funnels(d, ctx) {
  const ev = d.events.filter((e) => d.inRange(e.occurred_at));
  const visitors = new Set(byName(ev, 'page_view').map(visitorOf));
  const started = new Set(byName(ev, 'signup_started').map(visitorOf));
  const cohort = d.players.filter((p) => d.inRange(p.created_at));
  const ids = new Set(cohort.map((p) => p.id));
  const verifiedAt = new Map(); const loginAt = new Map();
  for (const e of d.allServerEvents) {
    if (!ids.has(e.user_id)) continue;
    if (e.event_name === 'email_verified' && !verifiedAt.has(e.user_id)) verifiedAt.set(e.user_id, Date.parse(e.occurred_at));
    if (e.event_name === 'login' && !loginAt.has(e.user_id)) loginAt.set(e.user_id, Date.parse(e.occurred_at));
  }
  const firstMatch = new Map(); const firstFinish = new Map();
  for (const r of d.results) {
    if (!ids.has(r.player_id)) continue;
    const t = Date.parse(r.at);
    if (!firstMatch.has(r.player_id) || t < firstMatch.get(r.player_id)) firstMatch.set(r.player_id, t);
    if (def.endReason(r.end_reason) === 'finished' && (!firstFinish.has(r.player_id) || t < firstFinish.get(r.player_id))) firstFinish.set(r.player_id, t);
  }
  const created = new Map(cohort.map((p) => [p.id, Date.parse(p.created_at)]));
  // A player counts at a step once they reached it or any later step: logging
  // in needs a verified email, playing needs a login. So the funnel never rises.
  const reached = (id) => (firstFinish.has(id) ? 4 : firstMatch.has(id) ? 3 : loginAt.has(id) ? 2 : verifiedAt.has(id) ? 1 : 0);
  const atLeast = (k) => cohort.filter((p) => reached(p.id) >= k).length;
  const steps = [
    ['Visited', visitors.size], ['Sign-up started', started.size], ['Sign-up submitted', cohort.length],
    ['Email verified', atLeast(1)], ['First login', atLeast(2)], ['First match started', atLeast(3)], ['First match finished', atLeast(4)],
  ];
  // Visits and sign-up starts are visitors (cookieless); sign-up onwards are players.
  // Where a step is larger than the one before (players who skipped the form), it shows 100%.
  const rows = steps.map(([name, n], i) => { const r = i ? Math.min(100, pct(n, steps[i - 1][1])) : 100; return [name, n, `${r}%`, i ? `${Math.round((100 - r) * 10) / 10}%` : '-']; });
  const gap = (a, b) => median([...b.entries()].filter(([id]) => a.has(id)).map(([id, t]) => t - a.get(id)));
  const never = cohort.filter((p) => !firstMatch.has(p.id));
  const bySource = new Map();
  for (const p of cohort) { const s = p.first_source || 'unknown'; const x = bySource.get(s) || { signups: 0, played: 0 }; x.signups++; if (firstMatch.has(p.id)) x.played++; bySource.set(s, x); }
  return {
    tiles: [tile('Visitors', visitors.size, 'unique per day, summed'), tile('Sign-ups', cohort.length), tile('Played a match', firstMatch.size, `${pct(firstMatch.size, cohort.length)}% of sign-ups`), tile('Never played', never.length)],
    series: [],
    tables: [
      table('Funnel', ['Step', 'Count', 'Of previous step', 'Drop-off'], rows),
      table('Time between steps (median)', ['From', 'To', 'Median'], [['Sign-up', 'Email verified', hours(gap(created, verifiedAt))], ['Sign-up', 'First match', hours(gap(created, firstMatch))], ['First match', 'First finished match', hours(gap(firstMatch, firstFinish))]]),
      table('Sign-ups by source', ['Source', 'Sign-ups', 'Played', 'Played %'], [...bySource.entries()].sort((a, b) => b[1].signups - a[1].signups).map(([s, x]) => [s, x.signups, x.played, `${pct(x.played, x.signups)}%`])),
      table('Sign-ups who never played', ['Username', 'Signed up', 'Source', 'Campaign'], never.map((p) => [p.username, def.dayOf(p.created_at, ctx.tz), p.first_source || 'unknown', p.first_campaign || ''])),
    ],
    notes: ['Visitors and "sign-up started" come from the cookieless collector (from the day it went live). Sign-up onwards comes from the server and cannot be blocked.', 'Filter Source / Campaign uses each player\'s first touch, saved at sign-up.'],
  };
}

function retention(d, ctx) {
  const today = def.dayOf(d.now, ctx.tz);
  const cohort = d.players.filter((p) => d.inRange(p.created_at));
  const fmt = (x) => (x ? `${x.rate}% (${x.returned}/${x.eligible})` : 'too early');
  const firstMode = new Map();
  for (const r of [...d.results].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) if (!firstMode.has(r.player_id)) firstMode.set(r.player_id, r.mode);
  const rows = def.retention(cohort, d.days, { tz: ctx.tz, today, by: 'week' });
  const bySource = def.retention(cohort, d.days, { tz: ctx.tz, today, by: 'week', key: (p) => p.first_source || 'unknown' });
  const byMode = def.retention(cohort, d.days, { tz: ctx.tz, today, by: 'week', key: (p) => firstMode.get(p.id) || 'never played' });
  const total = (n) => { let r = 0; let e = 0; for (const x of rows) if (x[`d${n}`]) { r += x[`d${n}`].returned; e += x[`d${n}`].eligible; } return e ? `${pct(r, e)}% (${r}/${e})` : 'too early'; };
  return {
    tiles: [tile('Cohort size', cohort.length), tile('Day 1', total(1)), tile('Day 7', total(7)), tile('Day 30', total(30))],
    series: [],
    tables: [
      table('By sign-up week', ['Week of', 'Players', 'Day 1', 'Day 7', 'Day 30'], rows.map((x) => [x.cohort, x.size, fmt(x.d1), fmt(x.d7), fmt(x.d30)])),
      table('By source', ['Week of', 'Source', 'Players', 'Day 1', 'Day 7', 'Day 30'], bySource.map((x) => [x.cohort, x.segment, x.size, fmt(x.d1), fmt(x.d7), fmt(x.d30)])),
      table('By first mode', ['Week of', 'First mode', 'Players', 'Day 1', 'Day 7', 'Day 30'], byMode.map((x) => [x.cohort, x.segment, x.size, fmt(x.d1), fmt(x.d7), fmt(x.d30)])),
    ],
    notes: ['Day N = share of the cohort active (played or traded) on day N after sign-up or any later day. A cohort shows "too early" until N days have passed.'],
  };
}

function pages(d, ctx) {
  const pv = byName(d.events, 'page_view').filter((e) => d.inRange(e.occurred_at));
  const perPage = new Map();
  for (const e of pv) { const k = e.page || 'unknown'; const x = perPage.get(k) || { views: 0, v: new Set() }; x.views++; x.v.add(`${def.dayOf(e.occurred_at, ctx.tz)}|${visitorOf(e)}`); perPage.set(k, x); }
  const sessions = def.sessions(d.events.filter((e) => d.inRange(e.occurred_at)), { idleMs: d.idleMs, tz: ctx.tz });
  const signupKeys = new Set(byName(d.allServerEvents, 'signup_submitted').map((e) => `${def.dayOf(e.occurred_at, ctx.tz)}|${e.visitor_day_hash}`));
  const landing = new Map(); const landingSrc = new Map();
  // the first page view of each visit is its landing page
  const firstOfSession = new Map();
  for (const e of [...pv].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))) if (e.session_id && !firstOfSession.has(e.session_id)) firstOfSession.set(e.session_id, e);
  for (const e of firstOfSession.values()) {
    const conv = signupKeys.has(`${def.dayOf(e.occurred_at, ctx.tz)}|${e.visitor_day_hash}`);
    const a = landing.get(e.page || 'unknown') || { sessions: 0, signups: 0 }; a.sessions++; if (conv) a.signups++; landing.set(e.page || 'unknown', a);
    const s = e.utm_source || e.referrer || 'direct';
    const b = landingSrc.get(s) || { sessions: 0, signups: 0 }; b.sessions++; if (conv) b.signups++; landingSrc.set(s, b);
  }
  const visitors = new Set(pv.map((e) => `${def.dayOf(e.occurred_at, ctx.tz)}|${visitorOf(e)}`));
  const byDay = count(pv, (e) => def.dayOf(e.occurred_at, ctx.tz));
  const vByDay = new Map();
  for (const e of pv) { const k = def.dayOf(e.occurred_at, ctx.tz); if (!vByDay.has(k)) vByDay.set(k, new Set()); vByDay.get(k).add(visitorOf(e)); }
  const lengths = sessions.map((s) => s.lengthSec);
  return {
    tiles: [tile('Page views', pv.length), tile('Unique visitors', visitors.size, 'per day, summed'), tile('Visits', sessions.length), tile('Median visit length', `${Math.round(median(lengths) || 0)} s`), tile('Pages per visit', sessions.length ? Math.round((sessions.reduce((a, s) => a + s.pages, 0) / sessions.length) * 10) / 10 : 0)],
    series: [{ title: 'Page views and visitors', x: d.dayList, lines: [{ name: 'Page views', values: d.dayList.map((x) => byDay.get(x) || 0) }, { name: 'Visitors', values: d.dayList.map((x) => (vByDay.get(x) || new Set()).size) }] }],
    tables: [
      table('Pages', ['Page', 'Views', 'Unique visitors'], [...perPage.entries()].sort((a, b) => b[1].views - a[1].views).map(([k, x]) => [k, x.views, x.v.size])),
      table('Landing pages (sign-up conversion)', ['Landing page', 'Visits', 'Sign-ups', 'Conversion'], [...landing.entries()].sort((a, b) => b[1].sessions - a[1].sessions).map(([k, x]) => [k, x.sessions, x.signups, `${pct(x.signups, x.sessions)}%`])),
      table('Sources (sign-up conversion)', ['Source', 'Visits', 'Sign-ups', 'Conversion'], [...landingSrc.entries()].sort((a, b) => b[1].sessions - a[1].sessions).map(([k, x]) => [k, x.sessions, x.signups, `${pct(x.signups, x.sessions)}%`])),
      table('Referrers', ['Referring site', 'Page views'], sortedRows(count(pv.filter((e) => e.referrer), 'referrer'))),
      table('Campaigns', ['Source / medium / campaign', 'Page views'], sortedRows(count(pv.filter((e) => e.utm_source || e.utm_campaign), (e) => `${e.utm_source || '-'} / ${e.utm_medium || '-'} / ${e.utm_campaign || '-'}`))),
      table('Devices', ['Device', 'Page views'], sortedRows(count(pv, 'device_class'))),
      table('Countries', ['Country', 'Page views'], sortedRows(count(pv, 'coarse_country'))),
    ],
    notes: ['Cookieless: a visitor is counted once per day (a daily-rotating hash, or the signed-in player). Visits end after the idle timeout.'],
  };
}

function modes(d, ctx) {
  const rs = d.results.filter((r) => d.inRange(r.at));
  const by = new Map();
  for (const r of rs) {
    const x = by.get(r.mode) || { matches: new Set(), players: new Set(), n: 0, finished: 0, forfeited: 0, disconnected: 0, unknown: 0, trades: 0, cards: 0, phone: 0, desktop: 0, tablet: 0, devUnknown: 0 };
    x.matches.add(r.match_id); x.players.add(r.player_id); x.n++;
    x[def.endReason(r.end_reason) === 'timed_out' ? 'unknown' : def.endReason(r.end_reason)]++;
    x.trades += r.trades || 0; x.cards += r.cards || 0;
    const dv = r.device_class || 'devUnknown'; x[dv in x ? dv : 'devUnknown']++;
    by.set(r.mode, x);
  }
  const ev = d.events.filter((e) => d.inRange(e.occurred_at));
  const ended = byName(ev, 'match_ended');
  const rankOf = new Map(ended.map((e) => [`${e.match_id}|${e.user_id}`, e.properties && e.properties.rank]));
  const cards = new Map();
  for (const e of byName(ev, 'card_played')) {
    const c = (e.properties && e.properties.card) || 'unknown';
    const x = cards.get(c) || { plays: 0, games: new Set(), wins: new Set() };
    x.plays++; const k = `${e.match_id}|${e.user_id}`; x.games.add(k); if (rankOf.get(k) === 1) x.wins.add(k);
    cards.set(c, x);
  }
  const reacts = byName(ev, 'spike_reacted').map((e) => Number(e.properties && e.properties.reaction_ms)).filter(Number.isFinite);
  const buckets = [[0, 2000, 'under 2 s'], [2000, 5000, '2-5 s'], [5000, 10000, '5-10 s'], [10000, 15001, '10-15 s']];
  const firstMode = new Map();
  for (const r of [...d.results].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) if (!firstMode.has(r.player_id)) firstMode.set(r.player_id, r.mode);
  const ret = def.retention(d.players.filter((p) => d.inRange(p.created_at)), d.days, { tz: ctx.tz, today: def.dayOf(d.now, ctx.tz), by: 'week', key: (p) => firstMode.get(p.id) || 'never played' });
  const modeRet = new Map();
  for (const x of ret) { const m = modeRet.get(x.segment) || { r: 0, e: 0 }; if (x.d7) { m.r += x.d7.returned; m.e += x.d7.eligible; } modeRet.set(x.segment, m); }
  return {
    tiles: [tile('Matches', new Set(rs.map((r) => r.match_id)).size), tile('Player results', rs.length), tile('Finished', `${pct(rs.filter((r) => def.endReason(r.end_reason) === 'finished').length, rs.length)}%`), tile('Spike reactions', reacts.length, reacts.length ? `median ${Math.round(median(reacts))} ms` : '')],
    series: [],
    tables: [
      table('By mode', ['Mode', 'Matches', 'Players', 'Finished', 'Forfeited', 'Disconnected', 'Unknown', 'Trades / match', 'Cards / match', 'Phone', 'Desktop', 'Tablet'], [...by.entries()].sort((a, b) => b[1].matches.size - a[1].matches.size).map(([m, x]) => [m, x.matches.size, x.players.size, `${pct(x.finished, x.n)}%`, `${pct(x.forfeited, x.n)}%`, `${pct(x.disconnected, x.n)}%`, `${pct(x.unknown, x.n)}%`, Math.round((x.trades / x.n) * 10) / 10, Math.round((x.cards / x.n) * 10) / 10, x.phone, x.desktop, x.tablet])),
      table('Cards', ['Card', 'Plays', 'Matches played in', 'Win rate when played'], [...cards.entries()].sort((a, b) => b[1].plays - a[1].plays).map(([c, x]) => [c, x.plays, x.games.size, `${pct(x.wins.size, x.games.size)}%`])),
      table('Spike reaction time', ['Within', 'Trades'], buckets.map(([a, b, label]) => [label, reacts.filter((v) => v >= a && v < b).length])),
      table('Day 7 retention by first mode', ['First mode', 'Day 7'], [...modeRet.entries()].map(([m, x]) => [m, x.e ? `${pct(x.r, x.e)}% (${x.r}/${x.e})` : 'too early'])),
    ],
    notes: ['End reasons: finished (to the bell or eliminated), forfeited (left), disconnected (lost connection), unknown (results from before end reasons were stored).', 'Win rate when played: share of matches where the player played that card and finished 1st (from match events, recorded since this build).'],
  };
}

function social(d) {
  const ev = d.events.filter((e) => d.inRange(e.occurred_at));
  const k = (name, kind) => byName(ev, name).filter((e) => !kind || (e.properties && e.properties.kind) === kind).length;
  const accepted = byName(ev, 'invite_accepted');
  const playedAfter = accepted.filter((e) => d.results.some((r) => r.player_id === e.user_id && Date.parse(r.at) >= Date.parse(e.occurred_at))).length;
  const refs = (d.referrals || []).filter((r) => d.inRange(r.created_at));
  return {
    tiles: [tile('Invites sent', k('invite_sent')), tile('Invites accepted', accepted.length), tile('Accepted then played', playedAfter), tile('Joined from an invite link', refs.length), tile('Private rooms created', k('private_room_created')), tile('Private rooms joined', k('private_room_joined')), tile('Discover joins', k('discover_join'))],
    series: [],
    tables: [
      table('Invites', ['Kind', 'Sent', 'Accepted'], [['Friend request', k('invite_sent', 'friend'), k('invite_accepted', 'friend')], ['Lobby invite', k('invite_sent', 'lobby'), k('invite_accepted', 'lobby')]]),
      table('Invite links', ['Status', 'Players'], sortedRows(count(refs, 'status'))),
    ],
    notes: ['Invites and Discover joins are recorded from this build on; invite-link sign-ups come from the referral records since launch.'],
  };
}

function competitions(d) {
  const ev = d.events.filter((e) => d.inRange(e.occurred_at));
  const views = count(byName(ev, 'competition_viewed'), (e) => (e.properties && e.properties.template) || 'other');
  const viewers = new Map();
  for (const e of byName(ev, 'competition_viewed')) { const t = (e.properties && e.properties.template) || 'other'; if (!viewers.has(t)) viewers.set(t, new Set()); viewers.get(t).add(visitorOf(e)); }
  const entries = count((d.compEntries || []).filter((x) => d.inRange(x.entered_at)), (x) => (x.template === 'daily' || x.template === 'weekend' ? x.template : 'other'));
  const done = count((d.compDone || []).filter((x) => d.inRange(x.ends_at)), (x) => (x.template === 'daily' || x.template === 'weekend' ? x.template : 'other'));
  const keys = ['daily', 'weekend', 'other'];
  return {
    tiles: keys.slice(0, 2).map((t) => tile(`${t === 'daily' ? 'Daily Open' : 'Weekend Open'} views`, views.get(t) || 0, `${entries.get(t) || 0} entries`)),
    series: [],
    tables: [table('Competitions', ['Competition', 'Page views', 'Unique viewers', 'Entries', 'Completed', 'View to entry'], keys.map((t) => [t === 'daily' ? 'Daily Open' : t === 'weekend' ? 'Weekend Open' : 'Other', views.get(t) || 0, (viewers.get(t) || new Set()).size, entries.get(t) || 0, done.get(t) || 0, `${pct(entries.get(t) || 0, (viewers.get(t) || new Set()).size)}%`]))],
    notes: ['Completed = accounts still in the competition when it settled.'],
  };
}

function sponsors(d, ctx) {
  const rep = require('./sponsorReport');
  const rows = [];
  const pageRows = [];
  for (const s of d.sponsors || []) {
    const pl = (d.placements || []).filter((p) => p.sponsor_id === s.id);
    const ids = new Set(pl.map((p) => p.id));
    const r = rep.build({ sponsor: s, placements: pl, events: d.events.filter((e) => ids.has(e.placement_id)), fromDay: ctx.fromDay, toDay: ctx.toDay, tz: ctx.tz });
    rows.push([s.name, r.totals.impressions, r.totals.unique_viewers, r.totals.clicks, r.totals.unique_clickers, `${r.totals.ctr}%`, s.id]);
    for (const x of r.byPlacement) pageRows.push([s.name, `placement: ${x.key}`, x.impressions, x.clicks, `${x.ctr}%`]);
    for (const x of r.byPage) pageRows.push([s.name, `page: ${x.key}`, x.impressions, x.clicks, `${x.ctr}%`]);
    for (const x of r.byDevice) pageRows.push([s.name, `device: ${x.key}`, x.impressions, x.clicks, `${x.ctr}%`]);
  }
  const imp = rows.reduce((a, r) => a + r[1], 0);
  const clk = rows.reduce((a, r) => a + r[3], 0);
  return {
    tiles: [tile('Impressions', imp, 'viewable: 50% for 1 s, once per visit'), tile('Clicks', clk), tile('CTR', `${pct(clk, imp)}%`), tile('Sponsors', rows.length)],
    series: [],
    tables: [table('Sponsors', ['Sponsor', 'Impressions', 'Unique viewers', 'Clicks', 'Unique clickers', 'CTR', 'Report'], rows), table('By placement, page and device', ['Sponsor', 'Breakdown', 'Impressions', 'Clicks', 'CTR'], pageRows)],
    notes: ['Per-sponsor report with CSV and PDF (aggregate only, no personal data): the Report column links to it.', 'Totals before this build (14 Nov onwards) exist only as daily counts in Sponsors > analytics.'],
  };
}

function affiliate(d) {
  const ev = d.events.filter((e) => d.inRange(e.occurred_at));
  const clicks = byName(ev, 'partner_link_click').concat(byName(ev, 'placement_click'));
  const uniq = (list) => new Set(list.map((e) => `${e.occurred_at.slice(0, 10)}|${visitorOf(e)}`)).size;
  const group = (key) => { const m = new Map(); for (const e of clicks) { const k = key(e) || 'unknown'; if (!m.has(k)) m.set(k, []); m.get(k).push(e); } return [...m.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, l]) => [k, l.length, uniq(l)]); };
  const statuses = count(d.winners || [], 'status');
  const order = ['pending_review', 'approved', 'email_sent', 'claimed', 'link_clicked', 'registered', 'verified', 'account_created', 'prize_requested', 'prize_credited', 'closed', 'manual_payout', 'declined', 'ineligible', 'expired'];
  return {
    tiles: [tile('Partner and sponsor link clicks', clicks.length), tile('Unique clickers', uniq(clicks)), tile('Winners registered (manual)', statuses.get('registered') || 0), tile('Prizes credited (manual)', statuses.get('prize_credited') || 0)],
    series: [],
    tables: [
      table('By partner', ['Partner (listing or sponsor id)', 'Clicks', 'Unique'], group((e) => e.partner_id || (e.properties && e.properties.link))),
      table('By placement', ['Placement', 'Clicks', 'Unique'], group((e) => e.placement_id)),
      table('By page', ['Page', 'Clicks', 'Unique'], group((e) => e.page)),
      table('Winner pipeline (all time)', ['Step', 'Winners'], order.map((s) => [s, statuses.get(s) || 0])),
    ],
    notes: ['"Registered" and "credited" are set by you in Competition Winners when the partner confirms.'],
  };
}

function tech(d, ctx) {
  const t = (d.tech || []).filter((x) => d.inRange(x.at));
  const kinds = ['disconnect', 'reconnect', 'client_freeze'];
  const perDay = (kind, agg = 'count') => d.dayList.map((day) => { const xs = t.filter((x) => x.kind === kind && def.dayOf(x.at, ctx.tz) === day); return agg === 'max' ? Math.max(0, ...xs.map((x) => x.value_ms || 0)) : xs.length; });
  const tickMax = Math.max(0, ...t.filter((x) => x.kind === 'tick_lag').map((x) => x.value_ms || 0));
  const loopMax = Math.max(0, ...t.filter((x) => x.kind === 'loop_lag').map((x) => x.value_ms || 0));
  const freezes = t.filter((x) => x.kind === 'client_freeze').length;
  const state = (v, warn, red) => (v >= red ? 'red' : v >= warn ? 'warning' : 'ok');
  const byMode = new Map();
  for (const x of t) { const m = x.mode || 'n/a'; const r = byMode.get(m) || { disconnect: 0, reconnect: 0, client_freeze: 0 }; if (x.kind in r) r[x.kind]++; byMode.set(m, r); }
  return {
    tiles: [tile('Bot probes', t.filter((x) => x.kind === 'probe').length), tile('Probers blocked', new Set(t.filter((x) => x.kind === 'probe' && x.properties && x.properties.blocked).map((x) => x.properties.visitor)).size), tile('Disconnects', t.filter((x) => x.kind === 'disconnect').length), tile('Reconnects', t.filter((x) => x.kind === 'reconnect').length), tile('Freezes', freezes, state(freezes, 5, 20)), tile('Worst tick lag', `${tickMax} ms`, state(tickMax, 150, 250)), tile('Worst event-loop p99', `${loopMax} ms`, state(loopMax, 50, 100))],
    series: [
      { title: 'Connection problems per day', x: d.dayList, lines: kinds.map((k) => ({ name: k === 'client_freeze' ? 'Freezes' : k[0].toUpperCase() + k.slice(1) + 's', values: perDay(k) })) },
      { title: 'Bot probes per day (/.env, /.git, /wp-admin, *.php and similar)', x: d.dayList, lines: [{ name: 'Probes', values: perDay('probe') }] },
      { title: 'Worst lag per day (ms)', x: d.dayList, lines: [{ name: 'Tick lag', values: perDay('tick_lag', 'max') }, { name: 'Event loop p99', values: perDay('loop_lag', 'max') }] },
    ],
    tables: [table('By mode', ['Mode', 'Disconnects', 'Reconnects', 'Freezes'], [...byMode.entries()].map(([m, r]) => [m, r.disconnect, r.reconnect, r.client_freeze]))],
    notes: ['Alert states: tick lag warning 150 ms, red 250 ms; event loop warning 50 ms, red 100 ms; freezes warning 5, red 20 in the range.', 'Kept 90 days. Lag samples are taken once a minute while matches run.'],
  };
}

function supportMobile(d, ctx) {
  const conv = (d.support || []).filter((c) => d.inRange(c.created_at));
  const ev = d.events.filter((e) => d.inRange(e.occurred_at));
  const n = (name) => byName(ev, name).length;
  const pwa = (d.pwa || []).filter((r) => r.day >= ctx.fromDay && r.day <= ctx.toDay);
  const pk = (kind) => pwa.filter((r) => r.kind === kind).reduce((a, r) => a + r.count, 0);
  return {
    tiles: [tile('Support chats', conv.length), tile('Escalated', conv.filter((c) => c.escalated_at).length), tile('Install prompt shown', n('a2hs_shown') || pk('prompt_shown')), tile('Installed', n('app_installed') || pk('installed')), tile('Landscape game visits', n('orientation_landscape'))],
    series: [],
    tables: [
      table('Support topics', ['Topic', 'Chats'], sortedRows(count(conv, (c) => c.topic || 'not classified'))),
      table('Add to Home Screen', ['Step', 'Count'], [['Shown', n('a2hs_shown') || pk('prompt_shown')], ['Accepted (install tapped)', n('a2hs_accepted') || pk('install_click')], ['Dismissed', n('a2hs_dismissed') || pk('prompt_dismissed') + pk('prompt_never')], ['Installed', n('app_installed') || pk('installed')]]),
      table('Installed app vs browser', ['Where', 'Count'], [['Installed-app sessions', pk('standalone_session')], ['Matches in the installed app', pk('match_installed')], ['Matches in the browser', pk('match_browser')]]),
    ],
    notes: ['Topics are classified from the player\'s first message (older chats show "not classified").'],
  };
}

function quality(d) {
  const now = d.now;
  const recent = d.recent48 || [];
  const hoursList = [];
  for (let i = 47; i >= 0; i--) hoursList.push(new Date(Math.floor((now - i * 3600000) / 3600000) * 3600000).toISOString().slice(0, 13));
  const perHour = count(recent, (e) => e.occurred_at.slice(0, 13));
  const lastOf = (src) => recent.filter((e) => e.source === src).map((e) => e.occurred_at).sort().pop() || d.lastBySource?.[src] || null;
  const quiet = (iso, h) => (!iso || now - Date.parse(iso) > h * 3600000);
  const sources = [
    ['First-party collector (page views)', lastOf('client'), 6],
    ['Server events (sign-ups, matches, clicks)', lastOf('server'), 24],
    ['Tech health', d.lastTechAt || null, 24],
  ];
  return {
    tiles: sources.map(([name, iso, h]) => tile(name, iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : 'nothing yet', quiet(iso, h) ? `quiet for more than ${h} h` : 'receiving')),
    series: [{ title: 'Events per hour, last 48 hours (UTC)', x: hoursList.map((h) => h.slice(5).replace('T', ' ') + 'h'), lines: [{ name: 'Events', values: hoursList.map((h) => perHour.get(h) || 0) }] }],
    tables: [
      table('Sources', ['Source', 'Last event', 'Status'], [...sources.map(([name, iso, h]) => [name, iso || '-', quiet(iso, h) ? 'WARNING: quiet' : 'ok']), ['Google Analytics 4', 'not readable from here', 'consent only; check the GA4 dashboard'], ['Cloudflare Web Analytics', 'not readable from here', 'every visitor, cookieless; check the Cloudflare dashboard']]),
      table('Known gaps', ['Data', 'Available from', 'Before that'], (d.gaps || []).map((g) => [g.what, g.from || 'not yet', g.before])),
    ],
    notes: [],
  };
}

const TABS = { overview, funnels, retention, pages, modes, social, competitions, sponsors, affiliate, tech, support: supportMobile, quality };

function run(tab, data, ctx) {
  const fn = TABS[tab];
  if (!fn) throw Object.assign(new Error('Unknown tab'), { status: 404 });
  const d = prepare(data, ctx);
  return fn(d, ctx);
}

function toCsv(out, meta = '') {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = meta ? [cell(meta), ''] : [];
  for (const t of out.tiles || []) lines.push([t.label, t.value, t.note].map(cell).join(','));
  for (const tb of out.tables || []) { lines.push('', cell(tb.title), tb.columns.map(cell).join(',')); for (const r of tb.rows) lines.push(r.map(cell).join(',')); }
  return lines.join('\n');
}

module.exports = { run, toCsv, TABS: Object.keys(TABS), prepare };
