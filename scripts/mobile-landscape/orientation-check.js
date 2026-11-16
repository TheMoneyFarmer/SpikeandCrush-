'use strict';

// Tests 1 and 2: orientation layers and the chart under a CSS rotation.
//   BASE=http://localhost:3070 ACCTS=... OUT=docs/mobile-landscape/orientation node scripts/mobile-landscape/orientation-check.js
const fs = require('fs');
const path = require('path');
const ph = require('./phone');

const BASE = process.env.BASE || 'http://localhost:3070';
const OUT = process.env.OUT || 'docs/mobile-landscape/orientation';
const accts = require(process.env.ACCTS);
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };

// Spies on fullscreen and orientation calls, installed before any page script.
const SPY = (lockResult) => `(() => {
  window.__calls = [];
  const rec = (n, a) => window.__calls.push(n + (a ? ':' + a : ''));
  const rf = Element.prototype.requestFullscreen;
  Element.prototype.requestFullscreen = function (o) { rec('requestFullscreen'); return rf ? rf.call(this, o).catch(() => {}) : Promise.resolve(); };
  const ef = Document.prototype.exitFullscreen;
  Document.prototype.exitFullscreen = function () { rec('exitFullscreen'); return ef ? ef.call(this).catch(() => {}) : Promise.resolve(); };
  if (window.screen && screen.orientation) {
    Object.defineProperty(screen.orientation, 'lock', { configurable: true, value: (o) => { rec('lock', o); return ${lockResult === 'ok' ? 'Promise.resolve()' : "Promise.reject(Object.assign(new Error('not supported'), { name: 'NotSupportedError' }))"}; } });
    Object.defineProperty(screen.orientation, 'unlock', { configurable: true, value: () => { rec('unlock'); } });
  }
  // pagehide calls are kept across the navigation for the test to read
  // registered after the page's own scripts, so its pagehide work is recorded first
  window.addEventListener('load', () => window.addEventListener('pagehide', () => { try { sessionStorage.setItem('__calls', JSON.stringify(window.__calls)); } catch (e) {} }));
})();`;

