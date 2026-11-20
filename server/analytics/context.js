'use strict';

// Request context for analytics: who (as a daily-rotating hash, never a raw
// address), what device, which browser family, which country (country only,
// from Cloudflare's header), and whether it looks like a bot.
//
// The visitor address comes from originLock.visitorIp, which trusts
// Cloudflare's header only when the request provably came through Cloudflare
// (req.ip on Railway is the proxy, shared by everyone).

const crypto = require('crypto');
const { visitorIp } = require('../originLock');
const { signingSecret } = require('../envCheck');

const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

// HMAC key for one UTC day. Yesterday's hashes cannot be linked to today's,
// and nothing raw is ever stored.
function daySalt(d = day()) {
  return crypto.createHmac('sha256', signingSecret('analytics-day-salt', 'IP_HASH_SECRET')).update(`day|${d}`).digest();
}

// One visitor for one day: address + browser string, hashed with the day's salt.
function visitorDayHash(req, d = day()) {
  const ua = String((req.headers && req.headers['user-agent']) || '');
  return crypto.createHmac('sha256', daySalt(d)).update(`${visitorIp(req)}|${ua}`).digest('hex').slice(0, 32);
}

function deviceClass(ua = '') {
  const s = String(ua);
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(s)) return 'phone';
  if (!s) return 'unknown';
  return 'desktop';
}

function browserFamily(ua = '') {
  const s = String(ua);
  if (/Edg\//.test(s)) return 'edge';
  if (/OPR\/|Opera/.test(s)) return 'opera';
  if (/SamsungBrowser/.test(s)) return 'samsung';
  if (/Firefox\//.test(s)) return 'firefox';
  if (/Chrome\//.test(s) || /CriOS/.test(s)) return 'chrome';
  if (/Safari\//.test(s)) return 'safari';
  return 'other';
}

// Country code only (Cloudflare adds CF-IPCountry). Never a city or coordinates.
function coarseCountry(req) {
  const c = String((req.headers && req.headers['cf-ipcountry']) || '').toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

// Known crawlers and tools, plus browsers that never send the headers every
// real browser sends. The collector is JavaScript-only, so no-JS fetches never
// reach it at all.
const CRAWLER = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|facebot|embedly|quora link preview|whatsapp|telegrambot|discordbot|slackbot|twitterbot|linkedinbot|pinterest|skypeuripreview|redditbot|applebot|yandex|baiduspider|duckduckbot|semrush|ahrefs|mj12bot|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|amazonbot|preview|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|statuscake|headless|phantomjs|puppeteer|playwright|selenium|curl|wget|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java\/|libwww|node-fetch|axios|postman|insomnia/i;
function isBot(req) {
  const h = req.headers || {};
  const ua = String(h['user-agent'] || '');
  if (!ua || ua.length < 20 || CRAWLER.test(ua)) return true;
  if (!h['accept-language']) return true; // real browsers always send it
  return false;
}

function fromReq(req) {
  const ua = String((req.headers && req.headers['user-agent']) || '');
  return { device_class: deviceClass(ua), browser_family: browserFamily(ua), coarse_country: coarseCountry(req), visitor_day_hash: visitorDayHash(req) };
}

module.exports = { day, daySalt, visitorDayHash, deviceClass, browserFamily, coarseCountry, isBot, fromReq, CRAWLER };
