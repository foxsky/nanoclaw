import { describe, expect, it } from 'vitest';

import { decideRunnerGate } from './runner-gate.js';

// The policy the gate enforces (per board, recomputed at each fire). Tier is decided by
// interactions first: any interaction => Active (regardless of pending); else pending => Stale;
// else Idle. The point is to kill the bot-like burst WhatsApp flagged — idle/quiet boards go
// (near-)silent, active boards keep their cadence but the evening digest shrinks to a resumo.
describe('decideRunnerGate', () => {
  const idle = { pending: false, interactions: false, dueToday: false, isMonday: false };
  const stale = { pending: true, interactions: false, dueToday: false, isMonday: false };
  const active = { pending: true, interactions: true, dueToday: false, isMonday: false };

  it('Idle board: every runner is silent — nothing pending and nobody active', () => {
    for (const job of ['standup', 'digest', 'review'] as const) {
      expect(decideRunnerGate(job, idle).fire).toBe(false);
    }
  });

  it('Stale board: standup fires on Monday only (one message that week), digest+review silent', () => {
    expect(decideRunnerGate('standup', { ...stale, isMonday: true }).fire).toBe(true);
    expect(decideRunnerGate('standup', { ...stale, isMonday: false }).fire).toBe(false);
    expect(decideRunnerGate('digest', { ...stale, isMonday: true }).fire).toBe(false);
    expect(decideRunnerGate('review', { ...stale, isMonday: true }).fire).toBe(false);
  });

  it('Stale board: standup also fires on a weekday when a task is due that day', () => {
    // dueToday is the caller-computed "a task is due today AND today is a weekday" signal;
    // weekend due dates resolve to false upstream, so no special weekend standup.
    expect(decideRunnerGate('standup', { ...stale, isMonday: false, dueToday: true }).fire).toBe(true);
    expect(decideRunnerGate('standup', { ...stale, isMonday: false, dueToday: false }).fire).toBe(false);
  });

  it('Active board: standup daily and review Friday are unchanged (full, no resumo)', () => {
    expect(decideRunnerGate('standup', active)).toEqual({ fire: true, summaryMode: false });
    expect(decideRunnerGate('review', active)).toEqual({ fire: true, summaryMode: false });
  });

  it('Active board: digest fires daily but trimmed to a resumo (summaryMode)', () => {
    expect(decideRunnerGate('digest', active)).toEqual({ fire: true, summaryMode: true });
  });

  it('interactions alone make a board Active even with nothing pending (someone chatted)', () => {
    const chattedNoTasks = { pending: false, interactions: true, dueToday: false, isMonday: false };
    expect(decideRunnerGate('standup', chattedNoTasks).fire).toBe(true);
    expect(decideRunnerGate('digest', chattedNoTasks)).toEqual({ fire: true, summaryMode: true });
  });
});
