'use strict';

// Lobby data + sponsor system (public side). One stats endpoint feeds both
// the desktop and the mobile lobby; sponsor endpoints only ever expose
// sponsors that are active and inside their date window. Every prize and
// win figure here is coins - coins have no cash value.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { sendEmail } = require('../admin/lib/email');

const STATS_CACHE_MS = 15000;
const PLACEMENTS = ['global_strip', 'hero', 'competition', 'mode'];
const MAX_STRIP_SPONSORS = 6;
const LEAD_INTERESTS = ['global_strip', 'competition', 'mode', 'hero', 'tournament', 'other'];
const LEAD_BUDGETS = ['under_1k', '1k_5k', '5k_20k', '20k_plus', 'not_sure'];
const LEADS_PER_IP_PER_DAY = 3;
const LEAD_INBOX = 'hello@spikeandcrush.com';
const LOBBY_MODES = ['quick', 'blitz', 'grand', 'solo', 'async', 'private', 'tournament'];

// Daily-rotating salt so an ip_hash can't be joined across days. The secret
// comes from the environment; without one a random per-process value is
// used (hashes then just don't survive a restart).
const IP_HASH_SECRET = process.env.IP_HASH_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.IP_HASH_SECRET) console.warn('[lobby] IP_HASH_SECRET not set - using a per-process random salt for ip hashes');

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress || '').replace('::ffff:', '');
}

