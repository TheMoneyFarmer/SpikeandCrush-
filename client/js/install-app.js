'use strict';

// "Add to Home Screen" for phone players (never on desktop, never during a
// match). The installed app opens fullscreen, keeps a real landscape lock on
// Android and starts faster.
//   - Android Chrome / Samsung Internet: our card with an "Install app"
//     button that opens the browser's own install prompt.
//   - iPhone Safari (no install prompt exists): our card with the exact steps.
//     Other iPhone browsers: from iOS 16.4 their own Share menu; older: Safari.
//   - Where it appears: a slim lobby banner (stops after 3 dismissals), the
//     card on the result screen after a player's 1st and 3rd match on this
//     phone, and the steps in Settings and Help. Every surface has "Don't
//     show again". Installed sessions never see any of it.
//   - Counts (no player id) go to /api/pwa/event for the admin report.
(function () {
  window.TW = window.TW || {};
  const KEY = { never: 'tw_pwa_never', banner: 'tw_pwa_banner_dismissed', matches: 'tw_pwa_matches', seenApp: 'tw_pwa_seen_standalone', installed: 'tw_pwa_installed' };
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };
  const ua = navigator.userAgent || '';
  let deferred = null;

  function platform() {
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (ios) return /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua) || !/Safari/.test(ua) ? 'ios_other' : 'ios_safari';
    if (/Android/.test(ua)) {
      if (/SamsungBrowser/.test(ua)) return 'samsung';
      if (/Chrome\//.test(ua) && !/EdgA|OPR|Firefox|YaBrowser/.test(ua)) return 'android_chrome';
      return 'android_other';
    }
    return isMobile() ? 'other' : 'desktop';
  }
  function iosVersion() {
    const m = ua.match(/OS (\d+)[_.](\d+)/);
    return m ? Number(m[1]) + Number(m[2]) / 100 : null;
  }
  function isMobile() {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    return Boolean(coarse && Math.min(window.innerWidth, window.innerHeight) <= 600);
  }
  function isStandalone() {
    return Boolean((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true);
  }
  const eligible = () => isMobile() && !isStandalone() && platform() !== 'desktop';

  function send(kind) {
    try {
      fetch('/api/pwa/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, platform: platform() }), keepalive: true }).catch(() => {});
    } catch (e) { /* counting is best effort */ }
  }

  // ---- icons (inline SVG drawn for this card; not Apple or Google assets) ----
  const SHARE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M6 11v9h12v-9"/></svg>';
  const ADDSQ = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg>';
  const DOTS = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';
  const PHONE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>';
  const X = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  // The steps for one platform (also used on Settings and Help).
  function stepsHtml(p = platform()) {
    const v = iosVersion();
    if (p === 'ios_safari') {
      return `<ol class="ia-steps">
        <li><span class="ia-ic">${SHARE}</span><span>Tap <b>Share</b> (the square with the arrow) in the Safari bar.</span></li>
        <li><span class="ia-ic">${ADDSQ}</span><span>Scroll down and tap <b>Add to Home Screen</b>.</span></li>
        <li><span class="ia-ic"><b>Add</b></span><span>Tap <b>Add</b>. Open Spike &amp; Crush from your home screen.</span></li></ol>`;
    }
    if (p === 'ios_other') {
      return v && v >= 16.4
        ? `<ol class="ia-steps"><li><span class="ia-ic">${SHARE}</span><span>Tap <b>Share</b> in this browser.</span></li><li><span class="ia-ic">${ADDSQ}</span><span>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</span></li></ol>`
        : `<ol class="ia-steps"><li><span class="ia-ic">${PHONE}</span><span>Open spikeandcrush.com in <b>Safari</b>. This browser can't add it to the home screen on your iOS version.</span></li><li><span class="ia-ic">${SHARE}</span><span>In Safari tap <b>Share</b>, then <b>Add to Home Screen</b>, then <b>Add</b>.</span></li></ol>`;
    }
    if (p === 'android_chrome' || p === 'samsung') {
      return deferred
        ? '<p class="ia-p">Tap <b>Install app</b> below, then <b>Install</b>.</p>'
        : `<ol class="ia-steps"><li><span class="ia-ic">${DOTS}</span><span>Open the browser menu.</span></li><li><span class="ia-ic">${ADDSQ}</span><span>Tap <b>Install app</b> or <b>Add to Home screen</b>.</span></li></ol>`;
    }
    return `<ol class="ia-steps"><li><span class="ia-ic">${DOTS}</span><span>Open your browser menu.</span></li><li><span class="ia-ic">${ADDSQ}</span><span>Tap <b>Add to Home screen</b> (or <b>Install</b>).</span></li></ol>`;
  }

  function closeCard() { document.getElementById('iaCard')?.remove(); }

  // The install card. source: 'banner' | 'result' | 'settings' | 'help' | 'nudge'
  function showCard(source = 'banner') {
    if (!isMobile() || isStandalone()) return false;
    closeCard();
    const p = platform();
    const card = document.createElement('div');
    card.id = 'iaCard';
    card.className = 'ia-backdrop';
    card.innerHTML = `<div class="ia-card" role="dialog" aria-modal="true" aria-labelledby="iaTitle">
      <button type="button" class="ia-x" aria-label="Close">${X}</button>
      <div class="ia-head"><img src="/icons/icon-192.png" alt="" width="44" height="44" /><div><b id="iaTitle">Play as an app</b><span>Fullscreen, landscape and a faster start.</span></div></div>
      ${stepsHtml(p)}
      ${(p === 'android_chrome' || p === 'samsung') && deferred ? '<button type="button" class="ia-install">Install app</button>' : ''}
      <button type="button" class="ia-never">Don't show again</button>
    </div>`;
    document.body.appendChild(card);
    send('prompt_shown');
    const done = (kind) => { if (kind) send(kind); closeCard(); };
    card.querySelector('.ia-x').addEventListener('click', () => done('prompt_dismissed'));
    card.addEventListener('click', (e) => { if (e.target === card) done('prompt_dismissed'); });
    card.querySelector('.ia-never').addEventListener('click', () => { ls.set(KEY.never, '1'); hideBanner(); done('prompt_never'); });
    card.querySelector('.ia-install')?.addEventListener('click', async () => {
      send('install_click');
      const ev = deferred;
      deferred = null;
      if (!ev) return;
      ev.prompt();
      const choice = await ev.userChoice.catch(() => null);
      if (choice && choice.outcome === 'accepted') ls.set(KEY.installed, '1');
      closeCard();
    });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { document.removeEventListener('keydown', esc); done('prompt_dismissed'); } });
    card.dataset.source = source;
    card.querySelector('.ia-x').focus();
    return true;
  }

  // ---- lobby banner ------------------------------------------------------------
  function hideBanner() { document.getElementById('iaBanner')?.remove(); }
  function banner(container) {
    if (!eligible() || ls.get(KEY.never) === '1' || Number(ls.get(KEY.banner) || 0) >= 3) return false;
    if (document.getElementById('iaBanner')) return true;
    const el = document.createElement('div');
    el.id = 'iaBanner';
    el.className = 'ia-banner';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Install the app');
    el.innerHTML = `<span class="ia-bic">${PHONE}</span><button type="button" class="ia-bopen">Play as an app: fullscreen and landscape</button><button type="button" class="ia-bx" aria-label="Dismiss">${X}</button>`;
    (container || document.body).prepend(el);
    el.querySelector('.ia-bopen').addEventListener('click', () => showCard('banner'));
    el.querySelector('.ia-bx').addEventListener('click', () => {
      ls.set(KEY.banner, String(Number(ls.get(KEY.banner) || 0) + 1));
      send('prompt_dismissed');
      hideBanner();
    });
    return true;
  }

  // ---- after a match (result screen) ---------------------------------------------
  // Card after this phone's 1st and 3rd finished match; a one-line nudge
  // when the landscape lock was refused (iPhone browsers).
  function afterMatch(container, { lockFailed = false } = {}) {
    if (!eligible()) return { card: false, nudge: false };
    const n = Number(ls.get(KEY.matches) || 0) + 1;
    ls.set(KEY.matches, String(n));
    let nudge = false;
    if (lockFailed && container && ls.get(KEY.never) !== '1') {
      const line = document.createElement('p');
      line.className = 'ia-nudge';
      line.innerHTML = `${PHONE}<span>Install the app for fullscreen play.</span><button type="button">Install</button>`;
      line.querySelector('button').addEventListener('click', () => showCard('nudge'));
      container.appendChild(line);
      send('lock_failed_nudge');
      nudge = true;
    }
    const card = (n === 1 || n === 3) && ls.get(KEY.never) !== '1';
    if (card) setTimeout(() => showCard('result'), 2600);
    return { card, nudge, matches: n };
  }

  // Settings / Help: the steps for every platform, this phone's first.
  function renderSettings(container) {
    if (!container) return;
    const p = platform();
    const order = ['ios_safari', 'android_chrome', 'ios_other', 'samsung'].sort((a, b) => (b === p) - (a === p));
    const names = { ios_safari: 'iPhone (Safari)', ios_other: 'iPhone (other browsers)', android_chrome: 'Android (Chrome)', samsung: 'Samsung Internet' };
    container.innerHTML = `${isStandalone() ? '<p class="ia-p ia-ok">You are playing in the app.</p>' : ''}
      ${order.map((k) => `<details class="ia-plat" ${k === p ? 'open' : ''}><summary>${names[k]}${k === p ? ' <em>this phone</em>' : ''}</summary>${stepsHtml(k)}</details>`).join('')}
      ${!isStandalone() && (p === 'android_chrome' || p === 'samsung') ? '<button type="button" class="ia-install ia-settings-install">Install app</button>' : ''}
      <label class="ia-never-row"><input type="checkbox" ${ls.get(KEY.never) === '1' ? 'checked' : ''}/> Don't remind me to install</label>`;
    container.querySelector('.ia-settings-install')?.addEventListener('click', () => (deferred ? showCard('settings') : TW.toast && TW.toast('Use the browser menu: Install app or Add to Home screen', 'info')));
    container.querySelector('.ia-never-row input').addEventListener('change', (e) => ls.set(KEY.never, e.target.checked ? '1' : ''));
  }

  // ---- wiring -----------------------------------------------------------------------
  window.addEventListener('beforeinstallprompt', (e) => {
    if (!isMobile()) return; // desktop: let the browser do its own thing
    e.preventDefault();
    deferred = e;
  });
  window.addEventListener('appinstalled', () => { ls.set(KEY.installed, '1'); send('installed'); closeCard(); hideBanner(); });

  function boot() {
    if (!isMobile()) return;
    // Faster start for the installed app (static files only, see /sw.js).
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }
    if (isStandalone()) {
      try {
        if (!sessionStorage.getItem('tw_pwa_session')) { sessionStorage.setItem('tw_pwa_session', '1'); send('standalone_session'); }
      } catch (e) { /* ignore */ }
      if (ls.get(KEY.seenApp) !== '1') {
        ls.set(KEY.seenApp, '1');
        setTimeout(() => TW.toast && TW.toast('Opened as an app', 'success'), 800);
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  // A match played installed or in the browser (once per match, game page).
  function noteMatch(matchId) {
    if (!isMobile() || !matchId) return;
    const k = `tw_pwa_m_${matchId}`;
    try { if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); } catch (e) { /* ignore */ }
    send(isStandalone() ? 'match_installed' : 'match_browser');
  }

  TW.Install = { platform, isMobile, isStandalone, eligible, banner, showCard, afterMatch, renderSettings, noteMatch, stepsHtml, hasPrompt: () => Boolean(deferred) };
})();
