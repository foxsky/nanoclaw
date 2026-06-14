import Database from 'better-sqlite3';
import path from 'path';

import { brPhoneMatchVariants } from './phone.js';

let _taskflowDb: Database.Database | null = null;

/** Lazily open taskflow.db and cache the handle. Writable access is required for lazy expiry/backfill. */
export function getTaskflowDb(dataDir: string): Database.Database | null {
  if (_taskflowDb) return _taskflowDb;
  const dbPath = path.join(dataDir, 'taskflow', 'taskflow.db');
  try {
    _taskflowDb = new Database(dbPath, { fileMustExist: true });
    // DELETE (not WAL) — see src/taskflow-db.ts for the cross-mount rationale.
    _taskflowDb.pragma('journal_mode = DELETE');
    _taskflowDb.pragma('busy_timeout = 5000');
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
export function resolveExternalDm(db: Database.Database, dmJid: string): DmRouteResult | null {
  // Guard: if external_contacts table doesn't exist yet, return null gracefully
  const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='external_contacts'`).get();
  if (!tableCheck) return null;

  // 1. Resolve external contact by direct_chat_jid. Identity here IS
  // authentication, so a JID that maps to >1 active contact is ambiguous and
  // MUST fail closed — the schema does not make direct_chat_jid unique, and
  // `.get()` would silently route the first row (impersonation risk). Use
  // `.all()` and bail on ambiguity.
  let contact: { external_id: string; display_name: string; phone: string } | undefined;
  const jidMatches = db
    .prepare(
      `SELECT external_id, display_name, phone FROM external_contacts
       WHERE direct_chat_jid = ? AND status = 'active'`,
    )
    .all(dmJid) as Array<{ external_id: string; display_name: string; phone: string }>;
  if (jidMatches.length > 1) return null;
  if (jidMatches.length === 1) contact = jidMatches[0];

  // 2. Fallback: extract phone from JID and match. RC5-ext: the stored phone may
  // differ from the inbound JID only by the BR mobile 9th digit (12- vs 13-digit
  // form of the same number), so match the equivalence set rather than exact
  // equality. Fail closed if >1 distinct contact matches — never route an
  // external into the wrong board's grants.
  if (!contact) {
    const rawPhone = dmJid.replace(/@s\.whatsapp\.net$/, '').replace(/:\d+$/, '');
    const variants = brPhoneMatchVariants(rawPhone);
    if (variants.length > 0) {
      const placeholders = variants.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT external_id, display_name, phone FROM external_contacts
           WHERE status = 'active' AND phone IN (${placeholders})`,
        )
        .all(...variants) as Array<{ external_id: string; display_name: string; phone: string }>;
      if (rows.length === 1) contact = rows[0];
    }

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
      ).run(now, g.board_id, g.meeting_task_id, g.occurrence_scheduled_at, contact.external_id);
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
