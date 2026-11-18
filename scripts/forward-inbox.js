#!/usr/bin/env node
'use strict';

// Forwards mail already sitting in Resend > Receiving (from before the webhook
// existed) to INBOUND_FORWARD_TO. Dry run by default: lists what it would send.
//   node scripts/forward-inbox.js            list received emails
//   node scripts/forward-inbox.js --send     forward them (each email once:
//                                            Resend drops repeats for 24 h)
// Needs RESEND_API_KEY and INBOUND_FORWARD_TO in the environment or .env.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createInboundForwarder, forwardTargets } = require('../server/inboundEmail');

(async () => {
  const send = process.argv.includes('--send');
  const fwd = createInboundForwarder();
  const list = await fwd.api('/emails/receiving?limit=100');
  const rows = list.data || [];
  console.log(`${rows.length} received email(s). Forward to: ${forwardTargets().length ? `${forwardTargets().length} address(es)` : 'NOT SET (INBOUND_FORWARD_TO)'}`);
  for (const e of rows) {
    const line = `${e.created_at.slice(0, 16)}  ${e.subject || '(no subject)'}  (${(e.attachments || []).length} attachment(s))`;
    if (!send) { console.log(`  would forward: ${line}`); continue; }
    try {
      const r = await fwd.forward(e.id);
      console.log(`  ${r.ok ? 'forwarded' : `skipped (${r.reason})`}: ${line}`);
    } catch (err) {
      console.log(`  FAILED: ${line}: ${err.message}`);
    }
  }
  if (!send) console.log('Dry run. Add --send to forward.');
})().catch((e) => { console.error(e.message); process.exit(1); });
