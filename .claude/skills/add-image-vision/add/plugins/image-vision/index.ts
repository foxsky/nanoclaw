/**
 * Image Vision Plugin for NanoClaw
 * Enables Claude to process visual content from WhatsApp images
 */
import { proto } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';

import { cleanAllGroupMedia } from './cleaner.js';
import { downloadAndSaveMedia, hasDownloadableMedia } from './downloader.js';
import { ImageVisionConfig, MediaMessage } from './types.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');

/**
 * Plugin configuration per group
 */
let groupConfigs: Map<string, ImageVisionConfig> = new Map();

/**
 * Initialize plugin by loading configs from registered_groups.json
 */
export function initImageVisionPlugin(): void {
  try {
    const configPath = path.join(DATA_DIR, 'registered_groups.json');
    if (!fs.existsSync(configPath)) return;

    const registeredGroups = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    for (const [jid, config] of Object.entries(registeredGroups)) {
      const groupConfig = (config as any).plugins?.['image-vision'];
      if (groupConfig?.enabled) {
        groupConfigs.set(jid, {
          enabled: true,
          maxMediaAge: groupConfig.maxMediaAge || 7,
          maxFileSize: groupConfig.maxFileSize || 10485760, // 10MB
        });
      }
    }

    console.log(
      `[Image Vision Plugin] Initialized for ${groupConfigs.size} group(s)`,
    );

    // Schedule daily cleanup
    scheduleMediaCleanup();
  } catch (err) {
    console.error('[Image Vision Plugin] Initialization failed:', err);
  }
}

/**
 * Process a message and download media if applicable
 * Returns file path if media was downloaded, null otherwise
 */
export async function processMessageMedia(
  msg: proto.IWebMessageInfo,
  chatJid: string,
  groupFolder: string,
): Promise<string | null> {
  const config = groupConfigs.get(chatJid);
  if (!config?.enabled) return null;

  if (!hasDownloadableMedia(msg)) return null;

  // Determine media type
  let mediaType: 'image' | 'video' | 'document' = 'image';
  if (msg.message?.videoMessage) mediaType = 'video';
  if (msg.message?.documentMessage) mediaType = 'document';

  if (!msg.key) {
    console.error('[Image Vision Plugin] Message key is missing');
    return null;
  }

  const mediaInfo: MediaMessage = {
    messageId: msg.key.id || '',
    timestamp: Number(msg.messageTimestamp),
    groupFolder,
    mediaType,
    caption:
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      msg.message?.documentMessage?.caption ||
      undefined,
  };

  console.log(
    `[Image Vision Plugin] Downloading ${mediaType} for group ${groupFolder}`,
  );

  const result = await downloadAndSaveMedia(msg, mediaInfo, config.maxFileSize);

  if (result.success && result.filePath) {
    console.log(
      `[Image Vision Plugin] Saved ${mediaType} to ${result.filePath} (${result.size} bytes)`,
    );
    return result.filePath;
  } else {
    console.error(
      `[Image Vision Plugin] Failed to download ${mediaType}: ${result.error}`,
    );
    return null;
  }
}

/**
 * Schedule daily media cleanup at midnight
 */
function scheduleMediaCleanup(): void {
  const runCleanup = () => {
    console.log('[Image Vision Plugin] Running daily media cleanup...');
    const results = cleanAllGroupMedia();

    let totalDeleted = 0;
    for (const [group, result] of results.entries()) {
      totalDeleted += result.deletedCount;
      if (result.errors.length > 0) {
        console.error(
          `[Image Vision Plugin] Errors cleaning ${group}:`,
          result.errors,
        );
      }
    }

    if (totalDeleted > 0) {
      console.log(
        `[Image Vision Plugin] Deleted ${totalDeleted} old media file(s)`,
      );
    }
  };

  // Run cleanup daily at midnight
  const msUntilMidnight = () => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime() - now.getTime();
  };

  const scheduleNext = () => {
    setTimeout(() => {
      try {
        runCleanup();
      } catch (err) {
        console.error('[Image Vision Plugin] Cleanup failed, will retry:', err);
      } finally {
        scheduleNext(); // Always reschedule even if cleanup fails
      }
    }, msUntilMidnight());
  };

  scheduleNext();
}

/**
 * Get all media file paths for a specific message context
 * Used by container agent to attach images to Claude API calls
 */
export function getMediaForMessage(
  groupFolder: string,
  messageId: string,
): string[] {
  const mediaDir = path.join(
    process.cwd(),
    'groups',
    groupFolder,
    'media',
  );

  if (!fs.existsSync(mediaDir)) return [];

  try {
    const files = fs.readdirSync(mediaDir);
    return files
      .filter((f) => f.includes(messageId))
      .map((f) => path.join(mediaDir, f));
  } catch {
    return [];
  }
}
