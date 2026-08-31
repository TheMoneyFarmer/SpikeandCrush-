'use strict';

const fs = require('fs');
const path = require('path');
const { gaussianRandom } = require('../data/dataProcessor');

const HISTORICAL_DIR = path.join(__dirname, '..', 'data', 'historical');

// filenamePattern -> parsed bars (or null if the file is missing/empty), loaded
// once and reused for the life of the process.
const csvCache = new Map();
// instrument symbol -> a full "day" of 1-minute OHLCV bars (real CSV-backed or
// synthetic), also loaded once.
const dayDataCache = new Map();

function findFile(pattern) {
  if (!fs.existsSync(HISTORICAL_DIR)) return null;
  const files = fs.readdirSync(HISTORICAL_DIR);
  const match = files.find((f) => f.includes(pattern));
  return match ? path.join(HISTORICAL_DIR, match) : null;
}

// Real files use `Etc/UTC` as the datetime column header (not `DateTime` as
// originally assumed) - parsed positionally by column index instead of by
// header name, so the exact header text doesn't matter.
function loadCSVFile(pattern) {
  if (csvCache.has(pattern)) return csvCache.get(pattern);

  const filePath = findFile(pattern);
  if (!filePath) {
    console.warn(`[csvLoader] no file matching "${pattern}" in ${HISTORICAL_DIR}`);
    csvCache.set(pattern, null);
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  const lines = raw.split('\n');
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 6) continue;
    const [dateStr, open, high, low, close, volume] = parts;
    const timeMs = Date.parse(dateStr);
    if (Number.isNaN(timeMs)) continue;
    const o = Number(open);
    const h = Number(high);
    const l = Number(low);
    const c = Number(close);
    if (![o, h, l, c].every(Number.isFinite)) continue;
    bars.push({ time: Math.floor(timeMs / 1000), open: o, high: h, low: l, close: c, volume: Number(volume) || 0 });
  }
  bars.sort((a, b) => a.time - b.time);

  if (bars.length === 0) {
    console.warn(`[csvLoader] "${path.basename(filePath)}" matched "${pattern}" but has no usable rows`);
    csvCache.set(pattern, null);
    return null;
  }

  console.log(`[csvLoader] loaded ${bars.length} bars from ${path.basename(filePath)} (pattern "${pattern}")`);
  csvCache.set(pattern, bars);
  return bars;
}

// Volatility isn't flat through a real trading day - busier at session opens,
// quieter overnight/at lunch. Applied as a multiplier on the base per-minute
// volatility so synthetic instruments don't feel like flat white noise.
function sessionVolatilityMultiplier(minuteOfDay) {
  const hour = (minuteOfDay / 60) % 24;
  if (hour >= 7 && hour < 9) return 1.6; // London open
  if (hour >= 13 && hour < 15) return 1.8; // New York open
  if (hour >= 11.5 && hour < 13) return 0.6; // UTC lunch lull
  if (hour >= 0 && hour < 5) return 0.5; // Asian quiet hours
  return 1.0;
}

// One full synthetic "day" (1440 one-minute OHLCV bars) for an instrument with
// no usable CSV. Built with the same mean-reversion-plus-drift model as the
// existing EURUSD/XAUUSD generator (data/dataProcessor.js), just at 1-minute
// resolution with a handful of intra-minute sub-steps for a believable high/low.
function generateSyntheticDay(basePrice, volatility, decimals = 5) {
  const bars = [];
  let price = basePrice;
  let longRunMean = basePrice;
  let drift = 0;
  const minutesInDay = 1440;
  const anchor = 1700000000; // arbitrary fixed epoch - synthetic instruments have no real calendar date

  for (let m = 0; m < minutesInDay; m++) {
    const vol = volatility * sessionVolatilityMultiplier(m);
    longRunMean += gaussianRandom() * vol * 0.3;
    drift = drift * 0.985 + gaussianRandom() * vol * 0.15;
    const reversion = (longRunMean - price) * 0.04;

    const open = price;
    let high = open;
    let low = open;
    let close = open;
    const subSteps = 6;
    for (let s = 0; s < subSteps; s++) {
      const shock = gaussianRandom() * (vol / Math.sqrt(subSteps));
      close += shock + drift / subSteps + reversion / subSteps;
      if (close <= 0) close = basePrice * 0.5;
      high = Math.max(high, close);
      low = Math.min(low, close);
    }
    price = close;

    bars.push({
      time: anchor + m * 60,
      open: Number(open.toFixed(decimals)),
      high: Number(high.toFixed(decimals)),
      low: Number(low.toFixed(decimals)),
      close: Number(close.toFixed(decimals)),
      volume: Math.round(500 + Math.random() * 2000),
    });
  }
  return bars;
}

// Returns a full "day" of 1-minute bars for an instrument: real CSV data when
// a usable file is present, otherwise a procedurally generated day. Cached per
// symbol so each instrument is only loaded/generated once per server run.
function getInstrumentDayData(symbol, { dataFile, basePrice, volatility, decimals = 5 }) {
  if (dayDataCache.has(symbol)) return dayDataCache.get(symbol);

  let bars = null;
  if (dataFile) {
    bars = loadCSVFile(dataFile);
  }

  // A file that's missing, empty, or too short to cover a match window
  // (120 pre-match + 10 live = 130 minutes minimum) falls back to synthetic -
  // this is what actually happens for USTUSD, whose CSV is a header with 0 rows.
  if (!bars || bars.length < 130) {
    if (dataFile) {
      console.warn(`[csvLoader] ${symbol}: "${dataFile}" unusable (${bars ? bars.length : 0} bars) - using synthetic data instead`);
    }
    bars = generateSyntheticDay(basePrice, volatility, decimals);
  }

  dayDataCache.set(symbol, bars);
  return bars;
}

function isSynthetic(symbol) {
  const bars = dayDataCache.get(symbol);
  return !!bars && bars.length > 0 && bars[0].time === 1700000000;
}

module.exports = {
  loadCSVFile,
  generateSyntheticDay,
  getInstrumentDayData,
  isSynthetic,
};
