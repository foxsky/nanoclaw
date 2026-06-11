/**
 * A12-part-2 backfill FUNCTION: register cross-board approval destinations for
 * existing parent↔child wirings that predate A12. Lives in src/ so the startup
 * self-heal (src/backfill-taskflow-destinations.ts) imports it; the CLI is
 * scripts/backfill-cross-board-destinations.ts.
 *
 * Each (parent_board, child_board) pair gets two agent_destinations rows
 * (idempotent — skipped when present):
 *   - On child agent: local_name='parent-<parent_folder>' → parent's
 *     messaging_group.
 *   - On parent agent: local_name='source-<child_folder>' → child's
 *     messaging_group.
 *
 * Pairs are walked from taskflow.db: boards.parent_board_id (primary
 * parent) UNION child_board_registrations (multi-parent links). The
 * board → agent_group bridge goes through messaging_groups.platform_id =
 * boards.group_jid, then messaging_group_agents.
 */

import type Database from 'better-sqlite3';
import { getDb, hasTable } from '../../db/connection.js';
import { createDestination, getDestinationByName } from '../../modules/agent-to-agent/db/agent-destinations.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';

interface BoardLink {
  parent_board_id: string;
  parent_folder: string;
  parent_group_jid: string;
  child_board_id: string;
  child_folder: string;
  child_group_jid: string;
}

export interface BackfillReport {
  links_processed: number;
  unresolved: number;
  child_inserted: number;
  child_skipped: number;
  parent_inserted: number;
  parent_skipped: number;
  /** When dry_run=true, inserted counts reflect WOULD-INSERT operations
   *  (no rows actually written). */
  dry_run: boolean;
}

export function readBoardLinks(tfDb: Database.Database): BoardLink[] {
  // Primary-parent edges via boards.parent_board_id + cross-parent
  // registrations via child_board_registrations. UNION dedupes.
  return tfDb
    .prepare(
      `SELECT p.id AS parent_board_id, p.group_folder AS parent_folder, p.group_jid AS parent_group_jid,
              c.id AS child_board_id,  c.group_folder AS child_folder,  c.group_jid  AS child_group_jid
         FROM boards c
         JOIN boards p ON p.id = c.parent_board_id
        WHERE c.parent_board_id IS NOT NULL
       UNION
       SELECT p.id, p.group_folder, p.group_jid,
              c.id, c.group_folder, c.group_jid
         FROM child_board_registrations cbr
         JOIN boards p ON p.id = cbr.parent_board_id
         JOIN boards c ON c.id = cbr.child_board_id`,
    )
    .all() as BoardLink[];
}

function resolveAgentAndMessagingGroup(
  groupFolder: string,
  groupJid: string,
): { agent_group_id: string; messaging_group_id: string } | null {
  const ag = getAgentGroupByFolder(groupFolder);
  if (!ag) return null;
  const mg = getDb()
    .prepare(
      `SELECT mg.id AS messaging_group_id
         FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mga.agent_group_id = ? AND mg.platform_id = ?`,
    )
    .get(ag.id, groupJid) as { messaging_group_id: string } | undefined;
  if (!mg) return null;
  return { agent_group_id: ag.id, messaging_group_id: mg.messaging_group_id };
}

/**
 * Pure-function entry point: reads links from `tfDb`, looks up the v2
 * agent+mg via `getDb()` (caller must have initDb'd it), inserts (or
 * dry-counts) missing destinations. Idempotent.
 */
export function backfillCrossBoardDestinations(
  tfDb: Database.Database,
  options: { dryRun: boolean; logger?: (line: string) => void },
): BackfillReport {
  const log = options.logger ?? (() => undefined);
  if (!hasTable(getDb(), 'agent_destinations')) {
    throw new Error('agent_destinations table missing — agent-to-agent module not installed.');
  }
  const links = readBoardLinks(tfDb);
  const report: BackfillReport = {
    links_processed: links.length,
    unresolved: 0,
    child_inserted: 0,
    child_skipped: 0,
    parent_inserted: 0,
    parent_skipped: 0,
    dry_run: options.dryRun,
  };
  const now = new Date().toISOString();

  for (const link of links) {
    const parent = resolveAgentAndMessagingGroup(link.parent_folder, link.parent_group_jid);
    const child = resolveAgentAndMessagingGroup(link.child_folder, link.child_group_jid);
    if (!parent || !child) {
      log(`  unresolved: parent_folder=${link.parent_folder} child_folder=${link.child_folder}`);
      report.unresolved++;
      continue;
    }

    const parentDestName = `parent-${link.parent_folder}`;
    const sourceDestName = `source-${link.child_folder}`;

    if (getDestinationByName(child.agent_group_id, parentDestName)) {
      report.child_skipped++;
    } else if (options.dryRun) {
      log(`  DRY: child ${child.agent_group_id} += '${parentDestName}' → ${parent.messaging_group_id}`);
      report.child_inserted++;
    } else {
      createDestination({
        agent_group_id: child.agent_group_id,
        local_name: parentDestName,
        target_type: 'channel',
        target_id: parent.messaging_group_id,
        created_at: now,
      });
      report.child_inserted++;
    }

    if (getDestinationByName(parent.agent_group_id, sourceDestName)) {
      report.parent_skipped++;
    } else if (options.dryRun) {
      log(`  DRY: parent ${parent.agent_group_id} += '${sourceDestName}' → ${child.messaging_group_id}`);
      report.parent_inserted++;
    } else {
      createDestination({
        agent_group_id: parent.agent_group_id,
        local_name: sourceDestName,
        target_type: 'channel',
        target_id: child.messaging_group_id,
        created_at: now,
      });
      report.parent_inserted++;
    }
  }
  return report;
}
