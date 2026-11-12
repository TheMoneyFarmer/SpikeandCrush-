# Admin records, sponsor lifecycle, date ranges, Discover panel

Branch `admin-records`. One migration: `supabase/migrations/20261112090000_admin_records.sql` (safe to run twice). Until it has run, the game keeps writing trades the old way, the event log stays off, and the admin pages fall back to what the tables already hold (timeline rebuilt from trades and card plays).

## Every match in admin

- **Why the Daily competition was missing:** Live matches read only the war engine's in-memory list (`gameEngine.listActiveMatches()`, waiting/countdown/active). Competitions run in the competition engine and live in the database, so they could never appear; matches being resolved were hidden too. History read only the `matches` table, capped at 1,000 rows with no paging.
- **Now:** `GET /api/matches/live/all` merges war matches (all modes, incl. `resolving`, friend tournaments, ghost challenges) with running competitions (`competitions.status = 'active'`), pushed over the admin socket every 5 s (`admin:live_rows`, only while an admin is connected) with a Pause toggle. `GET /api/matches` is the history: keyset pages of 50 (`before=`), filters `kind, status, instrument, from, to, q` (handle or 8-digit account number), across matches and competitions.
- **Match detail:** `/match-detail.html?id=` (wars) and `?competition=` (competitions). Read only; the only write is a dispute flag. Exports: `/api/records/match/:id/timeline.csv|json`.
- The existing **End now / Void** buttons stay on the Live matches table only (moderation that existed before); the record pages have no buttons that change a match.

## Record model (MT5 style)

| Thing | Where | Notes |
|---|---|---|
| Account number | `match_players.account_number`, `comp_accounts.account_number` | 8 digits, random, unique system-wide via the `account_numbers` registry (never reused), issued by a trigger on insert; back-filled for old rows |
| Ticket | `trades.ticket`, `comp_positions.ticket` | one shared counter from #1,000,001; back-filled in open-time order, `backfilled = true` |
| Deal | `trades.deal`, `comp_positions.deal` | issued by a trigger the moment a row is closed; shared counter from #5,000,001 |
| Event log | `match_events` | order_open, close (incl. partial), sltp (before/after, by player / card + attacker / system), card (amounts, target equity before/after), spike_alert, spike_result, disconnect, reconnect, elimination, mission, loss_limit, leave, join, start, end; real time + market seconds |
| Closing figures | `match_players.summary` | balance, equity, margin, free margin, margin level and floating P&L just before the final closes; cards, missions, Heat, offline seconds |
| Equity curve | `match_players.equity_curve` | per-second P&L downsampled to 300 points (lowest point kept) |
| Statements | `account_statements` | SHA-256 + HMAC signature (`STATEMENT_SECRET`, else `INTERNAL_ADMIN_SECRET`) |
| Disputes | `record_flags`; `support_tickets.account_number` | flags on a match, trade, account or competition; a support ticket can point at an account |

MT5 fields with no equivalent: **swap** and **commission** are always 0 (the game has neither; spread is inside the quoted bid/ask) and are shown as 0 with a note. **Comment** carries the game's reasons: SL hit, TP hit, margin call, force close by card, loss limit, elimination, partial close, match end, left match, ids back-filled. There is no late-entry rule, so "late entry" always reads No.

Views: admin `/account.html?n=` (and Account Lookup in the menu, plus a PDF check by upload); player `/my-accounts` (own accounts only; someone else's number answers 404), linked from the result screen and profile; the match screen top bar shows "Account 48213907". CSV columns follow the MT5 positions report, then Deal, Comment, Data open (s), Data close (s).

## Sponsor lifecycle

`status` stays the admin's own setting; `lifecycle` = scheduled / active / expiring (10 days) / expired / archived, from the dates (`server/sponsorLifecycle.js`). The admin process runs the job 30 s after start and hourly: it stores the lifecycle, sets expired placements to `ended`, and sends reminders 10 days before, 2 days before and on the day a placement ends, once per placement per milestone (`sponsor_reminders` primary key + Resend idempotency key), at most `maxEmailsPerRun` per run, optionally as one digest, optionally copied to the sponsor contact. Serving never waited on the job: the slot code already checks status and dates.

- Archive (editors): hides from lists and calendar, stops serving, keeps stats and audit.
- Delete placement: super_admin, only expired or archived, sponsor name typed; its daily stats are copied to `sponsor_stats_archive` first and reports keep counting them.
- Sponsor: archive only when nothing is live or scheduled; delete only with no placement rows and no linked competitions, name typed, logos removed from storage.
- Extend (+days or a date) and Renew (new scheduled placement with the same slot, target and creative), both logged.

Settings: `app_settings` key `sponsors.reminders` = `{ enabled, adminEmail (default hello@spikeandcrush.com), expiringDays (10), digest (false), maxEmailsPerRun (40) }`, edited from Sponsors → Reminder emails (logged). `ADMIN_URL` (default https://admin.spikeandcrush.com) builds the "Extend or renew" link.

## Date ranges

`server/dateRange.js`: Today, Yesterday, Last 7/14/30/90 days, This month, Last month, Year to date, Custom (from/to with time). Computed in the admin's IANA time zone (browser zone), so days start at local midnight and DST days have 23 or 25 hours; buckets are hours (≤ 2 days), days (≤ 120), weeks (≤ 400) or months. Comparison = previous equal period, switchable off. The choice is stored per admin in `admin_prefs` (`/api/prefs`, any role, own only). Used by the dashboard (all widgets incl. trades, coins bought/spent/earned, sponsor views and clicks, waitlist sign-ups, support chats, friend requests) and support analytics; exports follow the range.

## Discover panel

`client/js/discover-panel.js` + `client/css/discover-panel.css` in the lobby (`/play`). Desktop/tablet: right panel that pushes the page over. Phones: bottom sheet above the tab bar (half height, grip or button for full). Short landscape phones: side panel next to the mode sheet. Triggers: top-bar Discover button, Discover tab, profile-row button (landscape), friends panel; `/discover` redirects to `/play?discover=1` (query kept). Invites: your open room, a Private War, or a public mode (joins that lobby through `/api/match/create`, which charges entry as usual); anyone live can be invited if their privacy settings allow it; when they accept, both go to the same room. Privacy rules and rate limits are the existing ones (`server/discover.js`, `server/friendsHub.js`).

## Scripts and tests

- `node --test test/*.test.js` (records, statement PDF, matchLog, sponsorLifecycle, dateRange)
- `scripts/admin-records/accounts.js setup|cleanup` test players `rectest_*` on dev
- `scripts/admin-records/admin-shots.js`, `discover-panel-check.js`, `admin-soak.js`
- Run `discover-panel-check.js` against a freshly started local server (an invite from an earlier run stays pending for its TTL).
