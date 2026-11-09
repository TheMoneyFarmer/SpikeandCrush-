'use strict';

// Every page names a favicon that exists, so a typo can't leave a tab with no icon.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

for (const dir of ['client', 'admin']) {
  test(`${dir}: every page links a favicon that exists`, () => {
    for (const page of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(ROOT, dir, page), 'utf8');
      const links = [...html.matchAll(/<link rel="icon" href="([^"]+)"/g)].map((m) => m[1]);
      assert.strictEqual(links.length, 2, `${page} should link an SVG and a PNG icon`);
      for (const href of links) assert.ok(fs.existsSync(path.join(ROOT, dir, href)), `${page}: ${href} is missing`);
    }
  });
}

test('the admin panel has its own icon, so its tabs stand apart from the player site', () => {
  const page = fs.readFileSync(path.join(ROOT, 'admin', 'login.html'), 'utf8');
  assert.match(page, /\/icons\/admin\.svg/);
});
