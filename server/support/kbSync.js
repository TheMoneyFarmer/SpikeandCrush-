'use strict';

// Writes the code-derived knowledge articles to server/support/knowledge/*.md
// and upserts them into support_kb_articles with source='code'.
// Admin edits are never overwritten: a slug whose row has source 'admin'
// (an admin edited the generated article) is skipped, and an admin article
// with overrides_slug hides the code article at search time.

const fs = require('fs');
const path = require('path');
const { buildArticles, toMarkdown } = require('./knowledge/articles');

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');

function writeMarkdownFiles() {
  const articles = buildArticles();
  for (const a of articles) fs.writeFileSync(path.join(KNOWLEDGE_DIR, `${a.slug}.md`), toMarkdown(a));
  return articles;
}

async function syncToDatabase(supabase, { updatedBy = 'code-generator', writeFiles = true } = {}) {
  const articles = writeFiles ? writeMarkdownFiles() : buildArticles();
  const { data: existing, error } = await supabase.from('support_kb_articles').select('slug, source');
  if (error) throw error;
  const bySlug = new Map((existing || []).map((r) => [r.slug, r.source]));
  const rows = [];
  const skipped = [];
  for (const a of articles) {
    if (bySlug.has(a.slug) && bySlug.get(a.slug) !== 'code') {
      skipped.push(a.slug);
      continue;
    }
    const row = {
      slug: a.slug,
      title: a.title,
      body_md: a.body,
      category: a.category,
      tags: a.tags,
      source: 'code',
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    };
    // needs_review is only set when an article first appears, so an admin who
    // has reviewed one and cleared the flag doesn't see it come back.
    if (!bySlug.has(a.slug)) row.needs_review = Boolean(a.needsReview);
    rows.push(row);
  }
  if (rows.length) {
    // Inserts and updates go separately: one upsert batch would need the same
    // columns on every row, which would reset needs_review on existing articles.
    const fresh = rows.filter((r) => 'needs_review' in r);
    const existing2 = rows.filter((r) => !('needs_review' in r));
    if (fresh.length) {
      const { error: insErr } = await supabase.from('support_kb_articles').insert(fresh);
      if (insErr) throw insErr;
    }
    if (existing2.length) {
      const { error: upErr } = await supabase.from('support_kb_articles').upsert(existing2, { onConflict: 'slug' });
      if (upErr) throw upErr;
    }
  }
  return { written: rows.map((r) => r.slug), skippedAdminEdited: skipped, needsReview: articles.filter((a) => a.needsReview).map((a) => a.slug) };
}

module.exports = { writeMarkdownFiles, syncToDatabase, KNOWLEDGE_DIR };
