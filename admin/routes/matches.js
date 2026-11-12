'use strict';

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const internal = require('../lib/internalGameServer');

function matchInstruments(m) {
  if (Array.isArray(m.instruments) && m.instruments.length) return m.instruments;
  return [m.instrument_1, m.instrument_2].filter(Boolean);
}

// Shared by GET /api/matches/analytics and GET /api/analytics/matches (the
// nav links to both destinations, there's only one real implementation).
async function computeMatchAnalytics() {
  if (!isConfigured) throw Object.assign(new Error('Supabase not configured'), { status: 503 });
  const { data: matches } = await supabase.from('matches').select('mode, status, start_time, end_time, instrument_1, instrument_2, instruments, created_at');
  const { data: mpRows } = await supabase.from('match_players').select('final_pnl, is_draw');

  const durationsByMode = {};
  const instrumentCounts = {};
  const hourCounts = new Array(24).fill(0);
  let finished = 0, voided = 0;

  (matches || []).forEach((m) => {
    if (m.status === 'finished') finished++;
    if (m.status === 'voided') voided++;
    if (m.start_time && m.end_time) {
      const dur = (new Date(m.end_time) - new Date(m.start_time)) / 1000;
      (durationsByMode[m.mode] = durationsByMode[m.mode] || []).push(dur);
    }
    matchInstruments(m).forEach((sym) => { instrumentCounts[sym] = (instrumentCounts[sym] || 0) + 1; });
    hourCounts[new Date(m.created_at).getUTCHours()]++;
  });

  const avgDurationByMode = Object.fromEntries(
    Object.entries(durationsByMode).map(([mode, arr]) => [mode, Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)])
  );

  const pnlBuckets = { '< -5000': 0, '-5000 to -1000': 0, '-1000 to 0': 0, '0 to 1000': 0, '1000 to 5000': 0, '> 5000': 0 };
  (mpRows || []).forEach((row) => {
    const pnl = Number(row.final_pnl || 0);
    if (pnl < -5000) pnlBuckets['< -5000']++;
    else if (pnl < -1000) pnlBuckets['-5000 to -1000']++;
    else if (pnl < 0) pnlBuckets['-1000 to 0']++;
    else if (pnl < 1000) pnlBuckets['0 to 1000']++;
    else if (pnl < 5000) pnlBuckets['1000 to 5000']++;
    else pnlBuckets['> 5000']++;
  });

  return {
    avgDurationSecondsByMode: avgDurationByMode,
    instrumentPopularity: instrumentCounts,
    peakHoursUtc: hourCounts,
    completionRate: finished + voided > 0 ? Math.round((finished / (finished + voided)) * 1000) / 10 : null,
    abandonmentRate: finished + voided > 0 ? Math.round((voided / (finished + voided)) * 1000) / 10 : null,
    pnlDistribution: pnlBuckets,
    totalMatches: (matches || []).length,
  };
}

// ---- every match, live and finished, of every kind -------------------------
// War modes live in the game server's memory (internal bridge); competitions
// run in the competition engine and live in the database. Both are merged
// into one row shape here. Read-only.

const MODE_LABELS = { quick: 'Quick War', blitz: 'Blitz War', grand: 'Grand War', private: 'Private War', solo: 'Solo Ranked', tournament: 'Elimination', async: 'Async Daily Challenge' };
const NO_CARD_MODES = new Set(['async']);

function warLiveRow(m) {
  const players = m.players || [];
  const humans = players.filter((p) => !p.isAI);
  return {
    kind: m.kind || m.mode,
    family: 'war',
    id: m.id,
    name: m.modeLabel || MODE_LABELS[m.mode] || m.mode,
    mode: m.mode,
    status: m.status,
    roomCode: m.roomCode,
    ranked: Boolean(m.ranked),
    startedAt: m.startedAt ? new Date(m.startedAt).toISOString() : null,
    createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
    remainingSeconds: m.remainingSeconds,
    dataSeconds: m.dataSeconds,
    dataTime: null,
    instruments: m.instruments || [],
    replaySpeed: m.replaySpeed || 1,
    cardsOn: m.cardsOn !== undefined ? Boolean(m.cardsOn) : !NO_CARD_MODES.has(m.mode),
    lateEntries: m.lateEntries || 0,
    sponsor: null,
    lobbyTier: m.lobbyTier || null,
    players: {
      total: players.length,
      humans: humans.length,
      computer: players.length - humans.length,
      live: humans.filter((p) => p.online && !p.eliminated && !p.forfeited).length,
      offline: humans.filter((p) => !p.online && !p.forfeited).length,
      eliminated: players.filter((p) => p.eliminated || p.forfeited).length,
    },
    seats: players.map((p) => ({ id: p.id, handle: p.username, computer: Boolean(p.isAI), accountNumber: p.accountNumber || null, pnl: p.pnl, online: p.online, eliminated: Boolean(p.eliminated || p.forfeited) })),
  };
}

