'use strict';

// Broker/prop-firm affiliate tracking: referral_partners/clicks/conversions/
// payouts. Deliberately separate from the pre-existing broker_partners table
// (sponsor display cards on the player hub, managed under Tournaments >
// Sponsors) - this is click/conversion attribution with its own admin
// workflow, not a display widget.
const express = require('express');
const crypto = require('crypto');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { requireSuperAdmin, logAdminAction, clientIp } = require('../lib/auth');

function router() {
  const r = express.Router();

  // ---- partner list -------------------------------------------------------------

  r.get('/', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const { data: partners, error } = await supabase.from('referral_partners').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      const ids = partners.map((p) => p.id);
      const [{ data: clicks }, { data: conversions }] = ids.length
        ? await Promise.all([
            supabase.from('referral_clicks').select('partner_id').in('partner_id', ids),
            supabase.from('referral_conversions').select('partner_id, status, reward_coins').in('partner_id', ids),
          ])
        : [{ data: [] }, { data: [] }];

      const clicksByPartner = {};
      (clicks || []).forEach((c) => { clicksByPartner[c.partner_id] = (clicksByPartner[c.partner_id] || 0) + 1; });
      const convByPartner = {};
      (conversions || []).forEach((c) => {
        convByPartner[c.partner_id] = convByPartner[c.partner_id] || { total: 0, approved: 0 };
        convByPartner[c.partner_id].total++;
        if (c.status === 'approved' || c.status === 'paid') convByPartner[c.partner_id].approved++;
      });

      res.json(partners.map((p) => ({
        ...p,
        totalClicks: clicksByPartner[p.id] || 0,
        totalConversions: convByPartner[p.id]?.total || 0,
        approvedConversions: convByPartner[p.id]?.approved || 0,
      })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/', requireSuperAdmin, async (req, res) => {
    const { name, email, commissionPct, notes } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
      let referralCode;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = `${name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase() || 'PARTNER'}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        const { data: existing } = await supabase.from('referral_partners').select('id').eq('referral_code', candidate).maybeSingle();
        if (!existing) { referralCode = candidate; break; }
      }
      if (!referralCode) return res.status(500).json({ error: 'Could not generate a unique referral code, try again' });

      const { data, error } = await supabase
        .from('referral_partners')
        .insert({ name, email: email || null, referral_code: referralCode, commission_pct: Number(commissionPct) || 20, notes: notes || null })
        .select()
        .single();
      if (error) throw error;
      await logAdminAction({ adminUsername: req.admin.email || req.admin.username, actionType: 'create_referral_partner', targetType: 'referral_partner', targetId: data.id, details: { name, referralCode }, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.put('/:id', requireSuperAdmin, async (req, res) => {
    const patch = {};
    ['name', 'email', 'commission_pct', 'status', 'notes'].forEach((k) => {
      const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (req.body[camel] !== undefined) patch[k] = req.body[camel];
    });
    try {
      const { data, error } = await supabase.from('referral_partners').update(patch).eq('id', req.params.id).select().single();
      if (error) throw error;
      await logAdminAction({ adminUsername: req.admin.email || req.admin.username, actionType: 'update_referral_partner', targetType: 'referral_partner', targetId: req.params.id, details: patch, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- conversions ----------------------------------------------------------------

  r.get('/conversions', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      let query = supabase
        .from('referral_conversions')
        .select('*, partner:referral_partners(name, referral_code), player:players(username)')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (req.query.status) query = query.eq('status', req.query.status);
      const { data, error } = await query;
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/conversions/:id/approve', requireSuperAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('referral_conversions').update({ status: 'approved' }).eq('id', req.params.id).select().single();
      if (error) throw error;
      await logAdminAction({ adminUsername: req.admin.email || req.admin.username, actionType: 'approve_referral_conversion', targetType: 'referral_conversion', targetId: req.params.id, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/conversions/:id/reject', requireSuperAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('referral_conversions').update({ status: 'rejected' }).eq('id', req.params.id).select().single();
      if (error) throw error;
      await logAdminAction({ adminUsername: req.admin.email || req.admin.username, actionType: 'reject_referral_conversion', targetType: 'referral_conversion', targetId: req.params.id, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- analytics --------------------------------------------------------------

  r.get('/:id/analytics', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - 30);
      const [{ data: clicks }, { data: conversions }] = await Promise.all([
        supabase.from('referral_clicks').select('created_at').eq('partner_id', req.params.id).gte('created_at', since.toISOString()),
        supabase.from('referral_conversions').select('created_at, status').eq('partner_id', req.params.id).gte('created_at', since.toISOString()),
      ]);
      const byDay = {};
      (clicks || []).forEach((c) => { const d = c.created_at.slice(0, 10); byDay[d] = byDay[d] || { date: d, clicks: 0, conversions: 0 }; byDay[d].clicks++; });
      (conversions || []).forEach((c) => { const d = c.created_at.slice(0, 10); byDay[d] = byDay[d] || { date: d, clicks: 0, conversions: 0 }; byDay[d].conversions++; });
      res.json({
        totalClicks30d: (clicks || []).length,
        totalConversions30d: (conversions || []).length,
        conversionRatePct: (clicks || []).length ? Math.round(((conversions || []).length / clicks.length) * 1000) / 10 : 0,
        daily: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- payouts ------------------------------------------------------------------

  r.get('/payouts', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const { data, error } = await supabase.from('referral_payouts').select('*, partner:referral_partners(name, referral_code)').order('created_at', { ascending: false });
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/payouts', requireSuperAdmin, async (req, res) => {
    const { partnerId, amountUsd, notes } = req.body || {};
    if (!partnerId || !amountUsd) return res.status(400).json({ error: 'partnerId and amountUsd are required' });
    try {
      const { data, error } = await supabase.from('referral_payouts').insert({ partner_id: partnerId, amount_usd: Number(amountUsd), notes: notes || null }).select().single();
      if (error) throw error;
      await logAdminAction({ adminUsername: req.admin.email || req.admin.username, actionType: 'create_referral_payout', targetType: 'referral_payout', targetId: data.id, details: { partnerId, amountUsd }, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/payouts/:id/mark-paid', requireSuperAdmin, async (req, res) => {
    const { txReference } = req.body || {};
    try {
      const { data, error } = await supabase
        .from('referral_payouts')
        .update({ status: 'paid', tx_reference: txReference || null, paid_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) throw error;
      await logAdminAction({ adminUsername: req.admin.email || req.admin.username, actionType: 'mark_referral_payout_paid', targetType: 'referral_payout', targetId: req.params.id, details: { txReference }, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
