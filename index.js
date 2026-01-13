
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Security: Add basic security headers
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Security: Add a Content Security Policy (CSP) to mitigate XSS and data injection attacks.
  // This policy restricts where content (like scripts, styles, fonts) can be loaded from.
  // It's a critical security layer. For production, you might need to add specific domains for CDNs.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " + // By default, only allow content from our own origin.
    "script-src 'self'; " + // Allow scripts from our origin.
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " + // Allow stylesheets from our origin and inline styles.
    "font-src 'self' https://cdnjs.cloudflare.com; " + // Allow fonts from our origin and Font Awesome's CDN.
    "connect-src 'self' wss:; " + // Allow WebSocket, fetch to our origin and Font Awesome.
    "img-src 'self' data:; " + // Allow images from our origin and data: URIs.
    "media-src 'self' blob:;" // Allow media (video/audio) from our origin and blob URIs (for WebRTC).
  );
  next();
});

// For production, restrict the origin to your frontend's domain
const allowedOrigin = process.env.CORS_ORIGIN || "*";
const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ["GET", "POST"]
  }
});

app.use(cors({ origin: allowedOrigin }));
app.use(express.static('public'));

// Store connected users and waiting queue
const waitingUsers = new Map(); // Use Map for O(1) access and FIFO order
const activeChats = new Map();
const userSockets = new Map();
const rateLimit = new Map();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);  

  // Security: Basic rate limiting to prevent spam
  socket.use(([event, ...args], next) => {
    const now = Date.now();
    const limit = 10; // 10 events
    const per = 2000; // per 2 seconds

    let userData = rateLimit.get(socket.id);
    if (!userData) {
        userData = { count: 0, lastEvent: now };
        rateLimit.set(socket.id, userData);
    }

    if (now - userData.lastEvent > per) {
        userData.count = 1;
        userData.lastEvent = now;
    } else {
        userData.count++;
    }

    if (userData.count > limit) {
        console.warn(`Rate limit exceeded for socket ${socket.id} on event ${event}`);
        return next(new Error('Rate limit exceeded. Please slow down.'));
    }

    next();
  });
  
  socket.on('find-partner', (userData) => {
    console.log('User looking for partner:', socket.id);
    
    // Fix: Remove user from waiting queue if they are already there to prevent self-matching
    waitingUsers.delete(socket.id);

    // NOTE: For a large-scale application, this in-memory user management
    // would be replaced with a distributed store like Redis to allow for
    // multiple server instances.
    userSockets.set(socket.id, { ...userData, socketId: socket.id });
    
    // Improved matching logic: Find a valid partner, prioritizing same chat mode
    let partnerId = null;
    let partnerData = null;

    // Helper to validate socket
    const isSocketValid = (sid) => {
        const s = io.sockets.sockets.get(sid);
        return s && s.connected;
    };

    // 1. Try to find match with same mode
    for (const [pid, pdata] of waitingUsers) {
        if (isSocketValid(pid)) {
            if (pdata.chatMode === userData.chatMode) {
                partnerId = pid;
                partnerData = pdata;
                break;
            }
        } else {
            waitingUsers.delete(pid); // Clean up stale
        }
    }

    // 2. Fallback: any partner
    if (!partnerId) {
        for (const [pid, pdata] of waitingUsers) {
            if (isSocketValid(pid)) {
                partnerId = pid;
                partnerData = pdata;
                break;
            } else {
                waitingUsers.delete(pid);
            }
        }
    }

    if (partnerId) {
      // Match with waiting user
      waitingUsers.delete(partnerId);
      const partner = partnerData;

      const roomId = `room_${socket.id}_${partner.socketId}`;
      
      // Join both users to room
      socket.join(roomId);
      const partnerSocket = io.sockets.sockets.get(partner.socketId);
      if (partnerSocket) partnerSocket.join(roomId);
      
      // Store active chat
      activeChats.set(socket.id, { partnerId: partner.socketId, roomId });
      activeChats.set(partner.socketId, { partnerId: socket.id, roomId });
      
      // Notify both users
      socket.emit('partner-found', { partnerId: partner.socketId, roomId, partnerChatMode: partner.chatMode });
      io.to(partner.socketId).emit('partner-found', { partnerId: socket.id, roomId, partnerChatMode: userSockets.get(socket.id).chatMode });
      
    } else {
      // Add to waiting queue
      waitingUsers.set(socket.id, userSockets.get(socket.id));
      socket.emit('waiting-for-partner');
    }
  });

  // Fix: Handle user cancelling the search
  socket.on('leave-queue', () => {
    waitingUsers.delete(socket.id);
  });
  
  socket.on('send-message', (data) => {
    const chat = activeChats.get(socket.id);
    
    // Security: Validate message content and length on server side
    if (chat && data.message && typeof data.message === 'string') {
      // Enforce max length (increased to 2000 to allow for encrypted payload overhead)
      const messageContent = data.message.trim().substring(0, 2000);
      
      if (messageContent.length > 0) {
      io.to(chat.roomId).emit('message-received', {
          message: messageContent,
        senderId: socket.id,
        timestamp: Date.now(),
        id: data.id // Pass back message ID for delivery confirmation
      });
      }
    }
  });

  socket.on('exchange-key', (data) => {
    const chat = activeChats.get(socket.id);
    if (chat) {
      io.to(chat.partnerId).emit('exchange-key', {
        key: data.key,
        senderId: socket.id
      });
    }
  });
  
  socket.on('typing-start', () => {
    const chat = activeChats.get(socket.id);
    if (chat) {
      io.to(chat.partnerId).emit('partner-typing', true);
    }
  });
  
  socket.on('typing-stop', () => {
    const chat = activeChats.get(socket.id);
    if (chat) {
      io.to(chat.partnerId).emit('partner-typing', false);
    }
  });
  
  socket.on('skip-partner', () => {
    handleDisconnection(socket.id);
  });
  
  socket.on('offer', (data) => {
    const chat = activeChats.get(socket.id);
    if (chat && data.offer) {
      io.to(chat.partnerId).emit('offer', { offer: data.offer, senderId: socket.id });
    }
  });
  
  socket.on('answer', (data) => {
    const chat = activeChats.get(socket.id);
    if (chat && data.answer) {
      io.to(chat.partnerId).emit('answer', { answer: data.answer, senderId: socket.id });
    }
  });
  
  socket.on('ice-candidate', (data) => {
    const chat = activeChats.get(socket.id);
    if (chat && data.candidate) {
      // Forwarding only to the partner in the active chat is the security measure.
      io.to(chat.partnerId).emit('ice-candidate', { candidate: data.candidate, senderId: socket.id });
    }
  });
  
  socket.on('video-call-request', () => {
    const chat = activeChats.get(socket.id);
    if (chat) {
      io.to(chat.partnerId).emit('video-call-request', { senderId: socket.id });
    }
  });
  
  socket.on('video-call-response', (data) => {
    const chat = activeChats.get(socket.id);
    if (chat) {
      io.to(chat.partnerId).emit('video-call-response', { accepted: data.accepted, senderId: socket.id });
    }
  });
  
  socket.on('disconnect', () => {
    handleDisconnection(socket.id);
  });
});

function handleDisconnection(socketId) {
  // Clean up rate limit tracking
  rateLimit.delete(socketId);

  // Remove from waiting queue
  waitingUsers.delete(socketId);
  
  // Handle active chat disconnection
  const chat = activeChats.get(socketId);
  if (chat) {
    io.to(chat.partnerId).emit('partner-disconnected');
    activeChats.delete(socketId);
    activeChats.delete(chat.partnerId);
  }
  
  userSockets.delete(socketId);
  console.log('User disconnected:', socketId);
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`SecureChat server running on port ${PORT}`);
});
