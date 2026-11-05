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
const allPages = [];
let currentSuite = '';

function findChromium() {
  const c = [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
    .filter(Boolean).find((p) => fs.existsSync(p));
  if (!c) throw new Error('No Chromium found. Set CHROMIUM_PATH.');
  return c;
}

async function check(name, fn) {
  if (args.grep && !new RegExp(args.grep, 'i').test(name)) return;
  const label = `${currentSuite} › ${name}`;
  try { await fn(); results.push({ label, ok: true }); console.log(`  ✔ ${name}`); }
  catch (err) {
    results.push({ label, ok: false, err });
    const where = String(err.stack || '').split('\n').filter((l) => /e2e\.js:\d+/.test(l)).slice(0, 1).join('').trim();
    console.log(`  ✘ ${name}\n      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}${where ? `\n      at ${where}` : ''}`);
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
    viewport: { width, height }, permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'], colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: width < 600 ? 2 : 1
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.label = `page${allPages.length}`;
  allPages.push(page);
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

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');

async function freshPair(browser, url, mode = 'text') {
  const x = await newPage(browser, url, { consent: true });
  const y = await newPage(browser, url, { consent: true });
  await startBoth(x, y, mode);
  await Promise.all([x, y].map(encrypted));
  return [x, y];
}
const closeAll = (...ps) => Promise.all(ps.map((p) => p.context().close().catch(() => {})));
const nthText = async (p, i) => {
  try { await p.waitForFunction((n) => document.querySelectorAll('#messages .msg.them').length >= n, i + 1, { timeout: 15000 }); }
  catch { throw new Error(`message #${i} never arrived; have ${JSON.stringify(await theirs(p))}`); }
};

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
    await a.click('#emojiPop [data-set="Things"]');
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



  /* ---------------------------------------------------------------- v3 features */
  await check('quick replies, icebreaker and Shift+Enter multi-line messages', async () => {
    const [x, y] = await freshPair(browser, url);
    assert(await x.isVisible('#quick'), 'quick replies should show in an empty chat');
    await x.click('#quick .chip-accent');
    assert((await x.inputValue('#messageInput')).endsWith('?') || (await x.inputValue('#messageInput')).length > 8, 'icebreaker should fill the box');
    await x.fill('#messageInput', '');
    await x.focus('#messageInput');
    const h0 = await x.$eval('#messageInput', (n) => n.offsetHeight);
    await x.keyboard.type('line one');
    await x.keyboard.press('Shift+Enter');
    await x.keyboard.type('line two');
    await x.keyboard.press('Shift+Enter');
    await x.keyboard.type('line three');
    assert(await x.$eval('#messageInput', (n) => n.offsetHeight) > h0, 'the box should grow with its content');
    await x.press('#messageInput', 'Backspace');
    await x.fill('#messageInput', 'a'.repeat(450));
    assert(await x.isVisible('#counter') && /450\/500/.test(await x.textContent('#counter')), 'character counter near the limit');
    await x.fill('#messageInput', 'line one\nline two');
    await x.keyboard.press('Enter');
    await nthText(y, 0);
    assert((await theirs(y))[0] === 'line one\nline two', `got ${JSON.stringify(await theirs(y))}`);
    assert(!(await x.isVisible('#quick')), 'quick replies hide after the first message');
    await closeAll(x, y);
  });

  await check('formatting, shortcodes, slash commands and the profanity filter', async () => {
    const [x, y] = await freshPair(browser, url);
    await send(x, '**bold** *italic* `code` ~~gone~~ :fire:');
    await nthText(y, 0);
    assert(await y.$eval('#messages .msg.them p strong', (n) => n.textContent) === 'bold');
    assert(await y.$eval('#messages .msg.them p em', (n) => n.textContent) === 'italic');
    assert(await y.$eval('#messages .msg.them p code', (n) => n.textContent) === 'code');
    assert(await y.$eval('#messages .msg.them p del', (n) => n.textContent) === 'gone');
    assert((await theirs(y))[0].includes('🔥'), 'shortcode should become an emoji');
    await send(x, '/shrug whatever');
    await nthText(y, 1);
    assert((await theirs(y))[1].includes('¯\\_(ツ)_/¯') || (await theirs(y))[1].includes('(ツ)'), 'shrug');
    await send(x, '/roll');
    await nthText(y, 2);
    assert(/^🎲 I rolled a [1-6]$/.test((await theirs(y))[2]));
    await send(x, '/help');
    assert(await x.$$eval('#messages .sys', (n) => n.some((e) => /Commands:/.test(e.textContent))), '/help prints locally');
    await y.click('#settingsBtn');
    await y.check('#profanityChk');
    await y.click('#settingsDialog [data-close]');
    await send(x, 'well shit happens');
    await nthText(y, 3);
    assert((await theirs(y))[3] === 'well **** happens', `filter: ${(await theirs(y))[3]}`);
    await closeAll(x, y);
  });

  await check('reactions, replies and read receipts', async () => {
    const [x, y] = await freshPair(browser, url);
    await send(x, 'react to me');
    await nthText(y, 0);
    await y.hover('#messages .msg.them');
    await y.click('#messages .msg.them [aria-label="Add a reaction"]');
    await y.click('#messages .msg.them .react-pick [aria-label="React ❤️"]');
    await x.waitForSelector('#messages .msg.own .react', { timeout: 10000 });
    assert((await x.textContent('#messages .msg.own .react')).includes('❤️'));
    await x.waitForFunction(() => /Seen/.test(document.querySelector('#messages .msg.own .delivery').textContent), null, { timeout: 10000 });
    await y.hover('#messages .msg.them');
    await y.click('#messages .msg.them [aria-label="Copy message"]');
    await y.waitForSelector('.toast-success');
    assert(await y.evaluate(() => navigator.clipboard.readText()) === 'react to me', 'copy puts the text on the clipboard');
    await y.hover('#messages .msg.them');
    await y.click('#messages .msg.them [aria-label="Reply"]');
    assert(await y.isVisible('#replyBar'));
    await send(y, 'this is my reply');
    await x.waitForSelector('#messages .msg.them .quote', { timeout: 10000 });
    assert((await x.textContent('#messages .msg.them .quote')).includes('react to me'));
    assert(!(await y.isVisible('#replyBar')), 'reply bar clears after sending');
    await closeAll(x, y);
  });

  await check('photos: hidden until shown, viewable, and sent encrypted', async () => {
    const [x, y] = await freshPair(browser, url);
    await x.setInputFiles('#fileInput', { name: 'dot.png', mimeType: 'image/png', buffer: TINY_PNG });
    await y.waitForSelector('#messages .msg.them figure.hidden-img', { timeout: 15000 });
    assert(await y.isVisible('#messages .msg.them .reveal'));
    await y.click('#messages .msg.them .reveal');
    assert(await y.$$eval('#messages figure.hidden-img', (n) => n.length) === 0);
    await y.click('#messages .msg.them figure img');
    await y.waitForSelector('#imageDialog[open]');
    await y.click('#imageDialog [data-close]');
    await x.waitForFunction(() => /Delivered/.test(document.querySelector('#messages .msg.own .delivery').textContent), null, { timeout: 15000 });
    await y.click('#settingsBtn'); await y.uncheck('#blurImgChk'); await y.click('#settingsDialog [data-close]');
    await x.setInputFiles('#fileInput', { name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await x.waitForSelector('.toast-error');
    await closeAll(x, y);
  });

  await check('nickname and avatar reach the partner, and settings persist', async () => {
    const [x, y] = await freshPair(browser, url);
    await x.click('#settingsBtn');
    await x.fill('#nickInput', 'Skylark');
    await x.click('#avatarPick button:nth-child(3)');
    await x.press('#nickInput', 'Tab');
    await y.waitForFunction(() => document.querySelector('.who-text strong').textContent === 'Skylark', null, { timeout: 10000 });
    assert(await y.getAttribute('.panel-head .avatar', 'data-emoji') === '🦊');
    await x.click('#accentPick [data-accent="rose"]');
    assert(await x.evaluate(() => document.documentElement.dataset.accent) === 'rose');
    await x.click('#fontSel'); await x.selectOption('#fontSel', 'lg');
    await x.click('#settingsDialog [data-close]');
    await x.reload();
    assert(await x.evaluate(() => document.documentElement.dataset.accent) === 'rose', 'accent persists');
    assert(await x.evaluate(() => document.documentElement.dataset.font) === 'lg', 'font size persists');
    await closeAll(x, y);
  });

  await check('typing indicator can be switched off for privacy', async () => {
    const [x, y] = await freshPair(browser, url);
    await x.click('#settingsBtn'); await x.uncheck('#typingChk'); await x.click('#settingsDialog [data-close]');
    await x.focus('#messageInput');
    await x.keyboard.type('typing quietly', { delay: 30 });
    await sleep(1200);
    assert(await y.isHidden('#typing'), 'partner must not see typing when it is off');
    await closeAll(x, y);
  });

  await check('settings: theme, neutral title, reduced motion, session stats, corrupted settings', async () => {
    const [x, y] = await freshPair(browser, url);
    await send(x, 'one'); await nthText(y, 0);
    await x.click('#settingsBtn');
    await x.selectOption('#themeSel', 'dark');
    assert(await x.evaluate(() => document.documentElement.dataset.theme) === 'dark');
    await x.selectOption('#themeSel', 'light');
    assert(await x.evaluate(() => document.documentElement.dataset.theme) === 'light');
    await x.check('#disguiseChk');
    assert(await x.title() === 'Notes', 'neutral title option');
    await x.uncheck('#disguiseChk');
    await x.check('#motionChk');
    assert(await x.evaluate(() => document.documentElement.dataset.motion) === 'reduce');
    assert(/1 chat.*1 sent/.test(await x.textContent('#statsText')), `stats: ${await x.textContent('#statsText')}`);
    await closeAll(x, y);
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => localStorage.setItem('securechat.settings.v1', '{"accent":"neon","font":42,"interests":"x","nick":"<b>hi</b>","avatar":"💣"}'));
    const bad = await ctx.newPage();
    bad.errors = []; bad.label = 'corrupt'; allPages.push(bad);
    bad.on('pageerror', (er) => bad.errors.push(er.message));
    await bad.goto(url);
    assert(await bad.evaluate(() => document.documentElement.dataset.accent) === 'violet', 'bad accent falls back');
    assert(await bad.evaluate(() => document.documentElement.dataset.font) === 'md', 'bad font falls back');
    assert(await bad.evaluate(() => window.SCFeatures.settings().nick) === 'bhi/b', 'nickname is sanitised');
    await ctx.close();
  });

  await check('links ask before opening; shortcuts, panic and offline banner', async () => {
    const [x, y] = await freshPair(browser, url);
    await send(x, 'see https://example.org/page');
    await nthText(y, 0);
    await y.click('#messages .msg.them a');
    await y.waitForSelector('#linkDialog[open]');
    assert((await y.textContent('#linkUrl')).includes('example.org'));
    await y.click('#linkDialog [data-close]');
    await y.keyboard.press('?');
    await y.waitForSelector('#shortcutsDialog[open]');
    await y.keyboard.press('Escape');
    await x.context().setOffline(true);
    await x.waitForSelector('#netBanner:not(.hidden)', { timeout: 5000 });
    await x.context().setOffline(false);
    await x.waitForSelector('#netBanner.hidden', { state: 'attached', timeout: 5000 });
    await x.click('#panicBtn');
    await x.waitForSelector('#welcomeScreen:not(.hidden)');
    assert(await x.title() === 'Notes', 'panic uses a neutral title');
    await y.waitForSelector('#endedBar:not(.hidden)', { timeout: 20000 });
    await closeAll(x, y);
  });

  await check('auto-find-next when the partner leaves (opt-in)', async () => {
    const [x, y] = await freshPair(browser, url);
    await y.click('#settingsBtn'); await y.check('#autoNextChk'); await y.click('#settingsDialog [data-close]');
    await x.click('[data-action="home"]');
    await y.waitForSelector('#waitingScreen:not(.hidden)', { timeout: 15000 });
    await closeAll(x, y);
  });

  await check('interests are a soft preference: mismatched people still meet', async () => {
    const x = await newPage(browser, url, { consent: true });
    const y = await newPage(browser, url, { consent: true });
    for (const [p, interest] of [[x, 'pottery'], [y, 'rockets']]) {
      await p.click('#prefs summary');
      await p.fill('#interestsInput', interest);
      await p.press('#interestsInput', 'Enter');
      assert(await p.$$eval('#interestChips .chip-tag', (n) => n.length) === 1);
      await p.click('#startTextBtn');
    }
    await Promise.all([x, y].map((p) => p.waitForSelector('#sessionScreen:not(.hidden)', { timeout: 40000 })));
    await closeAll(x, y);
  });

  await check('private rooms only match each other', async () => {
    const roomUrl = `${url}${url.includes('?') ? '&' : '?'}room=friends42`;
    const p1 = await newPage(browser, roomUrl, { consent: true });
    const outsider = await newPage(browser, url, { consent: true });
    assert(await p1.isVisible('#roomBanner'), 'room banner should show');
    await p1.click('#startTextBtn');
    await p1.waitForSelector('#waitingScreen:not(.hidden)');
    await outsider.click('#startTextBtn');
    await outsider.waitForSelector('#waitingScreen:not(.hidden)');
    await sleep(11000); // longer than the soft-preference wait
    assert(/^0:(0[7-9]|1\d)$/.test(await p1.textContent('#waitTimer')), `wait timer: ${await p1.textContent('#waitTimer')}`);
    assert((await p1.textContent('#waitTip')).startsWith('Tip:'), 'a tip is shown while waiting');
    assert(await outsider.isHidden('#sessionScreen'), 'outsider must not be matched into a private room');
    assert(await p1.isHidden('#sessionScreen'), 'room owner must still be waiting');
    const p2 = await newPage(browser, roomUrl, { consent: true });
    await p2.click('#startTextBtn');
    await Promise.all([p1, p2].map((p) => p.waitForSelector('#sessionScreen:not(.hidden)', { timeout: 40000 })));
    await closeAll(p1, p2, outsider);
  });

  await check('invite dialog builds a working link; camera test dialog works', async () => {
    const x = await newPage(browser, url, { consent: true });
    await x.click('#prefs summary');
    await x.click('#inviteBtn');
    await x.waitForSelector('#inviteDialog[open]');
    assert(/[?&]room=[a-z0-9]{8}/.test(await x.inputValue('#inviteLink')));
    await x.click('#useInvite');
    assert(await x.isVisible('#roomBanner'));
    await x.click('#leaveRoomBtn');
    assert(await x.isHidden('#roomBanner'));
    await x.fill('#roomCodeInput', 'abcd2345');
    await x.click('#joinRoomBtn');
    assert((await x.textContent('#roomName')) === 'abcd2345', 'joining by code');
    await x.click('#leaveRoomBtn');
    await x.click('#testCamBtn');
    await x.waitForSelector('#testDialog[open]');
    await x.waitForFunction(() => /working/.test(document.getElementById('testStatus').textContent), null, { timeout: 15000 });
    await x.click('#testDone');
    await x.waitForFunction(() => !document.getElementById('testVideo').srcObject, null, { timeout: 5000 });
    await closeAll(x);
  });

  await check('a connection that dies without saying goodbye is detected within seconds', async () => {
    const [x, y] = await freshPair(browser, url);
    await y.evaluate(() => {
      const t = window.SC.S.transport;
      if (t.kind === 'mqtt') t.links.forEach((l) => { l.client.removeAllListeners('close'); l.client.stream.destroy(); });
      else t.socket.io.engine.close();
    });
    await x.waitForSelector('#endedBar:not(.hidden)', { timeout: 25000 });
    await closeAll(x, y);
  });

  await check('PWA: manifest, icons and service worker', async () => {
    const x = await newPage(browser, url, { consent: true });
    const m = await x.evaluate(async () => (await (await fetch('manifest.webmanifest')).json()));
    assert(m.short_name === 'SecureChat' && m.icons.length >= 3);
    assert((await x.evaluate(async () => (await fetch('icons/icon-192.png')).status)) === 200);
    assert(await x.evaluate(() => navigator.serviceWorker.ready.then((r) => Boolean(r.active))), 'service worker should activate');
    await closeAll(x);
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
    assert((await b.evaluate(() => sessionStorage.getItem('securechat.blocked') || '')).length > 2, 'reported person goes on the block list');
    await b.click('#settingsBtn');
    await b.click('#unblockBtn');
    assert(await b.isDisabled('#unblockBtn'), 'block list should be empty after clearing');
    await b.click('#settingsDialog [data-close]');
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


  await check('start with camera off (opt-in) and blur-by-default for partner video', async () => {
    const [x, y] = await freshPair(browser, url, 'video');
    await Promise.all([x, y].map(remotePlaying));
    await x.click('[data-action="home"]'); await y.click('[data-action="home"]');
    await x.click('#settingsBtn'); await x.check('#camOffChk'); await x.check('#blurRemoteChk'); await x.click('#settingsDialog [data-close]');
    await y.waitForSelector('#welcomeScreen:not(.hidden)');
    await startBoth(x, y, 'video');
    await Promise.all([x, y].map(encrypted));
    assert(await x.evaluate(() => !window.__securechat.state.localStream.getVideoTracks()[0].enabled), 'camera should start off');
    assert(await x.getAttribute('#camBtn', 'aria-pressed') === 'true');
    await x.waitForSelector('#blurVeil:not(.hidden)', { timeout: 30000 });
    assert(await x.$eval('#remoteVideo', (v) => v.classList.contains('blurred')), 'partner video starts blurred');
    await closeAll(x, y);
  });

  await check('video call extras: reactions, blur, quality, fit, network badge, mic meter', async () => {
    await a.click('#reactBtn');
    await a.click('#reactBar [aria-label="Send 🔥"]');
    await b.waitForSelector('#reactFloat .float', { timeout: 10000 });
    await a.click('#moreBtn');
    await a.selectOption('#qualitySel', 'low');
    await a.waitForFunction(() => { const s = window.__securechat.state.pc.getSenders().find((x) => x.track && x.track.kind === 'video'); return s && s.getParameters().encodings[0].maxBitrate === 250000; }, null, { timeout: 5000 });
    await a.$eval('#volRange', (n) => { n.value = '0.4'; n.dispatchEvent(new Event('input', { bubbles: true })); });
    assert(Math.abs(await a.$eval('#remoteVideo', (v) => v.volume) - 0.4) < 0.01, 'volume slider');
    assert(await a.$$eval('#camSel option', (o) => o.length) > 0 && await a.$$eval('#micSel option', (o) => o.length) > 0, 'device pickers list devices');
    await a.uncheck('#mirrorChk');
    assert(await a.$eval('#localBox', (n) => n.classList.contains('no-mirror')), 'mirror off');
    await a.check('#mirrorChk');
    await a.check('#blurChk');
    assert(await a.$eval('#remoteVideo', (v) => v.classList.contains('blurred')), 'remote video should blur');
    await a.keyboard.press('Escape');
    assert(await a.isHidden('#stageMenu'), 'Escape closes the video options');
    await a.click('#blurVeil');
    assert(!(await a.$eval('#remoteVideo', (v) => v.classList.contains('blurred'))), 'veil click reveals the video');
    await a.click('#moreBtn');
    await a.click('#fitBtn');
    assert(await a.$eval('#remoteVideo', (v) => v.style.objectFit) === 'contain');
    await a.uncheck('#selfChk');
    assert(await a.isHidden('#localBox'));
    await a.check('#selfChk');
    await a.click('#localBox');
    assert(await a.getAttribute('#localBox', 'data-corner') === 'br', 'self view moves to the next corner');
    await a.waitForFunction(() => !/Checking/.test(document.getElementById('netText').textContent), null, { timeout: 15000 });
    assert(/connection/.test(await a.textContent('#netText')));
    assert(await a.evaluate(() => getComputedStyle(document.getElementById('micBtn')).getPropertyValue('--lvl') !== ''));
    await a.keyboard.press('Escape');
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
    await c.evaluate(() => window.dispatchEvent(new Event('pagehide'))); // what a real tab close fires
    await sleep(800); // a real browser gives the page a moment to flush
    await c.close({ runBeforeUnload: false });
    await a.waitForSelector('#endedBar:not(.hidden)', { timeout: 30000 });
    assert(/left/i.test(await a.textContent('#partnerStatus')));
    await b.click('#endedBar [data-action="home"]');
    await b.waitForSelector('#welcomeScreen:not(.hidden)');
    await c.context().close();
    await a.context().close();
  });

  await check('no uncaught errors in the page console', async () => {
    const errs = allPages.flatMap((p) => p.errors.map((m) => `${p.label}: ${m}`));
    assert(errs.length === 0, errs.slice(0, 5).join(' | '));
  });
  await b.context().close();
}


/** Clean, scripted conversations for the README screenshots. */
async function showcase(browser, url) {
  const talk = async (p, q, lines) => { for (const [who, text] of lines) { await send(who === 'a' ? p : q, text); await sleep(350); } };
  const a = await newPage(browser, `${url}&x=1`, { consent: true });
  const b = await newPage(browser, `${url}&x=1`, { consent: true });
  await a.click('#prefs summary');
  for (const tag of ['ramen', 'travel']) { await a.fill('#interestsInput', tag); await a.press('#interestsInput', 'Enter'); }
  await a.selectOption('#langSelect', 'en');
  await a.waitForTimeout(300);
  await a.screenshot({ path: path.join(SHOTS, 'preferences.png') });
  await a.click('#settingsBtn');
  await a.waitForSelector('#settingsDialog[open]');
  await a.waitForTimeout(500);
  await a.screenshot({ path: path.join(SHOTS, 'settings.png') });
  await a.click('#settingsDialog [data-close]');
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
  // a reaction, a reply and a photo (shown hidden until the other person chooses to reveal it)
  await a.hover('#messages .msg.them');
  await a.click('#messages .msg.them [aria-label="Add a reaction"]');
  await a.click('#messages .msg.them .react-pick [aria-label="React ❤️"]');
  await a.locator('#messages .msg.them').last().hover();
  await a.locator('#messages .msg.them').last().locator('[aria-label="Reply"]').click();
  await send(a, 'Ramen from scratch sounds amazing!');
  await b.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 520; c.height = 340;
    const g = c.getContext('2d'); const grad = g.createLinearGradient(0, 0, 520, 340);
    grad.addColorStop(0, '#ffc83d'); grad.addColorStop(1, '#e8431f'); g.fillStyle = grad; g.fillRect(0, 0, 520, 340);
    g.fillStyle = '#13162e'; g.beginPath(); g.arc(260, 200, 90, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = 'bold 54px sans-serif'; g.textAlign = 'center'; g.fillText('ramen!', 260, 215);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'ramen.png', { type: 'image/png' }));
    const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change'));
  });
  await a.waitForSelector('#messages figure.hidden-img', { timeout: 20000 });
  await a.evaluate(() => { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; });
  await a.waitForTimeout(600);
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
  await a.click('#moreBtn');
  await a.waitForTimeout(300);
  await a.screenshot({ path: path.join(SHOTS, 'video-menu.png') });
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
