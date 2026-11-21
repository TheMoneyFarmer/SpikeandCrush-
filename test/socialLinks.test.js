'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const social = require('../server/socialLinks');

test('each platform only accepts its own site', () => {
  assert.deepStrictEqual(social.normalizeLink('instagram', 'https://www.instagram.com/spikeandcrush'), { url: 'https://www.instagram.com/spikeandcrush' });
  assert.deepStrictEqual(social.normalizeLink('instagram', 'instagram.com/spikeandcrush'), { url: 'https://instagram.com/spikeandcrush' });
  assert.deepStrictEqual(social.normalizeLink('x', 'http://twitter.com/sc'), { url: 'https://twitter.com/sc' });
  assert.ok(social.normalizeLink('x', 'https://x.com/sc').url);
  assert.ok(social.normalizeLink('threads', 'https://www.threads.net/@sc').url);
  assert.ok(social.normalizeLink('discord', 'https://discord.gg/abc123').url);
  assert.ok(social.normalizeLink('facebook', 'https://facebook.com/sc').url);
  for (const [k, bad] of [
    ['instagram', 'https://evil.example/instagram.com'],
    ['instagram', 'https://instagram.com.evil.example/x'],
    ['instagram', 'https://notinstagram.com/x'],
    ['facebook', 'javascript:alert(1)'],
    ['discord', 'data:text/html,hi'],
    ['x', 'https://user:pass@x.com/sc'],
    ['threads', 'ftp://threads.net/x'],
  ]) assert.ok(social.normalizeLink(k, bad).error, `${k} ${bad}`);
  assert.deepStrictEqual(social.normalizeLink('instagram', '  '), { url: '' }, 'empty clears the link');
  assert.ok(social.normalizeLink('tiktok', 'https://tiktok.com/x').error, 'unknown platforms refused');
});

test('the public list keeps order, drops empty and bad saved links', () => {
  const links = social.publicLinks({ facebook: 'https://facebook.com/sc', instagram: 'https://instagram.com/sc', x: '', discord: 'https://evil.example', extra: 'https://instagram.com/x' });
  assert.deepStrictEqual(links.map((l) => l.key), ['instagram', 'facebook']);
  assert.deepStrictEqual(social.publicLinks(null), []);
});

test('Discord account linking is gone', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  assert.ok(!/api\/discord/.test(read('server/index.js')), 'no Discord routes on the server');
  assert.ok(!/connectDiscord/.test(read('client/js/main.js')));
  assert.ok(!/discord/i.test(read('client/settings.html')), 'nothing about Discord in Settings');
  assert.ok(!/discord\.com/.test(read('server/securityHeaders.js')), 'forms can no longer post to Discord');
});
