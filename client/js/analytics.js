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

  // Social icons in every footer, from the links set in admin (Branding,
  // Social links). Nothing shows until a link is set. Built with DOM calls,
  // never innerHTML, so a saved link can't add markup to the page.
  // Icon shapes: Simple Icons 13.21.0 (CC0).
  const SOCIAL_ICONS = {"instagram": "M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077", "x": "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z", "threads": "M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z", "discord": "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z", "facebook": "M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z"};
  function fillSocials(links) {
    if (!Array.isArray(links) || !links.length) return;
    if (!document.getElementById('scSocialsStyle')) {
      const st = document.createElement('style');
      st.id = 'scSocialsStyle';
      st.textContent = '.sc-socials{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin:10px 0 12px}'
        + '.footer .sc-socials{justify-content:flex-start;margin:16px 0 0}'
        + '.sc-socials a{width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;'
        + 'color:rgba(255,255,255,.82);background:rgba(255,255,255,.07);transition:background .15s ease,color .15s ease}'
        + '.sc-socials a:hover{color:#fff;background:rgba(255,255,255,.16)}'
        + '.sc-socials a:focus-visible{outline:2px solid #fff;outline-offset:2px}'
        + '.sc-socials svg{width:18px;height:18px;fill:currentColor}';
      document.head.appendChild(st);
    }
    const build = () => {
      const nav = document.createElement('nav');
      nav.className = 'sc-socials';
      nav.setAttribute('aria-label', 'Spike & Crush on social media');
      for (const link of links) {
        const d = SOCIAL_ICONS[link.key];
        if (!d || !/^https:\/\//.test(String(link.url))) continue;
        const a = document.createElement('a');
        a.href = link.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer me';
        a.setAttribute('aria-label', `Spike & Crush on ${link.label}`);
        a.title = link.label;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
        a.appendChild(svg);
        nav.appendChild(a);
      }
      return nav.children.length ? nav : null;
    };
    // The site footer: before its copyright line. The landing page: under its contact line.
    document.querySelectorAll('.legal-footer-content').forEach((box) => {
      if (box.querySelector('.sc-socials')) return;
      const nav = build();
      if (!nav) return;
      const copyright = [...box.children].reverse().find((n) => /\u00a9/.test(n.textContent));
      box.insertBefore(nav, copyright || null);
    });
    document.querySelectorAll('.footer .footer-top > div:first-child').forEach((col) => {
      if (col.querySelector('.sc-socials')) return;
      const nav = build();
      if (nav) col.appendChild(nav);
    });
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
    try { fillSocials(cfg.socials); } catch (e) { /* a footer extra must never break a page */ }
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
