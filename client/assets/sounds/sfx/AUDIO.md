# Spike & Crush sound effects (Nov 2026)

Real recordings from Pixabay (Pixabay Content License: free for use in games, no attribution required; sources recorded anyway). No AI-generated items. Processed with the game-asset-pipeline `process_sfx.py`: leading silence trimmed, cut to length, faded, mono 44.1 kHz, peak-normalised, MP3 64 kb/s.

| Runtime file | Used for | Pixabay title | Author | ID | Raw bytes | Runtime bytes | Processing |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| `coin1.mp3` | Coins earned (variant A) | Money Pickup 2 | freesound_community | [89563](https://pixabay.com/sound-effects/89563/) | 11,702 | 3,177 | max 0.5s, fade 0.15s, peak -3 dBFS |
| `coin2.mp3` | Coins earned (variant B) | Coin Drop | Universfield | [229314](https://pixabay.com/sound-effects/229314/) | 41,472 | 7,775 | max 0.9s, fade 0.3s, peak -3 dBFS |
| `coin_big.mp3` | Big win / gold explosion | coins-falling-013 | freesound_community | [36967](https://pixabay.com/sound-effects/36967/) | 14,400 | 5,476 | max 0.8s, fade 0.25s, peak -2 dBFS |
| `tick.mp3` | Countdown tick | Clock Tick | freesound_community | [101150](https://pixabay.com/sound-effects/101150/) | 133,920 | 4,222 | max 0.45s, fade 0.1s, peak -5 dBFS |
| `win.mp3` | First place fanfare | Victory Fanfare | Universfield | [152480](https://pixabay.com/sound-effects/152480/) | 122,044 | 30,345 | max 3.8s, fade 0.8s, peak -2 dBFS |
| `whoosh.mp3` | You play a sabotage card | Simple Whoosh | DRAGON-STUDIO | [382724](https://pixabay.com/sound-effects/382724/) | 18,390 | 4,640 | max 0.6s, fade 0.2s, peak -3 dBFS |
| `card_place.mp3` | Card slap / card lands | Placing playing card | OxidVideos | [522514](https://pixabay.com/sound-effects/522514/) | 10,752 | 2,759 | max 0.4s, fade 0.1s, peak -3 dBFS |
| `hit.mp3` | A sabotage card hits you | Glitch_Hit_variation1 | wayofx | [604627](https://pixabay.com/sound-effects/604627/) | 257,280 | 10,074 | max 1.2s, fade 0.5s, peak -2 dBFS |
| `margin.mp3` | Margin alert | Warning Beep | Universfield | [153267](https://pixabay.com/sound-effects/153267/) | 65,201 | 13,417 | max 1.6s, fade 0.3s, peak -4 dBFS |
| `click.mp3` | Menu click (Menu sounds bus) | Soft UI Click | Universfield | [147352](https://pixabay.com/sound-effects/147352/) | 33,436 | 2,550 | max 0.25s, fade 0.08s, peak -6 dBFS |
| `notify.mp3` | Notification (Menu sounds bus) | New Notification 040 | Universfield | [493469](https://pixabay.com/sound-effects/493469/) | 34,272 | 8,193 | max 1.0s, fade 0.3s, peak -5 dBFS |
| `bell.mp3` | Match start (opening bell) | NYSEBell | freesound_community | [71414](https://pixabay.com/sound-effects/71414/) | 419,520 | 26,165 | max 3.2s, fade 1.2s, peak -3 dBFS |

Total: 1,162,389 -> 118,793 bytes (89.8% smaller).

## Levels in the game (js/sound.js)
Measured mean loudness differs by up to 20 dB between files, so `LEVEL` trims the loud ones at playback: bell 0.45, card hit 0.55, margin alert 0.6, fanfare 0.6, whoosh 0.75, everything else 1.0. Coins pick a random variant; coins, cards, clicks and ticks get +/-5% pitch jitter. Card hits, the fanfare and the margin alert duck the background music.

## Kept from the old set
`ambient` (lobby loop) and `match_timer` are unchanged: no Pixabay trading-floor ambience fit. The old WAV files stay in assets/sounds/ for those two.
