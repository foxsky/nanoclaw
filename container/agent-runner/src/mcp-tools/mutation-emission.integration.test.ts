import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  closeSessionDb,
  closeTaskflowDb,
  getInboundDb,
  getOutboundDb,
  initTestSessionDb,
} from '../db/connection.ts';
import { __resetDedupForTesting } from './mutation-dedup.ts';
import { setupEngineDb } from './taskflow-test-fixtures.ts';

// Phase-3 unit-2-core / Codex gate P5: session-DB-backed end-to-end
// integration asserting that a mutation tool writes EXACTLY ONE
// messages_out row with the byte-exact v1 card. Closes the coverage
// hole flagged by Codex (mutation-confirmation.test.ts only DI-tests
// the emitter; existing taskflow-api-mutate integration tests only
// log a caught SQLiteError because no session DB is mounted). Also
// regression-guards P4 dedup: if a future change ever causes the
// deterministic card AND the model's bare-text final reply to both
// land in messages_out, the `rows.length === 1` assertion catches it.

const BOARD = 'board-emit-int';
const ROUTING = { channel_type: 'whatsapp', platform_id: '120363400000000000@g.us', thread_id: null as string | null };

beforeEach(() => {
  __resetDedupForTesting();
  initTestSessionDb();
  // session_routing is host-written on container wake (initTestSessionDb
  // doesn't seed it); without it the emitMutationConfirmation guard
  // suppresses all emission. Create + seed for end-to-end coverage.
  getInboundDb().exec(`
    CREATE TABLE session_routing (
      id INTEGER PRIMARY KEY,
      channel_type TEXT,
      platform_id TEXT,
      thread_id TEXT
    );
  `);
  getInboundDb()
    .prepare('INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)')
    .run(ROUTING.channel_type, ROUTING.platform_id, ROUTING.thread_id);
});

afterEach(() => {
  closeSessionDb();
  closeTaskflowDb();
});

describe('mutation emission integration (Codex gate P5 — exactly-one messages_out per mutation)', () => {
  it('api_admin(reparent_task) emits EXACTLY ONE row with the byte-exact v1 "adicionada" card', async () => {
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateTaskTool, apiCreateSimpleTaskTool, apiAdminTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'bob', 'bob', 'member')`,
    ).run(BOARD);
    const proj = JSON.parse(
      (
        await apiCreateTaskTool.handler({
          board_id: BOARD, type: 'project', title: 'Operação da SECTI', sender_name: 'alice', assignee: 'bob',
        })
      ).content[0].text,
    );
    const child = JSON.parse(
      (
        await apiCreateSimpleTaskTool.handler({
          board_id: BOARD, title: 'Treinamento E-governe', sender_name: 'alice',
        })
      ).content[0].text,
    );

    // Sanity: pre-mutation outbound is empty (the create path is NOT
    // wired to emit; only reparent/reassign are in unit-2-core).
    expect((getOutboundDb().prepare('SELECT count(*) AS n FROM messages_out').get() as { n: number }).n).toBe(0);

    const result = JSON.parse(
      (
        await apiAdminTool.handler({
          board_id: BOARD, action: 'reparent_task', sender_name: 'alice',
          task_id: child.data.id, target_parent_id: proj.data.id,
        })
      ).content[0].text,
    );
    expect(result.success).toBe(true);

    const rows = getOutboundDb()
      .prepare('SELECT kind, platform_id, channel_type, thread_id, content FROM messages_out')
      .all() as Array<{ kind: string; platform_id: string | null; channel_type: string | null; thread_id: string | null; content: string }>;
    expect(rows.length).toBe(1); // P5 + P4 dedup regression guard
    expect(rows[0]).toMatchObject({
      kind: 'chat',
      platform_id: ROUTING.platform_id,
      channel_type: ROUTING.channel_type,
      thread_id: null,
    });
    expect(JSON.parse(rows[0].content).text).toBe(
      `✅ *${child.data.id} adicionada*\n━━━━━━━━━━━━━━\n\n📁 *${proj.data.id}* — Operação da SECTI\n   📋 *${child.data.id}* — Treinamento E-governe`,
    );
  });

  it('api_task_add_note emits EXACTLY ONE row with the byte-exact v1 "atualizada • Nota: <text>" card', async () => {
    setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateSimpleTaskTool } = await import('./taskflow-api-mutate.ts');
    const { apiTaskAddNoteTool } = await import('./taskflow-api-notes.ts');
    const taskId = JSON.parse(
      (
        await apiCreateSimpleTaskTool.handler({
          board_id: BOARD, title: 'Solicitar acesso', sender_name: 'alice',
        })
      ).content[0].text,
    ).data.id;

    expect((getOutboundDb().prepare('SELECT count(*) AS n FROM messages_out').get() as { n: number }).n).toBe(0);

    const result = JSON.parse(
      (
        await apiTaskAddNoteTool.handler({
          board_id: BOARD, task_id: taskId, sender_name: 'alice', text: 'Demanda no chamado CAST 38876',
        })
      ).content[0].text,
    );
    expect(result.success).toBe(true);

    const rows = getOutboundDb()
      .prepare('SELECT kind, content FROM messages_out')
      .all() as Array<{ kind: string; content: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('chat');
    expect(JSON.parse(rows[0].content).text).toBe(
      `✅ *${taskId}* atualizada\n━━━━━━━━━━━━━━\n\n• Nota: Demanda no chamado CAST 38876`,
    );
  });

  it('api_reassign emits EXACTLY ONE row with the v1-canonicalized "Reatribuída" card (P1 + P5 combined)', async () => {
    const db = setupEngineDb(BOARD, { withBoardAdmins: true });
    const { apiCreateSimpleTaskTool, apiReassignTool } = await import('./taskflow-api-mutate.ts');
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role) VALUES (?, 'lucas', 'Lucas', 'member')`,
    ).run(BOARD);
    const taskId = JSON.parse(
      (
        await apiCreateSimpleTaskTool.handler({
          board_id: BOARD, title: 'Solicitar acesso', sender_name: 'alice',
        })
      ).content[0].text,
    ).data.id;

    expect((getOutboundDb().prepare('SELECT count(*) AS n FROM messages_out').get() as { n: number }).n).toBe(0);

    const result = JSON.parse(
      (
        await apiReassignTool.handler({
          board_id: BOARD, task_id: taskId, target_person: 'lucas', sender_name: 'alice', confirmed: true,
        })
      ).content[0].text,
    );
    expect(result.success).toBe(true);

    const rows = getOutboundDb()
      .prepare('SELECT kind, content FROM messages_out')
      .all() as Array<{ kind: string; content: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('chat');
    expect(JSON.parse(rows[0].content).text).toBe(
      `✅ *${taskId}* — Solicitar acesso\n\nReatribuída para Lucas.`,
    );
  });
});
