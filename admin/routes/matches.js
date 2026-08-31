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

function router() {
  const r = express.Router();

  r.get('/live', async (req, res) => {
    try {
      const state = await internal.getLiveState();
      res.json(state.activeMatches);
    } catch (e) {
      res.status(502).json({ error: `Game server unreachable: ${e.message}` });
    }
  });

  r.get('/', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const { data, error } = await supabase
        .from('matches')
        .select('id, mode, status, room_code, instrument_1, instrument_2, instruments, start_time, end_time, created_at, winner_id, winner:players!matches_winner_id_fkey(username)')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;

      const matchIds = data.map((m) => m.id);
      const { data: mpRows } = await supabase.from('match_players').select('match_id, player_id, final_pnl').in('match_id', matchIds);
      const countByMatch = {};
      const prizeByMatch = {};
      (mpRows || []).forEach((row) => {
        countByMatch[row.match_id] = (countByMatch[row.match_id] || 0) + 1;
        if (Number(row.final_pnl) > 0) prizeByMatch[row.match_id] = (prizeByMatch[row.match_id] || 0) + Number(row.final_pnl);
      });

      res.json(data.map((m) => ({
        id: m.id, mode: m.mode, status: m.status, roomCode: m.room_code,
        instruments: matchInstruments(m), startTime: m.start_time, endTime: m.end_time, createdAt: m.created_at,
        winnerUsername: m.winner?.username || null,
        playerCount: countByMatch[m.id] || 0,
        durationSeconds: m.start_time && m.end_time ? Math.round((new Date(m.end_time) - new Date(m.start_time)) / 1000) : null,
      })));
    } catch (e) {
      console.error('[admin matches list]', e);
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
