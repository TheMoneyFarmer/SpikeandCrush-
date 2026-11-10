# Replay speed per mode (measured)

For each mode length and speed: price changes per real second, median range per real minute (bps), and how many 1-minute base candles form during the match. Medians over the kept instruments, 50 matches each. The guarantee (no flat stretch over 3s, every 3-minute stretch ranging at least the median 1-minute move) is already met at **1x** for every kept instrument (test/fire-market.test.js), so the lowest speed that meets it is 1x in every mode.

| Mode (s) | Speed | Changes / real s | Range bps / real min | 1m candles formed |
|---|---|---|---|---|
| 180 | 1x | 0.98 | 6.60 | 3 |
| 180 | 2x | 0.93 | 9.44 | 6 |
| 180 | 3x | 0.96 | 11.46 | 9 |
| 180 | 5x | 0.97 | 14.11 | 15 |
| 180 | 10x | 0.97 | 21.29 | 30 |
| 600 | 1x | 0.97 | 6.07 | 10 |
| 600 | 2x | 0.92 | 10.23 | 20 |
| 600 | 3x | 0.96 | 12.11 | 30 |
| 600 | 5x | 0.97 | 15.25 | 50 |
| 600 | 10x | 0.97 | 23.65 | 100 |
| 900 | 1x | 0.98 | 5.96 | 15 |
| 900 | 2x | 0.93 | 9.67 | 30 |
| 900 | 3x | 0.96 | 11.78 | 45 |
| 900 | 5x | 0.97 | 16.32 | 75 |
| 900 | 10x | 0.98 | 23.10 | 150 |
| 1200 | 1x | 0.97 | 7.08 | 20 |
| 1200 | 2x | 0.93 | 9.72 | 40 |
| 1200 | 3x | 0.96 | 11.75 | 60 |
| 1200 | 5x | 0.97 | 16.41 | 100 |
| 1200 | 10x | 0.98 | 24.00 | 200 |

**Chosen: 1x for every short mode** (config `market.replaySpeed`, admin-editable, capped at `market.maxReplaySpeed` = 5). Above 1x a 3-minute Blitz would cover 6+ minutes of market and every 1-second candle would jump several data seconds at a time; curation already removed the quiet stretches, so the extra speed only costs readability. Competitions stay at 1x.
