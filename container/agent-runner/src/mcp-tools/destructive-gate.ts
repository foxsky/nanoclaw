/**
 * Deterministic policy for which TaskFlow actions are "destructive / mass" and must be
 * held for ADMIN APPROVAL before they execute (operator decision, 2026-06-08).
 *
 * WHY THIS IS A SEPARATE PURE MODULE: the security boundary must be deterministic code, not
 * the agent's prompt. An indirect-prompt-injection ("reassign everything to X", "delete the
 * history", "remove the board") can talk the model into *calling* a legitimate tool — so the
 * tool layer, not the instructions, is what decides whether a high-impact action runs. This
 * module is the pure classifier; the MCP tools call it before mutating, and (next unit) a
 * gated action is routed to a human approver via the host approval round-trip instead of
 * executing. Pure + env-configurable so it is unit-testable and tunable without a rebuild.
 *
 * Scope (the four operator-selected categories):
 *  - mass_mutation     — reassign/move/update touching >= massMutation tasks in one call
 *  - destructive_delete — delete touching >= massDelete tasks, OR any delete that erases
 *                         history/archive rows (irreversible audit loss is always gated)
 *  - structure         — remove board / remove person / revoke admin (board-structure change)
 *  - broadcast         — send_message fan-out to an external dest, or to >= broadcast
 *                        non-current-group destinations
 *
 * Defaults FAIL SAFE toward gating the genuinely unusual: a single reassign/move/update or a
 * single recoverable delete is NOT gated (normal manager work); bulk and irreversible ones are.
 */

export type DestructiveCategory = 'mass_mutation' | 'destructive_delete' | 'structure' | 'broadcast';

export interface GateThresholds {
  /** reassign/move/update affecting >= this many tasks in one call → gated. */
  massMutation: number;
  /** delete affecting >= this many tasks → gated (a single recoverable delete stays open). */
  massDelete: number;
  /** send_message fan-out to >= this many non-current-group destinations → gated. */
  broadcast: number;
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  massMutation: 5,
  massDelete: 3,
  broadcast: 3,
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  // A non-numeric or non-positive override must never DISABLE the gate — fall back to the
  // safe default rather than letting a typo open the floodgates.
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Thresholds with optional env overrides, parsed per call so a systemd-set value is honored
 * without a rebuild and tests can toggle it. A malformed override falls back to the default
 * (fail safe — never disables the gate).
 *   TASKFLOW_GATE_MASS / TASKFLOW_GATE_DELETE / TASKFLOW_GATE_BROADCAST
 */
export function resolveThresholds(env: NodeJS.ProcessEnv = process.env): GateThresholds {
  return {
    massMutation: parsePositiveInt(env.TASKFLOW_GATE_MASS, DEFAULT_THRESHOLDS.massMutation),
    massDelete: parsePositiveInt(env.TASKFLOW_GATE_DELETE, DEFAULT_THRESHOLDS.massDelete),
    broadcast: parsePositiveInt(env.TASKFLOW_GATE_BROADCAST, DEFAULT_THRESHOLDS.broadcast),
  };
}

export type GateAction =
  | { kind: 'mutation'; affected: number }
  | { kind: 'delete'; affected: number; touchesHistory?: boolean }
  | { kind: 'structure'; adminAction?: string }
  | { kind: 'broadcast'; destinations: number; external: boolean };

export interface GateDecision {
  gated: boolean;
  category?: DestructiveCategory;
  reason?: string;
}

const OPEN: GateDecision = { gated: false };

/** api_admin actions that change board / people structure or PRIVILEGE. Gated (held for admin approval). */
export const STRUCTURE_ADMIN_ACTIONS: ReadonlySet<string> = new Set([
  'remove_child_board',
  'remove_person',
  'remove_admin',
  'remove_manager',
  'remove_delegate',
  // #411: merge_project archives an entire source project and re-IDs ALL its subtasks into the target
  // (irreversible renumbering) — an uncounted mass structural change reachable from chat via api_admin.
  'merge_project',
  // #411 (Codex xhigh): PRIVILEGE GRANTS. The old "additive = safe" heuristic predates the injection
  // threat model — granting manager/delegate is a privilege-escalation step (a prompt-injected agent
  // could self-grant the role that unlocks the OTHER gated manager-only actions). Held for approval.
  'add_manager',
  'add_delegate',
  // #411: changes the board-wide cross-board subtask WRITE policy — a structural/policy change that
  // can open cross-board writes for the whole board.
  'set_cross_board_subtask_mode',
]);

/** True iff an api_admin action mutates board/people structure (→ should be gated as 'structure'). */
export function isStructureAdminAction(action: string): boolean {
  return STRUCTURE_ADMIN_ACTIONS.has(action);
}

/**
 * Pure classifier. Returns `{ gated: true, category, reason }` when the action must be held for
 * admin approval, else `{ gated: false }`. Reason is human-readable (for the approval prompt).
 */
export function evaluateDestructiveAction(action: GateAction, thresholds: GateThresholds = resolveThresholds()): GateDecision {
  switch (action.kind) {
    case 'structure':
      return {
        gated: true,
        category: 'structure',
        reason: `board/people structure change${action.adminAction ? ` (${action.adminAction})` : ''} requires admin approval`,
      };

    case 'delete':
      if (action.touchesHistory) {
        return { gated: true, category: 'destructive_delete', reason: 'deletion would erase history/archive rows (irreversible) — requires admin approval' };
      }
      if (action.affected >= thresholds.massDelete) {
        return { gated: true, category: 'destructive_delete', reason: `bulk delete of ${action.affected} tasks (>= ${thresholds.massDelete}) requires admin approval` };
      }
      return OPEN;

    case 'mutation':
      if (action.affected >= thresholds.massMutation) {
        return { gated: true, category: 'mass_mutation', reason: `bulk change to ${action.affected} tasks (>= ${thresholds.massMutation}) requires admin approval` };
      }
      return OPEN;

    case 'broadcast':
      if (action.external) {
        return { gated: true, category: 'broadcast', reason: 'message to an external destination requires admin approval' };
      }
      if (action.destinations >= thresholds.broadcast) {
        return { gated: true, category: 'broadcast', reason: `broadcast to ${action.destinations} destinations (>= ${thresholds.broadcast}) requires admin approval` };
      }
      return OPEN;
  }
}
