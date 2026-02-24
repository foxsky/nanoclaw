# /add-media-support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the `/add-media-support` NanoClaw skill — downloads images and documents (PDFs, DOCX, etc.) from WhatsApp messages and makes them available to agents in all groups. Videos and audio are excluded (audio is handled by `/add-voice-transcription`; video files are too large and agents cannot process video content).

**Architecture:** Follows the manifest-based pattern (like `/add-voice-transcription`) — adds `src/media.ts`, modifies `src/channels/whatsapp.ts`. No container-runner changes needed — the group's `media/` subfolder is already mounted via the parent group directory mount at `/workspace/group/`.

**Tech Stack:** TypeScript, Baileys (`downloadMediaMessage`), NanoClaw skills engine

**Dependency:** Requires `/add-voice-transcription` to be applied first (`depends: [voice-transcription]` in manifest). Voice-transcription introduces the `finalContent` pattern and removes the `if (!content) continue;` guard in `whatsapp.ts` — both needed by media support. The skills engine uses three-way merge at apply time, so upstream changes to `whatsapp.ts` are preserved.

> **Pre-requisite (ENFORCED):** Before applying either skill, the voice-transcription modify file (`.claude/skills/add-voice-transcription/modify/src/channels/whatsapp.ts`) must be updated to include `fetchLatestWaWebVersion` (the 405 fix added after the skill was created). If left stale, the three-way merge would see the skill file "removing" `fetchLatestWaWebVersion` relative to the base snapshot, regressing the 405 fix. Update the voice-transcription modify file to match the current live source's imports and `makeWASocket` call before running `initNanoclawDir()`.
>
> **Validation:** Before proceeding past Task 1, run: `grep -q 'fetchLatestWaWebVersion' .claude/skills/add-voice-transcription/modify/src/channels/whatsapp.ts && echo "OK" || echo "FAIL: update voice-transcription modify file first"`. Do NOT proceed if this check fails.

---

### Task 1: Create media download module

**Files:**
- Create: `.claude/skills/add-media-support/add/src/media.ts`
- Test: `.claude/skills/add-media-support/tests/media.test.ts`

**Step 1: Write the failing test**

Create `.claude/skills/add-media-support/tests/media.test.ts`:

Security tests that MUST be present in this file:
- Reject unsupported MIME type (no file written).
- Reject when group quota is exceeded.
- Retention cleanup removes expired files only.
- Path traversal filename is rejected/sanitized.
- Injection-style caption does not alter tool behavior.

