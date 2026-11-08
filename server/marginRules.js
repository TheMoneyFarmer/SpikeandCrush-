'use strict';

// The trading rules for size and risk: there is no lot limit. What a player can
// open is decided by leverage and free margin, and what happens when a trade
// goes wrong by the margin call and stop-out levels.
//
//   margin for a position = notional value in USD / LEVERAGE
//   margin level          = equity / margin in use * 100
//   free margin           = equity - margin in use
//
// At or below MARGIN_CALL_LEVEL there is no free margin, so no new trades, and
// the player is warned. At or below STOP_OUT_LEVEL the biggest losing position
// is closed, then the next, until the level recovers. Used by live matches
// (gameEngine.js) and long-form competitions (compEngine.js).

const instruments = require('./instruments');

const LEVERAGE = 100;
const MARGIN_CALL_LEVEL = 100; // percent
const STOP_OUT_LEVEL = 50; // percent

function notionalUsd(symbol, lots, price) {
  const cfg = instruments.getInstrument(symbol);
  // USD/JPY etc: one lot is 100,000 US dollars whatever the exchange rate is.
  if (instruments.isUsdBase(symbol)) return lots * cfg.contractSize;
  return lots * cfg.contractSize * price;
}

function positionMargin(symbol, lots, price) {
  return notionalUsd(symbol, lots, price) / LEVERAGE;
}

// positions: [{ symbol, lots }], priceOf(position) -> mid price
function usedMargin(positions, priceOf) {
  return positions.reduce((sum, p) => sum + positionMargin(p.symbol, Number(p.lots), priceOf(p)), 0);
}

// null when nothing is open (a margin level has no meaning then).
function marginLevel(equity, used) {
  return used > 0 ? (equity / used) * 100 : null;
}

// The biggest size that fits in the free margin, rounded down to 0.01 lots.
function maxAffordableLots(symbol, price, freeMargin) {
  const perLot = positionMargin(symbol, 1, price);
  if (!(perLot > 0) || freeMargin <= 0) return 0;
  return Math.floor((freeMargin / perLot) * 100) / 100;
}

const mid = (quote) => (Number(quote.bid) + Number(quote.ask)) / 2;

const MARGIN_RULES = Object.freeze({ leverage: LEVERAGE, marginCallLevel: MARGIN_CALL_LEVEL, stopOutLevel: STOP_OUT_LEVEL });

module.exports = { LEVERAGE, MARGIN_CALL_LEVEL, STOP_OUT_LEVEL, MARGIN_RULES, notionalUsd, positionMargin, usedMargin, marginLevel, maxAffordableLots, mid };
