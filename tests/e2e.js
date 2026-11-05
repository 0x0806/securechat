'use strict';
/*
 * End-to-end tests: two real Chromium browsers talk to each other.
 *
 *   node tests/e2e.js                       run against the Node server AND the static (GitHub Pages style) build
 *   node tests/e2e.js --only=server|static  run one transport
 *   node tests/e2e.js --url=https://0x0806.github.io/securechat/   run against a deployed site (serverless)
 *   node tests/e2e.js --screenshots         also write docs/screenshots/*.png
 *
 * Needs a Chromium binary: set CHROMIUM_PATH, or it tries common locations.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');
const { createApp } = require('../index');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const SHOTS = path.join(__dirname, '..', 'docs', 'screenshots');
const results = [];
let currentSuite = '';

function findChromium() {
  const c = [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
    .filter(Boolean).find((p) => fs.existsSync(p));
  if (!c) throw new Error('No Chromium found. Set CHROMIUM_PATH.');
  return c;
}

async function check(name, fn) {
  const label = `${currentSuite} › ${name}`;
  try { await fn(); results.push({ label, ok: true }); console.log(`  ✔ ${name}`); }
  catch (err) {
    results.push({ label, ok: false, err });
    console.log(`  ✘ ${name}\n      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

/** Static file server that mounts ./public under /securechat/ like a GitHub project page. */
function serveStatic() {
  const root = path.join(__dirname, '..', 'public');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!u.pathname.startsWith('/securechat/')) { res.writeHead(404); return res.end('nope'); }
    let rel = decodeURIComponent(u.pathname.slice('/securechat/'.length)) || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/securechat/` })));
}

async function newPage(browser, url, { width = 1280, height = 800, consent = false, dark = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height }, permissions: ['camera', 'microphone'], colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: width < 600 ? 2 : 1
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) page.errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !/\/health$/.test(r.url())) page.errors.push(`http ${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => page.errors.push(`requestfailed ${r.url()} ${r.failure() && r.failure().errorText}`));
  await page.goto(url);
  if (consent) await agree(page);
  return page;
}

async function agree(page) {
  try { await page.waitForSelector('#consentDialog[open]', { timeout: 30000 }); }
  catch (err) { throw new Error(`consent dialog never opened. page errors: ${(page.errors || []).join(' | ') || 'none'}`); }
  await page.check('#ageCheck');
  await page.check('#termsCheck');
  await page.click('#consentAgree');
  await page.waitForFunction(() => !document.getElementById('consentDialog').open);
  await page.waitForFunction(() => !document.getElementById('startTextBtn').disabled, null, { timeout: 30000 });
}

async function startBoth(a, b, mode) {
  const btn = mode === 'video' ? '#startVideoBtn' : '#startTextBtn';
  await a.click(btn);
  await a.waitForSelector('#waitingScreen:not(.hidden)');
  await b.click(btn);
  await Promise.all([a, b].map((p) => p.waitForSelector('#sessionScreen:not(.hidden)', { timeout: 40000 })));
}
const encrypted = (p) => p.waitForFunction(() => !document.getElementById('messageInput').disabled, null, { timeout: 15000 });
const texts = (p) => p.$$eval('#messages .msg p', (n) => n.map((x) => x.textContent));
const theirs = (p) => p.$$eval('#messages .msg.them p', (n) => n.map((x) => x.textContent));
async function send(p, text) { await p.fill('#messageInput', text); await p.press('#messageInput', 'Enter'); }
const remotePlaying = (p) => p.waitForFunction(() => {
  const v = document.getElementById('remoteVideo');
  return v.videoWidth > 0 && v.readyState >= 2 && !v.paused;
}, null, { timeout: 45000 });
const pcState = (p) => p.evaluate(() => window.__securechat.state.pc && window.__securechat.state.pc.connectionState);

const dump = (p) => p.evaluate(() => {
  const S = window.__securechat.state; const t = S.transport;
  return JSON.stringify({ aes: !!S.aes, key: !!S.pendingKey, partner: S.partnerId && S.partnerId.slice(0, 4), me: String(t.id).slice(0, 4), tstate: t.state, room: t.room && t.room.slice(0, 4), tp: t.partner && t.partner.slice(0, 4), links: t.links && t.links.map((l) => l.up), msgs: [...document.querySelectorAll('#messages > *')].map((x) => `${x.className}:${x.textContent.slice(0, 40)}`) });
});

