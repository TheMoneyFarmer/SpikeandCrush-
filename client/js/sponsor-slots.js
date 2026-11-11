'use strict';

// Sponsor slots on the page: any element with data-slot="<slot>" (and an
// optional data-target) gets the placement the server chose, or collapses to
// nothing. The server decides what shows; this file only renders it, labels
// it ("Presented by" / "Sponsored"), and reports an impression once the slot
// has been at least half visible for a full second. Clicks go through /go/:id.
//
// Never placed over the chart, price scale, order ticket, Modify panel, card
// tray, target picker, support chat, sign-up or payment flows, or legal pages.
(function () {
  window.TW = window.TW || {};
  const cache = new Map(); // "slot:target" -> payload list
  const seenQueue = new Set();
  const counted = new Set();
  let flushTimer = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyOf = (el) => `${el.dataset.slot}:${el.dataset.target || ''}`;
  const preview = new URLSearchParams(location.search).get('sp_preview');
  const dark = () => document.documentElement.getAttribute('data-theme') !== 'light';

  function logo(p, cls) {
    const src = (dark() && p.sponsor.logoDarkUrl) || p.sponsor.logoUrl;
    return src ? `<img class="${cls}" src="${esc(src)}" alt="${esc(p.sponsor.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : `<span class="${cls} spx-name">${esc(p.sponsor.name)}</span>`;
  }

  // One renderer per slot, all inside fixed boxes (css/sponsor-slots.css).
  function html(p, el) {
    const link = (inner, cls = '') => `<a class="spx-link ${cls}" href="${esc(p.href)}" target="_blank" rel="noopener sponsored" data-placement="${esc(p.placementId)}">${inner}</a>`;
    switch (p.slot) {
      case 'match_header_chip':
        return link(`<span class="spx-label">${esc(p.label)}</span>${logo(p, 'spx-logo')}`, 'spx-chip');
      case 'spike_strip_tag':
        return link(`<span class="spx-label">Spike alerts presented by</span> <b>${esc(p.sponsor.name)}</b>`, 'spx-tag');
      case 'email_footer':
        return '';
      case 'prematch':
        return `<div class="spx-pre"><span class="spx-label">${esc(p.lead || p.label)}</span>${link(logo(p, 'spx-logo'))}${p.sponsor.tagline ? `<span class="spx-tagline">${esc(p.sponsor.tagline)}</span>` : ''}</div>`;
      case 'lobby_strip':
        return link(`${logo(p, 'spx-logo')}${p.sponsor.tagline ? `<span class="spx-tagline">${esc(p.sponsor.tagline)}</span>` : ''}`, 'spx-tile');
      default: // competition_card, result_screen, leaderboard_header, event_banner
        return `<div class="spx-row"><span class="spx-label">${esc(p.label)}</span>${link(logo(p, 'spx-logo'))}${p.sponsor.tagline && el.dataset.variant !== 'line' ? `<span class="spx-tagline">${esc(p.sponsor.tagline)}</span>` : ''}${p.cta && el.dataset.variant !== 'line' ? link(esc(p.cta.text), 'spx-cta') : ''}</div>`;
    }
  }

  function paint(el, list) {
    if (!list || !list.length) {
      el.hidden = true; // collapses: no gap where there is no sponsor
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = el.dataset.slot === 'lobby_strip'
      ? `<span class="spx-label spx-strip-label">Sponsored</span><div class="spx-strip">${list.map((p) => html(p, el)).join('')}</div>`
      : html(list[0], el);
    el.dataset.placements = list.map((p) => p.placementId).join(',');
    observe(el);
  }

  // ---- impressions: half visible for one second ----
  const timers = new WeakMap();
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio >= 0.5) {
        if (timers.has(e.target)) continue;
        timers.set(e.target, setTimeout(() => { timers.delete(e.target); queueSeen(e.target); }, 1000));
      } else if (timers.has(e.target)) {
        clearTimeout(timers.get(e.target));
        timers.delete(e.target);
      }
    }
  }, { threshold: [0, 0.5, 1] }) : null;

  function observe(el) {
    if (io && !preview) io.observe(el);
  }
  function queueSeen(el) {
    for (const id of String(el.dataset.placements || '').split(',').filter(Boolean)) {
      if (counted.has(id)) continue; // once per page view; the server also dedupes per minute
      counted.add(id);
      seenQueue.add(id);
    }
    if (!flushTimer) flushTimer = setTimeout(flushSeen, 4000);
  }
  function flushSeen(beacon) {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!seenQueue.size) return;
    const body = JSON.stringify({ ids: [...seenQueue].slice(0, 20) });
    seenQueue.clear();
    const headers = { 'Content-Type': 'application/json' };
    const token = window.TW && TW.getToken ? TW.getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/slots/seen', new Blob([body], { type: 'application/json' }));
    else fetch('/api/slots/seen', { method: 'POST', headers, body, keepalive: true }).catch(() => {});
  }
  addEventListener('pagehide', () => flushSeen(true));

  // ---- fetching ----
  async function load(els) {
    const wants = [...new Set(els.map(keyOf))].filter((k) => !cache.has(k));
    if (wants.length) {
      try {
        const q = new URLSearchParams({ want: wants.join(',') });
        if (preview) q.set('preview', preview);
        const res = await fetch(`/api/slots?${q}`);
        const d = res.ok ? await res.json() : { slots: {} };
        for (const k of wants) cache.set(k, (d.slots || {})[k] || []);
      } catch (e) {
        for (const k of wants) cache.set(k, []);
      }
    }
    els.forEach((el) => paint(el, cache.get(keyOf(el))));
  }

  function scan(root = document) {
    const els = [...root.querySelectorAll('[data-slot]')];
    if (els.length) return load(els);
    return Promise.resolve();
  }

  // Fill one element now from what is already loaded (for UI that re-renders,
  // like the spike strip), or fetch it if this slot/target is new.
  function renderInto(el) {
    const k = keyOf(el);
    if (cache.has(k)) paint(el, cache.get(k));
    else load([el]);
  }

  // The first sponsor already loaded for a slot (the result screen and share
  // image use it without another request).
  function current(slot, target = '') {
    const list = cache.get(`${slot}:${target}`);
    return list && list[0] ? list[0] : null;
  }

  TW.SponsorSlots = { scan, renderInto, current, load: (slot, target = '') => load([Object.assign(document.createElement('div'), { dataset: { slot, target } })]).then(() => current(slot, target)) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan());
  else scan();
})();