let compLiveCache = { at: 0, rows: [] };
async function liveCompetitionRows() {
  if (!isConfigured) return [];
  if (Date.now() - compLiveCache.at < 10000) return compLiveCache.rows;
  const { data: comps, error } = await supabase
    .from('competitions')
    .select('id, title, template_key, status, instruments, starts_at, ends_at, replay_speed, last_tick_data_time, entry_fee_coins, is_test, sponsor:sponsors(name)')
    .eq('status', 'active')
    .order('starts_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  const rows = [];
  for (const c of comps || []) {
    const { data: accts } = await supabase.from('comp_accounts').select('player_id, status, account_number, equity, starting_capital, player:players(username)').eq('competition_id', c.id).order('equity', { ascending: false }).limit(5000);
    const list = accts || [];
    let online = new Set();
    try {
      online = new Set((await internal.onlineOf(list.map((a) => a.player_id))).online);
    } catch (e) { /* game server unreachable: show live as unknown (0) */ }
    const out = list.filter((a) => a.status === 'loss_limit').length;
    rows.push({
      kind: 'competition',
      family: 'competition',
      id: c.id,
      name: c.title,
      mode: c.template_key || 'competition',
      status: 'active',
      roomCode: null,
      ranked: false,
      startedAt: c.starts_at,
      createdAt: c.starts_at,
      remainingSeconds: Math.max(0, Math.round((Date.parse(c.ends_at) - Date.now()) / 1000)),
      dataSeconds: null,
      dataTime: c.last_tick_data_time,
      instruments: c.instruments || [],
      replaySpeed: Number(c.replay_speed) || 1,
      cardsOn: false,
      lateEntries: 0,
      sponsor: c.sponsor ? c.sponsor.name : null,
      isTest: Boolean(c.is_test),
      players: {
        total: list.length,
        humans: list.length,
        computer: 0,
        live: list.filter((a) => online.has(a.player_id) && a.status !== 'loss_limit').length,
        offline: list.filter((a) => !online.has(a.player_id) && a.status !== 'loss_limit').length,
        eliminated: out,
      },
      seats: list.slice(0, 50).map((a) => ({ id: a.player_id, handle: a.player ? a.player.username : null, computer: false, accountNumber: a.account_number ? Number(a.account_number) : null, pnl: Math.round((Number(a.equity) - Number(a.starting_capital)) * 100) / 100, online: online.has(a.player_id), eliminated: a.status === 'loss_limit' })),
    });
  }
  compLiveCache = { at: Date.now(), rows };
  return rows;
}

async function buildLiveRows() {
  const [state, comps] = await Promise.all([
    internal.getLiveState().catch((e) => ({ error: e.message, activeMatches: [] })),
    liveCompetitionRows().catch((e) => { console.warn('[admin live comps]', e.message); return []; }),
  ]);
  const order = { active: 0, resolving: 1, countdown: 2, waiting: 3 };
  const rows = [...(state.activeMatches || []).map(warLiveRow), ...comps]
    .sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4) || String(b.startedAt || b.createdAt).localeCompare(String(a.startedAt || a.createdAt)));
  return { rows, gameServer: state.error ? { reachable: false, error: state.error } : { reachable: true }, at: new Date().toISOString() };
}

