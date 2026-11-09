'use strict';

// Admin API for fire gameplay: market curation + Fire monitor, every tunable
// in server/config/gameFeel.js, card unlock grants/revokes and reports.
// Same pattern as routes/gameConfig.js: the value is stored in game_config
// (key 'game_feel'), the game server is told to reload it over the secret
// bridge, and every change is written to the admin audit log.

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp, requireSuperAdmin } = require('../lib/auth');
const internal = require('../lib/internalGameServer');

const SECTIONS = ['market', 'cards', 'progression', 'rankSplit', 'heat', 'missions', 'spikeAlerts', 'crown', 'ghostChallenge', 'discover'];

async function stored() {
  if (!isConfigured) return {};
  const { data } = await supabase.from('game_config').select('value').eq('key', 'game_feel').maybeSingle();
  return (data && data.value) || {};
}

function router() {
  const r = express.Router();

  r.get('/state', async (req, res) => {
    try {
      res.json(await internal.fire('/state'));
    } catch (e) {
      res.status(502).json({ error: `Game server unreachable: ${e.message}` });
    }
  });

  // Replace one section's overrides (partial object merged over the defaults
  // on the game server). Admin and super_admin; super_admin only for the
  // market and rank-split switches.
  r.put('/config/:section', async (req, res) => {
    const { section } = req.params;
    if (!SECTIONS.includes(section)) return res.status(400).json({ error: 'Unknown section' });
    if (!['admin', 'super_admin'].includes(req.admin.role)) return res.status(403).json({ error: 'Admins only' });
    if (['market', 'rankSplit'].includes(section) && req.admin.role !== 'super_admin') return res.status(403).json({ error: 'Super admins only for this section' });
    const value = req.body && req.body.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return res.status(400).json({ error: 'value must be an object' });
    try {
      const all = await stored();
      const before = all[section] || null;
      all[section] = value;
      await supabase.from('game_config').upsert({ key: 'game_feel', value: all, updated_by: req.admin.username, updated_at: new Date().toISOString() });
      const live = await internal.fire('/reload', {});
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'update_game_feel', targetType: 'game_config', targetId: section, details: { section, before, after: value }, ip: clientIp(req) });
      res.json({ success: true, live: true, config: live.config });
    } catch (e) {
      res.status(502).json({ error: `Could not apply: ${e.message}` });
    }
  });

  // Rebuild playlists (super_admin): runs the curation in the background on
  // the game server, validates, swaps only if the guarantee holds.
  r.post('/rebuild', requireSuperAdmin, async (req, res) => {
    try {
      const out = await internal.fire('/rebuild', {});
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'rebuild_playlists', targetType: 'market', details: out, ip: clientIp(req) });
      res.json(out);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
  r.get('/rebuild', async (req, res) => {
    try {
      res.json(await internal.fire('/rebuild'));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Grant or revoke one card for one player, with a reason (logged).
  r.post('/card-grant', requireSuperAdmin, async (req, res) => {
    try {
      const out = await internal.fire('/card-grant', req.body || {});
      await logAdminAction({ adminUsername: req.admin.username, actionType: req.body && req.body.revoke ? 'revoke_card_unlock' : 'grant_card_unlock', targetType: 'player', targetId: req.body && req.body.playerId, details: req.body, ip: clientIp(req) });
      res.json(out);
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  r.get('/unlock-report', async (req, res) => {
    try {
      res.json(await internal.fire('/unlock-report'));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
