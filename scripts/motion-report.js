#!/usr/bin/env node
'use strict';

// Motion report: how much the chart a player sees actually moves.
//   node scripts/motion-report.js [matchesPerMode=200] [--json out.json]
//
// For every mode it builds N match windows exactly the way the engine does
// (same instrument picker, same window assignment, same replay speed), then
// samples the price at the rate the server delivers it and measures, on the
// default 5-second chart candles:
//   candles      displayed candles per match
//   chg/s        price changes the player sees per real second
//   flat max     longest run of "flat" real seconds (a second is flat when the
//                price moved less than 5% of the match's median candle range
//                within it), in seconds
//   flat %       share of the match spent in flat seconds
//   continuity   share of matches passing the continuity rule (10 slices each
//                with range >= 25% of the median slice range; no run of more
//                than 3 candles with a body under 5% of the average body; no
//                single candle holding more than 50% of the window's range)
//   floor ok     share of seconds with at least `floorChanges` price changes
// Numbers per mode are medians over matches and instruments, plus the worst
// match for flat max.

const path = require('path');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || '';
const instruments = require(path.join(__dirname, '..', 'server', 'instruments'));
const { MATCH_MODES } = require(path.join(__dirname, '..', 'server', 'gameEngine'));
const gameFeel = require(path.join(__dirname, '..', 'server', 'config', 'gameFeel'));
const modeIdentity = require(path.join(__dirname, '..', 'server', 'config', 'modeIdentity'));

const N = Number(process.argv[2]) || 200;
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const TF = 5; // default chart candle, seconds (client/js/chart.js DEFAULT_TIMEFRAME)
const MODES = (process.env.MOTION_MODES || 'blitz,quick,grand,tournament,solo,private,stocks,futures').split(',');

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };

// The engine's delivery: how many price messages per real second, and the
// price function at a real time t (seconds since start). Kept here in one
// place so the "after" engine can plug in its own.
function engineDelivery() {
  const market = gameFeel.get().market || {};
  return { hz: Number(market.deliveryHz) || 1, floorChanges: Number(market.minChangesPerSecond) || 4 };
}
function priceAt(matchId, symbol, t, hz) {
  if (typeof instruments.getPriceAt === 'function' && hz > 1) return instruments.getPriceAt(matchId, symbol, t).mid;
  return instruments.getCurrentPrice(matchId, symbol, Math.floor(t)).mid;
}
function speedFor(mode) {
  const m = gameFeel.get().market;
  const v = Math.floor(Number(m.replaySpeed && m.replaySpeed[mode]) || 1);
  return Math.max(1, Math.min(Number(m.maxReplaySpeed) || 1, v));
}

function measure(samples, hz, duration, speed, floorChanges) {
  // Displayed candles are built on market time (data seconds) like the chart.
  const candles = [];
  for (const [t, p] of samples) {
    const k = Math.floor((t * speed) / TF);
    const c = candles[k] || (candles[k] = { o: p, h: p, l: p, c: p });
    c.h = Math.max(c.h, p); c.l = Math.min(c.l, p); c.c = p;
  }
  const real = candles.filter(Boolean);
  const ranges = real.map((c) => c.h - c.l);
  const medRange = median(ranges) || 1e-12;
  // Per real second: moves and range.
  const secs = Math.ceil(duration);
  let flatRun = 0; let flatMax = 0; let flatCount = 0; let floorOk = 0; let changes = 0;
  // The first message is a new price versus the pre-match chart.
  let prev = NaN;
  for (let s = 0; s < secs; s++) {
    const inSec = samples.filter(([t]) => t >= s && t < s + 1).map(([, p]) => p);
    let lo = Number.isNaN(prev) ? Infinity : prev; let hi = Number.isNaN(prev) ? -Infinity : prev; let ch = 0;
    for (const p of inSec) { if (p !== prev) ch++; lo = Math.min(lo, p); hi = Math.max(hi, p); prev = p; }
    changes += ch;
    if (ch >= floorChanges) floorOk++;
    const flat = hi - lo < 0.05 * medRange;
    if (flat) { flatCount++; flatRun++; flatMax = Math.max(flatMax, flatRun); } else flatRun = 0;
  }
  // Continuity rule on the displayed candles.
  const all = samples.map(([, p]) => p);
  const winRange = Math.max(...all) - Math.min(...all) || 1e-12;
  const slices = [];
  for (let i = 0; i < 10; i++) {
    const part = all.slice(Math.floor((i * all.length) / 10), Math.floor(((i + 1) * all.length) / 10));
    slices.push(part.length ? Math.max(...part) - Math.min(...part) : 0);
  }
  const medSlice = median(slices);
  const slicesOk = slices.every((r) => r >= 0.25 * medSlice);
  const bodies = real.map((c) => Math.abs(c.c - c.o));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / (bodies.length || 1);
  let run = 0; let maxRun = 0;
  for (const b of bodies) { if (b < 0.05 * avgBody) { run++; maxRun = Math.max(maxRun, run); } else run = 0; }
  const bigCandle = Math.max(...ranges) > 0.5 * winRange;
  const continuity = slicesOk && maxRun <= 3 && !bigCandle;
  return { candles: real.length, chgPerSec: changes / secs, flatMax, flatShare: flatCount / secs, floorShare: floorOk / secs, continuity };
}

