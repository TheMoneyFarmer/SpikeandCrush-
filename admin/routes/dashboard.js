'use strict';

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const internal = require('../lib/internalGameServer');

// Past Battle Pass price, for revenue history. Nothing is on sale now.
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

  // ---- Overview dashboard (Mission Control, 2026-11-11) ----------------------
  // One call for the whole page: KPI tiles with the previous period for the
  // change arrows, daily series, mode mix, seats, retention by signup week,
  // coin flows, and the live game-server state. Real players only: persona
  // (computer) accounts are excluded everywhere except the seat split.
  const MODE_GROUP = { quick: 'quick', blitz: 'blitz', grand: 'grand', solo: 'solo', private: 'private' }; // the rest fold into "other"
  const COIN_IN = { welcome_bonus: 'Sign-up bonus', prize_won: 'Prizes', competition_prize: 'Prizes', referral_reward: 'Invite rewards', mission_reward: 'Missions', battlepass_challenge: 'Missions', admin_grant: 'Granted by admins', dev_grant: 'Granted by admins', match_refund: 'Refunds' };
  const COIN_OUT = { match_entry: 'Entry fees', tournament_entry: 'Entry fees', competition_entry: 'Entry fees', shop_purchase: 'Shop' };

  // Supabase returns at most 1000 rows a call; page through the rest.
  async function fetchAll(build, cap = 100000) {
    const out = [];
    for (let from = 0; from < cap; from += 1000) {
      const { data, error } = await build().range(from, from + 999);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return out;
  }

  // Just the live game-server numbers, for the panel that refreshes every few seconds.
  r.get('/live-now', async (req, res) => {
    const live = await internal.getLiveState().catch(() => null);
    if (!live) return res.json({ reachable: false });
    const lm = live.activeMatches || [];
    const running = lm.filter((m) => m.status === 'active' || m.status === 'countdown');
    const seats = running.flatMap((m) => m.players || []);
    res.json({
      reachable: true,
      online: live.websocketConnections,
      matchesRunning: running.length,
      lobbiesWaiting: lm.filter((m) => m.status === 'waiting').length,
      seatsReal: seats.filter((p) => !p.isAI).length,
      seatsComputer: seats.filter((p) => p.isAI).length,
      memoryMb: Math.round((live.memory?.rss || 0) / 1e6),
      heapPct: live.memory && live.memory.heapTotal ? Math.round((live.memory.heapUsed / live.memory.heapTotal) * 100) : null,
      uptimeSeconds: live.uptimeSeconds,
    });
  });

  r.get('/insights', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
      const modeFilter = Object.keys(MODE_GROUP).concat('other').includes(req.query.mode) ? req.query.mode : 'all';
      const hourly = days === 1;
      const now = Date.now();
      const spanMs = days * 86400000;
      const start = new Date(now - spanMs);
      const prevStart = new Date(now - 2 * spanMs);
      const cohortStart = new Date(now - 42 * 86400000); // six signup weeks for retention

      const modeOf = (m) => MODE_GROUP[m] || 'other';
      const wantMode = (m) => modeFilter === 'all' || modeOf(m) === modeFilter;

      const [personas, matches, logins, signups, cohortPlayers, coinTx, invitesPaid, supportOpen, reportsOpen, circulation, live, purchases, passes] = await Promise.all([
        fetchAll(() => supabase.from('players').select('id').eq('is_persona', true)),
        fetchAll(() => supabase.from('matches').select('id, mode, status, created_at, players:match_players(player_id)').gte('created_at', prevStart.toISOString()).order('created_at')),
        fetchAll(() => supabase.from('login_events').select('player_id, created_at').gte('created_at', cohortStart < prevStart ? cohortStart.toISOString() : prevStart.toISOString())),
        fetchAll(() => supabase.from('players').select('id, created_at').eq('is_persona', false).gte('created_at', prevStart.toISOString())),
        fetchAll(() => supabase.from('players').select('id, created_at').eq('is_persona', false).gte('created_at', cohortStart.toISOString())),
        fetchAll(() => supabase.from('coin_transactions').select('type, amount, created_at, player_id').gte('created_at', start.toISOString())),
        fetchAll(() => supabase.from('player_referrals').select('id, paid_at').eq('status', 'paid').gte('paid_at', prevStart.toISOString())),
        supabase.from('support_conversations').select('id', { count: 'exact', head: true }).eq('status', 'waiting_human'),
        supabase.from('player_reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
        fetchAll(() => supabase.from('players').select('coins').eq('is_persona', false)),
        internal.getLiveState().catch(() => null),
        fetchAll(() => supabase.from('coin_purchases').select('amount_usd, created_at').eq('status', 'completed').gte('created_at', prevStart.toISOString())),
        fetchAll(() => supabase.from('battle_pass_subscriptions').select('is_premium, started_at').eq('is_premium', true).gte('started_at', prevStart.toISOString())),
      ]);
      const isPersona = new Set(personas.map((p) => p.id));

      // buckets: hours for "today", days otherwise
      const bucketMs = hourly ? 3600000 : 86400000;
      const nBuckets = hourly ? 24 : days;
      const bucketOf = (ts) => {
        const i = Math.floor((new Date(ts).getTime() - start.getTime()) / bucketMs);
        return i >= 0 && i < nBuckets ? i : -1;
      };
      const labels = Array.from({ length: nBuckets }, (_, i) => new Date(start.getTime() + i * bucketMs).toISOString());
      const inCur = (ts) => new Date(ts) >= start;
      const inPrev = (ts) => { const d = new Date(ts); return d >= prevStart && d < start; };

      // matches, seats, players who played
      const mm = matches.filter((m) => wantMode(m.mode) && m.status !== 'cancelled' && m.status !== 'void');
      const modes = ['quick', 'blitz', 'grand', 'solo', 'private', 'other'];
      const byMode = Object.fromEntries(modes.map((k) => [k, Array(nBuckets).fill(0)]));
      const matchSeries = Array(nBuckets).fill(0);
      const activeSets = Array.from({ length: nBuckets }, () => new Set());
      const activeCur = new Set();
      const activePrev = new Set();
      let seatsReal = 0, seatsComp = 0, seatsRealPrev = 0, seatsCompPrev = 0, matchesCur = 0, matchesPrev = 0;
      for (const m of mm) {
        const real = (m.players || []).filter((p) => !isPersona.has(p.player_id));
        const comp = (m.players || []).length - real.length;
        if (inCur(m.created_at)) {
          matchesCur += 1;
          seatsReal += real.length; seatsComp += comp;
          const b = bucketOf(m.created_at);
          if (b >= 0) { matchSeries[b] += 1; byMode[modeOf(m.mode)][b] += 1; real.forEach((p) => activeSets[b].add(p.player_id)); }
          real.forEach((p) => activeCur.add(p.player_id));
        } else if (inPrev(m.created_at)) {
          matchesPrev += 1;
          seatsRealPrev += real.length; seatsCompPrev += comp;
          real.forEach((p) => activePrev.add(p.player_id));
        }
      }
      // logins count as active too (the mode filter only applies to play)
      if (modeFilter === 'all') {
        for (const l of logins) {
          if (isPersona.has(l.player_id)) continue;
          if (inCur(l.created_at)) { activeCur.add(l.player_id); const b = bucketOf(l.created_at); if (b >= 0) activeSets[b].add(l.player_id); }
          else if (inPrev(l.created_at)) activePrev.add(l.player_id);
        }
      }
      const signupSeries = Array(nBuckets).fill(0);
      let signupsCur = 0, signupsPrev = 0;
      for (const p of signups) {
        if (inCur(p.created_at)) { signupsCur += 1; const b = bucketOf(p.created_at); if (b >= 0) signupSeries[b] += 1; } else if (inPrev(p.created_at)) signupsPrev += 1;
      }
      const invitesCur = invitesPaid.filter((x) => inCur(x.paid_at)).length;
      const invitesPrev = invitesPaid.filter((x) => inPrev(x.paid_at)).length;
      const pct = (a, b) => (a + b ? Math.round((a / (a + b)) * 1000) / 10 : null);

      // retention: of each signup week, the share seen again N or more days after signing up
      const lastSeen = new Map(); // player -> list of activity times
      const touch = (id, ts) => { if (!lastSeen.has(id)) lastSeen.set(id, []); lastSeen.get(id).push(new Date(ts).getTime()); };
      for (const l of logins) touch(l.player_id, l.created_at);
      for (const m of matches) (m.players || []).forEach((p) => touch(p.player_id, m.created_at));
      const DAYS = [1, 3, 7, 14, 30];
      const weekStart = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };
      const cohorts = new Map();
      for (const p of cohortPlayers) {
        const key = weekStart(p.created_at).toISOString().slice(0, 10);
        if (!cohorts.has(key)) cohorts.set(key, []);
        cohorts.get(key).push(p);
      }
      const retention = [...cohorts.entries()].sort().slice(-6).map(([week, ps]) => ({
        week,
        size: ps.length,
        cells: DAYS.map((n) => {
          const eligible = ps.filter((p) => new Date(p.created_at).getTime() + n * 86400000 <= now);
          if (!eligible.length) return null;
          const back = eligible.filter((p) => (lastSeen.get(p.id) || []).some((t) => t >= new Date(p.created_at).getTime() + n * 86400000)).length;
          return Math.round((back / eligible.length) * 100);
        }),
      }));

      // coin flows in the period (real players only)
      const flows = {};
      for (const t of coinTx) {
        if (isPersona.has(t.player_id)) continue;
        const name = COIN_IN[t.type] || COIN_OUT[t.type];
        if (!name) continue;
        flows[name] = flows[name] || { name, dir: COIN_IN[t.type] ? 'in' : 'out', coins: 0 };
        flows[name].coins += Math.abs(t.amount);
      }

      // revenue: completed coin purchases plus premium passes (at the price they sold for)
      const revCoins = Array(nBuckets).fill(0);
      const revPass = Array(nBuckets).fill(0);
      let revCur = 0, revPrev = 0;
      for (const p of purchases) {
        const v = Number(p.amount_usd) || 0;
        if (inCur(p.created_at)) { revCur += v; const b = bucketOf(p.created_at); if (b >= 0) revCoins[b] += v; } else if (inPrev(p.created_at)) revPrev += v;
      }
      for (const p of passes) {
        if (inCur(p.started_at)) { revCur += BATTLE_PASS_PRICE_USD; const b = bucketOf(p.started_at); if (b >= 0) revPass[b] += BATTLE_PASS_PRICE_USD; } else if (inPrev(p.started_at)) revPrev += BATTLE_PASS_PRICE_USD;
      }
      const cents = (n) => Math.round(n * 100) / 100;

      // live game server
      const lm = (live && live.activeMatches) || [];
      const running = lm.filter((m) => m.status === 'active' || m.status === 'countdown');
      const liveSeats = running.flatMap((m) => m.players || []);
      res.json({
        range: { days, mode: modeFilter, hourly, labels },
        kpis: {
          activePlayers: { value: activeCur.size, prev: activePrev.size, series: activeSets.map((s) => s.size) },
          signups: { value: signupsCur, prev: signupsPrev, series: signupSeries },
          matches: { value: matchesCur, prev: matchesPrev, series: matchSeries },
          realSeatsPct: { value: pct(seatsReal, seatsComp), prev: pct(seatsRealPrev, seatsCompPrev) },
          invitesPaid: { value: invitesCur, prev: invitesPrev },
          revenue: { value: cents(revCur), prev: cents(revPrev), series: revCoins.map((v, i) => cents(v + revPass[i])) },
          supportWaiting: { value: supportOpen.count || 0 },
          reportsOpen: { value: reportsOpen.count || 0 },
        },
        series: { activePlayers: activeSets.map((s) => s.size), signups: signupSeries, matchesByMode: byMode, revenueCoins: revCoins.map(cents), revenuePass: revPass.map(cents) },
        seats: { real: seatsReal, computer: seatsComp },
        retention: { days: DAYS, cohorts: retention },
        coins: { circulation: circulation.reduce((a, p) => a + (p.coins || 0), 0), flows: Object.values(flows).sort((a, b) => b.coins - a.coins) },
        live: live ? {
          online: live.websocketConnections,
          matchesRunning: running.length,
          lobbiesWaiting: lm.filter((m) => m.status === 'waiting').length,
          seatsReal: liveSeats.filter((p) => !p.isAI).length,
          seatsComputer: liveSeats.filter((p) => p.isAI).length,
          memoryMb: Math.round((live.memory?.rss || 0) / 1e6),
          heapPct: live.memory && live.memory.heapTotal ? Math.round((live.memory.heapUsed / live.memory.heapTotal) * 100) : null,
          uptimeSeconds: live.uptimeSeconds,
        } : null,
      });
    } catch (e) {
      console.error('[admin dashboard insights]', e);
      res.status(500).json({ error: e.message });
    }
  });

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
        supabase.from('players').select('id, supabase_user_id').eq('is_persona', false).gte('created_at', todayStart),
        supabase.from('players').select('id').eq('is_persona', false).gte('created_at', yesterdayStart).lt('created_at', todayStart),
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
      const [totalPlayers, personaIdsRes, playersWithMatch, playersWithPurchase] = await Promise.all([
        supabase.from('players').select('id', { count: 'exact', head: true }).eq('is_persona', false),
        supabase.from('players').select('id').eq('is_persona', true),
        supabase.from('match_players').select('player_id'),
        supabase.from('coin_purchases').select('player_id').eq('status', 'completed'),
      ]);
      // match_players has no is_persona column of its own (that lives on
      // players) - exclude bot ids from the unique-player count by hand
      // instead of joining, since the persona roster is tiny.
      const personaIds = new Set((personaIdsRes.data || []).map((p) => p.id));
      const uniqueWithMatch = new Set((playersWithMatch.data || []).map((r) => r.player_id).filter((id) => !personaIds.has(id))).size;
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
        supabase.from('players').select('id, username, created_at, supabase_user_id, country').eq('is_persona', false).order('created_at', { ascending: false }).limit(limit),
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
