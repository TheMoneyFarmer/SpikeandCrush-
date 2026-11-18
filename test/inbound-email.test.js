'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createInboundForwarder, verifySignature, forwardTargets } = require('../server/inboundEmail');

const SECRET = `whsec_${Buffer.from('test-secret-key-32-bytes-long!!!').toString('base64')}`;
function sign(body, id = 'msg_1', ts = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(SECRET.slice(6), 'base64');
  return { id, timestamp: String(ts), signature: `v1,${crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}` };
}

test('signature: valid passes; tampered body, wrong secret, old timestamp fail', () => {
  const body = '{"type":"email.received"}';
  const h = sign(body);
  assert.ok(verifySignature({ secret: SECRET, body, ...h }));
  assert.ok(verifySignature({ secret: SECRET, body, ...h, signature: `v1,AAAA ${h.signature}` }), 'any listed signature may match');
  assert.ok(!verifySignature({ secret: SECRET, body: body + ' ', ...h }));
  assert.ok(!verifySignature({ secret: `whsec_${Buffer.from('other').toString('base64')}`, body, ...h }));
  const old = sign(body, 'msg_1', Math.floor(Date.now() / 1000) - 600);
  assert.ok(!verifySignature({ secret: SECRET, body, ...old }));
  assert.ok(!verifySignature({ secret: '', body, ...h }));
});

test('targets never include our own domain (no forwarding loop)', () => {
  assert.deepStrictEqual(forwardTargets('me@gmail.com, hello@spikeandcrush.com, bad', 'spikeandcrush.com'), ['me@gmail.com']);
  assert.deepStrictEqual(forwardTargets('', 'spikeandcrush.com'), []);
});

function fakeFetch(calls) {
  return async (url, opts = {}) => {
    calls.push({ url, opts });
    const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o, arrayBuffer: async () => new ArrayBuffer(0) });
    if (url.endsWith('/emails/receiving/em_1')) return json({ id: 'em_1', from: 'jo@partner.example', to: ['hello@spikeandcrush.com'], subject: 'Partnership', html: '<p>Hi</p>', text: 'Hi', reply_to: [], headers: { from: 'Jo <jo@partner.example>' }, created_at: '2026-11-14T10:00:00Z' });
    if (url.includes('/attachments')) return json({ data: [{ filename: 'deck.pdf', size: 3, content_type: 'application/pdf', download_url: 'https://cdn.example/deck' }] });
    if (url === 'https://cdn.example/deck') return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('pdf') };
    if (url.endsWith('/emails') && opts.method === 'POST') return json({ id: 'sent_1' });
    return json({ message: 'nope' }, 404);
  };
}

test('forward: fetches body and attachments, sends once with reply-to the sender', async () => {
  const calls = [];
  const fwd = createInboundForwarder({ fetchImpl: fakeFetch(calls), apiKey: () => 're_test', targets: () => ['me@gmail.com'], log: { warn() {}, error() {} } });
  const r = await fwd.forward('em_1');
  assert.deepStrictEqual(r, { ok: true, id: 'sent_1' });
  const send = calls.find((c) => c.opts.method === 'POST');
  const body = JSON.parse(send.opts.body);
  assert.deepStrictEqual(body.to, ['me@gmail.com']);
  assert.deepStrictEqual(body.reply_to, ['jo@partner.example']);
  assert.strictEqual(body.subject, 'Partnership', 'subject unchanged, so replies carry no tag');
  assert.strictEqual(body.attachments[0].filename, 'deck.pdf');
  assert.strictEqual(Buffer.from(body.attachments[0].content, 'base64').toString(), 'pdf');
  assert.strictEqual(send.opts.headers['Idempotency-Key'], 'inbound-fwd:em_1');
});

test('webhook: rejects unsigned, ignores other events, forwards email.received', async () => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  const calls = [];
  const fwd = createInboundForwarder({ fetchImpl: fakeFetch(calls), apiKey: () => 're_test', targets: () => ['me@gmail.com'], log: { warn() {}, error() {} } });
  const handler = fwd.webhook();
  const run = async (raw, headers) => {
    let out = { status: 200 };
    const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
    await handler({ body: Buffer.from(raw), get: (h) => headers[h] }, res);
    return out;
  };
  const good = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1' } });
  assert.strictEqual((await run(good, {})).status, 401);
  const h = sign(good);
  const ok = await run(good, { 'svix-id': h.id, 'svix-timestamp': h.timestamp, 'svix-signature': h.signature });
  assert.deepStrictEqual(ok.body, { forwarded: true });
  const other = JSON.stringify({ type: 'email.sent', data: {} });
  const h2 = sign(other);
  assert.deepStrictEqual((await run(other, { 'svix-id': h2.id, 'svix-timestamp': h2.timestamp, 'svix-signature': h2.signature })).body, { ignored: true });
  delete process.env.RESEND_WEBHOOK_SECRET;
});
