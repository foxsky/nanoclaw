/**
 * RC5-ext P3 (C3) — durable per-turn EXTERNAL-actor channel.
 *
 * The parallel of `turn-actor.ts` (SEC#13) for an authenticated external
 * contact who DM'd a board (RC5-ext inbound). The host writes
 * `content.externalActor = { externalId, displayName, sourceDmMgId, boardId }`
 * and `actorKind:'external'` on the routed row (NO `content.sender`). The
 * poll-loop reads that, POISONS `turn_actor` (an external is never a board
 * person), and pins THIS channel; the MCP child reads it to set
 * `sender_external_id` and to drive the external-safe capability gate (C7).
 *
 * AUTHENTICATION CARRIES ONLY `externalId`. displayName/sourceDmMgId/boardId
 * are context (reply scope; the engine re-checks the grant per-meeting at
 * mutation time — they are NEVER authorization). Resolution mirrors
 * turn-actor: resolved iff NOT poison AND exactly one distinct externalId.
 *
 * Same durability rationale as turn-actor: the MCP tools run as a separate
 * `bun` subprocess (no shared module global reaches them), and markCompleted
 * fires at the first `result` event while the stream stays open — so the
 * binding must live in `session_state` (outbound.db, journal_mode=DELETE),
 * written by the poll-loop main process, accumulated across follow-up pushes,
 * cleared at the turn boundary. Mutual exclusivity with `turn_actor` is the
 * poll-loop's job (it poisons that channel for external rows); here we only
 * store/resolve the external identity.
 */
import { getOutboundDb } from '../db/connection.js';

const KEY = 'turn_external_actor';

export interface ExternalActorContext {
  externalId: string;
  displayName: string;
  sourceDmMgId: string;
  boardId: string;
}

export type TurnExternalActor = ({ resolved: true } & ExternalActorContext) | { resolved: false };

type StoredEntry = ExternalActorContext;
type StoredExternalActor = { externals: StoredEntry[]; poison: boolean };

/** Keep only well-formed entries (non-empty externalId), de-dup by externalId preserving order. */
function normalizeEntries(entries: unknown): StoredEntry[] {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const out: StoredEntry[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const externalId = typeof e.externalId === 'string' ? e.externalId.trim() : '';
    if (!externalId || seen.has(externalId)) continue;
    seen.add(externalId);
    out.push({
      externalId,
      displayName: typeof e.displayName === 'string' ? e.displayName : '',
      sourceDmMgId: typeof e.sourceDmMgId === 'string' ? e.sourceDmMgId : '',
      boardId: typeof e.boardId === 'string' ? e.boardId : '',
    });
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

function writeStored(stored: StoredExternalActor): void {
  // Clear FIRST so a subsequent write failure fails CLOSED (missing key →
  // unresolved) rather than leaving a stale single external that could
  // authorize the next turn. If the insert throws, the catch clears again.
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

function readStored(): StoredExternalActor {
  try {
    const row = getOutboundDb()
      .prepare(`SELECT value FROM session_state WHERE key = ?`)
      .get(KEY) as { value: string } | undefined;
    if (!row) return { externals: [], poison: false }; // genuinely absent
    const parsed = JSON.parse(row.value) as Partial<StoredExternalActor>;
    return {
      externals: normalizeEntries(parsed.externals),
      poison: parsed.poison === true,
    };
  } catch {
    // Read/parse FAILURE — fail closed (poison → unresolved, sticky under accumulate).
    return { externals: [], poison: true };
  }
}

/** Poll-loop ONLY — fresh set for the INITIAL batch (overwrites any prior turn). */
export function setTurnExternalActor(entries: ExternalActorContext[], poison = false): void {
  writeStored({ externals: normalizeEntries(entries), poison });
}

/** Poll-loop ONLY — ACCUMULATE a follow-up push. Unions externals (a second
 *  distinct externalId anywhere makes the turn permanently unresolved) and
 *  OR-s poison (sticky). */
export function addTurnExternalActorEntries(entries: ExternalActorContext[], poison = false): void {
  const prev = readStored();
  writeStored({
    externals: normalizeEntries([...prev.externals, ...normalizeEntries(entries)]),
    poison: prev.poison || poison,
  });
}

/** MCP child read. Resolved iff NOT poison AND exactly one distinct externalId. */
export function getTurnExternalActor(): TurnExternalActor {
  const { externals, poison } = readStored();
  if (!poison && externals.length === 1) return { resolved: true, ...externals[0] };
  return { resolved: false };
}

/** Turn-boundary clear (poll-loop) — exception-safe; must run before pinning a
 *  new turn AND after the turn completes/errors so no stale external actor
 *  carries authority/capability-mode into a later turn (C3-lifecycle / B7). */
export function clearTurnExternalActor(): void {
  deleteKey();
}

export function __resetTurnExternalActorForTesting(): void {
  deleteKey();
}
