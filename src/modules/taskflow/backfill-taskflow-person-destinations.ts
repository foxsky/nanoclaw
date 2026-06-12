/**
 * Backfill FUNCTION: v2 named destinations from Taskflow's v1-era
 * board_people.notification_group_jid routing data. Lives in src/ so the host
 * startup self-heal imports it; the CLI is
 * scripts/backfill-taskflow-person-destinations.ts.
 *
 * v1 agents could read notification_group_jid from sqlite and call
 * send_message(target_chat_jid=...). v2 intentionally blocks raw sqlite and
 * raw-JID sends; the equivalent behavior is a first-class named destination
 * in agent_destinations pointing at a messaging_groups row.
 */
import { createHash } from 'crypto';

import type Database from 'better-sqlite3';

import { getDb, hasTable } from '../../db/connection.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { createMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { createDestinationEnsurer } from './backfill-destinations-common.js';

interface PersonNotificationRow {
  board_id: string;
  group_folder: string;
  person_id: string;
  name: string;
  notification_group_jid: string;
}

export interface PersonDestinationBackfillReport {
  rows_processed: number;
  unresolved_boards: number;
  messaging_groups_inserted: number;
  messaging_groups_reused: number;
  destinations_inserted: number;
  destinations_skipped: number;
  /** Two people on one board share a display name → agent_destinations keys on
   *  (agent_group_id, local_name), so the 2nd person's existing-name destination
   *  points at the 1st person's group (send_message would mis-route). Detected,
   *  not silently skipped (Codex migration-fidelity review). */
  name_collisions: number;
  dry_run: boolean;
}

export function readPersonNotificationRows(tfDb: Database.Database, boardId?: string): PersonNotificationRow[] {
  const where = [
    boardId ? 'bp.board_id = ?' : '',
    'bp.notification_group_jid IS NOT NULL',
    "TRIM(bp.notification_group_jid) != ''",
  ]
    .filter(Boolean)
    .join(' AND ');
  return tfDb
    .prepare(
      `SELECT bp.board_id, b.group_folder, bp.person_id, bp.name, bp.notification_group_jid
         FROM board_people bp
         JOIN boards b ON b.id = bp.board_id
        WHERE ${where}
        ORDER BY bp.board_id, bp.name`,
    )
    .all(...(boardId ? [boardId] : [])) as PersonNotificationRow[];
}

/**
 * Derive the messaging_groups.id from the JID — the row's REAL identity
 * (messaging_groups dedupes on UNIQUE(channel_type, platform_id)). Deriving it
 * from person_id was LOSSY: two distinct person_ids that normalize to the same
 * string (e.g. `ana-1` / `ana_1`) but route to different JIDs collided on the
 * `id` PK, so the 2nd insert threw UNIQUE and aborted the whole pass mid-loop
 * (Codex xhigh). A hash of the JID is collision-proof and stable across re-runs.
 */
function personMessagingGroupId(jid: string): string {
  return `mg-taskflow-person-${createHash('sha1').update(jid).digest('hex').slice(0, 16)}`;
}

export function backfillTaskflowPersonDestinations(
  tfDb: Database.Database,
  options: { boardId?: string; dryRun: boolean; logger?: (line: string) => void },
): PersonDestinationBackfillReport {
  const log = options.logger ?? (() => undefined);
  if (!hasTable(getDb(), 'agent_destinations')) {
    throw new Error('agent_destinations table missing — agent-to-agent module not installed.');
  }
  const rows = readPersonNotificationRows(tfDb, options.boardId);
  const report: PersonDestinationBackfillReport = {
    rows_processed: rows.length,
    unresolved_boards: 0,
    messaging_groups_inserted: 0,
    messaging_groups_reused: 0,
    destinations_inserted: 0,
    destinations_skipped: 0,
    name_collisions: 0,
    dry_run: options.dryRun,
  };
  const now = new Date().toISOString();
  const ensure = createDestinationEnsurer({ dryRun: options.dryRun, now }).ensure;
  // Messaging groups created (or, in dry-run, WOULD be created) earlier in THIS
  // pass, keyed by JID (the real dedup key — messaging_groups is UNIQUE on
  // (channel_type, platform_id)). Dry-run writes nothing, so without this two
  // people sharing one JID would each "insert" it and the 2nd be a false dup.
  const plannedMgByJid = new Map<string, string>();

  const process = (): void => {
    for (const row of rows) {
      const agentGroup = getAgentGroupByFolder(row.group_folder);
      if (!agentGroup) {
        report.unresolved_boards++;
        log(`  unresolved board folder=${row.group_folder} board_id=${row.board_id}`);
        continue;
      }

      let messagingGroupId =
        getMessagingGroupByPlatform('whatsapp', row.notification_group_jid)?.id ??
        plannedMgByJid.get(row.notification_group_jid);
      if (messagingGroupId) {
        report.messaging_groups_reused++;
      } else {
        messagingGroupId = personMessagingGroupId(row.notification_group_jid);
        log(`  ${options.dryRun ? 'DRY: ' : ''}messaging_group ${messagingGroupId} → ${row.notification_group_jid}`);
        if (!options.dryRun) {
          createMessagingGroup({
            id: messagingGroupId,
            channel_type: 'whatsapp',
            platform_id: row.notification_group_jid,
            name: row.name,
            is_group: 1,
            unknown_sender_policy: 'strict',
            created_at: now,
          });
        }
        plannedMgByJid.set(row.notification_group_jid, messagingGroupId);
        report.messaging_groups_inserted++;
      }

      const outcome = ensure(agentGroup.id, row.name, messagingGroupId);
      if (outcome.status === 'inserted') {
        report.destinations_inserted++;
        log(`  ${options.dryRun ? 'DRY: ' : ''}destination ${agentGroup.id} '${row.name}' → ${messagingGroupId}`);
      } else {
        report.destinations_skipped++;
        // Collision: the name already maps to a DIFFERENT group → a distinct
        // person with the same display name. The 2nd person's send_message({to})
        // would mis-route to the 1st. Surface it (the migrate step reports it as
        // degraded); do NOT overwrite — the operator resolves the duplicate.
        if (outcome.status === 'collision') {
          report.name_collisions++;
          log(
            `  COLLISION: ${agentGroup.id} '${row.name}' already → ${outcome.existingTarget}, not ${messagingGroupId} (person_id=${row.person_id})`,
          );
        }
      }
    }
  };

  // One transaction around the writes: atomic + a single fsync at cutover scale
  // (hundreds of board_people rows) instead of one per insert. Dry-run writes
  // nothing, so it just reads.
  getDb().transaction(process)();
  return report;
}
