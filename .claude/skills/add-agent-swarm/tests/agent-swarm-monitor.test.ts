import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../add/src/agent-swarm.js', () => ({
  checkAgents: vi.fn(),
  readTaskRegistry: vi.fn(),
}));

describe('agent-swarm-monitor', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('detects ready-for-review tasks', async () => {
    const { checkAgents, readTaskRegistry } = await import('../add/src/agent-swarm.js');
    const { evaluateAgents } = await import('../add/src/agent-swarm-monitor.js');

    (readTaskRegistry as any).mockResolvedValue({
      tasks: [
        {
          id: 'feat-x',
          status: 'pr_created',
          retries: 0,
          maxRetries: 3,
        },
      ],
    });

    (checkAgents as any).mockResolvedValue([
      {
        id: 'feat-x',
        tmux_alive: false,
        pr_number: 42,
        ci_status: 'passing',
        review_status: 'approved',
        critical_comments: 0,
        has_screenshots: true,
      },
    ]);

    const actions = await evaluateAgents('dev@remote');
    expect(actions).toContainEqual(
      expect.objectContaining({
        taskId: 'feat-x',
        action: 'notify_ready',
        pr: 42,
      }),
    );
  });

  it('detects failed agents needing respawn', async () => {
    const { checkAgents, readTaskRegistry } = await import(
      '../add/src/agent-swarm.js'
    );
    const { evaluateAgents } = await import(
      '../add/src/agent-swarm-monitor.js'
    );

    (readTaskRegistry as any).mockResolvedValue({
      tasks: [
        {
          id: 'fix-y',
          status: 'running',
          retries: 0,
          maxRetries: 3,
        },
      ],
    });

    (checkAgents as any).mockResolvedValue([
      {
        id: 'fix-y',
        tmux_alive: false,
        pr_number: null,
        ci_status: null,
        review_status: null,
        critical_comments: 0,
        has_screenshots: false,
      },
    ]);

    const actions = await evaluateAgents('dev@remote');
    expect(actions).toContainEqual(
      expect.objectContaining({
        taskId: 'fix-y',
        action: 'respawn',
      }),
    );
  });

  it('does not respawn if retries exhausted', async () => {
    const { checkAgents, readTaskRegistry } = await import(
      '../add/src/agent-swarm.js'
    );
    const { evaluateAgents } = await import(
      '../add/src/agent-swarm-monitor.js'
    );

    (readTaskRegistry as any).mockResolvedValue({
      tasks: [
        {
          id: 'fix-z',
          status: 'running',
          retries: 3,
          maxRetries: 3,
        },
      ],
    });

    (checkAgents as any).mockResolvedValue([
      {
        id: 'fix-z',
        tmux_alive: false,
        pr_number: null,
        ci_status: null,
        review_status: null,
        critical_comments: 0,
        has_screenshots: false,
      },
    ]);

    const actions = await evaluateAgents('dev@remote');
    expect(actions).toContainEqual(
      expect.objectContaining({
        taskId: 'fix-z',
        action: 'notify_failed',
      }),
    );
  });

  it('triggers review when agent dies but PR exists', async () => {
    const { checkAgents, readTaskRegistry } = await import('../add/src/agent-swarm.js');
    const { evaluateAgents } = await import('../add/src/agent-swarm-monitor.js');

    (readTaskRegistry as any).mockResolvedValue({
      tasks: [{ id: 'feat-pr', status: 'running', retries: 0, maxRetries: 3 }],
    });
    (checkAgents as any).mockResolvedValue([
      { id: 'feat-pr', tmux_alive: false, pr_number: 55, ci_status: 'pending', review_status: 'pending', critical_comments: 0, has_screenshots: false },
    ]);

    const actions = await evaluateAgents('dev@remote');
    expect(actions).toContainEqual(
      expect.objectContaining({ taskId: 'feat-pr', action: 'trigger_review', pr: 55 }),
    );
  });

  it('respawns with CI fix when CI is failing', async () => {
    const { checkAgents, readTaskRegistry } = await import('../add/src/agent-swarm.js');
    const { evaluateAgents } = await import('../add/src/agent-swarm-monitor.js');

    (readTaskRegistry as any).mockResolvedValue({
      tasks: [{ id: 'feat-ci', status: 'pr_created', retries: 1, maxRetries: 3 }],
    });
    (checkAgents as any).mockResolvedValue([
      { id: 'feat-ci', tmux_alive: false, pr_number: 60, ci_status: 'failing', review_status: 'pending', critical_comments: 0, has_screenshots: false },
    ]);

    const actions = await evaluateAgents('dev@remote');
    expect(actions).toContainEqual(
      expect.objectContaining({ taskId: 'feat-ci', action: 'respawn_with_ci_fix', pr: 60 }),
    );
  });

  it('respawns with review fix on critical comments', async () => {
    const { checkAgents, readTaskRegistry } = await import('../add/src/agent-swarm.js');
    const { evaluateAgents } = await import('../add/src/agent-swarm-monitor.js');

    (readTaskRegistry as any).mockResolvedValue({
      tasks: [{ id: 'feat-rev', status: 'pr_created', retries: 0, maxRetries: 3 }],
    });
    (checkAgents as any).mockResolvedValue([
      { id: 'feat-rev', tmux_alive: false, pr_number: 70, ci_status: 'passing', review_status: 'changes_requested', critical_comments: 2, has_screenshots: false },
    ]);

    const actions = await evaluateAgents('dev@remote');
    expect(actions).toContainEqual(
      expect.objectContaining({ taskId: 'feat-rev', action: 'respawn_with_review_fix', pr: 70 }),
    );
  });

  it('produces no action for still-running agents without PR', async () => {
    const { checkAgents, readTaskRegistry } = await import('../add/src/agent-swarm.js');
    const { evaluateAgents } = await import('../add/src/agent-swarm-monitor.js');

    (readTaskRegistry as any).mockResolvedValue({
      tasks: [{ id: 'feat-run', status: 'running', retries: 0, maxRetries: 3 }],
    });
    (checkAgents as any).mockResolvedValue([
      { id: 'feat-run', tmux_alive: true, pr_number: null, ci_status: null, review_status: null, critical_comments: 0, has_screenshots: false },
    ]);

    const actions = await evaluateAgents('dev@remote');
    expect(actions).toHaveLength(0);
  });

  it('produces no action for still-running agents even with PR and failing CI', async () => {
    const { checkAgents, readTaskRegistry } = await import('../add/src/agent-swarm.js');
    const { evaluateAgents } = await import('../add/src/agent-swarm-monitor.js');

    (readTaskRegistry as any).mockResolvedValue({
      tasks: [{ id: 'feat-alive-ci', status: 'running', retries: 0, maxRetries: 3 }],
    });
    (checkAgents as any).mockResolvedValue([
      { id: 'feat-alive-ci', tmux_alive: true, pr_number: 80, ci_status: 'failing', review_status: 'pending', critical_comments: 0, has_screenshots: false },
    ]);

    // Agent is still running — should NOT trigger respawn_with_ci_fix
    const actions = await evaluateAgents('dev@remote');
    expect(actions).toHaveLength(0);
  });
});
