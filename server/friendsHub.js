'use strict';

// The rules behind the Friends panel, kept free of the database and sockets so
// they can be tested directly. The routes live in index.js.

// "Show my online status" off: this player looks offline to everyone else.
function visiblePresence(settings, presence) {
  if (settings && settings.showOnline === false) {
    return { status: 'offline', matchId: null, lobbyId: null, mode: null, lastSeen: null };
  }
  return presence;
}

// 'friend', 'sent' (I asked them), 'received' (they asked me) or 'none'.
function relationFor(myId, otherId, rows) {
  const row = (rows || []).find(
    (f) =>
      (f.requester_id === myId && f.addressee_id === otherId) ||
      (f.requester_id === otherId && f.addressee_id === myId)
  );
  if (!row || row.status === 'blocked') return { relation: 'none', requestId: null };
  if (row.status === 'accepted') return { relation: 'friend', requestId: null };
  return { relation: row.requester_id === myId ? 'sent' : 'received', requestId: row.id };
}

// "Around you": the same country first (the one a player chose in Settings; we
// never use real location), then whoever is closest to your rating.
function rankOnlinePlayers(players, me) {
  const sameCountry = (p) => Boolean(me.country) && p.country === me.country;
  const gap = (p) => Math.abs((p.war_rating || 0) - (me.war_rating || 0));
  return players.slice().sort(
    (a, b) =>
      Number(sameCountry(b)) - Number(sameCountry(a)) ||
      gap(a) - gap(b) ||
      String(a.username).localeCompare(String(b.username))
  );
}

// Why an invite can't go to this player, or null if it can. Friends can invite
// even if a player has turned off invites from strangers. A block and a hidden
// player both read as offline, so nobody can find out they were blocked.
function inviteBlockReason({ isFriend, blocked, connected, presenceStatus, settings, alreadyInvited }) {
  if (blocked || !connected) return 'offline';
  if (!isFriend && settings && settings.showOnline === false) return 'offline';
  if (presenceStatus === 'in_match') return 'busy';
  if (!isFriend && settings && settings.allowInvites === false) return 'not_accepting';
  if (alreadyInvited) return 'already_invited';
  return null;
}

// A plain % or _ in a search would otherwise match every username.
function escapeLikePattern(query) {
  return String(query).replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Exact username first, then names that start with the search, then the rest.
function rankSearchResults(players, query) {
  const q = String(query).toLowerCase();
  const score = (p) => {
    const name = String(p.username).toLowerCase();
    if (name === q) return 0;
    return name.startsWith(q) ? 1 : 2;
  };
  return players.slice().sort((a, b) => score(a) - score(b) || String(a.username).localeCompare(String(b.username)));
}

// Per-player cap so requests and invites can't be used to spam strangers.
function createWindowLimiter({ max, windowMs }) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

module.exports = {
  visiblePresence,
  relationFor,
  rankOnlinePlayers,
  inviteBlockReason,
  escapeLikePattern,
  rankSearchResults,
  createWindowLimiter,
};
