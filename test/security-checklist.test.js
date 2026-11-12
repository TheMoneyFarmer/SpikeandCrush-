'use strict';

// Security checklist (docs/security/README.md): env check, signing keys,
// support chat spend guard, secret scanner, rate limiter keys, RLS migration,
// env.example coverage. No network, no database.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('env check: production refuses to start on a missing or placeholder required variable', () => {
  const { checkEnv } = require('../server/envCheck');
  const lines = [];
  const log = { warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  let exited = null;
  const env = { NODE_ENV: 'production', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'your_value', SUPABASE_ANON_KEY: 'k'.repeat(40) };
  const ok = checkEnv('game', { env, exit: (c) => { exited = c; }, log });
  assert.strictEqual(ok, false);
  assert.strictEqual(exited, 1);
  const text = lines.join('\n');
  assert.match(text, /SUPABASE_SERVICE_KEY/);
  assert.match(text, /ALLOWED_ORIGIN/);
  assert.ok(!text.includes('k'.repeat(40)), 'never prints a value');
});

test('env check: development only warns; a complete production env passes', () => {
  const { checkEnv } = require('../server/envCheck');
  const log = { warn() {}, error() {} };
  let exited = null;
  assert.strictEqual(checkEnv('admin', { env: { NODE_ENV: 'development' }, exit: (c) => { exited = c; }, log }), false);
  assert.strictEqual(exited, null);
  const full = { NODE_ENV: 'production', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 's'.repeat(40), ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'p'.repeat(20), ADMIN_SECRET: 'a'.repeat(64) };
  assert.strictEqual(checkEnv('admin', { env: full, exit: (c) => { exited = c; }, log }), true);
  assert.strictEqual(exited, null);
});

test('every environment variable the servers read is documented in .env.example', () => {
  const example = read('.env.example');
  const names = new Set();
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory() && e.name !== 'node_modules' && !rel.startsWith('admin/js')) walk(rel);
      else if (e.name.endsWith('.js')) files.push(rel);
    }
  };
  walk('server');
  walk('admin');
  for (const f of files) for (const m of read(f).matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]);
  const missing = [...names].filter((n) => !new RegExp(`\\b${n}\\b`).test(example));
  assert.deepStrictEqual(missing, []);
});

test('signing keys: never a fixed string from the source', () => {
  const { signingSecret } = require('../server/envCheck');
  withEnv({ CHALLENGE_SECRET: undefined, JWT_SECRET: undefined, SUPABASE_SERVICE_KEY: 'service-key-for-test-0123456789' }, () => {
    const k = signingSecret('challenge-links', 'CHALLENGE_SECRET', 'JWT_SECRET');
    assert.notStrictEqual(k, 'dev-only-challenge-secret');
    assert.strictEqual(k, crypto.createHmac('sha256', 'service-key-for-test-0123456789').update('spikecrush:challenge-links').digest('hex'));
    assert.notStrictEqual(signingSecret('statements', 'STATEMENT_SECRET'), k, 'one key per purpose');
  });
  withEnv({ CHALLENGE_SECRET: 'c'.repeat(64) }, () => {
    assert.strictEqual(signingSecret('challenge-links', 'CHALLENGE_SECRET', 'JWT_SECRET'), 'c'.repeat(64), 'an explicit variable wins');
  });
  withEnv({ STATEMENT_SECRET: undefined, INTERNAL_ADMIN_SECRET: undefined, ADMIN_SECRET: undefined, SUPABASE_SERVICE_KEY: undefined }, () => {
    const k = signingSecret('statements-dev', 'STATEMENT_SECRET');
    assert.ok(k && k.length === 64, 'development gets a random key, never empty');
  });
  assert.ok(!/dev-only-challenge-secret/.test(read('server/challenge.js')));
  assert.ok(!/ADMIN_SECRET \|\| ''/.test(read('server/statementPdf.js')));
});

test('support chat budget: per-account hourly limit, daily token cap, day rollover', () => {
  const { createSupportBudget } = require('../server/support/budget');
  let t = Date.parse('2026-11-12T10:00:00Z');
  const b = createSupportBudget({ perHour: 3, dailyTokenCap: 1000, now: () => t });
  for (let i = 0; i < 3; i++) {
    assert.ok(b.check('p:1').ok);
    b.record('p:1', { input_tokens: 10, output_tokens: 10 });
  }
  assert.deepStrictEqual(b.check('p:1'), { ok: false, reason: 'owner_hourly' });
  assert.ok(b.check('p:2').ok, 'another player is not affected');
  t += 61 * 60 * 1000;
  assert.ok(b.check('p:1').ok, 'an hour later the player can ask again');
  b.record('p:2', { input_tokens: 900, output_tokens: 100 });
  assert.deepStrictEqual(b.check('p:3'), { ok: false, reason: 'daily_spend' });
  t = Date.parse('2026-11-13T00:00:01Z');
  assert.ok(b.check('p:3').ok, 'the daily cap resets at UTC midnight');
});

test('support chat: the budget is checked before every AI call', () => {
  const src = read('server/support/service.js');
  const check = src.indexOf('budget.check(ownerKey)');
  const call = src.indexOf('await agent.reply(');
  assert.ok(check > 0 && call > check, 'budget.check comes before agent.reply');
  assert.ok(src.includes('budget.record(ownerKey'), 'usage is recorded');
});

test('secret scanner: finds planted keys, ignores the public anon key', () => {
  const { scanLines } = require('../scripts/secret-scan');
  const found = [];
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const anon = `eyJhbGciOiJIUzI1NiJ9.${b64({ role: 'anon', ref: 'abcdefghijklmnop' })}.${'x'.repeat(30)}`;
  const service = `eyJhbGciOiJIUzI1NiJ9.${b64({ role: 'service_role', ref: 'abcdefghijklmnop' })}.${'y'.repeat(30)}`;
  const live = ['sk', 'live', 'A1b2C3d4E5f6G7h8J9k0'].join('_');
  scanLines([
    'COMMIT abc1234',
    '+++ b/server/x.js',
    `+const k = '${live}';`,
    `+const anon = '${anon}';`,
    `+const svc = '${service}';`,
    "+const pw = process.env.ADMIN_PASSWORD || 'Hunter2Hunter2!';",
  ], (f) => found.push(f.rule));
  assert.deepStrictEqual(found.sort(), ['env_fallback', 'jwt', 'stripe_live']);
});

test('every rate limiter is keyed on the real visitor, not the Cloudflare edge address', () => {
  const offenders = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'server')).filter((n) => n.endsWith('.js'))) {
    const src = read(`server/${f}`);
    for (const m of src.matchAll(/rateLimit\(\{(?:[^\n]*\n?){1,3}/g)) {
      if (!/keyGenerator|limiterDefaults/.test(m[0])) offenders.push(`${f}: ${m[0].slice(0, 60)}`);
    }
  }
  assert.deepStrictEqual(offenders, []);
});

test('RLS migration closes direct public reads of sponsor and competition config tables', () => {
  const sql = read('supabase/migrations/20261112130000_close_public_sponsor_reads.sql');
  for (const p of ['sponsors_public_read', 'sponsor_placements_public_read', 'competition_templates_public_read', 'listing_tiers_read']) {
    assert.match(sql, new RegExp(`drop policy if exists ${p} on`));
  }
  assert.ok(!/create policy/i.test(sql));
});

test('production build check passes on this tree', () => {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/prod-check.js')], { env: { ...process.env, PROD_CHECK_ROOT: ROOT } }).toString();
  assert.match(out, /\[prod-check\] OK/);
});
