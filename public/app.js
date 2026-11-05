/* SecureChat client. Talks to a transport (Node server or serverless MQTT), see transport.js. */
(() => {
  'use strict';

  const CFG = window.SECURECHAT_CONFIG || {};
  const CONSENT_KEY = 'securechat.consent.v1';
  const THEME_KEY = 'securechat.theme';
  const SOUND_KEY = 'securechat.sound';
  const EMOJI = [
    ['😀', 'grinning'], ['😂', 'laughing'], ['😊', 'smiling'], ['😍', 'heart eyes'], ['😎', 'cool'], ['🤔', 'thinking'],
    ['😅', 'sweat smile'], ['🙃', 'upside down'], ['😭', 'crying'], ['😴', 'sleepy'], ['🤝', 'handshake'], ['👋', 'wave'],
    ['👍', 'thumbs up'], ['👎', 'thumbs down'], ['🙏', 'thanks'], ['👏', 'clap'], ['🔥', 'fire'], ['✨', 'sparkles'],
    ['🎉', 'party'], ['💯', 'hundred'], ['❤️', 'heart'], ['👀', 'eyes'], ['🎵', 'music'], ['☕', 'coffee']
  ];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = {};
  for (const id of [
    'app', 'welcomeScreen', 'waitingScreen', 'sessionScreen', 'startVideoBtn', 'startTextBtn', 'consentHint',
    'cancelBtn', 'waitingSub', 'previewVideo', 'localVideo', 'remoteVideo', 'remoteWait', 'remoteWaitText',
    'callTimer', 'micBtn', 'camBtn', 'flipBtn', 'shareBtn', 'pipBtn', 'stopVideoBtn', 'stage', 'messages',
    'toBottom', 'typing', 'composer', 'messageInput', 'sendBtn', 'emojiBtn', 'emojiPop', 'endedBar', 'askVideoBtn',
    'partnerStatus', 'safetyChip', 'onlineChip', 'onlineText', 'soundBtn', 'themeBtn', 'toasts', 'main',
    'consentDialog', 'consentForm', 'ageCheck', 'termsCheck', 'consentAgree', 'consentLeave', 'rulesDialog',
    'rulesLink', 'withdrawConsent', 'safetyDialog', 'safetyCode', 'copyCode', 'callDialog', 'acceptCall',
    'declineCall', 'reportDialog', 'reportForm'
  ]) el[id] = document.getElementById(id);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } }
  };

  const S = {
    transport: { emit() {}, id: '', kind: 'none' }, connected: false, everConnected: false,
    mode: 'text', screen: 'welcome', partnerId: null, gen: 0, ended: false,
    iceServers: CFG.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }],
    // encryption
    keyPair: null, myJwk: null, pendingKey: null, aes: null, keyTimer: null,
    // media + call
    localStream: null, pc: null, iReady: false, partnerReady: false, offered: false, pendingIce: [],
    asking: false, askTimer: null, restarts: 0, timerId: null, callStart: 0,
    screenStream: null, sharing: false,
    // misc
    isTyping: false, typingTimer: null, sound: store.get(SOUND_KEY) !== 'off', pending: new Map(), unread: 0,
    baseTitle: document.title, audioCtx: null,
    starting: false, nextLock: false, lastSendAt: 0, lastToast: '', lastToastAt: 0, noCrypto: false, noVideo: false
  };
  const hooks = {};
  const hook = (name, ...args) => { try { return hooks[name] ? hooks[name](...args) : undefined; } catch (err) { console.error(`hook ${name} failed`, err); return undefined; } };

  /* ------------------------------------------------------------------ utils */
  const show = (node, on) => node.classList.toggle('hidden', !on);
  const setIcon = (btn, id) => btn.querySelector('use').setAttribute('href', `#${id}`);
  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = (buf) => { let s = ''; new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function toast(message, type = 'info') {
    const now = Date.now();
    if (message === S.lastToast && now - S.lastToastAt < 2000) return; // no duplicate spam
    S.lastToast = message; S.lastToastAt = now;
    while (el.toasts.children.length >= 3) el.toasts.firstChild.remove();
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.setAttribute('role', type === 'error' ? 'alert' : 'status');
    t.textContent = message;
    t.title = 'Select to dismiss';
    el.toasts.appendChild(t);
    let timer;
    const dismiss = () => { t.classList.add('out'); setTimeout(() => t.remove(), 250); };
    const arm = () => { timer = setTimeout(dismiss, type === 'error' ? 7000 : 4200); };
    t.addEventListener('mouseenter', () => clearTimeout(timer)); // hovering pauses the countdown
    t.addEventListener('mouseleave', arm);
    t.addEventListener('click', dismiss);
    arm();
  }

  function beep(kind) {
    if (!S.sound) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      S.audioCtx = S.audioCtx || new AC();
      const ctx = S.audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const notes = { message: [[660, 0], [880, 0.07]], found: [[523, 0], [659, 0.1], [784, 0.2]], left: [[330, 0], [247, 0.1]] }[kind];
      notes.forEach(([f, at]) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
        const t = ctx.currentTime + at;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        o.start(t); o.stop(t + 0.2);
      });
    } catch { /* audio is optional */ }
  }

  /* ----------------------------------------------------------------- dialogs */
  function openDialog(d) {
    if (d.open) return;
    d._returnTo = document.activeElement;
    d.showModal();
  }
  document.addEventListener('close', (e) => { // 'close' does not bubble, so listen in the capture phase
    const d = e.target;
    if (d && d.tagName === 'DIALOG' && d._returnTo && document.contains(d._returnTo) && d !== el.consentDialog) {
      try { d._returnTo.focus({ preventScroll: true }); } catch { /* element gone */ }
    }
  }, true);
  function closeDialog(d) { if (d.open) d.close(); }
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeDialog(document.getElementById(b.dataset.close))));
  $$('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d && d !== el.consentDialog) d.close(); });
  });
  el.rulesLink.addEventListener('click', () => {
    show(el.withdrawConsent, hasConsent());
    openDialog(el.rulesDialog);
  });

  /* ------------------------------------------------------------------ theme */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const dark = theme === 'dark';
    setIcon(el.themeBtn, dark ? 'i-sun' : 'i-moon');
    el.themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  applyTheme(store.get(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  el.themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    store.set(THEME_KEY, next);
    applyTheme(next);
  });

  function applySound() {
    setIcon(el.soundBtn, S.sound ? 'i-volume' : 'i-volume-off');
    el.soundBtn.setAttribute('aria-pressed', String(S.sound));
    el.soundBtn.setAttribute('aria-label', S.sound ? 'Sounds on' : 'Sounds off');
  }
  applySound();
  el.soundBtn.addEventListener('click', () => {
    S.sound = !S.sound;
    store.set(SOUND_KEY, S.sound ? 'on' : 'off');
    applySound();
    if (S.sound) beep('message');
  });

  /* ---------------------------------------------------------------- consent */
  const hasConsent = () => { try { return JSON.parse(store.get(CONSENT_KEY)).v === 1; } catch { return false; } };

  function updateStartButtons() {
    const ok = hasConsent() && S.connected && !S.noCrypto;
    el.startVideoBtn.disabled = !ok || S.noVideo;
    el.startTextBtn.disabled = !ok;
    el.consentHint.textContent = S.noCrypto
      ? 'This page needs a secure connection (HTTPS) so messages can be encrypted.'
      : !hasConsent()
      ? 'Agree to the rules to start chatting.'
      : !S.connected
        ? 'Connecting… you can start in a moment.'
        : 'You must be 18 or older. Camera access is only requested for video chat.';
  }

  function syncConsentButton() {
    el.consentAgree.disabled = !(el.ageCheck.checked && el.termsCheck.checked);
  }
  el.ageCheck.addEventListener('change', syncConsentButton);
  el.termsCheck.addEventListener('change', syncConsentButton);
  el.consentDialog.addEventListener('cancel', (e) => e.preventDefault()); // Esc cannot skip consent
