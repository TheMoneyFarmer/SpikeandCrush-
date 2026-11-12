'use strict';

// Spend guard for the AI support chat (security checklist item 8). On top of
// the per-IP route limit (20 messages per 15 minutes) this caps:
//   - AI answers per account (or guest) per hour     SUPPORT_AI_PER_HOUR      default 30
//   - tokens across all chats per UTC day            SUPPORT_DAILY_TOKEN_CAP  default 4,000,000
// Over a cap the message is still saved and goes to a human; no AI call is made.
// Counts live in memory (one game server); a restart clears them, which errs on
// the side of answering players.

const HOUR_MS = 60 * 60 * 1000;

function createSupportBudget({ perHour = Number(process.env.SUPPORT_AI_PER_HOUR) || 30, dailyTokenCap = Number(process.env.SUPPORT_DAILY_TOKEN_CAP) || 4000000, now = () => Date.now() } = {}) {
  const calls = new Map(); // owner key -> [timestamps]
  let day = null;
  let tokensToday = 0;

  function rollDay() {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      tokensToday = 0;
    }
  }

  // { ok: true } or { ok: false, reason: 'owner_hourly' | 'daily_spend' }
  function check(ownerKey) {
    rollDay();
    if (tokensToday >= dailyTokenCap) return { ok: false, reason: 'daily_spend' };
    const key = String(ownerKey || 'anonymous');
    const cutoff = now() - HOUR_MS;
    const list = (calls.get(key) || []).filter((t) => t > cutoff);
    calls.set(key, list);
    if (list.length >= perHour) return { ok: false, reason: 'owner_hourly' };
    return { ok: true };
  }

  function record(ownerKey, usage = {}) {
    rollDay();
    const key = String(ownerKey || 'anonymous');
    const list = calls.get(key) || [];
    list.push(now());
    calls.set(key, list);
    tokensToday += (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0);
    if (calls.size > 50000) for (const [k, v] of calls) if (!v.length || v[v.length - 1] < now() - HOUR_MS) calls.delete(k);
  }

  return { check, record, stats: () => ({ day, tokensToday, dailyTokenCap, perHour }) };
}

module.exports = { createSupportBudget };
