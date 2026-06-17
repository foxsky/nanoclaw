/**
 * TaskFlow overlay: migrate-v2 post-seed step that carries v1
 * `registered_groups.is_main=1` over to v2 `messaging_groups.is_main_control=1`.
 *
 * Registered into the generic migrate-v2 step registry (src/migrate-v2-steps.ts).
 * The `/add-taskflow` installer appends this module's import to
 * `src/migrate-v2-steps-register.ts`. Importing it also pulls in
 * `migrations-register.js` so the `is_main_control` column migration is
 * registered before `runMigrations()` runs in `db.ts` (pristine core never
 * imports either, so the column is never created and this step never runs).
 *
 * Why the carry-over matters: without an `is_main_control=1` row, the
 * main-control privileged tools (provision_root_board, add_destination,
 * send_otp) fail-closed at `permission.ts` from every session — the typical
 * post-cutover bootstrap (provisioning the first root board) is blocked.
 */
import { registerMigrateV2Step, type MigrateV2Context } from '../../migrate-v2-steps.js';
// Side-effect: register the is_main_control column migration so the v2 migrate
// path (runMigrations) creates the column this step writes to.
import './migrations-register.js';
import { getMainControlMessagingGroup, setMainControlMessagingGroup } from './messaging-groups-main-control.js';

registerMigrateV2Step('taskflow-main-control', (ctx: MigrateV2Context): string[] => {
  // v1's is_main=1 row(s), in seed order (db.ts iterates registered_groups
  // ORDER BY rowid, so migrated[] preserves a deterministic order). v1 didn't
  // enforce a singleton — multiple rows could legally have is_main=1 — but v2's
  // partial unique index allows exactly one. Pick the first deterministically
  // and warn on extras. Only groups whose wiring was confirmed (created/reused)
  // are in `migrated`, so a "main" row that errored mid-create is excluded
  // automatically and surfaces in `skipped` instead.
  const mainCandidates = ctx.migrated.filter((m) => m.v1IsMain);
  const skippedMainRows = ctx.skipped.filter((s) => s.v1IsMain).map((s) => `${s.folder} (${s.jid}): ${s.reason}`);

  // Rerun policy: a v2 main already set (operator via ncl, or a prior run) is
  // preserved — first-write-wins; the operator's choice beats v1's mapping. This
  // matches migrate-v2.sh's "safe to re-run" contract.
  let mainPromoted = 0;
  const existingMain = getMainControlMessagingGroup();
  if (existingMain) {
    console.log(
      `INFO:is_main_control already set on "${existingMain.name ?? existingMain.id}" (preserving operator/prior choice)`,
    );
  } else if (mainCandidates.length > 0) {
    const pick = mainCandidates[0];
    setMainControlMessagingGroup(pick.messagingGroupId);
    mainPromoted = 1;
    if (mainCandidates.length > 1) {
      console.log(
        `WARN:multiple v1 is_main=1 rows (${mainCandidates.length}); promoted "${pick.folder}", ignored ${mainCandidates
          .slice(1)
          .map((c) => c.folder)
          .join(', ')}`,
      );
    }
  } else if (skippedMainRows.length > 0) {
    // v1 HAD an is_main=1 row but it was excluded mid-loop (Discord resolver
    // failure, JID parse failure, exception during seed). Point the operator at
    // the underlying cause rather than generic "designate manually".
    console.log(
      `WARN:v1 had ${skippedMainRows.length} is_main=1 row(s) but all were excluded during seed: ${skippedMainRows.join('; ')}. Fix the underlying cause (e.g. refresh DISCORD_BOT_TOKEN) and re-run, or designate manually via /migrate-from-v1.`,
    );
  } else {
    console.log(
      'WARN:no v1 registered_groups.is_main=1 — main-control privileged tools (provision_root_board, add_destination, send_otp) will be unauthorized until /migrate-from-v1 designates a main control group',
    );
  }

  return [`main_promoted=${mainPromoted}`];
});
