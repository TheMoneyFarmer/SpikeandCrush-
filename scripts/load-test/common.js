'use strict';

// Shared bits of the load test. It only ever runs against the dev database and a
// server it starts itself on this machine: see assertDev.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env') });

const DEV_PROJECT = 'tifsqiexbjcsazxwvavg';
const PROD_PROJECT = 'yooqbpnqozitgbvfcfre';
const NAME_PREFIX = 'zzload_test_'; // "test" keeps these off every public board
const EMAIL_DOMAIN = 'loadtest.example.invalid';
const ACCOUNTS_FILE = path.join(os.tmpdir(), 'spikecrush-load-test-accounts.json');
const TEST_PORT = Number(process.env.LOAD_TEST_PORT) || 3060;

function assertDev() {
  const url = process.env.SUPABASE_URL || '';
  if (url.includes(PROD_PROJECT) || !url.includes(DEV_PROJECT)) {
    console.error(`Refusing to run: SUPABASE_URL must be the dev project (${DEV_PROJECT}).`);
    process.exit(1);
  }
}

function adminClient() {
  const { createClient } = require(path.join(ROOT, 'node_modules/@supabase/supabase-js'));
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}
function anonClient() {
  const { createClient } = require(path.join(ROOT, 'node_modules/@supabase/supabase-js'));
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
}

const readAccounts = () => (fs.existsSync(ACCOUNTS_FILE) ? JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')) : []);
const writeAccounts = (rows) => fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(rows), { mode: 0o600 });

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

module.exports = { ROOT, NAME_PREFIX, EMAIL_DOMAIN, ACCOUNTS_FILE, TEST_PORT, assertDev, adminClient, anonClient, readAccounts, writeAccounts, percentile };