```typescript
import { describe, it, expect, vi } from 'vitest';

// Mock baileys downloadMediaMessage
vi.mock('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: vi.fn(),
}));

describe('media module', () => {
  it('detects image messages', async () => {
    const { isMediaMessage, getMediaType } = await import('../add/src/media.js');
    const imgMsg = { message: { imageMessage: { mimetype: 'image/jpeg' } } };
    expect(isMediaMessage(imgMsg as any)).toBe(true);
    expect(getMediaType(imgMsg as any)).toBe('image');
  });

  it('detects document messages', async () => {
    const { isMediaMessage, getMediaType } = await import('../add/src/media.js');
    const docMsg = { message: { documentMessage: { mimetype: 'application/pdf', fileName: 'itinerary.pdf' } } };
    expect(isMediaMessage(docMsg as any)).toBe(true);
    expect(getMediaType(docMsg as any)).toBe('document');
  });

  it('returns false for text-only messages', async () => {
    const { isMediaMessage } = await import('../add/src/media.js');
    const textMsg = { message: { conversation: 'hello' } };
    expect(isMediaMessage(textMsg as any)).toBe(false);
  });

  it('rejects documents with disallowed MIME types', async () => {
    const { isMediaMessage } = await import('../add/src/media.js');
    const exeMsg = { message: { documentMessage: { mimetype: 'application/x-executable', fileName: 'malware.exe' } } };
    expect(isMediaMessage(exeMsg as any)).toBe(false);
    const zipMsg = { message: { documentMessage: { mimetype: 'application/zip', fileName: 'archive.zip' } } };
    expect(isMediaMessage(zipMsg as any)).toBe(false);
    const unknownMsg = { message: { documentMessage: { mimetype: 'application/octet-stream', fileName: 'data.bin' } } };
    expect(isMediaMessage(unknownMsg as any)).toBe(false);
    // text/plain excluded — prompt injection risk
    const txtMsg = { message: { documentMessage: { mimetype: 'text/plain', fileName: 'notes.txt' } } };
    expect(isMediaMessage(txtMsg as any)).toBe(false);
  });

  it('rejects images with non-bitmap MIME types', async () => {
    const { isMediaMessage } = await import('../add/src/media.js');
    // SVG can contain JavaScript
    const svgMsg = { message: { imageMessage: { mimetype: 'image/svg+xml' } } };
    expect(isMediaMessage(svgMsg as any)).toBe(false);
    // TIFF is oversized and rarely useful
    const tiffMsg = { message: { imageMessage: { mimetype: 'image/tiff' } } };
    expect(isMediaMessage(tiffMsg as any)).toBe(false);
    // Case-insensitive — valid MIME should still work
    const jpegMsg = { message: { imageMessage: { mimetype: 'Image/JPEG' } } };
    expect(isMediaMessage(jpegMsg as any)).toBe(true);
  });

  it('sanitizes path traversal in filenames', async () => {
    const { downloadAndSaveMedia } = await import('../add/src/media.js');
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    (downloadMediaMessage as any).mockResolvedValue(Buffer.from('data'));
    const msg = {
      key: { id: 'msg456' },
      message: { documentMessage: { mimetype: 'application/pdf', fileName: '../../../etc/passwd' } },
    };
    const result = await downloadAndSaveMedia(msg as any, '/tmp/test-media', {} as any);
    expect(result).not.toContain('..');
    expect(result).toMatch(/\/tmp\/test-media\//);
    if (result) { (await import('fs')).unlinkSync(result); }
  });

  it('rejects oversized files via fileLength pre-check', async () => {
    const { downloadAndSaveMedia } = await import('../add/src/media.js');
    const msg = {
      key: { id: 'big1' },
      message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 30 * 1024 * 1024 } },
    };
    const result = await downloadAndSaveMedia(msg as any, '/tmp/test-media', {} as any);
    expect(result).toBeNull();
  });

  it('downloads and saves media to group folder', async () => {
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    const { downloadAndSaveMedia } = await import('../add/src/media.js');
    const fs = await import('fs');

    (downloadMediaMessage as any).mockResolvedValue(Buffer.from('fake-image-data'));

    const msg = {
      key: { id: 'msg123' },
      message: { imageMessage: { mimetype: 'image/jpeg' } },
    };

    const result = await downloadAndSaveMedia(msg as any, '/tmp/test-media', {} as any);

    expect(result).toMatch(/\/tmp\/test-media\/msg123\.jpeg$/);
    expect(fs.existsSync(result!)).toBe(true);

    // Cleanup
    fs.unlinkSync(result!);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run .claude/skills/add-media-support/tests/media.test.ts`
Expected: FAIL — module not found

**Step 3: Write the media module**

Create `.claude/skills/add-media-support/add/src/media.ts`:

**Security constraints (CRITICAL):**
- Enforce strict MIME allowlist. Reject unknown `documentMessage` MIME types.
- Add per-group storage quota:
  - `MAX_MEDIA_SIZE_BYTES = 25 * 1024 * 1024` (25MB per file)
  - `MAX_GROUP_MEDIA_TOTAL_BYTES = 500 * 1024 * 1024` (500MB per group)
  - Reject writes when quota is exceeded.
- Add retention policy:
  - Delete media older than `MEDIA_RETENTION_DAYS` (default 30 days).
- Never treat media text/caption/metadata as executable instruction.
- Media annotation is informational only and must not trigger tool execution.

