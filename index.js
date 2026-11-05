'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');
const Rules = require('./public/match-rules');

const MODES = new Set(['text', 'video']);
const MAX_MESSAGE_CHARS = 150000; // encrypted envelopes: text, or a compressed image up to ~60 KB
const MAX_SIGNAL_BYTES = 20000;
const RATE_LIMIT = { events: 80, perMs: 2000 };
const REPORT_REASONS = new Set(['abuse', 'nudity', 'spam', 'underage', 'other']);

/** Builds ICE server list from env so deployments can add TURN for strict NATs. */
function buildIceServers(env = process.env) {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (env.STUN_URLS) {
    servers.length = 0;
    servers.push({ urls: env.STUN_URLS.split(',').map((s) => s.trim()).filter(Boolean) });
  }
  if (env.TURN_URL) {
    servers.push({
      urls: env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: env.TURN_USERNAME || '',
      credential: env.TURN_CREDENTIAL || '',
    });
  }
  return servers;
}

function createApp(options = {}) {
  const log = options.log || ((...a) => console.log(`[${new Date().toISOString()}]`, ...a));
  const allowedOrigin = options.corsOrigin || process.env.CORS_ORIGIN || '*';
  const iceServers = options.iceServers || buildIceServers();
  const rematchCooldownMs = options.rematchCooldownMs ?? 30000;
  const softWaitMs = options.softWaitMs ?? Rules.SOFT_WAIT_MS;
  const sweepMs = options.sweepMs ?? 2000;
  const maxPerIp = options.maxConnectionsPerIp ?? 100;

  const app = express();
  const server = http.createServer(app);

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(compression());
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          fontSrc: ["'self'"],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          workerSrc: ["'self'", 'blob:'],
          frameAncestors: ["'none'"],
          // helmet's default adds upgrade-insecure-requests, which breaks plain-http localhost use
          upgradeInsecureRequests: null,
        },
      },
      permissionsPolicy: undefined,
    })
  );
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    next();
  });
  app.use(cors({ origin: allowedOrigin }));
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, file) {
      // Fonts never change under the same name; everything else revalidates so deploys show up at once.
      if (/\.woff2$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
      if (/sw\.js$/.test(file)) res.setHeader('Service-Worker-Allowed', '/');
    },
  }));

  app.get('/health', (req, res) => res.status(200).send('OK'));
  app.get('/api/ice-servers', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ iceServers });
  });
  app.get('/api/stats', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const byMode = { text: 0, video: 0 };
    for (const w of waiting.values()) byMode[w.chatMode] += 1;
    res.json({ online: io.engine.clientsCount, waiting: byMode, chats: chats.size / 2 });
  });
  app.use((req, res) => res.status(404).send('404 Not Found'));

  const io = new Server(server, {
    cors: { origin: allowedOrigin, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 256 * 1024,
    pingInterval: 25000,
    pingTimeout: 45000, // background tabs throttle timers; be patient before calling someone gone
  });

  // Basic abuse protection: cap simultaneous connections per address.
  const perIp = new Map();
  const addressOf = (socket) => {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || socket.handshake.address;
  };
  io.use((socket, next) => {
    const ip = addressOf(socket);
    if ((perIp.get(ip) || 0) >= maxPerIp) return next(new Error('too-many-connections'));
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    socket.once('disconnect', () => {
      const n = (perIp.get(ip) || 1) - 1;
      if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
    });
    next();
  });

  /** socket.id -> { chatMode, interests, lang, room, since, avoid } for sockets waiting (insertion order = FIFO) */
  const waiting = new Map();
  /** socket.id -> { partnerId, roomId, startedAt } */
  const chats = new Map();
  /** socket.id -> { id, at } of the last partner, so a skip does not immediately rematch the same two people */
  const lastPartner = new Map();
  const rate = new Map();
  const lastMessage = new Map(); // socket.id -> { text, at }

  const recentlyPaired = (a, b) => {
    const now = Date.now();
    return [[a, b], [b, a]].some(([x, y]) => {
      const last = lastPartner.get(x);
      return last && last.id === y && now - last.at < rematchCooldownMs;
    });
  };

  const broadcastOnline = () => io.emit('online-count', io.engine.clientsCount);

  const isLive = (id) => {
    const s = io.sockets.sockets.get(id);
    return Boolean(s && s.connected);
  };

  /** Ends the chat (if any) for socketId, tells the partner, and leaves the room. */
  function endChat(socketId, { notifyPartner = true } = {}) {
    const chat = chats.get(socketId);
    if (!chat) return null;
    chats.delete(socketId);
    chats.delete(chat.partnerId);
    for (const id of [socketId, chat.partnerId]) {
      io.sockets.sockets.get(id)?.leave(chat.roomId);
    }
    if (notifyPartner && isLive(chat.partnerId)) {
      io.to(chat.partnerId).emit('partner-disconnected');
    }
    log(`chat ended after ${Math.round((Date.now() - chat.startedAt) / 1000)}s`);
    return chat;
  }

  /** Best compatible waiting partner for `id`, or null. Preferences relax after softWaitMs. */
  function pickPartner(id, entry) {
    const now = Date.now();
    let best = null;
    let bestScore = -1;
    for (const [pid, other] of waiting) {
      if (pid === id) continue;
      if (!isLive(pid)) { waiting.delete(pid); continue; }
      if (entry.avoid.has(pid) || other.avoid.has(id)) continue; // blocked people are never matched
      if (!entry.room && recentlyPaired(id, pid)) continue;
      const a = { ...entry, mode: entry.chatMode, waited: now - entry.since };
      const b = { ...other, mode: other.chatMode, waited: now - other.since };
      if (!Rules.compatible(a, b, softWaitMs)) continue;
      const sc = Rules.score(a, b);
      if (sc > bestScore) { best = pid; bestScore = sc; }
    }
    return best;
  }

  function pair(idA, idB, chatMode) {
    const roomId = crypto.randomUUID();
    const sa = io.sockets.sockets.get(idA);
    const sb = io.sockets.sockets.get(idB);
    sa.join(roomId);
    sb.join(roomId);
    const startedAt = Date.now();
    chats.set(idA, { partnerId: idB, roomId, startedAt });
    chats.set(idB, { partnerId: idA, roomId, startedAt });
    lastPartner.set(idA, { id: idB, at: startedAt });
    lastPartner.set(idB, { id: idA, at: startedAt });
    sa.emit('partner-found', { partnerId: idB, roomId, chatMode });
    sb.emit('partner-found', { partnerId: idA, roomId, chatMode });
  }

  /** Periodic re-check so waiting people whose preferences have relaxed still get paired. */
  const sweep = setInterval(() => {
    for (const [id, entry] of Array.from(waiting)) {
      if (!waiting.has(id)) continue;
      if (!isLive(id)) { waiting.delete(id); continue; }
      waiting.delete(id);
      const partnerId = pickPartner(id, entry);
      if (partnerId) { waiting.delete(partnerId); pair(id, partnerId, entry.chatMode); }
      else waiting.set(id, entry);
    }
  }, sweepMs);
  sweep.unref();

  io.on('connection', (socket) => {
    broadcastOnline();
    socket.emit('online-count', io.engine.clientsCount);

    // Per-socket flood control. Generous enough for ICE candidate bursts.
    socket.use((packet, next) => {
      const now = Date.now();
      let bucket = rate.get(socket.id);
      if (!bucket || now - bucket.start > RATE_LIMIT.perMs) {
        bucket = { start: now, count: 0 };
        rate.set(socket.id, bucket);
      }
      bucket.count += 1;
      if (bucket.count > RATE_LIMIT.events) {
        socket.emit('rate-limited', { message: 'You are sending too fast. Slow down.' });
        return; // drop the packet
      }
      next();
    });

    const partnerOf = () => chats.get(socket.id);
    const relay = (event, build) => (payload) => {
      const chat = partnerOf();
      if (!chat) return;
      const out = build(payload || {});
      if (out === null) return;
      io.to(chat.partnerId).emit(event, { ...out, senderId: socket.id });
    };
    const sizeOk = (v) => {
      try {
        return JSON.stringify(v).length <= MAX_SIGNAL_BYTES;
      } catch {
        return false;
      }
    };

    socket.on('find-partner', (data) => {
      const info = data && typeof data === 'object' ? data : {};
      if (info.consent !== true) {
        socket.emit('consent-required');
        return;
      }
      if (!MODES.has(info.chatMode)) {
        socket.emit('error-message', { message: 'Unknown chat mode.' });
        return;
      }

      endChat(socket.id); // a user searching again leaves any existing chat
      waiting.delete(socket.id);

      const entry = {
        chatMode: info.chatMode,
        interests: Rules.normInterests(info.interests),
        lang: Rules.normLang(info.lang),
        room: Rules.normRoom(info.room),
        avoid: new Set(Rules.normAvoid(info.avoid)),
        since: Date.now(),
      };
      const partnerId = pickPartner(socket.id, entry);
      if (!partnerId) {
        waiting.set(socket.id, entry);
        socket.emit('waiting-for-partner');
        return;
      }
      waiting.delete(partnerId);
      pair(socket.id, partnerId, entry.chatMode);
    });

    socket.on('leave-queue', () => {
      waiting.delete(socket.id);
    });

    socket.on('send-message', (data) => {
      const chat = partnerOf();
      if (!chat || !data || typeof data.message !== 'string') return;
      const text = data.message.trim().slice(0, MAX_MESSAGE_CHARS);
      if (!text) return;
      const prev = lastMessage.get(socket.id);
      const now = Date.now();
      if (prev && prev.text === text && now - prev.at < 3000) return; // drop accidental double-sends
      lastMessage.set(socket.id, { text, at: now });
      const id = typeof data.id === 'string' ? data.id.slice(0, 64) : undefined;
      // Only the partner receives the message; the sender gets an ack for delivery state.
      io.to(chat.partnerId).emit('message-received', { message: text, senderId: socket.id, timestamp: now, id });
      socket.emit('message-delivered', { id });
    });

    socket.on('exchange-key', (data) => {
      const chat = partnerOf();
      if (!chat || !data || typeof data.key !== 'object' || data.key === null || !sizeOk(data.key)) return;
      io.to(chat.partnerId).emit('exchange-key', { key: data.key, senderId: socket.id });
    });

    socket.on('typing-start', relay('partner-typing', () => ({ typing: true })));
    socket.on('typing-stop', relay('partner-typing', () => ({ typing: false })));

    socket.on('offer', relay('offer', (d) => (d.offer && sizeOk(d.offer) ? { offer: d.offer } : null)));
    socket.on('answer', relay('answer', (d) => (d.answer && sizeOk(d.answer) ? { answer: d.answer } : null)));
    socket.on(
      'ice-candidate',
      relay('ice-candidate', (d) => (d.candidate && sizeOk(d.candidate) ? { candidate: d.candidate } : null))
    );
    socket.on('video-call-request', relay('video-call-request', () => ({})));
    socket.on('video-call-response', relay('video-call-response', (d) => ({ accepted: d.accepted === true })));
    socket.on('media-ready', relay('media-ready', () => ({})));
    socket.on('call-ended', relay('call-ended', () => ({})));

    let reports = [];
    socket.on('report-user', (data) => {
      const chat = partnerOf();
      if (!chat) return;
      const now = Date.now();
      reports = reports.filter((t) => now - t < 60000);
      if (reports.length >= 5) {
        socket.emit('error-message', { message: 'Too many reports. Please wait a minute.' });
        return;
      }
      reports.push(now);
      const reason = REPORT_REASONS.has(data && data.reason) ? data.reason : 'other';
      // Reports are logged by session-scoped socket id only; nothing else is stored.
      log(`report: ${socket.id} reported ${chat.partnerId} (${reason})`);
      socket.emit('report-received');
    });

    socket.on('skip-partner', () => {
      endChat(socket.id);
      waiting.delete(socket.id);
    });

    socket.on('disconnect', () => {
      endChat(socket.id);
      waiting.delete(socket.id);
      rate.delete(socket.id);
      lastMessage.delete(socket.id);
      lastPartner.delete(socket.id);
      broadcastOnline();
    });
  });

  const stats = setInterval(() => {
    log(`stats: ${chats.size / 2} chats, ${waiting.size} waiting, ${io.engine.clientsCount} connected`);
  }, 60000);
  stats.unref();

  return { app, server, io, state: { waiting, chats }, close: () => { clearInterval(stats); clearInterval(sweep); } };
}

function start(port = process.env.PORT || 5000) {
  const ctx = createApp();
  ctx.server.listen(port, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] SecureChat listening on port ${ctx.server.address().port}`);
  });
  const shutdown = () => {
    ctx.io.emit('server-shutdown');
    setTimeout(() => ctx.io.close(() => process.exit(0)), 300);
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return ctx;
}

if (require.main === module) start();

module.exports = { createApp, buildIceServers, start };
