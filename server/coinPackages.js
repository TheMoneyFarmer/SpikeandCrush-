'use strict';

// The coin packages sold through Stripe Checkout. One definition, read by the
// purchase route in index.js and by the support assistant's knowledge base,
// so a price change here is what both the shop and support quote.
const COIN_PACKAGES = Object.freeze({
  100: Object.freeze({ coins: 100, priceUsd: 0.99 }),
  500: Object.freeze({ coins: 500, priceUsd: 3.99 }),
  1500: Object.freeze({ coins: 1500, priceUsd: 9.99 }),
  5000: Object.freeze({ coins: 5000, priceUsd: 24.99 }),
});

// Premium Battle Pass, billed monthly through a Stripe subscription.
const BATTLE_PASS_PRICE_USD = 4.99;

module.exports = { COIN_PACKAGES, BATTLE_PASS_PRICE_USD };
