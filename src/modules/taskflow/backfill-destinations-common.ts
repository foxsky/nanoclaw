/**
 * Shared composite for the two destination backfills (cross-board + person).
 *
 * Both used to hand-copy the same exists → target-compare → collision-or-skip →
 * dry-run → insert sequence 3× (cross-board child leg, cross-board parent leg,
 * person), and the copies had already DIVERGED (the person copy grew an in-pass
 * dedup the cross-board copy lacked) — which is exactly where the wrong-target
 * silent-skip and lossy-id bugs lived. Centralizing it removes the divergence
 * seam and folds in a per-agent-group destination cache so the hot loop does
 * ONE `getDestinations()` load per agent group (memoized) instead of a
 * point-query per row.
 *
 * Returns the outcome; the caller maps it to its own (differently-named) report
 * counters and logs the caller-specific collision message. Both backfills target
 * a messaging_group, so target_type is always 'channel'.
 */
import { createDestination, getDestinations } from '../agent-to-agent/db/agent-destinations.js';

export type EnsureOutcome = 'inserted' | 'skipped' | 'collision';

export interface EnsureResult {
  status: EnsureOutcome;
  /** On 'collision' (and 'skipped'), the target the name ALREADY points at —
   *  for the caller's diagnostic log. Undefined on 'inserted'. */
  existingTarget?: string;
}

export interface DestinationEnsurer {
  /**
   * Ensure agent `agentGroupId` has a destination `localName` → `targetId`.
   * - 'inserted'  — was absent; created (or, in dry-run, WOULD be created).
   * - 'skipped'   — already present pointing at the SAME target (idempotent).
   * - 'collision' — already present pointing at a DIFFERENT target; NOT
   *                 overwritten (the caller surfaces it; operator resolves it).
   */
  ensure(agentGroupId: string, localName: string, targetId: string): EnsureResult;
}

export function createDestinationEnsurer(opts: { dryRun: boolean; now: string }): DestinationEnsurer {
  // agentGroupId -> (local_name -> target_id), lazily hydrated from the DB and
  // then updated in-memory as rows are (would-be) inserted, so a later
  // same-(agent, name) row in THIS pass is seen even in dry-run (nothing written).
  const cache = new Map<string, Map<string, string>>();

  function cacheFor(agentGroupId: string): Map<string, string> {
    let m = cache.get(agentGroupId);
    if (!m) {
      m = new Map();
      for (const d of getDestinations(agentGroupId)) m.set(d.local_name, d.target_id);
      cache.set(agentGroupId, m);
    }
    return m;
  }

  return {
    ensure(agentGroupId, localName, targetId) {
      const m = cacheFor(agentGroupId);
      const prior = m.get(localName);
      if (prior !== undefined) {
        return { status: prior === targetId ? 'skipped' : 'collision', existingTarget: prior };
      }
      m.set(localName, targetId); // reserve the name for this pass (dry-run too)
      if (!opts.dryRun) {
        createDestination({
          agent_group_id: agentGroupId,
          local_name: localName,
          target_type: 'channel',
          target_id: targetId,
          created_at: opts.now,
        });
      }
      return { status: 'inserted' };
    },
  };
}
