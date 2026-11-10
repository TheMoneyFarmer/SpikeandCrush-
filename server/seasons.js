'use strict';

// Monthly season end (Part 2E.5): once a month, the previous season's top
// finishers by season XP get exclusive cosmetics (server/cosmetics.js). The
// season rank resets by itself (season XP is per month); the lifetime level
// never resets. Runs hourly on one server (job lock) and pays each season
// exactly once (it checks whether that season was already rewarded).

const cosmetics = require('./cosmetics');

async function runSeasonRewards(db, notifyPlayer, season = cosmetics.previousSeason()) {
  if (!db.isConfigured) return { skipped: 'no database' };
  if (await db.seasonAlreadyRewarded(season)) return { skipped: 'already rewarded or table missing', season };
  const { from, to } = cosmetics.seasonBounds(season);
  const top = await db.seasonTop(from, to, cosmetics.SEASON_TOP);
  if (!top) return { skipped: 'season_top() missing', season };
  let granted = 0;
  for (let i = 0; i < top.length; i++) {
    const place = i + 1;
    const items = cosmetics.seasonRewardsFor(season, place);
    const rows = items.map((it) => ({ player_id: top[i].player_id, item_id: it.id, source: 'season', season }));
    const done = await db.grantCosmetics(rows);
    if (done === null) return { skipped: 'earned_cosmetics missing', season };
    granted += done.length;
    if (done.length) notifyPlayer?.(top[i].player_id, 'season_reward', `Season ${season}: you finished #${place}. Exclusive rewards unlocked: ${items.map((it) => it.name).join(', ')}`);
  }
  return { season, players: top.length, granted };
}

function startSeasonJob(db, notifyPlayer) {
  if (!db.isConfigured) return;
  const holder = `${process.pid}-season`;
  const run = async () => {
    try {
      if (db.tryCompJobLock && !(await db.tryCompJobLock('season_rewards', holder, 20 * 60))) return;
      const r = await runSeasonRewards(db, notifyPlayer);
      if (r.granted) console.log('[seasons]', JSON.stringify(r));
    } catch (e) {
      console.warn('[seasons] failed:', e.message);
    }
  };
  setTimeout(run, 2 * 60 * 1000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = { runSeasonRewards, startSeasonJob };
