# Spike & Crush: Engineering Audit + Fixes

> **Fix status, 2026-11-08** (branch `security-fixes`). The original read-only audit follows below, unchanged, from section 0.
>
> **DEPLOY ORDER (critical):** apply `supabase/migrations/20261108100000_security_ledger.sql` to the database **before** deploying this code to it. The coin code now calls `coin_apply`, `complete_coin_purchase` and `shop_buy`; on a database without them, every coin movement fails. Dev: not yet applied (the migration tool approval was declined three times). Prod: not applied.

## F1. Before / after (what was proven broken, and the same test after the fix)

All "after" results were measured on the fixed code running locally (game :3030, admin :3031) against the **dev** database, except the money proofs, which need the migration (F3).

| # | Problem | Before (evidence) | Fix | After (same test) | Status |
|---|---|---|---|---|---|
| U1 | Admin source code publicly served (incl. default master password) | `GET /lib/auth.js` → **200** on prod admin and :3003 | `admin/server.js`: static only `/css`, `/js`, `/components` and top-level `*.html`; everything else 404 | `/lib/auth.js`, `/server.js`, `/routes/system.js`, `/lib/supabaseAdmin.js`, `/lib/coins.js`, `/package.json`, `/../.env` → **404**; login page and assets → 200 | **Fixed in code** (prod needs deploy) |
| U1b | Hard-coded fallback master password `SpikeAndCrush2026!` | `admin/lib/auth.js:138` reset the super-admin to it on every start when the env var was unset | Fallback removed; a missing/short (<12) `MASTER_ADMIN_PASSWORD` now skips the sync and logs an error | Code review + startup log | **Fixed in code**. **You must rotate the password** (it is public in git history) |
| U2 | Avatar upload stored XSS (session theft) | `audit.html` declared `image/png` → saved as `.html`, served `200 text/html` | `server/imageValidation.js`: type from file bytes (PNG/JPEG/GIF/WebP only, polyglot check), extension from detected type, memory upload, Supabase Storage `avatars` bucket (local disk fallback), `/uploads` serves image extensions only, `nosniff` everywhere | Same HTML → **400** "Avatar must be a PNG, JPEG, GIF or WebP image"; real PNG named `evil.html` → saved `.png`, served `image/png` + `nosniff`; `/uploads/avatars/x.html` → **404** | **Fixed** |
| A | Coin balance lost updates | 5 concurrent +1 → balance **+1** (Proof A) | All coin moves via SQL `coin_apply()` (single statement, never < 0, ledger in same transaction, idempotency key); `creditCoins`/`debitCoins` and all 3 admin coin paths rewritten | Needs migration → see F3 | **Fixed in code, untested** |
| B | Stripe purchase double credit | 2 concurrent completions → credit ran **twice** (Proof B) | `complete_coin_purchase()` flips pending→completed and credits in one transaction (key `purchase:<session>`); unique `coin_purchases.stripe_session_id`; webhook dedupes by `stripe_events.id`, returns **500** on failure so Stripe retries | Needs migration | **Fixed in code, untested** |
| C | Shop double purchase / charge | 2 simultaneous buys → **2 purchases**, ledger ≠ balance (Proof C) | `shop_buy()` own-once/pay-once + unique `(player_id, item_id)` | Needs migration | **Fixed in code, untested** |
| 4b | Match entry: seated before paying | Debit after join; failure left player in unpaid | Charge first (unique key), seat, refund exactly that payment if seating fails or the seat was already paid; lobby refund keyed to the seat's payment (closes a pay-once/refund-twice hole found while fixing) | Needs migration | **Fixed in code, untested** |
| — | Double payouts on retries | Prizes, tournament/battle-pass rewards, cancellation refunds had no dedupe; admin "Distribute prizes" twice paid twice; concurrent tournament cancel refunded twice | Idempotency key on every credit (`prize:<match>:<player>`, `tournament_prize:<id>`, `bp_tier:…`, `bp_challenge:…`, `tournament_cancel_refund:…`, `admin_tournament_prize:…`, `prize_claim_refund:<id>`) | Needs migration | **Fixed in code, untested** |
| 36 | No security headers | `curl -I` prod: none | `server/securityHeaders.js` on both servers: CSP, nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, COOP, HSTS (HTTPS) | All present on :3030 and :3031; **0 CSP violations** across 8 pages in Chrome; a deliberate off-list script was **blocked and detected**; lobby fully working | **Fixed** |
| 26 | Bans not enforced | No reference to `is_banned` anywhere | `activeBan()` checked in `authenticate`, socket handshake and login | Banned dev test account: existing token → **403** "This account is banned"; fresh login → **403**; unbanned afterwards | **Fixed** |
| 7a | Admin IP allowlist bypass via `X-Forwarded-For` | Spoof header as Railway delivers it (`fake, real`) → passed allowlist (old code: 401 auth prompt) | `clientIp()` uses proxy-verified `req.ip` | Same header → **403** "Your IP is not on the admin allowlist"; genuine allowlisted IP still passes | **Fixed** |
| 7b | Admin sessions not revocable | Old admin: token after logout → **200** | Token carries `sid`; each request checks `admin_sessions.revoked`/expiry and `admin_users.is_active` (20 s cache); logout and deactivation revoke | After logout same token → **401** | **Fixed** |
| 7c | Admin lockout DoS / fail-open | 5 bad tries from anyone locked the master out; DB error = not locked | Lockout keyed on (username, IP); fails closed | Code review | **Fixed** |
| 28 | Admin cookie / JWT | No `Secure`, `SameSite=lax`, alg not pinned | `Secure` (HTTPS), `SameSite=Strict`, HS256 pinned, timing-safe legacy compare, socket CORS same-origin only | Cookie flags verified locally (Secure appears over HTTPS) | **Fixed** |
| 1 | Paid AI chat / spam endpoints only had the global limit | 300/15 min/IP | Support chat 20/15 min, tickets 5/h, OAuth callback auth limit, competition clicks 30/15 min | 23 chat requests → **20 × 200, 3 × 429** | **Fixed** |
| 10 | No socket rate limits; 1 MB messages; private matches spectatable | — | Per-socket token bucket (40 burst, 15/s; sabotage/chat 4 burst), 100 KB cap, private rooms spectatable by their players only | 60 rapid chat events → **4 processed, 56 "Slow down"** | **Fixed** |
| 27 | Discord OAuth `state` = player id; token in URL | Predictable state; `?token=` in URL | Random single-use 48-char state (10 min) bound server-side; `POST /api/discord/connect-url`; old GET retired; 10 s timeouts on Discord calls | State length 48, not the player id; forged state → rejected; old `?token=` route → redirect error | **Fixed** |
| 34 | Usernames accept markup; `escapeHtml` doesn't escape quotes | `<i>audit</i>x` registered | `^[A-Za-z0-9_]{3,20}$` on register and profile edit; email/password bounds; `escapeHtml` escapes `" '` | `<b>x</b>yz` → **400** "letters, numbers and underscores" | **Fixed** (existing names unchanged) |
| 2 | No timeouts on outbound calls | Resend, Discord, Stripe, Supabase | Supabase client 15 s (`DB_TIMEOUT_MS`), Stripe 15 s + 2 safe retries, Resend 10 s, Discord 10 s | Code review | **Fixed** |
| 3/6/51 | Webhook swallowed failures (200) | Credit failure lost silently | Returns 500 → Stripe retries; event log `stripe_events` with `processed_at` | Needs migration for the event table | **Fixed in code** |
| 19/47/48 | Slow DB-backed endpoints | `/api/stats/live` 12 req/s, p99 10 s, **242 timeouts**; others 18-46 req/s, p99 1.2-10 s | 10 s shared micro-cache with in-flight sharing on 5 public endpoints; `prize_total()` SQL sum (was 10k-row JS scan); 5 m static cache + ETag | `/api/stats/live` **4,545 req/s, p99 6.9 ms, 0 errors**; home 5,725/3.7 ms; competitions 2,808/8.8 ms; leaderboard 4,449/5.4 ms; activity 5,050/4.3 ms | **Fixed** |
| 18 | Missing / duplicate indexes, prod drift | Seq scans; 49 unindexed FKs on prod | Migration adds hot-query and FK indexes (same names as dev), drops 2 duplicates | Needs migration | **Fixed in migration** |
| 38 | 8 vulnerable packages (3 critical, 4 high) | `npm audit` | Lockfile updated (express 4.22.3, qs, proxy-addr, engine.io, compression, multer, body-parser); `concurrently` moved to devDependencies | `npm audit --omit=dev` → **0 vulnerabilities** (lockfile; installs on next deploy) | **Fixed** |
| 40 | No CI, no security tests | — | `.github/workflows/ci.yml` (npm ci, syntax check, tests, audit high+); `test/security.test.js` (6 tests) | `npm test` → **19/19 pass** | **Fixed** |
| 41 | Node not pinned | — | `.nvmrc` 24, `engines` `>=22.12 <25` | — | **Fixed** |
| 42 | No health/readiness | — | `GET /health`, `GET /ready` (DB ping) | `{"ok":true}` / `{"ok":true,"db":"ok"}` | **Fixed** |
| 31 | CORS wildcard if env missing | Falls back to `*` | Refuses to start in production without `ALLOWED_ORIGIN`; dev coin faucet always off in production | Code review | **Fixed** |
| 37 | Request size | 100 kb default | JSON 200 kb, sockets 100 KB, avatar 2 MB / 1 file | — | **Fixed** |

## F2. Not fixable from code (needs you)

| Item | What to do | Why |
|---|---|---|
| **Rotate the master admin password** | Railway → admin service → Variables → set `MASTER_ADMIN_PASSWORD` to a new 16+ character value; redeploy | The old fallback is public in git history and was downloadable from prod |
| Apply the migration | Dev then prod: Supabase → SQL editor → paste `supabase/migrations/20261108100000_security_ledger.sql` → Run. Or approve the migration tool | Required before deploying (see banner) |
| Backups / PITR (23) | Supabase prod → Database → Backups: confirm daily backups, enable Point-in-Time Recovery, do one test restore into a scratch project | Not visible to code |
| WAF / DDoS (30) | Put Cloudflare (free plan) in front of `www.` and `admin.` | Origin is exposed |
| Admin IP allowlist | Set `ADMIN_ALLOWED_IPS` on the admin service (now spoof-proof) | Strongly recommended for the panel |
| Railway env | Confirm `NODE_ENV=production`, `ALLOWED_ORIGIN`, `STRIPE_WEBHOOK_SECRET` set on the game service | Several guards key off them |
| Leaked-password protection | Supabase → Auth → enable HaveIBeenPwned check | Advisor warning |
| Monitoring (46) | Point an uptime checker (e.g. Better Stack free) at `/health`; add Sentry when ready | No alerting exists |
| Apex redirect (29) | GoDaddy forwarding for `spikeandcrush.com` should 301 to `https://www.` | Answers 405 over http |
| Railway "Wait for CI" | Turn on for the game service so `ci.yml` + `safe-deploy.yml` gate deploys | |

