import { describe, expect, it } from 'bun:test';

import { emitMutationConfirmation } from './mutation-confirmation.ts';

// Restores the deterministic post-mutation confirmation that v1's
// poll-loop handlers emitted via writeReply and the v1→v2 MCP-tool port
// dropped (Phase-3 root cause, 2026-05-18). The card text is the engine's
// existing `formatted` summary — currently returned only as JSON to the
// LLM, never delivered to the user's conversation. Guarded so the
// standalone FastAPI MCP entrypoint (tf-mcontrol) — which has no session
// routing — is NOT turned into a WhatsApp reply emitter (Codex constraint).

const ROUTING = { channel_type: 'whatsapp', platform_id: '123@g.us', thread_id: null };
const NO_ROUTING = { channel_type: null, platform_id: null, thread_id: null };

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
});
