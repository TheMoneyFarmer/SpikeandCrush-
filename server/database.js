'use strict';

const crypto = require('crypto');

const { createClient } = require('@supabase/supabase-js');
const { runPool, createFetchLimiter } = require('./concurrency');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const isConfigured = Boolean(
  SUPABASE_URL &&
    SUPABASE_SERVICE_KEY &&
    SUPABASE_URL !== 'your_value' &&
    SUPABASE_SERVICE_KEY !== 'your_value'
);

if (!isConfigured) {
  console.warn(
    '[database] SUPABASE_SERVICE_KEY is not set - database persistence is disabled. ' +
      'Add the real service_role key to .env (Supabase Dashboard -> Project Settings -> API) ' +
      'to enable accounts, match history and payments.'
  );
}

// Service role key bypasses RLS - this client must never be sent to the browser.
// Every DB call gets a timeout so a stalled request can't hang a player's
// request or the competition tick forever (audit item 2).
const DB_TIMEOUT_MS = Number(process.env.DB_TIMEOUT_MS || 15000);
const DB_MAX_CONCURRENT = Number(process.env.DB_MAX_CONCURRENT) || 40;
const DB_QUEUE_TIMEOUT_MS = Number(process.env.DB_QUEUE_TIMEOUT_MS) || 20000;
const fetchWithTimeout = createFetchLimiter({ max: DB_MAX_CONCURRENT, timeoutMs: DB_TIMEOUT_MS, queueTimeoutMs: DB_QUEUE_TIMEOUT_MS });
// Supabase returns at most 1000 rows per request however high .limit() is, and
// says nothing when it cuts a result short. Anything that must see every row reads
// page by page. `build` returns a fresh query with a stable .order().
const PAGE_SIZE = 1000;
const COMP_WRITE_BATCH = 500;
async function fetchAllRows(build, maxRows = 500000) {
  const rows = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

// A database function that doesn't exist yet (migration not run on this database).
function isMissingFunction(error) {
  return Boolean(error) && (error.code === 'PGRST202' || error.code === '42883');
}

const supabase = isConfigured ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { global: { fetch: fetchWithTimeout } }) : null;

function assertConfigured() {
  if (!isConfigured) {
    const err = new Error('Database is not configured (missing SUPABASE_SERVICE_KEY)');
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }
}

// ---- players ----------------------------------------------------------

