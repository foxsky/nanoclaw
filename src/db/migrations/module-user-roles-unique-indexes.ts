import type Database from 'better-sqlite3';

import { registerMigration, type Migration } from './index.js';

/**
 * The `user_roles` composite PRIMARY KEY (user_id, role, agent_group_id) does NOT enforce
 * uniqueness for global roles: SQLite treats every NULL `agent_group_id` as distinct, so re-granting
 * a global owner/admin inserts a duplicate row. Add partial unique indexes that cover BOTH the
 * global (NULL) and scoped (NOT NULL) cases. First dedup any pre-existing duplicates, else the
 * unique-index creation would fail on production data.
 *
 * Renamed from `016-user-roles-unique-indexes.ts` (ADR 0006 contract #3): the bare `016-` filename
 * collides with upstream's incoming `016-messaging-group-instance.ts`. The stored migration `name`
 * is kept VERBATIM as 'user-roles-unique-indexes' so DBs that already recorded this migration under
 * that name do NOT re-run it. The `module-` prefix lives on the filename / export identifier only.
 */
export const moduleUserRolesUniqueIndexes: Migration = {
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

// Self-register into the core migration runner (ADR 0006 contract #3). The
// taskflow overlay barrel side-effect-imports this file; pristine core never
// loads it, so the migration never runs on a non-taskflow install.
registerMigration(moduleUserRolesUniqueIndexes);
