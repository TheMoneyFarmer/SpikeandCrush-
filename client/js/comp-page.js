'use strict';

// The competitions page (/competitions). Our two competitions first, then
// partner listings in tier order. Everything is Coming soon until live data
// exists: the only actions are Coming soon (disabled), Notify me and Details.
// Order, tiers, counts and the live flags all come from the server.
(function () {
  const CT = TW.CompTemplates;
  const esc = CT.esc;
  const $ = (id) => document.getElementById(id);
  const HEART = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>';
  const GLOBE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
  const TAB_NAMES = { all: 'All', ours: 'Spike & Crush', prop: 'Prop Firms', broker: 'Brokers', sponsored: 'Sponsored', live: 'Live Now' };
  const TYPE_CHIP = { prop: 'Prop firm', broker: 'Broker', sponsored: 'Sponsored' };
  const TIER_CHIP = { featured: 'Featured', plus: 'Plus' };
  const state = { tab: 'all', ours: [], listings: [], order: {}, liveNow: false, liveFeed: { ready: false } };

  try { const t = sessionStorage.getItem('sc_comp_tab'); if (t && TAB_NAMES[t]) state.tab = t; } catch (e) { /* ignore */ }
  const h = location.hash.replace('#', '');
  if (TAB_NAMES[h]) state.tab = h;

  // ---- small parts ------------------------------------------------------------------------
  function ring(value, max, label, title) {
    const r = 15;
    const c = 2 * Math.PI * r;
    const frac = Math.max(0, Math.min(1, (Number(value) || 0) / max));
    return `<span class="cp-ring" title="${esc(title)}"><svg viewBox="0 0 36 36" width="40" height="40" aria-hidden="true"><circle cx="18" cy="18" r="${r}" class="cp-ring-bg"/><circle cx="18" cy="18" r="${r}" class="cp-ring-fg" stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 18 18)"/></svg><b>${esc(label)}</b></span>`;
  }

  function notifyBtn(t) {
    return t.waitlist.joined
      ? `<button type="button" class="tc-btn tc-on cp-btn" data-leave="${esc(t.key)}" aria-label="You're on the list for ${esc(t.title)}. Leave the list">${CT.CHECK}<span>You're on the list</span></button>`
      : `<button type="button" class="tc-btn tc-notify cp-btn" data-join="${esc(t.key)}" data-source="card">${CT.BELL}<span>Notify me</span></button>`;
  }
  function notifyListingBtn(l) {
    return l.waitlist.joined
      ? `<button type="button" class="tc-btn tc-on cp-btn cp-btn-sm" data-leave-listing="${esc(l.id)}" aria-label="You're on the list for ${esc(l.title)}. Leave the list">${CT.CHECK}<span>On the list</span></button>`
      : `<button type="button" class="tc-btn tc-notify cp-btn cp-btn-sm" data-join-listing="${esc(l.id)}" data-source="card" aria-label="Notify me when ${esc(l.title)} opens">${CT.BELL}<span>Notify me</span></button>`;
  }
  const soonBtn = (cls = '') => `<button type="button" class="tc-btn tc-soon cp-btn ${cls}" disabled aria-disabled="true">Coming soon</button>`;

  // ---- our competitions (large cards) -------------------------------------------------------
  function ourCard(t, i) {
    const p = t.prize;
    const waiting = t.waitlist.count ? Number(t.waitlist.count).toLocaleString('en-US') : 'Be first';
    const markets = t.marketsLabel ? `<span class="cp-chip">Weekend markets: ${esc(t.marketsLabel)}</span>` : '';
    return `<article class="cp-our" aria-labelledby="our-${esc(t.key)}">
      <div class="cp-our-head">
        <span class="cp-rank" aria-label="Number ${i + 1}">${String(i + 1).padStart(2, '0')}</span>
        <span class="cp-mark" aria-hidden="true">S<i>&amp;</i>C</span>
        <div class="cp-our-name">
          <h3 id="our-${esc(t.key)}"><a href="${esc(t.detailUrl)}">${esc(t.title)}</a></h3>
          <span class="cp-org">Spike &amp; Crush</span>
        </div>
        <span class="cp-pill-soon">Coming soon</span>
      </div>
      <dl class="cp-stats">
        <div><dt>Prize</dt><dd class="cp-gold">${esc(p.amount || p.label)}</dd></div>
        <div><dt>Entry</dt><dd>Free</dd></div>
        <div><dt>Waiting</dt><dd>${esc(waiting)}</dd></div>
        <div><dt>Schedule</dt><dd>${esc(t.scheduleText)}</dd></div>
      </dl>
      <p class="cp-hook">${esc(t.formatHook)}</p>
      ${markets ? `<div class="cp-chips">${markets}</div>` : ''}
      <ul class="cp-rules">${(t.moneyRules || []).map((r) => `<li>${CT.CHECK}<span>${esc(r)}</span></li>`).join('')}</ul>
      <div class="tc-sponsor" data-slot="competition_card" data-target="${esc(t.sponsorTarget)}" data-variant="line" hidden></div>
      <div class="cp-actions">${soonBtn()}${notifyBtn(t)}<a class="cp-details" href="${esc(t.detailUrl)}">Details</a></div>
    </article>`;
  }

  // ---- partner listings (compact rows) ------------------------------------------------------
  function listingRow(l) {
    const tier = l.tier || 'standard';
    const chips = [
      `<span class="cp-chip cp-chip-type">${esc(TYPE_CHIP[l.type])}</span>`,
      TIER_CHIP[tier] ? `<span class="cp-chip cp-chip-${tier}">${TIER_CHIP[tier]}</span>` : '',
      l.preview ? '<span class="cp-chip cp-chip-preview" title="Example listing. A real partner replaces it when they sign.">Preview</span>' : '',
      ...(l.type === 'sponsored' ? [l.howToWin ? `<span class="cp-chip">${esc(l.howToWin)}</span>` : ''] : l.rules.slice(0, 3).map((r) => `<span class="cp-chip">${esc(r)}</span>`)),
      ...l.assets.slice(0, 3).map((a) => `<span class="cp-chip cp-chip-asset">${esc(a)}</span>`),
    ].filter(Boolean).join('');
    const prize = l.prize.amount
      ? `<b class="cp-gold">${esc(l.prize.amount)}</b><span>Prize</span>`
      : `<b class="cp-goods">${esc(l.prize.text || l.prize.label)}</b><span>To win</span>`;
    const rings = l.type === 'sponsored' ? '' : `<div class="cp-rings">${l.organizer.years != null ? ring(l.organizer.years, 15, `${l.organizer.years}y`, `${l.organizer.years} years in operation (Preview data)`) : ''}${l.organizer.rating != null ? ring(l.organizer.rating, 5, l.organizer.rating.toFixed(1), `Rated ${l.organizer.rating} of 5 (Preview data)`) : ''}</div>`;
    const where = [l.organizer.name, l.kind].filter(Boolean).join(' · ');
    const country = l.organizer.country ? `<span class="cp-country" title="Country (Preview data)">${GLOBE}${esc(l.organizer.country)}</span>` : '';
    const platforms = l.platforms.length ? `<span class="cp-plat">${l.platforms.map(esc).join(' · ')}</span>` : '';
    return `<article class="cp-row cp-tier-${tier}" aria-labelledby="ls-${esc(l.id)}">
      <a class="cp-logo" href="${esc(l.detailUrl)}" tabindex="-1" aria-hidden="true"><img src="${esc(l.organizer.logo || '')}" alt="" width="44" height="44" loading="lazy"></a>
      <div class="cp-main">
        <div class="cp-title-row">
          <h3 id="ls-${esc(l.id)}"><a href="${esc(l.detailUrl)}">${esc(l.title)}</a></h3>
          <button type="button" class="cp-heart" data-save="${esc(l.id)}" aria-pressed="${l.saved ? 'true' : 'false'}" aria-label="${l.saved ? 'Saved. Remove from saved' : 'Save for later'}">${HEART}</button>
        </div>
        <div class="cp-sub">${esc(where)}${country}${platforms}</div>
        <div class="cp-chips">${chips}</div>
      </div>
      ${rings}
      <div class="cp-prize">${prize}</div>
      <div class="cp-row-actions">${soonBtn('cp-btn-sm')}${notifyListingBtn(l)}<a class="cp-details" href="${esc(l.detailUrl)}">Details</a></div>
    </article>`;
  }

  // ---- render --------------------------------------------------------------------------------
  function visibleListings() {
    if (state.tab === 'ours') return [];
    if (state.tab === 'live') return state.listings.filter((l) => l.state === 'running');
    const ids = state.order[state.tab] || state.order.all || [];
    const byId = new Map(state.listings.map((l) => [l.id, l]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  function render() {
    const tabs = ['all', 'ours', 'prop', 'broker', 'sponsored'];
    if (state.liveNow) tabs.splice(1, 0, 'live');
    if (!tabs.includes(state.tab)) state.tab = 'all';
    $('cpTabs').innerHTML = tabs.map((t) => `<button type="button" role="tab" class="cp-tab${t === state.tab ? ' is-on' : ''}" data-tab="${t}" aria-selected="${t === state.tab}">${t === 'live' ? '<span class="cp-live-dot" aria-hidden="true"></span>' : ''}${esc(TAB_NAMES[t])}</button>`).join('');
    const showOurs = state.tab === 'all' || state.tab === 'ours';
    const list = visibleListings();
    const count = (showOurs ? state.ours.length : 0) + list.length;
    $('cpCount').textContent = `${count} ${count === 1 ? 'competition' : 'competitions'}`;
    $('cpOursWrap').hidden = !showOurs;
    $('cpOurs').innerHTML = state.ours.map(ourCard).join('');
    $('cpListWrap').hidden = state.tab === 'ours';
    $('cpListHead').textContent = state.tab === 'all' ? 'Partner competitions' : TAB_NAMES[state.tab];
    $('cpList').innerHTML = list.length ? list.map(listingRow).join('') : `<div class="cp-empty">Nothing listed here yet. <a href="/sponsor">Partner with us</a> to list a competition.</div>`;
    const live = $('cpLiveLine');
    if (state.liveFeed.ready && state.liveFeed.heartbeatAt) {
      live.hidden = false;
      live.querySelector('span').textContent = TW.timeAgo ? TW.timeAgo(state.liveFeed.heartbeatAt) : new Date(state.liveFeed.heartbeatAt).toLocaleTimeString();
    } else live.hidden = true;
    if (TW.SponsorSlots) TW.SponsorSlots.scan($('cpOurs'));
  }

  async function load() {
    const headers = TW.getToken && TW.getToken() ? { Authorization: `Bearer ${TW.getToken()}` } : {};
    const [tpl, lst] = await Promise.all([
      CT.fetchTemplates().catch(() => ({ templates: [] })),
      fetch('/api/competition-listings', { headers }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    state.ours = (tpl.templates || []).filter((t) => t.prize && t.prize.kind !== 'coins');
    state.listings = lst.listings || [];
    state.order = lst.order || {};
    state.liveNow = Boolean(lst.liveNow) || state.ours.some((t) => t.state === 'running');
    state.liveFeed = lst.liveFeed || { ready: false };
    if (tpl.pageLine) $('cpPageLine').textContent = tpl.pageLine;
    render();
  }

  $('cpTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    try { sessionStorage.setItem('sc_comp_tab', state.tab); } catch (err) { /* ignore */ }
    history.replaceState(null, '', state.tab === 'all' ? location.pathname : `#${state.tab}`);
    render();
  });
  $('cpTabs').addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const all = [...$('cpTabs').querySelectorAll('[data-tab]')];
    const i = all.findIndex((x) => x.classList.contains('is-on'));
    const next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
    next.click(); $('cpTabs').querySelector(`[data-tab="${next.dataset.tab}"]`).focus();
  });
  CT.wire(document.getElementById('cpMain'), load);
  load().then(() => CT.resumeAfterLogin(load));
  setInterval(() => { if (!document.hidden) load(); }, 60000);
})();
