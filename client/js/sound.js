'use strict';

window.TW = window.TW || {};

// All sound effects are generated procedurally via the Web Audio API - no
// external audio files. Volumes are per-viewer preferences stored in
// localStorage (audio settings are inherently per-device, unlike gameplay
// settings which sync server-side via /api/player/settings).
TW.Sound = (function () {
  const STORAGE_KEY = 'tw_audio_settings';
  const DEFAULTS = { master: 70, effects: 100, music: 50, ui: 60, muted: false };

  let ctx = null;
  let unlocked = false;

  function loadSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
    } catch (e) {
      return { ...DEFAULTS };
    }
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      /* storage unavailable - settings just won't persist across reloads */
    }
  }

  let settings = loadSettings();

  function getSettings() {
    return { ...settings };
  }

  function updateSettings(patch) {
    settings = { ...settings, ...patch };
    saveSettings(settings);
    if (ambientEl) {
      if (settings.muted) {
        stopAmbient();
      } else {
        ambientEl.volume = Math.min(1, Math.max(0, 0.15 * effectiveGain('music')));
      }
    }
  }

  function ensureContext() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Browsers block audio until a user gesture - arm a one-time unlock listener.
  function armUnlock() {
    if (unlocked) return;
    const unlock = () => {
      ensureContext();
      unlocked = true;
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }
  armUnlock();

  // Sliders are 0-100 but loudness is perceived logarithmically, so each
  // slider follows a squared (roughly -40 dB to 0 dB) taper instead of a
  // straight line - the bottom half of a slider now actually sounds quieter.
  const taper = (v) => Math.pow(Math.min(100, Math.max(0, v)) / 100, 2);
  function effectiveGain(category) {
    if (settings.muted) return 0;
    const fallback = category === 'ui' ? DEFAULTS.ui : 100;
    return taper(settings.master) * taper(settings[category] ?? fallback);
  }

  // Ducking: big moments (a card hitting you, the final bell) briefly dip the
  // background music so they cut through, then it recovers.
  let duckTimer = null;
  function duck(ms = 1400) {
    if (!ambientEl) return;
    const full = Math.min(1, Math.max(0, 0.15 * effectiveGain('music')));
    fadeAudioEl(ambientEl, full * 0.3, 120);
    clearTimeout(duckTimer);
    duckTimer = setTimeout(() => { if (ambientEl) fadeAudioEl(ambientEl, full, 600); }, ms);
  }
  // Sounds that repeat a lot get a slight random pitch so they don't grate.
  const VARY = new Set(['coin_earn', 'coin_big', 'sabotage_play', 'sabotage_receive', 'card_slap', 'countdown']);
  const DUCK = new Set(['sabotage_receive', 'win_fanfare', 'margin_alert']);

  // ---- real sound files (coin/countdown/win-fanfare/sabotage/ambient) -----------
  // Everything else (buy/sell, sl_hit/tp_hit, button clicks) stays procedural
  // Web Audio - these five events specifically use the licensed WAV assets.
  const SOUND_FILES_BASE = 'assets/sounds/';
  const FILE_SOUNDS = {
    // Nov 2026 set (Pixabay, real recordings, processed - see assets/sounds/sfx/AUDIO.md).
    // An array means variants: one is picked at random each time.
    coin_earn: ['sfx/coin1.mp3', 'sfx/coin2.mp3'],
    coin_big: 'sfx/coin_big.mp3',
    countdown: 'sfx/tick.mp3',
    win_fanfare: 'sfx/win.mp3',
    sabotage_play: 'sfx/whoosh.mp3',
    sabotage_receive: 'sfx/hit.mp3',
    match_bell: 'sfx/bell.mp3',
    notify: 'sfx/notify.mp3',
    ambient: 'music/lobby-loop.wav', // 64s seamless loop, 120 bpm A minor (WAV: MP3 padding would gap the loop)
    card_slap: 'sfx/card_place.mp3',
    margin_alert: 'sfx/margin.mp3',
    match_timer: '626908__muzakplz__marktimer.wav',
  };

  const audioElCache = new Map();
  function getAudioEl(filename) {
    if (audioElCache.has(filename)) return audioElCache.get(filename);
    const el = new Audio(SOUND_FILES_BASE + filename.split('/').map(encodeURIComponent).join('/'));
    el.preload = 'auto';
    audioElCache.set(filename, el);
    return el;
  }

  // Per-file trim so loud and quiet recordings sit at the same level
  // (measured mean loudness, see AUDIO.md).
  const LEVEL = { match_bell: 0.45, sabotage_receive: 0.55, margin_alert: 0.6, win_fanfare: 0.6, sabotage_play: 0.75 };
  function playFile(key, category = 'effects') {
    const entry = FILE_SOUNDS[key];
    if (!entry) return null;
    const filename = Array.isArray(entry) ? entry[Math.floor(Math.random() * entry.length)] : entry;
    const vol = effectiveGain(category) * (LEVEL[key] ?? 1);
    if (vol <= 0) return null;
    const el = getAudioEl(filename);
    // A fresh clone lets the same clip overlap itself (e.g. rapid coin awards)
    // without cutting off the previous play - cloneNode carries the src/preload
    // but needs its own load, harmless for these short one-shot clips.
    const instance = el.cloneNode();
    instance.volume = Math.min(1, Math.max(0, vol));
    if (VARY.has(key)) { instance.preservesPitch = false; instance.playbackRate = 0.95 + Math.random() * 0.1; }
    if (DUCK.has(key)) duck();
    instance.play().catch(() => {}); // autoplay-policy rejections pre-unlock are expected and harmless
    return instance;
  }

  let ambientEl = null;
  let ambientFadeInterval = null;

  function fadeAudioEl(el, toVolume, durationMs, onDone) {
    clearInterval(ambientFadeInterval);
    const steps = 20;
    const stepMs = Math.max(16, durationMs / steps);
    const startVolume = el.volume;
    let i = 0;
    ambientFadeInterval = setInterval(() => {
      i += 1;
      el.volume = Math.min(1, Math.max(0, startVolume + (toVolume - startVolume) * (i / steps)));
      if (i >= steps) {
        clearInterval(ambientFadeInterval);
        el.volume = toVolume;
        if (onDone) onDone();
      }
    }, stepMs);
  }

  // Trading Floor home screen only - subtle 15%-of-music-volume background loop.
  function startAmbient() {
    const filename = FILE_SOUNDS.ambient;
    if (!filename || settings.muted) return;
    if (ambientEl) return; // already playing
    ambientEl = getAudioEl(filename);
    ambientEl.loop = true;
    ambientEl.volume = 0;
    ambientEl.play().catch(() => {});
    fadeAudioEl(ambientEl, 0.15 * effectiveGain('music'), 1500);
  }

  function stopAmbient() {
    if (!ambientEl) return;
    const el = ambientEl;
    ambientEl = null;
    fadeAudioEl(el, 0, 800, () => el.pause());
  }

  // ---- primitives -----------------------------------------------------------

  function tone({ freq, freqEnd, duration, type = 'sine', gain = 0.2, delay = 0, category = 'effects' }) {
    const audio = ensureContext();
    if (!audio) return;
    const vol = effectiveGain(category) * gain;
    if (vol <= 0) return;

    const startAt = audio.currentTime + delay;
    const osc = audio.createOscillator();
    const gainNode = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startAt);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), startAt + duration);

    gainNode.gain.setValueAtTime(0, startAt);
    gainNode.gain.linearRampToValueAtTime(vol, startAt + Math.min(0.02, duration / 4));
    gainNode.gain.exponentialRampToValueAtTime(0.001, startAt + duration);

    osc.connect(gainNode).connect(audio.destination);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }

  function noise({ duration, filterFreq = 1200, gain = 0.2, delay = 0, category = 'effects' }) {
    const audio = ensureContext();
    if (!audio) return;
    const vol = effectiveGain(category) * gain;
    if (vol <= 0) return;

    const startAt = audio.currentTime + delay;
    const bufferSize = Math.floor(audio.sampleRate * duration);
    const buffer = audio.createBuffer(1, bufferSize, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const src = audio.createBufferSource();
    src.buffer = buffer;
    const filter = audio.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = filterFreq;
    const gainNode = audio.createGain();
    gainNode.gain.setValueAtTime(vol, startAt);
    gainNode.gain.exponentialRampToValueAtTime(0.001, startAt + duration);

    src.connect(filter).connect(gainNode).connect(audio.destination);
    src.start(startAt);
    src.stop(startAt + duration + 0.02);
  }

  function chime(freqs, stepMs, opts = {}) {
    freqs.forEach((freq, i) => tone({ freq, duration: 0.22, type: 'triangle', gain: 0.18, delay: (i * stepMs) / 1000, ...opts }));
  }

  // ---- named effects ----------------------------------------------------------

  const effects = {
    // ---- canonical named effects (exact spec: frequency/duration/waveform) ----
    buy: () => tone({ freq: 440, freqEnd: 660, duration: 0.2, type: 'sine', gain: 0.3 }),
    sell: () => tone({ freq: 660, freqEnd: 440, duration: 0.2, type: 'sine', gain: 0.3 }),
    profit: () => {
      [523, 659, 784].forEach((freq, i) => tone({ freq, duration: 0.05, type: 'sine', gain: 0.22, delay: i * 0.05 }));
    },
    loss: () => {
      [784, 659, 523].forEach((freq, i) => tone({ freq, duration: 0.08, type: 'sine', gain: 0.2, delay: i * 0.08 }));
    },
    sl_hit: () => tone({ freq: 200, duration: 0.3, type: 'square', gain: 0.4 }),
    tp_hit: () => {
      tone({ freq: 523, duration: 0.4, type: 'sine', gain: 0.22 });
      tone({ freq: 659, duration: 0.4, type: 'sine', gain: 0.22 });
    },
    card_play: () => playFile('sabotage_play'),
    card_receive: () => playFile('sabotage_receive'),
    // Big events get a cinematic low-end hit; everyday actions stay clean arcade blips.
    // The opening bell of a real stock exchange, over a low thump.
    match_start: () => {
      tone({ freq: 60, duration: 0.4, type: 'sine', gain: 0.35 });
      playFile('match_bell');
    },
    match_end: () => {
      tone({ freq: 440, freqEnd: 220, duration: 1.0, type: 'sine', gain: 0.22 });
      noise({ duration: 0.3, filterFreq: 300, gain: 0.15, delay: 0.2 });
    },
    win_fanfare: () => {
      tone({ freq: 70, duration: 0.5, type: 'sine', gain: 0.45 });
      noise({ duration: 0.2, filterFreq: 2500, gain: 0.2 });
      playFile('win_fanfare');
    },
    countdown: () => playFile('countdown'),
    coin: () => playFile('coin_earn'),
    card_slap: () => playFile('card_slap'),
    margin_alert: () => playFile('margin_alert'),

    // ---- aliases used by older call sites - same sounds, descriptive names ----
    buyPlaced: () => effects.buy(),
    sellPlaced: () => effects.sell(),
    closeProfit: () => effects.profit(),
    closeLoss: () => effects.loss(),
    stopLossHit: () => effects.sl_hit(),
    takeProfitHit: () => effects.tp_hit(),
    cardPlayedByYou: () => effects.card_play(),
    cardReceived: () => effects.card_receive(),
    matchStart: () => effects.match_start(),
    matchEnd: () => effects.match_end(),
    firstPlaceWin: () => effects.win_fanfare(),
    matchLoss: () => effects.match_end(),
    countdownTick: () => effects.countdown(),
    coinEarned: () => effects.coin(),

    newsBomb: () => {
      chime([784, 784, 988, 988], 140, { type: 'square', gain: 0.14 });
    },
    forceClose: () => {
      tone({ freq: 100, duration: 0.3, type: 'square', gain: 0.3 });
      noise({ duration: 0.2, filterFreq: 150, gain: 0.2 });
    },
    chartGhost: () => noise({ duration: 0.3, filterFreq: 2500, gain: 0.14 }),

    oneMinuteWarning: () => {
      for (let i = 0; i < 4; i++) tone({ freq: 1000, duration: 0.1, type: 'square', gain: 0.16, delay: i * 0.2 });
    },

    drumRoll: () => {
      for (let i = 0; i < 14; i++) tone({ freq: 150 + Math.random() * 40, duration: 0.06, type: 'square', gain: 0.1, delay: i * 0.08 });
    },
    goldExplosion: () => {
      playFile('coin_big');
      chime([784, 988, 1318, 1568], 60, { gain: 0.22 });
    },

    tabSwitch: () => tone({ freq: 500, freqEnd: 700, duration: 0.12, type: 'sine', gain: 0.08 }),
    leaderboardChange: () => tone({ freq: 1200, duration: 0.08, type: 'sine', gain: 0.1 }),

    // Margin elimination - three heavy warning pulses.
    lossLimit: () => {
      [0, 0.15, 0.3].forEach((delay) => {
        tone({ freq: 150, duration: 0.12, type: 'sawtooth', gain: 0.3, delay });
        noise({ duration: 0.08, filterFreq: 800, gain: 0.25, delay: delay + 0.02 });
      });
    },
    // Position Freeze / Lockout - digital glitch.
    freeze: () => {
      for (let i = 0; i < 5; i++) tone({ freq: 800 + i * 200, duration: 0.04, type: 'square', gain: 0.1, delay: i * 0.03 });
      noise({ duration: 0.1, filterFreq: 6000, gain: 0.15, delay: 0.05 });
    },
    tradeOpen: () => {
      noise({ duration: 0.04, filterFreq: 5000, gain: 0.2 });
      tone({ freq: 800, duration: 0.08, type: 'sine', gain: 0.2, delay: 0.02 });
      tone({ freq: 1200, duration: 0.06, type: 'sine', gain: 0.1, delay: 0.06 });
    },
    rankUp: () => {
      [523, 659, 784, 1046].forEach((freq, i) => tone({ freq, duration: 0.2, type: 'sine', gain: 0.22, delay: i * 0.08 }));
      tone({ freq: 1046, duration: 0.45, type: 'sine', gain: 0.18, delay: 0.32 });
    },
    notification: () => { playFile('notify', 'ui'); },
    friendRequest: () => {
      tone({ freq: 659, duration: 0.09, type: 'sine', gain: 0.18 });
      tone({ freq: 784, duration: 0.12, type: 'sine', gain: 0.15, delay: 0.07 });
    },
    playerJoined: () => {
      tone({ freq: 523, duration: 0.09, type: 'sine', gain: 0.15 });
      tone({ freq: 659, duration: 0.08, type: 'sine', gain: 0.12, delay: 0.07 });
    },
    success: () => {
      tone({ freq: 587, duration: 0.09, type: 'sine', gain: 0.2 });
      tone({ freq: 880, duration: 0.12, type: 'sine', gain: 0.15, delay: 0.07 });
    },
    error: () => {
      tone({ freq: 300, duration: 0.1, type: 'square', gain: 0.12 });
      tone({ freq: 200, duration: 0.1, type: 'square', gain: 0.1, delay: 0.08 });
    },
    warning: () => {
      [0, 0.12].forEach((delay) => tone({ freq: 500, duration: 0.1, type: 'sine', gain: 0.2, delay }));
    },
    tick: () => tone({ freq: 800, duration: 0.04, type: 'sine', gain: 0.1 }),

    // ---- names from the sound-system spec, mapped onto the effects above ----
    matchWin: () => effects.win_fanfare(),
    tradeProfitClose: () => effects.profit(),
    tradeLossClose: () => effects.loss(),
    slHit: () => effects.sl_hit(),
    tpHit: () => effects.tp_hit(),
    cardPlayed: () => effects.card_play(),
    navigate: () => effects.tabSwitch(),
    coinReceived: () => effects.coin(),
    finalTick: () => effects.countdown(),
  };

  function play(name) {
    const fn = effects[name];
    if (fn) fn();
  }

  return { play, getSettings, updateSettings, DEFAULTS, startAmbient, stopAmbient };
})();

// SoundEngine-style API over TW.Sound, so there's still exactly one engine
// and one set of saved settings (tw_audio_settings) - the nav mute button,
// the settings sliders and these calls all read and write the same values.
window.SoundEngine = {
  play: (name) => TW.Sound.play(name),
  init: () => {},
  setVolume: (v) => TW.Sound.updateSettings({ master: Math.round(Math.max(0, Math.min(1, v)) * 100) }),
  getVolume: () => TW.Sound.getSettings().master / 100,
  setEnabled: (on) => TW.Sound.updateSettings({ muted: !on }),
  getEnabled: () => !TW.Sound.getSettings().muted,
};
