'use strict';

const express = require('express');
const { supabase, isConfigured } = require('../lib/supabaseAdmin');

const BATTLE_PASS_PRICE_USD = 4.99; // server/index.js Stripe checkout unit_amount: 499

function startOfDayIso(daysAgo = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}
function monthKey(iso) { return iso.slice(0, 7); }

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

  // No withdrawal system exists in this build - coins don't convert back to
  // cash (Stripe Connect payouts were deferred at product-decision time, see
  // the "Real Stripe payments" project note). Returning this explicitly so
  // the admin UI can show an honest empty state instead of fabricated rows.
  r.get('/withdrawals', (req, res) => {
    res.json({ implemented: false, message: 'No cash-withdrawal system exists yet - coins are a closed-loop in-game balance. This tab will populate once Stripe Connect payouts ship.', rows: [] });
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
