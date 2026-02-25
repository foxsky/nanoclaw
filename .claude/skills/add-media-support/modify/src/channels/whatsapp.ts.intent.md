# Intent: src/channels/whatsapp.ts modifications

## What this skill adds
Added media download support. When a WhatsApp message contains an image or document (PDF, DOCX, etc.), it is downloaded, saved to the group's `media/` directory, and an informational annotation is prepended to the message content.

## Key sections

### Imports (top of file)
- Added: `isMediaMessage`, `getMediaType`, `downloadAndSaveMedia` from `../media.js`
- Added: `GROUPS_DIR` to the existing `../config.js` import

### Content extraction chain
- Added: `msg.message?.documentMessage?.caption` to the content extraction chain so document captions are preserved

### messages.upsert handler (inside connectInternal)
- Added: media handling block after the voice transcription block and before `this.opts.onMessage()`
- Uses `isMediaMessage(msg)` to detect supported media types (images, PDFs, documents)
- Resolves per-group media directory via `groups[chatJid].folder` and `GROUPS_DIR`
- Calls `downloadAndSaveMedia(msg, mediaDir, this.sock)` to download and save
- Prepends `[Media: {type} at /workspace/group/media/{filename}]` annotation to `finalContent`
- On download failure: prepends `[Media: {type} — download failed]` annotation instead

## Invariants
- Media processing only runs inside the existing `if (groups[chatJid])` branch.
- Annotation format stays informational-only: `[Media: {type} at /workspace/group/media/{filename}]`.
- Download failures are non-fatal and only affect annotation text.

## Must-keep sections
- All existing message handling (conversation, extendedTextMessage, imageMessage caption, videoMessage caption, documentMessage caption) unchanged
- Voice transcription block (isVoiceMessage, transcribeAudioMessage) unchanged
- Connection lifecycle (connect, reconnect, disconnect) unchanged
- LID translation logic unchanged
- Outgoing message queue unchanged
- Group metadata sync unchanged
- sendMessage prefix logic unchanged
- setTyping, ownsJid, isConnected — all unchanged
