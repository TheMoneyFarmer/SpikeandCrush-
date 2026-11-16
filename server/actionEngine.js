'use strict';

// Action Engine: only ever show players the busy minutes of the market.
//
// 1. Window scoring (cached per instrument and match length): every curated
//    valid start (no holes, no closed market - server/curated.js) gets a
//    motion score = the window's total range, as a percentile among all
//    windows of that instrument and length. Eligible = percentile at or above
//    minPercentile, and no single 1-minute bar holding more than maxBarShare
//    of the window's range ("one spike, then nothing").
// 2. Selection at match start: weighted by percentile, never a window used
//    in the last `recentAvoid` picks for that instrument, and the actual price
//    path the players will see (same seed for everyone) must pass the
//    continuity rule; otherwise the next candidate is tried.
// 3. Anti-memorisation: a per-match price scale and mirror flip derived from
//    the match seed (stored with the match, reproducible).
//
// Thresholds live in server/config/gameFeel.js market.actionEngine (admin).
// Nothing here touches P&L maths: it only chooses and shapes the price series
// every price read then uses.

const gameFeel = require('./config/gameFeel');

const DEFAULTS = {
  enabled: true,
  minPercentile: 80,
  maxBarShare: 0.5,
  slices: 10,
  minSliceShare: 0.25, // every slice range >= this x the median slice range
  quietBodyShare: 0.05, // a "quiet" candle body is under this x the average body
  maxQuietRun: 3, // no more than this many quiet candles in a row
  candleSeconds: 5, // the chart's default candle (client/js/chart.js)
  maxTries: 40,
  recentAvoid: 20,
  priceScale: [0.8, 1.2], // anti-memorisation scale range; [1, 1] = off
  mirror: true, // random up/down flip per match
};

function cfg() {
  const m = (gameFeel.get().market || {}).actionEngine || {};
  return { ...DEFAULTS, ...m };
}

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

// Continuity rule on a sampled price path: samples = [[tReal, price], ...].
// Candles are built on market time like the chart (t * speed).
function continuity(samples, speed = 1, c = cfg()) {
  if (samples.length < c.slices * 2) return { ok: false, reason: 'too short' };
  const prices = samples.map((x) => x[1]);
  const hi = Math.max(...prices);
  const lo = Math.min(...prices);
  const winRange = hi - lo;
  if (!(winRange > 0)) return { ok: false, reason: 'no movement' };
  const sliceRanges = [];
  for (let i = 0; i < c.slices; i++) {
    const part = prices.slice(Math.floor((i * prices.length) / c.slices), Math.floor(((i + 1) * prices.length) / c.slices));
    sliceRanges.push(Math.max(...part) - Math.min(...part));
  }
  const medSlice = median(sliceRanges);
  if (sliceRanges.some((r) => r < c.minSliceShare * medSlice)) return { ok: false, reason: 'quiet slice' };
  const candles = [];
  for (const [t, p] of samples) {
    const k = Math.floor((t * speed) / c.candleSeconds);
    const cd = candles[k] || (candles[k] = { o: p, h: p, l: p, c: p });
    cd.h = Math.max(cd.h, p);
    cd.l = Math.min(cd.l, p);
    cd.c = p;
  }
  const real = candles.filter(Boolean);
  if (Math.max(...real.map((cd) => cd.h - cd.l)) > c.maxBarShare * winRange) return { ok: false, reason: 'one candle holds the move' };
  const bodies = real.map((cd) => Math.abs(cd.c - cd.o));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / bodies.length;
  let run = 0;
  for (const b of bodies) {
    run = b < c.quietBodyShare * avgBody ? run + 1 : 0;
    if (run > c.maxQuietRun) return { ok: false, reason: 'quiet candles in a row' };
  }
  return { ok: true };
}

// ---- window scoring ----------------------------------------------------------

const scoreCache = new Map(); // `${symbol}:${bars}` -> [{ start, pct }]

