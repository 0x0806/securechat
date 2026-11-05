/*
 * Transports give the app one event contract regardless of where it is hosted:
 *
 *   SocketTransport – Socket.IO to the bundled Node server (index.js).
 *   MqttTransport   – serverless. Matchmaking, chat relay and WebRTC signalling run over a
 *                     public MQTT broker, so the site works on GitHub Pages / any static host.
 *
 * Events emitted TO the app: connect, disconnect, online-count, waiting-for-partner,
 * partner-found, partner-disconnected, message-received, message-delivered, exchange-key,
 * partner-typing, offer, answer, ice-candidate, video-call-request, video-call-response,
 * media-ready, call-ended, report-received, consent-required, error-message, rate-limited.
 * Events the app emits: see MqttTransport.emit.
 */
(function () {
  'use strict';

  const MODES = ['text', 'video'];
  const Rules = window.MatchRules;
  const MAX_MESSAGE_CHARS = 150000; // encrypted envelopes (text, or a compressed image)
  const MAX_PAYLOAD_CHARS = 220000;
  const RELAYED = new Set([
    'message-received', 'exchange-key', 'partner-typing', 'offer', 'answer', 'ice-candidate',
    'video-call-request', 'video-call-response', 'media-ready', 'call-ended'
  ]);

  const randomHex = (bytes) =>
    Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

  class Emitter {
    constructor() { this.handlers = {}; }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
    fire(ev, data) {
      (this.handlers[ev] || []).slice().forEach((fn) => {
        try { fn(data); } catch (err) { console.error(`handler for ${ev} failed`, err); }
      });
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  /* ---------------------------------------------------------------- Socket.IO */
  class SocketTransport extends Emitter {
    constructor(socket) {
      super();
      this.socket = socket;
      this.kind = 'socket';
      this.broadcasts = [
        'connect', 'disconnect', 'online-count', 'waiting-for-partner', 'partner-found',
        'partner-disconnected', 'message-received', 'message-delivered', 'exchange-key',
        'partner-typing', 'offer', 'answer', 'ice-candidate', 'video-call-request',
        'video-call-response', 'media-ready', 'call-ended', 'report-received',
        'consent-required', 'error-message', 'rate-limited', 'server-shutdown'
      ];
      this.broadcasts.forEach((ev) => socket.on(ev, (d) => this.fire(ev, d)));
      if (socket.connected) queueMicrotask(() => this.fire('connect'));
    }
    get id() { return this.socket.id; }
    get connected() { return this.socket.connected; }
    emit(ev, data) { this.socket.emit(ev, data); }
    static async create() {
      await loadScript('socket.io/socket.io.js');
      return new SocketTransport(window.io({ transports: ['websocket', 'polling'] }));
    }
  }

  /* --------------------------------------------------------------------- MQTT */
  class MqttTransport extends Emitter {
    constructor(cfg) {
      super();
      this.kind = 'mqtt';
      this.cfg = cfg;
      this.ns = String(cfg.namespace || 'securechat/v1').replace(/[^a-zA-Z0-9/_-]/g, '');
      this.id = randomHex(8);
      this.state = 'idle'; // idle | waiting | proposing | chatting
      this.mode = null;
      this.partner = null;
      this.room = null;
      this.lastPartner = null;
      this.lastPartnerAt = 0;
      this.prefs = { mode: null, room: '', interests: [], lang: 'any', since: 0 };
      this.avoid = new Set();
      this.cooldown = Number.isFinite(cfg.rematchCooldownMs) ? cfg.rematchCooldownMs : 30000;
      this.pendingProposal = null;
      this.seen = new Map(); // presence: id -> last seen ms
      this.mids = new Map(); // de-duplication: message id -> time
      this.subs = new Set();
      this.pending = new Map(); // reliable messages waiting for an ack
      this.lastProposal = null; // { to, room } so a retry of the same proposal reuses its room
      this.partnerSeen = 0;
      this.inBudget = { start: 0, n: 0 };
      this.timers = {};
      // Every broker is used at the same time. Peers on different brokers still find each other
      // because each message is published to all of them and de-duplicated on receipt.
      this.links = cfg.brokers.map((url) => ({ url, client: null, up: false, delay: 1000 }));
      this.links.forEach((l) => this._connectLink(l));
      this.subs.add(this.topic('u', this.id)).add(this.topic('presence'));
      window.addEventListener('pagehide', () => this._shutdown());
    }

    get connected() { return this.links.some((l) => l.up); }

    topic(kind, key) { return `${this.ns}/${kind}${key ? `/${key}` : ''}`; }

    /* -- connection management -- */
    _connectLink(link) {
      const client = window.mqtt.connect(link.url, {
        clientId: `sc_${this.id}_${randomHex(2)}`, clean: true, keepalive: 30,
        connectTimeout: 10000, reconnectPeriod: 0, resubscribe: false,
        // If this browser vanishes without saying goodbye, the broker announces it on our "gone" topic.
        will: { topic: this.topic('gone', this.id), payload: JSON.stringify({ n: 'gone', from: this.id, mid: `will${randomHex(5)}` }), qos: 1, retain: false }
      });
      link.client = client;
      client.on('connect', () => {
        const wasConnected = this.connected;
        link.up = true;
        link.delay = 1000;
        client.subscribe(Array.from(this.subs), { qos: 0 });
        if (!wasConnected) {
          this.fire('connect');
          this._heartbeat();
          clearInterval(this.timers.hb);
          this.timers.hb = setInterval(() => this._heartbeat(), 8000);
        }
      });
      client.on('message', (topic, payload) => this._onMessage(topic, payload));
      client.on('error', () => {});
      client.on('close', () => {
        const was = link.up;
        link.up = false;
        client.removeAllListeners();
        try { client.end(true); } catch { /* already closed */ }
        if (was && !this.connected) {
          clearInterval(this.timers.hb);
          this.fire('disconnect');
          this._endChat(true);
        }
        link.delay = Math.min(link.delay * 1.6, 10000);
        setTimeout(() => this._connectLink(link), link.delay);
      });
    }

    _sub(topic) {
      if (this.subs.has(topic)) return;
      this.subs.add(topic);
      this.links.forEach((l) => l.up && l.client.subscribe(topic, { qos: 0 }));
    }
    _unsub(topic) {
      if (!this.subs.delete(topic)) return;
      this.links.forEach((l) => l.up && l.client.unsubscribe(topic));
    }

    /** Sent twice because one copy can be lost on a flaky broker link. */
    _bye() {
      const to = this.partner; const room = this.room;
      this._publish(to, 'bye');
      setTimeout(() => { if (this.connected) this._send(this.topic('u', to), { n: 'bye', room }, 1); }, 400);
    }

    _shutdown() {
      if (this.partner) { this._publish(this.partner, 'bye'); this._publish(this.partner, 'bye'); }
      this.links.forEach((l) => { try { l.client.end(false); } catch { /* ignore */ } }); // graceful: lets the 'bye' flush first
    }

    _send(topic, obj, qos) {
      const msg = JSON.stringify({ ...obj, from: this.id, mid: randomHex(6) });
      this.links.forEach((l) => l.up && l.client.publish(topic, msg, { qos }));
    }

    /** Publishes to a peer's inbox. Reliable messages are acknowledged and re-sent a few times. */
    _publish(toId, n, d, reliable = false) {
      if (!this.connected) return;
      const topic = this.topic('u', toId);
      const mid = randomHex(6);
      const msg = JSON.stringify({ n, d, room: this.room, from: this.id, mid, rel: reliable || undefined });
      const qos = n === 'ping' ? 0 : 1;
      const sendNow = () => this.links.forEach((l) => l.up && l.client.publish(topic, msg, { qos }));
      sendNow();
      if (!reliable) return;
      const entry = { n, id: d && d.id, tries: 0, timer: null };
      const delays = [1500, 2500, 4000, 6000];
      const tick = () => {
        if (!this.pending.has(mid)) return;
        if (entry.tries >= delays.length) {
          this.pending.delete(mid);
          if (n === 'message-received') this.fire('message-failed', { id: entry.id });
          return;
        }
        sendNow();
        entry.timer = setTimeout(tick, delays[entry.tries++]);
      };
      entry.timer = setTimeout(tick, 1200);
      this.pending.set(mid, entry);
    }

    _clearPending() {
      for (const e of this.pending.values()) clearTimeout(e.timer);
      this.pending.clear();
    }

    _heartbeat() {
      if (!this.connected) return;
      this._send(this.topic('presence'), {}, 0);
      const now = Date.now();
      for (const [id, t] of this.seen) if (now - t > 30000) this.seen.delete(id);
      for (const [mid, t] of this.mids) if (now - t > 60000) this.mids.delete(mid);
      this.fire('online-count', this.seen.size + 1);
    }

    /* -- inbound -- */
    _onMessage(topic, payload) {
      if (payload.length > MAX_PAYLOAD_CHARS) return;
      let m;
      try { m = JSON.parse(payload.toString()); } catch { return; }
      if (!m || typeof m !== 'object' || typeof m.from !== 'string' || m.from === this.id) return;
      if (typeof m.mid !== 'string') return;
      if (m.rel && this.state === 'chatting' && m.from === this.partner && m.room === this.room && topic === this.topic('u', this.id)) {
        this._send(this.topic('u', m.from), { n: 'ack', d: { mid: m.mid }, room: this.room }, 0); // ack duplicates too: our earlier ack may have been lost
      }
      if (this.mids.has(m.mid)) return; // already received via another broker or a retry
      this.mids.set(m.mid, Date.now());

      if (topic === this.topic('presence')) {
        const isNew = !this.seen.has(m.from);
        this.seen.set(m.from, Date.now());
        if (isNew) this.fire('online-count', this.seen.size + 1);
        return;
      }
      if (topic.startsWith(this.topic('gone'))) return this._onGone(m);
      if (topic.startsWith(this.topic('lobby'))) return this._onHello(m);
      if (topic === this.topic('u', this.id)) return this._onInbox(m);
    }

    /**
     * The broker says our partner's connection dropped. One flaky broker link also triggers this while the
     * partner is fine on the other link, so confirm with a short wait before ending the chat.
     */
    _onGone(m) {
      if (this.state !== 'chatting' || m.from !== this.partner || this.goneTimer) return;
      const asked = Date.now();
      this.goneTimer = setTimeout(() => {
        this.goneTimer = null;
        if (this.state === 'chatting' && this.partnerSeen < asked) this._endChat(true);
      }, 6500);
    }

    _recent(id) { return !this.prefs.room && this.lastPartner === id && Date.now() - this.lastPartnerAt < this.cooldown; }

    get lobbyKey() { return this.prefs.room ? `${this.mode}.${this.prefs.room}` : this.mode; }

    _onHello(m) {
      const d = m.d && typeof m.d === 'object' ? m.d : null;
      if (this.state !== 'waiting' || m.n !== 'hello' || !d || d.mode !== this.mode) return;
      if (this._recent(m.from) || this.avoid.has(m.from)) return;
      const mine = { ...this.prefs, waited: Date.now() - this.prefs.since };
      const theirs = { mode: d.mode, room: this.prefs.room, interests: Rules.normInterests(d.interests), lang: Rules.normLang(d.lang), waited: Number(d.w) || 0 };
      if (!Rules.compatible(mine, theirs)) return; // soft preferences relax with waiting time
      // Only the larger id proposes, so two seekers never propose to each other at once.
      if (this.id <= m.from) return;
      this.state = 'proposing';
      const room = this.lastProposal && this.lastProposal.to === m.from ? this.lastProposal.room : randomHex(16);
      this.lastProposal = { to: m.from, room };
      this.pendingProposal = { to: m.from, room };
      this.room = null;
      this._publish(m.from, 'propose', { mode: this.mode, room: this.pendingProposal.room });
      clearTimeout(this.timers.proposal);
      this.timers.proposal = setTimeout(() => {
        if (this.state === 'proposing') { this.state = 'waiting'; this.pendingProposal = null; }
      }, 3000);
    }

    _onInbox(m) {
      // Rate limit what a stranger can push at us.
      const now = Date.now();
      if (now - this.inBudget.start > 2000) this.inBudget = { start: now, n: 0 };
      if (++this.inBudget.n > 150) return;

      if (m.n === 'propose') {
        // Our accept may have been lost: confirm again instead of rejecting.
        if (this.state === 'chatting' && m.from === this.partner && m.d && m.d.room === this.room) return this._publish(m.from, 'accept', { room: this.room });
        const ok = this.state === 'waiting' && m.d && m.d.mode === this.mode &&
          typeof m.d.room === 'string' && m.d.room.length === 32 && !this._recent(m.from) && !this.avoid.has(m.from);
        if (!ok) return this._publish(m.from, 'reject');
        this._publish(m.from, 'accept', { room: m.d.room });
        return this._pair(m.from, m.d.room);
      }
      if (m.n === 'accept') {
        const p = this.lastProposal;
        if ((this.state === 'proposing' || this.state === 'waiting') && p && p.to === m.from && m.d && m.d.room === p.room) this._pair(m.from, p.room);
        return;
      }
      if (m.n === 'reject') {
        if (this.state === 'proposing' && this.pendingProposal && this.pendingProposal.to === m.from) {
          this.state = 'waiting';
          this.pendingProposal = null;
        }
        return;
      }
      // Everything below is only valid from the current partner inside the current room.
      if (this.state !== 'chatting' || m.from !== this.partner || m.room !== this.room) return;
      this.partnerSeen = Date.now();
      if (m.n === 'ping') return;
      if (m.n === 'ack') {
        const mid = m.d && m.d.mid;
        const e = this.pending.get(mid);
        if (e) {
          clearTimeout(e.timer);
          this.pending.delete(mid);
          if (e.n === 'message-received') this.fire('message-delivered', { id: e.id });
        }
        return;
      }
      if (m.n === 'bye') return this._endChat(true);
      if (!RELAYED.has(m.n)) return;
      this.fire(m.n, this._sanitize(m.n, m.d, m.from));
    }

    _sanitize(n, d, from) {
      d = d && typeof d === 'object' ? d : {};
      switch (n) {
        case 'message-received':
          return {
            message: typeof d.message === 'string' ? d.message.slice(0, MAX_MESSAGE_CHARS) : '',
            senderId: from, timestamp: Date.now(), id: typeof d.id === 'string' ? d.id.slice(0, 64) : undefined
          };
        case 'partner-typing': return { typing: d.typing === true };
        case 'video-call-response': return { accepted: d.accepted === true, senderId: from };
        default: return { ...d, senderId: from };
      }
    }

    /* -- matchmaking -- */
    _pair(partnerId, room) {
      this._leaveLobby();
      this.partner = partnerId;
      this.room = room;
      this.lastPartner = partnerId;
      this.lastPartnerAt = Date.now();
      this.state = 'chatting';
      this.pendingProposal = null;
      this.partnerSeen = Date.now();
      this._sub(this.topic('gone', partnerId));
      clearInterval(this.timers.ping);
      this.timers.ping = setInterval(() => {
        if (this.state !== 'chatting') return;
        this._publish(this.partner, 'ping');
        if (Date.now() - this.partnerSeen > 75000) this._endChat(true); // hidden tabs can throttle timers, so be patient; 'bye' covers normal exits
      }, 4000);
      this.fire('partner-found', { partnerId, roomId: room, chatMode: this.mode });
    }

    _leaveLobby() {
      clearInterval(this.timers.hello);
      clearTimeout(this.timers.proposal);
      if (this.mode) this._unsub(this.topic('lobby', this.lobbyKey));
    }

    _endChat(notifyApp) {
      const had = this.state === 'chatting';
      if (had && this.partner) this._unsub(this.topic('gone', this.partner));
      clearTimeout(this.goneTimer); this.goneTimer = null;
      clearInterval(this.timers.ping);
      this._clearPending();
      if (had) {
        this.lastProposal = null;
        this.partner = null;
        this.room = null;
        this.state = 'idle';
        if (notifyApp) this.fire('partner-disconnected');
      }
    }

    /* -- the app's outbound events (mirrors the Node server) -- */
    emit(ev, data) {
      switch (ev) {
        case 'find-partner': return this._find(data || {});
        case 'leave-queue':
          if (this.state === 'waiting' || this.state === 'proposing') { this._leaveLobby(); this.state = 'idle'; this.pendingProposal = null; }
          return;
        case 'skip-partner':
          if (this.partner) this._bye();
          this._endChat(false);
          if (this.state === 'waiting' || this.state === 'proposing') { this._leaveLobby(); this.state = 'idle'; }
          return;
        case 'send-message': {
          if (this.state !== 'chatting' || !data || typeof data.message !== 'string') return;
          const message = data.message.trim().slice(0, MAX_MESSAGE_CHARS);
          if (!message) return;
          const id = typeof data.id === 'string' ? data.id.slice(0, 64) : undefined;
          this._publish(this.partner, 'message-received', { message, id }, true); // 'message-delivered' fires on the partner's ack
          return;
        }
        case 'typing-start': return this._relay('partner-typing', { typing: true });
        case 'typing-stop': return this._relay('partner-typing', { typing: false });
        case 'exchange-key': return data && typeof data.key === 'object' && this._relay('exchange-key', { key: data.key });
        case 'offer': return data && data.offer && this._relay('offer', { offer: data.offer });
        case 'answer': return data && data.answer && this._relay('answer', { answer: data.answer });
        case 'ice-candidate': return data && data.candidate && this._relay('ice-candidate', { candidate: data.candidate });
        case 'video-call-request': return this._relay('video-call-request', {});
        case 'video-call-response': return this._relay('video-call-response', { accepted: !!(data && data.accepted) });
        case 'media-ready': return this._relay('media-ready', {});
        case 'call-ended': return this._relay('call-ended', {});
        case 'report-user':
          // There is no server to receive reports in serverless mode; acknowledge so the UI can move on.
          if (this.state === 'chatting') this.fire('report-received');
          return;
        default:
      }
    }

    _relay(n, d) { if (this.state === 'chatting') this._publish(this.partner, n, d, n !== 'partner-typing'); }

    _find(info) {
      if (info.consent !== true) return this.fire('consent-required');
      if (!MODES.includes(info.chatMode)) return this.fire('error-message', { message: 'Unknown chat mode.' });
      if (this.partner) { this._bye(); this._endChat(false); }
      this._leaveLobby();
      this.mode = info.chatMode;
      this.prefs = { mode: info.chatMode, room: Rules.normRoom(info.room), interests: Rules.normInterests(info.interests), lang: Rules.normLang(info.lang), since: Date.now() };
      this.avoid = new Set(Rules.normAvoid(info.avoid));
      this.state = 'waiting';
      this.pendingProposal = null;
      this._sub(this.topic('lobby', this.lobbyKey));
      const hello = () => {
        if (this.state === 'idle' || this.state === 'chatting' || !this.connected) return;
        this._send(this.topic('lobby', this.lobbyKey), { n: 'hello', d: { mode: this.mode, interests: this.prefs.interests, lang: this.prefs.lang, w: Date.now() - this.prefs.since } }, 0);
      };
      hello();
      this.timers.hello = setInterval(hello, 1500);
      this.fire('waiting-for-partner');
    }

    static async create(cfg) {
      await loadScript('vendor/mqtt.min.js');
      return new MqttTransport(cfg);
    }
  }

  async function createTransport(cfg) {
    let kind = cfg.transport || 'auto';
    if (kind === 'auto' && /\.github\.io$/.test(location.hostname)) kind = 'mqtt'; // GitHub Pages is static, no server to probe
    if (kind === 'auto') {
      try {
        const r = await fetch('health', { cache: 'no-store' });
        kind = r.ok && (await r.text()).trim() === 'OK' ? 'socket' : 'mqtt';
      } catch { kind = 'mqtt'; }
    }
    const transport = kind === 'socket' ? await SocketTransport.create() : await MqttTransport.create(cfg);
    return transport;
  }

  window.SecureTransport = { createTransport, MqttTransport, SocketTransport };
})();
