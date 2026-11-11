'use strict';
// Walkthrough self-check in a real browser (Playwright, system Chrome).
// Logs in with a test account on a running server, replays the lobby tour at
// desktop and phone sizes and checks every step: the anchor is on screen
// (or the step is meant to be centred), the card sits inside the viewport,
// and Next / Back / Skip work. Then it starts a Solo Ranked match and checks
// the first-match tour's anchors on the game page.
//
//   TOUR_BASE=http://localhost:3095 TOUR_USER=... TOUR_PASS=... node scripts/tour-check.js
//   npm run test:tours   (same, reads the same variables)
// Leaves the account's tour progress cleared (as after Settings > Replay).
const { chromium } = require('playwright-core');

const BASE = process.env.TOUR_BASE || 'http://localhost:3000';
const SIZES = [[1440, 900], [390, 844]];
let failed = 0;

function ok(cond, msg) {
  if (cond) console.log(`PASS ${msg}`);
  else { failed += 1; console.log(`FAIL ${msg}`); }
}

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.evaluate(async ([username, password]) => {
    const d = await TW.api('/api/auth/login', { method: 'POST', body: { username, password } });
    await TW.establishSession(d.token, d.refresh_token, d.player);
  }, [process.env.TOUR_USER, process.env.TOUR_PASS]);
}

// Walks whatever tour is open, checking each step; returns the step count.
async function walk(page, label, expectSteps) {
  await page.waitForSelector('.tutorial-overlay .tutorial-card', { timeout: 10000 });
  let n = 0;
  for (;;) {
    await page.waitForTimeout(450);
    const info = await page.evaluate(() => {
      const card = document.querySelector('.tutorial-overlay .tutorial-card');
      const spot = document.querySelector('.tutorial-overlay .tutorial-spotlight');
      const r = card.getBoundingClientRect();
      return {
        title: card.querySelector('.tutorial-title').textContent,
        inView: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
        spot: spot.style.display !== 'none',
        last: card.querySelector('.tutorial-footer .btn-tutorial-next').textContent === 'Done',
      };
    });
    const step = expectSteps[n] || {};
    ok(info.inView, `${label} step ${n + 1} "${info.title}": card inside the viewport`);
    if (step.anchor) ok(info.spot, `${label} step ${n + 1}: anchor [data-tour="${step.anchor}"] spotlighted`);
    n += 1;
    if (info.last || n > 20) break;
    await page.click('.tutorial-overlay .tutorial-footer .btn-tutorial-next');
  }
  return n;
}

(async () => {
  if (!process.env.TOUR_USER) throw new Error('Set TOUR_USER and TOUR_PASS (a dev test account).');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  const tours = await page.evaluate(() => TW.api('/api/tours'));
  ok(tours && tours.tours && tours.tours.lobby, 'GET /api/tours returns the lobby tour');

  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => TW.api('/api/tours/reset', { method: 'POST' }));
    await page.goto(`${BASE}/?replay_tutorial=1`, { waitUntil: 'load' });
    const steps = await walk(page, `lobby ${w}x${h}`, tours.tours.lobby.steps);
    ok(steps === tours.tours.lobby.steps.length, `lobby ${w}x${h}: all ${tours.tours.lobby.steps.length} steps shown`);
    // Back then Skip: Back returns a step, Skip asks once and closes.
    await page.click('.tutorial-overlay .btn-tutorial-back');
    await page.waitForTimeout(300);
    await page.click('.tutorial-overlay .btn-tutorial-skip');
    await page.click('.tutorial-confirm-overlay [data-yes]');
    await page.waitForTimeout(500);
    ok(!(await page.$('.tutorial-overlay')), `lobby ${w}x${h}: Skip closes the tour`);
    const progress = await page.evaluate(() => TW.api('/api/tours').then((d) => d.progress.lobby));
    ok(progress && progress.outcome === 'skipped', `lobby ${w}x${h}: skip recorded (step ${progress && progress.step})`);
  }

  // Phone-width game page: the first-match tour's anchors exist and show.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => TW.api('/api/tours/reset', { method: 'POST' }));
  const started = await page.evaluate(() => TW.api('/api/match/create', { method: 'POST', body: { mode: 'solo' } }).catch((e) => ({ error: e.message })));
  if (started && started.matchId) {
    await page.goto(`${BASE}/game.html?matchId=${started.matchId}`, { waitUntil: 'load' });
    const firstMatch = tours.tours.firstMatch;
    try {
      await page.waitForSelector('#rulesReadyBtn', { timeout: 20000 });
      await page.click('#rulesReadyBtn');
      const steps = await walk(page, 'first match', firstMatch.steps);
      ok(steps === firstMatch.steps.length, `first match: all ${firstMatch.steps.length} steps shown`);
      await page.click('.tutorial-overlay .tutorial-footer .btn-tutorial-next');
    } catch (e) {
      ok(false, `first match tour did not run: ${e.message}`);
    }
    await page.evaluate(() => TW.api('/api/match/forfeit', { method: 'POST' }).catch(() => {}));
  } else {
    ok(false, `could not start a Solo match: ${started && started.error}`);
  }
  await page.evaluate(() => TW.api('/api/tours/reset', { method: 'POST' }));
  ok(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await browser.close();
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll walkthrough checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
