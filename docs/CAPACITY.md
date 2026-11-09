# Capacity and operations

One server process. Measured on an Apple M1 core with the real match engine and
real bots, no database writes; Railway's CPUs may be slower.

| Live matches | CPU (one core) | Memory |
|---|---|---|
| 500 | 11% | 197 MB |
| 1,000 | 18% | 258 MB |
| 2,000 | 38% | 461 MB |

8,000 real sockets on the broadcast pattern: about 15% of a core, 30 KB each.
A second server is not supported yet: live matches, socket rooms and rate limits
are per process.

Railway replaces `X-Forwarded-For` with `[connecting address, its edge]`, so
`req.ip` is its edge. Use `visitorIp()` from `server/originLock.js` for anything
about the visitor. `TRUST_PROXY_HOPS` doesn't need changing.

## Settings (Railway variables)

| Variable | Default | What it does |
|---|---|---|
| `ORIGIN_LOCK` | `report` in production | `on` blocks requests that skip Cloudflare; `off` is the emergency switch. `/health` shows the result in its `X-Origin-Check` header |
| `ORIGIN_SECRET` | unset | Optional stronger check: only requests carrying this in `X-Origin-Secret` (added by a Cloudflare Transform Rule) count as Cloudflare. Set the rule first or the lock blocks everyone |
| `SUPABASE_SECRET_KEY` | unset | An `sb_secret` key. With IP Address Forwarding on in Supabase, logins count against each visitor instead of sharing the server's limit of about one sign-in every 2 seconds. Needed for launch |
| `MAX_LIVE_MATCHES` | `2000` | New matches are refused above this; running ones are never touched |
| `API_RATE_LIMIT` | `1500` | Requests per 15 minutes per visitor IP |
| `AUTH_RATE_LIMIT` | `100` | Login and sign-up attempts per 15 minutes per visitor IP |
| `LOBBY_IDLE_SECONDS` | `180` | A waiting room with nobody connected closes and refunds after this |
| `LOBBY_MAX_AGE_MINUTES` | `60` | No waiting room lives longer than this |
| `ALERT_EMAIL` | `hello@spikeandcrush.com` | Where server problem emails go |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | unset | Bot check on sign-up; off until both are set |
| `REPLAY_RETENTION_DAYS` | `90` | `0` keeps replays forever |
| `NOTIFICATION_RETENTION_DAYS` | `90` | Read notifications only |
| `COMP_SNAPSHOT_RETENTION_DAYS` | `30` | Equity curves after a competition settles |

## What runs in the background

- Every minute: a health line in the logs (`[ops] {...}`) with matches, sockets,
  memory and event loop delay; an email if memory or delay is too high.
- Every 30 seconds: abandoned waiting rooms close and refund.
- Every minute: matches lost to a crash are closed and refunded from the ledger.
- Once a day: old replays, read notifications and old equity curves are removed.

For an outside uptime check, monitor `GET /health` (process up) and `GET /ready`
(database reachable).

## Login checks

Logged-in requests and socket connections check the login token on this server
against Supabase's published public key (`server/authTokens.js`), so a slow or
down Supabase Auth doesn't cut off players already logged in. A logged-out
session's token keeps working until it expires (an hour at most). Bans are read
from the player record every time, so they apply at once.

## Load test

`scripts/load-test/`: starts a local server against the dev database and plays
virtual players through the real lobby, sockets, matches and competitions.

    node scripts/load-test/accounts.js setup 750   # once; logins take ~26 min (Supabase limit)
    node scripts/load-test/run.js 100,250,500,750 3
    node scripts/load-test/competition-scale.js 5000 1000
    node scripts/load-test/accounts.js cleanup

It refuses to run against anything but the dev project.
