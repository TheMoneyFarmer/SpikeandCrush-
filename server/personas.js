'use strict';

// Realistic trader-community usernames used to fill empty match slots and to
// seed the global leaderboard, replacing the old "Aggressive_Al" / "AI"-
// labeled placeholder accounts. Nothing about these players is disclosed as
// AI anywhere in client-facing data - see server/gameEngine.js (isAI stays
// server-only) and server/index.js (personaSeed.js seeding).

const TRADER_PERSONAS = [
  // Aggressive style personas
  { username: 'NakedPip', style: 'aggressive' },
  { username: 'ScalpKing', style: 'aggressive' },
  { username: 'PipHunter', style: 'aggressive' },
  { username: 'BullRekt', style: 'aggressive' },
  { username: 'EntrySignal', style: 'aggressive' },
  { username: 'LiquidityGrab', style: 'aggressive' },
  { username: 'StopHunter', style: 'aggressive' },
  { username: 'MarketMaker', style: 'aggressive' },
  { username: 'OrderFlow', style: 'aggressive' },
  { username: 'DeltaForce', style: 'aggressive' },
  { username: 'GapFiller', style: 'aggressive' },
  { username: 'FibBreaker', style: 'aggressive' },
  { username: 'SpikeTrader', style: 'aggressive' },
  { username: 'PivotKing', style: 'aggressive' },
  { username: 'RiskOn', style: 'aggressive' },
  { username: 'NakedTrade', style: 'aggressive' },
  { username: 'BreakoutKid', style: 'aggressive' },
  { username: 'MomentumX', style: 'aggressive' },
  { username: 'TrendKiller', style: 'aggressive' },
  { username: 'PipBandit', style: 'aggressive' },

  // Patient style personas
  { username: 'WaitForIt', style: 'patient' },
  { username: 'SetupHunter', style: 'patient' },
  { username: 'PatienceWins', style: 'patient' },
  { username: 'HighProbTrade', style: 'patient' },
  { username: 'ZoneTrader', style: 'patient' },
  { username: 'SupplyZone', style: 'patient' },
  { username: 'DemandBlock', style: 'patient' },
  { username: 'SmartMoney', style: 'patient' },
  { username: 'InstitutionalX', style: 'patient' },
  { username: 'OrderBlock', style: 'patient' },
  { username: 'LiquidityPool', style: 'patient' },
  { username: 'FairValue', style: 'patient' },
  { username: 'PremiumZone', style: 'patient' },
  { username: 'DiscountBuyer', style: 'patient' },
  { username: 'SessionOpen', style: 'patient' },
  { username: 'KillZone', style: 'patient' },
  { username: 'LondonBreak', style: 'patient' },
  { username: 'NewYorkOpen', style: 'patient' },
  { username: 'AsiaRange', style: 'patient' },
  { username: 'HighLowGame', style: 'patient' },

  // Chaos style personas
  { username: 'YOLO_FX', style: 'chaos' },
  { username: 'MoonOrDoom', style: 'chaos' },
  { username: 'AllIn_Gold', style: 'chaos' },
  { username: 'RecklessTP', style: 'chaos' },
  { username: 'NoStopLoss', style: 'chaos' },
  { username: 'FullSend', style: 'chaos' },
  { username: 'Degen_FX', style: 'chaos' },
  { username: 'MaxLeverage', style: 'chaos' },
  { username: 'ChaosCandle', style: 'chaos' },
  { username: 'WickHunter', style: 'chaos' },
  { username: 'PinBar_Gang', style: 'chaos' },
  { username: 'RandomEntry', style: 'chaos' },
  { username: 'NewsTrader', style: 'chaos' },
  { username: 'EventDriven', style: 'chaos' },
  { username: 'SpikeRider', style: 'chaos' },
  { username: 'CrushMode', style: 'chaos' },
  { username: 'GoldRush', style: 'chaos' },
  { username: 'OilPanic', style: 'chaos' },
  { username: 'CryptoBleed', style: 'chaos' },
  { username: 'NasdaqDegen', style: 'chaos' },

  // Mixed realistic names
  { username: 'Forex_Ghost', style: 'aggressive' },
  { username: 'ThePipDoctor', style: 'patient' },
  { username: 'SilentSell', style: 'patient' },
  { username: 'GoldSniper', style: 'aggressive' },
  { username: 'PipSurgeon', style: 'patient' },
  { username: 'TrendRider', style: 'aggressive' },
  { username: 'MarketSnipr', style: 'patient' },
  { username: 'CableKing', style: 'aggressive' },
  { username: 'FiberTrader', style: 'patient' },
  { username: 'YenSniper', style: 'patient' },
  { username: 'GoldBull', style: 'aggressive' },
  { username: 'OilBear', style: 'aggressive' },
  { username: 'IndexKing', style: 'aggressive' },
  { username: 'MacroView', style: 'patient' },
  { username: 'TechAnalyst', style: 'patient' },
  { username: 'PriceAction', style: 'patient' },
  { username: 'RiskReward', style: 'patient' },
  { username: 'SharpeRatio', style: 'patient' },
  { username: 'WinRateKing', style: 'patient' },
  { username: 'DrawdownZero', style: 'patient' },
  { username: 'PipCollector', style: 'aggressive' },
  { username: 'StopEater', style: 'aggressive' },
  { username: 'LiquidityTrap', style: 'chaos' },
  { username: 'FakeoutKing', style: 'chaos' },
  { username: 'WhipsawRider', style: 'chaos' },
  { username: 'GapTrader', style: 'aggressive' },
  { username: 'SwingMaster', style: 'patient' },
  { username: 'ScalperPro', style: 'aggressive' },
  { username: 'DayTraderX', style: 'aggressive' },
  { username: 'PropFunded', style: 'patient' },
  { username: 'FTMOPassed', style: 'patient' },
  { username: 'FundedTrader', style: 'patient' },
  { username: 'ChallengeKing', style: 'aggressive' },
  { username: 'EvalHunter', style: 'patient' },
  { username: 'TwoPercent', style: 'patient' },
  { username: 'OneRiskOnly', style: 'patient' },
  { username: 'HalfPercent', style: 'patient' },
  { username: 'MaxDrawdown', style: 'chaos' },
  { username: 'BlowupKing', style: 'chaos' },
  { username: 'ResetButton', style: 'chaos' },
];

