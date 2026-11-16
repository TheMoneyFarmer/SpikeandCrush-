'use strict';

// Test 7b: the install-the-app flow, manifest and service worker.
//   BASE=http://localhost:3070 ACCTS=... OUT=docs/mobile-landscape/install node scripts/mobile-landscape/install-check.js
const fs = require('fs');
const path = require('path');
const ph = require('./phone');

const BASE = process.env.BASE || 'http://localhost:3070';
const OUT = process.env.OUT || 'docs/mobile-landscape/install';
const accts = require(process.env.ACCTS);
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };
const UA_IOS_CHROME_17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1';
const UA_IOS_CHROME_15 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/110.0.5481.83 Mobile/15E148 Safari/604.1';

// The one-time walkthrough opens the mode sheet on phones; let it start,
// then put the lobby back to its plain state.
async function settle(page) {
  await ph.noTours(page);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { document.querySelectorAll('.tutorial-overlay, .tutorial-spotlight, .tutorial-card').forEach((e) => e.remove()); if (TW.closeModeSheet) TW.closeModeSheet(); });
  await page.waitForTimeout(200);
}

async function lobby(ctx, { clear = true } = {}) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ph.login(page, BASE, accts[0].username, accts[0].password);
  if (clear) await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('tw_pwa')) localStorage.removeItem(k); });
  await page.goto(`${BASE}/play`, { waitUntil: 'load' });
  await settle(page);
  return { page, errors };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await ph.launch();

  // ---- Android Chrome: our card, then the browser's own prompt ----
  {
    const ctx = await ph.phoneContext(browser, { width: 390, height: 844, platform: 'android' });
    const { page, errors } = await lobby(ctx);
    const banner = await page.isVisible('#iaBanner');
    ok('Android: lobby banner shows', banner);
    // the browser offers install: a stand-in beforeinstallprompt event
    await page.evaluate(() => {
      window.__prompted = 0;
      const ev = new Event('beforeinstallprompt', { cancelable: true });
      ev.prompt = () => { window.__prompted += 1; return Promise.resolve(); };
      ev.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(ev);
    });
    await page.click('#iaBanner .ia-bopen');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'android-card-390x844.png') });
    const hasBtn = await page.isVisible('#iaCard .ia-install');
    await page.click('#iaCard .ia-install');
    await page.waitForTimeout(400);
    const prompted = await page.evaluate(() => window.__prompted);
    ok('Android: our card shows "Install app" and it opens the browser prompt', hasBtn && prompted === 1, `prompt() called ${prompted}x`);
    ok('Android: no page errors', !errors.length, errors.join(' | '));
    // dismissals: 3 and the banner stops
    for (let i = 0; i < 3; i++) {
      await page.goto(`${BASE}/play`, { waitUntil: 'load' });
      await settle(page);
      if (await page.isVisible('#iaBanner')) await page.click('#iaBanner .ia-bx');
    }
    await page.goto(`${BASE}/play`, { waitUntil: 'load' });
    await page.waitForTimeout(700);
    ok('banner stops after three dismissals', !(await page.isVisible('#iaBanner')), `dismissed ${await page.evaluate(() => localStorage.getItem('tw_pwa_banner_dismissed'))}x`);
    // result screen: card after the 1st and 3rd match, not the 2nd or 4th
    const shown = await page.evaluate(async () => {
      localStorage.removeItem('tw_pwa_matches');
      const out = [];
      for (let i = 0; i < 4; i++) { const r = TW.Install.afterMatch(document.body, {}); out.push(r.card); }
      return out;
    });
    ok('result screen: card after this phone\'s 1st and 3rd match only', JSON.stringify(shown) === '[true,false,true,false]', JSON.stringify(shown));
    // Don't show again
    await page.evaluate(() => { localStorage.removeItem('tw_pwa_banner_dismissed'); });
    await page.goto(`${BASE}/play`, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    await page.evaluate(() => TW.Install.showCard('banner'));
    await page.click('#iaCard .ia-never');
    await page.goto(`${BASE}/play`, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => ({ banner: Boolean(document.getElementById('iaBanner')), card: TW.Install.afterMatch(document.body, {}).card }));
    ok('"Don\'t show again" stops the banner and the result-screen card', !after.banner && !after.card, JSON.stringify(after));
    // installed start URL lands on the lobby
    const res = await page.goto(`${BASE}/play?source=pwa`, { waitUntil: 'load' });
    ok('start URL /play?source=pwa opens the lobby', res.status() === 200 && /\/play\?source=pwa/.test(page.url()) && await page.isVisible('#modeQuickBtn, .lb-wrap'), page.url());
    await ctx.close();
  }

  // ---- iPhone Safari: the step card ----
  {
    const ctx = await ph.phoneContext(browser, { width: 390, height: 844, platform: 'ios' });
    const { page } = await lobby(ctx);
    await page.click('#iaBanner .ia-bopen');
    await page.waitForTimeout(300);
    const txt = await page.textContent('#iaCard');
    await page.screenshot({ path: path.join(OUT, 'ios-safari-card-390x844.png') });
    ok('iPhone Safari: card shows Share > Add to Home Screen > Add, no install button', /Share/.test(txt) && /Add to Home Screen/.test(txt) && /Tap Add/.test(txt) && !(await page.isVisible('#iaCard .ia-install')), txt.replace(/\s+/g, ' ').slice(0, 140));
    await ctx.close();
  }
  for (const [label, ua, expect] of [['iOS 17 Chrome', UA_IOS_CHROME_17, /Share in this browser/], ['iOS 15 Chrome', UA_IOS_CHROME_15, /in Safari/]]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: ua });
    const { page } = await lobby(ctx);
    await page.evaluate(() => TW.Install.showCard('banner'));
    await page.waitForTimeout(200);
    const txt = await page.textContent('#iaCard');
    ok(`${label}: wording fits the iOS version`, expect.test(txt), txt.replace(/\s+/g, ' ').slice(0, 120));
    await ctx.close();
  }

  // ---- installed (standalone) and desktop: nothing shows ----
  {
    const ctx = await ph.phoneContext(browser, { width: 390, height: 844, platform: 'ios' });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q));
    });
    const { page } = await lobby(ctx);
    const r = await page.evaluate(() => ({ banner: Boolean(document.getElementById('iaBanner')), card: TW.Install.showCard('banner'), after: TW.Install.afterMatch(document.body, {}).card }));
    ok('installed (standalone): no banner, no card', !r.banner && !r.card && !r.after, JSON.stringify(r));
    await ctx.close();
  }
  {
    const ctx = await ph.phoneContext(browser, { width: 1440, height: 900, platform: 'desktop', mobile: false });
    const { page } = await lobby(ctx);
    const r = await page.evaluate(() => ({ banner: Boolean(document.getElementById('iaBanner')), card: TW.Install.showCard('banner'), sw: navigator.serviceWorker && navigator.serviceWorker.controller ? 'controlled' : 'none' }));
    ok('desktop: nothing shows, no service worker', !r.banner && !r.card && r.sw === 'none', JSON.stringify(r));
    await ctx.close();
  }

  // ---- manifest ----
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const m = await (await page.request.get(`${BASE}/site.webmanifest`)).json();
    const icons = await Promise.all(m.icons.map(async (i) => [i.src, i.sizes, i.purpose, (await page.request.get(`${BASE}${i.src}`)).status()]));
    const checks = {
      name: Boolean(m.name), short_name: m.short_name === 'Spike & Crush', start_url: m.start_url === '/play?source=pwa', display: m.display === 'standalone',
      orientation: m.orientation === 'any', colours: /^#/.test(m.theme_color) && /^#/.test(m.background_color),
      icon192: icons.some((i) => i[1] === '192x192' && i[3] === 200), icon512: icons.some((i) => i[1] === '512x512' && i[2] === 'any' && i[3] === 200),
      maskable: icons.some((i) => i[2] === 'maskable' && i[3] === 200), scope: m.scope === '/',
    };
    ok('manifest: installable fields and icons present (Lighthouse 12 dropped its PWA audit, so these are checked directly)', Object.values(checks).every(Boolean), JSON.stringify(checks));
    await ctx.close();
  }

  // ---- service worker: static files only ----
  {
    const ctx = await ph.phoneContext(browser, { width: 390, height: 844, platform: 'android' });
    const { page } = await lobby(ctx, { clear: false });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'load' }); // now controlled by the worker
    await page.waitForTimeout(800);
    const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
    // API, socket, prices traffic while controlled
    await page.evaluate(async () => { await TW.api('/api/player/me').catch(() => {}); await fetch('/api/leaderboard?period=week').catch(() => {}); await fetch('/socket.io/?EIO=4&transport=polling').catch(() => {}); });
    await page.goto(`${BASE}/game.html?matchId=none`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.goto(`${BASE}/play`, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const cached = await page.evaluate(async () => {
      const out = [];
      for (const k of await caches.keys()) { const c = await caches.open(k); for (const r of await c.keys()) out.push(new URL(r.url).pathname + new URL(r.url).search); }
      return out;
    });
    const bad = cached.filter((u) => /^\/(api|socket\.io|internal|auth|admin)|\?|\.html$|^\/play$|^\/game/.test(u) || !/^\/(css|js|icons|fonts|images|img)\//.test(u));
    ok('service worker controls the page and caches static files only (no API, socket, price or page responses)', controlled && cached.length > 0 && !bad.length, `${cached.length} cached${bad.length ? `; not allowed: ${bad.join(', ')}` : `: ${cached.slice(0, 6).join(', ')}...`}`);
    const sw = await (await page.request.get(`${BASE}/sw.js`)).text();
    ok('service worker is versioned per deploy', !sw.includes('__SW_VERSION__') && /sc-shell-/.test(sw), (sw.match(/const VERSION = '([^']+)'/) || [])[1]);
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
