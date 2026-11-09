'use strict';

// Market time and prices for long-form competitions. A competition replays
// a stretch of real history ("data window") against the real clock: market
// time is always computed here from the competition's own start time, never
// taken from a client.
//
// Base data is 5-minute bars (data/market/<SYMBOL>/m5.csv.gz). Inside a bar
// the price follows a fixed path open -> first extreme -> second extreme ->
// close (low first on an up bar, high first on a down bar), so prices between
// bars are deterministic, a forming candle only ever shows the range reached
// so far, and SL/TP checks can walk the exact same path the chart shows.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const csvLoader = require('./csvLoader');
const instruments = require('./instruments');
const curated = require('./curated');
const intrabar = require('./intrabar');
const gameFeel = require('./config/gameFeel');

const BASE_SECONDS = 300;
// No bar for this long (two missing bars) = market closed (weekend,
// overnight session break, holiday).
const MARKET_CLOSED_AFTER = 2 * BASE_SECONDS;
// Edge slack when checking an instrument covers a window: a weekend/holiday
// at either end of the data shouldn't disqualify an otherwise-full window.
const COVERAGE_SLACK_SECONDS = 4 * 86400;
const WEEK_SECONDS = 7 * 86400;
const USED_WINDOW_MEMORY = 10;

// ---- activity-filtered (curated) competition series --------------------------
//
// scripts/curate-data.js writes data/curated/<SYMBOL>.comp.json: only the live
// stretches of the 5-minute history, stitched by ratio rebasing into a closed
// loop. They run on their own synthetic clock from catalog.compEpoch (2030), so
// a data time at or after the epoch belongs to the curated series and one
// before it to the raw history - competitions created before this existed keep
// replaying exactly what they did. Bar i of the virtual series is loop bar
// i % N; every odd pass through the loop is mirrored (log-reflected around the
// loop's start price, so returns are inverted and the seam stays exact) so the
// same path never plays twice in a row. Inside a bar the price follows the
// seeded intrabar generator (moves every second, touches the bar's high and
// low), never a straight line.
const compSeries = new Map();
const pathCache = new Map();
const PATH_CACHE_MAX = 4000;
const HISTORY_BARS_BEFORE_START = 600; // chart history before a curated competition starts

function compEpoch() {
  const cat = curated.load();
  return cat && cat.compEpoch ? cat.compEpoch : null;
}

function getCompSeries(symbol) {
  if (compSeries.has(symbol)) return compSeries.get(symbol);
  const cat = curated.load();
  const entry = cat && cat.instruments[symbol] && cat.instruments[symbol].comp;
  let s = null;
  if (entry) {
    try {
      s = JSON.parse(fs.readFileSync(path.join(curated.getDir(), entry.file), 'utf8'));
    } catch (e) {
      console.warn(`[replayClock] ${symbol} comp series unreadable:`, e.message);
    }
  }
  compSeries.set(symbol, s);
  return s;
}

function isCuratedTime(t) {
  const e = compEpoch();
  return e !== null && t >= e;
}

function curatedBar(symbol, i) {
  const s = getCompSeries(symbol);
  const n = s.bars.length;
  const loop = Math.floor(i / n);
  const [o, h, l, c] = s.bars[((i % n) + n) % n];
  if (loop % 2 === 0) return { open: o, high: h, low: l, close: c };
  const p0 = s.bars[0][0];
  const m = (v) => Number(((p0 * p0) / v).toFixed(s.decimals));
  return { open: m(o), high: m(l), low: m(h), close: m(c) };
}

function curatedPath(symbol, i) {
  const key = `${symbol}:${i}`;
  let p = pathCache.get(key);
  if (!p) {
    const s = getCompSeries(symbol);
    // Swing mode: a swing of at least the instrument's median 1-minute range
    // every <= 60s, so every 3-minute stretch of a competition moves at least
    // that much (the same guarantee short matches get from 1-minute bars).
    const minSwing = curated.load().instruments[symbol].medRange;
    p = intrabar.barPath(curatedBar(symbol, i), BASE_SECONDS, s.decimals, `comp:${symbol}`, String(i), { minSwing, maxLeg: 60 });
    if (pathCache.size >= PATH_CACHE_MAX) pathCache.delete(pathCache.keys().next().value);
    pathCache.set(key, p);
  }
  return p;
}

