'use strict';

// Deploy drain: idle lobbies close (with refunds) so a deploy can go ahead,
// including the public Elimination mode (internal key 'tournament'); only a
// user-made bracket tournament's lobby is left alone.

process.env.DEPLOY_LOBBY_GRACE_SECONDS = '0.001';
const test = require('node:test');
const assert = require('node:assert');
const { createDeployDrain } = require('../server/deployDrain');

test('drain closes waiting Elimination and Quick lobbies, keeps bracket tournament lobbies', async () => {
  const matches = {
    elim: { id: 'elim', mode: 'tournament', status: 'waiting', config: {} },
    quick: { id: 'quick', mode: 'quick', status: 'waiting', config: {} },
    bracket: { id: 'bracket', mode: 'tournament', status: 'waiting', config: { tournamentId: 't1' } },
    live: { id: 'live', mode: 'quick', status: 'active', config: {} },
  };
  const closed = [];
  const gameEngine = {
    listActiveMatches: () => Object.values(matches).map((m) => ({ id: m.id, mode: m.mode, status: m.status })),
    getMatch: (id) => matches[id],
    closeLobby: async (m) => { closed.push(m.id); m.status = 'closed'; },
  };
  const drain = createDeployDrain({ gameEngine, io: { emit() {} }, notifyPlayer() {} });
  drain.setDraining(true, { ttlSeconds: 600 });
  await new Promise((r) => setTimeout(r, 5));
  const n = await drain.closeIdleLobbies();
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(closed.sort(), ['elim', 'quick']);
  assert.strictEqual(matches.bracket.status, 'waiting');
  drain.setDraining(false);
});
