'use strict';

// Discover, inside the lobby: a right-hand panel on desktop and tablet that
// pushes the page over (nothing is covered), and a bottom sheet on phones
// that sits above the tab bar (half height, drag up for full) while the page
// above it stays scrollable. Everything works from inside the panel: Add
// friend, Invite to a match (your open room, a Private War, or a public mode),
// Join someone's open room, Block, Report. The panel keeps its tab, search,
// filters, list and scroll position when closed and reopened.
//
// TW.Discover.open() / close() / toggle(); /play?discover=1 opens it on load.
// Uses the existing Discover API (server/index.js /api/discover*), presence
// diffs over the socket, and the existing invite events. No location data is
// ever shown or sent.
(function () {
  window.TW = window.TW || {};
  if (TW.Discover) return;

  // The lobby's phone layout (tab bar, mode sheet) runs up to 1023px; short
  // landscape phones get a side panel instead of a sheet.
  const MOBILE = () => window.matchMedia('(max-width: 1023px)').matches && !window.matchMedia('(max-height: 500px) and (orientation: landscape)').matches;
  const REDUCED = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SS_KEY = 'tw_discover_state';
  const STATE_LABEL = { online: 'Online', in_match: 'In a match', away: 'Away', offline: 'Offline' };
  const INVITE_MODES = [
    ['private', 'Private War', 'Free, you host'],
    ['quick', 'Quick War', null],
    ['blitz', 'Blitz War', null],
    ['grand', 'Grand War', null],
  ];
  const ic = (name, size = 16) => (TW.icon ? TW.icon(name, { size }) : '');
  const esc = (s) => (TW.escapeHtml ? TW.escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = (m, t) => (TW.toast ? TW.toast(m, t) : null);

  const st = { section: 'friends', page: 0, q: '', filters: {}, items: [], hasMore: false, open: false, expanded: false, myRoom: null, pending: null, loadedOnce: false };
  try { Object.assign(st, JSON.parse(sessionStorage.getItem(SS_KEY) || '{}'), { items: [], open: false, pending: null, loadedOnce: false }); } catch (e) { /* defaults */ }
  const remember = () => { try { sessionStorage.setItem(SS_KEY, JSON.stringify({ section: st.section, q: st.q, filters: st.filters, expanded: st.expanded })); } catch (e) { /* not kept */ } };

  let root = null;
  let listEl = null;
  let lastTrigger = null;
  let socket = null;

  function build() {
    root = document.createElement('aside');
    root.className = 'dp';
    root.id = 'twDiscover';
    root.setAttribute('aria-label', 'Discover players');
    root.hidden = true;
    root.innerHTML = `
      <div class="dp-grip" aria-hidden="true"><span></span></div>
      <header class="dp-head">
        <h2 class="dp-title">${ic('users', 18)}<span>Discover</span></h2>
        <button type="button" class="dp-icon dp-size" aria-label="Full height" title="Full height">${ic('chevronUp', 18)}</button>
        <a class="dp-link" href="/settings#privacy">Privacy</a>
        <button type="button" class="dp-icon dp-close" aria-label="Close Discover">${ic('close', 18)}</button>
      </header>
      <div class="dp-room" hidden></div>
      <section class="dp-event" data-slot="event_banner" data-target="discover" aria-label="Event" hidden></section>
      <div class="dp-tabs" role="tablist" aria-label="Discover sections">
        <button type="button" role="tab" data-section="friends">Friends</button>
        <button type="button" role="tab" data-section="live">Live now</button>
        <button type="button" role="tab" data-section="rooms">Open rooms</button>
        <button type="button" role="tab" data-section="suggested">For you</button>
      </div>
      <div class="dp-tools">
        <label class="dp-search">${ic('search', 16)}<input type="search" placeholder="Search by handle" aria-label="Search by handle" /></label>
        <div class="dp-filters">
          <label><input type="checkbox" data-f="tier" /> Same rank</label>
          <label><input type="checkbox" data-f="level" /> Similar level</label>
          <label><input type="checkbox" data-f="played" /> Played before</label>
        </div>
      </div>
      <div class="dp-body"><div class="dp-list" role="list"></div><button type="button" class="dp-more" hidden>Load more</button>
        <p class="dp-note">Anyone live can be invited, friend or not, if their settings allow it. We never show anyone's location. Invites carry no messages.</p></div>`;
    document.body.appendChild(root);
    listEl = root.querySelector('.dp-list');

    root.querySelector('.dp-close').addEventListener('click', () => close());
    root.querySelector('.dp-size').addEventListener('click', () => setExpanded(!st.expanded));
    root.querySelectorAll('.dp-tabs [data-section]').forEach((b) => b.addEventListener('click', () => {
      st.section = b.dataset.section;
      remember();
      syncChrome();
      load(true);
    }));
    const search = root.querySelector('.dp-search input');
    search.value = st.q || '';
    let t = null;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { st.q = search.value.trim(); remember(); load(true); }, 250); });
    root.querySelectorAll('[data-f]').forEach((c) => {
      c.checked = Boolean(st.filters[c.dataset.f]);
      c.addEventListener('change', () => { st.filters[c.dataset.f] = c.checked; remember(); load(true); });
    });
    root.querySelector('.dp-more').addEventListener('click', () => { st.page += 1; load(false); });
    listEl.addEventListener('click', onAction);
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    bindDrag();
    syncChrome();
  }

  // Phone sheet: drag the grip up for full height, down to half, further to close.
  function bindDrag() {
    const grip = root.querySelector('.dp-grip');
    let y0 = null;
    grip.addEventListener('pointerdown', (e) => { if (!MOBILE()) return; y0 = e.clientY; grip.setPointerCapture(e.pointerId); });
    grip.addEventListener('pointerup', (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      y0 = null;
      if (dy < -40) setExpanded(true);
      else if (dy > 40) { if (st.expanded) setExpanded(false); else close(); }
    });
    grip.addEventListener('click', () => { if (MOBILE()) setExpanded(!st.expanded); });
  }

  function setExpanded(v) {
    st.expanded = v;
    remember();
    syncChrome();
    layout();
  }

  function syncChrome() {
    if (!root) return;
    root.querySelectorAll('.dp-tabs [data-section]').forEach((b) => {
      const on = b.dataset.section === st.section;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    root.querySelector('.dp-tools').hidden = st.section === 'rooms';
    root.classList.toggle('expanded', Boolean(st.expanded));
    const size = root.querySelector('.dp-size');
    size.setAttribute('aria-label', st.expanded ? 'Half height' : 'Full height');
    size.innerHTML = ic(st.expanded ? 'chevronDown' : 'chevronUp', 18);
  }

  // Reserve room for the panel so it never covers the page: right padding on
  // desktop, bottom padding (plus scroll padding) under the phone sheet.
  function layout() {
    const b = document.body;
    b.classList.toggle('dp-open', st.open);
    b.classList.toggle('dp-open-full', st.open && st.expanded && MOBILE());
    if (!st.open) {
      b.style.removeProperty('--dp-sheet-h');
      return;
    }
    // The sheet sits above whatever is highest of the tab bar and its raised
    // Play button, so Play is never under it.
    const bar = document.querySelector('.bottom-tab-bar');
    const playBtn = document.getElementById('tabPlayBtn');
    const tops = [bar, playBtn].filter((el) => el && getComputedStyle(el).display !== 'none').map((el) => el.getBoundingClientRect().top).filter((t) => t > 0);
    b.style.setProperty('--dp-bottom', tops.length ? `${Math.max(0, Math.round(window.innerHeight - Math.min(...tops) + 6))}px` : '0px');
    if (MOBILE()) {
      requestAnimationFrame(() => {
        const h = root.getBoundingClientRect().height;
        b.style.setProperty('--dp-sheet-h', `${Math.round(h)}px`);
      });
    }
  }

  function rowHtml(p) {
    const acts = [];
    if (p.joinLobbyId) acts.push(`<button type="button" class="dp-btn primary" data-act="join" data-lobby="${esc(p.joinLobbyId)}">Join</button>`);
    if (p.canInvite && p.state !== 'in_match') acts.push(`<button type="button" class="dp-btn" data-act="invite" aria-expanded="false">Invite</button>`);
    if (p.relation !== 'friend' && p.canRequest && !p.requested) acts.push(`<button type="button" class="dp-btn" data-act="request">Add friend</button>`);
    if (p.requested) acts.push('<span class="dp-tag">Request sent</span>');
    if (p.invited) acts.push('<span class="dp-tag gold">Invited</span>');
    acts.push(`<button type="button" class="dp-btn ghost" data-act="more" aria-label="More for ${esc(p.username)}" aria-expanded="false">${ic('moreHorizontal', 16)}</button>`);
    return `<div class="dp-row" role="listitem" data-id="${esc(p.id)}">
      <div class="dp-av">${p.avatarUrl ? `<img src="${esc(p.avatarUrl)}" alt="" loading="lazy" />` : esc((p.username || '?')[0]).toUpperCase()}</div>
      <div class="dp-who"><div class="dp-name">${esc(p.username)}${p.title ? ` <span class="dp-title-tag">${esc(p.title)}</span>` : ''}</div>
        <div class="dp-meta"><span class="dp-state st-${esc(p.state)}"><i></i>${STATE_LABEL[p.state] || 'Online'}${p.mode ? ` · ${esc(p.mode)}` : ''}</span>${p.tier ? `<span>${esc(p.tier)}</span>` : ''}${p.level ? `<span>Lv ${esc(p.level)}</span>` : ''}${p.mutualFriends ? `<span>${p.mutualFriends} mutual</span>` : ''}${p.relation === 'friend' ? '<span>Friend</span>' : ''}</div></div>
      <div class="dp-acts">${acts.join('')}</div>
      <div class="dp-drawer" hidden></div></div>`;
  }

  function roomHtml(r) {
    return `<div class="dp-row" role="listitem" data-room="${esc(r.matchId)}">
      <div class="dp-av dp-av-room">${esc(r.players)}</div>
      <div class="dp-who"><div class="dp-name">${esc(r.label)}</div><div class="dp-meta"><span>${r.players} player${r.players === 1 ? '' : 's'}${r.maxPlayers ? ` of ${r.maxPlayers}` : ''}</span><span>${r.entryCoins ? `${r.entryCoins} coins` : 'Free'}</span>${r.lobbyTier ? `<span>${esc(r.lobbyTier)} lobby</span>` : ''}<span>Open until it starts</span></div></div>
      <div class="dp-acts"><button type="button" class="dp-btn primary" data-act="joinroom">Join</button></div></div>`;
  }

  function emptyHtml(msg) {
    return `<div class="dp-empty">${esc(msg)}<div class="dp-empty-acts"><a href="/play?modes=1">Play Solo</a><a href="/async">Daily Challenge</a></div></div>`;
  }

  function render() {
    listEl.innerHTML = st.items.length ? st.items.map(st.section === 'rooms' ? roomHtml : rowHtml).join('') : emptyHtml(st.emptyMessage || (st.section === 'rooms' ? 'No open rooms right now. Start one and invite people.' : 'Nobody to show here right now.'));
    root.querySelector('.dp-more').hidden = !st.hasMore;
  }

  let loadSeq = 0;
  async function load(reset) {
    // Only the newest request counts: a tab switch and a search typed right
    // after it must not both add their results.
    const seq = ++loadSeq;
    if (reset) { st.page = 0; st.items = []; }
    const qs = new URLSearchParams({ section: st.section, page: st.page });
    if (st.q) qs.set('q', st.q);
    for (const [k, v] of Object.entries(st.filters)) if (v) qs.set(k, '1');
    if (reset) listEl.innerHTML = '<div class="dp-skel"></div><div class="dp-skel"></div><div class="dp-skel"></div>';
    try {
      const d = await TW.api(`/api/discover?${qs}`);
      if (seq !== loadSeq) return;
      const seen = new Set(st.items.map((x) => x.id || x.matchId));
      st.items = st.items.concat((d.items || []).filter((x) => !seen.has(x.id || x.matchId)));
      st.hasMore = Boolean(d.hasMore);
      st.emptyMessage = d.emptyMessage;
      st.loadedOnce = true;
      render();
      if (st.section !== 'rooms' && socket) socket.emit('discover:watch', { ids: st.items.slice(0, 60).map((p) => p.id) });
    } catch (e) {
      if (seq !== loadSeq) return;
      listEl.innerHTML = `<div class="dp-empty">${esc(e.message || 'Discover is not available right now')}</div>`;
    }
    loadMyRoom();
  }

  async function loadMyRoom() {
    try {
      const d = await TW.api('/api/discover/me');
      st.myRoom = d.room;
    } catch (e) {
      st.myRoom = null;
    }
    const box = root.querySelector('.dp-room');
    if (st.pending) {
      box.hidden = false;
      box.innerHTML = `<span>${ic('clock', 16)} Invite sent to <b>${esc(st.pending.username)}</b>. You are in your ${esc(st.pending.label)} room; you'll both be taken there when they accept.</span><a class="dp-btn primary" href="/lobby.html?matchId=${encodeURIComponent(st.pending.matchId)}">Go to room</a>`;
    } else if (st.myRoom) {
      box.hidden = false;
      box.innerHTML = `<span>${ic('flag', 16)} You have an open ${esc(st.myRoom.label)} room (${st.myRoom.players} in it). Invites go there.</span><a class="dp-btn" href="/lobby.html?matchId=${encodeURIComponent(st.myRoom.matchId)}">Open</a>`;
    } else {
      box.hidden = true;
      box.innerHTML = '';
    }
  }

  function closeDrawers(except) {
    listEl.querySelectorAll('.dp-drawer').forEach((d) => {
      if (d === except) return;
      d.hidden = true;
      d.innerHTML = '';
      d.closest('.dp-row')?.querySelectorAll('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    });
  }

  function inviteChooser(drawer) {
    const room = st.myRoom;
    drawer.innerHTML = `<div class="dp-choose" role="group" aria-label="Invite to">
      ${room ? `<button type="button" class="dp-opt" data-pick="room"><b>Your ${esc(room.label)} room</b><span>${room.players} in it now</span></button>` : ''}
      ${INVITE_MODES.filter(([m]) => !room || room.mode !== m).map(([m, label, note]) => `<button type="button" class="dp-opt" data-pick="${m}"><b>${esc(label)}</b><span>${esc(note || 'Public lobby, entry coins apply')}</span></button>`).join('')}
    </div>`;
  }

  function moreMenu(drawer) {
    drawer.innerHTML = `<div class="dp-choose" role="group" aria-label="More">
      <button type="button" class="dp-opt" data-more="block"><b>Block</b><span>They disappear from your lists and can't invite you</span></button>
      <div class="dp-report"><b>Report</b><div class="dp-reasons">${['cheating', 'abusive_name', 'spam', 'harassment', 'underage', 'other'].map((r) => `<button type="button" class="dp-chip" data-reason="${r}">${r.replace('_', ' ')}</button>`).join('')}</div></div>
    </div>`;
  }

  async function sendInvite(row, pick) {
    const id = row.dataset.id;
    const p = st.items.find((x) => x.id === id) || {};
    // A public mode: join (or make) that mode's lobby first; the server then
    // invites into it. Entry coins are charged by the normal join.
    if (pick !== 'room' && pick !== 'private' && !(st.myRoom && st.myRoom.mode === pick)) {
      await TW.api('/api/match/create', { method: 'POST', body: { mode: pick } });
    }
    if (pick === 'private' && st.myRoom && st.myRoom.mode !== 'private') {
      toast('You are already waiting in another room; invites go there', 'info');
    }
    const r = await TW.api('/api/discover/invite', { method: 'POST', body: { targetId: id } });
    if (!r.sent) {
      const why = { blocked: 'You can no longer invite this player', offline: 'They just went offline', busy: 'They are in a match', not_accepting: 'They are not taking invites right now', already_invited: 'Already invited', too_many: 'Too many invites to strangers. Try again in a few minutes' }[r.reason] || 'Could not invite right now';
      toast(why, 'warning');
      return;
    }
    p.invited = true;
    const room = (await TW.api('/api/discover/me').catch(() => ({ room: null }))).room;
    st.pending = { username: p.username || 'player', matchId: r.matchId, label: room ? room.label : 'Private War' };
    toast(`Invite sent to ${p.username || 'player'}`, 'success');
    render();
    loadMyRoom();
  }

  async function onAction(e) {
    const b = e.target.closest('button[data-act], button[data-pick], button[data-more], button[data-reason]');
    if (!b) return;
    const row = b.closest('.dp-row');
    const drawer = row && row.querySelector('.dp-drawer');
    try {
      if (b.dataset.act === 'invite' || b.dataset.act === 'more') {
        const opening = drawer.hidden || drawer.dataset.kind !== b.dataset.act;
        closeDrawers();
        if (!opening) return;
        drawer.dataset.kind = b.dataset.act;
        if (b.dataset.act === 'invite') inviteChooser(drawer); else moreMenu(drawer);
        drawer.hidden = false;
        b.setAttribute('aria-expanded', 'true');
        drawer.querySelector('button')?.focus();
        return;
      }
      b.disabled = true;
      if (b.dataset.pick) { await sendInvite(row, b.dataset.pick); closeDrawers(); return; }
      const id = row.dataset.id;
      const p = st.items.find((x) => x.id === id) || {};
      if (b.dataset.act === 'request') {
        await TW.api('/api/friends/request', { method: 'POST', body: { targetId: id } });
        p.requested = true;
        toast('Friend request sent', 'success');
        render();
      } else if (b.dataset.act === 'join') {
        const r = await TW.api('/api/discover/join', { method: 'POST', body: { lobbyId: b.dataset.lobby } });
        location.href = `/lobby.html?matchId=${encodeURIComponent(r.matchId)}`;
      } else if (b.dataset.act === 'joinroom') {
        const r = await TW.api('/api/discover/join', { method: 'POST', body: { lobbyId: row.dataset.room } });
        location.href = `/lobby.html?matchId=${encodeURIComponent(r.matchId)}`;
      } else if (b.dataset.more === 'block') {
        await TW.api('/api/friends/block', { method: 'POST', body: { targetId: id } });
        st.items = st.items.filter((x) => x.id !== id);
        render();
        toast('Blocked', 'info');
      } else if (b.dataset.reason) {
        await TW.api('/api/players/report', { method: 'POST', body: { targetId: id, reason: b.dataset.reason } });
        closeDrawers();
        toast('Report sent to our moderators', 'success');
      }
    } catch (err) {
      toast(err.message || 'Something went wrong', 'danger');
    } finally {
      if (b.isConnected) b.disabled = false;
    }
  }

  function wireSocket() {
    if (socket || (!TW.socket && !TW.connectSocket)) return;
    socket = TW.socket || TW.connectSocket();
    if (!socket) return;
    socket.on('discover:presence', (p) => {
      const i = st.items.findIndex((x) => x.id === p.id);
      if (i === -1 || !listEl) return;
      if (p.state === 'offline' && st.section !== 'suggested') { st.items.splice(i, 1); render(); return; }
      Object.assign(st.items[i], { state: p.state, mode: p.mode || null, joinLobbyId: p.joinLobbyId || null });
      const el = listEl.querySelector(`[data-id="${CSS.escape(p.id)}"]`);
      if (el) el.outerHTML = rowHtml(st.items[i]);
    });
    // Accepted: both players land in the same waiting room at once.
    socket.on('lobby:invite_accepted', (d) => {
      const matchId = (d && d.matchId) || (st.pending && st.pending.matchId);
      if (!matchId) return;
      toast(`${(d && d.username) || 'Your friend'} accepted. Taking you to the room`, 'success');
      setTimeout(() => { location.href = `/lobby.html?matchId=${encodeURIComponent(matchId)}`; }, 600);
    });
  }

  function open(trigger) {
    if (TW.isLoggedIn && !TW.isLoggedIn()) { location.href = '/?login=required'; return; }
    if (!root) build();
    lastTrigger = trigger || document.activeElement;
    st.open = true;
    root.hidden = false;
    root.classList.toggle('no-anim', REDUCED());
    requestAnimationFrame(() => root.classList.add('in'));
    syncTriggers();
    wireSocket();
    layout();
    if (!st.loadedOnce) load(true); else loadMyRoom();
    if (TW.SponsorSlots && !root.dataset.slotsScanned) { root.dataset.slotsScanned = '1'; TW.SponsorSlots.scan(root); }
    // The phone mode sheet and this sheet never stack.
    if (MOBILE() && TW.closeModeSheet && document.body.classList.contains('lb-sheet-open')) TW.closeModeSheet();
    root.querySelector('.dp-close').focus({ preventScroll: true });
  }

  function close() {
    if (!root || !st.open) return;
    st.open = false;
    root.classList.remove('in');
    root.hidden = true;
    layout();
    syncTriggers();
    if (lastTrigger && lastTrigger.focus && document.contains(lastTrigger)) lastTrigger.focus({ preventScroll: true });
  }

  function syncTriggers() {
    document.querySelectorAll('[data-discover-toggle]').forEach((t) => {
      t.setAttribute('aria-expanded', String(st.open));
      t.classList.toggle('active', st.open);
    });
  }

  TW.Discover = { open, close, toggle: (t) => (st.open ? close() : open(t)), isOpen: () => st.open, _state: st };

  // Any [data-discover-toggle] (nav button, tab) toggles the panel here.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-discover-toggle]');
    if (!t) return;
    e.preventDefault();
    TW.Discover.toggle(t);
  });
  window.addEventListener('resize', () => { if (st.open) layout(); });

  // The mode sheet opening on a phone hides this sheet (its state is kept).
  const wrapSheet = () => {
    if (!TW.openModeSheet || TW.openModeSheet._dp) return;
    const orig = TW.openModeSheet;
    // Portrait sheets can't share the bottom of the screen: the mode sheet
    // wins and Discover steps aside (state kept). In landscape both fit side by side.
    TW.openModeSheet = function () { if (MOBILE()) close(); return orig.apply(this, arguments); };
    TW.openModeSheet._dp = true;
  };
  const boot = () => {
    wrapSheet();
    if (new URLSearchParams(location.search).get('discover') === '1') open();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 0);
})();
