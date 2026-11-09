'use strict';

// Everything that needs the server for SEO and error pages: the noindex header,
// the sitemap, competition page tags and the final 404/500 handlers.
const fs = require('fs');
const path = require('path');
const { SITE, SITEMAP_PATHS, isNoindexPath } = require('./seoConfig');

const CLIENT = path.join(__dirname, '..', 'client');
const SITEMAP_TTL_MS = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOINDEX = 'noindex, nofollow';
const wantsPage = (req) => req.method === 'GET' && /\btext\/html\b/.test(req.headers.accept || '');

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeXml = (s) => escapeHtml(s).replace(/'/g, '&apos;');

const cache = new Map();
function page(file) {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(CLIENT, file), 'utf8'));
  return cache.get(file);
}

function noindexHeader(req, res, next) {
  if (isNoindexPath(req.path)) res.setHeader('X-Robots-Tag', NOINDEX);
  next();
}

function notFoundPage(res, { heading, message } = {}) {
  let html = page('404.html');
  if (heading) html = html.replace('This page went down.', escapeHtml(heading));
  if (message) html = html.replace('It may have moved, or the link may be wrong.', escapeHtml(message));
  res.status(404).setHeader('X-Robots-Tag', NOINDEX);
  return res.type('html').send(html);
}

function createSitemap(db) {
  let cached = null;
  return async (req, res) => {
    if (!cached || Date.now() - cached.at > SITEMAP_TTL_MS) {
      const urls = SITEMAP_PATHS.map((p) => ({ loc: `${SITE}${p}` }));
      try {
        if (db.isConfigured) {
          const live = (await db.listPublishedCompetitions()).filter((c) => !['ended', 'completed', 'cancelled', 'settled'].includes(c.status));
          for (const c of live.slice(0, 49000)) urls.push({ loc: `${SITE}/competition/${c.id}`, lastmod: c.updated_at || c.created_at });
        }
      } catch (e) {
        console.error('[sitemap]', e.message);
      }
      const body = urls.map((u) => `  <url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString()}</lastmod>` : ''}</url>`).join('\n');
      cached = { at: Date.now(), xml: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n` };
    }
    res.type('application/xml').setHeader('Cache-Control', 'public, max-age=3600');
    res.send(cached.xml);
  };
}

function competitionTags(html, comp) {
  const title = `${comp.title || comp.name || 'Competition'} | Spike & Crush`.slice(0, 60);
  const parts = [`${comp.title || comp.name || 'A trading competition'}.`];
  const prize = Number(comp.prize_pool);
  if (prize > 0) parts.push(`Prize pool ${prize.toLocaleString('en-US')} coins.`);
  parts.push(Number(comp.entry_fee_coins) > 0 ? `Entry ${comp.entry_fee_coins} coins.` : 'Free to enter.');
  parts.push('Coins have no cash value.');
  const description = parts.join(' ').slice(0, 155);
  const url = `${SITE}/competition/${comp.id}`;
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, `$1${escapeHtml(description)}`)
    .replace(/(<meta property="og:title" content=")[^"]*/, `$1${escapeHtml(title)}`)
    .replace(/(<meta property="og:description" content=")[^"]*/, `$1${escapeHtml(description)}`)
    .replace(/(<meta property="og:url" content=")[^"]*/, `$1${url}`)
    .replace(/(<link rel="canonical" href=")[^"]*/, `$1${url}`)
    .replace(/<meta name="robots"[^>]*>\n?/, '');
}

// A database problem still serves the page, which loads its own data. Only an id
// that's definitely wrong gets the friendly 404.
function createCompetitionPage(db) {
  const missing = (res) => notFoundPage(res, { heading: 'Competition not found.', message: 'It may have ended, or the link may be wrong.' });
  return async (req, res) => {
    const { id } = req.params;
    if (!db.isConfigured) return res.type('html').send(page('competition-play.html'));
    if (!UUID.test(id)) return missing(res);
    try {
      const comp = await db.getCompetitionById(id);
      if (!comp || comp.is_published === false) return missing(res);
      return res.type('html').send(competitionTags(page('competition-play.html'), comp));
    } catch (e) {
      if (e && e.code === 'PGRST116') return missing(res);
      console.error('[competition page]', e.message);
      return res.type('html').send(page('competition-play.html'));
    }
  };
}

// Registered last. Browsers get the page; everything else (a missing image, a
// script) gets a short plain answer rather than a page of HTML.
function notFoundHandler(req, res) {
  if (wantsPage(req)) return notFoundPage(res);
  return res.status(404).type('text').send('Not found');
}

// Pages get the 500 page; API callers keep the JSON they already rely on.
function errorPageFor(req, res, err) {
  const status = err.status || err.statusCode;
  const isNavigation = wantsPage(req) && !req.path.startsWith('/api');
  if (!isNavigation || (status && status < 500)) return false;
  res.status(500).setHeader('X-Robots-Tag', NOINDEX);
  res.type('html').send(page('500.html'));
  return true;
}

module.exports = { noindexHeader, createSitemap, createCompetitionPage, notFoundHandler, errorPageFor, competitionTags };
