'use strict';

// Test players for the admin-records checks (dev database only).
//
//   node scripts/admin-records/accounts.js setup [count] [file]   create rectest_0..n, write logins to file
//   node scripts/admin-records/accounts.js cleanup                 delete every rectest_ player, login and match row
//
// Emails use the reserved .invalid domain, so nothing is ever sent.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const DEV_REF = 'tifsqiexbjcsazxwvavg';
if (!String(process.env.SUPABASE_URL || '').includes(DEV_REF)) {
  console.error('Refusing: SUPABASE_URL is not the dev project.');
  process.exit(1);
}
const PREFIX = 'rectest_';
const DOMAIN = 'recordtest.example.invalid';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

async function setup(count, file) {
  const password = crypto.randomBytes(18).toString('base64url');
  const rows = [];
  for (let n = 0; n < count; n++) {
    const username = `${PREFIX}${n}`;
    const email = `${username}@${DOMAIN}`;
    const { data: existing } = await admin.from('players').select('id, supabase_user_id').eq('username', username).maybeSingle();
    let authId = existing && existing.supabase_user_id;
    if (authId) {
      const { error } = await admin.auth.admin.updateUserById(authId, { password, email_confirm: true });
      if (error) throw error;
    } else {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw error;
      authId = data.user.id;
    }
    let playerId = existing && existing.id;
    if (!playerId) {
      const { data: p, error } = await admin.from('players')
        .insert({ username, email, supabase_user_id: authId, coins: 500, tutorial_completed: true })
        .select('id').single();
      if (error) throw error;
      playerId = p.id;
    }
    rows.push({ username, email, password, authId, playerId });
  }
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  console.log(`${rows.length} accounts ready, logins in ${file}`);
}

async function cleanup() {
  let players = 0;
  for (;;) {
    const { data, error } = await admin.from('players').select('id, supabase_user_id').like('username', `${PREFIX}%`).limit(200);
    if (error) throw error;
    if (!data.length) break;
    const ids = data.map((p) => p.id);
    const { data: mp } = await admin.from('match_players').select('match_id').in('player_id', ids);
    const matchIds = [...new Set((mp || []).map((r) => r.match_id))];
    for (const t of ['match_events', 'trades', 'sabotage_events', 'match_players', 'match_market_stats']) {
      if (matchIds.length) await admin.from(t).delete().in('match_id', matchIds);
    }
    if (matchIds.length) await admin.from('matches').delete().in('id', matchIds);
    for (const t of ['coin_transactions', 'notifications', 'xp_events', 'player_progress', 'player_card_unlocks', 'login_events', 'player_presence']) {
      await admin.from(t).delete().in('player_id', ids);
    }
    await admin.from('friendships').delete().in('requester_id', ids);
    await admin.from('friendships').delete().in('addressee_id', ids);
    const { error: delErr } = await admin.from('players').delete().in('id', ids);
    if (delErr) throw delErr;
    for (const p of data) if (p.supabase_user_id) await admin.auth.admin.deleteUser(p.supabase_user_id).catch(() => {});
    players += ids.length;
  }
  console.log(`removed ${players} rectest players`);
}

const [cmd, a, b] = process.argv.slice(2);
(cmd === 'cleanup' ? cleanup() : setup(Number(a) || 2, b || path.join(require('os').tmpdir(), 'rectest-accounts.json')))
  .catch((e) => { console.error(e.message || e); process.exit(1); });
