import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.ts';
import { denyIfChatActorUnresolved, denyIfExternalActorBlocked, requiresChatActor } from './chat-actor-guard.ts';
import { getRegisteredToolForTesting } from './server.ts';
import { setVerbatimIds } from './taskflow-helpers.ts';
import { runAsApprovedReplay } from './replay-flag.ts';
import { __resetTurnActorForTesting, clearTurnActor, setTurnActor } from './turn-actor.ts';
import {
  __resetTurnExternalActorForTesting,
  clearTurnExternalActor,
  setTurnExternalActor,
} from './turn-external-actor.ts';
import type { McpToolDefinition } from './types.ts';

// #419 (SEC#13): the ENFORCEMENT half. Binding sender_name to the authenticated
// actor is not enough — an unresolved actor only fails the engine's person-gated
// checks, so unprivileged mutations (create/comment/update-unowned) would still
// run (Codex #419 BLOCKER). requiresChatActor denies every board-mutating tool
// when the in-session turn has no single authenticated chat sender.

const ok: McpToolDefinition = {
  tool: { name: 'probe', inputSchema: { type: 'object' } },
  handler: async () => ({ content: [{ type: 'text', text: JSON.stringify({ success: true, ran: true }) }] }),
};

function parse(r: { content: { text: string }[] }) {
  return JSON.parse(r.content[0].text);
}

describe('chat-actor-guard — denyIfChatActorUnresolved / requiresChatActor', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetTurnActorForTesting();
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-x';
  });
  afterEach(() => {
    clearTurnActor();
    closeSessionDb();
    setVerbatimIds(false);
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  });

  it('DENIES (permission_denied) when the chat actor is unresolved', () => {
    setTurnActor([]); // no sender → unresolved
    const r = denyIfChatActorUnresolved();
    expect(r).not.toBeNull();
    const body = parse(r!);
    expect(body.error_code).toBe('permission_denied');
    expect(String(body.error)).toMatch(/authenticate/i);
  });

  it('PROCEEDS (null) when the chat actor resolves to a single sender', () => {
    setTurnActor(['Ana']);
    expect(denyIfChatActorUnresolved()).toBeNull();
  });

  it('PROCEEDS under verbatim (FastAPI authenticates server-side)', () => {
    setTurnActor([]); // unresolved, but verbatim bypasses
    setVerbatimIds(true);
    expect(denyIfChatActorUnresolved()).toBeNull();
  });

  it('PROCEEDS under #407 approved-replay (park-time-authenticated args)', async () => {
    setTurnActor([]);
    await runAsApprovedReplay(() => {
      expect(denyIfChatActorUnresolved()).toBeNull();
    });
  });

  it('PROCEEDS for a non-taskflow agent (no env board)', () => {
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    setTurnActor([]);
    expect(denyIfChatActorUnresolved()).toBeNull();
  });

  it('requiresChatActor fronts the handler: denies unresolved, runs it when resolved', async () => {
    const guarded = requiresChatActor(ok);
    setTurnActor([]);
    expect(parse(await guarded.handler({})).error_code).toBe('permission_denied');
    setTurnActor(['Ana']);
    expect(parse(await guarded.handler({})).ran).toBe(true);
    // schema is preserved untouched
    expect(guarded.tool).toBe(ok.tool);
  });
});

// COVERAGE: every board-mutating tool's REGISTERED (post-wrap) handler must deny
// on an unresolved actor; read tools must NOT. A newly-added mutate tool that
// forgets requiresChatActor fails this suite rather than shipping spoofable.
const MUTATE_TOOLS = [
  'api_create_simple_task', 'api_create_meeting_task', 'api_create_task',
  'api_move', 'api_move_to_column', 'api_admin', 'api_reassign', 'api_undo',
  'api_update_task', 'api_update_simple_task', 'api_hierarchy', 'api_dependency',
  'api_delete_simple_task', 'api_reschedule_meeting', 'api_note_meeting',
  'api_task_add_note', 'api_task_edit_note', 'api_task_remove_note',
  'api_task_add_comment',
];
const READ_TOOLS = ['api_query', 'api_report', 'api_board_activity', 'api_filter_board_tasks', 'api_linked_tasks'];

