'use strict';

// Admin coin movements go through the same atomic coin_apply() SQL function as
// the game server (supabase/migrations/20261108100000_security_ledger.sql), so a
// double click or a retried request can never pay or refund twice, and the
// balance and ledger can't drift apart.
const { supabase } = require('./supabaseAdmin');

// Returns { ok, balance, duplicate } or { error }.
async function applyCoins(playerId, delta, type, idempotencyKey = null) {
  const { data, error } = await supabase.rpc('coin_apply', {
    p_player: playerId, p_delta: Math.round(delta), p_type: type, p_match: null, p_key: idempotencyKey,
  });
  if (error) {
    if (error.hint === 'duplicate' || /duplicate key/i.test(error.message || '')) return { ok: true, duplicate: true };
    throw error;
  }
  return data;
}

// Manual deduction: take up to the current balance (never below zero), as the
// panel always did.
async function deductUpTo(playerId, amount, type) {
  const first = await applyCoins(playerId, -amount, type);
  if (first?.error !== 'insufficient_coins') return { ...first, deducted: amount };
  const available = Math.max(0, Number(first.balance) || 0);
  if (available === 0) return { ok: true, balance: 0, deducted: 0 };
  const second = await applyCoins(playerId, -available, type);
  return { ...second, deducted: available };
}

module.exports = { applyCoins, deductUpTo };