## F3. Still to verify after the migration is applied

Re-run `race-proof.js` (Proofs A/B) and the double shop request (Proof C) against dev; expected: A +5, B one credit, C one purchase. Also: stripe event dedupe, entry-fee refund on failed seating, avatar upload to the Storage bucket.

## F4. Deliberately not changed

- `GAME_RULES` / `MODE_DURATIONS` (fixed facts): code has `MAX_POSITIONS = 10` and accepts lots < 0.01 while the UI says 3 positions / 5 lots: **owner decision**, untouched.
- CSP still allows `'unsafe-inline'` scripts (pages use inline scripts/handlers); tightening needs those moved to files.
- Multi-instance scaling (49), queues (7), API versioning (52): not needed yet; triggers in the audit table.
- Schema baseline for core tables (22): needs a `supabase db dump` of prod with dashboard access.

---

# Original audit (read-only)

Date: 2026-11-07/08. Auditor: Claude (Prompt A). Scope: inspect, test, report. **No application code, config, schema or data was changed**, except test rows written to the **dev** database by the proof scripts (listed under "Data touched").

Code audited: git `HEAD` = `e957750` on branch `redesign-console` (production runs `main` @ `8a58674`; the server code paths below are identical between the two except where noted). The working tree also contains **uncommitted, in-progress work from another session** (support system, `server/deployDrain.js`, coin packages, changes to `server/index.js`, `server/gameEngine.js`, `admin/*`). That work is **not** audited as shipped; it is called out where it changes the picture.

