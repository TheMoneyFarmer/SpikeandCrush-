'use strict';

// Closes discontinued competition formats (Weekly and Monthly). For every
// running or upcoming run: refund each entrant's entry coins once, close open
// positions at no profit or loss, mark the run closed with reason
// "discontinued", and tell each refunded player once (in-app and email).
//
// Safe to run again: every refund carries the ledger key
// `refund:<competition_id>:<player_id>`, so coin_apply() never moves the
// same coins twice, and the message and email go out only when a refund
// actually happened on this run. Rows and history are kept.

const { closedEmail } = require('./compEmails');

const DISCONTINUED = ['weekly', 'monthly'];
const NAMES = { weekly: 'Weekly War', monthly: 'Monthly Grand' };

async function closeDiscontinued({ supabase, sendEmail = null, dryRun = true, keys = DISCONTINUED, log = () => {} }) {
  const report = { dryRun, instances: [], instancesClosed: 0, entrants: 0, refunded: 0, alreadyRefunded: 0, coinsRefunded: 0, notified: 0, emailed: 0, errors: [] };
  const { data: comps, error } = await supabase
    .from('competitions')
    .select('id, title, frequency, status, state, entry_fee_coins, closed_reason')
    .in('frequency', keys)
    .eq('type', 'native')
    .in('status', ['scheduled', 'active']);
  if (error) throw error;
  // Runs already closed by an earlier pass still get checked for refunds.
  const { data: closedBefore, error: e0 } = await supabase
    .from('competitions')
    .select('id, title, frequency, status, state, entry_fee_coins, closed_reason')
    .in('frequency', keys)
    .eq('type', 'native')
    .eq('closed_reason', 'discontinued');
  if (e0) throw e0;
  const all = [...comps, ...(closedBefore || []).filter((c) => !comps.some((x) => x.id === c.id))];

  for (const comp of all) {
    const { data: accounts, error: e1 } = await supabase.from('comp_accounts').select('id, player_id').eq('competition_id', comp.id);
    if (e1) throw e1;
    const fee = Math.max(0, Number(comp.entry_fee_coins) || 0);
    const row = { id: comp.id, title: comp.title, frequency: comp.frequency, status: comp.status, entrants: accounts.length, fee };
    report.instances.push(row);
    report.entrants += accounts.length;
    if (dryRun) continue;

    if (comp.closed_reason !== 'discontinued') {
      const { data: open } = await supabase.from('comp_positions').select('id, entry_price').in('account_id', accounts.map((a) => a.id).concat('00000000-0000-0000-0000-000000000000')).eq('status', 'open');
      for (const pos of open || []) {
        await supabase.rpc('comp_close_position', { p_position: pos.id, p_exit: Number(pos.entry_price), p_reason: 'void', p_pnl: 0 }).then(({ error: e }) => e && report.errors.push(`position ${pos.id}: ${e.message}`));
      }
      const { error: e2 } = await supabase.from('competitions').update({ status: 'void', state: 'closed', closed_reason: 'discontinued' }).eq('id', comp.id);
      if (e2) { report.errors.push(`close ${comp.id}: ${e2.message}`); continue; }
      report.instancesClosed += 1;
    }

    for (const acc of accounts) {
      if (!fee) continue;
      const key = `refund:${comp.id}:${acc.player_id}`;
      const { data, error: e3 } = await supabase.rpc('coin_apply', { p_player: acc.player_id, p_delta: fee, p_type: 'competition_refund', p_match: null, p_key: key });
      const dup = (e3 && (e3.hint === 'duplicate' || /duplicate key/i.test(e3.message || ''))) || (data && data.duplicate);
      if (e3 && !dup) { report.errors.push(`refund ${key}: ${e3.message}`); continue; }
      if (dup) { report.alreadyRefunded += 1; continue; }
      report.refunded += 1;
      report.coinsRefunded += fee;
      // stop any later prize payout on this account
      await supabase.from('comp_accounts').update({ prize_paid: true }).eq('id', acc.id);
      const name = NAMES[comp.frequency] || comp.title;
      const message = `The ${name} has been closed and your ${fee} coins are back in your balance.`;
      const { error: e4 } = await supabase.from('notifications').insert({ player_id: acc.player_id, type: 'comp_closed', data: { message, competitionId: comp.id, coins: fee } });
      if (!e4) report.notified += 1;
      if (sendEmail) {
        const { data: p } = await supabase.from('players').select('email, username').eq('id', acc.player_id).maybeSingle();
        if (p && p.email) {
          const out = await sendEmail({ to: p.email, idempotencyKey: `comp-closed:${comp.id}:${acc.player_id}`, ...closedEmail({ username: p.username, name, coins: fee }) });
          if (out && !out.error) report.emailed += 1;
        }
      }
      log(`refunded ${fee} coins (${key})`);
    }
  }
  return report;
}

module.exports = { closeDiscontinued, DISCONTINUED };
