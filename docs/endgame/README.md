# Endgame (branch `endgame-seasons`): Stages 1-4 and rivalries

## Phase 0: what a player with everything unlocked can do today

1. They hold every card by level 18 (the last one also needs 50 wins); the level stops at 20.
2. XP after level 20 does nothing they can see.
3. The deck never changes: no new cards, no rotation, no weekly twist.
4. The only long goals are rating, the 30-day battle pass and monthly season cosmetics for the top few.
5. There is no mastery, no prestige and nothing to show off except rank cosmetics.

Already in the code (reused, not duplicated): monthly seasons (`server/seasons.js`), the 30-day battle pass (`server/battlepass.js`), earned cosmetics (`server/cosmetics.js`), the per-match event log (`match_events`, card plays with caster and target).

## Built

**Stage 1: balance data and card settings**
- Every match now logs the cards each player held (`cards_held`), so pick rate is measurable.
- Nightly job (admin server, hourly check, yesterday once): per card, mode and rank bracket: held, played, pick rate, win rate when played vs not played, finishing-rank swing. Admin > Seasons and Balance > Balance: sorted table, flags "too strong" (10 points over the average win rate, minimum sample shown) and "never picked".
- Card durations as versioned settings (`card_config_versions`): each save is a new logged version; the game server applies it within a minute, no deploy; rollback activates any old version; the server refuses values outside half to double the default and anything that is not a card setting. Heat stays in Fire Gameplay settings (already audited).

**Stage 2: seasons**
- Admin Season Studio: name, theme, dates (default 8 weeks), featured cards, track rewards, peak-rank rewards, soft reset %, End now.
- Season track: 50 levels from the same capped match XP; rewards are cosmetics, titles or 1-25 coins (idempotent per level, through the ledger).
- Featured cards and the Vault: a card featured by any season is seasonal; outside its season it is in the Vault: refused in ranked (dealing and playing), allowed in casual and private. Core cards never rotate. With no seasons yet, nothing changes.
- End job: peak-rank reward once, soft reset toward 1000 once per player with an audit row (`season_resets`), then archived. Rank maths untouched; only the next season's starting point moves.
- Player screens: /season (track, countdown, featured cards, Vault), Home banner, season progress in the match result data. Once a season exists, the old monthly top-player rewards stand down (no two systems paying out).

**Stage 3: mastery and prestige**
- Card mastery from the server's own match results only: a play counts when the target finishes below the caster; levels at 5/15/40/100/250 successes; badge and stats (uses, success rate, favourite target) on the profile. Never more power; no route accepts mastery from a client.
- Prestige at the top level: shown level back to 1, every card, unlock and cosmetic kept, prestige badge; confirmation required, irreversible, logged (`prestige_events`), cannot happen twice from a double click.
- Profile showcase: prestige, season peak, top three mastered cards.

**Stage 4: Weekly Twists**
- 6 twists (`server/twists.js`): Double Heat, No Shields, Faster Spikes, Card Cooldown Halved, Sharp Targets, Streak Rush. Each has one whitelisted setting with bounds; anything else is refused.
- A twist changes only the card, Heat and spike-alert settings of matches created while it runs (the per-match rules copy). Never GAME_RULES, lots, leverage, margin or payouts. Ranked public matches are left out unless the twist says otherwise; a mode list limits it further.
- Admin > Seasons and Balance > Weekly Twists: schedule (default one week), modes, include ranked, on/off; logged. Lobby shows a one-line description; the match rules panel lists the twist.

**Stage 5 (part): rivalries**
- Head-to-head record against any human player from finished matches (`/api/rivalry/:id`), and your top rivals on the profile.

## Tests

`test/endgame.test.js` (12): plus twists (library, whitelist and bounds, fire layer only, ranked and modes, No Shields, Sharp Targets) and head-to-head; and the first 8: GAME_RULES snapshot; balance numbers vs a hand-checked 50-match sample; card config bounds, whitelist, live apply and rollback; season lifecycle with a test clock, track rewards once, end job once per player with audit rows, soft reset values; Vault refused in ranked and allowed in casual and private; mastery only from server outcomes; prestige keeps unlocks and cannot double; season coins capped and keyed. Full suite and every mode end to end pass.

## Not built yet (rest of Stage 5)

- Rivalry record in the in-match target picker (it is on the profile).
- Cosmetic catalogue earned through play (candle themes, trade marker effects, crown skins, card variants), Equip and collection screens, challenge library paying XP and cosmetics, rivalries.
- Seasonal sidegrade cards: the system supports them, but none are designed; until then featured cards can only be chosen from existing cards (which then become seasonal).

## Content cadence (operating plan)

- **Every week:** schedule one Twist in Admin > Seasons and Balance > Weekly Twists.
- **Every season (8 weeks):** in Season Studio pick 3-4 featured cards, set the track (cosmetics, titles, a few coins) and peak rewards, choose the soft reset %; at the end the job pays peak rewards, resets, archives and vaults the featured cards automatically.
- **Every month:** one event idea (for example a themed Private room weekend or a Blitz-only weekend) using existing modes.
- **Without a code change:** card durations (with rollback), seasons and their rewards, featured cards and the Vault, soft reset %, Heat and mission settings (Fire Gameplay), mode settings (Game Modes), and the Balance dashboard to decide what to change.
