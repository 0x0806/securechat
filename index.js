'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');

const MODES = new Set(['text', 'video']);
const MAX_MESSAGE_CHARS = 4000; // ciphertext is larger than the 500-char plaintext limit
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
          imgSrc: ["'self'", 'data:'],
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
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (req, res) => res.status(200).send('OK'));
  app.get('/api/ice-servers', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ iceServers });
  });
  app.use((req, res) => res.status(404).send('404 Not Found'));

  const io = new Server(server, {
    cors: { origin: allowedOrigin, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 64 * 1024,
  });

  /** socket.id -> { chatMode } for sockets waiting for a partner (insertion order = FIFO) */
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

      let partnerId = null;
      for (const [id, entry] of waiting) {
        if (!isLive(id)) {
          waiting.delete(id);
          continue;
        }
        if (entry.chatMode !== info.chatMode) continue;
        if (recentlyPaired(socket.id, id)) continue;
        partnerId = id;
        break;
      }

      if (!partnerId) {
        waiting.set(socket.id, { chatMode: info.chatMode });
        socket.emit('waiting-for-partner');
        return;
      }

      waiting.delete(partnerId);
      const roomId = crypto.randomUUID();
      const partnerSocket = io.sockets.sockets.get(partnerId);
      socket.join(roomId);
      partnerSocket.join(roomId);
      const startedAt = Date.now();
      chats.set(socket.id, { partnerId, roomId, startedAt });
      chats.set(partnerId, { partnerId: socket.id, roomId, startedAt });
      lastPartner.set(socket.id, { id: partnerId, at: startedAt });
      lastPartner.set(partnerId, { id: socket.id, at: startedAt });
      socket.emit('partner-found', { partnerId, roomId, chatMode: info.chatMode });
      partnerSocket.emit('partner-found', { partnerId: socket.id, roomId, chatMode: info.chatMode });
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

    socket.on('report-user', (data) => {
      const chat = partnerOf();
      if (!chat) return;
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

  return { app, server, io, state: { waiting, chats }, close: () => clearInterval(stats) };
}

function start(port = process.env.PORT || 5000) {
  const ctx = createApp();
  ctx.server.listen(port, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] SecureChat listening on port ${ctx.server.address().port}`);
  });
  const shutdown = () => {
    ctx.io.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return ctx;
}

if (require.main === module) start();

module.exports = { createApp, buildIceServers, start };
