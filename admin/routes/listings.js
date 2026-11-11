'use strict';

// Admin: partner listings on the competitions page (prop firms, brokers,
// sponsored), listing tiers, the seed, encrypted outbound links and codes.
// super_admin and admin edit; moderator and support read. Every change is
// audit-logged. Codes are shown masked; only a super admin can reveal them.

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const { MAX_LOGO_BYTES, validateLogo } = require('../lib/logoValidation');
const compStates = require('../../server/competitionStates');
const liveFeed = require('../../server/liveFeed');
const secrets = require('../../server/listingSecrets');
const { seedListings } = require('../../server/listings');
const { waitlistOpenEmail } = require('../../server/compEmails');
const { sendEmail } = require('../lib/email');

const TYPES = { prop: 'external', broker: 'broker', sponsored: 'sponsored' };
const TYPE_KEY = { external: 'prop', broker: 'broker', sponsored: 'sponsored' };
const STATES = ['draft', 'coming_soon', 'running', 'closed'];
const TIERS = ['featured', 'plus', 'standard'];
const PIN_TABS = ['all', 'prop', 'broker', 'sponsored'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGO_BUCKET = 'sponsor-logos';
const SEED_FILE = path.join(__dirname, '..', '..', 'data', 'seed', 'competition-listings.json');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_BYTES, files: 1 } });

const canEdit = (req) => ['super_admin', 'admin'].includes(req.admin.role);
const isSuper = (req) => req.admin.role === 'super_admin';
const who = (req) => req.admin.email || req.admin.username;
const slugify = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const list = (v, max = 8) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, max).map((x) => x.slice(0, 40));
const dateOrNull = (v) => (v ? (Number.isNaN(Date.parse(v)) ? undefined : new Date(v).toISOString()) : null);

async function audit(req, actionType, targetId, details) {
  await logAdminAction({ adminUsername: who(req), actionType, targetType: 'competition_listing', targetId, details, ip: clientIp(req) });
}
function requireEditor(req, res, next) {
  if (!canEdit(req)) return res.status(403).json({ error: 'Your role can view listings but not change them' });
  next();
}

