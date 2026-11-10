'use strict';

// The card deck: 30 attack cards + 2 defensive cards.
//
// `kind`: 'attack' (targets one player), 'market' (hits every player except the
// caster and anyone shielded), 'defense' (plays on yourself, no target).
// Every attack and market card changes real, server-enforced trading state -
// the 11 old "threat-only" cards that only drew something on the target's
// screen were replaced in the fire-gameplay rework (old -> new id in
// REPLACED_THREAT_ONLY below, kept for the support knowledge base and tests).
// `requiresSymbol` cards act on one instrument (random if none given).
// `duration: 0` cards are instant. `rarity` weights random fills
// (server/config/gameFeel.js cards.rarityWeights). `icon` is an SVG icon key
// drawn by client/js/card-icons.js - never an emoji.
//
// Amounts (steal sizes, shares, fill penalties) live in CARD_AMOUNTS so admin
// can tune them; nothing touches P&L, equity or margin maths directly except
// through the same balance/position operations the original cards used.

const gameFeel = require('./config/gameFeel');

const CARD_AMOUNTS = {
  capitalDrain: 200,
  pipTheft: 150,
  profitTaxShare: 0.25,
  profitTaxCap: 300,
  profitSkimShare: 0.15,
  profitSkimCap: 250,
  slippageFills: 2,
  slippageSpreads: 2, // each penalised fill is this many spreads worse
  spreadBlowoutMultiplier: 3,
  marginSqueezeShare: 0.5,
  stopYankShare: 0.5, // stop moves this share of the way toward the price
  stopYankNewSpreads: 5, // no stop yet: one is placed this many spreads away
  cooldownJamSeconds: 8,
  shieldSeconds: 20,
  cleanseShieldSeconds: 5,
};

const C = (id, name, category, kind, rarity, icon, duration, description, extra = {}) => ({
  id,
  name,
  category,
  kind,
  rarity,
  icon,
  duration,
  description,
  targeted: kind === 'attack',
  ...extra,
});

