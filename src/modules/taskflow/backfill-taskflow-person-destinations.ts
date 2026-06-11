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
import type Database from 'better-sqlite3';

import { getDb, hasTable } from '../../db/connection.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { createDestination, getDestinationByName } from '../../modules/agent-to-agent/db/agent-destinations.js';

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

function normalizeIdPart(value: string): string {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
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

function findMessagingGroupId(channelType: string, platformId: string): string | null {
  const row = getDb()
    .prepare('SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?')
    .get(channelType, platformId) as { id: string } | undefined;
  return row?.id ?? null;
}

function insertMessagingGroup(id: string, platformId: string, name: string, now: string, dryRun: boolean): void {
  if (dryRun) return;
  getDb()
    .prepare(
      `INSERT INTO messaging_groups
         (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'whatsapp', ?, ?, 1, 'strict', ?)`,
    )
    .run(id, platformId, name, now);
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

  for (const row of rows) {
    const agentGroup = getAgentGroupByFolder(row.group_folder);
    if (!agentGroup) {
      report.unresolved_boards++;
      log(`  unresolved board folder=${row.group_folder} board_id=${row.board_id}`);
      continue;
    }

    let messagingGroupId = findMessagingGroupId('whatsapp', row.notification_group_jid);
    if (messagingGroupId) {
      report.messaging_groups_reused++;
    } else {
      messagingGroupId = `mg-taskflow-person-${normalizeIdPart(row.group_folder)}-${normalizeIdPart(row.person_id)}`;
      log(`  ${options.dryRun ? 'DRY: ' : ''}messaging_group ${messagingGroupId} → ${row.notification_group_jid}`);
      insertMessagingGroup(messagingGroupId, row.notification_group_jid, row.name, now, options.dryRun);
      report.messaging_groups_inserted++;
    }

    const existing = getDestinationByName(agentGroup.id, row.name);
    if (existing) {
      report.destinations_skipped++;
      // Collision: the name already maps to a DIFFERENT group → a distinct
      // person with the same display name. The 2nd person's send_message({to})
      // would mis-route to the 1st. Surface it (the migrate step gates on it);
      // do NOT overwrite — the operator resolves the duplicate.
      if (existing.target_id !== messagingGroupId) {
        report.name_collisions++;
        log(
          `  COLLISION: ${agentGroup.id} '${row.name}' already → ${existing.target_id}, not ${messagingGroupId} (person_id=${row.person_id})`,
        );
      }
      continue;
    }
    if (options.dryRun) {
      report.destinations_inserted++;
      log(`  DRY: destination ${agentGroup.id} '${row.name}' → ${messagingGroupId}`);
      continue;
    }
    createDestination({
      agent_group_id: agentGroup.id,
      local_name: row.name,
      target_type: 'channel',
      target_id: messagingGroupId,
      created_at: now,
    });
    report.destinations_inserted++;
  }

  return report;
}