describe('chat-actor-guard — every board-mutating tool is gated (registry coverage)', () => {
  beforeEach(async () => {
    // Import the tool modules so they register their (wrapped) handlers.
    await import('./taskflow-api-mutate.ts');
    await import('./taskflow-api-update.ts');
    await import('./taskflow-api-notes.ts');
    await import('./taskflow-api-comment.ts');
    await import('./taskflow-api-read.ts');
    initTestSessionDb();
    __resetTurnActorForTesting();
    setTurnActor([]); // unresolved turn
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-x';
  });
  afterEach(() => {
    clearTurnActor();
    closeSessionDb();
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  });

  for (const name of MUTATE_TOOLS) {
    it(`${name} DENIES on an unresolved actor (requiresChatActor applied)`, async () => {
      const def = getRegisteredToolForTesting(name);
      expect(def, `tool ${name} is not registered`).toBeDefined();
      const body = parse(await def!.handler({}));
      expect(body.error_code, `${name} did not deny on unresolved actor — missing requiresChatActor wrapper`).toBe(
        'permission_denied',
      );
      expect(String(body.error)).toMatch(/authenticate/i);
    });
  }

  for (const name of READ_TOOLS) {
    it(`${name} is NOT gated (reads proceed in an unresolved turn)`, async () => {
      const def = getRegisteredToolForTesting(name);
      expect(def, `tool ${name} is not registered`).toBeDefined();
      // The guard RETURNS a deny envelope; it never throws. A read may throw or
      // error for OTHER reasons (no taskflow DB seeded here) — either way it must
      // NOT be the actor-guard deny, proving it was not wrapped by requiresChatActor.
      let isActorDeny = false;
      try {
        const body = parse(await def!.handler({}));
        isActorDeny = body.error_code === 'permission_denied' && /authenticate/i.test(String(body.error ?? ''));
      } catch {
        isActorDeny = false; // a throw is never the guard's return-value deny
      }
      expect(isActorDeny, `${name} was wrongly gated by requiresChatActor`).toBe(false);
    });
  }
});

// RC5-ext P3 (C7) — external-safe capability gate (B6 content confinement).
// On a resolved EXTERNAL turn, DEFAULT-DENY every tool but the grant-scoped
// flow (add a meeting note; api_admin accept_external_invite). Non-external
// turns, FastAPI verbatim, and #407 replay are unaffected.
const ext1 = { externalId: 'ext-1', displayName: 'Maria', sourceDmMgId: 'mg-1', boardId: 'board-x' };

describe('chat-actor-guard — denyIfExternalActorBlocked (C7)', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetTurnActorForTesting();
    __resetTurnExternalActorForTesting();
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-x';
  });
  afterEach(() => {
    clearTurnActor();
    clearTurnExternalActor();
    closeSessionDb();
    setVerbatimIds(false);
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  });

  it('no env board → no restriction (null)', () => {
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    setTurnExternalActor([ext1]);
    expect(denyIfExternalActorBlocked('api_query', {})).toBeNull();
  });

  it('a NON-external turn (no external resolved) is unrestricted', () => {
    setTurnActor(['Ana']); // board turn
    expect(denyIfExternalActorBlocked('api_query', {})).toBeNull();
    expect(denyIfExternalActorBlocked('api_board_detail', {})).toBeNull();
  });

  it('an external turn DENIES board reads and arbitrary tools (default-deny)', () => {
    setTurnExternalActor([ext1]);
    for (const t of ['api_query', 'api_board_detail', 'api_board_tasks', 'memory_search', 'send_file', 'api_reassign']) {
      const r = denyIfExternalActorBlocked(t, {});
      expect(r, `${t} should be denied on an external turn`).not.toBeNull();
      expect(parse(r!).error_code).toBe('permission_denied');
    }
  });

  it('an external turn ALLOWS api_task_add_note through this gate', () => {
    setTurnExternalActor([ext1]);
    expect(denyIfExternalActorBlocked('api_task_add_note', { task_id: 'M1' })).toBeNull();
  });

  it('an external turn allows api_admin ONLY for accept_external_invite', () => {
    setTurnExternalActor([ext1]);
    expect(denyIfExternalActorBlocked('api_admin', { action: 'accept_external_invite', task_id: 'M1' })).toBeNull();
    expect(denyIfExternalActorBlocked('api_admin', { action: 'register_person' })).not.toBeNull();
    expect(denyIfExternalActorBlocked('api_admin', {})).not.toBeNull(); // no action
  });

  it('a POISONED external turn (two externals → unresolved) is treated as non-external (gate is no-op; the mutate guards still deny)', () => {
    setTurnExternalActor([ext1, { ...ext1, externalId: 'ext-2' }]);
    expect(denyIfExternalActorBlocked('api_query', {})).toBeNull();
  });

  it('FastAPI verbatim + #407 replay bypass the gate', () => {
    setTurnExternalActor([ext1]);
    setVerbatimIds(true);
    expect(denyIfExternalActorBlocked('api_query', {})).toBeNull();
    setVerbatimIds(false);
    runAsApprovedReplay(() => {
      expect(denyIfExternalActorBlocked('api_query', {})).toBeNull();
    });
  });
});

