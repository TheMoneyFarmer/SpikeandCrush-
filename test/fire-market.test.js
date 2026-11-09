'use strict';

// Part 1 tests: curated playlists, the seeded intrabar generator, seams,
// selectors and no future data. Runs on the real data/curated output.
const test = require('node:test');
const assert = require('node:assert');
const instruments = require('../server/instruments');
const curated = require('../server/curated');
const intrabar = require('../server/intrabar');
const gameFeel = require('../server/config/gameFeel');
const { competitionInstruments, TEMPLATES } = require('../server/compEngine');

const cat = curated.load();
const KEPT = Object.keys(cat.instruments);
const ALL = Object.keys(instruments.INSTRUMENTS);
const DROPPED = ALL.filter((s) => !KEPT.includes(s));
const FLAT_LIMIT = gameFeel.get().market.flatLimitSeconds;

function longestFlat(mids) {
  let longest = 0;
  let run = 0;
  for (let i = 1; i < mids.length; i++) {
    if (mids[i] === mids[i - 1]) longest = Math.max(longest, ++run);
    else run = 0;
  }
  return longest;
}

test('every kept instrument: 200 random matches per mode stay within the flat limit (live + pre-match history)', () => {
  for (const sym of KEPT) {
    for (const secs of [180, 600, 900, 1200]) {
      for (let k = 0; k < 200; k++) {
        const id = `flat-${sym}-${secs}-${k}`;
        instruments.assignMatchWindow(id, sym, id, Math.ceil(secs / 60));
        const live = instruments.getFullLiveSeries(id, sym).slice(0, secs).map((p) => p.mid);
        const pre = instruments.getPreMatchHistory(id, sym).map((p) => p.mid);
        instruments.releaseMatchWindows(id);
        const worst = Math.max(longestFlat(live), longestFlat(pre.concat(live)));
        assert.ok(worst <= FLAT_LIMIT, `${sym} ${secs}s match ${k}: flat ${worst}s`);
      }
    }
  }
});

test('intrabar generator: base OHLC unchanged when re-aggregated to 1m, 5m, 15m; deterministic', () => {
  for (const sym of KEPT) {
    const pl = curated.getPlaylist(sym);
    const dec = pl.decimals;
    const start = 1000 % pl.bars.length;
    const bars = curated.barsAt(sym, start, 30);
    const ticks = bars.flatMap((b) => Array.from(intrabar.barPath(b, 60, dec, 'seed-a', `${sym}:${b.index}`)));
    for (const tf of [1, 5, 15]) {
      for (let g = 0; g + tf <= bars.length; g += tf) {
        const slice = ticks.slice(g * 60, (g + tf) * 60);
        const group = bars.slice(g, g + tf);
        assert.strictEqual(slice[0], group[0].open, `${sym} ${tf}m open`);
        assert.strictEqual(slice[slice.length - 1], group[group.length - 1].close, `${sym} ${tf}m close`);
        assert.strictEqual(Math.max(...slice), Math.max(...group.map((b) => b.high)), `${sym} ${tf}m high`);
        assert.strictEqual(Math.min(...slice), Math.min(...group.map((b) => b.low)), `${sym} ${tf}m low`);
      }
    }
    const again = bars.flatMap((b) => Array.from(intrabar.barPath(b, 60, dec, 'seed-a', `${sym}:${b.index}`)));
    assert.deepStrictEqual(again, ticks, `${sym} not deterministic`);
  }
});

test('two players in the same match get byte-identical candles; same seed + offset reproduces a match', () => {
  const sym = KEPT[0];
  instruments.assignMatchWindow('same-1', sym, 'shared-seed', 10, {});
  const info = instruments.getMarketInfo('same-1')[sym];
  const a = JSON.stringify(instruments.getPreMatchHistory('same-1', sym)) + JSON.stringify(instruments.getFullLiveSeries('same-1', sym));
  const b = JSON.stringify(instruments.getPreMatchHistory('same-1', sym)) + JSON.stringify(instruments.getFullLiveSeries('same-1', sym));
  assert.strictEqual(a, b);
  // A ghost challenge: a different match id with the same seed and start.
  instruments.assignMatchWindow('ghost-1', sym, info.seed, 10, { startIndex: info.start });
  const c = JSON.stringify(instruments.getPreMatchHistory('ghost-1', sym)) + JSON.stringify(instruments.getFullLiveSeries('ghost-1', sym));
  assert.strictEqual(c, a);
  instruments.releaseMatchWindows('same-1');
  instruments.releaseMatchWindows('ghost-1');
});

test('seams: zero price jump at every seam and at the loop closure; all prices inside the band', () => {
  const band = gameFeel.get().market.priceBandPct;
  for (const sym of KEPT) {
    const pl = curated.getPlaylist(sym);
    const n = pl.bars.length;
    for (let i = 0; i < n; i++) {
      const prev = pl.bars[(i - 1 + n) % n];
      assert.strictEqual(pl.bars[i][0], prev[3], `${sym} bar ${i}: open != previous close`);
    }
    const c = cat.instruments[sym];
    assert.ok(c.bandPct.low >= -band && c.bandPct.high <= band, `${sym} band ${JSON.stringify(c.bandPct)}`);
  }
});

