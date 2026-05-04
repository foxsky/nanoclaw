import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * skill/taskflow-v2 migration — `agent_groups.is_main_control`.
 *
 * Reintroduces v1's `registered_groups.isMain` concept on the v2 schema. At
 * most one agent group can be the "main control" — the operator's primary
 * agent that holds elevated privileges (currently: triggering `send_otp`
 * via TaskFlow board provisioning; will gate the other 4 ipc-plugin
 * ports too). Codex (gpt-5.5/high, 2026-05-04) recommended C1 over schema-
 * derived alternatives because role/member topology is too mutable to
 * carry control-chat identity reliably.
 *
 * Storage:
 *   - `is_main_control INTEGER NOT NULL DEFAULT 0` — 0 means "not main",
 *     1 means "is main". SQLite has no BOOLEAN; INTEGER + DEFAULT 0 is
 *     the v2 convention (see `messaging_groups.is_group`).
 *   - Partial unique index on the `=1` rows ENFORCES "at most one main"
 *     atomically; a CHECK constraint can't express that. Rows with
 *     value 0 are unconstrained.
 *
 * Migration policy:
 *   - This migration leaves `is_main_control = 0` on every existing row
 *     (the column DEFAULT). No row is auto-promoted to main.
 *   - A skill bootstrap step (or admin tool) MUST designate exactly one
 *     row before any privileged action is callable. Until then the host
 *     handler drops the action — fail-closed by design.
 */
export const moduleTaskflowIsMainControl: Migration = {
  version: 13,
  name: 'module-taskflow-is-main-control',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE agent_groups ADD COLUMN is_main_control INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX idx_agent_groups_one_main_control
        ON agent_groups(is_main_control)
        WHERE is_main_control = 1;
    `);
  },
};
