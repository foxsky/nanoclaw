/**
 * #419 (SEC#13) — durable per-turn authenticated-actor channel.
 *
 * The TaskFlow engine authorizes admin/mutate actions on a `sender_name`
 * (isManager / isAssignee / no-self-approval / audit attribution). On the chat
 * MCP surface that field is a MODEL-supplied tool arg — `normalizeAgentIds`
 * pins board_id but NOT the actor — so a prompt-injected board agent could put
 * any manager's name in `sender_name`. This channel pins the AUTHENTICATED
 * inbound sender of the current batch; `normalizeAgentIds` binds `sender_name`
 * to it, and `requiresChatActor` (chat-actor-guard.ts) DENIES every chat mutate
 * tool when the actor is unresolvable (the real enforcement — never rely on a
 * sentinel string, Codex #419 review).
 *
 * WHY a durable session_state channel and not a module global or a
 * processing_ack read:
 *   - The MCP tools run as a SEPARATE `bun` subprocess; a poll-loop module
 *     global does not reach them (the mutation-dedup lesson).
 *   - markCompleted fires at the FIRST `result` event while the stream stays
 *     open for follow-ups, so a processing_ack-keyed binding is FAIL-OPEN on
 *     follow-up tool calls. This channel is poll-loop-written and not keyed on
 *     processing_ack.
 *
 * The poll-loop (main process) WRITES the authenticated sender(s) of the
 * current trigger=1 batch via `setTurnActor` before the initial provider query,
 * ACCUMULATES follow-up pushes via `addTurnActorSenders`, and `clearTurnActor`s
 * at the turn boundary. The MCP child READS it via `getTurnActor`. Both open the
 * same `/workspace/outbound.db`, so a committed write is visible cross-process
 * (journal_mode=DELETE).
 *
 * FAIL-CLOSED resolution. The actor is RESOLVED iff the turn is NOT poisoned AND
 * there is exactly ONE distinct, trimmed, non-empty sender. It is UNRESOLVED
 * (`{resolved:false}`) when:
 *   - ZERO senders (system/scheduled wake with no chat sender),
 *   - TWO-OR-MORE distinct senders accumulated across the whole stream — this is
 *     BOTH the mixed-batch defeat AND the cross-push defeat (sender A's in-flight
 *     tool can no longer ride a sender B that pushed mid-turn; once two senders
 *     appear the turn is unresolved),
 *   - POISONED — any trigger=1 row in the batch is NOT an authenticated chat
 *     message (a non-chat/system/scheduled row, or a chat row with an empty
 *     sender); such content must not ride a co-batched chat actor,
 *   - the key is MISSING, a write FAILED (see setTurnActor — it clears so a
 *     failed write fails closed, never leaves a stale resolved actor), or any
 *     parse/visibility failure occurs.
 *
 * No write-side FastAPI/verbatim guard: `setTurnActor`/`addTurnActorSenders`/
 * `clearTurnActor` are called ONLY from the poll-loop main process, which never
 * runs as the FastAPI verbatim subprocess (verbatim is set solely by
 * taskflow-server-entry.ts). Keeping this module free of taskflow-helpers also
 * avoids an import cycle (taskflow-helpers imports getTurnActor).
 */
import { getOutboundDb } from '../db/connection.js';

const KEY = 'turn_actor';

export type TurnActor = { resolved: true; sender: string } | { resolved: false };

type StoredActor = { senders: string[]; poison: boolean };

/** Trim, drop empties, de-dup preserving order. */
function distinctNonEmpty(senders: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of senders) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function writeStored(stored: StoredActor): void {
  // Clear FIRST so a subsequent write failure fails CLOSED (missing key →
  // unresolved) instead of leaving a stale single sender that could authorize
  // the next turn (Codex #419 review). If the insert throws, the catch clears
  // again — the only way a stale resolved actor survives is if BOTH writes to a
  // healthy-enough-to-have-written-before DB fail, which also breaks the turn.
  try {
    deleteKey();
    getOutboundDb()
      .prepare(
        `INSERT INTO session_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY, JSON.stringify(stored), new Date().toISOString());
  } catch {
    deleteKey();
  }
}

function deleteKey(): void {
  try {
    getOutboundDb().prepare(`DELETE FROM session_state WHERE key = ?`).run(KEY);
  } catch {
    // Best-effort.
  }
}

function readStored(): StoredActor {
  try {
    const row = getOutboundDb()
      .prepare(`SELECT value FROM session_state WHERE key = ?`)
      .get(KEY) as { value: string } | undefined;
    if (!row) return { senders: [], poison: false };
    const parsed = JSON.parse(row.value) as Partial<StoredActor>;
    return {
      senders: Array.isArray(parsed.senders) ? distinctNonEmpty(parsed.senders) : [],
      poison: parsed.poison === true,
    };
  } catch {
    return { senders: [], poison: false };
  }
}

/**
 * Poll-loop ONLY — fresh set for the INITIAL batch (overwrites any prior turn).
 * `poison` marks that the batch contained a trigger=1 row that is not an
 * authenticated chat message → the turn cannot be attributed to a chat actor.
 */
export function setTurnActor(senders: string[], poison = false): void {
  writeStored({ senders: distinctNonEmpty(senders), poison });
}

/**
 * Poll-loop ONLY — ACCUMULATE a follow-up push into the active stream's actor.
 * Unions the new senders with those already seen this turn and OR-s the poison
 * flag, so the actor becomes (and stays) unresolved as soon as a second distinct
 * sender or any non-chat row appears anywhere in the turn.
 */
export function addTurnActorSenders(senders: string[], poison = false): void {
  const prev = readStored();
  writeStored({
    senders: distinctNonEmpty([...prev.senders, ...senders]),
    poison: prev.poison || poison,
  });
}

/** MCP child read (normalizeAgentIds + requiresChatActor). Fail-closed. */
export function getTurnActor(): TurnActor {
  const { senders, poison } = readStored();
  if (!poison && senders.length === 1) return { resolved: true, sender: senders[0] };
  return { resolved: false };
}

/** Turn-boundary clear (poll-loop). */
export function clearTurnActor(): void {
  deleteKey();
}

export function __resetTurnActorForTesting(): void {
  deleteKey();
}
