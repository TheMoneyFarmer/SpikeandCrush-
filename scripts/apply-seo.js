'use strict';

// Writes one set of head tags into every client page from server/seoConfig.js.
// Static tags rather than injecting per request, so pages keep being served and
// cached exactly as they are today. Safe to re-run: it removes any older copies first.
//   node scripts/apply-seo.js
const fs = require('fs');
const path = require('path');
const { SITE, THEME_COLOR, OG_IMAGE, OG_IMAGE_ALT, PAGES } = require('../server/seoConfig');

const CLIENT = path.join(__dirname, '..', 'client');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Organization', name: 'Spike & Crush', url: `${SITE}/`, logo: `${SITE}/icons/icon-512.png` },
    { '@type': 'WebSite', name: 'Spike & Crush', url: `${SITE}/` },
  ],
});

const OLD_TAGS = [
  /[ \t]*<!-- seo:start -->[\s\S]*?<!-- seo:end -->\n?/g,
  /[ \t]*<title>[\s\S]*?<\/title>\n?/g,
  /[ \t]*<meta\s+name="(description|robots|theme-color|twitter:[a-z:]+)"[^>]*>\n?/g,
  /[ \t]*<meta\s+property="og:[a-z:]+"[^>]*>\n?/g,
  /[ \t]*<link\s+rel="canonical"[^>]*>\n?/g,
  /[ \t]*<link\s+rel="manifest"[^>]*>\n?/g,
  /[ \t]*<script type="application\/ld\+json">[\s\S]*?<\/script>\n?/g,
];

function block(page) {
  const url = `${SITE}${page.path}`;
  const lines = [
    '<!-- seo:start -->',
    `<title>${esc(page.title)}</title>`,
    `<meta name="description" content="${esc(page.description)}" />`,
    page.index ? null : '<meta name="robots" content="noindex, nofollow" />',
    `<link rel="canonical" href="${url}" />`,
    `<meta name="theme-color" content="${THEME_COLOR}" />`,
    '<link rel="manifest" href="/site.webmanifest" />',
    '<meta property="og:site_name" content="Spike &amp; Crush" />',
    `<meta property="og:title" content="${esc(page.title)}" />`,
    `<meta property="og:description" content="${esc(page.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:image" content="${OG_IMAGE}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    `<meta property="og:image:alt" content="${esc(OG_IMAGE_ALT)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    page.path === '/' ? `<script type="application/ld+json">${JSON_LD}</script>` : null,
    '<!-- seo:end -->',
  ];
  return `${lines.filter(Boolean).join('\n')}\n`;
}

let done = 0;
for (const [file, page] of Object.entries(PAGES)) {
  const full = path.join(CLIENT, file);
  if (!fs.existsSync(full)) { console.log(`skip (no file yet): ${file}`); continue; }
  let html = fs.readFileSync(full, 'utf8');
  for (const re of OLD_TAGS) html = html.replace(re, '');
  if (!/<head[^>]*>\n?/.test(html)) throw new Error(`no <head> in ${file}`);
  html = html.replace(/(<head[^>]*>\n?)/, (m) => `${m.endsWith('\n') ? m : `${m}\n`}${block(page)}`);
  // A viewport and charset must stay first in the head on every page.
  const metas = html.match(/[ \t]*<meta\s+(charset="[^"]*"|name="viewport"[^>]*)[^>]*>\n?/g) || [];
  for (const m of metas) html = html.replace(m, '');
  html = html.replace(/(<head[^>]*>\n)/, (m) => `${m}${metas.map((x) => `${x.trim()}\n`).join('')}`);
  fs.writeFileSync(full, html);
  done++;
}
const missing = fs.readdirSync(CLIENT).filter((f) => f.endsWith('.html') && !PAGES[f]);
if (missing.length) throw new Error(`pages not in seoConfig: ${missing.join(', ')}`);
console.log(`head tags written to ${done} pages`);