function main() {
  instruments.preloadAll();
  const { hz, floorChanges } = engineDelivery();
  const rows = [];
  for (const mode of MODES) {
    const cfg = MATCH_MODES[mode];
    if (!cfg) continue;
    const duration = cfg.durationSeconds;
    const speed = speedFor(mode);
    const rules = modeIdentity.rulesFor ? modeIdentity.rulesFor(mode) : {};
    const per = [];
    for (let i = 0; i < N; i++) {
      const matchId = `motion-${mode}-${i}`;
      const opts = { ...(rules.instrumentPool === 'top' ? { topN: rules.instrumentPoolSize || 6 } : {}), classes: rules.instrumentClasses, dataSeconds: duration * speed };
      const symbols = instruments.selectMatchInstruments(cfg.instrumentCount || 5, mode, opts);
      for (const symbol of symbols) {
        instruments.assignMatchWindow(matchId, symbol, `motion:${mode}:${i}`, Math.ceil(duration / 60), { speed });
        const samples = [];
        for (let k = 0; k < duration * hz; k++) { const t = k / hz; samples.push([t, priceAt(matchId, symbol, t, hz)]); }
        per.push({ symbol, ...measure(samples, hz, duration, speed, floorChanges) });
      }
      instruments.releaseMatchWindows(matchId);
    }
    const row = {
      mode, duration, speed, hz,
      candles: median(per.map((r) => r.candles)),
      chgPerSec: Number(median(per.map((r) => r.chgPerSec)).toFixed(2)),
      flatMaxMedian: median(per.map((r) => r.flatMax)),
      flatMaxWorst: Math.max(...per.map((r) => r.flatMax)),
      flatSharePct: Number((100 * median(per.map((r) => r.flatShare))).toFixed(1)),
      floorOkPct: Number((100 * median(per.map((r) => r.floorShare))).toFixed(1)),
      continuityPct: Number((100 * per.filter((r) => r.continuity).length / per.length).toFixed(1)),
      samples: per.length,
    };
    rows.push(row);
  }
  console.log(`Motion report: ${N} matches per mode, delivery ${hz}/s, ${TF}s candles, floor ${floorChanges} changes/s`);
  console.log('mode        len  speed  candles  chg/s  flatMax(med/worst)  flat%  floor-ok%  continuity%  samples');
  for (const r of rows) {
    console.log(`${r.mode.padEnd(10)} ${String(r.duration).padStart(5)}  ${String(r.speed).padStart(4)}x  ${String(r.candles).padStart(7)}  ${String(r.chgPerSec).padStart(5)}  ${`${r.flatMaxMedian}/${r.flatMaxWorst}`.padStart(17)}  ${String(r.flatSharePct).padStart(5)}  ${String(r.floorOkPct).padStart(9)}  ${String(r.continuityPct).padStart(11)}  ${r.samples}`);
  }
  if (jsonOut) require('fs').writeFileSync(jsonOut, JSON.stringify(rows, null, 2));
}

main();
