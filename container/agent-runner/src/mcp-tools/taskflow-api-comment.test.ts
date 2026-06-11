import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeSessionDb, closeTaskflowDb, initTestSessionDb } from '../db/connection.js';
import { setVerbatimIds } from './taskflow-helpers.js';
import { setupEngineDb } from './taskflow-test-fixtures.js';
import { __resetTurnActorForTesting, clearTurnActor, setTurnActor } from './turn-actor.js';

/**
 * `api_task_add_comment` MCP tool — flat FastAPI contract (mirrors
 * `add_task_comment` / `CreateCommentPayload` at main.py:151,3512).
 * Author is resolved FastAPI-side and passed flat (no sender_name /
 * actor parsing — R2.3). board_id is VERBATIM (handoff BLOCKER: the
 * `normalizeAgentIds` board-prefix breaks plain-UUID web-POST boards);
 * task_id IS uppercased (handoff explicitly names this tool). Returns
 * the FastAPI-parity 201 body as `data` plus `notification_events`
 * (kept as past-tense observability — owner decision 2026-05-16; the
 * WhatsApp host path delivers them, FastAPI ignores them post-0j-a).
 */
const SEED = 'board-x1';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(SEED, { withBoardAdmins: true });
  db.prepare(
    `INSERT INTO board_people (board_id, person_id, name, role, notification_group_jid) VALUES (?, 'bob', 'Bob', 'member', 'g-bob@x')`,
  ).run(SEED);
  db.prepare(
    `INSERT INTO tasks (id, board_id, title, assignee, created_at, updated_at) VALUES ('T1', ?, 'Fix login', 'bob', '2026-01-01', '2026-01-01')`,
  ).run(SEED);
});

afterEach(() => {
  setVerbatimIds(false); // process-global — never leak verbatim into siblings
  closeTaskflowDb();
});

async function call(args: Record<string, unknown>) {
  const { apiTaskAddCommentTool } = await import('./taskflow-api-comment.ts');
  return JSON.parse((await apiTaskAddCommentTool.handler(args)).content[0].text);
}

