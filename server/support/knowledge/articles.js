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
const { TEMPLATES } = require('../../compEngine');
const { CARDS } = require('../../sabotage');
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
  return `| ${m.label} | ${minutes(MODE_DURATIONS[key])} | ${entry} | ${m.minPlayers}-${m.maxPlayers} | ${m.cardsPerPlayer} | ${ranked} |`;
}

function compTemplateBlock(key) {
  const t = TEMPLATES[key];
  const pays = t.payouts.map((p) => `${ordinal(p.rank)}: ${p.coins} coins`).join(', ');
  return `### ${t.title}\n${t.description}\n\n- Entry: ${coins(t.entryFee)}\n- Instruments: ${t.instruments.join(', ')}\n- Default prizes (coins): ${pays}`;
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
    .map((c) => `- **${c.name}** (${c.category}${c.targeted ? ', targets an opponent' : ''}): ${c.description}`)
    .join('\n');

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
- **${MATCH_MODES.grand.label}**: the long mode. You choose your card deck before the match.
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
      tags: ['competition', 'daily war', 'weekly war', 'weekend blitz', 'monthly grand', 'entry', 'prize', 'settlement', 'leaderboard'],
      body: `Competitions are long trading sessions (hours to a month) on one account. Times are UTC.

${['daily', 'weekly', 'weekend', 'monthly'].map(compTemplateBlock).join('\n\n')}

**How they work**
- You pay the entry fee once and get one account with ${money(rules.STARTING_CAPITAL)}, with the same leverage, margin rules and position limit as matches.
- Your account lives between sessions, so closing the page changes nothing.
- Ranking is by equity at the end. Ties are broken by fewer trades, then by who entered first.
- Reaching the ${STOP_OUT_LEVEL}% margin level closes your biggest losers first. Your account stays open.
- When a competition ends it is settled: final ranks are set, prize coins are credited automatically, and your War Rating is adjusted by your finishing position. Disqualified accounts get no rank or prize.
- An admin can set different prizes for a specific event; the competition page shows the real prizes for that event.

${NO_CASH} Competition prizes are coins only.`,
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
      body: `Each player is dealt sabotage cards at the start of a match (how many depends on the mode, see Game modes). Each card can be played once per match. In Grand War you choose your deck before the match.

There are ${Object.keys(CARDS).length} cards:
${cardList}

Card variants (silver, gold) from the shop are cosmetic only.`,
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
      body: `- **Friends:** search for a player and send a friend request. Friends see when you are online or in a match, can invite you to their lobby and can watch your matches.
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
      slug: 'sponsors',
      title: 'Sponsors and "presented by"',
      category: 'business',
      tags: ['sponsor', 'presented by', 'advertise', 'partnership', 'business'],
      body: `Some competitions and lobby placements are "presented by" a sponsor. Sponsors can fund competition prize pools, which are still paid in coins.

Businesses interested in sponsoring can use the Sponsor page on the site or ask for a human agent, who will pass the enquiry to the team. You can also email ${CONTACT_EMAIL}.`,
    },
    {
      slug: 'fair-play',
      title: 'Fair play, reports and bans',
      category: 'safety',
      tags: ['cheating', 'report', 'report player', 'ban', 'banned', 'suspended', 'appeal', 'harassment', 'fair play'],
      body: `- **Reporting a player:** there is no report button yet. Ask for a human agent in this chat and give the player's username and what happened. A human will review it.
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
