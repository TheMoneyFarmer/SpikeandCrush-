'use strict';

// Loads the rows the analytics definitions (server/analytics/definitions.js)
// work on. Read-only, admin process only, service key. Pages through results:
// Supabase silently cuts a response at 1000 rows.

const { supabase } = require('./supabaseAdmin');

async function all(build, max = 500000) {
  const out = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function players() {
  const rows = await all(() => supabase.from('players').select('id, username, created_at, is_internal, is_persona, country, first_source, first_medium, first_campaign, first_referrer, first_partner, first_landing').order('created_at'));
  return rows;
}

// Activity = match results (the match's start time) and trades opened.
async function activity(fromIso, toIso) {
  const mp = await all(() => supabase.from('match_players').select('player_id, end_reason, device_class, final_rank, trades_made, cards_played, matches!inner(id, mode, created_at, start_time, end_time, status)').not('player_id', 'is', null).gte('matches.created_at', fromIso).lt('matches.created_at', toIso));
  const tr = await all(() => supabase.from('trades').select('player_id, opened_at').not('player_id', 'is', null).gte('opened_at', fromIso).lt('opened_at', toIso));
  return {
    results: mp.map((r) => ({ player_id: r.player_id, at: r.matches.start_time || r.matches.created_at, match_id: r.matches.id, mode: r.matches.mode, status: r.matches.status, end_reason: r.end_reason, device_class: r.device_class, final_rank: r.final_rank, trades: r.trades_made, cards: r.cards_played })),
    trades: tr.map((t) => ({ player_id: t.player_id, at: t.opened_at })),
  };
}

async function events(fromIso, toIso, names = null) {
  return all(() => {
    let q = supabase.from('analytics_events').select('*').gte('occurred_at', fromIso).lt('occurred_at', toIso).order('occurred_at');
    if (names) q = q.in('event_name', names);
    return q;
  });
}

async function techEvents(fromIso, toIso) {
  return all(() => supabase.from('tech_events').select('at, kind, match_id, mode, value_ms').gte('at', fromIso).lt('at', toIso));
}

// The old, login-based numbers (what admin showed before), for the before/after report.
async function loginEvents(fromIso, toIso) {
  return all(() => supabase.from('login_events').select('player_id, created_at').gte('created_at', fromIso).lt('created_at', toIso));
}

module.exports = { all, players, activity, events, techEvents, loginEvents };
