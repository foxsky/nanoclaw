import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * skill/taskflow-v2 migration — `messaging_groups.is_main_control`.
 *
 * Reintroduces v1's `registered_groups.isMain` semantics on the v2 schema.
 * v1 stored isMain on the registered group (the chat) — exactly ONE chat
 * could be the operator's main control. v2 dropped the unified
 * registered_groups table; the closest equivalent IS messaging_groups
 * (one row per chat per platform).
 *
 * Why `messaging_groups`, not `agent_groups`: in v1 isMain was per-chat,
 * not per-agent. A single agent in v2 can be wired to multiple chats; if
 * we put the flag on the agent, every chat using that agent inherits the
 * privilege — broader than v1's per-chat gate. That's the security drift
 * Codex BLOCKER #3 caught in commit a123cecd (reverted in 3133bd55).
 *
 * Storage:
 *   - `is_main_control INTEGER NOT NULL DEFAULT 0`
 *   - Partial unique index on `=1` rows enforces "at most one main"
 *     atomically; CHECK can't express that. Rows with value 0 are
 *     unconstrained.
 *
 * Migration policy:
 *   - This migration leaves `is_main_control = 0` on every existing row.
 *     No row is auto-promoted. Privileged actions (send_otp, the upcoming
 *     provision_* / create_group ports) drop until an admin designates one
 *     via setMainControlMessagingGroup() — fail-closed on purpose.
 */
export const moduleTaskflowMainControl: Migration = {
  version: 13,
  name: 'module-taskflow-main-control',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE messaging_groups ADD COLUMN is_main_control INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX idx_messaging_groups_one_main_control
        ON messaging_groups(is_main_control)
        WHERE is_main_control = 1;
    `);
  },
};
