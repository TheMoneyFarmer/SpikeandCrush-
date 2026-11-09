'use strict';

// Fails if any <img> in a page or a client script has no alt attribute.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['vendor', 'uploads', 'assets', 'Sounds', 'icons', 'node_modules']);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  if (e.isDirectory()) return SKIP.has(e.name) ? [] : walk(full);
  return /\.(html|js)$/.test(e.name) ? [full] : [];
});

const missing = [];
for (const file of [...walk(path.join(ROOT, 'client')), ...walk(path.join(ROOT, 'admin'))]) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/<img\b[^>]*>/g)) {
    if (!/\balt=/.test(m[0])) missing.push(`${path.relative(ROOT, file)}: ${m[0].slice(0, 70)}`);
  }
}
if (missing.length) {
  console.error(`${missing.length} image(s) without alt text:\n${missing.join('\n')}`);
  process.exit(1);
}
console.log('every <img> has alt text');