describe('api_task_add_comment MCP tool (engine-backed)', () => {
  it('exports a tool named api_task_add_comment', async () => {
    const { apiTaskAddCommentTool } = await import('./taskflow-api-comment.ts');
    expect(apiTaskAddCommentTool.tool.name).toBe('api_task_add_comment');
  });

  it('writes the comment and returns the FastAPI 201 parity body as data', async () => {
    const r = await call({
      board_id: SEED,
      task_id: 'T1',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'looks broken',
    });
    expect(r.success).toBe(true);
    expect(r.data.task_id).toBe('T1');
    expect(r.data.author_id).toBe('alice');
    expect(r.data.author_name).toBe('Alice');
    expect(r.data.message).toBe('looks broken');
    expect(typeof r.data.id).toBe('number');
    const row = db
      .prepare(
        `SELECT "by", details FROM task_history WHERE board_id=? AND task_id='T1' AND action='comment'`,
      )
      .get(SEED) as { by: string; details: string };
    expect(row).toEqual({ by: 'alice', details: 'looks broken' });
  });

  it('#396: enqueues a deferred notification when commenting on a task assigned to a cross-board unprovisioned person', async () => {
    // gio is a cross-board delegate (registration) whose board is still
    // provisioning (null JID). A comment notifies the assignee → null-JID
    // deferred → must be persisted for later delivery, not host-skipped + lost.
    db.prepare(`INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'gio', 'Gio', 'member')`).run(SEED);
    db.prepare(`INSERT INTO child_board_registrations (parent_board_id, person_id, child_board_id) VALUES (?, 'gio', 'child-gio')`).run(SEED);
    db.prepare(`INSERT INTO tasks (id, board_id, title, assignee, created_at, updated_at) VALUES ('T9', ?, 'Cross task', 'gio', '2026-01-01', '2026-01-01')`).run(SEED);

    const r = await call({ board_id: SEED, task_id: 'T9', author_id: 'alice', author_name: 'Alice', message: 'ping' });
    expect(r.success).toBe(true);

    const pending = db
      .prepare(`SELECT target_person_id, task_id FROM pending_notifications WHERE target_person_id='gio'`)
      .all() as Array<{ target_person_id: string; task_id: string }>;
    expect(pending.length).toBe(1);
    expect(pending[0]).toMatchObject({ target_person_id: 'gio', task_id: 'T9' });
  });

  it('emits notification_events for the assignee (kept; past-tense observability)', async () => {
    const r = await call({
      board_id: SEED,
      task_id: 'T1',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'please check',
    });
    expect(Array.isArray(r.notification_events)).toBe(true);
    expect(r.notification_events.length).toBe(1);
    expect(r.notification_events[0].message).toContain('please check');
    expect(r.notification_events[0].message).not.toContain('Digite');
  });

  it('VERBATIM (FastAPI subprocess): plain-UUID board_id is never board-prefixed (handoff BLOCKER)', async () => {
    // The handoff BLOCKER condition is the FastAPI subprocess, which
    // always runs setVerbatimIds(true) — that is where normalizeAgentIds
    // must NOT prefix a plain web-POST UUID. (In the non-verbatim
    // in-container WhatsApp path, board-prefixing a bare id IS the
    // intended v1-parity behavior that every task tool has — so the
    // BLOCKER is correctly asserted under verbatim, not unconditionally.)
    setVerbatimIds(true);
    try {
      const UUID = '550e8400-e29b-41d4-a716-446655440000';
      db.prepare(`INSERT INTO boards (id, short_code, name) VALUES (?, 'UU', 'U')`).run(UUID);
      db.prepare(
        `INSERT INTO tasks (id, board_id, title, created_at, updated_at) VALUES ('T9', ?, 't', '2026-01-01', '2026-01-01')`,
      ).run(UUID);
      const r = await call({
        board_id: UUID,
        task_id: 'T9',
        author_id: 'svc',
        author_name: 'svc',
        message: 'hi',
      });
      expect(r.success).toBe(true);
      expect(
        db.prepare(`SELECT 1 FROM task_history WHERE board_id=? AND action='comment'`).get(UUID),
      ).not.toBeNull();
      expect(
        db.prepare(`SELECT 1 FROM task_history WHERE board_id='board-' || ?`).get(UUID),
      ).toBeNull();
    } finally {
      setVerbatimIds(false);
    }
  });

  it('uppercases task_id (handoff: api_task_add_comment needs task-id normalization)', async () => {
    const r = await call({
      board_id: SEED,
      task_id: 't1',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'lowercased id',
    });
    expect(r.success).toBe(true);
    expect(r.data.task_id).toBe('T1');
  });

  it('mirrors CreateCommentPayload validators (author_id + message required, non-empty after trim)', async () => {
    expect((await call({ board_id: SEED, task_id: 'T1', author_id: '  ', message: 'x' })).error_code).toBe(
      'validation_error',
    );
    expect(
      (await call({ board_id: SEED, task_id: 'T1', author_id: 'alice', message: '   ' })).error_code,
    ).toBe('validation_error');
    expect((await call({ board_id: SEED, task_id: 'T1', author_id: 'alice' })).error_code).toBe(
      'validation_error',
    );
  });

  it('VERBATIM (FastAPI subprocess): task_id is NOT uppercased — uses normalizeAgentIds like the note tools', async () => {
    // The .61 regression: FastAPI fetch_task_row resolves and passes the
    // canonical stored id (e.g. lowercase 'task-simple'); the subprocess
    // runs setVerbatimIds(true) so normalizeAgentIds is a no-op. A blunt
    // .toUpperCase() mangles it → engine getTask('TASK-SIMPLE') → 404.
    setVerbatimIds(true);
    try {
      db.prepare(
        `INSERT INTO tasks (id, board_id, title, assignee, created_at, updated_at) VALUES ('task-simple', ?, 'Lower id', 'bob', '2026-01-01', '2026-01-01')`,
      ).run(SEED);
      const r = await call({
        board_id: SEED,
        task_id: 'task-simple',
        author_id: 'taskflow-api',
        author_name: 'taskflow-api',
        message: 'verbatim id must survive',
      });
      expect(r.success).toBe(true);
      expect(r.data.task_id).toBe('task-simple'); // NOT 'TASK-SIMPLE'
      expect(
        db
          .prepare(
            `SELECT 1 FROM task_history WHERE board_id=? AND task_id='task-simple' AND action='comment'`,
          )
          .get(SEED),
      ).not.toBeNull();
    } finally {
      setVerbatimIds(false);
    }
  });

  it('an engine-side throw surfaces as a structured {success:false,error_code:internal_error} envelope — never an escaped exception', async () => {
    // The .61 503 root cause: the golden runs the MCP server against
    // conftest `_base_schema()` whose `board_people` has NO
    // `notification_group_jid`; for an assignee'd task the engine's
    // notification SELECT throws. Every sibling FastAPI tool wraps the
    // engine call in try/catch → a structured envelope; this one didn't,
    // so the throw escaped as JSON-RPC -32603 → FastAPI
    // `parse_mcp_mutation_result` "missing boolean success" → 503.
    setVerbatimIds(true);
    try {
      db.exec('DROP TABLE board_people');
      db.exec(
        `CREATE TABLE board_people (board_id TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, role TEXT, wip_limit INTEGER, PRIMARY KEY (board_id, person_id))`,
      );
      db.prepare(
        `INSERT INTO board_people (board_id, person_id, name) VALUES (?, 'person-1', 'Alice')`,
      ).run(SEED);
      db.prepare(
        `INSERT INTO tasks (id, board_id, title, assignee, created_at, updated_at) VALUES ('task-x', ?, 'X', 'Alice', '2026-01-01', '2026-01-01')`,
      ).run(SEED);
      const r = await call({
        board_id: SEED,
        task_id: 'task-x',
        author_id: 'taskflow-api',
        author_name: 'taskflow-api',
        message: 'c',
      });
      expect(r.success).toBe(false);
      expect(r.error_code).toBe('internal_error');
      expect(typeof r.error).toBe('string');
    } finally {
      setVerbatimIds(false);
    }
  });

  it('in-container path: board_id injected from NANOCLAW_TASKFLOW_BOARD_ID when omitted (Codex #3: normalize must precede validation)', async () => {
    // Non-verbatim (default). The WhatsApp agent omits board_id and
    // relies on env injection inside normalizeAgentIds. Validating
    // args.board_id BEFORE normalizeAgentIds spuriously rejected it.
    const prev = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = SEED;
    try {
      const r = await call({
        // board_id intentionally OMITTED
        task_id: 'T1',
        author_id: 'alice',
        author_name: 'Alice',
        message: 'env-injected board',
      });
      expect(r.success).toBe(true);
      expect(r.data.task_id).toBe('T1');
    } finally {
      if (prev === undefined) delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
      else process.env.NANOCLAW_TASKFLOW_BOARD_ID = prev;
    }
  });

  it('passes through engine not_found for a missing task', async () => {
    const r = await call({
      board_id: SEED,
      task_id: 'NOPE',
      author_id: 'alice',
      author_name: 'Alice',
      message: 'x',
    });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
  });
});

