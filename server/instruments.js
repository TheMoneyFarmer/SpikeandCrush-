'use strict';

const csvLoader = require('./csvLoader');

// dataFile is a substring match against the actual filenames in
// data/historical/ (which carry long date-stamped names) - see csvLoader.findFile.
// dukascopy is the instrument id scripts/fetch-market-data.js downloads into
// data/market/<SYMBOL>/ (m1/h1/d1) - when those files exist they take
// precedence over both dataFile and the synthetic fallback.
// EURUSD/XAUUSD keep dataFile: null and the exact basePrice/volatility/spread
// the existing (pre-expansion) synthetic engine already used, so their behavior
// is unchanged for players still in a plain Quick War.
const INSTRUMENTS = {
  // ---- forex ----------------------------------------------------------------
  EURUSD: {
    name: 'EUR/USD', category: 'forex', nickname: ['fiber', 'euro', 'eurusd'],
    pipSize: 0.0001, pipValue: 10, spread: 0.00015, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 1.08, volatility: 0.0002, dukascopy: 'eurusd',
  },
  GBPUSD: {
    name: 'GBP/USD', category: 'forex', nickname: ['cable', 'pound', 'sterling'],
    pipSize: 0.0001, pipValue: 10, spread: 0.00020, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 1.27, volatility: 0.00025, dukascopy: 'gbpusd',
  },
  USDJPY: {
    name: 'USD/JPY', category: 'forex', nickname: ['yen', 'dollar yen', 'usdjpy'],
    pipSize: 0.01, pipValue: 9.1, spread: 0.015, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 3, dataFile: null, basePrice: 149.5, volatility: 0.03, dukascopy: 'usdjpy',
  },
  USDCHF: {
    name: 'USD/CHF', category: 'forex', nickname: ['swissy', 'swiss franc'],
    pipSize: 0.0001, pipValue: 10.9, spread: 0.00020, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 0.88, volatility: 0.00022, dukascopy: 'usdchf',
  },
  AUDUSD: {
    name: 'AUD/USD', category: 'forex', nickname: ['aussie', 'australian'],
    pipSize: 0.0001, pipValue: 10, spread: 0.00018, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 0.66, volatility: 0.00022, dukascopy: 'audusd',
  },
  USDCAD: {
    name: 'USD/CAD', category: 'forex', nickname: ['loonie', 'canadian'],
    pipSize: 0.0001, pipValue: 7.4, spread: 0.00022, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 1.36, volatility: 0.00022, dukascopy: 'usdcad',
  },
  NZDUSD: {
    name: 'NZD/USD', category: 'forex', nickname: ['kiwi', 'new zealand'],
    pipSize: 0.0001, pipValue: 10, spread: 0.00025, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 0.61, volatility: 0.00025, dukascopy: 'nzdusd',
  },

  // ---- metals -----------------------------------------------------------------
  XAUUSD: {
    name: 'Gold', category: 'metals', nickname: ['gold', 'xauusd', 'yellow metal'],
    pipSize: 0.01, pipValue: 1, spread: 0.35, contractSize: 100,
    minLot: 0.01, maxLot: 50, decimals: 2, dataFile: null, basePrice: 1950.0, volatility: 0.5, dukascopy: 'xauusd',
  },
  XAGUSD: {
    name: 'Silver', category: 'metals', nickname: ['silver', 'xagusd'],
    pipSize: 0.001, pipValue: 5, spread: 0.03, contractSize: 5000,
    minLot: 0.01, maxLot: 50, decimals: 3, dataFile: null, basePrice: 23.5, volatility: 0.05, dukascopy: 'xagusd',
  },

  // ---- indices ------------------------------------------------------------
  NAS100: {
    name: 'NASDAQ 100', category: 'indices', nickname: ['nasdaq', 'nas', 'tech index', 'hundred'],
    pipSize: 0.1, pipValue: 1, spread: 1.5, contractSize: 1,
    minLot: 0.1, maxLot: 100, decimals: 2, dataFile: 'USATECH.IDX', basePrice: 14037, volatility: 8, dukascopy: 'usatechidxusd',
  },
  US30: {
    name: 'Dow Jones', category: 'indices', nickname: ['dow', 'dow jones', 'usa30', 'thirty'],
    pipSize: 0.1, pipValue: 1, spread: 2.0, contractSize: 1,
    minLot: 0.1, maxLot: 100, decimals: 2, dataFile: 'USA30.IDX', basePrice: 24731, volatility: 10, dukascopy: 'usa30idxusd',
  },
  UK100: {
    name: 'FTSE 100', category: 'indices', nickname: ['ftse', 'footsie', 'uk100'],
    pipSize: 0.1, pipValue: 1.27, spread: 2.0, contractSize: 1,
    minLot: 0.1, maxLot: 100, decimals: 1, dataFile: null, basePrice: 7650, volatility: 8, dukascopy: 'gbridxgbp',
  },
  GER40: {
    name: 'DAX 40', category: 'indices', nickname: ['dax', 'german index', 'ger40'],
    pipSize: 0.1, pipValue: 1, spread: 1.5, contractSize: 1,
    minLot: 0.1, maxLot: 100, decimals: 1, dataFile: null, basePrice: 16800, volatility: 15, dukascopy: 'deuidxeur',
  },

  // ---- commodities --------------------------------------------------------
  BRENT: {
    name: 'Brent Crude', category: 'commodities', nickname: ['brent', 'brent crude', 'uk oil'],
    pipSize: 0.01, pipValue: 10, spread: 0.05, contractSize: 1000,
    minLot: 0.01, maxLot: 50, decimals: 3, dataFile: 'BRENT.CMD', basePrice: 46.8, volatility: 0.15, dukascopy: 'brentcmdusd',
  },
  USOIL: {
    name: 'WTI Crude', category: 'commodities', nickname: ['wti', 'crude', 'oil', 'usoil'],
    pipSize: 0.01, pipValue: 10, spread: 0.05, contractSize: 1000,
    minLot: 0.01, maxLot: 50, decimals: 2, dataFile: null, basePrice: 78.5, volatility: 0.3, dukascopy: 'lightcmdusd',
  },

  // ---- crypto ---------------------------------------------------------------
  BTCUSD: {
    name: 'Bitcoin', category: 'crypto', nickname: ['bitcoin', 'btc'],
    pipSize: 0.01, pipValue: 0.01, spread: 15.0, contractSize: 1,
    minLot: 0.01, maxLot: 10, decimals: 1, dataFile: 'BTC-USD', basePrice: 9795, volatility: 15, dukascopy: 'btcusd',
  },
  ETHUSD: {
    name: 'Ethereum', category: 'crypto', nickname: ['ethereum', 'eth'],
    pipSize: 0.01, pipValue: 0.01, spread: 1.0, contractSize: 1,
    minLot: 0.01, maxLot: 50, decimals: 2, dataFile: 'ETH-USD', basePrice: 186.7, volatility: 0.3, dukascopy: 'ethusd',
  },
  // USTUSD's CSV is present but empty (0 data rows) - csvLoader falls back to
  // synthetic automatically. Treated as a low-volatility, ~$1 asset.
  USTUSD: {
    name: 'TerraUSD', category: 'crypto', nickname: ['ust', 'terra', 'terrausd'],
    pipSize: 0.0001, pipValue: 0.0001, spread: 0.002, contractSize: 1,
    minLot: 1, maxLot: 10000, decimals: 4, dataFile: 'UST-USD', basePrice: 1.0, volatility: 0.002,
  },

  // ---- stocks -------------------------------------------------------------
  AAPL: {
    name: 'Apple Inc', category: 'stocks', nickname: ['apple', 'aapl'],
    pipSize: 0.01, pipValue: 1, spread: 0.05, contractSize: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: 'AAPL.US-USD', basePrice: 351.17, volatility: 0.5, dukascopy: 'aaplususd',
  },
};

