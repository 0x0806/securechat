
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
        this.callBtn = document.getElementById('callBtn');
        
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
        this.callBtn.addEventListener('click', () => this.initiateCall());
        
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
                this.startCall();
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
        // Close existing connection if it exists
        if (this.peerConnection) {
            this.peerConnection.close();
        }
        
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' }
            ],
            iceCandidatePoolSize: 10
        };
        
        this.peerConnection = new RTCPeerConnection(configuration);
        this.queuedCandidates = [];
        
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.partnerId && this.roomId) {
                console.log('Sending ICE candidate:', event.candidate);
                this.socket.emit('ice-candidate', { 
                    candidate: event.candidate,
                    roomId: this.roomId 
                });
            }
        };
        
        this.peerConnection.ontrack = (event) => {
            console.log('Remote stream received:', event.streams);
            if (event.streams && event.streams[0]) {
                this.remoteStream = event.streams[0];
                this.remoteVideo.srcObject = this.remoteStream;
                this.showNotification('Video connected!', 'success');
            }
        };
        
        this.peerConnection.onconnectionstatechange = () => {
            console.log('Connection state:', this.peerConnection.connectionState);
            switch(this.peerConnection.connectionState) {
                case 'connected':
                    this.showNotification('Video call connected', 'success');
                    break;
                case 'disconnected':
                    console.log('Peer connection disconnected');
                    break;
                case 'failed':
                    console.log('Peer connection failed, attempting restart');
                    this.restartIce();
                    break;
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
            switch(this.peerConnection.iceConnectionState) {
                case 'failed':
                    console.log('ICE connection failed, restarting ICE');
                    this.restartIce();
                    break;
                case 'disconnected':
                    console.log('ICE connection disconnected');
                    break;
                case 'connected':
                    console.log('ICE connection established');
                    break;
            }
        };
        
        this.peerConnection.onnegotiationneeded = async () => {
            console.log('Negotiation needed');
            if (this.peerConnection.signalingState !== 'stable') {
                console.log('Signaling state not stable, skipping negotiation');
                return;
            }
            try {
                await this.createAndSendOffer();
            } catch (error) {
                console.error('Error during negotiation:', error);
            }
        };
    }
    
    async restartIce() {
        if (this.peerConnection && this.peerConnection.connectionState !== 'closed') {
            try {
                console.log('Restarting ICE connection');
                await this.peerConnection.restartIce();
            } catch (error) {
                console.error('Error restarting ICE:', error);
                this.showNotification('Connection issue, retrying...', 'warning');
            }
        }
    }
    
    async createAndSendOffer() {
        try {
            if (this.peerConnection.signalingState !== 'stable') {
                console.log('Peer connection not stable, skipping offer creation');
                return;
            }
            
            const offer = await this.peerConnection.createOffer({
                offerToReceiveVideo: true,
                offerToReceiveAudio: true
            });
            
            await this.peerConnection.setLocalDescription(offer);
            console.log('Sending offer');
            this.socket.emit('offer', { 
                offer: offer,
                roomId: this.roomId 
            });
        } catch (error) {
            console.error('Error creating/sending offer:', error);
            this.showNotification('Failed to create call offer', 'error');
            this.endCall();
        }
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
    
    async initiateCall() {
        if (!this.partnerId) {
            this.showNotification('No partner connected', 'warning');
            return;
        }
        
        if (this.isInCall) {
            this.showNotification('Already in a call', 'warning');
            return;
        }
        
        try {
            // Always try to get both video and audio, fallback to audio only if video fails
            let constraints = { video: true, audio: true };
            
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
                this.showNotification('Starting video call...', 'info');
            } catch (videoError) {
                console.log('Video access failed, trying audio only:', videoError);
                constraints = { video: false, audio: true };
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
                this.showNotification('Starting voice call...', 'info');
            }
            
            this.socket.emit('video-call-request');
        } catch (error) {
            console.error('Media access error:', error);
            this.showNotification('Camera/microphone access denied', 'error');
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
            // Try video + audio first, fallback to audio only
            let constraints = { video: true, audio: true };
            
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            } catch (videoError) {
                console.log('Video access failed, trying audio only:', videoError);
                constraints = { video: false, audio: true };
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            }
            
            this.startCall();
        } catch (error) {
            console.error('Media access error:', error);
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
    
    async startCall() {
        if (!this.localStream) {
            this.showNotification('No local stream available', 'error');
            return;
        }
        
        try {
            // Ensure peer connection is in stable state
            if (this.peerConnection.signalingState !== 'stable') {
                console.log('Resetting peer connection due to unstable state');
                this.setupRTC();
            }
            
            // Clear existing tracks first to prevent duplicates
            const senders = this.peerConnection.getSenders();
            for (const sender of senders) {
                if (sender.track) {
                    await this.peerConnection.removeTrack(sender);
                }
            }
            
            // Wait a bit for cleanup
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Add new tracks to peer connection
            this.localStream.getTracks().forEach(track => {
                console.log('Adding track:', track.kind, track.enabled);
                this.peerConnection.addTrack(track, this.localStream);
            });
            
            // Set up local video display
            this.localVideo.srcObject = this.localStream;
            this.videoContainer.classList.remove('hidden');
            this.isInCall = true;
            
            // Update button states based on available tracks
            const hasVideo = this.localStream.getVideoTracks().length > 0;
            const hasAudio = this.localStream.getAudioTracks().length > 0;
            
            this.toggleVideoBtn.style.display = hasVideo ? 'flex' : 'none';
            this.toggleAudioBtn.style.display = hasAudio ? 'flex' : 'none';
            
            this.showNotification(`${hasVideo ? 'Video' : 'Voice'} call started`, 'success');
        } catch (error) {
            console.error('Error starting call:', error);
            this.showNotification('Failed to start call', 'error');
            this.endCall();
        }
    }
    
    async handleOffer(offer) {
        try {
            console.log('Handling offer, current signaling state:', this.peerConnection.signalingState);
            
            // Reset peer connection if in bad state
            if (this.peerConnection.signalingState !== 'stable') {
                console.log('Resetting peer connection due to unstable state');
                this.setupRTC();
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            console.log('Remote description set successfully');
            
            // Process any queued ICE candidates
            await this.processQueuedCandidates();
            
            if (this.localStream) {
                // Clear existing tracks first to prevent duplicates
                const senders = this.peerConnection.getSenders();
                for (const sender of senders) {
                    if (sender.track) {
                        await this.peerConnection.removeTrack(sender);
                    }
                }
                
                // Wait for cleanup
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Add local stream tracks
                this.localStream.getTracks().forEach(track => {
                    console.log('Adding track to answer:', track.kind, track.enabled);
                    this.peerConnection.addTrack(track, this.localStream);
                });
                
                this.localVideo.srcObject = this.localStream;
                this.videoContainer.classList.remove('hidden');
                this.isInCall = true;
                
                // Update button states
                const hasVideo = this.localStream.getVideoTracks().length > 0;
                const hasAudio = this.localStream.getAudioTracks().length > 0;
                
                this.toggleVideoBtn.style.display = hasVideo ? 'flex' : 'none';
                this.toggleAudioBtn.style.display = hasAudio ? 'flex' : 'none';
            }
            
            const answer = await this.peerConnection.createAnswer({
                offerToReceiveVideo: true,
                offerToReceiveAudio: true
            });
            
            await this.peerConnection.setLocalDescription(answer);
            console.log('Sending answer');
            this.socket.emit('answer', { 
                answer: answer,
                roomId: this.roomId 
            });
            
            console.log('Answer sent successfully');
        } catch (error) {
            console.error('Error handling offer:', error);
            this.showNotification('Failed to answer call', 'error');
            this.endCall();
        }
    }
    
    async handleAnswer(answer) {
        try {
            console.log('Handling answer, current signaling state:', this.peerConnection.signalingState);
            
            if (this.peerConnection.signalingState === 'have-local-offer') {
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                console.log('Answer processed successfully');
                
                // Process any queued ICE candidates
                await this.processQueuedCandidates();
            } else {
                console.log('Unexpected signaling state for answer:', this.peerConnection.signalingState);
            }
        } catch (error) {
            console.error('Error handling answer:', error);
            this.showNotification('Call connection failed', 'error');
        }
    }
    
    async handleIceCandidate(candidate) {
        try {
            if (candidate && this.peerConnection.remoteDescription) {
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                console.log('ICE candidate added successfully');
            } else if (candidate) {
                console.log('Queuing ICE candidate - no remote description yet');
                // Queue the candidate for later if remote description isn't set
                if (!this.queuedCandidates) {
                    this.queuedCandidates = [];
                }
                this.queuedCandidates.push(candidate);
            }
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }
    
    async processQueuedCandidates() {
        if (this.queuedCandidates && this.queuedCandidates.length > 0) {
            console.log('Processing queued ICE candidates:', this.queuedCandidates.length);
            for (const candidate of this.queuedCandidates) {
                try {
                    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                    console.log('Queued ICE candidate added');
                } catch (error) {
                    console.error('Error adding queued ICE candidate:', error);
                }
            }
            this.queuedCandidates = [];
        }
    }
    
    endCall() {
        try {
            console.log('Ending call...');
            
            // Stop all tracks first
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
            
            // Clean up peer connection
            if (this.peerConnection && this.peerConnection.connectionState !== 'closed') {
                try {
                    // Remove all senders safely
                    const senders = this.peerConnection.getSenders();
                    for (const sender of senders) {
                        if (sender.track) {
                            this.peerConnection.removeTrack(sender);
                        }
                    }
                    
                    this.peerConnection.close();
                } catch (pcError) {
                    console.log('Error closing peer connection:', pcError);
                }
            }
            
            // Reset connection after cleanup
            setTimeout(() => {
                this.setupRTC();
            }, 100);
            
            // Clear queued candidates
            this.queuedCandidates = [];
            
            // Reset video elements
            if (this.localVideo) this.localVideo.srcObject = null;
            if (this.remoteVideo) this.remoteVideo.srcObject = null;
            if (this.videoContainer) this.videoContainer.classList.add('hidden');
            
            // Reset button states
            if (this.toggleVideoBtn) this.toggleVideoBtn.innerHTML = '<i class="fas fa-video"></i>';
            if (this.toggleAudioBtn) this.toggleAudioBtn.innerHTML = '<i class="fas fa-microphone"></i>';
            
            this.isInCall = false;
            
            // Auto-focus back to text chat
            if (this.currentScreen === 'chat' && this.messageInput) {
                setTimeout(() => {
                    this.messageInput.focus();
                }, 200);
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
