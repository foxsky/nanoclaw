import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.ts';
import { emitDeterministicToolMessage, emitMutationConfirmation } from './mutation-confirmation.ts';
import { setVerbatimIds } from './taskflow-helpers.ts';
import {
  __resetDedupForTesting,
  consumeDeterministicMutationFlag,
} from './mutation-dedup.ts';

// Dedup state moved to SQLite (Codex P-Audit-2 cross-process fix) — the
// wiring tests now exercise the real session_state path via the in-mem
// outbound DB.
beforeEach(() => {
  initTestSessionDb();
  __resetDedupForTesting();
});
afterEach(() => {
  closeSessionDb();
});

// Restores the deterministic post-mutation confirmation that v1's
// poll-loop handlers emitted via writeReply and the v1→v2 MCP-tool port
// dropped (Phase-3 root cause, 2026-05-18). The card text is the engine's
// existing `formatted` summary — currently returned only as JSON to the
// LLM, never delivered to the user's conversation. Guarded so the
// standalone FastAPI MCP entrypoint (tf-mcontrol) — which has no session
// routing — is NOT turned into a WhatsApp reply emitter (Codex constraint).

const ROUTING = { channel_type: 'whatsapp', platform_id: '123@g.us', thread_id: null };
const NO_ROUTING = { channel_type: null, platform_id: null, thread_id: null };

describe('emitDeterministicToolMessage subprocess gate', () => {
  it('is a NO-OP in the FastAPI subprocess (verbatim ids) even when routing IS present', () => {
    // The tf-mcontrol FastAPI subprocess sets verbatim ids unconditionally. The
    // routing-absent gate fails OPEN if that subprocess can see a session_routing
    // row (shared /workspace) — it would emit a user-visible chat row. getVerbatimIds()
    // is the reliable subprocess signal, so the gate must honor it too (matches the
    // dispatchNotificationEvents + #396 enqueue/drain gates).
    setVerbatimIds(true);
    try {
      let emitted = false;
      emitDeterministicToolMessage('✅ card text', {
        getRouting: () => ROUTING,
        emit: () => {
          emitted = true;
        },
      });
      expect(emitted).toBe(false);
    } finally {
      setVerbatimIds(false);
    }
  });
});

describe('emitMutationConfirmation', () => {
  it('emits the engine formatted card to current-session routing on a successful mutation', () => {
    const emitted: Array<Record<string, unknown>> = [];
    emitMutationConfirmation(
      { success: true, formatted: '✅ *P11.23* atualizada\n━━━━━━━━━━━━━━\n• Prazo definido: 22/04' },
      { getRouting: () => ROUTING, emit: (m) => emitted.push(m) },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: 'chat',
      platform_id: '123@g.us',
      channel_type: 'whatsapp',
      thread_id: null,
    });
    expect(JSON.parse(emitted[0].content as string).text).toContain('P11.23');
  });

  it('does NOT emit when session routing is absent (tf-mcontrol FastAPI standalone guard)', () => {
    const emitted: unknown[] = [];
    emitMutationConfirmation(
      { success: true, formatted: '✅ done' },
      { getRouting: () => NO_ROUTING, emit: (m) => emitted.push(m) },
    );
    expect(emitted).toHaveLength(0);
  });

  it('does NOT emit on a failed mutation', () => {
    const emitted: unknown[] = [];
    emitMutationConfirmation(
      { success: false, formatted: 'irrelevant' },
      { getRouting: () => ROUTING, emit: (m) => emitted.push(m) },
    );
    expect(emitted).toHaveLength(0);
  });

  it('does NOT fabricate a confirmation when the engine returned no formatted summary', () => {
    const emitted: unknown[] = [];
    emitMutationConfirmation(
      { success: true },
      { getRouting: () => ROUTING, emit: (m) => emitted.push(m) },
    );
    expect(emitted).toHaveLength(0);
  });

  it('NEVER throws when routing lookup fails (no inbound DB in FastAPI/engine-only) — the mutation already succeeded', () => {
    const emitted: unknown[] = [];
    expect(() =>
      emitMutationConfirmation(
        { success: true, formatted: '✅ done' },
        {
          getRouting: () => {
            throw new Error('no inbound db (tf-mcontrol FastAPI standalone)');
          },
          emit: (m) => emitted.push(m),
        },
      ),
    ).not.toThrow();
    expect(emitted).toHaveLength(0);
  });

  it('NEVER throws when the emit sink itself fails', () => {
    expect(() =>
      emitMutationConfirmation(
        { success: true, formatted: '✅ done' },
        {
          getRouting: () => ROUTING,
          emit: () => {
            throw new Error('outbound write failed');
          },
        },
      ),
    ).not.toThrow();
  });

  it('LOGS (fail-loud) when a swallowed emission failure occurs — silent swallow blocked diagnosis of the reassign anomaly', () => {
    const errs: string[] = [];
    emitMutationConfirmation(
      { success: true, formatted: '✅ done' },
      {
        getRouting: () => ROUTING,
        emit: () => {
          throw new Error('outbound write failed');
        },
        onError: (msg) => errs.push(msg),
      },
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('outbound write failed');
  });

  it('does NOT log on the legitimate FastAPI/no-session guard path (not an error)', () => {
    const errs: string[] = [];
    emitMutationConfirmation(
      { success: true, formatted: '✅ done' },
      { getRouting: () => NO_ROUTING, emit: () => {}, onError: (msg) => errs.push(msg) },
    );
    expect(errs).toHaveLength(0);
  });

  it('marks the dedup flag on successful emission (Codex P4 — drives bare-text suppression)', () => {
    emitMutationConfirmation(
      { success: true, formatted: '✅ done' },
      { getRouting: () => ROUTING, emit: () => {} },
    );
    expect(consumeDeterministicMutationFlag()).toBe(true);
  });

  it('does NOT mark when the guard suppresses emission (FastAPI/no-session)', () => {
    emitMutationConfirmation(
      { success: true, formatted: '✅ done' },
      { getRouting: () => NO_ROUTING, emit: () => {} },
    );
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });

  it('does NOT mark on a failed mutation', () => {
    emitMutationConfirmation(
      { success: false, formatted: 'x' },
      { getRouting: () => ROUTING, emit: () => {} },
    );
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });

  it('does NOT mark when there is no formatted text to emit', () => {
    emitMutationConfirmation(
      { success: true },
      { getRouting: () => ROUTING, emit: () => {} },
    );
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });

  it('does NOT mark when emission throws (best-effort caught, no mark — false positive guard)', () => {
    emitMutationConfirmation(
      { success: true, formatted: '✅ done' },
      {
        getRouting: () => ROUTING,
        emit: () => {
          throw new Error('outbound write failed');
        },
        onError: () => {},
      },
    );
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });
});
