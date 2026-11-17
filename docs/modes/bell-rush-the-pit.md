# Bell Rush (stocks) and The Pit (futures)

Branch `stocks-futures-modes` (built on `match-engine`, which it needs for the Action Engine).

## Data: free for now

**Chosen: Dukascopy historical data feed** (free, no account, same pipeline as the existing forex/metals/indices data: `scripts/fetch-market-data.js` via the `dukascopy-node` package). 1-minute bars, 14 days for match windows (stocks: regular session only, about 3,910 bars each), plus 5-minute, hourly and daily history.

| Provider | Stocks intraday | Futures intraday | Price / free tier | Showing to players in a game |
|---|---|---|---|---|
| Dukascopy (used for forex today) | US stock CFDs, 1-minute | Futures-based CFDs (index, energy, metals, bonds, softs), 1-minute; not exchange futures, no roll | Free download | UNVERIFIED: Dukascopy's public pages are general disclaimers; the feed licence was not found ([terms](https://www.dukascopy.com/swiss/english/legal-pages/important-disclaimer)) |
| Alpaca | US stocks, minute bars (free plan: IEX real-time; SIP history older than 15 minutes) | No | Free plan with an account and API key ([docs](https://docs.alpaca.markets/docs/about-market-data-api)) | UNVERIFIED |
| Databento | Yes | CME futures with real contract rolls, 1-minute OHLCV | Pay as you go; $125 free credit for new accounts ([pricing](https://databento.com/pricing)) | UNVERIFIED |
| Polygon (now Massive) | Yes | Futures in newer plans | Sources disagree on a free tier | UNVERIFIED |
| Twelve Data | Yes (1min) | Limited | Free Basic plan, 8 credits/min, 800/day ([pricing](https://twelvedata.com/pricing.md)) | UNVERIFIED |

Recommendation when the game earns money: Databento for real futures with rolls (pay per GB, the free credit covers a prototype) and Alpaca or Databento for stocks. Nothing paid was bought or downloaded.

## Instruments (activity ranking chosen by the data)

Curation: `node scripts/curate-data.js --only stocks,futures --keep-all --out data/curated-modes`, then `node scripts/merge-mode-curation.js data/curated-modes --exclude VX,MA,OJ`. The existing 13 instruments and their ranking are unchanged.

- Ranking (activity score): AMD, INTC, MU, SNOW, ORCL, NVDA, PLTR, AVGO, TSLA, META, AMZN, CRM, GOOGL, MSFT, BA, Brent (BZ), BABA, XOM, QQQ, WTI (CL), VX, CVX, COST, JPM, AAPL, Cocoa, MA, V, UBER, Sugar, Silver, NQ, WMT, SPY, Gold, PYPL, NFLX, Platinum, RTY, ES, YM, Coffee, OJ, Copper, ZB, Palladium, Natural gas, Cotton, Euro FX, Soybeans, Dollar index.
- **Bell Rush offers 27 stocks**; not offered: MA (15 busy windows, flat stretches), COST (37 busy windows; at least 40 needed).
- **The Pit offers 20 futures**; not offered: VX (breaks the 15% price band), OJ (no valid window).
- Busy stock windows by New York start hour: 09:00 1,553 · 10:00 1,226 · 11:00 500 · 12:00 107 · 13:00 46 · 14:00 60 · 15:00 74 (the opening hour wins, as expected; nothing hard-coded).
- Missing from Dukascopy: COIN, MSTR, SHOP, DIS, ARM, SMCI, HOOD, ABNB, RIVN, LCID, SOFI.

## Modes

- Bell Rush (`stocks`): 600 s, about 8 stocks a match, ranked like Quick, coins only, 5 cards, bell icon, gold accent.
- The Pit (`futures`): 900 s, about 6 contracts a match, ranked like Quick, coins only, 5 cards, pit icon, green accent.
- `MODE_DURATIONS` gained two keys with existing lengths; no existing value changed (test).
- Stocks and futures are removed from every other mode (AAPL included). Private rooms can be a Bell Rush or The Pit room.
- On screen: "Simulated stocks" / "Simulated futures" beside the instruments; help, walkthrough intros and support text say "historical replay, simulated, not live prices".
- The modes appear in the lobby only when enough instruments have busy windows (data health gate).

## Motion table (200 matches each, Action Engine)

| Mode | Candles | Changes/s | Flat run worst | Flat % | Floor ok | Continuity |
|---|---|---|---|---|---|---|
| Bell Rush | 120 | 4 | 2 s | 0 | 100% | 100% |
| The Pit | 180 | 4 | 3 s | 0 | 100% | 100% |

## [LEGAL REVIEW]

1. Licence to show Dukascopy historical prices to players in a game (also applies to the forex data used today).
2. Showing real company names and tickers (AAPL, NVDA...) in a game with coin prizes; whether a disclaimer ("not affiliated, simulated replay") is needed or generic names should be used.
3. Futures shown with exchange-style codes (ES, CL, GC...) while the prices come from CFDs on those markets; the label says "simulated futures".
4. Even with dates hidden, scaled and mirrored prices, the data is derived from exchange data.

## Not done

- A per-mode instrument pool editor and Action Engine thresholds page in admin (the thresholds are config values in `market.actionEngine`; the existing per-instrument and per-mode switches work for the new symbols).
- An admin "Data health" page (the gate exists in code; the numbers are in this report and from `scripts/motion-report.js`).
- Real exchange futures with contract rolls (needs a paid source).
