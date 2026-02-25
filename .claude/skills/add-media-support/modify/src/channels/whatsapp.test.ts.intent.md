# Intent: src/channels/whatsapp.test.ts modifications

## What this skill adds
Added mock for the media module and 6 new test cases for media download handling.

## Key sections

### Mocks (top of file)
- Added: `vi.mock('../media.js', ...)` with `isMediaMessage`, `getMediaType`, and `downloadAndSaveMedia` mocks
- Added: `GROUPS_DIR` to the config mock
- Added: `import { downloadAndSaveMedia } from '../media.js'` for test assertions

### Test cases (inside "message handling" describe block)
- Added: "downloads image and prepends annotation" — expects `[Media: image at /workspace/group/media/msg-img.jpeg]`
- Added: "downloads PDF and prepends document annotation" — expects `[Media: document at /workspace/group/media/msg-doc-itinerary.pdf]`
- Added: "preserves caption with media annotation" — expects annotation prepended to caption text
- Added: "text-only messages are unaffected by media handling" — expects `downloadAndSaveMedia` NOT called
- Added: "handles media download failure gracefully" — expects `[Media: image — download failed]`
- Added: "voice notes (PTT audio) are NOT treated as media" — expects transcription, not media download
- Added: "extracts caption from documentMessage" — expects both `[Media: document at ...]` annotation and caption text
- Changed: "extracts caption from imageMessage" — now expects content containing caption (media annotation may be prepended)

## Invariants
- Media tests remain unit-level and rely on mocks, not network I/O.
- Existing test helper flow (`connectChannel`, `triggerMessages`) remains unchanged.
- Voice message behavior remains validated independently from media logic.

## Must-keep sections
- All existing test cases for text, extendedTextMessage, videoMessage unchanged
- All voice transcription tests unchanged
- All connection lifecycle tests unchanged
- All LID translation tests unchanged
- All outgoing queue tests unchanged
- All group metadata sync tests unchanged
- All ownsJid and setTyping tests unchanged
- All existing mocks (config, logger, db, fs, child_process, baileys, transcription) unchanged
- Test helpers (createTestOpts, triggerConnection, triggerDisconnect, triggerMessages, connectChannel) unchanged
