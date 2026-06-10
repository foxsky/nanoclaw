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
 * tool when the actor is unresolvable (the real enforcement — never a sentinel).
 *
 * WHY a durable session_state channel and not a module global / processing_ack
 * read: the MCP tools run as a SEPARATE `bun` subprocess (a poll-loop module
 * global never reaches them — the mutation-dedup lesson); and markCompleted
 * fires at the FIRST `result` event while the stream stays open for follow-ups,
 * so a processing_ack-keyed binding is FAIL-OPEN on follow-up tool calls. The
 * poll-loop WRITES this channel before the initial provider query, ACCUMULATES
 * follow-up pushes, and CLEARS at the turn boundary; the MCP child READS it.
 * Both open the same `/workspace/outbound.db` (journal_mode=DELETE).
 *
 * Stored shape `{senders, poison, system}`:
 *   - `senders`: distinct, trimmed, non-empty chat senders seen this turn.
 *   - `poison`: a trigger=1 row was NOT an authenticated chat message (a
 *     non-chat/system/scheduled row, or a chat row with an empty sender) — such
 *     content must not ride a co-batched chat actor.
 *   - `system`: the batch was a PURE non-chat turn (a scheduled/system wake with
 *     no chat row at all). Distinct from poison so a read-failure (which also
 *     yields no senders) can never masquerade as a trusted system turn.
 *
 * RESOLUTION (getTurnActor): resolved iff NOT poison AND exactly one distinct
 * sender. Everything else — zero senders, ≥2 distinct senders (mixed-batch AND
 * cross-push over-auth defeat: addTurnActorSenders unions across the stream so a
 * second sender anywhere makes the turn permanently unresolved), poison, a
 * MISSING key, or any read/parse FAILURE (→ fail-closed) — is unresolved.
 *
 * No write-side FastAPI/verbatim guard: the writers are called ONLY from the
 * poll-loop main process, which never runs as the verbatim subprocess.
 */
import { getOutboundDb } from '../db/connection.js';

const KEY = 'turn_actor';

export type TurnActor = { resolved: true; sender: string } | { resolved: false };

type StoredActor = { senders: string[]; poison: boolean; system: boolean };

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

function deleteKey(): void {
  try {
    getOutboundDb().prepare(`DELETE FROM session_state WHERE key = ?`).run(KEY);
  } catch {
    // Best-effort.
  }
}

function writeStored(stored: StoredActor): void {
  // Clear FIRST so a subsequent write failure fails CLOSED (missing key →
  // unresolved) instead of leaving a stale single sender that could authorize
  // the next turn. If the insert throws, the catch clears again.
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

function readStored(): StoredActor {
  try {
    const row = getOutboundDb()
      .prepare(`SELECT value FROM session_state WHERE key = ?`)
      .get(KEY) as { value: string } | undefined;
    if (!row) return { senders: [], poison: false, system: false }; // genuinely absent
    const parsed = JSON.parse(row.value) as Partial<StoredActor>;
    return {
      senders: Array.isArray(parsed.senders) ? distinctNonEmpty(parsed.senders) : [],
      poison: parsed.poison === true,
      system: parsed.system === true,
    };
  } catch {
    // Read/parse FAILURE — fail closed: poison (→ unresolved, and sticky under
    // accumulate) but NOT system (so a bundled mutation is never allowed).
    return { senders: [], poison: true, system: false };
  }
}

/** Poll-loop ONLY — fresh set for the INITIAL batch (overwrites any prior turn). */
export function setTurnActor(senders: string[], poison = false, system = false): void {
  writeStored({ senders: distinctNonEmpty(senders), poison, system });
}

/** Poll-loop ONLY — ACCUMULATE a follow-up push into the active stream's actor.
 *  Unions senders, OR-s poison (sticky), and drops `system` once any push is
 *  non-system, so a second distinct sender or any poisoned/chat follow-up makes
 *  (and keeps) the turn unresolved. */
export function addTurnActorSenders(senders: string[], poison = false, system = false): void {
  const prev = readStored();
  writeStored({
    senders: distinctNonEmpty([...prev.senders, ...senders]),
    poison: prev.poison || poison,
    system: prev.system && system,
  });
}

/** MCP child read (normalizeAgentIds + requiresChatActor). Fail-closed. */
export function getTurnActor(): TurnActor {
  const { senders, poison } = readStored();
  if (!poison && senders.length === 1) return { resolved: true, sender: senders[0] };
  return { resolved: false };
}

/**
 * #419: may a board MUTATION bundled into an otherwise-read tool run this turn?
 * (Today: only `api_report(type='standup')`'s auto-archive housekeeping.) TRUE
 * iff the actor RESOLVES (a real user/manager standup) OR the turn is a pure
 * SYSTEM/scheduled wake (the model-driven scheduled standup, which has no chat
 * sender). An ambiguous multi-sender / poisoned chat turn — and any read
 * failure — returns FALSE so an unauthenticated chat turn cannot trigger it.
 */
export function mayRunChatBundledMutation(): boolean {
  const { senders, poison, system } = readStored();
  return (!poison && senders.length === 1) || system;
}

/** Turn-boundary clear (poll-loop). */
export function clearTurnActor(): void {
  deleteKey();
}

export function __resetTurnActorForTesting(): void {
  deleteKey();
}
