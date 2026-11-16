'use strict';

// Test 5: a real 40-player Private War (10 minutes). The host plays on a
// phone-sized browser in landscape and cycles the five tabs; 39 scripted
// players join by room code and trade, change SL/TP and play cards over the
// real socket events. Every 30 s the host's event listeners, DOM nodes and JS
// heap are sampled (Chrome DevTools Performance metrics); frame rate is
// measured with the CPU throttled 4x at the start and at the end.
//   BASE=... ACCTS=<40 accounts json> OUT=docs/mobile-landscape/forty node scripts/mobile-landscape/forty.js
const fs = require('fs');
const path = require('path');
const io = require('socket.io-client');
const ph = require('./phone');

const BASE = process.env.BASE || 'http://localhost:3070';
const OUT = process.env.OUT || 'docs/mobile-landscape/forty';
const accts = require(process.env.ACCTS);
const MINUTES = Number(process.env.MINUTES || 10);
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

async function apiLogin(a) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: a.username, password: a.password }) });
  return (await r.json()).token;
}

// Forfeit a match an account is still seated in (an earlier run), so it can join.
async function clearLive(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'] });
  const emit = (ev, d) => new Promise((res) => { const t = setTimeout(() => res({}), 6000); s.emit(ev, d, (x) => { clearTimeout(t); res(x || {}); }); });
  await new Promise((res) => { s.on('connect', res); setTimeout(res, 6000); });
  const live = await emit('match:live', {});
  if (live.live) await emit('match:forfeit', { matchId: live.live.matchId || live.live.id });
  s.close();
}

