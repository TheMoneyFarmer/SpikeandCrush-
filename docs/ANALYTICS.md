# Analytics

Off by default. `client/js/analytics.js` is the only loader. With no provider set, nothing
loads and no cookie banner appears.

## Turn it on

Set these on the game service in Railway:

| Variable | Value |
|---|---|
| `ANALYTICS_PROVIDER` | `plausible` or `ga4` |
| `ANALYTICS_ID` | Plausible: your domain (`spikeandcrush.com`). GA4: the measurement ID (`G-XXXXXXX`) |

The site then shows the cookie banner, and scripts load only after a visitor accepts. The
security policy allows the provider's domain only while one is set.

## Events

No event carries an email, user id or username. Only `location`, `mode` and `type` are sent.

| Event | Fires when | Mark as conversion? |
|---|---|---|
| `page_view` | A page loads | |
| `cta_click` | A main call-to-action is clicked (`location`) | |
| `signup_started` | The sign-up form opens | |
| `signup_completed` | The sign-up thank-you page shows (once per visit) | Yes |
| `match_started` | A mode is chosen in the lobby (`mode`) | Yes |
| `competition_viewed` | A competition page opens (once per visit) | |
| `sponsor_form_submitted` | The sponsor thank-you page shows (once per visit) | Yes |
| `contact_submitted` | The contact thank-you page shows (once per visit) | |
| `referral_link_copied` | A player copies their invite link | |
| `support_opened` | The support button is clicked | |

Google sign-ups go straight to the lobby, so they don't count as `signup_completed`.
Admin pages don't load this file.

## Dashboard setup

- **Plausible**: add the site, then add the conversion events above under Goals as custom events.
- **GA4**: create a web data stream, then mark the conversion events above as key events.
