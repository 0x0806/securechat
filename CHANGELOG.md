# Changelog

## 3.1.0

Legend: ✓ covered by an automated test, ○ implemented but only checked by hand or by code review.
Everything new stays on your device or inside the encrypted chat: no accounts, no stored history, no server database.

### New features (63)

**Matching and rooms**
1. ✓ Interest tags (up to 5). People who share one are matched first.
2. ✓ Language preference (13 languages), also matched first.
3. ✓ Private rooms: create an invite link and only people with it can match each other.
4. ✓ Join a private room with a code or a pasted link.
5. ✓ People you report are never matched with you again in this browser session.
6. ✓ "Clear blocked people" button in Settings.
7. ✓ Live waiting timer.
8. ✓ Rotating safety and usage tips while waiting.
9. ○ "It is quiet right now" hint after 20 seconds of waiting.
10. ✓ Optional: find someone new automatically when your partner leaves.

**Profile**
11. ✓ Optional nickname, shared with your partner inside the encrypted chat.
12. ✓ Avatar picker, shown in the partner's chat header.

**Messaging**
13. ✓ Multi-line messages with Shift+Enter.
14. ✓ The message box grows as you type.
15. ✓ Character counter near the 500 limit.
16. ✓ Formatting: **bold**, *italic*, `code`, ~~strike~~ (built from DOM nodes, never HTML).
17. ✓ Emoji shortcodes such as :fire: and :smile:.
18. ✓ Emoji picker with categories (arrow-key navigation is not covered by a test).
19. ✓ Reactions on messages.
20. ✓ Replies with quoted text.
21. ✓ Read receipts ("Delivered · Seen").
22. ○ Switch to stop sending read receipts.
23. ✓ Photo sharing: compressed in your browser, then encrypted.
24. ✓ Incoming photos stay hidden until you choose to show them (switchable).
25. ✓ Full-size photo viewer.
26. ✓ Quick-reply chips in an empty chat.
27. ✓ "Suggest a topic" icebreaker.
28. ✓ Copy a message.
29. ○ Tap "Retry" on a message that failed to send.
30. ○ "New messages" divider for messages that arrived while the tab was hidden.
31. ✓ Optional filter that hides strong language in incoming messages.
32. ✓ Confirmation before opening links from strangers (switchable).
33. ✓ Switch to hide your typing indicator from your partner.
34. ✓ Slash commands: /shrug /me /flip /roll /topic /clear /help.

**Video and voice**
35. ✓ Blur your partner's video until you choose to show it (switchable per call or by default).
36. ○ Microphone level meter on the mute button.
37. ✓ Partner volume slider.
38. ✓ Connection quality badge (round-trip time and packet loss).
39. ✓ Video quality setting (data saver, standard, high) applied to the sender.
40. ✓ Camera and microphone pickers.
41. ✓ Start calls with your camera off.
42. ✓ Mirror toggle for your own video.
43. ✓ Hide your self-view, or tap it to move it between corners.
44. ✓ Floating call reactions.
45. ○ Screen stays awake during a call.
46. ✓ Camera and microphone test before you start.
47. ✓ Video fit toggle (fill or show everything).
48. ○ Double-click the video for full screen.
49. ○ "Tap to play" fallback when the browser blocks autoplay.

**App**
50. ✓ Settings dialog.
51. ✓ Accent colours.
52. ✓ Text size.
53. ✓ Theme chooser: match device, light or dark.
54. ○ Optional desktop notifications (with no message content).
55. ○ Optional vibration on new messages.
56. ✓ Panic button (Alt+X): leave and hide the chat instantly.
57. ✓ Neutral tab title option ("Notes").
58. ✓ Keyboard shortcuts dialog (press ?), plus Alt+R to report.
59. ✓ Installable app with offline shell.
60. ✓ This-session statistics (kept in memory only).
61. ✓ Reduce-motion switch.
62. ✓ Offline banner.
63. ✓ `/api/stats` on the Node server (online, waiting, active chats).

### Improvements and fixes (53)

