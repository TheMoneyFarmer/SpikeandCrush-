'use strict';

// Market curation: measures every instrument's real 1-minute data, ranks the
// instruments by activity, finds each kept instrument's hot windows, stitches
// them into one closed-loop playlist per instrument and indexes the valid match
// start offsets and the real spike events. Offline, deterministic (no clock,
// no Math.random), reproducible from the data files alone.
//
//   node scripts/curate-data.js [--out data/curated] [--report docs/fire/curation.md]
//
// Output:
//   data/curated/<SYMBOL>.playlist.json   bars, seams, spikes, valid starts
//   data/curated/catalog.json             scores, ranking, cutoff, windows,
//                                         active minutes, valid-start counts
//   docs/fire/curation.md                 the human-readable report
//
// Nothing here hard-codes instrument names or session hours as truth: the
// session hints below are only checked against the data and reported.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = path.resolve(ROOT, argOf('--out', 'data/curated'));
const REPORT = path.resolve(ROOT, argOf('--report', 'docs/fire/curation.md'));

const instruments = require('../server/instruments');
const feel = require('../server/config/gameFeel').get();

// Match lengths in DATA seconds to index valid starts for: the four mode
// lengths at 1x, plus longer spans so any mode at up to 10x replay speed is covered.
const MODE_SECONDS = [180, 600, 900, 1200, 1800, 3000, 6000, 12000];
const HISTORY_MIN = instruments.PRE_MATCH_MINUTES; // chart history before the start
const WINDOW_MIN = 30; // sliding window for hot-window search
const WINDOW_STEP = 5;
const MIN_SEGMENT_MIN = 20; // shortest stretch worth keeping as a playlist segment
// Curated competition series run on their own synthetic clock starting here
// (2030-01-07 00:00 UTC), so a data time tells replayClock which series it
// belongs to and can never be looked up against the real calendar.
const COMP_EPOCH = Date.UTC(2030, 0, 7) / 1000;
const KEEP_SHARE = 0.4; // top 40% of instruments...
const KEEP_MIN = 8; // ...never fewer than 8...
const PER_CLASS_MIN = 2; // ...and at least 2 per available asset class

// Asset classes the spec asks to cover. 'commodities' here is oil.
const CLASS_OF = (cat) => ({ forex: 'forex', indices: 'indices', metals: 'metals', commodities: 'oil', crypto: 'crypto', stocks: 'stocks' })[cat] || cat;
const REQUIRED_CLASSES = ['forex', 'indices', 'metals', 'oil', 'crypto'];

// Session hints from the spec, in America/New_York local hours. Checked, not trusted.
const HINTS = {
  indices: { label: 'US cash open 09:30-12:30 New York', hours: [9, 10, 11, 12] },
  forex: { label: 'London/New York overlap 08:00-11:00 New York', hours: [8, 9, 10] },
  metals: { label: 'US session open 08:00-10:59 New York', hours: [8, 9, 10] },
  oil: { label: 'US session open 08:00-10:59 New York', hours: [8, 9, 10] },
  crypto: { label: 'measured busiest hours (no prior hint)', hours: null },
  stocks: { label: 'US cash session 09:30-16:00 New York', hours: [9, 10, 11, 12, 13, 14, 15] },
};

const nyHour = (() => {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
  return (t) => Number(fmt.format(new Date(t * 1000)));
})();

