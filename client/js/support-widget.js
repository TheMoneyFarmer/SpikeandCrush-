'use strict';

// Spike & Crush support widget. Self-injecting: every page includes this one
// <script> (there is no shared HTML layer). Talks to /api/support/* (AI replies
// stream over Server-Sent Events) and listens on the socket.io namespace
// /support for live replies from human agents.
//
// Identity: the signed-in player's Supabase token when there is one (TW.getToken),
// otherwise a random guest token kept in localStorage.
//
// Layering: the widget sits on the top layer of the page (above the custom
// cursor, toasts and tab bar), uses the normal cursor inside itself, and hides
// any custom page cursor while the pointer is over it.

(function () {
  if (document.getElementById('twSupportWidgetRoot')) return;

  const GUEST_KEY = 'sc_support_guest';
  const CHIPS_KEY = 'sc_support_chips_used';
  const MAX_LEN = 2000;
  const COUNTER_AT = 1800;
  const MAX_IMAGE = 3 * 1024 * 1024;
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  const CHIPS = ['My match disconnected', 'Coins and prizes', 'Competition rules', 'Account help', 'Talk to a human'];
  const GREETING = 'Hi. I am the Spike & Crush support assistant. Ask me about matches, coins, competitions or your account. You can talk to a human at any time.';

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch (e) {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch (e) {
        /* private mode: fine, the session just won't persist */
      }
    },
  };
  let memGuest = null;
  function guestToken() {
    let t = store.get(GUEST_KEY) || memGuest;
    if (!t || !/^[A-Za-z0-9_-]{32,128}$/.test(t)) {
      const bytes = new Uint8Array(32);
      window.crypto.getRandomValues(bytes);
      t = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      store.set(GUEST_KEY, t);
      memGuest = t;
    }
    return t;
  }
  const authToken = () => (window.TW && typeof TW.getToken === 'function' ? TW.getToken() : null);
  function headers(json = true) {
    const h = { 'x-support-guest': guestToken() };
    if (json) h['Content-Type'] = 'application/json';
    const t = authToken();
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = (text) => (window.TW && TW.supportMarkdown ? TW.supportMarkdown.render(text) : `<p>${esc(text).replace(/\n/g, '<br>')}</p>`);
  const ago = (iso) => (iso && window.TW && TW.timeAgo ? TW.timeAgo(iso) : '');

  // Load the markdown renderer and fonts if the page doesn't already have them.
  if (!(window.TW && TW.supportMarkdown)) {
    const s = document.createElement('script');
    s.src = '/js/support-markdown.js';
    s.onload = () => render();
    document.head.appendChild(s);
  }
  if (!(window.TW && TW.timeAgo)) {
    const s = document.createElement('script');
    s.src = '/js/time-ago.js';
    s.onload = () => render();
    document.head.appendChild(s);
  }
  if (!document.querySelector('link[data-sc-support-fonts]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.dataset.scSupportFonts = '1';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Rajdhani:wght@600;700&display=swap';
    document.head.appendChild(l);
  }

  // ---- icons (SVG line icons, no emoji) --------------------------------------
  const svg = (paths, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  const ICON = {
    chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/>', 26),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    send: svg('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>'),
    attach: svg('<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'),
    up: svg('<path d="M7 10v12"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.4 22H7V10l4.3-8a2.6 2.6 0 0 1 3.7 3.9z"/>', 18),
    down: svg('<path d="M17 14V2"/><path d="M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.6 2H17v12l-4.3 8a2.6 2.6 0 0 1-3.7-3.9z"/>', 18),
    tickets: svg('<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M13 5v2M13 17v2M13 11v2"/>'),
    back: svg('<path d="m15 18-6-6 6-6"/>'),
    image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>', 16),
    x: svg('<path d="M18 6 6 18M6 6l12 12"/>', 14),
    offline: svg('<path d="M12 20h.01M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.3-1.6M2 8.8a15 15 0 0 1 4.2-2.7M22 8.8A15 15 0 0 0 11.4 5M2 2l20 20"/>', 16),
  };

  // ---- styles --------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
#twSupportWidgetRoot{--sw-bg:#14213d;--sw-panel:#1d2d50;--sw-tile:#25375f;--sw-line:#1D2638;--sw-text:#E8ECF4;--sw-muted:#9AA4B8;--sw-gold:#F5B83D;--sw-green:#2EE6A6;--sw-red:#FF4D5E;
  position:fixed;right:20px;bottom:20px;z-index:2147483000;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--sw-text);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;text-align:left;letter-spacing:normal;text-transform:none}
#twSupportWidgetRoot,#twSupportWidgetRoot *{cursor:auto;box-sizing:border-box}
#twSupportWidgetRoot button,#twSupportWidgetRoot a{cursor:pointer}
#twSupportWidgetRoot textarea,#twSupportWidgetRoot input{cursor:text}
#twSupportWidgetRoot.sw-hidden{display:none}
html.tw-sw-hover #cr,html.tw-sw-hover #cp,html.tw-sw-hover [data-custom-cursor]{opacity:0!important;visibility:hidden!important}
#twSupportWidgetRoot :focus-visible{outline:2px solid var(--sw-gold);outline-offset:2px}
.sw-launcher{position:relative;width:56px;height:56px;border-radius:50%;border:0;background:var(--sw-gold);color:#14213d;display:grid;place-items:center;box-shadow:0 8px 24px rgba(0,0,0,.45);transition:transform .15s ease;padding:0}
.sw-launcher:hover{transform:translateY(-1px)}
.sw-launcher.sw-pulse{animation:swPulse 2.4s ease-out 2}
@keyframes swPulse{0%{box-shadow:0 0 0 0 rgba(245,184,61,.55),0 8px 24px rgba(0,0,0,.45)}100%{box-shadow:0 0 0 18px rgba(245,184,61,0),0 8px 24px rgba(0,0,0,.45)}}
.sw-dot{position:absolute;top:3px;right:3px;width:13px;height:13px;border-radius:50%;background:var(--sw-red);border:2px solid #14213d;display:none}
.sw-launcher.sw-unread .sw-dot{display:block}
.sw-panel{position:fixed;right:20px;bottom:88px;width:380px;height:560px;max-height:calc(100vh - 108px);background:var(--sw-panel);border:1px solid var(--sw-line);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.6);display:none;flex-direction:column;overflow:hidden}
#twSupportWidgetRoot.sw-tabbar .sw-panel{bottom:164px;max-height:calc(100vh - 184px)}
.sw-panel.sw-open{display:flex}
.sw-handle{display:none}
.sw-head{height:64px;flex:0 0 64px;display:flex;align-items:center;gap:4px;padding:0 8px 0 16px;border-bottom:1px solid var(--sw-line);background:var(--sw-panel)}
.sw-head-text{flex:1;min-width:0}
.sw-title{font-family:Rajdhani,Inter,sans-serif;font-weight:700;font-size:18px;letter-spacing:.08em;text-transform:uppercase;line-height:1.1;margin:0;color:var(--sw-text)}
.sw-status{font-size:12px;color:var(--sw-muted);display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sw-status i{width:8px;height:8px;border-radius:50%;background:var(--sw-green);flex:0 0 8px}
.sw-status.sw-wait i{background:var(--sw-gold)}
.sw-status.sw-done i{background:var(--sw-muted)}
.sw-iconbtn{width:44px;height:44px;border-radius:12px;border:0;background:transparent;color:var(--sw-text);display:grid;place-items:center;flex:0 0 44px;padding:0}
.sw-iconbtn[hidden]{display:none}
.sw-iconbtn:hover{background:var(--sw-tile)}
.sw-banner{display:none;align-items:center;gap:8px;padding:8px 12px;background:#2A1A1E;color:#FFD3D8;font-size:13px;border-bottom:1px solid var(--sw-line)}
.sw-banner.sw-show{display:flex}
.sw-banner button{margin-left:auto;background:transparent;border:1px solid #FFD3D8;color:#FFD3D8;border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;min-height:32px}
.sw-body{flex:1;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:16px 12px;display:flex;flex-direction:column;gap:10px}
.sw-row{display:flex;flex-direction:column;max-width:86%}
.sw-row.sw-left{align-self:flex-start}
.sw-row.sw-right{align-self:flex-end;align-items:flex-end}
.sw-bubble{padding:10px 12px;border-radius:12px;word-wrap:break-word;overflow-wrap:anywhere;color:var(--sw-text)}
.sw-left .sw-bubble{background:var(--sw-tile);border:1px solid var(--sw-line);border-top-left-radius:4px}
.sw-right .sw-bubble{background:var(--sw-gold);color:#14213d;border-top-right-radius:4px}
.sw-bubble p{margin:0 0 6px}.sw-bubble p:last-child{margin:0}
.sw-bubble ul,.sw-bubble ol{margin:4px 0 6px;padding-left:20px}
.sw-bubble a{color:var(--sw-gold);text-decoration:underline}
.sw-right .sw-bubble a{color:#14213d}
.sw-bubble code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:rgba(255,255,255,.06);padding:1px 4px;border-radius:4px}
.sw-attach-link{display:inline-flex;align-items:center;gap:6px;margin-top:6px}
.sw-meta{font-size:11px;color:var(--sw-muted);margin-top:4px;display:flex;align-items:center;gap:6px;min-height:16px}
.sw-tag{font-family:Rajdhani,Inter,sans-serif;font-weight:700;font-size:11px;letter-spacing:.08em;background:var(--sw-gold);color:#14213d;border-radius:4px;padding:0 5px;line-height:16px}
.sw-sender{font-size:12px;color:var(--sw-muted);margin-bottom:4px;display:flex;align-items:center;gap:6px}
.sw-system{align-self:center;text-align:center;font-size:12px;color:var(--sw-muted);max-width:90%;padding:2px 8px}
.sw-rate{display:flex;gap:2px;margin-left:2px}
.sw-rate button{width:32px;height:32px;border-radius:8px;border:0;background:transparent;color:var(--sw-muted);display:grid;place-items:center;padding:0}
.sw-rate button:hover,.sw-rate button[aria-pressed="true"]{color:var(--sw-text);background:var(--sw-tile)}
.sw-error .sw-bubble{border-color:var(--sw-red)}
.sw-retry{margin-top:6px;align-self:flex-start;background:transparent;border:1px solid var(--sw-line);color:var(--sw-text);border-radius:10px;padding:6px 12px;font:inherit;font-size:13px;min-height:36px}
.sw-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
.sw-chip{border:1px solid var(--sw-line);background:var(--sw-tile);color:var(--sw-text);border-radius:999px;padding:8px 12px;font:inherit;font-size:13px;min-height:36px}
.sw-chip:hover{border-color:var(--sw-gold)}
.sw-typing{display:inline-flex;gap:4px;padding:14px}
.sw-typing span{width:6px;height:6px;border-radius:50%;background:var(--sw-muted);animation:swDot 1.2s infinite ease-in-out}
.sw-typing span:nth-child(2){animation-delay:.15s}.sw-typing span:nth-child(3){animation-delay:.3s}
@keyframes swDot{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
.sw-card{background:var(--sw-tile);border:1px solid var(--sw-line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}
.sw-card h3{margin:0;font-family:Rajdhani,Inter,sans-serif;font-weight:700;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--sw-text)}
.sw-card p{margin:0;color:var(--sw-muted);font-size:13px}
.sw-field{width:100%;background:var(--sw-bg);border:1px solid var(--sw-line);border-radius:10px;color:var(--sw-text);font:inherit;padding:10px 12px;min-height:44px}
.sw-field::placeholder{color:#8A93A6}
.sw-btn{min-height:44px;border-radius:12px;border:0;background:var(--sw-gold);color:#14213d;font:inherit;font-weight:600;padding:0 16px}
.sw-btn:disabled{opacity:.5}
.sw-btn.sw-ghost{background:transparent;border:1px solid var(--sw-line);color:var(--sw-text)}
.sw-btnrow{display:flex;gap:8px;flex-wrap:wrap}
.sw-csat{display:flex;gap:8px}
.sw-csat button{flex:1;min-height:44px;border-radius:12px;border:1px solid var(--sw-line);background:var(--sw-bg);color:var(--sw-text);display:flex;align-items:center;justify-content:center;gap:6px;font:inherit}
.sw-csat button[aria-pressed="true"]{border-color:var(--sw-gold);color:var(--sw-gold)}
.sw-foot{border-top:1px solid var(--sw-line);padding:10px 12px calc(8px + env(safe-area-inset-bottom));background:var(--sw-panel)}
.sw-preview{display:none;align-items:center;gap:8px;font-size:12px;color:var(--sw-muted);margin-bottom:8px;min-width:0}
.sw-preview span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.sw-preview.sw-show{display:flex}
.sw-preview img{width:40px;height:40px;object-fit:cover;border-radius:6px;border:1px solid var(--sw-line)}
.sw-preview button{width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--sw-muted);display:grid;place-items:center}
.sw-compose{display:flex;align-items:flex-end;gap:4px;background:var(--sw-bg);border:1px solid var(--sw-line);border-radius:12px;padding:4px}
.sw-compose:focus-within{border-color:var(--sw-gold)}
.sw-compose textarea{flex:1;min-width:0;resize:none;border:0;background:transparent;color:var(--sw-text);font:inherit;line-height:20px;padding:12px 6px;max-height:112px;min-height:44px;outline:none;box-shadow:none}
.sw-compose textarea::placeholder{color:#8A93A6}
.sw-send{width:44px;height:44px;border-radius:10px;border:0;background:var(--sw-gold);color:#14213d;display:grid;place-items:center;flex:0 0 44px;padding:0}
.sw-send:disabled{opacity:.45}
.sw-attach{width:44px;height:44px;border-radius:10px;border:0;background:transparent;color:var(--sw-muted);display:grid;place-items:center;flex:0 0 44px;padding:0}
.sw-attach:hover{color:var(--sw-text)}
.sw-footrow{display:flex;justify-content:space-between;align-items:center;margin-top:6px;min-height:24px;font-size:12px}
.sw-human{background:transparent;border:0;color:var(--sw-gold);font:inherit;font-size:13px;font-weight:600;padding:6px 0;min-height:32px;text-decoration:underline;text-underline-offset:3px}
.sw-human[hidden]{display:none}
.sw-count{color:var(--sw-muted)}.sw-count.sw-over{color:var(--sw-red)}
.sw-tickets{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.sw-tickets button{width:100%;text-align:left;background:var(--sw-tile);border:1px solid var(--sw-line);border-radius:12px;padding:10px 12px;color:var(--sw-text);font:inherit;min-height:44px}
.sw-tickets small{display:block;color:var(--sw-muted);font-size:12px}
.sw-sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;margin:-1px;padding:0;border:0}
@media (max-width:600px){
  #twSupportWidgetRoot{right:16px;bottom:16px}
  #twSupportWidgetRoot.sw-tabbar{bottom:96px}
  .sw-panel,#twSupportWidgetRoot.sw-tabbar .sw-panel{left:0;right:0;bottom:0;top:auto;width:100%;height:calc(100dvh - env(safe-area-inset-top) - 8px);max-height:none;border-radius:16px 16px 0 0;border-left:0;border-right:0;border-bottom:0}
  .sw-handle{display:block;width:100%;height:20px;flex:0 0 20px;border:0;background:var(--sw-panel);position:relative;touch-action:none;padding:0}
  .sw-handle::after{content:"";position:absolute;left:50%;top:8px;width:40px;height:4px;margin-left:-20px;border-radius:2px;background:#3A4560}
  .sw-head{height:56px;flex-basis:56px}
  #twSupportWidgetRoot.sw-is-open .sw-launcher{display:none}
}
/* The site's global heading, paragraph and form styles must not reach in here. */
#twSupportWidgetRoot .sw-title{font-family:Rajdhani,Inter,sans-serif!important;font-weight:700!important;font-size:18px!important;letter-spacing:.08em!important;text-transform:uppercase!important;color:var(--sw-text)!important}
#twSupportWidgetRoot .sw-card h3{font-family:Rajdhani,Inter,sans-serif!important;font-weight:700!important;font-size:15px!important;letter-spacing:.06em!important;text-transform:uppercase!important;color:var(--sw-text)!important}
#twSupportWidgetRoot .sw-bubble p,#twSupportWidgetRoot .sw-bubble li,#twSupportWidgetRoot .sw-bubble strong,#twSupportWidgetRoot .sw-bubble em{color:inherit!important;font-size:inherit!important;line-height:inherit!important}
#twSupportWidgetRoot .sw-compose textarea{border:0!important;background:transparent!important;box-shadow:none!important;outline:none!important;color:var(--sw-text)!important;margin:0!important;border-radius:0!important;width:auto!important}
@media (prefers-reduced-motion:reduce){
  .sw-launcher.sw-pulse{animation:none}
  .sw-typing span{animation:none;opacity:.8}
  .sw-launcher{transition:none}
}`;
  document.head.appendChild(style);

  // ---- DOM -----------------------------------------------------------------
  const root = document.createElement('div');
  root.id = 'twSupportWidgetRoot';
  root.innerHTML = `
    <section class="sw-panel" id="swPanel" role="dialog" aria-modal="true" aria-labelledby="swTitle" aria-hidden="true">
      <button class="sw-handle" id="swHandle" aria-label="Close support"></button>
      <header class="sw-head">
        <button class="sw-iconbtn" id="swBack" aria-label="Back to chat" hidden>${ICON.back}</button>
        <div class="sw-head-text">
          <h2 class="sw-title" id="swTitle">Support</h2>
          <div class="sw-status" id="swStatus"><i></i><span id="swStatusText">AI assistant</span></div>
        </div>
        <button class="sw-iconbtn" id="swTicketsBtn" aria-label="My tickets" title="My tickets" hidden>${ICON.tickets}</button>
        <button class="sw-iconbtn" id="swClose" aria-label="Close support">${ICON.close}</button>
      </header>
      <div class="sw-banner" id="swOffline" role="status">${ICON.offline}<span id="swOfflineText">You are offline.</span><button id="swRetryConn">Retry</button></div>
      <div class="sw-body" id="swBody" aria-live="polite" aria-relevant="additions text" tabindex="-1"></div>
      <div class="sw-foot" id="swFoot">
        <div class="sw-preview" id="swPreview"><img id="swPreviewImg" alt="Selected image" /><span id="swPreviewName"></span><button id="swPreviewRemove" aria-label="Remove image">${ICON.x}</button></div>
        <div class="sw-compose">
          <input type="file" id="swFile" accept="image/png,image/jpeg,image/webp" class="sw-sr" tabindex="-1" aria-hidden="true" />
          <button class="sw-attach" id="swAttach" aria-label="Attach an image (PNG, JPG or WebP, up to 3 MB)">${ICON.attach}</button>
          <label class="sw-sr" for="swInput">Message</label>
          <textarea id="swInput" rows="1" maxlength="${MAX_LEN}" placeholder="Type your message"></textarea>
          <button class="sw-send" id="swSend" aria-label="Send message" disabled>${ICON.send}</button>
        </div>
        <div class="sw-footrow">
          <button class="sw-human" id="swHuman">Talk to a human</button>
          <span class="sw-count" id="swCount" aria-live="polite"></span>
        </div>
      </div>
    </section>
    <button class="sw-launcher sw-pulse" id="swLauncher" aria-label="Open support chat" aria-expanded="false" aria-controls="swPanel">${ICON.chat}<span class="sw-dot" aria-hidden="true"></span></button>
  `;
  document.body.appendChild(root);
  const $ = (id) => document.getElementById(id);
  const panel = $('swPanel');
  const body = $('swBody');
  const input = $('swInput');
  const sendBtn = $('swSend');
  const launcher = $('swLauncher');

  // ---- state -----------------------------------------------------------------
  const state = {
    open: false,
    loaded: false,
    loading: false,
    loggedIn: false,
    conversation: null,
    messages: [],
    sending: false,
    streamText: null, // AI reply being streamed ('' = typing dots)
    pendingError: null, // { text, retryBody? }
    attachment: null, // { file, url }
    view: 'chat', // 'chat' | 'tickets' | 'form'
    tickets: [],
    chipsUsed: store.get(CHIPS_KEY) === '1',
    offline: false,
    needsEmail: false,
    csatDone: false,
    csatRating: null,
  };

  // ---- hide during an active match --------------------------------------------
  function updateVisibility() {
    const inMatch = document.body.dataset.page === 'game' && !document.querySelector('.end-screen');
    root.classList.toggle('sw-hidden', inMatch);
    if (inMatch && state.open) closePanel();
  }
  if (document.body.dataset.page === 'game') new MutationObserver(updateVisibility).observe(document.body, { childList: true });
  updateVisibility();

  // Sit above the mobile tab bar when it's showing.
  function updateTabbarOffset() {
    const bar = document.getElementById('bottom-tab-bar');
    root.classList.toggle('sw-tabbar', Boolean(bar && getComputedStyle(bar).display !== 'none'));
  }
  setTimeout(updateTabbarOffset, 0);
  setTimeout(updateTabbarOffset, 1000);
  window.addEventListener('resize', updateTabbarOffset);

  // Custom page cursors hide while the pointer is over the widget.
  root.addEventListener('pointerenter', () => document.documentElement.classList.add('tw-sw-hover'));
  root.addEventListener('pointerleave', () => document.documentElement.classList.remove('tw-sw-hover'));

  // ---- status line -------------------------------------------------------------
  function renderStatus() {
    const c = state.conversation;
    const st = $('swStatus');
    const txt = $('swStatusText');
    st.className = 'sw-status';
    if (!c || c.status === 'ai') txt.textContent = 'AI assistant';
    else if (c.status === 'waiting_human') {
      st.classList.add('sw-wait');
      txt.textContent = 'Waiting for a human agent';
    } else if (c.status === 'human') txt.textContent = `Chatting with ${c.agentName || 'the team'}`;
    else {
      st.classList.add('sw-done');
      txt.textContent = 'Resolved';
    }
    $('swTicketsBtn').hidden = !state.loggedIn || state.view !== 'chat';
    $('swBack').hidden = state.view === 'chat';
    $('swTitle').textContent = state.view === 'tickets' ? 'My tickets' : state.view === 'form' ? 'Send a message' : 'Support';
  }

  // ---- rendering -----------------------------------------------------------------
  function bubble(m) {
    if (m.sender === 'system') return `<div class="sw-system" data-id="${esc(m.id)}">${esc(m.body)}</div>`;
    const mine = m.sender === 'user';
    const attach = (m.attachments || []).map((a) => `<a href="/api/support/attachments/${esc(m.id)}/${a.index}" data-attach="1" class="sw-attach-link">${ICON.image} View image</a>`).join('');
    const sender = m.sender === 'human' ? `<div class="sw-sender"><span class="sw-tag">TEAM</span>${esc(m.senderName || 'Support')}</div>` : '';
    const canRate = m.sender === 'ai' && !m.kind && !String(m.id).startsWith('tmp-') && m.id !== 'greeting';
    const rate = canRate
      ? `<span class="sw-rate"><button data-rate="${esc(m.id)}" data-helpful="1" aria-label="Helpful" aria-pressed="${m.helpful === true}">${ICON.up}</button><button data-rate="${esc(m.id)}" data-helpful="0" aria-label="Not helpful" aria-pressed="${m.helpful === false}">${ICON.down}</button></span>`
      : '';
    const when = ago(m.createdAt);
    const meta = when || rate ? `<div class="sw-meta"><span>${m.sender === 'ai' ? 'Assistant' : m.sender === 'human' ? 'Team' : 'You'}${when ? ` · ${esc(when)}` : ''}</span>${rate}</div>` : '';
    return `<div class="sw-row ${mine ? 'sw-right' : 'sw-left'}" data-id="${esc(m.id)}">${sender}<div class="sw-bubble">${md(m.body)}${attach}</div>${meta}</div>`;
  }

  function render() {
    renderStatus();
    if (state.view === 'tickets') return renderTickets();
    if (state.view === 'form') return renderForm();
    $('swFoot').style.display = '';
    const c = state.conversation;
    const parts = [];
    if (state.loading && !state.loaded) parts.push('<div class="sw-system">Loading your conversation</div>');
    parts.push(bubble({ id: 'greeting', sender: 'ai', kind: 'greeting', body: GREETING, createdAt: null }));
    if (!state.messages.length && !state.chipsUsed && !state.sending) {
      parts.push(`<div class="sw-chips" role="group" aria-label="Common questions">${CHIPS.map((t) => `<button class="sw-chip" data-chip="${esc(t)}">${esc(t)}</button>`).join('')}</div>`);
    }
    for (const m of state.messages) parts.push(bubble(m));
    if (state.streamText !== null) {
      parts.push(
        state.streamText
          ? `<div class="sw-row sw-left"><div class="sw-bubble">${md(state.streamText)}</div></div>`
          : '<div class="sw-row sw-left" role="status" aria-label="Assistant is typing"><div class="sw-bubble sw-typing"><span></span><span></span><span></span></div></div>'
      );
    }
    if (state.pendingError) {
      parts.push(`<div class="sw-row sw-left sw-error"><div class="sw-bubble">${esc(state.pendingError.text)}</div>${state.pendingError.retryBody !== undefined ? '<button class="sw-retry" id="swRetrySend">Try again</button>' : ''}</div>`);
    }
    if (!state.loggedIn && (state.needsEmail || (c && c.needsEmail))) {
      parts.push(`<form class="sw-card" id="swEmailForm"><h3>Your email</h3><p>So a human agent can reply to you, enter your email.</p><label class="sw-sr" for="swEmail">Email</label><input class="sw-field" id="swEmail" type="email" autocomplete="email" required placeholder="you@example.com" /><button class="sw-btn" type="submit">Continue</button></form>`);
    }
    if (c && c.status === 'resolved' && !c.csatGiven && !state.csatDone) {
      parts.push(
        `<form class="sw-card" id="swCsat"><h3>Did this solve it?</h3><div class="sw-csat"><button type="button" data-csat="1" aria-pressed="${state.csatRating === 1}">${ICON.up} Yes</button><button type="button" data-csat="-1" aria-pressed="${state.csatRating === -1}">${ICON.down} No</button></div><label class="sw-sr" for="swCsatComment">Comment (optional)</label><textarea class="sw-field" id="swCsatComment" rows="2" maxlength="1000" placeholder="Anything to add? (optional)"></textarea><button class="sw-btn" type="submit" ${state.csatRating ? '' : 'disabled'}>Send feedback</button></form>`
      );
    } else if (state.csatDone) parts.push('<div class="sw-system">Thanks for your feedback.</div>');
    if (!state.loggedIn && (!c || c.status === 'ai')) parts.push('<div class="sw-system"><button class="sw-human" id="swFormLink" style="font-size:12px">Prefer email? Send us a message instead</button></div>');
    body.innerHTML = parts.join('');
    $('swHuman').hidden = Boolean(c && ['waiting_human', 'human'].includes(c.status));
    scrollDown();
  }

  function renderTickets() {
    $('swFoot').style.display = 'none';
    body.innerHTML = state.tickets.length
      ? `<ul class="sw-tickets">${state.tickets
          .map((t) => `<li><button data-open-conv="${esc(t.conversationId || '')}" ${t.conversationId ? '' : 'disabled'}><strong>${esc(t.ref || 'Ticket')}</strong> ${esc(t.subject)}<small>${esc(String(t.status).replace(/_/g, ' '))} · updated ${esc(ago(t.updatedAt))}</small></button></li>`)
          .join('')}</ul>`
      : '<div class="sw-system">You have no tickets yet.</div>';
  }

  function renderForm() {
    $('swFoot').style.display = 'none';
    body.innerHTML = `<form class="sw-card" id="swTicketForm"><h3>Send us a message</h3><p>We will reply by email. You get a ticket number straight away.</p>
      <label class="sw-sr" for="swTfEmail">Email</label><input class="sw-field" id="swTfEmail" type="email" autocomplete="email" required placeholder="Your email" />
      <label class="sw-sr" for="swTfSubject">Subject</label><input class="sw-field" id="swTfSubject" required maxlength="200" placeholder="Subject" />
      <label class="sw-sr" for="swTfMessage">Message</label><textarea class="sw-field" id="swTfMessage" required rows="5" maxlength="4000" placeholder="How can we help?"></textarea>
      <div class="sw-btnrow"><button class="sw-btn" type="submit">Send</button><button class="sw-btn sw-ghost" type="button" id="swTfCancel">Back to chat</button></div><div id="swTfResult" class="sw-system" aria-live="polite"></div></form>`;
  }

  function scrollDown() {
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });
  }

  // ---- API ------------------------------------------------------------------------
  async function api(path, { method = 'GET', body: b } = {}) {
    const res = await fetch(`/api/support${path}`, { method, headers: headers(), body: b ? JSON.stringify(b) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: res.status });
    return data;
  }

  function applyServer(data) {
    if (data.conversation !== undefined) state.conversation = data.conversation;
    if (Array.isArray(data.messages)) state.messages = data.messages;
    if (state.conversation) {
      state.needsEmail = Boolean(state.conversation.needsEmail);
      joinRoom();
    }
  }

  async function loadSession(conversationId) {
    state.loading = true;
    render();
    try {
      const data = await api('/session', { method: 'POST', body: { conversationId: conversationId || null } });
      state.loggedIn = data.loggedIn;
      applyServer(data);
      state.loaded = true;
      setOffline(false);
    } catch (e) {
      setOffline(true, navigator.onLine ? 'Could not reach support.' : 'You are offline.');
    } finally {
      state.loading = false;
      render();
    }
  }

  function setOffline(off, text) {
    state.offline = off;
    $('swOffline').classList.toggle('sw-show', off);
    if (text) $('swOfflineText').textContent = text;
  }

  // Sends a message and reads the AI reply as Server-Sent Events.
  async function sendMessage(text) {
    if (state.sending) return;
    const value = String(text || '').trim();
    const att = state.attachment;
    if (!value && !att) return;
    if (value.length > MAX_LEN) return;
    state.sending = true;
    state.pendingError = null;
    state.chipsUsed = true;
    store.set(CHIPS_KEY, '1');
    const temp = { id: `tmp-${Date.now()}`, sender: 'user', body: value || 'Image', attachments: [], createdAt: new Date().toISOString() };
    state.messages.push(temp);
    input.value = '';
    autoGrow();
    updateCount();
    const withHuman = state.conversation && ['waiting_human', 'human'].includes(state.conversation.status);
    state.streamText = withHuman ? null : '';
    render();
    try {
      let attachments = [];
      if (att) {
        const fd = new FormData();
        fd.append('file', att.file);
        if (state.conversation) fd.append('conversationId', state.conversation.id);
        const res = await fetch('/api/support/attachments', { method: 'POST', headers: headers(false), body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(data.error || 'Upload failed.'), { keep: true, status: 400 });
        if (!state.conversation) state.conversation = { id: data.conversationId, status: 'ai' };
        attachments = [data.attachment];
        clearAttachment();
      }
      const res = await fetch('/api/support/messages', {
        method: 'POST',
        headers: Object.assign(headers(), { Accept: 'text/event-stream' }),
        body: JSON.stringify({ conversationId: state.conversation ? state.conversation.id : null, body: value, attachments }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw Object.assign(new Error(data.error || 'Message not sent.'), { status: res.status });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let done = null;
      for (;;) {
        const { value: chunk, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = (raw.match(/^event: (.*)$/m) || [])[1];
          const dataLine = (raw.match(/^data: (.*)$/m) || [])[1];
          if (!ev || !dataLine) continue;
          const data = JSON.parse(dataLine);
          if (ev === 'conversation') {
            if (!state.conversation || state.conversation.id !== data.id) state.conversation = Object.assign({}, state.conversation, { id: data.id, status: data.status });
            joinRoom();
          } else if (ev === 'delta') {
            if (state.streamText === null) state.streamText = '';
            state.streamText += data.text;
            render();
          } else if (ev === 'done') done = data;
        }
      }
      state.streamText = null;
      if (!done) throw new Error('The connection dropped.');
      if (done.error && !done.conversation) {
        state.messages = state.messages.filter((m) => m !== temp);
        state.pendingError = { text: done.error, retryBody: value };
      } else applyServer(done);
      setOffline(false);
    } catch (e) {
      state.streamText = null;
      state.messages = state.messages.filter((m) => m !== temp);
      if (e.status === 429 || e.status === 400) state.pendingError = { text: e.message };
      else if (!navigator.onLine) {
        setOffline(true, 'You are offline.');
        state.pendingError = { text: 'Your message was not sent.', retryBody: value };
      } else state.pendingError = { text: 'Your message was not sent.', retryBody: value };
      // Keep the text for the player to edit only when there's no Try again button.
      if (value && state.pendingError.retryBody === undefined) input.value = value;
    } finally {
      state.sending = false;
      render();
      autoGrow();
      updateCount();
    }
  }

  async function talkToHuman() {
    state.chipsUsed = true;
    store.set(CHIPS_KEY, '1');
    state.pendingError = null;
    try {
      const data = await api('/escalate', { method: 'POST', body: { conversationId: state.conversation ? state.conversation.id : null } });
      applyServer(data);
      if (data.status === 'needs_email') state.needsEmail = true;
    } catch (e) {
      state.pendingError = { text: e.message };
    }
    render();
  }

  // ---- live updates (socket.io /support) ----------------------------------------
  let socket = null;
  let joinedId = null;
  let socketLoading = false;
  function ensureSocket(cb) {
    if (socket) return cb && cb();
    const go = () => {
      if (typeof window.io !== 'function' || socket) return cb && cb();
      const auth = { guestToken: guestToken() };
      const t = authToken();
      if (t) auth.token = t;
      socket = window.io('/support', { auth });
      socket.on('connect', () => {
        joinedId = null;
        joinRoom();
      });
      socket.on('support:message', (m) => {
        if (!state.conversation || m.conversationId !== state.conversation.id) return;
        if (state.messages.some((x) => x.id === m.id)) return;
        if (m.sender === 'user') state.messages = state.messages.filter((x) => !(String(x.id).startsWith('tmp-') && x.body === m.body));
        // While our own send is streaming, its messages arrive in the final payload.
        if (state.sending && m.sender !== 'human') return;
        state.messages.push(m);
        if (!state.open && m.sender !== 'user') launcher.classList.add('sw-unread');
        render();
      });
      socket.on('support:status', (c) => {
        if (!state.conversation || c.id !== state.conversation.id) return;
        state.conversation = c;
        state.needsEmail = Boolean(c.needsEmail);
        if (c.status !== 'resolved') state.csatDone = false;
        if (!state.sending) render();
      });
      socket.on('support:need_email', (d) => {
        if (state.conversation && d.conversationId === state.conversation.id) {
          state.needsEmail = true;
          if (!state.sending) render();
        }
      });
      if (cb) cb();
    };
    if (typeof window.io === 'function') return go();
    if (socketLoading) return;
    socketLoading = true;
    const s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.onload = () => go();
    document.head.appendChild(s);
  }
  function joinRoom() {
    if (!state.conversation || !state.conversation.id) return;
    ensureSocket(() => {
      if (!socket || !socket.connected || joinedId === state.conversation.id) return;
      joinedId = state.conversation.id;
      socket.emit('support:join', { conversationId: state.conversation.id });
    });
  }

  // ---- composer -----------------------------------------------------------------
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 44), 112)}px`;
  }
  function updateCount() {
    const n = input.value.length;
    const el = $('swCount');
    el.textContent = n >= COUNTER_AT ? `${n} / ${MAX_LEN}` : '';
    el.classList.toggle('sw-over', n >= MAX_LEN);
    sendBtn.disabled = state.sending || (!input.value.trim() && !state.attachment);
  }
  function clearAttachment() {
    if (state.attachment && state.attachment.url) URL.revokeObjectURL(state.attachment.url);
    state.attachment = null;
    $('swPreview').classList.remove('sw-show');
    $('swFile').value = '';
    updateCount();
  }
  input.addEventListener('input', () => {
    autoGrow();
    updateCount();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage(input.value);
    }
  });
  sendBtn.addEventListener('click', () => sendMessage(input.value));
  $('swAttach').addEventListener('click', () => $('swFile').click());
  $('swFile').addEventListener('change', () => {
    const f = $('swFile').files[0];
    if (!f) return;
    if (!IMAGE_TYPES.includes(f.type)) {
      state.pendingError = { text: 'Only PNG, JPG or WebP images can be attached.' };
      $('swFile').value = '';
      return render();
    }
    if (f.size > MAX_IMAGE) {
      state.pendingError = { text: 'Images must be 3 MB or smaller.' };
      $('swFile').value = '';
      return render();
    }
    clearAttachment();
    state.attachment = { file: f, url: URL.createObjectURL(f) };
    $('swPreviewImg').src = state.attachment.url;
    $('swPreviewName').textContent = f.name;
    $('swPreview').classList.add('sw-show');
    updateCount();
  });
  $('swPreviewRemove').addEventListener('click', clearAttachment);
  $('swHuman').addEventListener('click', talkToHuman);

  // Delegated clicks inside the message area.
  body.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-chip]');
    if (chip) {
      const t = chip.dataset.chip;
      if (t === 'Talk to a human') return talkToHuman();
      return sendMessage(t);
    }
    const rate = e.target.closest('[data-rate]');
    if (rate) {
      const helpful = rate.dataset.helpful === '1';
      const m = state.messages.find((x) => x.id === rate.dataset.rate);
      if (m) m.helpful = helpful;
      render();
      try {
        await api(`/messages/${rate.dataset.rate}/rate`, { method: 'POST', body: { helpful } });
        if (!helpful) applyServer(await api('/session', { method: 'POST', body: { conversationId: state.conversation && state.conversation.id } }));
      } catch (err) {
        /* rating is best effort */
      }
      return render();
    }
    const link = e.target.closest('[data-attach]');
    if (link) {
      e.preventDefault();
      // The API needs our auth headers, so fetch the image ourselves.
      try {
        const res = await fetch(link.getAttribute('href'), { headers: headers(false) });
        if (!res.ok) throw new Error();
        window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
      } catch (err) {
        state.pendingError = { text: 'That image could not be opened.' };
        render();
      }
      return;
    }
    const target = e.target.closest('button');
    if (!target) return;
    if (target.id === 'swRetrySend' && state.pendingError) {
      const retry = state.pendingError.retryBody;
      state.pendingError = null;
      input.value = '';
      return sendMessage(retry);
    }
    if (target.id === 'swFormLink') {
      state.view = 'form';
      return render();
    }
    if (target.id === 'swTfCancel') {
      state.view = 'chat';
      return render();
    }
    if (target.dataset.csat) {
      state.csatRating = Number(target.dataset.csat);
      const comment = $('swCsatComment') ? $('swCsatComment').value : '';
      render();
      if ($('swCsatComment')) $('swCsatComment').value = comment;
      return;
    }
    if (target.dataset.openConv) {
      state.view = 'chat';
      loadSession(target.dataset.openConv);
    }
  });
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'swEmailForm') {
      try {
        const data = await api('/guest-email', { method: 'POST', body: { conversationId: state.conversation && state.conversation.id, email: $('swEmail').value } });
        state.needsEmail = false;
        state.pendingError = null;
        applyServer(data);
      } catch (err) {
        state.pendingError = { text: err.message };
      }
      return render();
    }
    if (e.target.id === 'swCsat') {
      try {
        await api('/feedback', { method: 'POST', body: { conversationId: state.conversation.id, rating: state.csatRating, comment: $('swCsatComment').value } });
        state.csatDone = true;
      } catch (err) {
        state.pendingError = { text: err.message };
      }
      return render();
    }
    if (e.target.id === 'swTicketForm') {
      const out = $('swTfResult');
      try {
        const data = await api('/ticket', { method: 'POST', body: { email: $('swTfEmail').value, subject: $('swTfSubject').value, message: $('swTfMessage').value } });
        out.textContent = `Sent. Your ticket is ${data.ticket}. We will reply by email.`;
        e.target.querySelectorAll('input,textarea,button[type=submit]').forEach((el) => (el.disabled = true));
      } catch (err) {
        out.textContent = err.message;
      }
    }
  });

  $('swTicketsBtn').addEventListener('click', async () => {
    state.view = 'tickets';
    render();
    try {
      state.tickets = (await api('/tickets/mine')).tickets;
    } catch (e) {
      state.tickets = [];
    }
    render();
  });
  $('swBack').addEventListener('click', () => {
    state.view = 'chat';
    render();
  });
  $('swRetryConn').addEventListener('click', () => loadSession(state.conversation && state.conversation.id));
  window.addEventListener('offline', () => setOffline(true, 'You are offline.'));
  window.addEventListener('online', () => {
    setOffline(false);
    if (state.open) loadSession(state.conversation && state.conversation.id);
  });

  // ---- open / close, focus trap, swipe ---------------------------------------------
  let lastFocus = null;
  function openPanel(conversationId) {
    if (state.open && !conversationId) return;
    state.open = true;
    lastFocus = document.activeElement;
    panel.classList.add('sw-open');
    panel.setAttribute('aria-hidden', 'false');
    root.classList.add('sw-is-open');
    launcher.setAttribute('aria-expanded', 'true');
    launcher.setAttribute('aria-label', 'Close support chat');
    launcher.classList.remove('sw-unread', 'sw-pulse');
    if (!state.loaded || conversationId) loadSession(conversationId);
    else render();
    setTimeout(() => input.focus({ preventScroll: true }), 30);
  }
  function closePanel() {
    if (!state.open) return;
    state.open = false;
    panel.classList.remove('sw-open');
    panel.setAttribute('aria-hidden', 'true');
    root.classList.remove('sw-is-open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', 'Open support chat');
    panel.style.transform = '';
    if (lastFocus && document.contains(lastFocus) && lastFocus !== document.body) lastFocus.focus({ preventScroll: true });
    else launcher.focus({ preventScroll: true });
  }
  launcher.addEventListener('click', () => (state.open ? closePanel() : openPanel()));
  $('swClose').addEventListener('click', closePanel);
  $('swHandle').addEventListener('click', closePanel);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      return closePanel();
    }
    if (e.key !== 'Tab') return;
    const f = Array.from(panel.querySelectorAll('button:not([disabled]):not([hidden]),textarea:not([disabled]),input:not([disabled]):not([type=file]),a[href]')).filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  // Swipe down on the handle closes the bottom sheet (mobile).
  let dragY = null;
  $('swHandle').addEventListener('touchstart', (e) => (dragY = e.touches[0].clientY), { passive: true });
  $('swHandle').addEventListener(
    'touchmove',
    (e) => {
      if (dragY === null) return;
      panel.style.transform = `translateY(${Math.max(0, e.touches[0].clientY - dragY)}px)`;
    },
    { passive: true }
  );
  $('swHandle').addEventListener('touchend', (e) => {
    const dy = dragY === null ? 0 : e.changedTouches[0].clientY - dragY;
    dragY = null;
    panel.style.transform = '';
    if (dy > 80) closePanel();
  });
  // Keep the composer above the on-screen keyboard (mobile).
  if (window.visualViewport) {
    const fit = () => {
      if (!state.open || window.innerWidth > 600) {
        panel.style.height = '';
        panel.style.bottom = '';
        return;
      }
      const vv = window.visualViewport;
      panel.style.height = `${Math.round(vv.height - 8)}px`;
      panel.style.bottom = `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`;
      scrollDown();
    };
    window.visualViewport.addEventListener('resize', fit);
    window.visualViewport.addEventListener('scroll', fit);
  }

  // Deep link from support emails: /?support=<conversationId>
  try {
    const p = new URLSearchParams(location.search).get('support');
    if (p && /^[0-9a-f-]{36}$/i.test(p)) setTimeout(() => openPanel(p), 300);
  } catch (e) {
    /* ignore */
  }

  // If a conversation is waiting on or with a human, start listening in the
  // background so the unread dot lights up when the agent replies.
  setTimeout(() => {
    if (state.loaded || document.body.dataset.page === 'game') return;
    api('/session', { method: 'POST', body: {} })
      .then((data) => {
        if (state.loaded) return;
        state.loggedIn = data.loggedIn;
        if (data.conversation && ['waiting_human', 'human'].includes(data.conversation.status)) {
          applyServer(data);
          state.loaded = true;
        }
      })
      .catch(() => {});
  }, 1500);

  window.TW = window.TW || {};
  TW.supportWidget = { open: openPanel, close: closePanel };
  updateCount();
})();
