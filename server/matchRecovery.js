'use strict';

// Live matches exist only in the memory of the process running them, so a crash
// or forced restart loses them and leaves their rows "open" in the database with
// the players' entry coins spent. This sweep finds those rows and refunds exactly
// what the ledger says each player paid.
//
// A match is only treated as lost once it is well past the time it could still be
// running somewhere: during a deploy the old server keeps playing its matches
// while the new one is up, so "not in my memory" alone proves nothing. Refund keys
// come from the original payment, so running this twice can never pay twice.

const SAFETY_MARGIN_MS = 10 * 60 * 1000;
const WAITING_LOST_AFTER_MS = 75 * 60 * 1000; // longer than any lobby may live
const NEVER_STARTED_LOST_AFTER_MS = 3 * 60 * 60 * 1000;
const MESSAGE = 'A match you were in was interrupted by a server problem, so your entry coins have been refunded.';
const NO_FEE_MESSAGE = 'A match you were in was interrupted by a server problem and did not count.';
const TOURNAMENT_MESSAGE = 'Your tournament round was interrupted by a server problem. Open the tournament to play it again.';

function isLost(row, modes, nowMs) {
  const created = new Date(row.created_at).getTime();
  if (row.status === 'waiting') return nowMs - created > WAITING_LOST_AFTER_MS;
  if (row.status !== 'active') return false;
  const duration = (modes[row.mode]?.durationSeconds || 1200) * 1000;
  if (!row.start_time) return nowMs - created > NEVER_STARTED_LOST_AFTER_MS;
  return nowMs - new Date(row.start_time).getTime() > duration + SAFETY_MARGIN_MS;
}

// Payments for a match minus what was already handed back, one refund per payment.
function refundsDue(ledger) {
  const refunded = {};
  for (const tx of ledger) {
    if (tx.type === 'match_refund') refunded[tx.player_id] = (refunded[tx.player_id] || 0) + 1;
  }
  const due = [];
  for (const tx of ledger) {
    if (tx.type !== 'match_entry' || !(tx.amount < 0)) continue;
    if (refunded[tx.player_id] > 0) {
      refunded[tx.player_id]--;
      continue;
    }
    due.push({ playerId: tx.player_id, amount: -tx.amount, key: `lost-match-refund:${tx.id}` });
  }
  return due;
}

function createMatchRecovery({ db, gameEngine, notifyPlayer }) {
  let running = false;

  async function sweep(nowMs = Date.now()) {
    if (running || !db.isConfigured) return { voided: 0, refunded: 0 };
    running = true;
    let voided = 0;
    let refunded = 0;
    try {
      for (const row of await db.listOpenMatches()) {
        if (gameEngine.getMatch(row.id) || !isLost(row, gameEngine.MATCH_MODES, nowMs)) continue;
        const ledger = await db.listMatchLedger(row.id);
        const due = refundsDue(ledger);
        for (const refund of due) {
          await db.creditCoins(refund.playerId, refund.amount, { type: 'match_refund', matchId: row.id, idempotencyKey: refund.key });
          refunded++;
        }
        // A tournament's entry belongs to the bracket: nobody is refunded, the round
        // is replayed (see /api/tournament/:id/play).
        const refundedPlayers = new Set(due.map((r) => r.playerId));
        for (const playerId of refundedPlayers) notifyPlayer?.(playerId, 'match_voided', MESSAGE);
        for (const playerId of await db.listHumanMatchPlayerIds(row.id)) {
          if (!refundedPlayers.has(playerId)) notifyPlayer?.(playerId, 'match_voided', row.mode === 'tournament' ? TOURNAMENT_MESSAGE : NO_FEE_MESSAGE);
        }
        // Last, so a failure part way through is simply retried next sweep.
        await db.updateMatch(row.id, { status: 'voided', end_time: new Date(nowMs).toISOString() });
        voided++;
      }
      if (voided) console.log(`[recovery] closed ${voided} lost match(es), ${refunded} refund(s)`);
    } catch (e) {
      console.error('[recovery] sweep failed:', e.message);
    } finally {
      running = false;
    }
    return { voided, refunded };
  }

  return { sweep };
}

module.exports = { createMatchRecovery, isLost, refundsDue };
