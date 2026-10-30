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
const csvLoader = require('./csvLoader');
const instruments = require('./instruments');

const BASE_SECONDS = 300;
// No bar for this long (two missing bars) = market closed (weekend,
// overnight session break, holiday).
const MARKET_CLOSED_AFTER = 2 * BASE_SECONDS;
// Edge slack when checking an instrument covers a window: a weekend/holiday
// at either end of the data shouldn't disqualify an otherwise-full window.
const COVERAGE_SLACK_SECONDS = 4 * 86400;
const WEEK_SECONDS = 7 * 86400;
const USED_WINDOW_MEMORY = 10;

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
};
