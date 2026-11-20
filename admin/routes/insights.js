'use strict';

// Admin Analytics dashboard API: GET /api/insights/:tab (admin-only: mounted
// behind requireAdmin like every /api route; players get 403, no login 401).
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   days in the chosen zone (default: last 30)
//   &tz=dubai|utc                      (default dubai)
//   &internal=1                        include internal traffic (default off)
//   &device= &mode= &country= &source= &campaign= &page=
//   &format=csv                        the tab's tiles and tables as CSV
// Numbers come from server/analytics/dashboard.js (definitions.js inside).

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const data = require('../lib/analyticsData');
const def = require('../../server/analytics/definitions');
const dash = require('../../server/analytics/dashboard');

const DAY = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE = /^[\w .:/@+-]{1,80}$/;

function context(q) {
  const tz = def.tzKey(q.tz);
  const today = def.dayOf(Date.now(), tz);
  const preset = { today: 0, '7': 6, '30': 29, '90': 89 }[q.preset];
  const toDay = DAY_RE.test(q.to || '') ? q.to : today;
  const fromDay = preset !== undefined ? def.addDays(today, -preset) : DAY_RE.test(q.from || '') ? q.from : def.addDays(toDay, -29);
  const span = def.daysBetween(fromDay, toDay);
  if (span < 0 || span > 400) throw Object.assign(new Error('Choose a range of up to 400 days'), { status: 400 });
  const filters = {};
  for (const k of ['device', 'mode', 'country', 'source', 'campaign', 'page']) if (q[k] && SAFE.test(String(q[k]))) filters[k] = String(q[k]);
  return { tz, fromDay, toDay: preset !== undefined ? today : toDay, includeInternal: q.internal === '1' || q.internal === 'true', filters };
}

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { if (/schema cache|42P01|does not exist|PGRST/.test(e.message || '')) return fallback; throw e; }
}

