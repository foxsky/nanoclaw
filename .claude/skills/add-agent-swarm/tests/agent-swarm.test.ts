import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'child_process';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

function mockSshSuccess(stdout: string) {
  const proc = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
  (spawn as any).mockReturnValue(proc);

  // Call handlers after mock is set up
  setTimeout(() => {
    const dataHandler = proc.stdout.on.mock.calls[0]?.[1];
    if (dataHandler) dataHandler(Buffer.from(stdout));
    const closeHandler = proc.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
    if (closeHandler) closeHandler(0);
  }, 0);

  return proc;
}

function mockSshFailure(stderr: string, code: number) {
  const proc = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
  (spawn as any).mockReturnValue(proc);

  setTimeout(() => {
    const errHandler = proc.stderr.on.mock.calls[0]?.[1];
    if (errHandler) errHandler(Buffer.from(stderr));
    const closeHandler = proc.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
    if (closeHandler) closeHandler(code);
  }, 0);

  return proc;
}

describe('agent-swarm SSH bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('executes a remote script via SSH with args', async () => {
    const { executeRemoteScript } = await import('../add/src/agent-swarm.js');
    mockSshSuccess('spawned\n');

    const result = await executeRemoteScript(
      'dev@remote',
      '~/.agent-swarm/spawn-agent.sh',
      ['project-a', 'feat/x', 'codex', 'feat-x'],
    );

    expect(result).toBe('spawned\n');
    expect(spawn).toHaveBeenCalledWith(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        'dev@remote',
        '~/.agent-swarm/spawn-agent.sh',
        'project-a', 'feat/x', 'codex', 'feat-x',
      ],
      expect.any(Object),
    );
  });

  it('rejects on SSH failure', async () => {
    const { executeRemoteScript } = await import('../add/src/agent-swarm.js');
    mockSshFailure('command not found', 1);

    await expect(
      executeRemoteScript('dev@remote', 'bad-script.sh', []),
    ).rejects.toThrow('SSH command failed');
  });

  it('validates script path contains no shell metacharacters', async () => {
    const { executeRemoteScript } = await import('../add/src/agent-swarm.js');
    await expect(
      executeRemoteScript('dev@remote', '~/.agent-swarm/spawn.sh; rm -rf /', []),
    ).rejects.toThrow('rejected');
  });

  it('validates args contain no shell metacharacters', async () => {
    const { executeRemoteScript } = await import('../add/src/agent-swarm.js');
    await expect(
      executeRemoteScript('dev@remote', '~/.agent-swarm/spawn.sh', ['arg1; rm -rf /']),
    ).rejects.toThrow('rejected');
  });

  it('reads task registry from remote', async () => {
    const { readTaskRegistry } = await import('../add/src/agent-swarm.js');
    mockSshSuccess(
      JSON.stringify({
        tasks: [{ id: 'feat-x', status: 'running', repo: 'project-a', branch: 'feat/x' }],
      }),
    );

    const registry = await readTaskRegistry('dev@remote');
    expect(registry.tasks).toHaveLength(1);
    expect(registry.tasks[0].id).toBe('feat-x');
  });

  it('rejects invalid task registry JSON', async () => {
    const { readTaskRegistry } = await import('../add/src/agent-swarm.js');
    mockSshSuccess('not valid json');

    await expect(readTaskRegistry('dev@remote')).rejects.toThrow('Invalid task registry');
  });

  it('rejects read paths outside ~/.agent-swarm/', async () => {
    const { executeRemoteRead } = await import('../add/src/agent-swarm.js');
    await expect(
      executeRemoteRead('dev@remote', '/etc/passwd'),
    ).rejects.toThrow('Read path rejected');
  });

  it('rejects read paths with directory traversal', async () => {
    const { executeRemoteRead } = await import('../add/src/agent-swarm.js');
    await expect(
      executeRemoteRead('dev@remote', '~/.agent-swarm/../../etc/passwd'),
    ).rejects.toThrow('Read path rejected');
  });

  it('writes prompt to remote file via write-prompt.sh script', async () => {
    const { writePromptFile } = await import('../add/src/agent-swarm.js');
    const proc = mockSshSuccess('');

    await writePromptFile('dev@remote', 'task-123', "Don't forget to test it's working");
    expect(spawn).toHaveBeenCalledWith(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        'dev@remote',
        '~/.agent-swarm/write-prompt.sh', 'task-123',
      ],
      expect.any(Object),
    );
    expect(proc.stdin.write).toHaveBeenCalledWith("Don't forget to test it's working");
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it('rejects task IDs with directory traversal when writing prompt files', async () => {
    const { writePromptFile } = await import('../add/src/agent-swarm.js');
    await expect(
      writePromptFile('dev@remote', '../escape', 'oops'),
    ).rejects.toThrow('Task ID rejected');
  });

  it('updates task status via remote script', async () => {
    const { updateTaskStatus } = await import('../add/src/agent-swarm.js');
    mockSshSuccess('');

    await updateTaskStatus('dev@remote', 'task-123', 'ready_for_review');
    expect(spawn).toHaveBeenCalledWith(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        'dev@remote',
        '~/.agent-swarm/update-task-status.sh',
        'task-123',
        'ready_for_review',
      ],
      expect.any(Object),
    );
  });

  it('runs remote cleanup script', async () => {
    const { runCleanup } = await import('../add/src/agent-swarm.js');
    mockSshSuccess('Cleanup complete\n');

    await runCleanup('dev@remote');
    expect(spawn).toHaveBeenCalledWith(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        'dev@remote',
        '~/.agent-swarm/cleanup-worktrees.sh',
      ],
      expect.any(Object),
    );
  });
});
