'use strict';

// Offline tests for the support system: safety rules, upload validation and
// metadata stripping, markdown safety, tool exposure, and that the knowledge
// base and prompt quote the live game constants.
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

const safety = require('../server/support/safety');
const uploads = require('../server/support/uploads');
const md = require('../client/js/support-markdown');
const tools = require('../server/support/tools');
const { buildArticles } = require('../server/support/knowledge/articles');
const { buildSystemPrompt } = require('../server/support/agentPrompt');
const { GAME_RULES, MODE_DURATIONS, MATCH_MODES, RECONNECT_GRACE_SECONDS, baseRatingForPosition } = require('../server/gameEngine');
const { TEMPLATES } = require('../server/compEngine');

// ---- safety --------------------------------------------------------------------
test('human request is detected in code', () => {
  for (const t of ['Talk to a human', 'can I speak to a real person please', 'I want an agent', 'human', 'connect me with someone from the support team', 'you are not a bot right?']) {
    assert.ok(safety.detectHumanRequest(t), t);
  }
  for (const t of ['how long is a quick war', 'what is the human readable rating', 'hello']) assert.ok(!safety.detectHumanRequest(t), t);
});

test('always-escalate topics are detected', () => {
  const cases = {
    'I was charged but got no coins': 'payment',
    'why was I banned?': 'ban_appeal',
    'my account was hacked': 'hacked',
    'a player keeps harassing me in chat': 'safety',
    'please delete my data under GDPR': 'legal_data',
    'we want to sponsor a competition': 'sponsor',
    'there is a bug and I lost 200 coins': 'coin_bug',
  };
  for (const [text, topic] of Object.entries(cases)) assert.strictEqual((safety.detectEscalationTopic(text) || {}).topic, topic, text);
  assert.strictEqual(safety.detectEscalationTopic('how long is blitz war'), null);
});

test('PII masking hides card, IBAN and long ID numbers but keeps match UUIDs', () => {
  const r = safety.maskPII('card 4111 1111 1111 1111 cvv 123, iban GB82 WEST 1234 5698 7654 32, id 123456789012');
  assert.ok(r.masked);
  assert.ok(!/4111 1111 1111 1111/.test(r.text));
  assert.ok(!/cvv 123/.test(r.text));
  assert.ok(!/GB82 WEST/.test(r.text));
  assert.ok(!/123456789012/.test(r.text));
  const uuid = 'why did match 550e8400-e29b-41d4-a716-446655440000 end?';
  assert.strictEqual(safety.maskPII(uuid).text, uuid);
});

test('output filter strips keys, tokens, IPs and other people\'s emails', () => {
  const r = safety.filterOutput('key sk-ant-api03-abcdefghijklmnop and sk_live_abcdefghijklmnop jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ip 10.0.0.12 mail jane.doe@gmail.com contact hello@spikeandcrush.com');
  assert.ok(r.changed);
  assert.ok(!/sk-ant-api03/.test(r.text));
  assert.ok(!/sk_live_/.test(r.text));
  assert.ok(!/eyJhbGci/.test(r.text));
  assert.ok(!/10\.0\.0\.12/.test(r.text));
  assert.ok(!/jane\.doe@gmail\.com/.test(r.text));
  assert.ok(/j\*\*\*@gmail\.com/.test(r.text));
  assert.ok(/hello@spikeandcrush\.com/.test(r.text));
});

test('rate limits: 20 per conversation per 10 minutes, 100 per day', () => {
  safety.resetRateLimits();
  for (let i = 0; i < 20; i++) assert.ok(safety.checkRateLimit({ conversationId: 'c1', actorKey: 'p:1' }).ok, `msg ${i + 1}`);
  const blocked = safety.checkRateLimit({ conversationId: 'c1', actorKey: 'p:1' });
  assert.deepStrictEqual(blocked, { ok: false, scope: 'conversation' });
  safety.resetRateLimits();
  for (let i = 0; i < 100; i++) assert.ok(safety.checkRateLimit({ conversationId: `c${Math.floor(i / 20)}`, actorKey: 'p:2' }).ok, `msg ${i + 1}`);
  assert.deepStrictEqual(safety.checkRateLimit({ conversationId: 'cX', actorKey: 'p:2' }), { ok: false, scope: 'day' });
  safety.resetRateLimits();
});

test('guest IP is hashed with a daily salt, never stored raw', () => {
  const h = safety.hashIp('203.0.113.9');
  assert.match(h, /^[a-f0-9]{64}$/);
  assert.ok(!h.includes('203'));
  assert.strictEqual(h, safety.hashIp('203.0.113.9'));
  assert.notStrictEqual(h, safety.hashIp('203.0.113.10'));
});

