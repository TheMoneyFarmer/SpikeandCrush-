'use strict';

// Long-form competitions (Daily / Weekly / Weekend / Monthly). Reads come
// straight from Supabase; anything that moves money or pushes live events
// (settle, void + refund, disqualify, test creation) goes through the game
// server's compEngine via the internal bridge so there's one implementation.
const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const internal = require('../lib/internalGameServer');
const compStates = require('../../server/competitionStates');
const liveFeed = require('../../server/liveFeed');
const { waitlistOpenEmail } = require('../../server/compEmails');
const { sendEmail } = require('../lib/email');

const EDIT_ROLES = ['super_admin', 'admin'];
const COPY_FIELDS = ['title', 'schedule_text', 'rhythm_text', 'length_text', 'format_hook', 'rules_line'];
const PRIZE_FIELDS = ['prize_pool_amount', 'prize_top_amount', 'prize_pool_confirmed', 'prize_currency', 'prize_partner_note'];
const NOTIFY_THROTTLE_MS = 24 * 3600 * 1000;

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


  // ---- competition templates: state, wording, prize, waitlist ---------------------
  const canEdit = (req) => EDIT_ROLES.includes(req.admin.role);
  const isSuper = (req) => req.admin.role === 'super_admin';
  async function liveReady() {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'liveFeed.ready').maybeSingle();
    return data ? data.value === true : false;
  }
  async function waitlistCount(key) {
    const { count, error } = await supabase.from('competition_waitlist').select('id', { count: 'exact', head: true }).eq('template_key', key);
    if (error) throw error;
    return count || 0;
  }

  r.get('/templates', async (req, res) => {
    try {
      const { data, error } = await supabase.from('competition_templates').select('*').order('key');
      if (error) throw error;
      const out = [];
      for (const t of data) {
        const { data: last } = await supabase.from('competition_waitlist_sends').select('created_at, recipients').eq('template_key', t.key).order('created_at', { ascending: false }).limit(1).maybeSingle();
        out.push({ ...t, waitlist: await waitlistCount(t.key), lastNotify: last || null, preview: compStates.prizeWording({ ...t, prize_pool: t.prize_pool_amount }) });
      }
      res.json({ templates: out, liveFeedReady: await liveReady(), liveFeedHealthy: liveFeed.healthy(), canEdit: canEdit(req), isSuper: isSuper(req) });
    } catch (e) {
      fail(res, e);
    }
  });

  r.put('/templates/:key', async (req, res) => {
    if (!canEdit(req)) return res.status(403).json({ error: 'Your role can view templates but not change them' });
    try {
      const { data: t, error } = await supabase.from('competition_templates').select('*').eq('key', req.params.key).maybeSingle();
      if (error) throw error;
      if (!t) return res.status(404).json({ error: 'Template not found' });
      const b = req.body || {};
      const patch = {};
      for (const k of COPY_FIELDS) if (typeof b[k] === 'string') patch[k] = b[k].trim().slice(0, 200);
      for (const [k, v] of Object.entries(patch)) {
        const bad = compStates.cardTextViolations(v);
        if (bad.length) return res.status(400).json({ error: `"${k}" uses wording that is not allowed on cards (${bad.join(', ')})` });
      }
      const touchesPrize = PRIZE_FIELDS.some((k) => k in b);
      if (touchesPrize && !isSuper(req)) return res.status(403).json({ error: 'Only a super admin can set or confirm a prize pool' });
      if ('prize_pool_amount' in b) patch.prize_pool_amount = Math.max(0, Number(b.prize_pool_amount) || 0);
      if ('prize_top_amount' in b) patch.prize_top_amount = Math.max(0, Number(b.prize_top_amount) || 0);
      if ('prize_currency' in b) patch.prize_currency = /^[A-Z]{3}$/.test(b.prize_currency) ? b.prize_currency : 'USD';
      if ('prize_partner_note' in b) patch.prize_partner_note = String(b.prize_partner_note || '').slice(0, 500);
      if ('prize_pool_confirmed' in b) {
        patch.prize_pool_confirmed = b.prize_pool_confirmed === true;
        const note = 'prize_partner_note' in patch ? patch.prize_partner_note : t.prize_partner_note;
        if (patch.prize_pool_confirmed && !String(note || '').trim()) return res.status(400).json({ error: 'Name the paying partner in the admin note before confirming a prize pool' });
      }
      if ('state' in b && b.state !== t.state) {
        if (!String(b.reason || '').trim()) return res.status(400).json({ error: 'Give a reason for changing the state' });
        const gate = compStates.stateChangeGate(t, b.state, { liveOk: (await liveReady()) && liveFeed.healthy() });
        if (!gate.ok) return res.status(400).json({ error: gate.reason });
        patch.state = b.state;
        patch.state_reason = String(b.reason).slice(0, 300);
      }
      compStates.assertSeparation({ ...t, ...patch, prize_pool: 0 });
      if (!Object.keys(patch).length) return res.json({ template: t });
      patch.updated_by = adminName(req);
      patch.updated_at = new Date().toISOString();
      const { data: saved, error: e2 } = await supabase.from('competition_templates').update(patch).eq('key', t.key).select('*').single();
      if (e2) throw e2;
      await logAdminAction({ adminUsername: adminName(req), actionType: 'competition_template_update', targetType: 'competition_template', targetId: t.key, details: { patch, reason: b.reason || null }, ip: clientIp(req) });
      res.json({ template: saved });
    } catch (e) {
      fail(res, e);
    }
  });

  // One scheduled run's state (with the same live-feed guard).
  r.put('/:id/state', async (req, res) => {
    if (!canEdit(req)) return res.status(403).json({ error: 'Your role can view competitions but not change them' });
    try {
      const { data: c, error } = await supabase.from('competitions').select('id, state, data_source, prize_kind, entry_fee_coins, prize_pool_coins').eq('id', req.params.id).maybeSingle();
      if (error) throw error;
      if (!c) return res.status(404).json({ error: 'Competition not found' });
      const next = req.body?.state;
      if (!String(req.body?.reason || '').trim()) return res.status(400).json({ error: 'Give a reason for changing the state' });
      const gate = compStates.stateChangeGate(c, next, { liveOk: (await liveReady()) && liveFeed.healthy() });
      if (!gate.ok) return res.status(400).json({ error: gate.reason });
      const { data: saved, error: e2 } = await supabase.from('competitions').update({ state: next }).eq('id', c.id).select('id, state').single();
      if (e2) throw e2;
      await logAdminAction({ adminUsername: adminName(req), actionType: 'competition_state', targetType: 'competition', targetId: c.id, details: { from: c.state, to: next, reason: req.body.reason }, ip: clientIp(req) });
      res.json({ competition: saved });
    } catch (e) {
      fail(res, e);
    }
  });

  // Counts only: no names, emails or ids.
  r.get('/templates/waitlist.csv', async (req, res) => {
    try {
      const { data, error } = await supabase.from('competition_templates').select('key, title').order('key');
      if (error) throw error;
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const lines = ['competition,players_waiting,joined_last_7_days,already_notified'];
      for (const t of data) {
        const total = await waitlistCount(t.key);
        const { count: recent } = await supabase.from('competition_waitlist').select('id', { count: 'exact', head: true }).eq('template_key', t.key).gte('created_at', weekAgo);
        const { count: notified } = await supabase.from('competition_waitlist').select('id', { count: 'exact', head: true }).eq('template_key', t.key).not('notified_at', 'is', null);
        lines.push([`"${t.title.replace(/"/g, '""')}"`, total, recent || 0, notified || 0].join(','));
      }
      res.type('text/csv').set('Content-Disposition', 'attachment; filename="waitlist-counts.csv"').send(lines.join('\n'));
    } catch (e) {
      fail(res, e);
    }
  });

  // Tell the waitlist once. 24-hour throttle per template, and a per-player
  // idempotency key so a double click or a retry can never send twice.
  r.post('/templates/:key/notify', async (req, res) => {
    if (!canEdit(req)) return res.status(403).json({ error: 'Your role cannot send waitlist emails' });
    try {
      const { data: t, error } = await supabase.from('competition_templates').select('*').eq('key', req.params.key).maybeSingle();
      if (error) throw error;
      if (!t) return res.status(404).json({ error: 'Template not found' });
      const { data: last } = await supabase.from('competition_waitlist_sends').select('created_at').eq('template_key', t.key).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (last && Date.now() - new Date(last.created_at).getTime() < NOTIFY_THROTTLE_MS) {
        return res.status(429).json({ error: 'This waitlist was emailed in the last 24 hours. Try again later.' });
      }
      // claim the send first, so a second click in the same instant sees it
      await supabase.from('competition_waitlist_sends').insert({ template_key: t.key, sent_by: adminName(req), recipients: 0 });
      const { data: rows, error: e2 } = await supabase
        .from('competition_waitlist')
        .select('id, user_id, player:players!competition_waitlist_user_id_fkey(email, username)')
        .eq('template_key', t.key)
        .is('notified_at', null)
        .limit(5000);
      if (e2) throw e2;
      const site = String(process.env.SITE_URL || 'https://www.spikeandcrush.com').replace(/\/$/, '');
      const sendDay = new Date().toISOString().slice(0, 10);
      let sent = 0;
      for (const row of rows) {
        if (!row.player || !row.player.email) continue;
        const { error: e3 } = await supabase.from('competition_waitlist').update({ notified_at: new Date().toISOString() }).eq('id', row.id).is('notified_at', null);
        if (e3) continue;
        await sendEmail({ to: row.player.email, idempotencyKey: `waitlist-open:${t.key}:${row.user_id}:${sendDay}`, ...waitlistOpenEmail({ username: row.player.username, title: t.title, hook: t.format_hook, link: `${site}/competitions/${t.key}` }) });
        sent += 1;
      }
      await supabase.from('competition_waitlist_sends').update({ recipients: sent }).eq('template_key', t.key).eq('sent_by', adminName(req)).eq('recipients', 0);
      await logAdminAction({ adminUsername: adminName(req), actionType: 'waitlist_notify', targetType: 'competition_template', targetId: t.key, details: { recipients: sent }, ip: clientIp(req) });
      res.json({ sent });
    } catch (e) {
      fail(res, e);
    }
  });

  // liveFeed.ready: set by the live feed deployment; super admin only.
  r.put('/settings/live-feed', async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Only a super admin can change this' });
    try {
      const value = req.body?.ready === true;
      const { error } = await supabase.from('app_settings').upsert({ key: 'liveFeed.ready', value, updated_at: new Date().toISOString() });
      if (error) throw error;
      liveFeed.resetCache();
      await logAdminAction({ adminUsername: adminName(req), actionType: 'live_feed_ready', targetType: 'setting', targetId: 'liveFeed.ready', details: { value }, ip: clientIp(req) });
      res.json({ ready: value });
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