const CATEGORIES = Object.keys(INSTRUMENTS).reduce((set, sym) => set.add(INSTRUMENTS[sym].category), new Set());

function getInstrument(symbol) {
  return INSTRUMENTS[symbol] || null;
}

function listInstruments() {
  return Object.entries(INSTRUMENTS).map(([symbol, cfg]) => ({ symbol, ...cfg }));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Picks `count` instruments: always at least 1 forex pair, at most 2 crypto, at
// most 2 indices, and (when count < the number of categories available) no
// repeated category so a short match still feels varied.
function selectMatchInstruments(count = 5) {
  const all = Object.keys(INSTRUMENTS);
  const byCategory = {};
  for (const sym of all) {
    const cat = INSTRUMENTS[sym].category;
    (byCategory[cat] = byCategory[cat] || []).push(sym);
  }

  const selected = [];
  const usedCategories = new Set();

  const forexPick = shuffle(byCategory.forex)[0];
  selected.push(forexPick);
  usedCategories.add('forex');

  const capPerCategory = { crypto: 2, indices: 2 };
  const categoryCount = { forex: 1 };

  const pool = shuffle(all.filter((s) => s !== forexPick));
  for (const sym of pool) {
    if (selected.length >= count) break;
    const cat = INSTRUMENTS[sym].category;
    const cap = capPerCategory[cat] || Infinity;
    if ((categoryCount[cat] || 0) >= cap) continue;
    if (count < 5 && usedCategories.has(cat)) continue;
    selected.push(sym);
    usedCategories.add(cat);
    categoryCount[cat] = (categoryCount[cat] || 0) + 1;
  }

  // If category diversity constraints left us short (small registries, tight
  // caps), fill remaining slots from whatever's left regardless of category.
  if (selected.length < count) {
    for (const sym of pool) {
      if (selected.length >= count) break;
      if (selected.includes(sym)) continue;
      selected.push(sym);
    }
  }

  return shuffle(selected);
}

const PRE_MATCH_MINUTES = 120; // 2 hours of 1-minute bars shown as historical context
const LIVE_MINUTES = 10; // the match itself
const WINDOW_MINUTES = PRE_MATCH_MINUTES + LIVE_MINUTES;
const TICKS_PER_MINUTE = 60; // live minutes get interpolated to 1-second ticks for the existing tick-driven engine
// A 130-minute window may span at most this much more real time than 130
// minutes (a few dropped no-trade minutes are fine, a weekend is not).
const MAX_WINDOW_GAP_RATIO = 1.25;
const MIN_HISTORY_BARS = 1440;

// matchId -> { [symbol]: { preMatch: [{t,mid,bid,ask}], live: [{t,mid,bid,ask}] } }
const MATCH_WINDOWS = new Map();

// A Brownian bridge from `open` to `close`, clamped into [low, high] - keeps
// every synthetic sub-tick consistent with the real candle's recorded range
// while still looking like an organic path rather than a straight line.
function interpolateMinuteToTicks(bar, ticksPerMinute) {
  const { open, high, low, close } = bar;
  const n = ticksPerMinute;
  const range = Math.max(high - low, Math.abs(close - open), 1e-6);
  const stepVol = (range / Math.sqrt(n)) * 0.6;

  const w = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    w[i] = w[i - 1] + (Math.random() * 2 - 1) * stepVol;
  }

  const mids = [];
  for (let t = 1; t <= n; t++) {
    const bridge = w[t] - (t / n) * w[n];
    let mid = open + (close - open) * (t / n) + bridge;
    mid = Math.min(high, Math.max(low, mid));
    mids.push(mid);
  }
  return mids; // length n, last value === close-ish
}

