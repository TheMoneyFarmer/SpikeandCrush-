# Live market feed (live-data competitions)

## What it does

- `server/liveMarket.js` connects to Coinbase Exchange's public market data (no account, no key): the WebSocket `ticker` channel for every trade, and the REST candles endpoint for history.
- Served today: **BTCUSD, ETHUSD**. Forex, metals, energy, indices and stocks need a licensed live feed and are not served; a live competition drops them and logs why.
- Prices: one per second that traded (72 hours in memory). After a restart the last 50 hours of 1-minute bars are reloaded, so SL/TP and stop-out checks walk any gap (wicks included).
- Health: socket open and every served symbol traded in the last 30 seconds. While unhealthy, a live competition's quotes are "market closed": new trades are blocked, closing still works.
- The game server writes `liveFeed.heartbeatAt` every 15 seconds while healthy (deployed servers only); the admin panel reads it.

## Per competition

`competitions.data_source` decides the prices: `replay` (default, "Demo market data") or `live` ("Live market data"). A replay competition never switches to live prices. Live competitions use real time (no shifted clock), no curated windows, and no spike alerts (the future is unknown).

Daily Open and Weekend Open templates have `data_source = live`. They are scheduled and enterable only when BOTH:
1. `liveFeed.ready` is switched on (Admin > Competitions, super admin), and
2. the feed is healthy (heartbeat under 60 seconds old).

## Turning it on (owner)

1. After the deploy, Admin > Competitions: `liveFeed.healthy()` should read true within a minute.
2. Set `liveFeed.ready` to true.
3. Edit Weekend Open (and Daily Open): partner, hours, then State = Open with a reason.

`LIVE_FEED=off` on Railway disconnects the feed (emergency switch); live competitions then stay closed to new trades.

## Open

- Forex and other classes need a paid or licensed feed (Daily Open is crypto-only live until then).
- More coins (SOL, XRP...) need new instruments; not added, so war matches are unchanged.
- [LEGAL REVIEW] Coinbase's market data terms for showing prices in a product with prizes.
