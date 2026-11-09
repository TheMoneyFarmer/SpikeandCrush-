# Market curation report

Built by `node scripts/curate-data.js` from `data/market/<SYMBOL>/m1.csv.gz` (deterministic: same files, same output).

The files have **no volume or tick-count column**, so the 1-minute range is the activity measure.

## Instrument ranking (activity score = median 1-min range in bps x min(1, median range / 2 spreads) x share of live minutes)

| Rank | Instrument | Class | Median range bps/min | Mean abs return bps/min | Range / spread | Flat minutes % | Longest flat (min) | Score | Kept |
|---|---|---|---|---|---|---|---|---|---|
| 1 | ETHUSD | crypto | 10.88 | 5.35 | 2.60 | 0.5 | 2 | 10.832 | yes |
| 2 | AAPL | stocks | 6.11 | 3.82 | 4.22 | 0.4 | 1 | 6.086 | yes |
| 3 | BTCUSD | crypto | 5.90 | 3.29 | 3.20 | 1.3 | 3 | 5.828 | yes |
| 4 | BRENT | oil | 6.95 | 4.33 | 1.56 | 0.0 | 1 | 5.420 | yes |
| 5 | USOIL | oil | 6.92 | 4.35 | 1.40 | 2.5 | 6 | 4.724 | yes |
| 6 | XAGUSD | metals | 6.60 | 4.18 | 1.23 | 0.1 | 1 | 4.068 | yes |
| 7 | NAS100 | indices | 3.79 | 2.37 | 7.44 | 0.0 | 1 | 3.787 | yes |
| 8 | XAUUSD | metals | 3.40 | 2.12 | 3.97 | 0.0 | 1 | 3.403 | yes |
| 9 | GER40 | indices | 2.55 | 1.58 | 4.33 | 0.2 | 1 | 2.549 | yes |
| 10 | US30 | indices | 2.11 | 1.40 | 5.52 | 0.1 | 1 | 2.109 | yes |
| 11 | UK100 | indices | 2.15 | 1.33 | 1.15 | 0.3 | 2 | 1.233 | yes |
| — | **CUTOFF** (natural gap 2.31x after rank 11) | | | | | | | | |
| 12 | USDJPY | forex | 1.01 | 0.69 | 1.07 | 1.2 | 5 | 0.534 | yes (class minimum) |
| 13 | USDCHF | forex | 1.21 | 0.79 | 0.50 | 1.3 | 4 | 0.299 | yes (class minimum) |
| 14 | EURUSD | forex | 0.90 | 0.60 | 0.67 | 1.7 | 7 | 0.294 | no |
| 15 | GBPUSD | forex | 0.90 | 0.58 | 0.60 | 2.1 | 15 | 0.264 | no |
| 16 | AUDUSD | forex | 1.14 | 0.73 | 0.44 | 2.0 | 5 | 0.248 | no |
| 17 | NZDUSD | forex | 1.41 | 0.88 | 0.32 | 2.1 | 4 | 0.220 | no |
| 18 | USDCAD | forex | 0.78 | 0.50 | 0.50 | 1.8 | 8 | 0.192 | no |
| - | USTUSD | crypto | | | | | | | no: no real 1-minute data (synthetic fallback in game today) |

## Hot windows, playlists and the no-flat guarantee

Thresholds derived from the data: a bar is live when it spans at least 2 price points; every pair of consecutive bars must range at least the instrument's own median 1-minute range (shown below); a 30-minute window is hot when its average minute is at least 1.25x the median minute. Segments shorter than 20 minutes are dropped. Flat limit at seconds level: 3s.

| Instrument | Median 1m range | Active minutes in loop | Segments | Seams | Loop drift removed % | Price band vs median % | Valid starts 180s / 600s / 900s / 1200s | Spikes (top 1%) |
|---|---|---|---|---|---|---|---|---|
| ETHUSD | 2.60 | 6505 | 67 | 66 | -6.202 | -3.92 to +5.22 | 4939 / 4869 / 4819 / 4769 | 66 (>= 50.03 bps) |
| AAPL | 0.211 | 1070 | 16 | 15 | -0.281 | -1.42 to +0.85 | 822 / 808 / 798 / 788 | 11 (>= 36.76 bps) |
| BTCUSD | 48.0 | 5745 | 63 | 62 | -2.169 | -0.61 to +5.15 | 5745 / 5745 / 5745 / 5745 | 58 (>= 30.65 bps) |
| BRENT | 0.0780 | 3800 | 63 | 62 | 5.408 | -0.80 to +6.60 | 3552 / 3538 / 3528 / 3518 | 38 (>= 35.82 bps) |
| USOIL | 0.0700 | 4715 | 67 | 66 | 2.125 | -2.18 to +4.55 | 4174 / 4146 / 4126 / 4106 | 48 (>= 36.69 bps) |
| XAGUSD | 0.0370 | 4500 | 57 | 56 | -1.357 | -1.92 to +4.40 | 3622 / 3594 / 3574 / 3554 | 45 (>= 40.8 bps) |
| NAS100 | 11.2 | 3510 | 43 | 42 | -0.466 | -2.59 to +2.53 | 2774 / 2739 / 2714 / 2689 | 36 (>= 21.06 bps) |
| XAUUSD | 1.39 | 4310 | 56 | 55 | 0.045 | -2.65 to +1.11 | 3296 / 3247 / 3212 / 3177 | 44 (>= 18.2 bps) |
| GER40 | 6.50 | 5055 | 48 | 47 | 2.508 | -3.21 to +0.56 | 4149 / 4100 / 4065 / 4030 | 51 (>= 11.5 bps) |
| US30 | 11.0 | 4650 | 47 | 46 | 0.508 | -1.25 to +1.29 | 4059 / 4031 / 4011 / 3991 | 47 (>= 14.25 bps) |
| UK100 | 2.30 | 4935 | 40 | 39 | -0.364 | -1.12 to +0.59 | 3467 / 3402 / 3357 / 3312 | 50 (>= 10.76 bps) |
| USDJPY | 0.0160 | 4305 | 44 | 43 | -1.024 | -0.46 to +0.74 | 3888 / 3867 / 3852 / 3837 | 44 (>= 5.5 bps) |
| USDCHF | 0.000100 | 4995 | 46 | 45 | -0.464 | -0.82 to +0.94 | 4871 / 4864 / 4859 / 4854 | 50 (>= 6.07 bps) |