function scoreWindows(symbol, bars, validStarts, barsAt) {
  const c = cfg();
  const key = `${symbol}:${bars}:${c.minPercentile}:${c.maxBarShare}`;
  if (scoreCache.has(key)) return scoreCache.get(key);
  const scored = [];
  for (const start of validStarts) {
    const w = barsAt(symbol, start, bars);
    let hi = -Infinity;
    let lo = Infinity;
    let maxBar = 0;
    for (const b of w) {
      hi = Math.max(hi, b.high);
      lo = Math.min(lo, b.low);
      maxBar = Math.max(maxBar, b.high - b.low);
    }
    const range = hi - lo;
    scored.push({ start, range, oneBar: bars >= 3 && range > 0 && maxBar > c.maxBarShare * range });
  }
  const sorted = scored.map((s) => s.range).sort((a, b) => a - b);
  const pctOf = (r) => {
    let lo2 = 0;
    let hi2 = sorted.length;
    while (lo2 < hi2) {
      const mid = (lo2 + hi2) >> 1;
      if (sorted[mid] < r) lo2 = mid + 1;
      else hi2 = mid;
    }
    return (100 * lo2) / Math.max(1, sorted.length - 1);
  };
  const eligible = scored
    .map((s) => ({ start: s.start, pct: pctOf(s.range), oneBar: s.oneBar }))
    .filter((s) => s.pct >= c.minPercentile && !s.oneBar)
    .map(({ start, pct }) => ({ start, pct }));
  scoreCache.set(key, eligible);
  return eligible;
}

function clearCache() {
  scoreCache.clear();
}

// ---- selection ---------------------------------------------------------------

const recent = new Map(); // symbol -> recent starts (never the same window twice in a row)
const stats = { picks: 0, tries: 0, fallbacks: 0, lastFlat: [] };

// tryStart(start) -> { entry, samples } built exactly as players will see it.
function pickWindow(symbol, eligible, rand, tryStart, speed) {
  const c = cfg();
  const avoid = new Set(recent.get(symbol) || []);
  let pool = eligible.filter((e) => !avoid.has(e.start));
  if (!pool.length) pool = eligible.slice();
  let best = null;
  for (let attempt = 0; attempt < c.maxTries && pool.length; attempt++) {
    // Weighted by percentile above the bar (busier windows more often).
    const weights = pool.map((e) => 1 + (e.pct - c.minPercentile));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    let idx = 0;
    while (idx < pool.length - 1 && r >= weights[idx]) r -= weights[idx++];
    const cand = pool.splice(idx, 1)[0];
    const built = tryStart(cand.start);
    stats.tries++;
    if (!built) continue;
    const check = continuity(built.samples, speed, c);
    if (check.ok) {
      remember(symbol, cand.start, c.recentAvoid);
      stats.picks++;
      return { ...built, start: cand.start, pct: cand.pct, continuity: true };
    }
    if (!best) best = { ...built, start: cand.start, pct: cand.pct, continuity: false, reason: check.reason };
  }
  stats.fallbacks++;
  if (best) remember(symbol, best.start, c.recentAvoid);
  return best;
}

function remember(symbol, start, n) {
  const list = recent.get(symbol) || [];
  list.push(start);
  while (list.length > n) list.shift();
  recent.set(symbol, list);
}

// Per-match price transform from the seed: scale in [lo, hi], optional mirror
// around the window's first price. Reproducible from the seed alone.
function transformFor(rand, c = cfg()) {
  const [lo, hi] = c.priceScale || [1, 1];
  const scale = lo === hi ? lo : Number((lo + rand() * (hi - lo)).toFixed(4));
  const flip = Boolean(c.mirror) && rand() < 0.5;
  return { scale, flip };
}

module.exports = { continuity, scoreWindows, pickWindow, transformFor, clearCache, cfg, stats, DEFAULTS };
