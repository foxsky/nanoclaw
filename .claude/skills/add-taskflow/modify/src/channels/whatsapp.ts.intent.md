# Intent: src/channels/whatsapp.ts modifications

## What changed
Added optional `sender` parameter to `sendMessage()` so TaskFlow groups can use their per-group trigger name (e.g., "Case") instead of the global `ASSISTANT_NAME` (e.g., "Kipp") as the message prefix.

## Key sections

### sendMessage method
- Added: `sender?: string` parameter to method signature
- Added: `const displayName = sender?.trim() || ASSISTANT_NAME;` to resolve the display name
- Changed: prefix uses `displayName` instead of `ASSISTANT_NAME`

## Invariants (must-keep)
- All existing message handling (messages.upsert handler) unchanged
- Connection lifecycle (connect, reconnect, disconnect) unchanged
- LID translation logic unchanged
- Outgoing message queue unchanged
- Group metadata sync unchanged
- setTyping, ownsJid, isConnected unchanged
- ASSISTANT_HAS_OWN_NUMBER conditional prefix logic unchanged (just uses displayName instead of ASSISTANT_NAME)
