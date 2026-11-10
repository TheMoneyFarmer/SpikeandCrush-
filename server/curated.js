'use strict';

// Read side of market curation (scripts/curate-data.js writes data/curated/).
// Loads the catalog and each instrument's closed-loop playlist on first use,
// answers which instruments are enabled for which mode, and picks a valid
// match start offset with a seed. No other module reads data/curated directly.

const fs = require('fs');
const path = require('path');
const gameFeel = require('./config/gameFeel');

let DIR = path.join(__dirname, '..', 'data', 'curated');
let catalog = null;
let catalogLoaded = false;
const playlists = new Map();

function load() {
  if (catalogLoaded) return catalog;
  catalogLoaded = true;
  try {
    catalog = JSON.parse(fs.readFileSync(path.join(DIR, 'catalog.json'), 'utf8'));
  } catch (e) {
    catalog = null;
    if (e.code !== 'ENOENT') console.warn('[curated] catalog unreadable:', e.message);
  }
  return catalog;
}

// Tests and the admin "rebuild" swap point at a different directory.
function setDir(dir) {
  DIR = dir;
  catalog = null;
  catalogLoaded = false;
  playlists.clear();
}

function getDir() {
  return DIR;
}

function isActive() {
  return Boolean(gameFeel.get().market.curatedPlaylists && load());
}

function getPlaylist(symbol) {
  if (playlists.has(symbol)) return playlists.get(symbol);
  const cat = load();
  const entry = cat && cat.instruments[symbol];
  let pl = null;
  if (entry) {
    try {
      pl = JSON.parse(fs.readFileSync(path.join(DIR, entry.file), 'utf8'));
    } catch (e) {
      console.warn(`[curated] ${symbol} playlist unreadable:`, e.message);
    }
  }
  playlists.set(symbol, pl);
  return pl;
}

// Is this instrument playable? With curation on, only instruments the data
// kept (catalog) are enabled, then the admin switch per instrument and per
// mode applies on top. With curation off everything stays as before.
function isEnabled(symbol, mode = null) {
  const m = gameFeel.get().market;
  if (m.enabledOverride && m.enabledOverride[symbol] === false) return false;
  if (mode && m.enabledPerMode && m.enabledPerMode[symbol] && m.enabledPerMode[symbol][mode] === false) return false;
  if (!isActive()) return true;
  if (m.enabledOverride && m.enabledOverride[symbol] === true && getPlaylist(symbol)) return true;
  return Boolean(load().instruments[symbol]);
}

function enabledSymbols(all, mode = null) {
  return all.filter((s) => isEnabled(s, mode));
}

// The smallest indexed mode length that covers this match.
function durationKey(pl, seconds) {
  const keys = Object.keys(pl.validStarts).map(Number).sort((a, b) => a - b);
  return keys.find((k) => k >= seconds) || null;
}

// A start offset (playlist minute) where the whole match plus its chart
// history passes the no-flat guarantee. rand() in [0,1).
function pickStart(symbol, seconds, rand) {
  const pl = getPlaylist(symbol);
  if (!pl) return null;
  const key = durationKey(pl, seconds);
  const list = key ? pl.validStarts[key] : null;
  if (!list || !list.length) return null;
  return list[Math.floor(rand() * list.length)];
}

function isValidStart(symbol, seconds, start) {
  const pl = getPlaylist(symbol);
  const key = pl && durationKey(pl, seconds);
  return Boolean(key && pl.validStarts[key].includes(start));
}

// Bars [from, from+count) of the loop, wrapping. Each bar is {open,high,low,close,index}.
function barsAt(symbol, from, count) {
  const pl = getPlaylist(symbol);
  const n = pl.bars.length;
  const out = new Array(count);
  for (let k = 0; k < count; k++) {
    const i = (((from + k) % n) + n) % n;
    const [open, high, low, close] = pl.bars[i];
    out[k] = { open, high, low, close, index: i };
  }
  return out;
}

// Spike events inside playlist minutes [from, from+count), as minute offsets
// from `from` (wraps around the loop).
function spikesBetween(symbol, from, count) {
  const pl = getPlaylist(symbol);
  if (!pl) return [];
  const n = pl.bars.length;
  const out = [];
  for (const s of pl.spikes) {
    const rel = (((s.i - from) % n) + n) % n;
    if (rel < count) out.push({ minute: rel, movePct: s.movePct, rangeBps: s.rangeBps });
  }
  return out.sort((a, b) => a.minute - b.minute);
}

module.exports = { load, setDir, getDir, isActive, getPlaylist, isEnabled, enabledSymbols, pickStart, isValidStart, barsAt, spikesBetween, durationKey };