async function load(tab, ctx) {
  const now = Date.now();
  const [fromMs, toMs] = def.rangeMs(ctx.fromDay, ctx.toDay, ctx.tz);
  const iso = (ms) => new Date(ms).toISOString();
  const out = { now, idleMs: (Number(process.env.ANALYTICS_SESSION_IDLE_MINUTES) || 30) * 60000 };
  out.players = await data.players();
  // Activity reaches back 30 days before the range (rolling 30-day actives) and
  // forward to today (later returns count for retention).
  const act = await data.activity(iso(fromMs - 30 * DAY), iso(Math.max(toMs, now + 1000)));
  out.results = act.results;
  out.trades = act.trades;
  out.events = await safe(() => data.events(iso(fromMs), iso(toMs)), []);
  out.allServerEvents = await safe(() => data.events(iso(fromMs - 30 * DAY), iso(now + 1000), ['email_verified', 'login', 'signup_submitted']), []);
  const last = await safe(async () => (await supabase.from('analytics_events').select('occurred_at').order('occurred_at', { ascending: false }).limit(1)).data, []);
  out.lastEventAt = last && last[0] ? last[0].occurred_at : null;
  if (tab === 'tech' || tab === 'quality') out.tech = await safe(() => data.techEvents(iso(Math.min(fromMs, now - 2 * DAY)), iso(Math.max(toMs, now + 1000))), []);
  if (tab === 'social') out.referrals = await safe(() => data.all(() => supabase.from('player_referrals').select('created_at, status')), []);
  if (tab === 'competitions') {
    out.compEntries = await safe(async () => (await data.all(() => supabase.from('competition_entries').select('entered_at, competitions!inner(template_key, frequency)').gte('entered_at', iso(fromMs)).lt('entered_at', iso(toMs)))).map((r) => ({ entered_at: r.entered_at, template: r.competitions.template_key || r.competitions.frequency })), []);
    out.compDone = await safe(async () => (await data.all(() => supabase.from('comp_accounts').select('status, competitions!inner(template_key, frequency, ends_at, settled_at)').not('competitions.settled_at', 'is', null).gte('competitions.ends_at', iso(fromMs)).lt('competitions.ends_at', iso(toMs)))).filter((r) => r.status !== 'disqualified').map((r) => ({ ends_at: r.competitions.ends_at, template: r.competitions.template_key || r.competitions.frequency })), []);
  }
  if (tab === 'sponsors') {
    out.sponsors = await safe(async () => (await supabase.from('sponsors').select('id, name').order('name')).data || [], []);
    out.placements = await safe(async () => (await supabase.from('sponsor_placements').select('id, sponsor_id, slot')).data || [], []);
  }
  if (tab === 'affiliate') out.winners = await safe(() => data.all(() => supabase.from('comp_winners').select('status')), []);
  if (tab === 'support') {
    out.support = await safe(() => data.all(() => supabase.from('support_conversations').select('created_at, escalated_at, topic').gte('created_at', iso(fromMs)).lt('created_at', iso(toMs))), []);
    out.pwa = await safe(() => data.all(() => supabase.from('pwa_events_daily').select('day, kind, platform, count').gte('day', ctx.fromDay).lte('day', ctx.toDay)), []);
  }
  if (tab === 'quality') {
    out.recent48 = await safe(() => data.all(() => supabase.from('analytics_events').select('occurred_at, source').gte('occurred_at', iso(now - 48 * 3600000))), []);
    const lastTech = await safe(async () => (await supabase.from('tech_events').select('at').order('at', { ascending: false }).limit(1)).data, []);
    out.lastTechAt = lastTech && lastTech[0] ? lastTech[0].at : null;
    const first = async (table, col, filter) => safe(async () => { let q = supabase.from(table).select(col).order(col).limit(1); if (filter) q = filter(q); const r = (await q).data; return r && r[0] ? String(r[0][col]).slice(0, 10) : null; }, null);
    out.gaps = [
      { what: 'Page views, visitors, campaigns (first-party)', from: await first('analytics_events', 'occurred_at', (q) => q.eq('event_name', 'page_view')), before: 'Cloudflare Web Analytics and GA4 (consent only) dashboards' },
      { what: 'Sign-up source (first touch)', from: await first('players', 'first_seen_at', (q) => q.not('first_seen_at', 'is', null)), before: 'unknown for players who signed up earlier' },
      { what: 'Sponsor impressions and clicks per page and device', from: await first('analytics_events', 'occurred_at', (q) => q.in('event_name', ['placement_impression', 'placement_click'])), before: 'daily totals per placement only (sponsor_stats_daily)' },
      { what: 'Per-match event log (cards, trades, disconnects)', from: await first('match_events', 'real_at'), before: 'match results only' },
      { what: 'Match end reasons', from: await first('analytics_events', 'occurred_at', (q) => q.eq('event_name', 'match_ended')), before: 'older rows backfilled from the leave log, the rest "unknown"' },
      { what: 'Freezes and lag history', from: await first('tech_events', 'at'), before: 'kept 5 minutes in memory only' },
      { what: 'Support chat topics', from: await first('support_conversations', 'created_at', (q) => q.not('topic', 'is', null)), before: '"not classified"' },
    ];
  }
  return out;
}

function router() {
  const r = express.Router();
  r.get('/:tab', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    if (!dash.TABS.includes(req.params.tab)) return res.status(404).json({ error: 'Unknown tab' });
    try {
      const ctx = context(req.query);
      const out = dash.run(req.params.tab, await load(req.params.tab, ctx), ctx);
      const meta = { tab: req.params.tab, from: ctx.fromDay, to: ctx.toDay, timezone: ctx.tz === 'utc' ? 'UTC' : 'Asia/Dubai', includeInternal: ctx.includeInternal, filters: ctx.filters, generatedAt: new Date().toISOString() };
      if (req.query.format === 'csv') {
        res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="analytics-${req.params.tab}-${ctx.fromDay}-${ctx.toDay}.csv"`);
        return res.send(dash.toCsv(out, `Spike & Crush analytics: ${req.params.tab}, ${ctx.fromDay} to ${ctx.toDay} (${meta.timezone})${ctx.includeInternal ? ', internal traffic included' : ''}`));
      }
      res.set('Cache-Control', 'no-store');
      res.json({ meta, ...out });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });
  return r;
}

module.exports = router;
module.exports.context = context;
