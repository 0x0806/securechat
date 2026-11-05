/* SecureChat feature layer. Plugs into app.js through window.SC and its hooks. Everything stored stays on this device. */
(() => {
  'use strict';
  const SC = window.SC;
  if (!SC) return;
  const { S, el, store, toast, show, setIcon, openDialog, closeDialog, uid } = SC;
  const Rules = window.MatchRules;
  const $ = (id) => document.getElementById(id);
  const hooks = SC.hooks;
  const ORIGINAL_TITLE = document.title;

  /* ============================================================ settings */
  const SETTINGS_KEY = 'securechat.settings.v1';
  const AVATARS = ['😀', '😎', '🦊', '🐼', '🐙', '🦉', '🌵', '🚀', '🎧', '🌙', '🍀', '🔥'];
  const ACCENTS = [['violet', '#4f35f2'], ['blue', '#1f6feb'], ['teal', '#0a8a7a'], ['rose', '#d6336c'], ['graphite', '#3a3f5c']];
  const DEFAULTS = {
    nick: '', avatar: '😀', accent: 'violet', font: 'md', motion: false, disguise: false,
    sound: true, notify: false, vibrate: true, typing: true, receipts: true, autoNext: false,
    profanity: false, blurImg: true, linkWarn: true, camOff: false, blurRemote: false,
    mirror: true, quality: 'standard', fit: 'cover', interests: [], lang: 'any', camId: '', micId: ''
  };
  const ENUMS = { accent: ACCENTS.map((a) => a[0]), font: ['sm', 'md', 'lg'], quality: ['low', 'standard', 'hd'], fit: ['cover', 'contain'] };

  /** Keeps only known keys of the right type, so a corrupted or old settings blob can never break the app. */
  function validate(raw) {
    const out = { ...DEFAULTS };
    if (!raw || typeof raw !== 'object') return out;
    for (const key of Object.keys(DEFAULTS)) {
      const v = raw[key];
      if (typeof v !== typeof DEFAULTS[key] && !(key === 'interests' && Array.isArray(v))) continue;
      out[key] = v;
    }
    for (const key of Object.keys(ENUMS)) if (!ENUMS[key].includes(out[key])) out[key] = DEFAULTS[key];
    out.nick = cleanName(out.nick);
    if (!AVATARS.includes(out.avatar)) out.avatar = DEFAULTS.avatar;
    out.interests = Rules.normInterests(out.interests);
    out.lang = Rules.normLang(out.lang);
    out.camId = String(out.camId).slice(0, 200); out.micId = String(out.micId).slice(0, 200);
    return out;
  }
  function cleanName(v) { return String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20); }

  let cfg;
  try { cfg = validate(JSON.parse(store.get(SETTINGS_KEY))); } catch { cfg = { ...DEFAULTS }; }
  if (store.get(SETTINGS_KEY) === null && store.get(SC.SOUND_KEY) === 'off') cfg.sound = false; // migrate the old sound switch
  const save = () => store.set(SETTINGS_KEY, JSON.stringify(cfg));

  function applyAppearance() {
    const root = document.documentElement;
    root.dataset.accent = cfg.accent;
    root.dataset.font = cfg.font;
    root.dataset.motion = cfg.motion ? 'reduce' : 'auto';
    S.baseTitle = cfg.disguise ? 'Notes' : ORIGINAL_TITLE;
    document.title = S.baseTitle;
    S.sound = cfg.sound;
    el.soundBtn.setAttribute('aria-pressed', String(S.sound));
    setIcon(el.soundBtn, S.sound ? 'i-volume' : 'i-volume-off');
    const fit = cfg.fit;
    el.remoteVideo.style.objectFit = fit;
    $('fitBtn').textContent = fit === 'cover' ? 'Fit: fill screen' : 'Fit: show everything';
    $('localBox').classList.toggle('no-mirror', !cfg.mirror);
  }
  applyAppearance();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!store.get(SC.THEME_KEY)) SC.applyTheme(e.matches ? 'dark' : 'light'); // follow the device until the user picks
  });
  // Keep settings in step with the header sound button.
  el.soundBtn.addEventListener('click', () => { cfg.sound = S.sound; save(); $('soundChk').checked = cfg.sound; });

  /* ---- settings dialog ---- */
  const sd = $('settingsDialog');
  const checks = {
    soundChk: 'sound', vibrateChk: 'vibrate', typingChk: 'typing', receiptsChk: 'receipts', autoNextChk: 'autoNext',
    profanityChk: 'profanity', blurImgChk: 'blurImg', linkWarnChk: 'linkWarn', camOffChk: 'camOff', blurRemoteChk: 'blurRemote',
    motionChk: 'motion', disguiseChk: 'disguise'
  };
  AVATARS.forEach((a) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = a; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', `Avatar ${a}`);
    b.addEventListener('click', () => { cfg.avatar = a; save(); renderPickers(); sendProfile(); });
    $('avatarPick').appendChild(b);
  });
  ACCENTS.forEach(([name, color]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.style.background = color; b.dataset.accent = name;
    b.setAttribute('role', 'radio'); b.setAttribute('aria-label', `${name} accent`);
    b.addEventListener('click', () => { cfg.accent = name; save(); applyAppearance(); renderPickers(); });
    $('accentPick').appendChild(b);
  });
  function renderPickers() {
    $$('#avatarPick button').forEach((b) => b.setAttribute('aria-checked', String(b.textContent === cfg.avatar)));
    $$('#accentPick button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.accent === cfg.accent)));
  }
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

  function renderSettings() {
    for (const [id, key] of Object.entries(checks)) $(id).checked = Boolean(cfg[key]);
    $('notifyChk').checked = cfg.notify && 'Notification' in window && Notification.permission === 'granted';
    $('nickInput').value = cfg.nick;
    $('themeSel').value = store.get(SC.THEME_KEY) || 'system';
    $('fontSel').value = cfg.font;
    renderPickers();
    renderStats();
    renderBlocked();
  }
  for (const [id, key] of Object.entries(checks)) {
    $(id).addEventListener('change', () => { cfg[key] = $(id).checked; save(); applyAppearance(); });
  }
  $('nickInput').addEventListener('input', () => { cfg.nick = cleanName($('nickInput').value); save(); });
  $('nickInput').addEventListener('change', sendProfile);
  $('fontSel').addEventListener('change', () => { cfg.font = $('fontSel').value; save(); applyAppearance(); });
  $('themeSel').addEventListener('change', () => {
    const v = $('themeSel').value;
    if (v === 'system') { store.del(SC.THEME_KEY); SC.applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
    else { store.set(SC.THEME_KEY, v); SC.applyTheme(v); }
  });
  $('notifyChk').addEventListener('change', async () => {
    if (!$('notifyChk').checked) { cfg.notify = false; save(); return; }
    if (!('Notification' in window)) { toast('This browser does not support notifications.', 'error'); $('notifyChk').checked = false; return; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    cfg.notify = perm === 'granted';
    $('notifyChk').checked = cfg.notify;
    if (!cfg.notify) toast('Notifications are blocked. Allow them in your browser’s site settings.', 'error');
    save();
  });
  $('resetSettings').addEventListener('click', () => {
    cfg = { ...DEFAULTS }; save(); store.del(SC.THEME_KEY); store.del(SC.SOUND_KEY);
    SC.applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyAppearance(); renderSettings(); renderInterests(); $('langSelect').value = 'any';
    toast('Settings reset.', 'success');
  });
  $('settingsBtn').addEventListener('click', () => { renderSettings(); openDialog(sd); });

  /* ---- session stats (memory only) ---- */
  const stats = { chats: 0, sent: 0, received: 0, ms: 0, since: 0 };
  function renderStats() {
    const ms = stats.ms + (stats.since ? Date.now() - stats.since : 0);
    const mins = Math.round(ms / 60000);
    $('statsText').textContent = stats.chats
      ? `${stats.chats} chat${stats.chats === 1 ? '' : 's'}, ${stats.sent} sent, ${stats.received} received, about ${mins} minute${mins === 1 ? '' : 's'} chatting. This is kept in memory and cleared when you close the tab.`
      : 'No chats yet. This is kept in memory and cleared when you close the tab.';
  }
  const stopClock = () => { if (stats.since) { stats.ms += Date.now() - stats.since; stats.since = 0; } };

  /* ============================================================ profile */
  const partner = { name: '', avatar: '', ts: 0 };
  const lastReactTs = new Map(); // updates can arrive out of order, so newer wins
  function showPartner() {
    const name = partner.name || 'Stranger';
    document.querySelector('.who-text strong').textContent = name;
    const av = document.querySelector('.panel-head .avatar');
    if (partner.avatar) av.dataset.emoji = partner.avatar; else delete av.dataset.emoji;
    el.typing.lastChild.textContent = `${name} is typing`;
  }
  function sendProfile() {
    if (!S.aes || S.ended) return;
    SC.sendEnvelope({ t: 'profile', n: cfg.nick, a: cfg.avatar, ts: Date.now() }).catch(() => {});
  }

  /* ============================================================ formatting */
  const SHORTCODES = {
    smile: '😊', grin: '😀', joy: '😂', laugh: '😆', wink: '😉', heart_eyes: '😍', cool: '😎', thinking: '🤔', sob: '😭', cry: '😢',
    angry: '😠', sleepy: '😴', wave: '👋', thumbsup: '👍', thumbsdown: '👎', clap: '👏', pray: '🙏', ok: '👌', muscle: '💪', fire: '🔥',
    heart: '❤️', sparkles: '✨', tada: '🎉', hundred: '💯', eyes: '👀', rocket: '🚀', coffee: '☕', pizza: '🍕', music: '🎵', sun: '☀️',
    moon: '🌙', star: '⭐', skull: '💀', ghost: '👻', robot: '🤖', cat: '🐱', dog: '🐶', check: '✅', x: '❌', party: '🥳'
  };
  const BAD = /\b(fuck\w*|shit\w*|bitch\w*|asshole|bastard|cunt|dick\w*|slut|whore|nigg\w+|faggot)\b/gi;

  function applyShortcodes(text) {
    return text.replace(/:([a-z_]{2,15}):/g, (m, name) => SHORTCODES[name] || m);
  }

  /** Safe inline formatting built from DOM nodes (never innerHTML): `code`, **bold**, *italic*, ~~strike~~, links. */
  hooks.format = (text, body) => {
    const parts = applyShortcodes(text).split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|~~[^~\n]+~~|https?:\/\/[^\s<>"]+)/g);
    parts.forEach((part, i) => {
      if (!part) return;
      if (i % 2 === 0) { body.appendChild(document.createTextNode(part)); return; }
      const wrap = (tag, inner) => { const n = document.createElement(tag); n.textContent = inner; body.appendChild(n); };
      if (part.startsWith('`')) return wrap('code', part.slice(1, -1));
      if (part.startsWith('**')) return wrap('strong', part.slice(2, -2));
      if (part.startsWith('~~')) return wrap('del', part.slice(2, -2));
      if (part.startsWith('*')) return wrap('em', part.slice(1, -1));
      let ok = false;
      try { ok = ['http:', 'https:'].includes(new URL(part).protocol); } catch { /* not a URL */ }
      if (!ok) { body.appendChild(document.createTextNode(part)); return; }
      const a = document.createElement('a');
      a.href = part; a.textContent = part; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
      body.appendChild(a);
    });
    return true;
  };

  function maskText(node) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) n.nodeValue = n.nodeValue.replace(BAD, (w) => '*'.repeat(w.length));
  }

  /* ---- link warning ---- */
  el.messages.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || !cfg.linkWarn) return;
    e.preventDefault();
    $('linkUrl').textContent = a.href;
    $('linkOpen').dataset.url = a.href;
    openDialog($('linkDialog'));
  });
  $('linkOpen').addEventListener('click', () => {
    const url = $('linkOpen').dataset.url;
    closeDialog($('linkDialog'));
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  });

  /* ============================================================ composer */
  const input = el.messageInput;
  const MAX_LEN = 500;
  function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; }
  hooks.inputChanged = () => {
    autosize();
    const n = input.value.length;
    $('counter').textContent = `${n}/${MAX_LEN}`;
    show($('counter'), n >= MAX_LEN - 100);
    $('counter').classList.toggle('over', n >= MAX_LEN);
  };
  input.addEventListener('paste', () => setTimeout(() => {
    if (input.value.length >= MAX_LEN) toast(`Messages are limited to ${MAX_LEN} characters, so the rest was cut off.`, 'info');
  }, 0));
  hooks.typingOff = () => !cfg.typing;
  hooks.composerState = (enabled) => { $('attachBtn').disabled = !enabled; if (!enabled) show($('quick'), false); };

  /* ---- slash commands ---- */
  const TOPICS = [
    'What is the best thing that happened to you this week?', 'If you could live anywhere for a year, where would it be?',
    'What are you into at the moment?', 'What is a skill you would love to learn?', 'Which song have you had on repeat lately?',
    'What is the most interesting place you have been?', 'Mountains or the sea?', 'What did you want to be as a kid?',
    'What is your go-to comfort meal?', 'Which book or show would you recommend?'
  ];
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  hooks.beforeSend = (text) => {
    if (!text.startsWith('/')) return null;
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd.toLowerCase()) {
      case '/shrug': return { text: `${arg} ¯\\_(ツ)_/¯`.trim() };
      case '/me': return arg ? { text: `*${arg}*` } : { cancel: true };
      case '/flip': return { text: `🪙 ${Math.random() < 0.5 ? 'Heads' : 'Tails'}` };
      case '/roll': return { text: `🎲 I rolled a ${1 + Math.floor(Math.random() * 6)}` };
      case '/topic': return { text: pick(TOPICS) };
      case '/clear': el.messages.replaceChildren(); SC.addSystem('Cleared on your screen only.'); return { cancel: true };
      case '/help': SC.addSystem('Commands: /shrug, /me, /flip, /roll, /topic, /clear. Use **bold**, *italic*, `code` and ~~strike~~. Type :smile: for emoji.'); return { cancel: true };
      default: return null;
    }
  };

  /* ---- quick replies and icebreakers ---- */
  const QUICK = ['Hi 👋', 'Where are you from?', 'What do you like to do?'];
  QUICK.forEach((q) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip-btn'; b.textContent = q;
    b.addEventListener('click', () => { input.value = q; hooks.inputChanged(); el.composer.requestSubmit(); });
    $('quick').appendChild(b);
  });
  const ice = document.createElement('button');
  ice.type = 'button'; ice.className = 'chip-btn chip-accent'; ice.textContent = 'Suggest a topic';
  ice.addEventListener('click', () => { input.value = pick(TOPICS); hooks.inputChanged(); input.focus(); });
  $('quick').appendChild(ice);
  const hideQuick = () => show($('quick'), false);

  /* ---- reply ---- */
  let replyTo = null;
  function startReply(mid, text) {
    replyTo = { m: mid, x: text.slice(0, 80) };
    $('replyText').textContent = `Replying to: ${replyTo.x}`;
    show($('replyBar'), true);
    input.focus();
  }
  const clearReply = () => { replyTo = null; show($('replyBar'), false); };
  $('replyCancel').addEventListener('click', clearReply);
  hooks.takeReply = () => { const r = replyTo; clearReply(); return r; };

  /* ---- sent envelopes (for retry) ---- */
  const sentEnv = new Map();
  hooks.sent = (env) => { sentEnv.set(env.m, env); stats.sent += 1; hideQuick(); };

  /* ============================================================ message decoration */
  const REACTS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const reactions = new Map(); // mid -> Map(emoji -> Set('me'|'them'))

  function renderReactions(mid) {
    const wrap = el.messages.querySelector(`.msg[data-mid="${CSS.escape(mid)}"]`);
    if (!wrap) return;
    let box = wrap.querySelector('.reacts');
    const map = reactions.get(mid);
    if (!map || ![...map.values()].some((s) => s.size)) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.className = 'reacts'; wrap.insertBefore(box, wrap.querySelector('.meta')); }
    box.replaceChildren();
    for (const [emoji, who] of map) {
      if (!who.size) continue;
      const b = document.createElement('button');
      b.type = 'button'; b.className = `react${who.has('me') ? ' mine' : ''}`;
      b.textContent = `${emoji} ${who.size > 1 ? who.size : ''}`.trim();
      b.setAttribute('aria-label', `${emoji} reaction${who.size > 1 ? `s, ${who.size}` : ''}. ${who.has('me') ? 'Remove yours' : 'Add yours'}`);
      b.addEventListener('click', () => toggleReaction(mid, emoji));
      box.appendChild(b);
    }
  }
  function setReaction(mid, emoji, who, on) {
    if (!REACTS.includes(emoji)) return;
    if (!reactions.has(mid)) reactions.set(mid, new Map());
    const map = reactions.get(mid);
    if (!map.has(emoji)) map.set(emoji, new Set());
    const set = map.get(emoji);
    if (on) set.add(who); else set.delete(who);
    renderReactions(mid);
  }
  function toggleReaction(mid, emoji) {
    const on = !(reactions.get(mid) && reactions.get(mid).get(emoji) && reactions.get(mid).get(emoji).has('me'));
    setReaction(mid, emoji, 'me', on);
    SC.sendEnvelope({ t: 'react', mid, e: emoji, on, ts: Date.now() }).catch(() => {});
  }

  hooks.message = ({ wrap, body, data }) => {
    if (!data.own && cfg.profanity && body.tagName === 'P') maskText(body);
    if (data.reply && data.reply.x) {
      const q = document.createElement('div');
      q.className = 'quote';
      q.textContent = String(data.reply.x).slice(0, 80);
      wrap.insertBefore(q, body);
    }
    hideQuick();
    if (!data.id) return;
    const tools = document.createElement('div');
    tools.className = 'tools';
    tools.setAttribute('role', 'group');
    tools.setAttribute('aria-label', 'Message actions');
    const mk = (icon, label, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tool'; b.setAttribute('aria-label', label); b.title = label;
      b.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#${icon}"/></svg>`;
      b.addEventListener('click', fn);
      tools.appendChild(b);
      return b;
    };
    const picker = document.createElement('div');
    picker.className = 'react-pick hidden';
    REACTS.forEach((r) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = r; b.setAttribute('aria-label', `React ${r}`);
      b.addEventListener('click', () => { picker.classList.add('hidden'); toggleReaction(data.id, r); });
      picker.appendChild(b);
    });
    mk('i-smile', 'Add a reaction', () => picker.classList.toggle('hidden'));
    mk('i-reply', 'Reply', () => startReply(data.id, body.textContent || '[photo]'));
    if (body.tagName === 'P') mk('i-copy', 'Copy message', async () => {
      try { await navigator.clipboard.writeText(body.textContent); toast('Copied', 'success'); } catch { toast('Could not copy.', 'error'); }
    });
    tools.appendChild(picker);
    wrap.appendChild(tools);
  };

  /* ---- read receipts ---- */
  const seenQueue = [];
  let seenTimer = null;
  function flushSeen() {
    clearTimeout(seenTimer);
    if (!seenQueue.length || document.hidden || !cfg.receipts || !S.aes || S.ended || S.screen !== 'session') return;
    const ms = seenQueue.splice(0, 50);
    SC.sendEnvelope({ t: 'seen', ms }).catch(() => {});
  }
  hooks.visible = () => { flushSeen(); setTimeout(() => el.messages.querySelector('.divider')?.remove(), 4000); };

  /* ---- retry failed sends ---- */
  new MutationObserver(() => {
    el.messages.querySelectorAll('.delivery:not(.failed)').forEach((d) => {
      if (!/^Not (sent|delivered)/.test(d.textContent)) return;
      d.classList.add('failed');
      d.textContent = 'Not delivered. Retry';
      d.setAttribute('role', 'button'); d.tabIndex = 0;
      const retry = () => {
        const mid = d.closest('.msg')?.dataset.mid;
        const env = mid && sentEnv.get(mid);
        if (!env || !S.aes) return;
        d.classList.remove('failed'); d.removeAttribute('role'); d.removeAttribute('tabindex'); d.textContent = 'Sending';
        S.pending.set(mid, d);
        SC.sendEnvelope(env).catch(() => { d.textContent = 'Not sent'; });
      };
      d.addEventListener('click', retry);
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); retry(); } });
    });
  }).observe(el.messages, { subtree: true, childList: true, characterData: true });

  /* ---- images ---- */
  const IMG_MAX_BYTES = 60000;
  async function shrinkImage(file) {
    if (!/^image\/(png|jpe?g|gif|webp|bmp)$/.test(file.type)) throw new Error('That file is not a supported image.');
    if (file.size > 12 * 1024 * 1024) throw new Error('That image is too large.');
    const bmp = await createImageBitmap(file);
    for (const maxSide of [640, 480, 360, 260]) {
      const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale)); const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      for (const q of [0.72, 0.55, 0.4]) {
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
        if (blob && blob.size <= IMG_MAX_BYTES) {
          const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
          return { url, w, h };
        }
      }
    }
    throw new Error('Could not shrink that image enough to send.');
  }
  const validImageUrl = (u) => typeof u === 'string' && u.length < 120000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(u);

  function renderImage(container, url, { own }) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = url; img.alt = own ? 'Photo you sent' : 'Photo from your partner'; img.loading = 'lazy';
    fig.appendChild(img);
    const open = () => { $('imageBig').src = url; openDialog($('imageDialog')); };
    if (!own && cfg.blurImg) {
      fig.classList.add('hidden-img');
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'reveal'; b.textContent = 'Photo hidden. Show it';
      b.addEventListener('click', () => { fig.classList.remove('hidden-img'); b.remove(); });
      fig.appendChild(b);
    }
    img.tabIndex = 0;
    img.addEventListener('click', () => { if (!fig.classList.contains('hidden-img')) open(); });
    img.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !fig.classList.contains('hidden-img')) open(); });
    container.appendChild(fig);
  }

  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async () => {
    const file = $('fileInput').files[0];
    $('fileInput').value = '';
    if (!file || !S.aes || S.ended) return;
    try {
      const { url, w, h } = await shrinkImage(file);
      const id = uid();
      const env = { t: 'img', m: id, d: url, w, h };
      SC.addMessage({ own: true, ts: Date.now(), id, render: (c) => renderImage(c, url, { own: true }) });
      sentEnv.set(id, env);
      stats.sent += 1;
      await SC.sendEnvelope(env);
    } catch (err) {
      toast(err.message || 'Could not send that image.', 'error');
    }
  });

  /* ============================================================ incoming envelopes */
  const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
  hooks.envelope = (env) => {
    switch (env.t) {
      case 'profile': {
        if (!(Number(env.ts) >= partner.ts)) break; // stale update
        partner.ts = Number(env.ts) || 0;
        partner.name = cleanName(env.n);
        partner.avatar = AVATARS.includes(env.a) ? env.a : '';
        showPartner();
        break;
      }
      case 'react': {
        if (typeof env.mid !== 'string') break;
        const key = `${clip(env.mid, 64)}|${env.e}`;
        if (Number(env.ts) < (lastReactTs.get(key) || 0)) break; // an older toggle arrived late
        lastReactTs.set(key, Number(env.ts) || 0);
        setReaction(clip(env.mid, 64), env.e, 'them', env.on !== false);
        break;
      }
      case 'seen': {
        if (!Array.isArray(env.ms)) break;
        env.ms.slice(0, 50).forEach((mid) => {
          const d = el.messages.querySelector(`.msg.own[data-mid="${CSS.escape(clip(mid, 64))}"] .delivery`);
          if (d && !d.classList.contains('failed') && !/Seen/.test(d.textContent)) d.textContent = 'Delivered · Seen';
        });
        break;
      }
      case 'img': {
        if (!validImageUrl(env.d)) break;
        show($('typing'), false);
        const id = clip(env.m, 64);
        SC.addMessage({ own: false, ts: Date.now(), id, render: (c) => renderImage(c, env.d, { own: false }) });
        SC.beep('message');
        stats.received += 1;
        notifyIncoming(id);
        break;
      }
      case 'creact': showFloat(env.e); break;
      default: // unknown envelope types from newer clients are ignored
    }
  };

  function notifyIncoming(id) {
    if (id) seenQueue.push(id);
    if (document.hidden) {
      if (!el.messages.querySelector('.divider')) {
        const d = document.createElement('div');
        d.className = 'divider'; d.textContent = 'New messages';
        el.messages.insertBefore(d, el.messages.lastElementChild);
      }
      if (cfg.notify && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification('New message', { body: 'Your chat partner sent a message.', tag: 'securechat', silent: !S.sound }); } catch { /* not allowed here */ }
      }
      if (cfg.vibrate && navigator.vibrate) navigator.vibrate(60);
    }
    clearTimeout(seenTimer);
    seenTimer = setTimeout(flushSeen, 400);
  }
  hooks.incoming = (env) => { stats.received += 1; notifyIncoming(env.m); };

  /* ============================================================ emoji picker with categories */
  const EMOJI_SETS = {
    Smileys: [['😀', 'grinning'], ['😂', 'laughing'], ['😊', 'smiling'], ['😍', 'heart eyes'], ['😎', 'cool'], ['🤔', 'thinking'], ['😅', 'sweat smile'], ['🙃', 'upside down'], ['😭', 'crying'], ['😴', 'sleepy'], ['😉', 'wink'], ['🥳', 'partying'], ['😮', 'surprised'], ['😬', 'grimace'], ['🤯', 'mind blown'], ['😇', 'angel']],
    Hands: [['🤝', 'handshake'], ['👋', 'wave'], ['👍', 'thumbs up'], ['👎', 'thumbs down'], ['🙏', 'thanks'], ['👏', 'clap'], ['👌', 'ok'], ['✌️', 'peace'], ['💪', 'strong'], ['🙌', 'hooray'], ['🤞', 'fingers crossed'], ['👀', 'eyes']],
    Things: [['🔥', 'fire'], ['✨', 'sparkles'], ['🎉', 'party'], ['💯', 'hundred'], ['❤️', 'heart'], ['🎵', 'music'], ['☕', 'coffee'], ['🍕', 'pizza'], ['🚀', 'rocket'], ['🌙', 'moon'], ['⭐', 'star'], ['🎮', 'gaming'], ['📚', 'books'], ['⚽', 'football'], ['🌍', 'world'], ['🍜', 'ramen']],
    Animals: [['🐱', 'cat'], ['🐶', 'dog'], ['🦊', 'fox'], ['🐼', 'panda'], ['🐙', 'octopus'], ['🦉', 'owl'], ['🐢', 'turtle'], ['🦋', 'butterfly'], ['🌵', 'cactus'], ['🍀', 'clover'], ['🌸', 'blossom'], ['🐧', 'penguin']]
  };
  const pop = el.emojiPop;
  pop.replaceChildren();
  const tabs = document.createElement('div'); tabs.className = 'emoji-tabs'; tabs.setAttribute('role', 'tablist');
  const grid = document.createElement('div'); grid.className = 'emoji-grid'; grid.setAttribute('role', 'listbox');
  pop.append(tabs, grid);
  function showSet(name) {
    grid.replaceChildren();
    tabs.querySelectorAll('button').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.set === name)));
    EMOJI_SETS[name].forEach(([ch, label]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = ch; b.setAttribute('aria-label', label); b.setAttribute('role', 'option');
      b.addEventListener('click', () => {
        const start = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, start) + ch + input.value.slice(input.selectionEnd ?? start);
        input.focus(); input.setSelectionRange(start + ch.length, start + ch.length);
        show(pop, false); el.emojiBtn.setAttribute('aria-expanded', 'false');
        hooks.inputChanged(); SC.startTyping();
      });
      grid.appendChild(b);
    });
  }
  Object.keys(EMOJI_SETS).forEach((name) => {
    const t = document.createElement('button');
    t.type = 'button'; t.textContent = name; t.dataset.set = name; t.setAttribute('role', 'tab');
    t.addEventListener('click', () => showSet(name));
    tabs.appendChild(t);
  });
  showSet('Smileys');
  pop.addEventListener('keydown', (e) => { // arrow keys move through the emoji
    const items = Array.from(grid.querySelectorAll('button'));
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 }[e.key];
    if (!step) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, i + step))].focus();
  });

  /* ============================================================ matching: interests, language, rooms, blocks */
  const chipsBox = $('interestChips');
  function renderInterests() {
    chipsBox.replaceChildren();
    cfg.interests.forEach((it) => {
      const chip = document.createElement('span');
      chip.className = 'chip-tag';
      chip.textContent = it;
      const x = document.createElement('button');
      x.type = 'button'; x.setAttribute('aria-label', `Remove ${it}`); x.textContent = '×';
      x.addEventListener('click', () => { cfg.interests = cfg.interests.filter((i) => i !== it); save(); renderInterests(); });
      chip.appendChild(x);
      chipsBox.appendChild(chip);
    });
    $('interestsInput').disabled = cfg.interests.length >= Rules.MAX_INTERESTS;
  }
  function addInterest() {
    const [v] = Rules.normInterests([$('interestsInput').value]);
    $('interestsInput').value = '';
    if (!v || cfg.interests.includes(v)) return;
    cfg.interests = Rules.normInterests([...cfg.interests, v]); save(); renderInterests();
  }
  $('interestsInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addInterest(); }
    if (e.key === 'Backspace' && !$('interestsInput').value && cfg.interests.length) { cfg.interests.pop(); save(); renderInterests(); }
  });
  $('interestsInput').addEventListener('blur', addInterest);
  $('langSelect').value = cfg.lang;
  $('langSelect').addEventListener('change', () => { cfg.lang = Rules.normLang($('langSelect').value); save(); });
  renderInterests();
  if (cfg.interests.length || cfg.lang !== 'any') $('prefs').open = true;

  // private rooms
  let room = Rules.normRoom(new URLSearchParams(location.search).get('room'));
  function renderRoom() {
    show($('roomBanner'), Boolean(room));
    $('roomName').textContent = room;
  }
  function inviteUrl(code) {
    const u = new URL(location.href);
    const keep = ['ns', 'transport', 'cooldown'].map((k) => [k, u.searchParams.get(k)]).filter(([, v]) => v);
    u.search = '';
    keep.forEach(([k, v]) => u.searchParams.set(k, v));
    u.searchParams.set('room', code);
    return u.toString();
  }
  const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  function enterRoom(code) {
    room = Rules.normRoom(code);
    if (!room) { toast('Room codes use 4 to 24 letters and numbers.', 'error'); return false; }
    renderRoom();
    toast(`You are in private room ${room}.`, 'success');
    return true;
  }
  $('inviteBtn').addEventListener('click', () => {
    const code = newCode();
    $('inviteLink').value = inviteUrl(code);
    $('inviteLink').dataset.code = code;
    openDialog($('inviteDialog'));
  });
  $('copyInvite').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('inviteLink').value); toast('Invite link copied', 'success'); }
    catch { $('inviteLink').select(); toast('Press Ctrl+C to copy the link.', 'info'); }
  });
  $('useInvite').addEventListener('click', () => { closeDialog($('inviteDialog')); enterRoom($('inviteLink').dataset.code); });
  $('joinRoomBtn').addEventListener('click', () => {
    let code = $('roomCodeInput').value.trim();
    try { code = new URL(code).searchParams.get('room') || code; } catch { /* a bare code */ }
    if (enterRoom(code)) $('roomCodeInput').value = '';
  });
  $('roomCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('joinRoomBtn').click(); } });
  $('leaveRoomBtn').addEventListener('click', () => {
    room = '';
    renderRoom();
    const u = new URL(location.href); u.searchParams.delete('room'); history.replaceState(null, '', u);
  });
  renderRoom();
  if (room) $('prefs').open = true;

  // block list for this browser session only
  const BLOCK_KEY = 'securechat.blocked';
  const blocked = new Set((() => { try { return JSON.parse(sessionStorage.getItem(BLOCK_KEY)) || []; } catch { return []; } })());
  function renderBlocked() {
    $('unblockBtn').textContent = blocked.size ? `Clear blocked people (${blocked.size})` : 'Clear blocked people';
    $('unblockBtn').disabled = blocked.size === 0;
  }
  $('unblockBtn').addEventListener('click', () => {
    blocked.clear();
    try { sessionStorage.removeItem(BLOCK_KEY); } catch { /* storage unavailable */ }
    renderBlocked();
    toast('Blocked people cleared. You can be matched with them again.', 'success');
  });
  hooks.reported = (id) => {
    if (!id) return;
    blocked.add(id);
    renderBlocked();
    try { sessionStorage.setItem(BLOCK_KEY, JSON.stringify([...blocked].slice(-50))); } catch { /* storage unavailable */ }
  };
  hooks.prefs = () => ({ interests: cfg.interests, lang: cfg.lang, room, avoid: [...blocked] });

  /* ---- waiting screen extras ---- */
  const TIPS = [
    'Tip: use Alt+N to jump to the next person.', 'Tip: type :smile: to add an emoji.', 'Tip: check the safety code under the lock icon.',
    'Tip: never share your address or passwords with a stranger.', 'Tip: you can send photos. They stay hidden until the other person shows them.',
    'Tip: report anyone who makes you uncomfortable.'
  ];
  let waitTick = null; let waitStart = 0;
  function startWaiting() {
    stopWaiting();
    waitStart = Date.now();
    $('waitTimer').textContent = '0:00';
    show($('waitHint'), false);
    $('waitTip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
    let n = 0;
    waitTick = setInterval(() => {
      const s = Math.floor((Date.now() - waitStart) / 1000);
      $('waitTimer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s % 7 === 6) { n += 1; $('waitTip').textContent = TIPS[(n + Math.floor(waitStart / 1000)) % TIPS.length]; }
      if (s === 20) {
        $('waitHint').textContent = room
          ? 'Waiting for your friend. Ask them to open the invite link or enter the room code.'
          : S.mode === 'video'
            ? 'It is quiet right now. You could try a text chat, or invite a friend to a private room.'
            : 'It is quiet right now. Invite a friend to a private room, or try again in a moment.';
        show($('waitHint'), true);
      }
    }, 1000);
  }
  function stopWaiting() { clearInterval(waitTick); waitTick = null; }
  hooks.screen = (name) => { if (name === 'waiting') startWaiting(); else stopWaiting(); };

  /* ============================================================ session lifecycle hooks */
  hooks.partnerFound = () => {
    stats.chats += 1; stats.since = Date.now();
    document.title = S.baseTitle;
  };
  hooks.keyReady = () => {
    sendProfile();
    show($('quick'), true);
    if (S.mode === 'video') applyCamOffOnce();
  };
  hooks.partnerLeft = () => {
    stopClock();
    if (cfg.autoNext) {
      SC.addSystem('Finding someone new for you…');
      setTimeout(() => { if (S.screen === 'session' && S.ended) SC.nextPartner(); }, 2000);
    }
  };
  hooks.reset = () => {
    stopClock();
    partner.name = ''; partner.avatar = ''; partner.ts = 0; lastReactTs.clear(); showPartner();
    reactions.clear(); sentEnv.clear(); seenQueue.length = 0;
    clearReply(); hideQuick(); hooks.inputChanged();
    resetCallUi();
  };

  /* ============================================================ call features */
  const stageMenu = $('stageMenu');
  const reactBar = $('reactBar');
  const toggleMenu = (menu, btn, force) => {
    const open = force ?? menu.classList.contains('hidden');
    [stageMenu, reactBar].forEach((m) => { if (m !== menu) show(m, false); });
    $('moreBtn').setAttribute('aria-expanded', String(menu === stageMenu && open));
    $('reactBtn').setAttribute('aria-expanded', String(menu === reactBar && open));
    show(menu, open);
  };
  $('moreBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(stageMenu, $('moreBtn')); });
  $('reactBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(reactBar, $('reactBtn')); });
  document.addEventListener('click', (e) => {
    if (!stageMenu.contains(e.target)) show(stageMenu, false);
    if (!reactBar.contains(e.target)) show(reactBar, false);
    $('moreBtn').setAttribute('aria-expanded', String(!stageMenu.classList.contains('hidden')));
    $('reactBtn').setAttribute('aria-expanded', String(!reactBar.classList.contains('hidden')));
  });

  // call reactions
  ['👍', '❤️', '😂', '👏', '🔥', '😮'].forEach((r) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = r; b.setAttribute('aria-label', `Send ${r}`);
    b.addEventListener('click', () => { showFloat(r); SC.sendEnvelope({ t: 'creact', e: r }).catch(() => {}); });
    reactBar.appendChild(b);
  });
  function showFloat(emoji) {
    if (!['👍', '❤️', '😂', '👏', '🔥', '😮'].includes(emoji)) return;
    const f = document.createElement('span');
    f.className = 'float'; f.textContent = emoji;
    f.style.setProperty('--x', `${10 + Math.random() * 70}%`);
    $('reactFloat').appendChild(f);
    setTimeout(() => f.remove(), 2600);
  }

  // blur partner's video
  const veil = $('blurVeil');
  const applyBlur = (on) => { el.remoteVideo.classList.toggle('blurred', on); show(veil, on); $('blurChk').checked = on; };
  veil.addEventListener('click', () => applyBlur(false));
  $('blurChk').addEventListener('change', () => applyBlur($('blurChk').checked));
  hooks.remoteTrack = () => { if (cfg.blurRemote) applyBlur(true); };
  hooks.playBlocked = () => show($('playVeil'), true);
  $('playVeil').addEventListener('click', () => { el.remoteVideo.play().catch(() => {}); show($('playVeil'), false); });
  el.remoteVideo.addEventListener('playing', () => show($('playVeil'), false));

  // volume, fit, mirror, self view, quality
  $('volRange').addEventListener('input', () => { el.remoteVideo.volume = Number($('volRange').value); });
  $('fitBtn').addEventListener('click', () => { cfg.fit = cfg.fit === 'cover' ? 'contain' : 'cover'; save(); applyAppearance(); });
  el.remoteVideo.addEventListener('dblclick', () => { if (document.fullscreenElement) document.exitFullscreen(); else el.stage.requestFullscreen?.().catch(() => {}); });
  $('mirrorChk').checked = cfg.mirror;
  $('mirrorChk').addEventListener('change', () => { cfg.mirror = $('mirrorChk').checked; save(); applyAppearance(); });
  $('selfChk').addEventListener('change', () => show($('localBox'), $('selfChk').checked));
  $('qualitySel').value = cfg.quality;
  const BITRATE = { low: 250000, standard: 1000000, hd: 2500000 };
  async function applyQuality() {
    const sender = S.pc && S.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = BITRATE[cfg.quality];
      await sender.setParameters(params);
    } catch (err) { console.warn('quality not applied', err); }
  }
  $('qualitySel').addEventListener('change', () => { cfg.quality = $('qualitySel').value; save(); applyQuality(); });

  // move self-view between corners
  const corners = ['tr', 'br', 'bl', 'tl'];
  let cornerIdx = 0;
  const lb = $('localBox');
  const nextCorner = () => { cornerIdx = (cornerIdx + 1) % corners.length; lb.dataset.corner = corners[cornerIdx]; };
  lb.addEventListener('click', nextCorner);
  lb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nextCorner(); } });
  lb.dataset.corner = 'tr';

  // devices
  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
    const fill = (sel, kind, current, label) => {
      const items = list.filter((d) => d.kind === kind);
      sel.replaceChildren();
      items.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label || `${label} ${i + 1}`;
        sel.appendChild(o);
      });
      if (current && items.some((d) => d.deviceId === current)) sel.value = current;
      sel.disabled = items.length === 0;
    };
    const liveCam = S.localStream && S.localStream.getVideoTracks()[0];
    const liveMic = S.localStream && S.localStream.getAudioTracks()[0];
    fill($('camSel'), 'videoinput', liveCam ? liveCam.getSettings().deviceId : cfg.camId, 'Camera');
    fill($('micSel'), 'audioinput', liveMic ? liveMic.getSettings().deviceId : cfg.micId, 'Microphone');
    show($('flipBtn'), list.filter((d) => d.kind === 'videoinput').length > 1);
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
  async function swapDevice(kind, deviceId) {
    try {
      const fresh = (await navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: { deviceId: { exact: deviceId } } } : { audio: { deviceId: { exact: deviceId } } }))
        .getTracks()[0];
      const old = (kind === 'video' ? S.localStream.getVideoTracks() : S.localStream.getAudioTracks())[0];
      const sender = S.pc && S.pc.getSenders().find((s) => s.track && s.track.kind === kind);
      if (sender) await sender.replaceTrack(fresh);
      if (old) { S.localStream.removeTrack(old); old.stop(); }
      S.localStream.addTrack(fresh);
      el.localVideo.srcObject = S.localStream;
      if (kind === 'video') cfg.camId = deviceId; else { cfg.micId = deviceId; startMeter(); }
      save(); SC.syncMediaButtons();
    } catch (err) { console.error(err); toast('Could not switch that device.', 'error'); refreshDevices(); }
  }
  $('camSel').addEventListener('change', () => S.localStream && swapDevice('video', $('camSel').value));
  $('micSel').addEventListener('change', () => S.localStream && swapDevice('audio', $('micSel').value));

  function applyCamOffOnce() {
    const v = S.localStream && S.localStream.getVideoTracks()[0];
    if (cfg.camOff && v && !S.localStream._camOffApplied) {
      S.localStream._camOffApplied = true;
      v.enabled = false;
      SC.syncMediaButtons();
    }
  }
  hooks.media = (stream) => { applyCamOffOnce(); refreshDevices(); startMeter(stream); };

  // microphone level meter
  let meterRaf = 0; let meterCtx = null; let meterSrc = null;
  function startMeter(stream = S.localStream) {
    stopMeter();
    const track = stream && stream.getAudioTracks()[0];
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!track || !AC) return;
    try {
      meterCtx = new AC();
      const analyser = meterCtx.createAnalyser();
      analyser.fftSize = 256;
      meterSrc = meterCtx.createMediaStreamSource(new MediaStream([track]));
      meterSrc.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
        $('micBtn').style.setProperty('--lvl', track.enabled ? Math.min(1, peak / 60).toFixed(2) : '0');
        meterRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* meter is optional */ }
  }
  function stopMeter() {
    cancelAnimationFrame(meterRaf);
    try { meterSrc && meterSrc.disconnect(); meterCtx && meterCtx.close(); } catch { /* already closed */ }
    meterSrc = null; meterCtx = null;
    $('micBtn').style.setProperty('--lvl', '0');
  }

  // network quality
  let netTimer = null; let lastStats = null;
  function startNet() {
    stopNet();
    show($('netBadge'), true);
    $('netBadge').dataset.q = '';
    $('netText').textContent = 'Checking…';
    netTimer = setInterval(async () => {
      if (!S.pc || S.pc.connectionState !== 'connected') return;
      try {
        const report = await S.pc.getStats();
        let rtt = null; let lost = 0; let recv = 0;
        report.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && typeof r.currentRoundTripTime === 'number') rtt = r.currentRoundTripTime * 1000;
          if (r.type === 'inbound-rtp' && !r.isRemote) { lost += r.packetsLost || 0; recv += r.packetsReceived || 0; }
        });
        const dLost = lastStats ? lost - lastStats.lost : 0; const dRecv = lastStats ? recv - lastStats.recv : 0;
        lastStats = { lost, recv };
        const loss = dRecv + dLost > 0 ? dLost / (dRecv + dLost) : 0;
        const q = (rtt !== null && rtt > 400) || loss > 0.08 ? 'poor' : (rtt !== null && rtt > 150) || loss > 0.02 ? 'fair' : 'good';
        $('netBadge').dataset.q = q;
        $('netText').textContent = `${{ good: 'Good', fair: 'Fair', poor: 'Poor' }[q]} connection${rtt !== null ? `, ${Math.round(rtt)} ms` : ''}`;
        applyQuality();
      } catch { /* stats unavailable */ }
    }, 3000);
  }
  function stopNet() { clearInterval(netTimer); netTimer = null; lastStats = null; show($('netBadge'), false); }

  // keep the screen awake during a call
  let wake = null;
  async function lockScreen() {
    try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch { /* not allowed */ }
  }
  const unlockScreen = () => { try { wake && wake.release(); } catch { /* ignore */ } wake = null; };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && el.sessionScreen.dataset.call === 'on') lockScreen(); });

  hooks.callStart = () => {
    startNet(); lockScreen(); startMeter();
    if (cfg.blurRemote) applyBlur(false); // the veil appears when partner video arrives
    show($('playVeil'), false);
  };
  function resetCallUi() {
    stopNet(); stopMeter(); unlockScreen();
    applyBlur(false); show($('playVeil'), false); show(stageMenu, false); show(reactBar, false);
    $('reactFloat').replaceChildren();
    $('selfChk').checked = true; show($('localBox'), true);
  }
  hooks.callEnd = () => { resetCallUi(); };

  /* ---- camera and microphone test ---- */
  let testStream = null; let testRaf = 0; let testCtx = null;
  async function startTest(camId, micId) {
    stopTest();
    $('testStatus').textContent = 'Starting…';
    try {
      testStream = await navigator.mediaDevices.getUserMedia({
        video: camId ? { deviceId: { exact: camId } } : true, audio: micId ? { deviceId: { exact: micId } } : true
      });
    } catch (err) { $('testStatus').textContent = SC.mediaError(err); return; }
    $('testVideo').srcObject = testStream;
    $('testStatus').textContent = 'Your camera and microphone are working. Speak to see the level move.';
    const list = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, cur) => {
      sel.replaceChildren();
      list.filter((d) => d.kind === kind).forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `Device ${i + 1}`; sel.appendChild(o); });
      if (cur) sel.value = cur;
    };
    fill($('testCam'), 'videoinput', testStream.getVideoTracks()[0]?.getSettings().deviceId);
    fill($('testMic'), 'audioinput', testStream.getAudioTracks()[0]?.getSettings().deviceId);
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && testStream.getAudioTracks()[0]) {
      testCtx = new AC();
      const an = testCtx.createAnalyser(); an.fftSize = 256;
      testCtx.createMediaStreamSource(new MediaStream([testStream.getAudioTracks()[0]])).connect(an);
      const d = new Uint8Array(an.frequencyBinCount);
      const tick = () => { an.getByteTimeDomainData(d); let p = 0; for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i] - 128)); $('testMeter').style.width = `${Math.min(100, p * 1.8)}%`; testRaf = requestAnimationFrame(tick); };
      tick();
    }
  }
  function stopTest() {
    cancelAnimationFrame(testRaf);
    try { testCtx && testCtx.close(); } catch { /* ignore */ }
    testCtx = null;
    if (testStream) testStream.getTracks().forEach((t) => t.stop());
    testStream = null;
    $('testVideo').srcObject = null;
  }
  $('testCamBtn').addEventListener('click', () => {
    if (S.noVideo) { toast('Camera access needs a supported browser and a secure (HTTPS) connection.', 'error'); return; }
    openDialog($('testDialog')); startTest();
  });
  $('testCam').addEventListener('change', () => startTest($('testCam').value, $('testMic').value));
  $('testMic').addEventListener('change', () => startTest($('testCam').value, $('testMic').value));
  $('testDone').addEventListener('click', () => closeDialog($('testDialog')));
  $('testDialog').addEventListener('close', stopTest);

  /* ============================================================ app-level */
  // panic: leave right now and hide what was on screen
  function panic() {
    document.querySelectorAll('dialog[open]').forEach((d) => { if (d.id !== 'consentDialog') d.close(); });
    SC.goHome();
    S.baseTitle = 'Notes';
    document.title = 'Notes';
    document.getElementById('main').focus({ preventScroll: true });
  }
  $('panicBtn').addEventListener('click', panic);

  $('shortcutsLink').addEventListener('click', () => openDialog($('shortcutsDialog')));
  hooks.key = (e) => {
    if (e.key === 'Escape' && (!stageMenu.classList.contains('hidden') || !reactBar.classList.contains('hidden'))) { toggleMenu(stageMenu, $('moreBtn'), false); toggleMenu(reactBar, $('reactBtn'), false); return true; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey) { e.preventDefault(); openDialog($('shortcutsDialog')); return true; }
    if (e.altKey && e.key.toLowerCase() === 'x') { e.preventDefault(); panic(); return true; }
    if (e.altKey && e.key.toLowerCase() === 'r' && S.screen === 'session') { e.preventDefault(); document.querySelector('[data-action="report"]')?.click(); return true; }
    return false;
  };

  // offline banner
  const syncOnline = () => show($('netBanner'), !navigator.onLine);
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  syncOnline();

  // keep the composer above the on-screen keyboard on phones
  if (window.visualViewport) {
    const fit = () => document.documentElement.style.setProperty('--app-h', `${Math.round(window.visualViewport.height)}px`);
    window.visualViewport.addEventListener('resize', fit);
    fit();
  }

  // installable app + offline shell
  let installEvent = null;
  show($('installBtn'), false);
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; show($('installBtn'), true); });
  $('installBtn').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => {});
    installEvent = null; show($('installBtn'), false);
  });
  window.addEventListener('appinstalled', () => { show($('installBtn'), false); toast('SecureChat was installed.', 'success'); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
  }

  hooks.inputChanged();
  showPartner();
  window.SCFeatures = { settings: () => ({ ...cfg }), validate, shrinkImage };
})();
