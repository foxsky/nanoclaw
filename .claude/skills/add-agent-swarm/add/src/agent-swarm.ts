import { spawn } from 'child_process';

// --- Types ---

export interface SwarmTask {
  id: string;
  repo: string;
  branch: string;
  worktree: string;
  tmuxSession: string;
  model: string;
  promptFile: string;
  status:
    | 'running'
    | 'pr_created'
    | 'reviewing'
    | 'ready_for_review'
    | 'merged'
    | 'failed';
  priority: 'high' | 'normal' | 'low';
  startedAt: number;
  retries: number;
  maxRetries: number;
  pr: number | null;
  checks: {
    ciPassed: boolean;
    codexReviewPassed: boolean;
    claudeReviewPassed: boolean;
    geminiReviewPassed: boolean;
    screenshotsIncluded: boolean;
  };
  completedAt: number | null;
  notifyOnComplete: boolean;
}

export interface TaskRegistry {
  tasks: SwarmTask[];
}

export interface AgentStatus {
  id: string;
  tmux_alive: boolean;
  pr_number: number | null;
  ci_status: 'pending' | 'passing' | 'failing' | null;
  review_status: 'pending' | 'approved' | 'changes_requested' | null;
  critical_comments: number;
  has_screenshots: boolean;
}

// --- SSH execution ---

const SSH_TIMEOUT_MS = 30_000;

// SECURITY: Only allow safe characters in script paths and args.
// This is a structural allowlist — no shell metacharacters can pass through.
const SAFE_PATH = /^[a-zA-Z0-9_\-./~@]+$/;
// NOTE: No spaces — SSH concatenates positional args into one string for the
// remote shell, so spaces would cause word-splitting on the remote side.
// Includes `/` and `.` for branch names and filesystem paths.
const SAFE_ARG = /^[a-zA-Z0-9_\-./~@:=,]+$/;
// Task IDs are embedded into fixed remote file paths — forbid `/` and `.` to
// prevent directory traversal when constructing prompt/log filenames.
const SAFE_TASK_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Execute a pre-deployed script on the remote machine with positional arguments.
 * Arguments are passed as separate SSH parameters — no shell string construction.
 * For reading files, use executeRemoteRead instead.
 */
export function executeRemoteScript(
  sshTarget: string,
  scriptPath: string,
  args: string[] = [],
  timeoutMs: number = SSH_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!SAFE_PATH.test(scriptPath)) {
      reject(new Error(`Script path rejected: contains unsafe characters`));
      return;
    }
    for (const arg of args) {
      if (!SAFE_ARG.test(arg)) {
        reject(new Error(`Argument rejected: contains unsafe characters: ${arg.slice(0, 50)}`));
        return;
      }
    }

    const sshArgs = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      sshTarget,
      scriptPath,
      ...args,
    ];

    const ssh = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    ssh.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    ssh.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      ssh.kill('SIGTERM');
      reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ssh.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`SSH command failed (exit ${code}): ${stderr || stdout}`));
      }
    });

    ssh.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`SSH spawn error: ${err.message}`));
    });
  });
}

/**
 * Read a file from the remote machine. Only allows reading from ~/.agent-swarm/.
 * Supports 'cat' (default) and 'tail' commands for reading full files or last N lines.
 */
export function executeRemoteRead(
  sshTarget: string,
  filePath: string,
  options: { command?: 'cat' | 'tail'; lines?: number; gracefulMissing?: boolean } = {},
  timeoutMs: number = SSH_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!filePath.startsWith('~/.agent-swarm/') || filePath.includes('..')) {
      reject(new Error(`Read path rejected: must be under ~/.agent-swarm/`));
      return;
    }
    if (!SAFE_PATH.test(filePath)) {
      reject(new Error(`Read path rejected: contains unsafe characters`));
      return;
    }

    const cmd = options.command ?? 'cat';
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshTarget];
    if (cmd === 'tail') {
      sshArgs.push('tail', '-n', String(Math.min(options.lines ?? 100, 10_000)), filePath);
    } else {
      sshArgs.push('cat', filePath);
    }

    const ssh = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    ssh.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    ssh.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      ssh.kill('SIGTERM');
      reject(new Error(`SSH read timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ssh.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else if (options.gracefulMissing) {
        resolve(`No file found: ${filePath}`);
      } else {
        reject(new Error(`SSH read failed (exit ${code}): ${stderr}`));
      }
    });

    ssh.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`SSH spawn error: ${err.message}`));
    });
  });
}

/**
 * Write a prompt to a file on the remote machine via stdin.
 * Uses the pre-deployed write-prompt.sh script which reads stdin and writes
 * to ~/.agent-swarm/prompts/<taskId>.txt. The prompt content never passes
 * through shell interpretation — it's piped via SSH stdin.
 */
export function writePromptFile(
  sshTarget: string,
  taskId: string,
  prompt: string,
  timeoutMs: number = SSH_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!SAFE_TASK_ID.test(taskId)) {
      reject(new Error(`Task ID rejected: contains unsafe characters`));
      return;
    }

    const ssh = spawn(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        sshTarget,
        '~/.agent-swarm/write-prompt.sh', taskId,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stderr = '';
    ssh.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      ssh.kill('SIGTERM');
      reject(new Error(`SSH write timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ssh.stdin.write(prompt);
    ssh.stdin.end();

    ssh.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`SSH write failed (exit ${code}): ${stderr}`));
    });

    ssh.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`SSH spawn error: ${err.message}`));
    });
  });
}

