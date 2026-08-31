'use strict';

const COACH_TIER = 'War Lord';
const MIN_RATE_AED = 50;
const MAX_RATE_AED = 500;
const PLATFORM_FEE_PCT = 0.2;

const SESSION_TYPES = {
  trade_review: { label: '30-min Trade Review', durationMinutes: 30 },
  strategy_session: { label: '60-min Strategy Session', durationMinutes: 60 },
  live_coaching: { label: '90-min Live Match Coaching', durationMinutes: 90 },
};

function platformFee(priceAed) {
  return Math.round(priceAed * PLATFORM_FEE_PCT * 100) / 100;
}

function coachPayout(priceAed) {
  return Math.round((priceAed - platformFee(priceAed)) * 100) / 100;
}

function validRate(rateAed) {
  return Number.isFinite(rateAed) && rateAed >= MIN_RATE_AED && rateAed <= MAX_RATE_AED;
}

module.exports = {
  COACH_TIER,
  MIN_RATE_AED,
  MAX_RATE_AED,
  PLATFORM_FEE_PCT,
  SESSION_TYPES,
  platformFee,
  coachPayout,
  validRate,
};
