
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Security: Add basic security headers
app.disable('x-powered-by');

// Suggestion 1: Trust Proxy for correct IP handling behind load balancers/proxies
app.set('trust proxy', 1);

// Suggestion 1: Add timestamps to logs
const originalLog = console.log;
console.log = (...args) => {
  originalLog(`[${new Date().toISOString()}]`, ...args);
};

// Suggestion 1: Compression
app.use(compression());

// Suggestion 1: Use Helmet for security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      mediaSrc: ["'self'", "blob:"],
    },
  },
}));

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
const spamFilter = new Map(); // Suggestion 2: Spam filter storage

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Suggestion 2: Log server stats periodically
setInterval(() => {
    console.log(`Stats: ${activeChats.size} active chats, ${waitingUsers.size} waiting users, ${userSockets.size} connected sockets.`);
    // Suggestion 25: Broadcast online count
    io.emit('online-count', userSockets.size);
}, 60000);

// Suggestion 4: Health Check
app.get('/health', (req, res) => res.status(200).send('OK'));

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);  
  io.emit('online-count', userSockets.size + 1); // Immediate update

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

    // Optimized matching logic: Single pass to find the best possible partner.
    let partnerId = null;
    let partnerData = null;

    // Helper to validate socket
    const isSocketValid = (sid) => {
        const s = io.sockets.sockets.get(sid);
        return s && s.connected;
    };
    
    for (const [pid, pdata] of waitingUsers) {
        if (!isSocketValid(pid)) {
            waitingUsers.delete(pid); // Clean up stale entry
            continue;
        }
        // Prioritize finding a partner with the same chat mode.
        if (pdata.chatMode === userData.chatMode) {
            partnerId = pid;
            partnerData = pdata;
            break; // Found the best match, no need to search further.
        }
    }

    if (partnerId) {
      // Match with waiting user
      waitingUsers.delete(partnerId);
      const partner = partnerData;

      // Suggestion 3: Use UUID for room ID
      const roomId = crypto.randomUUID();
      
      // Join both users to room
      socket.join(roomId);
      const partnerSocket = io.sockets.sockets.get(partner.socketId);
      if (partnerSocket) partnerSocket.join(roomId);
      
      // Store active chat
      activeChats.set(socket.id, { partnerId: partner.socketId, roomId, startTime: Date.now() });
      activeChats.set(partner.socketId, { partnerId: socket.id, roomId, startTime: Date.now() });
      
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
      // Suggestion 14: Enforce max length
      // Suggestion 3: Strip HTML tags server-side
      const messageContent = data.message.trim().substring(0, 2000).replace(/<[^>]*>?/gm, '');
      
      if (messageContent.length > 0) {
        // Suggestion 2: Simple Spam Filter
        const lastMsg = spamFilter.get(socket.id);
        if (lastMsg === messageContent) {
            // Silently fail or notify user (optional)
            return; 
        }
        spamFilter.set(socket.id, messageContent);
        // Clear spam memory after 5 seconds to allow repeating later
        setTimeout(() => spamFilter.delete(socket.id), 5000);

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
  
  // Suggestion 3: Report User Handler
  socket.on('report-user', (data) => {
    console.warn(`[REPORT] User ${socket.id} reported partner ${data.partnerId} for reason: ${data.reason || 'Unspecified'}`);
    // In a real app, you would store this in a database and potentially ban the IP.
  });

  socket.on('disconnect', () => {
    handleDisconnection(socket.id);
  });
});

function handleDisconnection(socketId) {
  // Clean up rate limit tracking
  rateLimit.delete(socketId);
  spamFilter.delete(socketId);

  // Remove from waiting queue
  waitingUsers.delete(socketId);
  
  // Handle active chat disconnection
  const chat = activeChats.get(socketId);
  if (chat) {
    // Suggestion 2: Log Chat Duration
    const duration = (Date.now() - chat.startTime) / 1000;
    console.log(`Chat ended. Duration: ${duration}s`);

    io.to(chat.partnerId).emit('partner-disconnected');
    activeChats.delete(socketId);
    activeChats.delete(chat.partnerId);
  }
  
  userSockets.delete(socketId);
  console.log('User disconnected:', socketId);
  io.emit('online-count', Math.max(0, userSockets.size - 1));
}

// Suggestion 3: Graceful Shutdown
const gracefulShutdown = () => {
  console.log('Received kill signal, shutting down gracefully');
  server.close(() => {
    console.log('Closed out remaining connections');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Suggestion 6: 404 Handler
app.use((req, res) => {
  res.status(404).send('404 Not Found');
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`SecureChat server running on port ${PORT}`);
});
