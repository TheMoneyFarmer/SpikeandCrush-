'use strict';

// The one analytics loader, and the one cookie banner. Off unless ANALYTICS_PROVIDER
// is set on the server: with no provider there is nothing non-essential to consent
// to, so no banner appears and nothing loads. Never sends emails, ids or usernames.
//
// Also fills in company details and shows the one-time Terms update notice.
(function () {
  const CONSENT_KEY = 'sc_consent';
  const SIX_MONTHS = 183 * 24 * 60 * 60 * 1000;
  const ALLOWED_PROPS = new Set(['location', 'mode', 'type']);
  const MAX_EVENTS_PER_MINUTE = 30;
  const NO_BANNER = /^\/(game|lobby|spectate|competition\/|competition-play)/;

  let provider = 'none';
  let analyticsId = null;
  let ready = false;
  const queue = [];
  const sent = [];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    session(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    setSession(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };

  function consent() {
    try {
      const saved = JSON.parse(store.get(CONSENT_KEY));
      if (saved && Date.now() - saved.at < SIX_MONTHS) return saved.choice;
    } catch (e) { /* unreadable: ask again */ }
    return null;
  }

  function send(name, props) {
    const clean = {};
    for (const [k, v] of Object.entries(props || {})) if (ALLOWED_PROPS.has(k)) clean[k] = String(v).slice(0, 40);
    const now = Date.now();
    while (sent.length && now - sent[0] > 60000) sent.shift();
    if (sent.length >= MAX_EVENTS_PER_MINUTE) return;
    sent.push(now);
    if (provider === 'plausible' && window.plausible) window.plausible(name, { props: clean });
    if (provider === 'ga4' && window.gtag) window.gtag('event', name, clean);
  }

  function track(name, props) {
    if (provider === 'none' || consent() !== 'accepted') return;
    if (!ready) { queue.push([name, props]); return; }
    send(name, props);
  }

  // Counts once per visit, so a refresh doesn't double-count a conversion.
  function trackOnce(name, props) {
    const key = `sc_once_${name}`;
    if (store.session(key)) return;
    store.setSession(key, '1');
    track(name, props);
  }

  function loadProvider() {
    if (ready || provider === 'none' || !analyticsId || consent() !== 'accepted') return;
    const script = document.createElement('script');
    script.async = true;
    if (provider === 'plausible') {
      window.plausible = window.plausible || function plausibleQueue() { (window.plausible.q = window.plausible.q || []).push(arguments); };
      script.dataset.domain = analyticsId;
      script.src = 'https://plausible.io/js/script.manual.js';
    } else if (provider === 'ga4') {
      window.dataLayer = window.dataLayer || [];
      window.gtag = function gtag() { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      window.gtag('config', analyticsId, { send_page_view: false, anonymize_ip: true });
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(analyticsId)}`;
    } else {
      return;
    }
    document.head.appendChild(script);
    ready = true;
    send('page_view', {});
    queue.splice(0).forEach(([n, p]) => send(n, p));
  }

  function injectStyles() {
    if (document.getElementById('scSiteStyles')) return;
    const style = document.createElement('style');
    style.id = 'scSiteStyles';
    style.textContent = `
      .sc-banner{position:fixed;left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:9500;max-width:560px;margin:0 auto;padding:16px 18px;box-sizing:border-box;border-radius:14px;background:var(--c-elev,#1d2d50);border:1px solid var(--c-hair-2,rgba(160,182,222,.26));color:var(--c-on,#f2f5fa);font:14px/1.5 Inter,system-ui,sans-serif;box-shadow:0 12px 40px var(--c-shadow,rgba(2,6,18,.55))}
      .sc-banner p{margin:0 0 12px}.sc-banner a{color:var(--c-link,#6cb2ff)}
      .sc-banner-actions{display:flex;flex-wrap:wrap;gap:8px}
      .sc-banner button{flex:1 1 130px;min-height:44px;border-radius:10px;border:1px solid var(--c-hair-2,rgba(160,182,222,.26));background:transparent;color:inherit;font:600 14px Inter,system-ui,sans-serif;cursor:pointer}
      .sc-banner button.primary{background:var(--c-blue-fill,#1d6fe6);border-color:var(--c-blue-fill,#1d6fe6);color:#fff}
      .sc-banner label{display:flex;gap:10px;align-items:flex-start;margin:0 0 10px}
      .sc-banner input{margin-top:3px;width:18px;height:18px}
      body.sc-banner-open .sc-sticky-cta{display:none!important}`;
    document.head.appendChild(style);
  }

  // Google's cookies (_ga, _ga_<id>) on this host and the parent domain.
  function clearAnalyticsCookies() {
    const host = location.hostname;
    const domains = ['', host, '.' + host, '.' + host.split('.').slice(-2).join('.')];
    document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter((n) => /^_ga(_|$)/.test(n)).forEach((name) => {
      domains.forEach((d) => { document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d ? '; domain=' + d : ''}`; });
    });
  }

  function saveChoice(choice) {
    const wasLoaded = ready;
    store.set(CONSENT_KEY, JSON.stringify({ choice, at: Date.now() }));
    closeBanner();
    if (choice === 'accepted') return loadProvider();
    clearAnalyticsCookies();
    if (wasLoaded && provider === 'ga4' && analyticsId) window[`ga-disable-${analyticsId}`] = true;
  }

  function closeBanner() {
    document.getElementById('scCookieBanner')?.remove();
    document.body.classList.remove('sc-banner-open');
  }

  function openBanner(showSettings) {
    closeBanner();
    injectStyles();
    const box = document.createElement('div');
    box.id = 'scCookieBanner';
    box.className = 'sc-banner';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Cookie choices');
    const settings = showSettings
      ? `<label><input type="checkbox" checked disabled /> <span><strong>Essential</strong>. Keeps you logged in and remembers your settings. Always on.</span></label>
         <label><input type="checkbox" id="scConsentAnalytics" ${consent() === 'accepted' ? 'checked' : ''} /> <span><strong>Analytics</strong>. Counts visits and which features get used. Optional.</span></label>
         <div class="sc-banner-actions"><button type="button" class="primary" id="scConsentSave">Save choices</button></div>`
      : `<div class="sc-banner-actions">
           <button type="button" class="primary" id="scConsentAccept">Accept</button>
           <button type="button" class="primary" id="scConsentReject">Reject non-essential</button>
           <button type="button" id="scConsentSettings">Settings</button>
         </div>`;
    box.innerHTML = `<p>We use essential storage to run the game, and analytics only if you allow it. <a href="/cookies">Cookie policy</a></p>${settings}`;
    document.body.appendChild(box);
    document.body.classList.add('sc-banner-open');
    box.querySelector('#scConsentAccept')?.addEventListener('click', () => saveChoice('accepted'));
    box.querySelector('#scConsentReject')?.addEventListener('click', () => saveChoice('rejected'));
    box.querySelector('#scConsentSettings')?.addEventListener('click', () => openBanner(true));
    box.querySelector('#scConsentSave')?.addEventListener('click', () => saveChoice(box.querySelector('#scConsentAnalytics').checked ? 'accepted' : 'rejected'));
  }

  function wireEvents() {
    document.addEventListener('click', (e) => {
      const el = e.target.closest?.('a, button');
      if (!el) return;
      if (el.matches('.sw-launcher')) track('support_opened');
      if (el.matches('[data-mode]')) track('match_started', { mode: el.dataset.mode });
      if (el.matches('#tabRegister')) track('signup_started');
      if (el.matches('#inviteCopyBtn, [data-copy-invite]')) track('referral_link_copied');
      if (el.matches('[data-cta], .hero .btn-primary, .sc-sticky-cta a, .sc-sticky-cta button')) {
        track('cta_click', { location: el.dataset.cta || (el.closest('.sc-sticky-cta') ? 'sticky' : 'hero') });
        if (document.getElementById('lpRegisterForm')) track('signup_started');
      }
    });
    if (/^\/competition\//.test(location.pathname)) trackOnce('competition_viewed');
  }

  // Each page's footer fills itself from the server's settings, so nothing is invented.
  function fillCompany(cfg) {
    const c = cfg.company || {};
    const line = [c.name, c.address, c.regNo ? `Registration no. ${c.regNo}` : null].filter(Boolean).join(' · ');
    document.querySelectorAll('[data-company-line]').forEach((el) => { el.textContent = line; el.hidden = !line; });
    document.querySelectorAll('[data-company]').forEach((el) => {
      const value = c[el.dataset.company];
      if (value) { el.textContent = value; el.hidden = false; }
    });
    // Unfilled legal details are visible only in preview, never to the public.
    const preview = new URLSearchParams(location.search).has('preview');
    document.querySelectorAll('[data-legal-placeholder]').forEach((el) => { if (preview && !el.dataset.filled) el.hidden = false; });
    const banner = document.getElementById('legalDraftBanner');
    if (banner) banner.hidden = !(preview && !cfg.legalReviewed);
  }

  // One-time and dismissible. Nobody is ever blocked or logged out over this.
  function termsNotice(cfg) {
    if (!cfg.termsVersion || !document.querySelector('.lb-page') || location.pathname !== '/play') return;
    const seen = store.get('sc_terms_seen');
    if (seen === cfg.termsVersion) return;
    if (!seen) { store.set('sc_terms_seen', cfg.termsVersion); return; }
    injectStyles();
    const box = document.createElement('div');
    box.className = 'sc-banner';
    box.setAttribute('role', 'status');
    box.innerHTML = '<p>We updated our <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p><div class="sc-banner-actions"><button type="button" class="primary">Got it</button></div>';
    box.querySelector('button').addEventListener('click', () => { store.set('sc_terms_seen', cfg.termsVersion); box.remove(); });
    document.body.appendChild(box);
  }

  // ---- first-party, cookieless collector (/api/a/collect) ------------------------
  // Runs for everyone, before and without consent: the server counts a visitor
  // per day from a hash that rotates daily. The visit id lives in session
  // storage (gone when the tab closes, new after 30 idle minutes). Only after
  // "Accept" is a first-party id kept in local storage to link visits across
  // days; "Reject" deletes it. Batched, sent every few seconds or on leaving,
  // never blocks the page, never sent from inside the match loop.
  const FP = (() => {
    let IDLE_MS = 30 * 60 * 1000; // replaced by the server's setting at boot
    const q = [];
    let timer = null;
    const ss = {
      get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
      set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    };
    const rand = () => { const a = new Uint8Array(12); (window.crypto || window.msCrypto).getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };
    function sessionId() {
      const last = Number(ss.get('sc_sid_at')) || 0;
      let id = ss.get('sc_sid');
      if (!id || Date.now() - last > IDLE_MS) { id = rand(); ss.set('sc_sid', id); }
      ss.set('sc_sid_at', String(Date.now()));
      return id;
    }
    function anonId() {
      if (consent() !== 'accepted') { try { localStorage.removeItem('sc_aid'); localStorage.removeItem('sc_ft'); } catch (e) { /* ignore */ } return null; }
      let id = store.get('sc_aid');
      if (!id) { id = rand(); store.set('sc_aid', id); }
      return id;
    }
    const external = () => (document.referrer && !document.referrer.startsWith(location.origin) ? document.referrer.slice(0, 300) : null);
    function utm() {
      const p = new URLSearchParams(location.search);
      const g = (k) => (p.get(k) || '').slice(0, 60) || null;
      return { source: g('utm_source'), medium: g('utm_medium'), campaign: g('utm_campaign'), partner: g('partner') || g('sc_partner') };
    }
    // Where this visitor first came from: the first page of the visit (or, with
    // consent, of their first visit ever). Sent with the sign-up form.
    function firstTouch() {
      let ft = null;
      try { ft = JSON.parse(store.get('sc_ft') || ss.get('sc_ft') || 'null'); } catch (e) { ft = null; }
      if (!ft) {
        const u = utm();
        ft = { source: u.source, medium: u.medium, campaign: u.campaign, partner: u.partner, referrer: external(), landing: location.pathname.slice(0, 120) };
        ss.set('sc_ft', JSON.stringify(ft));
      }
      if (consent() === 'accepted' && !store.get('sc_ft')) store.set('sc_ft', JSON.stringify(ft));
      return ft;
    }
    function flush(leaving) {
      clearTimeout(timer);
      timer = null;
      if (!q.length) return;
      const body = JSON.stringify({ session_id: sessionId(), anon_id: anonId(), consent: consent() === 'accepted', referrer: external(), utm: utm(), events: q.splice(0, 20) });
      const token = window.TW && TW.getToken ? TW.getToken() : null;
      // keepalive fetch survives leaving the page; sendBeacon only if fetch is unavailable
      try {
        fetch('/api/a/collect', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}), body, keepalive: true }).catch(() => {});
      } catch (e) {
        if (navigator.sendBeacon) navigator.sendBeacon('/api/a/collect', new Blob([body], { type: 'application/json' }));
      }
    }
    function collect(name, props) {
      q.push({ name, props: props || {}, page: location.pathname });
      if (q.length >= 20) flush(false);
      else if (!timer) timer = setTimeout(() => flush(false), 1000);
    }
    // once per visit per event AND per its properties (Daily Open and Weekend Open are two views)
    const once = (name, props) => { const k = `sc_fp_${name}_${JSON.stringify(props || {})}`; if (ss.get(k)) return; ss.set(k, '1'); collect(name, props); };
    addEventListener('pagehide', () => flush(true));
    addEventListener('beforeunload', () => flush(true));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
    return { collect, once, flush, firstTouch, sessionId, setIdleMinutes: (m) => { if (m > 0) IDLE_MS = m * 60 * 1000; } };
  })();

  function wireFirstParty() {
    FP.firstTouch();
    FP.collect('page_view');
    const comp = location.pathname.match(/^\/competitions\/(daily|weekend)[a-z-]*/);
    if (comp) FP.once('competition_viewed', { template: comp[1] });
    if (/[?&]register=1/.test(location.search)) FP.once('signup_started', { location: 'link' });
    FP.flush(false); // on-load events go now (keepalive), so a quick click away never loses them
    document.addEventListener('click', (e) => {
      const el = e.target.closest?.('a, button');
      if (!el) return;
      if (el.matches('#tabRegister') || (el.matches('[data-cta], .hero .btn-primary, .sc-sticky-cta a, .sc-sticky-cta button') && document.getElementById('lpRegisterForm'))) FP.once('signup_started', { location: el.id === 'tabRegister' ? 'tab' : 'cta' });
    });
    // Game screen on a phone in landscape (once per visit).
    if (/^\/game/.test(location.pathname) && window.matchMedia) {
      const mq = window.matchMedia('(orientation: landscape) and (max-height: 500px)');
      const check = () => { if (mq.matches) FP.once('orientation_landscape', { installed: Boolean(window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) }); };
      check();
      mq.addEventListener?.('change', check);
    }
  }

  window.SCAnalytics = { track, trackOnce, openCookieSettings: () => openBanner(true), collect: (n, p) => FP.collect(n, p), firstTouch: () => FP.firstTouch() };
  try { wireFirstParty(); } catch (e) { /* tracking must never break a page */ }

  async function boot() {
    let cfg = {};
    try {
      cfg = await (await fetch('/api/config/public')).json();
    } catch (e) {
      return;
    }
    fillCompany(cfg);
    termsNotice(cfg);
    FP.setIdleMinutes(Number(cfg.analyticsSessionIdleMinutes) || 30);
    provider = cfg.analyticsProvider || 'none';
    analyticsId = cfg.analyticsId || null;
    document.querySelectorAll('[data-cookie-settings]').forEach((el) => {
      el.hidden = provider === 'none';
      el.addEventListener('click', (e) => { e.preventDefault(); openBanner(true); });
    });
    if (provider === 'none') return;
    injectStyles();
    wireEvents();
    if (consent() === 'accepted') loadProvider();
    else if (consent() === null && !NO_BANNER.test(location.pathname)) openBanner(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
