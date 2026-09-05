'use strict';

const { createClient } = require('@supabase/supabase-js');

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
const supabase = isConfigured ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

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

async function creditCoins(id, amount, { type = 'prize_won', matchId = null } = {}) {
  assertConfigured();
  const player = await getPlayerById(id);
  if (!player) throw new Error('Player not found');
  const newBalance = player.coins + amount;
  const updated = await updatePlayer(id, {
    coins: newBalance,
    coins_earned_total: (player.coins_earned_total || 0) + amount,
  });
  await recordCoinTransaction({ playerId: id, type, amount, balanceAfter: newBalance, matchId });
  return updated;
}

async function debitCoins(id, amount, { type = 'match_entry', matchId = null } = {}) {
  assertConfigured();
  const player = await getPlayerById(id);
  if (!player) throw new Error('Player not found');
  if (player.coins < amount) {
    const err = new Error('Insufficient coins');
    err.code = 'INSUFFICIENT_COINS';
    throw err;
  }
  const newBalance = player.coins - amount;
  const updated = await updatePlayer(id, {
    coins: newBalance,
    coins_spent_total: (player.coins_spent_total || 0) + amount,
  });
  await recordCoinTransaction({ playerId: id, type, amount: -amount, balanceAfter: newBalance, matchId });
  return updated;
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

async function setBattlePassPremium(playerId, season, { stripeSubscriptionId, expiresAt }) {
  assertConfigured();
  const status = await ensureBattlePassStatus(playerId, season);
  const { data, error } = await supabase
    .from('battle_pass_subscriptions')
    .update({ is_premium: true, stripe_subscription_id: stripeSubscriptionId, expires_at: expiresAt })
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
    .select('card_type, played_at')
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

async function getRecentActivity(limit = 15) {
  assertConfigured();
  const { data, error } = await supabase
    .from('matches')
    .select('id, mode, end_time, winner_id, winner:winner_id(username)')
    .eq('status', 'finished')
    .not('winner_id', 'is', null)
    .order('end_time', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map((m) => ({
    matchId: m.id,
    mode: m.mode,
    endTime: m.end_time,
    winnerUsername: m.winner?.username || 'Unknown',
  }));
}

// Streaks aren't a stored column, so this walks each player's most recent
// finished matches (already time-ordered from the query) and counts
// consecutive wins from the front - cheap enough at this data volume, and
// avoids adding a denormalized streak counter that could drift out of sync.
async function getHotStreaks(limit = 5) {
  assertConfigured();
  const { data, error } = await supabase
    .from('match_players')
    .select('player_id, final_rank, matches!inner(end_time, status), players!inner(username, war_rating)')
    .eq('matches.status', 'finished')
    .order('end_time', { foreignTable: 'matches', ascending: false })
    .limit(500);
  if (error) throw error;

  const byPlayer = new Map();
  for (const row of data) {
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
    .select('*, requester:requester_id(id, username, avatar_url, war_rating, tier), addressee:addressee_id(id, username, avatar_url, war_rating, tier)')
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
    .select('id, username, avatar_url, war_rating, tier')
    .ilike('username', `%${query}%`)
    .neq('id', excludePlayerId)
    .eq('is_persona', false)
    .limit(limit);
  if (error) throw error;
  return data;
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

// ---- coaching ---------------------------------------------------------------

async function listCoaches() {
  assertConfigured();
  const { data, error } = await supabase
    .from('players')
    .select('id, username, avatar_url, war_rating, tier, coaching_rate_aed, coaching_bio')
    .eq('coaching_enabled', true)
    .order('war_rating', { ascending: false });
  if (error) throw error;
  return data;
}

async function setCoachingProfile(playerId, { enabled, rateAed, bio }) {
  assertConfigured();
  const fields = { coaching_enabled: enabled };
  if (rateAed !== undefined) fields.coaching_rate_aed = rateAed;
  if (bio !== undefined) fields.coaching_bio = bio;
  return updatePlayer(playerId, fields);
}

async function createCoachingSession({ coachId, studentId, sessionType, priceAed, durationMinutes, scheduledAt }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('coaching_sessions')
    .insert({
      coach_id: coachId,
      student_id: studentId,
      session_type: sessionType,
      price_aed: priceAed,
      duration_minutes: durationMinutes,
      scheduled_at: scheduledAt,
      status: 'pending_payment',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateCoachingSession(id, fields) {
  assertConfigured();
  const { data, error } = await supabase.from('coaching_sessions').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

async function getCoachingSession(id) {
  assertConfigured();
  const { data, error } = await supabase.from('coaching_sessions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function listCoachingSessionsFor(playerId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('coaching_sessions')
    .select('*')
    .or(`coach_id.eq.${playerId},student_id.eq.${playerId}`)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function getCoachRatingSummary(coachId) {
  assertConfigured();
  const { data, error } = await supabase
    .from('coaching_sessions')
    .select('rating')
    .eq('coach_id', coachId)
    .not('rating', 'is', null);
  if (error) throw error;
  if (!data.length) return { avgRating: null, count: 0 };
  const avgRating = data.reduce((sum, r) => sum + r.rating, 0) / data.length;
  return { avgRating: Math.round(avgRating * 10) / 10, count: data.length };
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
  if (search) query = query.ilike('username', `%${search}%`);
  query = query.limit(limit);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function getPeriodLeaderboard(sinceIso, limit = 500) {
  assertConfigured();
  const { data, error } = await supabase
    .from('match_players')
    .select('player_id, final_pnl, trades_made, matches!inner(end_time), players!inner(username, war_rating)')
    .gte('matches.end_time', sinceIso)
    .limit(5000);
  if (error) throw error;

  const TEST_ACCOUNT_PATTERN = /test|debug|iso/i;
  const byPlayer = new Map();
  for (const row of data) {
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

async function recordCoinPurchase({ playerId, packageCoins, amountUsd, stripeSessionId, status = 'pending' }) {
  assertConfigured();
  const { data, error } = await supabase
    .from('coin_purchases')
    .insert({
      player_id: playerId,
      package_coins: packageCoins,
      amount_usd: amountUsd,
      stripe_session_id: stripeSessionId,
      status,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function completeCoinPurchase(stripeSessionId) {
  assertConfigured();
  const { data: purchase, error: findErr } = await supabase
    .from('coin_purchases')
    .select('*')
    .eq('stripe_session_id', stripeSessionId)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!purchase || purchase.status === 'completed') return purchase;

  await supabase.from('coin_purchases').update({ status: 'completed' }).eq('id', purchase.id);
  await creditCoins(purchase.player_id, purchase.package_coins, { type: 'coin_purchase' });
  return purchase;
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
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', todayStart.toISOString());
  if (error) throw error;
  return count || 0;
}

async function getCoinsWonToday() {
  assertConfigured();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('coin_transactions')
    .select('amount')
    .eq('type', 'prize_won')
    .gte('created_at', todayStart.toISOString());
  if (error) throw error;
  return data.reduce((sum, row) => sum + row.amount, 0);
}

async function getLargestWinToday() {
  assertConfigured();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('match_players')
    .select('final_pnl, matches!inner(end_time)')
    .gte('matches.end_time', todayStart.toISOString())
    .order('final_pnl', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data.length ? Number(data[0].final_pnl) : 0;
}

// Lifetime total, unlike getCoinsWonToday() above which is scoped to today -
// used by the landing page's "Total Prizes Distributed" stat.
async function getTotalPrizesDistributed() {
  assertConfigured();
  const { data, error } = await supabase.from('coin_transactions').select('amount').eq('type', 'prize_won');
  if (error) throw error;
  return data.reduce((sum, row) => sum + row.amount, 0);
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

module.exports = {
  isConfigured,
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
  setBattlePassPremium,
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
  createNotification,
  listNotifications,
  countUnreadNotifications,
  markNotificationsRead,
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
  getAnalyticsWinRateByInstrument,
  getAnalyticsPnlByMode,
  getAnalyticsTimeOfDayHeatmap,
  getAnalyticsCardSuccessRates,
  getAnalyticsPnlTrend,
  listBrokerPartners,
  listCoaches,
  setCoachingProfile,
  createCoachingSession,
  updateCoachingSession,
  getCoachingSession,
  listCoachingSessionsFor,
  getCoachRatingSummary,
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
  recordCoinPurchase,
  completeCoinPurchase,
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
  blockPlayer,
  unblockPlayer,
  listBlockedPlayers,
  getCardPlayStats,
  getTodayLoss,
  getLifetimeMatchPnl,
  getActiveAnnouncements,
  getActivePromoPopup,
  getPeriodLeaderboard,
  deletePlayer,
};
