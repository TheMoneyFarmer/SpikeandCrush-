'use strict';

// All 12 sabotage cards. `targeted` cards require a target player; market
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
      match.marketEffects.smokeScreenUntil = now + cardDef.duration * 1000;
      result.feedText = `${caster.username} played Smoke Screen - leaderboard blurred for everyone`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'spread_spike': {
      if (!match.marketEffects[effectSymbol]) match.marketEffects[effectSymbol] = { spreadMultiplier: 1, spreadUntil: 0, reversal: null };
      match.marketEffects[effectSymbol].spreadMultiplier = 3;
      match.marketEffects[effectSymbol].spreadUntil = now + cardDef.duration * 1000;
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
      result.feedText = `${caster.username} played Volatility Surge`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'liquidity_drain': {
      match.marketEffects.liquidityDrainUntil = now + cardDef.duration * 1000;
      result.feedText = `${caster.username} played Liquidity Drain - max lot size capped at 0.1 for everyone`;
      result.notify.push({ to: 'all', event: 'sabotage:incoming', payload: { cardType, duration: cardDef.duration } });
      break;
    }
    case 'reversal_flash': {
      if (!match.marketEffects[effectSymbol]) match.marketEffects[effectSymbol] = { spreadMultiplier: 1, spreadUntil: 0, reversal: null };
      const direction = Math.random() < 0.5 ? 1 : -1;
      match.marketEffects[effectSymbol].reversal = { until: now + cardDef.duration * 1000, direction, startedAt: now };
      result.feedText = `${caster.username} played Reversal Flash on ${effectSymbol}`;
      result.notify.push({
        to: 'all',
        event: 'sabotage:incoming',
        payload: { cardType, symbol: effectSymbol, duration: cardDef.duration },
      });
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
  };
}

function createPlayerEffects() {
  return {
    news_bomb: null,
    chart_ghost: null,
    false_signal: null,
    position_freeze: null,
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
