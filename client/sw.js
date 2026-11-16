'use strict';

// Spike & Crush service worker: caches the app shell's static files (CSS,
// JS, icons, fonts) so the installed app starts fast. It never caches API
// calls, the socket, prices, match pages or anything with a query string,
// and it makes no offline-play promises: pages always come from the network.
// The server stamps __SW_VERSION__ on every deploy, so a new deploy installs
// a new worker and drops the old cache.
const VERSION = '__SW_VERSION__';
const CACHE = `sc-shell-${VERSION}`;
const SHELL = ['/css/main.css', '/css/lobby-home.css', '/css/game.css', '/css/mobile.css', '/css/phone-land.css', '/js/main.js', '/js/icons.js', '/icons/icon-192.png', '/icons/icon-512.png'];

// Only these same-origin paths, GET, no query string.
const CACHEABLE = /^\/(css|js|icons|fonts|images|img)\//;
const NEVER = /^\/(api|socket\.io|internal|auth|admin)\b/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('sc-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.search || NEVER.test(url.pathname) || !CACHEABLE.test(url.pathname)) return; // network as usual
  // Static file: cache first, refreshed in the background.
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req);
    const fresh = fetch(req).then((res) => { if (res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
