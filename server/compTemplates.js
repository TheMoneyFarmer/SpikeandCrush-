'use strict';

// Competition templates as cards (Daily, Weekly, Weekend, Monthly), the
// "Notify me" waitlist, and each template's detail page. Every word on a card
// comes from the competition_templates row (edited in admin) plus the rules in
// competitionStates.js; the client never decides what a prize says.

const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { visitorIp } = require('./originLock'); // the real visitor, not Cloudflare's edge address
const compStates = require('./competitionStates');
const liveFeed = require('./liveFeed');
const { waitlistConfirmEmail } = require('./compEmails');
const schedule = require('./compSchedule');

const KEY_RE = /^(daily|weekend)$/; // Weekly and Monthly were discontinued (2026-11-12)
const ORDER = ['daily', 'weekend'];
const OLD_SLUGS = { daily: 'daily-open', weekend: 'weekend-open', weekly: null, monthly: null };
const live = (t) => t && ORDER.includes(t.key) && !t.discontinued_at && t.state !== 'closed';
const COUNT_CACHE_MS = 30000;

function createCompTemplatesRouter({ db, authenticate, optionalViewerId, sendEmail, clientDir, siteUrl, sponsorNameFor }) {
  const r = express.Router();
  const limiter = rateLimit({ keyGenerator: (req) => visitorIp(req), windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
  let counts = { at: 0, value: {} };

  async function waitlistCounts() {
    if (Date.now() - counts.at < COUNT_CACHE_MS) return counts.value;
    try { counts = { at: Date.now(), value: await db.waitlistCounts() }; } catch (e) { counts = { at: Date.now(), value: {} }; }
    return counts.value;
  }
  async function showFrom() {
    try { const v = await db.getAppSetting('waitlist.showCountFrom'); return Number.isFinite(Number(v)) ? Number(v) : 50; } catch (e) { return 50; }
  }

  async function cardFor(t, { joined, liveOk, threshold, countByKey }) {
    const prize = compStates.prizeWording({ ...t, prize_pool: t.prize_pool_amount });
    const gate = compStates.enterGate(t, { liveOk });
    const count = countByKey[t.key] || 0;
    let sponsor = null;
    try { sponsor = sponsorNameFor ? await sponsorNameFor('competition_card', `competition:${t.key}`) : null; } catch (e) { sponsor = null; }
    const win = schedule.nextWindow(t);
    return {
      key: t.key,
      slug: t.slug || t.key,
      title: t.title,
      scheduleText: t.schedule_text,
      rhythmText: t.rhythm_text,
      lengthText: t.length_text,
      formatHook: t.format_hook,
      rulesLine: t.rules_line,
      state: t.state,
      dataSource: t.data_source,
      prize,
      moneyRules: t.prize_kind === 'money' ? compStates.MONEY_RULE_LINES : [],
      canEnter: gate.ok,
      waitlist: { count: count >= threshold ? count : null, joined },
      detailUrl: `/competitions/${t.slug || t.key}`,
      prizeBreakdown: Array.isArray(t.prize_breakdown) ? t.prize_breakdown : [],
      instruments: Array.isArray(t.instruments) ? t.instruments : [],
      marketsLabel: (t.schedule && t.schedule.marketsLabel) || null,
      nextWindow: win ? { startsAt: win.startsAt.toISOString(), endsAt: win.endsAt.toISOString(), timezone: win.timezone, days: win.days || 1, sessionName: win.sessionName || null } : null,
      sponsorTarget: `competition:${t.key}`,
      hasSponsor: Boolean(sponsor),
    };
  }

  r.get('/api/competition-templates', limiter, async (req, res) => {
    if (!db.isConfigured) return res.json({ templates: [], pageLine: compStates.COMPETITIONS_PAGE_LINE });
    try {
      const [templates, viewerId, liveOk, threshold, countByKey] = await Promise.all([
        db.listCompTemplates(), optionalViewerId(req), liveFeed.canGoLive(db), showFrom(), waitlistCounts(),
      ]);
      const mine = viewerId ? await db.waitlistMine(viewerId).catch(() => []) : [];
      const out = [];
      const sorted = templates.filter(live).sort((x, y) => ORDER.indexOf(x.key) - ORDER.indexOf(y.key));
      for (const t of sorted) out.push(await cardFor(t, { joined: mine.includes(t.key), liveOk, threshold, countByKey }));
      res.json({ templates: out, pageLine: compStates.COMPETITIONS_PAGE_LINE, loggedIn: Boolean(viewerId) });
    } catch (e) {
      // No templates table yet (migration not run): the page simply has no template cards.
      res.json({ templates: [], pageLine: compStates.COMPETITIONS_PAGE_LINE, unavailable: true });
    }
  });

  async function templateFor(v) {
    const all = await db.listCompTemplates();
    return all.find((t) => live(t) && (t.key === v || t.slug === v)) || null;
  }

  r.get('/api/competition-templates/:key', limiter, async (req, res) => {
    if (!/^[a-z-]{3,30}$/.test(req.params.key) || !db.isConfigured) return res.status(404).json({ error: 'Competition not found' });
    try {
      const t = await templateFor(req.params.key);
      if (!t) return res.status(404).json({ error: 'Competition not found' });
      const viewerId = await optionalViewerId(req);
      const mine = viewerId ? await db.waitlistMine(viewerId).catch(() => []) : [];
      const card = await cardFor(t, { joined: mine.includes(t.key), liveOk: await liveFeed.canGoLive(db), threshold: await showFrom(), countByKey: await waitlistCounts() });
      res.json({ template: card, pageLine: compStates.COMPETITIONS_PAGE_LINE, loggedIn: Boolean(viewerId) });
    } catch (e) {
      res.status(404).json({ error: 'Competition not found' });
    }
  });

  r.post('/api/competition-templates/:key/waitlist', limiter, authenticate, async (req, res) => {
    if (!KEY_RE.test(req.params.key)) return res.status(404).json({ error: 'Competition not found' });
    const source = ['card', 'detail', 'email', 'signup'].includes(req.body?.source) ? req.body.source : 'card';
    try {
      const t = await db.getCompTemplate(req.params.key);
      if (!t) return res.status(404).json({ error: 'Competition not found' });
      const { created } = await db.waitlistJoin(req.tokenPlayer.id, t.key, source);
      counts.at = 0;
      if (created) {
        const player = await db.getPlayerById(req.tokenPlayer.id).catch(() => null);
        if (player && player.email) {
          const sponsorName = sponsorNameFor ? await sponsorNameFor('email_footer', `competition:${t.key}`).catch(() => null) : null;
          sendEmail({
            to: player.email,
            idempotencyKey: `waitlist-confirm:${t.key}:${player.id}`,
            ...waitlistConfirmEmail({ username: player.username, title: t.title, hook: t.format_hook, rhythm: t.rhythm_text, link: `${siteUrl(req)}/competitions/${t.slug || t.key}`, sponsorName }),
          }).catch(() => {});
        }
      }
      res.json({ joined: true, created });
    } catch (e) {
      console.error('[waitlist join]', e.message);
      res.status(500).json({ error: 'Could not join the list right now' });
    }
  });

  r.delete('/api/competition-templates/:key/waitlist', limiter, authenticate, async (req, res) => {
    if (!KEY_RE.test(req.params.key)) return res.status(404).json({ error: 'Competition not found' });
    try {
      await db.waitlistLeave(req.tokenPlayer.id, req.params.key);
      counts.at = 0;
      res.json({ joined: false });
    } catch (e) {
      res.status(500).json({ error: 'Could not leave the list right now' });
    }
  });

  // The detail page, with its own title, description and canonical (SEO).
  const fs = require('fs');
  const escAttr = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  r.get('/competitions/:key', async (req, res, next) => {
    const k = req.params.key;
    // old addresses: renamed formats move permanently, discontinued ones go to the page
    if (k in OLD_SLUGS) {
      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      return res.redirect(301, OLD_SLUGS[k] ? `/competitions/${OLD_SLUGS[k]}${qs}` : '/competitions');
    }
    if (!/^[a-z-]{3,30}$/.test(k)) return next();
    let html;
    try { html = fs.readFileSync(path.join(clientDir, 'competition-template.html'), 'utf8'); } catch (e) { return next(); }
    let t = null;
    try { t = db.isConfigured ? await templateFor(k) : null; } catch (e) { t = null; }
    if (!t) return next();
    const title = `${t.title}: free trading competition | Spike & Crush`;
    const prize = compStates.prizeWording({ ...t, prize_pool: t.prize_pool_amount });
    const desc = `${t.format_hook} Free to enter. ${prize.amount ? `${prize.amount} prize pool. ` : ''}${t.schedule_text}. Coming soon.`;
    const canonical = `${siteUrl(req)}/competitions/${t.slug || t.key}`;
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`)
      .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escAttr(desc)}" />\n<link rel="canonical" href="${escAttr(canonical)}" />\n<meta property="og:title" content="${escAttr(title)}" />\n<meta property="og:description" content="${escAttr(desc)}" />\n<meta property="og:url" content="${escAttr(canonical)}" />`);
    res.type('html').send(html);
  });

  return r;
}

module.exports = { createCompTemplatesRouter };