// SEC#13 (#419): the comment author is a model-controlled arg on the chat surface
// (author_id/author_name are NOT touched by normalizeAgentIds). On the chat surface
// the handler OVERWRITES them with the authenticated per-turn actor — author_id to
// the canonical person_id (so the engine's person_id-keyed self-comment suppression
// matches), author_name to the display name. The unresolved-actor DENY is enforced
// by the requiresChatActor WRAPPER (locked in chat-actor-guard.test.ts's registry
// coverage), not here — these tests exercise the raw handler's resolved binding. The
// FastAPI subprocess (verbatim) keeps its server-resolved author.
describe('SEC#13 (#419) — comment author bound to the authenticated turn actor', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetTurnActorForTesting();
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = SEED;
  });
  afterEach(() => {
    clearTurnActor();
    closeSessionDb();
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  });

  it('OVERWRITES the model author with the resolved actor — author_id is the canonical person_id, author_name the display name', () => {
    // 'Bob' is seeded as person_id='bob', name='Bob' (beforeEach). The sender display
    // name resolves to person_id 'bob' so notification suppression keys correctly.
    setTurnActor(['Bob']);
    return call({
      board_id: SEED,
      task_id: 'T1',
      author_id: 'mallory-spoof',
      author_name: 'Mallory',
      message: 'attributed to me, not Mallory',
    }).then((r) => {
      expect(r.success).toBe(true);
      expect(r.data.author_id).toBe('bob'); // canonical person_id (IMPORTANT #419)
      expect(r.data.author_name).toBe('Bob'); // display name
      const row = db
        .prepare(`SELECT "by" FROM task_history WHERE board_id=? AND task_id='T1' AND action='comment'`)
        .get(SEED) as { by: string };
      expect(row.by).toBe('bob');
    });
  });

  it('resolves a native-WhatsApp JID actor to the board person (live-adapter parity — phone match)', async () => {
    // On the native WhatsApp adapter the authenticated sender is a JID, not a
    // display name; the comment must attribute to the real board person, not a
    // raw JID string (delta-parity audit 2026-06-10).
    try {
      db.exec(`ALTER TABLE board_people ADD COLUMN phone TEXT`);
    } catch {
      /* already present */
    }
    db.prepare(`UPDATE board_people SET phone = '5586981234567' WHERE board_id = ? AND person_id = 'bob'`).run(SEED);
    setTurnActor(['5586981234567@s.whatsapp.net']);
    const r = await call({
      board_id: SEED,
      task_id: 'T1',
      author_id: 'mallory-spoof',
      author_name: 'Mallory',
      message: 'sent from a live WhatsApp group',
    });
    expect(r.success).toBe(true);
    expect(r.data.author_id).toBe('bob');
    expect(r.data.author_name).toBe('Bob');
  });

  it('falls back to the display name when the resolved sender is not a registered board person', async () => {
    setTurnActor(['Ext-Visitor']); // not in board_people
    const r = await call({
      board_id: SEED,
      task_id: 'T1',
      author_id: 'mallory-spoof',
      author_name: 'Mallory',
      message: 'still bound, not the model value',
    });
    expect(r.success).toBe(true);
    expect(r.data.author_id).toBe('Ext-Visitor');
    expect(r.data.author_id).not.toBe('mallory-spoof');
  });

  it('VERBATIM (FastAPI): the server-resolved author is kept (bind skipped)', async () => {
    setTurnActor(['Ana']);
    setVerbatimIds(true);
    try {
      const r = await call({
        board_id: SEED,
        task_id: 'T1',
        author_id: 'alice',
        author_name: 'Alice',
        message: 'fastapi authored',
      });
      expect(r.success).toBe(true);
      expect(r.data.author_id).toBe('alice');
      expect(r.data.author_name).toBe('Alice');
    } finally {
      setVerbatimIds(false);
    }
  });
});
