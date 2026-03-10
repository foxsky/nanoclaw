import Database from 'better-sqlite3';
import path from 'path';

let _taskflowDb: Database.Database | null = null;

/** Lazily open taskflow.db and cache the handle. Writable access is required for lazy expiry/backfill. */
export function getTaskflowDb(dataDir: string): Database.Database | null {
  if (_taskflowDb) return _taskflowDb;
  const dbPath = path.join(dataDir, 'taskflow', 'taskflow.db');
  try {
    _taskflowDb = new Database(dbPath);
    return _taskflowDb;
  } catch {
    return null;
  }
}

export interface DmGrant {
  boardId: string;
  meetingTaskId: string;
  occurrenceScheduledAt: string;
  inviteStatus: string;
  accessExpiresAt: string | null;
}

export interface DmRouteResult {
  externalId: string;
  displayName: string;
  groupJid: string;
  groupFolder: string;
  grants: DmGrant[];
  /** True when active grants span multiple distinct groups — orchestrator must send disambiguation prompt, not route. */
  needsDisambiguation: boolean;
}

/**
 * Resolve an inbound DM JID to a board group for routing.
 * Returns null if the sender has no active external-contact grants.
 * Performs lazy expiry: if access_expires_at is past, updates status to 'expired'.
 */
export function resolveExternalDm(
  db: Database.Database,
  dmJid: string,
): DmRouteResult | null {
  // 1. Resolve external contact by direct_chat_jid
  let contact = db
    .prepare(
      `SELECT external_id, display_name, phone FROM external_contacts
       WHERE direct_chat_jid = ? AND status = 'active'`,
    )
    .get(dmJid) as
    | { external_id: string; display_name: string; phone: string }
    | undefined;

  // 2. Fallback: extract phone from JID and match
  if (!contact) {
    const phone = dmJid.replace(/@s\.whatsapp\.net$/, '');
    contact = db
      .prepare(
        `SELECT external_id, display_name, phone FROM external_contacts
         WHERE phone = ? AND status = 'active'`,
      )
      .get(phone) as
      | { external_id: string; display_name: string; phone: string }
      | undefined;

    // Backfill direct_chat_jid for future fast lookups
    if (contact) {
      db.prepare(
        `UPDATE external_contacts SET direct_chat_jid = ?, updated_at = ?
         WHERE external_id = ?`,
      ).run(dmJid, new Date().toISOString(), contact.external_id);
    }
  }

  if (!contact) return null;

  // 3. Find active grants
  const now = new Date().toISOString();
  const grants = db
    .prepare(
      `SELECT mep.board_id, mep.meeting_task_id, mep.occurrence_scheduled_at,
              mep.invite_status, mep.access_expires_at,
              b.group_jid, b.group_folder
       FROM meeting_external_participants mep
       JOIN boards b ON b.id = mep.board_id
       WHERE mep.external_id = ?
         AND mep.invite_status IN ('accepted', 'invited', 'pending')`,
    )
    .all(contact.external_id) as Array<{
    board_id: string;
    meeting_task_id: string;
    occurrence_scheduled_at: string;
    invite_status: string;
    access_expires_at: string | null;
    group_jid: string;
    group_folder: string;
  }>;

  // 4. Lazy expiry check
  const active: typeof grants = [];
  for (const g of grants) {
    if (g.access_expires_at && g.access_expires_at < now) {
      db.prepare(
        `UPDATE meeting_external_participants
         SET invite_status = 'expired', updated_at = ?
         WHERE board_id = ? AND meeting_task_id = ? AND occurrence_scheduled_at = ? AND external_id = ?`,
      ).run(
        now,
        g.board_id,
        g.meeting_task_id,
        g.occurrence_scheduled_at,
        contact.external_id,
      );
    } else {
      active.push(g);
    }
  }

  if (active.length === 0) return null;

  // 5. Disambiguation is only needed when grants span multiple distinct groups,
  // because the orchestrator must pick a single group to route to. Multiple
  // grants on the *same* group (e.g., invited to M1 and M2 on one board) are
  // fine — the agent receives all grant IDs in the context tag and can resolve
  // which meeting the user means from message content.
  const primary = active[0];
  const distinctGroups = new Set(active.map((g) => g.group_jid));
  return {
    externalId: contact.external_id,
    displayName: contact.display_name,
    groupJid: primary.group_jid,
    groupFolder: primary.group_folder,
    grants: active.map((g) => ({
      boardId: g.board_id,
      meetingTaskId: g.meeting_task_id,
      occurrenceScheduledAt: g.occurrence_scheduled_at,
      inviteStatus: g.invite_status,
      accessExpiresAt: g.access_expires_at,
    })),
    needsDisambiguation: distinctGroups.size > 1,
  };
}
