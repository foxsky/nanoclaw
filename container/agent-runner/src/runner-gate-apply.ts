/**
 * Container-side application of the scheduled-runner gate (mirror of the host sweep gate in
 * src/modules/taskflow/runner-gate-apply.ts). The host works on raw messages_in rows; the warm
 * container instead gets the due runners in its pending-message batch, so this layer takes that
 * batch, computes each [TF-*] runner's board state, and decides via the shared policy.
 *
 * Suppressed runners are marked `completed` (processing_ack in outbound.db) — exactly how a normal
 * processed message ends — so the host syncs the ack to messages_in.status='completed', which both
 * drops the runner from the next wake AND lets handleRecurrence advance it to its next occurrence.
 * Dropping them from the returned batch is what stops the warm container posting a runner the host
 * sweep would have suppressed (closing the warm-container race; see runner-gate.ts).
 *
 * Pure and side-effect-free except the injected markCompleted: DBs and the completion callback are
 * passed in, so the env/singleton/fail-open glue lives in the poll loop (its local logger).
 */
import type { Database } from 'bun:sqlite';

import type { MessageInRow } from './db/messages-in.js';
import { computeRunnerState } from './runner-state.js';
import { decideRunnerGate, type RunnerJob } from './runner-gate.js';
import { isValidTimezone } from './timezone.js';

const JOB_TAGS: ReadonlyArray<[string, RunnerJob]> = [
  ['[TF-STANDUP]', 'standup'],
  ['[TF-DIGEST]', 'digest'],
  ['[TF-REVIEW]', 'review'],
];

function jobFromContent(content: string): RunnerJob | null {
  for (const [tag, job] of JOB_TAGS) if (content.includes(tag)) return job;
  return null;
}

/**
 * The board's configured timezone, or undefined if it can't be determined (missing table/row).
 * Undefined → assume the board shares the gate's zone (every board today) and gate normally.
 */
function boardTimezone(taskflowDb: Database, boardId: string): string | undefined {
  try {
    const row = taskflowDb.prepare('SELECT timezone FROM board_runtime_config WHERE board_id = ?').get(boardId) as
      | { timezone: string | null }
      | null;
    const tz = row?.timezone ?? undefined;
    // Validate so a corrupt board_runtime_config.timezone falls back to the gate's zone (consistent
    // with provision/recurrence) instead of throwing into cron-parser and fail-opening the runner.
    return tz && isValidTimezone(tz) ? tz : undefined;
  } catch {
    return undefined;
  }
}

/** A due TaskFlow runner: a wake-eligible recurring task whose envelope carries a [TF-*] tag. */
export function isTfRunnerRow(m: MessageInRow): boolean {
  return m.kind === 'task' && m.trigger === 1 && !!m.recurrence && m.content.includes('[TF-');
}

export interface ContainerGateOpts {
  taskflowDb: Database;
  inboundDb: Database;
  boardId: string;
  now: Date;
  timeZone: string;
}

export interface GateOutcome {
  id: string;
  job: RunnerJob;
  fired: boolean;
}

/** Per-runner gate decisions for the [TF-*] runners in `messages` (non-runner rows are ignored). */
export function gateRunnerMessages(messages: MessageInRow[], opts: ContainerGateOpts): GateOutcome[] {
  // Judge each runner in the board's OWN timezone (Option A per-board TZ), falling back to the gate's
  // zone when the board has none (every board today). The fire time is scheduled in the same board
  // zone (provision + handleRecurrence), so the gate window and the actual fire instant agree.
  const tz = boardTimezone(opts.taskflowDb, opts.boardId) ?? opts.timeZone;

  const outcomes: GateOutcome[] = [];
  for (const msg of messages) {
    const cron = msg.recurrence;
    if (!cron || !isTfRunnerRow(msg)) continue;
    const job = jobFromContent(msg.content);
    if (!job) continue; // matched [TF- loosely but no known job tag — leave it alone
    const state = computeRunnerState({
      taskflowDb: opts.taskflowDb,
      inboundDb: opts.inboundDb,
      boardId: opts.boardId,
      cron,
      now: opts.now,
      timeZone: tz,
    });
    outcomes.push({ id: msg.id, job, fired: decideRunnerGate(job, state).fire });
  }
  return outcomes;
}

/**
 * Gate the batch: mark suppressed runners completed (via the injected callback) and return the
 * batch with them removed. Fired runners and all non-runner messages pass through unchanged.
 */
export function applyRunnerGate(
  messages: MessageInRow[],
  opts: ContainerGateOpts,
  markCompleted: (ids: string[]) => void,
): MessageInRow[] {
  const suppressed = gateRunnerMessages(messages, opts)
    .filter((o) => !o.fired)
    .map((o) => o.id);
  if (suppressed.length === 0) return messages;
  markCompleted(suppressed);
  const drop = new Set(suppressed);
  return messages.filter((m) => !drop.has(m.id));
}
