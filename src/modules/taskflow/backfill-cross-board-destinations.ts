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
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { createDestinationEnsurer, type EnsureResult } from './backfill-destinations-common.js';

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
  /** A reserved cross-board name (`parent-<folder>` / `source-<folder>`)
   *  already exists pointing at a DIFFERENT messaging group than this link
   *  needs → approval forwarding for the pair is miswired. Detected, not
   *  silently counted as a benign skip (Codex migration-fidelity review:
   *  symmetry with the per-person backfill's name_collisions). */
  name_collisions: number;
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

interface ResolvedBoard {
  agent_group_id: string;
  messaging_group_id: string;
}

/**
 * Resolve a board's (folder, jid) to its v2 agent + messaging group, reusing
 * the db layer (getAgentGroupByFolder + getMessagingGroupsByAgentGroup) instead
 * of a hand-rolled join. Memoized by (folder, jid): a parent board is the
 * resolve target of every one of its children, so the same lookup recurs.
 */
function makeBoardResolver(): (groupFolder: string, groupJid: string) => ResolvedBoard | null {
  const memo = new Map<string, ResolvedBoard | null>();
  return (groupFolder, groupJid) => {
    const key = `${groupFolder}\0${groupJid}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const ag = getAgentGroupByFolder(groupFolder);
    const mg = ag ? getMessagingGroupsByAgentGroup(ag.id).find((m) => m.platform_id === groupJid) : undefined;
    const result = ag && mg ? { agent_group_id: ag.id, messaging_group_id: mg.id } : null;
    memo.set(key, result);
    return result;
  };
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
    name_collisions: 0,
    dry_run: options.dryRun,
  };
  const now = new Date().toISOString();
  const ensure = createDestinationEnsurer({ dryRun: options.dryRun, now }).ensure;
  const resolve = makeBoardResolver();

  // Map one ensure() outcome to the leg's inserted/skipped counters (+ the
  // shared name_collisions), keeping the two legs' bookkeeping identical.
  const recordLeg = (
    result: EnsureResult,
    inserted: 'child_inserted' | 'parent_inserted',
    skipped: 'child_skipped' | 'parent_skipped',
    desc: string,
    want: string,
  ): void => {
    if (result.status === 'inserted') {
      report[inserted]++;
      log(`  ${options.dryRun ? 'DRY: ' : ''}${desc} → ${want}`);
    } else {
      report[skipped]++;
      // Already present pointing at a DIFFERENT group → stale/partial prior
      // migration left forwarding miswired. Surface; do NOT overwrite.
      if (result.status === 'collision') {
        report.name_collisions++;
        log(`  COLLISION: ${desc} already → ${result.existingTarget}, not ${want}`);
      }
    }
  };

  const process = (): void => {
    for (const link of links) {
      const parent = resolve(link.parent_folder, link.parent_group_jid);
      const child = resolve(link.child_folder, link.child_group_jid);
      if (!parent || !child) {
        log(`  unresolved: parent_folder=${link.parent_folder} child_folder=${link.child_folder}`);
        report.unresolved++;
        continue;
      }
      const parentDestName = `parent-${link.parent_folder}`;
      const sourceDestName = `source-${link.child_folder}`;
      recordLeg(
        ensure(child.agent_group_id, parentDestName, parent.messaging_group_id),
        'child_inserted',
        'child_skipped',
        `child ${child.agent_group_id} '${parentDestName}'`,
        parent.messaging_group_id,
      );
      recordLeg(
        ensure(parent.agent_group_id, sourceDestName, child.messaging_group_id),
        'parent_inserted',
        'parent_skipped',
        `parent ${parent.agent_group_id} '${sourceDestName}'`,
        child.messaging_group_id,
      );
    }
  };

  // One transaction around the writes: atomic + a single fsync instead of one
  // per insert. Dry-run writes nothing, so it just reads.
  getDb().transaction(process)();
  return report;
}