const median = (a) => {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[Math.floor(s.length / 2)];
};
const quantile = (a, q) => {
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function loadM1(sym, tf = 'm1') {
  const f = path.join(ROOT, 'data/market', sym, `${tf}.csv.gz`);
  if (!fs.existsSync(f)) return null;
  const rows = zlib.gunzipSync(fs.readFileSync(f)).toString().trim().split('\n');
  rows.shift();
  return rows.map((r) => {
    const [time, open, high, low, close] = r.split(',').map(Number);
    return { time, open, high, low, close };
  });
}

// ---------------------------------------------------------------------------
// 1. Measure every instrument
// ---------------------------------------------------------------------------
function measure(sym, cfg, bars) {
  const point = 10 ** -cfg.decimals;
  const ranges = bars.map((b) => b.high - b.low);
  const rangeBps = bars.map((b) => ((b.high - b.low) / ((b.high + b.low) / 2)) * 1e4);
  const absRetBps = bars.map((b) => (Math.abs(b.close - b.open) / b.open) * 1e4);
  const flatBar = bars.map((b) => Math.round((b.high - b.low) / point) < 2);
  let longestFlat = 0;
  let run = 0;
  for (let i = 0; i < bars.length; i++) {
    const contiguous = i === 0 || bars[i].time - bars[i - 1].time === 60;
    run = flatBar[i] && contiguous ? run + 1 : flatBar[i] ? 1 : 0;
    longestFlat = Math.max(longestFlat, run);
  }
  const medRange = median(ranges);
  const medBps = median(rangeBps);
  const spreadRatio = medRange / cfg.spread;
  const activeShare = flatBar.filter((f) => !f).length / bars.length;
  // Activity score: visible movement in percent terms (what moves P&L at a
  // fixed capital and leverage) x how much of it clears the spread x how much
  // of the time the market is alive at all.
  const score = medBps * Math.min(1, spreadRatio / 2) * activeShare;
  return {
    sym,
    category: cfg.category,
    cls: CLASS_OF(cfg.category),
    bars: bars.length,
    days: (bars[bars.length - 1].time - bars[0].time) / 86400,
    medRange,
    medBps,
    meanAbsRetBps: absRetBps.reduce((s, v) => s + v, 0) / absRetBps.length,
    flatShare: 1 - activeShare,
    longestFlatMin: longestFlat,
    spreadRatio,
    volume: 'none (no volume or tick-count column in the files; range is the activity proxy)',
    score,
  };
}

// ---------------------------------------------------------------------------
// 2. Rank and cut
// ---------------------------------------------------------------------------
function rankAndCut(stats) {
  const ranked = stats.slice().sort((a, b) => b.score - a.score);
  const n = ranked.length;
  const minKeep = Math.max(KEEP_MIN, Math.ceil(n * KEEP_SHARE));
  // Natural gap: the biggest relative drop in score at or after minKeep.
  let cut = minKeep;
  let bestGap = 0;
  for (let i = minKeep; i < n; i++) {
    const gap = ranked[i - 1].score / Math.max(ranked[i].score, 1e-9);
    if (gap > bestGap) {
      bestGap = gap;
      cut = i;
    }
    if (i >= minKeep + 3) break; // look only a little past the minimum
  }
  const kept = new Set(ranked.slice(0, cut).map((s) => s.sym));
  const forced = [];
  for (const cls of REQUIRED_CLASSES) {
    const inClass = ranked.filter((s) => s.cls === cls);
    let have = inClass.filter((s) => kept.has(s.sym)).length;
    for (const s of inClass) {
      if (have >= Math.min(PER_CLASS_MIN, inClass.length)) break;
      if (!kept.has(s.sym)) {
        kept.add(s.sym);
        forced.push(s.sym);
        have++;
      }
    }
  }
  return { ranked, cut, gap: bestGap, kept, forced };
}

// ---------------------------------------------------------------------------
// 3. Hot windows + no-flat guarantee
// ---------------------------------------------------------------------------
// A bar is alive when it spans at least 2 price points. A pair of consecutive
// bars passes the guarantee when their combined range is at least the
// instrument's median 1-minute range - any 3-minute stretch of real time holds
// two full bars, so this is the conservative form of "every rolling 3-minute
// stretch ranges at least the median 1-minute range".
function hotWindows(bars, st, cfg, opts = {}) {
  const barSeconds = opts.barSeconds || 60;
  const W = opts.window || WINDOW_MIN; // in bars
  const STEP = opts.step || WINDOW_STEP;
  const minSeg = opts.minSegment || MIN_SEGMENT_MIN;
  const pairNeed = opts.pairNeed || st.medRange;
  const point = 10 ** -cfg.decimals;
  const n = bars.length;
  // opts.minBarRange: competition bars must each range at least the median
  // 1-minute move so the swing-mode path (server/intrabar.js) can guarantee it
  // inside every 3-minute stretch.
  const minBar = opts.minBarRange || 0;
  const alive = bars.map((b) => Math.round((b.high - b.low) / point) >= 2 && b.high - b.low >= minBar);
  const contiguous = bars.map((b, i) => i > 0 && b.time - bars[i - 1].time === barSeconds);
  const pairOk = bars.map((b, i) => i > 0 && contiguous[i] && Math.max(b.high, bars[i - 1].high) - Math.min(b.low, bars[i - 1].low) >= pairNeed);
  const rel = bars.map((b) => (b.high - b.low) / st.medRange);
  const windows = [];
  for (let s = 0; s + W <= n; s += STEP) {
    let ok = alive[s];
    let sum = 0;
    for (let i = s; i < s + W && ok; i++) {
      if (!alive[i]) ok = false;
      if (i > s && !pairOk[i]) ok = false;
      sum += Math.min(rel[i], 3);
    }
    if (!ok) continue;
    windows.push({ start: s, score: sum / W });
  }
  // Hot = window activity at least HOT x the instrument's own median bar.
  const HOT = opts.hot || 1.25;
  const chosen = new Uint8Array(n);
  for (const w of windows) if (w.score >= HOT) for (let i = w.start; i < w.start + W; i++) chosen[i] = 1;
  // Merge into contiguous segments (breaks at time gaps and failed pairs).
  const segments = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    const join = cur && chosen[i] && contiguous[i] && pairOk[i] && i === cur.end;
    if (join) cur.end = i + 1;
    else if (chosen[i]) {
      if (cur) segments.push(cur);
      cur = { start: i, end: i + 1 };
    }
  }
  if (cur) segments.push(cur);
  return { windows, hotThreshold: HOT, segments: segments.filter((s) => s.end - s.start >= minSeg) };
}