el.consentDialog.addEventListener('close', () => { if (!hasConsent()) setTimeout(() => openDialog(el.consentDialog), 0); });
  el.consentForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!(el.ageCheck.checked && el.termsCheck.checked)) return;
    store.set(CONSENT_KEY, JSON.stringify({ v: 1, at: Date.now() }));
    closeDialog(el.consentDialog);
    updateStartButtons();
    (el.startVideoBtn.disabled ? el.startTextBtn : el.startVideoBtn).focus();
  });
  el.consentLeave.addEventListener('click', () => { location.href = 'about:blank'; });
  el.withdrawConsent.addEventListener('click', () => {
    store.del(CONSENT_KEY);
    goHome();
    closeDialog(el.rulesDialog);
    el.ageCheck.checked = false; el.termsCheck.checked = false; syncConsentButton();
    updateStartButtons();
    openDialog(el.consentDialog);
  });

  /* ---------------------------------------------------------------- screens */
  function showScreen(name) {
    S.screen = name;
    el.app.dataset.screen = name;
    show(el.welcomeScreen, name === 'welcome');
    show(el.waitingScreen, name === 'waiting');
    show(el.sessionScreen, name === 'session');
    if (name !== 'session') show(el.safetyChip, false);
    hook('screen', name);
  }

  /* ------------------------------------------------------------ messages UI */
  function addSystem(text) {
    const d = document.createElement('div');
    d.className = 'sys';
    d.textContent = text;
    el.messages.appendChild(d);
    scrollDown(true);
  }

  function linkify(text, parent) {
    text.split(/(https?:\/\/[^\s<>"]+)/g).forEach((part, i) => {
      if (i % 2 === 0) { if (part) parent.appendChild(document.createTextNode(part)); return; }
      let ok = false;
      try { ok = ['http:', 'https:'].includes(new URL(part).protocol); } catch { /* not a URL */ }
      if (!ok) { parent.appendChild(document.createTextNode(part)); return; }
      const a = document.createElement('a');
      a.href = part; a.textContent = part; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
      parent.appendChild(a);
    });
  }

  /** data: { text | render(container), own, ts, id, reply } */
  function addMessage(data) {
    const { text, own, ts, id } = data;
    const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 120;
    const wrap = document.createElement('div');
    wrap.className = `msg ${own ? 'own' : 'them'}`;
    if (id) wrap.dataset.mid = id;
    let body;
    if (data.render) {
      body = document.createElement('div');
      body.className = 'media';
      data.render(body);
    } else {
      body = document.createElement('p');
      if (!hook('format', text, body)) linkify(text, body);
    }
    const meta = document.createElement('span');
    meta.className = 'meta';
    const time = document.createElement('time');
    time.dateTime = new Date(ts).toISOString();
    time.textContent = clock(ts);
    meta.appendChild(time);
    wrap.append(body, meta);
    if (own) {
      const st = document.createElement('span');
      st.className = 'delivery';
      st.textContent = 'Sending';
      meta.appendChild(st);
      if (id) S.pending.set(id, st);
    }
    el.messages.appendChild(wrap);
    while (el.messages.children.length > 400) el.messages.firstElementChild.remove(); // bound memory in very long chats
    hook('message', { wrap, body, meta, data });
    if (own || nearBottom) scrollDown(true);
    else show(el.toBottom, true);
    return wrap;
  }

  function scrollDown(force) {
    if (force) el.messages.scrollTop = el.messages.scrollHeight;
    show(el.toBottom, false);
  }
  el.messages.addEventListener('scroll', () => {
    show(el.toBottom, el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight > 160);
  });
  el.toBottom.addEventListener('click', () => scrollDown(true));

  function setComposer(enabled, placeholder) {
    el.messageInput.disabled = !enabled;
    el.sendBtn.disabled = !enabled;
    el.emojiBtn.disabled = !enabled;
    el.messageInput.placeholder = placeholder;
    hook('composerState', enabled);
  }

  function updateSessionChrome() {
    const text = S.mode === 'text';
    const inCall = el.sessionScreen.dataset.call === 'on';
    show(el.askVideoBtn, text && !inCall && !S.ended);
    el.askVideoBtn.disabled = !S.aes || S.asking;
    show(el.stopVideoBtn, text && inCall);
  }

  /* ----------------------------------------------------------- encryption */
  async function setupEncryption(gen) {
    try {
      const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
      if (gen !== S.gen) return;
      S.keyPair = kp;
      S.myJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
      if (gen !== S.gen) return;
      S.transport.emit('exchange-key', { key: { kty: 'EC', crv: 'P-256', x: S.myJwk.x, y: S.myJwk.y } });
      await tryDerive(gen);
    } catch (err) {
      console.error('Key setup failed', err);
    }
    S.keyTimer = setTimeout(() => {
      if (gen === S.gen && !S.aes) {
        addSystem('Could not set up encryption with this person, so sending is disabled. Press Next to try someone else.');
      }
    }, 10000);
  }

  async function tryDerive(gen) {
    if (!S.keyPair || !S.pendingKey || S.aes || gen !== S.gen) return;
    const k = S.pendingKey;
    if (!k || k.kty !== 'EC' || k.crv !== 'P-256' || typeof k.x !== 'string' || typeof k.y !== 'string') return;
    try {
      const theirJwk = { kty: 'EC', crv: 'P-256', x: k.x, y: k.y, ext: true };
      const theirs = await crypto.subtle.importKey('jwk', theirJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
      const aes = await crypto.subtle.deriveKey({ name: 'ECDH', public: theirs }, S.keyPair.privateKey,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      if (gen !== S.gen) return;
      const pair = [`${S.myJwk.x}.${S.myJwk.y}`, `${theirJwk.x}.${theirJwk.y}`].sort().join('|');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pair));
      if (gen !== S.gen) return;
      S.aes = aes;
      el.safetyCode.textContent = hex(digest).slice(0, 16).match(/.{4}/g).join(' ');
      show(el.safetyChip, true);
      setComposer(true, 'Write a message');
      updateSessionChrome();
      addSystem('Messages are end-to-end encrypted. Select the lock at the top to compare safety codes.');
      if (S.screen === 'session') el.messageInput.focus({ preventScroll: true });
      hook('keyReady');
    } catch (err) {
      console.error('Key exchange failed', err);
      addSystem('The other person sent an invalid encryption key. Press Next to try someone else.');
    }
  }

  async function encrypt(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, S.aes, new TextEncoder().encode(text));
    return JSON.stringify({ iv: b64(iv), c: b64(ct) });
  }
  async function decrypt(payload) {
    const { iv, c } = JSON.parse(payload);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, S.aes, unb64(c));
    return new TextDecoder().decode(pt);
  }

  el.safetyChip.addEventListener('click', () => openDialog(el.safetyDialog));
  el.copyCode.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(el.safetyCode.textContent); toast('Safety code copied', 'success'); }
    catch { toast('Could not copy. Select the code and copy it manually.', 'error'); }
  });

  /* --------------------------------------------------------------- sending */
  /** Everything sent to the partner is a typed JSON envelope inside the AES-GCM payload, so the relay never sees types or metadata. */
  async function sendEnvelope(env) {
    const id = env.m || uid();
    S.transport.emit('send-message', { message: await encrypt(JSON.stringify(env)), id });
    return id;
  }

  el.composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    let text = el.messageInput.value.trim();
    if (!text || !S.aes || S.ended) return;
    const out = hook('beforeSend', text);
    if (out && out.cancel) { el.messageInput.value = ''; hook('inputChanged'); return; }
    if (out && typeof out.text === 'string') text = out.text;
    const now = Date.now();
    const id = uid();
    const reply = hook('takeReply') || null;
    const env = { t: 'text', m: id, x: text };
    if (reply) env.r = reply;
    el.messageInput.value = '';
    hook('inputChanged');
    stopTyping();
    addMessage({ text, own: true, ts: now, id, reply });
    hook('sent', env);
    try {
      await sendEnvelope(env);
    } catch (err) {
      console.error(err);
      const st = S.pending.get(id);
      if (st) { st.textContent = 'Not sent'; hook('failed', id, env); }
    }
  });

  function startTyping() {
    if (hook('typingOff')) return;
    if (!S.isTyping) { S.isTyping = true; S.transport.emit('typing-start'); }
    clearTimeout(S.typingTimer);
    S.typingTimer = setTimeout(stopTyping, 1800);
  }
  function stopTyping() {
    clearTimeout(S.typingTimer);
    if (S.isTyping) { S.isTyping = false; S.transport.emit('typing-stop'); }
  }
  el.messageInput.addEventListener('input', () => {
    hook('inputChanged');
    if (el.messageInput.value) startTyping(); else stopTyping();
  });
  el.messageInput.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter makes a new line; Enter while composing (IME) must not send.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); el.composer.requestSubmit(); }
  });
  el.messageInput.addEventListener('blur', stopTyping);

  /* ------------------------------------------------------------------ emoji */
  EMOJI.forEach(([ch, name]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = ch; b.setAttribute('aria-label', name); b.setAttribute('role', 'option');
    b.addEventListener('click', () => {
      const i = el.messageInput;
      const start = i.selectionStart ?? i.value.length;
      i.value = i.value.slice(0, start) + ch + i.value.slice(i.selectionEnd ?? start);
      i.focus(); i.setSelectionRange(start + ch.length, start + ch.length);
      closeEmoji(); startTyping();
    });
    el.emojiPop.appendChild(b);
  });
  function closeEmoji() { show(el.emojiPop, false); el.emojiBtn.setAttribute('aria-expanded', 'false'); }
  el.emojiBtn.addEventListener('click', () => {
    const open = el.emojiPop.classList.contains('hidden');
    show(el.emojiPop, open);
    el.emojiBtn.setAttribute('aria-expanded', String(open));
    if (open) el.emojiPop.querySelector('button').focus();
  });
  document.addEventListener('click', (e) => {
    if (!el.emojiPop.contains(e.target) && !el.emojiBtn.contains(e.target)) closeEmoji();
  });

  /* ------------------------------------------------------------------ media */
  const mediaError = (e) => {
    if (!navigator.mediaDevices) return 'Camera access needs a secure (HTTPS) connection.';
    switch (e && e.name) {
      case 'NotAllowedError': case 'SecurityError': return 'Camera or microphone access was blocked. Allow it in your browser’s site settings and try again.';
      case 'NotFoundError': return 'No camera or microphone was found on this device.';
      case 'NotReadableError': return 'Another app is using your camera or microphone.';
      default: return 'Could not start your camera or microphone.';
    }
  };

  async function acquireMedia() {
    if (S.localStream && S.localStream.getTracks().some((t) => t.readyState === 'live')) return S.localStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('unsupported');
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      S.localStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio });
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
      S.localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio }); // voice only
    }
    el.localVideo.srcObject = S.localStream;
    el.previewVideo.srcObject = S.localStream;
    S.localStream.getTracks().forEach((track) => track.addEventListener('ended', () => {
      if (S.localStream && !S.sharing) { toast(`Your ${track.kind === 'video' ? 'camera' : 'microphone'} was disconnected.`, 'error'); syncMediaButtons(); }
    }));
    hook('media', S.localStream);
    const hasVideo = S.localStream.getVideoTracks().length > 0;
    el.camBtn.disabled = !hasVideo;
    el.micBtn.disabled = S.localStream.getAudioTracks().length === 0;
    syncMediaButtons();
    navigator.mediaDevices.enumerateDevices().then((d) => {
      show(el.flipBtn, d.filter((x) => x.kind === 'videoinput').length > 1);
    }).catch(() => {});
    show(el.shareBtn, !!(navigator.mediaDevices.getDisplayMedia));
    show(el.pipBtn, !!document.pictureInPictureEnabled);
    return S.localStream;
  }

  function stopLocalMedia() {
    stopScreenShare(false);
    if (S.localStream) S.localStream.getTracks().forEach((t) => t.stop());
    S.localStream = null;
    el.localVideo.srcObject = null;
    el.previewVideo.srcObject = null;
  }

  function syncMediaButtons() {
    const a = S.localStream && S.localStream.getAudioTracks()[0];
    const v = S.localStream && S.localStream.getVideoTracks()[0];
    const micOff = !a || !a.enabled; const camOff = !v || !v.enabled;
    el.micBtn.setAttribute('aria-pressed', String(micOff));
    el.micBtn.setAttribute('aria-label', micOff ? 'Unmute microphone' : 'Mute microphone');
    setIcon(el.micBtn, micOff ? 'i-mic-off' : 'i-mic');
    el.camBtn.setAttribute('aria-pressed', String(camOff));
    el.camBtn.setAttribute('aria-label', camOff ? 'Turn camera on' : 'Turn camera off');
    setIcon(el.camBtn, camOff ? 'i-video-off' : 'i-video');
  }
  function toggleTrack(kind) {
    const t = S.localStream && (kind === 'audio' ? S.localStream.getAudioTracks() : S.localStream.getVideoTracks())[0];
    if (t) { t.enabled = !t.enabled; syncMediaButtons(); }
  }

  async function switchCamera() {
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const cur = S.localStream.getVideoTracks()[0];
      const curId = cur && cur.getSettings().deviceId;
      const next = cams[(Math.max(0, cams.findIndex((c) => c.deviceId === curId)) + 1) % cams.length];
      const fresh = (await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: next.deviceId } } })).getVideoTracks()[0];
      const sender = S.pc && S.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(fresh);
      if (cur) { S.localStream.removeTrack(cur); cur.stop(); }
      S.localStream.addTrack(fresh);
      el.localVideo.srcObject = S.localStream;
      syncMediaButtons();
    } catch (err) {
      console.error(err);
      toast('Could not switch cameras.', 'error');
    }
  }

  async function toggleScreenShare() {
    if (S.sharing) return stopScreenShare(true);
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = display.getVideoTracks()[0];
      const sender = S.pc && S.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (!sender) { track.stop(); toast('Start video first, then share your screen.', 'info'); return; }
      await sender.replaceTrack(track);
      S.screenStream = display; S.sharing = true;
      el.localVideo.srcObject = display;
      el.shareBtn.setAttribute('aria-pressed', 'true');
      track.addEventListener('ended', () => stopScreenShare(true));
    } catch (err) {
      if (err.name !== 'NotAllowedError') toast('Could not share your screen.', 'error');
    }
  }
  function stopScreenShare(restore) {
    if (!S.sharing) return;
    S.sharing = false;
    S.screenStream.getTracks().forEach((t) => t.stop());
    S.screenStream = null;
    el.shareBtn.setAttribute('aria-pressed', 'false');
    if (restore && S.localStream) {
      const cam = S.localStream.getVideoTracks()[0];
      const sender = S.pc && S.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (cam && sender) sender.replaceTrack(cam).catch(() => {});
      el.localVideo.srcObject = S.localStream;
    }
  }

  /* ------------------------------------------------------------------- call */
  function createPeer(gen) {
    const pc = new RTCPeerConnection({ iceServers: S.iceServers });
    S.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate && gen === S.gen) S.transport.emit('ice-candidate', { candidate: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
      if (!e.streams[0]) return;
      el.remoteVideo.srcObject = e.streams[0];
      el.remoteVideo.play().catch(() => hook('playBlocked'));
      show(el.remoteWait, false);
      hook('remoteTrack', e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (S.pc !== pc) return;
      if (pc.connectionState === 'connected') { S.restarts = 0; startCallTimer(); show(el.remoteWait, false); }
      if (pc.connectionState === 'disconnected') el.remoteWaitText.textContent = 'Connection unstable…';
      if (pc.connectionState === 'failed') {
        if (S.offered && S.restarts < 2) {
          S.restarts += 1;
          pc.createOffer({ iceRestart: true }).then((o) => pc.setLocalDescription(o))
            .then(() => S.transport.emit('offer', { offer: pc.localDescription.toJSON() })).catch(() => {});
        } else {
          show(el.remoteWait, true);
          el.remoteWaitText.textContent = 'Video connection failed. Press Next to try someone else.';
        }
      }
    };
    return pc;
  }

  async function beginCall() {
    const gen = S.gen;
    try {
      await acquireMedia();
    } catch (e) {
      toast(mediaError(e), 'error');
      S.transport.emit('call-ended');
      S.asking = false;
      updateSessionChrome();
      return;
    }
    if (gen !== S.gen) return;
    if (S.pc) { S.pc.onconnectionstatechange = null; S.pc.ontrack = null; S.pc.onicecandidate = null; S.pc.close(); S.pc = null; }
    S.offered = false; S.pendingIce = [];
    const pc = createPeer(gen);
    S.localStream.getTracks().forEach((t) => pc.addTrack(t, S.localStream));
    el.sessionScreen.dataset.call = 'on';
    show(el.remoteWait, true);
    el.remoteWaitText.textContent = 'Connecting video…';
    S.asking = false;
    updateSessionChrome();
    hook('callStart');
    S.iReady = true;
    S.transport.emit('media-ready');
    maybeOffer();
  }

  async function maybeOffer() {
    if (!S.iReady || !S.partnerReady || S.offered || !S.pc) return;
    if (!(S.transport.id < S.partnerId)) return; // the lower id makes the offer
    S.offered = true;
    const gen = S.gen; const pc = S.pc;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (gen === S.gen && S.pc === pc) S.transport.emit('offer', { offer: pc.localDescription.toJSON() });
    } catch (err) {
      console.error(err);
      toast('Could not start the video call.', 'error');
    }
  }

  async function flushIce() {
    const queued = S.pendingIce; S.pendingIce = [];
    for (const c of queued) { try { await S.pc.addIceCandidate(c); } catch (err) { console.warn(err); } }
  }

  function startCallTimer() {
    if (S.timerId) return;
    S.callStart = Date.now();
    show(el.callTimer, true);
    S.timerId = setInterval(() => {
      const s = Math.floor((Date.now() - S.callStart) / 1000);
      el.callTimer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);
  }

  function endCall({ keepLocal = false, silent = false } = {}) {
    clearInterval(S.timerId); S.timerId = null;
    el.callTimer.textContent = '00:00';
    show(el.callTimer, false);
    stopScreenShare(false);
    if (S.pc) { S.pc.onconnectionstatechange = null; S.pc.ontrack = null; S.pc.onicecandidate = null; S.pc.close(); S.pc = null; }
    el.remoteVideo.srcObject = null;
    S.iReady = false; S.partnerReady = false; S.offered = false; S.pendingIce = []; S.restarts = 0;
    if (!keepLocal) stopLocalMedia();
    if (!silent) { el.sessionScreen.dataset.call = 'off'; }
    hook('callEnd');
    updateSessionChrome();
  }

  /* ----------------------------------------------------- session lifecycle */
  function resetSession() {
    S.gen += 1;
    clearTimeout(S.keyTimer);
    S.keyPair = null; S.myJwk = null; S.pendingKey = null; S.aes = null;
    S.ended = false; S.asking = false; S.isTyping = false; S.pending.clear();
    clearTimeout(S.askTimer);
    el.messages.replaceChildren();
    el.safetyCode.textContent = '—';
    show(el.typing, false); show(el.endedBar, false); show(el.composer, true); show(el.safetyChip, false);
    closeDialog(el.callDialog); closeDialog(el.reportDialog); closeDialog(el.safetyDialog); closeEmoji();
    setComposer(false, 'Securing this chat…');
    el.messageInput.value = '';
    el.partnerStatus.textContent = 'Connected';
    el.partnerStatus.classList.remove('gone');
    el.sessionScreen.dataset.call = 'off';
    hook('reset');
  }

  const findPayload = (mode) => ({ chatMode: mode, consent: true, ...(hook('prefs') || {}) });

  async function startSearch(mode) {
    if (!hasConsent()) return openDialog(el.consentDialog);
    if (!S.connected) return toast('Not connected yet. Try again in a moment.', 'error');
    if (S.starting) return; // ignore double clicks while the camera prompt is open
    S.starting = true;
    try {
      S.mode = mode;
      if (mode === 'video') {
        try { await acquireMedia(); } catch (e) { toast(mediaError(e), 'error'); return; }
        if (!hasConsent()) { stopLocalMedia(); return; }
      }
      el.previewVideo.parentElement.classList.toggle('live', mode === 'video');
      el.waitingSub.textContent = mode === 'video' ? 'Waiting for someone who wants a video chat.' : 'Waiting for someone who wants a text chat.';
      showScreen('waiting');
      el.cancelBtn.focus();
      S.transport.emit('find-partner', findPayload(mode));
    } finally {
      S.starting = false;
    }
  }

  function leaveChat({ keepLocal }) {
    stopTyping();
    S.transport.emit('skip-partner');
    endCall({ keepLocal });
    resetSession();
    S.partnerId = null;
  }

  function goHome() {
    if (S.screen === 'waiting') S.transport.emit('leave-queue');
    leaveChat({ keepLocal: false });
    stopLocalMedia();
    showScreen('welcome');
    el.main.focus({ preventScroll: true });
  }

  function nextPartner() {
    if (S.nextLock) return;
    S.nextLock = true;
    setTimeout(() => { S.nextLock = false; }, 700);
    leaveChat({ keepLocal: S.mode === 'video' });
    startSearch(S.mode);
  }

  function onPartnerFound(d) {
    resetSession();
    S.partnerId = d.partnerId;
    showScreen('session');
    el.sessionScreen.dataset.mode = S.mode;
    updateSessionChrome();
    beep('found');
    setupEncryption(S.gen);
    if (S.mode === 'video') {
      el.sessionScreen.dataset.call = 'on';
      beginCall();
    }
    hook('partnerFound', d);
  }

  function onPartnerLeft() {
    if (S.screen !== 'session' || S.ended) return;
    S.ended = true;
    stopTyping();
    endCall({ keepLocal: S.mode === 'video' });
    el.partnerStatus.textContent = 'Left the chat';
    el.partnerStatus.classList.add('gone');
    show(el.composer, false); show(el.endedBar, true); show(el.typing, false);
    closeDialog(el.callDialog);
    addSystem('Your partner left the chat.');
    beep('left');
    updateSessionChrome();
    el.endedBar.querySelector('[data-action="next"]').focus();
    hook('partnerLeft');
  }

  /* -------------------------------------------------------- transport events */
  function wire(t) {
    t.on('connect', () => {
      if (S.connected) return;
      S.connected = true;
      el.onlineChip.classList.add('live');
      el.onlineText.textContent = '1 online';
      if (!S.everConnected) S.everConnected = true;
      else toast('Reconnected', 'success');
      if (S.screen === 'waiting' && t.kind === 'socket') t.emit('find-partner', findPayload(S.mode));
      updateStartButtons();
    });
    t.on('disconnect', () => {
      S.connected = false;
      el.onlineChip.classList.remove('live');
      el.onlineText.textContent = 'Reconnecting…';
      toast('Connection lost. Reconnecting…', 'error');
      if (t.kind === 'socket' && S.screen === 'session') onPartnerLeft();
      updateStartButtons();
    });
    t.on('online-count', (n) => { if (S.connected) el.onlineText.textContent = `${n} online`; });
    t.on('consent-required', () => { openDialog(el.consentDialog); showScreen('welcome'); });
    t.on('error-message', (d) => toast((d && d.message) || 'Something went wrong.', 'error'));
    t.on('server-shutdown', () => toast('The server is restarting. You will reconnect automatically.', 'info'));
    t.on('rate-limited', (d) => toast((d && d.message) || 'Slow down a little.', 'info'));
    t.on('waiting-for-partner', () => { if (S.screen !== 'waiting') showScreen('waiting'); });
    t.on('partner-found', onPartnerFound);
    t.on('partner-disconnected', onPartnerLeft);

    t.on('exchange-key', (d) => { S.pendingKey = d.key; tryDerive(S.gen); });

    t.on('message-received', async (d) => {
      if (!S.aes || typeof d.message !== 'string') return;
      let plain;
      try { plain = await decrypt(d.message); } catch { addSystem('A message could not be decrypted and was dropped.'); return; }
      let env = null;
      try { env = JSON.parse(plain); } catch { /* older clients sent bare text */ }
      if (!env || typeof env !== 'object' || typeof env.t !== 'string') env = { t: 'text', x: plain, m: d.id };
      if (env.t !== 'text') { hook('envelope', env, d); return; }
      if (typeof env.x !== 'string') return;
      show(el.typing, false);
      const text = env.x.slice(0, 2000);
      addMessage({ text, own: false, ts: d.timestamp || Date.now(), id: typeof env.m === 'string' ? env.m.slice(0, 64) : undefined, reply: env.r });
      beep('message');
      if (document.hidden) S.unread += 1;
      hook('incoming', env);
    });
    t.on('message-delivered', (d) => {
      const st = d && S.pending.get(d.id);
      if (st) { st.textContent = 'Delivered'; S.pending.delete(d.id); }
    });
    t.on('message-failed', (d) => {
      const st = d && S.pending.get(d.id);
      if (st) { st.textContent = 'Not delivered'; S.pending.delete(d.id); }
    });
    t.on('partner-typing', (d) => {
      show(el.typing, d.typing === true);
      if (d.typing) scrollDown(false);
    });
    t.on('report-received', () => {
      toast(t.kind === 'socket' ? 'Report sent. Thank you.' : 'Noted. You have been moved on.', 'success');
    });

    // call signalling
    t.on('video-call-request', () => {
      if (el.sessionScreen.dataset.call === 'on' || el.callDialog.open || !S.aes) return t.emit('video-call-response', { accepted: false });
      openDialog(el.callDialog);
    });
    t.on('video-call-response', (d) => {
      clearTimeout(S.askTimer);
      if (d.accepted) beginCall();
      else { S.asking = false; updateSessionChrome(); toast('They chose to keep texting.', 'info'); }
    });
    t.on('media-ready', () => { S.partnerReady = true; maybeOffer(); });
    t.on('offer', async (d) => {
      const pc = S.pc;
      if (!pc || !d.offer) return;
      try {
        await pc.setRemoteDescription(d.offer);
        await flushIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        t.emit('answer', { answer: pc.localDescription.toJSON() });
      } catch (err) { console.error(err); toast('Could not answer the video call.', 'error'); }
    });
    t.on('answer', async (d) => {
      if (!S.pc || !d.answer || S.pc.signalingState !== 'have-local-offer') return;
      try { await S.pc.setRemoteDescription(d.answer); await flushIce(); } catch (err) { console.error(err); }
    });
    t.on('ice-candidate', async (d) => {
      if (!S.pc || !d.candidate) return;
      if (S.pc.remoteDescription) { try { await S.pc.addIceCandidate(d.candidate); } catch (err) { console.warn(err); } }
      else S.pendingIce.push(d.candidate);
    });
    t.on('call-ended', () => {
      if (S.mode !== 'text') { // partner could not start their camera: keep the chat usable
        endCall({ keepLocal: true, silent: true });
        show(el.remoteWait, true);
        el.remoteWaitText.textContent = 'Your partner could not start video. You can keep chatting, or press Next.';
        return;
      }
      if (S.mode === 'text') {
        endCall({ keepLocal: false });
        S.asking = false;
        toast('Your partner stopped the video.', 'info');
        updateSessionChrome();
      }
    });
  }

  /* ----------------------------------------------------------------- actions */
  el.acceptCall.addEventListener('click', async () => {
    closeDialog(el.callDialog);
    try { await acquireMedia(); } catch (e) {
      toast(mediaError(e), 'error');
      S.transport.emit('video-call-response', { accepted: false });
      return;
    }
    S.transport.emit('video-call-response', { accepted: true });
    beginCall();
  });
  el.declineCall.addEventListener('click', () => {
    closeDialog(el.callDialog);
    S.transport.emit('video-call-response', { accepted: false });
  });

  el.reportForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const reason = new FormData(el.reportForm).get('reason') || 'other';
    S.transport.emit('report-user', { reason });
    hook('reported', S.partnerId);
    closeDialog(el.reportDialog);
    nextPartner();
  });

  const actions = {
    skip: nextPartner,
    next: nextPartner,
    home: goHome,
    report: () => { if (S.partnerId && !S.ended) openDialog(el.reportDialog); },
    'ask-video': () => {
      if (!S.aes || S.asking || S.ended) return;
      S.asking = true;
      updateSessionChrome();
      toast('Asked to switch to video…', 'info');
      S.transport.emit('video-call-request');
      S.askTimer = setTimeout(() => { S.asking = false; updateSessionChrome(); }, 30000);
    },
    'stop-video': () => { S.transport.emit('call-ended'); endCall({ keepLocal: false }); },
    'toggle-mic': () => toggleTrack('audio'),
    'toggle-cam': () => toggleTrack('video'),
    'switch-camera': switchCamera,
    'share-screen': toggleScreenShare,
    pip: async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await el.remoteVideo.requestPictureInPicture();
      } catch { toast('Pop-out is not available right now.', 'info'); }
    },
    fullscreen: () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (el.stage.requestFullscreen) el.stage.requestFullscreen().catch(() => {});
    }
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b && actions[b.dataset.action]) actions[b.dataset.action]();
  });

  el.startVideoBtn.addEventListener('click', () => startSearch('video'));
  el.startTextBtn.addEventListener('click', () => startSearch('text'));
  el.cancelBtn.addEventListener('click', goHome);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.emojiPop.classList.contains('hidden')) { closeEmoji(); el.emojiBtn.focus(); }
    if (hook('key', e)) return;
    if (!e.altKey || S.screen !== 'session') return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); nextPartner(); }
    if (k === 'm') { e.preventDefault(); toggleTrack('audio'); }
    if (k === 'v') { e.preventDefault(); toggleTrack('video'); }
  });
  window.addEventListener('focus', () => { S.unread = 0; document.title = S.baseTitle; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { S.unread = 0; document.title = S.baseTitle; hook('visible'); } });
  window.addEventListener('pagehide', () => { stopLocalMedia(); });

  /* -------------------------------------------------------------------- boot */
  async function boot() {
    S.noCrypto = !(window.crypto && window.crypto.subtle);
    S.noVideo = !(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    if (S.noVideo) el.startVideoBtn.title = 'Video needs a browser with camera support and a secure (HTTPS) connection.';
    updateStartButtons();
    syncConsentButton();
    if (!hasConsent()) openDialog(el.consentDialog);

    el.onlineText.textContent = 'Connecting…';
    try {
      const params = new URLSearchParams(location.search);
      const cfg = { ...CFG };
      const ns = params.get('ns');
      if (ns && /^[a-zA-Z0-9_-]{1,40}$/.test(ns)) cfg.namespace = `${cfg.namespace}/private/${ns}`; // private lobby for friends/tests
      if (params.get('transport')) cfg.transport = params.get('transport');
      if (/^\d{1,6}$/.test(params.get('cooldown') || '')) cfg.rematchCooldownMs = Number(params.get('cooldown'));
      S.transport = await window.SecureTransport.createTransport(cfg);
      if (S.transport.kind === 'socket') {
        try {
          const r = await fetch('api/ice-servers', { cache: 'no-store' });
          if (r.ok) S.iceServers = (await r.json()).iceServers || S.iceServers;
        } catch { /* keep defaults */ }
      }
      wire(S.transport);
      document.documentElement.dataset.transport = S.transport.kind;
      if (S.transport.connected) S.transport.fire('connect');
    } catch (err) {
      console.error(err);
      el.onlineText.textContent = 'Offline';
      toast('Could not reach the chat network. Check your connection and reload.', 'error');
    }
    window.__securechat = { state: S };
  }
  window.SC = {
    S, el, hooks, store, toast, show, setIcon, openDialog, closeDialog, uid, clock, b64, hex, beep,
    addSystem, addMessage, sendEnvelope, startSearch, goHome, nextPartner, applyTheme, acquireMedia,
    syncMediaButtons, scrollDown, startTyping, stopTyping, hasConsent, mediaError, updateSessionChrome, setComposer,
    toggleTrack, updateStartButtons, stopLocalMedia, THEME_KEY, SOUND_KEY
  };
  boot();
})();