function buildTick(mid, spread, decimals) {
  const roundedMid = Number(mid.toFixed(decimals));
  return {
    mid: roundedMid,
    bid: Number((roundedMid - spread / 2).toFixed(decimals)),
    ask: Number((roundedMid + spread / 2).toFixed(decimals)),
  };
}

// Builds (once, cached) the pre-match + live windows for one instrument in one
// match: a random valid start offset into that instrument's day of 1-minute
// bars, sliced into 120 pre-match minutes (shown as-is, one point per minute -
// consistent with the chart's per-minute pre-match candles elsewhere) and 10
// live minutes interpolated into 600 one-second ticks for the existing
// tick-driven match engine (price:update, SL/TP checks, etc. all stay unchanged).
// Simple string hash -> mulberry32 PRNG, used only so the Async Daily
// Challenge can give every player the exact same historical window for a
// given symbol on a given UTC calendar day (fairness requirement) without
// pulling in a random-seeding dependency.
function seededRandom(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

// Deterministic sibling of selectMatchInstruments for the Async Daily
// Challenge - every player who starts today's challenge must see the exact
// same instrument set, so this shuffles with a seeded PRNG instead of
// Math.random() rather than reusing the category-diversity logic above
// (which doesn't need to be deterministic for the competitive modes it serves).
function selectDailyInstruments(seed, count = 3) {
  const rand = seededRandom(seed);
  const all = Object.keys(INSTRUMENTS);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, count);
}

