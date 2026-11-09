'use strict';

// Public traffic must come through Cloudflare. Without this, a request sent
// straight to Railway with our Host header skips Cloudflare's protection and can
// fake its IP to dodge rate limits (TRUST_PROXY_HOPS=2 trusts one more hop).
//
// Railway replaces X-Forwarded-For with exactly two entries: the address that
// connected to it, then its own edge. Whatever a caller sends is thrown away, so
// the FIRST entry can't be faked (checked on the live site: a made-up header sent
// straight to Railway never reaches us). It's the check: Cloudflare's ranges pass,
// anything else is direct. Any other shape isn't trusted, so if Railway ever stops
// replacing the header this fails closed instead of believing a caller.
//
// ORIGIN_LOCK=on blocks direct requests, =report only labels /health with the
// result, =off does nothing (the emergency switch). Default: DEFAULT_MODE in
// production, off elsewhere.
// With ORIGIN_SECRET set, a request is only "through Cloudflare" if it carries the
// secret header a Cloudflare Transform Rule adds (X-Origin-Secret). Nobody can fake
// that, unlike guessing from addresses, so it is the check to rely on when it's set.
const crypto = require('crypto');
const net = require('net');

const DEFAULT_MODE = 'report';

const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

// Paths with their own secret or that Railway's health checks and the deploy gate
// need, so a wrong answer here can never stop a deploy or the admin bridge.
const EXEMPT_PATHS = [/^\/health$/, /^\/ready$/, /^\/internal(\/|$)/, /^\/api\/deploy(\/|$)/];

const ranges = new net.BlockList();
function addRange(cidr) {
  const [ip, bits] = String(cidr).trim().split('/');
  const family = net.isIP(ip);
  if (!family || !/^\d+$/.test(bits || '')) return false;
  ranges.addSubnet(ip, Number(bits), family === 6 ? 'ipv6' : 'ipv4');
  return true;
}
CLOUDFLARE_V4.forEach(addRange);
CLOUDFLARE_V6.forEach(addRange);

function isCloudflareIp(ip) {
  const clean = String(ip || '').trim().replace(/^::ffff:/, '');
  const family = net.isIP(clean);
  if (!family) return false;
  return ranges.check(clean, family === 6 ? 'ipv6' : 'ipv4');
}

// 'cloudflare', 'direct', or 'internal' (no proxy involved: private network,
// localhost, Railway's health checker).
const RAILWAY_HOPS = 2;
function forwardedHops(headers = {}) {
  return String(headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function hasOriginSecret(headers = {}) {
  const expected = process.env.ORIGIN_SECRET;
  const given = headers['x-origin-secret'];
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function classify(headers = {}) {
  if (String(headers.host || '').split(':')[0] === 'healthcheck.railway.app') return 'internal';
  const forwarded = headers['x-forwarded-for'];
  if (!forwarded) return 'internal';
  if (process.env.ORIGIN_SECRET) return hasOriginSecret(headers) ? 'cloudflare' : 'direct';
  const hops = forwardedHops(headers);
  return hops.length === RAILWAY_HOPS && isCloudflareIp(hops[0]) ? 'cloudflare' : 'direct';
}

// The real visitor's IP, for rate limits, ip hashes and logs. Cloudflare's header is
// only believed when the request provably came through Cloudflare (see classify), so
// it can't be faked by going direct. Doesn't use req.ip, which on Railway is its edge
// address, shared by everyone connecting through that edge.
function visitorIp(req) {
  const headers = req.headers || {};
  if (classify(headers) === 'cloudflare') {
    const ip = String(headers['cf-connecting-ip'] || '').trim();
    if (net.isIP(ip)) return ip;
  }
  const hops = forwardedHops(headers);
  if (hops.length === RAILWAY_HOPS && net.isIP(hops[0])) return hops[0];
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function originReport(req, mode, via) {
  const headers = req.headers || {};
  const hops = forwardedHops(headers);
  const cfHops = hops.map((h, i) => (isCloudflareIp(h) ? i + 1 : 0)).filter(Boolean);
  const visitorIpOk = via !== 'cloudflare' || !isCloudflareIp(visitorIp(req));
  return [
    `mode=${mode}`,
    `via=${via}`,
    `visitor-ip-ok=${visitorIpOk}`,
    `hops=${hops.length}`,
    `cloudflare-hops=${cfHops.join('+') || 'none'}`,
    `cf-header=${net.isIP(String(headers['cf-connecting-ip'] || '').trim()) ? 'yes' : 'no'}`,
    `cf-ray=${headers['cf-ray'] ? 'yes' : 'no'}`,
    `secret=${process.env.ORIGIN_SECRET ? (hasOriginSecret(headers) ? 'ok' : 'missing') : 'unset'}`,
    `x-real-ip=${headers['x-real-ip'] ? 'yes' : 'no'}`,
  ].join('; ');
}

function currentMode() {
  const set = String(process.env.ORIGIN_LOCK || '').toLowerCase();
  if (['on', 'report', 'off'].includes(set)) return set;
  return process.env.NODE_ENV === 'production' ? DEFAULT_MODE : 'off';
}

function isExempt(url) {
  const path = String(url || '').split('?')[0];
  return EXEMPT_PATHS.some((re) => re.test(path));
}

// Works for Express and for Socket.io's engine, which pass plain Node requests.
function originLock() {
  return (req, res, next) => {
    const mode = currentMode();
    const via = classify(req.headers);
    if (String(req.url || '').split('?')[0] === '/health') {
      // Lets the setup be checked from outside. Labels and counts only, never an address.
      res.setHeader('X-Origin-Check', originReport(req, mode, via));
    }
    if (mode === 'off') return next();
    if (mode === 'on' && via === 'direct' && !isExempt(req.url)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Please use https://www.spikeandcrush.com' }));
    }
    return next();
  };
}

// Cloudflare rarely adds ranges. Adding the published list can only let more of
// Cloudflare through, and if the fetch fails the built-in list still applies.
async function refreshCloudflareRanges() {
  for (const url of ['https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) (await res.text()).split('\n').filter((line) => line.includes('/')).forEach(addRange);
    } catch (e) {
      console.warn('[origin-lock] could not refresh Cloudflare ranges:', e.message);
    }
  }
}

function startRangeRefresh() {
  if (currentMode() === 'off') return;
  refreshCloudflareRanges();
  setInterval(refreshCloudflareRanges, 24 * 60 * 60 * 1000).unref();
}

module.exports = { originLock, startRangeRefresh, visitorIp, classify, isCloudflareIp, isExempt, currentMode, CLOUDFLARE_V4, CLOUDFLARE_V6 };
