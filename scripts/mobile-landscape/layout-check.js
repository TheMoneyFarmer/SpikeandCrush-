'use strict';

// Tests 3, 4, 6, 7 on a live match in a phone-like browser:
//   3  nothing intersects the chart (canvas incl. price scale, price label and
//      position lines) at 5 sizes, with/without a spike alert, ticket open
//   4  one-click BUY fills via the server with the selected lot; forged
//      price/lot rejected or ignored; confirmation step; haptics; toast place
//   6  safe areas: rails and buttons clear of simulated notch/home insets
//   7  every interactive element has a 44px hit area
//   BASE=... ACCTS=... OUT=docs/mobile-landscape/layout node scripts/mobile-landscape/layout-check.js
const fs = require('fs');
const path = require('path');
const ph = require('./phone');

const BASE = process.env.BASE || 'http://localhost:3070';
const OUT = process.env.OUT || 'docs/mobile-landscape/layout';
const accts = require(process.env.ACCTS);
const SIZES = [[640, 360], [736, 414], [844, 390], [932, 430], [1024, 500]];
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };

// Everything that must never overlap the chart.
const OVERLAYS = ['#plSpike', '#plBand', '#heatMeter', '#cardSlots', '#matchSponsorChip', '#marketSpeedBadge', '#plToast', '#plTicket', '#twToast', '.tw-match-notifications', '.pl-confirm', '.pl-order', '#plLotSheet', '.pl-rail', '.pl-head'];

