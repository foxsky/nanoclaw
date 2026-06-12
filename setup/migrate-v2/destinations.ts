/**
 * migrate-v2 step: destinations
 *
 * Backfill the `agent_destinations` rows that MIGRATED TaskFlow boards need but
 * the core seed never created:
 *   - cross-board approval forwarding (`parent-<folder>` / `source-<folder>`)
 *   - per-person send_message (`board_people.notification_group_jid`)
 *
 * Both translators are idempotent and ALSO re-run by the host startup self-heal
 * (src/backfill-taskflow-destinations.ts), so this step is OBSERVABILITY only:
 * unresolved wiring / name collisions become `ERROR:` lines → run_step marks the
 * migration "degraded" (summary + handoff.json). It never aborts — the gap is
 * recoverable (fix the wiring, reboot; the self-heal re-applies it).
 *
 * Requires: db step (agent_groups + messaging_groups) AND taskflow step (the
 * copied taskflow.db) must have run first.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/destinations.ts [<v1-path>]
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../../src/config.js';
import { initDb, getDb, closeDb, hasTable } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { taskflowDbPath } from '../../src/taskflow-mount.js';
import { backfillCrossBoardDestinations } from '../../src/modules/taskflow/backfill-cross-board-destinations.js';
import { backfillTaskflowPersonDestinations } from '../../src/modules/taskflow/backfill-taskflow-person-destinations.js';

function main(): void {
  const tfPath = taskflowDbPath(DATA_DIR);
  if (!fs.existsSync(tfPath)) {
    // v1 had no taskflow.db (taskflow step skipped) → nothing to backfill.
    // Non-zero so run_step routes to the skipped branch, not silent "success".
    console.log('SKIPPED:no taskflow.db');
    process.exit(1);
  }

  const v2DbPath = path.join(DATA_DIR, 'v2.db');
  if (!fs.existsSync(v2DbPath)) {
    console.error('v2.db not found — run db step first');
    process.exit(1);
  }

  initDb(v2DbPath);
  runMigrations(getDb());
  if (!hasTable(getDb(), 'agent_destinations')) {
    console.log('SKIPPED:agent-to-agent module not installed');
    closeDb();
    process.exit(1);
  }

  const tfDb = new Database(tfPath, { readonly: true, fileMustExist: true });
  const cross = backfillCrossBoardDestinations(tfDb, { dryRun: false, logger: (l) => console.log(l) });
  const person = backfillTaskflowPersonDestinations(tfDb, { dryRun: false, logger: (l) => console.log(l) });
  tfDb.close();

  // Recoverable data-quality conditions → `ERROR:` lines so run_step promotes
  // the step to "degraded" (NOT a hard failure — the self-heal heals it later).
  if (cross.unresolved > 0) {
    console.error(`ERROR: ${cross.unresolved} cross-board link(s) unresolved — approval forwarding stays unwired.`);
  }
  if (cross.name_collisions > 0) {
    console.error(
      `ERROR: ${cross.name_collisions} cross-board name collision(s) — a reserved parent-/source- name points at a different group.`,
    );
  }
  if (person.unresolved_boards > 0) {
    console.error(
      `ERROR: ${person.unresolved_boards} person board(s) unresolved — per-person forwarding stays unwired.`,
    );
  }
  if (person.name_collisions > 0) {
    console.error(
      `ERROR: ${person.name_collisions} display-name collision(s) — a person's send_message could mis-route to a same-named teammate.`,
    );
  }

  console.log(
    `OK:cross_child=${cross.child_inserted},cross_parent=${cross.parent_inserted},` +
      `cross_unresolved=${cross.unresolved},cross_collisions=${cross.name_collisions},` +
      `person_dest=${person.destinations_inserted},person_mg=${person.messaging_groups_inserted},` +
      `person_unresolved=${person.unresolved_boards},person_collisions=${person.name_collisions}`,
  );
  closeDb();
}

try {
  main();
} catch (err) {
  console.error(`FAIL:${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
