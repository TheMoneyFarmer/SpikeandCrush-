'use strict';

// Downloads real multi-timeframe history for every instrument that has a
// `dukascopy` id in server/instruments.js, into data/market/<SYMBOL>/:
//   m1.csv.gz - recent 1-minute bars (match windows + 1m..30m chart history)
//   m5.csv.gz - ~7 months of 5-minute bars (long-form competition replay)
//   h1.csv.gz - ~6 months of hourly bars (1h/4h chart history)
//   d1.csv.gz - ~2 years of daily bars (D1 chart history)
// Rows are `time,open,high,low,close` with time in UNIX seconds (UTC).
//
// Usage: npm run data:fetch            (all instruments)
//        npm run data:fetch -- EURUSD  (just the listed symbols)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getHistoricalRates } = require('dukascopy-node');
const { INSTRUMENTS } = require('../server/instruments');

const OUT_DIR = path.join(__dirname, '..', 'data', 'market');
const DAY_MS = 86400000;

const RANGES = {
  m1: 14,
  // Base resolution for long-form competitions (server/replayClock.js) - a
  // monthly needs 31 continuous days plus room for distinct windows; m1 for
  // that long would be too heavy to hold in memory.
  m5: 210,
  h1: 180,
  d1: 730,
};

async function fetchSeries(id, timeframe, days) {
  // Ends at today's UTC midnight so a re-run never stores a half-formed day.
  const to = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS);
  const from = new Date(to.getTime() - days * DAY_MS);
  const rows = await getHistoricalRates({
    instrument: id,
    dates: { from, to },
    timeframe,
    format: 'array',
    volumes: false,
    ignoreFlats: true,
    retryCount: 3,
    batchSize: 10,
    pauseBetweenBatchesMs: 500,
  });
  // ignoreFlats only works with volumes on, so closed-market filler (weekends,
  // AAPL overnight) is dropped here instead: a bar with no range that opens
  // exactly where the previous one closed means nothing traded.
  const kept = [];
  let prevClose = null;
  for (const [ms, o, h, l, c] of rows) {
    const flat = o === h && h === l && l === c;
    if (!(flat && o === prevClose)) kept.push(`${Math.floor(ms / 1000)},${o},${h},${l},${c}`);
    prevClose = c;
  }
  return kept;
}

async function main() {
  const only = process.argv.slice(2).map((s) => s.toUpperCase());
  const symbols = Object.keys(INSTRUMENTS).filter(
    (sym) => INSTRUMENTS[sym].dukascopy && (only.length === 0 || only.includes(sym))
  );

  for (const sym of symbols) {
    const dir = path.join(OUT_DIR, sym);
    fs.mkdirSync(dir, { recursive: true });
    for (const [tf, days] of Object.entries(RANGES)) {
      try {
        const lines = await fetchSeries(INSTRUMENTS[sym].dukascopy, tf, days);
        if (lines.length === 0) {
          console.warn(`[data:fetch] ${sym} ${tf}: no rows returned - keeping any existing file`);
          continue;
        }
        const csv = `time,open,high,low,close\n${lines.join('\n')}\n`;
        fs.writeFileSync(path.join(dir, `${tf}.csv.gz`), zlib.gzipSync(csv));
        console.log(`[data:fetch] ${sym} ${tf}: ${lines.length} bars`);
      } catch (e) {
        console.error(`[data:fetch] ${sym} ${tf} failed: ${e.message}`);
      }
    }
  }
}

main();
