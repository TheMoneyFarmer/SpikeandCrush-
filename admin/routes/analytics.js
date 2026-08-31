'use strict';

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');

function daysAgoIso(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

async function computePlayerAnalytics() {
  if (!isConfigured) throw Object.assign(new Error('Supabase not configured'), { status: 503 });
  const since90 = daysAgoIso(90).toISOString();
      const [loginsRes, playersRes, sessionsRes] = await Promise.all([
        supabase.from('login_events').select('player_id, created_at').gte('created_at', since90),
        supabase.from('players').select('id, created_at'),
        supabase.from('sessions').select('created_at, last_seen_at').gte('created_at', since90),
      ]);
      const logins = loginsRes.data || [];
      const players = playersRes.data || [];
      const createdById = Object.fromEntries(players.map((p) => [p.id, new Date(p.created_at)]));

      // DAU for the last 90 days, then rolled up into weekly/monthly unique-active counts.
      const dauByDay = {};
      for (let i = 89; i >= 0; i--) dauByDay[daysAgoIso(i).toISOString().slice(0, 10)] = new Set();
      logins.forEach((l) => {
        const day = l.created_at.slice(0, 10);
        if (dauByDay[day]) dauByDay[day].add(l.player_id);
      });
      const dauSeries = Object.entries(dauByDay).map(([day, set]) => ({ day, count: set.size }));

      const wauSet = new Set(logins.filter((l) => new Date(l.created_at) >= daysAgoIso(6)).map((l) => l.player_id));
      const mauSet = new Set(logins.filter((l) => new Date(l.created_at) >= daysAgoIso(29)).map((l) => l.player_id));

      let newCount = 0, returningCount = 0;
      const activeLast30 = new Set([...mauSet]);
      activeLast30.forEach((pid) => {
        const created = createdById[pid];
        if (created && created >= daysAgoIso(29)) newCount++; else returningCount++;
      });

      const sessions = sessionsRes.data || [];
      const durationsMin = sessions.map((s) => (new Date(s.last_seen_at) - new Date(s.created_at)) / 60000).filter((m) => m >= 0 && m < 600);
      const sessionBuckets = { '<1m': 0, '1-5m': 0, '5-15m': 0, '15-30m': 0, '30-60m': 0, '60m+': 0 };
      durationsMin.forEach((m) => {
        if (m < 1) sessionBuckets['<1m']++;
        else if (m < 5) sessionBuckets['1-5m']++;
        else if (m < 15) sessionBuckets['5-15m']++;
        else if (m < 30) sessionBuckets['15-30m']++;
        else if (m < 60) sessionBuckets['30-60m']++;
        else sessionBuckets['60m+']++;
      });

      // D1/D7/D30 retention: for each player who signed up N+ days ago, did
      // they log in again on that exact day-offset from signup?
      function retentionRate(dayOffset) {
        const eligible = players.filter((p) => new Date(p.created_at) <= daysAgoIso(dayOffset));
        if (!eligible.length) return null;
        const loginDaysByPlayer = {};
        logins.forEach((l) => { (loginDaysByPlayer[l.player_id] = loginDaysByPlayer[l.player_id] || []).push(new Date(l.created_at)); });
        let retained = 0;
        eligible.forEach((p) => {
          const target = new Date(p.created_at);
          target.setUTCDate(target.getUTCDate() + dayOffset);
          const dayStr = target.toISOString().slice(0, 10);
          const hits = (loginDaysByPlayer[p.id] || []).some((d) => d.toISOString().slice(0, 10) === dayStr);
          if (hits) retained++;
        });
        return Math.round((retained / eligible.length) * 1000) / 10;
      }

      // Cohort heatmap: signup month x weeks-since-signup active %.
      const cohorts = {};
      players.forEach((p) => {
        const cohort = p.created_at.slice(0, 7);
        (cohorts[cohort] = cohorts[cohort] || []).push(p);
      });
      const loginDaysByPlayer = {};
      logins.forEach((l) => { (loginDaysByPlayer[l.player_id] = loginDaysByPlayer[l.player_id] || []).push(new Date(l.created_at)); });
      const cohortHeatmap = Object.entries(cohorts).slice(-6).map(([cohort, cohortPlayers]) => {
        const weeks = [0, 1, 2, 3, 4].map((w) => {
          const active = cohortPlayers.filter((p) => {
            const weekStart = new Date(p.created_at); weekStart.setUTCDate(weekStart.getUTCDate() + w * 7);
            const weekEnd = new Date(weekStart); weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
            return (loginDaysByPlayer[p.id] || []).some((d) => d >= weekStart && d < weekEnd);
          }).length;
          return cohortPlayers.length ? Math.round((active / cohortPlayers.length) * 1000) / 10 : 0;
        });
        return { cohort, size: cohortPlayers.length, weeks };
      });

      return {
        dauSeries, wau: wauSet.size, mau: mauSet.size,
        newVsReturning: { new: newCount, returning: returningCount },
        sessionLengthDistribution: sessionBuckets,
        retention: { day1: retentionRate(1), day7: retentionRate(7), day30: retentionRate(30) },
        cohortHeatmap,
        note: 'DAU/WAU/MAU and retention are derived from login_events, not a dedicated analytics pipeline - accurate for actual logins, but a session that never re-authenticates (token still valid) won’t generate a new login_events row.',
      };
}

function router() {
  const r = express.Router();

  r.get('/players', async (req, res) => {
    try {
      res.json(await computePlayerAnalytics());
    } catch (e) {
      console.error('[admin analytics players]', e);
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Match Analytics reuses the exact same computation as GET
  // /api/matches/analytics - the nav links here separately (Analytics > Match
  // Analytics) but there's only one implementation of it.
  r.get('/matches', async (req, res) => {
    try {
      res.json(await require('./matches').computeMatchAnalytics());
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  r.get('/revenue', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const since90 = daysAgoIso(90).toISOString();
      const [purchases, players] = await Promise.all([
        supabase.from('coin_purchases').select('amount_usd, created_at, player_id').eq('status', 'completed').gte('created_at', since90),
        supabase.from('players').select('id', { count: 'exact', head: true }),
      ]);
      const rows = purchases.data || [];
      const byDay = {};
      for (let i = 89; i >= 0; i--) byDay[daysAgoIso(i).toISOString().slice(0, 10)] = 0;
      rows.forEach((p) => { const d = p.created_at.slice(0, 10); if (d in byDay) byDay[d] += Number(p.amount_usd || 0); });

      const avgOrderValue = rows.length ? rows.reduce((s, p) => s + Number(p.amount_usd), 0) / rows.length : 0;
      const payingPlayers = new Set(rows.map((p) => p.player_id)).size;
      const conversionRate = players.count ? Math.round((payingPlayers / players.count) * 1000) / 10 : 0;

      const last7 = Object.values(byDay).slice(-7).reduce((a, b) => a + b, 0);
      const projectedMonthly = Math.round((last7 / 7) * 30 * 100) / 100;

      res.json({
        revenueByDay: byDay,
        averageOrderValue: Math.round(avgOrderValue * 100) / 100,
        conversionRateFreeToPaid: conversionRate,
        projectedMonthlyRevenue: projectedMonthly,
        projectionNote: 'Linear extrapolation from the last 7 days of coin-purchase revenue - a simple trend estimate, not a forecast model.',
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/retention', async (req, res) => {
    // Retention numbers live inside the same player-analytics computation
    // (day1/day7/day30 + cohort heatmap) rather than a separate query set.
    try {
      const full = await computePlayerAnalytics();
      res.json({ retention: full.retention, cohortHeatmap: full.cohortHeatmap, note: full.note });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  r.get('/geographic', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const { data: players } = await supabase.from('players').select('id, country');
      const byCountry = {};
      (players || []).forEach((p) => { const c = p.country || 'Unknown'; byCountry[c] = (byCountry[c] || 0) + 1; });

      const ids = (players || []).filter((p) => p.country).map((p) => p.id);
      const { data: purchases } = ids.length ? await supabase.from('coin_purchases').select('player_id, amount_usd').eq('status', 'completed').in('player_id', ids) : { data: [] };
      const countryById = Object.fromEntries((players || []).map((p) => [p.id, p.country]));
      const revenueByCountry = {};
      (purchases || []).forEach((p) => { const c = countryById[p.player_id] || 'Unknown'; revenueByCountry[c] = (revenueByCountry[c] || 0) + Number(p.amount_usd || 0); });

      res.json({
        playersByCountry: byCountry,
        revenueByCountry,
        unknownCountryCount: byCountry['Unknown'] || 0,
        note: 'country comes straight from players.country (self-reported/OAuth profile field) - there is no IP-geolocation pipeline in this build, so any player who never set it shows as Unknown.',
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
