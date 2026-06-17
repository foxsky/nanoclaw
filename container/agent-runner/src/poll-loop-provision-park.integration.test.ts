import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './db/connection.ts';
import { closeTaskflowDb, getTaskflowDb } from './mcp-tools/db/taskflow-db.ts';
import { applyBoardConfigColumns, setupEngineDb } from './mcp-tools/taskflow-test-fixtures.ts';
import { runAsApprovedReplay } from './mcp-tools/taskflow-approval.ts';
import { handleTaskflowPendingChildBoardRegistration } from './poll-loop.ts';

// SEC#11 completeness (delta-parity handoff item #3): the DETERMINISTIC register
// fast-path (contact-card / "cadastrar" parser → handleTaskflowPendingChildBoardRegistration)
// emitted the provision_child_board system row DIRECTLY — bypassing the approval park the
// MCP api_admin register_person path goes through (emitAutoProvisionIfRequested →
// parkForApproval('provision_child_board_auto')). provision_child_board is the
// structure + network + container-spawn escalation SEC#11 gates; a side door around the
// park defeats the gate. These tests pin the closed door: the deterministic path now
// routes through the SAME shared gate, parks on the board chat, and tells the user the
// provisioning awaits admin approval (no optimistic "está sendo provisionado").

const BOARD = 'board-prov-park';
const ROUTING = {
  inReplyTo: null as string | null,
  platformId: '120363400000000000@g.us',
  channelType: 'whatsapp',
  threadId: null as string | null,
};

const ACTION = {
  personName: 'Reginaldo Silva',
  phone: '5585999990000',
  role: 'Coordenador',
  groupName: 'COORD - TaskFlow',
  groupFolder: 'coord-taskflow',
};

const chatMsg = (text: string, sender = 'alice') =>
  [{ kind: 'chat', content: JSON.stringify({ sender, text }) }];

const outboundContents = (): Array<Record<string, unknown>> =>
  (getOutboundDb().prepare('SELECT kind, content FROM messages_out').all() as Array<{
    kind: string;
    content: string;
  }>)
    .filter((r) => r.kind === 'system')
    .map((r) => JSON.parse(r.content));

const replyTexts = (): string[] =>
  (getOutboundDb().prepare('SELECT kind, content FROM messages_out').all() as Array<{
    kind: string;
    content: string;
  }>)
    .filter((r) => r.kind === 'chat')
    .map((r) => JSON.parse(r.content).text as string);

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare('INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)')
    .run('whatsapp', ROUTING.platformId, ROUTING.threadId);
  const db = setupEngineDb(BOARD, { withBoardAdmins: true });
  applyBoardConfigColumns(db);
  // canDelegateDown(): hierarchy_level < max_depth → register_person (with a phone)
  // returns an auto_provision_request — the exact escalation under test.
  db.prepare('UPDATE boards SET hierarchy_level = 0, max_depth = 2 WHERE id = ?').run(BOARD);
  process.env.NANOCLAW_TASKFLOW_BOARD_ID = BOARD;
});

afterEach(() => {
  delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  closeTaskflowDb();
  closeSessionDb();
});

describe('SEC#11 — deterministic register PARKS the auto-provision (no approval side door)', () => {
  it('writes a taskflow_request_approval row for provision_child_board_auto and NO raw provision_child_board row', () => {
    const handled = handleTaskflowPendingChildBoardRegistration(
      ACTION,
      chatMsg('cadastrar Reginaldo Silva'),
      ROUTING,
    );
    expect(handled).toBe(true);

    const systems = outboundContents();
    const park = systems.find((c) => c.action === 'taskflow_request_approval');
    expect(park, 'expected an approval-park row').toBeTruthy();
    expect(park!.tool).toBe('provision_child_board_auto');
    // The parked args are the engine's auto_provision_request — the approved
    // executor re-emits the IDENTICAL provision row from these on approval.
    const args = park!.args as Record<string, unknown>;
    expect(args.person_name).toBe(ACTION.personName);
    expect(args.group_folder).toBe(ACTION.groupFolder);

    // The escalation itself must NOT have been emitted (that's the side door).
    expect(systems.find((c) => c.action === 'provision_child_board')).toBeUndefined();
  });

  it('the user ack says the provisioning AWAITS APPROVAL — not "está sendo provisionado"', () => {
    handleTaskflowPendingChildBoardRegistration(ACTION, chatMsg('cadastrar'), ROUTING);
    const acks = replyTexts();
    expect(acks.length).toBeGreaterThan(0);
    const ack = acks.join('\n');
    expect(ack).toContain('Reginaldo Silva');
    expect(ack.toLowerCase()).toMatch(/aguarda.*aprova|aprova[çc][ãa]o/);
    expect(ack).not.toContain('está sendo provisionado');
  });

  it('registration itself still COMMITS (the park gates only the provisioning escalation)', () => {
    handleTaskflowPendingChildBoardRegistration(ACTION, chatMsg('cadastrar'), ROUTING);
    const person = getTaskflowDb()
      .prepare('SELECT person_id FROM board_people WHERE board_id = ? AND name = ?')
      .get(BOARD, ACTION.personName);
    expect(person).toBeTruthy();
  });

  it('approved replay falls through to the DIRECT provision emit (post-approval execution path)', async () => {
    await runAsApprovedReplay(() => {
      handleTaskflowPendingChildBoardRegistration(ACTION, chatMsg('cadastrar'), ROUTING);
    });
    const systems = outboundContents();
    expect(systems.find((c) => c.action === 'provision_child_board')).toBeTruthy();
    expect(systems.find((c) => c.action === 'taskflow_request_approval')).toBeUndefined();
  });

  it('PARKS even when NANOCLAW_TASKFLOW_BOARD_ID is UNSET and the board resolves from message content (env-less board hardening)', () => {
    // currentTaskflowBoardId falls back env → message content → CLAUDE.local.md. A board
    // whose folder-env is not wired still runs this handler — the gate must key on the
    // RESOLVED board id, not the env alone, or the side door survives exactly there.
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    const messages = [
      { kind: 'chat', content: JSON.stringify({ sender: 'alice', text: 'cadastrar', taskflowBoardId: BOARD }) },
    ];
    const handled = handleTaskflowPendingChildBoardRegistration(ACTION, messages, ROUTING);
    expect(handled).toBe(true);
    const systems = outboundContents();
    expect(systems.find((c) => c.action === 'taskflow_request_approval')).toBeTruthy();
    expect(systems.find((c) => c.action === 'provision_child_board')).toBeUndefined();
  });
});
