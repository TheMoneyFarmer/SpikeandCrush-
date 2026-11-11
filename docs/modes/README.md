# Game modes with their own identity, How to play, walkthrough

Branch `game-modes` (worktree `~/Downloads/spikecrush/spikecrush-modes`), on top of `origin/main` d6e7ba3. Not merged, not pushed. No database migration.

## What each mode is now

| Mode | Cards | How you win | What is special |
|---|---|---|---|
| Quick War | 3 to start, 4 slots | Highest equity | Unchanged: the full game |
| Blitz War | 2 slots, fast refill, no heavy cards | Highest equity | Busiest instruments (top 6 of the activity ranking), spike alerts every 40s instead of 60s, "fastest win" on the result |
| Grand War | Starts with 2 basic/mid, up to 4 | Highest equity | 3 real market events near minutes 5/10/15, half-time card at 10, Steady Hand badge |
| Elimination (internal key `tournament`) | 4 slots + Lifeline card | Survive the cuts | Bottom 20% cut at 3/6/9/12 min (at least 1, only with 4+ players, stop below 4), "Cut in 0:30" strip, Danger tags, cut players watch |
| Solo Ranked | 2 slots, defense only (Shield, Cleanse) | Highest equity | Ghost of your best Solo run, yesterday's best, 3-mission chain |
| Daily Challenge (`async`) | None | Best of the day | Ghost of today's best run |
| Private War | Host decides | Host decides | House rules: cards on/off, deck level, starting hand, cuts on/off, Quick or Blitz card style |

Never touched: `GAME_RULES`, `MODE_DURATIONS`, prize split, entry fees, competitions, sponsored tournaments. A test pins their hashes to `main`.

User-made bracket tournaments keep working as before: their rounds pass 1v1 overrides (2 players, no fill, no fee, label "Tournament round"), so no cuts ever happen there.

## Where things live

- `server/config/modeIdentity.js`: every mode setting (identity texts, cards, instrument pool, spike gap, events, half-time, cuts, missions, XP multiplier, banners). Admin overrides: game_config key `mode_identity`.
- `server/config/tours.js`: every tour, its version and its steps. Admin overrides: game_config key `tours`.
- Admin: Fire Gameplay > **Game Modes** (per-mode on/off and overrides) and **Walkthrough** (switch, per-tour on/off and version, step text, completion and skip stats). Every save is audit-logged. Edits reach new matches only.
- APIs: `GET /api/modes/catalog`, `GET /api/match/:id/ghost`, `GET /api/tours`, `POST /api/tours/progress`, `POST /api/tours/reset`.
- Tour progress: `players.settings.tours` (existing JSON column).

## How to check it yourself

1. `cd ~/Downloads/spikecrush/spikecrush-modes && npm test` (217 tests).
2. `node scripts/modes-e2e.js`: every mode end to end with scripted players.
3. `node scripts/measure-grand-events.js 200`: Grand event coverage.
4. With a test server running: `TOUR_BASE=... TOUR_USER=... TOUR_PASS=... npm run test:tours` (real Chrome, desktop and phone).
5. Screenshots: `docs/modes/after/` (compare with `docs/modes/baseline/`).