async function suite(browser, name, baseUrl, query, opts = {}) {
  currentSuite = name;
  console.log(`\n${name}  (${baseUrl}${query})`);
  const url = baseUrl + query;
  let a; let b;

  await check('consent dialog blocks the app until both boxes are ticked', async () => {
    a = await newPage(browser, url);
    await a.waitForSelector('#consentDialog[open]');
    assert(await a.isDisabled('#startTextBtn') && await a.isDisabled('#startVideoBtn'), 'start buttons should be disabled');
    assert(await a.isDisabled('#consentAgree'), 'agree should start disabled');
    await a.check('#ageCheck');
    assert(await a.isDisabled('#consentAgree'), 'agree must stay disabled with one box ticked');
    await a.keyboard.press('Escape');
    await a.keyboard.press('Escape');
    await sleep(150);
    assert(await a.evaluate(() => document.getElementById('consentDialog').open), 'Escape must not dismiss consent');
    await a.uncheck('#ageCheck');
    await a.check('#termsCheck');
    assert(await a.isDisabled('#consentAgree'), 'agree must stay disabled with the other box ticked');
    if (opts.shots) await a.screenshot({ path: path.join(SHOTS, 'consent.png') });
    await agree(a);
  });

  await check('consent is remembered after a reload', async () => {
    await a.reload();
    await a.waitForFunction(() => !document.getElementById('startTextBtn').disabled, null, { timeout: 30000 });
    assert(!(await a.evaluate(() => document.getElementById('consentDialog').open)), 'dialog should not reopen');
  });

  await check('rules dialog opens and withdrawing consent brings the gate back', async () => {
    await a.click('#rulesLink');
    await a.waitForSelector('#rulesDialog[open]');
    await a.click('#withdrawConsent');
    await a.waitForSelector('#consentDialog[open]');
    assert(await a.isDisabled('#startTextBtn'));
    await agree(a);
  });

  if (opts.shots) {
    await a.waitForFunction(() => document.getElementById('onlineChip').classList.contains('live'));
    await a.waitForTimeout(400);
    await a.screenshot({ path: path.join(SHOTS, 'welcome-light.png') });
    await a.click('#themeBtn');
    await a.waitForTimeout(250);
    await a.screenshot({ path: path.join(SHOTS, 'welcome-dark.png') });
    await a.click('#themeBtn');
  }

  b = await newPage(browser, url, { consent: true });

  await check('text chat: match, encrypt, matching safety codes', async () => {
    await a.click('#startTextBtn');
    await a.waitForSelector('#waitingScreen:not(.hidden)');
    await b.click('#startTextBtn');
    await Promise.all([a, b].map((p) => p.waitForSelector('#sessionScreen:not(.hidden)', { timeout: 40000 })));
    await Promise.all([a, b].map(encrypted));
    const [ca, cb] = await Promise.all([a, b].map((p) => p.textContent('#safetyCode')));
    assert(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/.test(ca), `bad code format: ${ca}`);
    assert(ca === cb, `safety codes differ: ${ca} vs ${cb}`);
    assert(await a.isVisible('#safetyChip'), 'encrypted chip visible');
  });

  await check('messages flow both ways, show delivery, and render safely', async () => {
    await send(a, 'Hello from A 👋');
    await b.waitForFunction(() => document.querySelectorAll('#messages .msg.them').length === 1);
    await send(b, 'Hi A, this is B');
    await a.waitForFunction(() => document.querySelectorAll('#messages .msg.them').length === 1);
    assert((await texts(b)).includes('Hello from A 👋'));
    assert((await texts(a)).includes('Hi A, this is B'));
    await a.waitForFunction(() => /Delivered/.test(document.querySelector('#messages .msg.own .delivery').textContent));
    await send(a, '<img src=x onerror="window.__pwned=1"> https://example.com/path');
    await b.waitForFunction(() => document.querySelectorAll('#messages .msg.them').length === 2);
    assert(!(await b.evaluate(() => window.__pwned)), 'XSS executed');
    assert(await b.$$eval('#messages img', (n) => n.length) === 0, 'message produced an <img>');
    assert((await theirs(b))[1].includes('<img src=x'), 'markup should show as literal text');
    const href = await b.$eval('#messages .msg.them:last-child a', (x) => `${x.href}|${x.rel}|${x.target}`);
    assert(href === 'https://example.com/path|noopener noreferrer nofollow|_blank', `link wrong: ${href}`);
  });

  await check('typing indicator and emoji picker work', async () => {
    await b.focus('#messageInput');
    await b.keyboard.type('typing…', { delay: 20 });
    await a.waitForSelector('#typing:not(.hidden)', { timeout: 5000 });
    await b.fill('#messageInput', '');
    await a.waitForSelector('#typing.hidden', { state: 'attached', timeout: 5000 });
    await a.click('#emojiBtn');
    await a.waitForSelector('#emojiPop:not(.hidden)');
    await a.click('#emojiPop button[aria-label="fire"]');
    assert((await a.inputValue('#messageInput')).includes('🔥'));
    await a.fill('#messageInput', '');
  });

  await check('very long and empty messages are handled', async () => {
    await send(a, '   ');
    await send(a, 'x'.repeat(480));
    await b.waitForFunction(() => document.querySelectorAll('#messages .msg.them').length === 3);
    assert((await texts(a)).filter((t) => t.startsWith('xxx')).length === 1);
  });


  await check('upgrading to video: decline, then accept, then both see video', async () => {
    await a.click('#askVideoBtn');
    await b.waitForSelector('#callDialog[open]');
    await b.click('#declineCall');
    await a.waitForFunction(() => !window.__securechat.state.asking, null, { timeout: 8000 });
    assert(await a.evaluate(() => document.getElementById('sessionScreen').dataset.call) === 'off', 'call must stay off after decline');
    await a.click('#askVideoBtn');
    await b.waitForSelector('#callDialog[open]');
    await b.click('#acceptCall');
    await Promise.all([a, b].map(remotePlaying));
    await Promise.all([a, b].map((p) => p.waitForFunction(() => window.__securechat.state.pc && window.__securechat.state.pc.connectionState === 'connected', null, { timeout: 30000 })));
  });

  await check('call controls: mic, camera, timer, stop video', async () => {
    await a.click('#micBtn');
    assert(await a.getAttribute('#micBtn', 'aria-pressed') === 'true');
    assert(await a.evaluate(() => !window.__securechat.state.localStream.getAudioTracks()[0].enabled), 'audio track should be disabled');
    await a.click('#micBtn');
    await a.click('#camBtn');
    assert(await a.evaluate(() => !window.__securechat.state.localStream.getVideoTracks()[0].enabled));
    await a.click('#camBtn');
    await sleep(1200);
    assert(/^0\d:\d\d$/.test(await a.textContent('#callTimer')) && (await a.textContent('#callTimer')) !== '00:00', 'timer should be running');
    await a.click('#stopVideoBtn');
    await b.waitForFunction(() => document.getElementById('sessionScreen').dataset.call === 'off', null, { timeout: 10000 });
    assert(await a.evaluate(() => document.getElementById('sessionScreen').dataset.call) === 'off');
    assert(await a.evaluate(() => window.__securechat.state.localStream === null), 'camera must be released');
    await send(a, 'still encrypted after the call');
    await b.waitForFunction(() => [...document.querySelectorAll('#messages .msg.them p')].some((p) => /still encrypted/.test(p.textContent)));
  });

  await check('report moves the reporter on and tells the partner the chat ended', async () => {
    await b.click('[data-action="report"]');
    await b.waitForSelector('#reportDialog[open]');
    await b.check('#reportForm input[value="spam"]');
    await b.click('#reportSubmit');
    await b.waitForSelector('#waitingScreen:not(.hidden)', { timeout: 10000 });
    await b.click('#cancelBtn');
    await b.waitForSelector('#welcomeScreen:not(.hidden)');
    await a.waitForSelector('#endedBar:not(.hidden)', { timeout: 15000 });
    assert(/left/i.test(await a.textContent('#partnerStatus')));
    assert(await a.isHidden('#composer'), 'composer should be hidden after partner left');
  });

  await check('after the partner leaves, the person left behind can find someone new', async () => {
    const c = await newPage(browser, url, { consent: true });
    await c.click('#startTextBtn');
    await c.waitForSelector('#waitingScreen:not(.hidden)');
    await a.click('#endedBar [data-action="next"]');
    await Promise.all([a, c].map((p) => p.waitForSelector('#sessionScreen:not(.hidden)', { timeout: 40000 })));
    await Promise.all([a, c].map(encrypted));
    await send(c, 'fresh chat');
    await a.waitForFunction(() => [...document.querySelectorAll('#messages .msg.them p')].some((p) => p.textContent === 'fresh chat'));
    assert((await texts(a)).length === 1, 'old chat must be wiped');
    // skip from c; a is told
    await c.click('.panel-actions [data-action="skip"]');
    await a.waitForSelector('#endedBar:not(.hidden)', { timeout: 15000 });
    await c.waitForSelector('#waitingScreen:not(.hidden)');
    await c.click('#cancelBtn');
    await c.waitForSelector('#welcomeScreen:not(.hidden)');
    await c.context().close();
  });

  await check('leaving returns home and clears the conversation', async () => {
    await a.click('.panel-actions [data-action="home"]');
    await a.waitForSelector('#welcomeScreen:not(.hidden)');
    assert(await a.$$eval('#messages > *', (n) => n.length) === 0);
  });

  await check('video chat: match, auto-connect, fullscreen-able stage, controls', async () => {
    await startBoth(a, b, 'video');
    await Promise.all([a, b].map(remotePlaying));
    assert(await a.evaluate(() => document.getElementById('sessionScreen').dataset.call) === 'on');
    assert(await pcState(a) === 'connected' && await pcState(b) === 'connected', 'peer connections should be connected');
    await Promise.all([a, b].map(encrypted));
    await send(b, 'chat works during video too');
    try {
      await a.waitForFunction(() => [...document.querySelectorAll('#messages .msg.them p')].some((p) => /during video/.test(p.textContent)), null, { timeout: 15000 });
    } catch (err) { throw new Error(`message not received in video mode\nA ${await dump(a)}\nB ${await dump(b)}`); }
    await a.waitForFunction(() => document.getElementById('callTimer').textContent !== '00:00', null, { timeout: 10000 });
  });

  let c;
  await check('video chat: Next re-matches with someone else and keeps the camera on', async () => {
    c = await newPage(browser, url, { consent: true });
    await c.click('#startVideoBtn');
    await c.waitForSelector('#waitingScreen:not(.hidden)');
    await a.click('.controls [data-action="skip"]');
    // b is notified; a gets paired with c
    await b.waitForSelector('#endedBar:not(.hidden)', { timeout: 15000 });
    await Promise.all([a, c].map((p) => p.waitForSelector('#sessionScreen:not(.hidden)', { timeout: 40000 })));
    await Promise.all([a, c].map(remotePlaying));
    assert(await pcState(a) === 'connected', 'a should connect to c');
  });

  await check('closing a browser tab notifies the partner', async () => {
    await c.close({ runBeforeUnload: false });
    await a.waitForSelector('#endedBar:not(.hidden)', { timeout: 30000 });
    assert(/left/i.test(await a.textContent('#partnerStatus')));
    await b.click('#endedBar [data-action="home"]');
    await b.waitForSelector('#welcomeScreen:not(.hidden)');
    await c.context().close();
    await a.context().close();
  });

  await check('no uncaught errors in the page console', async () => {
    const errs = [...(b.errors || [])];
    assert(errs.length === 0, errs.join(' | '));
  });
  await b.context().close();
}