## Session hints

| Instrument | Hint | Result | Measured |
|---|---|---|---|
| ETHUSD | measured busiest hours (no prior hint) | n/a | busiest New York hours: 10:00 (1.52x), 11:00 (1.36x), 09:00 (1.31x), 12:00 (1.16x) |
| AAPL | US cash session 09:30-16:00 New York | did not hold | hint hours run at 1.10x the day average; busiest NY hours measured: 09:00 (2.51x), 10:00 (1.24x), 11:00 (0.93x), 15:00 (0.89x) |
| BTCUSD | measured busiest hours (no prior hint) | n/a | busiest New York hours: 10:00 (1.66x), 11:00 (1.39x), 09:00 (1.38x), 12:00 (1.17x) |
| BRENT | US session open 08:00-10:59 New York | HELD | hint hours run at 1.31x the day average; busiest NY hours measured: 11:00 (1.49x), 10:00 (1.46x), 09:00 (1.45x), 12:00 (1.30x) |
| USOIL | US session open 08:00-10:59 New York | HELD | hint hours run at 1.46x the day average; busiest NY hours measured: 09:00 (1.63x), 10:00 (1.61x), 11:00 (1.56x), 12:00 (1.33x) |
| XAGUSD | US session open 08:00-10:59 New York | HELD | hint hours run at 1.50x the day average; busiest NY hours measured: 09:00 (1.74x), 21:00 (1.65x), 10:00 (1.59x), 22:00 (1.31x) |
| NAS100 | US cash open 09:30-12:30 New York | HELD | hint hours run at 1.52x the day average; busiest NY hours measured: 10:00 (1.87x), 09:00 (1.82x), 16:00 (1.64x), 11:00 (1.30x) |
| XAUUSD | US session open 08:00-10:59 New York | HELD | hint hours run at 1.48x the day average; busiest NY hours measured: 09:00 (1.57x), 10:00 (1.56x), 21:00 (1.50x), 08:00 (1.30x) |
| GER40 | US cash open 09:30-12:30 New York | HELD | hint hours run at 1.27x the day average; busiest NY hours measured: 04:00 (1.72x), 03:00 (1.72x), 10:00 (1.50x), 09:00 (1.45x) |
| US30 | US cash open 09:30-12:30 New York | HELD | hint hours run at 1.72x the day average; busiest NY hours measured: 09:00 (2.28x), 10:00 (1.93x), 11:00 (1.45x), 16:00 (1.36x) |
| UK100 | US cash open 09:30-12:30 New York | HELD | hint hours run at 1.33x the day average; busiest NY hours measured: 03:00 (1.78x), 04:00 (1.78x), 09:00 (1.63x), 10:00 (1.51x) |
| USDJPY | London/New York overlap 08:00-11:00 New York | HELD | hint hours run at 1.33x the day average; busiest NY hours measured: 10:00 (1.44x), 09:00 (1.40x), 20:00 (1.36x), 03:00 (1.21x) |
| USDCHF | London/New York overlap 08:00-11:00 New York | HELD | hint hours run at 1.48x the day average; busiest NY hours measured: 10:00 (1.63x), 09:00 (1.54x), 17:00 (1.47x), 08:00 (1.27x) |

## Hot windows per instrument (source data times, UTC)