// RC5-ext P3 (C4b) — the board-actor guard (requiresChatActor) is ACTOR-AWARE.
// SEC#13's requiresChatActor denies every wrapped mutate tool when turn_actor is
// unresolved. On an external turn turn_actor is POISONED (an external is never a
// board person), so without C4b the whitelisted note/accept tools stay denied and
// the confined external flow can do nothing. C4b lets an authenticated EXTERNAL
// turn through requiresChatActor ONLY for the external-safe tools (the same
// whitelist the C7 central gate enforces) — every other mutate tool still denies.
describe('chat-actor-guard — C4b actor-aware requiresChatActor (external-safe scoped)', () => {
  beforeEach(() => {
    initTestSessionDb();
    __resetTurnActorForTesting();
    __resetTurnExternalActorForTesting();
    setTurnActor([]); // turn_actor unresolved (poisoned, as on a real external turn)
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-x';
  });
  afterEach(() => {
    clearTurnActor();
    clearTurnExternalActor();
    closeSessionDb();
    setVerbatimIds(false);
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  });

  it('a resolved external turn PASSES the board-actor guard for api_task_add_note', () => {
    setTurnExternalActor([ext1]);
    expect(denyIfChatActorUnresolved('api_task_add_note', {})).toBeNull();
  });

  it('a resolved external turn PASSES the guard for api_admin accept_external_invite ONLY', () => {
    setTurnExternalActor([ext1]);
    expect(denyIfChatActorUnresolved('api_admin', { action: 'accept_external_invite' })).toBeNull();
    expect(denyIfChatActorUnresolved('api_admin', { action: 'register_person' })).not.toBeNull();
  });

  it('a resolved external turn STILL DENIES non-whitelisted mutate tools (no board-person authority)', () => {
    setTurnExternalActor([ext1]);
    for (const t of ['api_create_simple_task', 'api_move', 'api_reassign', 'api_task_edit_note', 'api_task_remove_note']) {
      const r = denyIfChatActorUnresolved(t, {});
      expect(r, `${t} must stay denied on an external turn`).not.toBeNull();
      expect(parse(r!).error_code).toBe('permission_denied');
    }
  });

  it('NO external + unresolved board still denies even an external-safe tool name (C4b never opens a board turn)', () => {
    // turn_external_actor unresolved, turn_actor unresolved → the external bypass
    // must NOT fire just because the tool name is whitelisted.
    expect(denyIfChatActorUnresolved('api_task_add_note', {})).not.toBeNull();
  });

  it('a POISONED external turn (two externals → unresolved) does NOT pass the guard for a whitelisted tool', () => {
    setTurnExternalActor([ext1, { ...ext1, externalId: 'ext-2' }]);
    expect(denyIfChatActorUnresolved('api_task_add_note', {})).not.toBeNull();
  });

  it('requiresChatActor runs the whitelisted handler on an external turn', async () => {
    setTurnExternalActor([ext1]);
    const guarded = requiresChatActor({
      tool: { name: 'api_task_add_note', inputSchema: { type: 'object' } },
      handler: async () => ({ content: [{ type: 'text', text: JSON.stringify({ success: true, ran: true }) }] }),
    });
    expect(parse(await guarded.handler({})).ran).toBe(true);
  });
});

