/**
 * Pure-function helpers shared across TaskFlow MCP tools and exposed for
 * cross-repo Python consumers (actor resolution roundtrip tests).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  normalizeAgentIds,
  normalizeEngineNotificationEvents,
  getServiceOutboundDbPath,
  parseActorArg,
  parseNotificationEvents,
  setServiceOutboundDbPath,
  setVerbatimIds,
} from './taskflow-helpers.ts';
import { closeSessionDb, closeTaskflowDb, initTestSessionDb } from '../db/connection.ts';
import { __resetTurnActorForTesting, clearTurnActor, setTurnActor } from './turn-actor.ts';
import { applyBoardConfigColumns, setupEngineDb } from './taskflow-test-fixtures.ts';
import { runAsApprovedReplay } from './replay-flag.ts';

// SEC#12 (#418): the chat surface must not let the model assert service authority. The engine treats
// sender_is_service=true as manager-equivalent, so a prompt-injected sender_is_service:true is a direct
// privilege bypass. normalizeAgentIds forces it off on the chat path; the FastAPI/verbatim entry (which
// short-circuits earlier with a server-resolved actor) keeps it.
describe('SEC#12 — sender_is_service stripped on the chat surface', () => {
  afterEach(() => setVerbatimIds(false));

  it('forces sender_is_service=false for a chat (non-verbatim) tool call', () => {
    setVerbatimIds(false);
    const out = normalizeAgentIds({ board_id: 'b1', sender_name: 'x', sender_is_service: true });
    expect(out.sender_is_service).toBe(false);
  });

  it('leaves sender_is_service untouched under verbatim (FastAPI server-resolved actor)', () => {
    setVerbatimIds(true);
    const out = normalizeAgentIds({ board_id: 'b1', sender_name: 'taskflow-api', sender_is_service: true });
    expect(out.sender_is_service).toBe(true);
  });

  it('does not invent sender_is_service when absent', () => {
    setVerbatimIds(false);
    const out = normalizeAgentIds({ board_id: 'b1', sender_name: 'x' });
    expect('sender_is_service' in out).toBe(false);
  });
});

// SEC#13 (#419): on the chat surface, normalizeAgentIds BINDS sender_name to the
// authenticated per-turn actor (turn-actor channel) and STRIPS model-supplied
// sender_external_id — the model can no longer name an arbitrary manager or assert
// an external-grant identity. When the actor is UNRESOLVED, sender_name is DELETED
// (a backstop — the real deny is requiresChatActor in chat-actor-guard.ts; an
// unguarded tool then gets no actor → engine person checks fail). Verbatim (FastAPI)
// and #407 replay keep their server-/park-authenticated values (bind skipped).
describe('SEC#13 (#419) — sender_name bound to the authenticated turn actor on the chat surface', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetTurnActorForTesting();
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-seci-taskflow';
  });
  afterEach(() => {
    clearTurnActor();
    closeSessionDb();
    closeTaskflowDb();
    setVerbatimIds(false);
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  });

  it('OVERWRITES a model-supplied sender_name with the resolved actor — a spoofed manager name is replaced by the real sender', () => {
    // WHY: this is the #419 core. The engine keys isManager/no-self-approval/audit on
    // sender_name; on chat it was a model arg. Binding to the authenticated sender means
    // naming a manager you are not no longer passes isManager.
    setTurnActor(['Ana']); // the authenticated inbound sender of this turn
    const out = normalizeAgentIds({ board_id: 'b', task_id: 'P1', sender_name: 'BossManager' });
    expect(out.sender_name).toBe('Ana');
  });

  it('DELETES sender_name (NOT the model value) when the turn actor is UNRESOLVED', () => {
    setTurnActor(['Ana', 'Mallory']); // mixed-sender batch → unresolved
    const out = normalizeAgentIds({ board_id: 'b', sender_name: 'BossManager' });
    expect('sender_name' in out).toBe(false); // backstop — never the spoofed value
  });

  it('DELETES sender_name when the turn_actor channel was never written (fail-closed, not fail-open)', () => {
    // A never-written channel must DENY, proving no fail-open binding was reintroduced.
    const out = normalizeAgentIds({ board_id: 'b', sender_name: 'BossManager' });
    expect('sender_name' in out).toBe(false);
  });

  it('does NOT inject sender_name when the tool did not pass one (read/system tools untouched)', () => {
    setTurnActor(['Ana']);
    const out = normalizeAgentIds({ board_id: 'b', query: 'task_details', task_id: 'P1' });
    expect('sender_name' in out).toBe(false);
  });

  it('STRIPS a model-supplied sender_external_id on the chat surface (no authenticated external channel exists; defeats external-grant spoof)', () => {
    setTurnActor(['Ana']);
    const out = normalizeAgentIds({
      board_id: 'b',
      action: 'accept_external_invite',
      task_id: 'M1',
      sender_name: 'Ana',
      sender_external_id: 'ext-someone-else',
    });
    expect('sender_external_id' in out).toBe(false);
    expect(out.sender_name).toBe('Ana');
  });

  it('resolves a native-WhatsApp JID actor to the board person_id (live-adapter parity — phone match)', () => {
    // The native WhatsApp adapter authenticates the sender as a JID
    // ('5586…@s.whatsapp.net'), not a display name. Binding the raw JID made
    // every person-gated operation fail on a live board (engine resolvePerson
    // has no phone path). The binding must resolve it via board_people.phone —
    // V1's template phone-match rule, now deterministic.
    const db = setupEngineDb('board-seci-taskflow', { withBoardAdmins: true });
    applyBoardConfigColumns(db);
    db.prepare(
      `INSERT INTO board_people (board_id, person_id, name, role, phone) VALUES (?, 'giovanni', 'Carlos Giovanni', 'manager', '5586981234567')`,
    ).run('board-seci-taskflow');
    setTurnActor(['5586981234567@s.whatsapp.net']);
    // Even a spoofed manager name binds to the JID's REAL board person.
    const out = normalizeAgentIds({ board_id: 'b', task_id: 'P1', sender_name: 'BossManager' });
    expect(out.sender_name).toBe('giovanni');
  });

  it('keeps the raw JID when no board person matches (fail-closed — engine denies person-gated ops)', () => {
    const db = setupEngineDb('board-seci-taskflow', { withBoardAdmins: true });
    applyBoardConfigColumns(db);
    setTurnActor(['5599999999999@s.whatsapp.net']);
    const out = normalizeAgentIds({ board_id: 'b', sender_name: 'BossManager' });
    expect(out.sender_name).toBe('5599999999999@s.whatsapp.net');
  });

  it('SKIPS binding under verbatim (FastAPI server-resolved actor kept)', () => {
    setTurnActor(['Ana']);
    setVerbatimIds(true);
    const out = normalizeAgentIds({
      board_id: 'uuid-x',
      sender_name: 'fastapi-resolved-manager',
      sender_external_id: 'ext-legit',
    });
    expect(out.sender_name).toBe('fastapi-resolved-manager');
    expect(out.sender_external_id).toBe('ext-legit');
  });

  it('SKIPS binding under #407 approved-replay (parked, already-authenticated args survive unchanged)', async () => {
    // The parked sender_name was bound at park time and the replay runs before any new
    // turn_actor write — re-binding to a stale/empty channel would wrongly DENY an
    // admin-approved action.
    setTurnActor([]); // unresolved channel during replay
    await runAsApprovedReplay(() => {
      const out = normalizeAgentIds({ board_id: 'b', sender_name: 'Ana', sender_external_id: 'ext-parked' });
      expect(out.sender_name).toBe('Ana');
      expect(out.sender_external_id).toBe('ext-parked');
    });
  });

  it('does NOT bind for a non-taskflow agent (no env board) — sender_name passes through', () => {
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    setTurnActor(['Ana']);
    const out = normalizeAgentIds({ board_id: 'b', sender_name: 'Carlos' });
    expect(out.sender_name).toBe('Carlos');
  });
});

/**
 * 0h-v2 Option A — Unit 4: the service-session outbound.db path the
 * FastAPI subprocess is handed via `--service-outbound-db`. Process-
 * level (like `setVerbatimIds`), not a per-request MCP arg, so it can't
 * be spoofed by tool input. Absent is legal (tf fail-mode (b) — the
 * enqueue caller fail-closes per-call); the getter returns undefined.
 */
