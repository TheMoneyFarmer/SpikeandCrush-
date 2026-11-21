'use strict';

// How each market sizes an order, from the server (server/instruments.js
// clientSpecs, sent as match:state.instrumentSpecs and competition
// instrumentInfo). Forex and CFDs trade in lots (0.01 steps), stocks in whole
// shares, futures in whole contracts with the real exchange multiplier.
// Screens read sizes, P&L multipliers and labels from here, never from a list
// of their own.
window.TW = window.TW || {};

(function () {
  const specs = {};
  const listeners = [];
  const WORDS = { lot: ['lot', 'lots'], share: ['share', 'shares'], contract: ['contract', 'contracts'] };
  const CHIPS = { lot: [0.1, 0.5, 1, 2, 5], share: [1, 10, 25, 50, 100], contract: [1, 2, 5, 10, 20] };
  const DEFAULT_SIZE = { lot: 1, share: 10, contract: 1 };
  // Stop/target distances: pips in forex and CFDs, ticks in futures, cents in stocks.
  const DIST = { lot: { word: 'Pips', short: 'p' }, share: { word: 'Cents', short: '¢' }, contract: { word: 'Ticks', short: 't' } };

  const get = (sym) => specs[sym] || null;
  const unit = (sym) => (get(sym) && get(sym).unit) || 'lot';

  TW.Units = {
    set(map) {
      if (!map) return;
      let changed = false;
      for (const [sym, s] of Object.entries(map)) {
        if (!s || !(s.contractSize > 0)) continue;
        specs[sym] = s;
        changed = true;
      }
      if (changed) listeners.forEach((fn) => { try { fn(specs); } catch (e) { console.warn('[units]', e); } });
    },
    // fn(specs) runs now (if any are known) and on every update.
    onSet(fn) {
      listeners.push(fn);
      if (Object.keys(specs).length) fn(specs);
    },
    get,
    unit,
    whole: (sym) => unit(sym) !== 'lot',
    word: (sym, n) => (WORDS[unit(sym)] || WORDS.lot)[Number(n) === 1 ? 0 : 1],
    // "1 contract", "25 shares", "0.5 lots"
    size: (sym, n) => `${n} ${(WORDS[unit(sym)] || WORDS.lot)[Number(n) === 1 ? 0 : 1]}`,
    label: (sym) => ({ lot: 'Lot size', share: 'Shares', contract: 'Contracts' })[unit(sym)],
    chips: (sym) => CHIPS[unit(sym)],
    defaultSize: (sym) => DEFAULT_SIZE[unit(sym)],
    step: (sym) => (get(sym) && get(sym).step) || 0.01,
    min: (sym) => (get(sym) && get(sym).min) || 0.01,
    // A size this market accepts, or null.
    valid(sym, n) {
      const v = Number(n);
      if (!(v >= TW.Units.min(sym))) return false;
      return TW.Units.whole(sym) ? Math.abs(v - Math.round(v)) < 1e-9 : true;
    },
    dist: (sym) => DIST[unit(sym)],
  };
})();