**Reliability**
1. ○ Partner timeout raised from 20 s to 75 s so a backgrounded tab is not mistaken for a departed partner.
2. ✓ Closing a tab now flushes the goodbye message (graceful broker shutdown), so the partner is told at once.
3. ○ The goodbye message is sent twice, because one copy can be lost on a flaky link.
4. ○ In a video chat, if your partner's camera fails you now see a clear message instead of an endless "Connecting video…".
5. ○ Stopping a screen share restores the camera on the correct sender.
6. ○ Double-clicking Start no longer opens two camera prompts.
7. ○ "Next person" is debounced.
8. ○ A camera or microphone that is unplugged mid-call is reported.
9. ○ Camera and microphone lists refresh when devices change.
10. ✓ Fixed: a quick second message sent right after the first was silently dropped by a send throttle (found by the new tests). The throttle is gone.
11. ✓ Fixed: an older profile or reaction update could arrive late and overwrite a newer one. Updates are now timestamped (found by the new tests).
12. ✓ Waiting users are re-checked every 2 seconds, so preferences relax on time and nobody waits forever for a perfect match.
13. ✓ Private-room friends can pair again immediately (no rematch cooldown).
14. ✓ Preference scoring picks the best interest overlap among waiting people.
15. ✓ Serverless mode: a partner whose connection dies without saying goodbye is detected within about 7 seconds (MQTT last will, confirmed first so one flaky broker link cannot cause a false alarm).

**Server**
16. ✓ Per-address connection cap.
17. ✓ Reports are rate limited (5 a minute).
18. ✓ Fonts are cached as immutable; scripts and pages revalidate.
19. ○ Longer ping timeout for backgrounded tabs.
20. ○ Clients are told before a server restart.
21. ✓ Interests, language, room and block list are validated and normalised.
22. ✓ Message limit raised deliberately to 150,000 characters for encrypted photos, with a test.
23. ✓ Matching rules live in one shared module used by both the Node server and the serverless transport.
24. ○ Serverless lobby namespace bumped to `v2` so old open tabs cannot match new clients.

**Accessibility and polish**
25. ○ Toasts no longer repeat, pause while hovered and dismiss on click.
26. ○ Dialogs return focus to the control that opened them.
27. ○ Escape closes the emoji picker and returns focus to its button.
28. ○ Enter while using an IME (for example Japanese or Chinese) no longer sends half-typed text.
29. ○ The theme follows your device live until you choose one.
30. ✓ Corrupt or outdated saved settings fall back to safe defaults instead of breaking the app.
31. ○ The composer stays above the on-screen keyboard on phones.
32. ○ Safe-area padding for notched phones.
33. ○ High-contrast (forced colours) support.
34. ○ A clear message when JavaScript is disabled.
35. ○ The message list is capped at 400 items to bound memory in very long chats.
36. ○ Proper ARIA: labelled groups, radio groups for avatars and accents, labelled file input.
37. ○ `<time datetime>` on every message.
38. ○ A notice when pasted text is cut to the 500-character limit.
39. ○ Typing indicator uses your partner's nickname.
40. ○ Friendly 404 page for GitHub Pages.
41. ○ `robots.txt`.
42. ✓ Web app manifest, icons and Apple touch icon.
43. ✓ Service worker is network-first and never touches brokers, `api/` or `socket.io/`, so a new deploy is never hidden behind a stale cache.
44. ○ Clear message and disabled buttons when the page is not on HTTPS (encryption unavailable) or the browser has no camera support.

**Safety**
45. ✓ Nicknames are stripped of control characters and angle brackets.
46. ○ Incoming photos must be strict JPEG data URLs under a size cap or they are dropped.
47. ✓ Unsupported or oversized image files are rejected with a clear error.
48. ✓ Safer defaults: photos hidden until shown, link confirmation on.
49. ○ The interface no longer mentions how the project is licensed or hosted.

**Testing and tooling**
50. ✓ `npm run check` syntax-checks every script.
51. ○ CI runs the syntax check and all server tests.
52. ✓ The browser suite now fails on console errors from any page, not just one.
53. ✓ The browser suite prints the failing line and page state for each failed check.

## 3.0.0

Serverless GitHub Pages mode, consent gate, new design, video and text chat, end-to-end encrypted text. See the README.
