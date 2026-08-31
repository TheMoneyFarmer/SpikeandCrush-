'use strict';

const path = require('path');
const { generateWindow, SYMBOL_CONFIG } = require('../data/dataProcessor');

const WINDOWS_PER_SYMBOL = 1000;
const POINTS_PER_WINDOW = 600; // 10 minutes at 1 second intervals
const PRE_MATCH_SECONDS = 7200; // 2 hours of 1-second ticks shown as historical context before match start

const CONTRACT_SIZE = { EURUSD: 100000, XAUUSD: 100 };
const PIP_SIZE = { EURUSD: 0.0001, XAUUSD: 0.1 };

// Pre-generated pool of historical-style windows, held in memory for the life
// of the process. Each window is an array of 600 {t, mid, bid, ask} ticks.
const WINDOW_POOL = {};
// Shuffled queue of pool indices not yet handed out; refilled/reshuffled once
// exhausted so windows are unique-per-match until the whole pool has cycled.
const AVAILABLE_QUEUE = {};
// matchId -> { EURUSD: { poolIndex, window }, XAUUSD: { poolIndex, window } }
const MATCH_WINDOWS = new Map();

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildPool(symbol) {
  const cfg = SYMBOL_CONFIG[symbol];
  const windows = [];
  for (let i = 0; i < WINDOWS_PER_SYMBOL; i++) {
    windows.push(generateWindow({ ...cfg, points: POINTS_PER_WINDOW }));
  }
  WINDOW_POOL[symbol] = windows;
  AVAILABLE_QUEUE[symbol] = shuffle(windows.map((_, i) => i));
}

for (const symbol of Object.keys(SYMBOL_CONFIG)) {
  buildPool(symbol);
}
console.log(
  `[marketData] pre-generated ${WINDOWS_PER_SYMBOL} windows x ${POINTS_PER_WINDOW} ticks for: ${Object.keys(
    SYMBOL_CONFIG
  ).join(', ')}`
);

function getRandomWindow(symbol) {
  if (!WINDOW_POOL[symbol]) throw new Error(`Unknown symbol: ${symbol}`);
  if (AVAILABLE_QUEUE[symbol].length === 0) {
    // Pool exhausted - reshuffle so windows stay unique for another full cycle.
    AVAILABLE_QUEUE[symbol] = shuffle(WINDOW_POOL[symbol].map((_, i) => i));
  }
  const poolIndex = AVAILABLE_QUEUE[symbol].pop();
  return { poolIndex, window: WINDOW_POOL[symbol][poolIndex] };
}

function assignMatchWindows(matchId) {
  const assignment = {};
  for (const symbol of Object.keys(SYMBOL_CONFIG)) {
    assignment[symbol] = getRandomWindow(symbol);
  }
  MATCH_WINDOWS.set(matchId, assignment);
  return {
    EURUSD: assignment.EURUSD.poolIndex,
    XAUUSD: assignment.XAUUSD.poolIndex,
  };
}

function releaseMatchWindows(matchId) {
  MATCH_WINDOWS.delete(matchId);
}

function getCurrentPrice(matchId, symbol, elapsedSeconds) {
  const assignment = MATCH_WINDOWS.get(matchId);
  if (!assignment || !assignment[symbol]) {
    throw new Error(`No window assigned for match ${matchId} / ${symbol}`);
  }
  const window = assignment[symbol].window;
  const clamped = Math.max(0, Math.min(window.length - 1, Math.floor(elapsedSeconds)));
  return window[clamped];
}

// Lazily generated per {match, symbol} - not part of the startup pool, since
// only a handful of matches are ever live at once (unlike the live-window pool,
// which needs 1000 pre-generated entries so every concurrent match gets a
// unique one). Generated as one continuous random walk ending exactly at the
// live window's first tick, then split, so there's no visible price jump at
// the "MATCH START" boundary.
function getPreMatchHistory(matchId, symbol) {
  const assignment = MATCH_WINDOWS.get(matchId);
  if (!assignment || !assignment[symbol]) {
    throw new Error(`No window assigned for match ${matchId} / ${symbol}`);
  }
  if (assignment[symbol].preMatch) return assignment[symbol].preMatch;

  const cfg = SYMBOL_CONFIG[symbol];
  const liveFirstMid = assignment[symbol].window[0].mid;
  const path = generateWindow({ ...cfg, points: PRE_MATCH_SECONDS });
  const offset = liveFirstMid - path[path.length - 1].mid;

  const shifted = path.map((p, i) => {
    const mid = Number((p.mid + offset).toFixed(cfg.decimals));
    const bid = Number((mid - cfg.spread / 2).toFixed(cfg.decimals));
    const ask = Number((mid + cfg.spread / 2).toFixed(cfg.decimals));
    return { t: i - PRE_MATCH_SECONDS, mid, bid, ask };
  });

  assignment[symbol].preMatch = shifted;
  return shifted;
}

function getSpread(symbol) {
  const cfg = SYMBOL_CONFIG[symbol];
  if (!cfg) throw new Error(`Unknown symbol: ${symbol}`);
  return cfg.spread;
}

function calculatePnL(direction, lots, entryPrice, currentPrice, symbol) {
  const size = CONTRACT_SIZE[symbol];
  if (!size) throw new Error(`Unknown symbol: ${symbol}`);
  const diff = direction === 'BUY' ? currentPrice - entryPrice : entryPrice - currentPrice;
  return diff * lots * size;
}

function getPipValue(symbol, lots) {
  const size = CONTRACT_SIZE[symbol];
  const pip = PIP_SIZE[symbol];
  if (!size || !pip) throw new Error(`Unknown symbol: ${symbol}`);
  return pip * size * lots;
}

module.exports = {
  SYMBOL_CONFIG,
  CONTRACT_SIZE,
  PIP_SIZE,
  POINTS_PER_WINDOW,
  WINDOWS_PER_SYMBOL,
  PRE_MATCH_SECONDS,
  getRandomWindow,
  assignMatchWindows,
  releaseMatchWindows,
  getCurrentPrice,
  getPreMatchHistory,
  getSpread,
  calculatePnL,
  getPipValue,
};
