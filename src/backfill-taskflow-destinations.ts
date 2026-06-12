import type Database from 'better-sqlite3';

import { backfillCrossBoardDestinations } from './modules/taskflow/backfill-cross-board-destinations.js';
import { backfillTaskflowPersonDestinations } from './modules/taskflow/backfill-taskflow-person-destinations.js';
import { getDb, hasTable } from './db/connection.js';
import { log } from './log.js';

/**
 * Startup self-heal (migration-fidelity F1/F2). MIGRATED TaskFlow boards never
 * get the `agent_destinations` rows that two V1 features depend on:
 *   - cross-board approval forwarding — the engine emits symbolic
 *     `parent-<folder>` / `source-<folder>` destination names; an unresolved
 *     name is a hard `Unknown destination` error.
 *   - per-person `send_message({ to: '<name>' })` — needs a row per
 *     `board_people.notification_group_jid`.
 * Those rows are auto-wired ONLY at v2 provision time; the migration pipeline
 * (migrate-v2.sh / setup/migrate-v2/) never invoked the two backfill translators
 * that seed them for already-existing boards. Run both idempotently on every boot
 * (each skips rows that already exist) so a migrated board's named destinations
 * exist before its first wake.
 *
 * Fail-soft: a backfill error must NEVER crash boot. Collisions / unresolved
 * links are logged loud here; the migrate-v2.sh 1g/1h steps surface the same
 * conditions as a "degraded" migration (they do NOT abort — this self-heal
 * re-runs them every boot, so the gap is recoverable once the wiring is fixed).
 * No-op when the agent-to-agent module isn't installed (no `agent_destinations`).
 */
/**
 * Run one backfill fail-soft: an error must NEVER crash boot. Surface inserts
 * (info) and the recoverable data-quality conditions (warn) using the counts the
 * caller distills from its differently-shaped report.
 */
function heal(
  label: string,
  run: () => { inserted: number; unresolved: number; collisions: number; report: object },
): void {
  try {
    const { inserted, unresolved, collisions, report } = run();
    if (inserted > 0 || unresolved > 0 || collisions > 0) {
      log.info(`${label} backfilled`, { ...report });
    }
    if (collisions > 0) {
      // Metadata key kept as `name_collisions` (not `collisions`) so existing
      // log alerts that key on it keep firing.
      log.warn(
        `${label} backfill: ${collisions} name collision(s) — a reserved/duplicate name points at the wrong group`,
        {
          name_collisions: collisions,
        },
      );
    }
    if (unresolved > 0) {
      log.warn(`${label} backfill: ${unresolved} unresolved`, { unresolved });
    }
  } catch (err) {
    log.error(`${label} backfill failed (continuing boot)`, { err: String(err) });
  }
}

export function backfillTaskflowDestinations(tfDb: Database.Database): void {
  if (!hasTable(getDb(), 'agent_destinations')) return;
  const logger = (l: string): void => log.debug(l.trim());

  heal('Cross-board destinations', () => {
    const r = backfillCrossBoardDestinations(tfDb, { dryRun: false, logger });
    return {
      inserted: r.child_inserted + r.parent_inserted,
      unresolved: r.unresolved,
      collisions: r.name_collisions,
      report: r,
    };
  });
  heal('Person destinations', () => {
    const r = backfillTaskflowPersonDestinations(tfDb, { dryRun: false, logger });
    return {
      inserted: r.destinations_inserted,
      unresolved: r.unresolved_boards,
      collisions: r.name_collisions,
      report: r,
    };
  });
}
