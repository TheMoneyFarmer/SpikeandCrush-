# Account recovery (branch `auth-recovery`)

## What was wrong (Phase 0)

| Screen / route | Before |
|---|---|
| Sign-in drawer (`client/landing.html`) | No "Forgot password?" link. `main.js` listened for `#forgotPasswordLink`, but no page had that element. Its handler used a bare browser prompt. |
| `/forgot-password` | Did not exist. |
| `POST /api/auth/reset-password` | Same answer for every email, but slower for real accounts (the email was sent before replying), so timing showed which emails have accounts. Only the general 100 per 15 minutes per address limit. |
| `/reset-password` | Worked, but set the password in the browser (Supabase rules, 6 characters), left other devices signed in, sent no confirmation, and an expired link only showed a line of text. |
| Settings, change password | Checked the current password (good), 6+ characters, other devices stayed signed in, no confirmation email. |
| Settings, "Revoke" on a session | Only marked a row in our own table; nothing checked it, so the device stayed signed in. |
| Admin, "Reset Password" | Sent through Supabase's own mailer (rate limited, spam-prone) with a link to the **admin** address, which has no reset page. |
| Login limit per account | Counted wrong passwords for a username from anywhere, then blocked even the right password: anyone could lock a player out. |
| Supabase calls used | `signInWithPassword` (server), `admin.generateLink` (server), `signInWithOAuth` Google (client), `updateUser` (old reset page), `onAuthStateChange` (token refresh). Not used: `verifyOtp` in the app, `PASSWORD_RECOVERY` event. |
| Email delivery | Our own Resend sender for verification, reset and email-change mails; Supabase's mailer only as a fallback. DNS: DKIM `resend._domainkey` present, SPF on `send.spikeandcrush.com` present, DMARC `p=quarantine` present. |

## What changed

- Sign-in: **Forgot password?** under the password field (44 px), on desktop and phone (portrait and landscape); a wrong password says "Wrong username or password. Forgot password?"; too many attempts offers the reset link too.
- Sign-up: show/hide eye, live rules and a strength meter, "Already have an account? Sign in".
- One password rule everywhere (server checked): 8 to 72 characters, letters and at least one number.
- `/forgot-password`: one field, the same message for every email, reply sent before any email work (equal timing), limits 3 an hour per email and address, 10 an hour per address, 20 an hour per email from all addresses (env tunable).
- Branded reset email (our colours, plain text part, no emoji, expiry, "If you did not ask for this...").
- `/reset-password`: handles the recovery session, the same rules, saves through `POST /api/auth/complete-reset`; expired, used or broken links get a page with "Send me a new link"; after saving, this device is signed in and sent to the game, every other device is signed out, and a "Your password was changed" email goes out.
- Settings: confirm-new-password field, "Forgot your current password?", **Sign out of all other devices**, "Password last changed", and for Google-only accounts **Set a password** (emails a link).
- Signing out other devices really works: Supabase revokes their refresh tokens, and the game server refuses their current tokens (needs the migration below).
- Admin player page: **Send password reset email** (branded, player site link, audit logged), **Force sign-out all sessions** (audit logged), and a line with email verified, sign-in method, last sign-in and last password change.
- Login limit: per account and address (10 per 15 minutes), plus a wide per-account cap (100 per 15 minutes), so nobody can lock a player out.
- Support: new articles "I forgot my password" and "I did not get the reset or verification email"; the assistant is told never to say it cannot help with a password.

## I must do this myself

1. **Run the SQL** `supabase/migrations/20261116120000_auth_recovery.sql` on dev and prod (adds 3 columns to `players`). Until then, signed-out devices keep their current login for up to an hour (they still cannot refresh it).
2. **Supabase > Authentication > URL Configuration**
   - Site URL: `https://www.spikeandcrush.com`
   - Redirect URLs (add any missing):
     - `https://www.spikeandcrush.com/reset-password`
     - `https://www.spikeandcrush.com/auth-callback`
     - `https://spikeandcrush.com/reset-password`
     - `https://spikeandcrush.com/auth-callback`
     - `http://localhost:3000/**` (dev project only)
3. **Supabase > Authentication > Emails > SMTP Settings** (only used when our own sender is off, but set it so nothing falls back to Supabase's limited mailer):
   - Host `smtp.resend.com`, Port `465`, Username `resend`, Password `<your Resend key>`
   - Sender email `hello@spikeandcrush.com`, Sender name `Spike & Crush`
4. **Supabase > Authentication > Emails > Templates**: paste the four files in this folder (Confirm signup, Reset password, Change email, Magic link).
5. **Supabase > Authentication > Providers > Email**: minimum password length 8; email OTP expiry 3600 seconds (the reset email says 60 minutes; if you change it, set `RESET_LINK_MINUTES` to match).
6. **DNS**: nothing missing for sending (DKIM, SPF on the send subdomain, DMARC all present). Receiving mail at hello@ is a separate issue (see the leads report).

## Tests (local server, dev database, email dry run)

24 of 25 end-to-end checks pass. Not yet: "other device's current login refused at once" (needs the SQL above; their refresh is already refused). Unit tests: `test/auth-recovery.test.js` (6).
