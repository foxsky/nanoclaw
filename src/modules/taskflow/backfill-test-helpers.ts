/**
 * Shared seed helpers for the destination-backfill tests (cross-board +
 * startup self-heal), which otherwise hand-copied an identical `seedBoard` +
 * `seedV2Wiring` pair. Test-only; not imported by runtime code.
 *
 * (The per-person backfill test keeps its own single-board seeder — its shape
 * differs enough that sharing would obscure rather than dedupe.)
 */
import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';

const SEED_NOW = '2026-01-01T00:00:00.000Z';

/** Seed one taskflow.db board (+ its board_config) at the given hierarchy level. */
export function seedBoard(
  tfDb: Database.Database,
  id: string,
  folder: string,
  groupJid: string,
  parentId: string | null,
  level: number,
): void {
  tfDb
    .prepare(
      `INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code)
         VALUES (?, ?, ?, 'hierarchy', ?, 3, ?, NULL)`,
    )
    .run(id, groupJid, folder, level, parentId);
  tfDb.prepare('INSERT INTO board_config (board_id, wip_limit) VALUES (?, 7)').run(id);
}

/** Seed the v2 agent_group + messaging_group + wiring for a migrated board. */
export function seedV2Wiring(agentId: string, folder: string, mgId: string, platformId: string): void {
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, 'claude', ?)`)
    .run(agentId, folder, folder, SEED_NOW);
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, is_main_control, created_at)
         VALUES (?, 'whatsapp', ?, ?, 1, 'strict', 0, ?)`,
    )
    .run(mgId, platformId, folder, SEED_NOW);
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
         VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'shared', 0, ?)`,
    )
    .run(`mga-${agentId}`, mgId, agentId, SEED_NOW);
}
