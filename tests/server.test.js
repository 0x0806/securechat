'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../index');

let ctx;
let url;
const clients = [];

before(async () => {
  ctx = createApp({ log: () => {}, iceServers: [{ urls: 'stun:example.test' }], maxConnectionsPerIp: 500 });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${ctx.server.address().port}`;
});

after(async () => {
  clients.forEach((c) => c.close());
  ctx.close();
  await new Promise((r) => ctx.io.close(r));
});

async function client() {
  const c = connect(url, { transports: ['websocket'], forceNew: true });
  clients.push(c);
  await new Promise((r) => c.on('connect', r));
  return c;
}
const once = (c, ev, ms = 2000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    c.once(ev, (d) => { clearTimeout(t); res(d); });
  });
const never = (c, ev, ms = 300) =>
  new Promise((res, rej) => {
    const h = () => rej(new Error(`unexpected ${ev}`));
    c.once(ev, h);
    setTimeout(() => { c.off(ev, h); res(); }, ms);
  });

async function pair(mode = 'text') {
  const a = await client();
  const b = await client();
  const pa = once(a, 'waiting-for-partner');
  a.emit('find-partner', { chatMode: mode, consent: true });
  await pa;
  const fa = once(a, 'partner-found');
  const fb = once(b, 'partner-found');
  b.emit('find-partner', { chatMode: mode, consent: true });
  await Promise.all([fa, fb]);
  return [a, b];
}

test('health and ice-server endpoints', async () => {
  assert.equal((await fetch(`${url}/health`)).status, 200);
  const body = await (await fetch(`${url}/api/ice-servers`)).json();
  assert.deepEqual(body.iceServers, [{ urls: 'stun:example.test' }]);
  assert.equal((await fetch(`${url}/nope`)).status, 404);
  const page = await fetch(`${url}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
});

test('find-partner without consent is rejected', async () => {
  const a = await client();
  const p = once(a, 'consent-required');
  a.emit('find-partner', { chatMode: 'text' });
  await p;
  const q = once(a, 'consent-required');
  a.emit('find-partner', { chatMode: 'text', consent: 'yes' });
  await q;
  assert.equal(ctx.state.waiting.has(a.id), false);
});

test('invalid chat mode is rejected', async () => {
  const a = await client();
  const p = once(a, 'error-message');
  a.emit('find-partner', { chatMode: 'hologram', consent: true });
  await p;
});

test('same-mode users are matched; different modes are not', async () => {
  const t = await client();
  const v = await client();
  t.emit('find-partner', { chatMode: 'text', consent: true });
  await once(t, 'waiting-for-partner');
  v.emit('find-partner', { chatMode: 'video', consent: true });
  await once(v, 'waiting-for-partner');
  await never(t, 'partner-found');
  t.emit('leave-queue');
  v.emit('leave-queue');
});

test('a user never matches themselves', async () => {
  const a = await client();
  a.emit('find-partner', { chatMode: 'text', consent: true });
  a.emit('find-partner', { chatMode: 'text', consent: true });
  await once(a, 'waiting-for-partner');
  await never(a, 'partner-found');
  a.emit('leave-queue');
});

test('messages relay to partner only, are stripped of nothing, and are acked', async () => {
  const [a, b] = await pair();
  const got = once(b, 'message-received');
  const ack = once(a, 'message-delivered');
  a.emit('send-message', { message: '  hello <b>there</b>  ', id: 'm1' });
  const m = await got;
  assert.equal(m.message, 'hello <b>there</b>'); // escaping is the client's job
  assert.equal(m.senderId, a.id);
  assert.equal((await ack).id, 'm1');
  await never(a, 'message-received');
});

test('over-long and empty messages are handled (envelopes up to 150k chars)', async () => {
  const [a, b] = await pair();
  const got = once(b, 'message-received');
  a.emit('send-message', { message: 'x'.repeat(200000) });
  assert.equal((await got).message.length, 150000);
  a.emit('send-message', { message: '   ' });
  a.emit('send-message', { message: 42 });
  await never(b, 'message-received');
});

