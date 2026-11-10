'use strict';

// node scripts/load-test/accounts.js setup 500   create test accounts and log them in
// node scripts/load-test/accounts.js login [mins] fresh logins for any with less than mins left
// node scripts/load-test/accounts.js cleanup     delete every trace of them
const crypto = require('crypto');
const { NAME_PREFIX, EMAIL_DOMAIN, ACCOUNTS_FILE, assertDev, adminClient, anonClient, readAccounts, writeAccounts } = require('./common');

assertDev();
const admin = adminClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COINS = 100000;

async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

// Supabase allows about one sign-in every 2 seconds from one address, so these go
// one at a time just under that, oldest first, skipping logins with plenty of life left.
const SIGN_IN_GAP_MS = 2100;
const KEEP_IF_MINUTES_LEFT = 40;
async function logIn(rows, keepMinutes = KEEP_IF_MINUTES_LEFT) {
  const anon = anonClient();
  const now = Date.now() / 1000;
  const due = rows.filter((r) => !r.expires || r.expires - now < keepMinutes * 60).sort((a, b) => (a.expires || 0) - (b.expires || 0));
  const started = Date.now();
  let limited = 0;
  console.log(`logging in ${due.length} of ${rows.length}, about ${Math.round((due.length * SIGN_IN_GAP_MS) / 60000)} minutes`);
  for (let i = 0; i < due.length; i++) {
    const row = due[i];
    for (let attempt = 0; ; attempt++) {
      const { data, error } = await anon.auth.signInWithPassword({ email: row.email, password: row.password });
      if (!error) {
        row.token = data.session.access_token;
        row.refresh = data.session.refresh_token;
        row.expires = data.session.expires_at;
        break;
      }
      // A wrong password won't change; anything else (rate limit, network blip) can.
      if (error.code === 'invalid_credentials' || attempt > 40) throw error;
      limited++;
      await sleep(15000);
    }
    if (i % 25 === 0) writeAccounts(rows); // so a failure doesn't lose the progress
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${due.length} (${Math.round((Date.now() - started) / 1000)}s, rate limited ${limited} times)`);
    await sleep(SIGN_IN_GAP_MS);
  }
  console.log(`done in ${Math.round((Date.now() - started) / 1000)}s, rate limited ${limited} times`);
}

async function setup(count) {
  const existing = readAccounts();
  const rows = existing.slice(0, count);
  const password = rows[0]?.password || crypto.randomBytes(18).toString('base64url');
  const adding = Array.from({ length: Math.max(0, count - rows.length) }, (_, i) => rows.length + i);
  await pool(adding, 8, async (n) => {
    const username = `${NAME_PREFIX}${n}`;
    const email = `${username}@${EMAIL_DOMAIN}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    const { data: player, error: e2 } = await admin
      .from('players')
      .insert({ username, email, supabase_user_id: data.user.id, coins: COINS, tutorial_completed: true })
      .select('id')
      .single();
    if (e2) throw e2;
    rows.push({ username, email, password, authId: data.user.id, playerId: player.id });
  });
  console.log(`${rows.length} accounts ready`);
  await logIn(rows);
  writeAccounts(rows);
  console.log(`saved to ${ACCOUNTS_FILE}`);
}

// Loops until nothing is left: Supabase returns at most 1000 rows per request.
async function cleanup() {
  let players = 0, matches = 0, logins = 0;
  for (;;) {
    const { data, error } = await admin.from('players').select('id').like('username', `${NAME_PREFIX}%`).limit(500);
    if (error) throw error;
    if (!data.length) break;
    const ids = data.map((p) => p.id);
    const seen = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const { data: mp } = await admin.from('match_players').select('match_id').in('player_id', ids.slice(i, i + 100)).limit(1000);
      (mp || []).forEach((m) => seen.add(m.match_id));
    }
    const ms = [...seen];
    for (let i = 0; i < ms.length; i += 100) {
      await admin.from('replays').delete().in('match_id', ms.slice(i, i + 100));
      await admin.from('matches').delete().in('id', ms.slice(i, i + 100));
    }
    const { error: delErr } = await admin.from('players').delete().in('id', ids);
    if (delErr) throw delErr;
    players += ids.length;
    matches += ms.length;
  }
  // Logins are found by email, so ones missing from the local file go too.
  for (let page = 1; ; ) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const mine = data.users.filter((u) => String(u.email).endsWith(`@${EMAIL_DOMAIN}`));
    await pool(mine, 8, async (u) => { await admin.auth.admin.deleteUser(u.id); });
    logins += mine.length;
    if (data.users.length < 1000) break;
    if (!mine.length) page++;
  }
  writeAccounts([]);
  console.log(`removed ${players} players, ${matches} matches, ${logins} logins`);
}

(async () => {
  const [cmd, n] = process.argv.slice(2);
  if (cmd === 'setup') await setup(Number(n) || 100);
  else if (cmd === 'login') { const rows = readAccounts(); await logIn(rows, Number(n) || undefined); writeAccounts(rows); }
  else if (cmd === 'cleanup') await cleanup();
  else console.log('usage: accounts.js setup <count> | login | cleanup');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message || e); process.exit(1); });
