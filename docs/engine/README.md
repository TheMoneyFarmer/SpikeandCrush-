# Match freeze fix + Action Engine (branch `match-engine`)

## What was wrong (measured 2026-11-16)

**Freeze.**
1. *Proven:* when the clock hit 0:00 the server stopped sending prices, then saved every seat's result one database call after another (computer players included) before sending the end screen. 10 Blitz matches at once: the end screen came about **19 s** after 0:00 with a frozen clock and chart. With a slow database (15 s timeout per call) it could take minutes.
2. *From the code (not reproduced):* the browser socket kept the login token from page load (`io({ auth: { token } })`). Tokens expire after an hour, so any dropped connection after that could never reconnect.
3. *Possible, not verifiable here:* every push to `main` restarts the live server, and live matches only exist in its memory. Railway history was not reachable (CLI not logged in).
4. *Ruled out:* the server stalling mid-match. 10 Blitz + 3 Grand matches at once: event-loop delay p99 about 11-18 ms, price gaps 1.000 s (worst 1.098 s), memory flat.

**Slow charts.** Prices went out once a second and every mode replayed at 1x, so a 1-minute candle took a real minute. The earlier fix (`docs/fire/replay-speed.md`) measured "the price changed at all within 3 seconds", which a sub-pip wiggle passes, and chose "the lowest speed that passes" = 1x everywhere. It never measured motion against what the player sees, and never checked continuity.

## What changed

- **End of match:** `match:resolving` goes out the moment the clock ends ("Time's up. Counting results"); every player's saves run side by side (each player's own steps keep their order and idempotency keys). End screen now 2.0-2.5 s after 0:00 (was ~19 s).
- **Price loop** (`startPriceLoop`, `server/gameEngine.js`): `market.deliveryHz` (default 4) messages a second, aimed at start + n x period (no drift), skips ahead after a late step instead of queueing. Stops and take-profits are checked on every step. Every message carries `seq`, `serverTime`, `endsAt`.
- **One price clock** (`priceTime`): chart, fills, stops, equity and card baselines all read the same quarter-second step. P&L maths unchanged.
- **Sub-second prices** (`instruments.getPriceAt`): whole seconds are exactly the old series (replays unchanged); in between, a seeded Brownian bridge, same for every player, every step a new price.
- **Action Engine** (`server/actionEngine.js`, config `market.actionEngine`): windows scored as a percentile of their range (top 20% only, no single candle with half the move), then the actual path is checked against the continuity rule before a match uses it. Never the same window twice in a row. Per-match price scale (0.8-1.2) and mirror flip from the seed. Instruments without busy windows are not offered (today all 13 have plenty; fewest: AAPL in Blitz, 54).
- **Blitz** replays at 2x (one 5 s candle every 2.5 real seconds, 72 per match). Others stay 1x.
- **Browser:** the countdown follows server time; "Reconnecting" pill after 2 s without prices, clean reconnect after 8 s; the socket sends the current login token on every reconnect; the chart updates only the forming candle instead of redrawing everything; heavy panels redraw at most twice a second.
- **Engine health** card (admin > System > Errors tab): price-step lateness p95 (red over `ENGINE_RED_LAG_MS`, default 250), event-loop delay, memory, clients that missed more than 3 s of prices.

## Motion table (scripts/motion-report.js, 5 s chart candles)

Before (`motion-before.json`, 200 matches per mode, 1 price a second):

| Mode | Candles | Changes/s | Flat run med/worst | Flat % | Seconds with 4+ changes | Continuity |
|---|---|---|---|---|---|---|
| Blitz | 36 | 0.97 | 2 / 14 s | 4.4 | 0% | 58.4% |
| Quick | 120 | 0.97 | 2 / 17 s | 3.5 | 0% | 76.2% |
| Grand | 240 | 0.97 | 2 / 62 s | 3.4 | 0% | 77.6% |
| Elimination | 180 | 0.97 | 2 / 12 s | 3.4 | 0% | 78.8% |
| Solo | 120 | 0.97 | 2 / 13 s | 3.2 | 0% | 67.8% |
| Private | 120 | 0.97 | 2 / 61 s | 3.3 | 0% | 77.9% |

After (`motion-after.json`, 500 matches per mode, 4 prices a second):

| Mode | Candles (target) | Changes/s | Flat run med/worst (limit) | Flat % | Seconds with 4+ changes | Continuity |
|---|---|---|---|---|---|---|
| Blitz | 72 (60) | 4 | 0 / 2 s (5) | 0 | 100% | 100% |
| Quick | 120 (120) | 4 | 0 / 3 s (8) | 0 | 100% | 100% |
| Grand | 240 (200) | 4 | 0 / 3 s (8) | 0 | 100% | 100% |
| Elimination | 180 (150) | 4 | 0 / 3 s (8) | 0 | 100% | 100% |
| Solo | 120 | 4 | 0 / 3 s (8) | 0 | 100% | 100% |
| Private | 120 | 4 | 0 / 3 s (8) | 0 | 100% | 100% |

## Re-run

```
node scripts/motion-report.js 500            # the table above
node --test test/engine-loop.test.js         # price loop, stall, sub-second, fairness
npm test
```
