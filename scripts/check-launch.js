'use strict';

// The launch checklist tests, against a running local server. Prints a line per check.
//   SMOKE_BASE=http://localhost:3080 SMOKE_ADMIN=http://localhost:3081 COMP_ID=<real id> node scripts/check-launch.js
const { chromium } = require('playwright-core');
const { PAGES, isNoindexPath } = require('../server/seoConfig');

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
const ADMIN = process.env.SMOKE_ADMIN;
let failed = 0;
function row(name, ok, note = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? ` (${note})` : ''}`);
}
const html = { accept: 'text/html,application/xhtml+xml' };
const get = (url, headers = html) => fetch(url, { redirect: 'manual', headers });

const PUBLIC = ['/', '/competitions', '/leaderboard', '/help', '/sponsor', '/contact', '/terms', '/privacy', '/cookies', '/responsible'];
const WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920];

(async () => {
  // ---- errors --------------------------------------------------------------
  let r = await get(`${BASE}/no/such/page`);
  let body = await r.text();
  row('unknown page: branded 404', r.status === 404 && body.includes('This page went down.'), String(r.status));
  row('404 carries noindex', /noindex/.test(r.headers.get('x-robots-tag') || ''));
  r = await get(`${BASE}/api/nope`, { accept: 'application/json' });
  row('unknown api: JSON 404', r.status === 404 && (r.headers.get('content-type') || '').includes('json'), String(r.status));
  r = await get(`${BASE}/js/nope.js`, { accept: '*/*' });
  row('missing script: plain 404, not the page', r.status === 404 && !(await r.text()).includes('<html'), String(r.status));
  r = await get(`${BASE}/socket.io/?EIO=4&transport=polling`, { accept: '*/*' });
  row('socket.io still answers', r.status === 200, String(r.status));
  for (const p of ['/robots.txt', '/sitemap.xml', '/health', '/ready']) {
    r = await get(`${BASE}${p}`, { accept: '*/*' });
    row(`${p} answers`, r.status === 200, String(r.status));
  }
  for (const p of ['/r/nosuchcode', '/invite/AAAAAAAA']) {
    r = await get(`${BASE}${p}`);
    row(`${p} still redirects`, r.status === 302 && /noindex/.test(r.headers.get('x-robots-tag') || ''), String(r.status));
  }
  if (process.env.COMP_ID) {
    r = await get(`${BASE}/competition/${process.env.COMP_ID}`);
    body = await r.text();
    row('real competition: own title, indexable', r.status === 200 && !/<title>Competition \|/.test(body) && !/name="robots"/.test(body), (body.match(/<title>(.*?)<\/title>/) || [])[1]);
    row('real competition: coins, no currency', /coins/i.test((body.match(/name="description" content="([^"]*)/) || [])[1] || '') && !/\$/.test((body.match(/name="description" content="([^"]*)/) || [])[1] || ''));
  }
  r = await get(`${BASE}/competition/not-a-real-id`);
  body = await r.text();
  row('bad competition: friendly 404', r.status === 404 && body.includes('Competition not found.'), String(r.status));
  r = await get(`${BASE}/competition/00000000-0000-4000-8000-000000000000`);
  body = await r.text();
  row('missing competition: friendly 404', r.status === 404 && body.includes('Competition not found.'), String(r.status));

  // ---- robots, sitemap -----------------------------------------------------
  const robots = await (await get(`${BASE}/robots.txt`, { accept: '*/*' })).text();
  row('robots blocks api, thanks, invite and names the sitemap', ['/api/', '/thanks', '/invite/', '/r/', 'Sitemap: https://www.spikeandcrush.com/sitemap.xml'].every((x) => robots.includes(x)));
  const sitemap = await (await get(`${BASE}/sitemap.xml`, { accept: '*/*' })).text();
  const locs = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  row('sitemap has only https www URLs', locs.length > 0 && locs.every((l) => l.startsWith('https://www.spikeandcrush.com')), `${locs.length} urls`);
  row('sitemap has no noindex pages', locs.every((l) => !isNoindexPath(new URL(l).pathname)));
  row('sitemap includes competitions', locs.some((l) => l.includes('/competition/')));

  // ---- tags on every page ----------------------------------------------------
  for (const [file, page] of Object.entries(PAGES)) {
    const f = await (await get(`${BASE}/${file}`)).text();
    const count = (re) => (f.match(re) || []).length;
    const problems = [];
    if (count(/<title>/g) !== 1) problems.push('title');
    if (count(/name="description"/g) !== 1) problems.push('description');
    if (count(/rel="canonical"/g) !== 1) problems.push('canonical');
    if (count(/property="og:image"/g) !== 1) problems.push('og:image');
    if (count(/name="twitter:card"/g) !== 1) problems.push('twitter');
    if (count(/name="theme-color"/g) !== 1) problems.push('theme');
    if (count(/<html[^>]*lang=/g) !== 1) problems.push('lang');
    if (page.title.length > 60) problems.push(`title ${page.title.length}`);
    if (page.description.length > 155) problems.push(`desc ${page.description.length}`);
    if (page.index === Boolean(count(/name="robots"/g))) problems.push('robots');
    if (problems.length) row(`tags: ${file}`, false, problems.join(', '));
  }
  row('tags checked on every page', true, `${Object.keys(PAGES).length} pages`);
  const home = await (await get(`${BASE}/`)).text();
  row('home has one JSON-LD block', (home.match(/application\/ld\+json/g) || []).length === 1);
  r = await get(`${BASE}/og-image.png`, { accept: '*/*' });
  row('share image loads', r.status === 200);
  const manifest = await (await get(`${BASE}/site.webmanifest`, { accept: '*/*' })).json();
  for (const i of manifest.icons) row(`manifest icon ${i.sizes}`, (await get(BASE + i.src, { accept: '*/*' })).status === 200);

  // ---- browser checks ------------------------------------------------------
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  // Call to action inside the first screen.
  for (const [w, h] of [[1440, 900], [1280, 720], [390, 844], [360, 740]]) {
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    await p.goto(`${BASE}/`, { waitUntil: 'load' });
    await p.waitForTimeout(400);
    const box = await p.locator('.hero .btn-primary').first().boundingBox();
    const sec = await p.locator('.hero .btn-ghost').first().boundingBox();
    const inside = (b) => b && b.y >= 0 && b.y + b.height <= h && b.x >= 0 && b.x + b.width <= w;
    row(`CTA above the fold at ${w}x${h}`, inside(box) && inside(sec), box ? `bottom ${Math.round(box.y + box.height)}` : 'not found');
    await p.close();
  }

  // Sticky button, logged out on a phone.
  {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await p.goto(`${BASE}/`, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    const visible = () => p.locator('.sc-sticky-cta').isVisible();
    row('sticky CTA hidden while the hero button shows', !(await visible()));
    await p.evaluate(() => window.scrollTo(0, 1600));
    await p.waitForTimeout(500);
    row('sticky CTA shows after scrolling past it', await visible());
    const launcher = await p.locator('.sw-launcher').first().boundingBox();
    const btn = await p.locator('.sc-sticky-cta button').boundingBox();
    row('sticky CTA does not cover the support button', !launcher || !btn || btn.x + btn.width <= launcher.x, launcher ? 'clear' : 'no launcher');
    await p.close();
    const d = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await d.goto(`${BASE}/`, { waitUntil: 'load' });
    await d.evaluate(() => window.scrollTo(0, 1600));
    await d.waitForTimeout(300);
    row('no sticky CTA on desktop', (await d.locator('.sc-sticky-cta').count()) === 0);
    await d.close();
    const li = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await li.goto(`${BASE}/`, { waitUntil: 'load' });
    await li.evaluate(async ([username, password]) => {
      const d = await TW.api('/api/auth/login', { method: 'POST', body: { username, password } });
      await TW.establishSession(d.token, d.refresh_token, d.player);
    }, [process.env.SMOKE_USER, process.env.SMOKE_PASS]);
    await li.goto(`${BASE}/competitions`, { waitUntil: 'load' });
    await li.waitForTimeout(300);
    row('no sticky CTA when logged in', (await li.locator('.sc-sticky-cta').count()) === 0);
    await li.close();
  }

  // Forms.
  {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await p.goto(`${BASE}/contact`, { waitUntil: 'load' });
    await p.click('#contactSubmit');
    await p.waitForTimeout(150);
    row('contact: empty form marks fields', (await p.locator('[aria-invalid="true"]').count()) === 3);
    row('contact: summary takes focus', await p.evaluate(() => document.activeElement.matches('[data-error-summary]')));
    await p.fill('#contactEmail', 'nope');
    await p.fill('#contactSubject', 'Kept value');
    await p.click('#contactSubmit');
    await p.waitForTimeout(150);
    row('contact: bad email message, values kept', (await p.textContent('#contactEmail-error')).includes('valid email') && (await p.inputValue('#contactSubject')) === 'Kept value');
    await p.fill('#contactEmail', 'launch-check@example.invalid');
    await p.fill('#contactMessage', 'Launch check message, please ignore.');
    let posts = 0;
    await p.route('**/api/support/ticket', async (route) => { posts++; await new Promise((x) => setTimeout(x, 600)); route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }); });
    for (let i = 0; i < 5; i++) p.evaluate(() => document.getElementById('contactForm').requestSubmit()).catch(() => {});
    await p.waitForURL('**/thanks/contact', { timeout: 5000 });
    row('contact: five clicks, one request, then thanks page', posts === 1, `${posts} request(s)`);
    r = await get(`${BASE}/thanks/contact`);
    row('thanks page is noindex', /noindex/.test(r.headers.get('x-robots-tag') || ''));
    await p.goto(`${BASE}/contact`, { waitUntil: 'load' });
    await p.fill('#contactEmail', 'a@example.invalid');
    await p.fill('#contactSubject', 'x');
    await p.fill('#contactMessage', 'Offline check');
    await p.route('**/api/support/ticket', (route) => route.abort());
    await p.click('#contactSubmit');
    await p.waitForSelector('[data-error-summary]:not([hidden])');
    row('contact: offline says try again, button returns', (await p.textContent('[data-error-summary]')).includes('Connection problem') && !(await p.isDisabled('#contactSubmit')));
    await p.close();

    const l = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await l.goto(`${BASE}/?signup=1`, { waitUntil: 'load' });
    await l.waitForTimeout(400);
    await l.click('#lpRegisterSubmit');
    await l.waitForTimeout(200);
    row('sign-up: must agree to the Terms', (await l.getAttribute('#lpRegisterTerms', 'aria-invalid')) === 'true');
    row('sign-up: Terms link opens a new tab', (await l.getAttribute('.lp-agree a[href="/terms"]', 'target')) === '_blank');
    await l.close();
  }

  // Terms and consent.
  {
    const t = await (await get(`${BASE}/terms`)).text();
    row('Terms: no cash value wording, game, not advice', /no cash value/i.test(t) && /financial advice/i.test(t) && /welcome coins/i.test(t));
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await p.goto(`${BASE}/terms`, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    const pub = await p.evaluate(() => document.body.innerText);
    row('placeholders hidden from the public', !pub.includes('[COMPANY') && !pub.includes('DRAFT'));
    await p.goto(`${BASE}/terms?preview=1`, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    const prev = await p.evaluate(() => document.body.innerText);
    row('placeholders and DRAFT show in preview', prev.includes('[COMPANY LEGAL NAME]') && prev.includes('DRAFT'));
    await p.goto(`${BASE}/`, { waitUntil: 'load' });
    await p.waitForTimeout(600);
    row('no analytics set: no cookie banner', (await p.locator('#scCookieBanner').count()) === 0);
    await p.close();
  }

  // Consent with a provider switched on, using a fake config and no real provider.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true });
    const p = await ctx.newPage();
    const calls = [];
    await p.route('**/api/config/public', async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      route.fulfill({ response: res, json: { ...json, analyticsProvider: 'plausible', analyticsId: 'test.example' } });
    });
    await p.route('**/plausible.io/**', (route) => { calls.push(route.request().url()); route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }); });
    await p.goto(`${BASE}/help`, { waitUntil: 'load' });
    await p.waitForSelector('#scCookieBanner');
    row('consent: banner shows, nothing loaded before a choice', calls.length === 0);
    await p.click('#scConsentReject');
    await p.reload({ waitUntil: 'load' });
    await p.waitForTimeout(500);
    row('consent: reject stays off and remembered', calls.length === 0 && (await p.locator('#scCookieBanner').count()) === 0);
    await p.evaluate(() => window.SCAnalytics.openCookieSettings());
    await p.check('#scConsentAnalytics');
    await p.click('#scConsentSave');
    await p.waitForTimeout(300);
    row('consent: accepting in settings loads it', calls.length === 1);
    const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('sc_consent')));
    row('consent: choice stored with a date', saved.choice === 'accepted' && saved.at > 0);
    await ctx.close();
  }

  // Sideways scrolling, at every width.
  {
    const bad = [];
    const p = await browser.newPage();
    for (const w of WIDTHS) {
      await p.setViewportSize({ width: w, height: 800 });
      for (const path of PUBLIC) {
        await p.goto(BASE + path, { waitUntil: 'load' });
        await p.waitForTimeout(120);
        const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 0) bad.push(`${path}@${w}+${over}`);
      }
    }
    row(`no sideways scroll on ${PUBLIC.length} pages at ${WIDTHS.length} widths`, bad.length === 0, bad.slice(0, 8).join(' '));
    await p.close();
  }

  // Tap targets and icon-only buttons on the public pages, at phone width.
  {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const small = new Set();
    const unnamed = new Set();
    for (const path of PUBLIC) {
      await p.goto(BASE + path, { waitUntil: 'load' });
      await p.waitForTimeout(200);
      const res = await p.evaluate(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
        const out = { small: [], unnamed: [] };
        for (const el of document.querySelectorAll('button, a.btn, input:not([type=hidden]):not([type=checkbox]), select')) {
          if (!vis(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.height < 44) out.small.push(`${el.tagName.toLowerCase()}#${el.id || (el.textContent || '').trim().slice(0, 14)}=${Math.round(r.height)}`);
          if (el.tagName === 'BUTTON' && !(el.textContent || '').trim() && !el.getAttribute('aria-label') && !el.title) out.unnamed.push(el.id || el.className);
        }
        return out;
      });
      res.small.forEach((s) => small.add(`${path} ${s}`));
      res.unnamed.forEach((s) => unnamed.add(`${path} ${s}`));
    }
    row('touch targets at least 44px', small.size === 0, [...small].slice(0, 6).join(' ; '));
    row('icon-only buttons have names', unnamed.size === 0, [...unnamed].slice(0, 6).join(' ; '));
    await p.close();
  }

  // Admin.
  if (ADMIN) {
    r = await get(`${ADMIN}/robots.txt`, { accept: '*/*' });
    row('admin robots disallows everything', (await r.text()).includes('Disallow: /'));
    r = await get(`${ADMIN}/no-such-page`);
    body = await r.text();
    row('admin: own 404 page, noindex', r.status === 404 && body.includes('Page not found') && /noindex/.test(r.headers.get('x-robots-tag') || ''), String(r.status));
    r = await get(`${ADMIN}/lib/auth.js`, { accept: '*/*' });
    row('admin: source still not served', r.status === 404 && !(await r.text()).includes('require('), String(r.status));
  }

  await browser.close();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