- **ETHUSD**: 10-16 01:10 (30m), 10-16 03:30 (60m), 10-16 08:00 (45m), 10-16 10:30 (80m), 10-16 11:55 (60m), 10-16 13:00 (105m), 10-16 14:50 (335m), 10-17 21:21 (45m), 10-18 19:23 (45m), 10-18 21:58 (50m), 10-18 23:13 (35m), 10-18 23:53 (60m), … 55 more
- **AAPL**: 10-16 13:34 (140m), 10-16 16:59 (70m), 10-16 18:14 (40m), 10-19 13:33 (75m), 10-20 13:33 (95m), 10-21 13:32 (35m), 10-21 14:52 (65m), 10-22 13:31 (90m), 10-22 15:06 (30m), 10-23 13:30 (75m), 10-26 13:34 (70m), 10-27 13:33 (45m), … 4 more
- **BTCUSD**: 10-16 03:30 (30m), 10-16 11:00 (35m), 10-16 13:05 (100m), 10-16 14:50 (95m), 10-16 16:40 (105m), 10-16 18:30 (95m), 10-17 21:23 (45m), 10-19 00:17 (35m), 10-19 01:02 (35m), 10-19 02:37 (30m), 10-19 10:22 (35m), 10-19 13:22 (200m), … 51 more
- **BRENT**: 10-16 13:55 (70m), 10-16 15:35 (160m), 10-19 01:00 (30m), 10-19 08:05 (30m), 10-19 13:25 (40m), 10-19 15:25 (75m), 10-19 16:45 (45m), 10-19 17:45 (30m), 10-20 05:56 (55m), 10-20 07:16 (135m), 10-20 11:31 (65m), 10-20 12:41 (240m), … 51 more
- **USOIL**: 10-16 08:20 (30m), 10-16 13:20 (140m), 10-16 15:45 (85m), 10-16 17:15 (40m), 10-19 00:59 (35m), 10-19 10:39 (45m), 10-19 12:49 (95m), 10-19 14:29 (70m), 10-19 15:44 (30m), 10-19 16:24 (65m), 10-19 17:44 (60m), 10-20 05:55 (60m), … 55 more
- **XAGUSD**: 10-16 00:50 (150m), 10-16 05:25 (45m), 10-16 12:30 (135m), 10-16 14:50 (50m), 10-16 17:25 (30m), 10-19 00:49 (60m), 10-19 01:49 (30m), 10-19 02:24 (45m), 10-19 05:49 (30m), 10-19 12:34 (30m), 10-19 13:29 (75m), 10-20 01:00 (40m), … 45 more
- **NAS100**: 10-16 00:10 (30m), 10-16 03:30 (30m), 10-16 12:30 (30m), 10-16 13:15 (405m), 10-19 00:14 (30m), 10-19 13:24 (140m), 10-19 15:44 (55m), 10-19 17:29 (40m), 10-19 23:59 (40m), 10-20 00:59 (45m), 10-20 05:29 (40m), 10-20 11:59 (35m), … 31 more
- **XAUUSD**: 10-16 00:50 (50m), 10-16 02:20 (50m), 10-16 03:35 (45m), 10-16 05:25 (45m), 10-16 12:15 (50m), 10-16 13:05 (230m), 10-19 00:54 (60m), 10-19 02:24 (35m), 10-19 05:49 (30m), 10-19 06:49 (40m), 10-19 11:54 (60m), 10-19 13:29 (90m), … 44 more
- **GER40**: 10-16 07:01 (105m), 10-16 08:51 (40m), 10-16 09:36 (35m), 10-16 10:51 (60m), 10-16 13:21 (125m), 10-16 15:31 (65m), 10-16 16:41 (130m), 10-16 19:11 (30m), 10-19 06:31 (235m), 10-19 10:26 (310m), 10-20 05:56 (55m), 10-20 06:56 (235m), … 36 more
- **US30**: 10-16 10:55 (30m), 10-16 12:10 (475m), 10-19 10:24 (50m), 10-19 11:19 (65m), 10-19 13:24 (210m), 10-20 06:16 (30m), 10-20 07:01 (40m), 10-20 07:41 (40m), 10-20 08:41 (55m), 10-20 09:36 (50m), 10-20 11:31 (100m), 10-20 13:16 (115m), … 35 more
- **UK100**: 10-16 07:00 (100m), 10-16 09:00 (70m), 10-16 13:25 (260m), 10-19 05:57 (30m), 10-19 06:47 (190m), 10-19 10:27 (45m), 10-19 11:52 (180m), 10-19 14:57 (50m), 10-20 05:53 (350m), 10-20 11:48 (205m), 10-20 15:29 (60m), 10-21 06:55 (145m), … 28 more
- **USDJPY**: 10-16 00:50 (30m), 10-16 03:35 (50m), 10-16 06:00 (130m), 10-16 11:35 (45m), 10-16 13:30 (160m), 10-16 16:35 (75m), 10-18 23:51 (35m), 10-19 00:51 (30m), 10-20 05:53 (35m), 10-20 07:08 (30m), 10-20 12:18 (200m), 10-21 13:09 (30m), … 32 more
- **USDCHF**: 10-16 03:35 (50m), 10-16 06:15 (150m), 10-16 08:50 (185m), 10-16 12:30 (325m), 10-18 23:58 (55m), 10-19 05:48 (35m), 10-19 06:28 (70m), 10-19 07:43 (85m), 10-19 09:13 (30m), 10-19 10:28 (55m), 10-19 12:18 (175m), 10-20 06:58 (40m), … 34 more
