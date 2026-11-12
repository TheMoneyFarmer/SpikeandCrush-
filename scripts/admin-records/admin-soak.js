'use strict';

// Admin Live matches soak: keep the page open (socket refresh every 5 s) and
// sample its socket listener count, DOM size and JS heap, plus the admin
// server's own socket count. Flat numbers = no listener or timer growth.
//
//   SMOKE_ADMIN=http://localhost:3071 SMOKE_ADMIN_USER=... SMOKE_ADMIN_PASS=... MINUTES=10 \
//   node scripts/admin-records/admin-soak.js
const { chromium } = require('playwright-core');

const ADMIN = process.env.SMOKE_ADMIN || 'http://localhost:3071';
const MINUTES = Number(process.env.MINUTES || 10);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-precise-memory-info'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${ADMIN}/login.html`);
  await page.fill('#username', process.env.SMOKE_ADMIN_USER);
  await page.fill('#password', process.env.SMOKE_ADMIN_PASS);
  await page.click('#loginBtn');
  await page.waitForURL('**/dashboard.html');
  await page.goto(`${ADMIN}/matches.html?tab=live`, { waitUntil: 'networkidle' });
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < MINUTES * 60000) {
    const s = await page.evaluate(() => ({
      listeners: Admin.socket ? Object.values(Admin.socket._callbacks || {}).reduce((a, l) => a + l.length, 0) : null,
      rows: document.querySelectorAll('#liveTable tbody tr').length,
      nodes: document.getElementsByTagName('*').length,
      heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e5) / 10 : null,
    }));
    samples.push({ t: Math.round((Date.now() - t0) / 1000), ...s });
    await page.waitForTimeout(30000);
  }
  const first = samples[1] || samples[0];
  const last = samples[samples.length - 1];
  console.log(JSON.stringify(samples));
  console.log(`listeners ${first.listeners} -> ${last.listeners}, DOM nodes ${first.nodes} -> ${last.nodes}, heap ${first.heapMb} -> ${last.heapMb} MB over ${MINUTES} min`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
