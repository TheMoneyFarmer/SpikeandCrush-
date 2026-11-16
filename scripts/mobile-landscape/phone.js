'use strict';

// Shared Playwright helpers for the phone landscape checks: a phone-like
// browser context (touch, mobile, real user agent), login, and a live Solo
// match on the game screen.
const { chromium } = require('playwright-core');

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};

async function launch() {
  return chromium.launch({ channel: 'chrome', headless: true });
}

async function phoneContext(browser, { width = 844, height = 390, platform = 'android', mobile = true } = {}) {
  return browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: mobile ? 3 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: UA[platform] || UA.android,
  });
}

async function login(page, base, user, pass) {
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.evaluate(async ([u, p]) => {
    const d = await TW.api('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
    await TW.establishSession(d.token, d.refresh_token, d.player);
  }, [user, pass]);
}

// Hide one-off walkthroughs; they are per account and not what is tested.
async function noTours(page) {
  await page.addStyleTag({ content: '.tutorial-overlay,.tutorial-spotlight,.tutorial-card,.tw-tour,.match-rules,.match-rules-overlay{display:none!important}' }).catch(() => {});
}

async function startMatch(page, base, mode = 'solo') {
  await page.goto(`${base}/play`, { waitUntil: 'load' });
  const made = await page.evaluate((m) => TW.api('/api/match/create', { method: 'POST', body: { mode: m } }).catch((e) => ({ error: e.message })), mode);
  if (!made.matchId) throw new Error(`create failed: ${JSON.stringify(made)}`);
  await page.goto(`${base}/lobby.html?matchId=${made.matchId}`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof currentState !== 'undefined' && currentState, { timeout: 15000 });
  await page.evaluate(() => TW.emitAck('lobby:start_war', {}));
  await page.waitForURL('**/game*', { timeout: 30000 });
  await page.waitForLoadState('load');
  await noTours(page);
  await page.waitForFunction(() => window.TW && TW.Game && TW.Game.state().instruments.length && Object.keys(TW.Game.state().prices).length, { timeout: 30000 });
  await page.waitForTimeout(1500);
  return made.matchId;
}

// Forfeit the test match (from the game page, once it has re-joined).
async function leave(page, matchId) {
  try {
    if (!/game\.html/.test(page.url())) await page.goto(page.url().split('/').slice(0, 3).join('/') + `/game.html?matchId=${matchId}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.TW && TW.Game && TW.Game.state().you && TW.socket && TW.socket.connected, { timeout: 15000 });
    await page.waitForTimeout(500);
    await page.evaluate((id) => TW.emitAck('match:leave', { matchId: id }), matchId);
  } catch (e) { /* the match may already be over */ }
}

module.exports = { UA, launch, phoneContext, login, noTours, startMatch, leave };
