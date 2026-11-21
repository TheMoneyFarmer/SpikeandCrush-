'use strict';

// Bots try known secret and admin paths on every site (/.env, /.git, /wp-admin,
// *.php, *.sql). This answers them with a fast plain 404 before any other work,
// counts them per visitor (hashed, never the raw IP) into Tech health, and
// blocks a visitor that keeps probing for a while. Nothing a real player ever
// requests matches these paths.

const crypto = require('crypto');

const PROBE = /(^|\/)\.(env|git|svn|hg|aws|ssh|htaccess|htpasswd|ds_store|npmrc|docker)|\/(wp-admin|wp-login|wp-content|wp-includes|xmlrpc|phpmyadmin|pma|cgi-bin|vendor\/phpunit|actuator|solr|\.well-known\/acme-challenge\/\.\.)|\.(php\d?|asp|aspx|jsp|sql|bak|old|swp|tar|tgz|7z|rar|zip|gz)(\?|$)|\/(backup|dump|database|db)\.(sql|zip|tar|gz)/i;

function isProbe(url) {
  const path = String(url || '').split('?')[0];
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch (e) {
    // a malformed address is checked as sent
  }
  return PROBE.test(path) || PROBE.test(decoded);
}

function createProbeGuard({
  blockAfter = Number(process.env.PROBE_BLOCK_AFTER) || 20, // probes per window before blocking
  windowMs = 10 * 60 * 1000,
  blockMs = 15 * 60 * 1000,
  visitorIp = (req) => req.ip,
  onProbe = () => {}, // (ipHash, path) for Tech health
  now = () => Date.now(),
} = {}) {
  const hits = new Map(); // ip hash -> [timestamps]
  const blocked = new Map(); // ip hash -> until
  const salt = process.env.IP_HASH_SECRET || crypto.randomBytes(16).toString('hex');
  const hashIp = (ip) => crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);

  function middleware(req, res, next) {
    const url = req.originalUrl || req.url || '';
    if (/^\/(health|ready)$/.test(url.split('?')[0])) return next();
    const key = hashIp(visitorIp(req));
    const until = blocked.get(key);
    if (until && until > now()) {
      res.statusCode = 429;
      res.setHeader('Retry-After', String(Math.ceil((until - now()) / 1000)));
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Too many requests');
    }
    if (until) blocked.delete(key);
    if (!isProbe(url)) return next();

    const list = (hits.get(key) || []).filter((t) => t > now() - windowMs);
    list.push(now());
    hits.set(key, list);
    if (hits.size > 50000) hits.clear();
    if (list.length >= blockAfter) blocked.set(key, now() + blockMs);
    try {
      onProbe(key, url.split('?')[0].slice(0, 120), list.length >= blockAfter);
    } catch (e) {
      // counting must never break a response
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Not found');
  }

  return { middleware, isBlocked: (ip) => (blocked.get(hashIp(ip)) || 0) > now(), stats: () => ({ watched: hits.size, blocked: blocked.size }) };
}

module.exports = { createProbeGuard, isProbe };