## 0. Repo vs the brief (adapted)

| Brief says | Repo / reality |
|---|---|
| Game server port 3001, admin 3002 | Game `PORT` default **3000**, admin **3003** |
| Railway "not yet deployed" | **Live**: `www.spikeandcrush.com` and `admin.spikeandcrush.com` both on Railway (DNS + response headers) |
| Price feeds freeforexapi / goldapi / CoinGecko | **None in code.** Market data is 15 MB of historical files in `data/`, replayed (`server/instruments.js`, `replayClock.js`) |
| Scheduler every 6 h | `compEngine` schedules every **10 min** (`SCHEDULE_EVERY_MS`, compEngine.js:22); tick 5 s |
| `activeMatches` / `disconnectedPlayers` Maps | Named `matches`, `socketSessions`, disconnect-grace timers in `gameEngine.js` |
| GAME_RULES max 3 open positions | Code: `MAX_POSITIONS = 10` (gameEngine.js:15). UI rules text says "Max 3 positions" and "Max 5.0 lots"; code `MAX_LOTS = 10`. **Not flagged as a bug (fixed fact), but code and stated rules disagree: owner to decide which is true.** Min lot 0.01 is not enforced (code accepts any lots > 0, gameEngine.js:903). |
| Organizer login / organizer JWT | Not found in code at HEAD (organizers table exists; no organizer auth routes) |
| Apple OAuth | Removed (commit `3dcfab6`) |

## 1. URGENT (found during the audit; act today)

1. **Admin source code is publicly downloadable in production.** `curl -I https://admin.spikeandcrush.com/lib/auth.js` → `HTTP/2 200 application/javascript 10622 B` (same for `/server.js`). Cause: `admin/server.js:134` `express.static(__dirname)` serves the whole admin folder; the guard at :125-131 only protects `.html`. That file contains the master admin email and the **fallback password `SpikeAndCrush2026!`** (`admin/lib/auth.js:138`), which is applied to the super-admin on every restart when `MASTER_ADMIN_PASSWORD` is unset. I did **not** attempt to log in. **Verify `MASTER_ADMIN_PASSWORD` is set (and not that value) on the Railway admin service now, and rotate it.**
2. **Avatar upload allows stored XSS → session theft.** Proven on a local copy of HEAD: `POST /api/player/avatar` accepted `audit.html` declared as `image/png`; `GET /uploads/avatars/<id>.html` returned `200 Content-Type: text/html` from the game origin (`server/index.js:172-186`: mimetype is client-supplied, extension taken from the original filename). Player sessions are in `localStorage` (`sc_token`) on that origin, so a link to such a file can steal any viewer's token.

## 2. Checklist

Legend: Status = present / partial / missing / not needed yet / unverified. Priority P0 money/data/outage, P1 hurts at real traffic, P2 later.

### A. Traffic, resilience and external calls

