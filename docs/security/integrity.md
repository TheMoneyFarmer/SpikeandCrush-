# Security and game integrity pass (branch `security-and-integrity`)

This builds on `docs/security/README.md` (security checklist, 12 November) and `docs/AUDIT_REPORT.md` (8 November). Items those reports proved are reused, not redone.

## Section A: secrets exposure and spend caps

| Item | Result | Evidence | Files |
|---|---|---|---|
| A1.1 Secret inventory | PASS | 73 variables listed in `.env.example`, each marked REQ, REC or OPT and as game, admin or both. Server-only keys: Supabase service and secret keys, Anthropic, Resend, Resend webhook, admin and internal secrets, signing and encryption keys, Turnstile secret, deploy drain token, origin secret. | `.env.example` |
| A1.2 Values that reach the browser | PASS | No `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_` or `PUBLIC_` variables (no build step). `/api/config/public` sends only the Supabase URL and **anon** key, analytics provider and id, the Turnstile site key, company details and footer links: all public by design. | `server/index.js` |
| A1.3 `.env` files and build | PASS | `.env` and `.env.*` are git-ignored. No env, dump, key or backup file is tracked. No Dockerfile; Railway builds with Nixpacks. Static serving is limited to `client/`. | `.gitignore` |
| A2.1 Built output and live scan | PASS | No build step. Playwright loaded 16 live pages: 90 HTML, JS, CSS and JSON responses (1.4 MB) scanned for 12 secret patterns. **0 findings.** The one `sk-` match was a competition slug made of words. The one JWT seen has role `anon`. | `scratchpad jsscan.js` |
| A2.2 Source maps | PASS | None in `client/`; `.map` requests 404 on the live site. | |
| A2.3 Bot paths, live | PASS | 31 paths (`/.env*`, `/.git/*`, `/package*.json`, `/server.js`, `*.sql`, `*.zip`, `/swagger`, `/metrics`, `/graphql`, `/wp-admin`, `*.php`, folder listings and more) on **both** www and admin: **all 404**. `/health` shows only `ok` and uptime. | |
| A2.4 Static serving | PASS (kept `ignore`) | Game: `express.static(client/, { dotfiles: 'ignore' })`. A dotfile request falls through to a plain 404, which reveals less than `deny`'s 403. Admin serves only `/css`, `/js`, `/components` and `/icons`. | `server/index.js`, `admin/server.js` |
| A2.5 Error pages | PASS | Unknown API route gives `{"error":"Not found"}`. Profile with a bad id gives a plain message. A malformed URL is turned away by Cloudflare's edge before it reaches us: the server kept running and its uptime kept rising, checked live. No stack traces (the production check script verifies this in CI). | `scripts/prod-check.js` |
| A2.6 Headers | PASS | `server: cloudflare`, no `X-Powered-By`, CSP on every page, HSTS, no CORS header for a foreign origin, admin `X-Robots-Tag: noindex` and robots `Disallow: /`. | |
| A2.7 Admin exposure | PARTIAL | `admin.spikeandcrush.com` behind Cloudflare with the origin lock on (direct requests 403), login rate limited, 2FA for the master account, not indexed. **Not behind Cloudflare Access** yet (dashboard step 7 in `docs/my-security-todo.md`). | |
| A2.8 Supabase and RLS | PASS (12 Nov) | Reused from the security checklist item 5: RLS on all tables, anon reads only public sponsor rows, 0 rows written by player tokens. The prod policy list you ran on 9 November matches. | |
| A2.9 Git history | PASS | `npm run test:secrets` (history mode): **0 findings**. The one known old leak (admin password fallback) is allow-listed and was rotated 12 Nov. | `scripts/secret-scan.js` |
| A2.10 Logs | FIXED | The email sender printed the recipient address when no Resend key was set; it now prints only the subject. Failed sends print a reason, never an address. Railway's own logs are UNVERIFIED (no access). | `admin/lib/email.js` |
| A3 Bot probes | FIXED | New probe guard on both servers: a plain 404 before any other work, counted in Tech health as a hashed visitor (never the IP), and a visitor who sends 20 probes in 10 minutes is blocked for 15 (`/health` always answers). Tested locally: 20 probes 404, then 429 site-wide for that visitor only. | `server/probeGuard.js` |
| A3 Startup check, env file | PASS (12 Nov) | `server/envCheck.js` stops both servers in production on a missing or placeholder variable. | |
| A3 Rotation runbook | DONE | `docs/key-rotation.md`. Nothing needs rotating now. | |
| A3 Old Stripe | PASS in code | No Stripe package, key or route left. **Revoke the keys in Stripe** (to-do item 4). | |
| A4.1 Support chat caps | FIXED | Per IP 20 messages per 15 minutes, per conversation 10 a minute and 50 a day per visitor. Message max 2,000 characters, reply max 1,024 tokens, AI answers per account 30 an hour, **new** 40 AI answers per conversation, daily token cap **now saved in the database** (a restart no longer resets it), **new** admin off switch and editable cap (Support analytics), **new** email alerts at 50, 80 and 100%. Over a limit a person takes the chat and the player sees "Support is busy right now… or email us". Never an error. | `server/support/budget.js`, `server/support/service.js`, `admin/routes/support.js`, `admin/support-analytics.html` |
| A4.2 Email abuse | FIXED | **New** per-recipient cap (8 an hour to any outside address) and daily cap (3,000 per server, alerts at 80% and 100%) inside the one email sender. **Fixed:** the partner and contact form confirmations repeated the visitor's typed name and company to whatever address they typed, so they could be used to send someone our email containing their text. They now repeat nothing typed. No endpoint sends free text to an address a visitor chooses. | `admin/lib/emailGuard.js`, `admin/lib/email.js`, `server/lobby.js`, `server/leads.js` |
| A4.3 Supabase and Railway spend | TO DO (you) | Steps in `docs/my-security-todo.md` items 5 and 6. Current dashboard settings UNVERIFIED (no dashboard access). | |
| A4.4 Abuse tests (dev) | PASS | Local server on dev, emails in dry run, no AI calls made (0 in the log): AI off gives the busy message; over the token cap gives the busy message; 22 rapid messages trip the limit with no 5xx; 20 probes then a block. Unit tests: `test/integrity-a.test.js` (6 tests). | |
| A5 Dashboard checklist | DONE | `docs/my-security-todo.md` | |

**Secrets to rotate now:** none found. Revoke the unused Stripe keys.
