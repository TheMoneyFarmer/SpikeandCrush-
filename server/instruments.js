'use strict';

const csvLoader = require('./csvLoader');

// dataFile is a substring match against the actual filenames in
// data/historical/ (which carry long date-stamped names) - see csvLoader.findFile.
// EURUSD/XAUUSD keep dataFile: null and the exact basePrice/volatility/spread
// the existing (pre-expansion) synthetic engine already used, so their behavior
// is unchanged for players still in a plain Quick War.
const INSTRUMENTS = {
  // ---- forex ----------------------------------------------------------------
  EURUSD: {
    name: 'EUR/USD', category: 'forex', nickname: ['fiber', 'euro', 'eurusd'],
    pipSize: 0.0001, pipValue: 10, spread: 0.00015, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 1.08, volatility: 0.0002,
  },
  GBPUSD: {
    name: 'GBP/USD', category: 'forex', nickname: ['cable', 'pound', 'sterling'],
    pipSize: 0.0001, pipValue: 10, spread: 0.00020, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 1.27, volatility: 0.00025,
  },
  USDJPY: {
    name: 'USD/JPY', category: 'forex', nickname: ['yen', 'dollar yen', 'usdjpy'],
    pipSize: 0.01, pipValue: 9.1, spread: 0.015, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 3, dataFile: null, basePrice: 149.5, volatility: 0.03,
  },
  USDCHF: {
    name: 'USD/CHF', category: 'forex', nickname: ['swissy', 'swiss franc'],
    pipSize: 0.0001, pipValue: 10.9, spread: 0.00020, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 0.88, volatility: 0.00022,
  },
  AUDUSD: {
    name: 'AUD/USD', category: 'forex', nickname: ['aussie', 'australian'],
    pipSize: 0.0001, pipValue: 10, spread: 0.00018, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 0.66, volatility: 0.00022,
  },
  USDCAD: {
    name: 'USD/CAD', category: 'forex', nickname: ['loonie', 'canadian'],
    pipSize: 0.0001, pipValue: 7.4, spread: 0.00022, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 1.36, volatility: 0.00022,
  },
  NZDUSD: {
    name: 'NZD/USD', category: 'forex', nickname: ['kiwi', 'new zealand'],
    pipSize: 0.0001, pipValue: 10, spread: 0.00025, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 0.61, volatility: 0.00025,
  },

  // ---- metals -----------------------------------------------------------------
  XAUUSD: {
    name: 'Gold', category: 'metals', nickname: ['gold', 'xauusd', 'yellow metal'],
    pipSize: 0.01, pipValue: 1, spread: 0.35, contractSize: 100,
    minLot: 0.01, maxLot: 50, decimals: 2, dataFile: null, basePrice: 1950.0, volatility: 0.5,
  },
  XAGUSD: {
    name: 'Silver', category: 'metals', nickname: ['silver', 'xagusd'],
    pipSize: 0.001, pipValue: 5, spread: 0.03, contractSize: 5000,
    minLot: 0.01, maxLot: 50, decimals: 3, dataFile: null, basePrice: 23.5, volatility: 0.05,
  },

  // ---- indices ------------------------------------------------------------
  NAS100: {
    name: 'NASDAQ 100', category: 'indices', nickname: ['nasdaq', 'nas', 'tech index', 'hundred'],
    pipSize: 0.1, pipValue: 1, spread: 1.5, contractSize: 1,
    minLot: 0.1, maxLot: 100, decimals: 2, dataFile: 'USATECH.IDX', basePrice: 14037, volatility: 8,
  },
  US30: {
    name: 'Dow Jones', category: 'indices', nickname: ['dow', 'dow jones', 'usa30', 'thirty'],
    pipSize: 0.1, pipValue: 1, spread: 2.0, contractSize: 1,
    minLot: 0.1, maxLot: 100, decimals: 2, dataFile: 'USA30.IDX', basePrice: 24731, volatility: 10,
  },
  UK100: {
    name: 'FTSE 100', category: 'indices', nickname: ['ftse', 'footsie', 'uk100'],
    pipSize: 0.1, pipValue: 1.27, spread: 2.0, contractSize: 1,
    minLot: 0.1, maxLot: 100, decimals: 1, dataFile: null, basePrice: 7650, volatility: 8,
  },
  GER40: {
    name: 'DAX 40', category: 'indices', nickname: ['dax', 'german index', 'ger40'],
    pipSize: 0.1, pipValue: 1, spread: 1.5, contractSize: 1,
    minLot: 0.1, maxLot: 100, decimals: 1, dataFile: null, basePrice: 16800, volatility: 15,
  },

  // ---- commodities --------------------------------------------------------
  BRENT: {
    name: 'Brent Crude', category: 'commodities', nickname: ['brent', 'brent crude', 'uk oil'],
    pipSize: 0.01, pipValue: 10, spread: 0.05, contractSize: 1000,
    minLot: 0.01, maxLot: 50, decimals: 3, dataFile: 'BRENT.CMD', basePrice: 46.8, volatility: 0.15,
  },
  USOIL: {
    name: 'WTI Crude', category: 'commodities', nickname: ['wti', 'crude', 'oil', 'usoil'],
    pipSize: 0.01, pipValue: 10, spread: 0.05, contractSize: 1000,
    minLot: 0.01, maxLot: 50, decimals: 2, dataFile: null, basePrice: 78.5, volatility: 0.3,
  },

  // ---- crypto ---------------------------------------------------------------
  BTCUSD: {
    name: 'Bitcoin', category: 'crypto', nickname: ['bitcoin', 'btc'],
    pipSize: 0.01, pipValue: 0.01, spread: 15.0, contractSize: 1,
    minLot: 0.01, maxLot: 10, decimals: 1, dataFile: 'BTC-USD', basePrice: 9795, volatility: 15,
  },
  ETHUSD: {
    name: 'Ethereum', category: 'crypto', nickname: ['ethereum', 'eth'],
    pipSize: 0.01, pipValue: 0.01, spread: 1.0, contractSize: 1,
    minLot: 0.01, maxLot: 50, decimals: 2, dataFile: 'ETH-USD', basePrice: 186.7, volatility: 0.3,
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
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: 'AAPL.US-USD', basePrice: 351.17, volatility: 0.5,
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
  const rand = seed ? seededRandom(`${seed}:${symbol}`)() : Math.random();
  const startIndex = maxStart > 0 ? Math.floor(rand * maxStart) : 0;

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

  match[symbol] = { preMatch, live };
  return match[symbol];
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

function calculatePnL(direction, lots, entryPrice, currentPrice, symbol) {
  const cfg = getInstrument(symbol);
  if (!cfg) throw new Error(`Unknown instrument: ${symbol}`);
  const diff = direction === 'BUY' ? currentPrice - entryPrice : entryPrice - currentPrice;
  return diff * lots * cfg.contractSize;
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
      source: cfg.dataFile && !csvLoader.isSynthetic(symbol) ? 'csv' : 'synthetic',
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
  releaseMatchWindows,
  getFullLiveSeries,
  getSpread,
  calculatePnL,
  getPipValue,
  preloadAll,
  getTickerSnapshot,
  PRE_MATCH_MINUTES,
  LIVE_MINUTES,
};