// ---- uploads ----------------------------------------------------------------------
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function makePng(withText) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0]));
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), ...(withText ? [pngChunk('tEXt', Buffer.from('Comment\0GPS 51.5N SECRET')), pngChunk('eXIf', Buffer.from('MM\0*SECRETEXIF'))] : []), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
function makeJpeg() {
  const seg = (marker, payload) => {
    const b = Buffer.alloc(4);
    b[0] = 0xff;
    b[1] = marker;
    b.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([b, payload]);
  };
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')),
    seg(0xe1, Buffer.from('Exif\0\0GPSLatitude=51.5 SECRETEXIF')),
    seg(0xed, Buffer.from('Photoshop 3.0 SECRETIPTC')),
    seg(0xfe, Buffer.from('camera owner SECRETCOMMENT')),
    seg(0xdb, Buffer.alloc(65, 1)),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}
function makeWebp() {
  const chunk = (fourcc, data) => {
    const h = Buffer.alloc(8);
    h.write(fourcc, 0, 'ascii');
    h.writeUInt32LE(data.length, 4);
    return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04; // EXIF + XMP flags set
  const body = Buffer.concat([chunk('VP8X', vp8x), chunk('VP8 ', Buffer.alloc(10, 7)), chunk('EXIF', Buffer.from('SECRETEXIFGPS')), chunk('XMP ', Buffer.from('<x>SECRETXMP</x>'))]);
  const hdr = Buffer.alloc(12);
  hdr.write('RIFF', 0, 'ascii');
  hdr.writeUInt32LE(body.length + 4, 4);
  hdr.write('WEBP', 8, 'ascii');
  return Buffer.concat([hdr, body]);
}

test('an .exe renamed .png is rejected by magic bytes', () => {
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90), Buffer.from('This program cannot be run in DOS mode')]);
  assert.strictEqual(uploads.validateAndStrip(exe).error, 'Only PNG, JPG or WebP images can be attached.');
  assert.ok(uploads.validateAndStrip(Buffer.from('<svg onload=alert(1)>')).error);
});

test('images over 3 MB are rejected', () => {
  const big = Buffer.concat([makePng(false), Buffer.alloc(10 * 1024 * 1024)]);
  assert.strictEqual(uploads.validateAndStrip(big).error, 'Images must be 3 MB or smaller.');
});

test('EXIF / metadata is stripped from JPEG, PNG and WebP', () => {
  const j = uploads.validateAndStrip(makeJpeg());
  assert.strictEqual(j.mime, 'image/jpeg');
  assert.ok(!j.buffer.includes('SECRET'), 'jpeg still has metadata');
  assert.ok(j.buffer.includes('JFIF'));
  assert.deepStrictEqual([j.buffer[0], j.buffer[1]], [0xff, 0xd8]);
  assert.deepStrictEqual([j.buffer[j.buffer.length - 2], j.buffer[j.buffer.length - 1]], [0xff, 0xd9]);

  const p = uploads.validateAndStrip(makePng(true));
  assert.strictEqual(p.mime, 'image/png');
  assert.ok(!p.buffer.includes('SECRET'), 'png still has metadata');
  assert.ok(p.buffer.equals(makePng(false)), 'png pixels/structure changed');

  const w = uploads.validateAndStrip(makeWebp());
  assert.strictEqual(w.mime, 'image/webp');
  assert.ok(!w.buffer.includes('SECRET'), 'webp still has metadata');
  assert.strictEqual(w.buffer.readUInt32LE(4), w.buffer.length - 8, 'RIFF size not fixed');
  assert.strictEqual(w.buffer[20] & 0x0c, 0, 'VP8X EXIF/XMP flags not cleared');
});

