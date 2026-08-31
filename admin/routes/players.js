'use strict';

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const internal = require('../lib/internalGameServer');

const PLAYER_LIST_FIELDS =
  'id, username, email, avatar_url, tier, war_rating, coins, coins_earned_total, total_matches, wins, losses, draws, created_at, country, is_banned, banned_until, ban_reason, flagged, supabase_user_id';

async function computeRevenueByPlayer(playerIds) {
  if (!playerIds.length) return {};
  const { data } = await supabase.from('coin_purchases').select('player_id, amount_usd').eq('status', 'completed').in('player_id', playerIds);
  const out = {};
  (data || []).forEach((r) => { out[r.player_id] = (out[r.player_id] || 0) + Number(r.amount_usd || 0); });
  return out;
}

function router() {
  const r = express.Router();

  r.get('/', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const { data: players, error } = await supabase.from('players').select(PLAYER_LIST_FIELDS).order('created_at', { ascending: false }).limit(2000);
      if (error) throw error;
      const ids = players.map((p) => p.id);
      const [presenceRes, revenueByPlayer] = await Promise.all([
        supabase.from('player_presence').select('player_id, status, updated_at').in('player_id', ids),
        computeRevenueByPlayer(ids),
      ]);
      const freshSince = Date.now() - 3 * 60 * 1000;
      const presenceById = {};
      (presenceRes.data || []).forEach((p) => { presenceById[p.player_id] = p; });

      const rows = players.map((p) => {
        const presence = presenceById[p.id];
        const isFresh = presence && new Date(presence.updated_at).getTime() > freshSince;
        let status = 'offline';
        if (p.is_banned) status = 'banned';
        else if (p.flagged) status = 'flagged';
        else if (isFresh && presence.status !== 'offline') status = presence.status;
        const totalDecided = p.wins + p.losses;
        return {
          ...p,
          status,
          winRate: totalDecided > 0 ? Math.round((p.wins / totalDecided) * 1000) / 10 : 0,
          revenue: Math.round((revenueByPlayer[p.id] || 0) * 100) / 100,
          registrationMethod: p.supabase_user_id ? 'oauth' : 'email',
        };
      });
      res.json(rows);
    } catch (e) {
      console.error('[admin players list]', e);
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/:id', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    const { id } = req.params;
    try {
      const [
        playerRes, presenceRes, matchHistoryRes, coinTxRes, bpRes, coachingRes,
        friendsRes, reportsReceivedRes, reportsMadeRes, modActionsRes, sessionsRes, loginHistoryRes,
      ] = await Promise.all([
        supabase.from('players').select('*').eq('id', id).single(),
        supabase.from('player_presence').select('*').eq('player_id', id).maybeSingle(),
        supabase
          .from('match_players')
          .select('final_pnl, final_rank, cards_played, trades_made, rating_change, match:matches(id, mode, instrument_1, instrument_2, instruments, start_time, end_time, status)')
          .eq('player_id', id)
          .order('match(created_at)', { ascending: false })
          .limit(50),
        supabase.from('coin_transactions').select('*').eq('player_id', id).order('created_at', { ascending: false }).limit(100),
        supabase.from('battle_pass_subscriptions').select('*').eq('player_id', id).order('started_at', { ascending: false }).limit(5),
        supabase.from('coaching_sessions').select('*').or(`coach_id.eq.${id},student_id.eq.${id}`).order('created_at', { ascending: false }).limit(20),
        supabase.from('friendships').select('*').or(`requester_id.eq.${id},addressee_id.eq.${id}`),
        supabase.from('player_reports').select('*').eq('reported_player_id', id).order('created_at', { ascending: false }),
        supabase.from('player_reports').select('*').eq('reporter_id', id).order('created_at', { ascending: false }),
        supabase.from('player_moderation_actions').select('*').eq('player_id', id).order('created_at', { ascending: false }),
        supabase.from('sessions').select('id, created_at, last_seen_at, ip, user_agent, revoked').eq('player_id', id).order('last_seen_at', { ascending: false }).limit(10),
        supabase.from('login_events').select('ip, user_agent, created_at').eq('player_id', id).order('created_at', { ascending: false }).limit(10),
      ]);

      if (playerRes.error || !playerRes.data) return res.status(404).json({ error: 'Player not found' });
      const player = playerRes.data;

      const matchHistory = (matchHistoryRes.data || []).map((row) => ({
        matchId: row.match?.id,
        mode: row.match?.mode,
        instruments: row.match?.instruments || [row.match?.instrument_1, row.match?.instrument_2].filter(Boolean),
        rank: row.final_rank,
        pnl: Number(row.final_pnl || 0),
        cardsPlayed: row.cards_played,
        tradesMade: row.trades_made,
        ratingChange: row.rating_change,
        startTime: row.match?.start_time,
        endTime: row.match?.end_time,
        durationSeconds: row.match?.start_time && row.match?.end_time
          ? Math.round((new Date(row.match.end_time) - new Date(row.match.start_time)) / 1000)
          : null,
      }));

      const pnls = matchHistory.map((m) => m.pnl).filter((n) => Number.isFinite(n));
      const bestMatch = pnls.length ? Math.max(...pnls) : 0;
      const worstMatch = pnls.length ? Math.min(...pnls) : 0;
      const instrumentCounts = {};
      matchHistory.forEach((m) => (m.instruments || []).forEach((sym) => { instrumentCounts[sym] = (instrumentCounts[sym] || 0) + 1; }));
      const favouriteInstrument = Object.entries(instrumentCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const modeCounts = {};
      matchHistory.forEach((m) => { modeCounts[m.mode] = (modeCounts[m.mode] || 0) + 1; });
      const favouriteMode = Object.entries(modeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      let streak = 0;
      let longestStreak = 0;
      let running = 0;
      // matchHistory is newest-first; current streak reads from the front,
      // longest streak scans the whole (chronologically reversed) history.
      for (const m of matchHistory) {
        if (m.rank === 1) { if (streak === 0 || running > 0) running++; else break; } else break;
      }
      streak = running;
      running = 0;
      for (let i = matchHistory.length - 1; i >= 0; i--) {
        if (matchHistory[i].rank === 1) { running++; longestStreak = Math.max(longestStreak, running); } else running = 0;
      }

      const revenueByPlayer = await computeRevenueByPlayer([id]);
      const totalTimePlayedSeconds = matchHistory.reduce((s, m) => s + (m.durationSeconds || 0), 0);

      res.json({
        profile: {
          id: player.id, username: player.username, email: player.email, avatarUrl: player.avatar_url,
          createdAt: player.created_at, supabaseUserId: player.supabase_user_id,
          registrationMethod: player.supabase_user_id ? 'oauth' : 'email',
          country: player.country, tier: player.tier, warRating: player.war_rating,
          grandWarRating: player.grand_war_rating, soloRating: player.solo_rating,
          coins: player.coins, coinsEarnedTotal: player.coins_earned_total, coinsSpentTotal: player.coins_spent_total,
          isBanned: player.is_banned, bannedUntil: player.banned_until, banReason: player.ban_reason,
          flagged: player.flagged, adminNotes: player.admin_notes,
          totpEnabled: player.totp_enabled,
        },
        presence: presenceRes.data || null,
        stats: {
          totalMatches: player.total_matches, wins: player.wins, losses: player.losses, draws: player.draws,
          winRate: player.wins + player.losses > 0 ? Math.round((player.wins / (player.wins + player.losses)) * 1000) / 10 : 0,
          avgPnl: pnls.length ? Math.round((pnls.reduce((a, b) => a + b, 0) / pnls.length) * 100) / 100 : 0,
          bestMatch, worstMatch, favouriteInstrument, favouriteMode,
          totalTimePlayedSeconds, currentWinStreak: streak, longestWinStreak: longestStreak,
        },
        financial: {
          totalRevenue: Math.round((revenueByPlayer[id] || 0) * 100) / 100,
          coinTransactions: coinTxRes.data || [],
          battlePass: bpRes.data || [],
          coachingSessions: coachingRes.data || [],
        },
        matchHistory,
        social: { friendships: friendsRes.data || [] },
        moderation: {
          reportsReceived: reportsReceivedRes.data || [],
          reportsMade: reportsMadeRes.data || [],
          actions: modActionsRes.data || [],
        },
        sessions: sessionsRes.data || [],
        loginHistory: loginHistoryRes.data || [],
      });
    } catch (e) {
      console.error('[admin player detail]', e);
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/coins', async (req, res) => {
    const { id } = req.params;
    const { amount, direction, reason } = req.body || {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!['add', 'deduct'].includes(direction)) return res.status(400).json({ error: 'direction must be add or deduct' });
    try {
      const { data: player, error: pErr } = await supabase.from('players').select('coins').eq('id', id).single();
      if (pErr || !player) return res.status(404).json({ error: 'Player not found' });
      const delta = direction === 'add' ? amt : -amt;
      const newBalance = Math.max(0, player.coins + delta);
      await supabase.from('players').update({ coins: newBalance }).eq('id', id);
      await supabase.from('coin_transactions').insert({
        player_id: id, type: direction === 'add' ? 'admin_grant' : 'admin_deduct', amount: delta, balance_after: newBalance,
      });
      await supabase.from('player_moderation_actions').insert({
        player_id: id, admin_username: req.admin.username, action_type: direction === 'add' ? 'coins_added' : 'coins_deducted',
        reason, amount: amt,
      });
      await logAdminAction({ adminUsername: req.admin.username, actionType: `coins_${direction}`, targetType: 'player', targetId: id, details: { amount: amt, reason }, ip: clientIp(req) });
      res.json({ success: true, newBalance });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/ban', async (req, res) => {
    const { id } = req.params;
    const { type, durationHours, reason } = req.body || {};
    if (!['temp', 'perm'].includes(type)) return res.status(400).json({ error: 'type must be temp or perm' });
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    try {
      const bannedUntil = type === 'temp' ? new Date(Date.now() + Number(durationHours || 24) * 3600 * 1000).toISOString() : null;
      await supabase.from('players').update({ is_banned: true, banned_until: bannedUntil, ban_reason: reason }).eq('id', id);
      await supabase.from('player_moderation_actions').insert({
        player_id: id, admin_username: req.admin.username, action_type: type === 'temp' ? 'temp_ban' : 'perm_ban',
        reason, duration_hours: type === 'temp' ? Number(durationHours || 24) : null,
      });
      await logAdminAction({ adminUsername: req.admin.username, actionType: `ban_${type}`, targetType: 'player', targetId: id, details: { reason, durationHours }, ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/unban', async (req, res) => {
    const { id } = req.params;
    try {
      await supabase.from('players').update({ is_banned: false, banned_until: null, ban_reason: null }).eq('id', id);
      await supabase.from('player_moderation_actions').insert({ player_id: id, admin_username: req.admin.username, action_type: 'unban' });
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'unban', targetType: 'player', targetId: id, ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/flag', async (req, res) => {
    const { id } = req.params;
    const { flagged, reason } = req.body || {};
    try {
      await supabase.from('players').update({ flagged: !!flagged }).eq('id', id);
      await supabase.from('player_moderation_actions').insert({ player_id: id, admin_username: req.admin.username, action_type: flagged ? 'flagged' : 'unflagged', reason });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/warn', async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    try {
      await supabase.from('player_moderation_actions').insert({ player_id: id, admin_username: req.admin.username, action_type: 'warn', reason });
      // Real delivery through the game's existing notification bell.
      await supabase.from('notifications').insert({ player_id: id, type: 'admin_warning', data: { message: `Warning from admin: ${reason}` } });
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'warn', targetType: 'player', targetId: id, details: { reason }, ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/message', async (req, res) => {
    const { id } = req.params;
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message is required' });
    try {
      await supabase.from('notifications').insert({ player_id: id, type: 'admin_message', data: { message } });
      await supabase.from('player_moderation_actions').insert({ player_id: id, admin_username: req.admin.username, action_type: 'message_sent', reason: message });
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'message', targetType: 'player', targetId: id, details: { message }, ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/tier', async (req, res) => {
    const { id } = req.params;
    const { tier } = req.body || {};
    if (!tier) return res.status(400).json({ error: 'tier is required' });
    try {
      await supabase.from('players').update({ tier }).eq('id', id);
      await supabase.from('player_moderation_actions').insert({ player_id: id, admin_username: req.admin.username, action_type: 'tier_override', reason: `Set to ${tier}` });
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'tier_override', targetType: 'player', targetId: id, details: { tier }, ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/notes', async (req, res) => {
    const { id } = req.params;
    const { note } = req.body || {};
    try {
      await supabase.from('players').update({ admin_notes: note }).eq('id', id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/:id/reset-password', async (req, res) => {
    const { id } = req.params;
    try {
      const { data: player } = await supabase.from('players').select('email').eq('id', id).single();
      if (!player?.email) return res.status(404).json({ error: 'Player has no email on file' });
      await supabase.auth.resetPasswordForEmail(player.email, {
        redirectTo: `${req.headers.origin || 'http://localhost:' + (process.env.PORT || 3002)}/reset-password`,
      });
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'reset_password', targetType: 'player', targetId: id, ip: clientIp(req) });
      res.json({ success: true, message: `Reset email sent to ${player.email} (if a matching auth account exists)` });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const { data: player } = await supabase.from('players').select('username, supabase_user_id').eq('id', id).single();
      if (!player) return res.status(404).json({ error: 'Player not found' });
      if (player.supabase_user_id) {
        await supabase.auth.admin.deleteUser(player.supabase_user_id).catch((e) => console.warn('[admin] auth user delete failed:', e.message));
      }
      await supabase.from('players').delete().eq('id', id);
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'delete_account', targetType: 'player', targetId: id, details: { username: player.username }, ip: clientIp(req) });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GDPR-style full data export - everything this admin panel itself queries
  // about the player, bundled into one JSON document.
  r.get('/:id/export', async (req, res) => {
    const { id } = req.params;
    try {
      const tables = ['players', 'coin_transactions', 'trades', 'sabotage_events', 'match_players', 'shop_purchases', 'battle_pass_subscriptions', 'coaching_sessions', 'sessions', 'login_events', 'notifications'];
      const results = await Promise.all(tables.map((t) => supabase.from(t).select('*').eq(t === 'players' ? 'id' : 'player_id', id)));
      const bundle = Object.fromEntries(tables.map((t, i) => [t, results[i].data || []]));
      await logAdminAction({ adminUsername: req.admin.username, actionType: 'data_export', targetType: 'player', targetId: id, ip: clientIp(req) });
      res.json(bundle);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/reports/open', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('player_reports')
        .select('*, reported:players!player_reports_reported_player_id_fkey(username), reporter:players!player_reports_reporter_id_fkey(username)')
        .eq('status', 'open')
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/reports/:reportId/resolve', async (req, res) => {
    const { reportId } = req.params;
    const { status } = req.body || {};
    if (!['reviewed', 'dismissed'].includes(status)) return res.status(400).json({ error: 'status must be reviewed or dismissed' });
    try {
      await supabase.from('player_reports').update({ status, reviewed_by: req.admin.username, reviewed_at: new Date().toISOString() }).eq('id', reportId);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
