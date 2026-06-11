/**
 * #419 follow-up (delta-parity audit 2026-06-10, HIGH) — resolve the
 * HOST-authenticated turn-actor sender to a board person.
 *
 * The turn-actor channel pins the verbatim inbound `content.sender`. On the
 * chat-SDK bridge that is the author display name, but on the native WhatsApp
 * adapter it is the participant JID ('5586…@s.whatsapp.net') — and the engine's
 * resolvePerson has no phone/JID path, so binding the raw JID into sender_name
 * made every person-gated operation (isManager / isAssignee / no-self-approval)
 * fail on a live WhatsApp board. V1 never hit this because the AGENT resolved
 * the sender (template Sender Identification rules, incl. the phone-match rule)
 * and the engine trusted its person_id; #419 deliberately stopped trusting the
 * model, so the phone-match rule must now run deterministically HERE.
 *
 * Resolution order, all scoped to the authenticated board:
 *   1. exact person_id / name match (the pre-existing comment-author rule);
 *   2. for JID/phone-shaped senders only: normalized phone-digit match against
 *      board_people.phone.
 * Fail-closed: no match, an AMBIGUOUS phone match (two people sharing a phone —
 * the EX-015 dual-person case), or any DB error → null. Callers keep the raw
 * sender, which the engine cannot resolve — person-gated operations are denied
 * rather than mis-attributed.
 */
import type { Database } from 'bun:sqlite';

import { getTaskflowDb } from '../db/connection.js';
import { normalizePhone } from '../taskflow-engine.js';

/** A host-authenticated WhatsApp sender: bare digits, or digits(:device)@host. */
const JID_OR_PHONE_RE = /^\d{8,}(?::\d+)?(?:@[a-z0-9.]+)?$/i;

export interface ResolvedSenderPerson {
  personId: string;
  name: string;
}

export function resolveAuthenticatedSenderPerson(
  boardId: string,
  sender: string,
  db?: Database,
): ResolvedSenderPerson | null {
  try {
    // Acquired inside the try: a missing/unopenable taskflow DB (non-taskflow
    // session, engine-only test context) must resolve to null, not throw.
    const handle = db ?? getTaskflowDb();
    const exact = handle
      .prepare(
        `SELECT person_id, name FROM board_people
         WHERE board_id = ? AND (person_id = ? OR name = ?)
         ORDER BY (person_id = ?) DESC, person_id ASC LIMIT 1`,
      )
      .get(boardId, sender, sender, sender) as { person_id: string; name: string } | null;
    if (exact) return { personId: exact.person_id, name: exact.name };

    if (!JID_OR_PHONE_RE.test(sender)) return null;
    const digits = sender.split('@')[0].split(':')[0];
    const want = normalizePhone(digits);
    if (!want) return null;
    const rows = handle
      .prepare(
        `SELECT person_id, name, phone FROM board_people
         WHERE board_id = ? AND phone IS NOT NULL AND phone != ''`,
      )
      .all(boardId) as Array<{ person_id: string; name: string; phone: string }>;
    const matches = rows.filter((r) => normalizePhone(String(r.phone)) === want);
    if (matches.length !== 1) return null;
    return { personId: matches[0].person_id, name: matches[0].name };
  } catch {
    return null;
  }
}