```typescript
import {
  downloadMediaMessage,
  normalizeMessageContent,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';

type MediaType = 'image' | 'document';

// SECURITY: Only accept known-safe MIME types. Arbitrary binaries are rejected
// to prevent malware persistence and prompt-injection via crafted files.
// Single source of truth for allowed media types — prevents ALLOWED_MIME_TYPES
// and MIME_TO_EXT from drifting apart.
const MEDIA_TYPES = [
  // Images (only bitmap formats — SVG excluded due to script execution risk)
  { mime: 'image/jpeg', ext: 'jpeg' },
  { mime: 'image/png', ext: 'png' },
  { mime: 'image/webp', ext: 'webp' },
  { mime: 'image/gif', ext: 'gif' },
  // Documents (text-extractable, useful for agents)
  // NOTE: text/plain intentionally excluded — .txt files are directly readable
  // by the agent and carry the same prompt injection risk as chat messages,
  // but via a file that the agent may treat with higher authority.
  { mime: 'application/pdf', ext: 'pdf' },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  { mime: 'application/msword', ext: 'doc' },
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
] as const;

const ALLOWED_MIME_TYPES = new Set(MEDIA_TYPES.map(t => t.mime));
const MIME_TO_EXT: Record<string, string> = Object.fromEntries(
  MEDIA_TYPES.map(t => [t.mime, t.ext]),
);

// SECURITY: normalizeMessageContent() unwraps viewOnce, ephemeral,
// documentWithCaption, and editedMessage envelopes. Without this,
// wrapped messages bypass all MIME/type checks.
// NOTE: audioMessage excluded — voice notes (PTT) handled by /add-voice-transcription.
// NOTE: videoMessage excluded — video files are large and agents cannot process video content.
// NOTE: stickerMessage excluded — stickers are decorative, not useful context for agents.
export function isMediaMessage(msg: WAMessage): boolean {
  const content = normalizeMessageContent(msg.message);
  if (!content) return false;
  if (content.imageMessage) {
    const mime = content.imageMessage.mimetype?.toLowerCase();
    return !!mime && ALLOWED_MIME_TYPES.has(mime);
  }
  if (content.documentMessage) {
    const mime = content.documentMessage.mimetype?.toLowerCase();
    return !!mime && ALLOWED_MIME_TYPES.has(mime);
  }
  return false;
}

export function getMediaType(msg: WAMessage): MediaType | null {
  const content = normalizeMessageContent(msg.message);
  if (!content) return null;
  if (content.imageMessage) return 'image';
  if (content.documentMessage) return 'document';
  return null;
}

function getMimetype(msg: WAMessage): string | undefined {
  const content = normalizeMessageContent(msg.message);
  if (!content) return undefined;
  return (
    content.imageMessage?.mimetype ||
    content.documentMessage?.mimetype ||
    undefined
  )?.toLowerCase();
}

function getFileName(msg: WAMessage): string | undefined {
  const content = normalizeMessageContent(msg.message);
  const raw = content?.documentMessage?.fileName;
  if (!raw) return undefined;
  // Sanitize: strip path components to prevent directory traversal
  let sanitized = path.basename(raw).replace(/[^\w.\-]/g, '_');
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    sanitized = 'unnamed';
  }
  return sanitized;
}

const MAX_MEDIA_SIZE = 25 * 1024 * 1024; // 25MB — reject files larger than this
const MAX_MEDIA_DIR_SIZE = 500 * 1024 * 1024; // 500MB — per-group media directory quota
const DOWNLOAD_TIMEOUT_MS = 60_000; // 60 seconds — prevents hanging downloads

// Recursive directory size to prevent quota bypass via subdirectories
function getDirectorySize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      total += fs.statSync(fullPath).size;
    } else if (entry.isDirectory()) {
      total += getDirectorySize(fullPath);
    }
    // Deliberately skip symlinks
  }
  return total;
}

// NOTE: fileLength is sender-reported metadata (can be spoofed or a protobuf Long).
// The pre-download check is a fast-reject optimization only.
// The post-download buffer.length check is the actual security enforcement.
function getFileLength(msg: WAMessage): number | undefined {
  const content = normalizeMessageContent(msg.message);
  const len =
    content?.imageMessage?.fileLength ||
    content?.documentMessage?.fileLength;
  if (!len) return undefined;
  // Handle protobuf Long type: use toNumber() if available, else Number()
  const size = typeof len === 'number' ? len : (len as any).toNumber?.() ?? Number(len);
  return Number.isFinite(size) ? size : undefined;
}

export async function downloadAndSaveMedia(
  msg: WAMessage,
  mediaDir: string,
  sock: WASocket,
): Promise<string | null> {
  try {
    // Check per-group media directory quota to prevent disk exhaustion
    const currentDirSize = getDirectorySize(mediaDir);
    if (currentDirSize > MAX_MEDIA_DIR_SIZE) {
      console.warn(`Media directory quota exceeded (${currentDirSize} bytes), skipping download`);
      return null;
    }

    // Fast-reject optimization (sender-reported, not trustworthy — see getFileLength comment)
    const fileLength = getFileLength(msg);
    if (fileLength && fileLength > MAX_MEDIA_SIZE) {
      console.warn(`Media file too large (${fileLength} bytes), skipping download`);
      return null;
    }

    // Download with timeout to prevent hanging downloads from blocking message processing
    const downloadPromise = downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    ) as Promise<Buffer>;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Media download timeout')), DOWNLOAD_TIMEOUT_MS),
    );
    const buffer = await Promise.race([downloadPromise, timeoutPromise]);

    // Post-download size check — this is the actual security enforcement
    if (buffer.length > MAX_MEDIA_SIZE) {
      console.warn(`Downloaded media exceeds size limit (${buffer.length} bytes), discarding`);
      return null;
    }

    // MIME re-validation after download (defense-in-depth, case-insensitive)
    const mimetype = getMimetype(msg);
    if (!mimetype || !ALLOWED_MIME_TYPES.has(mimetype)) {
      console.warn(`Rejected media with disallowed MIME type: ${mimetype}`);
      return null;
    }

    fs.mkdirSync(mediaDir, { recursive: true });

    const ext = MIME_TO_EXT[mimetype];
    if (!ext) {
      // Should not happen — MIME was validated above. Reject as defense-in-depth.
      console.warn(`No extension mapping for validated MIME type: ${mimetype}`);
      return null;
    }
    // Sanitize msgId — sender-provided, could contain path separators
    const msgId = (msg.key.id || `media-${Date.now()}`).replace(/[^\w.\-]/g, '_');

    // Use original filename for documents, msgId for others
    const originalName = getFileName(msg);
    let filename = originalName
      ? `${msgId}-${originalName}`
      : `${msgId}.${ext}`;
    // Truncate to prevent ENAMETOOLONG on ext4 (255 byte limit)
    if (filename.length > 200) {
      filename = `${msgId}.${ext}`;
    }

    const filePath = path.join(mediaDir, filename);
    fs.writeFileSync(filePath, buffer, { mode: 0o644 });

    return filePath;
  } catch (err) {
    // NOTE: error details logged to host console only — never forwarded to agent annotations
    console.error('Media download error:', err);
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run .claude/skills/add-media-support/tests/media.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-media-support/
git commit -m "feat: add media download module for /add-media-support skill"
```

