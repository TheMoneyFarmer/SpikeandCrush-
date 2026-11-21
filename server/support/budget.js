'use strict';

// Spend guard for the AI support chat. On top of the per-IP route limit:
//   - AI answers per account (or guest) per hour     SUPPORT_AI_PER_HOUR          default 30
//   - AI answers in one conversation                 SUPPORT_AI_PER_CONVERSATION  default 40
//   - tokens across all chats per UTC day            SUPPORT_DAILY_TOKEN_CAP      default 4,000,000
//                                                    (admin can change it in Support analytics)
//   - an off switch in admin
// Over any limit the message is still saved and goes to a human; no AI call is
// made, so it can never fail open. Today's token count is saved through
// `store` so a restart doesn't reset it, and alerts go out at 50, 80 and 100
// percent of the cap, once each per day.

const HOUR_MS = 60 * 60 * 1000;
const ALERT_LEVELS = [50, 80, 100];

function createSupportBudget({
  perHour = Number(process.env.SUPPORT_AI_PER_HOUR) || 30,
  perConversation = Number(process.env.SUPPORT_AI_PER_CONVERSATION) || 40,
  dailyTokenCap = Number(process.env.SUPPORT_DAILY_TOKEN_CAP) || 4000000,
  now = () => Date.now(),
  store = null, // { loadUsage, saveUsage, loadSettings, alert } (all async), optional
} = {}) {
  const calls = new Map(); // owner key -> [timestamps]
  const perConv = new Map(); // conversation id -> AI answers today
  const cfg = { enabled: true, dailyTokenCap };
  let day = null;
  let tokensToday = 0;
  let alerted = [];
  let saveTimer = null;

  const today = () => new Date(now()).toISOString().slice(0, 10);

  function rollDay() {
    const d = today();
    if (d !== day) {
      day = d;
      tokensToday = 0;
      alerted = [];
      perConv.clear();
    }
  }

  // Admin settings and the saved count; called at start and every 30 seconds.
  async function refresh() {
    if (!store) return;
    try {
      const s = await store.loadSettings();
      if (s && typeof s.enabled === 'boolean') cfg.enabled = s.enabled;
      if (s && Number(s.dailyTokenCap) > 0) cfg.dailyTokenCap = Number(s.dailyTokenCap);
    } catch (e) {
      // keep the last good settings
    }
    try {
      rollDay();
      const saved = await store.loadUsage();
      if (saved && saved.day === day) {
        tokensToday = Math.max(tokensToday, Number(saved.tokens) || 0);
        alerted = [...new Set([...alerted, ...(Array.isArray(saved.alerted) ? saved.alerted : [])])];
      }
    } catch (e) {
      // the in-memory count still applies
    }
  }

  function scheduleSave() {
    if (!store || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      Promise.resolve(store.saveUsage({ day, tokens: tokensToday, alerted })).catch(() => {});
    }, 1500);
    if (saveTimer.unref) saveTimer.unref();
  }

  // { ok: true } or { ok: false, reason: 'disabled' | 'daily_spend' | 'owner_hourly' | 'conversation_long' }
  function check(ownerKey, conversationId) {
    rollDay();
    if (!cfg.enabled) return { ok: false, reason: 'disabled' };
    if (tokensToday >= cfg.dailyTokenCap) return { ok: false, reason: 'daily_spend' };
    if (conversationId && (perConv.get(conversationId) || 0) >= perConversation) return { ok: false, reason: 'conversation_long' };
    const key = String(ownerKey || 'anonymous');
    const cutoff = now() - HOUR_MS;
    const list = (calls.get(key) || []).filter((t) => t > cutoff);
    calls.set(key, list);
    if (list.length >= perHour) return { ok: false, reason: 'owner_hourly' };
    return { ok: true };
  }

  function record(ownerKey, usage = {}, conversationId = null) {
    rollDay();
    const key = String(ownerKey || 'anonymous');
    const list = calls.get(key) || [];
    list.push(now());
    calls.set(key, list);
    if (conversationId) perConv.set(conversationId, (perConv.get(conversationId) || 0) + 1);
    tokensToday += (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0);
    if (calls.size > 50000) for (const [k, v] of calls) if (!v.length || v[v.length - 1] < now() - HOUR_MS) calls.delete(k);
    if (perConv.size > 50000) perConv.clear();
    const pct = (tokensToday / cfg.dailyTokenCap) * 100;
    for (const level of ALERT_LEVELS) {
      if (pct >= level && !alerted.includes(level)) {
        alerted.push(level);
        if (store && store.alert) Promise.resolve(store.alert(level, stats())).catch(() => {});
      }
    }
    scheduleSave();
  }

  function stats() {
    rollDay();
    return { day, tokensToday, dailyTokenCap: cfg.dailyTokenCap, enabled: cfg.enabled, perHour, perConversation, alerted: alerted.slice() };
  }

  return { check, record, refresh, stats };
}

// What the player sees when the AI won't answer. Never an error: a person takes over.
function limitMessage(reason) {
  if (reason === 'disabled' || reason === 'daily_spend') {
    return 'Support is busy right now. A person will reply here, or you can email hello@spikeandcrush.com.';
  }
  if (reason === 'conversation_long') return 'This chat has got long, so a person will take it from here.';
  return 'You have sent a lot of messages. A person will reply here.';
}

module.exports = { createSupportBudget, limitMessage, ALERT_LEVELS };
