# Intent: src/channels/whatsapp.ts modifications

## What this skill adds
Unified media pipeline for image vision and PDF/document handling. Image messages are processed through sharp (download, resize, save to attachments/). PDF and document messages are saved to attachments/ with a pdf-reader usage hint. The media guard is updated to cover all three media categories.

## Key sections

### Imports (top of file)
- Added: `isImageMessage`, `processImage` from `../image.js`
- Added: `downloadMediaMessage` from `@whiskeysockets/baileys`
- Kept: `isMediaMessage`, `getMediaType`, `downloadAndSaveMedia` from `../media.js`
- Kept: `GROUPS_DIR` in the existing `../config.js` import

### Content extraction chain
- Kept: `msg.message?.documentMessage?.caption` in the content extraction chain so document captions are preserved

### messages.upsert handler (inside connectInternal)
- Image messages: detected via `isImageMessage(msg)`, downloaded via `downloadMediaMessage`, processed through sharp pipeline (`processImage` resizes and saves to `attachments/` directory), annotation prepended with path to saved image
- PDF/document messages: detected via `isMediaMessage(msg)`, saved to `attachments/` directory (not `media/`), annotation includes `pdf-reader extract` usage hint so the agent knows how to read PDF contents
- Guard updated: `!isImageMessage(msg)` added alongside `!isVoiceMessage(msg)` and `!isMediaMessage(msg)` to skip non-content messages

## Invariants
- Media processing only runs inside the existing `if (groups[chatJid])` branch.
- Image annotation format: `[Image: /workspace/group/attachments/{filename}]`.
- PDF annotation format includes `pdf-reader extract` usage hint.
- Download/processing failures are non-fatal and only affect annotation text.

## Must-keep sections
- All existing message handling (conversation, extendedTextMessage, imageMessage caption, videoMessage caption, documentMessage caption) unchanged
- Voice transcription block (isVoiceMessage, transcribeAudioMessage) unchanged
- Connection lifecycle (connect, reconnect, disconnect) unchanged
- LID translation logic unchanged
- Outgoing message queue unchanged
- Group metadata sync unchanged
- sendMessage prefix logic unchanged
- setTyping, ownsJid, isConnected — all unchanged