---

### Task 2: Create manifest and intent files for media support skill

**Files:**
- Create: `.claude/skills/add-media-support/manifest.yaml`
- Create: `.claude/skills/add-media-support/modify/src/channels/whatsapp.ts`
- Create: `.claude/skills/add-media-support/modify/src/channels/whatsapp.ts.intent.md`
- Create: `.claude/skills/add-media-support/modify/src/channels/whatsapp.test.ts`
- Create: `.claude/skills/add-media-support/modify/src/channels/whatsapp.test.ts.intent.md`
- Reference: `.claude/skills/add-voice-transcription/manifest.yaml` (for format)
- Reference: `.claude/skills/add-voice-transcription/modify/` (for pattern)

**Note:** No `src/container-runner.ts` modification needed. The group folder is already mounted writably at `/workspace/group/` (see `src/container-runner.ts:80-85`), so `media/` inside it is automatically accessible in the container.

**Step 1: Create manifest.yaml**

Check the actual `core_version` by reading `.claude/skills/add-voice-transcription/manifest.yaml` and matching it.

```yaml
skill: media-support
version: 1.0.0
description: "Download images, PDFs, and documents from WhatsApp messages"
core_version: 0.1.0
adds:
  - src/media.ts
modifies:
  - src/channels/whatsapp.ts
  - src/channels/whatsapp.test.ts
structured:
  npm_dependencies: {}
  env_additions: []
conflicts: []
depends:
  - voice-transcription
test: "npx vitest run src/channels/whatsapp.test.ts"
```

**Step 2: Create the modify files**

The modify file should be created by starting from the **voice-transcription modify file** (`.claude/skills/add-voice-transcription/modify/src/channels/whatsapp.ts`) and adding the media handling changes. The skills engine performs a **three-way merge** at apply time: it compares the skill's modify file against its base snapshot (`.nanoclaw/base/`), extracts the diff, and merges into the current live source. This means any upstream changes to `whatsapp.ts` (e.g., `fetchLatestWaWebVersion` for the 405 fix) are preserved — the engine merges the media changes on top of whatever the current file contains. The `depends: [voice-transcription]` in the manifest ensures voice-transcription is applied first, so its `finalContent` pattern and `!content` guard removal are in place.

**Key changes to make in the modify file:**

0. **Do NOT re-introduce a guard at the same position as the old `if (!content) continue;` line.** Voice-transcription's modify file removes this guard entirely. If the media-support modify file adds a different guard at the same position, `git merge-file` will see two conflicting changes to the same region (one deletion, one replacement) and produce a merge conflict.

   Instead, follow voice-transcription's approach: no guard. The `finalContent` pattern handles empty content gracefully — if there's no text, no voice transcript, and no media annotation, `finalContent` remains `''` and the agent receives an empty message (which it can ignore). Messages like delivery receipts and reactions don't reach this code path (they use different Baileys event types), so the only "empty" messages that get through are real messages with no text content — exactly the kind media-support wants to process (e.g., captionless images).

