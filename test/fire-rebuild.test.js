'use strict';

// Test 5 (part): a rebuild that fails the guarantee is rejected - the
// validator exits 1 on a curated set with a dead (flat) stretch, so
// server/fireAdmin.js never swaps it in and the old playlists stay live.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const run = (dir) => spawnSync(process.execPath, ['scripts/fire/validate-curated.js', dir, '15'], { cwd: ROOT, encoding: 'utf8' });

test('the live curated set passes validation', () => {
  const r = run('data/curated');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(r.stdout.trim().split('\n').pop()).ok, true);
});

test('a corrupted set (flat bars, broken seam) is rejected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curated-bad-'));
  for (const f of fs.readdirSync(path.join(ROOT, 'data/curated'))) fs.copyFileSync(path.join(ROOT, 'data/curated', f), path.join(tmp, f));
  const cat = JSON.parse(fs.readFileSync(path.join(tmp, 'catalog.json'), 'utf8'));
  const sym = Object.keys(cat.instruments)[0];
  const file = path.join(tmp, cat.instruments[sym].file);
  const pl = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Flatten every bar: a market that never moves, and keep claiming all starts valid.
  pl.bars = pl.bars.map(([o]) => [o, o, o, o]);
  pl.bars[10][0] = pl.bars[10][0] * 1.01; // and a seam jump
  fs.writeFileSync(file, JSON.stringify(pl));
  const r = run(tmp);
  assert.strictEqual(r.status, 1, r.stdout);
  const verdict = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes(sym)), JSON.stringify(verdict));
  fs.rmSync(tmp, { recursive: true, force: true });
});
