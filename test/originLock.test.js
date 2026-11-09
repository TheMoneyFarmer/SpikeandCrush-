'use strict';

// Direct-to-Railway requests are refused; Cloudflare, health checks, the admin
// bridge and local development are not. Uses the real middleware.
const test = require('node:test');
const assert = require('node:assert');
const { originLock, classify, isCloudflareIp, isExempt, currentMode, CLOUDFLARE_V4, CLOUDFLARE_V6 } = require('../server/originLock');

function run(mode, { url = '/', headers = {}, ip } = {}) {
  const before = process.env.ORIGIN_LOCK;
  process.env.ORIGIN_LOCK = mode;
  const out = { nextCalled: false, status: 200, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    end: (b) => { out.status = res.statusCode; out.body = b; },
  };
  originLock()({ url, headers, ip }, res, () => { out.nextCalled = true; });
  if (before === undefined) delete process.env.ORIGIN_LOCK; else process.env.ORIGIN_LOCK = before;
  return out;
}

const VIA_CF = { 'x-forwarded-for': '203.0.113.7, 172.70.1.1' };
const DIRECT = { 'x-forwarded-for': '203.0.113.7' };
const FAKED = { 'x-forwarded-for': '172.70.1.1, 203.0.113.7' };

test('Cloudflare addresses are recognised, others are not', () => {
  for (const ip of ['172.70.1.1', '104.21.56.170', '162.158.0.1', '2606:4700::1', '::ffff:172.70.1.1']) assert.ok(isCloudflareIp(ip), ip);
  for (const ip of ['203.0.113.7', '8.8.8.8', '153.52.255.85', '2001:db8::1', '', 'nonsense', null]) assert.ok(!isCloudflareIp(ip), String(ip));
  assert.strictEqual(CLOUDFLARE_V4.length, 15);
  assert.strictEqual(CLOUDFLARE_V6.length, 7);
});

test('only the last hop counts, so a faked Cloudflare address does not pass', () => {
  assert.strictEqual(classify(VIA_CF), 'cloudflare');
  assert.strictEqual(classify(DIRECT), 'direct');
  assert.strictEqual(classify(FAKED), 'direct');
  assert.strictEqual(classify({ 'x-forwarded-for': 'garbage' }), 'direct');
});

test('no proxy at all is internal: private network, localhost, Railway health checks', () => {
  assert.strictEqual(classify({}), 'internal');
  assert.strictEqual(classify({ host: 'healthcheck.railway.app', 'x-forwarded-for': '10.0.0.1' }), 'internal');
});

test('on: direct is blocked, Cloudflare and internal pass', () => {
  const blocked = run('on', { url: '/api/leaderboard', headers: DIRECT });
  assert.strictEqual(blocked.nextCalled, false);
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual(run('on', { url: '/socket.io/?EIO=4', headers: FAKED }).status, 403);
  assert.strictEqual(run('on', { url: '/api/leaderboard', headers: VIA_CF }).nextCalled, true);
  assert.strictEqual(run('on', { url: '/internal/admin/state' }).nextCalled, true);
});

test('on: health, the admin bridge and the deploy gate always pass', () => {
  for (const url of ['/health', '/ready', '/ready?x=1', '/internal/admin/state', '/internal/support/x', '/api/deploy/status', '/api/deploy/drain']) {
    assert.ok(isExempt(url), url);
    assert.strictEqual(run('on', { url, headers: DIRECT }).nextCalled, true, url);
  }
  for (const url of ['/', '/healthy', '/internalx', '/api/deployer', '/login.html']) assert.ok(!isExempt(url), url);
});

test('report never blocks, and /health shows the result', () => {
  const direct = run('report', { url: '/health', headers: DIRECT, ip: '203.0.113.7' });
  assert.strictEqual(direct.nextCalled, true);
  assert.match(direct.headers['x-origin-check'], /via=direct/);
  const good = run('report', { url: '/health', headers: VIA_CF, ip: '203.0.113.7' });
  assert.strictEqual(good.headers['x-origin-check'], 'via=cloudflare; visitor-ip-ok=true');
  const wrongHops = run('report', { url: '/health', headers: VIA_CF, ip: '172.70.1.1' });
  assert.strictEqual(wrongHops.headers['x-origin-check'], 'via=cloudflare; visitor-ip-ok=false');
  assert.strictEqual(run('report', { url: '/api/x', headers: DIRECT }).nextCalled, true);
});

test('off is the emergency switch, and local development is off by default', () => {
  assert.strictEqual(run('off', { url: '/api/x', headers: DIRECT }).nextCalled, true);
  const env = { lock: process.env.ORIGIN_LOCK, node: process.env.NODE_ENV };
  delete process.env.ORIGIN_LOCK;
  process.env.NODE_ENV = 'development';
  assert.strictEqual(currentMode(), 'off');
  if (env.lock !== undefined) process.env.ORIGIN_LOCK = env.lock;
  if (env.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env.node;
});