| # | Topic | Status | Evidence | Risk if left | Priority | Recommended fix |
|---|---|---|---|---|---|---|
| 1 | Rate limiting | partial | `apiLimiter` 300/15 min/IP on `/api` and `authLimiter` 20/15 min on register/login/reset (index.js:405-407, live header `ratelimit-limit: 300`). Admin login 20/15 min + 5-fail username lockout (admin/server.js:45, auth.js:64). **No per-user limits. No socket event limits** (no throttle in any `socket.on`). `/api/support/chat` (paid Claude calls) and `/api/support/ticket` only have the global 300 limit. `/api/auth/oauth-callback` has no `authLimiter`. Lockout keys on username → anyone can lock the master admin out for 15 min with 5 bad attempts. | AI cost abuse, socket spam/DoS, admin lockout DoS | P1 | Per-user + per-IP limits on support chat and money routes; token bucket per socket for trade/sabotage/chat events; lockout by (username, IP) with exponential backoff |
| 2 | Timeouts | partial | Anthropic: `timeout: REQUEST_TIMEOUT_MS, maxRetries: 1` (support/agent.js:22, uncommitted work). **Resend** `fetch('https://api.resend.com/emails')` (admin/lib/email.js:18), **Discord** OAuth/guild fetches (index.js:761-800): no timeout/AbortSignal. Stripe SDK default (80 s). supabase-js: no timeout set. Socket `getUser` on every connect: no timeout. No `server.requestTimeout`/`headersTimeout` override. | A slow dependency holds requests/sockets open indefinitely | P1 | `AbortSignal.timeout(5000)` on every fetch; Stripe `timeout: 10000`; supabase `global.fetch` with timeout |
| 3 | Retries / backoff | partial | Anthropic `maxRetries: 1`. compEngine retries implicitly on next 5 s tick. Nothing else retries. **Stripe webhook swallows credit failures and returns 200** (index.js:310-337 `catch → console.error`, then `res.json({received:true})`), so Stripe never retries. No retry on non-idempotent calls found (good). | Paid purchases silently not credited | P0 | Return 500 when crediting fails so Stripe retries (after making the credit idempotent, item 5) |
| 4 | Circuit breakers / fallbacks | partial | Landing ticker has static fallback (landing.html); support chat falls back to "AI OFF" when no key. No live price feed exists (not needed). Every authenticated request does 2 Supabase round trips (`authenticate`, index.js) with no cache; Supabase slow ⇒ whole API slow (measured, #47). | DB hiccup = site-wide slowness | P1 | Short-TTL cache for `getUser`/player lookups; cache stats endpoints |
| 5 | Idempotency | **missing** | Stripe signature verified (index.js:299) but **no event-id dedupe**. `coin_purchases.stripe_session_id` has **no unique index**. `completeCoinPurchase` is check-then-act (database.js:1301-1313): reads status, updates without `WHERE status<>'completed'`, then credits. **Proven double credit** (Proof B). `coin_transactions` has **no idempotency key** or unique constraint. Shop: "already owned" checked in JS, `shop_purchases` has no unique (player_id,item_id): **proven duplicate purchase** (Proof C). Competition entry/prize/refund are idempotent (`comp_enter` row lock, `comp_pay_prize`/`comp_refund_entry` guarded by `prize_paid`). Tournament registration: unique (tournament_id, player_id). | Double credits, double charges, ledger ≠ balance | P0 | Unique index on `coin_purchases(stripe_session_id)`; `coin_transactions.idempotency_key text unique`; do credits in one SQL function (update ... where status='pending' returning; then ledger insert) |
| 6 | Dead letter / failed jobs | missing | Webhook failure → `console.error` only. Emails: fire-and-forget. Errors land in an in-memory ring buffer (`recentErrors`, index.js, lost on restart). compEngine settlement failure is retried next tick (good). | Lost purchases/emails invisible to admin | P1 | `failed_jobs` table + admin view; alert on webhook credit failure |
| 7 | Queues / pub-sub | not needed yet | Emails, notifications, stats run inline. | Trigger: >1 instance, or email/settlement taking >1 s on the request path | P2 | Postgres-backed job table first (no Redis needed) |
| 8 | Cron / schedulers | present (comp) / partial (rest) | compEngine: DB lease lock `comp_try_lock` (holder+TTL) + in-process `ticking` guard (compEngine.js:921-925), atomic RPCs: safe across 2 instances and restarts. Support SLA timer (`setInterval`, support/index.js:350, uncommitted) and match timers have no lock (fine single-instance). | — | P2 | Keep; add the same lock to any new job |
| 9 | Backpressure | partial | Default Socket.io `maxHttpBufferSize` (1 MB), no per-socket send queue limits, leaderboard/price broadcasts per match interval. Not load-tested with real matches (see Unverified). | Slow clients buffer unbounded | P2 | Volatile emits for price ticks; cap payloads |

### B. Real-time and concurrency

| # | Topic | Status | Evidence | Risk | Priority | Fix |
|---|---|---|---|---|---|---|
| 10 | WebSockets | partial | Handshake auth: Supabase `getUser(token)` (index.js `io.use`). Actions resolve the player from `socketSessions` (cannot act as another player). `bindSocket` requires player already in match (gameEngine.js bindSocket). **`spectate:join` has no authorisation**: any logged-in user with a matchId sees full state, including private rooms. No per-event rate limits. Listener cleanup on disconnect present for presence. Heartbeat: Socket.io defaults. Banned players can connect (bans not enforced, see #26). | Spying on private matches; spam | P1 | Check private/visibility before `bindSpectator`; per-socket limiter |
| 11 | Long polling / SSE | not needed yet | Socket.io handles transport fallback. | — | P2 | — |
| 12 | Race conditions | partial | **Coin balance: not atomic** (read-modify-write in JS, database.js:99-127): **proven lost update** (Proof A). Max positions / open / close / modify: synchronous in-memory, atomic within one process. Competition entry fee: atomic (`comp_enter` `FOR UPDATE`). Prize payout: atomic (`prize_paid` flag). Match entry: debit happens *after* matchmaking (index.js:863-866); if the debit throws, the player is already in the match unpaid. Shop: not atomic (Proof C). Loss-limit auto-close vs manual close: same process, synchronous (OK). | Wrong balances, free entries, double charges | P0 | Move all coin moves into SQL functions: `update players set coins = coins - $1 where id=$2 and coins >= $1 returning coins` + ledger insert in one transaction |
| 13 | Locking | partial | Row lock only in `comp_enter`; lease lock for comp jobs. None for wallet. | as 12 | P0 | as 12 |
| 14 | Deadlocks | present (low risk) | No multi-row wallet transactions exist (each function touches one player). Risk appears once item 12 is fixed with transfers: lock rows in id order. | — | P2 | Order locks by player id |
| 15 | Event-loop blocking | partial | Boot blocks **686 ms** loading data files (monitor). Under the soak, **repeated stalls 100-578 ms** (minutes 3-9) at 10 HTTP concurrency + 50 socket churn. bcrypt cost 12 for admin login (async). | Stalls delay every player's ticks/trades | P1 | Profile (`--cpu-prof`) the stalls; cache stats responses; avoid large `JSON.stringify` on hot paths |
| 16 | Memory | present (no leak observed) | 10-min soak: heap floor 77-80 MB at start and end, peaks 94-189 MB reclaimed by GC; RSS ≤ 263 MB; active handles back to 29-58. Match timers cleared in `endMatch`; finished matches deleted after 5 min. 4,956 socket connects in the run. | — | P2 | Re-run with real matches when a bot client exists |
| 17 | Clock / time | present | Match timers and comp ticks are server-side (`Date.now()`); no client timestamps trusted in trades. "Today" uses `dubaiDayStart()` (database.js) for prize stats; `getMatchesToday` uses server-local midnight (inconsistent). | Off-by-timezone daily stats | P2 | Use one Dubai-day helper everywhere |

### C. Data layer

| # | Topic | Status | Evidence | Risk | Priority | Fix |
|---|---|---|---|---|---|---|
| 18 | Indexing | partial | Dev volume tiny (≤ 761 rows/table); EXPLAIN shows **seq scans** for leaderboard (`players order by war_rating` + `is_persona`), matches today (`created_at`), recent activity (`status, end_time`), prize credits (`coin_transactions.type`). Prod advisor: **49 unindexed foreign keys** (incl. `match_players.match_id`, `trades.player_id`, `notifications.player_id` on **prod**, which dev *does* index: drift). Duplicate indexes on `players.email` and `matches.room_code`. 100k-row seeding not done (see Unverified). | Seconds-long queries at scale | P1 | `players(war_rating desc) where not is_persona`, `matches(created_at)`, `matches(status,end_time desc)`, `coin_transactions(type,created_at)`, FK indexes from the advisor; drop duplicates |
| 19 | N+1 / query shape | partial | `/api/stats/live` → `getTotalPrizesDistributed` fetches **all prize credits (limit 10000) and sums in JS** on every landing-page hit (database.js:1352-1390); total silently wrong after 10k rows. `showSeedAccounts()` extra query per call. compEngine notifies per account in a loop (acceptable). | Slow landing page, wrong totals | P1 | `select sum(amount)` RPC or a cached counter |
| 20 | Connection pooling | present | supabase-js over HTTP/PostgREST (no `pg` pool in code), pooling is Supabase-side. | Bound by PostgREST/Auth rate limits | P2 | Monitor Supabase API usage |
| 21 | Replicas / sharding / partitioning / CAP | not needed yet | Single Supabase Postgres. Triggers: >5M ledger rows (partition `coin_transactions` by month), sustained >70% DB CPU (read replica for leaderboards/stats). | — | P2 | — |
| 22 | Migrations | **missing** | Repo has 4-5 migration files for competitions/sponsors/support only; **core tables (players, matches, coin_transactions, …) have no migration**; `supabase/prod_setup.sql` is a hand-run script. Prod schema differs from dev (indexes, see 18). Applied by hand. | Prod cannot be rebuilt from the repo | P1 | `supabase db dump` prod schema into a baseline migration; apply all changes via `supabase db push` |
| 23 | Backups / DR | unverified | Not visible via code or MCP. Supabase plan/PITR status unknown; no restore test, no RPO/RTO. | Unrecoverable ledger loss | P1 | Check Dashboard → Database → Backups; enable PITR on prod; nightly export of players/coin_transactions/comp_* |
| 24 | Failover / SPOF | missing | One Railway instance, one Supabase DB, one email provider, in-memory match state. | Any restart drops live matches | P1 | Accept for now; see 42/49 |

### D. Security

| # | Topic | Status | Evidence | Risk | Priority | Fix |
|---|---|---|---|---|---|---|
| 25 | Secrets | **partial (P0)** | `.env` git-ignored, never committed (`git log --all -- .env` empty). **Default master password `SpikeAndCrush2026!`** in code (admin/lib/auth.js:138) and in git history since `34a6878` (2026-09-06); **publicly downloadable** from prod admin (URGENT 1). No default JWT secret (admin refuses to start without `ADMIN_SECRET`, admin/server.js:30). `STRIPE_SECRET_KEY` defaults to `'sk_test_placeholder'` (index.js:59, harmless). Service key server-side only. | Full admin takeover | P0 | Remove fallback (refuse to start), rotate password, stop serving admin source |
| 26 | Authorisation / IDOR | partial | 127 game routes: 58 public, 69 `authenticate`. Admin `/api/*` behind `requireAdmin` + role checks. Internal bridge: secret + loopback socket check (internalAdmin.js:12-24, good). RLS on every table, SELECT-only policies; money functions not executable by anon/authenticated (dev SQL + prod advisor). **Bans are never enforced**: no reference to `is_banned`/`banned_until` in game server. `spectate:join` unrestricted (10). Admin JWT not checked against `admin_sessions.revoked` / `is_active` (auth.js:205-232). | Banned users keep playing; deactivated admins keep access ≤ 8 h | P1 | Check ban in `authenticate` + socket auth; check session/active on each admin request |
| 27 | OAuth | partial | Google via Supabase Auth (managed). **Discord**: `state` = player id (predictable, index.js connect handler) → CSRF/account-link; Supabase access token passed in query string `?token=` (logs/history). Scope `identify guilds.join` (needed). Redirect URI from `SITE_URL`. | Linking attacker's Discord to a victim; token in logs | P1 | Random state stored server-side; POST/exchange instead of token in URL |
| 28 | JWT | partial | Players: Supabase JWT verified via `getUser` each request. Admin: HS256 via `ADMIN_SECRET`, 8 h expiry, `algorithms` not pinned (jsonwebtoken v9 rejects `none`), cookie `httpOnly`, `sameSite=lax`, **no `secure` flag** (admin/server.js:90-94); no revocation (26). Player tokens in `localStorage` (XSS-exposed, see 34/39). | Token theft via XSS | P1 | `secure: true`; pin `algorithms:['HS256']`; revocation check |
| 29 | TLS / encryption | partial | HTTPS via Railway edge (HTTP/2). **No HSTS.** `http://spikeandcrush.com` apex answers from `awselb` 405 (GoDaddy forwarding) rather than a 301 to https. | Downgrade on first visit | P2 | HSTS header; fix apex redirect |
| 30 | WAF / DDoS | missing | `server: railway-hikari`, no Cloudflare/WAF; origins directly exposed. | Volumetric DoS | P2 | Cloudflare (free) in front of both hosts |
| 31 | CORS | present (prod) | `ALLOWED_ORIGIN` list, falls back to `'*'` when unset (index.js:66-70). Prod: no `Access-Control-Allow-Origin` for a foreign origin on API or socket polling (curl), so it is set. No credentials mode. | Wildcard if env lost | P2 | Refuse to start without `ALLOWED_ORIGIN` in production |
| 32 | CSRF | partial | Game API uses Bearer tokens (not cookies): not CSRF-able. Admin uses cookie + `sameSite=lax` (blocks cross-site POST), no CSRF token. | Low | P2 | Add CSRF token or `sameSite=strict` for admin |
| 33 | SQL injection | present | All DB access via supabase-js query builder / RPC with params; no raw SQL strings in app code. | — | P2 | — |
| 34 | XSS | partial | **Stored XSS via avatar upload (URGENT 2).** Core helpers escape (`TW.escapeHtml`, `renderUsername`, `createAvatar`); leaderboard verified. Chat is whitelisted presets (gameEngine.js sendChatMessage). Usernames accept any characters (register checks length only). `escapeHtml` does not escape quotes (unsafe in attributes). Sponsor links validated http(s) (sponsors.js:50). **No CSP** (curl). ~150 `innerHTML` sinks not individually traced. | Session theft | P0 (upload) / P1 (rest) | Fix upload; CSP; username charset `^[A-Za-z0-9_]{3,20}$`; escape quotes |
| 35 | SSRF | present | No server-side fetch of user-supplied URLs found (fetches are to fixed Discord/Resend/Stripe/Anthropic hosts). | — | P2 | — |
| 36 | Security headers | **missing** | `curl -I https://www.spikeandcrush.com/`: only `cache-control`, `server`, `x-railway-*`. No HSTS, CSP, `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`. No helmet in code. | Clickjacking, MIME sniffing, XSS impact | P1 | `helmet()` with a CSP allowing jsdelivr/Google Fonts/Supabase/Stripe |
| 37 | Input validation | partial | No schema library. Trades: symbol/direction/lot bounds checked (gameEngine.js openTrade). Register: length only. `express.json()` default 100 kb limit. Socket payloads mostly field-checked ad hoc. | Malformed input paths | P2 | zod on all bodies and socket payloads |
| 38 | Dependencies | partial | `npm audit --omit=dev`: **8 vulns (3 critical, 4 high, 1 moderate)**: proxy-addr (IP spoofing, affects rate-limit keys), engine.io DoS, compression/multer/body-parser DoS, shell-quote via `concurrently`, qs. All have fixes. Lockfile present; caret ranges. Outdated majors: stripe 16→23, express 4→5, @anthropic-ai/sdk 0.124→1.6. `concurrently` is a prod dependency. Node `engines >=22` but no `.nvmrc`. | Known exploitable DoS/spoofing | P1 | `npm audit fix`; move `concurrently` to dev; pin Node |
| 39 | File uploads | **missing (P0)** | Avatar: client mimetype only, original extension kept, stored in `client/uploads/avatars` (served same origin; Railway disk is ephemeral so avatars vanish on redeploy). Sponsor logos: multer memory + size limit, stored in Supabase Storage (logoValidation test exists). | Stored XSS; lost avatars | P0 | Sniff magic bytes, force extension from detected type, re-encode, store in Supabase Storage with `Content-Disposition`/separate domain |

### E. Delivery and operations

| # | Topic | Status | Evidence | Risk | Priority | Fix |
|---|---|---|---|---|---|---|
| 40 | CI/CD / tests | missing | No `.github/` (a `safe-deploy.yml` is referenced by uncommitted code but absent). 3 test files (logo validation, time-ago, support), **zero tests on ledger, webhooks, entry fees, settlement**. Railway auto-deploys `main` on push. | Money bugs ship unnoticed | P1 | CI: `npm ci`, `npm test`, `npm audit`; ledger/webhook tests (Proofs A-C as tests) |
| 41 | Build reproducibility | partial | No Dockerfile/nixpacks.toml; Railway Nixpacks default; lockfile present; no pinned Node. | Surprise Node upgrades | P2 | `.nvmrc` / `engines` exact; `npm ci --omit=dev` |
| 42 | Health / shutdown | missing (HEAD) | No `/health` or `/ready`; no SIGTERM handler at HEAD. Uncommitted `server/deployDrain.js` adds SIGTERM drain (in progress, not audited). Restart = all live matches lost. | Deploys kill live matches | P1 | `/health` (process) + `/ready` (DB ping); finish and commit drain |
| 43 | Deploys / rollback | partial | Railway keeps previous deploys (one-click redeploy). Hand-applied DB changes are not versioned, so rollbacks can mismatch schema. Blue-green/canary: not needed yet (trigger: >1 instance). | — | P2 | Backward-compatible migrations |
| 44 | Feature flags | partial | `app_settings` / `game_config` tables + admin game-config page exist. No single kill switch verified for shop, comp entry, AI support, sponsor strip. | Can't stop a bleeding feature fast | P2 | Flags checked at each of those routes |
| 45 | Logging | missing | `console.log/error` free text; no request ids, levels, or redaction; in-memory ring buffer for admin. Railway log retention per plan (unverified). | Hard incident forensics | P2 | pino + request id + redaction |
| 46 | Monitoring / alerts | missing | No uptime check, error tracking, or alerts in code. Tracing/SLOs: not needed yet. | Outages discovered by players | P1 | Uptime ping on `/health`, Sentry, alert on webhook/settlement failures |
| 47 | Latency / throughput | measured | See "Load test results". DB-backed endpoints 18-46 req/s, p95 0.4-1.6 s, p99 1.8-10 s, timeouts on `/api/stats/live` (3.3%) and `/api/stats/home`. In-memory endpoints 2,000-3,700 req/s, p99 ≤ 16 ms. | Landing/lobby slow under modest load | P1 | Cache stats 5-15 s; fix #19; indexes (#18) |
| 48 | Caching / CDN | missing | Static files `cache-control: public, max-age=0`; no server-side cache for stats/leaderboard; no CDN. | Repeated work per visitor | P2 | Fingerprinted assets with long max-age; 5-15 s in-memory cache on stats |
| 49 | Scaling / LB | not needed yet | Single instance assumed. **A second instance would break**: in-memory `matches`/sessions (players on different instances can't share a match), Socket.io rooms without Redis adapter, presence map, rate limits per instance, match timers. comp jobs are already safe (lease lock). Trigger: >~500 concurrent sockets or CPU > 70%. | — | P2 | Sticky sessions + Redis adapter + match state in Redis/DB when needed |
| 50 | DNS / HTTP versions | present | `www` → Railway (CNAME), apex A records at GoDaddy forwarding (`15.197.225.128`, `3.33.251.168`), NS `domaincontrol.com`. HTTP/2 at edge. gRPC/HTTP3: not needed. | — | P2 | — |
| 51 | Webhooks | partial | Stripe: signature ✔, fails closed without secret ✔, **no dedupe, no ordering handling, failures return 200** (#3, #5). No outgoing webhooks. | Lost/double credits | P0 | as 5 |
| 52 | API versioning | not needed yet | Unversioned `/api/*`; no changelog. Trigger: a mobile app. | — | P2 | `/api/v1` before mobile |
| 53 | IaC / k8s / serverless / cost | not needed yet | None in repo. Cost drivers (amounts unverified): Railway (2 services), Supabase (2 projects; prod plan unknown), Anthropic support chat (Haiku, per message), Resend. | Uncapped AI spend (see #1) | P2 | Anthropic spend limit; per-user chat cap |
| 54 | Incidents / on-call | missing | No runbook, incident template, owner or alert routing. | Slow response | P2 | One-page runbook (rollback, rotate secrets, pause shop) |

## 3. Money-path walkthrough

| Path | Atomic? | Idempotent? | Auditable? | Can go negative / double? |
|---|---|---|---|---|
| 1. Buy coins: `/api/coins/purchase` → Stripe → **webhook** `checkout.session.completed` **and** `/api/coins/verify-session` → `db.completeCoinPurchase` → `creditCoins` | No (3 separate HTTP writes) | **No** (no event dedupe, no unique session id, unconditional status update) | Ledger row written after balance update; if the insert fails the balance changed with no row | **Double credit proven (B).** Webhook failure is swallowed → credit lost. |
| 2. Competition entry → `compEngine.enter` → RPC `comp_enter` | **Yes** (single plpgsql function, `FOR UPDATE` on player) | Yes (existing account returned) | Yes (`competition_entry` ledger row inside the function) | No (checks coins ≥ fee under lock) |
| 3. Competition settlement → `settle` → `comp_close_position` / `comp_pay_prize` | Yes per account | Yes (`prize_paid` guard) | Yes | No; lease lock prevents two runners |
| 3b. Match prizes / refunds (non-competition) → `creditCoins` | **No** | Per-match guard (`endMatch` status) in one process only | Ledger row separate from balance write | **Lost updates proven (A)** when credits overlap |
| 4. Shop purchase `/api/shop/purchase` → `debitCoins` + `recordShopPurchase` | No | **No** (no unique player+item) | Ledger rows yes | **Duplicate purchase proven (C)**; balance can be undercharged (lost update) or overcharged |
| 4b. Match entry fee (`/api/match/create`, invite accept) | No | No | Yes | Player can join before the debit; failed debit leaves them in unpaid. Concurrent debits lose updates. |
| 5. Referral conversion: `/r/:code` cookie → register → `createReferralConversion`; admin approves; payouts recorded manually in `referral_payouts` (USD, manual) | n/a | No unique on `referral_conversions(player_id)` (one per registration in practice) | Admin actions in `admin_logs` | No automatic money movement; low risk |

### Proof output (dev database `tifsqiexbjcsazxwvavg` only, test account `designbot`)

Script: `race-proof.js` (calls the app's own `server/database.js`, refuses to run unless `SUPABASE_URL` is the dev project). Shop test: two simultaneous `curl` POSTs to a local server.

```
designbot start balance: 470
A. 5 concurrent creditCoins(+1): expected +5, balance moved +1  -> LOST UPDATE
B. completeCoinPurchase x2 concurrently on one 100-coin session: credit calls run = 2, balance moved +100 (expected +100) -> DOUBLE CREDIT
designbot balance restored to 470 (ledger rows of type audit_race_test / coin_purchase left in place as evidence)
C. before: 470 / req1 200 / req2 200 / after: 370 (moved -100)
C. shop_purchases rows for one item: 2, ledger shop_purchase rows: 2, balance moved -100 -> DUPLICATE PURCHASE + LEDGER/BALANCE MISMATCH. Balance restored to 470.
```

Ledger evidence (SQL on dev): five `audit_race_test +1` rows all with `balance_after = 471`; two `coin_purchase +100` rows for the single session `cs_audit_race_*`. In B the balance only rose 100 because the lost update in A masked the second credit: the ledger records 200 while the balance moved 100.

Upload proof (local copy of HEAD on :3022): `upload: {"avatarUrl":"/uploads/avatars/<player>-<ts>.html"}` → `HTTP/1.1 200 OK Content-Type: text/html; charset=UTF-8`. File deleted, avatar reset.

## 4. Load test results

Machine: Apple M1, 8 cores, 8 GB, macOS; Node v24.16.0; server = `git archive HEAD` copy on :3022 against **dev** Supabase (ap-southeast-1, from Dubai: includes ~WAN latency that Railway's Singapore region would mostly avoid). Load generator: own `httpload.js` (keep-alive, distinct `X-Forwarded-For` per request so the per-IP limiter does not dominate; this header is honoured only because no proxy is in front locally). 200-client socket match load: **not run** (see Unverified).

```
/                                  n= 40301 rps= 2015 p50=4.3ms   p95=10.1ms   p99=16.2ms    codes={200:40301}
/api/stats/ticker                  n= 73516 rps= 3676 p50=2.1ms   p95=5.9ms    p99=10.7ms    codes={200:73516}
/api/stats/home                    n=   351 rps=   18 p50=414.6ms p95=1035.0ms p99=10000.2ms codes={200:347,timeout:4}
/api/competitions                  n=   913 rps=   46 p50=143.3ms p95=430.7ms  p99=1793.4ms  codes={200:913}
/api/leaderboard?limit=50          n=   595 rps=   30 p50=268.7ms p95=474.5ms  p99=3798.3ms  codes={200:595}
/api/stats/activity                n=   874 rps=   44 p50=145.8ms p95=414.5ms  p99=1223.1ms  codes={200:872,timeout:2}
10-min soak /api/stats/live (c=10) n=  7360 rps=   12 p50=419.1ms p95=1579.5ms p99=10001.7ms codes={200:7118,timeout:242}
socket churn (50 auth'd sockets connect/5 s/disconnect, 10 min): {"cycles":109,"connected":4956,"errors":55}
event loop (perf_hooks, 10 ms resolution): boot 686 ms; soak stalls >100 ms at t=200..580 s, max 578 ms
heap per minute (MB): 69-94, 78-91, 80-102, 78-189, 90-121, 90-124, 76-114, 77-126, 81-121, 78-123, 77-108  (floor flat: no leak seen)
```

## 5. Top 10 risks (ranked)

1. **Admin source publicly served + hard-coded fallback master password** (prod verified exposure; password state unverified). P0
2. **Avatar upload → stored XSS → player session theft** (proven locally on HEAD). P0
3. **Coin balance updates are not atomic: lost updates** (proven A); ledger and balances diverge. P0
4. **Stripe purchase double credit** (proven B) + no event dedupe + failed credits acknowledged with 200 (lost). P0
5. **Shop double purchase / double charge** (proven C); match entry debit after join. P0
6. **No security headers / CSP / HSTS** on the live site. P1
7. **Bans not enforced; admin sessions not revocable; admin IP allowlist bypassable via `X-Forwarded-For`** (auth.js:21-34). P1
8. **DB-backed endpoints slow with multi-second tails; event-loop stalls up to 578 ms; landing stats scan all prize rows.** P1
9. **Schema not reproducible from repo; dev/prod drift; backups/PITR unverified; no CI or money-path tests.** P1
10. **Dependencies: 3 critical / 4 high advisories** (proxy-addr IP spoofing, engine.io DoS, …). P1

## 6. Could not verify (and what is needed)

- Whether `MASTER_ADMIN_PASSWORD`, `ADMIN_ALLOWED_IPS`, `STRIPE_WEBHOOK_SECRET` are set on Railway (needs Railway dashboard/CLI access; CLI not logged in). Did not attempt admin login.
- Supabase backups/PITR, plan tier, log retention, Auth rate limits (needs dashboard).
- Prod RLS policies table-by-table and prod row volumes (SQL was run on dev only; prod checked via advisors only).
- EXPLAIN at 100k rows (would require seeding a scratch DB; dev is shared with other sessions).
- 200-client socket.io load with match joins and trades (no Node socket.io client installed and installing packages was blocked; would also need 200 accounts, sign-up limited to 20/15 min/IP).
- Full trace of ~150 `innerHTML` sinks; organizer-supplied competition text rendering.
- Google OAuth redirect allowlist (Supabase/Google console).
- Uncommitted in-progress work (support system, deploy drain) was not audited.

## 7. Data touched (dev only)

- `coin_transactions`: 5 × `audit_race_test` (+1), 2 × `coin_purchase` (+100), 2 × `shop_purchase` (−100) for `designbot`; `coin_purchases`: 1 row `cs_audit_race_*`; `shop_purchases`: 2 × `frame_basic` for `designbot`. Balance restored to 470; avatar reset to null.
- Registered dev player `<i>audit</i>x` (email `xss-audit@example.com`) for the username-escaping check (not rendered on tested pages; inconclusive).
- No production writes. Production requests were read-only (`curl -I`, `HEAD`, one `GET` with a foreign `Origin`, DNS lookups).

## 8. Commands run

```
git status --short; git log --all --format=%h -- .env; git log --all -p -S "SpikeAndCrush2026"
grep -rn (secrets, rate limits, timeouts, innerHTML, is_banned, socket.on, setInterval, fetch) server admin client
npm audit --omit=dev [--json]; npm outdated
curl -sI https://www.spikeandcrush.com/ ; curl -sI http://spikeandcrush.com/ ; curl -sI https://www.spikeandcrush.com/css/main.css
curl -s -D - -o /dev/null -H "Origin: https://evil.example" https://www.spikeandcrush.com/api/stats/live (and /socket.io/?EIO=4&transport=polling)
curl -sI https://admin.spikeandcrush.com/{login.html,lib/auth.js,server.js} ; curl localhost:3003/{lib/auth.js,server.js,routes/system.js,lib/supabaseAdmin.js}
dig +short {admin.,www.,}spikeandcrush.com ; dig +short NS spikeandcrush.com
Supabase MCP (dev tifsqiexbjcsazxwvavg): tables/RLS/policies, constraints+indexes, columns, function definitions, function EXECUTE privileges, EXPLAIN ANALYZE x4, ledger evidence selects
Supabase MCP (prod yooqbpnqozitgbvfcfre): get_advisors security, performance
git archive HEAD | tar -x -C <scratch>/head ; PORT=3022 METRICS_FILE=… node -r monitor.js server/index.js
node race-proof.js ; 2× concurrent curl POST /api/shop/purchase ; curl -F avatar=@audit.html;type=image/png POST /api/player/avatar
node socketchurn.mjs http://localhost:3022 600 <token> ; node httpload.js http://localhost:3022 600 10 /api/stats/live
node httpload.js http://localhost:3022 20 10 / /api/stats/home /api/stats/ticker /api/competitions /api/leaderboard?limit=50 /api/stats/activity
```
(Helper scripts `race-proof.js`, `monitor.js`, `httpload.js`, `socketchurn.mjs` live in the session scratchpad, not the repo, per the "only create docs/AUDIT_REPORT.md" rule.)
