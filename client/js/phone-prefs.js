'use strict';

// Phone game settings (Settings page, game screen): saved on the account
// (settings.phone, cleaned by the server) and mirrored in this browser so the
// game screen can read them instantly.
//   rotate         turn the match to landscape on phones (default on)
//   confirmTrades  ask before a one-click BUY/SELL fills (default off)
//   defaultSlTp    prefill SL/TP in the quick ticket (default off) + slPips/tpPips
//   haptics        a short vibration on fills (default on)
(function () {
  window.TW = window.TW || {};
  const KEY = 'tw_phone_prefs';
  const DEFAULTS = { rotate: true, confirmTrades: false, defaultSlTp: false, slPips: 20, tpPips: 40, haptics: true };

  function clean(p) {
    const o = { ...DEFAULTS };
    if (!p || typeof p !== 'object') return o;
    for (const k of ['rotate', 'confirmTrades', 'defaultSlTp', 'haptics']) if (typeof p[k] === 'boolean') o[k] = p[k];
    for (const k of ['slPips', 'tpPips']) {
      const n = Number(p[k]);
      if (Number.isFinite(n) && n > 0 && n <= 100000) o[k] = Math.round(n * 10) / 10;
    }
    return o;
  }

  function get() {
    let local = null;
    try { local = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { /* none */ }
    const fromAccount = TW.getPlayer && TW.getPlayer() && TW.getPlayer().settings && TW.getPlayer().settings.phone;
    return clean({ ...(fromAccount || {}), ...(local || {}) });
  }

  async function set(patch) {
    const next = clean({ ...get(), ...patch });
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* this browser only */ }
    if (TW.api && TW.getToken && TW.getToken()) {
      try { await TW.api('/api/player/settings', { method: 'PATCH', body: { settings: { phone: next } } }); } catch (e) { /* kept locally */ }
    }
    return next;
  }

  TW.PhonePrefs = { get, set, DEFAULTS, clean };
})();
