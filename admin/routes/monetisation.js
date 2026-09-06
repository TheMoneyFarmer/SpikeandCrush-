'use strict';

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');
const { logAdminAction, clientIp } = require('../lib/auth');
const internal = require('../lib/internalGameServer');
const { sendEmail } = require('../lib/email');

const BATTLE_PASS_PRICE_USD = 4.99; // server/index.js Stripe checkout unit_amount: 499

function startOfDayIso(daysAgo = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}
function monthKey(iso) { return iso.slice(0, 7); }

// Plain-text-safe interpolation into the HTML email body below - not for
// rendering to a browser, just for not letting a tournament/username string
// break out of its tag if it happens to contain '<' or '&'.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatMoney(n) {
  const num = Number(n) || 0;
  return `$${num.toFixed(2)}`;
}

function router() {
  const r = express.Router();

  r.get('/overview', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const since12mo = startOfDayIso(365);
      const monthStart = startOfDayIso(new Date().getUTCDate() - 1);

      const [purchases, bpSubs, coachingSessions, tournaments, brokers, totalPlayers] = await Promise.all([
        supabase.from('coin_purchases').select('amount_usd, created_at').eq('status', 'completed').gte('created_at', since12mo),
        supabase.from('battle_pass_subscriptions').select('is_premium, started_at').gte('started_at', since12mo),
        supabase.from('coaching_sessions').select('price_aed, status, created_at').eq('status', 'completed'),
        supabase.from('tournaments').select('entry_coins').eq('status', 'completed'),
        supabase.from('broker_partners').select('monthly_fee_aed, active'),
        supabase.from('players').select('id', { count: 'exact', head: true }),
      ]);

      const revenueByMonth = {};
      (purchases.data || []).forEach((p) => { const k = monthKey(p.created_at); revenueByMonth[k] = (revenueByMonth[k] || { coins: 0, battlePass: 0 }); revenueByMonth[k].coins += Number(p.amount_usd || 0); });
      (bpSubs.data || []).filter((s) => s.is_premium).forEach((s) => { const k = monthKey(s.started_at); revenueByMonth[k] = revenueByMonth[k] || { coins: 0, battlePass: 0 }; revenueByMonth[k].battlePass += BATTLE_PASS_PRICE_USD; });

      const months = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i);
        months.push(d.toISOString().slice(0, 7));
      }
      const revenueChart = months.map((m) => ({ month: m, coins: revenueByMonth[m]?.coins || 0, battlePass: revenueByMonth[m]?.battlePass || 0 }));

      const totalCoinsRevenue = (purchases.data || []).reduce((s, p) => s + Number(p.amount_usd || 0), 0);
      const totalBpRevenue = (bpSubs.data || []).filter((s) => s.is_premium).length * BATTLE_PASS_PRICE_USD;
      const totalTournamentFees = (tournaments.data || []).reduce((s, t) => s + Number(t.entry_coins || 0), 0); // in coins, not USD - noted separately
      const totalCoachingAed = (coachingSessions.data || []).reduce((s, c) => s + Number(c.price_aed || 0), 0);
      const totalBrokerFeesAed = (brokers.data || []).filter((b) => b.active).reduce((s, b) => s + Number(b.monthly_fee_aed || 0), 0);

      const thisMonthKey = months[months.length - 1];
      const lastMonthKey = months[months.length - 2];
      const thisMonthTotal = (revenueByMonth[thisMonthKey]?.coins || 0) + (revenueByMonth[thisMonthKey]?.battlePass || 0);
      const lastMonthTotal = (revenueByMonth[lastMonthKey]?.coins || 0) + (revenueByMonth[lastMonthKey]?.battlePass || 0);

      res.json({
        totalRevenueUsd12mo: Math.round((totalCoinsRevenue + totalBpRevenue) * 100) / 100,
        byStream: {
          coinPurchasesUsd: Math.round(totalCoinsRevenue * 100) / 100,
          battlePassUsd: Math.round(totalBpRevenue * 100) / 100,
          tournamentEntryCoins: totalTournamentFees,
          coachingAed: totalCoachingAed,
          brokerPartnerFeesAedMonthly: totalBrokerFeesAed,
        },
        revenueChart,
        monthOverMonthGrowthPct: lastMonthTotal > 0 ? Math.round(((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 1000) / 10 : null,
        averageRevenuePerUser: totalPlayers.count ? Math.round(((totalCoinsRevenue + totalBpRevenue) / totalPlayers.count) * 100) / 100 : 0,
      });
    } catch (e) {
      console.error('[admin monetisation overview]', e);
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/transactions', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const { data, error } = await supabase
        .from('coin_transactions')
        .select('id, type, amount, balance_after, match_id, created_at, player:players(username)')
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      res.json(data.map((t) => ({ ...t, username: t.player?.username || 'unknown' })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/coins-in-circulation', async (req, res) => {
    try {
      const { data } = await supabase.from('players').select('coins, coins_earned_total, coins_spent_total');
      const totalInWallets = (data || []).reduce((s, p) => s + (p.coins || 0), 0);
      const totalEarned = (data || []).reduce((s, p) => s + (p.coins_earned_total || 0), 0);
      const totalSpent = (data || []).reduce((s, p) => s + (p.coins_spent_total || 0), 0);
      const { data: purchased } = await supabase.from('coin_purchases').select('package_coins').eq('status', 'completed');
      const totalPurchased = (purchased || []).reduce((s, p) => s + (p.package_coins || 0), 0);
      res.json({ totalInWallets, totalEarnedInMatches: totalEarned, totalSpent, totalPurchased });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/battle-pass', async (req, res) => {
    try {
      const { data: subs } = await supabase.from('battle_pass_subscriptions').select('*');
      const active = (subs || []).filter((s) => new Date(s.expires_at) > new Date());
      const premium = active.filter((s) => s.is_premium);
      const tierDist = {};
      active.forEach((s) => { tierDist[s.tier_current] = (tierDist[s.tier_current] || 0) + 1; });
      const { data: progress } = await supabase.from('battle_pass_progress').select('challenge_id, challenge_type');
      const completionByChallenge = {};
      (progress || []).forEach((p) => { completionByChallenge[p.challenge_id] = (completionByChallenge[p.challenge_id] || 0) + 1; });
      res.json({
        activeSubscribers: active.length,
        premiumSubscribers: premium.length,
        monthlyRecurringRevenueUsd: Math.round(premium.length * BATTLE_PASS_PRICE_USD * 100) / 100,
        tierDistribution: tierDist,
        challengeCompletions: completionByChallenge,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/shop', async (req, res) => {
    try {
      const { data } = await supabase.from('shop_purchases').select('item_id, item_type, coins_spent, purchased_at');
      const byItem = {};
      (data || []).forEach((p) => {
        byItem[p.item_id] = byItem[p.item_id] || { itemId: p.item_id, category: p.item_type, unitsSold: 0, coinsRevenue: 0 };
        byItem[p.item_id].unitsSold++;
        byItem[p.item_id].coinsRevenue += p.coins_spent || 0;
      });
      res.json(Object.values(byItem).sort((a, b) => b.unitsSold - a.unitsSold));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/coaching', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('coaching_sessions')
        .select('*, coach:players!coaching_sessions_coach_id_fkey(username), student:players!coaching_sessions_student_id_fkey(username)')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Ordinary coins have no cash value and cannot be withdrawn (see
  // client/help.html's own Withdrawals section) - this is exclusively for
  // coins credited by a completed Tournament War win. server/index.js's
  // /api/prize-claims debits the coins and inserts here; this is where an
  // admin actually pays out (bank transfer or crypto) and marks it done.
  r.get('/prize-claims', async (req, res) => {
    if (!isConfigured) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      let query = supabase
        .from('prize_claims')
        .select('*, player:players(username, email), tournaments(name)')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (req.query.status) query = query.eq('status', req.query.status);
      const { data, error } = await query;
      if (error) throw error;
      res.json({ rows: data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/prize-claims/:id/processing', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('prize_claims')
        .update({ status: 'processing' })
        .eq('id', req.params.id)
        .select('*, player:players(username)')
        .single();
      if (error) throw error;
      await logAdminAction({ adminUsername: req.admin.email || req.admin.username, actionType: 'prize_claim_processing', targetType: 'prize_claim', targetId: req.params.id, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/prize-claims/:id/paid', async (req, res) => {
    const { reference } = req.body || {};
    if (!reference) return res.status(400).json({ error: 'reference is required (tx hash for crypto, bank reference note otherwise)' });
    try {
      const { data, error } = await supabase
        .from('prize_claims')
        .update({ status: 'paid', payout_reference: reference, processed_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select('*, player:players(username, email), tournaments(name)')
        .single();
      if (error) throw error;
      if (data.player_id) {
        internal.notifyPlayer(data.player_id, 'prize_claim_paid', `Your ${data.tournaments?.name || 'tournament'} prize (${formatMoney(data.prize_usd)}) has been paid out.`, { data: { reference } }).catch(() => {});
        if (data.player?.email) {
          sendEmail({
            to: data.player.email,
            subject: 'Your Spike & Crush tournament prize is on its way',
            html: `<p>Hi ${escapeHtml(data.player.username)},</p>` +
              `<p>Your prize from <strong>${escapeHtml(data.tournaments?.name || 'your tournament win')}</strong> has been processed and paid out via ${data.payout_method === 'crypto' ? 'crypto' : 'bank transfer'}.</p>` +
              `<p><strong>Amount:</strong> ${formatMoney(data.prize_usd)} (${data.prize_coins} coins)<br>` +
              `<strong>Reference:</strong> ${escapeHtml(reference)}</p>` +
              `<p>Funds are on their way. Thanks for playing Spike &amp; Crush.</p>`,
          }).catch(() => {});
        }
      }
      await logAdminAction({ adminUsername: req.admin.email || req.admin.username, actionType: 'prize_claim_paid', targetType: 'prize_claim', targetId: req.params.id, details: { reference }, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Rejecting refunds the coins back to the player - a rejected claim
  // shouldn't just vanish the coins the earlier debitCoins() already took.
  r.post('/prize-claims/:id/reject', async (req, res) => {
    const { reason } = req.body || {};
    try {
      const { data: claim, error: findErr } = await supabase.from('prize_claims').select('*').eq('id', req.params.id).maybeSingle();
      if (findErr) throw findErr;
      if (!claim) return res.status(404).json({ error: 'Prize claim not found' });
      if (claim.status !== 'pending') return res.status(400).json({ error: 'Only pending claims can be rejected' });

      const { data: player } = await supabase.from('players').select('coins').eq('id', claim.player_id).single();
      if (player) {
        const newBalance = player.coins + claim.prize_coins;
        await supabase.from('players').update({ coins: newBalance }).eq('id', claim.player_id);
        await supabase.from('coin_transactions').insert({ player_id: claim.player_id, type: 'prize_claim_refund', amount: claim.prize_coins, balance_after: newBalance });
      }

      const { data, error } = await supabase
        .from('prize_claims')
        .update({ status: 'rejected', admin_notes: reason || null, processed_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) throw error;
      if (claim.player_id) {
        internal.notifyPlayer(claim.player_id, 'prize_claim_rejected', `Your prize claim was rejected and ${claim.prize_coins} coins were refunded to your balance.`, { data: { reason } }).catch(() => {});
      }
      await logAdminAction({ adminUsername: req.admin.email || req.admin.username, actionType: 'prize_claim_rejected', targetType: 'prize_claim', targetId: req.params.id, details: { reason }, ip: clientIp(req) });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/brokers', async (req, res) => {
    try {
      const { data, error } = await supabase.from('broker_partners').select('*').order('joined_date', { ascending: false });
      if (error) throw error;
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = router;
