'use strict';

// Same pattern as server/database.js: service-role client, bypasses RLS,
// never sent to the browser. The admin panel queries Supabase directly for
// everything persisted (players, matches, transactions, tournaments, etc.) -
// only live in-process game-server state goes through the internal bridge
// (see lib/internalGameServer.js).
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const isConfigured = Boolean(
  SUPABASE_URL && SUPABASE_SERVICE_KEY && SUPABASE_URL !== 'your_value' && SUPABASE_SERVICE_KEY !== 'your_value'
);

if (!isConfigured) {
  console.warn('[admin] SUPABASE_SERVICE_KEY not set - admin panel data endpoints will return empty/error responses.');
}

const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

module.exports = { supabase, isConfigured };
