'use strict';

window.TW = window.TW || {};

// Drag mode for stop loss / take profit (the third choice beside Pips and
// Price, on the match screen and the competition screen). Turning it on puts
// two lines on the chart for the NEXT trade - TP above the price, SL just
// below it - that can be dragged (mouse, or long-press on a phone) and stay
// on every timeframe. The SL/TP boxes show the dragged prices and can also be
// typed into. At Buy/Sell the levels are used as they are when they fit that
// direction, or mirrored around the price when they don't (lines set up for a
// BUY, then Sell pressed). Chart side: TW.Chart.setDraftLevels (js/chart.js).
TW.SltpDrag = function create({ slInput, tpInput, getSymbol, getLots, getSpread = () => 0, onLevels = () => {} }) {
  let on = false;
  const decimals = (symbol) => {
    const pip = TW.Chart.pipSize(symbol);
    return pip >= 1 ? 0 : Math.max(2, Math.ceil(-Math.log10(pip)) + 1);
  };
  const fmt = (symbol, v) => Number(v.toFixed(decimals(symbol)));

  function fill(levels) {
    if (!levels) return;
    slInput.value = fmt(levels.symbol, levels.stopLoss);
    tpInput.value = fmt(levels.symbol, levels.takeProfit);
    onLevels(levels);
  }

  // Lines for the current instrument (waits for a price if there is none yet).
  function place() {
    if (!on) return false;
    const levels = TW.Chart.defaultDraft(getSymbol(), getLots(), getSpread(getSymbol()));
    if (!levels) return false;
    TW.Chart.setDraftLevels(levels);
    fill(levels);
    return true;
  }

  TW.Chart.onDraftChange((levels) => {
    if (on) fill(levels);
  });

  // Typing a price moves its line.
  const typed = () => {
    if (!on) return;
    const d = TW.Chart.getDraftLevels();
    if (!d) return;
    const sl = Number(slInput.value);
    const tp = Number(tpInput.value);
    if (sl > 0) d.stopLoss = sl;
    if (tp > 0) d.takeProfit = tp;
    TW.Chart.setDraftLevels(d);
    onLevels(d);
  };
  slInput.addEventListener('change', typed);
  tpInput.addEventListener('change', typed);

  return {
    isOn: () => on,
    enable() {
      on = true;
      if (!place()) setTimeout(place, 1200);
      if (TW.toast) TW.toast(window.matchMedia('(pointer: coarse)').matches ? 'Long-press the TP or SL line on the chart, then drag it' : 'Drag the TP and SL lines on the chart', 'info');
    },
    disable() {
      on = false;
      TW.Chart.setDraftLevels(null);
    },
    // New instrument, or after a trade: fresh lines around the new price.
    reset() {
      if (on) place();
    },
    // Called on price updates: places the lines once a first price arrives.
    tick() {
      if (on && !TW.Chart.getDraftLevels()) place();
    },
    // { stopLoss, takeProfit, mirrored } for this direction, or null.
    levelsFor(direction) {
      const d = TW.Chart.getDraftLevels();
      const cur = TW.Chart.currentPrice(getSymbol());
      if (!on || !d || cur === null || d.symbol !== getSymbol()) return null;
      const fitsBuy = d.takeProfit > cur && d.stopLoss < cur;
      const wanted = direction === 'BUY' ? fitsBuy : !fitsBuy;
      if (wanted) return { stopLoss: fmt(d.symbol, d.stopLoss), takeProfit: fmt(d.symbol, d.takeProfit), mirrored: false };
      return { stopLoss: fmt(d.symbol, 2 * cur - d.stopLoss), takeProfit: fmt(d.symbol, 2 * cur - d.takeProfit), mirrored: true };
    },
  };
};