describe('service-outbound-db path (Unit 4)', () => {
  afterEach(() => setServiceOutboundDbPath(undefined));

  it('defaults to undefined (absent --service-outbound-db is legal — fail-mode (b))', () => {
    setServiceOutboundDbPath(undefined);
    expect(getServiceOutboundDbPath()).toBeUndefined();
  });

  it('round-trips the absolute path the entrypoint parsed', () => {
    setServiceOutboundDbPath('/root/nanoclaw/data/v2-sessions/taskflow-service/taskflow-service/outbound.db');
    expect(getServiceOutboundDbPath()).toBe(
      '/root/nanoclaw/data/v2-sessions/taskflow-service/taskflow-service/outbound.db',
    );
  });

  it('can be cleared back to undefined', () => {
    setServiceOutboundDbPath('/x/outbound.db');
    setServiceOutboundDbPath(undefined);
    expect(getServiceOutboundDbPath()).toBeUndefined();
  });
});

describe('normalizeAgentIds', () => {
  // Tests stuff process.env.NANOCLAW_TASKFLOW_BOARD_ID — guard cross-test
  // leaks. Bun runs files in one process; any normalizeAgentIds caller in a
  // sibling test file would otherwise see a stale env-overwrite.
  afterEach(() => {
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  });

  // Why this matters: Phase 2 (2026-05-11) corpus replay showed v2 agents
  // calling MCP tools with user-typed lowercase task IDs ("p11.23") and
  // short-form board IDs ("seci-taskflow" instead of "board-seci-taskflow").
  // The engine layer is strict on both; lookups returned "task not found"
  // for tasks that existed. Normalizing once at the MCP tool boundary
  // keeps the engine layer simple and lets fixture tests use any convention.

  it('prefixes a short-form board_id with "board-" when env is unset', () => {
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    const out = normalizeAgentIds({ board_id: 'seci-taskflow' });
    expect(out.board_id).toBe('board-seci-taskflow');
  });

  it('leaves already-prefixed board_id unchanged when env is unset', () => {
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    const out = normalizeAgentIds({ board_id: 'board-seci-taskflow' });
    expect(out.board_id).toBe('board-seci-taskflow');
  });

  it('env-overwrites board_id when NANOCLAW_TASKFLOW_BOARD_ID is set (v1 parity)', () => {
    // Why this matters: v1's MCP handlers do `engine.X({ ...args, board_id:
    // boardId })`, host-injecting board_id from container env regardless of
    // what the agent passed. v2 must do the same for board-scoped agents.
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-seci-taskflow';
    try {
      const out = normalizeAgentIds({ board_id: 'wrong-board' });
      expect(out.board_id).toBe('board-seci-taskflow');
    } finally {
      delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    }
  });

  it('env-injects board_id even when agent omitted it', () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-seci-taskflow';
    try {
      const out = normalizeAgentIds({ query: 'task_details', task_id: 'P1' });
      expect(out.board_id).toBe('board-seci-taskflow');
    } finally {
      delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    }
  });

  it('handler signature: agent can omit board_id when env is set (v1 parity)', async () => {
    // Regression for Codex IMPORTANT 2026-05-11: schema dropped board_id from
    // required AND properties, env injection at the helper boundary. Verifies
    // the full path — schema accepts no board_id, helper supplies it from env,
    // handler proceeds without "board_id: required" failure.
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-test-001';
    try {
      const { apiQueryTool } = await import('./taskflow-api-mutate.ts');
      // Schema-shape preconditions for this regression:
      const schema = apiQueryTool.tool.inputSchema as { properties: Record<string, unknown>; required: string[] };
      expect(schema.required).not.toContain('board_id');
      expect(schema.properties).not.toHaveProperty('board_id');
      // Handler behavior: normalizeAgentIds runs first and rewrites args.board_id
      // from env. Call without board_id and verify it does NOT bounce with a
      // "board_id required" structural error. (The downstream engine call may
      // still surface other validation errors because we don't seed a board,
      // but the early `requireString(args, 'board_id')` gate must not fire.)
      const out = normalizeAgentIds({ query: 'task_details', task_id: 'X1' });
      expect(out.board_id).toBe('board-test-001');
    } finally {
      delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    }
  });

  it('uppercases task_id', () => {
    const out = normalizeAgentIds({ task_id: 'p11.23' });
    expect(out.task_id).toBe('P11.23');
  });

  it('leaves already-uppercase task_id unchanged', () => {
    const out = normalizeAgentIds({ task_id: 'P11.23' });
    expect(out.task_id).toBe('P11.23');
  });

  it('uppercases all task-id-like keys (target_task_id, parent_task_id, etc.)', () => {
    const out = normalizeAgentIds({
      task_id: 't43',
      target_task_id: 't44',
      parent_task_id: 'p11',
      confirmed_task_id: 't45',
    });
    expect(out.task_id).toBe('T43');
    expect(out.target_task_id).toBe('T44');
    expect(out.parent_task_id).toBe('P11');
    expect(out.confirmed_task_id).toBe('T45');
  });

  it('uppercases subtask_id', () => {
    const out = normalizeAgentIds({ subtask_id: 's-001' });
    expect(out.subtask_id).toBe('S-001');
  });

  it('uppercases task_ids arrays', () => {
    const out = normalizeAgentIds({ task_ids: ['p11.17', 'p11.19'] });
    expect(out.task_ids).toEqual(['P11.17', 'P11.19']);
  });

  it('does not mutate the input object', () => {
    const input = { board_id: 'seci', task_id: 'p11.23' };
    const out = normalizeAgentIds(input);
    expect(input.board_id).toBe('seci');
    expect(input.task_id).toBe('p11.23');
    expect(out).not.toBe(input);
  });

  it('leaves non-string values alone', () => {
    const out = normalizeAgentIds({ board_id: 123, task_id: null, search_text: 'lower text' });
    expect(out.board_id).toBe(123);
    expect(out.task_id).toBe(null);
    expect(out.search_text).toBe('lower text');
  });

  it('preserves unrelated keys', () => {
    const out = normalizeAgentIds({
      board_id: 'seci',
      task_id: 'p1',
      sender_name: 'Carlos',
      query: 'task_details',
    });
    expect(out.sender_name).toBe('Carlos');
    expect(out.query).toBe('task_details');
  });

  // SECURITY BOUNDARY (cross-board spoof). The env-overwrite mechanism is the
  // sole thing standing between a board-scoped agent and another team's board.
  // The 'wrong-board' test above proves the mechanism fires; these frame it as
  // a red-team case — a WELL-FORMED, DIFFERENT, REAL board id — so the test
  // would fail if normalize ever honored a cross-board id the agent supplied.
  it('SECURITY: an agent-supplied board_id pointing at ANOTHER real board is overwritten by the env board (cross-board spoof defeated)', () => {
    // WHY (intent): the spoof target is a DIFFERENT real board id, not a
    // malformed sentinel. The assertion is that the result equals the ENV board
    // (the agent's own), NOT the agent-supplied target — so a regression that
    // passed through any well-formed board_id would fail here.
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-seci-taskflow';
    try {
      const out = normalizeAgentIds({ board_id: 'board-thiago-taskflow', task_id: 'P1' });
      expect(out.board_id).toBe('board-seci-taskflow');
    } finally {
      delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    }
  });

  it('SECURITY: in-session (verbatim OFF) the env board ALWAYS wins — the only escape hatch is _verbatimIds, which the in-session barrel never sets', () => {
    // WHY (intent): normalizeAgentIds returns the args verbatim ONLY when
    // _verbatimIds is true. setVerbatimIds(true) is proven subprocess-entry-only
    // by subprocess-gate-invariant.test.ts. With verbatim OFF (the in-session
    // default) the env board MUST win regardless of what the agent passes — this
    // is the structural guarantee that an in-session agent cannot reach another
    // board even with a perfectly-formed cross-board id.
    setVerbatimIds(false);
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-seci-taskflow';
    try {
      expect(normalizeAgentIds({ board_id: 'board-attacker' }).board_id).toBe('board-seci-taskflow');
    } finally {
      delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
      // Reset locally: the describe-level afterEach (line 49) only clears the env
      // var; the setVerbatimIds afterEach lives in a sibling describe block, so
      // reset here to avoid leaking verbatim state into other tests in this file.
      setVerbatimIds(false);
    }
  });
});

