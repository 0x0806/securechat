# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub:
**[Report a vulnerability](https://github.com/0x0806/securechat/security/advisories/new)**.

Do not open a public issue for anything that could put users at risk. Include what you found, how to reproduce it, and the impact you expect. You should get a first reply within 7 days. Once a fix ships, you are welcome to be credited in the advisory.

The machine-readable contact is at <https://securechat.online/.well-known/security.txt> (RFC 9116).

## Supported versions

Only the latest release on `main` (deployed at <https://securechat.online/>) is supported.

## Scope

In scope: the web client in `public/`, the Node.js server in `index.js`, and the deployment configuration in this repository.

Out of scope: the public MQTT brokers and STUN servers the site connects to, denial of service through volume alone, and reports that need a compromised device or browser.

## Security model in brief

- Text messages are end-to-end encrypted: ECDH (P-256) key agreement and AES-256-GCM via the Web Crypto API. The key exchange is relayed, so users compare a safety code to rule out a man-in-the-middle.
- Video and audio use WebRTC (DTLS-SRTP) peer to peer. Each side learns the other's IP address.
- No database, no accounts, no message history.
- Strict Content Security Policy with no inline script or style and no third-party scripts.
- On GitHub Pages, response headers cannot be set, so HSTS, `X-Frame-Options` and `frame-ancestors` are not available there. The client refuses to run inside a frame instead. The self-hosted Node server sends the full header set (CSP, HSTS, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `X-Content-Type-Options` and more).

The README section "Security and privacy, honestly" covers the trade-offs in more detail.
