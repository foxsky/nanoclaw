import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from './db/taskflow-db.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';
import { TaskflowEngine } from '../taskflow-engine.js';

/**
 * `engine.apiSendChat` — the 0h-v2 web-chat INGRESS write (memo §0.3).
 * tf-mcontrol `POST /boards/{id}/chat` retires onto this: it INSERTs
 * the dashboard transcript row into `board_chat` (sender_type='user'),
 * which `GET /chat` renders. NOT WhatsApp. Auth/actor is resolved
 * FastAPI-side and passed flat (sibling-tool convention). The board_id
 * is used verbatim. created_at is ISO-Z (Codex#4 IMPORTANT — the
 * dashboard orders by created_at; FastAPI writes ISO-Z).
 *
 * The board_chat row id is the load-bearing return: the tool uses it
 * for the `taskflow-web:${id}` ingress dedup key + the
 * `taskflow_web_chat_inbound` bus payload.
 */
const BOARD = 'board-chat-1';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(BOARD);
});

afterEach(() => {
  closeTaskflowDb();
});

function sendChat(args: { board_id?: string; sender_name: string; content: string }) {
  return new TaskflowEngine(db, BOARD).apiSendChat({
    board_id: args.board_id ?? BOARD,
    sender_name: args.sender_name,
    content: args.content,
  });
}

describe('engine.apiSendChat', () => {
  it("writes a board_chat user row and returns {id, board_id, sender_name, sender_type:'user', content, created_at}", () => {
    const r = sendChat({ sender_name: 'web:Alice', content: 'hello from the dashboard' }) as {
      success: true;
      data: Record<string, unknown>;
    };
    expect(r.success).toBe(true);
    expect(typeof r.data.id).toBe('number');
    expect(r.data.board_id).toBe(BOARD);
    expect(r.data.sender_name).toBe('web:Alice');
    expect(r.data.sender_type).toBe('user');
    expect(r.data.content).toBe('hello from the dashboard');
    expect(typeof r.data.created_at).toBe('string');
    // ISO-Z (not SQLite datetime()) — dashboard sorts on this.
    expect(r.data.created_at as string).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    const row = db
      .prepare(
        `SELECT board_id, sender_name, sender_type, content FROM board_chat WHERE id = ?`,
      )
      .get(r.data.id) as Record<string, unknown>;
    expect(row).toEqual({
      board_id: BOARD,
      sender_name: 'web:Alice',
      sender_type: 'user',
      content: 'hello from the dashboard',
    });
  });

  it('resolves the board group_jid IN-SUBPROCESS into the result (Codex#3: host must NOT read taskflow.db on ingress)', () => {
    // setupEngineDb's boards.group_jid defaults to '' (NOT NULL
    // DEFAULT ''); set a real JID so we assert the engine reads the
    // board's actual group_jid (the host ingress delivery-action then
    // maps group_jid→messaging_group→session with ZERO host
    // taskflow.db reads — same Codex#3 fix as taskflow_notify).
    db.prepare(`UPDATE boards SET group_jid = ? WHERE id = ?`).run(
      '120363111111111111@g.us',
      BOARD,
    );
    const r = sendChat({ sender_name: 'web:Z', content: 'route me' }) as {
      data: { group_jid: string | null };
    };
    expect(r.data.group_jid).toBe('120363111111111111@g.us');
  });

  it('returns group_jid:null when boards.group_jid is the empty-string default (un-routable → fail-mode b)', () => {
    // The fixture board exists but its group_jid is '' — an empty
    // string is NOT a routable destination; the engine normalizes to
    // null so the tool's `!group_jid` fail-mode (b) triggers.
    const r = sendChat({ sender_name: 'web:E', content: 'empty jid' }) as {
      success: boolean;
      data: { group_jid: string | null };
    };
    expect(r.success).toBe(true);
    expect(r.data.group_jid).toBeNull();
  });

  it('returns group_jid:null when the board row is absent (recorded, but un-routable → tool fail-mode b)', () => {
    const r = new TaskflowEngine(db, 'no-such-board').apiSendChat({
      board_id: 'no-such-board',
      sender_name: 'web:Q',
      content: 'orphan board',
    }) as { success: boolean; data: { id: number; group_jid: string | null } };
    expect(r.success).toBe(true); // board_chat row still recorded
    expect(typeof r.data.id).toBe('number');
    expect(r.data.group_jid).toBeNull();
  });

  it('returns a monotonic AUTOINCREMENT id usable as the ingress dedup key', () => {
    const a = sendChat({ sender_name: 'web:Bob', content: 'first' }) as {
      data: { id: number };
    };
    const b = sendChat({ sender_name: 'web:Bob', content: 'second' }) as {
      data: { id: number };
    };
    expect(b.data.id).toBeGreaterThan(a.data.id);
  });
});
