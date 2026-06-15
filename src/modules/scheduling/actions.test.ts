/**
 * L9 — host-side defense-in-depth: a TaskFlow board session must not persist a task `script`.
 * Non-board sessions still carry scripts; an unresolved agent group fails CLOSED (strips).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js');
vi.mock('../../db/agent-groups.js');
vi.mock('../../taskflow-db.js');
vi.mock('../../container-runner.js');

import { getAgentGroup } from '../../db/agent-groups.js';
import { resolveTaskflowBoardId } from '../../taskflow-db.js';
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
  vi.mocked(getAgentGroup).mockReturnValue({ id: 'ag1', folder: 'f1' } as ReturnType<typeof getAgentGroup>);
});

describe('stripBoardScript via handleScheduleTask (L9)', () => {
  it('strips the script for a TaskFlow board session', async () => {
    vi.mocked(resolveTaskflowBoardId).mockReturnValue('board-x');
    await handleScheduleTask(base, session, {} as never);
    expect(scriptPersisted()).toBeNull();
  });

  it('keeps the script for a non-board session', async () => {
    vi.mocked(resolveTaskflowBoardId).mockReturnValue(undefined);
    await handleScheduleTask(base, session, {} as never);
    expect(scriptPersisted()).toBe('echo hi');
  });

  it('fails CLOSED (strips) when the agent group cannot be resolved', async () => {
    vi.mocked(getAgentGroup).mockReturnValue(undefined as ReturnType<typeof getAgentGroup>);
    vi.mocked(resolveTaskflowBoardId).mockReturnValue(undefined);
    await handleScheduleTask(base, session, {} as never);
    expect(scriptPersisted()).toBeNull();
  });

  it('leaves a null script untouched (no board lookup needed)', async () => {
    await handleScheduleTask({ ...base, script: null }, session, {} as never);
    expect(scriptPersisted()).toBeNull();
    expect(resolveTaskflowBoardId).not.toHaveBeenCalled();
  });
});