function curatedPriceAt(symbol, t) {
  const rel = t - compEpoch();
  const i = Math.floor(rel / BASE_SECONDS);
  return curatedPath(symbol, i)[rel - i * BASE_SECONDS];
}

function curatedPathBetween(symbol, fromTime, toTime) {
  const points = [];
  if (toTime - fromTime <= 2 * 3600) {
    for (let t = fromTime + 1; t <= toTime; t++) points.push({ t, mid: curatedPriceAt(symbol, t) });
    return points;
  }
  // Long catch-up (a restart): each bar's low and high in the order the path
  // visits them, then the end price - enough to catch every level crossed.
  const e = compEpoch();
  for (let i = Math.floor((fromTime - e) / BASE_SECONDS); e + i * BASE_SECONDS <= toTime; i++) {
    const p = curatedPath(symbol, i);
    let lo = 0;
    let hi = 0;
    for (let k = 1; k < p.length; k++) {
      if (p[k] < p[lo]) lo = k;
      if (p[k] > p[hi]) hi = k;
    }
    for (const k of lo < hi ? [lo, hi] : [hi, lo]) {
      const t = e + i * BASE_SECONDS + k;
      if (t > fromTime && t < toTime) points.push({ t, mid: p[k] });
    }
  }
  points.push({ t: toTime, mid: curatedPriceAt(symbol, toTime) });
  return points;
}

function curatedCandlesUpTo(symbol, fromTime, dataTime) {
  const e = compEpoch();
  const rows = [];
  const first = Math.max(0, Math.ceil((fromTime - e) / BASE_SECONDS));
  const last = Math.floor((dataTime - e) / BASE_SECONDS);
  for (let i = first; i <= last; i++) {
    const start = e + i * BASE_SECONDS;
    const offset = dataTime - start;
    if (offset >= BASE_SECONDS) {
      const b = curatedBar(symbol, i);
      rows.push([start, b.open, b.high, b.low, b.close]);
      continue;
    }
    const p = curatedPath(symbol, i);
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = 0; k <= offset; k++) {
      if (p[k] > hi) hi = p[k];
      if (p[k] < lo) lo = p[k];
    }
    rows.push([start, p[0], hi, lo, p[offset]]);
  }
  return rows;
}

// A curated window is used for a new competition when the switch is on and
// every requested instrument has a curated series. Start = a seeded offset
// (whole bars) into the loop, never one of the recently used ones; chart
// history before it is guaranteed by starting at least
// HISTORY_BARS_BEFORE_START bars into the series.
function chooseCuratedWindow({ id, requested, usedStarts }) {
  const e = compEpoch();
  const series = requested.map((s) => [s, getCompSeries(s)]).filter(([, s]) => s);
  if (!series.length) return null;
  const n = Math.min(...series.map(([, s]) => s.bars.length));
  const used = new Set(usedStarts.map((s) => Math.floor(new Date(s).getTime() / 1000)));
  const span = Math.max(1, 2 * n - HISTORY_BARS_BEFORE_START); // two passes (normal + mirrored)
  let k = seedFromId(id) % span;
  for (let tries = 0; tries < 64 && used.has(e + (HISTORY_BARS_BEFORE_START + k) * BASE_SECONDS); tries++) k = (k + 997) % span;
  return {
    dataWindowStart: new Date((e + (HISTORY_BARS_BEFORE_START + k) * BASE_SECONDS) * 1000).toISOString(),
    instruments: series.map(([s]) => s),
    dropped: requested.filter((s) => !getCompSeries(s)).map((s) => ({ symbol: s, reason: 'no curated competition series' })),
  };
}

function dataTimeFor(comp, nowMs = Date.now()) {
  const elapsed = (nowMs - new Date(comp.starts_at).getTime()) / 1000;
  return Math.floor(new Date(comp.data_window_start).getTime() / 1000 + elapsed * (Number(comp.replay_speed) || 1));
}

// Constant offset (seconds) from data time to the competition's own
// calendar: charts show shifted times so players can't look up what the
// real market did next. A whole number of weeks for real-time competitions,
// so candles keep their real weekday/hour/day boundaries.
function timeShiftFor(comp) {
  return Math.round((new Date(comp.starts_at).getTime() - new Date(comp.data_window_start).getTime()) / 1000);
}