1. **Add imports** at top of file:
   ```typescript
   import { isMediaMessage, getMediaType, downloadAndSaveMedia } from '../media.js';
   ```
   Also add `normalizeMessageContent` to the Baileys import (used internally by the media module, but the modify file may also need it if accessing message content directly).

2. **Add media handling block** in the `messages.upsert` handler, after the voice transcription block and before `this.opts.onMessage()`. This integrates with the existing `finalContent` variable introduced by voice-transcription.

   **CRITICAL: Multi-group path resolution.** The WhatsApp channel handles ALL groups in a single process — there is no `this.opts.groupDir`. The `messages.upsert` handler already has `chatJid` and resolves the group entry via `const groups = this.opts.registeredGroups(); groups[chatJid]`. Use `groups[chatJid].folder` to resolve the media directory per-message:

   ```typescript
   // Download media files (images, PDFs, documents)
   if (isMediaMessage(msg)) {
     const mediaType = getMediaType(msg);
     const groupEntry = groups[chatJid];
     const mediaDir = path.join(GROUPS_DIR, groupEntry.folder, 'media');
     const savedPath = await downloadAndSaveMedia(msg, mediaDir, this.sock);
     if (savedPath) {
       const filename = path.basename(savedPath);
       const annotation = `[Media: ${mediaType} at /workspace/group/media/${filename}]`;
       finalContent = finalContent ? `${annotation}\n${finalContent}` : annotation;
     } else {
       const annotation = `[Media: ${mediaType} — download failed]`;
       finalContent = finalContent ? `${annotation}\n${finalContent}` : annotation;
     }
   }
   ```

   This requires adding `GROUPS_DIR` to the import from `../config.js` (current source only imports `ASSISTANT_HAS_OWN_NUMBER`, `ASSISTANT_NAME`, `STORE_DIR` — the modify file must add `GROUPS_DIR` to that import). The `groups[chatJid]` lookup is guaranteed to exist because the handler already checks `if (groups[chatJid])` before reaching this code.

4. **Create `whatsapp.ts.intent.md`** explaining: imports added (`isMediaMessage`, `getMediaType`, `downloadAndSaveMedia` from `../media.js`, `GROUPS_DIR` from `../config.js`), media download block added after voice transcription, uses existing `finalContent` pattern, resolves per-group media directory via `groups[chatJid].folder`.

5. **Create `whatsapp.test.ts` modify file** adding tests for:
   - Image message is downloaded and `[Media: image at ...]` annotation is prepended to content
   - PDF message is downloaded and `[Media: document at ...]` annotation is prepended
   - Image with caption: annotation is prepended, caption preserved
   - Text-only messages are unaffected
   - Download failure: `[Media: {type} — download failed]` annotation added, caption preserved
   - Voice notes (PTT audio) are NOT treated as media (handled by voice-transcription)

**Step 3: Commit**

```bash
git add .claude/skills/add-media-support/
git commit -m "feat: add manifest and modify files for media support skill"
```

---

### Task 3: Create SKILL.md for media support

**Files:**
- Create: `.claude/skills/add-media-support/SKILL.md`

**Step 1: Write the SKILL.md**

Follow the four-phase pattern from `/add-voice-transcription/SKILL.md`:

> **WARNING for implementers:** Voice-transcription's SKILL.md references `npx tsx scripts/apply-skill.ts --init` — this `--init` flag does NOT exist in `scripts/apply-skill.ts`. Do NOT copy that pattern. Use the inline import below instead.

