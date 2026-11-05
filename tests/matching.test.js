'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../index');
const Rules = require('../public/match-rules');

let ctx; let url;
const clients = [];
before(async () => {
  ctx = createApp({ log: () => {}, softWaitMs: 700, sweepMs: 100, rematchCooldownMs: 0, maxConnectionsPerIp: 40 });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${ctx.server.address().port}`;
});
after(async () => { clients.forEach((c) => c.close()); ctx.close(); await new Promise((r) => ctx.io.close(r)); });

const client = async () => {
  const c = connect(url, { transports: ['websocket'], forceNew: true });
  clients.push(c);
  await new Promise((r) => c.on('connect', r));
  return c;
};
const once = (c, ev, ms = 3000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
  c.once(ev, (d) => { clearTimeout(t); res(d); });
});
const never = (c, ev, ms = 400) => new Promise((res, rej) => {
  const h = () => rej(new Error(`unexpected ${ev}`));
  c.once(ev, h);
  setTimeout(() => { c.off(ev, h); res(); }, ms);
});
const find = (c, extra = {}) => c.emit('find-partner', { chatMode: 'text', consent: true, ...extra });

test('rules: normalisation limits and cleans input', () => {
  assert.deepEqual(Rules.normInterests([' Music ', 'music', 'C++', '<b>x</b>', 12, 'a'.repeat(40), 'one', 'two', 'three', 'four']),
    ['music', 'c++', 'bxb', 'a'.repeat(24), 'one']);
  assert.equal(Rules.normInterests('nope').length, 0);
  assert.equal(Rules.normLang('EN'), 'en');
  assert.equal(Rules.normLang('klingon!'), 'any');
  assert.equal(Rules.normRoom('AbC123'), 'abc123');
  assert.equal(Rules.normRoom('../x'), '');
  assert.equal(Rules.normAvoid(['a', 3, 'b'.repeat(80)]).length, 1);
});

test('rules: preferences are soft, mode and room are hard', () => {
  const base = { mode: 'text', room: '', interests: [], lang: 'any', waited: 0 };
  assert.ok(Rules.compatible({ ...base, interests: ['a'] }, { ...base, interests: ['a', 'b'] }));
  assert.ok(!Rules.compatible({ ...base, interests: ['a'] }, { ...base, interests: ['z'] }));
  assert.ok(Rules.compatible({ ...base, interests: ['a'] }, { ...base, interests: ['z'], waited: 9000 }));
  assert.ok(!Rules.compatible({ ...base, lang: 'en' }, { ...base, lang: 'es' }));
  assert.ok(Rules.compatible({ ...base, lang: 'en' }, { ...base, lang: 'any' }));
  assert.ok(!Rules.compatible({ ...base, waited: 99999 }, { ...base, mode: 'video', waited: 99999 }));
  assert.ok(!Rules.compatible({ ...base, room: 'abcd' }, { ...base, waited: 99999 }));
});

test('shared interests match quickly; the best overlap wins', async () => {
  const a = await client(); const b = await client(); const c = await client();
  find(a, { interests: ['music'] }); await once(a, 'waiting-for-partner');
  find(b, { interests: ['chess'] }); await once(b, 'waiting-for-partner');
  const fa = once(a, 'partner-found'); const fc = once(c, 'partner-found');
  find(c, { interests: ['music', 'art'] });
  const [pa, pc] = await Promise.all([fa, fc]);
  assert.equal(pa.partnerId, c.id);
  assert.equal(pc.partnerId, a.id);
  b.emit('leave-queue');
});

test('mismatched interests still match after the soft wait (nobody is stuck)', async () => {
  const a = await client(); const b = await client();
  find(a, { interests: ['pottery'] }); await once(a, 'waiting-for-partner');
  find(b, { interests: ['rockets'] }); await once(b, 'waiting-for-partner');
  await never(a, 'partner-found', 300);
  const t0 = Date.now();
  await Promise.all([once(a, 'partner-found'), once(b, 'partner-found')]);
  assert.ok(Date.now() - t0 >= 200, 'should have waited for the soft period');
});

test('language preference is soft too', async () => {
  const a = await client(); const b = await client();
  find(a, { lang: 'en' }); await once(a, 'waiting-for-partner');
  find(b, { lang: 'es' }); await once(b, 'waiting-for-partner');
  await Promise.all([once(a, 'partner-found', 4000), once(b, 'partner-found', 4000)]);
});

test('private rooms only match each other, regardless of waiting time', async () => {
  const a = await client(); const b = await client(); const outsider = await client();
  find(a, { room: 'friends1' }); await once(a, 'waiting-for-partner');
  find(outsider); await once(outsider, 'waiting-for-partner');
  await never(outsider, 'partner-found', 1200); // longer than the soft wait
  await never(a, 'partner-found', 100);
  const fa = once(a, 'partner-found');
  find(b, { room: 'FRIENDS1' });
  assert.equal((await fa).partnerId, b.id);
  outsider.emit('leave-queue');
});

test('blocked people are never matched, even after waiting', async () => {
  const a = await client(); const b = await client();
  find(b); await once(b, 'waiting-for-partner');
  find(a, { avoid: [b.id] }); await once(a, 'waiting-for-partner');
  await never(a, 'partner-found', 1200);
  await never(b, 'partner-found', 100);
  a.emit('leave-queue'); b.emit('leave-queue');
});

test('private room friends can pair again immediately (no cooldown)', async () => {
  const a = await client(); const b = await client();
  find(a, { room: 'again1' }); await once(a, 'waiting-for-partner');
  find(b, { room: 'again1' });
  await Promise.all([once(a, 'partner-found'), once(b, 'partner-found')]);
  a.emit('skip-partner'); await once(b, 'partner-disconnected');
  find(b, { room: 'again1' }); await once(b, 'waiting-for-partner');
  find(a, { room: 'again1' });
  await Promise.all([once(a, 'partner-found'), once(b, 'partner-found')]);
});

test('per-address connection cap refuses extra sockets', async () => {
  const limited = createApp({ log: () => {}, maxConnectionsPerIp: 2 });
  await new Promise((r) => limited.server.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${limited.server.address().port}`;
  const mk = () => connect(u, { transports: ['websocket'], forceNew: true, reconnection: false });
  const c1 = mk(); const c2 = mk();
  await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
  const c3 = mk();
  const err = await once(c3, 'connect_error');
  assert.equal(err.message, 'too-many-connections');
  [c1, c2, c3].forEach((c) => c.close());
  limited.close();
  await new Promise((r) => limited.io.close(r));
});
