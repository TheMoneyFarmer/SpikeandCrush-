# Phone game screen in landscape

On a phone, the game screen now plays sideways, with five tabs and one-tap trading. Players can also add the game to their home screen. The desktop and tablet screens are unchanged.

## What a player sees

- **Turning the phone.**
  - Android: the first tap starts fullscreen and locks the screen to landscape. Leaving the match exits fullscreen and unlocks it.
  - iPhone: Apple doesn't allow a website to lock the screen. If the phone is held upright, a "Turn your phone" card shows, with a "Play upright this time" button.
  - The setting "Rotate game to landscape" (Settings, Playing on your phone) turns all of this off.
- **The frame.**
  - Left rail: Assets, Chart, the gold Play button, Trade and Arena.
  - Top: a slim header and the spike alert strip.
  - Right rail: timer, P&L, equity and rank, lot chips (long press for every lot size), big BUY and SELL buttons, "open / max", and Close all.
- **Tabs.**
  - Chart: the chart, with cards and Heat in a band below it.
  - Play: the full order ticket, which pushes the chart aside rather than covering it.
  - Assets: every instrument's price, with a hot, warm or quiet dot.
  - Trade: open positions beside the standings.
  - Arena: cards, target picker, missions and the crown.
- **One-tap trading.**
  - BUY or SELL fills straight away at the server's price with the chosen lot. Prices and P&L always come from the server.
  - Settings can add a confirm step, default SL/TP and haptics.
  - Fill messages appear in the row above the chart, never on the price.
- **Install to home screen.**
  - Android: our own "Install app" card.
  - iPhone Safari: step-by-step instructions.
  - Other iPhone browsers: wording that fits the iOS version.
  - Where it shows: a lobby banner (stops after 3 closes), a card after a player's 1st and 3rd match, and entries in Settings and Help. Every place has "Don't show again".

## Where things live

| Piece | Files |
|---|---|
| Layout and orientation | `client/js/phone-land.js`, `client/css/phone-land.css` |
| Phone settings | `client/js/phone-prefs.js`, `client/settings.html` (saved in `settings.phone`) |
| Game interface the layout uses | `TW.Game` in `client/js/game.js` |
| Install flow | `client/js/install-app.js`, `client/css/install-app.css`, `client/sw.js`, `client/site.webmanifest` |
| Lot chips per mode | `server/config/gameFeel.js` → `phone` |
| Hot / warm / quiet levels | `server/curated.js` → `activityLevels()` |
| Install counts | `POST /api/pwa/event` → table `pwa_events_daily` (migration `20261116090000_pwa_events.sql`), admin page Analytics → App installs |
| Walkthrough | `server/config/tours.js` → `firstMatchPhone` |
| Help and support | Help page sections `#phone` and `#install`; support articles `playing-on-your-phone`, `install-app` |

What counts as a phone: a touch screen whose short side is 500px or less.

The service worker (`/sw.js`) is stamped with each deploy's version (`RAILWAY_GIT_COMMIT_SHA`). It is registered on phones only and caches static files only (css, js, icons, fonts, images), never pages, API, socket or price data.

## Tests

Every script is in `scripts/mobile-landscape/`. Results and screenshots are saved in the folder with the same name here.

| Check | Script | Result |
|---|---|---|
| Orientation | `orientation-check.js` | 10/11. The one "fail" is the measurement that ruled out CSS rotation: the chart's crosshair lands 390px away from the finger. |
| Layout, one-tap trading, touch targets, safe areas | `layout-check.js` | 21/21 |
| Install flow | `install-check.js` | 15/15 |
| 40-player match, 10 minutes | `forty.js` | 9/9. All 40 seated, and the 39 bots made 1,735 trades, 177 card plays and 408 SL/TP changes. Event listeners went from 263 to 267. Memory and page size go up and down as the browser cleans up, with no steady climb. 60 fps at the start and the end with the processor slowed 4×. |
| Screenshots, 5 landscape and 2 upright sizes | `tabs-shots.js` | `shots/` (27 images) |
| Baseline before any change | — | `baseline/` |
| Regression afterwards | `scripts/smoke.js`, `scripts/tour-check.js`, `scripts/fire/game-shots.js` | smoke 10/10, walkthroughs 53/53, unit tests 276/276. The desktop and upright game layouts match the baseline (`after/`); the chart's plot area differs by 14px only because the instrument was different. |

Run them against a local server on the dev database, never production. For example:

```
BASE=http://localhost:3070 ACCTS=<accounts json> node scripts/mobile-landscape/layout-check.js
```

`node scripts/admin-records/accounts.js setup 40 <file>` creates the test accounts, and `cleanup` removes them.
