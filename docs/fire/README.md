# Fire gameplay: how it works and how to run it

Everything here is on branch `fire-gameplay`. Nothing changes `GAME_RULES` or `MODE_DURATIONS` (capital, positions, leverage, margin call, stop-out and mode lengths are exactly as before).

## Files

| What | Where |
|---|---|
| Every tunable number | `server/config/gameFeel.js` (defaults; admin overrides in `game_config` key `game_feel`) |
| Market curation (offline) | `scripts/curate-data.js` → `data/curated/` |
| Curated playlists at runtime | `server/curated.js`, `server/instruments.js` (`assignCuratedWindow`, `dataSecondsFor`) |
| Seeded per-second price path | `server/intrabar.js` |
| Competitions on curated 5-minute series | `server/replayClock.js` (data times from 2030 = curated) |
| Card deck | `server/sabotage.js` |
| Earned cards, guards, crown, missions, spike alerts | `server/cards.js` |
| Levels, XP, unlocks | `server/progression.js` |
| Rank-split lobbies | `server/rankSplit.js` |
| Discover | `server/discover.js` + routes in `server/index.js` |
| Ghost challenge links | `server/challenge.js` |
| Admin (game-server side) | `server/fireAdmin.js` on `/internal/admin/fire/*` |
| Admin (panel) | `admin/routes/fire.js`, `admin/fire.html` |
| New tables | `supabase/migrations/20261110120000_fire_gameplay.sql` (**not applied anywhere yet**) |
| Reports | `docs/fire/*.md` |

## Market curation

1. `node scripts/curate-data.js` reads `data/market/<SYMBOL>/m1.csv.gz` and `m5.csv.gz`. The files have no volume column, so the 1-minute range is the activity measure.
2. It ranks instruments by **activity score** = median 1-minute range in bps × min(1, median range ÷ 2 spreads) × share of live minutes, keeps everything above the natural gap in the ranking (never fewer than 8), then adds the top two of any asset class that fell short.
3. For each kept instrument it slides 30-minute windows over the history. A window is hot when its average minute ranges at least 1.25× the instrument's median minute, every bar spans at least 2 price points, and every pair of bars ranges at least the median 1-minute range. Hot windows merge into segments; segments under 20 minutes are dropped.
4. Segments are stitched by **ratio rebasing**: each segment is scaled so its first open equals the previous close. The loop's leftover drift is spread over every minute, so the loop closes exactly. Every seam is exact.
5. It indexes the **valid start offsets** for match lengths of 180, 600, 900, 1200 data seconds (plus longer spans for faster replay speeds). Every minute of the match and its 120-minute chart history must pass. It also indexes **spike events** (top 1% of 1-minute ranges).
6. Competitions get a 5-minute series built the same way. In addition, segments are split into pieces of at most 6 hours, the net drift is balanced to within 2% by dropping the largest segments moving in the drift's direction, and segments are ordered to stay within ±15% of the median price. Odd passes through the loop play mirrored.

Inside every bar, `server/intrabar.js` makes a seeded one-second path. It starts at the open, touches the high and low, ends at the close, and moves every second. Re-aggregating to 1m/5m/15m gives back the exact base bars. Same seed + start = byte-identical prices, which is how ghost challenges replay a match. Competition bars use swing mode: a swing of at least the median 1-minute range every 60 seconds or less.

**Rebuild playlists:** admin → Fire Gameplay → Market Curation → Rebuild (super admins). The game server runs the curation into `data/curated-next`, validates it with `scripts/fire/validate-curated.js` (no flat stretch over the limit in sampled matches, exact seams, band), and only then swaps it in. A failed rebuild keeps the old playlists live. Running matches keep their prices. Competition series are carried over unchanged, because running competitions depend on them.

## Fire monitor

Admin → Fire Gameplay → Fire Monitor: for the last 24 hours, per mode and instrument, matches played, median and worst flat stretch, matches over the limit, price changes per minute and range. The data comes from `match_market_stats` once the migration is applied, and until then from the game server's memory. A match whose broadcast price stays flat longer than `market.flatLimitSeconds` emails hello@spikeandcrush.com (`FIRE_ALERT_EMAIL` to change), at most once an hour, with a count of the alerts held back.

## Config keys and defaults

Admin edits are partial objects merged over these defaults, per section, and every save is audit-logged (`admin_logs`, action `update_game_feel`).

