'use strict';

// Partner listings on the competitions page: prop firm, broker and sponsored
// competitions, all Coming soon until live data exists. Listings sort by paid
// tier, then by who listed first, then by name. Outbound links and referral,
// IB and discount codes never leave the server: the page links to an opaque
// /go/l/<token> that adds them and redirects (server/listingSecrets.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { visitorIp } = require('./originLock'); // the real visitor, not Cloudflare's edge address
const compStates = require('./competitionStates');
const liveFeed = require('./liveFeed');
const secrets = require('./listingSecrets');
const { waitlistConfirmEmail } = require('./compEmails');

const LISTING_TYPES = ['external', 'broker', 'sponsored'];
const TAB_OF = { external: 'prop', broker: 'broker', sponsored: 'sponsored' };
const TIER_RANK = { featured: 1, plus: 2, standard: 3 };
const TABS = ['all', 'prop', 'broker', 'sponsored'];
const BOT_UA = /bot|crawl|spider|slurp|preview|curl|wget|python-requests|headless/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{2,80}$/;

const t = (v) => (v ? new Date(v).getTime() : null);

// Tier in force now: a paid tier outside its dates falls back to Standard.
function effectiveTier(row, now = Date.now()) {
  const tier = TIER_RANK[row.tier] ? row.tier : 'standard';
  if (tier === 'standard') return tier;
  const s = t(row.tier_starts_at);
  const e = t(row.tier_ends_at);
  if ((s && now < s) || (e && now >= e)) return 'standard';
  return tier;
}

function pinnedOn(row, tab, now = Date.now()) {
  if (row.pin_tab !== tab) return false;
  const s = t(row.pin_starts_at);
  const e = t(row.pin_ends_at);
  return !(s && now < s) && !(e && now >= e);
}

// Pinned (one per tab, for its dates) first, then tier, then listed first, then name.
function sortListings(rows, tab = 'all', now = Date.now()) {
  const nameOf = (r) => String(r.title || r.name || '').toLowerCase();
  return [...rows].sort((a, b) => {
    const pa = pinnedOn(a, tab, now) ? 0 : 1;
    const pb = pinnedOn(b, tab, now) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const ta = TIER_RANK[effectiveTier(a, now)];
    const tb = TIER_RANK[effectiveTier(b, now)];
    if (ta !== tb) return ta - tb;
    const la = t(a.listed_at) || 0;
    const lb = t(b.listed_at) || 0;
    if (la !== lb) return la - lb;
    return nameOf(a).localeCompare(nameOf(b));
  });
}

function orderFor(rows, now = Date.now()) {
  const out = {};
  for (const tab of TABS) out[tab] = sortListings(tab === 'all' ? rows : rows.filter((r) => TAB_OF[r.type] === tab), tab, now).map((r) => r.id);
  return out;
}

// What the public sees. No outbound URL, no codes, no external_url.
function publicListing(row, { now = Date.now(), joined = false, saved = false, count = null } = {}) {
  const org = row.organizer || {};
  const l = row.listing || {};
  const prize = compStates.prizeWording({ ...row, prize_pool_amount: row.prize_pool });
  const live = ['open', 'running'].includes(row.state);
  return {
    id: row.id,
    slug: row.slug,
    type: TAB_OF[row.type],
    title: row.title,
    organizer: { name: org.name || '', logo: org.logo_dark_url || org.logo_url || null, country: org.country_code || null, years: org.years_operating ?? null, rating: org.rating != null ? Number(org.rating) : null },
    kind: l.kind || null,
    prize: { kind: prize.kind, amount: prize.amount || null, text: row.prize_kind === 'goods' ? row.prize_text : null, label: prize.label },
    rules: Array.isArray(l.rules) ? l.rules.slice(0, 6) : [],
    assets: Array.isArray(l.assets) ? l.assets.slice(0, 6) : [],
    platforms: Array.isArray(l.platforms) ? l.platforms.slice(0, 4) : [],
    accountType: l.accountType || null,
    leverage: l.leverage || null,
    instruments: Array.isArray(l.instruments) ? l.instruments : [],
    howToWin: l.howToWin || null,
    summary: row.rules_summary || l.summary || null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    state: row.state,
    tier: effectiveTier(row, now),
    preview: Boolean(row.is_preview),
    listedAt: row.listed_at,
    waitlist: { count, joined },
    saved,
    detailUrl: `/competitions/listing/${row.slug}`,
    // the outbound appears only once a listing is live; it is the opaque redirect, never the destination
    outbound: live && row.public_token ? `/go/l/${row.public_token}` : null,
  };
}

