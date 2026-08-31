'use strict';

window.TW = window.TW || {};

// All sound effects are generated procedurally via the Web Audio API - no
// external audio files. Volumes are per-viewer preferences stored in
// localStorage (audio settings are inherently per-device, unlike gameplay
// settings which sync server-side via /api/player/settings).
TW.Sound = (function () {
  const STORAGE_KEY = 'tw_audio_settings';
  const DEFAULTS = { master: 70, effects: 100, music: 50, muted: false };

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

  function effectiveGain(category) {
    if (settings.muted) return 0;
    const master = settings.master / 100;
    const cat = (settings[category] ?? 100) / 100;
    return master * cat;
  }

  // ---- real sound files (coin/countdown/win-fanfare/sabotage/ambient) -----------
  // Everything else (buy/sell, sl_hit/tp_hit, button clicks) stays procedural
  // Web Audio - these five events specifically use the licensed WAV assets.
  const SOUND_FILES_BASE = 'assets/sounds/';
  const FILE_SOUNDS = {
    coin_earn: '693840__philip_berger__collecting-coins.wav',
    countdown: '243070__timbre__remix-of-167385__ultradust__wood-block-tick-tock-cartoon-clock.wav',
    win_fanfare: '415504__exchanger__tadaa.wav',
    sabotage_play: '322216__liamg_sfx__arrow-impact-1.wav',
    sabotage_receive: '322222__liamg_sfx__arrow-impact-5.wav',
    ambient: '377793__little_wall__collectable-videogame-sound-compilation.wav',
    card_slap: '45821__themfish__slap-cards.wav',
    margin_alert: '221522__robinhood76__04949-buzzing-alert-analog-looping.wav',
    match_timer: '626908__muzakplz__marktimer.wav',
  };

  const audioElCache = new Map();
  function getAudioEl(filename) {
    if (audioElCache.has(filename)) return audioElCache.get(filename);
    const el = new Audio(SOUND_FILES_BASE + encodeURIComponent(filename));
    el.preload = 'auto';
    audioElCache.set(filename, el);
    return el;
  }

  function playFile(key) {
    const filename = FILE_SOUNDS[key];
    if (!filename) return null;
    const vol = effectiveGain('effects');
    if (vol <= 0) return null;
    const el = getAudioEl(filename);
    // A fresh clone lets the same clip overlap itself (e.g. rapid coin awards)
    // without cutting off the previous play - cloneNode carries the src/preload
    // but needs its own load, harmless for these short one-shot clips.
    const instance = el.cloneNode();
    instance.volume = Math.min(1, Math.max(0, vol));
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
    match_start: () => {
      tone({ freq: 220, duration: 0.3, type: 'sine', gain: 0.24 });
      tone({ freq: 330, duration: 0.3, type: 'sine', gain: 0.24, delay: 0.3 });
      tone({ freq: 440, duration: 0.5, type: 'sine', gain: 0.24, delay: 0.6 });
    },
    match_end: () => tone({ freq: 440, freqEnd: 220, duration: 1.0, type: 'sine', gain: 0.22 }),
    win_fanfare: () => playFile('win_fanfare'),
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
      noise({ duration: 0.4, filterFreq: 3000, gain: 0.18 });
      chime([784, 988, 1318, 1568], 60, { gain: 0.22 });
    },

    buttonClick: () => tone({ freq: 700, duration: 0.05, type: 'square', gain: 0.08, category: 'effects' }),
    tabSwitch: () => tone({ freq: 500, freqEnd: 700, duration: 0.12, type: 'sine', gain: 0.08 }),
    leaderboardChange: () => tone({ freq: 1200, duration: 0.08, type: 'sine', gain: 0.1 }),
  };

  function play(name) {
    const fn = effects[name];
    if (fn) fn();
  }

  return { play, getSettings, updateSettings, DEFAULTS, startAmbient, stopAmbient };
})();
