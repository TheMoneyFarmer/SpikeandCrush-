#!/usr/bin/env node
'use strict';
// Closes the Weekly and Monthly competitions and refunds their entrants once.
//   node scripts/close-discontinued-competitions.js          # dry run: counts only
//   node scripts/close-discontinued-competitions.js --run    # do it (safe to repeat)
// In production, use the admin Competitions page instead (same code, audit-logged).
const { createClient } = require('@supabase/supabase-js');
const { closeDiscontinued } = require('../server/compClosure');
const { sendEmail } = require('../admin/lib/email');
(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and the service key are required');
  const supabase = createClient(url, key);
  const run = process.argv.includes('--run');
  const report = await closeDiscontinued({ supabase, sendEmail, dryRun: !run, log: (m) => console.log('  ' + m) });
  console.log(JSON.stringify({ ...report, instances: report.instances.map((i) => `${i.frequency} ${i.status} entrants=${i.entrants} fee=${i.fee}`) }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
