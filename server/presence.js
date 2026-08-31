'use strict';

// In-memory presence tracking (MVP per spec - swap for Redis if this ever
// needs to scale past a single Node process). Socket connection tracking
// itself lives in index.js's playerSockets map; this module only owns the
// player's logical status (online/in_lobby/in_match/offline).
const presenceMap = new Map();
// playerId -> Timeout, running only during the 30s "went offline" grace
// window so a quick reconnect (e.g. a page navigation) doesn't flap status.
const offlineTimers = new Map();
const OFFLINE_GRACE_MS = 30 * 1000;

function getPresence(playerId) {
  return (
    presenceMap.get(playerId) || {
      status: 'offline',
      matchId: null,
      lobbyId: null,
      mode: null,
      lastSeen: null,
    }
  );
}

function setPresence(playerId, patch) {
  const existing = getPresence(playerId);
  const updated = { ...existing, ...patch, lastSeen: Date.now() };
  presenceMap.set(playerId, updated);
  const pendingOffline = offlineTimers.get(playerId);
  if (pendingOffline && updated.status !== 'offline') {
    clearTimeout(pendingOffline);
    offlineTimers.delete(playerId);
  }
  return updated;
}

// Called when a player's last connected socket disconnects. Delays the
// actual "offline" status/broadcast by OFFLINE_GRACE_MS so a page navigation
// (disconnect immediately followed by a reconnect) doesn't flicker a
// friend's presence in and out of "online" in their friends panel.
function scheduleOffline(playerId, onOffline) {
  clearTimeout(offlineTimers.get(playerId));
  const timer = setTimeout(() => {
    offlineTimers.delete(playerId);
    setPresence(playerId, { status: 'offline', matchId: null, lobbyId: null, mode: null });
    onOffline();
  }, OFFLINE_GRACE_MS);
  offlineTimers.set(playerId, timer);
}

function cancelScheduledOffline(playerId) {
  const timer = offlineTimers.get(playerId);
  if (timer) {
    clearTimeout(timer);
    offlineTimers.delete(playerId);
  }
}

module.exports = { getPresence, setPresence, scheduleOffline, cancelScheduledOffline, OFFLINE_GRACE_MS };