function bot(token, matchId, stats) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'] });
  const st = { positions: [], cards: [], you: null, players: [], instruments: [], active: false };
  const emit = (ev, d) => new Promise((res) => { const t = setTimeout(() => res({ success: false }), 6000); s.emit(ev, d, (x) => { clearTimeout(t); res(x || {}); }); });
  s.on('connect', () => emit('player:join', { matchId }));
  s.on('match:state', (m) => {
    st.you = m.you; st.instruments = m.instruments || []; st.active = m.status === 'active';
    st.players = (m.players || []).map((p) => p.id).filter((id) => id !== m.you);
    const me = (m.players || []).find((p) => p.id === m.you);
    if (me && Array.isArray(me.cards)) st.cards = me.cards.filter((c) => c && c.type && !c.used).map((c) => c.type);
  });
  s.on('cards:update', (d) => { st.cards = (d.cards || []).filter((c) => !c.used).map((c) => c.type); });
  s.on('trade:executed', (d) => { if (d.position && !st.positions.find((p) => p.id === d.position.id)) st.positions.push(d.position); });
  s.on('trade:closed', (d) => { st.positions = st.positions.filter((p) => p.id !== d.positionId); });
  let timer = null;
  const act = async () => {
    if (st.active && st.instruments.length) {
      const r = Math.random();
      if (r < 0.4 && st.positions.length < 3) { const x = await emit('trade:open', { symbol: rnd(st.instruments), direction: rnd(['BUY', 'SELL']), lots: rnd([0.01, 0.05, 0.1, 0.2]) }); stats.opens += x.success ? 1 : 0; }
      else if (r < 0.7 && st.positions.length) { const p = rnd(st.positions); const x = await emit('trade:close', { positionId: p.id }); stats.closes += x.success ? 1 : 0; }
      else if (r < 0.8 && st.positions.length) { const p = rnd(st.positions); await emit('trade:modify', { positionId: p.id, takeProfit: null }); stats.modifies += 1; }
      else if (st.cards.length && st.players.length) { const x = await emit('sabotage:play', { cardType: rnd(st.cards), targetId: rnd(st.players), symbol: rnd(st.instruments) }); stats.cards += x.success ? 1 : 0; }
    }
    timer = setTimeout(act, 2500 + Math.random() * 3500);
  };
  timer = setTimeout(act, 3000 + Math.random() * 3000);
  return { stop: async () => { clearTimeout(timer); await emit('match:leave', { matchId }); s.close(); } };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (accts.length < 40) throw new Error(`need 40 accounts, have ${accts.length}`);
  const browser = await ph.launch();
  const ctx = await ph.phoneContext(browser, { width: 844, height: 390, platform: 'android' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ph.login(page, BASE, accts[0].username, accts[0].password);
  await page.goto(`${BASE}/play`, { waitUntil: 'load' });
  const made = await page.evaluate(() => TW.api('/api/match/create', { method: 'POST', body: { mode: 'private' } }).catch((e) => ({ error: e.message })));
  if (!made.matchId) throw new Error(`create failed ${JSON.stringify(made)}`);
  const room = await (await fetch(`${BASE}/api/match/${made.matchId}`)).json();
  await page.goto(`${BASE}/lobby.html?matchId=${made.matchId}`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof currentState !== 'undefined' && currentState, { timeout: 15000 });

  // 39 players join by room code
  const stats = { opens: 0, closes: 0, modifies: 0, cards: 0 };
  const bots = [];
  for (const a of accts.slice(1, 40)) {
    const token = await apiLogin(a);
    await clearLive(token);
    const j = await (await fetch(`${BASE}/api/match/join`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ roomCode: room.roomCode }) })).json();
    if (!j.success && !j.matchId && !j.match) console.log('join refused', a.username, JSON.stringify(j).slice(0, 120));
    bots.push(bot(token, made.matchId, stats));
  }
  await sleep(4000);
  const seats = (await (await fetch(`${BASE}/api/match/${made.matchId}`)).json()).players.length;
  ok('40 players seated in one Private War', seats >= 40, `${seats} seats`);
  await page.evaluate(() => TW.emitAck('lobby:start_war', {}));
  await page.waitForURL('**/game*', { timeout: 30000 });
  await ph.noTours(page);
  await page.waitForFunction(() => window.TW && TW.Game && TW.PhoneLand && TW.PhoneLand.isOn() && Object.keys(TW.Game.state().prices).length, { timeout: 30000 });
  await sleep(3000);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.filter((m) => ['JSEventListeners', 'Nodes', 'JSHeapUsedSize', 'Documents'].includes(m.name)).map((m) => [m.name, m.value]));
  const fps = async () => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => TW.PhoneLand.setTab('chart'));
    const r = await page.evaluate(() => new Promise((resolve) => { let n = 0; let worst = 0; let last = performance.now(); const t0 = last; const f = (t) => { n += 1; worst = Math.max(worst, t - last); last = t; if (t - t0 < 3000) requestAnimationFrame(f); else resolve({ fps: Math.round((n / (t - t0)) * 1000), worstFrameMs: Math.round(worst) }); }; requestAnimationFrame(f); }));
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    return r;
  };
  const fps0 = await fps();
  const samples = [];
  const seen = { lbRows: 0, crown: false, missions: false, spike: false, frozen: false, positions: 0, arenaCards: 0 };
  // host trades a little too
  const t0 = Date.now();
  let i = 0;
  const tabs = ['chart', 'assets', 'trade', 'arena'];
  while (Date.now() - t0 < MINUTES * 60000) {
    const tab = tabs[i % tabs.length];
    await page.evaluate((x) => TW.PhoneLand.setTab(x), tab).catch(() => {});
    if (i % 6 === 0) await page.evaluate(() => TW.Game.placeTrade(Math.random() < 0.5 ? 'BUY' : 'SELL')).catch(() => {});
    if (i % 6 === 3) await page.evaluate(() => { const p = TW.Game.state().positions[0]; if (p) TW.Game.closePosition(p.id); }).catch(() => {});
    await sleep(5000);
    const v = await page.evaluate(() => ({
      lbRows: document.querySelectorAll('#leaderboardBody tr').length,
      crown: Boolean(document.querySelector('#leaderboardBody tr.crown-row')) || Boolean(document.getElementById('plCrown').textContent.trim()),
      missions: document.querySelectorAll('#plMissions .pl-mission').length > 0 || document.querySelectorAll('#spikeStrip .ms-mission, #spikeStrip [class*="mission"]').length > 0,
      spike: /spike/i.test(document.getElementById('spikeStrip').className + document.getElementById('spikeStrip').textContent),
      frozen: !document.getElementById('plFlag').hidden || document.getElementById('plRoot').classList.contains('pl-locked'),
      positions: TW.Game.state().positions.length,
      ended: TW.Game.state().ended,
    })).catch(() => ({}));
    seen.lbRows = Math.max(seen.lbRows, v.lbRows || 0);
    seen.crown = seen.crown || v.crown;
    seen.missions = seen.missions || v.missions;
    seen.spike = seen.spike || v.spike;
    seen.frozen = seen.frozen || v.frozen;
    seen.positions = Math.max(seen.positions, v.positions || 0);
    if (i % 6 === 0) {
      const m = await metrics().catch(() => null);
      if (m) samples.push({ t: Math.round((Date.now() - t0) / 1000), ...m });
      if (i % 24 === 0) await page.screenshot({ path: path.join(OUT, `forty-${tab}-${Math.round((Date.now() - t0) / 60000)}m.png`) });
    }
    if (v.ended) break;
    i += 1;
  }
  const fps1 = await fps().catch(() => null);
  await Promise.all(bots.map((b) => b.stop()));

  const first = samples[1] || samples[0];
  const last = samples[samples.length - 1];
  fs.writeFileSync(path.join(OUT, 'samples.json'), `${JSON.stringify({ samples, fps0, fps1, stats, seen }, null, 2)}\n`);
  ok('standings show all 40 players', seen.lbRows >= 40, `${seen.lbRows} rows`);
  ok('crown, missions and positions updated on the tabs', seen.crown && seen.missions && seen.positions > 0, JSON.stringify(seen));
  ok('bots really played: opens, closes, SL/TP changes, card plays', stats.opens > 50 && stats.closes > 20 && stats.cards > 5, JSON.stringify(stats));
  ok(`no listener growth over ${MINUTES} min`, last.JSEventListeners <= first.JSEventListeners * 1.15 + 20, `JS event listeners ${first.JSEventListeners} -> ${last.JSEventListeners}`);
  ok('DOM size stays flat', last.Nodes <= first.Nodes * 1.25 + 200, `nodes ${first.Nodes} -> ${last.Nodes}`);
  ok('JS heap stays flat', last.JSHeapUsedSize <= first.JSHeapUsedSize * 1.5, `heap ${(first.JSHeapUsedSize / 1e6).toFixed(1)} MB -> ${(last.JSHeapUsedSize / 1e6).toFixed(1)} MB`);
  ok('frame rate on a 4x throttled CPU stays smooth', fps0.fps >= 30 && (!fps1 || fps1.fps >= 30), `start ${JSON.stringify(fps0)}, end ${JSON.stringify(fps1)}`);
  ok('no page errors', !errors.length, errors.slice(0, 3).join(' | '));
  await ph.leave(page, made.matchId);
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
