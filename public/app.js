
class SecureChat {
    constructor() {
        this.socket = io();
        this.currentScreen = 'welcome';
        this.isInCall = false;
        this.localStream = null;
        this.remoteStream = null;
        this.peerConnection = null;
        this.partnerId = null;
        this.roomId = null;
        this.typingTimer = null;
        this.isTyping = false;
        
        this.initializeElements();
        this.bindEvents();
        this.setupSocketEvents();
        this.setupRTC();
    }
    
    initializeElements() {
        // Screens
        this.welcomeScreen = document.getElementById('welcomeScreen');
        this.waitingScreen = document.getElementById('waitingScreen');
        this.chatScreen = document.getElementById('chatScreen');
        
        // Buttons
        this.startChatBtn = document.getElementById('startChatBtn');
        this.cancelWaitBtn = document.getElementById('cancelWaitBtn');
        this.sendBtn = document.getElementById('sendBtn');
        this.skipBtn = document.getElementById('skipBtn');
        this.videoCallBtn = document.getElementById('videoCallBtn');
        this.audioCallBtn = document.getElementById('audioCallBtn');
        
        // Video elements
        this.localVideo = document.getElementById('localVideo');
        this.remoteVideo = document.getElementById('remoteVideo');
        this.videoContainer = document.getElementById('videoContainer');
        this.toggleVideoBtn = document.getElementById('toggleVideoBtn');
        this.toggleAudioBtn = document.getElementById('toggleAudioBtn');
        this.endCallBtn = document.getElementById('endCallBtn');
        
        // Chat elements
        this.messageInput = document.getElementById('messageInput');
        this.chatMessages = document.getElementById('chatMessages');
        this.typingIndicator = document.getElementById('typingIndicator');
        this.partnerStatus = document.getElementById('partnerStatus');
        
        // Modal elements
        this.callRequestModal = document.getElementById('callRequestModal');
        this.acceptCallBtn = document.getElementById('acceptCallBtn');
        this.declineCallBtn = document.getElementById('declineCallBtn');
        
        // Other elements
        this.connectionStatus = document.getElementById('connectionStatus');
        this.notificationContainer = document.getElementById('notificationContainer');
    }
    