// ---- seeding (idempotent; also run from admin) ------------------------------------------
async function seedListings(supabase, seed, { now = Date.now() } = {}) {
  const out = { organizers: 0, created: 0, updated: 0 };
  for (const l of seed.listings) {
    const o = l.organizer;
    const orgRow = { seed_key: `org-${l.seedKey}`, name: o.name, logo_url: o.logo, logo_dark_url: o.logoDark || o.logo, country_code: o.country || null, years_operating: o.years ?? null, rating: o.rating ?? null, is_verified: false };
    // seed_key has a partial unique index, which upsert's ON CONFLICT cannot target: look up, then write.
    const { data: orgFound, error: e0 } = await supabase.from('organizers').select('id').eq('seed_key', orgRow.seed_key).maybeSingle();
    if (e0) throw e0;
    const { data: org, error: e1 } = orgFound
      ? await supabase.from('organizers').update(orgRow).eq('id', orgFound.id).select('id').single()
      : await supabase.from('organizers').insert(orgRow).select('id').single();
    if (e1) throw e1;
    out.organizers += 1;
    const type = { prop: 'external', broker: 'broker', sponsored: 'sponsored' }[l.type];
    const content = {
      title: l.title, slug: l.slug, type, organizer_id: org.id,
      prize_kind: l.prize.kind, prize_pool: l.prize.kind === 'money' ? l.prize.amount : 0, prize_currency: l.prize.currency || 'USD',
      prize_text: l.prize.kind === 'goods' ? l.prize.text : null, entry_fee_coins: 0, prize_pool_coins: 0,
      rules_summary: l.summary, description: l.summary, data_source: 'live', state: 'coming_soon',
      listing: { kind: l.kind, rules: l.rules, assets: l.assets, platforms: l.platforms, accountType: l.accountType || null, leverage: l.leverage || null, instruments: l.instruments || [], howToWin: l.howToWin || null, summary: l.summary },
      is_published: true, is_preview: Boolean(l.preview), external_url: null,
    };
    const { data: existing } = await supabase.from('competitions').select('id').eq('seed_key', l.seedKey).maybeSingle();
    if (existing) {
      const { error } = await supabase.from('competitions').update(content).eq('id', existing.id);
      if (error) throw error;
      out.updated += 1;
    } else {
      const start = now + l.startsInDays * 86400000;
      const row = { ...content, seed_key: l.seedKey, tier: l.tier, listed_at: new Date(now - l.listedDaysAgo * 86400000).toISOString(), starts_at: new Date(start).toISOString(), ends_at: new Date(start + l.lengthDays * 86400000).toISOString(), public_token: crypto.randomBytes(9).toString('base64url') };
      const { error } = await supabase.from('competitions').insert(row);
      if (error) throw error;
      out.created += 1;
    }
  }
  return out;
}

