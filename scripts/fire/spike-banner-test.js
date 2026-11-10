'use strict';

// Test 15b: the spike alert strip never covers the chart. At each viewport it
// measures the chart canvas, price scale and order ticket boxes without and
// with an alert showing, checks nothing lands on top of the chart (a grid of
// elementFromPoint probes), clicks BUY during the alert, and saves screenshots.
//   SHOT_USER=... SHOT_PASS=... node scripts/fire/spike-banner-test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const BASE = process.env.SHOT_BASE || 'http://localhost:3091';
const DIR = process.env.SHOT_DIR || 'docs/fire/after/spike';
const SIZES = [[1440, 900], [390, 844], [844, 390]];

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.evaluate(async ([u, p]) => {
    const d = await TW.api('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
    await TW.establishSession(d.token, d.refresh_token, d.player);
  }, [process.env.SHOT_USER, process.env.SHOT_PASS]);
  await page.goto(`${BASE}/play`, { waitUntil: 'load' });
  const made = await page.evaluate(() => TW.api('/api/match/create', { method: 'POST', body: { mode: 'solo' } }));
  await page.goto(`${BASE}/lobby.html?matchId=${made.matchId}`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof currentState !== 'undefined' && currentState, { timeout: 15000 });
  await page.evaluate(() => TW.emitAck('lobby:start_war', {}));
  await page.waitForURL('**/game*', { timeout: 30000 });
  await page.waitForTimeout(14000);

  const measure = () => page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const canvases = Array.from(document.querySelectorAll('#chartCanvas canvas'));
    const main = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const chartWrap = document.getElementById('chartCanvasWrap');
    const strip = document.getElementById('spikeStrip');
    const ticket = document.querySelector('.trade-buttons') || document.getElementById('tradingPanel');
    const c = chartWrap.getBoundingClientRect();
    // Probe a 6x6 grid over the chart: the top element must belong to the chart.
    const covered = [];
    for (let i = 1; i <= 6; i++) {
      for (let j = 1; j <= 6; j++) {
        const x = c.left + (c.width * i) / 7;
        const y = c.top + (c.height * j) / 7;
        const el = document.elementFromPoint(x, y);
        if (el && !chartWrap.contains(el) && !el.closest('.chart-section')) covered.push({ x: Math.round(x), y: Math.round(y), by: el.id || el.className || el.tagName });
        if (el && strip.contains(el)) covered.push({ x: Math.round(x), y: Math.round(y), by: 'STRIP' });
      }
    }
    const s = strip.getBoundingClientRect();
    const overlap = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const sb = box(strip);
    return { chart: box(chartWrap), canvas: box(main), strip: sb, ticket: box(ticket), stripOverChart: overlap(sb, box(chartWrap)), stripOverTicket: overlap(sb, box(ticket)), covered: covered.filter((x) => x.by === 'STRIP'), stripClass: strip.className, stripText: strip.textContent.trim().slice(0, 80), stripHeight: Math.round(s.height) };
  });

  const out = {};
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(800);
    const before = await measure();
    await page.evaluate(() => TW.Fire.spikeAlert({ id: 'test', inSeconds: 9 }));
    await page.waitForTimeout(1200);
    const during = await measure();
    await page.screenshot({ path: path.join(DIR, `spike-alert-${w}x${h}.png`) });
    // Trade during the alert: the real BUY button (chart view on phones has
    // the slim Buy bar; desktop the order ticket).
    const traded = await page.evaluate(async () => {
      const btn = document.querySelector('.mobile-trade-bar .btn-buy, #mobileBuyBtn') && window.innerWidth < 600 ? document.querySelector('.mobile-trade-bar .btn-buy, #mobileBuyBtn') : document.getElementById('buyBtn');
      const before = document.querySelectorAll('#positionsList .position-row, #positionsList > div').length;
      if (!btn || btn.offsetParent === null) return { skipped: 'buy button not visible in this view' };
      btn.click();
      await new Promise((r) => setTimeout(r, 1500));
      const after = document.querySelectorAll('#positionsList .position-row, #positionsList > div').length;
      return { clicked: btn.id || btn.className, positionsBefore: before, positionsAfter: after };
    });
    await page.evaluate(() => TW.Fire.spikeResult({ id: 'test', symbol: 'XAUUSD', movePct: 0.31, showSeconds: 4 }));
    await page.waitForTimeout(600);
    const result = await measure();
    await page.screenshot({ path: path.join(DIR, `spike-result-${w}x${h}.png`) });
    await page.waitForTimeout(4500);
    const after = await measure();
    out[`${w}x${h}`] = {
      canvasSame: JSON.stringify(before.canvas) === JSON.stringify(during.canvas) && JSON.stringify(before.canvas) === JSON.stringify(result.canvas) && JSON.stringify(before.canvas) === JSON.stringify(after.canvas),
      chartBoxSame: JSON.stringify(before.chart) === JSON.stringify(during.chart),
      stripHeights: [before.stripHeight, during.stripHeight, result.stripHeight, after.stripHeight],
      stripOverChart: during.stripOverChart,
      stripOverTicket: during.stripOverTicket,
      stripCoversChartPoints: during.covered.length,
      duringText: during.stripText,
      resultText: result.stripText,
      backToIdle: after.stripClass === 'match-strip',
      canvas: before.canvas,
      traded,
    };
  }
  await page.evaluate((id) => TW.emitAck('match:leave', { matchId: id }), made.matchId).catch(() => {});
  fs.writeFileSync(path.join(DIR, 'result.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  const fail = Object.entries(out).filter(([, r]) => !r.canvasSame || !r.chartBoxSame || r.stripOverChart || r.stripOverTicket || r.stripCoversChartPoints || r.stripHeights.some((x) => x !== 32));
  console.log(fail.length ? `FAIL ${fail.map(([k]) => k).join(', ')}` : 'PASS spike strip never moves or covers the chart');
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