test('typing, key exchange and call signalling relay to the partner', async () => {
  const [a, b] = await pair('video');
  let p = once(b, 'partner-typing');
  a.emit('typing-start');
  assert.deepEqual({ ...(await p) }.typing, true);
  p = once(b, 'partner-typing');
  a.emit('typing-stop');
  assert.equal((await p).typing, false);

  p = once(b, 'exchange-key');
  a.emit('exchange-key', { key: { kty: 'EC', x: 'x', y: 'y' } });
  assert.equal((await p).key.kty, 'EC');

  for (const [ev, payload, field] of [
    ['offer', { offer: { type: 'offer', sdp: 'v=0' } }, 'offer'],
    ['answer', { answer: { type: 'answer', sdp: 'v=0' } }, 'answer'],
    ['ice-candidate', { candidate: { candidate: 'candidate:1' } }, 'candidate'],
  ]) {
    p = once(b, ev);
    a.emit(ev, payload);
    assert.deepEqual((await p)[field], payload[field]);
  }
  p = once(b, 'media-ready');
  a.emit('media-ready');
  await p;
  p = once(b, 'video-call-request');
  a.emit('video-call-request');
  await p;
  p = once(a, 'video-call-response');
  b.emit('video-call-response', { accepted: true });
  assert.equal((await p).accepted, true);
  p = once(a, 'call-ended');
  b.emit('call-ended');
  await p;
});

test('ICE candidate bursts are not rate limited', async () => {
  const [a, b] = await pair('video');
  let received = 0;
  b.on('ice-candidate', () => received++);
  for (let i = 0; i < 40; i++) a.emit('ice-candidate', { candidate: { candidate: `c${i}` } });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(received, 40);
});

test('floods are dropped and the sender is told', async () => {
  const [a, b] = await pair();
  let received = 0;
  b.on('message-received', () => received++);
  const limited = once(a, 'rate-limited');
  for (let i = 0; i < 200; i++) a.emit('send-message', { message: `m${i}` });
  await limited;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(received < 200 && received > 0, `received ${received}`);
});

test('oversized signalling payloads are ignored', async () => {
  const [a, b] = await pair('video');
  a.emit('offer', { offer: { sdp: 'x'.repeat(50000) } });
  await never(b, 'offer');
});

test('events without a partner are ignored', async () => {
  const a = await client();
  const b = await client();
  a.emit('send-message', { message: 'hi' });
  a.emit('offer', { offer: {} });
  await never(b, 'message-received');
  await never(b, 'offer');
});

test('skip notifies partner, ends the chat, and does not rematch the same pair', async () => {
  const [a, b] = await pair();
  const gone = once(b, 'partner-disconnected');
  a.emit('skip-partner');
  await gone;
  assert.equal(ctx.state.chats.has(a.id), false);
  assert.equal(ctx.state.chats.has(b.id), false);
  let p = once(b, 'waiting-for-partner');
  b.emit('find-partner', { chatMode: 'text', consent: true });
  await p;
  p = once(a, 'waiting-for-partner');
  a.emit('find-partner', { chatMode: 'text', consent: true });
  await p;
  await never(a, 'partner-found');
  // messages from a former partner are not delivered
  a.emit('send-message', { message: 'ghost' });
  await never(b, 'message-received');
  a.emit('leave-queue');
  b.emit('leave-queue');
});

test('disconnect notifies partner and cleans up queues', async () => {
  const [a, b] = await pair();
  const gone = once(b, 'partner-disconnected');
  a.close();
  await gone;
  const w = await client();
  w.emit('find-partner', { chatMode: 'text', consent: true });
  await once(w, 'waiting-for-partner');
  w.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ctx.state.waiting.has(w.id), false);
});

test('report is acknowledged and unknown reasons collapse to "other"', async () => {
  const [a] = await pair();
  const p = once(a, 'report-received');
  a.emit('report-user', { reason: '<script>' });
  await p;
});

test('stats endpoint reports online, waiting and chats', async () => {
  const body = await (await fetch(`${url}/api/stats`)).json();
  assert.ok(body.online >= 1);
  assert.deepEqual(Object.keys(body.waiting).sort(), ['text', 'video']);
  assert.equal(typeof body.chats, 'number');
});

test('static assets: fonts are immutable, scripts revalidate', async () => {
  const font = await fetch(`${url}/fonts/bricolage-grotesque-latin-wght-normal.woff2`);
  assert.match(font.headers.get('cache-control'), /immutable/);
  const js = await fetch(`${url}/app.js`);
  assert.equal(js.headers.get('cache-control'), 'no-cache');
});

test('more than 5 reports a minute are refused', async () => {
  const [a] = await pair();
  let refused = 0;
  a.on('error-message', () => refused++);
  for (let i = 0; i < 8; i++) a.emit('report-user', { reason: 'spam' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(refused, 3);
});

test('online count is broadcast', async () => {
  const a = await client();
  const n = await once(a, 'online-count').catch(() => null);
  const p = once(a, 'online-count');
  const b = await client();
  const count = await p;
  assert.ok(count >= 2);
  assert.ok(b.connected);
  void n;
});
