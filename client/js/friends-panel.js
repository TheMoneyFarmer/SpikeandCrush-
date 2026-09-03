'use strict';

window.TW = window.TW || {};

// Persistent, COD-style friends panel + invite popup system (Block 12).
// Included on every authenticated page; self-injects its own DOM rather than
// requiring each page to carry a placeholder div.
TW.FriendsPanel = (function () {
  let friends = [];
  let currentLobbyId = null;
  let collapsed = false;
  let offlineExpanded = false;
  const activeInvites = new Map(); // inviteId -> { data, expiresAt, el, tickTimer }

  function avatarColor(seed) {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    const hue = hash % 360;
    return `hsl(${hue}, 65%, 45%)`;
  }

  function timeAgo(ms) {
    if (!ms) return 'a while ago';
    const diff = Date.now() - ms;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function statusText(f) {
    if (f.status === 'online') return 'Online — Trading Floor';
    if (f.status === 'in_lobby') return `In Lobby: ${f.mode || 'War'}`;
    if (f.status === 'in_match') return `In Match: ${f.mode || 'War'}`;
    return `Last seen ${timeAgo(f.lastSeen)}`;
  }

  function friendCardHtml(f) {
    const canJoin = f.status === 'in_lobby';
    const canInvite = f.status === 'online' && currentLobbyId;
    const canSpectate = f.status === 'in_match';
    let actionsHtml = `<button class="tw-view-profile-btn" data-username="${TW.escapeHtml(f.username)}">👤 Profile</button>`;
    if (canJoin) actionsHtml = `<button class="primary tw-join-friend-btn" data-lobby="${f.lobbyId}">Join</button>` + actionsHtml;
    else if (canInvite) actionsHtml = `<button class="primary tw-invite-friend-btn" data-id="${f.id}">Invite</button>` + actionsHtml;
    else if (canSpectate) actionsHtml = `<button class="primary tw-spectate-friend-btn" data-match="${f.matchId}">Spectate</button>` + actionsHtml;

    return `
      <div class="tw-friend-card" data-friend-id="${f.id}">
        <div class="tw-friend-card-top">
          <div class="tw-friend-avatar" style="background:transparent;">
            ${TW.createAvatar(f, 'sm')}
            <span class="tw-friend-status-dot ${f.status}"></span>
          </div>
          <div>
            <div class="tw-friend-name">${TW.renderUsername(f)}</div>
            <div class="tw-friend-meta">${TW.TIER_ICON[f.tier] || '🔰'} ${f.warRating}</div>
          </div>
        </div>
        <div class="tw-friend-status-text">${statusText(f)}</div>
        <div class="tw-friend-actions">${actionsHtml}</div>
      </div>
    `;
  }

  function render() {
    const body = document.getElementById('twFriendsPanelBody');
    if (!body) return;
    const online = friends.filter((f) => f.status === 'online' || f.status === 'in_lobby');
    const inMatch = friends.filter((f) => f.status === 'in_match');
    const offline = friends.filter((f) => f.status === 'offline');

    let html = '';
    html += `<div class="tw-friends-section-label">Online Now (${online.length})</div>`;
    html += online.length ? online.map(friendCardHtml).join('') : '<div class="tw-friends-empty">No friends online right now.</div>';

    if (inMatch.length) {
      html += `<div class="tw-friends-section-label">In A Match (${inMatch.length})</div>`;
      html += inMatch.map(friendCardHtml).join('');
    }

    html += `<div class="tw-friends-section-label collapsible" id="twOfflineToggle">Offline (${offline.length}) ${offlineExpanded ? '▲' : '▼'}</div>`;
    if (offlineExpanded) {
      html += offline.length ? offline.map(friendCardHtml).join('') : '<div class="tw-friends-empty">No offline friends.</div>';
    }

    body.innerHTML = html;
    wireCardActions(body);
    document.getElementById('twOfflineToggle')?.addEventListener('click', () => {
      offlineExpanded = !offlineExpanded;
      render();
    });
  }

  function wireCardActions(root) {
    root.querySelectorAll('.tw-view-profile-btn').forEach((btn) => {
      btn.addEventListener('click', () => { window.location.href = `/profile/${encodeURIComponent(btn.dataset.username)}`; });
    });
    root.querySelectorAll('.tw-spectate-friend-btn').forEach((btn) => {
      btn.addEventListener('click', () => { window.location.href = `/spectate.html?matchId=${btn.dataset.match}`; });
    });
    root.querySelectorAll('.tw-join-friend-btn').forEach((btn) => {
      btn.addEventListener('click', () => { window.location.href = `/lobby.html?matchId=${btn.dataset.lobby}`; });
    });
    root.querySelectorAll('.tw-invite-friend-btn').forEach((btn) => {
      btn.addEventListener('click', () => sendInvite([btn.dataset.id]));
    });
  }

  async function sendInvite(targetIds) {
    if (!currentLobbyId) {
      TW.toast('You need to be in a lobby to invite friends', 'warning');
      return;
    }
    const result = await TW.emitAck('lobby:invite', { targetIds, matchId: currentLobbyId });
    if (result.success) TW.toast(`Invite sent to ${result.sentTo.length} friend${result.sentTo.length === 1 ? '' : 's'}`, 'info');
    else TW.toast(result.error || 'Could not send invite', 'danger');
  }

  async function loadFriends() {
    try {
      const data = await TW.api('/api/friends');
      friends = data.friends;
      render();
      updateToggleBadge();
    } catch (e) {
      // Not fatal - panel just stays empty until the next refresh.
    }
  }

  function updateToggleBadge() {
    const badge = document.getElementById('twFriendsOnlineBadge');
    if (!badge) return;
    const onlineCount = friends.filter((f) => f.status !== 'offline').length;
    badge.textContent = onlineCount;
    badge.classList.toggle('hidden', onlineCount === 0);
    const toggleBtn = document.getElementById('twFriendsToggleBtn');
    if (toggleBtn) toggleBtn.title = `Friends (${onlineCount})`;
  }

  let outsideClickHandler = null;

  function setCollapsed(next) {
    collapsed = next;
    document.getElementById('twFriendsPanel')?.classList.toggle('collapsed', collapsed);
    try {
      localStorage.setItem('tw_friends_panel_collapsed', collapsed ? '1' : '0');
    } catch (e) {}

    // A tray, not a layout column: open state gets a click-outside-to-close
    // backdrop (same idea as the hamburger drawer) instead of ever shifting
    // or resizing page content.
    const existingBackdrop = document.getElementById('twFriendsPanelBackdrop');
    if (!collapsed && !existingBackdrop) {
      const backdrop = document.createElement('div');
      backdrop.id = 'twFriendsPanelBackdrop';
      backdrop.className = 'tw-friends-panel-backdrop';
      document.body.appendChild(backdrop);
      outsideClickHandler = (e) => {
        const panel = document.getElementById('twFriendsPanel');
        const toggleBtn = document.getElementById('twFriendsToggleBtn');
        if (panel && !panel.contains(e.target) && e.target !== toggleBtn && !toggleBtn?.contains(e.target)) {
          setCollapsed(true);
        }
      };
      setTimeout(() => document.addEventListener('click', outsideClickHandler), 0);
    } else if (collapsed && existingBackdrop) {
      existingBackdrop.remove();
      if (outsideClickHandler) {
        document.removeEventListener('click', outsideClickHandler);
        outsideClickHandler = null;
      }
    }
  }

  function applyPresenceUpdate(payload) {
    const idx = friends.findIndex((f) => f.id === payload.playerId);
    if (idx === -1) return; // not a friend we're tracking (or list not loaded yet)
    friends[idx] = { ...friends[idx], status: payload.status, matchId: payload.matchId, lobbyId: payload.lobbyId, mode: payload.mode, lastSeen: Date.now() };
    render();
    updateToggleBadge();
  }

  // ---- add friend search modal ------------------------------------------------

  function openSearchModal() {
    const backdrop = document.createElement('div');
    backdrop.className = 'tw-search-modal-backdrop';
    backdrop.innerHTML = `
      <div class="tw-search-modal">
        <h3 style="margin-top:0;">Add Friend</h3>
        <input type="text" id="twFriendSearchInput" placeholder="Search by username..." autocomplete="off" />
        <div class="tw-search-results" id="twFriendSearchResults"></div>
        <button class="btn" id="twSearchCloseBtn" style="margin-top:12px;">Close</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    backdrop.querySelector('#twSearchCloseBtn').addEventListener('click', () => backdrop.remove());

    const input = backdrop.querySelector('#twFriendSearchInput');
    const results = backdrop.querySelector('#twFriendSearchResults');
    let debounceTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const q = input.value.trim();
      if (q.length < 2) {
        results.innerHTML = '';
        return;
      }
      debounceTimer = setTimeout(async () => {
        try {
          const data = await TW.api(`/api/players/search?q=${encodeURIComponent(q)}`);
          results.innerHTML = data.players.length
            ? data.players
                .map(
                  (p) => `
                    <div class="tw-search-result-row">
                      ${TW.createAvatar(p, 'sm')}
                      <div style="flex:1;">
                        <div style="font-weight:700;font-size:13px;">${TW.renderUsername(p)}</div>
                        <div style="font-size:11px;color:var(--text-secondary);">${TW.TIER_ICON[p.tier] || '🔰'} ${p.warRating}</div>
                      </div>
                      <button class="btn btn-primary" data-add="${p.id}" style="padding:6px 12px;font-size:12px;">Add</button>
                    </div>
                  `
                )
                .join('')
            : '<div class="tw-friends-empty">No players found.</div>';
          results.querySelectorAll('[data-add]').forEach((btn) => {
            btn.addEventListener('click', async () => {
              try {
                await TW.api('/api/friends/request', { method: 'POST', body: { targetId: btn.dataset.add } });
                btn.textContent = 'Sent';
                btn.disabled = true;
              } catch (e) {
                TW.toast(e.message, 'danger');
              }
            });
          });
        } catch (e) {
          results.innerHTML = `<div class="tw-friends-empty">${TW.escapeHtml(e.message)}</div>`;
        }
      }, 300);
    });
    input.focus();
  }

  // ---- battle invite popups (COD style) ----------------------------------------

  function ensureInviteStack() {
    let stack = document.getElementById('twInviteStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'twInviteStack';
      stack.className = 'tw-invite-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function showInvitePopup(invite) {
    if (activeInvites.size >= 3) {
      // Oldest (bottom of stack, since newest renders on top) gets dropped
      // silently rather than growing unbounded - matches "max 3 visible".
      const oldestId = activeInvites.keys().next().value;
      dismissInvite(oldestId, 'declining');
    }
    const stack = ensureInviteStack();
    const el = document.createElement('div');
    el.className = 'tw-invite-popup';
    const extraCount = Math.max(0, (invite.instruments || []).length - 3);
    const instrumentsLabel = (invite.instruments || []).slice(0, 3).join(' · ') + (extraCount > 0 ? ` + ${extraCount} more instruments` : '');
    el.innerHTML = `
      <div class="tw-invite-title">⚔️ BATTLE INVITE</div>
      <div class="tw-invite-body">
        <div class="tw-friend-avatar" style="background:${avatarColor(invite.fromUsername)};">${invite.fromUsername[0].toUpperCase()}</div>
        <div>
          <div class="name">${TW.escapeHtml(invite.fromUsername)} <span style="font-weight:400;color:var(--text-secondary);">(${TW.escapeHtml(invite.fromTier)})</span></div>
          <div class="sub">invites you to ${TW.escapeHtml(invite.matchMode)}</div>
          <div class="sub">${TW.escapeHtml(instrumentsLabel)}</div>
          <div class="sub">${invite.currentPlayers}/${invite.maxPlayers} players · Lobby open</div>
        </div>
      </div>
      <div class="tw-invite-progress-wrap"><div class="tw-invite-progress-bar" id="bar-${invite.id}" style="width:100%;"></div></div>
      <div class="tw-invite-expiry-label" id="label-${invite.id}">expires in 60s</div>
      <div class="tw-invite-actions">
        <button class="accept" id="accept-${invite.id}">✓ ACCEPT</button>
        <button class="decline" id="decline-${invite.id}">✗ DECLINE</button>
      </div>
    `;
    stack.appendChild(el);
    // Spec asks for impact-1.wav specifically - that's the file behind the
    // existing card_play effect (see sound.js's sabotage_play mapping).
    if (TW.Sound) TW.Sound.play('card_play');

    const totalMs = invite.expiresAt - Date.now();
    const tickTimer = setInterval(() => {
      const remaining = Math.max(0, invite.expiresAt - Date.now());
      const pct = Math.max(0, (remaining / totalMs) * 100);
      const bar = document.getElementById(`bar-${invite.id}`);
      const label = document.getElementById(`label-${invite.id}`);
      if (bar) bar.style.width = `${pct}%`;
      if (label) label.textContent = `expires in ${Math.ceil(remaining / 1000)}s`;
      if (remaining <= 0) {
        clearInterval(tickTimer);
        dismissInvite(invite.id, 'declining');
      }
    }, 500);

    activeInvites.set(invite.id, { data: invite, el, tickTimer });

    document.getElementById(`accept-${invite.id}`).addEventListener('click', async () => {
      const result = await TW.emitAck('lobby:invite_accept', { inviteId: invite.id });
      if (result.success) {
        dismissInvite(invite.id, 'accepting');
        setTimeout(() => { window.location.href = `/lobby.html?matchId=${result.matchId}`; }, 350);
      } else {
        TW.toast(result.error || 'Could not accept invite', 'danger');
        dismissInvite(invite.id, 'declining');
      }
    });
    document.getElementById(`decline-${invite.id}`).addEventListener('click', () => {
      TW.emitAck('lobby:invite_decline', { inviteId: invite.id });
      dismissInvite(invite.id, 'declining');
    });
  }

  function dismissInvite(inviteId, animationClass) {
    const entry = activeInvites.get(inviteId);
    if (!entry) return;
    clearInterval(entry.tickTimer);
    entry.el.classList.add(animationClass);
    setTimeout(() => entry.el.remove(), 400);
    activeInvites.delete(inviteId);
  }

  // ---- panel shell + wiring -----------------------------------------------------

  function injectPanel() {
    if (document.getElementById('twFriendsPanel')) return;
    // Closed by default everywhere - it's a tray you open on demand (via the
    // Friends button), not a permanent layout column. Only reopens
    // automatically if the user themselves left it open last time.
    try {
      collapsed = localStorage.getItem('tw_friends_panel_collapsed') !== '0';
    } catch (e) {
      collapsed = true;
    }
    const panel = document.createElement('div');
    panel.id = 'twFriendsPanel';
    panel.className = `tw-friends-panel${collapsed ? ' collapsed' : ''}`;
    panel.innerHTML = `
      <div class="tw-friends-panel-header">
        <h3>Friends</h3>
        <button class="btn btn-outline" id="twAddFriendBtn" style="padding:4px 10px;font-size:11px;">+ Add Friend</button>
      </div>
      <div class="tw-friends-panel-body" id="twFriendsPanelBody"></div>
    `;
    document.body.appendChild(panel);
    if (!collapsed) setCollapsed(false); // wires the click-outside backdrop if it's starting open
    panel.querySelector('#twAddFriendBtn').addEventListener('click', openSearchModal);
  }

  function wireToggleButton() {
    const btn = document.getElementById('twFriendsToggleBtn');
    if (!btn) return;
    btn.addEventListener('click', () => setCollapsed(!collapsed));
  }

  function wireSocketEvents() {
    const socket = TW.connectSocket ? TW.connectSocket() : null;
    if (!socket) return;
    socket.on('friend:status_update', applyPresenceUpdate);
    socket.on('friend:accepted', () => loadFriends());
    socket.on('friend:request_received', () => {
      if (TW.toast) TW.toast('You have a new friend request', 'info');
    });
    socket.on('lobby:invite_received', showInvitePopup);
    socket.on('lobby:invite_expired', (data) => dismissInvite(data.inviteId, 'declining'));
  }

  function init() {
    if (!window.TW || !TW.getToken || !TW.getToken()) return;
    injectPanel();
    wireToggleButton();
    wireSocketEvents();
    loadFriends();
    setInterval(loadFriends, 60000);
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    setCurrentLobby: (lobbyId) => { currentLobbyId = lobbyId; },
    getOnlineFriends: () => friends.filter((f) => f.status !== 'offline'),
    refresh: loadFriends,
    sendInvite,
  };
})();
