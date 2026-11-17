#!/usr/bin/env node
'use strict';

// Adds the Bell Rush (stocks) and The Pit (futures) playlists from a separate
// curation run into data/curated without touching the existing instruments,
// their ranking or the long-form competition files.
//
//   node scripts/curate-data.js --only stocks,futures --keep-all --out data/curated-modes --report docs/fire/curation-modes.md
//   node scripts/merge-mode-curation.js [data/curated-modes] [--exclude VX,MA,OJ]
//
// --exclude: symbols that fail scripts/fire/validate-curated.js (2026-11-16:
// VX breaks the 15% price band, MA has flat stretches, OJ has no valid start) are left out.
//
// Existing symbols (e.g. AAPL) are left exactly as they are. New symbols are
// appended to catalog.instruments and to the end of catalog.ranking with
// pool: 'modes' (their own activity rank kept as modeRank), so "top N"
// pools of other modes never pick them up (those modes exclude the classes
// anyway).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const EXCLUDE = argv.includes('--exclude') ? argv[argv.indexOf('--exclude') + 1].split(',') : [];
const SRC = path.resolve(ROOT, argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--exclude') || 'data/curated-modes');
const DST = path.join(ROOT, 'data', 'curated');

const src = JSON.parse(fs.readFileSync(path.join(SRC, 'catalog.json'), 'utf8'));
const dst = JSON.parse(fs.readFileSync(path.join(DST, 'catalog.json'), 'utf8'));

let added = 0;
const skipped = [];
let nextRank = Math.max(...dst.ranking.map((r) => r.rank)) + 1;
for (const r of src.ranking) {
  const entry = src.instruments[r.sym];
  if (!entry || EXCLUDE.includes(r.sym)) continue;
  if (dst.instruments[r.sym]) {
    skipped.push(r.sym);
    continue;
  }
  fs.copyFileSync(path.join(SRC, entry.file), path.join(DST, entry.file));
  dst.instruments[r.sym] = { ...entry, pool: 'modes' };
  dst.ranking.push({ rank: nextRank++, sym: r.sym, cls: r.cls, score: r.score, kept: true, forcedForClass: false, pool: 'modes', modeRank: r.rank });
  added++;
}
dst.modesCuration = { builtFrom: path.relative(ROOT, SRC), at: new Date().toISOString().slice(0, 10), added, skippedExisting: skipped, excluded: EXCLUDE };
fs.writeFileSync(path.join(DST, 'catalog.json'), `${JSON.stringify(dst, null, 1)}\n`);
console.log(`[merge-mode-curation] added ${added} instruments; left existing as they were: ${skipped.join(', ') || 'none'}`);
