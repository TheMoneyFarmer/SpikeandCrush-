'use strict';

// What anyone may see of another player's account (security pass B4.4). The
// public profile routes need no login, so they return only these fields; a
// player viewing their own profile gets their full record from the route.
const PUBLIC_FIELDS = [
  'id', 'username', 'avatar_url', 'country', 'tier', 'war_rating', 'grand_war_rating', 'solo_rating',
  'total_matches', 'wins', 'losses', 'draws', 'experience_level', 'level', 'title', 'created_at',
];

function publicProfilePlayer(p) {
  const out = {};
  for (const k of PUBLIC_FIELDS) if (p && p[k] !== undefined) out[k] = p[k];
  return out;
}

module.exports = { PUBLIC_FIELDS, publicProfilePlayer };
