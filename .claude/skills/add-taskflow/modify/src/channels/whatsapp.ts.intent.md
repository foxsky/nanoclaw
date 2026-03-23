# Intent: src/channels/whatsapp.ts modifications

## What changed
Added optional `sender` parameter to `sendMessage()` so TaskFlow groups can use their per-group trigger name (e.g., "Case") instead of the global `ASSISTANT_NAME` (e.g., "Kipp") as the message prefix.

## Key sections

### sendMessage method
- Added: `sender?: string` parameter to method signature
- Added: `const displayName = sender?.trim() || ASSISTANT_NAME;` to resolve the display name
- Changed: prefix uses `displayName` instead of `ASSISTANT_NAME`

### resolvePhoneJid method
- Added: `resolvePhoneJid(phone: string)` — resolves a phone number to a WhatsApp JID using `sock.onWhatsApp()`
- Fallback: returns `phone@s.whatsapp.net` if not found on WhatsApp

### createGroup method
- Added: `createGroup(subject, participants)` — creates a WhatsApp group using `sock.groupCreate()`
- Returns `{ jid, subject, inviteLink?, droppedParticipants? }` for IPC plugin use
- Participant verification: checks by count first (avoids LID JID false misses), then falls back to JID matching with `p.phoneNumber`/`p.lid` from metadata
- 2-second delay before verification to let WhatsApp propagate additions
- Generates invite link only when participant count truly doesn't match

### Voice message transcription (from voice-transcription skill)
- Imports: `isVoiceMessage`, `transcribeAudioMessage` from `../transcription.js`
- In messages.upsert handler: voice messages (`ptt=true`) are allowed through even without text content
- Voice messages are transcribed via OpenAI Whisper and stored as `[Voice: <transcript>]`
- Fallback messages for unavailable/failed transcription

### DM message handling
- DMs (non-group chats) are also stored so `getDmMessages()` can find inbound messages from external meeting participants

### Multi-trigger bot detection
- Bot message detection checks all registered group triggers, not just `ASSISTANT_NAME`

## Invariants (must-keep)
- Connection lifecycle (connect, reconnect, disconnect) unchanged
- LID translation logic unchanged
- Outgoing message queue unchanged
- Group metadata sync unchanged
- setTyping, ownsJid, isConnected unchanged
- ASSISTANT_HAS_OWN_NUMBER conditional prefix logic unchanged (just uses displayName instead of ASSISTANT_NAME)
