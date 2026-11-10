'use strict';

// Validates a freshly built curated directory BEFORE it may go live:
// every valid start of every kept instrument passes the no-flat guarantee
// (sampled matches through the real generator), every seam is exact, prices
// stay inside the band. Exit 0 = safe to swap in, 1 = keep the old playlists.
//   node scripts/fire/validate-curated.js data/curated-next [samples]
const path = require('path');
const curated = require('../../server/curated');
const instruments = require('../../server/instruments');
const gameFeel = require('../../server/config/gameFeel');

const dir = path.resolve(process.argv[2] || 'data/curated-next');
const samples = Number(process.argv[3] || 40);
curated.setDir(dir);
const cat = curated.load();
if (!cat) {
  console.log(JSON.stringify({ ok: false, error: `no catalog in ${dir}` }));
  process.exit(1);
}
const limit = gameFeel.get().market.flatLimitSeconds;
const band = gameFeel.get().market.priceBandPct;
const problems = [];
let checked = 0;
for (const sym of Object.keys(cat.instruments)) {
  const pl = curated.getPlaylist(sym);
  const c = cat.instruments[sym];
  if (c.bandPct.low < -band || c.bandPct.high > band) problems.push(`${sym}: price band ${c.bandPct.low}..${c.bandPct.high}%`);
  for (let i = 0; i < pl.bars.length; i++) {
    const prev = pl.bars[(i - 1 + pl.bars.length) % pl.bars.length];
    if (pl.bars[i][0] !== prev[3]) {
      problems.push(`${sym}: seam jump at bar ${i}`);
      break;
    }
  }
  for (const secs of [180, 600, 900, 1200]) {
    if (!pl.validStarts[secs] || !pl.validStarts[secs].length) {
      problems.push(`${sym}: no valid start for ${secs}s`);
      continue;
    }
    for (let k = 0; k < samples; k++) {
      const id = `validate-${sym}-${secs}-${k}`;
      instruments.assignMatchWindow(id, sym, id, Math.ceil(secs / 60));
      const mids = instruments.getPreMatchHistory(id, sym).map((p) => p.mid).concat(instruments.getFullLiveSeries(id, sym).slice(0, secs).map((p) => p.mid));
      instruments.releaseMatchWindows(id);
      let run = 0;
      for (let i = 1; i < mids.length; i++) {
        run = mids[i] === mids[i - 1] ? run + 1 : 0;
        if (run > limit) {
          problems.push(`${sym} ${secs}s: flat ${run}s`);
          break;
        }
      }
      checked++;
    }
  }
}
const ok = problems.length === 0;
console.log(JSON.stringify({ ok, instruments: Object.keys(cat.instruments).length, matchesChecked: checked, problems: problems.slice(0, 20) }));
process.exit(ok ? 0 : 1);