/** Clean, scripted conversations for the README screenshots. */
async function showcase(browser, url) {
  const talk = async (p, q, lines) => { for (const [who, text] of lines) { await send(who === 'a' ? p : q, text); await sleep(350); } };
  const a = await newPage(browser, `${url}&x=1`, { consent: true });
  const b = await newPage(browser, `${url}&x=1`, { consent: true });
  await a.click('#startVideoBtn');
  await a.waitForSelector('#waitingScreen:not(.hidden)');
  await a.waitForTimeout(1200);
  await a.screenshot({ path: path.join(SHOTS, 'waiting.png') });
  await a.click('#cancelBtn');
  await a.waitForSelector('#welcomeScreen:not(.hidden)');
  await startBoth(a, b, 'text');
  await Promise.all([a, b].map(encrypted));
  await talk(a, b, [['b', 'Hey! Where are you chatting from?'], ['a', 'Lisbon. It’s almost midnight here 🌙'], ['b', 'Nice, I’m in Osaka, just had breakfast ☕'], ['a', 'Ha, other side of the world. What are you up to today?'], ['b', 'Learning to make ramen from scratch 🍜']]);
  await a.waitForFunction(() => document.querySelectorAll('#messages .msg').length >= 5);
  await a.screenshot({ path: path.join(SHOTS, 'text-chat.png') });
  await a.click('#themeBtn'); await a.waitForTimeout(250);
  await a.screenshot({ path: path.join(SHOTS, 'text-chat-dark.png') });
  await a.click('#themeBtn');
  await a.click('#safetyChip');
  await a.waitForSelector('#safetyDialog[open]');
  await a.screenshot({ path: path.join(SHOTS, 'safety-code.png') });
  await a.click('#safetyDialog [data-close]');
  await a.click('#askVideoBtn');
  await b.waitForSelector('#callDialog[open]');
  await b.screenshot({ path: path.join(SHOTS, 'video-request.png') });
  await b.click('#acceptCall');
  await Promise.all([a, b].map(remotePlaying));
  await a.waitForTimeout(4600);
  await a.screenshot({ path: path.join(SHOTS, 'video-call.png') });
  await a.context().close(); await b.context().close();
}