/**
 * Read the last N lines of an agent's log file.
 * Routes through executeRemoteRead with tail command.
 */
export function readAgentLog(
  sshTarget: string,
  taskId: string,
  lines: number = 100,
  timeoutMs: number = SSH_TIMEOUT_MS,
): Promise<string> {
  if (!SAFE_TASK_ID.test(taskId)) {
    return Promise.reject(new Error(`Task ID rejected: contains unsafe characters`));
  }
  return executeRemoteRead(
    sshTarget,
    `~/.agent-swarm/logs/${taskId}.log`,
    { command: 'tail', lines, gracefulMissing: true },
    timeoutMs,
  );
}

// --- Task registry ---

export async function readTaskRegistry(sshTarget: string): Promise<TaskRegistry> {
  const raw = await executeRemoteRead(sshTarget, '~/.agent-swarm/active-tasks.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid task registry: not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as TaskRegistry).tasks)) {
    throw new Error('Invalid task registry: missing tasks array');
  }
  return parsed as TaskRegistry;
}

// --- Agent operations ---

export async function spawnAgent(
  sshTarget: string,
  opts: {
    repo: string;
    repoPath: string;
    branchName: string;
    prompt: string;
    model: string;
    priority?: 'high' | 'normal' | 'low';
  },
): Promise<string> {
  const taskId = opts.branchName.replace(/[^a-zA-Z0-9_-]/g, '-');

  // Write prompt to file on remote (avoids shell quoting entirely)
  await writePromptFile(sshTarget, taskId, opts.prompt);

  // Spawn via pre-deployed script with positional args
  const priority = opts.priority ?? 'normal';
  await executeRemoteScript(
    sshTarget,
    '~/.agent-swarm/spawn-agent.sh',
    [opts.repoPath, opts.branchName, opts.model, taskId, priority],
    120_000, // 2 min for install
  );

  return taskId;
}

export async function checkAgents(sshTarget: string): Promise<AgentStatus[]> {
  const raw = await executeRemoteScript(
    sshTarget,
    '~/.agent-swarm/check-agents.sh',
    [],
    60_000, // 60s — may have many gh API calls
  );
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid check-agents output: not valid JSON');
  }
}

export async function redirectAgent(
  sshTarget: string,
  taskId: string,
  message: string,
): Promise<void> {
  // Write message to file, then have redirect script read from it
  await writePromptFile(sshTarget, `redirect-${taskId}`, message);
  await executeRemoteScript(
    sshTarget,
    '~/.agent-swarm/redirect-agent.sh',
    [taskId],
  );
}

export async function killAgent(
  sshTarget: string,
  taskId: string,
  cleanup: boolean = false,
): Promise<void> {
  await executeRemoteScript(
    sshTarget,
    '~/.agent-swarm/kill-agent.sh',
    [taskId, cleanup ? 'cleanup' : 'keep'],
  );
}

export async function runReview(
  sshTarget: string,
  taskId: string,
): Promise<void> {
  await executeRemoteScript(
    sshTarget,
    '~/.agent-swarm/review-pr.sh',
    [taskId],
    300_000, // 5 min for reviews
  );
}

export async function updateTaskStatus(
  sshTarget: string,
  taskId: string,
  status: SwarmTask['status'],
): Promise<void> {
  if (!SAFE_TASK_ID.test(taskId)) {
    throw new Error(`Task ID rejected: contains unsafe characters`);
  }
  await executeRemoteScript(
    sshTarget,
    '~/.agent-swarm/update-task-status.sh',
    [taskId, status],
  );
}

export async function runCleanup(sshTarget: string): Promise<void> {
  await executeRemoteScript(
    sshTarget,
    '~/.agent-swarm/cleanup-worktrees.sh',
    [],
    120_000,
  );
}