function sessionProfile(bars, st) {
  const sum = new Array(24).fill(0);
  const cnt = new Array(24).fill(0);
  for (const b of bars) {
    const h = nyHour(b.time);
    sum[h] += (b.high - b.low) / st.medRange;
    cnt[h]++;
  }
  const mean = sum.map((s, h) => (cnt[h] ? s / cnt[h] : 0));
  const overall = sum.reduce((a, b) => a + b, 0) / cnt.reduce((a, b) => a + b, 0);
  const order = mean.map((m, h) => [h, m]).filter(([h]) => cnt[h] > 30).sort((a, b) => b[1] - a[1]);
  return { mean, overall, top: order.slice(0, 4).map(([h, m]) => ({ hour: h, rel: m / overall })) };
}

function checkHint(cls, profile) {
  const hint = HINTS[cls];
  if (!hint || !hint.hours) return { label: hint ? hint.label : '-', held: 'n/a', note: `busiest New York hours: ${profile.top.map((t) => `${String(t.hour).padStart(2, '0')}:00 (${t.rel.toFixed(2)}x)`).join(', ')}` };
  const hintRel = hint.hours.reduce((s, h) => s + profile.mean[h], 0) / hint.hours.length / profile.overall;
  const rankOf = (h) => profile.mean.map((m, i) => [i, m]).sort((a, b) => b[1] - a[1]).findIndex(([i]) => i === h);
  const inTopThird = hint.hours.filter((h) => rankOf(h) < 8).length / hint.hours.length;
  const held = hintRel >= 1.25 && inTopThird >= 0.5;
  return {
    label: hint.label,
    held: held ? 'HELD' : 'did not hold',
    note: `hint hours run at ${hintRel.toFixed(2)}x the day average; busiest NY hours measured: ${profile.top.map((t) => `${String(t.hour).padStart(2, '0')}:00 (${t.rel.toFixed(2)}x)`).join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// 4. Stitch into a closed loop
// ---------------------------------------------------------------------------
// Ratio rebasing: each next segment is scaled so its first open equals the
// previous segment's last close, which keeps every percentage return intact
// and leaves no gap at a seam. The loop's total drift is then spread evenly
// over every minute of the loop (a tiny per-minute factor, far below one
// price point per minute on every instrument) so the loop closes exactly and
// no seam carries a correction jump.
// Order segments so the stitched price stays inside the band: date order when
// that already holds, otherwise a deterministic greedy pass that always takes
// the earliest remaining segment whose whole path stays within 80% of the
// band from where the price is now, or else the one that ends closest to the
// median. Ratio rebasing keeps every segment's own returns intact either way.
function orderSegments(bars, segments, bandPct) {
  const info = segments.map((s) => {
    const base = bars[s.start].open;
    let hi = 0;
    let lo = 0;
    for (let i = s.start; i < s.end; i++) {
      hi = Math.max(hi, Math.log(bars[i].high / base));
      lo = Math.min(lo, Math.log(bars[i].low / base));
    }
    return { seg: s, ret: Math.log(bars[s.end - 1].close / base), hi, lo };
  });
  const limit = Math.log(1 + bandPct / 100);
  let level = 0;
  let ok = true;
  for (const x of info) {
    if (level + x.hi > limit || level + x.lo < -limit) ok = false;
    level += x.ret;
  }
  if (ok) return { order: segments, reordered: false };
  const left = info.slice();
  const order = [];
  level = 0;
  const soft = limit * 0.8;
  while (left.length) {
    // Among segments whose whole path stays inside the soft band, the one
    // that ends nearest the median; if none fits, the one that ends nearest.
    let pick = -1;
    let best = Infinity;
    left.forEach((x, k) => {
      const fits = level + x.hi <= soft && level + x.lo >= -soft;
      const d = Math.abs(level + x.ret) + (fits ? 0 : 10);
      if (d < best) {
        best = d;
        pick = k;
      }
    });
    const [x] = left.splice(pick, 1);
    order.push(x.seg);
    level += x.ret;
  }
  return { order, reordered: true };
}

// The loop's total drift is the sum of every segment's return whatever the
// order. When the history trended hard (months of 5-minute data), drop the
// biggest segments moving in the drift's direction until the net drift is
// within maxDriftPct - real paths only, nothing invented - so the loop can
// close without tilting every price.
function balanceDrift(bars, segments, maxDriftPct) {
  const ret = (s) => Math.log(bars[s.end - 1].close / bars[s.start].open);
  const keep = segments.slice();
  let total = keep.reduce((sum, s) => sum + ret(s), 0);
  const limit = Math.log(1 + maxDriftPct / 100);
  let dropped = 0;
  while (Math.abs(total) > limit && keep.length > 2) {
    const sign = Math.sign(total);
    let k = -1;
    let best = 0;
    keep.forEach((s, i) => {
      const r = ret(s) * sign;
      // the largest same-direction move that doesn't overshoot past -limit
      if (r > best && Math.abs(total) - r > -limit) {
        best = r;
        k = i;
      }
    });
    if (k === -1) break;
    total -= ret(keep[k]);
    keep.splice(k, 1);
    dropped++;
  }
  return { segments: keep, dropped };
}

// Long segments (a whole crash or rally day) are cut into pieces of at most
// maxBars so the band-keeping order can interleave them.
function splitSegments(segments, maxBars) {
  if (!maxBars) return segments;
  const out = [];
  for (const s of segments) {
    for (let a = s.start; a < s.end; a += maxBars) out.push({ start: a, end: Math.min(s.end, a + maxBars) });
  }
  return out;
}

function stitch(bars, segmentsRaw, cfg, histMedian, opts = {}) {
  const segmentsIn = splitSegments(segmentsRaw, opts.maxSegmentBars);
  const balanced = opts.balanceDriftPct ? balanceDrift(bars, segmentsIn, opts.balanceDriftPct) : { segments: segmentsIn, dropped: 0 };
  const { order: segments, reordered } = orderSegments(bars, balanced.segments, feel.market.priceBandPct);
  const dec = cfg.decimals;
  const round = (v) => Number(v.toFixed(dec));
  const raw = [];
  const seams = [];
  const srcTimes = [];
  let factor = 1;
  let lastClose = null;
  for (const seg of segments) {
    if (lastClose !== null) {
      factor = lastClose / bars[seg.start].open;
      seams.push(raw.length);
    }
    for (let i = seg.start; i < seg.end; i++) {
      const b = bars[i];
      raw.push([b.open * factor, b.high * factor, b.low * factor, b.close * factor]);
      srcTimes.push(b.time);
    }
    lastClose = raw[raw.length - 1][3];
  }
  // Re-anchor the whole loop on the historical median level so the price
  // sits where the instrument normally trades, then detrend to close the loop.
  const N = raw.length;
  const drift = raw[N - 1][3] / raw[0][0];
  const anchor = histMedian / raw[0][0];
  const out = new Array(N);
  let minP = Infinity;
  let maxP = -Infinity;
  for (let i = 0; i < N; i++) {
    // Bar i spans minute i..i+1 of the loop; open uses i, close uses i+1.
    const fo = anchor * drift ** (-i / N);
    const fc = anchor * drift ** (-(i + 1) / N);
    const [o, h, l, c] = raw[i];
    const O = round(o * fo);
    const C = round(c * fc);
    const H = round(Math.max(h * fo, h * fc, O, C));
    const L = round(Math.min(l * fo, l * fc, O, C));
    out[i] = [O, H, L, C];
    minP = Math.min(minP, L);
    maxP = Math.max(maxP, H);
  }
  // Make every seam exact after rounding (open = previous close) and close the loop.
  for (let i = 1; i < N; i++) {
    out[i][0] = out[i - 1][3];
    out[i][1] = Math.max(out[i][1], out[i][0]);
    out[i][2] = Math.min(out[i][2], out[i][0]);
  }
  // The detrend closes the loop to within rounding; pin the last close onto
  // the first open so the loop seam is exact too.
  out[N - 1][3] = out[0][0];
  out[N - 1][1] = Math.max(out[N - 1][1], out[N - 1][3]);
  out[N - 1][2] = Math.min(out[N - 1][2], out[N - 1][3]);
  const loopJump = Math.abs(out[N - 1][3] - out[0][0]);
  return {
    bars: out,
    seams,
    srcTimes,
    drift,
    bandPct: { low: ((minP / histMedian) - 1) * 100, high: ((maxP / histMedian) - 1) * 100 },
    loopJump,
    reordered,
  };
}

// ---------------------------------------------------------------------------
// 5. Valid start offsets and spikes
// ---------------------------------------------------------------------------
function validStarts(pl, cfg, medRange) {
  const point = 10 ** -cfg.decimals;
  const N = pl.bars.length;
  const bad = new Uint8Array(N); // bar i or the pair (i-1, i) fails
  for (let i = 0; i < N; i++) {
    const b = pl.bars[i];
    const p = pl.bars[(i - 1 + N) % N];
    if (Math.round((b[1] - b[2]) / point) < 2) bad[i] = 1;
    if (Math.max(b[1], p[1]) - Math.min(b[2], p[2]) < medRange) bad[i] = 1;
  }
  const out = {};
  for (const secs of MODE_SECONDS) {
    const span = HISTORY_MIN + Math.ceil(secs / 60) + 1;
    const list = [];
    if (span <= N) {
      // Window for start s = minutes [s - HISTORY_MIN, s - HISTORY_MIN + span - 1]
      // (history, the match, one spare minute), wrapping around the loop.
      let badCount = 0;
      const at = (k) => bad[((k % N) + N) % N];
      for (let k = 0; k < span; k++) badCount += at(k - HISTORY_MIN);
      for (let s = 0; s < N; s++) {
        if (badCount === 0) list.push(s);
        badCount -= at(s - HISTORY_MIN);
        badCount += at(s - HISTORY_MIN + span);
      }
    }
    out[secs] = list;
  }
  return out;
}

function findSpikes(pl, topPercent) {
  const bps = pl.bars.map(([o, h, l]) => ((h - l) / o) * 1e4);
  const thr = quantile(bps, 1 - topPercent / 100);
  const spikes = [];
  for (let i = 0; i < pl.bars.length; i++) {
    if (bps[i] >= thr) {
      const [o, , , c] = pl.bars[i];
      spikes.push({ i, rangeBps: Number(bps[i].toFixed(2)), movePct: Number((((c - o) / o) * 100).toFixed(3)) });
    }
  }
  return { thresholdBps: thr, spikes };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const stats = [];
  const data = {};
  for (const sym of Object.keys(instruments.INSTRUMENTS)) {
    const cfg = instruments.INSTRUMENTS[sym];
    const bars = loadM1(sym);
    if (!bars || bars.length < 500) {
      stats.push({ sym, category: cfg.category, cls: CLASS_OF(cfg.category), score: 0, missing: true, note: 'no real 1-minute data (synthetic fallback in game today)' });
      continue;
    }
    data[sym] = bars;
    stats.push(measure(sym, cfg, bars));
  }
  const real = stats.filter((s) => !s.missing);
  const { ranked, cut, gap, kept, forced } = rankAndCut(real);

  fs.mkdirSync(OUT, { recursive: true });
  const catalog = {
    version: 1,
    builtFrom: 'data/market/<SYMBOL>/m1.csv.gz',
    thresholds: {
      flatLimitSeconds: feel.market.flatLimitSeconds,
      aliveBarPoints: 2,
      pairRangeRule: '2 consecutive bars combined range >= instrument median 1-minute range',
      hotWindowMinutes: WINDOW_MIN,
      minSegmentMinutes: MIN_SEGMENT_MIN,
      historyMinutes: HISTORY_MIN,
    },
    ranking: ranked.map((s, i) => ({ rank: i + 1, sym: s.sym, cls: s.cls, score: Number(s.score.toFixed(4)), kept: kept.has(s.sym), forcedForClass: forced.includes(s.sym) })),
    excluded: stats.filter((s) => s.missing).map((s) => ({ sym: s.sym, reason: s.note })),
    cutoffAfterRank: cut,
    instruments: {},
  };

  const rows = [];
  for (const st of ranked) {
    if (!kept.has(st.sym)) continue;
    const cfg = instruments.INSTRUMENTS[st.sym];
    const bars = data[st.sym];
    const hw = hotWindows(bars, st, cfg);
    const profile = sessionProfile(bars, st);
    const hint = checkHint(st.cls, profile);
    const histMedian = median(bars.map((b) => b.close));
    const pl = stitch(bars, hw.segments, cfg, histMedian);
    const starts = validStarts(pl, cfg, st.medRange);
    const sp = findSpikes(pl, feel.spikeAlerts.topPercent);
    const file = `${st.sym}.playlist.json`;
    fs.writeFileSync(
      path.join(OUT, file),
      JSON.stringify({
        symbol: st.sym,
        decimals: cfg.decimals,
        medRange: st.medRange,
        bars: pl.bars,
        srcTimes: pl.srcTimes,
        seams: pl.seams,
        spikes: sp.spikes,
        validStarts: starts,
      })
    );
    catalog.instruments[st.sym] = {
      file,
      class: st.cls,
      score: Number(st.score.toFixed(4)),
      medRange: st.medRange,
      medBps: Number(st.medBps.toFixed(3)),
      activeMinutes: pl.bars.length,
      segments: hw.segments.length,
      seams: pl.seams.length,
      windows: hw.segments.map((s) => ({ from: new Date(bars[s.start].time * 1000).toISOString(), minutes: s.end - s.start })),
      driftPct: Number(((pl.drift - 1) * 100).toFixed(3)),
      bandPct: { low: Number(pl.bandPct.low.toFixed(2)), high: Number(pl.bandPct.high.toFixed(2)) },
      loopJump: pl.loopJump,
      validStarts: Object.fromEntries(Object.entries(starts).map(([k, v]) => [k, v.length])),
      spikes: sp.spikes.length,
      spikeThresholdBps: Number(sp.thresholdBps.toFixed(2)),
      sessionHint: hint,
    };
    rows.push({ st, hw, pl, starts, sp, hint });
  }
  // ---- competitions: activity-filtered 5-minute series ----
  // Same rules on the 5-minute history (about 208 days): live bars, every pair
  // of consecutive bars ranging at least the instrument's median 1-minute
  // range, hot 1-hour windows (>= the median 5-minute bar), segments of at
  // least 30 minutes, stitched by ratio rebasing and detrended into a closed
  // loop. At runtime (server/replayClock.js) a competition longer than one
  // loop plays the next pass mirrored (returns inverted) so the same path
  // never plays twice in a row.
  const compRows = [];
  for (const st of ranked) {
    if (!kept.has(st.sym)) continue;
    const cfg = instruments.INSTRUMENTS[st.sym];
    const bars5 = loadM1(st.sym, 'm5');
    if (!bars5 || bars5.length < 1000) continue;
    const st5 = measure(st.sym, cfg, bars5);
    const hw5 = hotWindows(bars5, st5, cfg, { barSeconds: 300, window: 12, step: 1, minSegment: 6, pairNeed: st.medRange, minBarRange: st.medRange, hot: 1.0 });
    const pl5 = stitch(bars5, hw5.segments, cfg, median(bars5.map((b) => b.close)), { balanceDriftPct: 2, maxSegmentBars: 72 });
    const file = `${st.sym}.comp.json`;
    fs.writeFileSync(path.join(OUT, file), JSON.stringify({ symbol: st.sym, decimals: cfg.decimals, barSeconds: 300, bars: pl5.bars }));
    catalog.instruments[st.sym].comp = {
      file,
      activeMinutes: pl5.bars.length * 5,
      segments: hw5.segments.length,
      sourceDays: Number(((bars5[bars5.length - 1].time - bars5[0].time) / 86400).toFixed(1)),
      bandPct: { low: Number(pl5.bandPct.low.toFixed(2)), high: Number(pl5.bandPct.high.toFixed(2)) },
      driftPct: Number(((pl5.drift - 1) * 100).toFixed(3)),
    };
    compRows.push({ sym: st.sym, ...catalog.instruments[st.sym].comp });
  }
  catalog.compEpoch = COMP_EPOCH;
  fs.writeFileSync(path.join(OUT, 'catalog.json'), `${JSON.stringify(catalog, null, 1)}\n`);

  // ---- report ----
  const f = (v, d = 2) => Number(v).toFixed(d);
  let md = `# Market curation report\n\nBuilt by \`node scripts/curate-data.js\` from \`data/market/<SYMBOL>/m1.csv.gz\` (deterministic: same files, same output).\n\nThe files have **no volume or tick-count column**, so the 1-minute range is the activity measure.\n\n`;
  md += `## Instrument ranking (activity score = median 1-min range in bps x min(1, median range / 2 spreads) x share of live minutes)\n\n| Rank | Instrument | Class | Median range bps/min | Mean abs return bps/min | Range / spread | Flat minutes % | Longest flat (min) | Score | Kept |\n|---|---|---|---|---|---|---|---|---|---|\n`;
  ranked.forEach((s, i) => {
    md += `| ${i + 1} | ${s.sym} | ${s.cls} | ${f(s.medBps)} | ${f(s.meanAbsRetBps)} | ${f(s.spreadRatio)} | ${f(s.flatShare * 100, 1)} | ${s.longestFlatMin} | ${f(s.score, 3)} | ${kept.has(s.sym) ? (forced.includes(s.sym) ? 'yes (class minimum)' : 'yes') : 'no'} |\n`;
    if (i + 1 === cut) md += `| — | **CUTOFF** (natural gap ${f(gap)}x after rank ${cut}) | | | | | | | | |\n`;
  });
  for (const s of stats.filter((x) => x.missing)) md += `| - | ${s.sym} | ${s.cls} | | | | | | | no: ${s.note} |\n`;

  md += `\n## Hot windows, playlists and the no-flat guarantee\n\nThresholds derived from the data: a bar is live when it spans at least 2 price points; every pair of consecutive bars must range at least the instrument's own median 1-minute range (shown below); a 30-minute window is hot when its average minute is at least ${rows[0] ? rows[0].hw.hotThreshold : 1.25}x the median minute. Segments shorter than ${MIN_SEGMENT_MIN} minutes are dropped. Flat limit at seconds level: ${feel.market.flatLimitSeconds}s.\n\n| Instrument | Median 1m range | Active minutes in loop | Segments | Seams | Loop drift removed % | Price band vs median % | Valid starts 180s / 600s / 900s / 1200s | Spikes (top 1%) |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    const c = catalog.instruments[r.st.sym];
    md += `| ${r.st.sym} | ${r.st.medRange.toPrecision(3)} | ${c.activeMinutes} | ${c.segments} | ${c.seams} | ${f(c.driftPct, 3)} | ${f(c.bandPct.low)} to +${f(c.bandPct.high)} | ${c.validStarts[180]} / ${c.validStarts[600]} / ${c.validStarts[900]} / ${c.validStarts[1200]} | ${c.spikes} (>= ${c.spikeThresholdBps} bps) |\n`;
  }
  md += `\n## Session hints\n\n| Instrument | Hint | Result | Measured |\n|---|---|---|---|\n`;
  for (const r of rows) md += `| ${r.st.sym} | ${r.hint.label} | ${r.hint.held} | ${r.hint.note} |\n`;
  md += `\n## Hot windows per instrument (source data times, UTC)\n\n`;
  for (const r of rows) {
    const c = catalog.instruments[r.st.sym];
    md += `- **${r.st.sym}**: ${c.windows.slice(0, 12).map((w) => `${w.from.slice(5, 16).replace('T', ' ')} (${w.minutes}m)`).join(', ')}${c.windows.length > 12 ? `, … ${c.windows.length - 12} more` : ''}\n`;
  }
  md += `\n## Competitions: active minutes needed vs available (activity-filtered 5-minute series)\n\n| Instrument | Source days | Active minutes in loop | Segments | Price band % |\n|---|---|---|---|---|\n`;
  for (const r of compRows) md += `| ${r.sym} | ${r.sourceDays} | ${r.activeMinutes} | ${r.segments} | ${f(r.bandPct.low)} to +${f(r.bandPct.high)} |\n`;
  const { TEMPLATES, competitionInstruments } = require('../server/compEngine');
  md += `\n| Template | Needs (minutes of market) | Instruments after curation | Shortest loop among them | Fallback used |\n|---|---|---|---|---|\n`;
  for (const [name, tpl] of Object.entries(TEMPLATES)) {
    const occ = tpl.next(Date.UTC(2026, 10, 2)); // a Monday, so every template has its next occurrence
    const need = Math.round((occ.endsAt - occ.startsAt) / 60000);
    const syms = competitionInstruments(tpl.instruments);
    const avail = Math.min(...syms.map((s) => (catalog.instruments[s] && catalog.instruments[s].comp ? catalog.instruments[s].comp.activeMinutes : 0)));
    const swapped = tpl.instruments.filter((s) => !syms.includes(s));
    const fb = [];
    if (swapped.length) fb.push(`(a) rotation: ${swapped.join(', ')} replaced by ${syms.filter((s) => !tpl.instruments.includes(s)).join(', ')}`);
    if (avail < need) fb.push('(b) random start offset into the loop + (c) mirrored passes after one full loop');
    else fb.push('(b) random start offset into the loop (no repeat needed)');
    md += `| ${name} | ${need.toLocaleString()} | ${syms.join(', ')} | ${avail.toLocaleString()} | ${fb.join('; ')} |\n`;
  }
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, md);
  console.log(md);
}

if (require.main === module) main();

module.exports = { measure, rankAndCut, hotWindows, stitch, validStarts, findSpikes, MODE_SECONDS };