async function mobileAndShots(browser, url) {
  const m = await newPage(browser, url, { width: 390, height: 844 });
  await m.waitForSelector('#consentDialog[open]');
  await m.screenshot({ path: path.join(SHOTS, 'mobile-consent.png') });
  await agree(m);
  await m.screenshot({ path: path.join(SHOTS, 'mobile-welcome.png') });
  const peer = await newPage(browser, url, { consent: true });
  await m.click('#startTextBtn'); await peer.click('#startTextBtn');
  await Promise.all([m, peer].map((p) => p.waitForSelector('#sessionScreen:not(.hidden)', { timeout: 40000 })));
  await Promise.all([m, peer].map(encrypted));
  await send(peer, 'Hey! Where are you from?');
  await send(m, 'Lisbon. You?');
  await peer.waitForFunction(() => document.querySelectorAll('#messages .msg.them').length === 1);
  await m.waitForFunction(() => document.querySelectorAll('#messages .msg.them').length === 1);
  await m.screenshot({ path: path.join(SHOTS, 'mobile-chat.png') });
  await m.click('#askVideoBtn');
  await peer.waitForSelector('#callDialog[open]');
  await peer.click('#acceptCall');
  await Promise.all([m, peer].map(remotePlaying));
  await m.waitForTimeout(4600);
  await m.screenshot({ path: path.join(SHOTS, 'mobile-video.png') });
  const hs = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(hs <= 0, `horizontal overflow of ${hs}px on mobile`);
  await m.context().close(); await peer.context().close();
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: findChromium(), headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required', '--no-sandbox']
  });
  const ns = `t${crypto.randomBytes(4).toString('hex')}`;
  const shots = Boolean(args.screenshots);
  let nodeApp; let stat;
  try {
    if (args.url) {
      await suite(browser, 'deployed site (serverless)', args.url, `?ns=${ns}&cooldown=0`, { shots });
      if (shots) { currentSuite = 'mobile'; await check('mobile layout + screenshots', async () => { await mobileAndShots(browser, `${args.url}?ns=${ns}m&cooldown=0`); await showcase(browser, `${args.url}?ns=${ns}s&cooldown=0`); }); }
    } else {
      if (args.only !== 'static') {
        nodeApp = createApp({ log: () => {}, rematchCooldownMs: 0 });
        await new Promise((r) => nodeApp.server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${nodeApp.server.address().port}/`;
        await suite(browser, 'Node server transport', base, '', { shots: false });
      }
      if (args.only !== 'server') {
        stat = await serveStatic();
        await suite(browser, 'static / GitHub Pages transport', stat.url, `?ns=${ns}&cooldown=0`, { shots });
        if (shots) { currentSuite = 'mobile'; await check('mobile layout + screenshots', async () => { await mobileAndShots(browser, `${stat.url}?ns=${ns}m&cooldown=0`); await showcase(browser, `${stat.url}?ns=${ns}s&cooldown=0`); }); }
      }
    }
  } finally {
    await browser.close();
    if (nodeApp) { nodeApp.close(); nodeApp.io.close(); }
    if (stat) stat.server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
