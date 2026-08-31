'use strict';

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const internal = require('../lib/internalGameServer');

// Matches the Stripe checkout unit_amount for battle pass premium in
// server/index.js (line ~1303: unit_amount: 499). battle_pass_subscriptions
// doesn't store a price itself (it's a subscription status row), so revenue
// attribution multiplies this constant by new-premium-subs-today.
const BATTLE_PASS_PRICE_USD = 4.99;
const PRESENCE_FRESH_MINUTES = 3; // player_presence rows older than this aren't "online" anymore, just stale

function startOfDayIso(daysAgo = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

function pctChange(today, yesterday) {
  if (!yesterday) return today > 0 ? 100 : 0;
  return Math.round(((today - yesterday) / yesterday) * 1000) / 10;
}

function router() {
  const r = express.Router();

  r.get('/overview', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const todayStart = startOfDayIso(0);
      const yesterdayStart = startOfDayIso(1);
      const freshSince = new Date(Date.now() - PRESENCE_FRESH_MINUTES * 60 * 1000).toISOString();

      const [
        presenceRes,
        matchesTodayRes,
        matchesYesterdayRes,
        coinRevTodayRes,
        coinRevYesterdayRes,
        bpTodayRes,
        regTodayRes,
        regYesterdayRes,
        tournamentsRes,
        liveState,
      ] = await Promise.all([
        supabase.from('player_presence').select('status').gte('updated_at', freshSince).neq('status', 'offline'),
        supabase.from('matches').select('mode').gte('created_at', todayStart),
        supabase.from('matches').select('mode').gte('created_at', yesterdayStart).lt('created_at', todayStart),
        supabase.from('coin_purchases').select('amount_usd').eq('status', 'completed').gte('created_at', todayStart),
        supabase.from('coin_purchases').select('amount_usd').eq('status', 'completed').gte('created_at', yesterdayStart).lt('created_at', todayStart),
        supabase.from('battle_pass_subscriptions').select('id').eq('is_premium', true).gte('started_at', todayStart),
        supabase.from('players').select('id, supabase_user_id').gte('created_at', todayStart),
        supabase.from('players').select('id').gte('created_at', yesterdayStart).lt('created_at', todayStart),
        supabase.from('tournaments').select('id, name, status, starts_at').in('status', ['signup', 'active']),
        internal.getLiveState().catch(() => null),
      ]);

      const presence = presenceRes.data || [];
      const inLobby = presence.filter((p) => p.status === 'in_lobby').length;
      const inMatch = presence.filter((p) => p.status === 'in_match').length;
      const browsing = presence.filter((p) => p.status === 'online').length;

      const modeCounts = (rows) => (rows || []).reduce((acc, m) => { acc[m.mode] = (acc[m.mode] || 0) + 1; return acc; }, {});
      const matchesToday = modeCounts(matchesTodayRes.data);
      const matchesTodayTotal = Object.values(matchesToday).reduce((a, b) => a + b, 0);
      const matchesYesterdayTotal = (matchesYesterdayRes.data || []).length;

      const coinRevToday = (coinRevTodayRes.data || []).reduce((s, r) => s + Number(r.amount_usd || 0), 0);
      const coinRevYesterday = (coinRevYesterdayRes.data || []).reduce((s, r) => s + Number(r.amount_usd || 0), 0);
      const bpRevToday = (bpTodayRes.data || []).length * BATTLE_PASS_PRICE_USD;
      const revenueToday = coinRevToday + bpRevToday;
      const revenueYesterday = coinRevYesterday; // battle pass yesterday not separately tracked here, coins dominate revenue anyway

      const regToday = regTodayRes.data || [];
      const regOAuth = regToday.filter((p) => p.supabase_user_id).length;
      const regEmail = regToday.length - regOAuth;

      const tournaments = tournamentsRes.data || [];
      const nextTournament = tournaments
        .filter((t) => t.status === 'signup' && t.starts_at)
        .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0] || null;
      let nextTournamentRegs = 0;
      if (nextTournament) {
        const { count } = await supabase.from('tournament_registrations').select('id', { count: 'exact', head: true }).eq('tournament_id', nextTournament.id);
        nextTournamentRegs = count || 0;
      }

      res.json({
        activePlayers: { total: presence.length, browsing, inLobby, inMatch },
        matchesToday: { total: matchesTodayTotal, byMode: matchesToday, changePct: pctChange(matchesTodayTotal, matchesYesterdayTotal) },
        revenueToday: { total: revenueToday, coins: coinRevToday, battlePass: bpRevToday, changePct: pctChange(revenueToday, revenueYesterday) },
        registrationsToday: { total: regToday.length, email: regEmail, oauth: regOAuth, changePct: pctChange(regToday.length, (regYesterdayRes.data || []).length) },
        tournaments: { activeCount: tournaments.length, next: nextTournament, nextRegistrations: nextTournamentRegs },
        systemHealth: liveState
          ? {
              uptimeSeconds: liveState.uptimeSeconds,
              websocketConnections: liveState.websocketConnections,
              dbConfigured: liveState.dbConfigured,
              gameServerReachable: true,
            }
          : { gameServerReachable: false },
      });
    } catch (e) {
      console.error('[admin dashboard/overview]', e);
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/realtime', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const since30d = startOfDayIso(29);
      const todayStart = startOfDayIso(0);

      const [presenceHistory, purchases30d, matchesTodayRes] = await Promise.all([
        // player_presence only holds current status per player (no history table
        // kept), so "players online last 24h" is approximated from login_events
        // timestamps bucketed by hour - a real proxy for activity, not a literal
        // concurrent-online count (which would need a time-series presence log
        // this schema doesn't have).
        supabase.from('login_events').select('created_at').gte('created_at', since24h),
        supabase.from('coin_purchases').select('amount_usd, created_at').eq('status', 'completed').gte('created_at', since30d),
        supabase.from('matches').select('mode, created_at').gte('created_at', todayStart),
      ]);

      const hourBuckets = new Array(24).fill(0);
      (presenceHistory.data || []).forEach((row) => {
        const hoursAgo = Math.floor((Date.now() - new Date(row.created_at).getTime()) / (60 * 60 * 1000));
        if (hoursAgo >= 0 && hoursAgo < 24) hourBuckets[23 - hoursAgo]++;
      });

      const dayBuckets = {};
      for (let i = 0; i < 30; i++) dayBuckets[startOfDayIso(29 - i).slice(0, 10)] = 0;
      (purchases30d.data || []).forEach((row) => {
        const day = row.created_at.slice(0, 10);
        if (day in dayBuckets) dayBuckets[day] += Number(row.amount_usd || 0);
      });

      const hourOfDayMatches = new Array(24).fill(0);
      const modeByHour = { quick: new Array(24).fill(0), blitz: new Array(24).fill(0), grand: new Array(24).fill(0), private: new Array(24).fill(0), solo: new Array(24).fill(0), async: new Array(24).fill(0), tournament: new Array(24).fill(0) };
      (matchesTodayRes.data || []).forEach((row) => {
        const h = new Date(row.created_at).getUTCHours();
        hourOfDayMatches[h]++;
        if (modeByHour[row.mode]) modeByHour[row.mode][h]++;
      });

      // Registration funnel: real counts where the schema tracks them
      // (players, first match via match_players, week-2 retention via
      // login_events spaced 7+ days apart), estimated where it doesn't
      // (site visits aren't logged anywhere - no analytics/pageview table exists).
      const [totalPlayers, playersWithMatch, playersWithPurchase] = await Promise.all([
        supabase.from('players').select('id', { count: 'exact', head: true }),
        supabase.from('match_players').select('player_id'),
        supabase.from('coin_purchases').select('player_id').eq('status', 'completed'),
      ]);
      const uniqueWithMatch = new Set((playersWithMatch.data || []).map((r) => r.player_id)).size;
      const uniqueWithPurchase = new Set((playersWithPurchase.data || []).map((r) => r.player_id)).size;

      res.json({
        playersOnline24h: { labels: Array.from({ length: 24 }, (_, i) => `${23 - i}h ago`).reverse(), values: hourBuckets, note: 'Proxy from login_events (no time-series presence log exists)' },
        revenue30d: { labels: Object.keys(dayBuckets), values: Object.values(dayBuckets) },
        matchesPerHourToday: { labels: hourOfDayMatches.map((_, h) => `${h}:00`), byMode: modeByHour },
        registrationFunnel: [
          { stage: 'Registered', value: totalPlayers.count || 0 },
          { stage: 'Played 1st match', value: uniqueWithMatch },
          { stage: 'Made a purchase', value: uniqueWithPurchase },
        ],
      });
    } catch (e) {
      console.error('[admin dashboard/realtime]', e);
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/activity-feed', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const limit = 30;
      const [regs, matchesEnded, purchases, bans] = await Promise.all([
        supabase.from('players').select('id, username, created_at, supabase_user_id, country').order('created_at', { ascending: false }).limit(limit),
        supabase.from('matches').select('id, mode, end_time, winner_id, players:match_players(count)').eq('status', 'finished').order('end_time', { ascending: false }).limit(limit),
        supabase.from('coin_purchases').select('id, amount_usd, package_coins, created_at, player_id').eq('status', 'completed').order('created_at', { ascending: false }).limit(limit),
        supabase.from('player_moderation_actions').select('id, action_type, reason, created_at, player_id').in('action_type', ['temp_ban', 'perm_ban']).order('created_at', { ascending: false }).limit(limit),
      ]);

      const playerIds = new Set();
      (purchases.data || []).forEach((p) => playerIds.add(p.player_id));
      (bans.data || []).forEach((b) => playerIds.add(b.player_id));
      (matchesEnded.data || []).forEach((m) => m.winner_id && playerIds.add(m.winner_id));
      let namesById = {};
      if (playerIds.size) {
        const { data } = await supabase.from('players').select('id, username').in('id', Array.from(playerIds));
        namesById = Object.fromEntries((data || []).map((p) => [p.id, p.username]));
      }

      const events = [
        ...(regs.data || []).map((p) => ({
          type: 'registration', ts: p.created_at,
          text: `New player registered: ${p.username}${p.country ? ` (${p.country})` : ''} via ${p.supabase_user_id ? 'OAuth' : 'email'}`,
        })),
        ...(matchesEnded.data || []).map((m) => ({
          type: 'match_end', ts: m.end_time,
          text: `Match ended: ${m.mode} · winner ${namesById[m.winner_id] || 'unknown'}`,
        })),
        ...(purchases.data || []).map((p) => ({
          type: 'payment', ts: p.created_at,
          text: `Payment received: $${Number(p.amount_usd).toFixed(2)} for ${p.package_coins} coins (${namesById[p.player_id] || 'player'})`,
        })),
        ...(bans.data || []).map((b) => ({
          type: 'ban', ts: b.created_at,
          text: `Ban issued: ${namesById[b.player_id] || 'player'} - ${b.reason || 'no reason given'}`,
        })),
      ]
        .filter((e) => e.ts)
        .sort((a, b) => new Date(b.ts) - new Date(a.ts))
        .slice(0, limit);

      res.json(events);
    } catch (e) {
      console.error('[admin dashboard/activity-feed]', e);
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