function assignMatchWindow(matchId, symbol, seed) {
  const cfg = getInstrument(symbol);
  if (!cfg) throw new Error(`Unknown instrument: ${symbol}`);

  let match = MATCH_WINDOWS.get(matchId);
  if (!match) {
    match = {};
    MATCH_WINDOWS.set(matchId, match);
  }
  if (match[symbol]) return match[symbol];

  const dayBars = csvLoader.getInstrumentDayData(symbol, cfg);
  const maxStart = dayBars.length - WINDOW_MINUTES;
  const rand = seed ? seededRandom(`${seed}:${symbol}`) : Math.random;
  // Multi-day market data has weekend/overnight gaps (closed-market bars are
  // dropped at download time) - a window spanning one would play a jump
  // between sessions as if it were a single minute, so retry for a stretch
  // that's (near-)continuous real time. Seeded runs stay deterministic since
  // the same PRNG sequence is consumed in the same order.
  // With market data, also skip the first ~day of bars so there's always
  // 1-minute history before the window for the 1m-30m chart timeframes.
  const minStart = csvLoader.getMarketSeries(symbol) ? Math.min(MIN_HISTORY_BARS, Math.floor(maxStart / 2)) : 0;
  const pickStart = () => minStart + Math.floor(rand() * (maxStart - minStart));
  let startIndex = maxStart > 0 ? pickStart() : 0;
  for (let attempt = 0; attempt < 50 && maxStart > 0; attempt++) {
    const span = dayBars[startIndex + WINDOW_MINUTES - 1].time - dayBars[startIndex].time;
    if (span <= (WINDOW_MINUTES - 1) * 60 * MAX_WINDOW_GAP_RATIO) break;
    startIndex = pickStart();
  }

  const preMatchBars = dayBars.slice(startIndex, startIndex + PRE_MATCH_MINUTES);
  const liveBars = dayBars.slice(startIndex + PRE_MATCH_MINUTES, startIndex + WINDOW_MINUTES);

  // Same per-second interpolation as the live bars below, not just bar.close -
  // a flat one-point-per-minute close produces a zero-range doji in every
  // bucket at any timeframe <= 60s (5s/10s/30s/M1 all collapse to one raw
  // point per bucket), which is most of the visible chart right at match
  // start when pre-match history dominates the screen.
  const totalPreMatchTicks = preMatchBars.length * TICKS_PER_MINUTE;
  const preMatch = [];
  let preMatchTickIndex = 0;
  preMatchBars.forEach((bar) => {
    const subTicks = interpolateMinuteToTicks(bar, TICKS_PER_MINUTE);
    subTicks.forEach((mid) => {
      const t = preMatchTickIndex - totalPreMatchTicks;
      preMatch.push({ t, ...buildTick(mid, cfg.spread, cfg.decimals) });
      preMatchTickIndex++;
    });
  });

  const live = [];
  liveBars.forEach((bar, minuteIdx) => {
    const subTicks = interpolateMinuteToTicks(bar, TICKS_PER_MINUTE);
    subTicks.forEach((mid, secIdx) => {
      const t = minuteIdx * TICKS_PER_MINUTE + secIdx;
      live.push({ t, ...buildTick(mid, cfg.spread, cfg.decimals) });
    });
  });

  match[symbol] = { preMatch, live, ...buildChartContext(symbol, preMatchBars) };
  return match[symbol];
}

