'use strict';

// Per-admin preferences (the report date range, time zone, comparison on or
// off), stored server-side so they follow the admin to any browser. Keyed by
// the admin's email (or the shared login's username). Until the records
// migration has run there is no table: reads return {} and writes no-op.

const { supabase, isConfigured } = require('./supabaseAdmin');

const ALLOWED = {
  range: (v) => v && typeof v === 'object' && {
    preset: String(v.preset || '7d').slice(0, 20),
    from: v.from ? String(v.from).slice(0, 40) : null,
    to: v.to ? String(v.to).slice(0, 40) : null,
    tz: v.tz ? String(v.tz).slice(0, 60) : null,
    compare: v.compare !== false,
  },
};

const keyOf = (admin) => String((admin && (admin.email || admin.username)) || '').toLowerCase().slice(0, 200);

async function get(admin) {
  if (!isConfigured || !keyOf(admin)) return {};
  const { data, error } = await supabase.from('admin_prefs').select('prefs').eq('admin_key', keyOf(admin)).maybeSingle();
  if (error) return {};
  return (data && data.prefs) || {};
}

async function set(admin, patch) {
  if (!isConfigured || !keyOf(admin)) return {};
  const cur = await get(admin);
  const next = { ...cur };
  for (const [k, clean] of Object.entries(ALLOWED)) {
    if (patch && patch[k] !== undefined) {
      const v = clean(patch[k]);
      if (v) next[k] = v;
    }
  }
  const { error } = await supabase.from('admin_prefs').upsert({ admin_key: keyOf(admin), prefs: next, updated_at: new Date().toISOString() }, { onConflict: 'admin_key' });
  if (error && !/does not exist|schema cache/.test(error.message || '')) throw error;
  return next;
}

module.exports = { get, set, keyOf };
