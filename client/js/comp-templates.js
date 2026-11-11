'use strict';

// Recurring competition cards (Daily, Weekly, Weekend, Monthly) and partner
// competition cards. Used by /competitions and /competitions/:key.
// Every word on a card comes from the server (competition_templates + the
// rules in server/competitionStates.js). A locked card keeps its full
// identity; only the Enter button changes to "Coming soon".
(function () {
  window.TW = window.TW || {};
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';
  const BELL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>';
  const EXT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';
  const STATE_LABEL = { coming_soon: 'Coming soon', open: 'Open', running: 'Live', paused: 'Paused', closed: 'Closed' };

  const authHeaders = () => {
    const t = TW.getToken ? TW.getToken() : null;
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  function actions(t, variant) {
    const enter = t.canEnter
      ? `<a class="tc-btn tc-primary" href="${esc(t.detailUrl)}">Enter for free</a>`
      : `<button type="button" class="tc-btn tc-soon" disabled aria-disabled="true">${t.state === 'paused' ? 'Paused' : t.state === 'closed' ? 'Closed' : 'Coming soon'}</button>`;
    const notify = t.canEnter ? '' : t.waitlist.joined
      ? `<button type="button" class="tc-btn tc-on" data-leave="${esc(t.key)}" aria-label="You're on the list for ${esc(t.title)}. Leave the list">${CHECK}<span>You're on the list</span></button>`
      : `<button type="button" class="tc-btn tc-notify" data-join="${esc(t.key)}" data-source="${variant === 'detail' ? 'detail' : 'card'}">${BELL}<span>Notify me</span></button>`;
    return `<div class="tc-actions">${enter}${notify}</div>`;
  }

  function templateCard(t, variant = 'card') {
    const p = t.prize;
    return `<article class="tc-card${t.canEnter ? '' : ' tc-locked'}" data-key="${esc(t.key)}" aria-labelledby="tc-${esc(t.key)}">
      <div class="tc-top">
        <span class="tc-state tc-state-${esc(t.state)}">${esc(STATE_LABEL[t.state] || t.state)}</span>
        ${p.badge ? `<span class="tc-free">${esc(p.badge)}</span>` : ''}
      </div>
      <h3 id="tc-${esc(t.key)}"><a href="${esc(t.detailUrl)}">${esc(t.title)}</a></h3>
      <div class="tc-sched">${esc(t.scheduleText)} · ${esc(t.lengthText)}</div>
      <div class="tc-prize${p.kind === 'coins' ? ' tc-prize-coins' : ''}">${esc(p.label)}</div>
      ${p.top ? `<div class="tc-top-line">${esc(p.top)}</div>` : ''}
      <p class="tc-hook">${esc(t.formatHook)}</p>
      <div class="tc-rules-line">${esc(t.rulesLine)}</div>
      ${t.moneyRules && t.moneyRules.length ? `<ul class="tc-rules">${t.moneyRules.map((r) => `<li>${CHECK}<span>${esc(r)}</span></li>`).join('')}</ul>` : ''}
      <div class="tc-sponsor" data-slot="competition_card" data-target="${esc(t.sponsorTarget)}" data-variant="line" hidden></div>
      ${actions(t, variant)}
      ${t.canEnter ? '' : `<div class="tc-rhythm">${esc(t.rhythmText)}</div>`}
      ${t.waitlist.count ? `<div class="tc-waiting">${Number(t.waitlist.count).toLocaleString()} players waiting</div>` : ''}
      ${variant === 'card' ? `<a class="tc-more" href="${esc(t.detailUrl)}">How it works</a>` : ''}
    </article>`;
  }

  // Partner competitions: hosted on the partner's site, prize text exactly as supplied.
  function partnerCard(c, sponsorName, placement) {
    const host = sponsorName || c.organizer_name || 'the partner';
    const when = [c.starts_at, c.ends_at].map((d) => (d ? new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '')).filter(Boolean).join(' to ');
    return `<article class="tc-card tc-partner" aria-labelledby="pc-${esc(c.id)}">
      <div class="tc-top"><span class="tc-hosted">Hosted by ${esc(host)}</span><span class="tc-free">Free entry</span></div>
      <h3 id="pc-${esc(c.id)}">${esc(c.title)}</h3>
      ${when ? `<div class="tc-sched">${esc(when)}</div>` : ''}
      <div class="tc-prize">${esc(c.prize_text || 'Prizes set by the partner')}</div>
      <div class="tc-top-line">Prize and rules set by ${esc(host)}</div>
      ${c.rules_summary ? `<p class="tc-hook">${esc(c.rules_summary)}</p>` : ''}
      <p class="tc-rules-line">Sign-up and trading happen on ${esc(host)}'s site, under ${esc(host)}'s rules.</p>
      <div class="tc-actions"><a class="tc-btn tc-primary" href="${esc(placement.href)}" target="_blank" rel="noopener sponsored" title="Opens ${esc(host)}'s site in a new tab">Compete on ${esc(host)} ${EXT}</a></div>
    </article>`;
  }

  async function join(key, source) {
    if (!(TW.isLoggedIn && TW.isLoggedIn())) {
      // Sign up first, then land back here with the list joined automatically.
      try { localStorage.setItem('tw_redirect_after_login', `${location.origin}/competitions/${key}?join=1`); } catch (e) { /* fall back to the page */ }
      location.href = '/?login=required';
      return false;
    }
    const res = await fetch(`/api/competition-templates/${encodeURIComponent(key)}/waitlist`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ source }) });
    if (!res.ok) { (TW.toast || alert)('Could not join the list right now'); return false; }
    TW.toast && TW.toast("You're on the list. We'll email you once when it opens.", 'info');
    return true;
  }
  async function leave(key) {
    const res = await fetch(`/api/competition-templates/${encodeURIComponent(key)}/waitlist`, { method: 'DELETE', headers: authHeaders() });
    if (!res.ok) { (TW.toast || alert)('Could not leave the list right now'); return false; }
    TW.toast && TW.toast('You have left the list.', 'info');
    return true;
  }

  function wire(root, reload) {
    root.addEventListener('click', async (e) => {
      const j = e.target.closest('[data-join]');
      const l = e.target.closest('[data-leave]');
      if (j) { j.disabled = true; if (await join(j.dataset.join, j.dataset.source)) await reload(); else j.disabled = false; }
      if (l) { l.disabled = true; if (await leave(l.dataset.leave)) await reload(); else l.disabled = false; }
    });
  }

  async function fetchTemplates() {
    const res = await fetch('/api/competition-templates', { headers: authHeaders() });
    return res.ok ? res.json() : { templates: [] };
  }
  async function fetchTemplate(key) {
    const res = await fetch(`/api/competition-templates/${encodeURIComponent(key)}`, { headers: authHeaders() });
    return res.ok ? res.json() : null;
  }

  TW.CompTemplates = { templateCard, partnerCard, join, leave, wire, fetchTemplates, fetchTemplate };
})();
