/**
 * 0h-v2 Option A — engine-side outbound enqueue for the FastAPI MCP
 * subprocess path.
 *
 * The standalone TaskFlow MCP subprocess (bun) has NO `/workspace`
 * session DBs and cannot import the host's `writeOutboundDirect`
 * (Node/better-sqlite3 — host and container never share modules). This
 * is the bun-side, path-EXPLICIT, race-safe equivalent: it opens the
 * dedicated TaskFlow "service session" `outbound.db` by absolute path
 * and writes a `system`-kind row whose content carries the
 * `taskflow_notify` delivery-action payload. `src/delivery.ts` drains
 * that session on the 60s sweep and `handleSystemAction` dispatches to
 * the host `taskflow_notify` handler, which resolves
 * board→messaging_group→(channel_type, platform_id) and delivers via
 * the channel adapter (fail-closed — Codex review #2).
 *
 * Seq is assigned in ONE statement (`(SELECT COALESCE(MAX(seq),0)+2)`)
 * mirroring `writeOutboundDirect` — NOT the read-then-insert form of
 * `writeMessageOut`, which races. The service session has a single
 * writer (this subprocess, serialized over its stdio JSON-RPC), so a
 * monotonic +2 step with a UNIQUE seq is safe; `INSERT OR IGNORE` on
 * the id PK makes retries idempotent.
 */
import { Database } from 'bun:sqlite';

export interface EnqueueOutboundParams {
  /** Stable id for idempotent retry (INSERT OR IGNORE on the PK). */
  id: string;
  /** Logical origin board; the host handler resolves it → channel. */
  board_id: string;
  /** Logical target; the host handler resolves it → chat address. */
  target: { kind: 'person'; person_id: string } | { kind: 'group'; group_jid: string };
  text: string;
  metadata?: Record<string, unknown>;
}

/**
 * Enqueue a TaskFlow notification into the service session's
 * `outbound.db` at `serviceOutboundDbPath`. Returns the assigned seq.
 * Routing columns (`platform_id`/`channel_type`/`thread_id`) are left
 * NULL on purpose — board→channel resolution is host-side and
 * fail-closed in the `taskflow_notify` delivery action.
 */
export function enqueueOutboundMessage(
  serviceOutboundDbPath: string,
  params: EnqueueOutboundParams,
): number {
  const content = JSON.stringify({
    action: 'taskflow_notify',
    board_id: params.board_id,
    target: params.target,
    text: params.text,
    metadata: params.metadata ?? {},
  });
  const db = new Database(serviceOutboundDbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    // ON CONFLICT(id) DO NOTHING makes a retry with the same id
    // idempotent — but, unlike INSERT OR IGNORE, a failure on ANY other
    // constraint (UNIQUE seq, NOT NULL, …) still throws instead of
    // silently no-op'ing into a phantom "enqueued" return.
    db.prepare(
      `INSERT INTO messages_out
         (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES
         (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out),
          datetime('now'), 'system', NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(params.id, content);
    const row = db
      .prepare('SELECT seq FROM messages_out WHERE id = ?')
      .get(params.id) as { seq: number } | null;
    if (!row) {
      // Insert affected no row and none pre-existed — fail loud rather
      // than return a sentinel the caller would read as "delivered".
      throw new Error(
        `enqueueOutboundMessage: row not persisted for id=${params.id}`,
      );
    }
    return row.seq;
  } finally {
    db.close();
  }
}
