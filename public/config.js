/*
 * SecureChat runtime configuration.
 *
 * transport:
 *   'auto'   – use the Node server if this site is served by it (GET health answers "OK"),
 *              otherwise run serverless (GitHub Pages, any static host).
 *   'socket' – force the Node/Socket.IO server.
 *   'mqtt'   – force serverless mode (matchmaking + signalling over a public MQTT broker).
 *
 * Add a TURN server to iceServers if people behind strict NATs cannot connect video.
 */
window.SECURECHAT_CONFIG = {
  transport: 'auto',
  namespace: 'securechat-0x0806/v1',
  brokers: [
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://broker.emqx.io:8084/mqtt'
  ],
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ]
};