| Key | Default |
|---|---|
| `market.curatedPlaylists` | `true` |
| `market.curatedCompetitions` | `true` |
| `market.enabledOverride` | `{}` (instrument → true/false) |
| `market.enabledPerMode` | `{}` (instrument → { mode: false }) |
| `market.replaySpeed` | `{"quick":1,"blitz":1,"grand":1,"private":1,"solo":1,"tournament":1,"async":1}` |
| `market.maxReplaySpeed` | `5` |
| `market.flatLimitSeconds` | `3` |
| `market.priceBandPct` | `15` |
| `market.seamJumpFactor` | `3` |
| `cards.earnedCards` | `true` |
| `cards.handSize` | `4` |
| `cards.minWinPctOfCapital` | `0.002` (0.2% = 20 on 10,000) |
| `cards.minHoldSeconds` | `5` |
| `cards.streakRewards` | `{"1":1,"2":1,"3":2}` |
| `cards.refillAtStreak` | `5` |
| `cards.perWinAfterRefill` | `1` |
| `cards.heatPerOverflowCard` | `25` |
| `cards.maxCardsPerMinute` | `3` |
| `cards.maxCardsPerMatch` | `12` |
| `cards.hitShieldSeconds` | `10` |
| `cards.sameTargetCooldownSeconds` | `4` |
| `cards.rarityWeights` | `{"common":60,"rare":28,"epic":10,"legendary":2}` |
| `cards.floorPctOfCapital` | `0.5` (no card takes equity below 5,000 in one hit) |
| `progression.enabled` | `true` |
| `progression.xp.matchCompleted / win / podium / qualifyingWin / bestStreakPerStep / missionCompleted` | `40 / 60 / 25 / 8 / 5 / 30` |
| `progression.xp.profitPctPerPoint / profitXpCapPerMatch` | `4 / 60` |
| `progression.xp.perMatchCap / perDayCap / minMatchSecondsForXp` | `250 / 1500 / 60` |
| `progression.levelThresholds` | `[0,150,350,600,900,1300,1800,2400,3100,3900,4800,5800,7000,8400,10000,12000,14500,17500,21000,25000]` |
| `progression.startingCardsByTier` | `{"Recruit":0,"Trader":0,"Broker":1,"Analyst":1,"Veteran":1,"Elite":2,"War Lord":2}` |
| `progression.fasterStreakTiers` | `[]` (tiers that get +1 card at streak 3 instead; never combine with extra starting cards) |
| `progression.unlockOverrides` | not set (card → { level } / { wins } / { matches }) |
| `rankSplit.enabled` | `false` |
| `rankSplit.tiers` | Rookie = Recruit; Trader = Trader, Broker; Veteran = Analyst, Veteran; Warlord = Elite, War Lord |
| `rankSplit.joinUpTiers` | `1` |
| `rankSplit.suggestedTriggerConcurrent` | `200` |
| `heat.enabled / multipliers / basePerWin / sabotageLeaderBonus` | `true / [1,1.5,2,3] / 100 / 40` |
| `missions.enabled / perMatch / coinsPerMission / perMatchCoinCap / perDayCoinCap` | `true / 2 / 3 / 6 / 30` |
| `spikeAlerts.enabled / leadDataSeconds / resultShowSeconds / topPercent` | `true / 10 / 4 / 1` |
| `crown.enabled / dethroneCard / dethroneCooldownSeconds` | `true / true / 60` |
| `ghostChallenge.enabled / expiryDays` | `true / 7` |
| `discover.enabled / pageSize / suggestionCacheSeconds` | `true / 30 / 60` |
| `discover.weights` | `{"friendsOfFriends":3,"similarRank":2,"sameModes":1.5,"similarHours":1,"playedTogether":2,"proximity":0.5}` |

## Turning things off

Each one is a save in admin → Fire Gameplay (or a `game_feel` override). All take effect at the next match, with no restart.

| Feature | Switch |
|---|---|
| Curated market (back to raw random windows) | `market.curatedPlaylists = false` |
| Curated competitions (new ones only) | `market.curatedCompetitions = false` |
| One instrument | `market.enabledOverride.<SYMBOL> = false` |
| Earned cards | `cards.earnedCards = false` (start-of-match deal stays) |
| Heat | `heat.enabled = false` |
| Missions | `missions.enabled = false` |
| Spike alerts | `spikeAlerts.enabled = false` |
| Crown / Dethrone card | `crown.enabled = false` / `crown.dethroneCard = false` |
| Ghost challenges | `ghostChallenge.enabled = false` |
| Level unlocks | `progression.enabled = false` stops XP; to give everyone every card, set `progression.unlockOverrides` |
| Rank split | `rankSplit.enabled = false` (default) |
| Discover | `discover.enabled = false` |

## Tests and tools

- `npm test`: all unit tests (the `test/fire-*.test.js` files cover everything here)
- `node scripts/fire/flatness-report.js`: the before/after flatness proof and the replay-speed table
- `node scripts/fire/validate-curated.js data/curated`: the guarantee check
- `SHOT_USER=… SHOT_PASS=… node scripts/fire/game-shots.js`: game-screen screenshots and layout boxes
- `SHOT_USER=… SHOT_PASS=… node scripts/fire/spike-banner-test.js`: proves the spike strip never moves or covers the chart
- `SHOT_PASS=… node scripts/fire/discover-live-check.js`: two live accounts, appear-offline and visibility rules
- `node --expose-gc scripts/fire/soak.js`: 54 bots, 10 minutes
