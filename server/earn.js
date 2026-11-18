'use strict';

// Ways to earn coins by playing (coins are never sold and have no cash value).
//
//   Claimed with a button (GET /api/earn, POST /api/earn/claim):
//     streak        daily login streak, days 1-7, resets after a missed day
//     starter:<id>  getting-started tasks, once each
//     achievement:<id>  one-time milestones
//     welcome_back  after 14+ days without a match, at most once per 30 days
//   Paid automatically:
//     first win of the day, level-ups (and prestige), the Daily Challenge,
//     the weekly leaderboard (Monday, top 3 per tier).
//
// Every payment goes through the coin ledger (db.creditCoins) with an
// idempotency key, so nothing can be paid twice: retries, double clicks and
// two servers all land on the same key. Eligibility is always checked on the
// server from server data; the client only asks.

const DAY = 86400000;

const REWARDS = {
  streak: [5, 5, 10, 10, 15, 15, 40],
  firstWin: 15,
  level: (n) => Math.min(100, 10 + 5 * n),
  prestige: 250,
  dailyChallenge: 10,
  welcomeBack: { coins: 50, awayDays: 14, everyDays: 30 },
  weekly: { perTier: [60, 35, 20], minMatches: 5, excludeModes: ['private', 'solo', 'async'] },
};

const PLAY_MODES = ['quick', 'blitz', 'grand', 'solo', 'stocks', 'futures', 'tournament', 'async'];

const STARTER = [
  { id: 'verify_email', label: 'Verify your email', coins: 20, done: (s) => s.emailVerified },
  { id: 'tutorial', label: 'Finish the walkthrough', coins: 20, done: (s) => s.tutorial },
  { id: 'three_modes', label: 'Play 3 different modes', coins: 30, done: (s) => s.modes.length >= 3, progress: (s) => [Math.min(3, s.modes.length), 3] },
  { id: 'install_app', label: 'Add Spike & Crush to your home screen and open it from there', coins: 20, done: (s) => s.installed },
];