// ---- markdown -----------------------------------------------------------------------
test('markdown renders safely (no raw HTML, no javascript: links)', () => {
  for (const payload of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '[x](https://a.com/"onmouseover="alert(1))', '<iframe src="https://evil">']) {
    const html = md.render(payload);
    assert.ok(!/<script|<img|<iframe|javascript:|onerror=|onmouseover="/i.test(html.replace(/&[a-z]+;/g, '')) || !/<(script|img|iframe)/i.test(html), payload);
    assert.ok(!/<(script|img|iframe)\b/i.test(html), payload);
    assert.ok(!/href="javascript/i.test(html), payload);
  }
  assert.strictEqual(md.render('**hi** [site](https://spikeandcrush.com)'), '<p><strong>hi</strong> <a href="https://spikeandcrush.com" target="_blank" rel="noopener noreferrer nofollow">site</a></p>');
});

// ---- tools ----------------------------------------------------------------------------
test('no tool accepts a user id, and only two tools can write', () => {
  for (const def of Object.values(tools.DEFINITIONS)) {
    const props = Object.keys(def.input_schema.properties || {});
    assert.ok(!props.some((p) => /user|player|account_id|email/i.test(p)), `${def.name} takes ${props}`);
    assert.strictEqual(def.input_schema.additionalProperties, false, def.name);
  }
  assert.deepStrictEqual(Array.from(tools.WRITE_TOOLS).sort(), ['create_ticket', 'escalate_to_human']);
});

test('guests only get search_kb, create_ticket and escalate_to_human', () => {
  assert.deepStrictEqual(tools.toolsFor({ playerId: null }).map((t) => t.name).sort(), ['create_ticket', 'escalate_to_human', 'search_kb']);
  assert.strictEqual(tools.toolsFor({ playerId: 'x' }).length, 10);
});

// ---- knowledge comes from code -----------------------------------------------------------
test('KB articles and prompt quote the live constants', () => {
  const all = buildArticles().map((a) => a.body).join('\n');
  assert.ok(all.includes(`$${GAME_RULES.STARTING_CAPITAL.toLocaleString('en-US')}`));
  assert.ok(all.includes(`${GAME_RULES.MAX_LOTS} lots`));
  assert.ok(all.includes(`${GAME_RULES.HARD_LOSS_PCT * 100}%`));
  assert.ok(all.includes(`${RECONNECT_GRACE_SECONDS} seconds`));
  for (const key of Object.keys(MATCH_MODES)) assert.ok(all.includes(`| ${MATCH_MODES[key].label} | ${MODE_DURATIONS[key] / 60} minute`), key);
  for (const t of Object.values(TEMPLATES)) assert.ok(all.includes(t.title), t.title);
  assert.ok(/no cash value and cannot be withdrawn/.test(all));
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes(`Starting capital $${GAME_RULES.STARTING_CAPITAL}`));
  assert.ok(/cannot be withdrawn/.test(prompt));
  assert.ok(!/\p{Extended_Pictographic}/u.test(prompt + all), 'emoji found');
});

test('last place always costs 25 rating, whatever the table size', () => {
  for (const n of [2, 3, 4, 6, 8]) assert.strictEqual(baseRatingForPosition(n, n), -25, `${n} players`);
  assert.strictEqual(baseRatingForPosition(1, 2), 25);
  assert.strictEqual(baseRatingForPosition(2, 3), 10);
  assert.strictEqual(baseRatingForPosition(3, 4), 0);
  assert.strictEqual(baseRatingForPosition(4, 6), -10);
});

test('the Help page no longer contradicts the game rules', () => {
  const help = require('fs').readFileSync(require('path').join(__dirname, '../client/help.html'), 'utf8');
  assert.ok(!/What Is Margin\?|Your open positions stay in the match|Quick War, Blitz, and Private/.test(help));
  assert.ok(help.includes(`${RECONNECT_GRACE_SECONDS} seconds to reconnect`));
});

test('bridge: right secret and place only; remote mode needs a long secret', () => {
  const { bridgeCallAllowed } = require('../server/bridgeAuth');
  const saved = { s: process.env.INTERNAL_ADMIN_SECRET, r: process.env.SUPPORT_BRIDGE_ALLOW_REMOTE };
  const req = (secret, ip) => ({ headers: { 'x-internal-secret': secret }, socket: { remoteAddress: ip } });
  const long = 'x'.repeat(48);
  process.env.INTERNAL_ADMIN_SECRET = long;
  delete process.env.SUPPORT_BRIDGE_ALLOW_REMOTE;
  assert.ok(bridgeCallAllowed(req(long, '127.0.0.1')));
  assert.ok(bridgeCallAllowed(req(long, '::ffff:127.0.0.1')));
  assert.ok(!bridgeCallAllowed(req(long, '10.0.0.5')), 'remote refused by default');
  assert.ok(!bridgeCallAllowed(req('y'.repeat(48), '127.0.0.1')), 'wrong secret');
  assert.ok(!bridgeCallAllowed(req(undefined, '127.0.0.1')), 'no secret');
  process.env.SUPPORT_BRIDGE_ALLOW_REMOTE = '1';
  assert.ok(bridgeCallAllowed(req(long, '10.0.0.5')), 'remote allowed when switched on');
  assert.ok(!bridgeCallAllowed(req('y'.repeat(48), '10.0.0.5')));
  process.env.INTERNAL_ADMIN_SECRET = 'short';
  assert.ok(!bridgeCallAllowed(req('short', '10.0.0.5')), 'short secret refused in remote mode');
  if (saved.s === undefined) delete process.env.INTERNAL_ADMIN_SECRET; else process.env.INTERNAL_ADMIN_SECRET = saved.s;
  if (saved.r === undefined) delete process.env.SUPPORT_BRIDGE_ALLOW_REMOTE; else process.env.SUPPORT_BRIDGE_ALLOW_REMOTE = saved.r;
});