async function createPlayer({ username, email, passwordHash, supabaseUserId }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('players')
    .insert({ username, email, password_hash: passwordHash || null, supabase_user_id: supabaseUserId || null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getPlayerByUsername(username) {
  assertConfigured();
  const { data, error } = await supabase.from('players').select('*').eq('username', username).maybeSingle();
  if (error) throw error;
  return data;
}

async function getPlayerByEmail(email) {
  assertConfigured();
  const { data, error } = await supabase.from('players').select('*').eq('email', email).maybeSingle();
  if (error) throw error;
  return data;
}

async function getPlayerById(id) {
  assertConfigured();
  const { data, error } = await supabase.from('players').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function getPlayerBySupabaseUserId(supabaseUserId) {
  assertConfigured();
  const { data, error } = await supabase.from('players').select('*').eq('supabase_user_id', supabaseUserId).maybeSingle();
  if (error) throw error;
  return data;
}

async function deletePlayer(id) {
  assertConfigured();
  const { error } = await supabase.from('players').delete().eq('id', id);
  if (error) throw error;
}

async function updatePlayer(id, fields) {
  assertConfigured();
  const { data, error } = await supabase.from('players').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

async function recordCoinTransaction({ playerId, type, amount, balanceAfter, matchId = null }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('coin_transactions')
    .insert({ player_id: playerId, type, amount, balance_after: balanceAfter, match_id: matchId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---- coins: every movement goes through the coin_apply() SQL function ----------------
// One statement moves the balance (never below zero) and writes the ledger row
// in the same transaction (supabase/migrations/20261108100000_security_ledger.sql).
// The old read-modify-write here lost updates under concurrency and could
// leave the ledger and the balance disagreeing (audit Proofs A-C).
// `idempotencyKey` makes a call safe to retry: the same key never moves coins twice.
async function applyCoins(id, delta, { type, matchId = null, idempotencyKey = null }) {
  assertConfigured();
  const { data, error } = await supabase.rpc('coin_apply', {
    p_player: id,
    p_delta: delta,
    p_type: type,
    p_match: matchId,
    p_key: idempotencyKey,
  });
  if (error) {
    // A concurrent call with the same key won the race: already applied once.
    if (error.hint === 'duplicate' || /duplicate key/i.test(error.message || '')) {
      return { ...(await getPlayerById(id)), duplicate: true };
    }
    throw error;
  }
  if (data?.error === 'player_not_found') throw new Error('Player not found');
  if (data?.error === 'insufficient_coins') {
    const err = new Error('Insufficient coins');
    err.code = 'INSUFFICIENT_COINS';
    err.balance = data.balance;
    throw err;
  }
  const player = await getPlayerById(id);
  return { ...player, duplicate: Boolean(data?.duplicate) };
}

async function creditCoins(id, amount, { type = 'prize_won', matchId = null, idempotencyKey = null } = {}) {
  if (!(amount > 0)) throw new Error('creditCoins amount must be positive');
  return applyCoins(id, Math.round(amount), { type, matchId, idempotencyKey });
}

async function debitCoins(id, amount, { type = 'match_entry', matchId = null, idempotencyKey = null } = {}) {
  if (!(amount > 0)) throw new Error('debitCoins amount must be positive');
  return applyCoins(id, -Math.round(amount), { type, matchId, idempotencyKey });
}

// ---- battle pass -----------------------------------------------------------

async function getBattlePassStatus(playerId, season) {
  assertConfigured();
  const { data, error } = await supabase
    .from('battle_pass_subscriptions')
    .select('*')
    .eq('player_id', playerId)
    .eq('season', season)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function ensureBattlePassStatus(playerId, season, expiresAt) {
  const existing = await getBattlePassStatus(playerId, season);
  if (existing) return existing;
  const { data, error } = await supabase
    .from('battle_pass_subscriptions')
    .insert({
      player_id: playerId,
      season,
      tier_current: 0,
      xp_current: 0,
      is_premium: false,
      expires_at: expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function addBattlePassXp(playerId, season, xpDelta, tierCurrent) {
  assertConfigured();
  const status = await ensureBattlePassStatus(playerId, season);
  const newXp = status.xp_current + xpDelta;
  const { data, error } = await supabase
    .from('battle_pass_subscriptions')
    .update({ xp_current: newXp, tier_current: tierCurrent })
    .eq('id', status.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function listCompletedChallenges(playerId, season) {
  assertConfigured();
  const { data, error } = await supabase
    .from('battle_pass_progress')
    .select('challenge_id, challenge_type, completed_at, coins_earned')
    .eq('player_id', playerId)
    .eq('season', season);
  if (error) throw error;
  return data;
}

async function getBattlePassChallengeStats(playerId, sinceIso) {
  assertConfigured();
  const { data: matchRows, error: matchErr } = await supabase
    .from('match_players')
    .select('final_rank, final_pnl, cards_played, matches!inner(mode, created_at)')
    .eq('player_id', playerId)
    .gte('matches.created_at', sinceIso);
  if (matchErr) throw matchErr;

  const { data: tradeRows, error: tradeErr } = await supabase
    .from('trades')
    .select('symbol, opened_at')
    .eq('player_id', playerId)
    .gte('opened_at', sinceIso);
  if (tradeErr) throw tradeErr;

  const { data: cardRows, error: cardErr } = await supabase
    .from('sabotage_events')
    .select('card_type, played_at, target_player_id')
    .eq('player_id', playerId)
    .gte('played_at', sinceIso);
  if (cardErr) throw cardErr;

  return {
    matches: (matchRows || []).map((r) => ({
      mode: r.matches.mode,
      finalRank: r.final_rank,
      finalPnl: Number(r.final_pnl || 0),
      cardsPlayed: r.cards_played || 0,
    })),
    trades: tradeRows || [],
    cardPlays: cardRows || [],
  };
}

async function recordChallengeCompletion({ playerId, season, challengeId, challengeType, coinsEarned }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('battle_pass_progress')
    .insert({ player_id: playerId, season, challenge_id: challengeId, challenge_type: challengeType, coins_earned: coinsEarned })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---- trading floor home screen widgets ---------------------------------------

// app_settings.show_seed_accounts (default false): while false, persona
// accounts (players.is_persona - the seeded bots from seedPersonas.js) never
// appear on public boards, feeds or counts. Cached briefly so every widget
// on the lobby doesn't re-read the setting.
const SEED_SETTING_TTL_MS = 15000;
let seedSettingCache = { value: false, at: 0 };
async function showSeedAccounts() {
  if (Date.now() - seedSettingCache.at < SEED_SETTING_TTL_MS) return seedSettingCache.value;
  try {
    const value = (await getAppSetting('show_seed_accounts')) === true;
    seedSettingCache = { value, at: Date.now() };
  } catch (e) {
    seedSettingCache = { value: false, at: Date.now() };
  }
  return seedSettingCache.value;
}

// Midnight in Dubai (UTC+4, no DST) - the lobby's "today".
const DUBAI_OFFSET_MS = 4 * 3600 * 1000;
function dubaiDayStart(nowMs = Date.now()) {
  const d = new Date(nowMs + DUBAI_OFFSET_MS);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - DUBAI_OFFSET_MS);
}

// Coin credits that count as winnings on the lobby and landing stats.
const PRIZE_TX_TYPES = ['prize_won', 'competition_prize', 'tournament_prize'];
// Mirrors excludeTestAccounts() for rows filtered in JS.
const TEST_USERNAME_RE = /test|debug|iso|^monitor|^pclose/i;

async function getRecentActivity(limit = 15) {
  assertConfigured();
  const hideSeeds = !(await showSeedAccounts());
  const [{ data, error }, comps] = await Promise.all([
    supabase
      .from('matches')
      .select('id, mode, end_time, winner_id, winner:winner_id(username, is_persona)')
      .eq('status', 'finished')
      .not('winner_id', 'is', null)
      .order('end_time', { ascending: false })
      .limit(limit * 4),
    supabase
      .from('comp_accounts')
      .select('final_rank, prize_coins, competition:competitions!inner(id, title, settled_at, is_test, status), player:players!inner(username, is_persona)')
      .eq('final_rank', 1)
      .eq('competition.is_test', false)
      .eq('competition.status', 'ended')
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);
  if (error) throw error;
  const matchRows = data
    .filter((m) => !hideSeeds || !m.winner?.is_persona)
    .map((m) => ({
      kind: 'match',
      matchId: m.id,
      mode: m.mode,
      endTime: m.end_time,
      winnerUsername: m.winner?.username || 'Unknown',
    }));
  // Competition results are optional extra rows - a missing table (older
  // database) just means match rows only.
  const compRows = (comps.error ? [] : comps.data || [])
    .filter((a) => a.competition?.settled_at && (!hideSeeds || !a.player?.is_persona))
    .map((a) => ({
      kind: 'competition',
      competitionId: a.competition.id,
      competitionTitle: a.competition.title,
      prizeCoins: a.prize_coins || 0,
      endTime: a.competition.settled_at,
      winnerUsername: a.player.username,
    }));
  return [...matchRows, ...compRows].sort((a, b) => new Date(b.endTime) - new Date(a.endTime)).slice(0, limit);
}

// Streaks aren't a stored column, so this walks each player's most recent
// finished matches (already time-ordered from the query) and counts
// consecutive wins from the front - cheap enough at this data volume, and
// avoids adding a denormalized streak counter that could drift out of sync.
async function getHotStreaks(limit = 5) {
  assertConfigured();
  const { data, error } = await supabase
    .from('match_players')
    .select('player_id, final_rank, matches!inner(end_time, status), players!inner(username, war_rating, is_persona)')
    .eq('matches.status', 'finished')
    .order('end_time', { foreignTable: 'matches', ascending: false })
    .limit(500);
  if (error) throw error;

  const hideSeeds = !(await showSeedAccounts());
  const byPlayer = new Map();
  for (const row of data) {
    if (hideSeeds && row.players.is_persona) continue;
    if (!byPlayer.has(row.player_id)) byPlayer.set(row.player_id, []);
    byPlayer.get(row.player_id).push(row);
  }

  const streaks = [];
  for (const [playerId, rows] of byPlayer) {
    let streak = 0;
    for (const row of rows) {
      if (row.final_rank === 1) streak += 1;
      else break;
    }
    if (streak >= 2) {
      streaks.push({ playerId, username: rows[0].players.username, warRating: rows[0].players.war_rating, streak });
    }
  }
  streaks.sort((a, b) => b.streak - a.streak);
  return streaks.slice(0, limit);
}

async function getPlayerWinStreak(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('match_players')
    .select('final_rank, matches!inner(end_time, status)')
    .eq('player_id', playerId)
    .eq('matches.status', 'finished')
    .order('end_time', { foreignTable: 'matches', ascending: false })
    .limit(50);
  if (error) throw error;
  let streak = 0;
  for (const row of data) {
    if (row.final_rank === 1) streak += 1;
    else break;
  }
  return streak;
}

async function getPlayerWinRateSince(playerId, sinceIso) {
  assertConfigured();
  const { data, error } = await supabase
    .from('match_players')
    .select('final_rank, matches!inner(end_time, status)')
    .eq('player_id', playerId)
    .eq('matches.status', 'finished')
    .gte('matches.end_time', sinceIso);
  if (error) throw error;
  if (!data.length) return { matches: 0, winRate: 0 };
  const wins = data.filter((r) => r.final_rank === 1).length;
  return { matches: data.length, winRate: Math.round((wins / data.length) * 1000) / 10 };
}

// ---- async daily challenge ---------------------------------------------------

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

async function getAsyncResultToday(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('async_results')
    .select('*')
    .eq('player_id', playerId)
    .eq('daily_id', todayDateStr())
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function recordAsyncResult({ playerId, pnl, tradesMade }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('async_results')
    .insert({ daily_id: todayDateStr(), player_id: playerId, pnl, trades_made: tradesMade })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getAsyncLeaderboardToday(limit = 50) {
  assertConfigured();
  const { data, error } = await supabase
    .from('async_results')
    .select('player_id, pnl, trades_made, completed_at, players!inner(username, avatar_url)')
    .eq('daily_id', todayDateStr())
    .order('pnl', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map((row, i) => ({
    rank: i + 1,
    playerId: row.player_id,
    username: row.players.username,
    avatarUrl: row.players.avatar_url,
    pnl: Number(row.pnl),
    tradesMade: row.trades_made,
  }));
}

// ---- friends ----------------------------------------------------------------

async function getFriendshipBetween(playerAId, playerBId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('friendships')
    .select('*')
    .or(`and(requester_id.eq.${playerAId},addressee_id.eq.${playerBId}),and(requester_id.eq.${playerBId},addressee_id.eq.${playerAId})`)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function sendFriendRequest(requesterId, addresseeId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('friendships')
    .insert({ requester_id: requesterId, addressee_id: addresseeId, status: 'pending' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function acceptFriendRequest(requestId, accepterId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('friendships')
    .update({ status: 'accepted', updated_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('addressee_id', accepterId)
    .eq('status', 'pending')
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function declineFriendRequest(requestId, declinerId) {
  assertConfigured();
  const { error } = await supabase.from('friendships').delete().eq('id', requestId).eq('addressee_id', declinerId).eq('status', 'pending');
  if (error) throw error;
}

async function removeFriend(playerId, friendId) {
  assertConfigured();
  const { error } = await supabase
    .from('friendships')
    .delete()
    .or(`and(requester_id.eq.${playerId},addressee_id.eq.${friendId}),and(requester_id.eq.${friendId},addressee_id.eq.${playerId})`)
    .eq('status', 'accepted');
  if (error) throw error;
}

async function listFriends(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('friendships')
    .select('*, requester:requester_id(id, username, avatar_url, war_rating, tier, settings), addressee:addressee_id(id, username, avatar_url, war_rating, tier, settings)')
    .or(`requester_id.eq.${playerId},addressee_id.eq.${playerId}`)
    .eq('status', 'accepted');
  if (error) throw error;
  return data.map((f) => (f.requester_id === playerId ? f.addressee : f.requester));
}

async function listFriendIds(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('friendships')
    .select('requester_id, addressee_id')
    .or(`requester_id.eq.${playerId},addressee_id.eq.${playerId}`)
    .eq('status', 'accepted');
  if (error) throw error;
  return data.map((f) => (f.requester_id === playerId ? f.addressee_id : f.requester_id));
}

async function listIncomingRequests(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('friendships')
    .select('*, requester:requester_id(id, username, avatar_url, war_rating, tier)')
    .eq('addressee_id', playerId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function listOutgoingRequests(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('friendships')
    .select('*, addressee:addressee_id(id, username, avatar_url, war_rating, tier)')
    .eq('requester_id', playerId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// Persona accounts (server/personas.js) are excluded - they're per-match
// slot-fillers with no real login, so a friend request to one would sit
// pending forever. They still show up on the leaderboard, just never here.
async function searchPlayers(query, excludePlayerId, limit = 10) {
  assertConfigured();
  const { data, error } = await supabase
    .from('players')
    .select('id, username, avatar_url, war_rating, tier, country, settings, is_banned, banned_until')
    .ilike('username', `%${query}%`)
    .neq('id', excludePlayerId)
    .eq('is_persona', false)
    .limit(limit);
  if (error) throw error;
  return data;
}

// Public fields for the Friends panel. Personas are left out here too.
async function getPlayersForFriendsPanel(ids) {
  assertConfigured();
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('players')
    .select('id, username, avatar_url, war_rating, tier, country, settings, is_banned, banned_until')
    .in('id', ids)
    .eq('is_persona', false);
  if (error) throw error;
  return data;
}

// Every friendship row this player is part of, in any state.
async function listFriendshipRows(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('friendships')
    .select('id, requester_id, addressee_id, status')
    .or(`requester_id.eq.${playerId},addressee_id.eq.${playerId}`);
  if (error) throw error;
  return data;
}

async function cancelFriendRequest(requestId, requesterId) {
  assertConfigured();
  const { error } = await supabase
    .from('friendships')
    .delete()
    .eq('id', requestId)
    .eq('requester_id', requesterId)
    .eq('status', 'pending');
  if (error) throw error;
}

// Ends any friendship or pending request between two players.
async function removeFriendshipBetween(playerAId, playerBId) {
  assertConfigured();
  const { error } = await supabase
    .from('friendships')
    .delete()
    .or(`and(requester_id.eq.${playerAId},addressee_id.eq.${playerBId}),and(requester_id.eq.${playerBId},addressee_id.eq.${playerAId})`);
  if (error) throw error;
}

// Everyone this player has blocked or been blocked by, as a Set of ids.
async function listBlockRelationIds(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('player_blocks')
    .select('player_id, blocked_player_id')
    .or(`player_id.eq.${playerId},blocked_player_id.eq.${playerId}`);
  if (error) throw error;
  return new Set(data.map((b) => (b.player_id === playerId ? b.blocked_player_id : b.player_id)));
}

// ---- notifications ------------------------------------------------------------

async function createNotification({ playerId, type, fromPlayerId, data }) {
  assertConfigured();
  const { data: row, error } = await supabase
    .from('notifications')
    .insert({ player_id: playerId, type, from_player_id: fromPlayerId || null, data: data || {} })
    .select()
    .single();
  if (error) throw error;
  return row;
}

async function listNotifications(playerId, limit = 30) {
  assertConfigured();
  const { data, error } = await supabase
    .from('notifications')
    .select('*, from_player:from_player_id(username, avatar_url)')
    .eq('player_id', playerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

async function countUnreadNotifications(playerId) {
  assertConfigured();
  const { count, error } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('player_id', playerId)
    .eq('read', false);
  if (error) throw error;
  return count || 0;
}

async function markNotificationsRead(playerId, ids) {
  assertConfigured();
  let query = supabase.from('notifications').update({ read: true }).eq('player_id', playerId);
  if (ids && ids.length) query = query.in('id', ids);
  const { error } = await query;
  if (error) throw error;
}

// Marks the acceptor's own 'friend_request' notification read the moment
// they act on it - previously it only ever got marked read incidentally
// (opening the bell used to mark everything read on every open), so an
// accept via the Friends panel directly, bypassing the bell's own Accept
// button, left it sitting unread indefinitely.
async function markFriendRequestNotificationRead(playerId, requestId) {
  assertConfigured();
  const { error } = await supabase
    .from('notifications')
    .update({ read: true })
    .eq('player_id', playerId)
    .eq('type', 'friend_request')
    .contains('data', { requestId });
  if (error) throw error;
}

async function deleteAllNotifications(playerId) {
  assertConfigured();
  const { error } = await supabase.from('notifications').delete().eq('player_id', playerId);
  if (error) throw error;
}

// ---- presence (best-effort persistence - the in-memory Map in index.js is
// the live authoritative source; this table just survives restarts/audits) --

async function upsertPresence({ playerId, status, currentMatchId, currentLobbyId, currentMode }) {
  assertConfigured();
  const { error } = await supabase.from('player_presence').upsert(
    {
      player_id: playerId,
      status,
      current_match_id: currentMatchId || null,
      current_lobby_id: currentLobbyId || null,
      current_mode: currentMode || null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'player_id' }
  );
  if (error) throw error;
}

// ---- replays / clips ------------------------------------------------------------

async function createReplay({ matchId, eventLog, priceData, players, pnlSnapshots }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('replays')
    .insert({
      match_id: matchId,
      event_log: eventLog,
      price_data: priceData,
      players: players || [],
      pnl_snapshots: pnlSnapshots || {},
      clip_count: 0,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getReplay(matchId) {
  assertConfigured();
  const { data, error } = await supabase.from('replays').select('*').eq('match_id', matchId).maybeSingle();
  if (error) throw error;
  return data;
}

async function createClip({ matchId, playerId, startSecond, endSecond, caption }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('clips')
    .insert({ match_id: matchId, player_id: playerId, start_second: startSecond, end_second: endSecond, caption, share_count: 0 })
    .select()
    .single();
  if (error) throw error;
  const replay = await getReplay(matchId);
  if (replay) await supabase.from('replays').update({ clip_count: (replay.clip_count || 0) + 1 }).eq('match_id', matchId);
  return data;
}

async function getClip(id) {
  assertConfigured();
  const { data, error } = await supabase.from('clips').select('*, players(username)').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function incrementClipShareCount(id) {
  assertConfigured();
  const clip = await supabase.from('clips').select('share_count').eq('id', id).single();
  if (clip.error) throw clip.error;
  const { error } = await supabase.from('clips').update({ share_count: (clip.data.share_count || 0) + 1 }).eq('id', id);
  if (error) throw error;
}

// ---- tournaments --------------------------------------------------------------

async function createTournament({ name, bracketSize, entryCoins, startsAt }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('tournaments')
    .insert({ name, bracket_size: bracketSize, entry_coins: entryCoins, starts_at: startsAt, status: 'signup', prize_pool_coins: 0 })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function listTournaments() {
  assertConfigured();
  const { data, error } = await supabase.from('tournaments').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return data;
}

async function getTournament(id) {
  assertConfigured();
  const { data, error } = await supabase.from('tournaments').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function updateTournament(id, fields) {
  assertConfigured();
  const { data, error } = await supabase.from('tournaments').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

async function listTournamentRegistrations(tournamentId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('tournament_registrations')
    .select('*, players(username)')
    .eq('tournament_id', tournamentId)
    .order('registered_at', { ascending: true });
  if (error) throw error;
  return data.map((r) => ({ ...r, username: r.players?.username }));
}

async function registerForTournament({ tournamentId, playerId, seed }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('tournament_registrations')
    .insert({ tournament_id: tournamentId, player_id: playerId, seed, current_round: 1 })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateTournamentRegistration(tournamentId, playerId, fields) {
  assertConfigured();
  const { data, error } = await supabase
    .from('tournament_registrations')
    .update(fields)
    .eq('tournament_id', tournamentId)
    .eq('player_id', playerId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---- competitions (Competition Hub listings) ------------------------------------

const COMPETITION_SELECT = '*, organizer:organizers(id, name, logo_url, website, is_verified), competition_entries(count)';

function flattenCompetition(row) {
  if (!row) return row;
  const { competition_entries: entries, ...rest } = row;
  return { ...rest, entry_count: entries?.[0]?.count || 0 };
}

// Ended competitions stay listed for 30 days so "Results" rows don't vanish
// the moment a competition closes.
async function listPublishedCompetitions() {
  assertConfigured();
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('competitions')
    .select(COMPETITION_SELECT)
    .eq('is_published', true)
    .eq('is_test', false)
    .gte('ends_at', cutoff)
    .order('starts_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  return data.map(flattenCompetition);
}

async function getPublishedCompetition(id) {
  assertConfigured();
  const { data, error } = await supabase
    .from('competitions')
    .select(COMPETITION_SELECT)
    .eq('id', id)
    .eq('is_published', true)
    .maybeSingle();
  if (error) throw error;
  return flattenCompetition(data);
}

async function hasEnteredCompetition(competitionId, playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('competition_entries')
    .select('player_id')
    .eq('competition_id', competitionId)
    .eq('player_id', playerId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function enterCompetition(competitionId, playerId) {
  assertConfigured();
  const { error } = await supabase.from('competition_entries').insert({ competition_id: competitionId, player_id: playerId });
  if (error) throw error;
}

async function incrementCompetitionClicks(id) {
  assertConfigured();
  const { error } = await supabase.rpc('increment_competition_clicks', { comp_id: id });
  if (error) throw error;
}

// ---- analytics (Battle Pass premium) -------------------------------------------

async function getAnalyticsWinRateByInstrument(playerId) {
  assertConfigured();
  const { data, error } = await supabase.from('trades').select('symbol, pnl').eq('player_id', playerId).not('pnl', 'is', null);
  if (error) throw error;
  const bySymbol = {};
  for (const t of data) {
    const s = (bySymbol[t.symbol] = bySymbol[t.symbol] || { symbol: t.symbol, trades: 0, wins: 0, totalPnl: 0 });
    s.trades += 1;
    if (Number(t.pnl) > 0) s.wins += 1;
    s.totalPnl += Number(t.pnl);
  }
  return Object.values(bySymbol)
    .map((s) => ({ ...s, winRate: Math.round((s.wins / s.trades) * 1000) / 10 }))
    .sort((a, b) => b.trades - a.trades);
}

async function getAnalyticsPnlByMode(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('match_players')
    .select('final_pnl, matches!inner(mode)')
    .eq('player_id', playerId)
    .not('final_pnl', 'is', null);
  if (error) throw error;
  const byMode = {};
  for (const row of data) {
    const m = (byMode[row.matches.mode] = byMode[row.matches.mode] || { mode: row.matches.mode, matches: 0, totalPnl: 0 });
    m.matches += 1;
    m.totalPnl += Number(row.final_pnl);
  }
  return Object.values(byMode).sort((a, b) => b.matches - a.matches);
}

async function getAnalyticsTimeOfDayHeatmap(playerId) {
  assertConfigured();
  const { data, error } = await supabase.from('trades').select('opened_at, pnl').eq('player_id', playerId).not('pnl', 'is', null);
  if (error) throw error;
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, trades: 0, wins: 0, totalPnl: 0 }));
  for (const t of data) {
    const hour = new Date(t.opened_at).getUTCHours();
    byHour[hour].trades += 1;
    if (Number(t.pnl) > 0) byHour[hour].wins += 1;
    byHour[hour].totalPnl += Number(t.pnl);
  }
  return byHour;
}

async function getAnalyticsCardSuccessRates(playerId) {
  assertConfigured();
  const [{ data: plays, error: playsErr }, { data: matchRows, error: matchErr }] = await Promise.all([
    supabase.from('sabotage_events').select('card_type, match_id').eq('player_id', playerId),
    supabase.from('match_players').select('match_id, final_rank').eq('player_id', playerId),
  ]);
  if (playsErr) throw playsErr;
  if (matchErr) throw matchErr;
  const winByMatch = new Map(matchRows.map((r) => [r.match_id, r.final_rank === 1]));
  const byCard = {};
  for (const p of plays) {
    const c = (byCard[p.card_type] = byCard[p.card_type] || { cardType: p.card_type, timesPlayed: 0, winsWhenPlayed: 0 });
    c.timesPlayed += 1;
    if (winByMatch.get(p.match_id)) c.winsWhenPlayed += 1;
  }
  return Object.values(byCard)
    .map((c) => ({ ...c, winRateWhenPlayed: Math.round((c.winsWhenPlayed / c.timesPlayed) * 1000) / 10 }))
    .sort((a, b) => b.timesPlayed - a.timesPlayed);
}

async function getAnalyticsPnlTrend(playerId, days = 30) {
  assertConfigured();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('match_players')
    .select('final_pnl, matches!inner(end_time)')
    .eq('player_id', playerId)
    .not('final_pnl', 'is', null)
    .gte('matches.end_time', since);
  if (error) throw error;
  const byDay = {};
  for (const row of data) {
    const day = row.matches.end_time.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + Number(row.final_pnl);
  }
  return Object.entries(byDay)
    .map(([day, pnl]) => ({ day, pnl: Math.round(pnl * 100) / 100 }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// ---- broker partners ----------------------------------------------------------

const BROKER_TIER_ORDER = { title: 0, official: 1, featured: 2 };

async function listBrokerPartners() {
  assertConfigured();
  const { data, error } = await supabase.from('broker_partners').select('*').eq('active', true);
  if (error) throw error;
  return data.sort((a, b) => (BROKER_TIER_ORDER[a.tier] ?? 9) - (BROKER_TIER_ORDER[b.tier] ?? 9));
}

// ---- shop / cosmetics -----------------------------------------------------

async function recordShopPurchase({ playerId, itemType, itemId, coinsSpent }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('shop_purchases')
    .insert({ player_id: playerId, item_type: itemType, item_id: itemId, coins_spent: coinsSpent })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function listShopPurchases(playerId) {
  assertConfigured();
  const { data, error } = await supabase.from('shop_purchases').select('*').eq('player_id', playerId);
  if (error) throw error;
  return data;
}

async function getEquippedCosmetics(playerId) {
  assertConfigured();
  const { data, error } = await supabase.from('equipped_cosmetics').select('*').eq('player_id', playerId);
  if (error) throw error;
  return data;
}

// Bulk variant for lists (friends panel, leaderboard) so rendering N players'
// cosmetics doesn't cost N separate queries. Returns { [playerId]: { avatar_frame, background, nameplate } }.
async function getEquippedCosmeticsForPlayers(playerIds) {
  assertConfigured();
  if (!playerIds || playerIds.length === 0) return {};
  const { data, error } = await supabase.from('equipped_cosmetics').select('*').in('player_id', playerIds);
  if (error) throw error;
  const byPlayer = {};
  for (const row of data) {
    if (!byPlayer[row.player_id]) byPlayer[row.player_id] = {};
    byPlayer[row.player_id][row.slot] = row.item_id;
  }
  return byPlayer;
}

async function equipCosmetic(playerId, slot, itemId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('equipped_cosmetics')
    .upsert({ player_id: playerId, slot, item_id: itemId, equipped_at: new Date().toISOString() }, { onConflict: 'player_id,slot' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Excludes obvious leftover QA/dev accounts from any public leaderboard -
// real accounts are never named this way, so this is safe defense-in-depth
// even after a one-time cleanup of existing rows (server/seedPersonas.js's
// persona accounts don't match any of these patterns).
function excludeTestAccounts(query) {
  return query
    .not('username', 'ilike', '%test%')
    .not('username', 'ilike', '%debug%')
    .not('username', 'ilike', '%iso%')
    .not('username', 'ilike', 'monitor%')
    .not('username', 'ilike', 'pclose%');
}

async function getLeaderboard(limit = 10, { search = null } = {}) {
  assertConfigured();
  let query = supabase
    .from('players')
    .select('id, username, war_rating, tier, wins, losses, draws, total_matches')
    .gt('total_matches', 0)
    .order('war_rating', { ascending: false });
  query = excludeTestAccounts(query);
  if (!(await showSeedAccounts())) query = query.eq('is_persona', false);
  if (search) query = query.ilike('username', `%${search}%`);
  query = query.limit(limit);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function getPeriodLeaderboard(sinceIso, limit = 500) {
  assertConfigured();
  const { data: ranked, error: rankError } = await supabase.rpc('period_leaderboard', {
    p_since: sinceIso,
    p_include_seeds: await showSeedAccounts(),
    p_limit: limit,
  });
  if (!rankError) {
    return ranked.map((r) => ({
      id: r.id,
      username: r.username,
      war_rating: r.war_rating,
      periodPnl: Number(r.period_pnl) || 0,
      periodMatches: Number(r.period_matches) || 0,
      periodTrades: Number(r.period_trades) || 0,
    }));
  }
  if (!isMissingFunction(rankError)) throw rankError;

  // Until the capacity migration has run.
  const { data, error } = await supabase
    .from('match_players')
    .select('player_id, final_pnl, trades_made, matches!inner(end_time), players!inner(username, war_rating, is_persona)')
    .gte('matches.end_time', sinceIso)
    .limit(1000);
  if (error) throw error;

  const TEST_ACCOUNT_PATTERN = /test|debug|iso/i;
  const hideSeeds = !(await showSeedAccounts());
  const byPlayer = new Map();
  for (const row of data) {
    if (hideSeeds && row.players.is_persona) continue;
    if (TEST_ACCOUNT_PATTERN.test(row.players.username) || /^(monitor|pclose)/i.test(row.players.username)) continue;
    const entry = byPlayer.get(row.player_id) || {
      id: row.player_id,
      username: row.players.username,
      war_rating: row.players.war_rating,
      periodPnl: 0,
      periodMatches: 0,
      periodTrades: 0,
    };
    entry.periodPnl += Number(row.final_pnl || 0);
    entry.periodMatches += 1;
    entry.periodTrades += row.trades_made || 0;
    byPlayer.set(row.player_id, entry);
  }
  return Array.from(byPlayer.values())
    .sort((a, b) => b.periodPnl - a.periodPnl)
    .slice(0, limit);
}

// ---- matches ------------------------------------------------------------

async function createMatch({ id, mode, roomCode, instrumentList }) {
  assertConfigured();
  const list = instrumentList || [];
  const { data, error } = await supabase
    .from('matches')
    .insert({
      id,
      mode,
      room_code: roomCode,
      instrument_1: list[0] || null,
      instrument_2: list[1] || null,
      instruments: list,
      status: 'waiting',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateMatch(id, fields) {
  assertConfigured();
  const { data, error } = await supabase.from('matches').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

async function getMatch(id) {
  assertConfigured();
  const { data, error } = await supabase.from('matches').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// ---- match_players --------------------------------------------------------

async function addMatchPlayer({ matchId, playerId }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('match_players')
    .insert({ match_id: matchId, player_id: playerId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateMatchPlayer(matchId, playerId, fields) {
  assertConfigured();
  const { data, error } = await supabase
    .from('match_players')
    .update(fields)
    .eq('match_id', matchId)
    .eq('player_id', playerId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getPlayerMatchHistory(playerId, limit = 10) {
  assertConfigured();
  const { data, error } = await supabase
    .from('match_players')
    .select('final_pnl, final_rank, cards_played, trades_made, rating_change, matches(id, mode, instrument_1, instrument_2, end_time)')
    .eq('player_id', playerId)
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// For each of the given matches, who else (besides excludePlayerId) played
// in it - powers the "who they played against" links on the profile page.
async function getMatchOpponents(matchIds, excludePlayerId) {
  assertConfigured();
  if (!matchIds.length) return {};
  const { data, error } = await supabase
    .from('match_players')
    .select('match_id, player_id, players(username)')
    .in('match_id', matchIds)
    .neq('player_id', excludePlayerId);
  if (error) throw error;
  const byMatch = {};
  for (const row of data) {
    (byMatch[row.match_id] = byMatch[row.match_id] || []).push({ id: row.player_id, username: row.players?.username });
  }
  return byMatch;
}

async function getBestMatchPnl(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('match_players')
    .select('final_pnl')
    .eq('player_id', playerId)
    .order('final_pnl', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? data.final_pnl : 0;
}

async function getPlayerTradeStats(playerId) {
  assertConfigured();
  const { data, error } = await supabase.from('trades').select('symbol').eq('player_id', playerId).limit(500);
  if (error) throw error;
  const counts = {};
  for (const row of data) counts[row.symbol] = (counts[row.symbol] || 0) + 1;
  const favouriteInstrument = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
  return { favouriteInstrument, totalTrades: data.length, counts };
}

// ---- trades ---------------------------------------------------------------

async function recordTrade({ matchId, playerId, symbol, direction, lots, entryPrice }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('trades')
    .insert({ match_id: matchId, player_id: playerId, symbol, direction, lots, entry_price: entryPrice })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function closeTrade(tradeId, { exitPrice, pnl }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('trades')
    .update({ exit_price: exitPrice, pnl, closed_at: new Date().toISOString() })
    .eq('id', tradeId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---- sabotage_events --------------------------------------------------------

async function recordSabotageEvent({ matchId, playerId, targetPlayerId, cardType, effectDuration }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('sabotage_events')
    .insert({
      match_id: matchId,
      player_id: playerId,
      target_player_id: targetPlayerId,
      card_type: cardType,
      effect_duration: effectDuration,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---- coin_purchases --------------------------------------------------------

// Buy a shop item once and pay once, atomically (audit Proof C).
// Returns { ok, balance } or { error: 'already_owned' | 'insufficient_coins' | 'player_not_found' }.
// Cheap readiness probe: one indexed row read.
async function ping() {
  assertConfigured();
  const { error } = await supabase.from('players').select('id', { head: true, count: 'exact' }).limit(1);
  if (error) throw error;
  return true;
}

async function shopBuy({ playerId, itemType, itemId, price }) {
  assertConfigured();
  const { data, error } = await supabase.rpc('shop_buy', { p_player: playerId, p_item_type: itemType, p_item_id: itemId, p_price: price });
  if (error) throw error;
  return data;
}

async function getCoinTransactions(playerId, limit = 50) {
  assertConfigured();
  const { data, error } = await supabase
    .from('coin_transactions')
    .select('id, type, amount, balance_after, match_id, created_at')
    .eq('player_id', playerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

async function getCoinsBreakdown(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('coin_transactions')
    .select('type, amount')
    .eq('player_id', playerId)
    .gt('amount', 0);
  if (error) throw error;
  let fromMatches = 0;
  let fromPurchases = 0;
  for (const row of data) {
    if (row.type === 'prize_won') fromMatches += row.amount;
    else if (row.type === 'coin_purchase') fromPurchases += row.amount;
  }
  return { fromMatches, fromPurchases };
}

// FIX: the home page's "Matches Today" used to come from gameEngine's
// in-memory `matches` Map, which prunes each match a few minutes after it
// ends (see the cleanup setTimeout in endMatch) - so the count quietly
// dropped back down/reset to 0 shortly after someone actually finished a
// match, even though it was correctly persisted here all along. This counts
// the real, permanent `matches` table instead, which only grows through
// the day.
async function getMatchesToday() {
  assertConfigured();
  const todayStart = dubaiDayStart();
  const { count, error } = await supabase
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', todayStart.toISOString());
  if (error) throw error;
  return count || 0;
}

// Prize coin credits since `sinceIso` (all time when null), seed accounts
// excluded unless show_seed_accounts is on. Everything here is coins.
async function listPrizeCredits(sinceIso = null) {
  assertConfigured();
  const hideSeeds = !(await showSeedAccounts());
  const rows = await fetchAllRows(() => {
    let query = supabase.from('coin_transactions').select('id, amount, players!inner(is_persona, username)').in('type', PRIZE_TX_TYPES).gt('amount', 0).order('id');
    if (sinceIso) query = query.gte('created_at', sinceIso);
    if (hideSeeds) query = query.eq('players.is_persona', false);
    return query;
  }, 50000);
  // Same test/QA account exclusions as the public leaderboard.
  return rows.filter((row) => !TEST_USERNAME_RE.test(row.players.username)).map((row) => Number(row.amount) || 0);
}

// Totals are worked out in the database; pulling every prize row would get slower
// each day. The row-by-row path only runs until the capacity migration has.
async function getPrizeStats(sinceIso = null) {
  assertConfigured();
  const { data, error } = await supabase.rpc('prize_stats', { p_since: sinceIso, p_include_seeds: await showSeedAccounts() });
  if (!error) return { total: Number(data?.[0]?.total) || 0, largest: Number(data?.[0]?.largest) || 0 };
  if (!isMissingFunction(error)) throw error;
  const credits = await listPrizeCredits(sinceIso);
  return { total: credits.reduce((sum, n) => sum + n, 0), largest: credits.reduce((max, n) => Math.max(max, n), 0) };
}

async function getCoinsWonToday() {
  return (await getPrizeStats(dubaiDayStart().toISOString())).total;
}

// Largest single prize credited today, in coins (never simulated-capital P&L).
async function getLargestWinToday() {
  return (await getPrizeStats(dubaiDayStart().toISOString())).largest;
}

// Lifetime total, unlike getCoinsWonToday() above which is scoped to today -
// used by the landing page's "Total Prizes Distributed" stat. Coins.
async function getTotalPrizesDistributed() {
  return (await getPrizeStats(null)).total;
}

// ---- sessions / login history --------------------------------------------------

async function createSession({ playerId, userAgent, ip }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('sessions')
    .insert({ player_id: playerId, user_agent: userAgent, ip })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getSession(id) {
  assertConfigured();
  const { data, error } = await supabase.from('sessions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function listSessions(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('player_id', playerId)
    .eq('revoked', false)
    .order('last_seen_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function touchSession(id) {
  assertConfigured();
  await supabase.from('sessions').update({ last_seen_at: new Date().toISOString() }).eq('id', id);
}

async function revokeSession(id, playerId) {
  assertConfigured();
  const { error } = await supabase.from('sessions').update({ revoked: true }).eq('id', id).eq('player_id', playerId);
  if (error) throw error;
}

async function recordLoginEvent({ playerId, ip, userAgent }) {
  assertConfigured();
  const { error } = await supabase.from('login_events').insert({ player_id: playerId, ip, user_agent: userAgent });
  if (error) throw error;
}

async function getLoginHistory(playerId, limit = 10) {
  assertConfigured();
  const { data, error } = await supabase
    .from('login_events')
    .select('ip, user_agent, created_at')
    .eq('player_id', playerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// ---- card decks / blocks --------------------------------------------------------

async function getCardDeck(playerId) {
  assertConfigured();
  const { data, error } = await supabase.from('card_decks').select('*').eq('player_id', playerId).maybeSingle();
  if (error) throw error;
  return data;
}

async function saveCardDeck(playerId, cardTypes) {
  assertConfigured();
  const { data, error } = await supabase
    .from('card_decks')
    .upsert({ player_id: playerId, card_types: cardTypes, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Upsert rather than insert - a double-click or retry on the results screen
// shouldn't 500 on the unique (rater_id, target_id, match_id) constraint,
// and switching a 👍 to a 👎 for the same match should just overwrite it.
async function rateTrader(raterId, targetId, matchId, rating) {
  assertConfigured();
  const { data, error } = await supabase
    .from('trader_ratings')
    .upsert({ rater_id: raterId, target_id: targetId, match_id: matchId, rating }, { onConflict: 'rater_id,target_id,match_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Admin-customizable email content (admin panel's Branding > Email Templates
// tab writes here) - returns null if nothing's been saved for this id yet,
// so callers fall back to their own hardcoded default copy.
async function getEmailTemplate(id) {
  assertConfigured();
  const { data, error } = await supabase.from('message_templates').select('subject, body_html').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function blockPlayer(playerId, blockedPlayerId) {
  assertConfigured();
  const { error } = await supabase.from('player_blocks').insert({ player_id: playerId, blocked_player_id: blockedPlayerId });
  if (error && error.code !== '23505') throw error; // ignore duplicate-block conflicts
}

async function unblockPlayer(playerId, blockedPlayerId) {
  assertConfigured();
  const { error } = await supabase
    .from('player_blocks')
    .delete()
    .eq('player_id', playerId)
    .eq('blocked_player_id', blockedPlayerId);
  if (error) throw error;
}

async function listBlockedPlayers(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('player_blocks')
    .select('blocked_player_id, created_at, players!player_blocks_blocked_player_id_fkey(username)')
    .eq('player_id', playerId);
  if (error) throw error;
  return data;
}

// ---- sabotage card stats -----------------------------------------------------------

async function getCardPlayStats(playerId) {
  assertConfigured();
  const [playedByMe, playedAgainstMe] = await Promise.all([
    supabase.from('sabotage_events').select('card_type').eq('player_id', playerId),
    supabase.from('sabotage_events').select('card_type').eq('target_player_id', playerId),
  ]);
  if (playedByMe.error) throw playedByMe.error;
  if (playedAgainstMe.error) throw playedAgainstMe.error;

  const countBy = (rows) => {
    const counts = {};
    for (const row of rows) counts[row.card_type] = (counts[row.card_type] || 0) + 1;
    return counts;
  };
  return { playedByMe: countBy(playedByMe.data), playedAgainstMe: countBy(playedAgainstMe.data) };
}

async function getTodayLoss(playerId) {
  assertConfigured();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('match_players')
    .select('final_pnl, matches!inner(end_time)')
    .eq('player_id', playerId)
    .gte('matches.end_time', todayStart.toISOString());
  if (error) throw error;
  const totalPnl = data.reduce((sum, row) => sum + Number(row.final_pnl || 0), 0);
  return totalPnl < 0 ? Math.abs(totalPnl) : 0;
}

async function getLifetimeMatchPnl(playerId) {
  assertConfigured();
  const { data, error } = await supabase.from('match_players').select('final_pnl').eq('player_id', playerId);
  if (error) throw error;
  return data.reduce((sum, row) => sum + Number(row.final_pnl || 0), 0);
}

// Public-facing (no auth required) - written by the admin panel's
// Communications > Announcements tab, read by the home page banner.
async function getActivePromoPopup() {
  assertConfigured();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('promotional_popups')
    .select('id, headline, subtext, button_text, button_url, gradient_from, gradient_to')
    .eq('active', true)
    .lte('active_from', nowIso)
    .or(`active_until.is.null,active_until.gte.${nowIso}`)
    .order('active_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getActiveAnnouncements(location = 'home') {
  assertConfigured();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('announcements')
    .select('id, title, message, type, display_location, show_until')
    .eq('active', true)
    .lte('show_from', nowIso)
    .or(`show_until.is.null,show_until.gte.${nowIso}`)
    .in('display_location', [location, 'both'])
    .order('show_from', { ascending: false });
  if (error) throw error;
  return data;
}

// ---- app settings (tournament unlock gate) --------------

async function getAppSetting(key) {
  assertConfigured();
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

async function getAppSettings(keys) {
  assertConfigured();
  const { data, error } = await supabase.from('app_settings').select('key, value').in('key', keys);
  if (error) throw error;
  const out = {};
  (data || []).forEach((row) => { out[row.key] = row.value; });
  return out;
}

async function getTotalPlayerCount() {
  assertConfigured();
  const { count, error } = await supabase.from('players').select('id', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
}

async function setAppSetting(key, value) {
  assertConfigured();
  const { data, error } = await supabase
    .from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---- player invite rewards ---------------------------------------------------
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily confused characters

async function getInviterByCode(code) {
  assertConfigured();
  const { data, error } = await supabase.from('player_invite_codes').select('player_id').eq('code', code).maybeSingle();
  if (error) throw error;
  return data ? data.player_id : null;
}

async function getOrCreateInviteCode(playerId) {
  assertConfigured();
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await supabase.from('player_invite_codes').select('code').eq('player_id', playerId).maybeSingle();
    if (error) throw error;
    if (data) return data.code;
    const code = Array.from(crypto.randomBytes(8), (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
    const { error: insertError } = await supabase.from('player_invite_codes').insert({ player_id: playerId, code });
    if (!insertError) return code;
    if (insertError.code !== '23505') throw insertError; // only a code clash or a double click is retried
  }
  throw new Error('Could not create an invite code');
}

async function createPlayerReferral({ inviterId, friendId }) {
  assertConfigured();
  const { error } = await supabase.from('player_referrals').insert({ inviter_id: inviterId, friend_id: friendId });
  if (error && error.code !== '23505') throw error;
}

async function getInviteStats(inviterId) {
  assertConfigured();
  const count = async (status) => {
    const { count: n, error } = await supabase.from('player_referrals').select('id', { count: 'exact', head: true }).eq('inviter_id', inviterId).eq('status', status);
    if (error) throw error;
    return n || 0;
  };
  const [paid, waiting] = await Promise.all([count('paid'), count('waiting')]);
  return { paid, waiting };
}

// Pays the friend's inviter once, inside one database transaction. Returns
// { paid: true, inviter } when coins moved, otherwise { paid: false }.
async function payPlayerReferral(friendId, matchId, coins, limit) {
  assertConfigured();
  const { data, error } = await supabase.rpc('pay_player_referral', { p_friend: friendId, p_match: matchId, p_coins: coins, p_limit: limit });
  if (error) throw error;
  return data;
}

// ---- referral / affiliate tracking ------------------------------------------

async function getReferralPartnerByCode(code) {
  assertConfigured();
  const { data, error } = await supabase.from('referral_partners').select('*').eq('referral_code', code).eq('status', 'active').maybeSingle();
  if (error) throw error;
  return data;
}

async function recordReferralClick({ partnerId, landingPath, ipHash, userAgent }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('referral_clicks')
    .insert({ partner_id: partnerId, landing_path: landingPath || null, ip_hash: ipHash || null, user_agent: userAgent || null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function createReferralConversion({ partnerId, playerId, clickId }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('referral_conversions')
    .insert({ partner_id: partnerId, player_id: playerId, click_id: clickId || null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---- long-form competitions: accounts, positions, settlement ----------------
// Everything a running competition needs lives in these tables (see
// server/compEngine.js) - nothing is held only in memory, so a server
// restart mid-competition loses nothing. The comp_* SQL functions do the
// money-moving steps atomically (fee once, close once, pay once).

async function getCompetitionById(id) {
  assertConfigured();
  const { data, error } = await supabase.from('competitions').select(COMPETITION_SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return flattenCompetition(data);
}

async function updateCompetition(id, fields) {
  assertConfigured();
  const { data, error } = await supabase.from('competitions').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// Moves a competition between statuses only if it's still in `fromStatus` -
// returns the row on success, null if another runner got there first.
async function transitionCompetition(id, fromStatus, fields) {
  assertConfigured();
  const { data, error } = await supabase.from('competitions').update(fields).eq('id', id).eq('status', fromStatus).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function createCompetitionRow(row) {
  assertConfigured();
  const { data, error } = await supabase.from('competitions').insert(row).select().single();
  if (error) throw error;
  return data;
}

async function listNativeCompetitionsByStatus(statuses) {
  assertConfigured();
  const { data, error } = await supabase.from('competitions').select('*').eq('type', 'native').in('status', statuses);
  if (error) throw error;
  return data;
}

async function listRecentWindowStarts(frequency, limit) {
  assertConfigured();
  const { data, error } = await supabase
    .from('competitions')
    .select('data_window_start')
    .eq('frequency', frequency)
    .not('data_window_start', 'is', null)
    .order('starts_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map((r) => r.data_window_start);
}

async function listCompetitionsByFrequency(frequency, since) {
  assertConfigured();
  const { data, error } = await supabase
    .from('competitions')
    .select('id, starts_at')
    .eq('frequency', frequency)
    .eq('is_test', false)
    .gte('starts_at', since);
  if (error) throw error;
  return data;
}

async function tryCompJobLock(name, holder, ttlSeconds) {
  assertConfigured();
  const { data, error } = await supabase.rpc('comp_try_lock', { p_name: name, p_holder: holder, p_ttl_seconds: ttlSeconds });
  if (error) throw error;
  return data === true;
}

async function compEnter(competitionId, playerId, fee, capital) {
  assertConfigured();
  const { data, error } = await supabase.rpc('comp_enter', { p_comp: competitionId, p_player: playerId, p_fee: fee, p_capital: capital });
  if (error) throw error;
  return data;
}

async function getCompAccount(competitionId, playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('comp_accounts')
    .select('*')
    .eq('competition_id', competitionId)
    .eq('player_id', playerId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getCompAccountById(id) {
  assertConfigured();
  const { data, error } = await supabase.from('comp_accounts').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function listCompAccounts(competitionId) {
  assertConfigured();
  return fetchAllRows(() =>
    supabase
      .from('comp_accounts')
      .select('*, player:players(username, avatar_url, country)')
      .eq('competition_id', competitionId)
      .order('id')
  );
}

async function listPlayerCompAccounts(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('comp_accounts')
    .select('*, competition:competitions(id, title, frequency, status, starts_at, ends_at, is_test)')
    .eq('player_id', playerId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

async function updateCompAccount(id, fields) {
  assertConfigured();
  const { error } = await supabase.from('comp_accounts').update(fields).eq('id', id);
  if (error) throw error;
}

// Flips an account out of 'active' exactly once (loss limit, disqualify).
async function lockCompAccount(id, fields) {
  assertConfigured();
  const { data, error } = await supabase.from('comp_accounts').update(fields).eq('id', id).eq('status', 'active').select().maybeSingle();
  if (error) throw error;
  return data;
}

async function incrementCompTradeCount(accountId) {
  const account = await getCompAccountById(accountId);
  if (account) await updateCompAccount(accountId, { trade_count: account.trade_count + 1 });
}

async function insertCompPosition(row) {
  assertConfigured();
  const { data, error } = await supabase.from('comp_positions').insert(row).select().single();
  if (error) throw error;
  return data;
}

async function getCompPosition(id) {
  assertConfigured();
  const { data, error } = await supabase.from('comp_positions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function listCompPositions(filter, { limit = 1000 } = {}) {
  assertConfigured();
  let query = supabase.from('comp_positions').select('*');
  for (const [key, value] of Object.entries(filter)) query = query.eq(key, value);
  const { data, error } = await query.order('opened_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

// Every open position in a competition, however many there are.
async function listOpenCompPositions(competitionId) {
  assertConfigured();
  return fetchAllRows(() => supabase.from('comp_positions').select('*').eq('competition_id', competitionId).eq('status', 'open').order('id'));
}

// One tick's equity results in a single write: [{id, equity, snapshot}].
async function compApplyTicks(rows) {
  assertConfigured();
  for (let i = 0; i < rows.length; i += COMP_WRITE_BATCH) {
    const batch = rows.slice(i, i + COMP_WRITE_BATCH);
    const { error } = await supabase.rpc('comp_apply_ticks', { p_rows: batch });
    if (!error) continue;
    if (!isMissingFunction(error)) throw error;
    // Database hasn't had the capacity migration yet.
    await runPool(batch, 8, async (row) => {
      const fields = { equity: row.equity };
      if (row.snapshot) {
        await insertCompEquitySnapshot(row.id, row.equity);
        fields.last_snapshot_at = new Date().toISOString();
      }
      await updateCompAccount(row.id, fields);
    });
  }
}

async function updateCompPosition(id, fields) {
  assertConfigured();
  const { data, error } = await supabase.from('comp_positions').update(fields).eq('id', id).eq('status', 'open').select().maybeSingle();
  if (error) throw error;
  return data;
}

async function compClosePosition(positionId, exitPrice, reason, pnl) {
  assertConfigured();
  const { data, error } = await supabase.rpc('comp_close_position', { p_position: positionId, p_exit: exitPrice, p_reason: reason, p_pnl: pnl });
  if (error) throw error;
  return data === true;
}

async function compPayPrize(accountId) {
  assertConfigured();
  const { data, error } = await supabase.rpc('comp_pay_prize', { p_account: accountId });
  if (error) throw error;
  return data === true;
}

async function compRefundEntry(accountId, fee) {
  assertConfigured();
  const { data, error } = await supabase.rpc('comp_refund_entry', { p_account: accountId, p_fee: fee });
  if (error) throw error;
  return data === true;
}

async function insertCompEquitySnapshot(accountId, equity) {
  assertConfigured();
  const { error } = await supabase.from('comp_equity_snapshots').insert({ account_id: accountId, equity });
  if (error) throw error;
}

async function listCompEquitySnapshots(accountId) {
  assertConfigured();
  const { data, error } = await supabase.from('comp_equity_snapshots').select('ts, equity').eq('account_id', accountId).order('ts').limit(2000);
  if (error) throw error;
  return data;
}

// ---- prize claims (closed; records only) --------------------------------------
// Coins have no cash value, so no new claims are created. Old rows are still
// readable for a player's history.

async function listPlayerPrizeClaims(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('prize_claims')
    .select('*, tournaments(name), competitions(title)')
    .eq('player_id', playerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ---- support tickets ---------------------------------------------------------

async function createSupportTicket({ playerId, subject, message }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('support_tickets')
    .insert({ player_id: playerId || null, subject, message })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function listPlayerSupportTickets(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('support_tickets')
    .select('*')
    .eq('player_id', playerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ---- sponsors + lobby settings -------------------------------------------------
// Public reads only ever return sponsors that are status 'active' and inside
// their starts_at/ends_at window. Writes happen in the admin panel.

const SPONSOR_TIER_ORDER = { platinum: 0, gold: 1, silver: 2, partner: 3 };

function sponsorIsLive(s, now = Date.now()) {
  return (
    s &&
    s.status === 'active' &&
    (!s.starts_at || new Date(s.starts_at).getTime() <= now) &&
    (!s.ends_at || new Date(s.ends_at).getTime() > now)
  );
}

async function listActiveSponsors({ placement, target = null } = {}) {
  assertConfigured();
  let query = supabase
    .from('sponsor_placements')
    .select('placement, target_id, sort_order, sponsor:sponsors!inner(id, name, logo_url, link_url, tier, status, starts_at, ends_at)')
    .eq('active', true)
    .eq('sponsor.status', 'active');
  if (placement) query = query.eq('placement', placement);
  if (target) query = query.eq('target_id', String(target));
  const { data, error } = await query.limit(200);
  if (error) throw error;
  const seen = new Set();
  return data
    .filter((row) => sponsorIsLive(row.sponsor))
    .sort((a, b) => (SPONSOR_TIER_ORDER[a.sponsor.tier] ?? 9) - (SPONSOR_TIER_ORDER[b.sponsor.tier] ?? 9) || a.sort_order - b.sort_order)
    .filter((row) => {
      const key = `${row.sponsor.id}:${row.placement}:${row.target_id || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => ({
      id: row.sponsor.id,
      name: row.sponsor.name,
      logoUrl: row.sponsor.logo_url,
      tier: row.sponsor.tier,
      placement: row.placement,
      targetId: row.target_id,
    }));
}

// Only a live sponsor can be clicked through - a paused/ended one 404s.
async function getLiveSponsor(id) {
  assertConfigured();
  const { data, error } = await supabase.from('sponsors').select('id, name, link_url, status, starts_at, ends_at').eq('id', id).maybeSingle();
  if (error) throw error;
  return sponsorIsLive(data) ? data : null;
}

async function recordSponsorClick({ sponsorId, placement, targetId, userId, ipHash }) {
  assertConfigured();
  const { error } = await supabase
    .from('sponsor_clicks')
    .insert({ sponsor_id: sponsorId, placement, target_id: targetId, user_id: userId, ip_hash: ipHash });
  if (error) throw error;
}

async function bumpSponsorImpression({ sponsorId, placement, day, count = 1 }) {
  assertConfigured();
  const { error } = await supabase.rpc('sponsor_impression_bump', { p_sponsor: sponsorId, p_placement: placement, p_day: day, p_n: count });
  if (error) throw error;
}

async function countRecentSponsorLeads(ipHash, sinceIso) {
  assertConfigured();
  const { count, error } = await supabase
    .from('sponsor_leads')
    .select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash)
    .gte('created_at', sinceIso);
  if (error) throw error;
  return count || 0;
}

async function createSponsorLead(lead) {
  assertConfigured();
  const { data, error } = await supabase.from('sponsor_leads').insert(lead).select('id, created_at').single();
  if (error) throw error;
  return data;
}

// ---- lost match recovery (server/matchRecovery.js) and data retention ----------

async function listOpenMatches() {
  assertConfigured();
  const { data, error } = await supabase
    .from('matches')
    .select('id, mode, status, created_at, start_time')
    .in('status', ['waiting', 'active'])
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  return data;
}

async function listMatchLedger(matchId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('coin_transactions')
    .select('id, player_id, type, amount')
    .eq('match_id', matchId)
    .in('type', ['match_entry', 'match_refund'])
    .order('created_at');
  if (error) throw error;
  return data;
}

async function listHumanMatchPlayerIds(matchId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('match_players')
    .select('player_id, players!inner(is_persona)')
    .eq('match_id', matchId)
    .eq('players.is_persona', false);
  if (error) throw error;
  return data.map((row) => row.player_id);
}

// An entry fee is charged before the match it pays for exists. This ties the
// ledger row to the match, which is what lets a lost match be refunded correctly.
async function linkEntryToMatch(idempotencyKey, matchId) {
  assertConfigured();
  const { error } = await supabase.from('coin_transactions').update({ match_id: matchId }).eq('idempotency_key', idempotencyKey);
  if (error) throw error;
}

// Deletes rows older than a date, in small rounds so a big backlog can't hold the
// table up. Returns how many went.
async function deleteOlderThan(table, column, beforeIso, { extra = null, idColumn = 'id', rounds = 20, batch = 500 } = {}) {
  assertConfigured();
  let total = 0;
  for (let round = 0; round < rounds; round++) {
    let select = supabase.from(table).select(idColumn).lt(column, beforeIso).limit(batch);
    if (extra) select = extra(select);
    const { data, error } = await select;
    if (error) throw error;
    if (!data.length) break;
    const { error: delError } = await supabase.from(table).delete().in(idColumn, data.map((row) => row[idColumn]));
    if (delError) throw delError;
    total += data.length;
    if (data.length < batch) break;
  }
  return total;
}

// Equity curves of competitions that ended long ago.
async function pruneEndedCompSnapshots(beforeIso, { competitions = 20 } = {}) {
  assertConfigured();
  const { data: comps, error } = await supabase
    .from('competitions')
    .select('id')
    .not('settled_at', 'is', null)
    .lt('settled_at', beforeIso)
    .limit(competitions);
  if (error) throw error;
  let total = 0;
  for (const comp of comps) {
    const accounts = await fetchAllRows(() => supabase.from('comp_accounts').select('id').eq('competition_id', comp.id).order('id'));
    for (let i = 0; i < accounts.length; i += 200) {
      const { error: delError, count } = await supabase
        .from('comp_equity_snapshots')
        .delete({ count: 'exact' })
        .in('account_id', accounts.slice(i, i + 200).map((a) => a.id));
      if (delError) throw delError;
      total += count || 0;
    }
  }
  return total;
}

const LOBBY_SETTING_KEYS = ['show_seed_accounts', 'lobby_empty_message', 'featured_competition_id', 'season_label'];
async function getLobbySettings() {
  const raw = await getAppSettings(LOBBY_SETTING_KEYS);
  return {
    showSeedAccounts: raw.show_seed_accounts === true,
    emptyMessage: typeof raw.lobby_empty_message === 'string' && raw.lobby_empty_message.trim()
      ? raw.lobby_empty_message
      : 'Season 1 is live. Be one of the first traders on the board.',
    featuredCompetitionId: typeof raw.featured_competition_id === 'string' ? raw.featured_competition_id : null,
    seasonLabel: typeof raw.season_label === 'string' ? raw.season_label : 'Season 1',
  };
}

// ---- fire gameplay (supabase/migrations/20261110120000_fire_gameplay.sql) ----
//
// Every function here degrades gracefully when its table doesn't exist yet
// (the migration is applied separately per environment): reads return null or
// empty, writes return null, and the game falls back to what it can derive
// from the players row (server/progression.js historyXp). A missing table is
// reported once per process, not on every call.

const missingTables = new Set();
function fireTableMissing(table, error) {
  if (!error) return false;
  const missing = error.code === '42P01' || error.code === 'PGRST205' || /does not exist|Could not find the table/i.test(error.message || '');
  if (missing && !missingTables.has(table)) {
    missingTables.add(table);
    console.warn(`[database] ${table} not found - apply supabase/migrations/20261110120000_fire_gameplay.sql (feature falls back until then)`);
  }
  return missing;
}

function fireTablesStatus() {
  return { missing: Array.from(missingTables) };
}

// Coins of one ledger type credited today (UTC) - the per-day mission cap.
async function coinsOfTypeToday(playerId, type) {
  assertConfigured();
  const since = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const { data, error } = await supabase.from('coin_transactions').select('amount').eq('player_id', playerId).eq('type', type).gte('created_at', since).limit(1000);
  if (error) throw error;
  return (data || []).reduce((s, r) => s + Math.max(0, Number(r.amount) || 0), 0);
}

async function getProgress(playerId) {
  if (!isConfigured) return null;
  const { data, error } = await supabase.from('player_progress').select('*').eq('player_id', playerId).maybeSingle();
  if (fireTableMissing('player_progress', error)) return null;
  if (error) throw error;
  return data || null;
}

// Adds XP once per idempotency key, never below `floorXp` (the player's
// history XP), tracks the per-day counter and best stats. Returns the new
// progress row, or null when the tables don't exist yet.
async function awardXp(playerId, { matchId, amount, key, bestStreak = 0, bestHeat = 0, qualifyingWins = 0, floorXp = 0 }) {
  if (!isConfigured) return null;
  const ev = await supabase.from('xp_events').insert({ player_id: playerId, match_id: matchId, source: 'match', amount, idempotency_key: key });
  if (fireTableMissing('xp_events', ev.error)) return null;
  const duplicate = ev.error && (ev.error.code === '23505' || /duplicate key/i.test(ev.error.message || ''));
  if (ev.error && !duplicate) throw ev.error;
  const current = await getProgress(playerId);
  if (duplicate) return current;
  const day = new Date().toISOString().slice(0, 10);
  const base = Math.max(Number(current?.xp) || 0, floorXp);
  const xp = base + amount;
  const row = {
    player_id: playerId,
    xp,
    level: require('./progression').levelForXp(xp),
    xp_day: day,
    xp_today: (current && current.xp_day === day ? current.xp_today : 0) + amount,
    best_streak: Math.max(Number(current?.best_streak) || 0, bestStreak),
    best_heat: Math.max(Number(current?.best_heat) || 0, bestHeat),
    qualifying_wins: (Number(current?.qualifying_wins) || 0) + qualifyingWins,
    season: require('./progression').season(),
    season_xp: (current && current.season === require('./progression').season() ? current.season_xp : 0) + amount,
    migrated_at: current?.migrated_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('player_progress').upsert(row).select().maybeSingle();
  if (fireTableMissing('player_progress', error)) return null;
  if (error) throw error;
  return data;
}

// Admin grants/revokes on top of the level rules. Revokes are stored as
// source 'admin' with reason starting "revoke:" so one table holds both.
async function getCardGrants(playerId) {
  if (!isConfigured) return { granted: [], revoked: [] };
  const { data, error } = await supabase.from('player_card_unlocks').select('card_id, source, reason').eq('player_id', playerId);
  if (fireTableMissing('player_card_unlocks', error)) return { granted: [], revoked: [] };
  if (error) throw error;
  const rows = data || [];
  return {
    granted: rows.filter((r) => !(r.reason || '').startsWith('revoke:')).map((r) => r.card_id),
    revoked: rows.filter((r) => (r.reason || '').startsWith('revoke:')).map((r) => r.card_id),
  };
}

async function setCardGrant(playerId, cardId, { revoke = false, reason = '' } = {}) {
  assertConfigured();
  const { error } = await supabase.from('player_card_unlocks').upsert({ player_id: playerId, card_id: cardId, source: 'admin', reason: `${revoke ? 'revoke:' : 'grant:'}${reason}`.slice(0, 500) });
  if (fireTableMissing('player_card_unlocks', error)) throw new Error('player_card_unlocks table missing - apply the fire_gameplay migration first');
  if (error) throw error;
  return true;
}

// Discover: accepted friends of many players at once -> Map(id -> Set(friendIds)).
async function listFriendIdsForMany(ids) {
  assertConfigured();
  const out = new Map(ids.map((id) => [id, new Set()]));
  if (!ids.length) return out;
  const list = ids.join(',');
  const { data, error } = await supabase
    .from('friendships')
    .select('requester_id, addressee_id')
    .eq('status', 'accepted')
    .or(`requester_id.in.(${list}),addressee_id.in.(${list})`)
    .limit(20000);
  if (error) throw error;
  for (const f of data || []) {
    if (out.has(f.requester_id)) out.get(f.requester_id).add(f.addressee_id);
    if (out.has(f.addressee_id)) out.get(f.addressee_id).add(f.requester_id);
  }
  return out;
}

// Discover: real players this player shared a match with recently.
async function listRecentCoPlayers(playerId, matches = 20) {
  assertConfigured();
  const mine = await supabase.from('match_players').select('match_id').eq('player_id', playerId).limit(matches);
  if (mine.error) throw mine.error;
  const ids = (mine.data || []).map((r) => r.match_id);
  if (!ids.length) return [];
  const { data, error } = await supabase.from('match_players').select('player_id').in('match_id', ids).neq('player_id', playerId).limit(500);
  if (error) throw error;
  return [...new Set((data || []).map((r) => r.player_id))];
}

// Discover suggestions: the modes each player played recently and the UTC
// hours they usually play at, from their real match history.
async function listPlayHabits(ids, perPlayer = 20) {
  assertConfigured();
  const out = new Map(ids.map((id) => [id, { modes: new Set(), hours: new Set() }]));
  if (!ids.length) return out;
  const { data, error } = await supabase
    .from('match_players')
    .select('player_id, matches!inner(mode, created_at)')
    .in('player_id', ids)
    .order('created_at', { foreignTable: 'matches', ascending: false })
    .limit(Math.min(5000, ids.length * perPlayer));
  if (error) throw error;
  for (const r of data || []) {
    const h = out.get(r.player_id);
    if (!h || !r.matches) continue;
    if (r.matches.mode) h.modes.add(r.matches.mode);
    if (r.matches.created_at) h.hours.add(new Date(r.matches.created_at).getUTCHours());
  }
  return out;
}

// A player's report goes to the existing moderation queue (admin "reports").
async function createPlayerReport({ reporterId, reportedId, reason, matchId = null }) {
  assertConfigured();
  const { error } = await supabase.from('player_reports').insert({ reporter_id: reporterId, reported_player_id: reportedId, reason: String(reason).slice(0, 60), match_id: matchId, status: 'open' });
  if (error) throw error;
  return true;
}

// Admin config stored by the admin panel (game_config table, key/value).
async function getGameConfig(key) {
  if (!isConfigured) return null;
  const { data, error } = await supabase.from('game_config').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

// Unlock-rate report: real players' match history (personas excluded).
async function listPlayersForUnlockReport(limit = 50000) {
  assertConfigured();
  const { data, error } = await supabase.from('players').select('total_matches, wins').eq('is_persona', false).limit(limit);
  if (error) throw error;
  return data || [];
}

async function recordMarketStats(row) {
  if (!isConfigured) return null;
  const { error } = await supabase.from('match_market_stats').upsert(row, { onConflict: 'match_id,symbol' });
  if (fireTableMissing('match_market_stats', error)) return null;
  if (error) throw error;
  return true;
}

async function listMarketStats(sinceIso) {
  if (!isConfigured) return null;
  const { data, error } = await supabase.from('match_market_stats').select('*').gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(5000);
  if (fireTableMissing('match_market_stats', error)) return null;
  if (error) throw error;
  return data || [];
}

module.exports = {
  isConfigured,
  fetchWithTimeout,
  coinsOfTypeToday,
  getProgress,
  awardXp,
  getCardGrants,
  setCardGrant,
  recordMarketStats,
  listFriendIdsForMany,
  listPlayHabits,
  getGameConfig,
  listPlayersForUnlockReport,
  listRecentCoPlayers,
  createPlayerReport,
  listMarketStats,
  fireTablesStatus,
  createPlayer,
  getPlayerByUsername,
  getPlayerByEmail,
  getPlayerById,
  getPlayerBySupabaseUserId,
  updatePlayer,
  creditCoins,
  debitCoins,
  getLeaderboard,
  recordShopPurchase,
  listShopPurchases,
  getEquippedCosmetics,
  getEquippedCosmeticsForPlayers,
  equipCosmetic,
  getBattlePassStatus,
  ensureBattlePassStatus,
  addBattlePassXp,
  listCompletedChallenges,
  recordChallengeCompletion,
  getBattlePassChallengeStats,
  getRecentActivity,
  getHotStreaks,
  getMatchOpponents,
  getPlayerWinStreak,
  getPlayerWinRateSince,
  getAsyncResultToday,
  recordAsyncResult,
  getAsyncLeaderboardToday,
  getFriendshipBetween,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
  listFriends,
  listFriendIds,
  listIncomingRequests,
  listOutgoingRequests,
  searchPlayers,
  getPlayersForFriendsPanel,
  listFriendshipRows,
  cancelFriendRequest,
  removeFriendshipBetween,
  listBlockRelationIds,
  createNotification,
  listNotifications,
  countUnreadNotifications,
  markNotificationsRead,
  markFriendRequestNotificationRead,
  deleteAllNotifications,
  upsertPresence,
  createReplay,
  getReplay,
  createClip,
  getClip,
  incrementClipShareCount,
  createTournament,
  listTournaments,
  getTournament,
  updateTournament,
  listTournamentRegistrations,
  registerForTournament,
  updateTournamentRegistration,
  listPublishedCompetitions,
  getPublishedCompetition,
  hasEnteredCompetition,
  enterCompetition,
  incrementCompetitionClicks,
  getAnalyticsWinRateByInstrument,
  getAnalyticsPnlByMode,
  getAnalyticsTimeOfDayHeatmap,
  getAnalyticsCardSuccessRates,
  getAnalyticsPnlTrend,
  listBrokerPartners,
  createMatch,
  updateMatch,
  getMatch,
  addMatchPlayer,
  updateMatchPlayer,
  getPlayerMatchHistory,
  getBestMatchPnl,
  getPlayerTradeStats,
  recordTrade,
  closeTrade,
  recordSabotageEvent,
  shopBuy,
  ping,
  applyCoins,
  recordCoinTransaction,
  getCoinTransactions,
  getCoinsWonToday,
  getCoinsBreakdown,
  getMatchesToday,
  getLargestWinToday,
  getTotalPrizesDistributed,
  createSession,
  getSession,
  listSessions,
  touchSession,
  revokeSession,
  recordLoginEvent,
  getLoginHistory,
  getCardDeck,
  saveCardDeck,
  getEmailTemplate,
  blockPlayer,
  unblockPlayer,
  listBlockedPlayers,
  rateTrader,
  getCardPlayStats,
  getTodayLoss,
  getLifetimeMatchPnl,
  getActiveAnnouncements,
  getAppSetting,
  getAppSettings,
  setAppSetting,
  getTotalPlayerCount,
  getInviterByCode,
  getOrCreateInviteCode,
  createPlayerReferral,
  getInviteStats,
  payPlayerReferral,
  getReferralPartnerByCode,
  recordReferralClick,
  createReferralConversion,
  getCompetitionById,
  updateCompetition,
  transitionCompetition,
  createCompetitionRow,
  listNativeCompetitionsByStatus,
  listRecentWindowStarts,
  listCompetitionsByFrequency,
  tryCompJobLock,
  compEnter,
  getCompAccount,
  getCompAccountById,
  listCompAccounts,
  listPlayerCompAccounts,
  updateCompAccount,
  lockCompAccount,
  incrementCompTradeCount,
  insertCompPosition,
  getCompPosition,
  fetchAllRows,
  listCompPositions,
  listOpenCompPositions,
  compApplyTicks,
  listOpenMatches,
  listMatchLedger,
  listHumanMatchPlayerIds,
  linkEntryToMatch,
  deleteOlderThan,
  pruneEndedCompSnapshots,
  updateCompPosition,
  compClosePosition,
  compPayPrize,
  compRefundEntry,
  insertCompEquitySnapshot,
  listCompEquitySnapshots,
  listPlayerPrizeClaims,
  createSupportTicket,
  listPlayerSupportTickets,
  getActivePromoPopup,
  getPeriodLeaderboard,
  deletePlayer,
  showSeedAccounts,
  dubaiDayStart,
  listActiveSponsors,
  getLiveSponsor,
  recordSponsorClick,
  bumpSponsorImpression,
  countRecentSponsorLeads,
  createSponsorLead,
  getLobbySettings,
};