const ACHIEVEMENTS = [
  { id: 'first_win', label: 'First win', coins: 25, done: (s) => s.wins >= 1, progress: (s) => [Math.min(1, s.wins), 1] },
  { id: 'wins_10', label: '10 wins', coins: 50, done: (s) => s.wins >= 10, progress: (s) => [Math.min(10, s.wins), 10] },
  { id: 'wins_50', label: '50 wins', coins: 100, done: (s) => s.wins >= 50, progress: (s) => [Math.min(50, s.wins), 50] },
  { id: 'wins_100', label: '100 wins', coins: 200, done: (s) => s.wins >= 100, progress: (s) => [Math.min(100, s.wins), 100] },
  { id: 'matches_100', label: 'Play 100 matches', coins: 100, done: (s) => s.matches >= 100, progress: (s) => [Math.min(100, s.matches), 100] },
  { id: 'all_modes', label: 'Play every mode', coins: 75, done: (s) => PLAY_MODES.every((m) => s.modes.includes(m)), progress: (s) => [PLAY_MODES.filter((m) => s.modes.includes(m)).length, PLAY_MODES.length] },
  { id: 'streak_5', label: '5 winning trades in a row in one match', coins: 40, done: (s) => s.bestStreak >= 5, progress: (s) => [Math.min(5, s.bestStreak), 5] },
  { id: 'level_10', label: 'Reach level 10', coins: 60, done: (s) => s.level >= 10 || s.prestige > 0, progress: (s) => [s.prestige > 0 ? 10 : Math.min(10, s.level), 10] },
];

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
// Monday 00:00 UTC of the week containing ms.
function weekStart(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

// Streak after claiming on `today`, from the stored { day, last }.
function nextStreak(stored, today) {
  const s = stored || {};
  if (s.last === today) return { day: s.day || 1, already: true };
  const yesterday = ymd(Date.parse(`${today}T00:00:00Z`) - DAY);
  const day = s.last === yesterday ? ((s.day || 0) % REWARDS.streak.length) + 1 : 1;
  return { day, already: false };
}

// Top players per tier for one week: [{ playerId, tier, place, coins }].
function weeklyWinners(rows, { perTier = REWARDS.weekly.perTier, minMatches = REWARDS.weekly.minMatches } = {}) {
  const by = new Map();
  for (const r of rows) {
    const k = r.player_id;
    if (!by.has(k)) by.set(k, { playerId: k, tier: r.tier || 'Unranked', wins: 0, matches: 0 });
    const x = by.get(k);
    x.matches += 1;
    if (r.final_rank === 1 && !r.is_draw) x.wins += 1;
  }
  const tiers = new Map();
  for (const x of by.values()) {
    if (x.matches < minMatches || x.wins < 1) continue;
    if (!tiers.has(x.tier)) tiers.set(x.tier, []);
    tiers.get(x.tier).push(x);
  }
  const out = [];
  for (const [tier, list] of tiers) {
    list.sort((a, b) => b.wins - a.wins || a.matches - b.matches || String(a.playerId).localeCompare(String(b.playerId)));
    list.slice(0, perTier.length).forEach((x, i) => out.push({ playerId: x.playerId, tier, place: i + 1, wins: x.wins, matches: x.matches, coins: perTier[i] }));
  }
  return out;
}

function createEarn({ db, notify = () => {}, now = () => Date.now(), log = console }) {
  const sb = () => db.client();
  let doneWeek = null;

  async function pay(playerId, coins, type, key, label) {
    if (!(coins > 0)) return null;
    const r = await db.creditCoins(playerId, coins, { type, idempotencyKey: key });
    if (r && r.duplicate) return null;
    try { notify(playerId, 'coins_earned', `+${coins} coins: ${label}`, { data: { coins, reason: type } }); } catch (e) { /* notification is best effort */ }
    return { coins, label, type, balance: r && r.coins };
  }

  async function claimedKeys(playerId) {
    const { data, error } = await sb().from('coin_transactions').select('idempotency_key, type, amount, created_at').eq('player_id', playerId).like('type', 'earn_%').order('created_at', { ascending: false }).limit(2000);
    if (error) throw error;
    return data || [];
  }

  async function matchHistory(playerId) {
    const { data, error } = await sb().from('match_players').select('final_rank, is_draw, matches!inner(mode, end_time, status)').eq('player_id', playerId).limit(5000);
    if (error) throw error;
    return (data || []).map((r) => ({ mode: r.matches.mode, endTime: r.matches.end_time, rank: r.final_rank }));
  }

  async function stats(player, authUser) {
    const [history, progress] = await Promise.all([matchHistory(player.id), db.getProgress ? db.getProgress(player.id).catch(() => null) : null]);
    const progression = require('./progression');
    const standing = progression.standing(player, progress);
    const ends = history.map((h) => Date.parse(h.endTime)).filter(Number.isFinite);
    const settings = (player.settings && player.settings.earn) || {};
    return {
      wins: Number(player.wins) || 0,
      matches: Number(player.total_matches) || history.length,
      modes: [...new Set(history.map((h) => h.mode))],
      bestStreak: Number(progress && progress.best_streak) || 0,
      level: standing.level,
      prestige: Number(player.prestige_level) || 0,
      emailVerified: Boolean(authUser && (authUser.email_confirmed_at || authUser.confirmed_at)),
      tutorial: Boolean(player.tutorial_completed),
      installed: Boolean(settings.installed),
      lastMatchAt: ends.length ? Math.max(...ends) : null,
      settings,
    };
  }

  function welcomeBackOpen(s) {
    const w = REWARDS.welcomeBack;
    if (!s.lastMatchAt || now() - s.lastMatchAt < w.awayDays * DAY) return false;
    const last = Date.parse(s.settings.welcomeBackAt || '');
    return !(Number.isFinite(last) && now() - last < w.everyDays * DAY);
  }

  async function status(player, authUser) {
    const [s, paid] = await Promise.all([stats(player, authUser), claimedKeys(player.id)]);
    const has = new Set(paid.map((p) => p.idempotency_key));
    const today = ymd(now());
    const st = nextStreak(s.settings.streak, today);
    const shownDay = st.already ? st.day : st.day;
    const line = (def, kind) => {
      const claimed = has.has(`earn:${kind}:${player.id}:${def.id}`);
      const done = def.done(s);
      return { id: def.id, label: def.label, coins: def.coins, done, claimed, claimable: done && !claimed, progress: def.progress ? def.progress(s) : null };
    };
    const week = weekStart(now()) - 7 * DAY;
    const weekly = paid.find((p) => p.type === 'earn_weekly' && String(p.idempotency_key).startsWith(`earn:weekly:${ymd(week)}:`));
    return {
      streak: { day: shownDay, claimedToday: st.already, rewards: REWARDS.streak, nextCoins: REWARDS.streak[shownDay - 1] },
      starter: STARTER.map((d) => line(d, 'starter')),
      achievements: ACHIEVEMENTS.map((d) => line(d, 'achievement')),
      welcomeBack: { open: welcomeBackOpen(s), coins: REWARDS.welcomeBack.coins, awayDays: REWARDS.welcomeBack.awayDays },
      automatic: {
        firstWin: { coins: REWARDS.firstWin, paidToday: has.has(`earn:firstwin:${player.id}:${today}`) },
        dailyChallenge: { coins: REWARDS.dailyChallenge, paidToday: has.has(`earn:daily:${player.id}:${today}`) },
        levelUp: { next: s.level + 1, coins: REWARDS.level(s.level + 1), prestigeCoins: REWARDS.prestige },
        weekly: { perTier: REWARDS.weekly.perTier, minMatches: REWARDS.weekly.minMatches, lastWeek: weekly ? { coins: weekly.amount } : null },
      },
      earnedTotal: paid.reduce((a, p) => a + (Number(p.amount) || 0), 0),
    };
  }

  async function saveSettings(player, patch) {
    const fresh = (await db.getPlayerById(player.id)) || player;
    const settings = { ...(fresh.settings || {}) };
    settings.earn = { ...(settings.earn || {}), ...patch };
    await db.updatePlayer(player.id, { settings });
  }

  async function claim(player, authUser, kind, id) {
    const today = ymd(now());
    if (kind === 'streak') {
      const st = nextStreak(((player.settings || {}).earn || {}).streak, today);
      if (st.already) return { error: 'Already collected today. Come back tomorrow.' };
      const coins = REWARDS.streak[st.day - 1];
      const r = await pay(player.id, coins, 'earn_streak', `earn:streak:${player.id}:${today}`, `Daily reward, day ${st.day}`);
      await saveSettings(player, { streak: { day: st.day, last: today } });
      return r ? { ok: true, ...r, day: st.day } : { error: 'Already collected today. Come back tomorrow.' };
    }
    const s = await stats(player, authUser);
    if (kind === 'starter' || kind === 'achievement') {
      const def = (kind === 'starter' ? STARTER : ACHIEVEMENTS).find((d) => d.id === id);
      if (!def) return { error: 'Unknown reward' };
      if (!def.done(s)) return { error: 'Not done yet' };
      const r = await pay(player.id, def.coins, `earn_${kind}`, `earn:${kind}:${player.id}:${def.id}`, def.label);
      return r ? { ok: true, ...r } : { error: 'Already collected' };
    }
    if (kind === 'welcome_back') {
      if (!welcomeBackOpen(s)) return { error: 'Not available' };
      const r = await pay(player.id, REWARDS.welcomeBack.coins, 'earn_welcome_back', `earn:welcomeback:${player.id}:${today}`, 'Welcome back');
      await saveSettings(player, { welcomeBackAt: new Date(now()).toISOString() });
      return r ? { ok: true, ...r } : { error: 'Already collected' };
    }
    return { error: 'Unknown reward' };
  }

  async function markInstalled(player) {
    if (((player.settings || {}).earn || {}).installed) return { ok: true };
    await saveSettings(player, { installed: true });
    return { ok: true };
  }

  // After a finished match, for one human player. Returns what was paid now.
  async function onMatchEnd(match, p, r, progress) {
    if (!p || p.isAI || r.isAI || !db.isConfigured) return [];
    const out = [];
    const today = ymd(now());
    const humans = Object.values(match.players || {}).filter((x) => !x.isAI).length;
    const selfPlay = Boolean(match.config && match.config.challenge) || (match.mode === 'private' && humans === 1);
    try {
      if (r.rank === 1 && !r.isDraw && !selfPlay) {
        const x = await pay(p.id, REWARDS.firstWin, 'earn_first_win', `earn:firstwin:${p.id}:${today}`, 'First win of the day');
        if (x) out.push(x);
      }
      if (match.mode === 'async') {
        const x = await pay(p.id, REWARDS.dailyChallenge, 'earn_daily_challenge', `earn:daily:${p.id}:${today}`, 'Daily Challenge');
        if (x) out.push(x);
      }
      if (progress && progress.levelAfter > progress.levelBefore) {
        const row = await db.getPlayerById(p.id);
        const prestige = Number(row && row.prestige_level) || 0;
        for (let L = progress.levelBefore + 1; L <= progress.levelAfter; L++) {
          const x = await pay(p.id, REWARDS.level(L), 'earn_level', `earn:level:${p.id}:p${prestige}:${L}`, `Reached level ${L}`);
          if (x) out.push(x);
        }
      }
    } catch (e) {
      log.warn('[earn] match rewards failed:', e.message);
    }
    return out;
  }

  async function onPrestige(playerId, prestige) {
    return pay(playerId, REWARDS.prestige, 'earn_prestige', `earn:prestige:${playerId}:${prestige}`, `Prestige ${prestige}`);
  }

  // Monday job: pays last week's top players per tier, once (keys per week).
  async function weeklyJob() {
    const start = weekStart(now()) - 7 * DAY;
    const end = start + 7 * DAY;
    if (now() < end + 5 * 60000) return { skipped: 'too early' };
    if (doneWeek === ymd(start)) return { skipped: 'done' }; // this process already paid it
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb().from('match_players')
        .select('player_id, final_rank, is_draw, matches!inner(mode, end_time), players!inner(tier, is_persona)')
        .gte('matches.end_time', new Date(start).toISOString()).lt('matches.end_time', new Date(end).toISOString())
        .not('player_id', 'is', null).range(from, from + 999);
      if (error) throw error;
      for (const r of data || []) {
        if (r.players.is_persona || REWARDS.weekly.excludeModes.includes(r.matches.mode)) continue;
        rows.push({ player_id: r.player_id, final_rank: r.final_rank, is_draw: r.is_draw, tier: r.players.tier });
      }
      if (!data || data.length < 1000) break;
    }
    const winners = weeklyWinners(rows);
    let paid = 0;
    for (const w of winners) {
      const x = await pay(w.playerId, w.coins, 'earn_weekly', `earn:weekly:${ymd(start)}:${w.playerId}`, `Weekly leaderboard: #${w.place} in ${w.tier}`).catch((e) => { log.warn('[earn weekly]', e.message); return null; });
      if (x) paid++;
    }
    doneWeek = ymd(start);
    return { week: ymd(start), winners: winners.length, paid };
  }

  return { status, claim, markInstalled, onMatchEnd, onPrestige, weeklyJob };
}

module.exports = { createEarn, REWARDS, STARTER, ACHIEVEMENTS, PLAY_MODES, nextStreak, weeklyWinners, weekStart };
