'use strict';

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');

function router() {
  const r = express.Router();

  r.get('/', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const { data, error } = await supabase.from('tournaments').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      const ids = data.map((t) => t.id);
      const { data: regs } = ids.length ? await supabase.from('tournament_registrations').select('tournament_id').in('tournament_id', ids) : { data: [] };
      const countByTournament = {};
      (regs || []).forEach((row) => { countByTournament[row.tournament_id] = (countByTournament[row.tournament_id] || 0) + 1; });
      res.json(data.map((t) => ({ ...t, registeredCount: countByTournament[t.id] || 0 })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/', async (req, res) => {
    const { name, mode, bracketSize, entryCoins, prizePoolCoins, startsAt, sponsorName, rules, instruments } = req.body || {};
    if (!name || !bracketSize || !startsAt) return res.status(400).json({ error: 'name, bracketSize and startsAt are required' });
    if (![8, 16, 32, 64].includes(Number(bracketSize))) return res.status(400).json({ error: 'bracketSize must be 8, 16, 32 or 64' });
    try {
      const { data, error } = await supabase
        .from('tournaments')
        .insert({
          name, bracket_size: Number(bracketSize), entry_coins: Number(entryCoins || 0), starts_at: new Date(startsAt).toISOString(),
          prize_pool_coins: Number(prizePoolCoins || 0), status: 'signup',
          bracket_data: { mode: mode || 'quick', sponsorName: sponsorName || null, rules: rules || null, instruments: instruments || 'random' },
        })
        .select()
        .single();
      if (error) throw error;
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'create_tournament', targetType: 'tournament', targetId: data.id, details: req.body, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/:id', async (req, res) => {
    const { id } = req.params;
    const patch = {};
    ['name', 'entry_coins', 'prize_pool_coins', 'starts_at', 'status'].forEach((k) => {
      const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (req.body[camel] !== undefined) patch[k] = req.body[camel];
    });
    try {
      const { data, error } = await supabase.from('tournaments').update(patch).eq('id', id).select().single();
      if (error) throw error;
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'update_tournament', targetType: 'tournament', targetId: id, details: patch, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
      // Cancelling refunds every registrant's entry fee, same principle as
      // voiding a live match - a cancelled tournament shouldn't cost anyone coins.
      const { data: tournament } = await supabase.from('tournaments').select('entry_coins, status').eq('id', id).single();
      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
      if (tournament.entry_coins > 0) {
        const { data: regs } = await supabase.from('tournament_registrations').select('player_id').eq('tournament_id', id);
        for (const reg of regs || []) {
          const { data: player } = await supabase.from('players').select('coins').eq('id', reg.player_id).single();
          if (!player) continue;
          const newBalance = player.coins + tournament.entry_coins;
          await supabase.from('players').update({ coins: newBalance }).eq('id', reg.player_id);
          await supabase.from('coin_transactions').insert({ player_id: reg.player_id, type: 'admin_grant', amount: tournament.entry_coins, balance_after: newBalance });
        }
      }
      await supabase.from('tournaments').update({ status: 'cancelled' }).eq('id', id);
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'cancel_tournament', targetType: 'tournament', targetId: id, ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/:id/bracket', async (req, res) => {
    try {
      const { data, error } = await supabase.from('tournaments').select('bracket_data').eq('id', req.params.id).single();
      if (error) throw error;
      res.json(data.bracket_data || {});
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Credits prize_pool_coins split by the given percentage structure to
  // registrants ranked by final_rank - a real coin credit through the same
  // coin_transactions ledger every other prize/grant uses, not a UI-only stub.
  r.post('/:id/prizes/distribute', async (req, res) => {
    const { id } = req.params;
    const { splits } = req.body || {}; // [{ rank: 1, percentage: 50 }, ...]
    if (!Array.isArray(splits) || !splits.length) return res.status(400).json({ error: 'splits array is required' });
    try {
      const { data: tournament } = await supabase.from('tournaments').select('prize_pool_coins, name').eq('id', id).single();
      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
      const { data: regs } = await supabase.from('tournament_registrations').select('player_id, final_rank').eq('tournament_id', id).not('final_rank', 'is', null);

      const results = [];
      for (const split of splits) {
        const reg = (regs || []).find((rr) => rr.final_rank === split.rank);
        if (!reg) continue;
        const amount = Math.round(tournament.prize_pool_coins * (split.percentage / 100));
        if (amount <= 0) continue;
        const { data: player } = await supabase.from('players').select('coins').eq('id', reg.player_id).single();
        if (!player) continue;
        const newBalance = player.coins + amount;
        await supabase.from('players').update({ coins: newBalance }).eq('id', reg.player_id);
        await supabase.from('coin_transactions').insert({ player_id: reg.player_id, type: 'prize_won', amount, balance_after: newBalance });
        results.push({ playerId: reg.player_id, rank: split.rank, amount });
      }
      await supabase.from('tournaments').update({ status: 'completed' }).eq('id', id);
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'distribute_prizes', targetType: 'tournament', targetId: id, details: { results }, ip: clientIp(req) });
      res.json({ success: true, distributed: results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- sponsors / broker partners --------------------------------------------

  r.get('/sponsors/list', async (req, res) => {
    try {
      const { data, error } = await supabase.from('broker_partners').select('*').order('joined_date', { ascending: false });
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/sponsors', async (req, res) => {
    const { brokerName, logoUrl, referralUrl, tier, monthlyFeeAed } = req.body || {};
    if (!brokerName || !referralUrl) return res.status(400).json({ error: 'brokerName and referralUrl are required' });
    try {
      const { data, error } = await supabase.from('broker_partners').insert({
        broker_name: brokerName, logo_url: logoUrl || null, referral_url: referralUrl, tier: tier || 'featured', monthly_fee_aed: Number(monthlyFeeAed || 0),
      }).select().single();
      if (error) throw error;
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'create_sponsor', targetType: 'broker_partner', targetId: data.id, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/sponsors/:id', async (req, res) => {
    const patch = {};
    ['broker_name', 'logo_url', 'referral_url', 'tier', 'monthly_fee_aed', 'active'].forEach((k) => {
      const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (req.body[camel] !== undefined) patch[k] = req.body[camel];
    });
    try {
      const { data, error } = await supabase.from('broker_partners').update(patch).eq('id', req.params.id).select().single();
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
