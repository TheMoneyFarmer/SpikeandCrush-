'use strict';

// POST /api/a/collect: the first-party, cookieless collector for client events
// (page views, sign-up started, competition views, install prompts...).
//
//   body: { session_id, anon_id, consent, referrer, utm: { source, medium, campaign, partner },
//           events: [{ name, page, props }] }   (at most 20 events)
//
// Bots are dropped (server/analytics/context.js isBot). A visitor is a daily
// hash of address + browser (rotates every day, never stored raw). anon_id is
// accepted only with consent. A signed-in player's id comes from their token,
// never from the body. Always answers 204 quickly; storage is batched.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { visitorIp } = require('../originLock');
const { CLIENT_EVENTS } = require('./catalogue');
const ctx = require('./context');
const { analytics } = require('./events');

const ID = /^[a-f0-9]{16,40}$/;
const s60 = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null);

function createCollector({ optionalViewerId = async () => null, writer = analytics() } = {}) {
  const r = express.Router();
  const limiter = rateLimit({ keyGenerator: (req) => visitorIp(req), windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
  const stats = { requests: 0, events: 0, bots: 0, rejected: 0 };

  r.post('/api/a/collect', limiter, async (req, res) => {
    stats.requests++;
    res.status(204).end();
    try {
      if (ctx.isBot(req)) { stats.bots++; return; }
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const events = Array.isArray(b.events) ? b.events.slice(0, 20) : [];
      const c = ctx.fromReq(req);
      const userId = await optionalViewerId(req).catch(() => null);
      const consent = b.consent === true;
      const utm = b.utm && typeof b.utm === 'object' ? b.utm : {};
      for (const e of events) {
        const name = e && typeof e.name === 'string' ? e.name : '';
        if (!CLIENT_EVENTS.has(name)) { stats.rejected++; continue; }
        writer.track(name, {
          source: 'client',
          userId,
          anonymousId: consent && ID.test(String(b.anon_id || '')) ? b.anon_id : null,
          sessionId: ID.test(String(b.session_id || '')) ? b.session_id : null,
          visitorDayHash: c.visitor_day_hash,
          page: typeof e.page === 'string' ? e.page : null,
          referrer: typeof b.referrer === 'string' ? b.referrer : null,
          utmSource: s60(utm.source), utmMedium: s60(utm.medium), utmCampaign: s60(utm.campaign), partnerId: s60(utm.partner),
          deviceClass: c.device_class, browserFamily: c.browser_family, country: c.coarse_country,
          props: e.props && typeof e.props === 'object' ? e.props : {},
        });
        stats.events++;
      }
    } catch (err) {
      stats.rejected++;
    }
  });

  return { router: r, stats };
}

module.exports = { createCollector };