// Registry coverage for an EXTERNAL turn: at the REGISTERED (post-wrap) handler
// level, requiresChatActor itself (the second gate, defense-in-depth behind the
// C7 central dispatch gate) must DENY every mutate tool except api_task_add_note
// — independent of C7. A whitelist that drifts between C4b and C7 fails here.
describe('chat-actor-guard — C4b external-turn registry coverage', () => {
  beforeEach(async () => {
    await import('./taskflow-api-mutate.ts');
    await import('./taskflow-api-update.ts');
    await import('./taskflow-api-notes.ts');
    await import('./taskflow-api-comment.ts');
    await import('./taskflow-api-read.ts');
    initTestSessionDb();
    __resetTurnActorForTesting();
    __resetTurnExternalActorForTesting();
    setTurnActor([]); // turn_actor poisoned, as on a real external turn
    setTurnExternalActor([ext1]); // a single resolved external
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-x';
  });
  afterEach(() => {
    clearTurnActor();
    clearTurnExternalActor();
    closeSessionDb();
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  });

  for (const name of MUTATE_TOOLS.filter((n) => n !== 'api_task_add_note')) {
    it(`${name} STILL denies on an external turn (only api_task_add_note is external-safe)`, async () => {
      const def = getRegisteredToolForTesting(name);
      expect(def, `tool ${name} is not registered`).toBeDefined();
      // api_admin with a non-whitelisted action denies via the actor guard; with
      // accept_external_invite it would pass the guard and run the real handler —
      // so probe api_admin with a plain (non-accept) action to assert the deny.
      const args = name === 'api_admin' ? { action: 'register_person' } : {};
      const body = parse(await def!.handler(args));
      expect(body.error_code, `${name} must stay denied on an external turn`).toBe('permission_denied');
      expect(String(body.error)).toMatch(/authenticate/i);
    });
  }

  it('api_task_add_note PASSES the actor guard on an external turn (handler runs / no actor deny)', async () => {
    const def = getRegisteredToolForTesting('api_task_add_note');
    expect(def).toBeDefined();
    // It passes requiresChatActor (C4b) and reaches the real handler, which then
    // errors for OTHER reasons (no meeting/grant/DB seeded) — never the actor deny.
    let isActorDeny = false;
    try {
      const body = parse(await def!.handler({ task_id: 'M1', sender_name: 'Maria', text: 'oi' }));
      isActorDeny = body.error_code === 'permission_denied' && /authenticate/i.test(String(body.error ?? ''));
    } catch {
      isActorDeny = false;
    }
    expect(isActorDeny, 'api_task_add_note was wrongly denied by the actor guard on an external turn').toBe(false);
  });

  // Codex C4b NICE: lock the whitelisted api_admin action through the REGISTERED
  // wrapper (not just the raw guard). accept_external_invite passes requiresChatActor
  // on an external turn and reaches the real handler; a non-whitelisted action denies.
  it('api_admin accept_external_invite PASSES the actor guard via the registered wrapper; register_person denies', async () => {
    const def = getRegisteredToolForTesting('api_admin');
    expect(def).toBeDefined();
    let acceptIsActorDeny = false;
    try {
      const body = parse(await def!.handler({ action: 'accept_external_invite', task_id: 'M1', sender_name: 'Maria' }));
      acceptIsActorDeny = body.error_code === 'permission_denied' && /authenticate/i.test(String(body.error ?? ''));
    } catch {
      acceptIsActorDeny = false; // reached the real handler, which errors for non-actor reasons
    }
    expect(acceptIsActorDeny, 'accept_external_invite was wrongly denied by the actor guard on an external turn').toBe(
      false,
    );
    const denied = parse(await def!.handler({ action: 'register_person', sender_name: 'Maria' }));
    expect(denied.error_code).toBe('permission_denied');
    expect(String(denied.error)).toMatch(/authenticate/i);
  });
});
