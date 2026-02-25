---
name: add-media-support
description: Download images, PDFs, and documents from WhatsApp messages. Makes media files available to agents at /workspace/group/media/. No external API keys needed.
---

# Add Media Support

This skill adds automatic media download support to NanoClaw's WhatsApp channel. When a user sends an image (JPEG, PNG, WebP, GIF) or document (PDF, DOCX, DOC, XLSX), it is downloaded, saved to the group's `media/` directory, and the agent receives an annotation like `[Media: image at /workspace/group/media/filename.jpeg]`.

Videos, audio, and stickers are excluded — audio is handled by `/add-voice-transcription`, video files are too large for agents to process, and stickers are decorative.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `media-support` is in `applied_skills`, skip to Phase 4 (Verify). The code changes are already in place.

### Check dependency

Read `.nanoclaw/state.yaml`. If `voice-transcription` is NOT in `applied_skills`, stop and tell the user:

> Media support requires voice transcription to be applied first. Run `/add-voice-transcription` before continuing.

Media support's modify file depends on the `finalContent` pattern and the `!content` guard removal that voice-transcription introduces.

### Validate merge-safety prerequisite

Before applying, verify the voice-transcription modify file includes the WA Web version fetch safeguard:

```bash
grep -q 'fetchLatestWaWebVersion' .claude/skills/add-voice-transcription/modify/src/channels/whatsapp.ts && echo "OK" || echo "FAIL: update voice-transcription modify file first"
```

If this prints `FAIL`, stop and update the voice-transcription modify file first.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet, initialize from the NanoClaw project root:

```bash
npx tsx -e "import { initNanoclawDir } from './skills-engine/index.js'; initNanoclawDir();"
```

> **WARNING:** Do NOT use `npx tsx scripts/apply-skill.ts --init` — the `--init` flag does not exist in `apply-skill.ts`.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-media-support
```

This deterministically:
- Adds `src/media.ts` (media download module with MIME allowlist, quota, path sanitization)
- Three-way merges media handling into `src/channels/whatsapp.ts` (isMediaMessage check, downloadAndSaveMedia call, annotation prepend)
- Three-way merges media tests into `src/channels/whatsapp.test.ts` (mock + 6 test cases)
- Records the application in `.nanoclaw/state.yaml`

No new npm dependencies needed — media support uses Baileys' `downloadMediaMessage` which is already installed.

If the apply reports merge conflicts, read the intent files:
- `modify/src/channels/whatsapp.ts.intent.md` — what changed and invariants for whatsapp.ts
- `modify/src/channels/whatsapp.test.ts.intent.md` — what changed for whatsapp.test.ts

### Validate code changes

```bash
npx vitest run --config vitest.skills.config.ts .claude/skills/add-media-support/tests/media.test.ts
npx vitest run src/channels/whatsapp.test.ts
npm run build
```

All tests must pass (including the 6 new media test cases) and build must be clean before proceeding.

## Phase 3: Configure

No configuration required — media support uses the existing WhatsApp connection. Unlike voice transcription which requires an OpenAI API key, media support has no external dependencies.

### Build and restart

```bash
npm run build
./container/build.sh  # Rebuild agent container with new media module
systemctl --user restart nanoclaw  # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

### Test with an image

Send an image (JPEG or PNG) to any registered WhatsApp group. The agent should receive a message containing:

```
[Media: image at /workspace/group/media/<msgid>.jpeg]
```

If the image has a caption, both the annotation and caption should be present:

```
[Media: image at /workspace/group/media/<msgid>.jpeg]
Look at this restaurant!
```

### Test with a document

Send a PDF to a registered group. The agent should receive:

```
[Media: document at /workspace/group/media/<msgid>-filename.pdf]
```

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i media
```

Look for:
- `Media download error` — download failure (network, timeout, or encryption key issue)
- `Media directory quota exceeded` — group has >500MB of media files
- `Media file too large` — file exceeds 25MB limit
- `Rejected media with disallowed MIME type` — unsupported file type was blocked

## Security Notes

- **MIME allowlist:** Only known-safe types are accepted. SVG (script execution risk), text/plain (prompt injection risk), executables, archives, and unknown types are rejected.
- **Path sanitization:** Filenames are stripped of path separators and special characters to prevent directory traversal.
- **Size limits:** 25MB per file, 500MB per group directory.
- **Download timeout:** 60-second timeout prevents hanging downloads from blocking message processing.
- **Annotations are data-only:** The `[Media: ...]` annotation is informational — it does not trigger any tool execution or special behavior.

## Troubleshooting

### Agent doesn't see media files

1. Verify the group's `media/` directory exists: `ls groups/<folder>/media/`
2. Check the container can access it: the group folder is mounted at `/workspace/group/` — media is at `/workspace/group/media/`
3. Check logs for download errors

### Media downloads fail silently

Check if the WhatsApp media encryption keys expired. Baileys uses `reuploadRequest` to refresh keys — this requires an active socket connection. If the bot was offline when the media was sent, the keys may have expired by the time it reconnects.

### Disk space issues

Run cleanup of old media files. Media older than 30 days can be safely deleted:

```bash
find groups/*/media/ -type f -mtime +30 -delete
```