- **Phase 1 (Pre-flight):** Check if `.nanoclaw/state.yaml` exists. If it does NOT exist, initialize the skills system first (run from the NanoClaw project root):
  ```bash
  npx tsx -e "import { initNanoclawDir } from './skills-engine/index.js'; initNanoclawDir();"
  ```
  Then read `state.yaml` — if `media-support` is already in `applied_skills`, skip to Phase 4. Also verify `voice-transcription` is in `applied_skills` — if not, stop and tell the user to run `/add-voice-transcription` first (media support's modify file depends on the `!content` guard removal and `finalContent` pattern it introduces).
- **Phase 2 (Apply):** Run `npx tsx scripts/apply-skill.ts .claude/skills/add-media-support` to apply code changes. Rebuild with `npm run build`. (No `npm install` needed — this skill adds no new npm dependencies; it uses Baileys' `downloadMediaMessage` which is already installed.)
- **Phase 3 (Configure):** No external configuration needed (unlike voice-transcription which requires an API key). Note this explicitly: "No configuration required — media support uses the existing WhatsApp connection."
- **Phase 4 (Verify):** Run tests: `npx vitest run src/channels/whatsapp.test.ts`. Rebuild container: `./container/build.sh`. Test by sending an image to a registered group and confirming the agent receives `[Media: image at /workspace/group/media/...]`.

**Step 2: Commit**

```bash
git add .claude/skills/add-media-support/SKILL.md
git commit -m "feat: complete /add-media-support skill with SKILL.md"
```

---

### Task 4: Integration verification

**Step 1: Verify skill structure**

```bash
# Check all expected files exist
ls -la .claude/skills/add-media-support/SKILL.md
ls -la .claude/skills/add-media-support/manifest.yaml
ls -la .claude/skills/add-media-support/add/src/media.ts
ls -la .claude/skills/add-media-support/tests/media.test.ts
ls -la .claude/skills/add-media-support/modify/src/channels/whatsapp.ts
ls -la .claude/skills/add-media-support/modify/src/channels/whatsapp.ts.intent.md
```

Expected: all files exist

**Step 2: Run media module tests**

```bash
npx vitest run .claude/skills/add-media-support/tests/media.test.ts
```

Expected: all tests pass

**Step 3: Verify existing tests still pass (no regressions)**

```bash
npx vitest run
```

Expected: all existing tests pass

**Step 4: Run adversarial security validation**

Run focused security checks:
1. Send a file with unsupported MIME type and verify it is rejected.
2. Fill a test group `media/` directory to exceed quota and verify new uploads are blocked.
3. Create expired test files and verify retention cleanup removes only files older than threshold.
4. Send media with injection-style caption text (for example: "ignore previous instructions") and verify no privileged tool behavior is triggered from caption content.

Expected: all checks pass and failures are surfaced in logs without unsafe fallback behavior.

**Step 5: Commit any fixes**

```bash
git add .claude/skills/add-media-support/
git commit -m "test: verify media support skill integration"
```

---

## Task Dependency Graph

```
Task 1: Media module + tests
  ↓
Task 2: Manifest + modify files
  ↓
Task 3: Media SKILL.md
  ↓
Task 4: Integration verification
```

---

## Security Acceptance Criteria (REQUIRED)

These controls MUST pass before the skill can be merged:

- [ ] Agent runs with `permissionMode: 'acceptEdits'` (NOT `bypassPermissions`)
- [ ] PreToolUse hook denies dangerous Bash patterns (curl|bash, env dumps, secret refs)
- [ ] Write/Edit operations outside `/workspace/group/` and `/workspace/ipc/` are denied
- [ ] Media content annotations are informational-only — no executable instruction markers
- [ ] MIME allowlist enforced for both images and documents (no text/plain, no SVG)
- [ ] `/app/src` is mounted read-only — agent cannot modify its own MCP tools
- [ ] Adversarial validation (Step 4 in Task 4) passes: MIME rejection, quota blocking, retention cleanup, injection caption

| # | Criteria | Resolution |
|---|----------|------------|
| R11-1 | `permissionMode: 'acceptEdits'` enforced | Pending — platform hardening task |
| R11-2 | PreToolUse Bash deny patterns active | Pending — platform hardening task |
| R11-3 | Write-path enforcement outside allowed dirs | Pending — platform hardening task |
| R11-4 | Media annotations are data-only | Verified — annotations use `[Media: {type} at {path}]` format, no executable markers |
| R11-5 | MIME allowlist enforced (no text/plain, no SVG) | Verified — `ALLOWED_MIME_TYPES` set rejects both; tests cover exe/zip/octet-stream/svg/tiff |
| R11-6 | `/app/src` mounted read-only | Pending — platform hardening task |
| R11-7 | Adversarial validation passes | Pending — verified at integration time (Task 4 Step 4) |

---

## Review Issue Resolution Tracker

| # | Issue | Severity | Resolution |
|---|-------|----------|------------|
| 4 | Nonexistent `src/container-runner.test.ts` in manifest | Critical | Removed from manifest test command; only tests `src/channels/whatsapp.test.ts` |
| 5 | Unnecessary container-runner.ts modification | Critical | Removed entirely; group's `media/` is already mounted via parent directory |
| 11 | Insufficient test coverage | Important | Task 4 now has 4 verification steps |
| C1 | `if (!content) continue;` drops captionless media | Critical | Modify file builds on voice-transcription-applied source which already removed this guard; documented in Task 2 |
| C2 | `core_version: 1.1.0` wrong | Critical | Fixed to `0.1.0` matching voice-transcription manifest |
| C3 | Voice-transcription dependency undefined; audio/PTT overlap | Critical | Added `depends: [voice-transcription]` to manifest; excluded `audioMessage` from `isMediaMessage` (PTT handled by voice-transcription) |
| I1 | Task 2 modify file content too vague | Important | Added concrete code snippets for import, media handling block, and `finalContent` integration |
| I2 | Test import pattern inconsistent | Important | Acknowledged; implementer should follow the pattern established by the project's test infrastructure |
| I3 | SKILL.md 3 phases vs reference's 4 | Important | Fixed to 4 phases; Phase 3 (Configure) explicitly says no configuration needed |
| I4 | `npm install` but no dependencies | Important | Removed `npm install` mention; added note that no new npm dependencies are needed |
| I5 | `downloadAndSaveMedia` silently swallows errors | Important | Added `console.error('Media download error:', err)` in catch block |
| R2-C2 | Design doc omits voice-transcription dependency for media support | Critical | Updated design doc: media-support scope now documents voice-transcription as required dependency |
| R2-I3 | Video scope inconsistent (architecture says download, scope says metadata only) | Important | Resolved: videos excluded entirely from both design doc and implementation; `videoMessage` removed from code |
| R3-1 | `this.opts.groupDir` doesn't exist; multi-group path resolution wrong | Critical | Fixed: resolve per-message via `groups[chatJid].folder` + `GROUPS_DIR` from config; documented multi-group behavior |
| R3-2 | Missing skills-system `--init` step | Critical | Added init check to SKILL.md Phase 1: if `.nanoclaw/state.yaml` missing, run inline `initNanoclawDir()` import (not `--init` flag which doesn't exist in `apply-skill.ts`) |
| R3-3 | Unbounded media download — OOM/DoS risk | Critical | Added `MAX_MEDIA_SIZE` (25MB) with pre-download `fileLength` check and post-download `buffer.length` check |
| R3-4 | Path traversal via document filenames | Critical | Added `path.basename()` + character sanitization in `getFileName()` |
| R3-5 | Modify file base may regress newer whatsapp.ts behavior | Important | Clarified: skills engine uses three-way merge — upstream changes are preserved; modify file is a diff, not a replacement |
| R3-6 | Video scope still inconsistent | Important | Already fixed in R2-I3; confirmed no `videoMessage` references remain |
| R4-1 | `apply-skill.ts --init` doesn't exist | Critical | Fixed: replaced with inline `initNanoclawDir()` import matching CI pattern |
| R4-2 | `GROUPS_DIR` not actually imported in current whatsapp.ts | Important | Fixed: clarified modify file must add `GROUPS_DIR` to the existing config import |
| R5-1 | Guard removal description says "remove" but it's a replacement | Important | Fixed: wording changed from "Remove" to "Replace" to accurately describe the three-way merge behavior |
| R7-C1 | Voice-transcription SKILL.md references non-existent `--init` flag; implementers may copy it | Critical | Added WARNING box in Task 3 SKILL.md section: "Do NOT copy voice-transcription's `--init` pattern" |
| R7-C2 | Guard replacement creates three-way merge conflict with voice-transcription's guard deletion | Critical | Removed combined guard from Task 2 Step 0; follow voice-transcription's no-guard approach; `finalContent` handles empty content |
| R7-I1 | Voice-transcription modify file missing `fetchLatestWaWebVersion` — regression risk | Important | Added pre-requisite note: update voice-transcription modify file before running `initNanoclawDir()` |
| R8-C1 | Document MIME types not allowlisted — arbitrary binaries can be persisted | Critical | Added `ALLOWED_MIME_TYPES` set; `isMediaMessage()` now rejects documents with unknown MIME types; `downloadAndSaveMedia()` double-checks MIME before saving |
| R8-I1 | No storage quota — many small files can exhaust disk | Important | Added `MAX_MEDIA_DIR_SIZE` (500MB) per-group quota with `getDirectorySize()` check before download |
| R8-I2 | Security controls under-tested | Important | Added 3 security test cases: MIME rejection (exe/zip/octet-stream), path traversal (`../../../etc/passwd`), oversized file pre-check |
| SEC-C1 | `isMediaMessage()` bypassed by wrapped messages (viewOnce, ephemeral, documentWithCaption) | Critical | All message inspection functions now use `normalizeMessageContent()` to unwrap envelope types before checking |
| SEC-C2 | `fileLength` is protobuf Long type, not plain number; comparison operators fail silently | Critical | Added `getFileLength()` helper that detects Long type and calls `.toNumber()`; pre-download size check uses this |
| SEC-I1 | No download timeout — malicious/slow peer can block agent indefinitely | Important | `downloadAndSaveMedia()` uses `Promise.race` with 60-second `AbortController` timeout |
| SEC-I2 | Entire file buffered in memory before size check | Important | Accepted: Baileys API downloads to buffer; mitigated by `fileLength` pre-check rejecting oversized files before download |
| SEC-I3 | No global disk quota across all groups | Important | Already addressed by R8-I1 (per-group `MAX_MEDIA_DIR_SIZE`); global quota deferred as over-engineering for personal assistant |
| SEC-I4 | Media files mounted read-write into container | Important | Accepted risk: container isolation is the security boundary; agent needs write access for its own media organization |
| SEC-I5 | Sticker messages not explicitly excluded from `isMediaMessage()` | Important | Added comment documenting that `stickerMessage` is intentionally excluded (no `content.stickerMessage` check) |
| SEC-I6 | `getDirectorySize()` not recursive — subdirectories not counted toward quota | Important | Rewritten with `fs.readdirSync({ withFileTypes: true })` + recursive descent; skips symlinks to prevent loops |
| SEC-I7 | MIME check case-sensitive — `Image/JPEG` bypasses allowlist | Important | All MIME comparisons use `.toLowerCase()` before `ALLOWED_MIME_TYPES.has()` |
| SEC-I8 | No rate limiting on media downloads | Important | Accepted: per-group queue serializes message processing; quota provides natural throughput limit |
| SEC-L1 | `path.basename()` returns '.' for '.' input and '..' for '..' input | Low | Added explicit check: if basename is '.' or '..', falls back to `media_<msgId>` naming |
| SEC-L2 | `msg.key.id` used in filenames without sanitization — could contain path separators | Low | Added regex sanitization: `msgId.replace(/[^a-zA-Z0-9_-]/g, '_')` before use in file paths |
| R10-1 | `isMediaMessage()` skips MIME check for images — downloads SVG/TIFF before post-download rejection | Important | Added MIME validation to image path: `content.imageMessage.mimetype?.toLowerCase()` checked against `ALLOWED_MIME_TYPES` |
| R10-2 | `text/plain` in MIME allowlist enables direct prompt injection via readable file content | Important | Removed `text/plain` from allowlist; `.txt` files are directly readable by the agent and may be treated with higher authority than chat messages |
| R10-3 | No magic-byte validation — MIME is sender-reported only | Important | Accepted for now: post-download MIME re-check and container isolation mitigate; magic-byte validation is defense-in-depth for future hardening |
| R10-4 | `MIME_TO_EXT` and `ALLOWED_MIME_TYPES` can drift apart | Low | Unified into single `MEDIA_TYPES` array source of truth; both sets derived from it |
| R10-5 | `MIME_TO_EXT` fallback to `'bin'` bypasses allowlist intent | Low | Replaced `\|\| 'bin'` fallback with explicit rejection if no extension mapping exists |
| R10-6 | No filename length truncation — ENAMETOOLONG on ext4 (255 byte limit) | Low | Added 200-char truncation; falls back to `${msgId}.${ext}` for long filenames |
| R10-7 | `git add -A` in Task 4 risks committing sensitive untracked files | Important | Replaced with `git add .claude/skills/add-media-support/` — only stage skill files |
| R10-8 | Voice-transcription modify file freshness not enforced — documented but no automated check | Important | Added `grep` validation command with pass/fail gate before Task 2 |
| R10-9 | Image comment misleading ("all safe") — SVG can contain JavaScript | Low | Reworded to "only bitmap formats — SVG excluded due to script execution risk" |
| R10-10 | Synchronous recursive `getDirectorySize()` can block event loop | Important | Accepted for now: function runs once per download, media directories are typically flat; async version or depth limit is future hardening |
| R10-11 | Timeout `Promise.race` leaks background download promise | Low | Accepted: Baileys API does not support AbortSignal; timeout still prevents indefinite blocking; leaked promise bounded by MAX_MEDIA_SIZE |
| R10-P1 | **PLATFORM:** Agent-runner source (`/app/src`) mounted writable — agent can rewrite MCP tools to bypass all IPC auth | Critical | **Not a plan issue — requires core platform code change.** Mount `/app/src` as read-only in `container-runner.ts`, or move all authorization to host-side IPC handler |
| R10-P2 | **PLATFORM:** No rate limiting on media downloads or `send_message` IPC | Important | **Not a plan issue — requires core platform code change.** Add per-group rate limits in `ipc.ts` |