test('seconds-level jump across a seam is no bigger than a normal in-bar step', () => {
  const factor = gameFeel.get().market.seamJumpFactor;
  for (const sym of KEPT) {
    const pl = curated.getPlaylist(sym);
    const point = 10 ** -pl.decimals;
    for (const seam of pl.seams) {
      const bars = curated.barsAt(sym, seam - 3, 6);
      const ticks = bars.flatMap((b) => Array.from(intrabar.barPath(b, 60, pl.decimals, 'seam', `${sym}:${b.index}`)));
      const steps = [];
      for (let i = 1; i < ticks.length; i++) steps.push(Math.abs(ticks[i] - ticks[i - 1]));
      const typical = steps.slice().sort((x, y) => x - y)[Math.floor(steps.length / 2)] || point;
      const atSeam = Math.abs(ticks[180] - ticks[179]);
      assert.ok(atSeam <= Math.max(typical, point) * factor + 1e-12, `${sym} seam ${seam}: jump ${atSeam} vs typical ${typical}`);
    }
  }
});

test('no future leak: 1,000 random history requests never return a tick after the current data time', () => {
  const sym = KEPT[1];
  instruments.assignMatchWindow('leak-1', sym, 'leak', 10, {});
  for (let k = 0; k < 1000; k++) {
    const elapsed = Math.floor(Math.random() * 600);
    const played = instruments.getFullLiveSeries('leak-1', sym).slice(0, instruments.dataSecondsFor('leak-1', sym, elapsed) + 1);
    const pre = instruments.getPreMatchHistory('leak-1', sym);
    const ctx = instruments.getChartContext('leak-1', sym);
    assert.ok(played.every((p) => p.t <= elapsed));
    assert.ok(pre.every((p) => p.t < 0));
    assert.ok(ctx.context.m1.every((r) => r[0] < -instruments.PRE_MATCH_MINUTES * 60 + 1));
  }
  instruments.releaseMatchWindows('leak-1');
});

test('selectors: no dropped instrument in any random draw, daily set, solo pin or competition template', () => {
  for (let k = 0; k < 500; k++) {
    for (const mode of ['quick', 'blitz', 'grand', 'private', 'solo', 'tournament']) {
      for (const s of instruments.selectMatchInstruments(5, mode)) assert.ok(KEPT.includes(s), `${mode} drew ${s}`);
    }
    for (const s of instruments.selectDailyInstruments(`2026-11-${k}`, 3)) assert.ok(KEPT.includes(s), `async drew ${s}`);
  }
  for (const s of DROPPED) assert.strictEqual(instruments.isPlayable(s, 'solo'), false, `${s} still playable`);
  for (const [name, tpl] of Object.entries(TEMPLATES)) {
    const got = competitionInstruments(tpl.instruments);
    assert.strictEqual(got.length, tpl.instruments.length, `${name} shrank`);
    for (const s of got) assert.ok(KEPT.includes(s), `${name} competition has ${s}`);
  }
});

test('admin switch: disabling an instrument removes it from every draw; per-mode switch only from that mode', () => {
  const sym = KEPT[0];
  gameFeel.applyOverrides({ market: { enabledOverride: { [sym]: false } } });
  for (let k = 0; k < 200; k++) assert.ok(!instruments.selectMatchInstruments(5, 'quick').includes(sym));
  gameFeel.applyOverrides({ market: { enabledPerMode: { [sym]: { blitz: false } } } });
  assert.strictEqual(instruments.isPlayable(sym, 'blitz'), false);
  assert.strictEqual(instruments.isPlayable(sym, 'quick'), true);
  gameFeel.applyOverrides({});
});

test('replay speed: data time = real elapsed x speed in one function; SL/TP range helper sees skipped ticks', () => {
  const sym = KEPT[2];
  for (const speed of [1, 3, 5]) {
    const id = `speed-${speed}`;
    instruments.assignMatchWindow(id, sym, id, 3, { speed });
    assert.strictEqual(instruments.dataSecondsFor(id, sym, 10), 10 * speed);
    assert.strictEqual(instruments.getFullLiveSeries(id, sym).length, 3 * 60 * speed);
    const p = instruments.getCurrentPrice(id, sym, 10);
    assert.strictEqual(p.t, 10 * speed);
    const r = instruments.liveRangeBetween(id, sym, 9 * speed, 10 * speed);
    const live = instruments.getFullLiveSeries(id, sym).slice(9 * speed + 1, 10 * speed + 1).map((x) => x.mid);
    assert.strictEqual(r.low, Math.min(...live));
    assert.strictEqual(r.high, Math.max(...live));
    instruments.releaseMatchWindows(id);
  }
});

test('spike schedule only lists real indexed events from the playlist', () => {
  for (const sym of KEPT) {
    const pl = curated.getPlaylist(sym);
    const id = `spike-${sym}`;
    instruments.assignMatchWindow(id, sym, id, 20, {});
    const start = instruments.getMarketInfo(id)[sym].start;
    for (const s of instruments.getSpikeSchedule(id, sym)) {
      const idx = (start + s.dataSecond / 60) % pl.bars.length;
      assert.ok(pl.spikes.some((x) => x.i === idx && x.movePct === s.movePct), `${sym} invented spike at ${idx}`);
    }
    instruments.releaseMatchWindows(id);
  }
});
