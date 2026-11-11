'use strict';

// Code-derived knowledge base for the support assistant.
//
// Every number below is read from the live game modules - never typed by
// hand - so the assistant cannot drift from the real rules. Prose is written
// for players. Where the code is unclear or two places disagree, the article
// says so plainly and is marked needsReview: true (listed in the admin KB
// editor and in the support build report) instead of guessing.
//
// Regenerate the .md copies + DB rows with: node scripts/generate-support-kb.js

const {
  GAME_RULES,
  MODE_DURATIONS,
  MATCH_MODES,
  SOFT_LOSS_PCT,
  SOFT_LOSS_WINDOW_SECONDS,
  RECONNECT_GRACE_SECONDS,
  PRIZE_SHARE_BY_RANK,
  TIERS,
  EXPERIENCE_LEVELS,
  PRIVATE_WAR_HOST_FEE,
  baseRatingForPosition,
} = require('../../gameEngine');
const { TEMPLATES, competitionInstruments } = require('../../compEngine');
const { CARDS } = require('../../sabotage');
const gameFeelCfg = require('../../config/gameFeel');
const progressionRules = require('../../progression');
const shop = require('../../shop');
const battlepass = require('../../battlepass');
const instruments = require('../../instruments');
const { LEVERAGE, MARGIN_CALL_LEVEL, STOP_OUT_LEVEL, positionMargin, maxAffordableLots } = require('../../marginRules');
const { INVITE_REWARD_COINS, INVITE_MAX_PAID } = require('../../referralRules');

const CONTACT_EMAIL = 'hello@spikeandcrush.com';
const NO_CASH = 'Coins have no cash value and cannot be withdrawn, cashed out or exchanged for money.';

const pct = (x) => `${Math.round(x * 100)}%`;
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
const minutes = (seconds) => {
  const m = seconds / 60;
  return Number.isInteger(m) ? `${m} minute${m === 1 ? '' : 's'}` : `${seconds} seconds`;
};
const coins = (n) => (n === 0 ? 'free' : `${n} coin${n === 1 ? '' : 's'}`);
const sign = (n) => (n > 0 ? `+${n}` : String(n));

const MODE_ORDER = ['quick', 'blitz', 'grand', 'solo', 'async', 'private', 'tournament'];

function modeRow(key) {
  const m = MATCH_MODES[key];
  const entry =
    key === 'private' ? `${coins(PRIVATE_WAR_HOST_FEE)} for the host, free for invited players`
    : key === 'tournament' ? 'set per tournament'
    : coins(m.entryCoins);
  const ranked = m.ranked ? `yes (${m.ratingKey === 'war_rating' ? 'War Rating' : m.ratingKey === 'grand_war_rating' ? 'separate Grand War rating' : 'separate Solo rating'})` : 'no';
  return `| ${m.label} | ${minutes(MODE_DURATIONS[key])} | ${entry} | ${m.maxPlayers ? `${m.minPlayers}-${m.maxPlayers}` : `${m.minPlayers}+ (no limit)`} | ${Math.min(m.cardsPerPlayer, gameFeelCfg.get().cards.handSize)} | ${ranked} |`;
}

