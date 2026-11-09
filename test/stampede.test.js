'use strict';

// Found by the load test: at 100 players the lobby stats endpoint rebuilt once per
// request whenever a rebuild was slow, and took the database down.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { createLobbyRouter } = require('../server/lobby');
const { createFetchLimiter } = require('../server/concurrency');

function start(db) {
  const app = express();
  app.use(createLobbyRouter({
    db,
    gameEngine: { MATCH_MODES: {}, getFilledSeatsInPlay: () => 0 },
    instrumentsRegistry: { getTickerSnapshot: () => [] },
    playerSockets: new Map(),
    competitionSummary: (c) => c,
    TIERS: [],
    authenticate: (req, res, next) => next(),
    optionalViewerId: async () => null,
  }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/api/lobby/stats` }));
  });
}

function fakeDb() {
  const db = {
    isConfigured: true,
    builds: 0,
    delayMs: 40,
    fail: false,
    getMatchesToday: async () => {
      db.builds++;
      await new Promise((r) => setTimeout(r, db.delayMs));
      if (db.fail) throw new Error('db down');
      return 7;
    },
    getLargestWinToday: async () => { if (db.fail) throw new Error('db down'); return 3; },
    getCoinsWonToday: async () => { if (db.fail) throw new Error('db down'); return 9; },
    listPublishedCompetitions: async () => [],
    listActiveSponsors: async () => [],
    getLobbySettings: async () => ({ showSeedAccounts: false, emptyMessage: 'x', featuredCompetitionId: null, seasonLabel: 'S' }),
  };
  return db;
}

test('50 requests at once cause one rebuild, not 50', async () => {
  const db = fakeDb();
  const { server, url } = await start(db);
  try {
    const replies = await Promise.all(Array.from({ length: 50 }, () => fetch(url).then((r) => r.json())));
    assert.strictEqual(db.builds, 1);
    assert.ok(replies.every((r) => r.matchesToday === 7));
  } finally { server.close(); }
});

test('an expired cache answers at once with the last numbers and refreshes once behind the scenes', async () => {
  const db = fakeDb();
  const { server, url } = await start(db);
  const realNow = Date.now;
  try {
    await fetch(url);
    db.builds = 0;
    db.delayMs = 300; // a slow database
    Date.now = () => realNow() + 20000;
    const started = realNow();
    const replies = await Promise.all(Array.from({ length: 50 }, () => fetch(url).then((r) => r.json())));
    assert.ok(realNow() - started < 250, 'nobody waited for the slow rebuild');
    assert.ok(replies.every((r) => r.matchesToday === 7));
    assert.strictEqual(db.builds, 1);
  } finally { Date.now = realNow; server.close(); }
});

test('a database hiccup keeps the last good numbers instead of zeros', async () => {
  const db = fakeDb();
  const { server, url } = await start(db);
  const realNow = Date.now;
  const warn = console.warn;
  console.warn = () => {};
  try {
    await fetch(url);
    db.fail = true;
    db.delayMs = 1;
    Date.now = () => realNow() + 20000;
    await fetch(url);
    await new Promise((r) => setTimeout(r, 30));
    Date.now = () => realNow() + 21000;
    const after = await (await fetch(url)).json();
    assert.strictEqual(after.matchesToday, 7);
    assert.strictEqual(after.coinsWonToday, 9);
  } finally { Date.now = realNow; console.warn = warn; server.close(); }
});

test('the database ceiling holds, everything queued gets served, and a stuck queue fails cleanly', async () => {
  let running = 0, peak = 0;
  const fetchImpl = async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; return 'ok'; };
  const limited = createFetchLimiter({ max: 5, timeoutMs: 1000, queueTimeoutMs: 1000, fetchImpl });
  const out = await Promise.all(Array.from({ length: 50 }, () => limited('u')));
  assert.strictEqual(peak, 5);
  assert.strictEqual(out.length, 50);
  assert.deepStrictEqual(limited.stats(), { inFlight: 0, waiting: 0 });

  let release;
  const stuck = createFetchLimiter({ max: 1, timeoutMs: 1000, queueTimeoutMs: 20, fetchImpl: () => new Promise((r) => { release = r; }) });
  const first = stuck('u');
  await new Promise((r) => setImmediate(r));
  await assert.rejects(stuck('u'), { code: 'DB_QUEUE_TIMEOUT' });
  release('done');
  assert.strictEqual(await first, 'done');
  assert.deepStrictEqual(stuck.stats(), { inFlight: 0, waiting: 0 });
});