    bindEvents() {
        this.startChatBtn.addEventListener('click', () => this.startChat());
        this.cancelWaitBtn.addEventListener('click', () => this.cancelWait());
        this.sendBtn.addEventListener('click', () => this.sendMessage());
        this.skipBtn.addEventListener('click', () => this.skipPartner());
        this.videoCallBtn.addEventListener('click', () => this.initiateVideoCall());
        this.audioCallBtn.addEventListener('click', () => this.initiateAudioCall());
        
        this.endCallBtn.addEventListener('click', () => this.endCall());
        this.toggleVideoBtn.addEventListener('click', () => this.toggleVideo());
        this.toggleAudioBtn.addEventListener('click', () => this.toggleAudio());
        
        this.acceptCallBtn.addEventListener('click', () => this.acceptCall());
        this.declineCallBtn.addEventListener('click', () => this.declineCall());
        
        this.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendMessage();
            } else {
                this.handleTyping();
            }
        });
        
        this.messageInput.addEventListener('input', () => this.handleTyping());
        this.messageInput.addEventListener('blur', () => this.stopTyping());
        
        // Handle window focus/blur for typing indicators
        window.addEventListener('focus', () => this.handleWindowFocus());
        window.addEventListener('blur', () => this.handleWindowBlur());
    }
    
    setupSocketEvents() {
        this.socket.on('connect', () => {
            this.updateConnectionStatus(true);
            this.showNotification('Connected to SecureChat', 'success');
        });
        
        this.socket.on('disconnect', () => {
            this.updateConnectionStatus(false);
            this.showNotification('Connection lost. Attempting to reconnect...', 'error');
        });
        
        this.socket.on('waiting-for-partner', () => {
            this.showScreen('waiting');
        });
        
        this.socket.on('partner-found', (data) => {
            this.partnerId = data.partnerId;
            this.roomId = data.roomId;
            this.showScreen('chat');
            this.showNotification('Partner found! Start chatting', 'success');
            this.updatePartnerStatus('Online');
        });
        
        this.socket.on('message-received', (data) => {
            if (data.senderId !== this.socket.id) {
                this.displayMessage(data.message, false, data.timestamp);
                this.playNotificationSound();
            }
        });
        
        this.socket.on('partner-typing', (isTyping) => {
            this.showTypingIndicator(isTyping);
        });
        
        this.socket.on('partner-disconnected', () => {
            this.handlePartnerDisconnect();
        });
        
        this.socket.on('video-call-request', (data) => {
            this.showCallRequestModal();
        });
        
        this.socket.on('video-call-response', (data) => {
            if (data.accepted) {
                this.startVideoCall();
            } else {
                this.showNotification('Call declined - Continue texting', 'warning');
                // Focus back on text input when call is declined
                if (this.messageInput) {
                    setTimeout(() => {
                        this.messageInput.focus();
                    }, 100);
                }
            }
        });
        
        // WebRTC signaling events
        this.socket.on('offer', async (data) => {
            await this.handleOffer(data.offer);
        });
        
        this.socket.on('answer', async (data) => {
            await this.handleAnswer(data.answer);
        });
        
        this.socket.on('ice-candidate', async (data) => {
            await this.handleIceCandidate(data.candidate);
        });
    }
    
    setupRTC() {
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' }
            ]
        };
        
        this.peerConnection = new RTCPeerConnection(configuration);
        
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.partnerId) {
                this.socket.emit('ice-candidate', { candidate: event.candidate });
            }
        };
        
        this.peerConnection.ontrack = (event) => {
            console.log('Remote stream received');
            this.remoteStream = event.streams[0];
            this.remoteVideo.srcObject = this.remoteStream;
            this.showNotification('Video connected!', 'success');
        };
        
        this.peerConnection.onconnectionstatechange = () => {
            console.log('Connection state:', this.peerConnection.connectionState);
            switch(this.peerConnection.connectionState) {
                case 'connected':
                    this.showNotification('Video call connected', 'success');
                    break;
                case 'disconnected':
                case 'failed':
                case 'closed':
                    if (this.isInCall) {
                        this.endCall();
                        this.showNotification('Video call disconnected - Back to text chat', 'warning');
                    }
                    break;
            }
        };
        
        this.peerConnection.onicegatheringstatechange = () => {
            console.log('ICE gathering state:', this.peerConnection.iceGatheringState);
        };
        
        this.peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', this.peerConnection.iceConnectionState);
            if (this.peerConnection.iceConnectionState === 'failed') {
                this.showNotification('Connection failed, retrying...', 'warning');
            }
        };
    }
    
    startChat() {
        this.socket.emit('find-partner', {
            timestamp: Date.now()
        });
    }
    
    cancelWait() {
        this.showScreen('welcome');
    }
    
    sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message) {
            return;
        }
        
        if (!this.partnerId) {
            this.showNotification('No partner connected', 'warning');
            return;
        }
        
        if (message.length > 500) {
            this.showNotification('Message too long', 'warning');
            return;
        }
        
        this.socket.emit('send-message', { message });
        this.displayMessage(message, true);
        this.messageInput.value = '';
        this.stopTyping();
    }
    
    skipPartner() {
        this.socket.emit('skip-partner');
        this.endCall();
        this.clearChat();
        this.showScreen('waiting');
        this.showNotification('Finding a new partner...', 'info');
    }
    
    async initiateVideoCall() {
        if (!this.partnerId) {
            this.showNotification('No partner connected', 'warning');
            return;
        }
        
        if (this.isInCall) {
            this.showNotification('Already in a call', 'warning');
            return;
        }
        
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            
            this.socket.emit('video-call-request');
            this.showNotification('Calling partner...', 'info');
        } catch (error) {
            console.error('Media access error:', error);
            this.showNotification('Camera/microphone access denied', 'error');
        }
    }
    
    async initiateAudioCall() {
        if (!this.partnerId) {
            this.showNotification('No partner connected', 'warning');
            return;
        }
        
        if (this.isInCall) {
            this.showNotification('Already in a call', 'warning');
            return;
        }
        
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: true
            });
            
            this.socket.emit('video-call-request');
            this.showNotification('Starting voice call...', 'info');
        } catch (error) {
            console.error('Microphone access error:', error);
            this.showNotification('Microphone access denied', 'error');
        }
    }
    
    showCallRequestModal() {
        this.callRequestModal.classList.remove('hidden');
    }
    
    hideCallRequestModal() {
        this.callRequestModal.classList.add('hidden');
    }
    
    async acceptCall() {
        this.hideCallRequestModal();
        this.socket.emit('video-call-response', { accepted: true });
        
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            
            this.startVideoCall();
        } catch (error) {
            this.showNotification('Camera/microphone access denied', 'error');
        }
    }
    
    declineCall() {
        this.hideCallRequestModal();
        this.socket.emit('video-call-response', { accepted: false });
        
        // Focus back on text input after declining call
        if (this.messageInput) {
            setTimeout(() => {
                this.messageInput.focus();
            }, 100);
        }
    }
    
    async startVideoCall() {
        if (!this.localStream) {
            this.showNotification('No local stream available', 'error');
            return;
        }
        
        try {
            // Add tracks to peer connection
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });
            
            this.localVideo.srcObject = this.localStream;
            this.videoContainer.classList.remove('hidden');
            this.isInCall = true;
            
            // Always create offer when starting call
            const offer = await this.peerConnection.createOffer({
                offerToReceiveVideo: true,
                offerToReceiveAudio: true
            });
            
            await this.peerConnection.setLocalDescription(offer);
            this.socket.emit('offer', { offer });
            
            this.showNotification('Call started', 'success');
        } catch (error) {
            console.error('Error starting video call:', error);
            this.showNotification('Failed to start call', 'error');
            this.endCall();
        }
    }
    
    async handleOffer(offer) {
        try {
            console.log('Handling offer');
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            
            if (this.localStream) {
                this.localStream.getTracks().forEach(track => {
                    this.peerConnection.addTrack(track, this.localStream);
                });
                this.localVideo.srcObject = this.localStream;
                this.videoContainer.classList.remove('hidden');
                this.isInCall = true;
            }
            
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);
            this.socket.emit('answer', { answer });
            
            console.log('Answer sent');
        } catch (error) {
            console.error('Error handling offer:', error);
            this.showNotification('Failed to answer call', 'error');
        }
    }
    
    async handleAnswer(answer) {
        try {
            console.log('Handling answer');
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            console.log('Answer processed');
        } catch (error) {
            console.error('Error handling answer:', error);
            this.showNotification('Call connection failed', 'error');
        }
    }
    
    async handleIceCandidate(candidate) {
        try {
            if (candidate) {
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                console.log('ICE candidate added');
            }
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }
    
    endCall() {
        try {
            if (this.localStream) {
                this.localStream.getTracks().forEach(track => {
                    track.stop();
                    console.log('Stopped track:', track.kind);
                });
                this.localStream = null;
            }
            
            if (this.remoteStream) {
                this.remoteStream.getTracks().forEach(track => track.stop());
                this.remoteStream = null;
            }
            
            if (this.peerConnection) {
                this.peerConnection.close();
                this.setupRTC(); // Reset connection
            }
            
            // Reset video elements
            this.localVideo.srcObject = null;
            this.remoteVideo.srcObject = null;
            this.videoContainer.classList.add('hidden');
            
            // Reset button states
            this.toggleVideoBtn.innerHTML = '<i class="fas fa-video"></i>';
            this.toggleAudioBtn.innerHTML = '<i class="fas fa-microphone"></i>';
            
            this.isInCall = false;
            
            // Auto-focus back to text chat
            if (this.currentScreen === 'chat' && this.messageInput) {
                setTimeout(() => {
                    this.messageInput.focus();
                }, 100);
            }
            
            this.showNotification('Call ended - Continue texting', 'info');
        } catch (error) {
            console.error('Error ending call:', error);
        }
    }
    
    toggleVideo() {
        if (this.localStream) {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                this.toggleVideoBtn.innerHTML = videoTrack.enabled ? 
                    '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
            }
        }
    }
    
    toggleAudio() {
        if (this.localStream) {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                this.toggleAudioBtn.innerHTML = audioTrack.enabled ? 
                    '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
            }
        }
    }
    
    displayMessage(message, isOwn, timestamp = Date.now()) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isOwn ? 'own' : 'partner'}`;
        
        const messageText = document.createElement('div');
        messageText.textContent = message;
        messageDiv.appendChild(messageText);
        
        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-timestamp';
        timeDiv.textContent = new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
        messageDiv.appendChild(timeDiv);
        
        this.chatMessages.appendChild(messageDiv);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }
    
    handleTyping() {
        if (!this.isTyping) {
            this.isTyping = true;
            this.socket.emit('typing-start');
        }
        
        clearTimeout(this.typingTimer);
        this.typingTimer = setTimeout(() => {
            this.stopTyping();
        }, 2000);
    }
    
    stopTyping() {
        if (this.isTyping) {
            this.isTyping = false;
            this.socket.emit('typing-stop');
        }
        clearTimeout(this.typingTimer);
    }
    
    showTypingIndicator(show) {
        if (show) {
            this.typingIndicator.classList.remove('hidden');
        } else {
            this.typingIndicator.classList.add('hidden');
        }
    }
    
    handlePartnerDisconnect() {
        this.endCall();
        this.partnerId = null;
        this.roomId = null;
        this.updatePartnerStatus('Disconnected');
        this.showNotification('Partner disconnected. Finding a new one...', 'warning');
        
        setTimeout(() => {
            this.clearChat();
            this.showScreen('waiting');
            this.startChat();
        }, 2000);
    }
    
    clearChat() {
        this.chatMessages.innerHTML = `
            <div class="system-message">
                <i class="fas fa-info-circle"></i>
                <span>You're now connected with a stranger. Say hello!</span>
            </div>
        `;
        this.showTypingIndicator(false);
    }
    
    showScreen(screen) {
        // Hide all screens
        this.welcomeScreen.classList.add('hidden');
        this.waitingScreen.classList.add('hidden');
        this.chatScreen.classList.add('hidden');
        
        // Show target screen
        switch (screen) {
            case 'welcome':
                this.welcomeScreen.classList.remove('hidden');
                break;
            case 'waiting':
                this.waitingScreen.classList.remove('hidden');
                break;
            case 'chat':
                this.chatScreen.classList.remove('hidden');
                this.messageInput.focus();
                break;
        }
        
        this.currentScreen = screen;
    }
    
    updateConnectionStatus(connected) {
        const statusIcon = this.connectionStatus.querySelector('i');
        const statusText = this.connectionStatus.querySelector('span');
        
        if (connected) {
            statusIcon.style.color = 'var(--success-color)';
            statusText.textContent = 'Connected';
        } else {
            statusIcon.style.color = 'var(--danger-color)';
            statusText.textContent = 'Disconnected';
        }
    }
    
    updatePartnerStatus(status) {
        this.partnerStatus.textContent = status;
        
        switch (status.toLowerCase()) {
            case 'online':
                this.partnerStatus.style.color = 'var(--success-color)';
                break;
            case 'disconnected':
                this.partnerStatus.style.color = 'var(--danger-color)';
                break;
            default:
                this.partnerStatus.style.color = 'var(--warning-color)';
        }
    }
    
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        
        const icon = document.createElement('i');
        switch (type) {
            case 'success':
                icon.className = 'fas fa-check-circle';
                break;
            case 'warning':
                icon.className = 'fas fa-exclamation-triangle';
                break;
            case 'error':
                icon.className = 'fas fa-times-circle';
                break;
            default:
                icon.className = 'fas fa-info-circle';
        }
        
        const text = document.createElement('span');
        text.textContent = message;
        
        notification.appendChild(icon);
        notification.appendChild(text);
        
        this.notificationContainer.appendChild(notification);
        
        // Auto remove after 4 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.style.animation = 'fadeOut 0.3s ease';
                setTimeout(() => {
                    notification.remove();
                }, 300);
            }
        }, 4000);
    }
    
    playNotificationSound() {
        // Create a subtle notification sound using Web Audio API
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(400, audioContext.currentTime + 0.1);
            
            gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.1);
            
            oscillator.start();
            oscillator.stop(audioContext.currentTime + 0.1);
        } catch (error) {
            // Silent fail if audio context is not available
        }
    }
    
    handleWindowFocus() {
        // Resume any paused functionality when window gains focus
    }
    
    handleWindowBlur() {
        // Pause typing when window loses focus
        this.stopTyping();
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SecureChat();
});

// PWA capabilities can be added later with proper service worker implementation