function compTemplateBlock(key) {
  const t = TEMPLATES[key];
  const pays = t.payouts.map((p) => `${ordinal(p.rank)}: ${p.coins} coins`).join(', ');
  return `### ${t.title}\n${t.description}\n\n- Entry: ${coins(t.entryFee)}\n- Instruments: ${competitionInstruments(t.instruments).join(', ')}\n- Default prizes (coins): ${pays}`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function buildArticles() {
  const rules = GAME_RULES;
  const eurPrice = instruments.getInstrument('EURUSD').basePrice;
  const eurMargin = Math.round(positionMargin('EURUSD', 1, eurPrice));
  const eurMax = Math.floor(maxAffordableLots('EURUSD', eurPrice, rules.STARTING_CAPITAL));
  const ratingTable4 = [1, 2, 3, 4].map((p) => `${ordinal(p)}: ${sign(baseRatingForPosition(p, 4))}`).join(', ');
  const ratingTable6 = [1, 2, 3, 4, 5, 6].map((p) => `${ordinal(p)}: ${sign(baseRatingForPosition(p, 6))}`).join(', ');
  const shares = Object.entries(PRIZE_SHARE_BY_RANK).map(([r, s]) => `${ordinal(Number(r))}: ${pct(s)}`).join(', ');
  const cat = shop.getCatalog();
  const cardList = Object.values(CARDS)
    .map((c) => `- **${c.name}** (${c.rarity}, ${c.kind === 'defense' ? 'plays on yourself' : c.kind === 'market' ? 'hits every other unshielded player' : 'targets one player'}; ${progressionRules.BASIC_DECK.includes(c.id) ? 'starter card' : progressionRules.describeUnlock(progressionRules.unlockRule(c.id))}): ${c.description}`)
    .join('\n');
  const F = gameFeelCfg.get();

  return [
    {
      slug: 'game-concept',
      title: 'What is Spike & Crush?',
      category: 'basics',
      tags: ['about', 'concept', 'goal', 'how to play', 'what is'],
      body: `Spike & Crush is a competitive trading game. You and your opponents each get ${money(rules.STARTING_CAPITAL)} of virtual capital and trade real historical market prices against the clock. Whoever finishes with the highest profit (P&L) wins.

Everyone also gets sabotage cards: one-time abilities you can play on opponents to disrupt their trading.

It is a game, not real trading. The capital is virtual and resets every match. The only thing you put in is a coin entry fee in some modes. ${NO_CASH}`,
    },
    {
      slug: 'trading-basics',
      title: 'Trading basics inside the game',
      category: 'basics',
      tags: ['buy', 'sell', 'pip', 'lot', 'spread', 'stop loss', 'take profit', 'beginner'],
      body: `- **Buy** if you think the price will rise, **sell** if you think it will fall. Close the trade to lock in the result.
- **Lot size** sets how big a position is. Bigger lots make every price move count for more, up and down.
- **Spread** is the gap between the buy and sell price. You pay it once when you open a trade.
- **Stop loss** closes a trade automatically if price moves against you by a set amount. **Take profit** closes it automatically at your target. You can set both when opening a trade or change them while it is open.
- Prices are real historical market data replayed in the match, not live prices.`,
    },
    {
      slug: 'match-rules-limits',
      title: 'Starting capital, position limit and lot size',
      category: 'rules',
      tags: ['starting capital', 'lot limit', 'max lots', 'lot size', 'max positions', 'how many lots', 'rules', 'limits'],
      body: `Every match uses the same core rules:

- Starting capital: ${money(rules.STARTING_CAPITAL)} (virtual, resets every match)
- Maximum open positions at once: ${rules.MAX_POSITIONS}
- Lot size: **there is no lot limit**. How big you can trade depends on your leverage and free margin (see "Leverage and margin").

Two sabotage cards can cap your lot size for a short time: Lot Limiter and Liquidity Drain.

Long-form competitions use the same capital, position limit and margin rules.`,
    },
    {
      slug: 'loss-limits',
      title: 'How you can lose: stop-out and the 2-minute lock',
      category: 'rules',
      tags: ['max loss', 'loss limit', 'eliminated', 'auto close', 'locked', 'lockout', 'blown account', 'lose everything', 'stopped out', 'why was my position closed'],
      body: `Risk is decided by the margin rules (see "Leverage, margin, margin call and stop-out"). There is no fixed maximum loss: small positions can keep running through a bigger drawdown, and big ones get stopped out sooner. You are never removed from a match for losing. If your equity is too low to open anything, you just can't trade until you have free margin.

**Stop-out at ${STOP_OUT_LEVEL}% margin level.** Your biggest losing position closes automatically, then the next, until the level recovers.

**The 2-minute lock.** If you lose ${pct(SOFT_LOSS_PCT)} of starting capital within one ${minutes(SOFT_LOSS_WINDOW_SECONDS)} window, you cannot open new trades until the next window starts. Windows run every ${minutes(SOFT_LOSS_WINDOW_SECONDS)} from the start of the match. This applies to matches only, not competitions.`,
    },
    {
      slug: 'leverage',
      title: 'Leverage, margin, margin call and stop-out',
      category: 'rules',
      tags: ['leverage', 'margin', 'margin call', 'stop out', 'stop-out', 'margin level', 'free margin', 'how many lots', 'lot limit'],
      body: `Every player trades at **${LEVERAGE}:1 leverage**. There is no lot limit: free margin decides how much you can open.

- **Margin used**: the value of your open positions divided by ${LEVERAGE}.
- **Free margin**: equity minus margin used. A new trade must fit inside it.
- **Margin level**: equity divided by margin used, as a percentage.

Example: on EUR/USD near ${eurPrice}, one lot needs about ${money(eurMargin)} of margin, so ${money(rules.STARTING_CAPITAL)} opens about ${eurMax} lots.

**Margin call at ${MARGIN_CALL_LEVEL}%.** You get a warning and cannot open new trades until the level recovers.

**Stop-out at ${STOP_OUT_LEVEL}%.** Your biggest losing position is closed, then the next, until the level recovers. You keep trading with what is left.

Margin Call is also the name of a sabotage card, which closes a target's open positions.`,
    },
    {
      slug: 'game-modes',
      title: 'Game modes and match durations',
      category: 'modes',
      tags: ['modes', 'duration', 'how long', 'quick war', 'blitz', 'grand war', 'solo', 'async', 'private', 'tournament', 'entry fee'],
      body: `| Mode | Match length | Entry | Players | Cards | Ranked |
|---|---|---|---|---|---|
${MODE_ORDER.map(modeRow).join('\n')}

- **${MATCH_MODES.quick.label}**: the standard match.
- **${MATCH_MODES.blitz.label}**: a short, cheap, unranked sprint.
- **${MATCH_MODES.grand.label}**: the long mode. Your saved deck loads, and you can change your cards in the lobby.
- **${MATCH_MODES.solo.label}**: free, against AI opponents only, with its own rating.
- **${MATCH_MODES.async.label}**: everyone that day trades the same market window, alone, with no sabotage. Separate daily leaderboard.
- **${MATCH_MODES.private.label}**: invite friends with a 6-digit room code. The host pays ${coins(PRIVATE_WAR_HOST_FEE)} when the match starts; invited players join free. Unranked.
- **${MATCH_MODES.tournament.label}**: one-on-one bracket matches inside a tournament. The entry fee is set per tournament.`,
    },
    {
      slug: 'prizes-and-scoring',
      title: 'How matches are scored and how prizes are paid',
      category: 'rules',
      tags: ['prize pool', 'scoring', 'winner', 'payout', 'coins won', 'draw', 'tie'],
      body: `The player with the highest profit (P&L) when the timer ends wins.

**Prize pool.** Each seat's entry fee goes into the pool. The platform keeps 15% and the rest is split by finishing position: ${shares}. Lower positions get no prize.

Prize coins are added to your balance automatically when the match ends. ${NO_CASH}

**Ties.** Players who finish with exactly the same P&L (to the cent) share the prize and rating change of the positions they occupy. Solo Ranked has no ties: if you tie with an AI, you win.`,
    },
    {
      slug: 'disconnects',
      title: 'Disconnects and leaving a match',
      category: 'rules',
      tags: ['disconnect', 'disconnected', 'lost connection', 'reconnect', 'forfeit', 'left match', 'match ended'],
      body: `You can leave the game screen during a match to visit other pages, like Settings or Home. The match keeps running and your open trades stay open. A live match card shows your P&L and open trades on those pages, with **Continue match** and **Forfeit** buttons. You can't start another match until this one ends or you forfeit it.

If you leave the site completely or lose connection, you have **${RECONNECT_GRACE_SECONDS} seconds** to come back. Open the site again and tap Continue match on the card.

If you do not come back within ${RECONNECT_GRACE_SECONDS} seconds, it counts as a forfeit:
- all your open positions are closed,
- you are placed last,
- in ranked modes you get the last-place rating change (${sign(baseRatingForPosition(4, 4))}),
- the match carries on for everyone else.

Tapping Forfeit has the same result.`,
    },
    {
      slug: 'rating-and-tiers',
      title: 'War Rating, tiers and experience levels',
      category: 'progression',
      tags: ['rating', 'war rating', 'elo', 'tier', 'rank', 'ranking', 'experience level', 'war lord'],
      body: `**Ratings.** Ranked matches change your rating by finishing position. In a 4-player match: ${ratingTable4}. In a 6-player match: ${ratingTable6}. You get 5 extra points for a gain if your opponents were rated higher on average, and lose 5 more on a loss if they were rated lower.

Only ranked modes change a rating: ${MODE_ORDER.filter((k) => MATCH_MODES[k].ranked).map((k) => `${MATCH_MODES[k].label} (${MATCH_MODES[k].ratingKey === 'war_rating' ? 'War Rating' : MATCH_MODES[k].ratingKey === 'grand_war_rating' ? 'Grand War rating' : 'Solo rating'})`).join(', ')}. ${MODE_ORDER.filter((k) => !MATCH_MODES[k].ranked).map((k) => MATCH_MODES[k].label).join(', ')} do not change any rating. Long-form competitions also adjust your War Rating when they settle.

**Tiers** come from your War Rating:
${TIERS.map((t) => `- ${t.name}: ${t.max === Infinity ? `${t.min.toLocaleString('en-US')}+` : `${t.min.toLocaleString('en-US')}-${t.max.toLocaleString('en-US')}`}`).join('\n')}

**Experience level** comes from your total matches played:
${EXPERIENCE_LEVELS.map((l) => `- ${l.label}: ${l.max === Infinity ? `${l.min}+` : `${l.min}-${l.max}`} matches`).join('\n')}`,
    },
    {
      slug: 'competitions',
      title: 'Competitions: daily, weekly, weekend and monthly',
      category: 'competitions',
      tags: ['competition', 'daily war', 'weekly war', 'weekend blitz', 'monthly grand', 'coming soon', 'notify me', 'waitlist', 'entry', 'settlement', 'leaderboard', 'bot', 'EA', 'expert advisor', 'automated trading', 'AI'],
      body: `The Daily, Weekly, Weekend and Monthly competitions are **coming soon**. They are being rebuilt as free-to-enter competitions with cash prizes paid by a competition partner (see "Competition prizes: who pays and how").

**Coming soon**
- A coming soon card cannot be entered yet. Tap **Notify me** and we email you once when it opens, plus a short confirmation now. You can leave the list from the competition's page.
- Each competition has its own page (for example /competitions/daily) with how it works, times in your own timezone, the prize and the rules.
- Nobody can say exactly when they open until the partner and prize are confirmed. The card shows the planned rhythm, like "Every weekday" or "One weekend a month".
- There is no other daily, weekly, weekend or monthly event to enter in the meantime. The game modes (Quick, Blitz, Grand, Solo, Async, Private and Tournament War) are open any time and pay coins.

**Runs that were already going**
Only a run that a player had already entered before the change keeps going, and it finishes as a coin event under its old rules. No new coin runs are being scheduled. ${NO_CASH} The old details, for players asking about a run they are already in:

${['daily', 'weekly', 'weekend', 'monthly'].map(compTemplateBlock).join('\n\n')}

**How a run works (both kinds)**
- One account with ${money(rules.STARTING_CAPITAL)} of virtual capital, with the same leverage, margin rules and position limit as matches. Your account lives between sessions.
- Ranking is by equity at the end. Ties are broken by fewer trades, then by who entered first.
- Reaching the ${STOP_OUT_LEVEL}% margin level closes your biggest losers first. Your account stays open.
- You can enter more than one competition at a time, for example the Daily and the Weekly.

**Bots, EAs and AI are not allowed.** Every trade in a competition must be placed by the player by hand: no AI, bots, EAs (expert advisors), scripts or automated trading. We review trading patterns, and accounts that trade automatically are removed and lose any prize.`,
    },
    {
      slug: 'competition-prizes',
      title: 'Competition prizes: who pays and how',
      category: 'competitions',
      tags: ['cash prize', 'prize pool', 'real money', 'win money', 'payout', 'partner', 'free entry', 'verified', 'bots', 'EA', 'AI'],
      body: `There are two kinds of prize on Spike & Crush, and they never mix.

**Game modes pay coins.** Quick, Blitz, Grand, Solo, Async, Private and Tournament War pay coins. ${NO_CASH}

**"Hosted by" competitions** are different again: a partner runs them on the partner's own site, and the partner sets the prize and the rules. Spike & Crush only lists them; the "Compete on" button opens the partner's site in a new tab, and you sign up and trade there.

**Some competitions have a cash prize.** The Daily, Weekly, Weekend and Monthly competitions will be cash prize competitions played here on Spike & Crush, on our own trading screen. When a competition card says "Cash prizes" or shows a prize pool:
- Entry is always free. It never costs coins or money.
- The prize is paid in money by the competition partner named in that competition's terms, not by Spike & Crush.
- To be paid, a winner verifies their identity with the partner and completes the partner's payout form. Spike & Crush never asks for bank or card details, and support cannot pay out or speed up a prize.
- Rules: a verified profile, one account per player, and every trade placed by you: no AI, bots or EAs. We review trading patterns. Accounts that trade automatically are removed and lose any prize.
- Coins and cash prizes are separate: coins never become a cash prize, and a cash prize is never paid in coins.

These competitions are coming soon. The full rules are in the Terms, under Competition Prizes (/terms#competition-prizes).

If a player asks about a specific prize payment, the partner named in the competition's terms handles it. If they cannot reach the partner, offer a human agent.`,
    },
    {
      slug: 'sponsors',
      title: 'Sponsors: "Sponsored", "Presented by" and "Hosted by" partner competitions',
      category: 'competitions',
      tags: ['sponsor', 'sponsored', 'presented by', 'hosted by', 'hosted by another company', 'my email', 'my username', 'personal data', 'share my data', 'partner competition', 'compete on', 'other site', 'partner', 'advert', 'ad', 'logo', 'privacy', 'advertise', 'partnership', 'business'],
      body: `Spike & Crush is supported by sponsors.

**Do sponsors get my details? No.** Sponsors never receive a player's username, email, account, IP address or any personal data. They only get totals, such as how many times a placement was shown or clicked.

- Anything a sponsor pays for is labelled **Sponsored** or **Presented by**.
- Sponsors never change prices, charts, results, rankings or rules. During a match a sponsor can only appear as a small "Presented by" chip next to the mode name on wide screens and a short text tag at the end of the spike strip. Never on the chart, the price scale, the order ticket, the Modify panel or the card tray, and never as a pop-up.
- **Hosted by** means another company (a partner) runs that competition on its own site, not on Spike & Crush. The partner sets the prize and the rules. The "Compete on" button opens the partner's site in a new tab; players sign up and trade there, under the partner's terms.
- Links to sponsors carry a tag saying the visit came from Spike & Crush, with nothing about the player.
- A sponsor showing a broker or prop firm is not advice to trade with real money.

Players can't turn sponsors off individually. If a placement looks wrong or covers something, ask them for a screenshot and offer a human agent.

**Businesses** interested in sponsoring can use the Sponsor page on the site or ask for a human agent, who will pass the enquiry to the team. You can also email ${CONTACT_EMAIL}.`,
    },
    {
      slug: 'replays',
      title: 'Market data and replays',
      category: 'competitions',
      tags: ['replay', 'historical data', 'market data', 'real prices', 'session'],
      body: `All prices in Spike & Crush are real historical market data, replayed. They are not live market prices.

- **Matches** replay a window of history for the match's instruments.
- **Competitions** replay real market history on a competition clock, normally at real-time speed. The play screen shows which trading session that moment belongs to (Asian, London, London / New York, New York).
- **Match replays**: finished matches can be watched again from the replay page, and short clips can be shared.`,
    },
    {
      slug: 'sabotage-cards',
      title: 'Sabotage cards and abilities',
      category: 'cards',
      tags: ['cards', 'sabotage', 'abilities', 'deck', 'freeze', 'news bomb'],
      body: `You hold up to ${F.cards.handSize} cards at once. You are dealt cards at the start of a match (how many depends on the mode and your rank, never more than ${F.cards.handSize}), and you **earn more by winning trades in a row**: see "Earning cards, streaks and Heat". Each card can be played once. Only cards you have unlocked are ever dealt or earned; new players start with ${progressionRules.BASIC_DECK.length} starter cards and unlock the rest by playing (see "Levels, ranks and card unlocks"). You can save a deck of up to 5 unlocked cards on the Cards page.

**How to play one:** tap the card, then pick a player from the live ranking (search, or tap Random, Leader, Above me or Below me). Defensive cards play at once on yourself. Every card changes something real: your rival's spread, fills, stop loss, take profit, trade size, how often they can trade, or their banked profit.

**Protection:** a player hit by a card is protected for ${F.cards.hitShieldSeconds} seconds. A player can have only one timed card effect on them at a time. Shielded and offline players can't be targeted. No card can take a player below ${Math.round(F.cards.floorPctOfCapital * 100)}% of the starting capital in one hit.

There are ${Object.keys(CARDS).length} cards:
${cardList}

Card variants (silver, gold) from the shop are cosmetic only. Coins never buy a card.`,
    },
    {
      slug: 'earned-cards-heat',
      title: 'Earning cards, streaks and Heat',
      category: 'cards',
      tags: ['streak', 'heat', 'earn cards', 'new card', 'killstreak', 'refill', 'qualifying win'],
      body: `Win trades in a row to earn cards. A **qualifying win** is a closed trade with a profit of at least ${(F.cards.minWinPctOfCapital * 100).toFixed(1)}% of your starting capital, held at least ${F.cards.minHoldSeconds} seconds. Your **streak** counts qualifying wins since your last losing close; a losing close resets it to 0 but you keep the cards you hold.

Rewards: streak 1: +${F.cards.streakRewards[1]} card, streak 2: +${F.cards.streakRewards[2]}, streak 3: +${F.cards.streakRewards[3]}, streak ${F.cards.refillAtStreak}: every empty slot is refilled, then +${F.cards.perWinAfterRefill} for each further win. With a full hand an extra card becomes Heat instead. Limits: ${F.cards.maxCardsPerMinute} cards a minute, ${F.cards.maxCardsPerMatch} a match.

**Heat** is a separate score on the result screen: each qualifying win adds Heat times your streak multiplier (${F.heat.multipliers.map((m) => `x${m}`).join(', ')}). Heat never changes your P&L, rank, prizes or rating.

**Crown:** the match leader wears the crown. Overtaking the leader earns one card (Dethrone, at most once a minute), and hitting the leader with a card earns Heat.`,
    },
    {
      slug: 'missions-and-spikes',
      title: 'Quick missions and spike alerts',
      category: 'matches',
      tags: ['missions', 'quick missions', 'spike', 'spike alert', 'alert', 'countdown'],
      body: `**Quick missions:** each match shows two small missions above the chart (for example "Hold a trade for 60 seconds" or "Close two trades in profit"). Finishing one pays ${F.missions.coinsPerMission} coins, at most ${F.missions.perMatchCoinCap} a match and ${F.missions.perDayCoinCap} a day. Tiny trades don't count.

**Spike alerts:** before a real big move in the market data, the strip above the chart shows "Spike incoming in ${F.spikeAlerts.leadDataSeconds}s". It never says which way or how big, and it never covers the chart. After the move it shows the real change for a few seconds. Alerts only come from real moves in the historical data: nothing is invented.`,
    },
    {
      slug: 'market-speed',
      title: 'The live market and the MARKET badge',
      category: 'matches',
      tags: ['market', 'flat', 'quiet', 'speed', 'market x', 'badge', 'replay', 'not moving'],
      body: `Matches replay real market data, chosen from the busiest stretches of each instrument so the price keeps moving in every match. Only the most active instruments are offered. Every player in a match sees exactly the same prices.

If a mode ever replays the market faster than real time, a small "MARKET x2" (or similar) badge shows the real multiplier next to the clock. The clock always shows real match time. Right now every mode plays at 1x.`,
    },
    {
      slug: 'levels-unlocks',
      title: 'Levels, ranks and card unlocks',
      category: 'cards',
      tags: ['level', 'xp', 'unlock', 'locked card', 'rank', 'warlord', 'trader', 'benefits', 'collection'],
      body: `You earn XP by playing: finishing matches, wins and podiums, qualifying wins, your best streak, missions and profit (capped per match at ${F.progression.xp.perMatchCap} XP and per day at ${F.progression.xp.perDayCap} XP). Matches left in the first minute and solo practice give no XP. XP raises your **level** (1 to ${F.progression.levelThresholds.length}); levels unlock cards. Unlocks come only from playing - coins never buy a card.

Your **rank** is your rating tier (Recruit, Trader, Broker, Analyst, Veteran, Elite, War Lord). Higher ranks start matches with extra cards and unlock cosmetics. See the Rank page and the Card collection for exactly what unlocks each card.`,
    },
    {
      slug: 'ghost-challenge',
      title: 'Ghost challenges and rematches',
      category: 'matches',
      tags: ['challenge', 'ghost', 'share', 'beat my score', 'rematch', 'same market'],
      body: `On the result screen, **Challenge a friend** makes a link (valid ${F.ghostChallenge.expiryDays} days) to the exact market you just played: the same instruments and the same seconds of price. Your friend plays it and sees your result to beat. Challenges are free, unranked and don't count as wins or losses. **Rematch** opens a private room and invites everyone from your match who is still online.`,
    },
    {
      slug: 'discover-privacy',
      title: 'Discover players and privacy',
      category: 'social',
      tags: ['discover', 'find players', 'online', 'appear offline', 'privacy', 'location', 'suggested', 'block', 'report'],
      body: `Discover shows your friends who are online, other players live now, open rooms you can still join, and suggestions. We never show anyone's location.

Privacy settings (Settings, Privacy): appear offline, who can see your status, who can see what you're playing, whether you appear in Discover, who can send you friend requests, and whether others can join your open match. Changes apply at once. Block or report anyone from their row; blocked players disappear from your lists and can't invite you. Suggestions may use the country you picked in Settings to show players near you; it is never shown to anyone.`,
    },
    {
      slug: 'coins',
      title: 'Coins: how to earn and spend them',
      category: 'coins',
      tags: ['coins', 'balance', 'earn', 'spend', 'welcome bonus', 'where are my coins', 'missing coins'],
      body: `Coins are the in-game currency.

**Earn coins:** welcome bonus on a new account, match prizes, competition and tournament prizes, Battle Pass challenges and tiers.
**Spend coins:** match and competition entry fees, the cosmetic shop, tournament entry.
**Invite friends:** earn coins when a friend you invite plays (see "Invite friends and earn coins").

Every change to your balance is listed in your coin history on the Wallet page, with the reason (entry fee, prize, shop and so on).

${NO_CASH} They exist only for use inside the game.`,
    },
    {
      slug: 'no-cash-value',
      title: 'Withdrawals and cashing out (coins have no cash value)',
      category: 'coins',
      tags: ['withdraw', 'withdrawal', 'cash out', 'real money', 'payout', 'bank', 'crypto', 'redeem', 'convert'],
      body: `${NO_CASH}

There are no withdrawals of any kind: not for coins won in matches, tournaments or competitions, and not for coins you bought. Prizes are coins only. There is no cash prize path.`,
    },
    {
      slug: 'buying-coins',
      title: 'Buying coins and Premium',
      category: 'coins',
      tags: ['buy coins', 'purchase', 'payment', 'price', 'charged', 'refund', 'card', 'top up', 'get coins', 'premium'],
      body: `Coins and Battle Pass Premium are not on sale right now. We are not taking any payments, so no card is needed and nothing can be charged.

To get more coins: win matches, finish daily and weekly challenges, reach Battle Pass tiers, or invite friends (see "Invite friends and earn coins").

If a charge from us appears on your statement, ask for a human agent and do not share your card number in chat. ${NO_CASH}`,
    },
    {
      slug: 'battle-pass',
      title: 'Battle Pass',
      category: 'progression',
      tags: ['battle pass', 'season', 'xp', 'challenges', 'premium', 'subscription', 'cancel', 'cancel subscription'],
      body: `The Battle Pass runs in seasons of ${battlepass.SEASON_DAYS} days with tiers you unlock with XP (${battlepass.XP_PER_TIER} XP per tier). Matches give XP and daily and weekly challenges give XP and coins.

Everyone has the free track. There is also a Premium track with extra cosmetics and coins, but Premium is not on sale right now, so there is nothing to subscribe to or cancel and no one is being charged.

Tiers cannot be bought directly.`,
    },
    {
      slug: 'shop',
      title: 'The shop',
      category: 'coins',
      tags: ['shop', 'cosmetics', 'avatar frame', 'background', 'nameplate', 'card variant', 'equip'],
      body: `The shop sells cosmetic items for coins:
- Card variants: ${cat.cardVariants.length} items
- Avatar frames: ${cat.avatarFrames.length} items
- Profile backgrounds: ${cat.profileBackgrounds.length} items
- Nameplate effects: ${cat.nameplateEffects.length} items

Cosmetics are visual only and never change gameplay. Equip them from the shop or your profile. Shop purchases are spent coins and are not refundable.`,
    },
    {
      slug: 'friends-spectating-private',
      title: 'Friends, spectating and private matches',
      category: 'social',
      tags: ['friends', 'friend request', 'invite', 'spectate', 'watch', 'private war', 'room code', 'block'],
      body: `- **Friends:** tap the Friends icon at the top of the page. Search a username or pick someone under Players online, then send a friend request. They can accept or reject it. Friends see when you are online or in a match, and can join your lobby or watch your matches.
- **Match invites:** any player online can invite you to a match, and you can accept, decline or block them. To limit this, go to Settings, Privacy and turn off "Allow match invites from anyone". You can also hide your online status or stop friend requests there.
- **Invites** to a lobby expire after 60 seconds if not answered.
- **Spectating:** you can watch live matches from the spectate page. Private matches can only be watched by their own players.
- **Private War:** create a room and share the 6-digit room code. The host pays ${coins(PRIVATE_WAR_HOST_FEE)} when the match starts; invited players join free.
- **Blocking:** blocked players are managed in Settings, Privacy.`,
    },
    {
      slug: 'invite-friends',
      title: 'Invite friends and earn coins',
      category: 'social',
      tags: ['invite', 'invite link', 'referral', 'refer a friend', 'earn coins', 'free coins', 'friend bonus', 'referral reward'],
      body: `Share your invite link and earn ${INVITE_REWARD_COINS} coins for each friend who joins and plays. Find your link on the Wallet page under Invite friends.

**When you get paid:** when your friend finishes their first match against at least one other real player. Your friend has to stay until the end and make at least one trade. Until then the invite shows as waiting.

**The rules:**
- Your friend must create a new account after opening your link, within 30 days. Existing accounts cannot be added later.
- The reward goes to the inviter. The friend gets the normal welcome coins.
- You can be paid for up to ${INVITE_MAX_PAID} invites.
- Inviting yourself with extra accounts is abuse, and coins can be removed.

${NO_CASH}`,
    },
    {
      slug: 'referrals-partners',
      title: 'Partner referral links',
      category: 'social',
      tags: ['partner', 'broker', 'affiliate', 'prop firm', 'creator', 'code'],
      body: `Partner referral links look like spikeandcrush.com/r/CODE. Opening one remembers the partner for 30 days, and if you sign up in that time your new account is credited to that partner.

These links are for partners (brokers, prop firms, creators). To invite friends and earn coins, use your own invite link instead (see "Invite friends and earn coins").

For partner or business enquiries, ask for a human agent or email ${CONTACT_EMAIL}.`,
    },
    {
      slug: 'discord',
      title: 'Linking Discord',
      category: 'account',
      tags: ['discord', 'link discord', 'member role', 'server', 'community'],
      body: `Link Discord from **Settings**:
1. Open Settings and choose Connect Discord.
2. Approve access on Discord (Spike & Crush asks for your Discord identity and permission to add you to the server).
3. You are added to the Spike & Crush Discord server and given the Member role automatically.

If it fails you are sent back to Settings with an error. Try again, and make sure you are signed in to the right Discord account. If the role is still missing, a human agent can check.`,
    },
    {
      slug: 'notifications',
      title: 'Notifications',
      category: 'account',
      tags: ['notifications', 'bell', 'alerts', 'email'],
      body: `The bell at the top of the site shows your notifications, and they are saved so they are there after a reload or on another device. You get notifications for friend requests and invites, friends' wins, competitions starting, ending soon and ending, loss limit hits in competitions, shop purchases, invite rewards, Battle Pass and support replies.

Notification preferences (for example friends' wins) are in Settings.`,
    },
    {
      slug: 'mobile',
      title: 'Playing on mobile and landscape mode',
      category: 'technical',
      tags: ['mobile', 'phone', 'app', 'landscape', 'portrait', 'tablet', 'browser'],
      body: `Spike & Crush runs in your mobile browser. There is no separate app to install.

- In portrait, the match screen switches between the Chart and the Trade panel with a toggle.
- Turn your phone to landscape for a wider chart with the trading panel alongside it.
- When logged in on a phone, a tab bar at the bottom links to Home, Ranks, Play, Compete and your profile.

If the page looks wrong, refresh it and make sure your browser is up to date.`,
    },
    {
      slug: 'account-signup-login',
      title: 'Account: sign up, log in and password reset',
      category: 'account',
      tags: ['sign up', 'register', 'login', 'log in', 'google', 'apple', 'password', 'reset password', 'forgot password', 'email', '2fa', 'two factor', 'change username', 'username'],
      body: `- **Sign up** with email and password, or continue with Google. Sign in with Apple is not available.
- **Verify your email:** after signing up with an email and password, click the link we email you, then log in. The link works for 24 hours. If it expired or never arrived, check spam, then try to log in and choose "Send it again". Google sign-ins don't need this.
- **Forgot your password?** Use "Forgot password" on the login screen and enter your email. If an account exists for that email, a reset link is sent. Follow the link to set a new password.
- **Two-factor authentication** can be turned on in Settings, Security.
- **Sessions and login history** are in Settings, Security, where you can sign other devices out.
- **Changing your username, email or password** is done in Settings, and needs your current password.`,
    },
    {
      slug: 'account-deletion',
      title: 'Deleting your account and data requests',
      category: 'account',
      tags: ['delete account', 'deletion', 'close account', 'gdpr', 'data', 'privacy', 'remove my data'],
      body: `You can delete your account from **Settings**, in the Delete Account section. Deletion is permanent and removes your player record and sign-in.

- If you sign in with a password, confirm with your password.
- If you sign in with Google, confirm by typing your username.

For any other data request (a copy of your data, corrections), ask for a human agent. Support will create a ticket and the team will handle it.`,
    },
    {
      slug: 'fair-play',
      title: 'Fair play, reports and bans',
      category: 'safety',
      tags: ['cheating', 'report', 'report player', 'ban', 'banned', 'suspended', 'appeal', 'harassment', 'fair play'],
      body: `- **Reporting a player:** tap **Report** on the player's row in Discover (or ask for a human agent in this chat and give the player's username and what happened). Reports go to the moderation team. You can also **Block** a player there: they disappear from your lists and can't invite you.
- **Harassment or safety concerns:** tell support and ask for a human. These are always passed to the team.
- **Bans and suspensions** are decided by the team. A banned account cannot log in or play while the ban lasts, but can still use this support chat. Support (including this assistant) cannot ban, unban or change a ban. If you want to appeal, ask for a human agent and a ticket will be opened.`,
    },
    {
      slug: 'contact',
      title: 'Contacting the team',
      category: 'support',
      tags: ['contact', 'email', 'human', 'agent', 'ticket', 'support'],
      body: `You can reach a human by choosing **Talk to a human** in this chat at any time. A ticket is created and an agent replies here. You will also get an email.

You can also email ${CONTACT_EMAIL}.

Support can explain rules, look up your own account, matches and coin history, and open tickets. Only the team can change accounts, coins, bans or results.`,
    },
  ];
}

function toMarkdown(article) {
  const front = [
    '---',
    `slug: ${article.slug}`,
    `title: ${JSON.stringify(article.title)}`,
    `category: ${article.category}`,
    `tags: [${article.tags.map((t) => JSON.stringify(t)).join(', ')}]`,
    `source: code`,
    `needs_review: ${Boolean(article.needsReview)}`,
    '---',
  ].join('\n');
  return `${front}\n\n# ${article.title}\n\n${article.body}\n`;
}

module.exports = { buildArticles, toMarkdown, NO_CASH, CONTACT_EMAIL };
