import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * The `user_roles` composite PRIMARY KEY (user_id, role, agent_group_id) does NOT enforce
 * uniqueness for global roles: SQLite treats every NULL `agent_group_id` as distinct, so re-granting
 * a global owner/admin inserts a duplicate row. Add partial unique indexes that cover BOTH the
 * global (NULL) and scoped (NOT NULL) cases. First dedup any pre-existing duplicates, else the
 * unique-index creation would fail on production data.
 */
export const migration016: Migration = {
  version: 16,
  name: 'user-roles-unique-indexes',
  up(db: Database.Database) {
    // Keep the earliest rowid per (user_id, role, agent_group_id). GROUP BY treats NULLs as equal,
    // so duplicate global rows (agent_group_id IS NULL) are grouped and collapsed too.
    db.prepare(
      `DELETE FROM user_roles
       WHERE rowid NOT IN (
         SELECT MIN(rowid) FROM user_roles GROUP BY user_id, role, agent_group_id
       )`,
    ).run();
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_global
         ON user_roles (user_id, role) WHERE agent_group_id IS NULL`,
    ).run();
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_scoped
         ON user_roles (user_id, role, agent_group_id) WHERE agent_group_id IS NOT NULL`,
    ).run();
  },
};
