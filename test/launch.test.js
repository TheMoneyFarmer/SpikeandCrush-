'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PAGES, isNoindexPath, SITEMAP_PATHS } = require('../server/seoConfig');
const { competitionTags } = require('../server/seo');
const { buildCsp } = require('../server/securityHeaders');

test('every title and description fits, and each is unique', () => {
  const titles = new Set();
  for (const [file, p] of Object.entries(PAGES)) {
    assert.ok(p.title.length <= 60, `${file} title ${p.title.length}`);
    assert.ok(p.description.length <= 155, `${file} description ${p.description.length}`);
    assert.ok(!titles.has(p.title), `${file} repeats a title`);
    titles.add(p.title);
    assert.doesNotMatch(`${p.title} ${p.description}`, /[$€£]|win cash/i, file);
  }
});

test('private pages are noindex, public ones are not, and the sitemap lists only public ones', () => {
  for (const p of ['/play', '/wallet', '/thanks/signup', '/invite/ABC', '/r/x', '/game.html', '/profile/someone', '/lobby.html']) assert.ok(isNoindexPath(p), p);
  for (const p of ['/', '/competitions', '/terms', '/competition/abc', '/help', '/contact', '/privacy', '/cookies', '/terms.html']) assert.ok(!isNoindexPath(p), p);
  for (const p of SITEMAP_PATHS) assert.ok(!isNoindexPath(p), p);
});

test('competition tags are escaped, in coins, and indexable', () => {
  const html = '<title>x</title><meta name="description" content="x" /><meta name="robots" content="noindex" />\n<link rel="canonical" href="x" /><meta property="og:title" content="x" /><meta property="og:description" content="x" /><meta property="og:url" content="x" />';
  const out = competitionTags(html, { id: 'abc', title: '<script>alert(1)</script>', prize_pool: 5000, entry_fee_coins: 10 });
  assert.ok(!out.includes('<script>'));
  assert.match(out, /5,000 coins/);
  assert.doesNotMatch(out, /\$/);
  assert.doesNotMatch(out, /name="robots"/);
  assert.match(out, /canonical" href="https:\/\/www\.spikeandcrush\.com\/competition\/abc"/);
});

test('the security policy opens for an analytics provider only when one is set', () => {
  const before = process.env.ANALYTICS_PROVIDER;
  delete process.env.ANALYTICS_PROVIDER;
  assert.doesNotMatch(buildCsp(), /plausible|googletagmanager/);
  process.env.ANALYTICS_PROVIDER = 'plausible';
  assert.match(buildCsp(), /plausible\.io/);
  assert.doesNotMatch(buildCsp({ admin: true }), /plausible/);
  if (before === undefined) delete process.env.ANALYTICS_PROVIDER; else process.env.ANALYTICS_PROVIDER = before;
});

test('Google sign-ups from the drawer record Terms acceptance; other routes do not claim it', () => {
  const fs = require('fs');
  const read = (f) => fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
  assert.match(read('client/landing.html'), /onclick="TW\.loginWithGoogle\(true\)"/);
  assert.match(read('client/landing.html'), /By continuing you agree to our <a href="\/terms">Terms<\/a>/);
  const auth = read('client/js/auth.js');
  assert.match(auth, /if \(agreed === true\) sessionStorage\.setItem\('sc_oauth_terms', '1'\);\s*else sessionStorage\.removeItem\('sc_oauth_terms'\);/);
  const cb = read('client/auth-callback.html');
  assert.match(cb, /sessionStorage\.removeItem\('sc_oauth_terms'\)/);
  assert.match(cb, /termsAccepted \}\)/);
  const server = read('server/index.js');
  const oauth = server.slice(server.indexOf("app.post('/api/auth/oauth-callback'"));
  assert.match(oauth.slice(0, 3000), /createPlayer[\s\S]{0,120}recordTermsAcceptance\(player, req\.body\?\.termsAccepted\)/);
  assert.match(server, /async function recordTermsAcceptance\(player, accepted\) \{\s*if \(accepted !== true\) return;/);
});
