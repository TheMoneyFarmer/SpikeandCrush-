'use strict';

// Small internal-only bridge the separate admin panel (port 3003) calls for
// the handful of things that only exist in this process's memory: which
// matches are live right now, forcing one to end, kicking a mid-match player,
// and hot-reloading game_config into the running MATCH_MODES object. Every
// other admin data need goes straight to Supabase from the admin server
// itself (see admin/lib/supabaseAdmin.js) - this router only exists for
// state Supabase doesn't have.
const express = require('express');
const { requireBridgeSecret } = require('./bridgeAuth');

// Only the fields the admin Match Settings form edits, as positive whole
// numbers, for modes that exist - a bad saved value can never break a mode.
const MATCH_SETTING_FIELDS = ['entryCoins', 'durationSeconds', 'maxPlayers', 'minPlayers', 'lobbyTimeoutMs', 'cardsPerPlayer', 'instrumentCount'];
function sanitizeMatchSettings(rows) {
  if (!rows || typeof rows !== 'object') return null;
  const out = {};
  for (const [mode, patch] of Object.entries(rows)) {
    if (!patch || typeof patch !== 'object') continue;
    const clean = {};
    for (const f of MATCH_SETTING_FIELDS) {
      const v = Number(patch[f]);
      if (patch[f] !== undefined && patch[f] !== '' && Number.isFinite(v) && v >= 0 && Number.isInteger(v)) clean[f] = v;
    }
    if (Object.keys(clean).length) out[mode] = clean;
  }
  return out;
}

function createInternalAdminRouter({ gameEngine, compEngine, io, db, instrumentsRegistry, sabotage, TIERS, recentErrors, notifyPlayer }) {
  const router = express.Router();
  router.use(requireBridgeSecret);

  // Read-only reference/config data for the Game Config admin pages - pulled
  // straight from the running process's live objects (post any config
  // overrides already applied) rather than duplicated as a second copy.
  router.get('/config', (req, res) => {
    res.json({
      matchModes: gameEngine.MATCH_MODES,
      instruments: instrumentsRegistry.listInstruments(),
      sabotageCards: sabotage.CARDS,
      tiers: TIERS,
    });
  });

  router.get('/errors', (req, res) => {
    res.json(recentErrors.slice(-200).reverse());
  });

  router.get('/state', (req, res) => {
    res.json({
      uptimeSeconds: process.uptime(),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      websocketConnections: io.engine.clientsCount,
      activeMatches: gameEngine.listActiveMatches(),
      memory: process.memoryUsage(),
      nodeVersion: process.version,
      dbConfigured: db.isConfigured,
    });
  });

  router.post('/matches/:id/force-end', async (req, res) => {
    const result = await gameEngine.forceEndMatch(req.params.id);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  });

  router.post('/matches/:id/void', async (req, res) => {
    const result = await gameEngine.voidMatch(req.params.id);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  });

  router.post('/matches/:id/kick/:playerId', async (req, res) => {
    const result = await gameEngine.kickPlayerFromMatch(req.params.id, req.params.playerId);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  });

  // Fixed: the admin panel calls this with no body after saving
  // game_config 'match_settings', so the saved values used to be dropped.
  // The game server now reads them back from the database itself.
  router.post('/reload-config', async (req, res) => {
    try {
      const rows = req.body?.matchSettings || (db.getGameConfig ? await db.getGameConfig('match_settings') : null);
      gameEngine.applyConfigOverrides(sanitizeMatchSettings(rows));
      res.json({ success: true, matchModes: gameEngine.MATCH_MODES });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Instantly pushes a banner to every currently-connected client (home page
  // banner + in-game toast) - persistence/history lives in the `announcements`
  // table, written by the admin server itself; this just makes it feel live
  // for players who are already on the site right now.
  router.post('/broadcast-announcement', (req, res) => {
    io.emit('announcement:new', req.body);
    res.json({ success: true, deliveredTo: io.engine.clientsCount });
  });

  // Lets admin-side actions that live entirely in Supabase (withdrawal
  // processed, support ticket answered) still reach the player as a live
  // toast if they're online right now - same notifyPlayer() every in-process
  // game feature already uses, just reachable from the other process.
  router.post('/notify-player/:playerId', (req, res) => {
    const { type, message, extra } = req.body || {};
    if (!type || !message) return res.status(400).json({ error: 'type and message are required' });
    notifyPlayer(req.params.playerId, type, message, extra || {});
    res.json({ success: true });
  });

  // ---- long-form competitions ---------------------------------------------------
  // Settlement/void/disqualify move money and push live events, so they run
  // through the game server's compEngine rather than as raw Supabase writes.
  const compAction = (fn) => async (req, res) => {
    try {
      res.json({ success: true, ...(await fn(req)) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  };
  router.post('/competitions/:id/settle', compAction((req) => compEngine.settle(req.params.id)));
  router.post('/competitions/:id/void', compAction((req) => compEngine.voidCompetition(req.params.id)));
  router.post('/competitions/:id/disqualify/:playerId', compAction((req) => compEngine.disqualify(req.params.id, req.params.playerId)));
  // Test competitions start now and may replay faster than real time
  // (e.g. 144x = a full day of market in 10 minutes). Never published to the hub.
  router.post('/competitions/test', compAction(async (req) => {
    const { durationMinutes = 10, replaySpeed = 144, instruments, entryFee = 0, title } = req.body || {};
    const startsAt = new Date();
    const competition = await compEngine.createCompetition({
      title: title || `TEST ${durationMinutes}m @ ${replaySpeed}x`,
      description: 'Admin test competition',
      instruments: instruments && instruments.length ? instruments : ['EURUSD', 'XAUUSD', 'BTCUSD'],
      startsAt,
      endsAt: new Date(startsAt.getTime() + Number(durationMinutes) * 60000),
      entryFee: Number(entryFee) || 0,
      payouts: [{ rank: 1, coins: 100 }, { rank: 2, coins: 50 }],
      replaySpeed: Number(replaySpeed) || 1,
      isTest: true,
    });
    return { competition };
  }));

  return router;
}

module.exports = { createInternalAdminRouter, sanitizeMatchSettings };
