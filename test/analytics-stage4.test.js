'use strict';

// Analytics Stage 4: sessions, retention cleanup of raw addresses (idempotent).
const test = require('node:test');
const assert = require('node:assert');
const def = require('../server/analytics/definitions');
const { runRetention } = require('../server/retention');

test('sessions: split after the idle timeout; length, pages, device', () => {
  const ev = (t, name = 'page_view', extra = {}) => ({ session_id: 's1', source: 'client', event_name: name, occurred_at: t, device_class: 'phone', page: '/', ...extra });
  const s = def.sessions([
    ev('2026-11-20T10:00:00Z'), ev('2026-11-20T10:05:00Z'), ev('2026-11-20T10:06:00Z', 'support_opened'),
    ev('2026-11-20T11:00:00Z'), // 54 idle minutes later: a new session
    { ...ev('2026-11-20T10:01:00Z'), source: 'server' }, // server events are not visits
  ], { idleMs: 30 * 60000 });
  assert.strictEqual(s.length, 2);
  assert.deepStrictEqual([s[0].pages, s[0].lengthSec, s[0].device], [2, 360, 'phone']);
  assert.deepStrictEqual([s[1].pages, s[1].lengthSec], [1, 0]);
  assert.strictEqual(s[0].day, '2026-11-20');
});

test('retention job: raw IPs older than the setting are cleared, newer kept, second run does nothing', async () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  const rows = {
    login_events: [{ id: 1, created_at: '2026-10-01T00:00:00Z', ip: '203.0.113.5', user_agent: 'UA' }, { id: 2, created_at: '2026-11-15T00:00:00Z', ip: '203.0.113.6', user_agent: 'UA' }],
    sessions: [{ id: 3, created_at: '2026-09-01T00:00:00Z', ip: '198.51.100.1', user_agent: 'UA' }],
  };
  const client = () => ({
    from: (t) => ({
      update: (patch) => ({
        lt: (_c, iso) => ({
          or: () => ({
            select: async () => {
              const hit = rows[t].filter((r) => r.created_at < iso && (r.ip !== null || r.user_agent !== null));
              hit.forEach((r) => Object.assign(r, patch));
              return { data: hit.map((r) => ({ id: r.id })), error: null };
            },
          }),
        }),
      }),
    }),
  });
  const db = { client, deleteOlderThan: async () => 0, pruneEndedCompSnapshots: async () => 0 };
  const first = await runRetention(db, now);
  assert.strictEqual(first.login_events_anonymised, 1);
  assert.strictEqual(first.sessions_anonymised, 1);
  assert.strictEqual(rows.login_events[0].ip, null);
  assert.strictEqual(rows.login_events[1].ip, '203.0.113.6', '5 days old: kept');
  const second = await runRetention(db, now);
  assert.strictEqual(second.login_events_anonymised, 0, 'idempotent');
  assert.strictEqual(second.sessions_anonymised, 0);
});
