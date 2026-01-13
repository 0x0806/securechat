/**
 * @class SecureChat
 * @description Manages the entire frontend logic for the SecureChat application,
 * including UI, WebSocket communication, WebRTC video/audio calls, and E2E encryption.
 */
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
        this.chatMode = 'text'; // 'text' or 'video'
        this.originalTitle = document.title;
        this.titleInterval = null;
        this.keyPair = null;
        this.sharedSecret = null;
        this.audioContext = null;
        this.reconnectTimer = null;
        
        this.initializeElements();
        this.bindEvents();
        this.setupSocketEvents();
        this.setupRTC();
        this.initAudio();
        // Move local video to a persistent container to be visible across screens
        this.mainContent.appendChild(this.localVideo);
    }

    // --- Initialization & Setup ---

    /**
     * Caches all necessary DOM elements for performance.
     */
    initializeElements() {
        // Screens
        this.welcomeScreen = document.getElementById('welcomeScreen');
        this.waitingScreen = document.getElementById('waitingScreen');
        this.chatScreen = document.getElementById('chatScreen');
        this.mainContent = document.querySelector('.main-content');
        
        // Buttons
        this.startChatBtn = document.getElementById('startChatBtn');
        this.startVideoChatBtn = document.getElementById('startVideoChatBtn');
        this.termsCheckbox = document.getElementById('termsCheckbox');
        this.termsCheckbox.setAttribute('aria-label', 'Accept terms and conditions');

        this.cancelWaitBtn = document.getElementById('cancelWaitBtn');
        this.sendBtn = document.getElementById('sendBtn');
        this.sendBtn.setAttribute('aria-label', 'Send message');
        this.skipBtn = document.getElementById('skipBtn');
        this.skipBtn.setAttribute('aria-label', 'Skip to a new partner');
        this.callBtn = document.getElementById('callBtn');
        this.callBtn.setAttribute('aria-label', 'Start video call');
        
        // Video elements
        this.localVideo = document.getElementById('localVideo');
        this.remoteVideo = document.getElementById('remoteVideo');
        this.videoContainer = document.getElementById('videoContainer');
        this.toggleVideoBtn = document.getElementById('toggleVideoBtn');
        this.toggleVideoBtn.setAttribute('aria-label', 'Toggle your video');
        this.toggleAudioBtn = document.getElementById('toggleAudioBtn');
        this.toggleAudioBtn.setAttribute('aria-label', 'Toggle your microphone');
        this.endCallBtn = document.getElementById('endCallBtn');
        this.endCallBtn.setAttribute('aria-label', 'End call');
        this.fullscreenBtn = document.getElementById('fullscreenBtn');
        this.fullscreenBtn.setAttribute('aria-label', 'Toggle fullscreen');
        
        // Chat elements
        this.messageInput = document.getElementById('messageInput');
        this.messageInput.setAttribute('aria-label', 'Type your message');
        this.chatMessages = document.getElementById('chatMessages');
        this.chatMessages.setAttribute('role', 'log');
        this.chatMessages.setAttribute('aria-live', 'polite');
        this.typingIndicator = document.getElementById('typingIndicator');
        this.partnerStatus = document.getElementById('partnerStatus');
        
        this.emojiBtn = document.getElementById('emojiBtn');
        this.emojiBtn.setAttribute('aria-label', 'Open emoji picker');
        this.emojiPicker = document.getElementById('emojiPicker');

        // Modal elements
        this.callRequestModal = document.getElementById('callRequestModal');
        this.acceptCallBtn = document.getElementById('acceptCallBtn');
        this.declineCallBtn = document.getElementById('declineCallBtn');
        
        // Other elements
        this.connectionStatus = document.getElementById('connectionStatus');
        this.notificationContainer = document.getElementById('notificationContainer');
        this.notificationContainer.setAttribute('aria-live', 'assertive');
        this.localVideo.classList.add('hidden'); // Hide persistent local video initially
    }

    /**
     * Binds all DOM event listeners to their respective handlers.
     */
    bindEvents() {
        this.startChatBtn.addEventListener('click', () => {
            this.chatMode = 'text';
            this.startChat();
        });
        this.startVideoChatBtn.addEventListener('click', () => {
            this.chatMode = 'video';
            this.startChat();
        });

        this.termsCheckbox.addEventListener('change', () => {
            const isChecked = this.termsCheckbox.checked;
            this.startChatBtn.disabled = !isChecked;
            this.startVideoChatBtn.disabled = !isChecked;
        });
        this.cancelWaitBtn.addEventListener('click', () => this.cancelWait());
        this.sendBtn.addEventListener('click', () => this.sendMessage());
        this.skipBtn.addEventListener('click', () => this.skipPartner());
        this.callBtn.addEventListener('click', () => this.initiateCall());
        this.skipBtn.title = 'Skip to a new partner (Esc)';
        
        this.endCallBtn.addEventListener('click', () => this.endCall({ stopLocalStream: true }));
        this.toggleVideoBtn.addEventListener('click', () => this.toggleVideo());
        this.toggleAudioBtn.addEventListener('click', () => this.toggleAudio());
        
        this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());

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
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.currentScreen === 'chat') {
                this.skipPartner();
            }
        });

        // Make local video draggable
        this.makeDraggable(this.localVideo);

        // Emoji events
        this.emojiBtn.addEventListener('click', () => this.toggleEmojiPicker());
        this.setupEmojiPicker();
    }

    /**
     * Sets up all Socket.IO event listeners.
     */
    setupSocketEvents() {
        this.socket.on('connect', () => {
            this.updateConnectionStatus(true);
            this.showNotification('Connected to SecureChat', 'success');
            
            // UX: If we reconnected while in a chat or waiting, the server state is lost.
            // We must reset to home to avoid a broken UI state.
            if (this.currentScreen === 'chat' || this.currentScreen === 'waiting') {
                this.showNotification('Session restored - Please start a new search', 'info');
                this.resetToHome();
            }
        });
        
        this.socket.on('disconnect', () => {
            this.updateConnectionStatus(false);
            this.showNotification('Connection lost. Attempting to reconnect...', 'error');
        });
        
        // Handle generic socket errors (like rate limiting)
        this.socket.on('error', (err) => {
            this.showNotification(err.message || 'An error occurred', 'error');
        });

        this.socket.on('waiting-for-partner', () => {
            this.showScreen('waiting');
        });
        
        this.socket.on('partner-found', async (data) => {
            this.partnerId = data.partnerId;
            this.roomId = data.roomId;
            this.showScreen('chat');
            this.showNotification('Partner found! Start chatting', 'success');
            this.playSound('found');
            this.updatePartnerStatus('Online');
            this.initEncryption();
            
            // Auto-start video if in video mode
            if (this.chatMode === 'video') {
                // Start local video immediately
                try {
                    await this.startLocalVideo();
                } catch (e) {
                    console.error("Failed to start video:", e);
                }
                
                if (data.partnerChatMode === 'video') {
                    // Both in video mode - connect directly
                    if (this.socket.id > this.partnerId) {
                        this.startCall();
                    }
                } else {
                    // Partner is text - request video
                    this.socket.emit('video-call-request');
                    this.showNotification('Requesting video call...', 'info');
                }
            }
        });
        
        this.socket.on('message-received', async (data) => {
            // UX: Handle confirmation of our own sent message
            if (data.senderId === this.socket.id && data.id) {
                this.confirmMessageSent(data.id);
                return; // Don't display our own message twice
            }

            let wasEncrypted = false;
            let isSystemHtml = false;
            if (data.senderId !== this.socket.id) {
                // Attempt to decrypt if encryption is active
                if (this.sharedSecret) {
                    const decrypted = await this.decryptMessage(data.message);
                    if (decrypted) {
                        data.message = decrypted;
                        wasEncrypted = true;
                    }
                } else if (data.message.includes('"iv":') && data.message.includes('"content":')) {
                    data.message = '🔒 <i>Encrypted message (waiting for key...)</i>';
                    isSystemHtml = true;
                }
                this.displayMessage(data.message, false, data.timestamp, wasEncrypted, isSystemHtml);
                this.playSound('message');
                this.flashTitle('New Message!');
            }
        });
        
        this.socket.on('partner-typing', (isTyping) => {
            this.showTypingIndicator(isTyping);
        });
        
        this.socket.on('partner-disconnected', () => {
            this.handlePartnerDisconnect();
        });

        this.socket.on('exchange-key', async (data) => {
            await this.handleKeyExchange(data);
        });
        
        this.socket.on('video-call-request', (data) => {
            if (this.chatMode === 'video') {
                this.acceptCall();
            } else {
                this.showCallRequestModal();
            }
        });
        
        this.socket.on('video-call-response', (data) => {
            if (data.accepted) {
                this.startCall();
            } else {
                this.showNotification('Call declined - Continue texting', 'warning');
                this.endCall(); // Clean up local stream/UI since call was declined
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
    
    /**
     * Initializes the RTCPeerConnection with STUN servers and event handlers.
     * This is the core of the WebRTC functionality.
     */
    setupRTC() {
        // Close existing connection if it exists
        if (this.peerConnection) {
            if (this.peerConnection.connectionState !== 'closed') {
                this.peerConnection.close();
            }
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
                this.socket.emit('ice-candidate', { candidate: event.candidate });
            }
        };
        
        this.peerConnection.ontrack = (event) => {
            console.log('Remote stream received.');
            if (event.streams && event.streams[0]) {
                this.remoteStream = event.streams[0];
                this.remoteVideo.srcObject = this.remoteStream;
                this.showNotification('Video connected!', 'success');
            }
        };
        
        this.peerConnection.onconnectionstatechange = () => {
            console.log('PeerConnection state:', this.peerConnection.connectionState);
            switch(this.peerConnection.connectionState) {
                case 'connected':
                    this.showNotification('Video call connected', 'success');
                    break;
                case 'disconnected':
                    this.showNotification('Connection unstable, trying to reconnect...', 'warning');
                    break;
                case 'failed':
                    this.showNotification('Connection failed, attempting to restart...', 'error');
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
            // For debugging: e.g., 'gathering', 'complete'
        };
        
        this.peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', this.peerConnection.iceConnectionState);
            switch(this.peerConnection.iceConnectionState) {
                case 'failed':
                    this.restartIce();
                    break;
                case 'connected':
                    console.log('ICE connection established');
                    break;
            }
        };
        
        this.peerConnection.onnegotiationneeded = async () => {
            console.log('Negotiation needed');
            if (this.peerConnection.signalingState !== 'stable' || !this.isInCall) {
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

    /**
     * Initializes the Web Audio API context for sound playback.
     * This is done once to improve performance.
     */
    initAudio() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                this.audioContext = new AudioContext();
            }
        } catch (e) {
            console.warn("Web Audio API is not supported in this browser.");
        }
    }

    // --- Core Application Logic ---

    /** Attempts to restart the ICE connection, a recovery mechanism for failed WebRTC calls. */
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
    
    /** Creates and sends a WebRTC offer to the partner. */
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
            console.log('Sending offer.');
            this.socket.emit('offer', { offer });
        } catch (error) {
            console.error('Error creating/sending offer:', error);
            this.showNotification('Failed to create call offer', 'error');
            this.endCall();
        }
    }

    /** Starts the process of finding a partner. */
    startChat() {
        if (!this.termsCheckbox.checked) {
            this.showNotification('Please accept the terms first', 'warning');
            return;
        }

        this.showScreen('waiting');
        
        this.socket.emit('find-partner', {
            timestamp: Date.now(),
            chatMode: this.chatMode
        });
    }
    
    /** Cancels the search for a partner. */
    cancelWait() {
        this.socket.emit('leave-queue');
        this.showScreen('welcome');
    }
    
    /** Encrypts (if possible) and sends a text message. */
    async sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message) {
            return;
        }
        
        if (!this.partnerId) {
            this.showNotification('No partner connected', 'warning');
            return;
        }
        
        if (message.length > 2000) {
            this.showNotification('Message too long', 'warning');
            return;
        }
        
        const msgId = `${Date.now()}-${Math.random()}`;
        let messageToSend = message;
        
        // Encrypt if shared secret exists
        if (this.sharedSecret) {
            const encrypted = await this.encryptMessage(message);
            // Note: We display the unencrypted message locally for the sender.
            if (encrypted) messageToSend = encrypted;
        }

        this.socket.emit('send-message', { message: messageToSend, id: msgId });
        this.displayMessage(message, true, Date.now(), !!this.sharedSecret, false, msgId);
        this.messageInput.value = '';
        this.stopTyping();
    }
    
    /** Disconnects from the current partner and finds a new one. */
    skipPartner() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.resetEncryption();
        this.socket.emit('skip-partner');
        // Clean up call but keep local video stream for next partner for a seamless UX
        this.endCall({ stopLocalStream: false });
        this.clearChat();
        this.showScreen('waiting');
        this.showNotification('Finding a new partner...', 'info');
        this.startChat();
    }
    
    // --- Video & Call Management ---

    /**
     * Requests access to the user's camera and microphone and displays the local video stream.
     */
    async startLocalVideo() {
        if (this.localStream) return;
        
        // Prevent concurrent calls
        if (this.isStartingVideo) {
            while (this.isStartingVideo) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (this.localStream) return;
        }
        
        this.isStartingVideo = true;
        
        this.videoContainer.classList.remove('hidden');
        
        try {
            let constraints = { video: true, audio: true };
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            } catch (videoError) {
                console.log('Video access failed, trying audio only:', videoError);
                constraints = { video: false, audio: true };
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            }
            
            this.localVideo.srcObject = this.localStream;
            this.localVideo.muted = true; // Fix: Mute local video to prevent feedback
            this.localVideo.classList.remove('hidden'); // Show the persistent local video element
            this.toggleVideoBtn.style.display = 'flex';
            this.toggleAudioBtn.style.display = 'flex';
        } catch (error) {
            console.error('Media access error:', error.name, error.message);
            let userMessage = 'Could not access camera/microphone.';
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                userMessage = 'Permission for camera/mic was denied. Please allow it in your browser settings.';
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                userMessage = 'No camera/microphone found on your device.';
            } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
                userMessage = 'Your camera/microphone is being used by another application.';
            }
            this.showNotification(userMessage, 'error');
            this.videoContainer.classList.add('hidden');
            throw error;
        } finally {
            this.isStartingVideo = false;
        }
    }
    
    /** Initiates a video call request to the partner. */
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
            await this.startLocalVideo();
            this.showNotification('Waiting for partner to accept call...', 'info');
            this.socket.emit('video-call-request');
            
        } catch (error) {
            // Error handled in startLocalVideo
        }
    }
    
    /** Shows the incoming call request modal. */
    showCallRequestModal() {
        this.callRequestModal.classList.remove('hidden');
    }
    
    /** Hides the incoming call request modal. */
    hideCallRequestModal() {
        this.callRequestModal.classList.add('hidden');
    }
    
    /** Accepts an incoming video call request. */
    async acceptCall() {
        this.hideCallRequestModal();
        try {
            await this.startLocalVideo();

            // Send response AFTER media is ready
            this.socket.emit('video-call-response', { accepted: true });
        } catch (error) {
            this.socket.emit('video-call-response', { accepted: false });
        }
    }
    
    /** Declines an incoming video call request. */
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
    
    /** Starts the WebRTC call by adding local media tracks to the peer connection. */
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
            
            this.isInCall = true; // Fix: Set state before adding tracks to ensure negotiation triggers

            // Add new tracks to peer connection
            this.localStream.getTracks().forEach(track => {
                console.log('Adding track:', track.kind, track.enabled);
                this.peerConnection.addTrack(track, this.localStream);
            });
            
            // NEW: Switch to video view by hiding chat elements and showing video container
            this.chatScreen.classList.add('in-video-call');
            this.videoContainer.classList.remove('hidden');
            
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
    
    /** Handles an incoming WebRTC offer from the partner. */
    async handleOffer(offer) {
        try {
            console.log('Handling offer...');
            
            // Ensure video is ready if in video mode
            if (this.chatMode === 'video' && !this.localStream) {
                try {
                    await this.startLocalVideo();
                } catch (e) {
                    console.error("Failed to start video in handleOffer:", e);
                }
            }
            
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
                
                // NEW: Switch to video view
                this.chatScreen.classList.add('in-video-call');
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
            console.log('Sending answer.');
            this.socket.emit('answer', { answer });
            
            console.log('Answer sent successfully');
        } catch (error) {
            console.error('Error handling offer:', error);
            this.showNotification('Failed to answer call', 'error');
            this.endCall();
        }
    }
    
    /** Handles an incoming WebRTC answer from the partner. */
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
    
    /** Handles an incoming ICE candidate from the partner. */
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
    
    /** Processes any ICE candidates that were received before the connection was ready. */
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
    
    /** Gracefully ends the call, stopping all media tracks and cleaning up connections. */
    endCall(options = { stopLocalStream: true }) {
        try {
            console.log('Ending call...');
            
            // Conditionally stop local tracks. On "skip", we keep the stream alive.
            if (options.stopLocalStream) {
                if (this.localStream) {
                    this.localStream.getTracks().forEach(track => {
                        track.stop();
                        console.log('Stopped local track:', track.kind);
                    });
                    this.localStream = null;
                }
                // Hide the persistent local video element only when the stream is fully stopped
                if (this.localVideo) {
                    this.localVideo.srcObject = null;
                    this.localVideo.classList.add('hidden');
                }
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
            if (this.remoteVideo) this.remoteVideo.srcObject = null;
            // NEW: Switch back to text view
            if (this.videoContainer) this.videoContainer.classList.add('hidden');
            if (this.chatScreen) this.chatScreen.classList.remove('in-video-call');
            
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
    
    /** Toggles the local video track on and off. */
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
    
    /** Toggles the local audio track on and off. */
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
    
    // --- UI & Display Management ---

    /**
     * Displays a message in the chat window.
     * @param {string} message - The message content.
     * @param {boolean} isOwn - True if the message is from the current user.
     * @param {number} [timestamp=Date.now()] - The message timestamp.
     * @param {boolean} [isEncrypted=false] - True if the message was E2E encrypted.
     * @param {boolean} [isSystemHtml=false] - True if the message contains trusted system HTML.
     * @param {string|null} [messageId=null] - A unique ID for the message, used for delivery status.
     */
    displayMessage(message, isOwn, timestamp = Date.now(), isEncrypted = false, isSystemHtml = false, messageId = null) {
        // Smart scroll detection: Check if user is near bottom BEFORE adding message
        const threshold = 100; // px
        const isNearBottom = this.chatMessages.scrollHeight - this.chatMessages.scrollTop - this.chatMessages.clientHeight <= threshold;

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isOwn ? 'own' : 'partner'}`;
        if (messageId) {
            messageDiv.dataset.messageId = messageId;
        }
        
        const messageText = document.createElement('div');
        messageText.className = 'message-text';
        if (isSystemHtml) {
            messageText.innerHTML = message; // Only use innerHTML for trusted system messages
        } else {
            messageText.textContent = message; // Use textContent for user input to prevent XSS
        }
        messageDiv.appendChild(messageText);

        // UX: Add a copy button to all messages
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-message-btn';
        copyBtn.innerHTML = '<i class="far fa-copy"></i>';
        copyBtn.setAttribute('aria-label', 'Copy message text');
        copyBtn.title = 'Copy message';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(messageText.textContent).then(() => {
                copyBtn.innerHTML = '<i class="fas fa-check"></i>';
                this.showNotification('Message copied!', 'success');
                setTimeout(() => {
                    copyBtn.innerHTML = '<i class="far fa-copy"></i>';
                }, 1500);
            }).catch(err => {
                this.showNotification('Failed to copy message', 'error');
                console.error('Failed to copy: ', err);
            });
        });
        messageDiv.appendChild(copyBtn);
        
        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-timestamp';
        timeDiv.textContent = new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
        messageDiv.appendChild(timeDiv);

        if (isOwn && messageId) {
            const statusIcon = document.createElement('i');
            statusIcon.className = 'fas fa-clock message-status-icon'; // Pending icon
            statusIcon.setAttribute('aria-label', 'Sending');
            statusIcon.title = 'Sending...';
            timeDiv.prepend(statusIcon);
        }

        if (isEncrypted) {
            const lockIcon = document.createElement('i');
            lockIcon.setAttribute('aria-hidden', 'true');
            lockIcon.className = 'fas fa-lock message-lock-icon';
            lockIcon.title = 'End-to-end encrypted';
            timeDiv.prepend(lockIcon);
        }
        
        this.chatMessages.appendChild(messageDiv);
        
        if (isOwn || isNearBottom) {
            this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
        }
    }

    /** UX: Confirms a message was sent by updating its status icon. */
    confirmMessageSent(messageId) {
        const messageDiv = this.chatMessages.querySelector(`[data-message-id="${messageId}"]`);
        if (messageDiv) {
            const statusIcon = messageDiv.querySelector('.message-status-icon');
            if (statusIcon) {
                statusIcon.className = 'fas fa-check message-status-icon'; // Delivered icon
                statusIcon.setAttribute('aria-label', 'Sent');
                statusIcon.title = 'Sent';
            }
        }
    }
    
    /** Handles the logic for sending 'typing' events. */
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
    
    /** Stops sending 'typing' events. */
    stopTyping() {
        if (this.isTyping) {
            this.isTyping = false;
            this.socket.emit('typing-stop');
        }
        clearTimeout(this.typingTimer);
    }
    
    /** Shows or hides the 'partner is typing' indicator. */
    showTypingIndicator(show) {
        if (show) {
            this.typingIndicator.classList.remove('hidden');
        } else {
            this.typingIndicator.classList.add('hidden');
        }
    }
    
    /** Handles the partner disconnecting from the chat. */
    handlePartnerDisconnect() {
        this.showNotification('Partner disconnected', 'warning');
        this.playSound('disconnect');
        this.resetEncryption();
        this.endCall();
        this.partnerId = null;
        this.roomId = null;
        this.updatePartnerStatus('Disconnected');
        this.showTypingIndicator(false);

        // UX: Disable input and show a message in the chat window for a smoother transition
        this.messageInput.disabled = true;
        this.sendBtn.disabled = true;
        this.displaySystemMessage('Finding a new partner for you in 3 seconds...');

        this.reconnectTimer = setTimeout(() => {
            this.clearChat();
            this.messageInput.disabled = false;
            this.sendBtn.disabled = false;
            this.startChat();
        }, 3000);
    }
    
    /** Clears all messages from the chat window. */
    clearChat() {
        this.chatMessages.innerHTML = `
            <div class="system-message">
                <i class="fas fa-info-circle"></i>
                <span>You're now connected with a stranger. Say hello!</span>
            </div>
        `;
        this.showTypingIndicator(false);
    }

    /** Displays a system message directly in the chat window. */
    displaySystemMessage(message) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'system-message';
        messageDiv.innerHTML = `<i class="fas fa-info-circle"></i> <span>${message}</span>`;
        this.chatMessages.appendChild(messageDiv);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }

    /** Resets the app to the welcome screen and cleans up state. */
    resetToHome() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.resetEncryption();
        this.endCall();
        this.clearChat();
        this.showScreen('welcome');
        this.partnerId = null;
        this.roomId = null;
    }
    
    /** Switches the visible screen in the UI. */
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
    
    /** Updates the global connection status indicator in the header. */
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
    
    /** Updates the partner's status (Online, Disconnected, etc.). */
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
    
    /** Displays a temporary notification toast. */
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        
        const icon = document.createElement('i');
        switch (type) {
            case 'success':
                notification.setAttribute('role', 'status');
                icon.className = 'fas fa-check-circle';
                break;
            case 'warning':
                icon.className = 'fas fa-exclamation-triangle';
                break;
            case 'error':
                notification.setAttribute('role', 'alert');
                icon.className = 'fas fa-times-circle';
                break;
            default:
                notification.setAttribute('role', 'status');
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
    
    /** Plays a sound effect using the Web Audio API. */
    playSound(type) {
        try {
            if (!this.audioContext || this.audioContext.state === 'suspended') {
                this.audioContext?.resume();
            }
            if (!this.audioContext) return;
            const ctx = this.audioContext;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            
            osc.connect(gain);
            gain.connect(ctx.destination);
            
            const now = ctx.currentTime;
            
            switch (type) {
                case 'message':
                    // Soft pop
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(800, now);
                    osc.frequency.exponentialRampToValueAtTime(400, now + 0.1);
                    gain.gain.setValueAtTime(0.1, now);
                    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
                    osc.start(now);
                    osc.stop(now + 0.1);
                    break;
                    
                case 'found':
                    // Success chime
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(440, now); // A4
                    osc.frequency.setValueAtTime(554, now + 0.1); // C#5
                    osc.frequency.setValueAtTime(659, now + 0.2); // E5
                    
                    gain.gain.setValueAtTime(0.05, now);
                    gain.gain.linearRampToValueAtTime(0.1, now + 0.1);
                    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
                    
                    osc.start(now);
                    osc.stop(now + 0.6);
                    break;
                    
                case 'error':
                case 'disconnect':
                    // Subtle low buzz
                    osc.type = 'sawtooth';
                    osc.frequency.setValueAtTime(150, now);
                    osc.frequency.linearRampToValueAtTime(100, now + 0.2);
                    
                    gain.gain.setValueAtTime(0.05, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.2);
                    
                    osc.start(now);
                    osc.stop(now + 0.2);
                    break;
            }
        } catch (error) {
            // Silent fail if audio context is not available
        }
    }
    
    /** Handles the browser window gaining focus. */
    handleWindowFocus() {
        // Resume any paused functionality when window gains focus
        this.stopTitleFlash();
    }
    
    /** Handles the browser window losing focus. */
    handleWindowBlur() {
        // Pause typing when window loses focus
        this.stopTyping();
    }

    /** Makes a DOM element draggable. */
    makeDraggable(element) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        const parent = element.parentElement; // The container to constrain within

        element.onmousedown = dragMouseDown; 

        function dragMouseDown(e) {
            e = e || window.event;
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e = e || window.event;
            e.preventDefault();
            // calculate the new cursor position:
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;

            let newTop = element.offsetTop - pos2;
            let newLeft = element.offsetLeft - pos1;

            // Constrain to parent boundaries
            const parentRect = parent.getBoundingClientRect();
            const elemRect = element.getBoundingClientRect();

            if (newTop < 0) newTop = 0;
            if (newLeft < 0) newLeft = 0;
            if (newTop + elemRect.height > parentRect.height) {
                newTop = parentRect.height - elemRect.height;
            }
            if (newLeft + elemRect.width > parentRect.width) {
                newLeft = parentRect.width - elemRect.width;
            }

            element.style.top = newTop + "px";
            element.style.left = newLeft + "px";
            element.style.right = 'auto'; // Clear right/bottom to allow free movement as we set top/left
            element.style.bottom = 'auto';
        }

        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

    /** Toggles fullscreen mode for the video container. */
    toggleFullscreen() {
        if (!document.fullscreenElement) {
            this.videoContainer.requestFullscreen().catch(err => {
                console.error(`Error attempting to enable fullscreen: ${err.message}`);
            });
        } else {
            document.exitFullscreen();
        }
    }

    /** Populates the emoji picker with a predefined list of emojis. */
    setupEmojiPicker() {
        const emojis = ['😀', '😂', '😍', '😎', '🤔', '😭', '😡', '👍', '👎', '❤️', '🔥', '✨', '👋', '👻', '🎉', '👀', '💯', '💩', '🤡', '🚀'];
        
        emojis.forEach(emoji => {
            const span = document.createElement('span');
            span.textContent = emoji;
            span.className = 'emoji-item';
            span.addEventListener('click', () => {
                this.messageInput.value += emoji;
                this.messageInput.focus();
                this.emojiPicker.classList.add('hidden');
            });
            this.emojiPicker.appendChild(span);
        });

        // Close picker when clicking outside
        document.addEventListener('click', (e) => {
            if (!this.emojiBtn.contains(e.target) && !this.emojiPicker.contains(e.target)) {
                this.emojiPicker.classList.add('hidden');
            }
        });
    }

    /** Toggles the visibility of the emoji picker. */
    toggleEmojiPicker() {
        this.emojiPicker.classList.toggle('hidden');
    }

    /** Flashes the document title to grab the user's attention when the window is not focused. */
    flashTitle(message) {
        if (!document.hidden) return;
        if (this.titleInterval) clearInterval(this.titleInterval);
        
        let isOriginal = true;
        this.titleInterval = setInterval(() => {
            document.title = isOriginal ? message : this.originalTitle;
            isOriginal = !isOriginal;
        }, 1000);
    }

    /** Stops the title from flashing and restores the original title. */
    stopTitleFlash() {
        if (this.titleInterval) {
            clearInterval(this.titleInterval);
            this.titleInterval = null;
            document.title = this.originalTitle;
        }
    }

    // --- Encryption Methods ---

    /**
     * Initializes the E2E encryption by generating an ECDH key pair and exchanging public keys.
     */
    async initEncryption() {
        try {
            this.keyPair = await window.crypto.subtle.generateKey(
                { name: "ECDH", namedCurve: "P-256" },
                true,
                ["deriveKey"]
            );

            const publicKeyJwk = await window.crypto.subtle.exportKey(
                "jwk",
                this.keyPair.publicKey
            );

            this.socket.emit('exchange-key', { key: publicKeyJwk });
        } catch (e) {
            console.error('Encryption setup failed:', e);
        }
    }

    /**
     * Handles the public key from the partner and derives the shared secret.
     */
    async handleKeyExchange(data) {
        if (data.senderId === this.socket.id) return;
        
        try {
            const remoteKey = await window.crypto.subtle.importKey(
                "jwk",
                data.key,
                { name: "ECDH", namedCurve: "P-256" },
                true,
                []
            );

            this.sharedSecret = await window.crypto.subtle.deriveKey(
                { name: "ECDH", public: remoteKey },
                this.keyPair.privateKey,
                { name: "AES-GCM", length: 256 },
                true,
                ["encrypt", "decrypt"]
            );
            
            this.showNotification('🔒 End-to-End Encryption Enabled', 'success');
            this.updateSecurityIcon(true);
        } catch (e) {
            console.error('Key exchange failed:', e);
        }
    }

    /**
     * Encrypts a text message using the shared AES-GCM key.
     * @param {string} text - The plaintext message to encrypt.
     */
    async encryptMessage(text) {
        try {
            const enc = new TextEncoder();
            const encoded = enc.encode(text);
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            
            const ciphertext = await window.crypto.subtle.encrypt(
                { name: "AES-GCM", iv: iv },
                this.sharedSecret,
                encoded
            );

            const ivStr = btoa(String.fromCharCode(...iv));
            const contentStr = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
            
            return JSON.stringify({ iv: ivStr, content: contentStr });
        } catch (e) {
            console.error('Encryption failed:', e);
            return null;
        }
    }

    /**
     * Decrypts an incoming message payload.
     * @param {string} encryptedData - The JSON string containing the IV and ciphertext.
     */
    async decryptMessage(encryptedData) {
        try {
            const data = JSON.parse(encryptedData);
            const iv = new Uint8Array(atob(data.iv).split('').map(c => c.charCodeAt(0)));
            const ciphertext = new Uint8Array(atob(data.content).split('').map(c => c.charCodeAt(0)));

            const decrypted = await window.crypto.subtle.decrypt(
                { name: "AES-GCM", iv: iv },
                this.sharedSecret,
                ciphertext
            );

            return new TextDecoder().decode(decrypted);
        } catch (e) {
            // Fail silently if message isn't encrypted or decryption fails
            return null;
        }
    }

    /** Resets all encryption-related state. */
    resetEncryption() {
        this.sharedSecret = null;
        this.keyPair = null;
        this.updateSecurityIcon(false);
    }

    /**
     * Updates the main logo icon to show a lock when encryption is active.
     */
    updateSecurityIcon(isSecure) {
        const logoIcon = document.querySelector('.logo i');
        if (logoIcon) {
            if (isSecure) {
                logoIcon.className = 'fas fa-lock';
                logoIcon.style.color = 'var(--success-color)';
                logoIcon.style.textShadow = '0 0 10px rgba(0, 255, 136, 0.3)';
            } else {
                logoIcon.className = 'fas fa-shield-alt';
                logoIcon.style.color = '';
                logoIcon.style.textShadow = '';
            }
        }
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SecureChat();
    // Disable start buttons until terms are checked
    const termsCheckbox = document.getElementById('termsCheckbox');
    document.getElementById('startChatBtn').disabled = !termsCheckbox.checked;
    document.getElementById('startVideoChatBtn').disabled = !termsCheckbox.checked;
});

// PWA capabilities can be added later with proper service worker implementation