function createListingsRouter({ db, authenticate, optionalViewerId, sendEmail, clientDir, siteUrl }) {
  const r = express.Router();
  const readLimiter = rateLimit({ keyGenerator: (req) => visitorIp(req), windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false });
  const writeLimiter = rateLimit({ keyGenerator: (req) => visitorIp(req), windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false });
  const goLimiter = rateLimit({ keyGenerator: (req) => visitorIp(req), windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false });
  const sb = () => db.client();
  let cache = { at: 0, rows: null };

  async function loadRows() {
    if (cache.rows && Date.now() - cache.at < 15000) return cache.rows;
    const { data, error } = await sb()
      .from('competitions')
      .select('id, slug, type, title, prize_kind, prize_pool, prize_currency, prize_text, rules_summary, listing, starts_at, ends_at, state, tier, tier_starts_at, tier_ends_at, listed_at, is_preview, pin_tab, pin_starts_at, pin_ends_at, public_token, organizer:organizers(name, logo_url, logo_dark_url, country_code, years_operating, rating)')
      .in('type', LISTING_TYPES)
      .eq('is_published', true)
      .neq('state', 'closed')
      .not('slug', 'is', null);
    if (error) throw error;
    cache = { at: Date.now(), rows: data };
    return data;
  }
  async function threshold() {
    try { const v = Number(await db.getAppSetting('waitlist.showCountFrom')); return Number.isFinite(v) && v > 0 ? v : 50; } catch (e) { return 50; }
  }
  let countCache = { at: 0, map: {} };
  async function waitCounts() {
    if (Date.now() - countCache.at < 30000) return countCache.map;
    const { data } = await sb().from('competition_waitlist').select('competition_id').not('competition_id', 'is', null).limit(100000);
    const map = {};
    (data || []).forEach((w) => { map[w.competition_id] = (map[w.competition_id] || 0) + 1; });
    countCache = { at: Date.now(), map };
    return map;
  }
  async function viewerSets(viewerId) {
    if (!viewerId) return { saved: new Set(), joined: new Set() };
    const [s, w] = await Promise.all([
      sb().from('listing_saves').select('competition_id').eq('user_id', viewerId),
      sb().from('competition_waitlist').select('competition_id').eq('user_id', viewerId).not('competition_id', 'is', null),
    ]);
    return { saved: new Set((s.data || []).map((x) => x.competition_id)), joined: new Set((w.data || []).map((x) => x.competition_id)) };
  }
  async function liveInfo() {
    const ready = await liveFeed.canGoLive(db).catch(() => false);
    let heartbeatAt = null;
    if (ready) { try { heartbeatAt = await db.getAppSetting('liveFeed.heartbeatAt'); } catch (e) { heartbeatAt = null; } }
    return { ready, heartbeatAt: ready ? heartbeatAt || null : null };
  }

  r.get('/api/competition-listings', readLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!db.isConfigured) return res.json({ listings: [], order: {}, liveNow: false, liveFeed: { ready: false, heartbeatAt: null } });
    try {
      const now = Date.now();
      const [rows, viewerId, th, counts, live] = await Promise.all([loadRows(), optionalViewerId(req), threshold(), waitCounts(), liveInfo()]);
      const mine = await viewerSets(viewerId);
      const { data: tiers } = await sb().from('listing_tiers').select('key, name, rank').order('rank');
      const listings = rows.map((row) => publicListing(row, { now, joined: mine.joined.has(row.id), saved: mine.saved.has(row.id), count: (counts[row.id] || 0) >= th ? counts[row.id] : null }));
      res.json({ listings, order: orderFor(rows, now), liveNow: rows.some((x) => x.state === 'running'), liveFeed: live, tiers: tiers || [], loggedIn: Boolean(viewerId) });
    } catch (e) {
      console.error('[listings]', e.message);
      res.json({ listings: [], order: {}, liveNow: false, liveFeed: { ready: false, heartbeatAt: null }, unavailable: true });
    }
  });

  async function bySlugOrId(v) {
    const rows = await loadRows();
    return rows.find((x) => x.slug === v || x.id === v) || null;
  }

  r.get('/api/competition-listings/:slug', readLimiter, async (req, res) => {
    if (!SLUG_RE.test(req.params.slug) && !UUID_RE.test(req.params.slug)) return res.status(404).json({ error: 'Listing not found' });
    try {
      const row = await bySlugOrId(req.params.slug);
      if (!row) return res.status(404).json({ error: 'Listing not found' });
      const viewerId = await optionalViewerId(req);
      const mine = await viewerSets(viewerId);
      const counts = await waitCounts();
      const th = await threshold();
      res.json({ listing: publicListing(row, { joined: mine.joined.has(row.id), saved: mine.saved.has(row.id), count: (counts[row.id] || 0) >= th ? counts[row.id] : null }), loggedIn: Boolean(viewerId) });
    } catch (e) {
      res.status(404).json({ error: 'Listing not found' });
    }
  });

  r.post('/api/competition-listings/:id/save', writeLimiter, authenticate, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Listing not found' });
    const { error } = await sb().from('listing_saves').upsert({ user_id: req.tokenPlayer.id, competition_id: req.params.id }, { onConflict: 'user_id,competition_id', ignoreDuplicates: true });
    if (error) return res.status(400).json({ error: 'Could not save this listing' });
    res.json({ saved: true });
  });
  r.delete('/api/competition-listings/:id/save', writeLimiter, authenticate, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Listing not found' });
    await sb().from('listing_saves').delete().eq('user_id', req.tokenPlayer.id).eq('competition_id', req.params.id);
    res.json({ saved: false });
  });

  r.post('/api/competition-listings/:id/waitlist', writeLimiter, authenticate, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Listing not found' });
    try {
      const row = await bySlugOrId(req.params.id);
      if (!row) return res.status(404).json({ error: 'Listing not found' });
      const source = ['card', 'detail', 'email', 'signup'].includes(req.body?.source) ? req.body.source : 'card';
      // The (user_id, competition_id) unique index is partial, so no upsert: a duplicate (23505) means already on the list.
      const { error } = await sb().from('competition_waitlist').insert({ user_id: req.tokenPlayer.id, competition_id: row.id, source });
      if (error && error.code !== '23505') throw error;
      const created = !error;
      countCache.at = 0;
      if (created && sendEmail) {
        const player = await db.getPlayerById(req.tokenPlayer.id).catch(() => null);
        if (player && player.email) {
          sendEmail({ to: player.email, idempotencyKey: `waitlist-confirm:listing:${row.id}:${player.id}`, ...waitlistConfirmEmail({ username: player.username, title: row.title, hook: (row.listing && row.listing.summary) || '', rhythm: 'Coming soon', link: `${siteUrl(req)}/competitions/listing/${row.slug}` }) }).catch(() => {});
        }
      }
      res.json({ joined: true, created });
    } catch (e) {
      console.error('[listing waitlist]', e.message);
      res.status(500).json({ error: 'Could not join the list right now' });
    }
  });
  r.delete('/api/competition-listings/:id/waitlist', writeLimiter, authenticate, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Listing not found' });
    await sb().from('competition_waitlist').delete().eq('user_id', req.tokenPlayer.id).eq('competition_id', req.params.id);
    countCache.at = 0;
    res.json({ joined: false });
  });

  // The only way out to a partner. Codes are added here, never shown anywhere.
  r.get('/go/l/:token', goLimiter, async (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(req.params.token) || !db.isConfigured) return res.redirect(302, '/competitions');
    try {
      const { data: row } = await sb().from('competitions').select('id, slug, type, public_token').eq('public_token', req.params.token).in('type', LISTING_TYPES).maybeSingle();
      if (!row) return res.redirect(302, '/competitions');
      const { data: sec } = await sb().from('competition_listing_secrets').select('*').eq('competition_id', row.id).maybeSingle();
      const url = secrets.outboundUrl(sec, { utm: { utm_source: 'spikeandcrush', utm_medium: 'competition_listing', utm_campaign: row.slug } });
      if (!url) return res.redirect(302, `/competitions/listing/${row.slug}?note=not-configured`);
      if (!BOT_UA.test(String(req.get('user-agent') || ''))) sb().rpc('listing_outbound_bump', { p_id: row.id }).then(() => {}, () => {});
      res.redirect(302, url);
    } catch (e) {
      res.redirect(302, '/competitions');
    }
  });

  // Detail page with its own title, description, canonical and JSON-LD.
  const escAttr = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  r.get('/competitions/listing/:slug', async (req, res, next) => {
    if (!SLUG_RE.test(req.params.slug)) return next();
    let html;
    try { html = fs.readFileSync(path.join(clientDir, 'listing.html'), 'utf8'); } catch (e) { return next(); }
    let row = null;
    try { row = db.isConfigured ? await bySlugOrId(req.params.slug) : null; } catch (e) { row = null; }
    if (!row) return next();
    const org = (row.organizer && row.organizer.name) || '';
    const title = `${row.title} by ${org} | Spike & Crush`.slice(0, 70);
    const prize = compStates.prizeWording({ ...row, prize_pool_amount: row.prize_pool });
    const desc = `${row.title}, hosted by ${org}. ${prize.amount ? `${prize.amount} prize. ` : row.prize_text ? `Win ${row.prize_text.toLowerCase()}. ` : ''}Free entry. Coming soon.`;
    const canonical = `${siteUrl(req)}/competitions/listing/${row.slug}`;
    const ld = { '@context': 'https://schema.org', '@type': 'Event', name: row.title, description: desc, startDate: row.starts_at, endDate: row.ends_at, eventStatus: 'https://schema.org/EventScheduled', eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode', location: { '@type': 'VirtualLocation', url: canonical }, organizer: { '@type': 'Organization', name: org }, isAccessibleForFree: true };
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`)
      .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escAttr(desc)}" />\n<link rel="canonical" href="${escAttr(canonical)}" />\n<meta property="og:title" content="${escAttr(title)}" />\n<meta property="og:description" content="${escAttr(desc)}" />\n<meta property="og:url" content="${escAttr(canonical)}" />\n<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`);
    res.type('html').send(html);
  });

  // Tier names, perks and price lines for the Partner with us page (prices blank until set).
  r.get('/api/listing-tiers', readLimiter, async (req, res) => {
    if (!db.isConfigured) return res.json({ tiers: [] });
    const { data } = await sb().from('listing_tiers').select('key, name, rank, perks, price_text').order('rank');
    res.json({ tiers: (data || []).map((x) => ({ ...x, price_text: x.price_text && String(x.price_text).trim() ? x.price_text : null })) });
  });

  r.clearCache = () => { cache = { at: 0, rows: null }; countCache = { at: 0, map: {} }; };
  return r;
}

module.exports = { createListingsRouter, sortListings, effectiveTier, pinnedOn, publicListing, orderFor, seedListings, TIER_RANK, TAB_OF };
