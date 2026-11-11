'use strict';

// Competition states, the two prize worlds, and the wording rules for
// competition cards. Pure functions: used by the server (API + enter guard),
// the admin panel (validation) and the tests.
//
// Two prize worlds, never mixed:
//   - Game modes pay coins only. Coins have no cash value; no currency
//     symbol ever sits next to a coin figure.
//   - Money competitions pay a cash prize, paid by the named competition
//     partner (stated in the terms and detail page, never on the card).
//     Entry is always free: no coins, no money, nothing purchasable.
//   - Partner competitions are hosted on the partner's site; their prize
//     text is shown exactly as the partner supplied it.

const STATES = ['coming_soon', 'open', 'running', 'paused', 'closed'];
const ENTERABLE_STATES = ['open', 'running'];
const DATA_SOURCES = ['replay', 'live'];
const PRIZE_KINDS = ['coins', 'money', 'partner'];

// Shown on every money competition card, one line each.
const MONEY_RULE_LINES = ['Verified profile required', 'One account per player', 'No AI, bots or EAs'];

// Never on a card, strip or email.
const FORBIDDEN_CARD_PHRASES = [/guaranteed/i, /funded by/i, /provided by/i, /win money/i, /win cash/i];

const COMPETITIONS_PAGE_LINE = 'Competition prizes are paid in money by the competition partner. Coins won in game modes have no cash value.';

function formatMoney(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(amount) || 0);
  } catch (e) {
    return `${currency} ${Math.round(Number(amount) || 0).toLocaleString('en-US')}`;
  }
}

function formatCoins(n) {
  return `${Math.round(Number(n) || 0).toLocaleString('en-US')} coins`;
}

// The prize block on a card. A money figure appears only when a super_admin
// has confirmed the pool with a named partner; otherwise "Cash prizes".
function prizeWording(row) {
  const kind = row.prize_kind || 'coins';
  if (kind === 'partner') {
    return { kind, label: row.prize_text ? String(row.prize_text) : 'Prizes set by the partner', top: null, badge: 'Free entry' };
  }
  if (kind === 'money') {
    const pool = Number(row.prize_pool_amount ?? row.prize_pool) || 0;
    const top = Number(row.prize_top_amount) || 0;
    const currency = row.prize_currency || 'USD';
    if (row.prize_pool_confirmed && pool > 0) {
      return {
        kind,
        label: `${formatMoney(pool, currency)} prize pool`,
        top: top > pool ? `Up to ${formatMoney(top, currency)} on featured days` : null,
        badge: 'Free entry',
      };
    }
    return { kind, label: 'Cash prizes', top: null, badge: 'Free entry' };
  }
  const coins = Number(row.prize_pool_coins) || 0;
  return { kind: 'coins', label: coins > 0 ? `${formatCoins(coins)} to win` : 'Coin prizes', top: null, badge: Number(row.entry_fee_coins) > 0 ? null : 'Free entry' };
}

// Server-side guard for the money/coins separation. Throws with a clear message.
function assertSeparation(row) {
  const kind = row.prize_kind || 'coins';
  if (!PRIZE_KINDS.includes(kind)) throw new Error(`Unknown prize kind "${kind}"`);
  if (kind !== 'coins') {
    if (Number(row.entry_fee_coins) > 0) throw new Error('A money competition is always free to enter: it cannot have a coin entry fee.');
    if (Number(row.prize_pool_coins) > 0) throw new Error('A money competition cannot pay coins.');
  } else if (Number(row.prize_pool) > 0 || Number(row.prize_top_amount) > 0 || Number(row.prize_pool_amount) > 0) {
    throw new Error('A coin event cannot carry a money prize.');
  }
  return true;
}

// Game modes never carry a money prize or currency.
function assertGameModesCoinsOnly(matchModes) {
  for (const [mode, cfg] of Object.entries(matchModes || {})) {
    for (const key of Object.keys(cfg || {})) {
      if (/currency|cash|money|usd|prize_pool(?!_coins)|prizeMoney/i.test(key)) {
        throw new Error(`Game mode "${mode}" has a money field "${key}": game modes pay coins only.`);
      }
    }
  }
  return true;
}

// Whether a player can enter. `liveOk` = liveFeed.ready && liveFeed.healthy().
function enterGate(row, { liveOk = false } = {}) {
  const state = row.state || 'open';
  if (!ENTERABLE_STATES.includes(state)) {
    return { ok: false, reason: state === 'coming_soon' ? 'This competition is coming soon. Tap Notify me to hear when it opens.' : 'This competition is not open for entry.' };
  }
  if ((row.data_source || 'replay') === 'live' && !liveOk) {
    return { ok: false, reason: 'This competition needs live market data, which is not switched on yet.' };
  }
  if ((row.prize_kind || 'coins') !== 'coins' && Number(row.entry_fee_coins) > 0) {
    return { ok: false, reason: 'A money competition is always free to enter.' };
  }
  return { ok: true };
}

// Whether a template or instance may be set to a given state.
function stateChangeGate(row, nextState, { liveOk = false } = {}) {
  if (!STATES.includes(nextState)) return { ok: false, reason: `Unknown state "${nextState}"` };
  if ((nextState === 'open' || nextState === 'running') && (row.data_source || 'replay') === 'live' && !liveOk) {
    return { ok: false, reason: 'This competition uses live market data. It can open only after the live feed is ready (liveFeed.ready) and healthy.' };
  }
  return { ok: true };
}

function cardTextViolations(text) {
  return FORBIDDEN_CARD_PHRASES.filter((re) => re.test(String(text || ''))).map((re) => re.source);
}

module.exports = {
  STATES,
  ENTERABLE_STATES,
  DATA_SOURCES,
  PRIZE_KINDS,
  MONEY_RULE_LINES,
  FORBIDDEN_CARD_PHRASES,
  COMPETITIONS_PAGE_LINE,
  formatMoney,
  formatCoins,
  prizeWording,
  assertSeparation,
  assertGameModesCoinsOnly,
  enterGate,
  stateChangeGate,
  cardTextViolations,
};
