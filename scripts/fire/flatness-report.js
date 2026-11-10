'use strict';

// Before/after flatness proof and the replay-speed table (docs/fire).
//   node scripts/fire/flatness-report.js
// "Before" = market curation switched off (the old random raw window, exactly
// the code path live today). "After" = curated playlists. 200 matches per
// instrument per mode duration through the real server/instruments.js.
const fs = require('fs');
const path = require('path');
const instruments = require('../../server/instruments');
const gameFeel = require('../../server/config/gameFeel');
const curated = require('../../server/curated');

const N = Number(process.env.FLAT_N || 200);
const DURATIONS = [180, 600, 900, 1200];
const ROOT = path.join(__dirname, '..', '..');
const pct = (a, p) => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

function stats(mids) {
  let longest = 0;
  let run = 0;
  let changes = 0;
  for (let i = 1; i < mids.length; i++) {
    if (mids[i] === mids[i - 1]) longest = Math.max(longest, ++run);
    else {
      run = 0;
      changes++;
    }
  }
  let sum = 0;
  let mins = 0;
  for (let m = 0; m + 60 <= mids.length; m += 60) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = m; k < m + 60; k++) {
      hi = Math.max(hi, mids[k]);
      lo = Math.min(lo, mids[k]);
    }
    sum += ((hi - lo) / ((hi + lo) / 2)) * 1e4;
    mins++;
  }
  return { longest, cpm: changes / (mids.length / 60), bps: sum / mins };
}

function run(sym, secs, label, speed = 1) {
  const L = [];
  const C = [];
  const R = [];
  for (let k = 0; k < N; k++) {
    const id = `${label}-${sym}-${secs}-${k}`;
    instruments.assignMatchWindow(id, sym, id, Math.ceil(secs / 60), { speed });
    // What the player sees: one broadcast per real second at data time t*speed.
    const series = instruments.getFullLiveSeries(id, sym);
    const mids = [];
    for (let t = 0; t < secs; t++) mids.push(series[Math.min(series.length - 1, t * speed)].mid);
    instruments.releaseMatchWindows(id);
    const s = stats(mids);
    L.push(s.longest);
    C.push(s.cpm);
    R.push(s.bps);
  }
  return { med: pct(L, 0.5), worst: Math.max(...L), cpm: pct(C, 0.5), bps: pct(R, 0.5) };
}

const kept = Object.keys(curated.load().instruments);
let md = `# Flatness: before vs after\n\nGenerated ${new Date().toISOString()} by \`node scripts/fire/flatness-report.js\`: ${N} random matches per instrument per mode duration through the real \`server/instruments.js\`. **Before** = curation off (the raw random window live today). **After** = curated playlists + seeded intrabar paths. Flat = consecutive seconds with an unchanged broadcast price. Flat limit: ${gameFeel.get().market.flatLimitSeconds}s.\n\n| Instrument | Mode (s) | Longest flat median before → after | Worst flat before → after | Changes/min before → after | Range bps/min before → after |\n|---|---|---|---|---|---|\n`;
const summary = [];
for (const sym of kept) {
  for (const secs of DURATIONS) {
    gameFeel.applyOverrides({ market: { curatedPlaylists: false } });
    const b = run(sym, secs, 'before');
    gameFeel.applyOverrides({});
    const a = run(sym, secs, 'after');
    summary.push({ sym, secs, b, a });
    md += `| ${sym} | ${secs} | ${b.med} → **${a.med}** | ${b.worst} → **${a.worst}** | ${b.cpm.toFixed(1)} → **${a.cpm.toFixed(1)}** | ${b.bps.toFixed(2)} → **${a.bps.toFixed(2)}** |\n`;
  }
}
const worstAfter = Math.max(...summary.map((r) => r.a.worst));
const worstBefore = Math.max(...summary.map((r) => r.b.worst));
md += `\n**Worst flat stretch over every kept instrument and mode: before ${worstBefore}s, after ${worstAfter}s.**\n`;
fs.writeFileSync(path.join(ROOT, 'docs/fire/flatness-after.md'), md);

// ---- replay speed table ----
let sp = `# Replay speed per mode (measured)\n\nFor each mode length and speed: price changes per real second, median range per real minute (bps), and how many 1-minute base candles form during the match. Medians over the kept instruments, ${Math.min(N, 50)} matches each. The guarantee (no flat stretch over ${gameFeel.get().market.flatLimitSeconds}s, every 3-minute stretch ranging at least the median 1-minute move) is already met at **1x** for every kept instrument (test/fire-market.test.js), so the lowest speed that meets it is 1x in every mode.\n\n| Mode (s) | Speed | Changes / real s | Range bps / real min | 1m candles formed |\n|---|---|---|---|---|\n`;
const saveN = N;
for (const secs of DURATIONS) {
  for (const speed of [1, 2, 3, 5, 10]) {
    const cps = [];
    const bps = [];
    for (const sym of kept) {
      const r = (function () {
        const L = [];
        const C = [];
        const R = [];
        for (let k = 0; k < Math.min(saveN, 50); k++) {
          const id = `spd-${sym}-${secs}-${speed}-${k}`;
          instruments.assignMatchWindow(id, sym, id, Math.ceil(secs / 60), { speed });
          const series = instruments.getFullLiveSeries(id, sym);
          const mids = [];
          for (let t = 0; t < secs; t++) mids.push(series[Math.min(series.length - 1, t * speed)].mid);
          instruments.releaseMatchWindows(id);
          const s = stats(mids);
          L.push(s.longest);
          C.push(s.cpm);
          R.push(s.bps);
        }
        return { cpm: pct(C, 0.5), bps: pct(R, 0.5) };
      })();
      cps.push(r.cpm / 60);
      bps.push(r.bps);
    }
    sp += `| ${secs} | ${speed}x | ${pct(cps, 0.5).toFixed(2)} | ${pct(bps, 0.5).toFixed(2)} | ${Math.floor((secs * speed) / 60)} |\n`;
  }
}
sp += `\n**Chosen: 1x for every short mode** (config \`market.replaySpeed\`, admin-editable, capped at \`market.maxReplaySpeed\` = ${gameFeel.get().market.maxReplaySpeed}). Above 1x a 3-minute Blitz would cover 6+ minutes of market and every 1-second candle would jump several data seconds at a time; curation already removed the quiet stretches, so the extra speed only costs readability. Competitions stay at 1x.\n`;
fs.writeFileSync(path.join(ROOT, 'docs/fire/replay-speed.md'), sp);
console.log(md);
console.log(sp);