// Shared parsing for create and update. Returns { row, org } or { error }.
function parseListing(b, { partial, current = {} }) {
  const row = {};
  const org = {};
  if (!partial || b.type !== undefined) {
    if (!TYPES[b.type]) return { error: 'Type must be prop, broker or sponsored' };
    row.type = TYPES[b.type];
  }
  if (!partial || b.title !== undefined) {
    const title = String(b.title || '').trim().slice(0, 120);
    if (!title) return { error: 'Give the competition a name' };
    row.title = title;
  }
  if (b.slug !== undefined || !partial) {
    const s = slugify(b.slug || `${b.organizerName || current.organizerName || ''} ${b.title || current.title || ''}`);
    if (s.length < 3) return { error: 'The address (slug) needs at least 3 letters' };
    row.slug = s;
  }
  if (b.organizerName !== undefined) { const n = String(b.organizerName).trim().slice(0, 120); if (!n) return { error: 'Name the partner' }; org.name = n; }
  if (b.country !== undefined) { const c = String(b.country || '').trim().toUpperCase(); if (c && !/^[A-Z]{2}$/.test(c)) return { error: 'Country is a two-letter code, like GB' }; org.country_code = c || null; }
  if (b.years !== undefined) { const y = b.years === '' || b.years === null ? null : Math.trunc(Number(b.years)); if (y !== null && !(y >= 0 && y <= 200)) return { error: 'Years in operation must be 0 to 200' }; org.years_operating = y; }
  if (b.rating !== undefined) { const r = b.rating === '' || b.rating === null ? null : Number(b.rating); if (r !== null && !(r >= 0 && r <= 5)) return { error: 'Rating must be 0 to 5' }; org.rating = r; }
  if (b.prizeKind !== undefined || !partial) {
    if (!['money', 'goods'].includes(b.prizeKind)) return { error: 'A listing prize is money or goods, never coins' };
    row.prize_kind = b.prizeKind;
  }
  const kind = row.prize_kind || current.prize_kind;
  if (b.prizeAmount !== undefined) {
    const n = Math.round(Number(b.prizeAmount));
    if (kind === 'money' && !(n > 0)) return { error: 'Enter the prize amount' };
    row.prize_pool = kind === 'money' ? n : 0;
  }
  if (b.prizeCurrency !== undefined) { const c = String(b.prizeCurrency || 'USD').toUpperCase(); if (!/^[A-Z]{3}$/.test(c)) return { error: 'Currency is a three-letter code, like USD' }; row.prize_currency = c; }
  if (b.prizeText !== undefined) row.prize_text = String(b.prizeText || '').trim().slice(0, 140) || null;
  if (b.summary !== undefined) row.rules_summary = String(b.summary || '').trim().slice(0, 400) || null;
  const lj = { ...(current.listing || {}) };
  let touched = false;
  for (const [k, max] of [['kind', 60], ['accountType', 60], ['leverage', 40], ['howToWin', 140]]) if (b[k] !== undefined) { lj[k] = String(b[k] || '').trim().slice(0, max) || null; touched = true; }
  for (const k of ['rules', 'assets', 'platforms', 'instruments']) if (b[k] !== undefined) { lj[k] = list(b[k]); touched = true; }
  if (b.summary !== undefined) { lj.summary = row.rules_summary; touched = true; }
  if (touched || !partial) row.listing = lj;
  for (const [key, col] of [['startsAt', 'starts_at'], ['endsAt', 'ends_at'], ['tierStartsAt', 'tier_starts_at'], ['tierEndsAt', 'tier_ends_at'], ['pinStartsAt', 'pin_starts_at'], ['pinEndsAt', 'pin_ends_at']]) {
    if (b[key] === undefined) continue;
    const d = dateOrNull(b[key]);
    if (d === undefined) return { error: `${key} is not a valid date` };
    row[col] = d;
  }
  if (!partial && (!row.starts_at || !row.ends_at)) return { error: 'Set the start and end dates' };
  const s = row.starts_at || current.starts_at;
  const e = row.ends_at || current.ends_at;
  if (s && e && Date.parse(e) <= Date.parse(s)) return { error: 'The end must be after the start' };
  if (b.tier !== undefined) { if (!TIERS.includes(b.tier)) return { error: 'Tier must be featured, plus or standard' }; row.tier = b.tier; }
  if (b.pinTab !== undefined) { if (b.pinTab && !PIN_TABS.includes(b.pinTab)) return { error: 'Pin to all, prop, broker or sponsored' }; row.pin_tab = b.pinTab || null; }
  if (b.preview !== undefined) row.is_preview = b.preview === true;
  for (const [k, v] of Object.entries({ title: row.title, prize: row.prize_text, summary: row.rules_summary, howToWin: lj.howToWin })) {
    const bad = compStates.cardTextViolations(v);
    if (bad.length) return { error: `${k} uses wording that is not allowed (${bad.join(', ')})` };
  }
  return { row, org };
}

