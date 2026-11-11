'use strict';

// Generated logo marks for invented (Preview) partner listings: a geometric
// mark plus initials in the site palette. No outside images and no look-alike
// of any real brand. Every file carries the generator marker so a test can
// prove each seeded logo came from here.

const MARKER = 'sc-logo-generator v1';
const ACCENTS = ['#1fd38a', '#f5b83d', '#6cb2ff', '#ff4d6a', '#9085e9', '#2ee6a6', '#e0581c', '#d55181'];

function hash(str) {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function initials(name) {
  const words = String(name).replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

function shape(kind, accent) {
  switch (kind) {
    case 0: return `<circle cx="32" cy="32" r="20" fill="none" stroke="${accent}" stroke-width="6"/>`;
    case 1: return `<path d="M32 10 L54 52 H10 Z" fill="none" stroke="${accent}" stroke-width="6" stroke-linejoin="round"/>`;
    case 2: return `<rect x="13" y="13" width="38" height="38" rx="9" fill="none" stroke="${accent}" stroke-width="6" transform="rotate(45 32 32)"/>`;
    case 3: return `<path d="M12 44 L24 30 L34 38 L52 18" fill="none" stroke="${accent}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 4: return `<path d="M14 20 h36 M14 32 h28 M14 44 h20" stroke="${accent}" stroke-width="6" stroke-linecap="round"/>`;
    default: return `<path d="M32 12 a20 20 0 1 0 20 20 h-20 z" fill="${accent}"/>`;
  }
}

// variant: 'dark' (light text, for the navy site) or 'light' (dark text)
function logoSvg(name, variant = 'dark') {
  const h = hash(name);
  const accent = ACCENTS[h % ACCENTS.length];
  const kind = (h >>> 4) % 6;
  const ink = variant === 'dark' ? '#f2f5fa' : '#14213d';
  const tile = variant === 'dark' ? '#1d2d50' : '#eef2f9';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="${String(name).replace(/[<>&"]/g, '')}"><!-- ${MARKER} --><rect width="64" height="64" rx="14" fill="${tile}"/><g opacity="0.9">${shape(kind, accent)}</g><text x="32" y="38" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="17" font-weight="700" fill="${ink}">${initials(name)}</text></svg>`;
}

module.exports = { logoSvg, MARKER, initials };