const CARDS = {
  // ---- replacements for the 11 threat-only cards (same slots, real damage) ----
  profit_tax: C('profit_tax', 'Profit Tax', 'opponent', 'attack', 'epic', 'percent', 20,
    "The target's next winning close within 20s pays 25% of its profit to you (max 300)."),
  spread_blowout: C('spread_blowout', 'Spread Blowout', 'opponent', 'attack', 'rare', 'spread', 20,
    "Triples the target's spread on every instrument for 20s."),
  slippage_storm: C('slippage_storm', 'Slippage Storm', 'opponent', 'attack', 'rare', 'slip', 30,
    "The target's next 2 fills (open or close) within 30s fill 2 spreads worse."),
  margin_squeeze: C('margin_squeeze', 'Margin Squeeze', 'opponent', 'attack', 'common', 'squeeze', 30,
    'For 30s the target can open at most half the size their free margin allows.'),
  stop_yank: C('stop_yank', 'Stop-Loss Yank', 'opponent', 'attack', 'epic', 'yank', 0,
    "Moves the stop loss on the target's largest position halfway to the price (or places a tight one)."),
  tp_snip: C('tp_snip', 'TP Snip', 'opponent', 'attack', 'common', 'scissors', 0,
    "Removes the take profit from every one of the target's open positions."),
  order_freeze: C('order_freeze', 'Order Freeze', 'opponent', 'attack', 'common', 'snow', 15,
    'The target cannot add or move a stop loss or take profit for 15s.'),
  trade_limit: C('trade_limit', 'Trade Limit', 'opponent', 'attack', 'common', 'one', 20,
    'For 20s the target cannot open a new trade while they hold one.'),
  one_way: C('one_way', 'One Way', 'opponent', 'attack', 'rare', 'arrow', 15,
    'For 15s the target can only open trades in one direction (chosen at random).'),
  cooldown_jam: C('cooldown_jam', 'Cooldown Jam', 'opponent', 'attack', 'common', 'hourglass', 30,
    'For 30s the target must wait 8s between opening trades.'),
  profit_skim: C('profit_skim', 'Profit Skim', 'opponent', 'attack', 'legendary', 'skim', 0,
    "Takes 15% of the target's banked profit into yours (max 250)."),

  // ---- the original damaging cards, unchanged ----
  spread_spike: C('spread_spike', 'Spread Spike', 'market', 'market', 'common', 'bolt', 20,
    'Triple the spread on one instrument for 20s.', { requiresSymbol: true }),
  volatility_surge: C('volatility_surge', 'Volatility Surge', 'market', 'market', 'rare', 'wave', 25,
    'Double price movement speed for 25s.'),
  liquidity_drain: C('liquidity_drain', 'Liquidity Drain', 'market', 'market', 'common', 'drain', 30,
    'Cap max lot size at 0.1 for all players for 30s.'),
  reversal_flash: C('reversal_flash', 'Reversal Flash', 'market', 'market', 'rare', 'reverse', 8,
    'Force a sharp 10 pip reversal, then snap back, over 8s.', { requiresSymbol: true }),
  position_freeze: C('position_freeze', 'Position Freeze', 'opponent', 'attack', 'common', 'freeze', 15,
    'Target cannot open new trades for 15s.'),
  force_close: C('force_close', 'Force Close', 'opponent', 'attack', 'epic', 'lock', 0,
    "Force close the target's best-performing position at market."),
  capital_drain: C('capital_drain', 'Capital Drain', 'opponent', 'attack', 'epic', 'wallet', 0,
    "Deduct 200 from the target's capital."),
  mirror_trade: C('mirror_trade', 'Mirror Trade', 'opponent', 'attack', 'rare', 'mirror', 0,
    "Copy your current position onto the target's account."),
  double_spread: C('double_spread', 'Double Spread', 'market', 'market', 'common', 'spread2', 15,
    'Double the spread on every instrument for everyone except you, for 15s.'),
  time_warp: C('time_warp', 'Time Warp', 'market', 'market', 'rare', 'clock', 10,
    'Delay the price feed by 3 seconds for everyone except you, for 10s.'),
  fog_of_war: C('fog_of_war', 'Fog of War', 'market', 'market', 'rare', 'fog', 10,
    'Throw price jitter into the feed for everyone except you, for 10s.'),
  panic_wave: C('panic_wave', 'Panic Wave', 'market', 'market', 'epic', 'panic', 8,
    'Force a brief synchronized reversal across every instrument, then snap back, over 8s.'),
  dead_calm: C('dead_calm', 'Dead Calm', 'market', 'market', 'rare', 'pause', 6,
    'Freeze price movement on every instrument for everyone except you, for 6s.'),
  lockout: C('lockout', 'Lockout', 'opponent', 'attack', 'common', 'padlock', 10,
    'Target cannot close any position for 10s.'),
  margin_call: C('margin_call', 'Margin Call', 'opponent', 'attack', 'legendary', 'warn', 0,
    "Force-close every one of the target's open positions at market."),
  lot_limiter: C('lot_limiter', 'Lot Limiter', 'opponent', 'attack', 'common', 'ruler', 15,
    "Cap the target's max lot size at 0.05 for 15s."),
  pip_theft: C('pip_theft', 'Pip Theft', 'opponent', 'attack', 'legendary', 'thief', 0,
    "Steal 150 from the target's capital straight into yours."),
  ghost_trade: C('ghost_trade', 'Ghost Trade', 'opponent', 'attack', 'rare', 'ghost', 0,
    "Force a small losing position onto the target's account."),
  stop_snipe: C('stop_snipe', 'Stop Snipe', 'opponent', 'attack', 'rare', 'target', 0,
    "Drag the target's best position's stop-loss to break-even, wiping their cushion."),

  // ---- defensive (self) ----
  shield: C('shield', 'Shield', 'defense', 'defense', 'common', 'shield', 20,
    'For 20s attack cards cannot target you and market cards do not affect you.'),
  cleanse: C('cleanse', 'Cleanse', 'defense', 'defense', 'rare', 'cleanse', 0,
    'Removes every card effect on you and shields you for 5s.'),
};

// Old threat-only card -> its replacement (same slot in the deck).
const REPLACED_THREAT_ONLY = {
  news_bomb: 'profit_tax',
  chart_ghost: 'spread_blowout',
  false_signal: 'slippage_storm',
  smoke_screen: 'margin_squeeze',
  margin_scare: 'stop_yank',
  phantom_candle: 'tp_snip',
  blackout: 'order_freeze',
  static_burst: 'trade_limit',
  decoy_order: 'one_way',
  mirage: 'cooldown_jam',
  intel_leak: 'profit_skim',
};

