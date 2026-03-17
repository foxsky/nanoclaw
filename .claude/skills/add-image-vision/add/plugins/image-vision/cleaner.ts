/**
 * Media Cleaner for Image Vision Plugin
 * Removes old media files based on retention policy
 */
import fs from 'fs';
import path from 'path';

const GROUPS_DIR = path.resolve(process.cwd(), 'groups');
const DEFAULT_MAX_AGE_DAYS = 7;

/**
 * Clean old media files from a group's media directory
 */
export function cleanOldMedia(
  groupFolder: string,
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
): { deletedCount: number; errors: string[] } {
  const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');

  if (!fs.existsSync(mediaDir)) {
    return { deletedCount: 0, errors: [] };
  }

  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const errors: string[] = [];
  let deletedCount = 0;

  try {
    const files = fs.readdirSync(mediaDir);

    for (const file of files) {
      try {
        const filePath = path.join(mediaDir, file);
        const stats = fs.statSync(filePath);

        // Check file age
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      } catch (err) {
        errors.push(
          `Failed to process ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    errors.push(
      `Failed to read media directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { deletedCount, errors };
}

/**
 * Clean old media for all groups
 */
export function cleanAllGroupMedia(
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
): Map<string, { deletedCount: number; errors: string[] }> {
  const results = new Map<
    string,
    { deletedCount: number; errors: string[] }
  >();

  try {
    const groups = fs.readdirSync(GROUPS_DIR);

    for (const group of groups) {
      const groupPath = path.join(GROUPS_DIR, group);
      const mediaPath = path.join(groupPath, 'media');

      if (fs.existsSync(mediaPath) && fs.statSync(groupPath).isDirectory()) {
        const result = cleanOldMedia(group, maxAgeDays);
        if (result.deletedCount > 0 || result.errors.length > 0) {
          results.set(group, result);
        }
      }
    }
  } catch (err) {
    console.error('Error cleaning group media:', err);
  }

  return results;
}
