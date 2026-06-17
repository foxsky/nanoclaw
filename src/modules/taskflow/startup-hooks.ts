/**
 * ADR 0006 contract #1 registration — TaskFlow startup hooks.
 *
 * Moves the four TaskFlow boot blocks that used to be inline in `src/index.ts`
 * into the core startup-hook registry. Behavior is byte-for-byte the same as the
 * inline blocks; only the call site moved.
 *
 *   post-db (before delivery polls start):
 *     1. bootstrapTaskflowDb        — heavy schema + ALTER TABLE migrations, once.
 *     2. migrate scheduled_tasks    — legacy rows → v2 native messages_in; drop the
 *        legacy table when drained; self-heal MIGRATED boards' agent_destinations.
 *     3. ensureTaskflowServiceSession (CRITICAL) — the always-active synthetic
 *        session whose outbound.db receives FastAPI-originated taskflow_notify
 *        rows. MUST exist before the delivery polls start (the sweep only drains
 *        status='active' sessions); a failure here is fail-loud so the host does
 *        not come up silently unable to deliver engine notifications.
 *
 *   post-services (after delivery polls + host sweep are running):
 *     4. startEmbeddingFeeder (#385) — no-op unless OLLAMA_HOST is set; otherwise
 *        builds/maintains data/embeddings/embeddings.db so api_query 'search'
 *        ranks semantically. Registers its own onShutdown stop.
 *
 * Side-effect module: imported by src/modules/taskflow/index.ts.
 */
import { onShutdown } from '../../response-registry.js';
import { registerStartupHook } from '../../startup-registry.js';
import { backfillTaskflowDestinations } from '../../backfill-taskflow-destinations.js';
import { startEmbeddingFeeder } from '../../embedding-feeder.js';
import { initTaskflowDb } from '../../taskflow-db.js';
import { bootstrapTaskflowDb, taskflowDbPath } from '../../taskflow-mount.js';
import { log } from '../../log.js';
import {
  defaultInboundResolver,
  dropScheduledTasksIfDrained,
  migrateScheduledTasks,
} from './migrate-scheduled-tasks.js';
import { ensureTaskflowServiceSession } from './service-session.js';

// 1a. Bootstrap TaskFlow DB once at startup (heavy schema + ALTER TABLE
// migrations). Container spawns later only re-check existence; the
// long-lived host handles open lazily against this fully-migrated file.
registerStartupHook(
  'post-db',
  'taskflow:bootstrap-db',
  ({ dataDir }) => {
    bootstrapTaskflowDb(dataDir);
    log.info('TaskFlow DB ready');
  },
  { order: 10 },
);

// 1a.1 Migrate any legacy `scheduled_tasks` rows (status active/paused)
// into v2 native messages_in. Idempotent — re-running skips already-
// migrated rows. Existing TaskFlow boards' standup/digest/review tasks
// begin firing through the new path on first host startup after deploy.
registerStartupHook(
  'post-db',
  'taskflow:migrate-scheduled-tasks',
  ({ dataDir }) => {
    const tfDb = initTaskflowDb(taskflowDbPath(dataDir));
    const { resolve, closeAll } = defaultInboundResolver();
    try {
      const result = migrateScheduledTasks(tfDb, resolve);
      log.info('TaskFlow scheduled_tasks migration complete', { ...result });
      // Drop the legacy table once every row has migrated. Re-runs are
      // safe on already-dropped DBs.
      dropScheduledTasksIfDrained(tfDb);
      // Self-heal the agent_destinations rows for MIGRATED boards (the migration
      // pipeline never ran the two backfill translators). Idempotent + fail-soft.
      backfillTaskflowDestinations(tfDb);
    } finally {
      closeAll();
      tfDb.close();
    }
  },
  { order: 20 },
);

// 1d. TaskFlow "service session" (0h-v2 Option A) — the always-active
// synthetic session whose outbound.db receives FastAPI-originated
// `taskflow_notify` rows. Idempotent + self-healing (re-activates if
// ever closed); pollSweep only drains status='active' sessions.
//
// CRITICAL: must exist before the delivery polls start, so it registers in
// the 'post-db' phase (which drains before delivery). Do NOT move it to a
// later phase. A failure re-throws so the host fails loud instead of
// silently never delivering engine notifications.
registerStartupHook(
  'post-db',
  'taskflow:service-session',
  () => {
    ensureTaskflowServiceSession();
    log.info('TaskFlow service session ready');
  },
  { order: 30, critical: true },
);

// 6a. Start the host-side TaskFlow embedding feeder (#385). No-op unless
// OLLAMA_HOST is configured; otherwise builds/maintains
// data/embeddings/embeddings.db (Ollama bge-m3) so the in-container
// api_query 'search' ranks semantically instead of falling back to lexical.
registerStartupHook('post-services', 'taskflow:embedding-feeder', ({ dataDir }) => {
  const embeddingFeeder = startEmbeddingFeeder(dataDir);
  if (embeddingFeeder) onShutdown(() => embeddingFeeder.stop());
});
