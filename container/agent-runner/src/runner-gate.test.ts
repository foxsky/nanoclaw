import { describe, expect, it } from 'bun:test';

import { decideRunnerGate } from './runner-gate.js';

// Mirror of the host runner-gate tests (src/modules/taskflow/runner-gate.test.ts) — the policy
// must stay byte-identical to the host's so a warm container gates exactly as the sweep would.
describe('decideRunnerGate (container mirror)', () => {
  const idle = { pending: false, interactions: false, dueToday: false, isMonday: false };
  const stale = { pending: true, interactions: false, dueToday: false, isMonday: false };
  const active = { pending: true, interactions: true, dueToday: false, isMonday: false };

  it('Idle: every runner silent', () => {
    for (const job of ['standup', 'digest', 'review'] as const) {
      expect(decideRunnerGate(job, idle).fire).toBe(false);
    }
  });

  it('Stale: standup on Monday or a due-day weekday; digest+review silent', () => {
    expect(decideRunnerGate('standup', { ...stale, isMonday: true }).fire).toBe(true);
    expect(decideRunnerGate('standup', { ...stale, dueToday: true }).fire).toBe(true);
    expect(decideRunnerGate('standup', stale).fire).toBe(false);
    expect(decideRunnerGate('digest', { ...stale, isMonday: true }).fire).toBe(false);
    expect(decideRunnerGate('review', { ...stale, isMonday: true }).fire).toBe(false);
  });

  it('Active: standup + review full; digest as resumo', () => {
    expect(decideRunnerGate('standup', active)).toEqual({ fire: true, summaryMode: false });
    expect(decideRunnerGate('review', active)).toEqual({ fire: true, summaryMode: false });
    expect(decideRunnerGate('digest', active)).toEqual({ fire: true, summaryMode: true });
  });
});