// Timed effects that sit on one target. At most one is active per target
// (gameFeel cards: damage guards) and all expire on their own timestamps.
const TIMED_TARGET_EFFECTS = [
  'position_freeze', 'lockout', 'lot_limiter', 'spread_blowout', 'slippage_storm', 'margin_squeeze',
  'order_freeze', 'trade_limit', 'one_way', 'cooldown_jam', 'profit_tax',
];

function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A saved deck comes first: if it holds more cards than the mode deals, they're
// picked from it at random, and any slots it can't fill are random cards.
// `allowed` (the player's unlocked cards) limits both - a locked card can
// never be dealt.
function dealCards(count = 3, deck = [], allowed = null) {
  const all = Object.keys(CARDS).filter((t) => !allowed || allowed.includes(t));
  const saved = shuffle([...new Set(Array.isArray(deck) ? deck : [])].filter((type) => all.includes(type)));
  const rest = shuffle(all.filter((type) => !saved.includes(type)));
  return [...saved, ...rest].slice(0, count).map((type) => ({ type, used: false }));
}

// One random card weighted by rarity from `pool` (card ids).
function drawWeighted(pool, rand = Math.random) {
  const weights = gameFeel.get().cards.rarityWeights;
  const items = pool.filter((t) => CARDS[t]).map((t) => [t, Number(weights[CARDS[t].rarity]) || 1]);
  const total = items.reduce((s, [, w]) => s + w, 0);
  if (!total) return null;
  let r = rand() * total;
  for (const [t, w] of items) {
    r -= w;
    if (r < 0) return t;
  }
  return items[items.length - 1][0];
}

function getCardCatalog() {
  return Object.values(CARDS).map(({ id, name, category, kind, rarity, icon, description, duration, targeted, requiresSymbol }) => ({
    id,
    name,
    category,
    kind,
    rarity,
    icon,
    description,
    duration,
    targeted,
    requiresSymbol: Boolean(requiresSymbol),
  }));
}

const active = (eff, now) => Boolean(eff && now < eff.until);

function isShielded(player, now) {
  return Boolean(player && player.effects && (active(player.effects.shield, now) || active(player.effects.hitShield, now)));
}

// Card-shield only (the Shield card), which also exempts from market cards.
function hasShieldCard(player, now) {
  return Boolean(player && player.effects && active(player.effects.shield, now));
}

function activeTargetEffect(player, now) {
  if (!player || !player.effects) return null;
  return TIMED_TARGET_EFFECTS.find((k) => active(player.effects[k], now)) || null;
}

/**
 * Applies a card. Mutates `match` in place for effects this module owns (card
 * state, player effect flags, match-wide market effects, balance moves).
 * Effects that need live pricing (force_close, mirror_trade, ghost_trade,
 * stop_snipe, stop_yank, tp_snip) are returned as descriptors for
 * gameEngine.js to execute against the authoritative price feed.
 *
 * ctx (from gameEngine): { targetId, symbol, targetEquity, rand } -
 * targetEquity lets the damage floor cap money cards; rand is the match's
 * seeded generator so a replay of the match log reproduces every amount.
 */
