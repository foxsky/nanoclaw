/**
 * 0h-v2 Option A — engine-side outbound enqueue for the FastAPI MCP
 * subprocess path.
 *
 * The standalone TaskFlow MCP subprocess (bun) has NO `/workspace`
 * session DBs and cannot import the host's `writeOutboundDirect`
 * (Node/better-sqlite3 — host and container never share modules). This
 * is the bun-side, path-EXPLICIT, race-safe equivalent: it opens the
 * dedicated TaskFlow "service session" `outbound.db` by absolute path
 * and writes a `system`-kind row whose content carries a delivery-
 * action payload. `src/delivery.ts` drains that session on the 60s
 * sweep and `handleSystemAction` dispatches by `content.action`:
 *   - `taskflow_notify`          → comment-assignee WhatsApp push
 *   - `taskflow_web_chat_inbound`→ dashboard web-chat ingress (memo §0.3)
 *
 * Seq is assigned in ONE statement (`(SELECT COALESCE(MAX(seq),0)+2)`)
 * mirroring `writeOutboundDirect` — NOT the read-then-insert form of
 * `writeMessageOut`, which races. The service session has a single
 * writer (this subprocess, serialized over its stdio JSON-RPC), so a
 * monotonic +2 step with a UNIQUE seq is safe. `ON CONFLICT(id) DO
 * NOTHING` makes a same-id retry idempotent while still throwing on any
 * OTHER constraint (no silent sentinel-0 — Codex review #3).
 */
import { Database } from 'bun:sqlite';

/**
 * Low-level: write one `system`-kind `messages_out` row whose `content`
 * is `JSON.stringify(contentObj)`. Shared by every service-bus action
 * so the race-safe seq + idempotency + fail-loud semantics live in one
 * place. Returns the assigned seq. Routing columns
 * (`platform_id`/`channel_type`/`thread_id`) are NULL on purpose — all
 * resolution is host-side in the delivery action, fail-closed.
 */
function enqueueServiceSystemRow(
  serviceOutboundDbPath: string,
  id: string,
  contentObj: Record<string, unknown>,
): number {
  const content = JSON.stringify(contentObj);
  const db = new Database(serviceOutboundDbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(
      `INSERT INTO messages_out
         (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES
         (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out),
          datetime('now'), 'system', NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(id, content);
    const row = db
      .prepare('SELECT seq FROM messages_out WHERE id = ?')
      .get(id) as { seq: number } | null;
    if (!row) {
      // Insert affected no row and none pre-existed — fail loud rather
      // than return a sentinel the caller would read as "enqueued".
      throw new Error(`enqueueServiceSystemRow: row not persisted for id=${id}`);
    }
    return row.seq;
  } finally {
    db.close();
  }
}

export interface EnqueueOutboundParams {
  /** Stable id for idempotent retry (ON CONFLICT(id) DO NOTHING). */
  id: string;
  /** Logical origin board; the host handler resolves it → channel. */
  board_id: string;
  /** Logical target; the host handler resolves it → chat address. */
  target: { kind: 'person'; person_id: string } | { kind: 'group'; group_jid: string };
  text: string;
  metadata?: Record<string, unknown>;
}

/**
 * Comment-assignee WhatsApp push. Host `taskflow_notify` delivery
 * action resolves board→messaging_group→(channel_type, platform_id)
 * and delivers via the channel adapter (fail-closed — Codex review #2).
 */
export function enqueueOutboundMessage(
  serviceOutboundDbPath: string,
  params: EnqueueOutboundParams,
): number {
  return enqueueServiceSystemRow(serviceOutboundDbPath, params.id, {
    action: 'taskflow_notify',
    board_id: params.board_id,
    target: params.target,
    text: params.text,
    metadata: params.metadata ?? {},
  });
}

export interface EnqueueWebChatInboundParams {
  /** Stable id, e.g. `taskflow-web:${board_chat_id}` — idempotent. */
  id: string;
  board_id: string;
  /** The board_chat row id just inserted (host dedup key + correlation). */
  board_chat_id: number;
  /** Display sender (e.g. `web:Alice`); host tags origin via the payload. */
  sender_name: string;
  /** The user's message text. */
  content: string;
  /** ISO-Z timestamp of the board_chat row. */
  created_at: string;
}

/**
 * 0h-v2 web-chat INGRESS (memo §0.3). Host
 * `taskflow_web_chat_inbound` delivery action resolves board→session
 * and writes a trigger-bypassed `messages_in` row with structured
 * `{origin:'taskflow_web', …}` metadata so the agent processes it
 * without an `@mention`.
 */
export function enqueueWebChatInbound(
  serviceOutboundDbPath: string,
  params: EnqueueWebChatInboundParams,
): number {
  return enqueueServiceSystemRow(serviceOutboundDbPath, params.id, {
    action: 'taskflow_web_chat_inbound',
    board_id: params.board_id,
    board_chat_id: params.board_chat_id,
    sender_name: params.sender_name,
    content: params.content,
    created_at: params.created_at,
  });
}
