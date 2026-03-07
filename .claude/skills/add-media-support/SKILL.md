---
name: add-media-support
description: Unified media pipeline for WhatsApp — image vision (sharp + base64 multimodal), PDF text extraction (poppler-utils + pdf-reader), and document downloads. Files saved to attachments/ directory.
---

# Add Media Support

This skill adds a unified media pipeline to NanoClaw's WhatsApp channel. When a user sends an image, PDF, or document, the file is downloaded and saved to the group's `attachments/` directory, and the agent receives a typed annotation.

- **Images** (JPEG, PNG, WebP, GIF): Processed by `src/image.ts` using sharp — resized to 1024px max dimension, converted to JPEG, saved to `attachments/`. The host parses `[Image: attachments/filename.jpg]` references and injects the image as a base64 multimodal content block into the Claude API call, so the agent actually sees the image.
- **PDFs**: Downloaded via `downloadAndSaveMedia` from `src/media.ts`, saved to `attachments/`. Produces `[PDF: attachments/filename.pdf (SIZE KB)]`. The container includes `poppler-utils` and `pdf-reader` CLI for text extraction.
- **Documents** (DOCX, XLSX): Downloaded via `downloadAndSaveMedia` from `src/media.ts`, saved to `attachments/`. Produces `[Document: attachments/filename.ext (SIZE KB)]`.

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
- Adds `src/image.ts` (sharp-based image processing — resize to 1024px max, JPEG conversion)
- Applies `add-image-vision` (base64 multimodal injection of image references into Claude API calls)
- Applies `add-pdf-reader` (container-side `poppler-utils` + `pdf-reader` CLI for PDF text extraction)
- Three-way merges media handling into `src/channels/whatsapp.ts` (isMediaMessage check, downloadAndSaveMedia call, annotation prepend)
- Three-way merges media tests into `src/channels/whatsapp.test.ts` (mock + test cases)
- Records the application in `.nanoclaw/state.yaml`

**New npm dependency:** `sharp` is required for image processing. It will be installed as part of the apply step.

**Container rebuild required:** The container must be rebuilt to include `poppler-utils` and `pdf-reader` for PDF text extraction.

If the apply reports merge conflicts, read the intent files:
- `modify/src/channels/whatsapp.ts.intent.md` — what changed and invariants for whatsapp.ts
- `modify/src/channels/whatsapp.test.ts.intent.md` — what changed for whatsapp.test.ts

### Validate code changes

```bash
npx vitest run --config vitest.skills.config.ts .claude/skills/add-media-support/tests/media.test.ts
npx vitest run src/channels/whatsapp.test.ts
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

No external configuration required — media support uses the existing WhatsApp connection and has no external API key dependencies.

### Build and restart

```bash
npm run build
./container/build.sh  # Rebuild agent container (required for poppler-utils and pdf-reader)
systemctl --user restart nanoclaw  # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

### Test with an image

Send an image (JPEG or PNG) to any registered WhatsApp group. The agent should receive a message containing:

```
[Image: attachments/<msgid>.jpg]
```

The host injects the image as a base64 multimodal content block, so the agent can describe what it sees in the image. Ask the agent to describe the image to confirm vision is working.

If the image has a caption, both the annotation and caption should be present:

```
[Image: attachments/<msgid>.jpg]
Look at this restaurant!
```

### Test with a PDF

Send a PDF to a registered group. The agent should receive:

```
[PDF: attachments/<msgid>-filename.pdf (SIZE KB)]
```

Ask the agent to extract text from the PDF. It should use `pdf-reader extract` to read the document contents.

### Test with a document

Send a DOCX or XLSX to a registered group. The agent should receive:

```
[Document: attachments/<msgid>-filename.xlsx (SIZE KB)]
```

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -iE 'media|image|attach'
```

Look for:
- `Media download error` — download failure (network, timeout, or encryption key issue)
- `Media directory quota exceeded` — group has >500MB of media files
- `Media file too large` — file exceeds 25MB limit
- `Rejected media with disallowed MIME type` — unsupported file type was blocked

## Security Notes

- **MIME allowlist:** Only known-safe types are accepted. SVG (script execution risk), text/plain (prompt injection risk), executables, archives, and unknown types are rejected.
- **Sharp processing:** Images are re-encoded through sharp before being passed to the agent, stripping any embedded metadata or payloads.
- **Path sanitization:** Filenames are stripped of path separators and special characters to prevent directory traversal.
- **Size limits:** 25MB per file, 500MB per group directory.
- **Download timeout:** 60-second timeout prevents hanging downloads from blocking message processing.
- **Annotations are data-only:** The `[Image: ...]`, `[PDF: ...]`, and `[Document: ...]` annotations are informational — they do not trigger any tool execution or special behavior. The host reads image annotations to inject multimodal content blocks.

## Troubleshooting

### Agent doesn't see media files

1. Verify the group's `attachments/` directory exists: `ls groups/<folder>/attachments/`
2. Check the container can access it: the group folder is mounted at `/workspace/group/` — attachments are at `/workspace/group/attachments/`
3. Check logs for download errors

### Agent can't see images (no vision)

1. Verify the annotation format is `[Image: attachments/...]` (not the old `[Media: ...]` format)
2. Check that the host-side multimodal injection is working — the image should be injected as a base64 content block, not just a text reference
3. Verify the image file exists and is a valid JPEG (sharp conversion may have failed)

### PDF text extraction fails

1. Verify `poppler-utils` and `pdf-reader` are installed in the container: `docker exec <container> which pdf-reader`
2. If missing, rebuild the container: `./container/build.sh`
3. Check that the PDF is not password-protected or corrupt

### Media downloads fail silently

Check if the WhatsApp media encryption keys expired. Baileys uses `reuploadRequest` to refresh keys — this requires an active socket connection. If the bot was offline when the media was sent, the keys may have expired by the time it reconnects.

### Disk space issues

Run cleanup of old attachment files. Attachments older than 30 days can be safely deleted:

```bash
find groups/*/attachments/ -type f -mtime +30 -delete
```
