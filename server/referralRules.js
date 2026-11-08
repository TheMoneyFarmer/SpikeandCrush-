'use strict';

// Player invite rewards. One definition, read by the server, the support
// assistant's knowledge base and (through /api/referrals/me) the invite popup.
const INVITE_REWARD_COINS = 100; // paid to the inviter only
const INVITE_MAX_PAID = 50; // paid invites per player, ever

// A friend's invite pays out on their first finished match against at least one
// other real player: no bots, no AI. They must stay to the end and make a trade,
// and so must the match have another real player still in it at the end.
function qualifiesForInviteReward(players, playerId) {
  const finishers = players.filter((p) => !p.isAI && !p.forfeited);
  const friend = finishers.find((p) => p.id === playerId);
  return Boolean(friend) && friend.tradesMade >= 1 && finishers.length >= 2;
}

module.exports = { INVITE_REWARD_COINS, INVITE_MAX_PAID, qualifiesForInviteReward };
