'use strict';

// Draws the default share image (1200x630) and the larger app icons from the site's
// own colours. Needs playwright-core and Google Chrome.
//   node scripts/make-og.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CLIENT = path.join(__dirname, '..', 'client');
const NAVY = '#14213d', GREEN = '#1fd38a', RED = '#ff4d6a', WHITE = '#f2f5fa';

// A fixed seed, so re-running gives the same picture.
let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

function candles() {
  let out = '';
  let y = 470;
  for (let i = 0; i < 26; i++) {
    const up = rand() < 0.56;
    const body = 26 + rand() * 54;
    const x = 40 + i * 44;
    const top = up ? y - body : y;
    const color = up ? GREEN : RED;
    const opacity = 0.16 + (i / 26) * 0.34;
    out += `<rect x="${x + 11}" y="${top - 14}" width="3" height="${body + 28}" fill="${color}" opacity="${opacity}"/>`;
    out += `<rect x="${x}" y="${top}" width="25" height="${body}" rx="3" fill="${color}" opacity="${opacity}"/>`;
    y += up ? -body * 0.5 : body * 0.42;
    y = Math.max(90, Math.min(560, y));
  }
  return out;
}

const OG = `<!doctype html><html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${NAVY}"/>${candles()}
  <text x="80" y="290" font-family="Inter, Arial, sans-serif" font-weight="800" font-size="104"><tspan fill="${GREEN}">Spike</tspan><tspan fill="${WHITE}">&amp;</tspan><tspan fill="${RED}">Crush</tspan></text>
  <text x="84" y="356" font-family="Inter, Arial, sans-serif" font-size="42" fill="${WHITE}">The competitive trading game.</text>
  <text x="84" y="412" font-family="Inter, Arial, sans-serif" font-size="34" fill="${WHITE}" opacity=".76">Up. Then not.</text>
  <text x="84" y="566" font-family="Inter, Arial, sans-serif" font-weight="600" font-size="28" fill="${WHITE}" opacity=".76">spikeandcrush.com</text>
</svg></body></html>`;

const icon = (size) => `<!doctype html><html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="${NAVY}"/>
  <path d="M8 50 L21.5 15 L35 50 Z" fill="${GREEN}" stroke="${GREEN}" stroke-width="3" stroke-linejoin="round"/>
  <path d="M29 14 L42.5 49 L56 14 Z" fill="${RED}" stroke="${RED}" stroke-width="3" stroke-linejoin="round"/>
</svg></body></html>`;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(OG);
  await page.screenshot({ path: path.join(CLIENT, 'og-image.png') });
  for (const size of [192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(icon(size));
    fs.mkdirSync(path.join(CLIENT, 'icons'), { recursive: true });
    await page.screenshot({ path: path.join(CLIENT, 'icons', `icon-${size}.png`) });
  }
  await browser.close();
  console.log('og-image.png, icon-192.png and icon-512.png written');
})().catch((e) => { console.error(e.message); process.exit(1); });
