# Personal data we keep (analytics view)

Every field below is read only by the servers (Supabase RLS on, no client policies) and the admin panel.

| Where | Field | What it is | Kept for | Notes |
|---|---|---|---|---|
| `players` | email, username | account identity | while the account exists | not analytics; never in any export or sponsor report |
| `players` | country | self-reported country | while the account exists | country only |
| `players` | first_source, first_medium, first_campaign, first_referrer, first_partner, first_landing, first_seen_at | where the player first came from | while the account exists | campaign codes, referring site host, landing path; no full URLs. `[LEGAL REVIEW]` |
| `players` | is_internal | internal (admin, test) flag | while the account exists | |
| `login_events` | ip, user_agent | raw address and browser string at login | **30 days**, then cleared (`LOGIN_IP_RETENTION_DAYS`) | row (time, player) kept as login history. `[LEGAL REVIEW]` |
| `sessions` | ip, user_agent | raw address and browser string of a login session | **30 days**, then cleared | same job |
| `analytics_events` | user_id | signed-in player behind an event | 400 days (`ANALYTICS_RETENTION_DAYS`) | never in sponsor reports |
| `analytics_events` | anonymous_id | first-party visitor id, **only after cookie consent** | 400 days | removed from the browser on "Reject" |
| `analytics_events` | visitor_day_hash | HMAC of address + browser with a salt that changes every UTC day | 400 days | cannot be reversed or linked across days; no raw address is ever stored |
| `analytics_events` | coarse_country, device_class, browser_family | country code, phone/tablet/desktop, browser family | 400 days | never a city or coordinates |
| `analytics_events` | page, referrer, utm_* | page path, referring host, campaign tags | 400 days | query strings are cut off |
| `tech_events` | player_id | who disconnected or froze | **90 days** (`TECH_EVENT_RETENTION_DAYS`) | |
| `comp_winners` | consent, country, account number (encrypted) | prize claims | until the winner asks for deletion | existing rewards flow |

Not stored anywhere: precise location, raw IP in analytics, full browser string in analytics, emails or tokens in events.

Third parties: Cloudflare Web Analytics (cookieless, runs for every visitor, before consent: `[LEGAL REVIEW]`); Google Analytics 4 (only after "Accept").
