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
 * links are logged loud here; the migrate-v2.sh step is the cutover HARD gate.
 * No-op when the agent-to-agent module isn't installed (no `agent_destinations`).
 */
export function backfillTaskflowDestinations(tfDb: Database.Database): void {
  if (!hasTable(getDb(), 'agent_destinations')) return;

  try {
    const r = backfillCrossBoardDestinations(tfDb, { dryRun: false, logger: (l) => log.debug(l.trim()) });
    if (r.child_inserted + r.parent_inserted > 0 || r.unresolved > 0) {
      log.info('Cross-board destinations backfilled', { ...r });
    }
    if (r.unresolved > 0) {
      log.warn('Cross-board destination backfill left unresolved board links', { unresolved: r.unresolved });
    }
  } catch (err) {
    log.error('Cross-board destination backfill failed (continuing boot)', { err: String(err) });
  }

  try {
    const r = backfillTaskflowPersonDestinations(tfDb, { dryRun: false, logger: (l) => log.debug(l.trim()) });
    if (r.destinations_inserted > 0 || r.unresolved_boards > 0 || r.name_collisions > 0) {
      log.info('Person destinations backfilled', { ...r });
    }
    if (r.name_collisions > 0) {
      log.warn('Person destination backfill: display-name collisions — duplicate names route to one person', {
        name_collisions: r.name_collisions,
      });
    }
    if (r.unresolved_boards > 0) {
      log.warn('Person destination backfill left unresolved boards', { unresolved: r.unresolved_boards });
    }
  } catch (err) {
    log.error('Person destination backfill failed (continuing boot)', { err: String(err) });
  }
}
