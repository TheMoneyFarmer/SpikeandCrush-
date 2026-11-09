'use strict';

// Game-screen screenshots for before/after comparison (docs/fire). Logs in,
// starts a Solo match through the real lobby route, waits until it is live and
// shoots the game screen at desktop, phone portrait and phone landscape.
//
//   SHOT_BASE=http://localhost:3091 SHOT_USER=... SHOT_PASS=... SHOT_DIR=docs/fire/after/shots \
//   node scripts/fire/game-shots.js
//
// Also writes layout.json: the bounding boxes of the chart canvas, order ticket,
// card tray and spike strip at each size, so overlap can be checked in numbers.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const BASE = process.env.SHOT_BASE || 'http://localhost:3091';
const DIR = process.env.SHOT_DIR || 'docs/fire/shots';
const SIZES = (process.env.SHOT_SIZES || '1440x900,390x844,844x390,360x780,430x932').split(',').map((s) => s.split('x').map(Number));

const BOXES = {
  chart: '#chartContainer canvas, .tv-lightweight-charts canvas, #chart canvas',
  ticket: '#orderTicket, .order-ticket, #tradePanel, .trade-panel',
  cards: '#cardTray, .card-tray, #cardSlots, .card-slots',
  spike: '#spikeStrip',
  heat: '#heatMeter',
};

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`JS: ${e.message}`));
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.evaluate(async ([u, p]) => {
    const d = await TW.api('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
    await TW.establishSession(d.token, d.refresh_token, d.player);
  }, [process.env.SHOT_USER, process.env.SHOT_PASS]);
  await page.goto(`${BASE}/play`, { waitUntil: 'load' });
  const made = await page.evaluate((mode) => TW.api('/api/match/create', { method: 'POST', body: { mode } }).catch((e) => ({ error: e.message })), process.env.SHOT_MODE || 'solo');
  if (!made.matchId) throw new Error(`create failed: ${JSON.stringify(made)}`);
  await page.goto(`${BASE}/lobby.html?matchId=${made.matchId}`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof currentState !== 'undefined' && currentState, { timeout: 15000 });
  await page.evaluate(() => TW.emitAck('lobby:start_war', {}));
  await page.waitForURL('**/game*', { timeout: 30000 });
  await page.waitForLoadState('load');
  // Let the countdown run out so the live screen (not the countdown) is shot.
  await page.waitForTimeout(Number(process.env.SHOT_WAIT_MS || 6000));
  const layout = {};
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(900);
    const name = `game-${w}x${h}`;
    await page.screenshot({ path: path.join(DIR, `${name}.png`) });
    layout[name] = await page.evaluate((boxes) => {
      const out = { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
      for (const [k, sel] of Object.entries(boxes)) {
        const el = Array.from(document.querySelectorAll(sel)).find((e) => e.offsetParent !== null || e.getClientRects().length);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        out[k] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }
      return out;
    }, BOXES);
  }
  fs.writeFileSync(path.join(DIR, 'layout.json'), `${JSON.stringify({ errors, layout }, null, 2)}\n`);
  await page.evaluate((id) => TW.emitAck('match:leave', { matchId: id }), made.matchId).catch(() => {});
  console.log(JSON.stringify({ errors, layout }, null, 1));
  await browser.close();
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
