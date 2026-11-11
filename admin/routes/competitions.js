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

  // The email_footer sponsor for a competition's emails: a live placement
  // targeted at this competition (or all), unless sponsors are switched off.
  async function emailFooterSponsor(key) {
    try {
      const { data: on } = await supabase.from('app_settings').select('value').eq('key', 'sponsors.enabled').maybeSingle();
      if (on && on.value === false) return null;
      const now = Date.now();
      const { data } = await supabase.from('sponsor_placements').select('targets, starts_at, ends_at, weight, sponsors(name, status)').eq('slot', 'email_footer').eq('status', 'active');
      const live = (data || []).filter((p) => p.sponsors && p.sponsors.status === 'active' && (!p.starts_at || Date.parse(p.starts_at) <= now) && (!p.ends_at || Date.parse(p.ends_at) > now));
      const list = (t) => String(t || 'all').split(',').map((x) => x.trim());
      const pick = live.find((p) => list(p.targets).includes(`competition:${key}`)) || live.find((p) => list(p.targets).includes('all'));
      return pick ? pick.sponsors.name : null;
    } catch (e) {
      return null;
    }
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
      const { data: th } = await supabase.from('app_settings').select('value').eq('key', 'waitlist.showCountFrom').maybeSingle();
      res.json({ templates: out, liveFeedReady: await liveReady(), liveFeedHealthy: liveFeed.healthy(), waitlistShowCountFrom: th && Number.isFinite(Number(th.value)) ? Number(th.value) : 50, canEdit: canEdit(req), isSuper: isSuper(req) });
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
      const sponsorName = await emailFooterSponsor(t.key);
      let sent = 0;
      let failed = 0;
      let skipped = 0; // no email provider configured (local runs)
      for (const row of rows) {
        if (!row.player || !row.player.email) continue;
        const { error: e3 } = await supabase.from('competition_waitlist').update({ notified_at: new Date().toISOString() }).eq('id', row.id).is('notified_at', null);
        if (e3) continue;
        const out = await sendEmail({ to: row.player.email, idempotencyKey: `waitlist-open:${t.key}:${row.user_id}:${sendDay}`, ...waitlistOpenEmail({ username: row.player.username, title: t.title, hook: t.format_hook, link: `${site}/competitions/${t.key}`, sponsorName }) });
        if (out && out.error) {
          // not delivered: clear the mark so the next notify tries this player again
          failed += 1;
          await supabase.from('competition_waitlist').update({ notified_at: null }).eq('id', row.id);
          continue;
        }
        if (out && out.skipped) skipped += 1;
        else sent += 1;
      }
      await supabase.from('competition_waitlist_sends').update({ recipients: sent }).eq('template_key', t.key).eq('sent_by', adminName(req)).eq('recipients', 0);
      await logAdminAction({ adminUsername: adminName(req), actionType: 'waitlist_notify', targetType: 'competition_template', targetId: t.key, details: { recipients: sent, failed, skipped }, ip: clientIp(req) });
      res.json({ sent, failed, skipped });
    } catch (e) {
      fail(res, e);
    }
  });

  // How many players must be waiting before a card shows the number.
  r.put('/settings/waitlist-threshold', async (req, res) => {
    if (!canEdit(req)) return res.status(403).json({ error: 'Your role cannot change this' });
    const n = Math.trunc(Number(req.body?.value));
    if (!(n >= 1 && n <= 100000)) return res.status(400).json({ error: 'Choose a number from 1 to 100000' });
    try {
      const { error } = await supabase.from('app_settings').upsert({ key: 'waitlist.showCountFrom', value: n, updated_at: new Date().toISOString() });
      if (error) throw error;
      await logAdminAction({ adminUsername: adminName(req), actionType: 'waitlist_threshold', targetType: 'setting', targetId: 'waitlist.showCountFrom', details: { value: n }, ip: clientIp(req) });
      res.json({ value: n });
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


  // ---- partner competitions -------------------------------------------------------
  // Hosted and paid by a sponsor on their own site. We list it, link out through
  // /go/ (counted, UTM-tagged) and never take entries, money or payouts here.
  const isHttps = (u) => { try { return new URL(u).protocol === 'https:'; } catch (e) { return false; } };
  function partnerFields(b = {}) {
    const title = String(b.title || '').trim().slice(0, 120);
    if (!title) return { error: 'Title is required' };
    if (!/^[0-9a-f-]{36}$/i.test(String(b.sponsorId || ''))) return { error: 'Pick the hosting sponsor' };
    if (!isHttps(String(b.externalUrl || ''))) return { error: "The sponsor's competition link must start with https://" };
    if (!b.startsAt || !b.endsAt || Number.isNaN(Date.parse(b.startsAt)) || Number.isNaN(Date.parse(b.endsAt))) return { error: 'Start and end dates are required' };
    if (Date.parse(b.endsAt) <= Date.parse(b.startsAt)) return { error: 'End must be after start' };
    const prizeText = String(b.prizeText || '').trim().slice(0, 140);
    const rules = String(b.rulesSummary || '').trim().slice(0, 400);
    for (const [k, v] of [['Title', title], ['Prize text', prizeText], ['Rules summary', rules]]) {
      const bad = compStates.cardTextViolations(v);
      if (bad.length) return { error: `${k} uses wording that is not allowed on cards (${bad.join(', ')})` };
    }
    return {
      fields: {
        title, type: 'external', prize_kind: 'partner', state: 'open', data_source: 'live',
        entry_fee_coins: 0, prize_pool: 0, prize_top_amount: 0, prize_text: prizeText || null, rules_summary: rules || null,
        external_url: String(b.externalUrl).trim(), starts_at: new Date(b.startsAt).toISOString(), ends_at: new Date(b.endsAt).toISOString(),
        sponsor_id: b.sponsorId, is_published: b.published !== false, description: rules || null,
      },
    };
  }

  r.get('/partner', async (req, res) => {
    try {
      const { data, error } = await supabase.from('competitions').select('id, title, starts_at, ends_at, external_url, prize_text, rules_summary, sponsor_id, is_published, click_count, sponsors(name)').eq('prize_kind', 'partner').order('starts_at', { ascending: false }).limit(200);
      if (error) throw error;
      const { data: sponsors } = await supabase.from('sponsors').select('id, name, status').order('name');
      res.json({ competitions: data || [], sponsors: sponsors || [], canEdit: canEdit(req) });
    } catch (e) {
      fail(res, e);
    }
  });

  async function syncPartnerPlacement(comp, req) {
    const target = `partner:${comp.id}`;
    const row = { sponsor_id: comp.sponsor_id, slot: 'competition_card', placement: 'competition', targets: target, weight: 1, status: comp.is_published ? 'active' : 'paused', active: !!comp.is_published, creative: 'logo_tagline_cta', cta_text: null, cta_url: comp.external_url, starts_at: comp.starts_at, ends_at: comp.ends_at, updated_at: new Date().toISOString() };
    const { data: existing } = await supabase.from('sponsor_placements').select('id').eq('slot', 'competition_card').eq('targets', target).maybeSingle();
    if (existing) {
      const { error } = await supabase.from('sponsor_placements').update(row).eq('id', existing.id);
      if (error) throw error;
      return existing.id;
    }
    const { data, error } = await supabase.from('sponsor_placements').insert({ ...row, created_by: adminName(req) }).select('id').single();
    if (error) throw error;
    return data.id;
  }

  r.post('/partner', async (req, res) => {
    if (!canEdit(req)) return res.status(403).json({ error: 'Your role cannot create competitions' });
    const { fields, error: invalid } = partnerFields(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    try {
      compStates.assertSeparation(fields);
      const { data: comp, error } = await supabase.from('competitions').insert(fields).select('*').single();
      if (error) throw error;
      const placementId = await syncPartnerPlacement(comp, req);
      await logAdminAction({ adminUsername: adminName(req), actionType: 'partner_competition_create', targetType: 'competition', targetId: comp.id, details: { title: comp.title, sponsor_id: comp.sponsor_id, placementId }, ip: clientIp(req) });
      res.json({ competition: comp, placementId });
    } catch (e) {
      fail(res, e);
    }
  });

  r.put('/partner/:id', async (req, res) => {
    if (!canEdit(req)) return res.status(403).json({ error: 'Your role cannot change competitions' });
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'Competition not found' });
    const { fields, error: invalid } = partnerFields(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    try {
      compStates.assertSeparation(fields);
      const { data: comp, error } = await supabase.from('competitions').update(fields).eq('id', req.params.id).eq('prize_kind', 'partner').select('*').maybeSingle();
      if (error) throw error;
      if (!comp) return res.status(404).json({ error: 'Partner competition not found' });
      const placementId = await syncPartnerPlacement(comp, req);
      await logAdminAction({ adminUsername: adminName(req), actionType: 'partner_competition_update', targetType: 'competition', targetId: comp.id, details: { title: comp.title, published: comp.is_published }, ip: clientIp(req) });
      res.json({ competition: comp, placementId });
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
