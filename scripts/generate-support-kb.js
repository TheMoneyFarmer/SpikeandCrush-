'use strict';

// Regenerates the support assistant's code-derived knowledge base.
//   node scripts/generate-support-kb.js          -> .md files + DB upsert
//   node scripts/generate-support-kb.js --no-db  -> .md files only
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { writeMarkdownFiles, syncToDatabase } = require('../server/support/kbSync');

(async () => {
  if (process.argv.includes('--no-db')) {
    const articles = writeMarkdownFiles();
    console.log(`Wrote ${articles.length} articles (no DB).`);
    console.log('needs_review:', articles.filter((a) => a.needsReview).map((a) => a.slug).join(', '));
    return;
  }
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const result = await syncToDatabase(supabase);
  console.log(JSON.stringify(result, null, 2));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
