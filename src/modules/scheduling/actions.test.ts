/**
 * Inert core (ADR 0006 contract #5): with NO sanitizer registered, the scheduling
 * handlers persist the script verbatim. The board-strip behavior moved to the fork
 * overlay (`src/modules/taskflow/task-script-sanitizer.ts` + its test). This test
 * pins that pristine core never strips on its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js');
vi.mock('../../container-runner.js');

import type { Session } from '../../types.js';
import { handleScheduleTask } from './actions.js';
import { insertTask } from './db.js';

const session = { id: 's1', agent_group_id: 'ag1' } as Session;
const base = { taskId: 't1', prompt: 'do x', processAfter: '2026-06-15T00:00:00Z', script: 'echo hi' };

function scriptPersisted(): string | null {
  const arg = vi.mocked(insertTask).mock.calls[0][1] as { content: string };
  return JSON.parse(arg.content).script;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleScheduleTask script persistence (inert core)', () => {
  it('persists the script verbatim when no sanitizer is registered', async () => {
    await handleScheduleTask(base, session, {} as never);
    expect(scriptPersisted()).toBe('echo hi');
  });

  it('persists a null script as null', async () => {
    await handleScheduleTask({ ...base, script: null }, session, {} as never);
    expect(scriptPersisted()).toBeNull();
  });
});
