
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.static('public'));

// Store connected users and waiting queue
const waitingUsers = [];
const activeChats = new Map();
const userSockets = new Map();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('find-partner', (userData) => {
    console.log('User looking for partner:', socket.id);
    userSockets.set(socket.id, { ...userData, socketId: socket.id });
    
    if (waitingUsers.length > 0) {
      // Match with waiting user
      const partner = waitingUsers.shift();
      const roomId = `room_${socket.id}_${partner.socketId}`;
      
      // Join both users to room
      socket.join(roomId);
      io.sockets.sockets.get(partner.socketId)?.join(roomId);
      
      // Store active chat
      activeChats.set(socket.id, { partnerId: partner.socketId, roomId });
      activeChats.set(partner.socketId, { partnerId: socket.id, roomId });
      
      // Notify both users
      socket.emit('partner-found', { partnerId: partner.socketId, roomId, partnerChatMode: partner.chatMode });
      io.to(partner.socketId).emit('partner-found', { partnerId: socket.id, roomId, partnerChatMode: userSockets.get(socket.id).chatMode });
      
    } else {
      // Add to waiting queue
      waitingUsers.push(userSockets.get(socket.id));
      socket.emit('waiting-for-partner');
    }
  });
  
  socket.on('send-message', (data) => {
    const chat = activeChats.get(socket.id);
    if (chat) {
      io.to(chat.roomId).emit('message-received', {
        message: data.message,
        senderId: socket.id,
        timestamp: Date.now()
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
      console.log('Forwarding offer from', socket.id, 'to', chat.partnerId, 'in room', chat.roomId);
      // Validate that the room ID matches
      if (data.roomId && data.roomId === chat.roomId) {
        io.to(chat.partnerId).emit('offer', { offer: data.offer, senderId: socket.id, roomId: chat.roomId });
      } else {
        console.log('Room ID mismatch for offer');
      }
    }
  });
  
  socket.on('answer', (data) => {
    const chat = activeChats.get(socket.id);
    if (chat && data.answer) {
      console.log('Forwarding answer from', socket.id, 'to', chat.partnerId, 'in room', chat.roomId);
      // Validate that the room ID matches
      if (data.roomId && data.roomId === chat.roomId) {
        io.to(chat.partnerId).emit('answer', { answer: data.answer, senderId: socket.id, roomId: chat.roomId });
      } else {
        console.log('Room ID mismatch for answer');
      }
    }
  });
  
  socket.on('ice-candidate', (data) => {
    const chat = activeChats.get(socket.id);
    if (chat && data.candidate) {
      console.log('Forwarding ICE candidate from', socket.id, 'to', chat.partnerId, 'in room', chat.roomId);
      // Validate that the room ID matches
      if (data.roomId && data.roomId === chat.roomId) {
        io.to(chat.partnerId).emit('ice-candidate', { candidate: data.candidate, senderId: socket.id, roomId: chat.roomId });
      } else {
        console.log('Room ID mismatch for ICE candidate');
      }
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
  // Remove from waiting queue
  const waitingIndex = waitingUsers.findIndex(user => user.socketId === socketId);
  if (waitingIndex > -1) {
    waitingUsers.splice(waitingIndex, 1);
  }
  
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
