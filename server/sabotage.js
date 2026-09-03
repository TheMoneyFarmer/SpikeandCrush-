'use strict';

// All 30 sabotage cards. `targeted` cards require a target player; market
// cards (`targeted: false`) affect the whole match environment. Cards with
// `requiresSymbol` act on one instrument (defaults to a random one if the
// caller doesn't supply one). `duration: 0` cards are instantaneous.
const CARDS = {
  news_bomb: {
    id: 'news_bomb',
    name: 'News Bomb',
    category: 'information',
    icon: '📰',
    description: "Inject a fake news headline into the target's feed for 15s.",
    duration: 15,
    targeted: true,
  },
  chart_ghost: {
    id: 'chart_ghost',
    name: 'Chart Ghost',
    category: 'information',
    icon: '👻',
    description: "Freeze the target's price display for 10s.",
    duration: 10,
    targeted: true,
  },
  false_signal: {
    id: 'false_signal',
    name: 'False Signal',
    category: 'information',
    icon: '📉',
    description: "Show a fake RSI divergence on the target's chart for 20s.",
    duration: 20,
    targeted: true,
  },
  smoke_screen: {
    id: 'smoke_screen',
    name: 'Smoke Screen',
    category: 'information',
    icon: '💨',
    description: 'Blur the leaderboard for all players for 30s.',
    duration: 30,
    targeted: false,
  },
  spread_spike: {
    id: 'spread_spike',
    name: 'Spread Spike',
    category: 'market',
    icon: '⚡',
    description: 'Triple the spread on one instrument for 20s.',
    duration: 20,
    targeted: false,
    requiresSymbol: true,
  },
  volatility_surge: {
    id: 'volatility_surge',
    name: 'Volatility Surge',
    category: 'market',
    icon: '🌪️',
    description: 'Double price movement speed for 25s.',
    duration: 25,
    targeted: false,
  },
  liquidity_drain: {
    id: 'liquidity_drain',
    name: 'Liquidity Drain',
    category: 'market',
    icon: '🏜️',
    description: 'Cap max lot size at 0.1 for all players for 30s.',
    duration: 30,
    targeted: false,
  },
  reversal_flash: {
    id: 'reversal_flash',
    name: 'Reversal Flash',
    category: 'market',
    icon: '↩️',
    description: 'Force a sharp 10 pip reversal, then snap back, over 8s.',
    duration: 8,
    targeted: false,
    requiresSymbol: true,
  },
  position_freeze: {
    id: 'position_freeze',
    name: 'Position Freeze',
    category: 'opponent',
    icon: '🧊',
    description: 'Target cannot open new trades for 15s.',
    duration: 15,
    targeted: true,
  },
  force_close: {
    id: 'force_close',
    name: 'Force Close',
    category: 'opponent',
    icon: '🔒',
    description: "Force close the target's best-performing position at market.",
    duration: 0,
    targeted: true,
  },
  capital_drain: {
    id: 'capital_drain',
    name: 'Capital Drain',
    category: 'opponent',
    icon: '💸',
    description: "Deduct $200 from the target's capital.",
    duration: 0,
    targeted: true,
  },
  mirror_trade: {
    id: 'mirror_trade',
    name: 'Mirror Trade',
    category: 'opponent',
    icon: '🪞',
    description: "Copy your current position onto the target's account.",
    duration: 0,
    targeted: true,
  },

  // ---- expansion set (18 more, added to reach 30 total) -------------------
  margin_scare: {
    id: 'margin_scare',
    name: 'Margin Scare',
    category: 'information',
    icon: '🚨',
    description: "Flash a fake margin-call warning on the target's screen for 10s.",
    duration: 10,
    targeted: true,
  },
  phantom_candle: {
    id: 'phantom_candle',
    name: 'Phantom Candle',
    category: 'information',
    icon: '🕯️',
    description: "Inject one fake bearish candle into the target's chart for 8s.",
    duration: 8,
    targeted: true,
  },
  blackout: {
    id: 'blackout',
    name: 'Blackout',
    category: 'information',
    icon: '⬛',
    description: "Blank out the target's live P&L display for 12s.",
    duration: 12,
    targeted: true,
  },
  static_burst: {
    id: 'static_burst',
    name: 'Static Burst',
    category: 'information',
    icon: '📺',
    description: "Cover the target's chart in visual static for 10s.",
    duration: 10,
    targeted: true,
  },
  decoy_order: {
    id: 'decoy_order',
    name: 'Decoy Order',
    category: 'information',
    icon: '🐋',
    description: 'Show the target a fake giant sell-wall alert for 12s.',
    duration: 12,
    targeted: true,
  },
  mirage: {
    id: 'mirage',
    name: 'Mirage',
    category: 'information',
    icon: '👁️',
    description: "Plant a fake ghost position in the target's position list for 15s.",
    duration: 15,
    targeted: true,
  },
  intel_leak: {
    id: 'intel_leak',
    name: 'Intel Leak',
    category: 'information',
    icon: '🕵️',
    description: "Reveal the target's real P&L and open positions to you for 10s.",
    duration: 10,
    targeted: true,
  },
  double_spread: {
    id: 'double_spread',
    name: 'Double Spread',
    category: 'market',
    icon: '〽️',
    description: 'Double the spread on every instrument for everyone except you, for 15s.',
    duration: 15,
    targeted: false,
  },
  time_warp: {
    id: 'time_warp',
    name: 'Time Warp',
    category: 'market',
    icon: '📡',
    description: 'Delay the price feed by 3 seconds for everyone except you, for 10s.',
    duration: 10,
    targeted: false,
  },
  fog_of_war: {
    id: 'fog_of_war',
    name: 'Fog of War',
    category: 'market',
    icon: '🌫️',
    description: 'Throw random price jitter into the feed for everyone except you, for 10s.',
    duration: 10,
    targeted: false,
  },
  panic_wave: {
    id: 'panic_wave',
    name: 'Panic Wave',
    category: 'market',
    icon: '📉',
    description: 'Force a brief synchronized reversal across every instrument, then snap back, over 8s.',
    duration: 8,
    targeted: false,
  },
  dead_calm: {
    id: 'dead_calm',
    name: 'Dead Calm',
    category: 'market',
    icon: '🧊',
    description: 'Freeze price movement on every instrument for everyone except you, for 6s.',
    duration: 6,
    targeted: false,
  },
  lockout: {
    id: 'lockout',
    name: 'Lockout',
    category: 'opponent',
    icon: '🔐',
    description: 'Target cannot close any position for 10s.',
    duration: 10,
    targeted: true,
  },
  margin_call: {
    id: 'margin_call',
    name: 'Margin Call',
    category: 'opponent',
    icon: '⚠️',
    description: "Force-close every one of the target's open positions at market.",
    duration: 0,
    targeted: true,
  },
  lot_limiter: {
    id: 'lot_limiter',
    name: 'Lot Limiter',
    category: 'opponent',
    icon: '📏',
    description: "Cap the target's max lot size at 0.05 for 15s.",
    duration: 15,
    targeted: true,
  },
  pip_theft: {
    id: 'pip_theft',
    name: 'Pip Theft',
    category: 'opponent',
    icon: '🥷',
    description: "Steal $150 from the target's capital straight into yours.",
    duration: 0,
    targeted: true,
  },
  ghost_trade: {
    id: 'ghost_trade',
    name: 'Ghost Trade',
    category: 'opponent',
    icon: '👻',
    description: "Force a small guaranteed-losing position onto the target's account.",
    duration: 0,
    targeted: true,
  },
  stop_snipe: {
    id: 'stop_snipe',
    name: 'Stop Snipe',
    category: 'opponent',
    icon: '🎯',
    description: "Drag the target's best position's stop-loss to break-even, wiping their cushion.",
    duration: 0,
    targeted: true,
  },
};