function router() {
  const r = express.Router();
  r.use((req, res, next) => (isConfigured ? next() : res.status(503).json({ error: 'Supabase not configured' })));

  async function waitCounts() {
    const { data } = await supabase.from('competition_waitlist').select('competition_id').not('competition_id', 'is', null).limit(100000);
    const m = {};
    (data || []).forEach((w) => { m[w.competition_id] = (m[w.competition_id] || 0) + 1; });
    return m;
  }

  r.get('/', async (req, res) => {
    try {
      let q = supabase.from('competitions')
        .select('id, slug, type, title, state, is_published, is_preview, tier, tier_starts_at, tier_ends_at, listed_at, pin_tab, pin_starts_at, pin_ends_at, prize_kind, prize_pool, prize_currency, prize_text, rules_summary, listing, starts_at, ends_at, outbound_clicks, seed_key, organizer:organizers(id, name, logo_url, logo_dark_url, country_code, years_operating, rating), secret:competition_listing_secrets(outbound_enc, ref_param, ref_code_enc, ib_param, ib_code_enc, discount_param, discount_code_enc, updated_at)')
        .in('type', Object.values(TYPES))
        .order('listed_at');
      if (TYPES[req.query.type]) q = q.eq('type', TYPES[req.query.type]);
      if (TIERS.includes(req.query.tier)) q = q.eq('tier', req.query.tier);
      if (req.query.preview === 'yes') q = q.eq('is_preview', true);
      if (req.query.preview === 'no') q = q.eq('is_preview', false);
      if (req.query.state === 'draft') q = q.eq('is_published', false);
      else if (STATES.includes(req.query.state)) q = q.eq('state', req.query.state).eq('is_published', true);
      const { data, error } = await q;
      if (error) throw error;
      const counts = await waitCounts();
      const listings = data.map((l) => {
        const sec = Array.isArray(l.secret) ? l.secret[0] : l.secret;
        const masked = (enc) => (enc ? secrets.mask(secrets.decrypt(enc) || '••••') : '');
        return {
          ...l, secret: undefined, type: TYPE_KEY[l.type], status: l.is_published ? l.state : 'draft', waitlist: counts[l.id] || 0,
          outbound: { set: Boolean(sec && sec.outbound_enc), url: sec && sec.outbound_enc ? masked(sec.outbound_enc) : '', refParam: sec?.ref_param || '', ref: masked(sec?.ref_code_enc), ibParam: sec?.ib_param || '', ib: masked(sec?.ib_code_enc), discountParam: sec?.discount_param || '', discount: masked(sec?.discount_code_enc), updatedAt: sec?.updated_at || null },
        };
      });
      const { data: tiers } = await supabase.from('listing_tiers').select('*').order('rank');
      res.json({ listings, tiers: tiers || [], canEdit: canEdit(req), isSuper: isSuper(req), secretsKey: secrets.configured() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  async function saveOrganizer(org, existingId) {
    if (!Object.keys(org).length) return existingId;
    if (existingId) {
      const { error } = await supabase.from('organizers').update(org).eq('id', existingId);
      if (error) throw error;
      return existingId;
    }
    const { data, error } = await supabase.from('organizers').insert({ name: org.name || 'Partner', ...org }).select('id').single();
    if (error) throw error;
    return data.id;
  }

  // One pin per tab at a time: pinning here unpins the others on that tab.
  async function exclusivePin(id, tab) {
    if (!tab) return;
    await supabase.from('competitions').update({ pin_tab: null, pin_starts_at: null, pin_ends_at: null }).eq('pin_tab', tab).neq('id', id);
  }

  async function setState(row, b, current) {
    if (b.status === undefined) return null;
    if (!STATES.includes(b.status)) return 'Status must be draft, coming soon, running or closed';
    if (b.status === 'running') {
      const ok = (await liveFeed.isReady({ getAppSetting: async (k) => (await supabase.from('app_settings').select('value').eq('key', k).maybeSingle()).data?.value })) && liveFeed.healthy();
      if (!ok) return 'A listing can be set to running only after the live feed is ready';
    }
    row.is_published = b.status !== 'draft';
    row.state = b.status === 'draft' ? 'coming_soon' : b.status;
    return null;
  }

  r.post('/', requireEditor, async (req, res) => {
    const b = req.body || {};
    const { row, org, error } = parseListing(b, { partial: false });
    if (error) return res.status(400).json({ error });
    if (!org.name) return res.status(400).json({ error: 'Name the partner' });
    const stateErr = await setState(row, { status: b.status || 'draft' });
    if (stateErr) return res.status(400).json({ error: stateErr });
    try {
      compStates.assertSeparation({ ...row, entry_fee_coins: 0 });
      row.organizer_id = await saveOrganizer(org, null);
      Object.assign(row, { entry_fee_coins: 0, prize_pool_coins: 0, data_source: 'live', listed_at: new Date().toISOString(), public_token: require('crypto').randomBytes(9).toString('base64url') });
      const { data, error: e2 } = await supabase.from('competitions').insert(row).select('id, slug').single();
      if (e2) throw e2;
      if (row.pin_tab) await exclusivePin(data.id, row.pin_tab);
      await audit(req, 'listing_create', data.id, { title: row.title, type: b.type, tier: row.tier || 'standard', status: b.status || 'draft' });
      res.json({ listing: data });
    } catch (e) {
      res.status(/duplicate key/.test(e.message) ? 400 : 500).json({ error: /slug/.test(e.message) ? 'That address (slug) is already used' : e.message });
    }
  });

  r.put('/:id', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Listing not found' });
    try {
      const { data: cur, error: e0 } = await supabase.from('competitions').select('id, type, title, prize_kind, listing, starts_at, ends_at, organizer_id, organizer:organizers(name)').eq('id', req.params.id).in('type', Object.values(TYPES)).maybeSingle();
      if (e0) throw e0;
      if (!cur) return res.status(404).json({ error: 'Listing not found' });
      const b = req.body || {};
      const { row, org, error } = parseListing(b, { partial: true, current: { ...cur, organizerName: cur.organizer?.name } });
      if (error) return res.status(400).json({ error });
      const stateErr = await setState(row, b, cur);
      if (stateErr) return res.status(400).json({ error: stateErr });
      compStates.assertSeparation({ prize_kind: row.prize_kind || cur.prize_kind, entry_fee_coins: 0 });
      await saveOrganizer(org, cur.organizer_id);
      if (Object.keys(row).length) {
        const { error: e1 } = await supabase.from('competitions').update(row).eq('id', cur.id);
        if (e1) throw e1;
      }
      if (row.pin_tab) await exclusivePin(cur.id, row.pin_tab);
      await audit(req, 'listing_update', cur.id, { title: row.title || cur.title, fields: Object.keys(row).concat(Object.keys(org).map((k) => `organizer.${k}`)) });
      res.json({ success: true });
    } catch (e) {
      res.status(/duplicate key/.test(e.message) ? 400 : 500).json({ error: /slug/.test(e.message) ? 'That address (slug) is already used' : e.message });
    }
  });

  // Close (never a hard delete: history stays).
  r.delete('/:id', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Listing not found' });
    const { data, error } = await supabase.from('competitions').update({ state: 'closed', closed_reason: 'removed', pin_tab: null }).eq('id', req.params.id).in('type', Object.values(TYPES)).select('id, title').maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Listing not found' });
    await audit(req, 'listing_close', data.id, { title: data.title });
    res.json({ success: true });
  });

  // Outbound link and codes: stored encrypted; the response never echoes them.
  r.put('/:id/secrets', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Listing not found' });
    if (!secrets.configured()) return res.status(503).json({ error: 'LISTING_SECRETS_KEY is not set on this server, so links and codes cannot be saved' });
    const b = req.body || {};
    const row = { competition_id: req.params.id, updated_by: who(req), updated_at: new Date().toISOString() };
    try {
      if (b.outboundUrl !== undefined) {
        const u = String(b.outboundUrl || '').trim();
        if (u && !/^https:\/\//i.test(u)) return res.status(400).json({ error: 'The link must start with https://' });
        row.outbound_enc = u ? secrets.encrypt(u) : null;
      }
      for (const [k, pk, col, pcol] of [['refCode', 'refParam', 'ref_code_enc', 'ref_param'], ['ibCode', 'ibParam', 'ib_code_enc', 'ib_param'], ['discountCode', 'discountParam', 'discount_code_enc', 'discount_param']]) {
        if (b[k] !== undefined) row[col] = String(b[k] || '').trim() ? secrets.encrypt(String(b[k]).trim().slice(0, 120)) : null;
        if (b[pk] !== undefined) {
          const p = String(b[pk] || '').trim();
          if (p && !/^[A-Za-z0-9_.-]{1,40}$/.test(p)) return res.status(400).json({ error: 'A link parameter name is letters, numbers, dot, dash or underscore' });
          row[pcol] = p || null;
        }
      }
      const { error } = await supabase.from('competition_listing_secrets').upsert(row, { onConflict: 'competition_id' });
      if (error) throw error;
      await audit(req, 'listing_secrets_update', req.params.id, { changed: Object.keys(row).filter((k) => k.endsWith('_enc') || k.endsWith('_param')) });
      res.json({ success: true });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Reveal the real values (super admin only; logged).
  r.get('/:id/secrets', async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Only a super admin can reveal links and codes' });
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Listing not found' });
    const { data } = await supabase.from('competition_listing_secrets').select('*').eq('competition_id', req.params.id).maybeSingle();
    await audit(req, 'listing_secrets_reveal', req.params.id, {});
    res.set('Cache-Control', 'no-store');
    res.json({ outboundUrl: secrets.decrypt(data?.outbound_enc) || '', refParam: data?.ref_param || '', refCode: secrets.decrypt(data?.ref_code_enc) || '', ibParam: data?.ib_param || '', ibCode: secrets.decrypt(data?.ib_code_enc) || '', discountParam: data?.discount_param || '', discountCode: secrets.decrypt(data?.discount_code_enc) || '' });
  });

  r.post('/:id/logo', requireEditor, (req, res) => {
    upload.single('logo')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Logo must be 1 MB or smaller' : err.message });
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Listing not found' });
      const result = validateLogo(req.file?.buffer);
      if (!result.ok) return res.status(400).json({ error: result.error });
      try {
        const { data: c } = await supabase.from('competitions').select('id, organizer_id').eq('id', req.params.id).maybeSingle();
        if (!c || !c.organizer_id) return res.status(404).json({ error: 'Listing not found' });
        const objectPath = `listings/${c.organizer_id}/${Date.now()}.${result.ext}`;
        const { error: upErr } = await supabase.storage.from(LOGO_BUCKET).upload(objectPath, result.buffer, { contentType: result.contentType, upsert: true });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(objectPath);
        const col = req.query.variant === 'dark' ? 'logo_dark_url' : 'logo_url';
        await supabase.from('organizers').update({ [col]: pub.publicUrl }).eq('id', c.organizer_id);
        await audit(req, 'listing_logo_upload', c.id, { variant: col });
        res.json({ url: pub.publicUrl });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  });

  // Notify everyone waiting for a listing: once per 24 hours, one email per player.
  r.post('/:id/notify', requireEditor, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Listing not found' });
    try {
      const { data: c } = await supabase.from('competitions').select('id, title, slug, rules_summary').eq('id', req.params.id).maybeSingle();
      if (!c) return res.status(404).json({ error: 'Listing not found' });
      const { data: last } = await supabase.from('competition_waitlist_sends').select('created_at').eq('competition_id', c.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (last && Date.now() - Date.parse(last.created_at) < 24 * 3600 * 1000) return res.status(429).json({ error: 'This list was emailed in the last 24 hours. Try again later.' });
      await supabase.from('competition_waitlist_sends').insert({ competition_id: c.id, sent_by: who(req), recipients: 0 });
      const { data: rows } = await supabase.from('competition_waitlist').select('id, user_id, player:players!competition_waitlist_user_id_fkey(email, username)').eq('competition_id', c.id).is('notified_at', null).limit(5000);
      const site = String(process.env.SITE_URL || 'https://www.spikeandcrush.com').replace(/\/$/, '');
      const day = new Date().toISOString().slice(0, 10);
      let sent = 0;
      let failed = 0;
      for (const w of rows || []) {
        if (!w.player || !w.player.email) continue;
        const { error: e3 } = await supabase.from('competition_waitlist').update({ notified_at: new Date().toISOString() }).eq('id', w.id).is('notified_at', null);
        if (e3) continue;
        const out = await sendEmail({ to: w.player.email, idempotencyKey: `listing-open:${c.id}:${w.user_id}:${day}`, ...waitlistOpenEmail({ username: w.player.username, title: c.title, hook: c.rules_summary || '', link: `${site}/competitions/listing/${c.slug}` }) });
        if (out && out.error) { failed += 1; await supabase.from('competition_waitlist').update({ notified_at: null }).eq('id', w.id); } else sent += 1;
      }
      await supabase.from('competition_waitlist_sends').update({ recipients: sent }).eq('competition_id', c.id).eq('sent_by', who(req)).eq('recipients', 0);
      await audit(req, 'listing_waitlist_notify', c.id, { sent, failed });
      res.json({ sent, failed });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Load or refresh the invented Preview listings from data/seed (super admin).
  r.post('/seed', async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Only a super admin can load the seed listings' });
    try {
      const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
      const out = await seedListings(supabase, seed);
      await audit(req, 'listing_seed', null, out);
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Tiers: names, perks and price lines.
  r.put('/tiers/:key', requireEditor, async (req, res) => {
    if (!TIERS.includes(req.params.key)) return res.status(404).json({ error: 'Tier not found' });
    const patch = { updated_by: who(req), updated_at: new Date().toISOString() };
    if (req.body?.name !== undefined) { const n = String(req.body.name).trim().slice(0, 30); if (!n) return res.status(400).json({ error: 'Name the tier' }); patch.name = n; }
    if (req.body?.perks !== undefined) patch.perks = String(req.body.perks || '').trim().slice(0, 400) || null;
    if (req.body?.priceText !== undefined) patch.price_text = String(req.body.priceText || '').trim().slice(0, 40) || null;
    const { error } = await supabase.from('listing_tiers').update(patch).eq('key', req.params.key);
    if (error) return res.status(500).json({ error: error.message });
    await audit(req, 'listing_tier_update', req.params.key, patch);
    res.json({ success: true });
  });

  return r;
}

module.exports = router;
module.exports.parseListing = parseListing;
