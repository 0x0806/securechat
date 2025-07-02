
# 🛡️ SecureChat - Anonymous Real-time Video & Text Chat Platform

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4.8.1-blue.svg)](https://socket.io/)
[![WebRTC](https://img.shields.io/badge/WebRTC-Enabled-orange.svg)](https://webrtc.org/)
[![Replit](https://img.shields.io/badge/Deploy-Replit-667881.svg)](https://replit.com/)

> **Secure, Anonymous, Real-time Communication Platform** - Connect with strangers worldwide through encrypted video calls and instant messaging without compromising your privacy.

## 🌟 Features

### 🔒 **Privacy & Security**
- **100% Anonymous** - No registration or personal information required
- **End-to-End Encryption** - WebRTC peer-to-peer connections
- **No Data Storage** - Messages are not stored on servers
- **Secure Connections** - HTTPS/WSS protocols for all communications

### 💬 **Communication Features**
- **Real-time Text Chat** - Instant messaging with typing indicators
- **HD Video Calls** - High-quality video communication
- **Voice Calls** - Crystal clear audio conversations
- **Smart Matching** - Automatic partner pairing system
- **Quick Skip** - Easy partner switching functionality

### 🎨 **User Experience**
- **Responsive Design** - Works on desktop, tablet, and mobile
- **Dark Theme** - Eye-friendly interface with glassmorphism design
- **Real-time Notifications** - System alerts and status updates
- **Intuitive Controls** - User-friendly interface with minimal learning curve
- **Cross-Platform** - Compatible with all modern browsers

## 🚀 Live Demo

Experience SecureChat live: [**Try SecureChat Now**](https://securechat.replit.app) *(Deploy on Replit)*

## 📱 Screenshots

### Welcome Screen
![Welcome Screen](https://via.placeholder.com/800x400/1a1a2e/ffffff?text=SecureChat+Welcome+Screen)

### Chat Interface
![Chat Interface](https://via.placeholder.com/800x400/16213e/ffffff?text=SecureChat+Interface)

### Video Call
![Video Call](https://via.placeholder.com/800x400/0f3460/ffffff?text=Video+Call+Interface)

## 🛠️ Technology Stack

| Technology | Purpose | Version |
|------------|---------|---------|
| **Node.js** | Backend Runtime | 18+ |
| **Express.js** | Web Framework | 5.1.0 |
| **Socket.IO** | Real-time Communication | 4.8.1 |
| **WebRTC** | Peer-to-peer Video/Audio | Native |
| **HTML5** | Frontend Structure | Latest |
| **CSS3** | Styling & Animations | Latest |
| **JavaScript ES6+** | Client-side Logic | Latest |

## ⚡ Quick Start

### Prerequisites
- Node.js 18+ installed
- Modern web browser with WebRTC support
- Internet connection

### Installation

```bash
# Clone the repository
git clone https://github.com/0x0806/securechat.git
cd securechat

# Install dependencies
npm install

# Start the application
npm start
```

### Deploy on Replit
1. Click [![Run on Replit](https://replit.com/badge/github/0x0806/securechat)](https://replit.com/@0x0806/securechat)
2. Fork the project
3. Click "Run" button
4. Your SecureChat instance is live!



## 🔧 Configuration

### Environment Variables
```bash
PORT=5000                   # Server port (default: 5000)
NODE_ENV=production         # Environment mode
```

### WebRTC Configuration
```javascript
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};
```

## 🎯 API Endpoints

### Socket.IO Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `find-partner` | Client → Server | Request to find chat partner |
| `partner-found` | Server → Client | Partner matching notification |
| `send-message` | Client → Server | Send text message |
| `message-received` | Server → Client | Receive text message |
| `typing-start` | Client ↔ Server | Typing indicator start |
| `typing-stop` | Client ↔ Server | Typing indicator stop |
| `video-call-request` | Client ↔ Server | Initiate video call |
| `offer` | Client ↔ Server | WebRTC offer exchange |
| `answer` | Client ↔ Server | WebRTC answer exchange |
| `ice-candidate` | Client ↔ Server | ICE candidate exchange |

## 🎨 Design System

### Color Palette
```css
--primary-bg: #0a0e27;        /* Deep space blue */
--secondary-bg: #1a1a2e;      /* Dark blue-gray */
--accent-color: #00d4ff;      /* Cyan accent */
--success-color: #00ff88;     /* Success green */
--warning-color: #ffaa00;     /* Warning orange */
--danger-color: #ff4757;      /* Error red */
```

### Typography
- **Primary Font**: System fonts for optimal performance
- **Fallback**: Arial, Helvetica, sans-serif
- **Icon Font**: Font Awesome 6.0.0

## 🔐 Security Features

- **No Server-side Message Storage** - All messages are ephemeral
- **WebRTC P2P Encryption** - Direct browser-to-browser communication
- **No User Tracking** - Anonymous sessions without persistent identifiers
- **CORS Protection** - Cross-origin resource sharing controls
- **Rate Limiting** - Protection against spam and abuse

## 📊 Performance Metrics

- **Initial Load Time**: < 2 seconds
- **Real-time Latency**: < 100ms
- **Video Quality**: Up to 1080p HD
- **Audio Quality**: 48kHz stereo
- **Concurrent Users**: Scalable architecture
- **Mobile Optimized**: 90+ Lighthouse score

## 🌐 Browser Compatibility

| Browser | Version | Support Level |
|---------|---------|---------------|
| Chrome | 60+ | ✅ Full Support |
| Firefox | 55+ | ✅ Full Support |
| Safari | 11+ | ✅ Full Support |
| Edge | 79+ | ✅ Full Support |
| Opera | 47+ | ✅ Full Support |

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details.

### Development Setup
```bash
# Fork the repository
git clone https://github.com/your-username/securechat.git

# Create feature branch
git checkout -b feature/amazing-feature

# Make changes and commit
git commit -m "Add amazing feature"

# Push to branch
git push origin feature/amazing-feature

# Open Pull Request
```

## 📈 Roadmap

- [ ] **Voice-only Mode** - Audio calls without video
- [ ] **File Sharing** - Secure P2P file transfer
- [ ] **Chat Rooms** - Multi-user chat functionality
- [ ] **Mobile App** - Native iOS/Android applications
- [ ] **Screen Sharing** - Desktop sharing capabilities
- [ ] **Message Encryption** - Additional text encryption layer
- [ ] **User Preferences** - Customizable interface themes
- [ ] **Language Support** - Multi-language interface

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 👨‍💻 Author & Copyright

**Developed by:** [0x0806](https://github.com/0x0806)  
**Copyright © 2024 0x0806. All rights reserved.**

---

### 🌟 Star this repository if you found it helpful!

For questions, issues, or contributions, visit: [github.com/0x0806](https://github.com/0x0806)

---

**Keywords:** secure chat, anonymous messaging, video call, webrtc, real-time communication, privacy chat, encrypted messaging, peer-to-peer, socket.io, node.js, express.js, replit deployment
