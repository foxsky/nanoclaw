// TaskFlow install-overlay — fork-owned main-control DB primitives (ADR 0006,
// EXTRACT_TO_OVERLAY of the is_main_control logic out of src/db/messaging-groups.ts).
//
// These reintroduce v1's `registered_groups.isMain` semantics on the v2 schema:
// exactly one messaging_groups row may be the operator's main-control chat. The
// column + partial unique index are added by
// src/db/migrations/module-taskflow-main-control.ts; the `is_main_control?` TS
// field is re-attached to core's MessagingGroup by
// src/modules/taskflow/types-augment.d.ts. The authorization gate that consumes
// this flag lives in src/modules/taskflow/permission.ts.
//
// SECURITY: do not relax any guard here. The fail-closed throw on an unknown id,
// the single atomic clear+set transaction (the partial unique index must never
// see a transient two-main state), and the v1-parity always-engage side effect
// are all load-bearing and were ported VERBATIM from core.
import type { MessagingGroup } from '../../types.js';
import { getDb } from '../../db/connection.js';

/**
 * Designate `id` as THE main control messaging group (v1 isMain parity).
 * Atomically clears any existing main and sets the new one in a single
 * transaction so the partial unique index never sees a transient two-main
 * state.
 *
 * Throws if the target id doesn't exist (fail-closed against typos).
 *
 * Side effect: also sets the designated group's wired agents to always-engage
 * (engage_mode='pattern', engage_pattern='.'). The main control group is the
 * operator's command channel and must answer every message (v1 parity), and the
 * router ignores is_main_control when deciding engagement.
 *
 * Designed to be called by:
 *   - Skill bootstrap step (one-time during install).
 *   - Admin command path (operator can re-designate later).
 *
 * Returns the id of a DIFFERENT main that was demoted (or null on first/same-id
 * designation). Re-designation leaves the demoted main's wired agents at
 * always-engage (engage_pattern='.') — that is NOT auto-reverted because the
 * pre-promotion engage config isn't stored and the safe default differs for a
 * DM (always-engage is fine) vs a group (would keep spamming). Callers should
 * warn the operator to reconfigure the old main's engagement.
 */
export function setMainControlMessagingGroup(id: string): string | null {
  const db = getDb();
  let demotedPreviousMain: string | null = null;
  db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM messaging_groups WHERE id = ?').get(id);
    if (!exists) {
      throw new Error(`setMainControlMessagingGroup: messaging group "${id}" does not exist`);
    }
    const prev = db.prepare('SELECT id FROM messaging_groups WHERE is_main_control = 1 AND id != ?').get(id) as
      | { id: string }
      | undefined;
    demotedPreviousMain = prev?.id ?? null;
    db.prepare('UPDATE messaging_groups SET is_main_control = 0 WHERE is_main_control = 1').run();
    db.prepare('UPDATE messaging_groups SET is_main_control = 1 WHERE id = ?').run(id);
    // The main control group is the operator's command channel — it must respond
    // to EVERY message, not just triggered/mentioned ones (v1 parity: the main
    // group always-engaged). The router gates purely on engage_mode/engage_pattern
    // and ignores is_main_control, so always-engage its wired agents here. (Agents
    // wired AFTER designation aren't covered — in the migration/bootstrap flows
    // wiring precedes designation, so the operator's existing agents are caught.)
    db.prepare(
      "UPDATE messaging_group_agents SET engage_mode = 'pattern', engage_pattern = '.' WHERE messaging_group_id = ?",
    ).run(id);
  })();
  return demotedPreviousMain;
}

/**
 * Returns the current main control messaging group, or undefined if none
 * has been designated yet (fresh install before bootstrap, or operator
 * cleared it). Privileged-action handlers MUST treat undefined as a
 * fail-closed signal — drop the action with a warn log.
 */
export function getMainControlMessagingGroup(): MessagingGroup | undefined {
  return getDb().prepare('SELECT * FROM messaging_groups WHERE is_main_control = 1').get() as
    | MessagingGroup
    | undefined;
}
