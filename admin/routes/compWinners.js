'use strict';

// Admin: competition winners and sponsoring partners (server/compRewards.js).
// Behind requireAdmin; support agents blocked by the support guard. Every
// action is audit logged. Winner personal data never goes to sponsor reports.

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const { sendEmail } = require('../lib/email');
const secrets = require('../../server/listingSecrets');
const calendar = require('../../server/marketCalendar');
const { createCompRewards, STATUSES, ADMIN_SETTABLE } = require('../../server/compRewards');

const UUID_RE = /^[0-9a-f-]{36}$/i;
const COUNTRY_RE = /^[A-Z]{2}$/;

function router() {
  const r = express.Router();
  const who = (req) => req.admin.email || req.admin.username;
  const audit = (req, action, id, details) => logAdminAction({ adminUsername: req.admin.username, actionType: action, targetType: 'comp_winner', targetId: id, details, ip: clientIp(req) });
  const rewards = createCompRewards({ client: () => supabase, sendEmail });
  const superOnly = (req, res, next) => (req.admin.role === 'super_admin' ? next() : res.status(403).json({ error: 'Super admin only' }));

  r.use((req, res, next) => (isConfigured ? next() : res.status(503).json({ error: 'Supabase not configured' })));

  // ---- winners ---------------------------------------------------------------------

  r.get('/winners', async (req, res) => {
    try {
      let q = supabase.from('comp_winners').select('id, created_at, competition_id, player_id, rank, prize_text, prize_amount, prize_currency, partner_id, status, flags, email_sent_at, consent_at, country, prize_requested_at, data_deleted_at, competition:competitions(title, ends_at), player:players(username), partner:comp_partners(name, partner_type)');
      if (req.query.status && STATUSES.includes(req.query.status)) q = q.eq('status', req.query.status);
      if (req.query.queue === 'manual') q = q.eq('status', 'manual_payout');
      if (UUID_RE.test(req.query.competition || '')) q = q.eq('competition_id', req.query.competition);
      if (UUID_RE.test(req.query.partner || '')) q = q.eq('partner_id', req.query.partner);
      const { data, error } = await q.order('created_at', { ascending: false }).order('rank').limit(500);
      if (error) throw error;
      res.json({ winners: data, statuses: STATUSES, settable: ADMIN_SETTABLE });
    } catch (e) {
      res.status(500).json({ error: /comp_winners/.test(e.message) ? 'Run the competition_rewards migration first' : e.message });
    }
  });

  r.get('/winners/export.csv', async (req, res) => {
    const { data, error } = await supabase.from('comp_winners').select('created_at, rank, prize_text, status, country, consent_at, prize_requested_at, competition:competitions(title), player:players(username), partner:comp_partners(name)').order('created_at', { ascending: false }).limit(20000);
    if (error) return res.status(500).json({ error: error.message });
    const cell = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const rows = data.map((w) => [w.created_at, w.competition && w.competition.title, w.rank, w.player && w.player.username, w.prize_text, w.partner && w.partner.name, w.status, w.country, w.consent_at, w.prize_requested_at].map(cell).join(','));
    await audit(req, 'winners_export', null, { rows: data.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="winners-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(['created_at,competition,rank,player,prize,partner,status,country,consent_at,prize_requested_at', ...rows].join('\n'));
  });

  r.get('/winners/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Winner not found' });
    const [{ data: w }, { data: events }] = await Promise.all([
      supabase.from('comp_winners').select('*, competition:competitions(title), player:players(username, email), partner:comp_partners(name, partner_type)').eq('id', req.params.id).maybeSingle(),
      supabase.from('comp_winner_events').select('*').eq('winner_id', req.params.id).order('created_at'),
    ]);
    if (!w) return res.status(404).json({ error: 'Winner not found' });
    delete w.claim_token_hash;
    w.account_number = w.account_number_enc ? secrets.mask(secrets.decrypt(w.account_number_enc) || '') : null;
    delete w.account_number_enc;
    res.json({ winner: w, events: events || [] });
  });

  r.post('/winners/approve', async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => UUID_RE.test(x)).slice(0, 100);
    if (!ids.length) return res.status(400).json({ error: 'Choose winners to approve' });
    try {
      const out = await rewards.approve(ids, who(req));
      await audit(req, 'winners_approve', null, { ids, results: out.map((o) => ({ id: o.id, ok: o.ok, emailed: o.emailed })) });
      res.json({ results: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/winners/:id/status', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Winner not found' });
    try {
      await rewards.setStatus(req.params.id, req.body?.status, who(req), { accountNumber: req.body?.accountNumber });
      await audit(req, 'winner_status', req.params.id, { status: req.body?.status, accountNumber: req.body?.accountNumber ? 'set' : undefined });
      res.json({ success: true });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  r.post('/winners/:id/prize-request', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Winner not found' });
    try {
      const out = await rewards.prizeRequest(req.params.id, req.body?.channel === 'whatsapp' ? 'whatsapp' : 'email', who(req));
      await audit(req, 'winner_prize_request', req.params.id, { channel: out.channel });
      res.json(out);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  r.post('/winners/:id/delete-claim-data', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Winner not found' });
    await rewards.deleteClaimData(req.params.id, who(req));
    await audit(req, 'winner_claim_data_deleted', req.params.id, {});
    res.json({ success: true });
  });

  // ---- partners (who pays the prize) --------------------------------------------------

  const publicPartner = (p) => {
    const contact = p.contact_enc ? JSON.parse(secrets.decrypt(p.contact_enc) || '{}') : {};
    const { contact_enc, ...rest } = p;
    return { ...rest, contact: { email: contact.email ? secrets.mask(contact.email) : null, whatsapp: contact.whatsapp ? secrets.mask(contact.whatsapp) : null, notes: contact.notes ? 'saved' : null } };
  };

  r.get('/partners', async (req, res) => {
    const { data, error } = await supabase.from('comp_partners').select('*').order('name');
    if (error) return res.status(500).json({ error: /comp_partners/.test(error.message) ? 'Run the competition_rewards migration first' : error.message });
    res.json({ partners: data.map(publicPartner), canReveal: req.admin.role === 'super_admin' });
  });

  r.get('/partners/:id/contact', superOnly, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Partner not found' });
    const { data } = await supabase.from('comp_partners').select('contact_enc').eq('id', req.params.id).maybeSingle();
    await audit(req, 'partner_contact_reveal', req.params.id, {});
    res.json({ contact: data && data.contact_enc ? JSON.parse(secrets.decrypt(data.contact_enc) || '{}') : {} });
  });

  function partnerFields(b, { partial }) {
    const f = {};
    if (!partial || b.name !== undefined) {
      const n = String(b.name || '').trim().slice(0, 120);
      if (!n) return { error: 'Name the partner' };
      f.name = n;
    }
    if (!partial || b.partnerType !== undefined) {
      if (!['broker', 'prop_firm'].includes(b.partnerType)) return { error: 'Type must be broker or prop firm' };
      f.partner_type = b.partnerType;
    }
    if (b.listingId !== undefined) f.listing_id = UUID_RE.test(b.listingId || '') ? b.listingId : null;
    for (const [k, col] of [['allowedCountries', 'allowed_countries'], ['restrictedCountries', 'restricted_countries']]) {
      if (b[k] !== undefined) {
        const list = (Array.isArray(b[k]) ? b[k] : String(b[k]).split(',')).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
        if (list.some((x) => !COUNTRY_RE.test(x))) return { error: 'Countries must be two-letter codes, e.g. AE, GB' };
        f[col] = list;
      }
    }
    if (b.claimSteps !== undefined) f.claim_steps = String(b.claimSteps || '').slice(0, 1000) || null;
    if (b.nameInTerms !== undefined) f.name_in_terms = b.nameInTerms === true;
    if (b.reminderDays !== undefined) f.reminder_days = Math.max(1, Math.min(60, Number(b.reminderDays) || 5));
    if (b.contact !== undefined && b.contact) {
      const c = { email: String(b.contact.email || '').trim().slice(0, 200) || null, whatsapp: String(b.contact.whatsapp || '').trim().slice(0, 40) || null, notes: String(b.contact.notes || '').slice(0, 1000) || null };
      if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) return { error: 'Check the IB manager email' };
      if (c.whatsapp && !/^[+0-9 ()-]{6,40}$/.test(c.whatsapp)) return { error: 'Check the WhatsApp number' };
      f.contact_enc = secrets.encrypt(JSON.stringify(c));
    }
    f.updated_at = new Date().toISOString();
    return { f };
  }

  r.post('/partners', async (req, res) => {
    const { f, error } = partnerFields(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    const { data, error: e2 } = await supabase.from('comp_partners').insert(f).select('*').single();
    if (e2) return res.status(500).json({ error: e2.message });
    await audit(req, 'partner_create', data.id, { name: data.name, type: data.partner_type });
    res.json({ partner: publicPartner(data) });
  });

  r.put('/partners/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Partner not found' });
    const { f, error } = partnerFields(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    const { data, error: e2 } = await supabase.from('comp_partners').update(f).eq('id', req.params.id).select('*').single();
    if (e2) return res.status(500).json({ error: e2.message });
    await audit(req, 'partner_update', data.id, { fields: Object.keys(f).filter((k) => k !== 'contact_enc'), contactChanged: Boolean(f.contact_enc) });
    res.json({ partner: publicPartner(data) });
  });

  // ---- pool preview from the market calendar --------------------------------------------

  r.get('/pool-preview', async (req, res) => {
    const start = Date.parse(req.query.start);
    const end = Date.parse(req.query.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return res.status(400).json({ error: 'Give a start and an end' });
    const registry = require('../../server/instruments').INSTRUMENTS;
    const pool = calendar.poolFor(start, end, registry);
    const { liveMarket } = require('../../server/liveMarket');
    // open markets, and of those the ones the live feed actually serves today
    res.json({ ...pool, liveSymbols: pool.symbols.filter((s) => liveMarket().supports(s)), dataSource: require('../../server/marketDataSource').label('live') });
  });

  return r;
}

module.exports = router;
