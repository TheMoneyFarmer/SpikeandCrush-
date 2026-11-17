# Leads centre (branch `leads-centre`)

## Where inquiries went before (Phase 0, checked 2026-11-16)

| Form | Stored | Email | Delivered to | Who replies |
|---|---|---|---|---|
| Partner with us (`/sponsor`) | yes, `sponsor_leads` | yes, to the inbox + confirmation to sender ("within two working days") | `hello@spikeandcrush.com` (hard-coded in `server/lobby.js`) | whoever reads hello@ |
| Support chat escalation | ticket + conversation; sponsor topic also `sponsor_leads` | support notification (`SUPPORT_NOTIFY_EMAIL`) | support inbox in admin | support agents |
| Coming soon "Notify me" | `competition_waitlist` | confirmation to the player | nowhere for the team | nobody |
| Feedback / bug report | no form existed | - | nowhere | - |
| 36 `mailto:hello@spikeandcrush.com` links | - | the visitor's own mail app | `hello@spikeandcrush.com` | whoever reads hello@ |

**Can hello@ receive mail?** MX for spikeandcrush.com is `inbound-smtp.ap-northeast-1.amazonaws.com`: Resend's receiving is switched on. It had stored 4 emails (7, 11, 11 and 14 November). Nothing forwarded them and no webhook was set, so they were only visible in the Resend dashboard. Not lost, but unseen.

DNS: DKIM `resend._domainkey` present; SPF on `send.spikeandcrush.com` present; DMARC `p=quarantine` present.

## What changed

- `leads`, `lead_notes`, `lead_events`, `lead_settings` (migration `20261116140000_leads_centre.sql`, RLS on, no client access).
- Every form lands in `leads` with a category: Partner with us (broker, prop firm, brand sponsor, other), support escalations, feedback and bug reports (new form on Help), waitlist joins (quiet).
- Same email + category within 30 days merges as a note. Honeypot, limits per IP (and per account for waitlists), captcha switch in settings (Turnstile keys needed to switch on).
- Team notification to `LEADS_NOTIFY_EMAILS` (default hello@), per-category routing in Admin > Leads > Settings. Auto-reply: "We received your message. A person will reply." plus a reply time only if you set one.
- An email failure is recorded on the lead (`email_status = failed`, red label in admin); the lead is never lost.
- Admin > Sponsors > **Leads**: tabs with counts and a red dot for unread New, search and filters (status, owner, priority, date range), sort by newest or next follow-up, detail with timeline and notes, status, owner, priority, follow-up date, tags, Reply (mailto draft), spam, Create sponsor account / Create partner listing (drafts through the existing editors), CSV export, pipeline summary, settings. Every change audit logged.
- Daily digest email per owner: overdue follow-ups and leads still New after N days.

## I must do this myself

1. Run `supabase/migrations/20261116140000_leads_centre.sql` on dev and prod. Until then the Partner form falls back to the old table and the new feedback form answers with "please email hello@".
2. **Read the 4 emails** waiting in Resend > Receiving.
3. Pick how to read hello@ going forward (one of):
   - **Forward in Resend** (simplest): Resend > Receiving > add a forwarding rule or webhook to your own inbox.
   - **A real mailbox** (Google Workspace or Zoho): this replaces Resend receiving. Set the MX records the provider gives you (and remove the `inbound-smtp...amazonaws.com` MX), keep `send.spikeandcrush.com` SPF and the Resend DKIM for sending, and add the provider's SPF include on the root domain.
4. Optional: set `LEADS_NOTIFY_EMAILS` on Railway (game and admin) to the address you actually read.