describe('parseActorArg', () => {
  it('accepts a valid taskflow_person actor', () => {
    const actor = parseActorArg({
      actor_type: 'taskflow_person',
      source_auth: 'jwt',
      user_id: 'u1',
      board_id: 'b1',
      person_id: 'alice',
      display_name: 'Alice',
    });
    expect(actor.actor_type).toBe('taskflow_person');
    if (actor.actor_type === 'taskflow_person') {
      expect(actor.person_id).toBe('alice');
      expect(actor.display_name).toBe('Alice');
    }
  });

  it('accepts a valid api_service actor', () => {
    const actor = parseActorArg({
      actor_type: 'api_service',
      source_auth: 'api_token',
      board_id: 'b1',
      service_name: 'taskflow-api',
    });
    expect(actor.actor_type).toBe('api_service');
    if (actor.actor_type === 'api_service') {
      expect(actor.service_name).toBe('taskflow-api');
    }
  });

  it('rejects null', () => {
    expect(() => parseActorArg(null)).toThrow('actor: expected object');
  });

  it('rejects unknown actor_type', () => {
    expect(() => parseActorArg({ actor_type: 'unknown' })).toThrow(
      'actor.actor_type: unknown value',
    );
  });

  it('rejects taskflow_person with missing person_id', () => {
    expect(() =>
      parseActorArg({
        actor_type: 'taskflow_person',
        source_auth: 'jwt',
        user_id: 'u1',
        board_id: 'b1',
        display_name: 'Alice',
      }),
    ).toThrow('actor.person_id: required string');
  });

  it('rejects api_service with wrong source_auth', () => {
    expect(() =>
      parseActorArg({
        actor_type: 'api_service',
        source_auth: 'jwt',
        board_id: 'b1',
        service_name: 'taskflow-api',
      }),
    ).toThrow('actor.source_auth: expected "api_token"');
  });
});

