# Key rotation runbook

How to replace every secret Spike & Crush uses. Values live only in Railway variables (game service and admin service) and, for local work, in a `.env` file that git ignores. Never paste a value into a chat, ticket, commit or email.

**Rotate right away** if a value was ever committed, logged, shown in a browser, sent to someone, or typed on a machine you no longer trust. Deleting it is not enough: the old value still works until it is rotated.

**General order for any secret:**
1. Create the new value at its source.
2. Put it in Railway on every service that uses it.
3. Redeploy those services.
4. Check the site works.
5. Revoke the old value at its source.

Steps 2 to 4 before step 5 is what keeps the site up.

## Status on 2026-11-21 (security pass, section A)

The scans of git history, the files the live site sends, and the logs found **no secret that needs rotating now**.

The only value ever leaked was the old admin password fallback (`MASTER_ADMIN_PASSWORD`, public in git history before 8 November). You changed it on 2026-11-12.

Old Stripe keys are no longer used by any code. **Revoke them** (see the last row of the table).

## Every secret

| Variable | Service | Used by | Rotate at | What breaks while rotating | Notes |
|---|---|---|---|---|---|
| `SUPABASE_SERVICE_KEY` | Supabase | game, admin | Supabase > Project Settings > API Keys | Everything that reads or writes the database, between revoking the old key and the redeploy finishing | Do game and admin together. With the new-style keys, create a new secret key, deploy, then delete the old one. |
| `SUPABASE_SECRET_KEY` | Supabase | game | Same page, new-style secret key | Auth IP forwarding falls back to the shared limit | Optional key. |
| `SUPABASE_ANON_KEY` | Supabase | game (sent to browsers) | Same page | Sign-in in open tabs until they reload | Public by design. Rotate only if the project is re-created. |
| `ANTHROPIC_API_KEY` | Claude Console | game | console.anthropic.com > API Keys | AI answers in support chat; messages go to a person meanwhile | Set a monthly spend limit on the workspace too. |
| `RESEND_API_KEY` | Resend | game, admin | resend.com > API Keys | All email: sign-up verification, resets, alerts | Use a sending-only key restricted to the spikeandcrush.com domain. |
| `RESEND_WEBHOOK_SECRET` | Resend | game | resend.com > Webhooks > the inbound webhook > signing secret | Forwarding of mail sent to hello@ | Roll the secret, update Railway, redeploy. |
| `ADMIN_SECRET` | ours | admin | Generate 64 random characters | Every admin is logged out | Expected, harmless. |
| `ADMIN_PASSWORD` | ours | admin | Pick a new 16+ character value | The shared admin login | Use personal admin accounts with 2FA instead where possible. |
| `MASTER_ADMIN_PASSWORD` | ours | admin | Pick a new 16+ character value | Super-admin login until redeployed | Rotated 2026-11-12. |
| `INTERNAL_ADMIN_SECRET` | ours | game, admin | Generate 64 random characters | Admin actions that reach live players (support replies, kicks) until both services run the new value | Set on both, then redeploy both. |
| `ORIGIN_SECRET` | ours + Cloudflare | game | Cloudflare Transform Rule value, then Railway | **The whole site, if the two differ while `ORIGIN_LOCK=on`** | Set `ORIGIN_LOCK=report` first, change Cloudflare, then Railway, redeploy, check `/health` shows `secret=ok`, then set `on` again. |
| `DEPLOY_DRAIN_TOKEN` | ours + GitHub | game, CI | GitHub repo > Settings > Secrets, and Railway | The deploy gate can't pause new matches; deploys wait | Change both to the same value. |
| `CHALLENGE_SECRET` / `JWT_SECRET` | ours | game | Generate 64 random characters | Challenge links already sent stop working | |
| `STATEMENT_SECRET` | ours | game, admin | Generate 64 random characters | Older account statements fail verification | Only rotate if leaked. |
| `IP_HASH_SECRET` | ours | game | Generate 64 random characters | Unique-visitor counts in sponsor stats restart that day | |
| `LISTING_SECRETS_KEY` | ours | game, admin | Generate a new key **and re-encrypt** stored partner links and codes first | Partner outbound links and codes can't be read | Ask an engineer: this one needs a re-encryption script before the switch. |
| `TURNSTILE_SECRET_KEY` | Cloudflare | game | Cloudflare > Turnstile > the widget > Rotate secret | Sign-up bot check until redeployed | |
| Google OAuth client secret | Google Cloud | Supabase Auth (not our servers) | Google Cloud Console > Credentials | "Continue with Google" | Paste the new secret into Supabase > Authentication > Providers > Google, for dev and prod. |
| Old Stripe keys and webhook secret | Stripe | nothing (Stripe was removed) | Stripe Dashboard > Developers > API keys and Webhooks | Nothing | **Roll or delete the secret and restricted keys, delete the webhook endpoint, delete any `STRIPE_*` variable still in Railway.** |

## After any rotation

- Load the site, sign in and play one match.
- Check `https://www.spikeandcrush.com/health` and `/ready`.
- Check the admin login works.
- Check the support chat answers, if the Anthropic key was rotated.
- Note the date in this file.
