'use strict';

const express = require('express');
const os = require('os');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const internal = require('../lib/internalGameServer');

const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'your_value');
const Stripe = stripeConfigured ? require('stripe') : null;
const stripe = stripeConfigured ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const REAL_TABLES = [
  'players', 'matches', 'match_players', 'trades', 'sabotage_events', 'coin_purchases', 'coin_transactions',
  'sessions', 'login_events', 'card_decks', 'player_blocks', 'battle_pass_subscriptions', 'battle_pass_progress',
  'shop_purchases', 'equipped_cosmetics', 'replays', 'clips', 'broker_partners', 'coaching_sessions',
  'async_daily', 'async_results', 'tournaments', 'tournament_registrations', 'friendships', 'player_presence',
  'notifications', 'admin_logs', 'admin_sessions', 'player_moderation_actions', 'player_reports', 'announcements',
];

function router() {
  const r = express.Router();

  r.get('/health', async (req, res) => {
    const startedAt = Date.now();
    let gameServer = null;
    let gameServerError = null;
    try {
      gameServer = await internal.getLiveState();
    } catch (e) {
      gameServerError = e.message;
    }
    const roundTripMs = Date.now() - startedAt;

    let dbOk = false;
    if (isConfigured) {
      try {
        await supabase.from('players').select('id', { count: 'exact', head: true });
        dbOk = true;
      } catch (e) {}
    }

    res.json({
      adminServer: { uptimeSeconds: process.uptime(), memory: process.memoryUsage(), nodeVersion: process.version },
      gameServer: gameServer ? { reachable: true, ...gameServer } : { reachable: false, error: gameServerError },
      database: { configured: isConfigured, reachable: dbOk },
      stripe: { configured: stripeConfigured },
      internalBridgeRoundTripMs: roundTripMs,
      host: { loadavg: os.loadavg(), totalMemMb: Math.round(os.totalmem() / 1e6), freeMemMb: Math.round(os.freemem() / 1e6), cpuCount: os.cpus().length },
    });
  });

  r.get('/api-usage', async (req, res) => {
    const result = {
      supabase: { configured: isConfigured, tableCount: REAL_TABLES.length, rowCounts: {} },
      stripe: { configured: stripeConfigured },
      llmApis: {
        note: 'This product does not call any LLM API (OpenAI, Anthropic, or otherwise) - AI opponents are rule-based, not model-driven. An ANTHROPIC_API_KEY exists in .env but is unused (see server/.env comment). ElevenLabs is not integrated either. Nothing to meter here.',
      },
    };
    if (isConfigured) {
      const counts = await Promise.all(REAL_TABLES.map((t) => supabase.from(t).select('id', { count: 'exact', head: true }).then((res) => [t, res.count]).catch(() => [t, null])));
      result.supabase.rowCounts = Object.fromEntries(counts);
    }
    if (stripeConfigured) {
      try {
        const [balance, charges] = await Promise.all([stripe.balance.retrieve(), stripe.charges.list({ limit: 10 })]);
        result.stripe.balance = balance.available.map((b) => ({ amount: b.amount / 100, currency: b.currency }));
        result.stripe.recentCharges = charges.data.map((c) => ({ amount: c.amount / 100, currency: c.currency, created: new Date(c.created * 1000).toISOString(), status: c.status }));
      } catch (e) {
        result.stripe.error = e.message;
      }
    }
    res.json(result);
  });

  r.get('/errors', async (req, res) => {
    try {
      res.json(await internal.getErrors());
    } catch (e) {
      res.status(502).json({ error: `Game server unreachable: ${e.message}` });
    }
  });

  r.get('/database', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const counts = await Promise.all(REAL_TABLES.map((t) => supabase.from(t).select('id', { count: 'exact', head: true }).then((res) => [t, res.count]).catch(() => [t, null])));
      res.json({
        rowCounts: Object.fromEntries(counts),
        note: 'Row counts only - table byte-size, slowest-query, and index-usage stats need direct Postgres introspection (pg_stat_*), which this admin server does not have a path to run from the Supabase JS client.',
        backups: { managedBy: 'Supabase (project-level point-in-time recovery)', note: 'No custom backup job exists in this codebase - backup/restore is entirely Supabase\'s managed responsibility for this project.' },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
