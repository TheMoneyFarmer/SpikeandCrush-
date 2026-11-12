'use strict';

// Admin-panel screenshots for before/after comparison (docs/admin-records).
//
//   SMOKE_ADMIN=http://localhost:3071 SMOKE_ADMIN_USER=... SMOKE_ADMIN_PASS=... \
//   SHOT_DIR=docs/admin-records/baseline/admin node scripts/admin-records/admin-shots.js
//
// Shoots the dashboard, Live matches, Match history and the newest match's
// detail at 1440x900 and 390x844. Extra pages: ADMIN_PAGES=name=/path,name2=/path2
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ADMIN = process.env.SMOKE_ADMIN || 'http://localhost:3071';
const DIR = process.env.SHOT_DIR || 'docs/admin-records/shots';
const SIZES = (process.env.SHOT_SIZES || '1440x900,390x844').split(',').map((s) => s.split('x').map(Number));

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${ADMIN}/login.html`);
  await page.fill('#username', process.env.SMOKE_ADMIN_USER);
  await page.fill('#password', process.env.SMOKE_ADMIN_PASS);
  await page.click('#loginBtn');
  await page.waitForURL('**/dashboard.html', { timeout: 10000 });

  const latest = await page.evaluate(async () => {
    const r = await fetch('/api/matches?limit=1', { credentials: 'include' });
    const j = await r.json();
    const rows = Array.isArray(j) ? j : j.items || [];
    return rows[0] ? rows[0].id : null;
  });
  const pages = [
    ['dashboard', '/dashboard.html'],
    ['live', '/matches.html?tab=live'],
    ['history', '/matches.html?tab=history'],
  ];
  if (latest) pages.push(['match-detail', process.env.DETAIL_PATH ? process.env.DETAIL_PATH.replace(':id', latest) : `/matches.html?tab=history&match=${latest}`]);
  for (const extra of (process.env.ADMIN_PAGES || '').split(',').filter(Boolean)) {
    const [name, p] = extra.split('=');
    pages.push([name, p]);
  }
  for (const [name, p] of pages) {
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${ADMIN}${p}`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(1200);
      const file = path.join(DIR, `${name}-${w}x${h}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log('shot', file);
    }
  }
  console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
