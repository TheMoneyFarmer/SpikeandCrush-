'use strict';

// Prints every Express route (method + path) in the game and admin servers, sorted,
// so a before/after diff shows exactly what a change added or removed.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROUTE = /\b(app|router|r)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\3/g;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'knowledge' ? [] : walk(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}

const lines = [];
for (const dir of ['server', 'admin']) {
  for (const file of walk(path.join(ROOT, dir))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(ROUTE)) {
      lines.push(`${path.relative(ROOT, file)} ${m[2].toUpperCase()} ${m[4]}`);
    }
  }
}
process.stdout.write(`${[...new Set(lines)].sort().join('\n')}\n`);
