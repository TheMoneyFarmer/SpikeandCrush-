'use strict';

// Test 17 soak: 54 scripted bots in 9 live Quick War matches (6 each) on the
// real engine for SOAK_MINUTES (default 10), trading, earning and playing
// cards, with missions, crown changes and spike alerts running. Samples heap,
// event-loop lag and active handles every 30s; fails if they grow.
//   node scripts/fire/soak.js > docs/fire/soak.txt
process.env.SUPABASE_SERVICE_KEY = '';
const { monitorEventLoopDelay } = require('perf_hooks');
const { createGameEngine } = require('../../server/gameEngine');
const sabotage = require('../../server/sabotage');

const MINUTES = Number(process.env.SOAK_MINUTES || 10);
const events = { total: 0, byType: {} };
const io = { to: () => ({ emit: (e) => { events.total++; events.byType[e] = (events.byType[e] || 0) + 1; } }), sockets: { sockets: new Map() } };
const engine = createGameEngine(io, () => {}, () => {}, () => {}, () => true);
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const handles = () => (process._getActiveHandles ? process._getActiveHandles().length : -1);
const mb = (b) => Math.round((b / 1048576) * 10) / 10;

(async () => {
  const matches = [];
  for (let m = 0; m < 9; m++) {
    const match = await engine.createMatch('quick', { configOverrides: { durationSeconds: MINUTES * 60 + 60 } });
    for (let p = 0; p < 6; p++) engine.joinMatch(match, { id: `bot-${m}-${p}`, username: `Bot${m}${p}`, war_rating: 800 + p * 500, unlockedCards: Object.keys(sabotage.CARDS) }, `sock-${m}-${p}`);
    matches.push(match);
  }
  for (const m of matches) await engine.hostStartMatch?.(m.id, m.hostId).catch?.(() => {});
  // Start directly (countdown skipped) through the same activation path.
  for (const m of matches) if (m.status !== 'active') { m.status = 'countdown'; }
  await new Promise((r) => setTimeout(r, 200));
  for (const m of matches) if (m.status !== 'active') engine.forceStartLobby?.(m.id);
  await new Promise((r) => setTimeout(r, 12000));
  const active = matches.filter((m) => m.status === 'active').length;
  console.log(`soak: ${matches.length} matches, ${active} active, ${matches.length * 6} bots, ${MINUTES} minutes`);

  let actions = 0;
  let cardsPlayed = 0;
  let cardErrors = 0;
  const botTimer = setInterval(() => {
    for (const m of matches) {
      if (m.status !== 'active') continue;
      for (const pid of Object.keys(m.players)) {
        const p = m.players[pid];
        const r = Math.random();
        if (r < 0.25 && p.positions.length < 3) {
          engine.openTrade(m.id, pid, { symbol: m.instruments[Math.floor(Math.random() * m.instruments.length)], direction: Math.random() < 0.5 ? 'BUY' : 'SELL', lots: 0.1, takeProfitPips: 30, stopLossPips: 30 });
          actions++;
        } else if (r < 0.45 && p.positions.length) {
          engine.closeTrade(m.id, pid, p.positions[0].id, 'manual');
          actions++;
        } else if (r < 0.5) {
          const card = p.cards.find((c) => !c.used);
          if (card) {
            const others = Object.keys(m.players).filter((x) => x !== pid);
            const res = engine.playSabotageCard(m.id, pid, card.type, { targetId: others[Math.floor(Math.random() * others.length)] });
            if (res.success) cardsPlayed++;
            else cardErrors++;
          }
        }
      }
    }
  }, 1000);

  const samples = [];
  const sample = (label) => {
    global.gc && global.gc();
    const s = { t: label, heapMB: mb(process.memoryUsage().heapUsed), rssMB: mb(process.memoryUsage().rss), loopP99ms: Math.round(loop.percentile(99) / 1e6), loopMaxMs: Math.round(loop.max / 1e6), handles: handles(), events: events.total, actions, cardsPlayed };
    samples.push(s);
    console.log(JSON.stringify(s));
    loop.reset();
  };
  sample('0s');
  for (let i = 1; i <= MINUTES * 2; i++) {
    await new Promise((r) => setTimeout(r, 30000));
    sample(`${i * 30}s`);
  }
  clearInterval(botTimer);
  const first = samples[1];
  const last = samples[samples.length - 1];
  const mid = samples[Math.floor(samples.length / 2)];
  const heapGrowth = last.heapMB - mid.heapMB;
  console.log(`events by type: ${JSON.stringify(Object.entries(events.byType).sort((a, b) => b[1] - a[1]).slice(0, 14))}`);
  console.log(`cards played ${cardsPlayed}, refused by guards ${cardErrors}, trade actions ${actions}`);
  console.log(`heap first ${first.heapMB}MB, mid ${mid.heapMB}MB, last ${last.heapMB}MB (second-half growth ${heapGrowth.toFixed(1)}MB); handles ${first.handles} -> ${last.handles}; worst loop p99 ${Math.max(...samples.map((s) => s.loopP99ms))}ms`);
  const ok = heapGrowth < 25 && last.handles <= first.handles + 2 && Math.max(...samples.slice(1).map((s) => s.loopP99ms)) < 100;
  console.log(ok ? 'PASS soak: memory, event-loop lag and handles flat' : 'FAIL soak');
  for (const m of matches) await engine.forceEndMatch?.(m.id).catch?.(() => {});
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
