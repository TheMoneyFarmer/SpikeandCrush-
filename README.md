# Spike & Crush

Competitive multiplayer trading game. Traders battle in real time on simulated EURUSD and XAUUSD price action, with sabotage cards to disrupt opponents, over a 10-minute match. Built with Express, Socket.io, and Supabase.

## Requirements

- Node.js 18+
- A Supabase project (URL + anon key + service_role key)
- (Optional) Stripe account in test mode, for coin purchases

## 1. Install dependencies

```bash
cd spikecrush
npm install
```

## 2. Configure environment

Copy your credentials into `.env` (already scaffolded in this repo):

```
PORT=3000
JWT_SECRET=<any random string>

SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_KEY=<service_role key>   # Dashboard -> Project Settings -> API

STRIPE_SECRET_KEY=<sk_test_...>
STRIPE_PUBLISHABLE_KEY=<pk_test_...>
STRIPE_WEBHOOK_SECRET=<whsec_...>
```

The database schema (`players`, `matches`, `match_players`, `trades`, `sabotage_events`, `coin_purchases`) is expected to already exist in your Supabase project, with Row Level Security enabled. Without `SUPABASE_SERVICE_KEY` set, the server still starts and the landing page loads, but accounts, matches and the leaderboard are disabled (you'll get a clear "Database not configured" error). Without Stripe keys, everything works except coin purchases.

## 3. Start the server

```bash
npm start
```

You should see:

```
[marketData] pre-generated 1000 windows x 600 ticks for: EURUSD, XAUUSD
Spike & Crush server listening on http://localhost:3000
```

## 4. Open the game

Go to **http://localhost:3000** in your browser. Register an account (new players get a 500 coin welcome bonus), then either:

- **Quick Play** (10 coins) — joins the fastest open lobby, or creates one
- **Create Private War** (free) — creates a 6-digit room code lobby
- **Join Private War** — enter a friend's 6-digit code

### Creating a test match to share with friends

1. Log in and click **Create Private War**.
2. On the lobby screen, click **Copy Code** (or **Share Link**) and send it to friends.
3. They open http://localhost:3000 (or your machine's LAN address if testing across devices), log in, and enter the code under **Join Private War**.
4. Each player clicks **Ready**. If the lobby doesn't fill within 45 seconds, remaining slots (up to 4 players) are auto-filled with AI opponents. A 10-second countdown then starts the match.

Matches run for 10 minutes. Positions are auto-closed and War Ratings updated at the end.

## Regenerating the sample historical data files

`data/EURUSD_2022.json` and `data/XAUUSD_2022.json` are illustrative samples. The live server always generates its own 1000 in-memory price windows per instrument at startup (see `server/marketData.js`), so matches never reuse stale data. To regenerate the sample files:

```bash
npm run generate-data
```

## Sabotage cards

Each player is dealt 3 random cards at the start of a match; each card can be played once.

**Information**
- **News Bomb** — injects a fake headline into the target's feed for 15s
- **Chart Ghost** — freezes the target's price display for 10s
- **False Signal** — shows a fake RSI divergence on the target's chart for 20s
- **Smoke Screen** — blurs the leaderboard for everyone for 30s

**Market**
- **Spread Spike** — triples the spread on one instrument for 20s
- **Volatility Surge** — doubles price swing magnitude for 25s
- **Liquidity Drain** — caps max lot size at 0.1 for everyone for 30s
- **Reversal Flash** — forces a sharp 10 pip reversal, then snaps back, over 8s

**Opponent**
- **Position Freeze** — target can't open new trades for 15s
- **Force Close** — force-closes the target's best-performing position at market
- **Capital Drain** — deducts $200 from the target's capital
- **Mirror Trade** — copies your current position onto the target's account

## New pages

Beyond the core lobby/match flow, the app now has:

| Route | Purpose |
|---|---|
| `/wallet` | Coin purchase packages (Stripe), daily loss limit tracker with a midnight countdown, transaction history with CSV export |
| `/cards` | Card collection grid (Standard / Silver at 50 wins / Gold at 200 wins), per-card play stats, deck builder for the upcoming Grand War mode |
| `/settings` | Profile (username/avatar/country/experience/instruments), Game Preferences, Privacy (visibility, online status, friend requests, block list), Security (2FA, login history, active sessions, delete account), Notifications |
| `/leaderboard` | Full leaderboard with All-Time/Week/Month and tier filters, username search, and your own row highlighted |
| `/profile` and `/profile/:username` | Your own editable profile, or a read-only view of another player's public stats |
| `/spectate?matchId=...` | Watch a live match in progress (redacted view, no position data leaked) |

All pages share a common nav bar (`js/nav.js`) with a mobile hamburger drawer, mute toggle, and settings shortcut.

## New chart tools (game screen)

- **Timeframes**: 5s/10s/30s/1m buttons (labelled in the MT5 M1/M5 style, scaled to a 10-minute match)
- **Drawing toolbar**: cursor, crosshair, horizontal line, trend line, rectangle, fibonacci retracement, text annotation, eraser, and a magnet-snap toggle that locks new points to the nearest candle. Horizontal lines render as native price-scale lines; everything else draws on a synced canvas overlay that tracks pan/zoom.
- **Indicators dropdown**: Moving Average (20/50/200, multi-select), Bollinger Bands (20, 2σ), RSI (14) in its own sub-panel, MACD (12/26/9) in its own sub-panel, and a tick-volume histogram (this simulated market has no real order book, so cumulative tick-to-tick price movement stands in for volume, the same convention several retail forex platforms use)
- **Settings gear**: bull/bear candle colors, dark/light background, grid toggle, crosshair style, price-scale side
- **Position lines on chart**: entry/SL/TP shown as dashed price lines; SL and TP are draggable directly on the chart to modify a trade

## New trade management

- **SL/TP entry**: pips or absolute price, quick-pip buttons (10/20/50 for SL, 20/50/100 for TP), a live $ risk and reward:risk display before you click Buy/Sell
- **Modify modal**: "Move to breakeven" (disabled until the position is actually in profit — setting SL to the exact entry price on a position that hasn't moved favorably yet closes it on the very next tick, since a BUY's SL is checked against bid, which sits one spread below the ask it opened at) and a partial-close slider (25/50/75/custom%)
- **Position limits**: raised to 10 open positions and 10 lots per position (from the original 3/5.0)
- **Two-tier risk management**: a 20% soft loss limit that re-checks on a rolling 2-minute window and briefly locks trading if breached, plus a 50% hard loss limit that force-closes every open position and eliminates the player from the match

## Post-match results screen

Black intro screen with a drum roll, then rankings reveal one at a time (4th to 1st) with a gold particle burst and crown for the winner. Each player's card shows medal, tier (with promotion/demotion arrow), P&L in $ and %, trade count, best/worst trade, cards played, and War Rating change. Followed by a personal summary, an equity curve for the match, a replay timeline built from the match feed, and coin rewards by rank (1st: 50, 2nd: 25, 3rd: 10, 4th: 5 — virtual coins only, see below). Actions: Play Again, Share Result, View Full Stats, Back to Lobby.

## Sound

Every effect is generated at runtime via the Web Audio API (oscillators, gain envelopes, noise buffers) — there are no audio files to ship. Covers trade open/close, sabotage cards, match start/end stingers, and UI clicks, with a master/effects/music volume mixer persisted in `js/sound.js`.

## Coins-only economy

Wallet, prize rewards, and the coin store are entirely virtual currency. There is no real-money withdrawal path (bank/PayPal/crypto) — this prototype has no payment-processor KYC integration or real-money tournament mode, so building one would have meant fabricating a compliance story that doesn't exist. Coin purchases still run through real Stripe test-mode checkout.

## Security additions

- **2FA**: TOTP (RFC 6238) implemented from scratch in `server/totp.js` — no external auth service — with QR-code enrollment
- **Sessions**: a `sessions` table layered on top of the stateless JWT (the JWT carries a session id; login/logout/revoke are tracked server-side) plus a login history and an active-sessions list under Settings → Security
- **Block list**: block/unblock other players from Settings → Privacy

## Notes on this build

- **Auth**: the `players` table needed a `password_hash` column (not in the original schema) — added via migration, since real login requires it.
- **Room codes**: `matches.room_code` was added (referenced throughout the matchmaking flow but not in the original column list).
- **Purchase history**: a `coin_purchases` table was added for Stripe purchase records (required by the coin system spec, not in the original table list).
- **AI opponents** (Aggressive Al, Patient Patricia, Chaos Carlos) are rule-based, not LLM-driven — `ANTHROPIC_API_KEY` isn't used anywhere in this build.
- All trade execution, P&L, and sabotage validation is server-authoritative; the client only renders live estimates for responsiveness.
- **Schema additions for the features above**: `players` gained `settings`, `avatar_url`, `country`, `experience_level`, `preferred_instruments`, `totp_secret`, `totp_enabled`, `daily_loss_limit_usd`, `coins_earned_total`, `coins_spent_total`; new tables `sessions`, `login_events`, `card_decks`, `player_blocks`, `coin_transactions`; `matches.winner_id` was changed to `ON DELETE SET NULL` so a past match winner's account can be deleted.
- New dependencies: `multer` (avatar uploads) and `qrcode` (2FA enrollment QR codes).
