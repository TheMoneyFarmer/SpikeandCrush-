'use strict';

/**
 * Historical-style price path generator shared by the live server
 * (server/marketData.js) and this file's CLI mode.
 *
 * Model: a random walk with momentum (short-lived drift) pulled back toward
 * a slowly-shifting long-run mean (mean reversion). The long-run mean itself
 * wanders over the window, which is what produces multi-minute trending legs
 * instead of pure white noise.
 */

function gaussianRandom() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function generateWindow({
  basePrice,
  volatility,
  spread,
  points = 600,
  meanReversionStrength = 0.04,
  trendPersistence = 0.985,
  decimals = 5,
}) {
  const path = [];
  let mid = basePrice;
  let longRunMean = basePrice;
  let drift = 0;

  for (let i = 0; i < points; i++) {
    longRunMean += gaussianRandom() * volatility * 0.3;
    drift = drift * trendPersistence + gaussianRandom() * volatility * 0.15;
    const reversion = (longRunMean - mid) * meanReversionStrength;
    const shock = gaussianRandom() * volatility;

    mid = mid + shock + drift + reversion;
    if (mid <= 0) mid = basePrice * 0.5;

    const roundedMid = Number(mid.toFixed(decimals));
    const bid = Number((roundedMid - spread / 2).toFixed(decimals));
    const ask = Number((roundedMid + spread / 2).toFixed(decimals));

    path.push({ t: i, mid: roundedMid, bid, ask });
  }

  return path;
}

function generateWindows(config, count) {
  const windows = [];
  for (let i = 0; i < count; i++) {
    windows.push(generateWindow(config));
  }
  return windows;
}

const SYMBOL_CONFIG = {
  EURUSD: { basePrice: 1.08, volatility: 0.0002, spread: 0.00015, decimals: 5 },
  XAUUSD: { basePrice: 1950.0, volatility: 0.5, spread: 0.5, decimals: 2 },
};

module.exports = { gaussianRandom, generateWindow, generateWindows, SYMBOL_CONFIG };

// `npm run generate-data` regenerates the static sample files below. These are
// illustrative only - live matches use server/marketData.js, which pre-generates
// its own 1000 in-memory windows per symbol at server startup.
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');

  const SAMPLE_WINDOW_COUNT = 25;

  for (const [symbol, cfg] of Object.entries(SYMBOL_CONFIG)) {
    const windows = generateWindows({ ...cfg, points: 600 }, SAMPLE_WINDOW_COUNT);
    const outPath = path.join(__dirname, `${symbol}_2022.json`);
    fs.writeFileSync(outPath, JSON.stringify({ symbol, points_per_window: 600, windows }, null, 2));
    console.log(`Wrote ${windows.length} windows (${windows.length * 600} ticks) to ${outPath}`);
  }
}