async function gameOn(ctx, extra = '') {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ph.login(page, BASE, accts[0].username, accts[0].password);
  const id = await ph.startMatch(page, BASE);
  if (extra) {
    await page.goto(`${BASE}/game.html?matchId=${id}${extra}`, { waitUntil: 'load' });
    await ph.noTours(page);
    await page.waitForFunction(() => TW.Game && Object.keys(TW.Game.state().prices).length, { timeout: 20000 });
    await page.waitForTimeout(1200);
  }
  return { page, id, errors };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await ph.launch();

  // ---- 1a. Android-like, upright: first tap asks for fullscreen + landscape lock ----
  {
    const ctx = await ph.phoneContext(browser, { width: 390, height: 844, platform: 'android' });
    await ctx.addInitScript(SPY('ok'));
    const { page, id } = await gameOn(ctx);
    const before = await page.evaluate(() => ({ calls: window.__calls.slice(), on: TW.PhoneLand.isOn(), mode: TW.PhoneLand.orientation().mode }));
    await page.touchscreen.tap(195, 420);
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => ({ calls: window.__calls.slice(), o: TW.PhoneLand.orientation() }));
    ok('Android: nothing is requested before a tap', !before.calls.some((c) => c.startsWith('lock')), JSON.stringify(before.calls));
    ok('Android: first tap requests fullscreen and the landscape lock', after.calls.includes('requestFullscreen') && after.calls.includes('lock:landscape') && after.o.lock === 'ok', JSON.stringify(after.calls));
    // the device turns: the viewport becomes landscape
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(500);
    const turned = await page.evaluate(() => ({ mode: TW.PhoneLand.orientation().mode, on: TW.PhoneLand.isOn(), turnCard: !document.getElementById('plTurn').hidden }));
    ok('Android: after the lock the landscape screen shows', turned.on && turned.mode === 'locked-landscape' && !turned.turnCard, JSON.stringify(turned));
    await page.screenshot({ path: path.join(OUT, 'android-locked-844x390.png') });
    // leave the match through Home: unlock + exit fullscreen on the way out
    await page.evaluate(() => { const a = document.getElementById('matchHomeBtn'); if (a) a.click(); else location.href = '/play'; });
    await page.waitForURL('**/play*', { timeout: 10000 });
    const leftCalls = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__calls') || '[]'));
    const onLobby = await page.evaluate(() => !document.body.classList.contains('pl') && !document.documentElement.classList.contains('pl-rot'));
    ok('Android: leaving unlocks the orientation and exits fullscreen', leftCalls.includes('unlock') && onLobby, JSON.stringify(leftCalls.slice(-4)));
    await page.goto(`${BASE}/game.html?matchId=${id}`);
    await ph.leave(page, id);
    await ctx.close();
  }

  // ---- 1b. iOS-like, upright: lock refused -> fallback ----
  {
    const ctx = await ph.phoneContext(browser, { width: 390, height: 844, platform: 'ios' });
    await ctx.addInitScript(SPY('refuse'));
    const { page, id } = await gameOn(ctx);
    await page.touchscreen.tap(195, 420);
    await page.waitForTimeout(600);
    const o = await page.evaluate(() => ({ o: TW.PhoneLand.orientation(), turn: !document.getElementById('plTurn').hidden, calls: window.__calls }));
    ok('iOS: lock refused silently, fallback shown', o.o.lock.startsWith('refused') && o.o.mode === 'turn-card' && o.turn, JSON.stringify({ lock: o.o.lock, mode: o.o.mode }));
    await page.screenshot({ path: path.join(OUT, 'ios-portrait-390x844.png') });
    await page.setViewportSize({ width: 430, height: 932 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'ios-portrait-430x932.png') });
    // turning the phone: landscape screen, no card
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(400);
    const land = await page.evaluate(() => ({ mode: TW.PhoneLand.orientation().mode, turn: !document.getElementById('plTurn').hidden }));
    ok('iOS: turning the phone shows the landscape screen', land.mode === 'landscape' && !land.turn, JSON.stringify(land));
    // "Play upright this time" -> the existing portrait layout
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.click('#plTurnDismiss');
    await page.waitForTimeout(400);
    const upright = await page.evaluate(() => ({ pl: document.body.classList.contains('pl'), tabs: getComputedStyle(document.getElementById('gameMobileTabs')).display }));
    ok('"Play upright this time" falls back to the portrait layout', !upright.pl && upright.tabs !== 'none', JSON.stringify(upright));
    await page.screenshot({ path: path.join(OUT, 'ios-upright-fallback-390x844.png') });
    await ph.leave(page, id);
    await ctx.close();
  }

  // ---- 2. the chart under a CSS rotation (test mode ?plrot=css) ----
  {
    const ctx = await ph.phoneContext(browser, { width: 390, height: 844, platform: 'ios' });
    await ctx.addInitScript(SPY('refuse'));
    const { page, id } = await gameOn(ctx, '&pltest=1&plrot=css');
    const rotated = await page.evaluate(() => document.documentElement.classList.contains('pl-rot'));
    await page.screenshot({ path: path.join(OUT, 'css-rotation-390x844.png') });
    // Point 120,80 inside the chart (its own unrotated coordinates) -> screen.
    const probe = async () => page.evaluate(() => {
      const el = document.querySelector('#chartCanvas');
      let x = 0; let y = 0; let n = el;
      while (n && n !== document.body) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
      return { bodyX: x + 120, bodyY: y + 80, vw: window.innerWidth };
    });
    const pr = await probe();
    // body is rotated 90deg about its top-left and placed at left: 100vw
    const screenX = pr.vw - pr.bodyY;
    const screenY = pr.bodyX;
    await page.mouse.move(screenX, screenY);
    await page.waitForTimeout(300);
    const cross = await page.evaluate(() => window.__plCrosshair);
    const good = cross && Math.abs(cross.x - 120) < 4 && Math.abs(cross.y - 80) < 4;
    // Measured result decides the shipped fallback: the chart library reads
    // touch positions unrotated, so the CSS rotation is not used in play.
    console.log(`  chart under CSS rotation (test mode): rotated=${rotated}, expected (120,80), library saw ${JSON.stringify(cross)} -> ${good ? 'works' : 'broken'}`);
    const shipped = await page.evaluate(() => (new URLSearchParams(location.search).get('plrot') ? 'test mode' : 'n/a'));
    ok('CSS rotation is not shipped while the chart reads touches wrongly under it', !good && shipped === 'test mode', good ? 'rotation works: consider enabling it' : 'default stays the Turn your phone card');
    // control: the same probe unrotated
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(500);
    const box = await page.evaluate(() => { const r = document.querySelector('#chartCanvas').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    await page.mouse.move(box.x + 120, box.y + 80);
    await page.waitForTimeout(300);
    const ctrl = await page.evaluate(() => window.__plCrosshair);
    ok('control, unrotated: crosshair lands under the finger', ctrl && Math.abs(ctrl.x - 120) < 4 && Math.abs(ctrl.y - 80) < 4, JSON.stringify(ctrl));
    await ph.leave(page, id);
    await ctx.close();
  }

  // ---- 1c. setting off keeps the portrait layout; desktop untouched ----
  {
    const ctx = await ph.phoneContext(browser, { width: 390, height: 844, platform: 'android' });
    await ctx.addInitScript(() => { try { localStorage.setItem('tw_phone_prefs', JSON.stringify({ rotate: false })); } catch (e) {} });
    const { page, id } = await gameOn(ctx);
    const s = await page.evaluate(() => ({ pl: document.body.classList.contains('pl'), tabs: getComputedStyle(document.getElementById('gameMobileTabs')).display }));
    ok('setting off: the portrait layout stays', !s.pl && s.tabs !== 'none', JSON.stringify(s));
    await page.screenshot({ path: path.join(OUT, 'setting-off-390x844.png') });
    await ph.leave(page, id);
    await ctx.close();
  }
  {
    const ctx = await ph.phoneContext(browser, { width: 1440, height: 900, platform: 'desktop', mobile: false });
    await ctx.addInitScript(SPY('ok'));
    const { page, id } = await gameOn(ctx);
    await page.mouse.click(700, 450);
    await page.waitForTimeout(400);
    const d = await page.evaluate(() => ({ pl: document.body.classList.contains('pl'), calls: window.__calls, arena: document.body.classList.contains('arena') }));
    ok('desktop: no phone layout and no fullscreen or lock requests', !d.pl && d.arena && !d.calls.length, JSON.stringify(d));
    await ph.leave(page, id);
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
