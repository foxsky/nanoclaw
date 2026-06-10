import { existsSync, rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'bun:test';

import { applyPreTaskScripts } from './task-script.js';
import type { MessageInRow } from '../db/messages-in.js';

const MARKER = '/tmp/SEC11_should_never_exist';

// SEC#11 round 3 (Codex residual): a pre-agent `script` is a bash shell-exec primitive. On a TaskFlow
// board it must NEVER run — this is the authoritative EXECUTION chokepoint that neutralises any scripted
// task (legacy, or one a board agent re-times/resumes) regardless of how it got scheduled. Board
// scheduled tasks are prompt-only, so skipping a scripted task drops nothing legitimate.

const SAVED = process.env.NANOCLAW_TASKFLOW_BOARD_ID;
afterEach(() => {
  if (SAVED === undefined) delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
  else process.env.NANOCLAW_TASKFLOW_BOARD_ID = SAVED;
  rmSync(MARKER, { force: true });
});

function taskRow(id: string, content: Record<string, unknown>): MessageInRow {
  return { id, kind: 'task', content: JSON.stringify(content) } as MessageInRow;
}

describe('applyPreTaskScripts board script chokepoint', () => {
  it('SKIPS a scripted task on a board session WITHOUT executing the script', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'b1';
    // If the skip failed, runScript would write+bash-exec this — the marker proves it never ran by the
    // task landing in `skipped` (pre-exec) and never in `keep`.
    const out = await applyPreTaskScripts([taskRow('t-evil', { prompt: 'x', script: `touch ${MARKER}` })]);
    expect(out.skipped).toEqual(['t-evil']);
    expect(out.keep).toEqual([]);
    expect(existsSync(MARKER)).toBe(false); // the bash side effect never happened

  });

  it('passes through a NON-scripted board task unchanged', async () => {
    process.env.NANOCLAW_TASKFLOW_BOARD_ID = 'b1';
    const row = taskRow('t-ok', { prompt: 'standup', script: null });
    const out = await applyPreTaskScripts([row]);
    expect(out.skipped).toEqual([]);
    expect(out.keep).toHaveLength(1);
  });

  it('does not gate non-board agents (a non-scripted task still passes through)', async () => {
    delete process.env.NANOCLAW_TASKFLOW_BOARD_ID;
    const out = await applyPreTaskScripts([taskRow('t-plain', { prompt: 'hello' })]);
    expect(out.keep).toHaveLength(1);
    expect(out.skipped).toEqual([]);
  });
});
