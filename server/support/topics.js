'use strict';

// A support chat's topic for analytics, from the player's own words (keyword
// rules, no model call). First match wins; checked in this order so a precise
// topic beats a broad one. Never reads secrets: only the message text.

const RULES = [
  ['account', /\b(password|log ?in|sign ?in|sign ?up|register|verify|verification|email|2fa|two.?factor|account|username|banned?|locked)\b/i],
  ['coins', /\b(coins?|balance|wallet|refund|reward|earn|invite|referr?al|bonus|battle ?pass|shop)\b/i],
  ['competitions', /\b(competition|daily open|weekend open|prize|winner|claim|partner|broker|prop firm|tournament|elimination)\b/i],
  ['cards', /\b(cards?|sabotage|shield|heat|streak|mission|deck|unlock)\b/i],
  ['technical', /\b(bug|error|crash|freez|froze|frozen|stuck|lag|slow|loading|disconnect|reconnect|not working|broken|blank)\b/i],
  ['trading', /\b(trade|lot|leverage|margin|stop ?loss|take ?profit|sl|tp|spread|pips?|chart|price|position|p&l|pnl)\b/i],
  ['modes', /\b(blitz|quick|grand|solo|private|bell rush|the pit|mode|match|room|lobby|rank|rating|tier|leaderboard)\b/i],
  ['sponsor', /\b(sponsor|advertis|partnership|business|collaborat)\b/i],
];

function classify(text) {
  const t = String(text || '');
  for (const [topic, re] of RULES) if (re.test(t)) return topic;
  return 'other';
}

module.exports = { classify, TOPICS: [...RULES.map((r) => r[0]), 'other'] };
