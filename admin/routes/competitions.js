'use strict';

// Long-form competitions (Daily / Weekly / Weekend / Monthly). Reads come
// straight from Supabase; anything that moves money or pushes live events
// (settle, void + refund, disqualify, test creation) goes through the game
// server's compEngine via the internal bridge so there's one implementation.
const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const internal = require('../lib/internalGameServer');

module.exports = function competitionsRoutes() {
  const r = express.Router();
  const adminName = (req) => req.admin.email || req.admin.username;
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });

  r.use((req, res, next) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    next();
  });

  r.get('/', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('competitions')
        .select('id, title, type, frequency, status, is_test, starts_at, ends_at, entry_fee_coins, instruments, replay_speed, data_window_start, settled_at, comp_accounts(count)')
        .eq('type', 'native')
        .order('starts_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      res.json({ competitions: data.map(({ comp_accounts: c, ...rest }) => ({ ...rest, entrants: c?.[0]?.count || 0 })) });
    } catch (e) {
      fail(res, e);
    }
  });

  // Entrants with their accounts, ranked by equity (or final rank once settled).
  r.get('/:id/entrants', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('comp_accounts')
        .select('*, player:players(username, email)')
        .eq('competition_id', req.params.id);
      if (error) throw error;
      data.sort((a, b) => (a.final_rank ?? 1e9) - (b.final_rank ?? 1e9) || Number(b.equity) - Number(a.equity));
      res.json({ entrants: data });
    } catch (e) {
      fail(res, e);
    }
  });

  r.get('/accounts/:accountId', async (req, res) => {
    try {
      const [{ data: account, error: aErr }, { data: positions, error: pErr }, { data: snapshots, error: sErr }] = await Promise.all([
        supabase.from('comp_accounts').select('*, player:players(username, email)').eq('id', req.params.accountId).maybeSingle(),
        supabase.from('comp_positions').select('*').eq('account_id', req.params.accountId).order('opened_at', { ascending: false }).limit(500),
        supabase.from('comp_equity_snapshots').select('ts, equity').eq('account_id', req.params.accountId).order('ts').limit(2000),
      ]);
      if (aErr || pErr || sErr) throw aErr || pErr || sErr;
      if (!account) return res.status(404).json({ error: 'Account not found' });
      res.json({ account, positions, snapshots });
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/:id/settle', async (req, res) => {
    try {
      const result = await internal.settleCompetition(req.params.id);
      await logAdminAction({ adminUsername: adminName(req), actionType: 'force_settle_competition', targetType: 'competition', targetId: req.params.id, details: result, ip: clientIp(req) });
      res.json(result);
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/:id/void', async (req, res) => {
    try {
      const result = await internal.voidCompetition(req.params.id);
      await logAdminAction({ adminUsername: adminName(req), actionType: 'void_competition', targetType: 'competition', targetId: req.params.id, details: result, ip: clientIp(req) });
      res.json(result);
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/:id/disqualify/:playerId', async (req, res) => {
    try {
      const result = await internal.disqualifyFromCompetition(req.params.id, req.params.playerId);
      await logAdminAction({ adminUsername: adminName(req), actionType: 'disqualify_competition_player', targetType: 'competition', targetId: req.params.id, details: { playerId: req.params.playerId, reason: req.body?.reason || null }, ip: clientIp(req) });
      res.json(result);
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/test', async (req, res) => {
    try {
      const { durationMinutes, replaySpeed, instruments, entryFee, title } = req.body || {};
      const result = await internal.createTestCompetition({ durationMinutes, replaySpeed, instruments, entryFee, title });
      await logAdminAction({ adminUsername: adminName(req), actionType: 'create_test_competition', targetType: 'competition', targetId: result.competition?.id, details: req.body, ip: clientIp(req) });
      res.json(result);
    } catch (e) {
      fail(res, e);
    }
  });

  return r;
};
