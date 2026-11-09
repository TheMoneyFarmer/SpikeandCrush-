'use strict';
// Loads every new or changed page logged in, at desktop and phone width:
// console errors, horizontal overflow, and a screenshot of each.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const BASE = process.env.SHOT_BASE || 'http://localhost:3091';
const DIR = process.env.SHOT_DIR || 'docs/fire/after/pages';
const PAGES = ['/cards', '/rank', '/discover', '/help', '/privacy', '/settings', '/challenge/invalid.code'];
const IGNORABLE = /cloudflareinsights|status of 401|status of 404|status of 400|favicon|net::ERR_/i;
(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.evaluate(async ([u, p]) => {
    const d = await TW.api('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
    await TW.establishSession(d.token, d.refresh_token, d.player);
  }, [process.env.SHOT_USER, process.env.SHOT_PASS]);
  const out = [];
  for (const url of PAGES) {
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      const errors = [];
      const onErr = (e) => errors.push(`JS: ${e.message}`);
      const onCon = (m) => { if (m.type() === 'error' && !IGNORABLE.test(m.text())) errors.push(m.text()); };
      page.on('pageerror', onErr);
      page.on('console', onCon);
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${BASE}${url}`, { waitUntil: 'load' });
      await page.waitForTimeout(1800);
      const m = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, w: window.innerWidth, text: document.body.innerText.slice(0, 120).replace(/\s+/g, ' ') }));
      const name = `${url.replace(/[^a-z]/gi, '_')}-${w}`;
      await page.screenshot({ path: path.join(DIR, `${name}.png`), fullPage: false });
      page.off('pageerror', onErr);
      page.off('console', onCon);
      out.push({ url, size: `${w}x${h}`, errors, overflow: m.scrollW > m.w, text: m.text });
    }
  }
  console.log(JSON.stringify(out, null, 1));
  const bad = out.filter((r) => r.errors.length || r.overflow);
  console.log(bad.length ? `FAIL ${bad.map((b) => `${b.url}@${b.size}`).join(', ')}` : 'PASS all pages load with no console errors and no horizontal overflow');
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
