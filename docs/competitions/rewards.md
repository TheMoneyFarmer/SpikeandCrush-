# Competition data engine and winner flow (branch `competition-rewards`)

## Phase 0

- Already built (prompts 01/02): Daily Open and Weekend Open templates with schedules (`server/compSchedule.js`), Coming soon states, `liveFeed.ready` switch (super admin, default off) and `liveFeed.healthy()` extension point, encrypted partner listing links (`competition_listing_secrets`) and the opaque `/go/l/<token>` redirect, sponsors and placements.
- Missing: a swappable data source, a market calendar, any winner flow (settlement only paid coin prizes), storage for an IB manager's contact. There was no `prizePayout` extension point under that name.

## What changed

- `server/marketDataSource.js`: HistoricalReplay (works now, labelled **"Demo market data"**) and a LiveFeed stub (every call throws "Live feed not connected"; never healthy, so competitions stay Coming soon even if `liveFeed.ready` is switched on). The competition engine reads every price through it (32 call sites).
- `server/marketCalendar.js`: New York hours per class (crypto always; forex Sun 17:00-Fri 17:00; Globex classes Sun 18:00-Fri 17:00 with the daily 17:00 break; stocks 09:30-16:00 weekdays, NYSE holidays). Live-data competitions get only classes open for the whole window. **Weekend Open: crypto only** (stocks, forex and futures are closed). Admin pool preview: `/api/rewards/pool-preview`.
- Winners: when a money-prize competition settles, the prize table (pool x breakdown) gives each winner a row **Pending review** with flags (shared IP between winners, account under 48 hours old, fewer than 5 trades, disqualified). Nothing is emailed until an admin approves.
- Claim email (branded, plain text, no emoji): rank, prize, the delivery sentence, a single-use link (only its SHA-256 stored, 14 days), the **partner disclosure**, the partner named only when the terms name them. Prop firms: "Claim your challenge".
- Claim page `/claim/<token>`: 18 or over, country checked against the partner's allowed and restricted lists, a separate unticked consent box (text version and time stored). The button is `/go/c/<token>`: the IB code is added on the server, the click is logged with a hashed IP. Expired, used and broken links get a friendly page.
- Statuses: Pending review, Approved, Email sent, Claimed, Link clicked, Registered, Verified, Standard account created, Prize requested, Prize credited, Closed, Declined, Ineligible, Expired, Manual payout. Automatic where we can see it; set by an admin otherwise, with history.
- Admin > Tournaments > **Competition Winners**: filters, approve (bulk), statuses, account number (stored encrypted, shown masked), **Send prize request** by email (only with consent) or a **prepared WhatsApp message** (never sent automatically), delete claim data, CSV export, manual payout queue, sponsoring partners with the IB manager contact encrypted and masked (super admin can reveal; logged). A reminder email goes out when a prize request is not marked credited after the partner's reminder days.
- No partner: no broker email; the winner is in the Manual payout queue and the email promises nothing beyond the terms. No payout is made by code.
- Terms and the competition detail page carry the delivery sentence and the disclosure before entry.

## Tests

`test/comp-rewards.test.js` (10): weekday pool has every class, Saturday only crypto and never a stock, the 17:00 break, Thanksgiving, DST; data source label and stub; prize table; winners recorded for review with flags, idempotent; approval email with disclosure and single-use hashed link; claim with and without consent; `/go/` adds the IB code server side and logs the click; prize request only with consent; WhatsApp prepared only; ineligible country; under 18; expired, reused and tampered links; prop-firm template; no-partner manual queue; secrecy of partner URL and codes. Full suite 286/286, production check clean. Live: claim page and API friendly for unknown links, no caching or indexing, admin routes 401 for anonymous and player.

Not run: a real end-to-end claim against the database (needs the SQL below and a real money-prize competition settling).

## I must do this myself

1. Run `supabase/migrations/20261117100000_competition_rewards.sql` on dev and prod.
2. In admin, add the sponsoring partner (name, type, partner listing id for the link, allowed/restricted countries, IB manager email and WhatsApp) and link it to the Daily Open / Weekend Open template (`competition_templates.partner_id`).

## [DECISION FOR ME]

1. **Daily Open window.** Recommended default: the US cash session, 09:30-16:00 New York (17:30-00:00 Dubai in winter, 18:30-01:00 in summer), when forex, crypto, stocks and futures are all open. To set it (template schedule, admin-editable): `{"days":[1,2,3,4,5],"timezone":"America/New_York","sessionName":"US session","open":"09:30","close":"16:00"}`.
2. **Weekend Open on live data is crypto only.** Richer options: crypto plus a clearly labelled simulated synthetic market, or a Friday-Monday mix. Not built (the calendar allows crypto only).

## [LEGAL REVIEW]

1. Sharing winner name, email and account number with a partner under the UAE data protection law (consent text, retention, cross-border transfer).
2. The prize terms: a prize credited by a third party to an account the winner must open, and eligibility by country.
3. The partner (IB) agreement and the disclosure wording.
4. Marketing: claim and prize emails are transactional; no marketing without a separate opt-in.