function ipHash(req) {
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${IP_HASH_SECRET}:${day}:${clientIp(req)}`).digest('hex');
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function prizeCoinsOf(c) {
  if (Number(c.prize_pool_coins) > 0) return Number(c.prize_pool_coins);
  return (Array.isArray(c.prize_payouts) ? c.prize_payouts : []).reduce((sum, p) => sum + (Number(p.coins) || 0), 0);
}

function createLobbyRouter({ db, gameEngine, instrumentsRegistry, playerSockets, competitionSummary, TIERS, authenticate, optionalViewerId }) {
  const r = express.Router();
  const impressionLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
  const clickLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
  const leadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });

  // Sponsor tables may not exist yet on a database that hasn't run the
  // lobby_sponsors migration - the lobby then just has no sponsors.
  async function safeSponsors(args) {
    if (!db.isConfigured) return [];
    try {
      return await db.listActiveSponsors(args);
    } catch (e) {
      return [];
    }
  }

  async function lobbySettings() {
    const fallback = { showSeedAccounts: false, emptyMessage: 'Season 1 is live. Be one of the first traders on the board.', featuredCompetitionId: null, seasonLabel: 'Season 1' };
    if (!db.isConfigured) return fallback;
    try {
      return await db.getLobbySettings();
    } catch (e) {
      return fallback;
    }
  }

  // Featured = the admin's pick (if it's still running or upcoming), else the
  // soonest-ending live native competition, else the next one to start.
  async function featuredCompetition(settings) {
    if (!db.isConfigured) return null;
    const rows = (await db.listPublishedCompetitions()).map(competitionSummary).filter((c) => c.lifecycle !== 'void' && c.status !== 'ended');
    const picked = settings.featuredCompetitionId && rows.find((c) => c.id === settings.featuredCompetitionId);
    const live = rows.filter((c) => c.status === 'active' && c.type === 'native').sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));
    const next = rows.filter((c) => c.status === 'upcoming' && c.type === 'native').sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    const c = picked || live[0] || next[0];
    if (!c) return null;
    const [placed] = await safeSponsors({ placement: 'competition', target: c.id });
    let sponsor = placed || null;
    if (!sponsor && c.sponsor_id) {
      try {
        const s = await db.getLiveSponsor(c.sponsor_id);
        if (s) sponsor = { id: s.id, name: s.name, logoUrl: s.logo_url, placement: 'competition', targetId: c.id };
      } catch (e) {
        sponsor = null;
      }
    }
    return {
      id: c.id,
      title: c.title,
      frequency: c.frequency,
      status: c.status,
      startsAt: c.starts_at,
      endsAt: c.ends_at,
      prizeCoins: prizeCoinsOf(c),
      entryCoins: c.entry_fee_coins || 0,
      entrants: c.entry_count || 0,
      sponsor,
    };
  }

  let statsCache = { at: 0, body: null };

  async function buildStats() {
    const settings = await lobbySettings();
    const tasks = {
      matchesToday: db.isConfigured ? db.getMatchesToday() : Promise.resolve(0),
      largestWinCoins: db.isConfigured ? db.getLargestWinToday() : Promise.resolve(0),
      coinsWonToday: db.isConfigured ? db.getCoinsWonToday() : Promise.resolve(0),
      featured: featuredCompetition(settings),
      sponsors: safeSponsors({ placement: 'global_strip' }),
    };
    const keys = Object.keys(tasks);
    const results = await Promise.allSettled(Object.values(tasks));
    const out = {};
    keys.forEach((k, i) => {
      out[k] = results[i].status === 'fulfilled' ? results[i].value : null;
      if (results[i].status === 'rejected') console.warn(`[lobby stats] ${k} failed:`, results[i].reason?.message);
    });
    let ticker = [];
    try {
      ticker = instrumentsRegistry.getTickerSnapshot();
    } catch (e) {
      ticker = [];
    }
    const modes = LOBBY_MODES.filter((m) => gameEngine.MATCH_MODES[m]).map((m) => ({
      key: m,
      label: gameEngine.MATCH_MODES[m].label,
      durationSeconds: gameEngine.MATCH_MODES[m].durationSeconds,
      entryCoins: gameEngine.MATCH_MODES[m].entryCoins,
    }));
    return {
      matchesToday: out.matchesToday || 0,
      // Connected players right now. Personas never hold a socket, so this
      // is real people only.
      activePlayers: playerSockets.size,
      largestWinCoins: out.largestWinCoins || 0,
      coinsWonToday: out.coinsWonToday || 0,
      emptyMessage: settings.emptyMessage,
      seasonLabel: settings.seasonLabel,
      ticker,
      featured: out.featured,
      sponsors: (out.sponsors || []).slice(0, MAX_STRIP_SPONSORS),
      modes,
      generatedAt: new Date().toISOString(),
    };
  }

  r.get('/api/lobby/stats', async (req, res) => {
    try {
      if (!statsCache.body || Date.now() - statsCache.at > STATS_CACHE_MS) {
        statsCache = { at: Date.now(), body: await buildStats() };
      }
      res.set('Cache-Control', 'public, max-age=15');
      res.json(statsCache.body);
    } catch (e) {
      console.error('[lobby stats]', e);
      res.status(500).json({ error: 'Could not load lobby stats' });
    }
  });

  // Player card: rating, tier + progress to the next one, win rate, streak.
  r.get('/api/lobby/me', authenticate, async (req, res) => {
    try {
      const p = req.player;
      const rating = Number(p.war_rating || 0);
      const idx = Math.max(0, TIERS.findIndex((t) => rating >= t.min && rating <= t.max));
      const tier = TIERS[idx];
      const next = TIERS[idx + 1] || null;
      const progressPct = next ? Math.max(0, Math.min(100, Math.round(((rating - tier.min) / (next.min - tier.min)) * 100))) : 100;
      const streak = p.total_matches ? await db.getPlayerWinStreak(p.id).catch(() => 0) : 0;
      res.json({
        id: p.id,
        username: p.username,
        avatarUrl: p.avatar_url || null,
        coins: Number(p.coins || 0),
        rating,
        tier: tier.name,
        nextTier: next ? next.name : null,
        nextTierAt: next ? next.min : null,
        progressPct,
        totalMatches: p.total_matches || 0,
        winRate: p.total_matches ? Math.round(((p.wins || 0) / p.total_matches) * 100) : null,
        streak: p.total_matches ? streak : null,
      });
    } catch (e) {
      console.error('[lobby me]', e);
      res.status(500).json({ error: 'Could not load your player card' });
    }
  });

  // Same rotating snapshot the ticker always used (replayed historical data).
  r.get('/api/prices/live', (req, res) => {
    try {
      res.json({ rows: instrumentsRegistry.getTickerSnapshot() });
    } catch (e) {
      res.status(500).json({ rows: [], error: 'Prices unavailable' });
    }
  });

  r.get('/api/sponsors/active', async (req, res) => {
    const placement = PLACEMENTS.includes(req.query.placement) ? req.query.placement : 'global_strip';
    const target = req.query.target ? String(req.query.target).slice(0, 64) : null;
    res.json({ sponsors: await safeSponsors({ placement, target }) });
  });

  async function recordImpressions(items) {
    const day = new Date().toISOString().slice(0, 10);
    const counts = new Map();
    for (const it of items) {
      if (!it || !UUID_RE.test(String(it.id)) || !PLACEMENTS.includes(it.placement)) continue;
      const key = `${it.id}|${it.placement}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let recorded = 0;
    for (const [key, count] of counts) {
      const [sponsorId, placement] = key.split('|');
      try {
        await db.bumpSponsorImpression({ sponsorId, placement, day, count });
        recorded += count;
      } catch (e) {
        console.warn('[sponsor impression]', e.message);
      }
    }
    return recorded;
  }

  // One batched call per page view: { items: [{ id, placement }] }.
  r.post('/api/sponsors/impressions', impressionLimiter, async (req, res) => {
    if (!db.isConfigured) return res.json({ recorded: 0 });
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [];
    res.json({ recorded: await recordImpressions(items) });
  });

  r.post('/api/sponsors/:id/impression', impressionLimiter, async (req, res) => {
    if (!db.isConfigured) return res.json({ recorded: 0 });
    res.json({ recorded: await recordImpressions([{ id: req.params.id, placement: req.body?.placement || req.query.placement }]) });
  });

  // Counts the click, then 302s to the sponsor's own site. GET as well as
  // POST so a plain <a target="_blank" rel="noopener sponsored"> works.
  async function handleClick(req, res) {
    if (!UUID_RE.test(req.params.id) || !db.isConfigured) return res.status(404).send('Sponsor not found');
    try {
      const sponsor = await db.getLiveSponsor(req.params.id);
      if (!sponsor || !isHttpUrl(sponsor.link_url)) return res.status(404).send('Sponsor not found');
      const placement = PLACEMENTS.includes(req.query.placement || req.body?.placement) ? req.query.placement || req.body.placement : null;
      const target = req.query.target || req.body?.target;
      await db
        .recordSponsorClick({
          sponsorId: sponsor.id,
          placement,
          targetId: target ? String(target).slice(0, 64) : null,
          userId: await optionalViewerId(req),
          ipHash: ipHash(req),
        })
        .catch((e) => console.warn('[sponsor click]', e.message));
      res.redirect(302, new URL(sponsor.link_url).toString());
    } catch (e) {
      console.error('[sponsor click]', e);
      res.status(500).send('Could not open sponsor link');
    }
  }
  r.get('/api/sponsors/:id/click', clickLimiter, handleClick);
  r.post('/api/sponsors/:id/click', clickLimiter, handleClick);

  // Sponsor enquiry form (/sponsor). Stored, then emailed to the inbox.
  r.post('/api/sponsor-leads', leadLimiter, async (req, res) => {
    if (!db.isConfigured) return res.status(503).json({ error: 'Enquiries are unavailable right now' });
    const b = req.body || {};
    const clean = (v, max) => String(v || '').trim().slice(0, max);
    const lead = {
      company: clean(b.company, 120),
      contact_name: clean(b.contactName, 120),
      email: clean(b.email, 200),
      interest: LEAD_INTERESTS.includes(b.interest) ? b.interest : 'other',
      budget_band: LEAD_BUDGETS.includes(b.budgetBand) ? b.budgetBand : 'not_sure',
      message: clean(b.message, 2000),
    };
    if (!lead.company || !lead.contact_name) return res.status(400).json({ error: 'Company and contact name are required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return res.status(400).json({ error: 'Enter a valid email address' });
    try {
      const hash = ipHash(req);
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      if ((await db.countRecentSponsorLeads(hash, since)) >= LEADS_PER_IP_PER_DAY) {
        return res.status(429).json({ error: 'Thanks - we already have your enquiry and will be in touch.' });
      }
      const saved = await db.createSponsorLead({ ...lead, ip_hash: hash });
      const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
      sendEmail({
        to: LEAD_INBOX,
        subject: `Sponsor enquiry: ${lead.company}`,
        html: `<p><b>${esc(lead.company)}</b> - ${esc(lead.contact_name)} &lt;${esc(lead.email)}&gt;</p>
          <p>Interested in: ${esc(lead.interest)} · Budget: ${esc(lead.budget_band)}</p>
          <p>${esc(lead.message).replace(/\n/g, '<br>')}</p>`,
      }).catch((e) => console.warn('[sponsor lead email]', e.message));
      res.json({ success: true, id: saved.id });
    } catch (e) {
      console.error('[sponsor lead]', e);
      res.status(500).json({ error: 'Could not send your enquiry. Please email hello@spikeandcrush.com.' });
    }
  });

  return r;
}

module.exports = { createLobbyRouter, isHttpUrl, prizeCoinsOf };