const NEWS_HEADLINES = [
  'Fed hints emergency rate cut incoming',
  'Oil supply disruption reported in Gulf',
  'Risk-off sentiment sweeping markets',
  'Central bank intervention rumored',
  'Inflation data shock expected',
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dealCards(count = 3) {
  const pool = shuffle(Object.keys(CARDS));
  return pool.slice(0, count).map((type) => ({ type, used: false }));
}

function getCardCatalog() {
  return Object.values(CARDS).map(({ id, name, category, icon, description, duration, targeted, requiresSymbol }) => ({
    id,
    name,
    category,
    icon,
    description,
    duration,
    targeted,
    requiresSymbol: Boolean(requiresSymbol),
  }));
}

/**
 * Applies a sabotage card. Mutates `match` in place for effects sabotage.js
 * owns directly (card state, targeted-player effect flags, match-wide market
 * effects, capital drain). Effects that need live pricing (force_close,
 * mirror_trade) are returned as descriptors for gameEngine.js to execute
 * against the authoritative price feed, since sabotage.js has no notion of
 * a specific match's live prices.
 */
function playCard(match, casterId, cardType, { targetId, symbol } = {}, now = Date.now()) {
  const caster = match.players[casterId];
  if (!caster) return { success: false, error: 'Caster not in match' };

  const cardDef = CARDS[cardType];
  if (!cardDef) return { success: false, error: 'Unknown card' };

  const handCard = caster.cards.find((c) => c.type === cardType);
  if (!handCard) return { success: false, error: 'Card not in hand' };
  if (handCard.used) return { success: false, error: 'Card already played' };

  let target = null;
  if (cardDef.targeted) {
    target = match.players[targetId];
    if (!target) return { success: false, error: 'Invalid target' };
    if (target.id === caster.id) return { success: false, error: 'Cannot target yourself' };
  }

  // Validate against this match's actual instrument list (was hardcoded to
  // EURUSD/XAUUSD before instrument rotation shipped, which silently sent
  // these cards at an instrument not even in play for any other mode).
  const matchInstruments = match.instruments || ['EURUSD', 'XAUUSD'];
  const effectSymbol = cardDef.requiresSymbol
    ? matchInstruments.includes(symbol)
      ? symbol
      : matchInstruments[Math.floor(Math.random() * matchInstruments.length)]
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
  };

  switch (cardType) {
    case 'news_bomb': {
      const headline = NEWS_HEADLINES[Math.floor(Math.random() * NEWS_HEADLINES.length)];
      target.effects.news_bomb = { until: now + cardDef.duration * 1000, headline };
      result.feedText = `${caster.username} played News Bomb on ${target.username}`;
      result.notify.push({
        to: target.id,
        event: 'sabotage:incoming',
        payload: { cardType, headline, duration: cardDef.duration },
      });
      break;
    }
    case 'chart_ghost': {
      target.effects.chart_ghost = { until: now + cardDef.duration * 1000 };
      result.feedText = `${caster.username} played Chart Ghost on ${target.username}`;
      result.notify.push({
        to: target.id,
        event: 'sabotage:incoming',
        payload: { cardType, duration: cardDef.duration },
      });
      break;
    }
    case 'false_signal': {
      const fakeRsi = Math.random() < 0.5 ? Math.floor(Math.random() * 15) + 5 : Math.floor(Math.random() * 15) + 80;
      target.effects.false_signal = { until: now + cardDef.duration * 1000, fakeRsi };
      result.feedText = `${caster.username} played False Signal on ${target.username}`;
      result.notify.push({
        to: target.id,
        event: 'sabotage:incoming',
        payload: { cardType, fakeRsi, duration: cardDef.duration },
      });
      break;
    }
    case 'smoke_screen': {
      // *CasterId records who played it so gameEngine.js can exempt them from
      // their own effect (FIX: market cards must not affect the caster) -
      // checked alongside the *Until timestamp everywhere this is read.
      match.marketEffects.smokeScreenUntil = now + cardDef.duration * 1000;
      match.marketEffects.smokeScreenCasterId = caster.id;
      result.feedText = `${caster.username} played Smoke Screen - leaderboard blurred for everyone else`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'spread_spike': {
      if (!match.marketEffects[effectSymbol]) match.marketEffects[effectSymbol] = { spreadMultiplier: 1, spreadUntil: 0, reversal: null };
      match.marketEffects[effectSymbol].spreadMultiplier = 3;
      match.marketEffects[effectSymbol].spreadUntil = now + cardDef.duration * 1000;
      match.marketEffects[effectSymbol].spreadCasterId = caster.id;
      result.feedText = `${caster.username} played Spread Spike on ${effectSymbol}`;
      result.notify.push({
        to: 'all',
        event: 'sabotage:incoming',
        payload: { cardType, symbol: effectSymbol, duration: cardDef.duration },
      });
      break;
    }
    case 'volatility_surge': {
      match.marketEffects.volatilitySurgeUntil = now + cardDef.duration * 1000;
      match.marketEffects.volatilitySurgeCasterId = caster.id;
      result.feedText = `${caster.username} played Volatility Surge`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'liquidity_drain': {
      match.marketEffects.liquidityDrainUntil = now + cardDef.duration * 1000;
      match.marketEffects.liquidityDrainCasterId = caster.id;
      result.feedText = `${caster.username} played Liquidity Drain - max lot size capped at 0.1 for everyone else`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'reversal_flash': {
      if (!match.marketEffects[effectSymbol]) match.marketEffects[effectSymbol] = { spreadMultiplier: 1, spreadUntil: 0, reversal: null };
      const direction = Math.random() < 0.5 ? 1 : -1;
      // The reversal itself is shared/unavoidable once it starts (price is
      // the same for everyone) - the caster's edge is a 1s private warning
      // before it begins, not immunity from the price move. startedAt is
      // pushed 1s into the future so getEffectivePrice's reversal gate holds
      // off applying the offset until the warning window has elapsed.
      const WARNING_MS = 1000;
      const startedAt = now + WARNING_MS;
      match.marketEffects[effectSymbol].reversal = { until: startedAt + cardDef.duration * 1000, direction, startedAt };
      result.feedText = `${caster.username} played Reversal Flash on ${effectSymbol}`;
      result.notify.push({
        to: caster.id,
        event: 'sabotage:reversal_warning',
        payload: { cardType, symbol: effectSymbol },
      });
      // Opponents only learn about it once it actually starts moving price -
      // gameEngine.js's playSabotageCard schedules this after WARNING_MS.
      result.delayedNotify = {
        delayMs: WARNING_MS,
        exceptPlayerId: caster.id,
        event: 'sabotage:incoming',
        payload: { cardType, symbol: effectSymbol, duration: cardDef.duration },
      };
      break;
    }
    case 'position_freeze': {
      target.effects.position_freeze = { until: now + cardDef.duration * 1000 };
      result.feedText = `${caster.username} played Position Freeze on ${target.username}`;
      result.notify.push({
        to: target.id,
        event: 'sabotage:incoming',
        payload: { cardType, duration: cardDef.duration },
      });
      break;
    }
    case 'force_close': {
      if (target.positions.length === 0) return { success: false, error: 'Target has no open positions' };
      result.forceCloseTarget = true;
      result.feedText = `${caster.username} force-closed a position on ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: 0 } });
      break;
    }
    case 'capital_drain': {
      target.balance = Math.max(0, target.balance - 200);
      result.feedText = `${caster.username} drained $200 from ${target.username}`;
      result.notify.push({
        to: target.id,
        event: 'sabotage:incoming',
        payload: { cardType, amount: 200, duration: 0 },
      });
      break;
    }
    case 'mirror_trade': {
      if (caster.positions.length === 0) return { success: false, error: 'You have no open position to mirror' };
      if (target.positions.length >= 3) return { success: false, error: "Target's position slots are full" };
      const source = caster.positions[caster.positions.length - 1];
      result.mirrorSource = { symbol: source.symbol, direction: source.direction, lots: source.lots };
      result.feedText = `${caster.username} mirrored a ${source.direction} ${source.symbol} position onto ${target.username}`;
      result.notify.push({
        to: target.id,
        event: 'sabotage:incoming',
        payload: { cardType, source: result.mirrorSource, duration: 0 },
      });
      break;
    }

    // ---- expansion set ------------------------------------------------
    case 'margin_scare': {
      target.effects.margin_scare = { until: now + cardDef.duration * 1000 };
      result.feedText = `${caster.username} played Margin Scare on ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'phantom_candle': {
      target.effects.phantom_candle = { until: now + cardDef.duration * 1000 };
      result.feedText = `${caster.username} played Phantom Candle on ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'blackout': {
      target.effects.blackout = { until: now + cardDef.duration * 1000 };
      result.feedText = `${caster.username} played Blackout on ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'static_burst': {
      target.effects.static_burst = { until: now + cardDef.duration * 1000 };
      result.feedText = `${caster.username} played Static Burst on ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'decoy_order': {
      target.effects.decoy_order = { until: now + cardDef.duration * 1000 };
      result.feedText = `${caster.username} played Decoy Order on ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'mirage': {
      target.effects.mirage = { until: now + cardDef.duration * 1000 };
      result.feedText = `${caster.username} played Mirage on ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'intel_leak': {
      target.effects.intel_leak = { until: now + cardDef.duration * 1000 };
      result.feedText = `${caster.username} played Intel Leak on ${target.username}`;
      // Unlike every other targeted card, this one benefits the CASTER, not
      // the target - the notify (carrying the target's real data) goes to
      // the caster instead of the usual "you were sabotaged" push.
      result.notify.push({
        to: caster.id,
        event: 'sabotage:incoming',
        payload: {
          cardType,
          duration: cardDef.duration,
          targetUsername: target.username,
          targetBalance: target.balance,
          targetPositions: target.positions.map((p) => ({ symbol: p.symbol, direction: p.direction, lots: p.lots })),
        },
      });
      break;
    }
    case 'double_spread': {
      match.marketEffects.doubleSpreadUntil = now + cardDef.duration * 1000;
      match.marketEffects.doubleSpreadCasterId = caster.id;
      result.feedText = `${caster.username} played Double Spread - spread doubled on every instrument for everyone else`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'time_warp': {
      match.marketEffects.timeWarpUntil = now + cardDef.duration * 1000;
      match.marketEffects.timeWarpCasterId = caster.id;
      result.feedText = `${caster.username} played Time Warp - price feed delayed for everyone else`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'fog_of_war': {
      match.marketEffects.fogOfWarUntil = now + cardDef.duration * 1000;
      match.marketEffects.fogOfWarCasterId = caster.id;
      result.feedText = `${caster.username} played Fog of War - price feed jittered for everyone else`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'panic_wave': {
      // Same shared-reversal-with-private-warning mechanism as
      // reversal_flash, just applied to every instrument in the match at
      // once instead of a single requiresSymbol target.
      const WARNING_MS = 1000;
      const startedAt = now + WARNING_MS;
      const until = startedAt + cardDef.duration * 1000;
      for (const s of matchInstruments) {
        if (!match.marketEffects[s]) match.marketEffects[s] = { spreadMultiplier: 1, spreadUntil: 0, reversal: null };
        const direction = Math.random() < 0.5 ? 1 : -1;
        match.marketEffects[s].reversal = { until, direction, startedAt };
      }
      result.feedText = `${caster.username} played Panic Wave - every instrument about to reverse`;
      result.notify.push({ to: caster.id, event: 'sabotage:reversal_warning', payload: { cardType } });
      result.delayedNotify = {
        delayMs: WARNING_MS,
        exceptPlayerId: caster.id,
        event: 'sabotage:incoming',
        payload: { cardType, duration: cardDef.duration },
      };
      break;
    }
    case 'dead_calm': {
      // Baseline mid-price per symbol is captured by gameEngine.js right
      // after playCard() returns (needs live prices, which sabotage.js has
      // no access to) - exactly the same split responsibility as
      // volatility_surge's baseline capture just above in playSabotageCard.
      match.marketEffects.deadCalmUntil = now + cardDef.duration * 1000;
      match.marketEffects.deadCalmCasterId = caster.id;
      result.feedText = `${caster.username} played Dead Calm - price frozen for everyone else`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'lockout': {
      target.effects.lockout = { until: now + cardDef.duration * 1000 };
      result.feedText = `${caster.username} played Lockout on ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'margin_call': {
      if (target.positions.length === 0) return { success: false, error: 'Target has no open positions' };
      result.forceCloseAllTarget = true;
      result.feedText = `${caster.username} played Margin Call - all of ${target.username}'s positions are being force-closed`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: 0 } });
      break;
    }
    case 'lot_limiter': {
      target.effects.lot_limiter = { until: now + cardDef.duration * 1000 };
      result.feedText = `${caster.username} played Lot Limiter on ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'pip_theft': {
      const stolen = Math.min(150, target.balance);
      target.balance = Math.max(0, target.balance - 150);
      caster.balance = Math.round((caster.balance + stolen) * 100) / 100;
      result.feedText = `${caster.username} stole $${stolen} from ${target.username}`;
      result.notify.push({
        to: target.id,
        event: 'sabotage:incoming',
        payload: { cardType, amount: stolen, duration: 0 },
      });
      break;
    }
    case 'ghost_trade': {
      if (target.positions.length >= 3) return { success: false, error: "Target's position slots are full" };
      result.ghostTrade = { symbol: matchInstruments[Math.floor(Math.random() * matchInstruments.length)] };
      result.feedText = `${caster.username} forced a ghost trade onto ${target.username}`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: 0 } });
      break;
    }
    case 'stop_snipe': {
      if (target.positions.length === 0) return { success: false, error: 'Target has no open positions' };
      result.stopSnipeTarget = true;
      result.feedText = `${caster.username} sniped the stop-loss on ${target.username}'s best position`;
      result.notify.push({ to: target.id, event: 'sabotage:incoming', payload: { cardType, duration: 0 } });
      break;
    }
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
    EURUSD: { spreadMultiplier: 1, spreadUntil: 0, reversal: null },
    XAUUSD: { spreadMultiplier: 1, spreadUntil: 0, reversal: null },
    volatilitySurgeUntil: 0,
    liquidityDrainUntil: 0,
    smokeScreenUntil: 0,
    doubleSpreadUntil: 0,
    timeWarpUntil: 0,
    fogOfWarUntil: 0,
    deadCalmUntil: 0,
  };
}

function createPlayerEffects() {
  return {
    news_bomb: null,
    chart_ghost: null,
    false_signal: null,
    position_freeze: null,
    margin_scare: null,
    phantom_candle: null,
    blackout: null,
    static_burst: null,
    decoy_order: null,
    mirage: null,
    intel_leak: null,
    lockout: null,
    lot_limiter: null,
  };
}

module.exports = {
  CARDS,
  NEWS_HEADLINES,
  dealCards,
  getCardCatalog,
  playCard,
  createMarketEffects,
  createPlayerEffects,
};
