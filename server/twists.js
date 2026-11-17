'use strict';

// Weekly Twists (endgame Stage 4): rotating rules that only touch the fire
// layer (cards, Heat, spike alerts) of matches created while the twist runs.
// Each twist has a whitelisted parameter with bounds the server checks. A twist
// never touches GAME_RULES, lot sizes, leverage, margin or payout maths: it
// only changes the per-match `rules` snapshot (server/config/modeIdentity.js).

const LIBRARY = {
  double_heat: {
    name: 'Double Heat',
    line: 'Heat builds twice as fast on every qualifying win.',
    param: 'factor', default: 2, min: 1.25, max: 3,
    apply: (r, v) => { r.heat = { ...r.heat, basePerWin: Math.round(r.heat.basePerWin * v) }; },
  },
  no_shields: {
    name: 'No Shields',
    line: 'Shield cards are out this week, and the short shield after a hit is shorter.',
    param: 'hitShieldSeconds', default: 3, min: 0, max: 10,
    apply: (r, v) => { r.cards = { ...r.cards, noShields: true, hitShieldSeconds: v }; },
  },
  faster_spikes: {
    name: 'Faster Spikes',
    line: 'Spike alerts can come round more often.',
    param: 'gapFactor', default: 0.5, min: 0.25, max: 0.9,
    apply: (r, v) => { r.spikeAlerts = { ...r.spikeAlerts, minGapSeconds: Math.max(15, Math.round((r.spikeAlerts.minGapSeconds || 60) * v)) }; },
  },
  cooldown_halved: {
    name: 'Card Cooldown Halved',
    line: 'You can hit the same target again sooner.',
    param: 'factor', default: 0.5, min: 0, max: 0.9,
    apply: (r, v) => { r.cards = { ...r.cards, sameTargetCooldownSeconds: Math.round(r.cards.sameTargetCooldownSeconds * v * 10) / 10 }; },
  },
  sharp_targets: {
    name: 'Sharp Targets',
    line: 'Attack cards can only target the leader.',
    param: 'leaderOnly', default: 1, min: 1, max: 1,
    apply: (r) => { r.cards = { ...r.cards, leaderOnly: true }; },
  },
  streak_rush: {
    name: 'Streak Rush',
    line: 'Your hand refills at a shorter win streak.',
    param: 'refillAtStreak', default: 3, min: 2, max: 5,
    apply: (r, v) => { r.cards = { ...r.cards, refillAtStreak: Math.min(r.cards.refillAtStreak || 5, v) }; },
  },
};

// { key, params: { [param]: value } } -> { twist } or { error }. Rejects unknown
// twists, parameters that are not the twist's own, and out-of-bounds values.
function validateTwist(key, params = {}) {
  const t = LIBRARY[key];
  if (!t) return { error: `Unknown twist ${key}` };
  const extra = Object.keys(params).filter((k) => k !== t.param);
  if (extra.length) return { error: `${extra.join(', ')} is not a setting of ${t.name} (only ${t.param})` };
  const raw = params[t.param] === undefined ? t.default : Number(params[t.param]);
  if (!Number.isFinite(raw) || raw < t.min || raw > t.max) return { error: `${t.name}: ${t.param} must be between ${t.min} and ${t.max}` };
  return { twist: { key, params: { [t.param]: raw } } };
}

// Applies a twist to a copy of a match's rules. Ranked public matches only
// when the twist allows it; modes limited to the twist's list.
function applyToRules(rules, twist, { mode, ranked }) {
  if (twist && !twist.key && twist.twist_key) twist = { ...twist, key: twist.twist_key };
  if (!twist || !LIBRARY[twist.key]) return rules;
  if (Array.isArray(twist.modes) && twist.modes.length && !twist.modes.includes(mode)) return rules;
  if (ranked && !twist.include_ranked) return rules;
  const v = validateTwist(twist.key, twist.params || {});
  if (v.error) return rules;
  const t = LIBRARY[twist.key];
  const out = JSON.parse(JSON.stringify(rules));
  t.apply(out, v.twist.params[t.param]);
  out.twist = { key: twist.key, name: t.name, line: t.line };
  return out;
}

const publicTwist = (row) => { const twist = row && !row.key && row.twist_key ? { ...row, key: row.twist_key } : row; return twist && LIBRARY[twist.key] ? { key: twist.key, name: LIBRARY[twist.key].name, line: LIBRARY[twist.key].line, modes: twist.modes || [], ranked: Boolean(twist.include_ranked), endsAt: twist.ends_at } : null; };

module.exports = { LIBRARY, validateTwist, applyToRules, publicTwist };
