# Security to-do: dashboard steps only you can do

Short and in order of importance. No secrets in this file. Tick each one when done.

- [ ] **1. Claude API spend limit.**
  - console.anthropic.com > Settings > Limits (or Billing): set a **monthly spend limit** for the workspace that holds the support chat key.
  - The in-app cap is a second line of defence. It's set in admin > Support analytics (default 4,000,000 tokens a day), and you get an email at 50%, 80% and 100%.
- [ ] **2. Resend.**
  - resend.com > Domains: check spikeandcrush.com is verified.
  - API Keys: replace the key with one that has **Sending access** only, restricted to that domain (see docs/key-rotation.md).
  - The app now caps sending at 3,000 emails a day per server and 8 an hour to any one outside address. Change these with `EMAIL_DAILY_CAP` and `EMAIL_PER_RECIPIENT_HOUR` in Railway.
- [ ] **3. Rotate leaked keys.** The 21 November scan found none to rotate now. The old admin password fallback was already replaced on 12 November.
- [ ] **4. Stripe.** Stripe Dashboard > Developers > API keys: roll or delete the secret and restricted keys. Webhooks: delete the endpoint. Railway: delete any `STRIPE_*` variable.
- [ ] **5. Supabase.**
  - Check the service role key is only in Railway (game and admin), nowhere else.
  - Organization > Billing: keep the **Spend Cap** on, and add usage alerts if offered.
  - Authentication > Rate Limits: check the email and sign-in limits are on.
- [ ] **6. Railway.** Project > Settings > Usage: set a **usage limit** (hard cap) and an alert below it.
- [ ] **7. Cloudflare.**
  - Security > Bots: turn on **Bot Fight Mode**.
  - Security > WAF > Rate limiting rules: add rules for `/api/auth/*`, `/api/support/messages`, `/api/sponsors/lead` and `/api/leads`, for example 30 requests a minute per IP. The app limits these too.
  - Zero Trust > Access: protect `admin.spikeandcrush.com` with an email one-time-PIN policy for your own address, if you can (the free plan allows 50 users).
- [ ] **8. Two-factor authentication** on GitHub, Railway, Supabase, Cloudflare, Resend, the Claude Console, your email and your domain registrar. Use an authenticator app, and keep the recovery codes offline.
