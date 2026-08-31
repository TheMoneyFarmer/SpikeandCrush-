'use strict';

// Small internal-only bridge the separate admin panel (port 3003) calls for
// the handful of things that only exist in this process's memory: which
// matches are live right now, forcing one to end, kicking a mid-match player,
// and hot-reloading game_config into the running MATCH_MODES object. Every
// other admin data need goes straight to Supabase from the admin server
// itself (see admin/lib/supabaseAdmin.js) - this router only exists for
// state Supabase doesn't have.
const express = require('express');

function requireInternalSecret(req, res, next) {
  const expected = process.env.INTERNAL_ADMIN_SECRET;
  if (!expected || req.headers['x-internal-secret'] !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Belt-and-braces: this bridge should only ever be called from the admin
  // server on the same machine, never reachable from the public internet.
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== 'localhost') {
    return res.status(403).json({ error: 'Forbidden - internal endpoint, localhost only' });
  }
  next();
}

function createInternalAdminRouter({ gameEngine, io, db, instrumentsRegistry, sabotage, TIERS, recentErrors }) {
  const router = express.Router();
  router.use(requireInternalSecret);

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

  router.post('/reload-config', async (req, res) => {
    try {
      const rows = req.body?.matchSettings;
      gameEngine.applyConfigOverrides(rows || null);
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

  return router;
}

module.exports = { createInternalAdminRouter };
