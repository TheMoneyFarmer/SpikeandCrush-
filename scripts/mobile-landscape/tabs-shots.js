'use strict';

// Screenshots of every tab and the quick ticket at each phone size, from one
// live match (the viewport is resized between sizes).
//   BASE=http://localhost:3070 ACCTS=... OUT=docs/mobile-landscape/shots node scripts/mobile-landscape/tabs-shots.js
const fs = require('fs');
const path = require('path');
const ph = require('./phone');

const BASE = process.env.BASE || 'http://localhost:3070';
const OUT = process.env.OUT || 'docs/mobile-landscape/shots';
const accts = require(process.env.ACCTS);
const SIZES = (process.env.SIZES || '640x360,736x414,844x390,932x430,1024x500').split(',').map((s) => s.split('x').map(Number));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await ph.launch();
  const ctx = await ph.phoneContext(browser, { width: 844, height: 390 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ph.login(page, BASE, accts[0].username, accts[0].password);
  const matchId = await ph.startMatch(page, BASE);
  console.log('phone layout on:', await page.evaluate(() => TW.PhoneLand && TW.PhoneLand.isOn()));
  // one position so the Trade tab has a card
  await page.evaluate(() => TW.Game.placeTrade('BUY'));
  await page.waitForTimeout(800);
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(500);
    for (const t of ['chart', 'assets', 'trade', 'arena']) {
      await page.evaluate((x) => TW.PhoneLand.setTab(x), t);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `${t}-${w}x${h}.png`) });
    }
    await page.evaluate(() => { TW.PhoneLand.setTab('chart'); TW.PhoneLand.setTicket(true); });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `ticket-${w}x${h}.png`) });
    await page.evaluate(() => TW.PhoneLand.setTicket(false));
  }
  // upright phone: the "Turn your phone" card
  for (const [w, h] of (process.env.PORTRAIT || '390x844,430x932').split(',').map((s) => s.split('x').map(Number))) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => TW.PhoneLand._evaluate && TW.PhoneLand._evaluate());
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `portrait-${w}x${h}.png`) });
  }
  console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
  await ph.leave(page, matchId);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
