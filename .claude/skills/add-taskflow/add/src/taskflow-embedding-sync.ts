import type Database from 'better-sqlite3';

import type { EmbeddingService } from './embedding-service.js';
import { logger } from './logger.js';

export function buildSourceText(task: {
  title: string;
  description?: string | null;
  next_action?: string | null;
}): string {
  return [task.title, task.description ?? '', task.next_action ?? '']
    .join(' ')
    .trim();
}

/**
 * Periodically syncs active TaskFlow tasks into the generic embedding service.
 * Removes embeddings for tasks that are done, archived, or deleted.
 */
export function startTaskflowEmbeddingSync(
  service: EmbeddingService,
  tfDb: Database.Database | null,
  intervalMs = 15_000,
): ReturnType<typeof setInterval> | null {
  if (!tfDb) {
    logger.info('TaskFlow DB not found — embedding sync disabled');
    return null;
  }

  const sync = () => {
    try {
      const tasks = tfDb
        .prepare(
          `SELECT board_id, id, title, description, next_action, assignee, column
           FROM tasks WHERE column != 'done'`,
        )
        .all() as Array<{
        board_id: string;
        id: string;
        title: string;
        description: string | null;
        next_action: string | null;
        assignee: string | null;
        column: string;
      }>;

      const activeKeys = new Set<string>();
      for (const task of tasks) {
        const collection = `tasks:${task.board_id}`;
        const text = buildSourceText(task);
        if (text) {
          service.index(collection, task.id, text, {
            title: task.title,
            assignee: task.assignee,
            column: task.column,
          });
        }
        activeKeys.add(`${collection}\0${task.id}`);
      }

      // Clean stale embeddings for done/archived/deleted tasks
      const allTaskCollections = service.getCollections('tasks:');
      for (const collection of allTaskCollections) {
        const items = service.getItemIds(collection);
        for (const itemId of items) {
          if (!activeKeys.has(`${collection}\0${itemId}`)) {
            service.remove(collection, itemId);
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'TaskFlow embedding sync failed');
    }
  };

  // Run first sync immediately
  sync();
  return setInterval(sync, intervalMs);
}
