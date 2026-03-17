/**
 * Media Downloader for Image Vision Plugin
 * Downloads images/videos from WhatsApp using Baileys
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { proto } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';

import { MediaDownloadResult, MediaMessage } from './types.js';

const GROUPS_DIR = path.resolve(process.cwd(), 'groups');

/**
 * Download media from a WhatsApp message and save to disk
 */
export async function downloadAndSaveMedia(
  msg: proto.IWebMessageInfo,
  mediaInfo: MediaMessage,
  maxFileSize?: number,
): Promise<MediaDownloadResult> {
  try {
    if (!msg.key) {
      return {
        success: false,
        error: 'Message key is missing',
      };
    }

    // Create media directory if it doesn't exist
    const mediaDir = path.join(GROUPS_DIR, mediaInfo.groupFolder, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    // Download media buffer - cast to any to bypass type checking
    // The actual implementation works correctly despite type mismatch
    const buffer = await downloadMediaMessage(
      msg as any,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: () => Promise.resolve(null as any),
      },
    );

    if (!buffer) {
      return {
        success: false,
        error: 'Failed to download media: empty buffer',
      };
    }

    // Validate file size if maxFileSize is configured
    if (maxFileSize && buffer.length > maxFileSize) {
      const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
      const maxMB = (maxFileSize / 1024 / 1024).toFixed(2);
      return {
        success: false,
        error: `File too large: ${sizeMB}MB (max: ${maxMB}MB)`,
      };
    }

    // Determine file extension based on media type
    let ext = 'jpg';
    let mimeType = 'image/jpeg';

    if (msg.message?.imageMessage) {
      mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
      ext = mimeType.split('/')[1] || 'jpg';
    } else if (msg.message?.videoMessage) {
      mimeType = msg.message.videoMessage.mimetype || 'video/mp4';
      // For videos, we'll save as-is but Claude can process first frame
      ext = 'mp4';
    } else if (msg.message?.documentMessage) {
      mimeType = msg.message.documentMessage.mimetype || 'application/pdf';
      const fileName = msg.message.documentMessage.fileName || 'document';
      ext = fileName.split('.').pop() || 'pdf';
    }

    // Save file
    const fileName = `${mediaInfo.timestamp}-${mediaInfo.messageId}.${ext}`;
    const filePath = path.join(mediaDir, fileName);

    fs.writeFileSync(filePath, buffer);

    return {
      success: true,
      filePath,
      mimeType,
      size: buffer.length,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check if a message contains downloadable media
 */
export function hasDownloadableMedia(msg: proto.IWebMessageInfo): boolean {
  return !!(
    msg.message?.imageMessage ||
    msg.message?.videoMessage ||
    msg.message?.documentMessage
  );
}
