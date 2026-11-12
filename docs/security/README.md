# Security checklist (2026-11-12)

Branch `security-checklist`. Builds on the 8 November audit (`docs/AUDIT_REPORT.md`), which already fixed the admin source leak, avatar XSS, coin races, headers, bans, socket limits and dependencies. This pass proved what was done and closed the gaps found.

## Status, item by item

| # | Item | Before | After | Evidence |
|---|---|---|---|---|
| 1 | API keys hidden | Done | Done | Secret scan of tracked files: 0 findings. Only the anon key reaches the browser (`/api/config/public`). |
| 2 | Env variables | Not done | **Done** | `.env.example` lists every variable (a test fails if one is missing). `server/envCheck.js` stops either server in production on a missing or placeholder required variable; it prints names only. |
| 3 | Admin routes | Done | Done | All 20 admin API prefixes: anonymous 401, player token 401; admin pages redirect to login; internal bridge 403 without its secret. |
| 4 | Authentication | Done | Done | Forged, expired, garbage and missing tokens on 4 player routes: all 401. No route takes a player id from the client. |
| 5 | Own data only | Partial | **Fixed in SQL (you run it)** | RLS on all 86 tables, SELECT-only policies. A signed-in player reading directly from Supabase sees only their own rows; 7 tables tried for writes: 0 rows changed; coin insert 403. **Leak found:** the public key could read sponsors' contact name and email, notes and links, placement links, template notes and tier prices. Migration `20261112130000_close_public_sponsor_reads.sql` closes it. |
| 6 | Sanitize forms | Partial | Partial | Fields are checked per route (lengths, http/https only for links, username charset). No shared schema library yet. |
| 7 | XSS | Partial | Partial | Text escaped, usernames restricted, uploads checked by bytes. CSP still allows inline scripts (60 pages use them). |
| 8 | Rate limiting | Partial | **Done** | 8 limiters (listings, `/go/`, sponsor slots, sponsor report, competition templates) counted Cloudflare's edge address, so all players shared one counter; now keyed on the real visitor. Support chat: new per-account limit (30 AI answers per hour) and a daily token cap (4,000,000); over a cap a human takes the message. |
| 9 | CORS | Done | Done | Live API gives no CORS header to a foreign origin; production refuses to start without `ALLOWED_ORIGIN`. |
| 10 | Headers | Done | Done | CSP, nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, COOP on both servers; HSTS live; no X-Powered-By. |
| 11 | Debug off | Partial | **Done** | `scripts/prod-check.js` (in CI). Fixed: admin server sent stack traces with file paths on bad input (now a plain 400/500); `/api/dev/add-coins` is no longer registered in production. On the old code the check reports 5 problems; on this branch 0. |
| 12 | Unused packages | Done | Done | Every dependency is imported. |
| 13 | Dependencies | Done | Done | `npm audit`: 0 vulnerabilities; CI fails on high or critical. |
| 14 | Exposed files | Done | Done | 27 sensitive paths 404 on the game server; admin source 404. |
| 15 | Database | Partial | Partial | Parameterised queries only; ledger changes only through server functions; balances never below zero. No tested restore (needs dashboard). |
| 16 | Passwords and tokens | Partial | **Done** | Supabase hashes passwords; sponsor report tokens hashed; listing secrets encrypted. Fixed: challenge links fell back to a fixed key in the source and statements to an empty key; both now use their own variable or a key derived from the service key. |
| 17 | Secrets in history | Partial | **Done** | `scripts/secret-scan.js`: 183 commits, 0 live secrets. The one known old leak (the removed admin password fallback) is allowlisted with a reason. Runs in CI and as a pre-commit hook (`npm run hooks`). |
| 18 | Full audit | Not done | Partial | Done: dependency audit, secret scan, header check, RLS policy review, admin route matrix, token forgery, direct database access as a player. Not done: OWASP ZAP (downloading it was blocked), restore test, 50-player soak. |

## Needs you

1. **Run the SQL** `supabase/migrations/20261112130000_close_public_sponsor_reads.sql` on dev and prod (SQL editor). Until then a real sponsor's contact email, name and notes can be read by anyone. The `competitions-page` migration re-creates `listing_tiers_read`; if it is run again after this one, run this one again too.
2. **Confirm `MASTER_ADMIN_PASSWORD` was changed** after 8 November. The old one is public in git history.
3. **Set on Railway (game service):** `CHALLENGE_SECRET` and `STATEMENT_SECRET` (64 random characters each). Without them the derived key is used, which is safe; setting `STATEMENT_SECRET` to a new value would make older statements fail verification, so only set it if it is unset now and you accept that.
4. **Test restore:** Supabase dashboard > Database > Backups > restore the latest into a new scratch project and compare row counts.

## Re-run every check

```
npm test                      # unit tests incl. test/security-checklist.test.js
npm run test:secrets          # secret scan over the whole git history
npm run test:prod             # production build check
npm audit --omit=dev --audit-level=high
npm run hooks                 # once per clone: pre-commit secret scan
```
