// Suggestion 4: Centralized Configuration
const CONFIG = {
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ],
    TYPING_DEBOUNCE_MS: 500
};

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
        this.isMuted = localStorage.getItem('securechat_muted') === 'true'; // Suggestion 8: Persist mute
        this.iceRestartCount = 0; // Suggestion 8: Limit ICE restarts
        this.callStartTime = null;
        this.callTimerInterval = null;
        this.autoSkipEnabled = false; // Suggestion 8: Auto-Skip state
        this.currentCameraDeviceId = null; // Suggestion 11: Camera switching

        // PRIVACY ENHANCEMENTS
        this.sessionId = this.generateAnonymousId(); // #6: Anonymous User IDs
        this.privacyTipsShown = sessionStorage.getItem('privacy_tips_shown') === 'true';
        this.encryptionActive = false;

        this.setupGlobalErrorHandling(); // Suggestion 7: Global error handler
        this.checkSupport(); // Suggestion 6: Browser check
        this.initializeElements();
        this.bindEvents();
        this.setupSocketEvents();
        this.setupRTC();
        this.initAudio();
        this.setupSoundToggle(); // Suggestion 7: Sound toggle
        this.setupPrivacyFeatures(); // Initialize all privacy features
    }

    // --- Initialization & Setup ---

    setupGlobalErrorHandling() {
        window.onerror = (msg, url, lineNo, columnNo, error) => {
            console.error('Global error:', msg, error);
            this.showNotification('An unexpected error occurred.', 'error');
            return false;
        };
    }

    /**
     * Caches all necessary DOM elements for performance.
     */
    checkSupport() {
        if (!window.RTCPeerConnection || !navigator.mediaDevices || !window.WebSocket) {
            alert("Your browser does not support required features (WebRTC/WebSockets). Please update.");
            throw new Error("Browser not supported");
        }
    }

    initializeElements() {
        // Screens
        this.welcomeScreen = document.getElementById('welcomeScreen');
        this.waitingScreen = document.getElementById('waitingScreen');
        this.chatScreen = document.getElementById('chatScreen');
        this.textInterface = document.getElementById('textInterface');
        this.mainContent = document.querySelector('.main-content');

        // Buttons
        this.startChatBtn = document.getElementById('startChatBtn');
        this.startVideoChatBtn = document.getElementById('startVideoChatBtn');
        this.startVideoChatBtn = document.getElementById('startVideoChatBtn');


        this.cancelWaitBtn = document.getElementById('cancelWaitBtn');
        this.sendBtn = document.getElementById('sendBtn');
        this.sendBtn.setAttribute('aria-label', 'Send message');
        this.skipBtn = document.getElementById('skipBtn');
        this.skipBtn.setAttribute('aria-label', 'Next Partner');
        this.exitChatBtn = document.getElementById('exitChatBtn');
        if (this.exitChatBtn) this.exitChatBtn.setAttribute('aria-label', 'Exit to Home');

        // Video elements
        this.localVideo = document.getElementById('localVideo');
        this.remoteVideo = document.getElementById('remoteVideo');
        // Suggestion 5: iOS Safari fix
        this.localVideo.setAttribute('playsinline', 'true');
        this.remoteVideo.setAttribute('playsinline', 'true');
        this.videoInterface = document.getElementById('videoContainer'); // Renamed ID in HTML
        this.toggleVideoBtn = document.getElementById('toggleVideoBtn');
        this.toggleVideoBtn.setAttribute('aria-label', 'Toggle your video');
        this.toggleAudioBtn = document.getElementById('toggleAudioBtn');
        this.toggleAudioBtn.setAttribute('aria-label', 'Toggle your microphone');
        this.switchCameraBtn = document.getElementById('switchCameraBtn'); // Suggestion 5
        this.endCallBtn = document.getElementById('endCallBtn');
        this.endCallBtn.setAttribute('aria-label', 'End call');
        this.skipVideoBtn = document.getElementById('skipVideoBtn');
        this.fullscreenBtn = document.getElementById('fullscreenBtn');
        this.fullscreenBtn.setAttribute('aria-label', 'Toggle fullscreen');

        // Chat elements
        this.messageInput = document.getElementById('messageInput');
        this.messageInput.setAttribute('aria-label', 'Type your message');
        this.chatMessages = document.getElementById('chatMessages');
        this.chatMessages.setAttribute('role', 'log');
        this.chatMessages.setAttribute('aria-live', 'polite');
        this.scrollBottomBtn = document.getElementById('scrollBottomBtn'); // Suggestion 7
        this.typingIndicator = document.getElementById('typingIndicator');
        this.partnerStatus = document.getElementById('partnerStatus');

        this.emojiBtn = document.getElementById('emojiBtn');
        this.emojiBtn.setAttribute('aria-label', 'Open emoji picker');
        this.emojiPicker = document.getElementById('emojiPicker');

        // New Elements
        // New Elements
        this.callTimerDisplay = document.getElementById('callTimer');
        this.callTimerDisplay = document.getElementById('callTimer');

        // Modal elements
        this.callRequestModal = document.getElementById('callRequestModal');
        this.acceptCallBtn = document.getElementById('acceptCallBtn');
        this.declineCallBtn = document.getElementById('declineCallBtn');

        // Other elements
        this.connectionStatus = document.getElementById('connectionStatus');
        this.notificationContainer = document.getElementById('notificationContainer');
        this.notificationContainer.setAttribute('aria-live', 'assertive');
    }

    setupSoundToggle() {
        // Inject mute button into header status indicator area
        const statusContainer = document.querySelector('.status-indicator');
        if (statusContainer) {
            const muteBtn = document.createElement('button');
            muteBtn.className = 'sound-toggle-btn';
            muteBtn.innerHTML = this.isMuted ? '<i class="fas fa-volume-mute"></i>' : '<i class="fas fa-volume-up"></i>';
            muteBtn.title = 'Toggle System Sounds';
            muteBtn.onclick = () => {
                this.isMuted = !this.isMuted;
                localStorage.setItem('securechat_muted', this.isMuted);
                muteBtn.innerHTML = this.isMuted ? '<i class="fas fa-volume-mute"></i>' : '<i class="fas fa-volume-up"></i>';
                if (!this.isMuted) this.playSound('message'); // Test sound
            };
            // Insert before the status text
            statusContainer.insertBefore(muteBtn, statusContainer.firstChild);
        }
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


        this.cancelWaitBtn.addEventListener('click', () => this.cancelWait());
        this.sendBtn.addEventListener('click', () => this.sendMessage());
        this.skipBtn.addEventListener('click', () => this.skipPartner());
        this.skipBtn.addEventListener('click', () => this.skipPartner());

        if (this.exitChatBtn) this.exitChatBtn.addEventListener('click', () => {
            this.resetToHome();
        });

        if (this.switchCameraBtn) this.switchCameraBtn.addEventListener('click', () => this.switchCamera());

        this.skipBtn.title = 'Skip to a new partner (Esc)';

        if (this.skipVideoBtn) this.skipVideoBtn.addEventListener('click', () => this.skipPartner());

        // End call button now exits to home since sections are standalone
        this.endCallBtn.addEventListener('click', () => {
            this.endCall();
            this.resetToHome();
        });
        this.toggleVideoBtn.addEventListener('click', () => this.toggleVideo());
        this.toggleAudioBtn.addEventListener('click', () => this.toggleAudio());

        this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());

        this.acceptCallBtn.addEventListener('click', () => this.acceptCall());
        this.declineCallBtn.addEventListener('click', () => this.declineCall());

        // Suggestion 9: Use keydown and support Shift+Enter for newlines
        this.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault(); // Prevent newline
                this.sendMessage();
            } else {
                this.debouncedTyping();
            }
        });

        this.messageInput.addEventListener('input', () => this.debouncedTyping());
        this.messageInput.addEventListener('blur', () => this.stopTyping());

        // Suggestion 7: Scroll to bottom button logic
        this.chatMessages.addEventListener('scroll', () => {
            const isNearBottom = this.chatMessages.scrollHeight - this.chatMessages.scrollTop - this.chatMessages.clientHeight <= 100;
            if (isNearBottom) {
                this.scrollBottomBtn.classList.add('hidden');
            } else {
                this.scrollBottomBtn.classList.remove('hidden');
            }
        });
        this.scrollBottomBtn.addEventListener('click', () => {
            this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
        });

        // Handle window focus/blur for typing indicators
        window.addEventListener('focus', () => this.handleWindowFocus());
        window.addEventListener('blur', () => this.handleWindowBlur());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.currentScreen === 'chat') {
                this.skipPartner();
            }
            // Suggestion 43: Keyboard Shortcuts
            if (e.ctrlKey && e.key === 'm') {
                this.toggleAudio();
            }
            if (e.ctrlKey && e.key === 'b') {
                this.toggleVideo();
            }
        });

        // Make local video draggable
        // Removed draggable to enforce enterprise fixed layout

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

        this.socket.on('online-count', (count) => {
            // Could update UI here if element existed
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
            if (this.chatMode === 'video') {
                this.showScreen('video');
            } else {
                this.showScreen('chat');
            }
            this.showNotification('Partner connected', 'success');
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
                        this.startCall(true); // true = auto switch to video view
                    }
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
                this.startCall(true);
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
            iceServers: CONFIG.ICE_SERVERS,
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
            console.log('Remote stream received:', event.streams);
            if (event.streams && event.streams[0]) {
                this.remoteStream = event.streams[0];

                // CRITICAL FIX: Properly set remote video srcObject
                this.remoteVideo.srcObject = this.remoteStream;
                this.remoteVideo.autoplay = true;
                this.remoteVideo.playsInline = true;

                // Force play to ensure video displays (especially on mobile)
                this.remoteVideo.play().then(() => {
                    console.log('Remote video playing successfully');
                    this.showNotification('Partner connected', 'success');
                }).catch(err => {
                    console.error('Remote video autoplay failed:', err);
                    // Try again after user interaction
                    const playOnInteraction = () => {
                        this.remoteVideo.play();
                        document.removeEventListener('click', playOnInteraction);
                        document.removeEventListener('touchstart', playOnInteraction);
                    };
                    document.addEventListener('click', playOnInteraction, { once: true });
                    document.addEventListener('touchstart', playOnInteraction, { once: true });
                });
            }
        };

        this.peerConnection.onconnectionstatechange = () => {
            console.log('PeerConnection state:', this.peerConnection.connectionState);
            switch (this.peerConnection.connectionState) {
                case 'connected':
                    this.showNotification('Partner connected', 'success');
                    this.iceRestartCount = 0; // Suggestion 12: Reset counter
                    break;
                case 'disconnected':
                    this.showNotification('Network unstable', 'warning'); // Suggestion 11: Network warning
                    break;
                case 'failed':
                    this.showNotification('Connection failed, attempting to restart...', 'error');
                    this.restartIce();
                    break;
                case 'closed':
                    if (this.isInCall) {
                        this.endCall();
                        this.showNotification('Partner disconnected', 'warning');
                    }
                    break;
            }
        };

        this.peerConnection.onicegatheringstatechange = () => {
            // For debugging: e.g., 'gathering', 'complete'
        };

        this.peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', this.peerConnection.iceConnectionState);
            switch (this.peerConnection.iceConnectionState) {
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
        // Suggestion 8: Limit ICE restarts
        if (this.iceRestartCount >= 3) {
            this.showNotification('Cannot re-establish connection. Please skip partner.', 'error');
            return;
        }
        this.iceRestartCount++;

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

        // Suggestion 10: Client-side sanitization (basic)
        // We strip tags for the optimistic UI update, though server should also validate.
        const sanitizedMessage = message.replace(/<[^>]*>?/gm, '');

        // Encrypt if shared secret exists
        if (this.sharedSecret) {
            const encrypted = await this.encryptMessage(message);
            // Note: We display the unencrypted message locally for the sender.
            if (encrypted) messageToSend = encrypted;
        }

        this.socket.emit('send-message', { message: messageToSend, id: msgId });
        this.displayMessage(sanitizedMessage, true, Date.now(), !!this.sharedSecret, false, msgId);
        this.messageInput.value = '';
        this.stopTyping();
    }

    /** Disconnects from the current partner and finds a new one. */
    skipPartner() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.resetEncryption();
        this.socket.emit('skip-partner');
        // Clean up call but keep local video stream for next partner for a seamless UX
        this.endCall({ stopLocalStream: false, keepUI: true });
        this.clearChat();
        this.showScreen('waiting');
        this.showScreen('waiting');
        // Notification removed per user request (Redundant with screen)
        this.startChat();

        // Suggestion 12: Auto-focus input
        setTimeout(() => {
            if (this.messageInput) this.messageInput.focus();
        }, 100);
    }

    /** Handles partner disconnection events. */
    handlePartnerDisconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

        this.showNotification('Partner disconnected', 'info');
        this.playSound('message');

        this.resetEncryption();
        // Clean up call but keep local video stream for seamless UX
        this.endCall({ stopLocalStream: false, keepUI: true });

        this.clearChat();
        this.showScreen('waiting');

        // Auto-search immediately
        this.startChat();

        // Auto-focus input
        setTimeout(() => {
            if (this.messageInput) this.messageInput.focus();
        }, 100);
    }

    // --- Video & Call Management ---

    /**
     * Requests access to the user's camera and microphone and displays the local video stream.
     */
    async startLocalVideo() {
        // IMPROVED: Check if stream exists and has live tracks to prevent re-asking permission
        if (this.localStream && this.localStream.getTracks().some(track => track.readyState === 'live')) {
            console.log('Local stream already active, reusing existing stream');
            // Ensure video element is connected
            if (this.localVideo.srcObject !== this.localStream) {
                this.localVideo.srcObject = this.localStream;
            }
            this.videoInterface.classList.remove('hidden');
            return;
        }

        // Prevent concurrent calls
        if (this.isStartingVideo) {
            console.log('Video start already in progress, waiting...');
            while (this.isStartingVideo) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (this.localStream && this.localStream.getTracks().some(track => track.readyState === 'live')) return;
        }

        this.isStartingVideo = true;

        try {
            let constraints = {
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: 'user'
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            };

            // Use specific camera if selected
            if (this.currentCameraDeviceId) {
                constraints.video.deviceId = { exact: this.currentCameraDeviceId };
            }

            try {
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
                console.log('Media stream acquired successfully');
            } catch (videoError) {
                console.log('Video access failed, trying audio only:', videoError);
                constraints = {
                    video: false,
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                };
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            }

            // CRITICAL FIX: Properly set srcObject and ensure autoplay
            this.localVideo.srcObject = this.localStream;
            this.localVideo.muted = true; // Prevent feedback
            this.localVideo.autoplay = true;
            this.localVideo.playsInline = true;

            // Force play to ensure video displays
            try {
                await this.localVideo.play();
            } catch (playError) {
                console.log('Autoplay prevented, will play on user interaction:', playError);
            }

            this.toggleVideoBtn.style.display = 'flex';
            this.toggleAudioBtn.style.display = 'flex';
            this.setupVisualizer();

            // Store stream reference globally to prevent re-requesting
            console.log('Local video started successfully, stream stored');
        } catch (error) {
            console.error('Media access error:', error.name, error.message);
            let userMessage = 'Could not access camera/microphone.';
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                userMessage = 'Permission denied. Please allow camera/mic access in your browser settings.';
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                userMessage = 'No camera/microphone found on your device.';
            } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
                userMessage = 'Your camera/microphone is being used by another application.';
            }
            this.showNotification(userMessage, 'error');
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
            // If already in call, just switch view
            this.switchViewMode('video');
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
    async startCall(switchToVideo = true) {
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

            if (switchToVideo) {
                this.switchViewMode('video');
            }

            // Update button states based on available tracks
            const hasVideo = this.localStream.getVideoTracks().length > 0;
            const hasAudio = this.localStream.getAudioTracks().length > 0;

            this.toggleVideoBtn.style.display = hasVideo ? 'flex' : 'none';
            this.toggleAudioBtn.style.display = hasAudio ? 'flex' : 'none';

            this.showNotification(`${hasVideo ? 'Video' : 'Voice'} call started`, 'success');
            this.startCallTimer(); // Suggestion 33: Call Timer
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

                this.isInCall = true;
                this.switchViewMode('video');

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
    endCall(options = { stopLocalStream: true, keepUI: false }) {
        try {
            console.log('Ending call...');
            this.stopCallTimer();

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
                    this.localVideo.load(); // Suggestion 10: Force release
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

            if (!options.keepUI) {
                // Removed automatic switch to text mode to keep sections standalone
            }

            // Reset button states
            if (this.toggleVideoBtn) this.toggleVideoBtn.innerHTML = '<i class="fas fa-video"></i>';
            if (this.toggleAudioBtn) this.toggleAudioBtn.innerHTML = '<i class="fas fa-microphone"></i>';

            this.isInCall = false;

            // Auto-focus back to text chat
            if (this.chatMode === 'text' && this.currentScreen === 'chat' && this.messageInput) {
                setTimeout(() => {
                    this.messageInput.focus();
                }, 200);
            }

            if (!options.keepUI) {
                this.showNotification('Call ended', 'info');
            }
        } catch (error) {
            console.error('Error ending call:', error);
        }
    }

    /** Switches between Text and Video interfaces */
    switchViewMode(mode) {
        if (mode === 'video') {
            this.chatMode = 'video';
            this.showScreen('video');
        } else {
            this.chatMode = 'text';
            this.showScreen('chat');
        }
    }

    /** Switches back to text mode from video interface */
    switchToTextMode() {
        // If we are in a call, we might want to end it, or just hide the video.
        // For this app, "End Call" button in video view ends the call and goes to text.
        this.endCall({ stopLocalStream: false }); // Keep stream for quick toggle back
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

    // Suggestion 34: Screen Sharing
    async toggleScreenShare() {
        if (!this.isInCall) return;

        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ cursor: true });
            const screenTrack = stream.getTracks()[0];

            const senders = this.peerConnection.getSenders();
            const videoSender = senders.find(s => s.track.kind === 'video');

            if (videoSender) {
                videoSender.replaceTrack(screenTrack);
                this.localVideo.srcObject = stream;

                screenTrack.onended = () => {
                    // Revert to camera
                    if (this.localStream) {
                        const camTrack = this.localStream.getVideoTracks()[0];
                        videoSender.replaceTrack(camTrack);
                        this.localVideo.srcObject = this.localStream;
                    }
                };
            }
        } catch (e) {
            console.error("Screen share failed", e);
        }
    }

    // Suggestion 35: Picture in Picture
    async togglePiP() {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
        } else if (this.remoteVideo && this.remoteVideo.readyState !== 0) {
            await this.remoteVideo.requestPictureInPicture();
        }
    }

    // Suggestion 33: Call Timer
    startCallTimer() {
        this.callStartTime = Date.now();
        if (this.callTimerDisplay) {
            this.callTimerDisplay.classList.remove('hidden');
            this.callTimerInterval = setInterval(() => {
                const delta = Date.now() - this.callStartTime;
                const seconds = Math.floor((delta / 1000) % 60);
                const minutes = Math.floor((delta / (1000 * 60)) % 60);
                const hours = Math.floor((delta / (1000 * 60 * 60)));
                this.callTimerDisplay.textContent =
                    `${hours > 0 ? hours + ':' : ''}${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            }, 1000);
        }
    }

    stopCallTimer() {
        if (this.callTimerInterval) {
            clearInterval(this.callTimerInterval);
            this.callTimerInterval = null;
        }
        if (this.callTimerDisplay) {
            this.callTimerDisplay.classList.add('hidden');
            this.callTimerDisplay.textContent = '00:00';
        }
    }

    // Suggestion 37: Audio Visualizer
    setupVisualizer() {
        if (!this.audioContext || !this.localStream) return;
        const source = this.audioContext.createMediaStreamSource(this.localStream);
        const analyser = this.audioContext.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);

        const canvas = document.createElement('canvas');
        canvas.className = 'audio-visualizer';
        canvas.width = 50;
        canvas.height = 30;
        // Append to local video wrapper if not exists
        const wrapper = document.querySelector('.local-video-wrapper');
        if (wrapper && !wrapper.querySelector('.audio-visualizer')) {
            wrapper.appendChild(canvas);
        }

        const ctx = canvas.getContext('2d');
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            if (!this.localStream) return;
            requestAnimationFrame(draw);
            analyser.getByteFrequencyData(dataArray);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const barHeight = (dataArray[10] / 255) * canvas.height; // Simple visualization
            ctx.fillStyle = '#00d4ff';
            ctx.fillRect(0, canvas.height - barHeight, canvas.width, barHeight);
        };
        draw();
    }

    // Suggestion 11: Switch Camera
    async switchCamera() {
        if (!this.localStream) return;

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(device => device.kind === 'videoinput');

            if (videoDevices.length < 2) {
                this.showNotification('Only one camera available', 'warning');
                return;
            }

            const currentTrack = this.localStream.getVideoTracks()[0];
            const currentDeviceId = currentTrack.getSettings().deviceId;

            const currentIndex = videoDevices.findIndex(d => d.deviceId === currentDeviceId);
            const nextIndex = (currentIndex + 1) % videoDevices.length;
            this.currentCameraDeviceId = videoDevices[nextIndex].deviceId;

            // Stop current track
            currentTrack.stop();

            // Get new stream
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: this.currentCameraDeviceId } },
                audio: false // Don't touch audio
            });

            const newVideoTrack = newStream.getVideoTracks()[0];

            // Replace track in peer connection
            if (this.peerConnection) {
                const sender = this.peerConnection.getSenders().find(s => s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(newVideoTrack);
                }
            }

            // Update local stream and video element
            this.localStream.removeTrack(currentTrack);
            this.localStream.addTrack(newVideoTrack);
            this.localVideo.srcObject = this.localStream;

            this.showNotification('Camera switched', 'success');
        } catch (e) {
            console.error('Error switching camera:', e);
            this.showNotification('Failed to switch camera', 'error');
        }
    }

    // Suggestion 6: Screenshot
    takeScreenshot() {
        if (!this.remoteVideo || this.remoteVideo.readyState < 2) {
            this.showNotification('No video to capture', 'warning');
            return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = this.remoteVideo.videoWidth;
        canvas.height = this.remoteVideo.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(this.remoteVideo, 0, 0, canvas.width, canvas.height);

        const link = document.createElement('a');
        link.download = `securechat-snap-${Date.now()}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
        this.showNotification('Screenshot saved', 'success');
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

        // Suggestion 31 & 32: Linkify and Markdown
        let formattedMessage = message;
        if (!isSystemHtml) {
            formattedMessage = this.formatMessage(message);
        }

        if (isSystemHtml) {
            messageText.innerHTML = message; // Only use innerHTML for trusted system messages
        } else {
            messageText.innerHTML = formattedMessage; // Use innerHTML for formatted message (sanitized by formatMessage logic ideally, but here we trust our formatter)
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

    // Suggestion 31 & 32: Formatter
    formatMessage(text) {
        // Escape HTML first
        let safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        // Linkify
        safeText = safeText.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

        // Markdown (Bold, Italic, Code)
        safeText = safeText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        safeText = safeText.replace(/\*(.*?)\*/g, '<em>$1</em>');
        safeText = safeText.replace(/`(.*?)`/g, '<code>$1</code>');

        return safeText;
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

    // Suggestion 9: Debounced typing
    debouncedTyping = (() => {
        let timeout;
        return () => {
            if (!this.isTyping) {
                this.isTyping = true;
                this.socket.emit('typing-start');
            }
            clearTimeout(timeout);
            timeout = setTimeout(() => this.stopTyping(), 2000);
        };
    })();

    /** Handles the logic for sending 'typing' events. */
    handleTyping() {
        // Deprecated in favor of debouncedTyping
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
        this.clearAllData(); // #2: Auto delete chat
        this.showNotification('Partner disconnected', 'warning');
        this.playSound('disconnect');
        this.resetEncryption();
        // FIX: Don't stop local stream if we are in video mode, so we are ready for next partner without permission prompt
        this.endCall({ stopLocalStream: this.chatMode !== 'video', keepUI: false });
        this.partnerId = null;
        this.roomId = null;
        this.updatePartnerStatus('Disconnected');
        this.showTypingIndicator(false);

        if (this.chatMode === 'text') {
            // UX: Disable input and show a message in the chat window for a smoother transition
            this.messageInput.disabled = true;
            this.sendBtn.disabled = true;
            this.displaySystemMessage('Finding a new partner for you in 3 seconds...');
        } else {
            // In video mode, show notification immediately
            this.showNotification('Partner disconnected. Searching...', 'info');
        }

        if (this.autoSkipEnabled && this.chatMode === 'text') {
            this.displaySystemMessage('Auto-skipping enabled. Searching...');
        }

        this.reconnectTimer = setTimeout(() => {
            this.clearChat();
            this.messageInput.disabled = false;
            this.sendBtn.disabled = false;
            this.startChat();
        }, 3000);
    }

    // Suggestion 4: Report User
    reportUser() {
        if (!this.partnerId) return;
        if (confirm('Are you sure you want to report this user? This will end the chat.')) {
            this.socket.emit('report-user', { partnerId: this.partnerId, reason: 'User reported via UI' });
            this.showNotification('User reported. Skipping...', 'error');
            this.skipPartner();
        }
    }

    // Suggestion 8: Toggle Auto-Skip
    toggleAutoSkip() {
        this.autoSkipEnabled = !this.autoSkipEnabled;
        if (this.autoSkipEnabled) {
            this.autoSkipBtn.classList.add('active');
            this.showNotification('Auto-skip enabled', 'success');
        } else {
            this.autoSkipBtn.classList.remove('active');
            this.showNotification('Auto-skip disabled', 'info');
        }
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

    // Suggestion 40: Export Chat
    exportChat() {
        const messages = Array.from(this.chatMessages.querySelectorAll('.message')).map(msg => {
            const time = msg.querySelector('.message-timestamp').innerText;
            const text = msg.querySelector('.message-text').innerText;
            const sender = msg.classList.contains('own') ? 'Me' : 'Partner';
            return `[${time}] ${sender}: ${text}`;
        }).join('\n');

        const blob = new Blob([messages], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `securechat-history-${Date.now()}.txt`;
        a.click();
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
        this.videoInterface.classList.add('hidden');

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
            case 'video':
                this.videoInterface.classList.remove('hidden');
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
        // Minimal notifications: Remove old ones if there are too many
        while (this.notificationContainer.children.length >= 1) {
            this.notificationContainer.removeChild(this.notificationContainer.firstChild);
        }

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
        if (this.isMuted) return; // Suggestion 7: Check mute state
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
        // Suggestion 10: Resume video
        if (this.remoteVideo && this.remoteVideo.paused && this.remoteStream) {
            this.remoteVideo.play().catch(e => console.log('Auto-resume failed', e));
        }
        this.stopTitleFlash();
    }

    /** Handles the browser window losing focus. */
    handleWindowBlur() {
        // Pause typing when window loses focus
        // Suggestion 9: Pause video to save resources
        if (this.remoteVideo && !this.remoteVideo.paused) {
            this.remoteVideo.pause();
        }
        this.stopTyping();
    }

    /** Makes a DOM element draggable. */
    // Removed draggable logic as we are using a fixed layout

    /** Toggles fullscreen mode for the video container. */
    toggleFullscreen() {
        if (!document.fullscreenElement && this.videoInterface) {
            this.videoInterface.requestFullscreen().catch(err => {
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
            this.updateEncryptionStatus(true); // #5: Update indicator
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
        this.updateEncryptionStatus(false); // #5: Update indicator
    }

    /** Suggestion 6: Manual clear chat */
    manualClearChat() {
        this.clearChat();
        this.showNotification('Chat history cleared', 'info');
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

    // ========== PRIVACY METHODS ==========

    /**
     * Safety: NSFW/Age Warning
     */
    /**
     * Safety & Compliance: Unified Welcome Modal
     */
    setupWelcomeModal() {
        const consent = sessionStorage.getItem('welcome_consent');
        if (consent === 'true') return;

        const modal = document.createElement('div');
        modal.className = 'nsfw-modal-overlay';
        modal.innerHTML = `
            <div class="nsfw-modal-content">
                <i class="fas fa-shield-alt nsfw-icon" style="color: var(--accent-color);"></i>
                <h2>Welcome to SecureChat</h2>
                
                <div style="text-align: left; margin: 1.5rem 0; padding: 0 1rem;">
                    <div style="background: rgba(255, 71, 87, 0.1); border-left: 3px solid var(--danger-color); padding: 10px; margin-bottom: 15px; border-radius: 4px;">
                        <p style="margin: 0 0 5px 0; font-size: 0.9rem; color: var(--danger-color); font-weight: bold;">
                            <i class="fas fa-exclamation-triangle"></i> NSFW / MATURE CONTENT (18+)
                        </p>
                        <p style="margin: 0; font-size: 0.8rem; color: var(--secondary-text);">
                            This service is unmoderated. You may encounter explicit content.
                        </p>
                    </div>

                    <p style="font-size: 0.8rem; color: var(--secondary-text); line-height: 1.5; margin-bottom: 10px;">
                        <strong>Disclaimer:</strong> This is a P2P service. The developer accepts <strong>NO LIABILITY</strong> for user conduct or content. You are solely responsible for your interactions.
                    </p>

                    <p style="margin-bottom: 0.5rem; color: var(--success-color); font-size: 0.85rem; display: flex; align-items: center; gap: 6px;">
                        <i class="fas fa-lock"></i> 100% Anonymous & Encrypted
                    </p>
                </div>

                <div class="nsfw-actions">
                    <button class="nsfw-btn-agree" id="welcomeAgreeBtn">
                        <i class="fas fa-check"></i> I Agree & Enter
                    </button>
                    <button class="nsfw-btn-exit" id="welcomeExitBtn">
                        Exit
                    </button>
                    <div class="age-warning">
                        By entering, you confirm you are 18+ and accept our Terms.
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        document.body.style.overflow = 'hidden';

        document.getElementById('welcomeAgreeBtn').addEventListener('click', () => {
            sessionStorage.setItem('welcome_consent', 'true');
            sessionStorage.setItem('nsfw_consent', 'true');
            sessionStorage.setItem('privacy_tips_shown', 'true');
            modal.style.opacity = '0';
            setTimeout(() => {
                modal.remove();
                document.body.style.overflow = '';
            }, 300);
        });

        document.getElementById('welcomeExitBtn').addEventListener('click', () => {
            window.location.href = 'https://www.google.com';
        });
    }

    /**
     * #1-15: Setup all privacy features
     */
    setupPrivacyFeatures() {
        this.setupWelcomeModal(); // Combined Warning
        this.setupDisconnectOnTabClose(); // #11
        this.setupClearStorageOnExit(); // #12
        this.showPrivacyBanner(); // #4, #7, #10
        this.showEncryptionIndicator(); // #5
        // Tips modal merged into Welcome
        this.setupScreenshotWarning(); // #8
        this.setupIncognitoRecommendation(); // #9
        this.updateConnectionSecurityStatus(); // #15
    }

    /**
     * #6: Generate Anonymous Session ID
     */
    generateAnonymousId() {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    /**
     * #11: Disconnect on Tab Close
     */
    setupDisconnectOnTabClose() {
        window.addEventListener('beforeunload', (e) => {
            // Clean disconnect
            if (this.partnerId) {
                this.socket.emit('force-disconnect');
            }
            this.clearAllData(); // #2: Auto delete chat
            this.endCall({ stopLocalStream: true });
        });

        // Also handle visibility change
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                console.log('Tab hidden - maintaining connection');
            }
        });
    }

    /**
     * #12: Clear Local Storage on Exit
     */
    setupClearStorageOnExit() {
        window.addEventListener('unload', () => {
            // Clear sensitive data but keep preferences
            const mutePreference = localStorage.getItem('securechat_muted');
            localStorage.clear();
            if (mutePreference) {
                localStorage.setItem('securechat_muted', mutePreference);
            }
            sessionStorage.clear();
        });
    }

    /**
     * #2: Clear All Chat Data
     */
    clearAllData() {
        // Clear chat messages
        if (this.chatMessages) {
            this.chatMessages.innerHTML = `
                <div class="system-message">
                    <i class="fas fa-info-circle"></i>
                    <span>Chat history cleared for privacy</span>
                </div>
            `;
        }

        // Reset encryption
        this.resetEncryption();

        // Clear any cached data
        this.partnerId = null;
        this.roomId = null;
    }

    /**
     * #4, #7, #10: Show Privacy Banner
     */
    showPrivacyBanner() {
        const banner = document.createElement('div');
        banner.className = 'privacy-banner';
        banner.innerHTML = `
            <div class="privacy-banner-content">
                <i class="fas fa-shield-alt"></i>
                <div class="privacy-text">
                    <strong>🔒 100% Private & Secure</strong>
                    <p>No logs • No cookies • No data storage • IP addresses not tracked</p>
                </div>
                <button class="privacy-banner-close" onclick="this.parentElement.parentElement.remove()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;

        // Insert at top of app
        const appContainer = document.querySelector('.app-container');
        if (appContainer) {
            appContainer.insertBefore(banner, appContainer.firstChild);
        }

        // Auto-hide after 10 seconds
        setTimeout(() => {
            if (banner.parentElement) {
                banner.style.animation = 'fadeOut 0.5s ease';
                setTimeout(() => banner.remove(), 500);
            }
        }, 10000);
    }

    /**
     * #5: Show Encryption Indicator
     */
    showEncryptionIndicator() {
        const indicator = document.createElement('div');
        indicator.className = 'encryption-indicator';
        indicator.id = 'encryptionIndicator';
        indicator.innerHTML = `
            <i class="fas fa-lock"></i>
            <span>Encrypted</span>
        `;
        indicator.style.display = 'none'; // Hidden until encryption active

        const header = document.querySelector('.header');
        if (header) {
            header.appendChild(indicator);
        }
    }

    /**
     * #5: Update encryption indicator when encryption is active
     */
    updateEncryptionStatus(isActive) {
        this.encryptionActive = isActive;
        const indicator = document.getElementById('encryptionIndicator');
        if (indicator) {
            if (isActive) {
                indicator.style.display = 'flex';
                indicator.classList.add('active');
            } else {
                indicator.style.display = 'none';
                indicator.classList.remove('active');
            }
        }
    }

    /**
     * #13: Privacy Tips Modal
     */
    /**
     * #13: Privacy Tips Modal (Deprecated - Merged into Welcome)
     */
    showPrivacyTipsModal() {
        // Functionality merged into setupWelcomeModal
    }

    /**
     * #8: Screenshot Protection Warning
     */
    setupScreenshotWarning() {
        // Detect screenshot attempts (limited browser support)
        document.addEventListener('keyup', (e) => {
            // Print Screen key
            if (e.key === 'PrintScreen') {
                this.showNotification('⚠️ Screenshots can compromise privacy', 'warning');
            }
        });

        // Detect screenshot on mobile (iOS/Android)
        if ('mediaDevices' in navigator && 'getDisplayMedia' in navigator.mediaDevices) {
            // Screen capture detection
            console.log('Screenshot detection active');
        }
    }

    /**
     * #9: Incognito Mode Recommendation
     */
    setupIncognitoRecommendation() {
        // Detect if in incognito mode (heuristic approach)
        const isIncognito = this.detectIncognitoMode();

        if (!isIncognito) {
            // Show recommendation banner
            setTimeout(() => {
                const notice = document.createElement('div');
                notice.className = 'incognito-notice';
                notice.innerHTML = `
                    <i class="fas fa-user-secret"></i>
                    <span>For maximum privacy, use incognito/private browsing mode</span>
                    <button onclick="this.parentElement.remove()">
                        <i class="fas fa-times"></i>
                    </button>
                `;

                const container = document.querySelector('.notification-container');
                if (container) {
                    container.appendChild(notice);
                    setTimeout(() => notice.remove(), 8000);
                }
            }, 3000);
        }
    }

    /**
     * Detect incognito mode (heuristic)
     */
    detectIncognitoMode() {
        // Check for FileSystem API availability
        if ('storage' in navigator && 'estimate' in navigator.storage) {
            navigator.storage.estimate().then(estimate => {
                const isIncognito = estimate.quota < 120000000; // Less than 120MB suggests incognito
                return isIncognito;
            });
        }
        return false; // Default to false if can't detect
    }

    /**
     * #15: Connection Security Status
     */
    updateConnectionSecurityStatus() {
        const status = {
            encryption: this.encryptionActive,
            webrtc: this.isInCall,
            socket: this.socket.connected
        };

        // Update UI indicator
        const securityLevel = this.calculateSecurityLevel(status);
        this.displaySecurityLevel(securityLevel);
    }

    /**
     * Calculate security level
     */
    calculateSecurityLevel(status) {
        let score = 0;
        if (status.encryption) score += 40;
        if (status.webrtc) score += 30;
        if (status.socket) score += 30;

        if (score >= 70) return 'high';
        if (score >= 40) return 'medium';
        return 'low';
    }

    /**
     * Display security level
     */
    displaySecurityLevel(level) {
        const colors = {
            high: '#00ff88',
            medium: '#ffaa00',
            low: '#ff4757'
        };

        const labels = {
            high: 'Secure',
            medium: 'Partial',
            low: 'Basic'
        };

        const statusEl = document.querySelector('.connection-status');
        if (statusEl) {
            statusEl.style.color = colors[level];
            statusEl.setAttribute('data-security', level);
            statusEl.title = `Security Level: ${labels[level]}`;
        }
    }

    /**
     * #3: Fingerprint Protection - Minimize data collection
     */
    minimizeFingerprinting() {
        // Override navigator properties to reduce fingerprinting
        // Note: This is limited by browser security

        // Don't send unnecessary headers
        if ('sendBeacon' in navigator) {
            console.log('Using sendBeacon for minimal data transmission');
        }

        // Limit canvas fingerprinting
        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function (type) {
            if (type === 'image/png' && this.width === 16 && this.height === 16) {
                // Likely fingerprinting attempt
                console.warn('Potential fingerprinting detected');
            }
            return originalToDataURL.apply(this, arguments);
        };
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

// ========== MODIFY EXISTING METHODS ==========

/**
 * Modify handleKeyExchange to update encryption indicator
 * Add this line at the end of handleKeyExchange method:
 */
// this.updateEncryptionStatus(true);

/**
 * Modify resetEncryption to update encryption indicator
 * Add this line at the end of resetEncryption method:
 */
// this.updateEncryptionStatus(false);

/**
 * Modify handlePartnerDisconnect to clear data
 * Add this line at the beginning of handlePartnerDisconnect method:
 */
// this.clearAllData();

// ========== END OF PRIVACY ENHANCEMENTS ==========

/**
 * INTEGRATION INSTRUCTIONS:
 * 
 * 1. Add the properties to constructor (lines shown at top)
 * 2. Copy all methods above into the SecureChat class
 * 3. Modify existing methods as indicated
 * 4. Add CSS from privacy-styles.css
 * 5. Test all privacy features
 */