// Index of the last bar starting at or before t, or -1.
function barIndexAt(candles, t) {
  let lo = 0;
  let hi = candles.length - 1;
  if (hi < 0 || candles.time[0] > t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles.time[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// The four path vertices of bar i as [secondsIntoBar, price].
function barPath(candles, i) {
  const o = candles.open[i];
  const c = candles.close[i];
  const h = candles.high[i];
  const l = candles.low[i];
  const third = BASE_SECONDS / 3;
  return c >= o
    ? [[0, o], [third, l], [2 * third, h], [BASE_SECONDS, c]]
    : [[0, o], [third, h], [2 * third, l], [BASE_SECONDS, c]];
}

function priceOnPath(path, offset) {
  for (let k = 1; k < path.length; k++) {
    const [t1, p1] = path[k];
    if (offset <= t1) {
      const [t0, p0] = path[k - 1];
      return t1 === t0 ? p1 : p0 + ((p1 - p0) * (offset - t0)) / (t1 - t0);
    }
  }
  return path[path.length - 1][1];
}

function quote(symbol, mid, marketClosed) {
  const cfg = instruments.getInstrument(symbol);
  const d = cfg.decimals;
  const m = Number(mid.toFixed(d));
  return {
    mid: m,
    bid: Number((m - cfg.spread / 2).toFixed(d)),
    ask: Number((m + cfg.spread / 2).toFixed(d)),
    marketClosed,
  };
}

// Price at a data time, with the same spread rule as live matches. In a
// market gap it's the last traded price with marketClosed = true (new trades
// are blocked then; closing is always allowed).
function getPriceAt(symbol, dataTime) {
  if (isCuratedTime(dataTime) && getCompSeries(symbol)) return quote(symbol, curatedPriceAt(symbol, dataTime), false);
  const candles = csvLoader.getBaseCandles(symbol);
  if (!candles) return null;
  const i = barIndexAt(candles, dataTime);
  if (i === -1) return quote(symbol, candles.open[0], true);
  const offset = dataTime - candles.time[i];
  if (offset >= MARKET_CLOSED_AFTER) return quote(symbol, candles.close[i], true);
  return quote(symbol, priceOnPath(barPath(candles, i), Math.min(offset, BASE_SECONDS)), false);
}

// Every price point the path passes through in (fromTime, toTime], in time
// order, as {t, mid} - path vertices are the only places a linear path turns,
// so checking them catches any SL/TP crossed between two ticks, wicks included.
function pathBetween(symbol, fromTime, toTime) {
  if (isCuratedTime(fromTime) && getCompSeries(symbol)) return toTime <= fromTime ? [] : curatedPathBetween(symbol, fromTime, toTime);
  const candles = csvLoader.getBaseCandles(symbol);
  if (!candles || toTime <= fromTime) return [];
  const points = [];
  let i = Math.max(0, barIndexAt(candles, fromTime));
  for (; i < candles.length && candles.time[i] <= toTime; i++) {
    const start = candles.time[i];
    for (const [off, price] of barPath(candles, i)) {
      const t = start + off;
      if (t > fromTime && t < toTime) points.push({ t, mid: price });
    }
  }
  const end = getPriceAt(symbol, toTime);
  if (end) points.push({ t: toTime, mid: end.mid });
  return points;
}

// Base bars up to dataTime for the chart: closed bars as-is, and the bar
// containing dataTime cut off at dataTime (high/low only as far as the path
// has reached). Never returns anything after dataTime.
function candlesUpTo(symbol, fromTime, dataTime) {
  if (isCuratedTime(dataTime) && getCompSeries(symbol)) return curatedCandlesUpTo(symbol, fromTime, dataTime);
  const candles = csvLoader.getBaseCandles(symbol);
  if (!candles) return [];
  const rows = [];
  let i = Math.max(0, barIndexAt(candles, fromTime));
  if (candles.time[i] < fromTime) i++;
  for (; i < candles.length && candles.time[i] <= dataTime; i++) {
    const start = candles.time[i];
    const offset = dataTime - start;
    if (offset >= BASE_SECONDS) {
      rows.push([start, candles.open[i], candles.high[i], candles.low[i], candles.close[i]]);
      continue;
    }
    const path = barPath(candles, i);
    const reached = path.filter(([t]) => t <= offset).map(([, p]) => p);
    // Same rounding as getPriceAt, so the forming candle closes exactly on the quote.
    const now = Number(priceOnPath(path, offset).toFixed(instruments.getInstrument(symbol).decimals));
    reached.push(now);
    rows.push([start, candles.open[i], Math.max(...reached), Math.min(...reached), now]);
  }
  return rows;
}

function coverage(symbol) {
  const candles = csvLoader.getBaseCandles(symbol);
  if (!candles || !candles.length) return null;
  return { first: candles.time[0], last: candles.time[candles.length - 1] };
}

function seedFromId(id) {
  return crypto.createHash('sha256').update(String(id)).digest().readUInt32BE(0);
}

// Picks a competition's data_window_start: a moment in the data with the
// same UTC weekday/hour/minute as starts_at (so weekends and session gaps
// land where the real calendar has them), covering the whole replayed span
// (duration x replay_speed) for as many of the requested instruments as
// possible, not one of `usedStarts` (recent windows of the same template),
// chosen deterministically from the competition id. Instruments without
// enough data are dropped and reported, never silently kept.
function chooseDataWindow({ id, startsAt, endsAt, replaySpeed = 1, instruments: requested, usedStarts = [] }) {
  // Activity-filtered series first (switch: market.curatedCompetitions). Speed
  // stays whatever the caller asked - competitions are created at 1x.
  if (gameFeel.get().market.curatedCompetitions !== false && curated.isActive() && compEpoch() !== null) {
    const w = chooseCuratedWindow({ id, requested, usedStarts });
    if (w && w.instruments.length) return w;
  }
  const startSec = Math.floor(new Date(startsAt).getTime() / 1000);
  const span = ((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 1000) * (Number(replaySpeed) || 1);
  const used = new Set(usedStarts.map((s) => Math.floor(new Date(s).getTime() / 1000)));

  const covers = {};
  const dropped = [];
  for (const sym of requested) {
    const cov = coverage(sym);
    if (!cov) dropped.push({ symbol: sym, reason: 'no 5-minute replay data (run npm run data:fetch)' });
    else covers[sym] = cov;
  }
  const symbols = Object.keys(covers);
  if (!symbols.length) return { dataWindowStart: null, instruments: [], dropped };

  // Whole weeks back from starts_at keeps weekday/hour/minute aligned.
  const latestEnd = Math.max(...symbols.map((s) => covers[s].last));
  const earliestStart = Math.min(...symbols.map((s) => covers[s].first));
  const candidates = [];
  for (let k = 1; ; k++) {
    const t = startSec - k * WEEK_SECONDS;
    if (t < earliestStart - COVERAGE_SLACK_SECONDS) break;
    if (t + span > latestEnd + COVERAGE_SLACK_SECONDS) continue;
    const ok = symbols.filter(
      (s) => covers[s].first <= t + COVERAGE_SLACK_SECONDS && covers[s].last >= t + span - COVERAGE_SLACK_SECONDS
    );
    if (ok.length) candidates.push({ t, ok });
  }
  if (!candidates.length) {
    symbols.forEach((s) => dropped.push({ symbol: s, reason: `data doesn't cover a ${(span / 86400).toFixed(1)}-day window` }));
    return { dataWindowStart: null, instruments: [], dropped };
  }

  const best = Math.max(...candidates.map((c) => c.ok.length));
  let pool = candidates.filter((c) => c.ok.length === best);
  const fresh = pool.filter((c) => !used.has(c.t));
  if (fresh.length) pool = fresh;
  const pick = pool[seedFromId(id) % pool.length];

  symbols
    .filter((s) => !pick.ok.includes(s))
    .forEach((s) => dropped.push({ symbol: s, reason: `data doesn't cover the chosen ${(span / 86400).toFixed(1)}-day window` }));
  return { dataWindowStart: new Date(pick.t * 1000).toISOString(), instruments: pick.ok, dropped };
}

module.exports = {
  BASE_SECONDS,
  USED_WINDOW_MEMORY,
  dataTimeFor,
  timeShiftFor,
  getPriceAt,
  pathBetween,
  candlesUpTo,
  coverage,
  chooseDataWindow,
  isCuratedTime,
  compEpoch,
};
