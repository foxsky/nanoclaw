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
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: 'docx',
  },
  { mime: 'application/msword', ext: 'doc' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  },
] as const;

const ALLOWED_MIME_TYPES: Set<string> = new Set(MEDIA_TYPES.map((t) => t.mime));
const MIME_TO_EXT: Record<string, string> = Object.fromEntries(
  MEDIA_TYPES.map((t) => [t.mime, t.ext]),
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
const DEFAULT_MEDIA_RETENTION_DAYS = 30;

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

function getRetentionDays(): number {
  const raw = process.env.MEDIA_RETENTION_DAYS;
  if (!raw) return DEFAULT_MEDIA_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_MEDIA_RETENTION_DAYS;
  return Math.floor(parsed);
}

function cleanupExpiredMedia(mediaDir: string): void {
  if (!fs.existsSync(mediaDir)) return;
  const retentionMs = getRetentionDays() * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;

  for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
    const fullPath = path.join(mediaDir, entry.name);
    if (entry.isFile()) {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fullPath);
      }
    } else if (entry.isDirectory()) {
      cleanupExpiredMedia(fullPath);
    }
    // Deliberately skip symlinks
  }
}

// NOTE: fileLength is sender-reported metadata (can be spoofed or a protobuf Long).
// The pre-download check is a fast-reject optimization only.
// The post-download buffer.length check is the actual security enforcement.
function getFileLength(msg: WAMessage): number | undefined {
  const content = normalizeMessageContent(msg.message);
  const len =
    content?.imageMessage?.fileLength || content?.documentMessage?.fileLength;
  if (!len) return undefined;
  // Handle protobuf Long type: use toNumber() if available, else Number()
  const size =
    typeof len === 'number' ? len : ((len as any).toNumber?.() ?? Number(len));
  return Number.isFinite(size) ? size : undefined;
}

export async function downloadAndSaveMedia(
  msg: WAMessage,
  mediaDir: string,
  sock: WASocket,
): Promise<string | null> {
  try {
    // Retention cleanup is best-effort and runs before quota checks.
    cleanupExpiredMedia(mediaDir);

    // Check per-group media directory quota to prevent disk exhaustion
    const currentDirSize = getDirectorySize(mediaDir);
    if (currentDirSize >= MAX_MEDIA_DIR_SIZE) {
      console.warn(
        `Media directory quota exceeded (${currentDirSize} bytes), skipping download`,
      );
      return null;
    }

    // Fast-reject optimization (sender-reported, not trustworthy — see getFileLength comment)
    const fileLength = getFileLength(msg);
    if (fileLength && fileLength > MAX_MEDIA_SIZE) {
      console.warn(
        `Media file too large (${fileLength} bytes), skipping download`,
      );
      return null;
    }
    if (fileLength && currentDirSize + fileLength > MAX_MEDIA_DIR_SIZE) {
      console.warn(
        `Media directory would exceed quota (${currentDirSize + fileLength} bytes), skipping download`,
      );
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
      setTimeout(
        () => reject(new Error('Media download timeout')),
        DOWNLOAD_TIMEOUT_MS,
      ),
    );
    const buffer = await Promise.race([downloadPromise, timeoutPromise]);

    // Post-download size check — this is the actual security enforcement
    if (buffer.length > MAX_MEDIA_SIZE) {
      console.warn(
        `Downloaded media exceeds size limit (${buffer.length} bytes), discarding`,
      );
      return null;
    }
    if (currentDirSize + buffer.length > MAX_MEDIA_DIR_SIZE) {
      console.warn(
        `Media directory would exceed quota (${currentDirSize + buffer.length} bytes), discarding`,
      );
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
    const msgId = (msg.key.id || `media-${Date.now()}`).replace(
      /[^\w.\-]/g,
      '_',
    );

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
