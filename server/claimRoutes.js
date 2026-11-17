'use strict';

// Public prize-claim routes. The token in the link is the only credential;
// only its hash is stored. Tight limits per IP; friendly answers for expired,
// used and broken links. The partner URL never leaves the server: the button
// is /go/c/<token>, which redirects with the IB code added here.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { visitorIp } = require('./originLock');

const BOT_UA = /bot|crawl|spider|preview|facebookexternalhit|slackbot|whatsapp|telegram|discord/i;

function createClaimRouter({ rewards, clientDir }) {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => visitorIp(req) });
  const postLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => visitorIp(req), message: { error: 'Too many attempts. Please wait a few minutes.' } });
  // Never a fixed salt from the source (envCheck.signingSecret).
  const ipHash = (req) => crypto.createHmac('sha256', require('./envCheck').signingSecret('claim-ip', 'IP_HASH_SECRET')).update(String(visitorIp(req))).digest('hex').slice(0, 24);
  const noStore = (res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  };

  r.get('/claim/:token', limiter, (req, res) => {
    noStore(res);
    res.sendFile(path.join(clientDir, 'claim.html'));
  });

  r.get('/api/claims/:token', limiter, async (req, res) => {
    noStore(res);
    try {
      const out = await rewards.claimView(req.params.token);
      if (out.error) return res.status(out.error === 'invalid' ? 404 : 410).json({ error: out.error });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: 'unavailable' });
    }
  });

  r.post('/api/claims/:token', postLimiter, async (req, res) => {
    noStore(res);
    try {
      const out = await rewards.submitClaim(req.params.token, req.body || {}, { ipHash: ipHash(req) });
      if (out.error) {
        const status = { invalid: 404, expired: 410, used: 410, manual: 400, age: 400, country: 400, ineligible: 403 }[out.error] || 400;
        return res.status(status).json({ error: out.error, message: out.message || null });
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: 'unavailable' });
    }
  });

  r.get('/go/c/:token', limiter, async (req, res) => {
    noStore(res);
    try {
      const out = await rewards.goTarget(req.params.token, { ipHash: ipHash(req), bot: BOT_UA.test(String(req.get('user-agent') || '')) });
      res.redirect(302, out.url);
    } catch (e) {
      res.redirect(302, '/competitions');
    }
  });

  return r;
}

module.exports = { createClaimRouter };