// Handle or 8-digit account number -> the match/competition ids it appears in.
async function idsForPlayerSearch(q) {
  const out = { matchIds: null, compIds: null };
  if (!q) return out;
  if (/^\d{8}$/.test(q)) {
    const [mp, ca] = await Promise.all([
      supabase.from('match_players').select('match_id').eq('account_number', Number(q)),
      supabase.from('comp_accounts').select('competition_id').eq('account_number', Number(q)),
    ]);
    out.matchIds = (mp.data || []).map((r) => r.match_id);
    out.compIds = (ca.data || []).map((r) => r.competition_id);
    return out;
  }
  const { data: players } = await supabase.from('players').select('id').ilike('username', `%${q.replace(/[%_,()]/g, '')}%`).limit(50);
  const ids = (players || []).map((p) => p.id);
  if (!ids.length) return { matchIds: [], compIds: [] };
  const [mp, ca] = await Promise.all([
    supabase.from('match_players').select('match_id').in('player_id', ids).limit(2000),
    supabase.from('comp_accounts').select('competition_id').in('player_id', ids).limit(2000),
  ]);
  out.matchIds = [...new Set((mp.data || []).map((r) => r.match_id))];
  out.compIds = [...new Set((ca.data || []).map((r) => r.competition_id))];
  return out;
}

const HISTORY_PAGE = 50;
const WAR_KINDS = ['quick', 'blitz', 'grand', 'private', 'solo', 'tournament', 'async'];

