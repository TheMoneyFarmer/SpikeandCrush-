'use strict';
// How often Grand War finds a real top-5% move within +-120s of each event
// minute (5/10/15). Builds N Grand matches offline (no database) and runs the
// same search planModeSchedule() uses. Usage: node scripts/measure-grand-events.js [N]
process.env.SUPABASE_URL = '';
const instruments = require('../server/instruments');
const { createGameEngine } = require('../server/gameEngine');
const modeIdentity = require('../server/config/modeIdentity');

const fakeIo = () => ({ to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } });

(async () => {
  if (process.env.EVENTS) modeIdentity.applyOverrides({ grand: { events: JSON.parse(process.env.EVENTS) } });
  await instruments.preloadAll?.();
  const N = Number(process.argv[2]) || 200;
  const ev = modeIdentity.rulesFor('grand').events;
  const engine = createGameEngine(fakeIo(), () => {}, () => {}, () => {}, () => true);
  const perMinute = Object.fromEntries(ev.minutes.map((m) => [m, 0]));
  let allThree = 0;
  let none = 0;
  let spread = 0;
  for (let i = 0; i < N; i++) {
    const match = await engine.createMatch('grand');
    const movesAt = (pct) => match.instruments.flatMap((s) => instruments.getBigMoves(match.id, s, pct));
    const strong = movesAt(ev.topPercent || 10);
    const wide = ev.fallbackTopPercent ? movesAt(ev.fallbackTopPercent) : [];
    let found = 0;
    const used = [];
    const syms = new Set();
    for (const minute of ev.minutes) {
      const at = minute * 60;
      const pick = (list) => list.filter((e) => Math.abs(e.dataSecond - at) <= (ev.searchWindowSeconds || 120) && !used.includes(e.dataSecond)).sort((a, b) => (syms.has(a.symbol) - syms.has(b.symbol)) || b.rangeBps - a.rangeBps)[0];
      const near = pick(strong) || pick(wide);
      if (near) { perMinute[minute] += 1; found += 1; used.push(near.dataSecond); syms.add(near.symbol); }
    }
    if (found === ev.minutes.length) allThree += 1;
    if (!found) none += 1;
    if (syms.size >= Math.min(found, 2)) spread += 1;
    await engine.forceEndMatch(match.id).catch(() => {});
  }
  const pct = (n) => `${((n / N) * 100).toFixed(1)}%`;
  console.log(`Grand War market events over ${N} matches (top ${ev.topPercent}% then ${ev.fallbackTopPercent || '-'}% moves, +-${ev.searchWindowSeconds}s):`);
  for (const m of ev.minutes) console.log(`  minute ${m}: found ${pct(perMinute[m])}`);
  console.log(`  all ${ev.minutes.length} found: ${pct(allThree)}   none found: ${pct(none)}   events on 2+ instruments: ${pct(spread)}`);
  process.exit(0);
})();
