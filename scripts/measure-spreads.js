'use strict';
// Measures every instrument's real spread from the same source as its prices
// (Dukascopy tick data: ask and bid on every tick). Samples a London window
// and a New York window on several recent weekdays and prints the median
// ask - bid per instrument, so server/instruments.js can use it as `spread`.
//   node scripts/measure-spreads.js [YYYY-MM-DD ...]  > spreads.json
process.env.SUPABASE_URL = process.env.SUPABASE_URL || '';
const { getHistoricalRates } = require('dukascopy-node');
const { INSTRUMENTS } = require('../server/instruments');

const DAYS = process.argv.slice(2).length ? process.argv.slice(2) : ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-17', '2026-11-18'];
// UTC windows: London morning, New York morning (stocks and US softs trade here).
const WINDOWS = [['08:00', '08:20'], ['15:00', '15:20']];

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function spreadsFor(id) {
  const out = [];
  for (const day of DAYS) {
    for (const [from, to] of WINDOWS) {
      try {
        const rows = await getHistoricalRates({ instrument: id, dates: { from: new Date(`${day}T${from}:00Z`), to: new Date(`${day}T${to}:00Z`) }, timeframe: 'tick', format: 'array' });
        for (const r of rows) if (r[1] > r[2]) out.push(r[1] - r[2]);
      } catch { /* window without data */ }
    }
  }
  return out;
}

(async () => {
  const result = {};
  for (const [sym, cfg] of Object.entries(INSTRUMENTS)) {
    if (!cfg.dukascopy) continue;
    const s = await spreadsFor(cfg.dukascopy);
    result[sym] = { source: cfg.dukascopy, ticks: s.length, median: median(s) };
    console.error(sym.padEnd(6), String(s.length).padStart(7), 'ticks  median', result[sym].median, ' current', cfg.spread);
  }
  console.log(JSON.stringify({ measuredFrom: DAYS, windowsUtc: WINDOWS, spreads: result }, null, 1));
})();
