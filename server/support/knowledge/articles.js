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
const { COIN_PACKAGES, BATTLE_PASS_PRICE_USD } = require('../../coinPackages');

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
  const lossFloor = rules.STARTING_CAPITAL * (1 - rules.HARD_LOSS_PCT);
  const ratingTable4 = [1, 2, 3, 4].map((p) => `${ordinal(p)}: ${sign(baseRatingForPosition(p, 4))}`).join(', ');
  const ratingTable6 = [1, 2, 3, 4, 5, 6].map((p) => `${ordinal(p)}: ${sign(baseRatingForPosition(p, 6))}`).join(', ');
  const shares = Object.entries(PRIZE_SHARE_BY_RANK).map(([r, s]) => `${ordinal(Number(r))}: ${pct(s)}`).join(', ');
  const cat = shop.getCatalog();
  const cardList = Object.values(CARDS)
    .map((c) => `- **${c.name}** (${c.category}${c.targeted ? ', targets an opponent' : ''}): ${c.description}`)
    .join('\n');
  const packages = Object.values(COIN_PACKAGES).map((p) => `- ${p.coins.toLocaleString('en-US')} coins: $${p.priceUsd.toFixed(2)}`).join('\n');

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
      title: 'Starting capital, lot limits and open positions',
      category: 'rules',
      tags: ['starting capital', 'lot limit', 'max lots', 'max positions', 'rules', 'limits'],
      body: `Every match uses the same core rules:

- Starting capital: ${money(rules.STARTING_CAPITAL)} (virtual, resets every match)
- Maximum size per trade: ${rules.MAX_LOTS} lots (some instruments have a lower maximum of their own; the lower one applies)
- Maximum open positions at once: ${rules.MAX_POSITIONS}

Long-form competitions use the same starting capital, lot limit and position limit.`,
    },
    {
      slug: 'loss-limits',
      title: 'Loss limits: the 50% max loss rule and the 2-minute lock',
      category: 'rules',
      tags: ['max loss', 'loss limit', 'eliminated', 'margin call', 'auto close', '50%', 'locked', 'lockout'],
      body: `There are two loss limits in a match.

**Hard limit (${pct(rules.HARD_LOSS_PCT)} max loss).** If your equity falls to ${pct(rules.HARD_LOSS_PCT)} below your starting capital (${money(lossFloor)} or less from ${money(rules.STARTING_CAPITAL)}), all your open positions are closed automatically and you are eliminated from trading for the rest of that match. You get a warning when you are down 40%.

**Soft limit (2-minute lock).** If you lose ${pct(SOFT_LOSS_PCT)} of starting capital within one ${minutes(SOFT_LOSS_WINDOW_SECONDS)} window, you cannot open new trades until the next window starts. Windows run every ${minutes(SOFT_LOSS_WINDOW_SECONDS)} from the start of the match.

In long-form competitions, reaching the ${pct(rules.HARD_LOSS_PCT)} loss locks the account at its final equity for the rest of the competition.

There is no separate margin call or leverage setting; the loss limits above are what protect your account. (Margin Call is also the name of a sabotage card, which closes a target's open positions.)`,
    },
    {
      slug: 'leverage',
      title: 'Leverage and margin',
      category: 'rules',
      tags: ['leverage', 'margin', 'margin call'],
      body: `The game does not use a leverage setting. Position size is controlled by lot size (up to ${rules.MAX_LOTS} lots per trade) and risk is capped by the loss limits: a ${pct(SOFT_LOSS_PCT)} loss within ${minutes(SOFT_LOSS_WINDOW_SECONDS)} pauses new trades, and a ${pct(rules.HARD_LOSS_PCT)} total loss ends your trading for the match.`,
    },
    {
      slug: 'game-modes',
      title: 'Game modes and match durations',
      category: 'modes',
      tags: ['modes', 'duration', 'how long', 'quick war', 'blitz', 'grand war', 'solo', 'async', 'private', 'tournament', 'entry fee'],
      body: `| Mode | Match length | Entry | Players | Cards | Ranked |
|---|---|---|---|---|---|
${MODE_ORDER.map(modeRow).join('\n')}

- **${MATCH_MODES.quick.label}**: the standard match. Empty seats are filled with AI opponents.
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

**Prize pool.** Each seat's entry fee goes into the pool (AI-filled seats count as paid seats so a win pays fairly). The platform keeps 15% and the rest is split by finishing position: ${shares}. Lower positions get no prize. AI opponents never receive coins.

Prize coins are added to your balance automatically when the match ends. ${NO_CASH}

**Ties.** Players who finish with exactly the same P&L (to the cent) share the prize and rating change of the positions they occupy. Solo Ranked has no ties: if you tie with an AI, you win.`,
    },
    {
      slug: 'disconnects',
      title: 'Disconnects and leaving a match',
      category: 'rules',
      tags: ['disconnect', 'disconnected', 'lost connection', 'reconnect', 'forfeit', 'left match', 'match ended'],
      body: `If you lose connection during a match, you have **${RECONNECT_GRACE_SECONDS} seconds** to reconnect. Open the same match again and you continue where you were.

If you do not reconnect within ${RECONNECT_GRACE_SECONDS} seconds, it counts as leaving the match (a forfeit):
- all your open positions are closed,
- you are placed last,
- in ranked modes you get the last-place rating change (${sign(baseRatingForPosition(4, 4))}),
- the match carries on for everyone else.

Leaving a match on purpose has the same result.`,
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
- You pay the entry fee once and get one account with ${money(rules.STARTING_CAPITAL)}, the same lot and position limits as matches.
- Your account lives between sessions, so closing the page changes nothing.
- Ranking is by equity at the end. Ties are broken by fewer trades, then by who entered first.
- Losing ${pct(rules.HARD_LOSS_PCT)} locks your account at its final equity.
- When a competition ends it is settled: final ranks are set, prize coins are credited automatically, and your War Rating is adjusted by your finishing position. Disqualified accounts get no rank or prize.
- An admin can set different prizes for a specific event; the competition page shows the real prizes for that event.

${NO_CASH} Competition prizes are coins only.`,
    },
    {
      slug: 'replays',
      title: 'Market data and replays',
      category: 'competitions',
      tags: ['replay', 'historical data', 'market data', 'real prices', 'session'],
      needsReview: true,
      body: `All prices in Spike & Crush are real historical market data, replayed. They are not live market prices.

- **Matches** replay a window of history for the match's instruments.
- **Competitions** replay real market history on a competition clock. The play screen shows which trading session that moment belongs to (Asian, London, London / New York, New York).
- **Match replays**: finished matches can be watched again from the replay page, and short clips can be shared.

(Marked for review: the exact replay speed per competition is set per event.)`,
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
**Buy coins:** coin packages on the Wallet page (see "Buying coins").

Every change to your balance is listed in your coin history on the Wallet page, with the reason (entry fee, prize, purchase, shop and so on).

${NO_CASH} They exist only for use inside the game.`,
    },
    {
      slug: 'no-cash-value',
      title: 'Withdrawals and cashing out (coins have no cash value)',
      category: 'coins',
      tags: ['withdraw', 'withdrawal', 'cash out', 'real money', 'payout', 'bank', 'crypto', 'redeem', 'convert'],
      body: `${NO_CASH}

There are no withdrawals of any kind: not for coins won in matches, tournaments or competitions, and not for coins you bought. Prizes are coins only. There is no cash prize path.

Coin purchases are final.`,
    },
    {
      slug: 'buying-coins',
      title: 'Buying coins and payments',
      category: 'payments',
      tags: ['buy coins', 'purchase', 'payment', 'stripe', 'price', 'charged', 'refund', 'card'],
      body: `Coin packages are sold on the Wallet page and paid through Stripe:
${packages}

Coins are added to your balance after Stripe confirms the payment. The purchase then appears in your coin history.

If you were charged but did not get your coins, a human agent needs to check the payment. Support can open a ticket for this, but cannot add coins or issue refunds itself. Never share your full card number in chat.

${NO_CASH}`,
    },
    {
      slug: 'battle-pass',
      title: 'Battle Pass',
      category: 'progression',
      tags: ['battle pass', 'season', 'xp', 'challenges', 'premium', 'subscription', 'cancel'],
      body: `The Battle Pass runs in seasons of 30 days with tiers you unlock with XP (${battlepass.XP_PER_TIER} XP per tier). Matches give XP and daily and weekly challenges give XP and coins.

Everyone has the free track. Premium costs $${BATTLE_PASS_PRICE_USD.toFixed(2)} a month (Stripe subscription) and unlocks a second track with extra cosmetics and coins. It renews monthly until you cancel it from the Wallet page. Rewards you already claimed stay yours.

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
- **Spectating:** you can watch live matches from the spectate page.
- **Private War:** create a room and share the 6-digit room code. The host pays ${coins(PRIVATE_WAR_HOST_FEE)} when the match starts; invited players join free.
- **Blocking:** blocked players are managed in Settings, Privacy.`,
    },
    {
      slug: 'referrals-partners',
      title: 'Referrals and partners',
      category: 'social',
      tags: ['referral', 'partner', 'broker', 'affiliate', 'link', 'code'],
      needsReview: true,
      body: `Partner referral links look like spikeandcrush.com/r/CODE. Opening one remembers the partner for 30 days, and if you sign up in that time your new account is credited to that partner.

The referral programme is for partners (brokers, prop firms, creators). For partner or business enquiries, ask for a human agent or email ${CONTACT_EMAIL}.

(Marked for review: player-to-player referral rewards are not described in the code.)`,
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
      body: `The bell at the top of the site shows your notifications, and they are saved so they are there after a reload or on another device. You get notifications for friend requests and invites, friends' wins, competitions starting, ending soon and ending, loss limit hits in competitions, shop and coin purchases, Battle Pass, coaching bookings and support replies.

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
      tags: ['sign up', 'register', 'login', 'log in', 'google', 'apple', 'password', 'reset password', 'forgot password', 'email', '2fa', 'two factor'],
      body: `- **Sign up** with email and password, or continue with Google. Sign in with Apple is not available.
- **Forgot your password?** Use "Forgot password" on the login screen and enter your email. If an account exists for that email, a reset link is sent. Follow the link to set a new password.
- **Two-factor authentication** can be turned on in Settings, Security.
- **Sessions and login history** are in Settings, Security, where you can sign other devices out.
- **Username changes** are not supported after registration.`,
    },
    {
      slug: 'account-deletion',
      title: 'Deleting your account and data requests',
      category: 'account',
      tags: ['delete account', 'deletion', 'close account', 'gdpr', 'data', 'privacy', 'remove my data'],
      needsReview: true,
      body: `You can delete your account from **Settings**. You must confirm with your password. Deletion is permanent and removes your player record and sign-in.

If you signed up with Google and have no password, or for any other data request (a copy of your data, corrections), ask for a human agent. Support will create a ticket and the team will handle it.

(Marked for review: Google-only accounts cannot pass the password check in the self-service delete.)`,
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
      body: `- **Reporting a player:** use the report option on their profile or on the match results screen.
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