// War Rating range assigned to a persona based on trading style - aggressive
// personas run mid-tier (win some, lose some), patient personas trend higher
// (discipline pays off over time), chaos personas run low/inconsistent.
const RATING_RANGES = {
  aggressive: { min: 1100, max: 1600 },
  patient: { min: 1400, max: 2200 },
  chaos: { min: 800, max: 1200 },
};

function ratingForStyle(style) {
  const range = RATING_RANGES[style] || RATING_RANGES.aggressive;
  return range.min + Math.floor(Math.random() * (range.max - range.min));
}

// Tracks which persona usernames are already in play for the CURRENT match,
// keyed by matchId, so the same match never gets two personas with the same
// name. Cleared via resetMatchPersonas() when a match ends/is removed.
const usedByMatch = new Map();

function getPersona(style, matchId) {
  const pool = TRADER_PERSONAS.filter((p) => p.style === style);
  const used = matchId ? usedByMatch.get(matchId) || new Set() : new Set();
  const available = pool.filter((p) => !used.has(p.username));

  const persona = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : pool[Math.floor(Math.random() * pool.length)];

  if (matchId) {
    used.add(persona.username);
    usedByMatch.set(matchId, used);
  }

  return { ...persona, rating: ratingForStyle(persona.style) };
}

function resetMatchPersonas(matchId) {
  usedByMatch.delete(matchId);
}

// Lobby chat lines a persona occasionally sends on join, so the lobby feels
// populated - weighted like the spec: 30% GL HF, 20% Let's go, 10% May the
// best trader win, 40% says nothing.
const JOIN_CHAT_LINES = [
  { text: 'GL HF', weight: 0.3 },
  { text: "Let's go", weight: 0.2 },
  { text: 'May the best trader win', weight: 0.1 },
];

function maybeJoinChatLine() {
  const roll = Math.random();
  let cumulative = 0;
  for (const line of JOIN_CHAT_LINES) {
    cumulative += line.weight;
    if (roll < cumulative) return line.text;
  }
  return null; // remaining probability mass = silence
}

module.exports = {
  TRADER_PERSONAS,
  RATING_RANGES,
  getPersona,
  resetMatchPersonas,
  maybeJoinChatLine,
};
