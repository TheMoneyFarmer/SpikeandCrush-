'use strict';

// Discover panel checks in a real browser (dev database only):
//   1. at every viewport the panel opens and closes, and never covers a mode
//      card or the Play button (bounding boxes + elementFromPoint at each
//      control's centre, after scrolling it into the space left free)
//   2. the panel keeps its tab and search when closed and reopened
//   3. invite a NON-friend from the panel, they accept, and both land in the
//      same waiting room
//   4. no Discover API response carries location fields
//
//   SHOT_BASE=http://localhost:3070 ACCTS=/path/to/rec-accounts.json SHOT_DIR=... \
//   node scripts/admin-records/discover-panel-check.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const BASE = process.env.SHOT_BASE || 'http://localhost:3070';
const DIR = process.env.SHOT_DIR || 'docs/admin-records/discover';
const accts = JSON.parse(fs.readFileSync(process.env.ACCTS, 'utf8'));
const SIZES = [[1440, 900], [1024, 768], [768, 1024], [360, 780], [390, 844], [430, 932], [780, 360], [844, 390], [932, 430]];
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };

async function login(page, a) {
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.evaluate(async ([u, p]) => {
    const d = await TW.api('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
    await TW.establishSession(d.token, d.refresh_token, d.player);
  }, [a.username, a.password]);
}

// Walkthroughs ("What's new") are per-account and not part of this check.
async function noTours(page) {
  await page.addStyleTag({ content: '.tutorial-overlay,.tutorial-spotlight,.tutorial-card,.tw-tour{display:none!important}' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelectorAll('.tutorial-overlay, .tutorial-spotlight, .tutorial-card, .tw-tour').forEach((e) => e.remove()));
}

// Is this element visible where it is, and not under the panel?
async function uncovered(page, selector) {
  return page.evaluate((sel) => {
    const panel = document.getElementById('twDiscover');
    const pr = panel && !panel.hidden ? panel.getBoundingClientRect() : null;
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const r0 = el.getBoundingClientRect();
      if (!r0.width || !r0.height || getComputedStyle(el).visibility === 'hidden') continue;
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      const overlap = pr && r.left < pr.right && r.right > pr.left && r.top < pr.bottom && r.bottom > pr.top;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out.push({ id: el.id || el.className, overlap: Boolean(overlap), hitSelf: Boolean(hit && (hit === el || el.contains(hit))) });
    }
    return out;
  }, selector);
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  // ---- 1 + 2: layout at every size -------------------------------------------
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, accts[0]);
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${BASE}/play`, { waitUntil: 'load' });
    await page.waitForSelector('#modeQuickBtn', { state: 'attached' });
    await page.waitForTimeout(700);
    await noTours(page);
    const mobile = w <= 1023; // the lobby's phone layout: tab bar + mode sheet
    await page.evaluate(() => TW.closeModeSheet && TW.closeModeSheet());
    const landscapePhone = h <= 500 && w > h && w <= 1023;
    // desktop: top nav button; phones: the Discover tab; landscape phones
    // (no tab bar there): the Discover button in the profile row
    const trigger = !mobile ? '#twDiscoverBtn' : landscapePhone ? '#lbMDiscover' : '.bottom-tab-bar [data-discover-toggle]';
    const visibleTrigger = await page.locator(trigger).first().isVisible().catch(() => false);
    if (!visibleTrigger) { ok(`${w}x${h} Discover trigger visible`, false, trigger); continue; }
    await page.locator(trigger).first().click();
    await page.waitForSelector('#twDiscover:not([hidden])');
    // landscape phones: then open the modes (what Play does) next to Discover
    if (landscapePhone) await page.evaluate(() => TW.openModeSheet && TW.openModeSheet());
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(DIR, `panel-${w}x${h}.png`) });
    const modes = await uncovered(page, '.lb-mode');
    // Play: desktop the Quick card; phones the raised Play tab; landscape
    // phones the mode sheet itself (no tab bar there), checked as mode cards.
    const play = await uncovered(page, !mobile ? '#modeQuickBtn' : landscapePhone ? '#modeQuickBtn' : '#tabPlayBtn');
    const badModes = modes.filter((m) => m.overlap || !m.hitSelf);
    ok(`${w}x${h} mode cards not covered`, badModes.length === 0, `${modes.length} visible${badModes.length ? `, covered: ${badModes.map((m) => m.id).join(',')}` : ''}`);
    ok(`${w}x${h} Play reachable`, play.length > 0 && play.every((p) => !p.overlap && p.hitSelf), JSON.stringify(play));
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    ok(`${w}x${h} no sideways page scroll`, noHScroll);
    if (landscapePhone) {
      ok(`${w}x${h} mode sheet and Discover side by side`, modes.length === 7 && badModes.length === 0, `${modes.length} cards`);
      await page.locator('#twDiscover .dp-close').click();
      await page.waitForTimeout(250);
      ok(`${w}x${h} closes and frees the space`, await page.evaluate(() => document.getElementById('twDiscover').hidden && !document.body.classList.contains('dp-open')));
    } else if (mobile) {
      // close and reopen via the tab must free the space too
      await page.locator(trigger).first().click();
      await page.waitForTimeout(250);
      ok(`${w}x${h} closes and frees the space`, await page.evaluate(() => document.getElementById('twDiscover').hidden && !document.body.classList.contains('dp-open')));
      await page.locator(trigger).first().click();
      await page.waitForTimeout(300);
      // Play opens the mode sheet: Discover steps aside (state kept), cards usable.
      await page.locator('#tabPlayBtn').click();
      await page.waitForTimeout(500);
      const hidden = await page.evaluate(() => document.getElementById('twDiscover').hidden);
      const sheetModes = await uncovered(page, '.lb-mode');
      ok(`${w}x${h} Play sheet opens with Discover out of the way`, hidden && sheetModes.length > 0 && sheetModes.every((m) => m.hitSelf), `${sheetModes.length} cards`);
      await page.evaluate(() => TW.closeModeSheet && TW.closeModeSheet());
    } else {
      await page.locator('#twDiscover .dp-close').click();
      await page.waitForTimeout(250);
      const closed = await page.evaluate(() => document.getElementById('twDiscover').hidden && !document.body.classList.contains('dp-open'));
      ok(`${w}x${h} closes and frees the space`, closed);
    }
  }

  // state kept across close/reopen
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/play?discover=1`, { waitUntil: 'load' });
  await page.waitForSelector('#twDiscover:not([hidden])');
  await noTours(page);
  await page.locator('#twDiscover [data-section="suggested"]').click();
  await page.locator('#twDiscover .dp-search input').fill('rec');
  await page.waitForTimeout(500);
  await page.locator('#twDiscover .dp-close').click();
  await page.locator('#twDiscoverBtn').click();
  await page.waitForTimeout(300);
  const kept = await page.evaluate(() => ({ tab: document.querySelector('#twDiscover .dp-tabs .active').dataset.section, q: document.querySelector('#twDiscover .dp-search input').value }));
  ok('panel keeps tab and search when reopened', kept.tab === 'suggested' && kept.q === 'rec', JSON.stringify(kept));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#twDiscover:not([hidden])');
  await noTours(page);
  const keptReload = await page.evaluate(() => document.querySelector('#twDiscover .dp-tabs .active').dataset.section);
  ok('panel keeps its tab across a page load', keptReload === 'suggested', keptReload);
  ok('no page errors in the lobby', errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();

  // ---- 3: invite a non-friend, accept, same room --------------------------------
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  await login(A, accts[0]);
  await login(B, accts[1]);
  await B.goto(`${BASE}/play`, { waitUntil: 'load' });
  await noTours(B);
  await A.goto(`${BASE}/play?discover=1`, { waitUntil: 'load' });
  await A.waitForSelector('#twDiscover:not([hidden])');
  await noTours(A);
  const rel = await A.evaluate(async (bid) => (await TW.api('/api/friends')).friends?.some?.((f) => f.id === bid) ?? null, accts[1].playerId).catch(() => null);
  ok('the two test players are not friends', rel === false || rel === null, String(rel));
  // privacy: no location fields in any Discover payload
  const payloads = await A.evaluate(async () => Promise.all(['friends', 'live', 'rooms', 'suggested'].map((s) => TW.api(`/api/discover?section=${s}`).then((d) => JSON.stringify(d)))));
  const loc = payloads.join('').match(/"(country|city|region|lat|lng|lon|latitude|longitude|distance|geo|ip)"\s*:/i);
  ok('no location fields in Discover responses', !loc, loc ? loc[0] : `${payloads.join('').length} bytes checked`);
  await A.locator('#twDiscover [data-section="live"]').click();
  await A.locator('#twDiscover .dp-search input').fill(accts[1].username);
  const row = A.locator(`#twDiscover .dp-row[data-id="${accts[1].playerId}"]`);
  await row.waitFor({ timeout: 8000 });
  await row.locator('[data-act="invite"]').click();
  await A.screenshot({ path: path.join(DIR, 'invite-chooser-1440.png') });
  await row.locator('[data-pick="private"]').click();
  await A.waitForSelector('#twDiscover .dp-room:has-text("Invite sent")', { timeout: 8000 });
  ok('invite sent from the panel without leaving the lobby', A.url().includes('/play'), A.url());
  // B accepts through the existing invite popup (friends-panel.js)
  const accept = B.locator('[data-inv="accept"]').first();
  await accept.waitFor({ timeout: 10000 });
  await B.screenshot({ path: path.join(DIR, 'invite-received-390.png') });
  await accept.click();
  const bOk = await B.waitForURL(/lobby\.html\?matchId=/, { timeout: 15000 }).then(() => true, () => false);
  const aOk = await A.waitForURL(/lobby\.html\?matchId=/, { timeout: 15000 }).then(() => true, () => false);
  if (!bOk || !aOk) {
    const toastB = await B.evaluate(() => [...document.querySelectorAll('.toast, .tw-toast, [role="status"]')].map((t) => t.textContent.trim()).join(' | ')).catch(() => '');
    ok('accepting takes both players to the room', false, `invitee ${bOk ? 'arrived' : `stayed on ${B.url()} ${toastB}`}; inviter ${aOk ? 'arrived' : `stayed on ${A.url()}`}`);
  }
  const idA = new URL(A.url()).searchParams.get('matchId');
  const idB = new URL(B.url()).searchParams.get('matchId');
  ok('both players land in the same waiting room', idA && idA === idB, `${idA} / ${idB}`);
  // (the waiting room is closed by the idle-lobby sweep; run against a fresh
  // local server so no invite from an earlier run is still pending)

  await browser.close();
  fs.writeFileSync(path.join(DIR, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