function playCard(match, casterId, cardType, ctx = {}, now = Date.now()) {
  const caster = match.players[casterId];
  if (!caster) return { success: false, error: 'Caster not in match' };

  const cardDef = CARDS[cardType];
  if (!cardDef) return { success: false, error: 'Unknown card' };

  const handCard = caster.cards.find((c) => c.type === cardType && !c.used);
  if (!handCard) return { success: false, error: caster.cards.some((c) => c.type === cardType) ? 'Card already played' : 'Card not in hand' };

  const rand = ctx.rand || Math.random;
  const cfg = gameFeel.get().cards;
  const startCapital = Number(ctx.startingCapital) || 10000;
  const floor = startCapital * (Number(cfg.floorPctOfCapital) || 0.5);
  // Money a card may take from the target without pushing their equity under
  // the floor in this one hit.
  const roomAboveFloor = Math.max(0, Math.floor((Number(ctx.targetEquity ?? Infinity) - floor) * 100) / 100);

  let target = null;
  if (cardDef.targeted) {
    target = match.players[ctx.targetId];
    if (!target) return { success: false, error: 'Choose a target player' };
    if (target.id === caster.id) return { success: false, error: 'Cannot target yourself' };
  }

  const matchInstruments = match.instruments || [];
  const effectSymbol = cardDef.requiresSymbol
    ? matchInstruments.includes(ctx.symbol)
      ? ctx.symbol
      : matchInstruments[Math.floor(rand() * matchInstruments.length)]
    : null;

  const result = {
    success: true,
    cardType,
    card: cardDef,
    casterId: caster.id,
    targetId: target ? target.id : null,
    symbol: effectSymbol,
    notify: [],
    feedText: '',
    amounts: {},
  };
  const until = now + cardDef.duration * 1000;
  const hit = (key, extra = {}) => {
    target.effects[key] = { until, by: caster.id, ...extra };
    result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration, ...extra } });
  };
  const ensureSymbolEffects = (s) => {
    if (!match.marketEffects[s]) match.marketEffects[s] = { spreadMultiplier: 1, spreadUntil: 0, reversal: null };
  };

  switch (cardType) {
    // ---- replacements -------------------------------------------------------
    case 'profit_tax':
      hit('profit_tax', { share: CARD_AMOUNTS.profitTaxShare, cap: CARD_AMOUNTS.profitTaxCap });
      result.feedText = `${caster.username} put a Profit Tax on ${target.username}`;
      break;
    case 'spread_blowout':
      hit('spread_blowout', { multiplier: CARD_AMOUNTS.spreadBlowoutMultiplier });
      result.feedText = `${caster.username} blew out ${target.username}'s spread`;
      break;
    case 'slippage_storm':
      hit('slippage_storm', { fillsLeft: CARD_AMOUNTS.slippageFills, spreads: CARD_AMOUNTS.slippageSpreads });
      result.feedText = `${caster.username} hit ${target.username} with a Slippage Storm`;
      break;
    case 'margin_squeeze':
      hit('margin_squeeze', { share: CARD_AMOUNTS.marginSqueezeShare });
      result.feedText = `${caster.username} squeezed ${target.username}'s margin`;
      break;
    case 'stop_yank':
      if (target.positions.length === 0) return { success: false, error: 'Target has no open positions' };
      result.stopYankTarget = true;
      result.feedText = `${caster.username} yanked ${target.username}'s stop loss`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: 0 } });
      break;
    case 'tp_snip':
      if (!target.positions.some((p) => p.takeProfit)) return { success: false, error: 'Target has no take profit to snip' };
      result.tpSnipTarget = true;
      result.feedText = `${caster.username} snipped ${target.username}'s take profits`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: 0 } });
      break;
    case 'order_freeze':
      hit('order_freeze');
      result.feedText = `${caster.username} froze ${target.username}'s orders`;
      break;
    case 'trade_limit':
      hit('trade_limit');
      result.feedText = `${caster.username} put a Trade Limit on ${target.username}`;
      break;
    case 'one_way': {
      const direction = rand() < 0.5 ? 'BUY' : 'SELL';
      hit('one_way', { direction });
      result.feedText = `${caster.username} locked ${target.username} to ${direction} only`;
      break;
    }
    case 'cooldown_jam':
      hit('cooldown_jam', { gapSeconds: CARD_AMOUNTS.cooldownJamSeconds });
      result.feedText = `${caster.username} jammed ${target.username}'s trading`;
      break;
    case 'profit_skim': {
      const banked = Math.max(0, target.balance - startCapital);
      const amount = Math.min(Math.round(banked * CARD_AMOUNTS.profitSkimShare * 100) / 100, CARD_AMOUNTS.profitSkimCap, roomAboveFloor);
      if (!(amount > 0)) return { success: false, error: 'Target has no banked profit to skim' };
      target.balance = Math.round((target.balance - amount) * 100) / 100;
      caster.balance = Math.round((caster.balance + amount) * 100) / 100;
      result.amounts = { amount };
      result.feedText = `${caster.username} skimmed ${amount} from ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, amount, duration: 0 } });
      break;
    }

    // ---- original cards -------------------------------------------------------
    case 'spread_spike':
      ensureSymbolEffects(effectSymbol);
      match.marketEffects[effectSymbol].spreadMultiplier = 3;
      match.marketEffects[effectSymbol].spreadUntil = until;
      match.marketEffects[effectSymbol].spreadCasterId = caster.id;
      result.feedText = `${caster.username} played Spread Spike on ${effectSymbol}`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, symbol: effectSymbol, duration: cardDef.duration } });
      break;
    case 'volatility_surge':
      match.marketEffects.volatilitySurgeUntil = until;
      match.marketEffects.volatilitySurgeCasterId = caster.id;
      result.feedText = `${caster.username} played Volatility Surge`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    case 'liquidity_drain':
      match.marketEffects.liquidityDrainUntil = until;
      match.marketEffects.liquidityDrainCasterId = caster.id;
      result.feedText = `${caster.username} played Liquidity Drain - max lot size capped at 0.1 for everyone else`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    case 'reversal_flash': {
      ensureSymbolEffects(effectSymbol);
      const direction = rand() < 0.5 ? 1 : -1;
      // The caster's edge is a 1s private warning before the shared move.
      const WARNING_MS = 1000;
      const startedAt = now + WARNING_MS;
      match.marketEffects[effectSymbol].reversal = { until: startedAt + cardDef.duration * 1000, direction, startedAt };
      result.feedText = `${caster.username} played Reversal Flash on ${effectSymbol}`;
      result.notify.push({ to: caster.id, event: 'sabotage:reversal_warning', payload: { cardType, symbol: effectSymbol } });
      result.delayedNotify = { delayMs: WARNING_MS, exceptPlayerId: caster.id, event: 'sabotage:incoming', payload: { cardType, symbol: effectSymbol, duration: cardDef.duration } };
      break;
    }
    case 'position_freeze':
      hit('position_freeze');
      result.feedText = `${caster.username} froze ${target.username}`;
      break;
    case 'force_close':
      if (target.positions.length === 0) return { success: false, error: 'Target has no open positions' };
      result.forceCloseTarget = true;
      result.feedText = `${caster.username} force-closed a position on ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: 0 } });
      break;
    case 'capital_drain': {
      const amount = Math.min(CARD_AMOUNTS.capitalDrain, roomAboveFloor);
      if (!(amount > 0)) return { success: false, error: 'Target is at the loss floor - this card cannot take more' };
      target.balance = Math.round((target.balance - amount) * 100) / 100;
      result.amounts = { amount };
      result.feedText = `${caster.username} drained ${amount} from ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, amount, duration: 0 } });
      break;
    }
    case 'mirror_trade': {
      if (caster.positions.length === 0) return { success: false, error: 'You have no open position to mirror' };
      if (target.positions.length >= (ctx.maxPositions || 10)) return { success: false, error: "Target's position slots are full" };
      const source = caster.positions[caster.positions.length - 1];
      result.mirrorSource = { symbol: source.symbol, direction: source.direction, lots: source.lots };
      result.feedText = `${caster.username} mirrored a ${source.direction} ${source.symbol} position onto ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, source: result.mirrorSource, duration: 0 } });
      break;
    }
    case 'double_spread':
      match.marketEffects.doubleSpreadUntil = until;
      match.marketEffects.doubleSpreadCasterId = caster.id;
      result.feedText = `${caster.username} played Double Spread - spread doubled on every instrument for everyone else`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    case 'time_warp':
      match.marketEffects.timeWarpUntil = until;
      match.marketEffects.timeWarpCasterId = caster.id;
      result.feedText = `${caster.username} played Time Warp - price feed delayed for everyone else`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    case 'fog_of_war':
      match.marketEffects.fogOfWarUntil = until;
      match.marketEffects.fogOfWarCasterId = caster.id;
      result.feedText = `${caster.username} played Fog of War - price feed jittered for everyone else`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    case 'panic_wave': {
      const WARNING_MS = 1000;
      const startedAt = now + WARNING_MS;
      const end = startedAt + cardDef.duration * 1000;
      for (const s of matchInstruments) {
        ensureSymbolEffects(s);
        match.marketEffects[s].reversal = { until: end, direction: rand() < 0.5 ? 1 : -1, startedAt };
      }
      result.feedText = `${caster.username} played Panic Wave - every instrument about to reverse`;
      result.notify.push({ to: caster.id, event: 'sabotage:reversal_warning', payload: { cardType } });
      result.delayedNotify = { delayMs: WARNING_MS, exceptPlayerId: caster.id, event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } };
      break;
    }
    case 'dead_calm':
      match.marketEffects.deadCalmUntil = until;
      match.marketEffects.deadCalmCasterId = caster.id;
      result.feedText = `${caster.username} played Dead Calm - price frozen for everyone else`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    case 'lockout':
      hit('lockout');
      result.feedText = `${caster.username} played Lockout on ${target.username}`;
      break;
    case 'margin_call':
      if (target.positions.length === 0) return { success: false, error: 'Target has no open positions' };
      result.forceCloseAllTarget = true;
      result.feedText = `${caster.username} played Margin Call - all of ${target.username}'s positions are being force-closed`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: 0 } });
      break;
    case 'lot_limiter':
      hit('lot_limiter');
      result.feedText = `${caster.username} played Lot Limiter on ${target.username}`;
      break;
    case 'pip_theft': {
      const amount = Math.min(CARD_AMOUNTS.pipTheft, Math.max(0, target.balance), roomAboveFloor);
      if (!(amount > 0)) return { success: false, error: 'Target is at the loss floor - this card cannot take more' };
      target.balance = Math.round((target.balance - amount) * 100) / 100;
      caster.balance = Math.round((caster.balance + amount) * 100) / 100;
      result.amounts = { amount };
      result.feedText = `${caster.username} stole ${amount} from ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, amount, duration: 0 } });
      break;
    }
    case 'ghost_trade':
      if (target.positions.length >= (ctx.maxPositions || 10)) return { success: false, error: "Target's position slots are full" };
      result.ghostTrade = { symbol: matchInstruments[Math.floor(rand() * matchInstruments.length)], direction: rand() < 0.5 ? 'BUY' : 'SELL' };
      result.feedText = `${caster.username} forced a ghost trade onto ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: 0 } });
      break;
    case 'stop_snipe':
      if (target.positions.length === 0) return { success: false, error: 'Target has no open positions' };
      result.stopSnipeTarget = true;
      result.feedText = `${caster.username} sniped the stop-loss on ${target.username}'s best position`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: 0 } });
      break;

    // ---- defensive ------------------------------------------------------------
    case 'shield':
      caster.effects.shield = { until: now + CARD_AMOUNTS.shieldSeconds * 1000, by: caster.id };
      result.feedText = `${caster.username} raised a Shield`;
      result.notify.push({ to: caster.id, event: 'cards:shield', payload: { until: caster.effects.shield.until } });
      break;
    case 'cleanse':
      for (const k of TIMED_TARGET_EFFECTS) caster.effects[k] = null;
      caster.effects.shield = { until: now + CARD_AMOUNTS.cleanseShieldSeconds * 1000, by: caster.id };
      result.feedText = `${caster.username} cleansed every effect`;
      result.notify.push({ to: caster.id, event: 'cards:shield', payload: { until: caster.effects.shield.until } });
      break;
    default:
      return { success: false, error: 'Unhandled card type' };
  }

  handCard.used = true;
  caster.cardsPlayed += 1;
  result.notify.push({
    to: 'all',
    event: 'sabotage:broadcast',
    payload: { caster: caster.username, target: target ? target.username : null, cardType, feedText: result.feedText },
  });
  return result;
}

function createMarketEffects() {
  return {
    volatilitySurgeUntil: 0,
    liquidityDrainUntil: 0,
    doubleSpreadUntil: 0,
    timeWarpUntil: 0,
    fogOfWarUntil: 0,
    deadCalmUntil: 0,
  };
}

function createPlayerEffects() {
  const e = { shield: null, hitShield: null };
  for (const k of TIMED_TARGET_EFFECTS) e[k] = null;
  return e;
}

module.exports = {
  CARDS,
  CARD_AMOUNTS,
  REPLACED_THREAT_ONLY,
  TIMED_TARGET_EFFECTS,
  dealCards,
  drawWeighted,
  getCardCatalog,
  playCard,
  isShielded,
  hasShieldCard,
  activeTargetEffect,
  createMarketEffects,
  createPlayerEffects,
};