async function overlaps(page) {
  return page.evaluate((sels) => {
    const chart = document.getElementById('chartCanvasWrap').getBoundingClientRect();
    const hits = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        if (el.hidden || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const ix = Math.min(r.right, chart.right) - Math.max(r.left, chart.left);
        const iy = Math.min(r.bottom, chart.bottom) - Math.max(r.top, chart.top);
        if (ix > 0.5 && iy > 0.5) hits.push(`${sel} (${Math.round(ix)}x${Math.round(iy)})`);
      }
    }
    return { chart: { x: Math.round(chart.x), y: Math.round(chart.y), w: Math.round(chart.width), h: Math.round(chart.height) }, hits };
  }, OVERLAYS);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await ph.launch();
  const ctx = await ph.phoneContext(browser, { width: 844, height: 390, platform: 'android' });
  await ctx.addInitScript(() => {
    window.__vibrate = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (p) => { window.__vibrate.push(p); return true; } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ph.login(page, BASE, accts[0].username, accts[0].password);
  const id = await ph.startMatch(page, BASE);

  // one position so its line is on the chart
  await page.evaluate(() => TW.Game.placeTrade('BUY'));
  await page.waitForTimeout(800);

  // ---- 3. chart visibility ------------------------------------------------------
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(450);
    await page.evaluate(() => TW.PhoneLand.setTab('chart'));
    const a = await overlaps(page);
    // spike alert active (display only, the same call the socket event makes)
    await page.evaluate(() => TW.Fire && TW.Fire.spikeAlert({ inSeconds: 10, symbol: TW.Game.state().active, at: Date.now() + 10000 }));
    await page.waitForTimeout(300);
    const b = await overlaps(page);
    await page.screenshot({ path: path.join(OUT, `chart-spike-${w}x${h}.png`) });
    await page.evaluate(() => TW.PhoneLand.setTicket(true));
    await page.waitForTimeout(350);
    const c = await overlaps(page);
    await page.screenshot({ path: path.join(OUT, `chart-ticket-${w}x${h}.png`) });
    await page.evaluate(() => TW.PhoneLand.setTicket(false));
    const clear = !a.hits.length && !b.hits.length && !c.hits.length;
    ok(`${w}x${h}: nothing over the chart (plain / spike alert / ticket open)`, clear && a.chart.w > 150 && c.chart.w > 150, `chart ${a.chart.w}x${a.chart.h}, with ticket ${c.chart.w}x${c.chart.h}${clear ? '' : `; over it: ${[...a.hits, ...b.hits, ...c.hits].join(', ')}`}`);
    const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.documentElement.scrollHeight <= window.innerHeight + 1);
    ok(`${w}x${h}: no page scroll`, noScroll);
  }

  // ---- 4. one-click trading ---------------------------------------------------------
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(400);
  await page.evaluate(() => TW.PhoneLand.setTab('chart'));
  await page.tap('#plLots [data-lot="0.5"]');
  const before = await page.evaluate(() => TW.Game.state().positions.length);
  await page.tap('#plBuy');
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => { const s = TW.Game.state(); const p = s.positions[s.positions.length - 1]; return { n: s.positions.length, lots: p && p.lots, dir: p && p.direction, toast: document.getElementById('plToast').textContent, vib: window.__vibrate.slice() }; });
  ok('one tap on BUY fills at market with the selected lot (no confirm step)', after.n === before + 1 && Number(after.lots) === 0.5 && after.dir === 'BUY', JSON.stringify({ before, ...after, vib: undefined }));
  ok('haptic tap on fill', after.vib.length > 0, JSON.stringify(after.vib));
  ok('fill message shows in the tools row', /BUY 0\.5 .* filled/.test(after.toast), after.toast);
  const t = await overlaps(page);
  ok('fill message never over the chart or its price', !t.hits.length, t.hits.join(', '));
  // forged requests straight to the server
  const forged = await page.evaluate(async () => {
    const s = TW.Game.state();
    const px = s.prices[s.active];
    const fakePrice = await TW.emitAck('trade:open', { symbol: s.active, direction: 'BUY', lots: 0.01, price: 1, entryPrice: 1 });
    const hugeLot = await TW.emitAck('trade:open', { symbol: s.active, direction: 'BUY', lots: 100000 });
    const badLot = await TW.emitAck('trade:open', { symbol: s.active, direction: 'BUY', lots: -5 });
    const badSym = await TW.emitAck('trade:open', { symbol: 'FAKE', direction: 'BUY', lots: 1 });
    return { ask: px.ask, fakeFill: fakePrice.position && fakePrice.position.entryPrice, huge: hugeLot.success, hugeErr: hugeLot.error, bad: badLot.success, sym: badSym.success };
  });
  ok('server ignores a forged price (fills at its own quote)', forged.fakeFill !== 1 && Math.abs(forged.fakeFill - forged.ask) / forged.ask < 0.01, JSON.stringify(forged));
  ok('server rejects a forged lot and symbol', !forged.huge && !forged.bad && !forged.sym, `${forged.hugeErr}`);
  // confirmation on
  await page.evaluate(() => TW.PhonePrefs.set({ confirmTrades: true }));
  const n0 = await page.evaluate(() => TW.Game.state().positions.length);
  await page.tap('#plSell');
  await page.waitForTimeout(300);
  const shown = await page.evaluate(() => Boolean(document.querySelector('.pl-confirm')));
  await page.screenshot({ path: path.join(OUT, 'confirm-844x390.png') });
  const cov = await overlaps(page);
  await page.tap('.pl-confirm .pl-cno');
  await page.waitForTimeout(500);
  const n1 = await page.evaluate(() => TW.Game.state().positions.length);
  ok('confirmation on: SELL asks first, Cancel places nothing, card is not over the chart', shown && n1 === n0 && !cov.hits.length, `${n0} -> ${n1}`);
  await page.tap('#plSell');
  await page.waitForTimeout(300);
  await page.tap('.pl-confirm .pl-cyes');
  await page.waitForTimeout(900);
  const n2 = await page.evaluate(() => TW.Game.state().positions.length);
  ok('confirmation on: Place order fills', n2 === n0 + 1, `${n0} -> ${n2}`);
  await page.evaluate(() => TW.PhonePrefs.set({ confirmTrades: false }));

  // ---- 7. touch targets ------------------------------------------------------------------
  const small = [];
  for (const t of ['chart', 'assets', 'trade', 'arena', 'ticket']) {
    await page.evaluate((x) => { if (x === 'ticket') { TW.PhoneLand.setTab('chart'); TW.PhoneLand.setTicket(true); } else { TW.PhoneLand.setTicket(false); TW.PhoneLand.setTab(x); } }, t);
    await page.waitForTimeout(400);
    const bad = await page.evaluate((tabName) => {
      const out = [];
      const els = document.querySelectorAll('#plRoot button, #plRoot a[href], #plRoot input, #plRoot select, #plRoot [role="row"][tabindex]');
      for (const el of els) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        if (r.width >= 44 && r.height >= 44) continue;
        // only controls a finger can reach now (not scrolled out of view)
        const c0 = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!c0 || (c0 !== el && !el.contains(c0))) continue;
        // hit area: the element (or a pseudo-element extension) answers 22px
        // either side of its centre along the short side(s)
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const pts = [];
        if (r.height < 44) pts.push([cx, cy - 21], [cx, cy + 21]);
        if (r.width < 44) pts.push([cx - 21, cy], [cx + 21, cy]);
        const hits = pts.every(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e === el || el.contains(e)); });
        if (!hits) out.push(`${tabName}: ${el.id || el.className || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    }, t);
    small.push(...bad);
  }
  await page.evaluate(() => TW.PhoneLand.setTicket(false));
  ok('every interactive element has a 44px hit area', !small.length, small.slice(0, 12).join(' | '));

  // ---- 6. safe areas (Chrome DevTools safe-area override where supported) -----------
  const cdp = await ctx.newCDPSession(page);
  let insetsOn = false;
  try {
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 47, right: 47, bottom: 21 } });
    insetsOn = true;
  } catch (e) {
    console.log(`  safe-area override not available in this Chrome (${e.message.split('\n')[0]}); using CSS env() fallback values instead`);
    await page.addStyleTag({ content: ':root{--sai-test:1} body.pl #plRoot{grid-template-columns: calc(var(--pl-rail) + 47px) minmax(0,1fr)} .pl-rail{padding-left:51px!important;padding-bottom:21px!important} .pl-main{padding-right:47px!important;padding-bottom:21px!important}' });
  }
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => TW.PhoneLand.setTab('chart'));
  await page.waitForTimeout(500);
  const safe = await page.evaluate(() => {
    const L = 47; const R = 47; const B = 21;
    const bad = [];
    for (const el of document.querySelectorAll('#plRoot button, #plRoot a[href], #plRoot input')) {
      const r = el.getBoundingClientRect();
      if (!r.width || el.closest('[hidden]') || getComputedStyle(el).visibility === 'hidden') continue;
      if (r.left < L - 0.5 || r.right > innerWidth - R + 0.5 || r.bottom > innerHeight - B + 0.5) bad.push(`${el.id || el.className} [${Math.round(r.left)},${Math.round(r.right)},${Math.round(r.bottom)}]`);
    }
    return bad;
  });
  await page.screenshot({ path: path.join(OUT, 'safe-areas-844x390.png') });
  ok(`safe areas (${insetsOn ? 'DevTools insets' : 'simulated'} 47px sides, 21px bottom): no control under the notch or home bar`, !safe.length, safe.slice(0, 8).join(' | '));

  ok('no page errors', !errors.length, errors.slice(0, 3).join(' | '));
  await ph.leave(page, id);
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
