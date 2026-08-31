'use strict';

const BRACKET_SIZES = [8, 16, 32, 64];
const SIGNUP_WINDOW_MS = 24 * 60 * 60 * 1000;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Builds a single-elimination bracket from a full list of registered player
// ids (length must equal bracketSize - the caller only starts a tournament
// once registration hits capacity). Round 1 pairs slots [0v1, 2v3, ...];
// every later round starts with both slots empty, filled in as earlier
// rounds' matches complete (see advanceBracket).
function buildBracket(bracketSize, playerIds) {
  const seeded = shuffle(playerIds);
  const totalRounds = Math.log2(bracketSize);
  const rounds = [];
  for (let r = 1; r <= totalRounds; r++) {
    const matchupCount = bracketSize / 2 ** r;
    const matchups = [];
    for (let i = 0; i < matchupCount; i++) {
      matchups.push({
        matchup: i,
        playerAId: r === 1 ? seeded[i * 2] : null,
        playerBId: r === 1 ? seeded[i * 2 + 1] : null,
        matchId: null,
        winnerId: null,
        status: r === 1 ? 'ready' : 'waiting',
      });
    }
    rounds.push({ round: r, matchups });
  }
  return { rounds, seeds: seeded };
}

function getMatchup(bracketData, round, matchup) {
  const roundData = bracketData.rounds.find((r) => r.round === round);
  return roundData ? roundData.matchups[matchup] : null;
}

// Shared by a real win (advanceBracket) and a bye (checkForBye): records this
// matchup's outcome, then either names a champion (final round) or propagates
// the winner into the next round's paired slot - marking it 'ready' once both
// slots are filled, and checking whether that slot itself needs a bye (its
// sibling may already be void, in either order of resolution). Returns
// { tournamentComplete, championId }; championId is null unless this call (or
// a bye it triggered downstream) named one.
function recordResult(bracketData, round, matchupIdx, winnerId, status) {
  const roundData = bracketData.rounds.find((r) => r.round === round);
  const m = roundData.matchups[matchupIdx];
  m.winnerId = winnerId;
  m.status = status;

  const isFinalRound = round === bracketData.rounds.length;
  if (isFinalRound) {
    return { tournamentComplete: true, championId: winnerId };
  }

  // A real winner fills its slot in the next round's paired matchup; a void
  // (winnerId null) has no slot to fill, but the next round still needs
  // checking - its other source may already be void too (double-void
  // cascade) or already have a winner waiting (bye), either of which this
  // matchup's resolution just completed.
  if (winnerId != null) {
    const nextRound = bracketData.rounds.find((r) => r.round === round + 1);
    const nextMatchup = nextRound.matchups[Math.floor(matchupIdx / 2)];
    if (matchupIdx % 2 === 0) nextMatchup.playerAId = winnerId;
    else nextMatchup.playerBId = winnerId;
    if (nextMatchup.playerAId && nextMatchup.playerBId) nextMatchup.status = 'ready';
  }

  const byeResult = checkForBye(bracketData, round + 1, Math.floor(matchupIdx / 2));
  return byeResult || { tournamentComplete: false, championId: null };
}

// Records a matchup's winner and, if both players of the NEXT round's paired
// matchup are now known, marks that matchup ready to play. Returns
// { bracketData, tournamentComplete, championId }.
function advanceBracket(bracketData, round, matchup, winnerId) {
  const result = recordResult(bracketData, round, matchup, winnerId, 'completed');
  return { bracketData, ...result };
}

// A draw in a single-elimination matchup eliminates BOTH players - neither
// advances, and the slot they would have filled in the next round is
// permanently empty (not "waiting for a match", just void). Returns
// { bracketData, tournamentComplete, championId, voided: true } - callers
// should treat tournamentComplete+championId===null here as "the tournament
// has no champion from this path", distinct from a real single-elimination
// final (which always names a championId).
function voidMatchup(bracketData, round, matchup) {
  const result = recordResult(bracketData, round, matchup, null, 'void');
  return { bracketData, ...result, voided: true };
}

// If exactly one of a matchup's two source matchups (previous round) was
// voided by a draw and the other has a confirmed winner (from a real match
// OR an earlier bye), the lone advancing player passes straight through -
// there's only ever one candidate for this, so no rating-based tie-break is
// needed for the common case. If BOTH sources voided, this matchup has no
// one left to advance either, so it cascades into a void of its own. Either
// way, routes through recordResult so the outcome propagates into the round
// after this one exactly like a real win would (a bye is otherwise never
// "played", so nothing else would push its winner forward).
// Returns { tournamentComplete, championId } if this resolution reached (or
// voided) the final round, else null - callers need this because a bye can
// cascade all the way to naming a champion without any call site otherwise
// finding out.
function checkForBye(bracketData, round, matchupIdx) {
  const roundData = bracketData.rounds.find((r) => r.round === round);
  if (!roundData) return null; // round is beyond the bracket (shouldn't happen, but stay defensive)
  const m = roundData.matchups[matchupIdx];
  if (m.status !== 'waiting') return null; // already resolved (ready/completed/bye/void)

  const prevRound = bracketData.rounds.find((r) => r.round === round - 1);
  const srcA = prevRound.matchups[matchupIdx * 2];
  const srcB = prevRound.matchups[matchupIdx * 2 + 1];
  const aVoid = srcA.status === 'void';
  const bVoid = srcB.status === 'void';

  if (aVoid && srcB.winnerId != null) {
    m.playerAId = null;
    m.playerBId = srcB.winnerId;
    return recordResult(bracketData, round, matchupIdx, srcB.winnerId, 'bye');
  }
  if (bVoid && srcA.winnerId != null) {
    m.playerBId = null;
    m.playerAId = srcA.winnerId;
    return recordResult(bracketData, round, matchupIdx, srcA.winnerId, 'bye');
  }
  if (aVoid && bVoid) {
    return recordResult(bracketData, round, matchupIdx, null, 'void');
  }
  return null; // neither source is void - nothing for this matchup to do yet
}

// True once every round-1 slot is filled with distinct players - the earliest
// point registration can close and the bracket can be generated.
function isRegistrationFull(bracketSize, registrationCount) {
  return registrationCount >= bracketSize;
}

module.exports = {
  BRACKET_SIZES,
  SIGNUP_WINDOW_MS,
  buildBracket,
  getMatchup,
  advanceBracket,
  voidMatchup,
  isRegistrationFull,
};
