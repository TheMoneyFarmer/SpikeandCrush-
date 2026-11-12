'use strict';

// Test 3: N concurrent account-number claims (the same database function the
// match_players / comp_accounts triggers use). Checks 8 digits, all unique,
// not sequential. Dev only; the test numbers are deleted afterwards (they
// stay unused, so nothing real ever had them).
//   node scripts/admin-records/account-number-load.js [count=10000] [parallel=50]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

if (!String(process.env.SUPABASE_URL).includes('tifsqiexbjcsazxwvavg')) { console.error('dev only'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const N = Number(process.argv[2]) || 10000;
const P = Number(process.argv[3]) || 50;
const TEST_REF = '00000000-0000-4000-8000-00000000a11d';

(async () => {
  const t0 = Date.now();
  const got = [];
  let errors = 0;
  let next = 0;
  await Promise.all(Array.from({ length: P }, async () => {
    while (next < N) {
      next++;
      const { data, error } = await sb.rpc('claim_account_number', { p_kind: 'match', p_ref: TEST_REF, p_player: null });
      if (error) errors++; else got.push(Number(data));
    }
  }));
  const ms = Date.now() - t0;
  const unique = new Set(got).size;
  const eight = got.every((n) => n >= 10000000 && n <= 99999999);
  const sorted = [...got].sort((a, b) => a - b);
  let adjacent = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] === 1) adjacent++;
  // issue order vs numeric order: a sequential scheme would correlate ~1
  const idx = got.map((n, i) => [n, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const mean = (idx.length - 1) / 2;
  let num = 0; let den = 0;
  idx.forEach((v, i) => { num += (i - mean) * (v - mean); den += (i - mean) ** 2; });
  console.log(JSON.stringify({ requested: N, parallel: P, issued: got.length, errors, unique, collisions: got.length - unique, allEightDigits: eight, adjacentPairs: adjacent, orderCorrelation: Math.round((num / den) * 1000) / 1000, seconds: ms / 1000 }));
  const { error: delErr, count } = await sb.from('account_numbers').delete({ count: 'exact' }).eq('ref_id', TEST_REF);
  console.log('test numbers removed:', delErr ? delErr.message : count);
  process.exit(got.length === N && unique === N && eight && !errors ? 0 : 1);
})();
