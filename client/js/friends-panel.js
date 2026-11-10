'use strict';

window.TW = window.TW || {};

// The Friends panel, opened from the icon in the header: your friends and what
// they're doing, players online now, username search, and requests. Also shows
// match invites from anywhere on the site.
//
// One click listener on the panel handles every button, so redrawing the list
// can't lose a click. The panel only closes from its close button, the dimmed
// area behind it, or Escape: it never guesses that a click was "outside".
TW.FriendsPanel = (function () {
  let friends = [];
  let incoming = [];
  let outgoing = [];
  let onlinePlayers = null; // null until the first load
  let onlineError = false;
  let searchResults = null;
  let searchError = false;
  let query = '';
  let searchSeq = 0;
  let searchTimer = null;
  let tab = 'friends';
  let isOpen = false;
  let offlineExpanded = false;
  let expandedRow = null; // "more" actions showing for this player id
  let confirming = null; // { kind: 'remove' | 'block' | 'host', id }
  let currentLobbyId = null;
  let friendsLoaded = false;
  let lastFocus = null;
  const activeInvites = new Map(); // inviteId -> { data, el, tickTimer }
  const busy = new Set(); // player ids with a request on its way

  const esc = (v) => TW.escapeHtml(String(v == null ? '' : v));
  const icon = (name, size = 18) => (TW.icon ? TW.icon(name, { size }) : '');
  const el = (id) => document.getElementById(id);
  const toast = (msg, type = 'info') => TW.toast && TW.toast(msg, type);
  const sound = (name) => TW.Sound && TW.Sound.play(name);

  function statusText(p) {
    if (p.status === 'online') return 'Online';
    if (p.status === 'in_lobby') return p.mode ? `In a lobby: ${p.mode}` : 'In a lobby';
    if (p.status === 'in_match') return p.mode ? `In a match: ${p.mode}` : 'In a match';
    if (p.status == null) return '';
    if (p.lastSeen && TW.timeAgo) return `Last seen ${TW.timeAgo(p.lastSeen)}`;
    return 'Offline';
  }
  const isReachable = (p) => p.status === 'online' || p.status === 'in_lobby';

  // ---- rows ------------------------------------------------------------------

  function button(act, id, label, opts = {}) {
    const name = opts.name ? ` data-name="${esc(opts.name)}"` : '';
    const extra = opts.value ? ` data-value="${esc(opts.value)}"` : '';
    const off = opts.disabled || busy.has(id) ? ' disabled' : '';
    const cls = opts.primary ? 'twf-btn primary' : opts.danger ? 'twf-btn danger' : 'twf-btn';
    return `<button type="button" class="${cls}" data-act="${act}" data-id="${esc(id)}"${name}${extra}${off}>${opts.icon ? icon(opts.icon, 16) : ''}<span>${esc(label)}</span></button>`;
  }

  function confirmHtml(p) {
    if (!confirming || confirming.id !== p.id) return '';
    const text = {
      remove: `Remove ${p.username} from your friends?`,
      block: `Block ${p.username}? You won't see each other here, and any friendship or request between you ends.`,
      host: `Start a private match and invite ${p.username}? Hosting costs you 1 coin when it starts. Guests play free.`,
    }[confirming.kind];
    const yes = { remove: 'Remove', block: 'Block', host: 'Start match' }[confirming.kind];
    return `
      <div class="twf-confirm" role="group" aria-label="Confirm">
        <p>${esc(text)}</p>
        <div class="twf-actions">
          ${button(`confirm-${confirming.kind}`, p.id, yes, { primary: confirming.kind === 'host', danger: confirming.kind !== 'host', name: p.username })}
          ${button('confirm-cancel', p.id, 'Cancel')}
        </div>
      </div>`;
  }

  function relationButtons(p) {
    if (p.relation === 'friend') return `<span class="twf-tag">Friends</span>`;
    if (p.relation === 'sent') return button('cancel', p.id, 'Cancel request', { value: p.requestId });
    if (p.relation === 'received') {
      return button('accept', p.id, 'Accept', { value: p.requestId, primary: true, icon: 'check', name: p.username }) +
        button('reject', p.id, 'Reject', { value: p.requestId });
    }
    if (p.acceptsFriendRequests === false) return `<span class="twf-tag">Not accepting requests</span>`;
    return button('add', p.id, 'Add friend', { primary: true, icon: 'userPlus', name: p.username });
  }

  function playActions(p) {
    if (p.relation === 'friend' && p.status === 'in_lobby') {
      return button('join', p.id, 'Join', { primary: true, icon: 'swords', name: p.username });
    }
    if (p.status === 'in_match' && p.matchId) return button('watch', p.id, 'Watch', { value: p.matchId, icon: 'eye' });
    if (isReachable(p) && p.acceptsInvites !== false) {
      return button('invite', p.id, 'Invite to play', { icon: 'swords', name: p.username, primary: p.relation === 'friend' });
    }
    return '';
  }

  function rowHtml(p, { showRelation = false, tag = '' } = {}) {
    const moreOpen = expandedRow === p.id;
    const avatar = TW.createAvatar ? TW.createAvatar({ ...p }, 'md') : '';
    const rating = p.warRating != null ? `${TW.TIER_ICON ? TW.TIER_ICON[p.tier] || '' : ''} ${esc(p.warRating)}` : '';
    const name = TW.renderUsername ? TW.renderUsername(p) : esc(p.username);
    const status = esc(statusText(p));
    const sub = [status, rating].filter(Boolean).join(' · ');
    return `
      <div class="twf-row" data-row="${esc(p.id)}">
        <div class="twf-who">
          <div class="twf-avatar">${avatar}${p.status ? `<span class="twf-dot ${esc(p.status)}" aria-hidden="true"></span>` : ''}</div>
          <div class="twf-text">
            <div class="twf-name">${name}${tag ? ` <span class="twf-tag near">${esc(tag)}</span>` : ''}</div>
            <div class="twf-sub">${sub}</div>
          </div>
          <button type="button" class="twf-more" data-act="more" data-id="${esc(p.id)}" aria-label="More for ${esc(p.username)}" aria-expanded="${moreOpen}">${icon('moreHorizontal', 18)}</button>
        </div>
        <div class="twf-actions">${playActions(p)}${showRelation ? relationButtons(p) : ''}</div>
        ${moreOpen ? `
          <div class="twf-actions twf-more-row">
            <a class="twf-btn" href="/profile/${encodeURIComponent(p.username)}">${icon('user', 16)}<span>Profile</span></a>
            ${p.relation === 'friend' ? button('ask-remove', p.id, 'Remove friend', { name: p.username }) : ''}
            ${button('ask-block', p.id, 'Block', { name: p.username, danger: true })}
          </div>` : ''}
        ${confirmHtml(p)}
      </div>`;
  }

  const label = (text) => `<div class="twf-label">${esc(text)}</div>`;
  const empty = (text, actionHtml = '') => `<div class="twf-empty"><p>${esc(text)}</p>${actionHtml}</div>`;

  // ---- tabs ------------------------------------------------------------------

  function friendsTabHtml() {
    if (!friendsLoaded) return `<div class="twf-empty"><p>Loading…</p></div>`;
    if (!friends.length) {
      return empty('No friends yet. Find someone to play with.', button('go-find', 'find', 'Find players', { primary: true, icon: 'search' }));
    }
    const asFriend = (f) => ({ ...f, relation: 'friend' });
    const online = friends.filter(isReachable).map(asFriend);
    const inMatch = friends.filter((f) => f.status === 'in_match').map(asFriend);
    const offline = friends.filter((f) => f.status === 'offline').map(asFriend);
    let html = label(`Online (${online.length})`);
    html += online.length ? online.map((f) => rowHtml(f)).join('') : `<div class="twf-none">No friends online right now.</div>`;
    if (inMatch.length) html += label(`In a match (${inMatch.length})`) + inMatch.map((f) => rowHtml(f)).join('');
    html += `<button type="button" class="twf-label twf-toggle" data-act="toggle-offline" aria-expanded="${offlineExpanded}">Offline (${offline.length})${icon(offlineExpanded ? 'chevronUp' : 'chevronDown', 16)}</button>`;
    if (offlineExpanded) html += offline.length ? offline.map((f) => rowHtml(f)).join('') : `<div class="twf-none">Nobody offline.</div>`;
    return html;
  }

  function findTabHtml() {
    if (query.length >= 2) {
      if (searchError) return empty('Search failed. Check your connection and try again.');
      if (searchResults === null) return `<div class="twf-empty"><p>Searching…</p></div>`;
      if (!searchResults.length) return empty(`Nobody found for "${query}".`);
      return label('Results') + searchResults.map((p) => rowHtml(p, { showRelation: true })).join('');
    }
    if (query.length === 1) return `<div class="twf-none">Keep typing: at least 2 letters.</div>`;
    if (onlineError) return empty('Could not load players.', button('retry-online', 'online', 'Try again'));
    if (onlinePlayers === null) return `<div class="twf-empty"><p>Loading…</p></div>`;
    if (!onlinePlayers.length) {
      return label('Online now') + empty('Nobody else is online right now. Search for a username above, or bring a friend.', `<a class="twf-btn primary" href="/wallet">${icon('userPlus', 16)}<span>Get my invite link</span></a>`);
    }
    return label('Online now, closest to you first') +
      onlinePlayers.map((p) => rowHtml(p, { showRelation: true, tag: p.sameCountry ? 'Near you' : '' })).join('');
  }

  function requestsTabHtml() {
    const person = (r) => ({ id: r.playerId, username: r.username, tier: r.tier, warRating: r.warRating, avatarUrl: r.avatarUrl, requestId: r.requestId });
    let html = label(`Waiting for you (${incoming.length})`);
    html += incoming.length
      ? incoming.map((r) => rowHtml({ ...person(r), relation: 'received', status: null }, { showRelation: true })).join('')
      : `<div class="twf-none">No requests right now.</div>`;
    if (outgoing.length) {
      html += label(`Sent (${outgoing.length})`);
      html += outgoing.map((r) => rowHtml({ ...person(r), relation: 'sent', status: null }, { showRelation: true })).join('');
    }
    return html;
  }

  function render() {
    syncButton();
    const body = el('twfBody');
    if (!body) return;
    const counts = { friends: friends.filter((f) => f.status !== 'offline').length, requests: incoming.length };
    document.querySelectorAll('#twFriendsPanel [data-tab]').forEach((t) => {
      const on = t.dataset.tab === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
      const c = t.querySelector('.twf-count');
      if (c) {
        const n = counts[t.dataset.tab] || 0;
        c.textContent = n;
        c.hidden = n === 0;
      }
    });
    el('twfSearchWrap').hidden = tab !== 'find';
    const top = body.scrollTop;
    body.innerHTML = tab === 'friends' ? friendsTabHtml() : tab === 'find' ? findTabHtml() : requestsTabHtml();
    body.scrollTop = top;
  }

  function syncButton() {
    const btn = el('twFriendsToggleBtn');
    if (!btn) return;
    btn.classList.remove('hidden');
    btn.setAttribute('aria-expanded', String(isOpen));
    const onlineCount = friends.filter((f) => f.status !== 'offline').length;
    const badge = el('twFriendsOnlineBadge');
    const parts = [];
    if (incoming.length) parts.push(`${incoming.length} friend ${incoming.length === 1 ? 'request' : 'requests'}`);
    if (onlineCount) parts.push(`${onlineCount} online`);
    btn.setAttribute('aria-label', parts.length ? `Friends, ${parts.join(', ')}` : 'Friends');
    if (!badge) return;
    // Requests matter most, so they take the badge and turn it red.
    const n = incoming.length || onlineCount;
    badge.textContent = n > 99 ? '99+' : n;
    badge.classList.toggle('hidden', n === 0);
    badge.classList.toggle('alert', incoming.length > 0);
  }

  // ---- data ------------------------------------------------------------------

  async function loadFriends() {
    try {
      const data = await TW.api('/api/friends');
      friends = data.friends;
      friendsLoaded = true;
      safeRender();
    } catch (e) {
      // Stays as it was until the next refresh.
    }
  }

  async function loadRequests() {
    try {
      const data = await TW.api('/api/friends/requests');
      incoming = data.incoming;
      outgoing = data.outgoing;
      safeRender();
    } catch (e) {
      // Stays as it was until the next refresh.
    }
  }

  async function loadOnline() {
    try {
      const data = await TW.api('/api/players/online');
      onlinePlayers = data.players;
      onlineError = false;
    } catch (e) {
      onlineError = onlinePlayers === null;
    }
    if (isOpen && tab === 'find' && query.length < 2) safeRender();
  }

  // Background refreshes mustn't fold away a row someone is using.
  function safeRender() {
    if (isOpen && (expandedRow || confirming)) syncButton();
    else render();
  }

  async function runSearch() {
    const mine = ++searchSeq;
    searchError = false;
    try {
      const data = await TW.api(`/api/players/search?q=${encodeURIComponent(query)}`);
      if (mine !== searchSeq) return; // a newer search is on its way
      searchResults = data.players;
    } catch (e) {
      if (mine !== searchSeq) return;
      searchResults = null;
      searchError = true;
    }
    render();
  }

  // After a friend request changes, every list that shows that player updates.
  function patchPlayer(id, patch) {
    const fix = (p) => (p.id === id ? { ...p, ...patch } : p);
    if (onlinePlayers) onlinePlayers = onlinePlayers.map(fix);
    if (searchResults) searchResults = searchResults.map(fix);
  }
  function removeEverywhere(id) {
    friends = friends.filter((f) => f.id !== id);
    incoming = incoming.filter((r) => r.playerId !== id);
    outgoing = outgoing.filter((r) => r.playerId !== id);
    if (onlinePlayers) onlinePlayers = onlinePlayers.filter((p) => p.id !== id);
    if (searchResults) searchResults = searchResults.filter((p) => p.id !== id);
  }

  // ---- inviting --------------------------------------------------------------

  const SKIP_TEXT = {
    offline: (n) => `${n} isn't online right now`,
    busy: (n) => `${n} is in a match right now`,
    not_accepting: (n) => `${n} isn't accepting invites`,
    already_invited: (n) => `You already invited ${n}`,
    too_many: () => 'You have sent a lot of invites. Try again in a few minutes.',
  };

  async function sendInvite(targetIds, name) {
    if (!currentLobbyId) {
      toast('You need to be in a lobby to invite players', 'warning');
      return false;
    }
    const result = await TW.emitAck('lobby:invite', { targetIds, matchId: currentLobbyId });
    if (!result.success) {
      toast(result.error || 'Could not send invite', 'danger');
      return false;
    }
    const sent = (result.sentTo || []).length;
    if (sent) toast(`Invite sent${name ? ` to ${name}` : ` to ${sent} ${sent === 1 ? 'player' : 'players'}`}`, 'info');
    (result.skipped || []).forEach((s) => {
      const text = SKIP_TEXT[s.reason];
      toast(text ? text(name || 'That player') : 'Could not invite that player', 'warning');
    });
    return sent > 0;
  }

  async function connectedSocket() {
    const socket = TW.connectSocket && TW.connectSocket();
    if (socket && !socket.connected) {
      await new Promise((resolve) => {
        socket.once('connect', resolve);
        setTimeout(resolve, 5000);
      });
    }
    return socket;
  }

  // Not in a lobby yet: make a private one, invite them, then go to it.
  async function hostAndInvite(id, name) {
    const created = await TW.api('/api/match/create', { method: 'POST', body: { mode: 'private' } });
    await connectedSocket();
    const joined = await TW.emitAck('player:join', { matchId: created.matchId });
    if (!joined.success) throw new Error(joined.error || 'Could not open the lobby');
    currentLobbyId = created.matchId;
    await sendInvite([id], name);
    window.location.href = `/lobby.html?matchId=${created.matchId}`;
  }

  // ---- buttons ---------------------------------------------------------------

  async function withBusy(id, work) {
    busy.add(id);
    render();
    try {
      await work();
    } catch (e) {
      toast(e.message || 'Something went wrong', 'danger');
    } finally {
      busy.delete(id);
      render();
    }
  }

  const ACTIONS = {
    more(id) {
      expandedRow = expandedRow === id ? null : id;
      confirming = null;
      render();
    },
    'toggle-offline'() {
      offlineExpanded = !offlineExpanded;
      render();
    },
    'go-find'() {
      setTab('find');
    },
    'retry-online'() {
      onlineError = false;
      onlinePlayers = null;
      render();
      loadOnline();
    },
    add(id, btn) {
      return withBusy(id, async () => {
        const r = await TW.api('/api/friends/request', { method: 'POST', body: { targetId: id } });
        patchPlayer(id, { relation: 'sent', requestId: r.requestId });
        toast(`Friend request sent to ${btn.dataset.name}`, 'info');
        loadRequests();
      });
    },
    cancel(id, btn) {
      return withBusy(id, async () => {
        await TW.api(`/api/friends/requests/${encodeURIComponent(btn.dataset.value)}`, { method: 'DELETE' });
        patchPlayer(id, { relation: 'none', requestId: null });
        outgoing = outgoing.filter((r) => r.playerId !== id);
      });
    },
    accept(id, btn) {
      return withBusy(id, async () => {
        await TW.api(`/api/friends/${encodeURIComponent(btn.dataset.value)}/accept`, { method: 'POST' });
        patchPlayer(id, { relation: 'friend', requestId: null });
        incoming = incoming.filter((r) => r.playerId !== id);
        toast(`You and ${btn.dataset.name} are now friends`, 'info');
        sound('success');
        loadFriends();
      });
    },
    reject(id, btn) {
      return withBusy(id, async () => {
        await TW.api(`/api/friends/${encodeURIComponent(btn.dataset.value)}/decline`, { method: 'POST' });
        patchPlayer(id, { relation: 'none', requestId: null });
        incoming = incoming.filter((r) => r.playerId !== id);
      });
    },
    invite(id, btn) {
      if (currentLobbyId) return withBusy(id, () => sendInvite([id], btn.dataset.name));
      confirming = { kind: 'host', id };
      render();
      return undefined;
    },
    'confirm-host'(id, btn) {
      confirming = null;
      return withBusy(id, () => hostAndInvite(id, btn.dataset.name));
    },
    join(id) {
      return withBusy(id, async () => {
        const r = await TW.api(`/api/friends/${encodeURIComponent(id)}/join`, { method: 'POST' });
        window.location.href = `/lobby.html?matchId=${encodeURIComponent(r.matchId)}`;
      });
    },
    watch(id, btn) {
      window.location.href = `/spectate.html?matchId=${encodeURIComponent(btn.dataset.value)}`;
    },
    'ask-remove'(id) {
      confirming = { kind: 'remove', id };
      render();
    },
    'ask-block'(id) {
      confirming = { kind: 'block', id };
      render();
    },
    'confirm-cancel'() {
      confirming = null;
      render();
    },
    'confirm-remove'(id, btn) {
      confirming = null;
      expandedRow = null;
      return withBusy(id, async () => {
        await TW.api(`/api/friends/${encodeURIComponent(id)}`, { method: 'DELETE' });
        friends = friends.filter((f) => f.id !== id);
        patchPlayer(id, { relation: 'none', requestId: null });
        toast(`${btn.dataset.name} removed`, 'info');
      });
    },
    'confirm-block'(id, btn) {
      confirming = null;
      expandedRow = null;
      return withBusy(id, async () => {
        await TW.api('/api/friends/block', { method: 'POST', body: { targetId: id } });
        removeEverywhere(id);
        toast(`${btn.dataset.name} blocked. You can undo this in Settings.`, 'info');
      });
    },
  };

  // ---- open and close --------------------------------------------------------

  function setTab(next) {
    tab = next;
    expandedRow = null;
    confirming = null;
    render();
    if (next === 'find') {
      loadOnline();
      el('twfSearch')?.focus();
    }
    if (next === 'requests') loadRequests();
    if (next === 'friends') loadFriends();
  }

  function open(nextTab) {
    if (!el('twFriendsPanel')) return;
    lastFocus = document.activeElement;
    isOpen = true;
    el('twFriendsPanel').hidden = false;
    el('twfBackdrop').hidden = false;
    // A frame later, so the slide-in plays.
    requestAnimationFrame(() => document.documentElement.classList.add('twf-open'));
    const wanted = nextTab || (incoming.length ? 'requests' : tab);
    el('twfClose').focus();
    setTab(wanted);
    syncButton();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    expandedRow = null;
    confirming = null;
    document.documentElement.classList.remove('twf-open');
    el('twfBackdrop').hidden = true;
    const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => { if (!isOpen) el('twFriendsPanel').hidden = true; }, reduced ? 0 : 240);
    syncButton();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function onKeydown(e) {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...el('twFriendsPanel').querySelectorAll('a[href],button:not([disabled]),input')].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function injectPanel() {
    if (el('twFriendsPanel')) return;
    const backdrop = document.createElement('div');
    backdrop.id = 'twfBackdrop';
    backdrop.className = 'twf-backdrop';
    backdrop.hidden = true;
    backdrop.addEventListener('click', close);
    document.body.appendChild(backdrop);

    const panel = document.createElement('aside');
    panel.id = 'twFriendsPanel';
    panel.className = 'twf-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Friends');
    panel.innerHTML = `
      <header class="twf-head">
        <h2>Friends</h2>
        <a class="twf-discover" href="/discover" title="Players live now, suggestions and open lobbies">${icon('users', 16)}<span>Discover</span></a>
        <button type="button" class="twf-close" id="twfClose" aria-label="Close friends">${icon('close', 20)}</button>
      </header>
      <div class="twf-tabs" role="tablist">
        <button type="button" role="tab" data-tab="friends">Friends <span class="twf-count" hidden></span></button>
        <button type="button" role="tab" data-tab="find">Find players</button>
        <button type="button" role="tab" data-tab="requests">Requests <span class="twf-count alert" hidden></span></button>
      </div>
      <div class="twf-search" id="twfSearchWrap" hidden>
        ${icon('search', 18)}
        <input type="search" id="twfSearch" placeholder="Search by username" aria-label="Search by username" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="30" />
      </div>
      <div class="twf-body" id="twfBody"></div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#twfClose').addEventListener('click', close);
    panel.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) {
        setTab(tabBtn.dataset.tab);
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      const action = ACTIONS[btn.dataset.act];
      if (action) action(btn.dataset.id, btn);
    });
    panel.querySelector('#twfSearch').addEventListener('input', (e) => {
      query = e.target.value.trim();
      clearTimeout(searchTimer);
      searchSeq++;
      searchResults = null;
      searchError = false;
      expandedRow = null;
      confirming = null;
      render();
      if (query.length >= 2) searchTimer = setTimeout(runSearch, 250);
    });
  }

  // ---- match invite pop-ups --------------------------------------------------

  function ensureInviteStack() {
    let stack = el('twInviteStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'twInviteStack';
      stack.className = 'twf-invites';
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    return stack;
  }

  function showInvitePopup(invite) {
    if (activeInvites.has(invite.id)) return;
    if (activeInvites.size >= 3) dismissInvite(activeInvites.keys().next().value);
    const box = document.createElement('div');
    box.className = 'twf-invite';
    const fee = invite.entryCoins > 0 ? `Entry: ${invite.entryCoins} coins, paid if you accept` : 'Free to join';
    box.innerHTML = `
      <div class="twf-invite-title">${icon('swords', 16)}<span>Match invite</span></div>
      <p class="twf-invite-text"><strong>${esc(invite.fromUsername)}</strong>${invite.fromFriend ? '' : ' <span class="twf-tag">Not a friend</span>'} invited you to ${esc(invite.matchMode)}.</p>
      <p class="twf-invite-sub">${esc(fee)} · ${esc(invite.currentPlayers)}${invite.maxPlayers ? `/${esc(invite.maxPlayers)}` : ''} players</p>
      <div class="twf-invite-bar"><span></span></div>
      <div class="twf-actions">
        <button type="button" class="twf-btn primary" data-inv="accept">${icon('check', 16)}<span>Accept</span></button>
        <button type="button" class="twf-btn" data-inv="decline">Decline</button>
        ${invite.fromFriend ? '' : `<button type="button" class="twf-btn danger" data-inv="block">Block</button>`}
      </div>`;
    ensureInviteStack().appendChild(box);
    sound('card_play');

    const total = Math.max(1, invite.expiresAt - Date.now());
    const bar = box.querySelector('.twf-invite-bar span');
    const tickTimer = setInterval(() => {
      const left = invite.expiresAt - Date.now();
      bar.style.transform = `scaleX(${Math.max(0, left / total)})`;
      if (left <= 0) dismissInvite(invite.id);
    }, 250);
    activeInvites.set(invite.id, { data: invite, el: box, tickTimer });

    box.addEventListener('click', async (e) => {
      const which = e.target.closest('[data-inv]')?.dataset.inv;
      if (!which) return;
      box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      if (which === 'accept') {
        const result = await TW.emitAck('lobby:invite_accept', { inviteId: invite.id });
        dismissInvite(invite.id);
        if (result.success) window.location.href = `/lobby.html?matchId=${encodeURIComponent(result.matchId)}`;
        else toast(result.error || 'Could not accept invite', 'danger');
        return;
      }
      TW.emitAck('lobby:invite_decline', { inviteId: invite.id });
      dismissInvite(invite.id);
      if (which === 'block') {
        try {
          await TW.api('/api/friends/block', { method: 'POST', body: { targetId: invite.fromPlayerId } });
          removeEverywhere(invite.fromPlayerId);
          toast(`${invite.fromUsername} blocked. You can undo this in Settings.`, 'info');
          render();
        } catch (err) {
          toast(err.message || 'Could not block player', 'danger');
        }
      }
    });
  }

  function dismissInvite(inviteId) {
    const entry = activeInvites.get(inviteId);
    if (!entry) return;
    clearInterval(entry.tickTimer);
    entry.el.remove();
    activeInvites.delete(inviteId);
  }

  // ---- start up --------------------------------------------------------------

  function applyPresenceUpdate(payload) {
    const i = friends.findIndex((f) => f.id === payload.playerId);
    if (i === -1) return;
    friends[i] = { ...friends[i], status: payload.status, matchId: payload.matchId, lobbyId: payload.lobbyId, mode: payload.mode, lastSeen: Date.now() };
    safeRender();
  }

  function wireSocketEvents() {
    const socket = TW.connectSocket ? TW.connectSocket() : null;
    if (!socket) return;
    socket.on('friend:status_update', applyPresenceUpdate);
    socket.on('friend:accepted', (d) => {
      loadFriends();
      loadRequests();
      if (d && d.playerId) patchPlayer(d.playerId, { relation: 'friend', requestId: null });
      if (d && d.username) toast(`${d.username} accepted your friend request`, 'info');
      sound('success');
    });
    socket.on('friend:request_received', (d) => {
      loadRequests();
      toast(`${d && d.username ? d.username : 'Someone'} sent you a friend request`, 'info');
      sound('friendRequest');
    });
    socket.on('lobby:invite_received', showInvitePopup);
    socket.on('lobby:invite_expired', (d) => dismissInvite(d.inviteId));
  }

  let started = false;
  function init() {
    if (started || !window.TW || !TW.getToken || !TW.getToken()) return;
    started = true;
    // Here rather than in each page, so invites look right on every page that loads this.
    if (!document.querySelector('link[href="/css/friends.css"]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/css/friends.css';
      document.head.appendChild(css);
    }
    injectPanel();
    // On the document, so it still works if the header is ever redrawn.
    document.addEventListener('click', (e) => {
      if (!e.target.closest || !e.target.closest('#twFriendsToggleBtn')) return;
      if (isOpen) close();
      else open();
    });
    document.addEventListener('keydown', onKeydown);
    syncButton();
    wireSocketEvents();
    loadFriends();
    loadRequests();
    setInterval(() => {
      loadFriends();
      loadRequests();
    }, 60000);
    setInterval(() => {
      if (isOpen && tab === 'find') loadOnline();
    }, 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    open,
    close,
    setCurrentLobby: (lobbyId) => { currentLobbyId = lobbyId; },
    getOnlineFriends: () => friends.filter((f) => f.status !== 'offline'),
    getAllFriends: () => friends.slice(),
    refresh: () => Promise.all([loadFriends(), loadRequests()]),
    sendInvite,
  };
})();
