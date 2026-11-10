'use strict';

// Launch smoke test: drives the real site in headless Chrome and records pass/fail.
//
//   SMOKE_BASE=http://localhost:3080 SMOKE_ADMIN=http://localhost:3081 \
//   SMOKE_USER=... SMOKE_PASS=... SMOKE_ADMIN_USER=... SMOKE_ADMIN_PASS=... \
//   SMOKE_SHOTS=docs/launch/before node scripts/smoke.js
//
// Point it at a local server on the dev database, never at production: it logs in,
// starts a Solo match and places a trade. Needs playwright-core and Google Chrome.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
const ADMIN = process.env.SMOKE_ADMIN;
const SHOTS = process.env.SMOKE_SHOTS;
const results = [];

async function step(name, fn) {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note || '' });
    console.log(`PASS ${name}${note ? ` (${note})` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, note: e.message.split('\n')[0].slice(0, 160) });
    console.log(`FAIL ${name}: ${e.message.split('\n')[0].slice(0, 160)}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// Noise that isn't a site bug: failed third-party beacons and expected auth refusals.
const IGNORABLE = /cloudflareinsights|status of 401|status of 404|favicon|net::ERR_/i;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  let errors = [];
  page.on('pageerror', (e) => errors.push(`JS: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORABLE.test(m.text())) errors.push(m.text()); });
  const shot = async (name, width, height, url) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const p = await ctx.newPage();
    await p.setViewportSize({ width, height });
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForTimeout(1500);
    await p.screenshot({ path: path.join(SHOTS, `${name}-${width}x${height}.png`) });
    await p.close();
  };
  const sizes = [[1440, 900], [390, 844]];

  await step('landing page loads with no console errors', async () => {
    errors = [];
    const r = await page.goto(`${BASE}/`, { waitUntil: 'load' });
    assert(r.status() === 200, `status ${r.status()}`);
    await page.waitForTimeout(800);
    assert(errors.length === 0, errors[0] || 'errors');
  });
  for (const [w, h] of sizes) await shot('landing', w, h, `${BASE}/`);

  await step('login works with the test account', async () => {
    assert(process.env.SMOKE_USER, 'SMOKE_USER not set');
    await page.evaluate(async ([username, password]) => {
      const d = await TW.api('/api/auth/login', { method: 'POST', body: { username, password } });
      await TW.establishSession(d.token, d.refresh_token, d.player);
    }, [process.env.SMOKE_USER, process.env.SMOKE_PASS]);
    assert(await page.evaluate(() => Boolean(TW.getToken())), 'no token');
  });

  for (const [w, h] of sizes) {
    await step(`lobby loads at ${w}x${h}`, async () => {
      errors = [];
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${BASE}/play`, { waitUntil: 'load' });
      await page.waitForSelector('#modeQuickBtn', { state: 'attached', timeout: 8000 });
      await page.waitForTimeout(600);
      assert(!errors.some((e) => e.startsWith('JS:')), errors[0] || 'errors');
    });
    await shot('lobby', w, h, `${BASE}/play`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await step('competitions page loads', async () => {
    errors = [];
    const r = await page.goto(`${BASE}/competitions`, { waitUntil: 'load' });
    assert(r.status() === 200, `status ${r.status()}`);
    await page.waitForTimeout(600);
    assert(!errors.some((e) => e.startsWith('JS:')), errors[0] || 'errors');
  });
  for (const [w, h] of sizes) await shot('competitions', w, h, `${BASE}/competitions`);

  await step('socket connects and reconnects', async () => {
    await page.goto(`${BASE}/help`, { waitUntil: 'load' });
    const out = await page.evaluate(() => new Promise((resolve) => {
      const s = TW.connectSocket(true);
      const timer = setTimeout(() => resolve('timeout'), 8000);
      const onFirst = () => {
        s.off('connect', onFirst);
        s.once('connect', () => { clearTimeout(timer); resolve('reconnected'); });
        s.disconnect();
        s.connect();
      };
      if (s.connected) onFirst(); else s.on('connect', onFirst);
    }));
    assert(out === 'reconnected', out);
  });

  await step('a Solo match starts and a trade opens and closes', async () => {
    await page.goto(`${BASE}/play`, { waitUntil: 'load' });
    const made = await page.evaluate(() => TW.api('/api/match/create', { method: 'POST', body: { mode: 'solo' } }));
    // The real route: the lobby, Start War, then the game screen.
    await page.goto(`${BASE}/lobby.html?matchId=${made.matchId}`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof currentState !== 'undefined' && currentState, { timeout: 12000 });
    await page.evaluate(() => TW.emitAck('lobby:start_war', {}));
    await page.waitForURL('**/game*', { timeout: 30000 });
    await page.waitForLoadState('load');
    for (const [w, h] of sizes) await shot('game', w, h, page.url());
    // The game page's socket connects ~150ms after load; the match is already
    // live by then. Wait for it like a player's first click would.
    await page.waitForFunction(() => window.TW && TW.socket && TW.socket.connected, { timeout: 15000 });
    const out = await page.evaluate(async (id) => {
      await TW.emitAck('player:join', { matchId: id });
      let m;
      for (let i = 0; i < 45; i++) {
        m = await (await fetch(`/api/match/${id}`)).json();
        if (m.status === 'active') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (m.status !== 'active') return { error: `status stayed ${m.status}` };
      const opened = await TW.emitAck('trade:open', { symbol: m.instruments[0], direction: 'BUY', lots: 0.01 });
      if (!opened.success) return { error: `open: ${opened.error}` };
      const closed = await TW.emitAck('trade:close', { positionId: opened.position.id });
      if (!closed.success) return { error: `close: ${closed.error}` };
      const left = await TW.emitAck('match:leave', { matchId: id });
      return { symbol: m.instruments[0], left: left.success };
    }, made.matchId);
    assert(!out.error, out.error);
    return `traded ${out.symbol}`;
  });

  await step('support widget opens', async () => {
    await page.goto(`${BASE}/help`, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const opened = await page.evaluate(() => {
      const b = document.querySelector('[id^="sw"][id*="auncher"], #swLauncher, .sw-launcher, [class*="support"][class*="launcher"]');
      if (!b) return false;
      b.click();
      return true;
    });
    assert(opened, 'launcher not found');
  });

  if (ADMIN) {
    await step('admin login page loads', async () => {
      const r = await page.goto(`${ADMIN}/login.html`, { waitUntil: 'load' });
      assert(r.status() === 200, `status ${r.status()}`);
      assert(await page.$('#loginForm'), 'no form');
    });
    await step('an admin can log in', async () => {
      assert(process.env.SMOKE_ADMIN_USER, 'SMOKE_ADMIN_USER not set');
      await page.fill('#username', process.env.SMOKE_ADMIN_USER);
      await page.fill('#password', process.env.SMOKE_ADMIN_PASS);
      await page.click('#loginBtn');
      await page.waitForURL('**/dashboard.html', { timeout: 10000 });
    });
    for (const [w, h] of sizes) await shot('admin', w, h, `${ADMIN}/dashboard.html`);
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (process.env.SMOKE_JSON) fs.writeFileSync(process.env.SMOKE_JSON, `${JSON.stringify(results, null, 2)}\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
