'use strict';

// The admin panel is a separate process from the game server and gets almost
// all of its data straight from Supabase (see supabaseAdmin.js). The handful
// of things that only exist in the game server's own memory - which matches
// are live right now, forcing one to end, kicking a player mid-match, or
// hot-reloading game_config into the running MATCH_MODES object - go through
// this small internal HTTP bridge instead. Protected by a shared secret
// header and expected to only ever be called over localhost.
const GAME_SERVER_URL = process.env.GAME_SERVER_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 3002}`;
const SECRET = process.env.INTERNAL_ADMIN_SECRET;

async function callInternal(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${GAME_SERVER_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': SECRET || '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `Game server returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Raw image upload for an agent attachment (binary body, not JSON).
async function supportUpload(conversationId, buffer, mime) {
  const res = await fetch(`${GAME_SERVER_URL}/internal/support/conversations/${conversationId}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': mime || 'application/octet-stream', 'x-internal-secret': SECRET || '' },
    body: buffer,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `Game server returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

module.exports = {
  // Support system actions that must reach a live user (socket push, email,
  // bell) run on the game server - see server/support/index.js.
  support: (path, body) => callInternal(`/internal/support${path}`, { method: body === undefined ? 'GET' : 'POST', body }),
  supportUpload,
  getLiveState: () => callInternal('/internal/admin/state'),
  getConfig: () => callInternal('/internal/admin/config'),
  getErrors: () => callInternal('/internal/admin/errors'),
  forceEndMatch: (matchId) => callInternal(`/internal/admin/matches/${matchId}/force-end`, { method: 'POST' }),
  voidMatch: (matchId) => callInternal(`/internal/admin/matches/${matchId}/void`, { method: 'POST' }),
  kickPlayer: (matchId, playerId) =>
    callInternal(`/internal/admin/matches/${matchId}/kick/${playerId}`, { method: 'POST' }),
  reloadConfig: () => callInternal('/internal/admin/reload-config', { method: 'POST' }),
  broadcastAnnouncement: (announcement) =>
    callInternal('/internal/admin/broadcast-announcement', { method: 'POST', body: announcement }),
  settleCompetition: (id) => callInternal(`/internal/admin/competitions/${id}/settle`, { method: 'POST' }),
  voidCompetition: (id) => callInternal(`/internal/admin/competitions/${id}/void`, { method: 'POST' }),
  disqualifyFromCompetition: (id, playerId) =>
    callInternal(`/internal/admin/competitions/${id}/disqualify/${playerId}`, { method: 'POST' }),
  createTestCompetition: (body) => callInternal('/internal/admin/competitions/test', { method: 'POST', body }),
  notifyPlayer: (playerId, type, message, extra) =>
    callInternal(`/internal/admin/notify-player/${playerId}`, { method: 'POST', body: { type, message, extra } }),
};