const DAY_SECONDS = 86400;
const CONTEXT_M1_DAYS = 2; // feeds 1m-30m candles beyond the 2h of pre-match ticks
const CONTEXT_M1_MIN_BARS = 2880; // ...stretched further back for session-hours instruments (AAPL)
const CONTEXT_H1_DAYS = 45; // feeds 1h/4h
const CONTEXT_D1_BARS = 400; // feeds D1

// Real bars from before the pre-match ticks, for browsing history on the
// higher chart timeframes (1m..D1). Each resolution covers the stretch the
// finer one doesn't, with no overlap or gap between them, so a client candle
// spanning a handover still merges into correct OHLC. Times are seconds relative to match start (same
// axis as the ticks, never real dates - a calendar date would let a player
// look up what happens next), plus alignOffset = match start's seconds into
// its UTC day, so the client can align H1/H4/D1 candles to real boundaries.
function buildChartContext(symbol, preMatchBars) {
  const market = csvLoader.getMarketSeries(symbol);
  if (!market || !preMatchBars.length) return { context: null, alignOffset: 0 };

  const anchor = preMatchBars[0].time; // real time of the first pre-match tick
  const preMatchSeconds = PRE_MATCH_MINUTES * 60;
  const rel = (time) => time - anchor - preMatchSeconds;
  const dayFloor = (time) => Math.floor(time / DAY_SECONDS) * DAY_SECONDS;
  const toRow = (b) => [rel(b.time), b.open, b.high, b.low, b.close];

  // The m1 stretch starts on a whole hour (so an H1 candle never mixes h1 and
  // m1 bars) and h1 hands over to d1 on a UTC midnight, likewise for D1.
  const hourFloor = (time) => Math.floor(time / 3600) * 3600;
  let m1Start = hourFloor(anchor - CONTEXT_M1_DAYS * DAY_SECONDS);
  const anchorIndex = market.m1.findIndex((b) => b.time >= anchor);
  const minBarsIndex = Math.max(0, (anchorIndex === -1 ? market.m1.length : anchorIndex) - CONTEXT_M1_MIN_BARS);
  if (market.m1.length) m1Start = Math.min(m1Start, hourFloor(market.m1[minBarsIndex].time));
  if (market.m1.length && market.m1[0].time > m1Start) m1Start = hourFloor(market.m1[0].time) + 3600;
  m1Start = Math.min(m1Start, anchor);
  const h1Start = dayFloor(m1Start - CONTEXT_H1_DAYS * DAY_SECONDS);

  const m1 = market.m1.filter((b) => b.time >= m1Start && b.time < anchor);
  const h1 = market.h1.filter((b) => b.time >= h1Start && b.time < m1Start);
  const d1End = h1.length ? dayFloor(h1[0].time) : m1Start;
  const d1 = market.d1.filter((b) => b.time < d1End).slice(-CONTEXT_D1_BARS);

  const matchStart = anchor + preMatchSeconds;
  return {
    context: { m1: m1.map(toRow), h1: h1.map(toRow), d1: d1.map(toRow) },
    alignOffset: ((matchStart % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS,
  };
}

function getCurrentPrice(matchId, symbol, elapsedSeconds) {
  const match = MATCH_WINDOWS.get(matchId);
  if (!match || !match[symbol]) throw new Error(`No window assigned for match ${matchId} / ${symbol}`);
  const live = match[symbol].live;
  const clamped = Math.max(0, Math.min(live.length - 1, Math.floor(elapsedSeconds)));
  return live[clamped];
}

function getPreMatchHistory(matchId, symbol) {
  const match = MATCH_WINDOWS.get(matchId);
  if (!match || !match[symbol]) return null;
  return match[symbol].preMatch;
}

// Higher-timeframe history for the chart (see buildChartContext) - null for
// instruments with no downloaded market data, which then show ticks only.
function getChartContext(matchId, symbol) {
  const match = MATCH_WINDOWS.get(matchId);
  if (!match || !match[symbol]) return null;
  return { context: match[symbol].context, alignOffset: match[symbol].alignOffset };
}

function releaseMatchWindows(matchId) {
  MATCH_WINDOWS.delete(matchId);
}

// Full-resolution live tick series for a match's instrument, for persisting
// into the replays table at match end - must be called before
// releaseMatchWindows() clears the underlying cache.
function getFullLiveSeries(matchId, symbol) {
  const match = MATCH_WINDOWS.get(matchId);
  const entry = match && match[symbol];
  if (!entry) return [];
  return entry.live.map((tick) => ({ t: tick.t, mid: tick.mid }));
}

function getSpread(symbol) {
  const cfg = getInstrument(symbol);
  if (!cfg) throw new Error(`Unknown instrument: ${symbol}`);
  return cfg.spread;
}

// USD/JPY, USD/CHF, USD/CAD: prices are in the second currency, so a profit
// has to be converted back to dollars at the current rate. Without this a
// USD/JPY pip paid about $1,000 a lot instead of about $9.
function isUsdBase(symbol) {
  const cfg = getInstrument(symbol);
  return Boolean(cfg && cfg.category === 'forex' && symbol.startsWith('USD'));
}

function calculatePnL(direction, lots, entryPrice, currentPrice, symbol) {
  const cfg = getInstrument(symbol);
  if (!cfg) throw new Error(`Unknown instrument: ${symbol}`);
  const diff = direction === 'BUY' ? currentPrice - entryPrice : entryPrice - currentPrice;
  const pnl = diff * lots * cfg.contractSize;
  return isUsdBase(symbol) ? pnl / currentPrice : pnl;
}

function getPipValue(symbol, lots) {
  const cfg = getInstrument(symbol);
  if (!cfg) throw new Error(`Unknown instrument: ${symbol}`);
  return cfg.pipSize * cfg.contractSize * lots;
}

// Called once at server startup so every instrument's data (real CSV or
// synthetic fallback) is loaded/generated up front rather than on the first
// match that happens to use it, and so there's a clear report of what loaded.
// Decorative price snapshot for the Trading Floor home screen ticker - not
// tied to any match, rotates through each instrument's day data using the
// current minute as a slowly-advancing shared cursor.
function getTickerSnapshot() {
  const cursor = Math.floor(Date.now() / 60000);
  const rows = [];
  for (const [symbol, cfg] of Object.entries(INSTRUMENTS)) {
    const dayBars = csvLoader.getInstrumentDayData(symbol, cfg);
    if (!dayBars || !dayBars.length) continue;
    const bar = dayBars[cursor % dayBars.length];
    const changePct = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : 0;
    rows.push({ symbol, price: Number(bar.close.toFixed(cfg.decimals)), changePct: Number(changePct.toFixed(2)) });
  }
  return rows;
}

function preloadAll() {
  const report = [];
  for (const [symbol, cfg] of Object.entries(INSTRUMENTS)) {
    const bars = csvLoader.getInstrumentDayData(symbol, cfg);
    report.push({
      symbol,
      source: csvLoader.getMarketSeries(symbol) ? 'market' : cfg.dataFile && !csvLoader.isSynthetic(symbol) ? 'csv' : 'synthetic',
      points: bars.length,
    });
  }
  return report;
}

module.exports = {
  INSTRUMENTS,
  CATEGORIES: Array.from(CATEGORIES),
  getInstrument,
  listInstruments,
  selectMatchInstruments,
  selectDailyInstruments,
  assignMatchWindow,
  getCurrentPrice,
  getPreMatchHistory,
  getChartContext,
  releaseMatchWindows,
  getFullLiveSeries,
  getSpread,
  calculatePnL,
  isUsdBase,
  getPipValue,
  preloadAll,
  getTickerSnapshot,
  PRE_MATCH_MINUTES,
  LIVE_MINUTES,
};
