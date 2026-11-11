'use strict';

// Competition templates as cards (Daily, Weekly, Weekend, Monthly), the
// "Notify me" waitlist, and each template's detail page. Every word on a card
// comes from the competition_templates row (edited in admin) plus the rules in
// competitionStates.js; the client never decides what a prize says.

const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const compStates = require('./competitionStates');
const liveFeed = require('./liveFeed');
const { waitlistConfirmEmail } = require('./compEmails');

const KEY_RE = /^(daily|weekly|weekend|monthly)$/;
const COUNT_CACHE_MS = 30000;

function createCompTemplatesRouter({ db, authenticate, optionalViewerId, sendEmail, clientDir, siteUrl, sponsorNameFor }) {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
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
    return {
      key: t.key,
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
      detailUrl: `/competitions/${t.key}`,
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
      for (const t of templates) out.push(await cardFor(t, { joined: mine.includes(t.key), liveOk, threshold, countByKey }));
      res.json({ templates: out, pageLine: compStates.COMPETITIONS_PAGE_LINE, loggedIn: Boolean(viewerId) });
    } catch (e) {
      // No templates table yet (migration not run): the page simply has no template cards.
      res.json({ templates: [], pageLine: compStates.COMPETITIONS_PAGE_LINE, unavailable: true });
    }
  });

  r.get('/api/competition-templates/:key', limiter, async (req, res) => {
    if (!KEY_RE.test(req.params.key) || !db.isConfigured) return res.status(404).json({ error: 'Competition not found' });
    try {
      const t = await db.getCompTemplate(req.params.key);
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
            ...waitlistConfirmEmail({ username: player.username, title: t.title, hook: t.format_hook, rhythm: t.rhythm_text, link: `${siteUrl(req)}/competitions/${t.key}`, sponsorName }),
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
    if (!KEY_RE.test(req.params.key)) return next();
    let html;
    try { html = fs.readFileSync(path.join(clientDir, 'competition-template.html'), 'utf8'); } catch (e) { return next(); }
    let t = null;
    try { t = db.isConfigured ? await db.getCompTemplate(req.params.key) : null; } catch (e) { t = null; }
    const title = `${t ? t.title : req.params.key[0].toUpperCase() + req.params.key.slice(1)} | Spike & Crush`;
    const desc = t ? `${t.format_hook} Free to enter. ${t.schedule_text}.` : 'A free-to-enter Spike & Crush trading competition.';
    const canonical = `${siteUrl(req)}/competitions/${req.params.key}`;
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`)
      .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escAttr(desc)}" />\n<link rel="canonical" href="${escAttr(canonical)}" />\n<meta property="og:title" content="${escAttr(title)}" />\n<meta property="og:description" content="${escAttr(desc)}" />\n<meta property="og:url" content="${escAttr(canonical)}" />`);
    res.type('html').send(html);
  });

  return r;
}

module.exports = { createCompTemplatesRouter };