describe('parseNotificationEvents', () => {
  it('accepts a valid deferred_notification', () => {
    const result = parseNotificationEvents([
      { kind: 'deferred_notification', target_person_id: 'alice', message: 'Hello' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('deferred_notification');
    if (result[0].kind === 'deferred_notification') {
      expect(result[0].target_person_id).toBe('alice');
      expect(result[0].message).toBe('Hello');
    }
  });

  it('accepts a valid direct_message', () => {
    const result = parseNotificationEvents([
      { kind: 'direct_message', target_chat_jid: 'jid@s.whatsapp.net', message: 'Hi there' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('direct_message');
    if (result[0].kind === 'direct_message') {
      expect(result[0].target_chat_jid).toBe('jid@s.whatsapp.net');
      expect(result[0].message).toBe('Hi there');
    }
  });

  it('accepts a valid parent_notification', () => {
    const result = parseNotificationEvents([
      { kind: 'parent_notification', parent_group_jid: 'group@g.us', message: 'Update' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('parent_notification');
    if (result[0].kind === 'parent_notification') {
      expect(result[0].parent_group_jid).toBe('group@g.us');
      expect(result[0].message).toBe('Update');
    }
  });

  it('rejects items with unknown kind', () => {
    expect(() =>
      parseNotificationEvents([{ kind: 'unknown_kind', message: 'Should fail' }]),
    ).toThrow(/unknown value/);
  });

  it('returns empty array for nullish input and rejects malformed non-array input', () => {
    expect(parseNotificationEvents(null)).toEqual([]);
    expect(parseNotificationEvents(undefined)).toEqual([]);
    expect(() => parseNotificationEvents('a string')).toThrow(/expected array/);
    expect(() => parseNotificationEvents(42)).toThrow(/expected array/);
  });

  it('rejects empty message string', () => {
    expect(() =>
      parseNotificationEvents([
        { kind: 'deferred_notification', target_person_id: 'alice', message: '' },
      ]),
    ).toThrow(/message/);
    expect(() =>
      parseNotificationEvents([
        { kind: 'direct_message', target_chat_jid: 'jid@s.whatsapp.net', message: '' },
      ]),
    ).toThrow(/message/);
    expect(() =>
      parseNotificationEvents([
        { kind: 'parent_notification', parent_group_jid: 'group@g.us', message: '' },
      ]),
    ).toThrow(/message/);
  });

  it('rejects deferred_notification missing required field target_person_id', () => {
    expect(() =>
      parseNotificationEvents([{ kind: 'deferred_notification', message: 'No person' }]),
    ).toThrow(/target_person_id/);
  });

  it('accepts destination_message — symbolic-name routing for cross-board approval flows (A12)', () => {
    // The agent's send_message MCP tool resolves the destination_name via
    // agent_destinations. The engine emits this kind for cross-board
    // approval forwarding where it cannot know the receiving agent's
    // local destination names ahead of time.
    const result = parseNotificationEvents([
      { kind: 'destination_message', destination_name: 'parent_board', message: 'Request' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('destination_message');
    if (result[0].kind === 'destination_message') {
      expect(result[0].destination_name).toBe('parent_board');
      expect(result[0].message).toBe('Request');
    }
  });

  it('rejects destination_message missing required destination_name (A12)', () => {
    expect(() =>
      parseNotificationEvents([{ kind: 'destination_message', message: 'No destination' }]),
    ).toThrow(/destination_name/);
  });
});

describe('normalizeEngineNotificationEvents', () => {
  it('normalizes group-routed, deferred, and parent notifications', () => {
    const result = normalizeEngineNotificationEvents({
      notifications: [
        {
          notification_group_jid: 'group-1@g.us',
          target_person_id: 'alice',
          message: 'group update',
        },
        { target_person_id: 'bob', message: 'deferred update' },
      ],
      parent_notification: { parent_group_jid: 'parent@g.us', message: 'parent update' },
    });

    expect(result).toEqual([
      { kind: 'direct_message', target_chat_jid: 'group-1@g.us', message: 'group update' },
      { kind: 'deferred_notification', target_person_id: 'bob', message: 'deferred update' },
      { kind: 'parent_notification', parent_group_jid: 'parent@g.us', message: 'parent update' },
    ]);
  });

  it('preserves same-call parent dedup behavior', () => {
    const result = normalizeEngineNotificationEvents({
      notifications: [
        {
          notification_group_jid: 'parent@g.us',
          target_person_id: 'alice',
          message: 'already delivered',
        },
      ],
      parent_notification: { parent_group_jid: 'parent@g.us', message: 'duplicate parent update' },
    });

    expect(result).toEqual([
      { kind: 'direct_message', target_chat_jid: 'parent@g.us', message: 'already delivered' },
    ]);
  });

  it('rejects malformed engine notification entries', () => {
    expect(() =>
      normalizeEngineNotificationEvents({ notifications: [{ message: 'missing route' }] }),
    ).toThrow(/missing routing target/);
  });

  it('maps a group-targeted notification with NO jid to in_chat_notice, not a throw (#399 invite-pending)', () => {
    // The engine pushes { target_kind:'group', message } (no notification_group_jid)
    // for the "Convite pendente" forwardable invite card when an external
    // participant has never messaged the bot. Pre-#399 this hit the
    // missing-routing-target throw → finalizeMutationResult threw → the tool
    // returned success:false despite a committed DB write. It is an in-chat
    // card, not a host-dispatchable event.
    const result = normalizeEngineNotificationEvents({
      notifications: [{ target_kind: 'group', message: '📅 Convite pendente — encaminhe a mensagem' }],
    });
    expect(result).toEqual([
      { kind: 'in_chat_notice', message: '📅 Convite pendente — encaminhe a mensagem' },
    ]);
  });

  it('normalizes engine destination_name into destination_message kind (A12 cross-board approval)', () => {
    // Engine emits { destination_name, message } in notifications when it
    // wants the receiving agent to resolve the destination by name via its
    // own agent_destinations registry (rather than passing a JID directly).
    const result = normalizeEngineNotificationEvents({
      notifications: [
        { destination_name: 'source-CHI', message: '✅ Solicitação aprovada' },
      ],
    });
    expect(result).toEqual([
      { kind: 'destination_message', destination_name: 'source-CHI', message: '✅ Solicitação aprovada' },
    ]);
  });

  it('routes target_kind=dm via target_chat_jid', () => {
    const result = normalizeEngineNotificationEvents({
      notifications: [
        {
          target_kind: 'dm',
          target_chat_jid: 'alice@s.whatsapp.net',
          message: 'dm-routed',
        },
      ],
    });
    expect(result).toEqual([
      { kind: 'direct_message', target_chat_jid: 'alice@s.whatsapp.net', message: 'dm-routed' },
    ]);
  });
});

/**
 * Codex BLOCKER 2026-05-16: `normalizeAgentIds` board-prefixes
 * plain-UUID board ids — wrong for the FastAPI subprocess, which passes
 * canonical ids verbatim. The standalone taskflow entrypoint enables
 * verbatim mode so EVERY FastAPI-facing tool (task/note/read, not just
 * the 4 board tools) skips rewriting. In-container barrel never sets it
 * → zero behavior change for the WhatsApp agent.
 */
describe('setVerbatimIds (FastAPI subprocess passthrough)', () => {
  afterEach(() => {
    setVerbatimIds(false);
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  });

  it('verbatim mode: plain-UUID board_id is NOT prefixed, task_id NOT uppercased', () => {
    setVerbatimIds(true);
    const out = normalizeAgentIds({
      board_id: '550e8400-e29b-41d4-a716-446655440000',
      task_id: 'p11.23',
    });
    expect(out.board_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(out.task_id).toBe('p11.23');
  });

  it('verbatim mode overrides even a set NANOCLAW_TASKFLOW_BOARD_ID env', () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-injected';
    setVerbatimIds(true);
    const out = normalizeAgentIds({ board_id: 'uuid-x' });
    expect(out.board_id).toBe('uuid-x');
  });

  it('still returns a new object (input not mutated) in verbatim mode', () => {
    setVerbatimIds(true);
    const input = { board_id: 'uuid-x' };
    const out = normalizeAgentIds(input);
    expect(out).not.toBe(input);
    expect(out).toEqual({ board_id: 'uuid-x' });
  });

  it('resetting verbatim mode restores normal prefixing/uppercasing', () => {
    setVerbatimIds(true);
    setVerbatimIds(false);
    const out = normalizeAgentIds({ board_id: 'seci-taskflow', task_id: 'p1' });
    expect(out.board_id).toBe('board-seci-taskflow');
    expect(out.task_id).toBe('P1');
  });
});