// Finished (and voided) matches and ended competitions, newest first, keyset
// paged by time (`before`), 50 a page. Filters: kind, status, instrument,
// from/to, q (handle or account number).
async function historyPage(query) {
  const kind = String(query.kind || '');
  const status = String(query.status || '');
  const instrument = String(query.instrument || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const from = query.from && !Number.isNaN(Date.parse(query.from)) ? new Date(query.from).toISOString() : null;
  const to = query.to && !Number.isNaN(Date.parse(query.to)) ? new Date(query.to).toISOString() : null;
  const before = query.before && !Number.isNaN(Date.parse(query.before)) ? new Date(query.before).toISOString() : null;
  const ids = await idsForPlayerSearch(String(query.q || '').trim());

  const wantWars = !kind || kind === 'war' || WAR_KINDS.includes(kind);
  const wantComps = !kind || kind === 'competition';
  const timer = Date.now();

  const wars = (async () => {
    if (!wantWars || (ids.matchIds && !ids.matchIds.length)) return [];
    let q = supabase.from('matches')
      .select('id, mode, status, room_code, instrument_1, instrument_2, instruments, start_time, end_time, created_at, winner:players!matches_winner_id_fkey(username)')
      .order('created_at', { ascending: false })
      .limit(HISTORY_PAGE + 1);
    q = status ? q.eq('status', status) : q.in('status', ['finished', 'voided']);
    if (WAR_KINDS.includes(kind)) q = q.eq('mode', kind);
    if (before) q = q.lt('created_at', before);
    if (from) q = q.gte('created_at', from);
    if (to) q = q.lte('created_at', to);
    if (instrument) q = q.or(`instruments.cs.["${instrument}"],instrument_1.eq.${instrument},instrument_2.eq.${instrument}`);
    if (ids.matchIds) q = q.in('id', ids.matchIds.slice(0, 1000));
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map((m) => ({
      kind: m.mode, family: 'war', id: m.id, name: MODE_LABELS[m.mode] || m.mode, mode: m.mode, status: m.status, roomCode: m.room_code,
      startedAt: m.start_time, endedAt: m.end_time, at: m.created_at, instruments: matchInstruments(m),
      winner: m.winner ? m.winner.username : null, cardsOn: !NO_CARD_MODES.has(m.mode), sponsor: null, lateEntries: 0,
      durationSeconds: m.start_time && m.end_time ? Math.round((Date.parse(m.end_time) - Date.parse(m.start_time)) / 1000) : null,
    }));
  })();

  const comps = (async () => {
    if (!wantComps || (ids.compIds && !ids.compIds.length)) return [];
    let q = supabase.from('competitions')
      .select('id, title, template_key, status, instruments, starts_at, ends_at, settled_at, replay_speed, sponsor:sponsors(name)')
      .order('starts_at', { ascending: false })
      .limit(HISTORY_PAGE + 1);
    q = status ? q.eq('status', status === 'finished' ? 'ended' : status === 'voided' ? 'void' : status) : q.in('status', ['ended', 'void']);
    if (before) q = q.lt('starts_at', before);
    if (from) q = q.gte('starts_at', from);
    if (to) q = q.lte('starts_at', to);
    if (instrument) q = q.contains('instruments', [instrument]);
    if (ids.compIds) q = q.in('id', ids.compIds.slice(0, 1000));
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map((c) => ({
      kind: 'competition', family: 'competition', id: c.id, name: c.title, mode: c.template_key || 'competition', status: c.status === 'ended' ? 'finished' : c.status === 'void' ? 'voided' : c.status,
      startedAt: c.starts_at, endedAt: c.ends_at, at: c.starts_at, instruments: c.instruments || [], winner: null, cardsOn: false,
      replaySpeed: Number(c.replay_speed) || 1, sponsor: c.sponsor ? c.sponsor.name : null, lateEntries: 0,
      durationSeconds: Math.round((Date.parse(c.ends_at) - Date.parse(c.starts_at)) / 1000),
    }));
  })();

  const merged = [...(await wars), ...(await comps)].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const items = merged.slice(0, HISTORY_PAGE);
  const hasMore = merged.length > HISTORY_PAGE;

  // Player counts and replay speed for this page only (<= 50 matches).
  const warIds = items.filter((i) => i.family === 'war').map((i) => i.id);
  const compIds = items.filter((i) => i.family === 'competition').map((i) => i.id);
  const [mp, stats, ca] = await Promise.all([
    warIds.length ? supabase.from('match_players').select('match_id, player:players(is_persona)').in('match_id', warIds) : { data: [] },
    warIds.length ? supabase.from('match_market_stats').select('match_id, replay_speed').in('match_id', warIds) : { data: [] },
    compIds.length ? supabase.from('comp_accounts').select('competition_id').in('competition_id', compIds) : { data: [] },
  ]);
  const count = {};
  const humans = {};
  for (const r of mp.data || []) {
    count[r.match_id] = (count[r.match_id] || 0) + 1;
    if (!(r.player && r.player.is_persona)) humans[r.match_id] = (humans[r.match_id] || 0) + 1;
  }
  for (const r of ca.data || []) count[r.competition_id] = (count[r.competition_id] || 0) + 1;
  const speed = {};
  for (const s of stats.data || []) speed[s.match_id] = Math.max(speed[s.match_id] || 1, Number(s.replay_speed) || 1);
  for (const i of items) {
    i.players = count[i.id] || 0;
    i.humans = i.family === 'war' ? humans[i.id] || 0 : i.players;
    if (i.family === 'war') i.replaySpeed = speed[i.id] || 1;
  }
  return { items, nextBefore: hasMore ? items[items.length - 1].at : null, pageSize: HISTORY_PAGE, serverMs: Date.now() - timer };
}

function router() {
  const r = express.Router();

  // War matches only (kept for the Realtime page).
  r.get('/live', async (req, res) => {
    try {
      const state = await internal.getLiveState();
      res.json(state.activeMatches);
    } catch (e) {
      res.status(502).json({ error: `Game server unreachable: ${e.message}` });
    }
  });

  // Every live match of every kind, competitions included.
  r.get('/live/all', async (req, res) => {
    try {
      res.json(await buildLiveRows());
    } catch (e) {
      console.error('[admin live all]', e);
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      res.json(await historyPage(req.query));
    } catch (e) {
      console.error('[admin matches history]', e);
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/flagged', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      // Two real, computable heuristics rather than a fabricated detection
      // system: (1) an implausibly large P&L swing for a 10k-starting-capital
      // match, (2) two-or-more players in the same match who logged in from
      // the same IP address around match time (possible multi-accounting).
      const EXTREME_PNL_THRESHOLD = 5000; // 50% of STARTING_CAPITAL

      const { data: extremePnl } = await supabase
        .from('match_players')
        .select('match_id, player_id, final_pnl, player:players(username), match:matches(mode, created_at, status)')
        .or(`final_pnl.gt.${EXTREME_PNL_THRESHOLD},final_pnl.lt.${-EXTREME_PNL_THRESHOLD}`)
        .order('created_at', { ascending: false, foreignTable: 'matches' })
        .limit(100);

      const flags = (extremePnl || []).map((row) => ({
        matchId: row.match_id,
        mode: row.match?.mode,
        reason: 'Suspicious P&L',
        detail: `${row.player?.username || 'player'} finished ${row.final_pnl > 0 ? '+' : ''}$${Number(row.final_pnl).toFixed(2)} (${Math.round((Math.abs(row.final_pnl) / 10000) * 100)}% of starting capital)`,
        confidence: Math.min(0.95, Math.abs(row.final_pnl) / 10000),
        createdAt: row.match?.created_at,
      }));

      // Same-IP multi-accounting: players in the same match whose most recent
      // login_events row shares an IP.
      const { data: matchPlayers } = await supabase.from('match_players').select('match_id, player_id').limit(5000);
      const byMatch = {};
      (matchPlayers || []).forEach((row) => { (byMatch[row.match_id] = byMatch[row.match_id] || []).push(row.player_id); });
      const candidateMatches = Object.entries(byMatch).filter(([, ids]) => ids.length >= 2).slice(0, 300);
      const allIds = [...new Set(candidateMatches.flatMap(([, ids]) => ids))];
      const { data: logins } = allIds.length
        ? await supabase.from('login_events').select('player_id, ip').in('player_id', allIds).order('created_at', { ascending: false })
        : { data: [] };
      const latestIpByPlayer = {};
      (logins || []).forEach((l) => { if (!latestIpByPlayer[l.player_id] && l.ip) latestIpByPlayer[l.player_id] = l.ip; });
      for (const [matchId, ids] of candidateMatches) {
        const ipGroups = {};
        ids.forEach((pid) => { const ip = latestIpByPlayer[pid]; if (ip) (ipGroups[ip] = ipGroups[ip] || []).push(pid); });
        for (const [ip, group] of Object.entries(ipGroups)) {
          if (group.length >= 2) {
            flags.push({ matchId, mode: null, reason: 'Multiple accounts, same IP', detail: `${group.length} players in this match last logged in from ${ip}`, confidence: 0.7, createdAt: null });
          }
        }
      }

      res.json(flags);
    } catch (e) {
      console.error('[admin matches flagged]', e);
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/analytics', async (req, res) => {
    try {
      res.json(await computeMatchAnalytics());
    } catch (e) {
      console.error('[admin matches analytics]', e);
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  r.get('/:id', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    const { id } = req.params;
    try {
      const [matchRes, playersRes, tradesRes, sabotageRes, replayRes, reportsRes] = await Promise.all([
        supabase.from('matches').select('*, winner:players!matches_winner_id_fkey(username)').eq('id', id).single(),
        supabase.from('match_players').select('*, player:players(username, avatar_url, tier)').eq('match_id', id),
        supabase.from('trades').select('*, player:players(username)').eq('match_id', id).order('opened_at', { ascending: true }),
        supabase.from('sabotage_events').select('*, player:players!sabotage_events_player_id_fkey(username), target:players!sabotage_events_target_player_id_fkey(username)').eq('match_id', id).order('played_at', { ascending: true }),
        supabase.from('replays').select('match_id, clip_count').eq('match_id', id).maybeSingle(),
        supabase.from('player_reports').select('*').eq('match_id', id),
      ]);
      if (matchRes.error || !matchRes.data) return res.status(404).json({ error: 'Match not found' });
      res.json({
        match: { ...matchRes.data, instruments: matchInstruments(matchRes.data) },
        players: playersRes.data || [],
        trades: tradesRes.data || [],
        sabotageEvents: sabotageRes.data || [],
        hasReplay: !!replayRes.data,
        reports: reportsRes.data || [],
      });
    } catch (e) {
      console.error('[admin match detail]', e);
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/force-end', async (req, res) => {
    try {
      const result = await internal.forceEndMatch(req.params.id);
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'force_end_match', targetType: 'match', targetId: req.params.id, ip: clientIp(req) });
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  r.post('/:id/void', async (req, res) => {
    try {
      const result = await internal.voidMatch(req.params.id);
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'void_match', targetType: 'match', targetId: req.params.id, ip: clientIp(req) });
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  r.delete('/:id/player/:playerId', async (req, res) => {
    try {
      const result = await internal.kickPlayer(req.params.id, req.params.playerId);
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'kick_player', targetType: 'match', targetId: req.params.id, details: { playerId: req.params.playerId }, ip: clientIp(req) });
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
module.exports.computeMatchAnalytics = computeMatchAnalytics;
module.exports.buildLiveRows = buildLiveRows;
module.exports.historyPage = historyPage;
module.exports.warLiveRow = warLiveRow;
