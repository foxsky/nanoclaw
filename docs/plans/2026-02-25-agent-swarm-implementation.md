# Agent Swarm Implementation Plan

> **For implementer:** Execute this plan task-by-task with a test-first workflow (write failing test -> implement -> pass tests).

**Goal:** Create the `/add-agent-swarm` NanoClaw skill — an orchestrator that spawns and monitors Claude Code / Codex coding agents on a remote machine via SSH, with automated PR review (including Gemini Code Assist signals) and WhatsApp notifications.

**Architecture:** Follows the manifest-based skill pattern. Adds `src/agent-swarm.ts` (SSH bridge + task registry), `src/agent-swarm-monitor.ts` (monitor loop), remote shell scripts, and modifies `src/ipc.ts` + `container/agent-runner/src/ipc-mcp-stdio.ts` to register new MCP tools. The orchestrator group's agent calls MCP tools → IPC files → host processes SSH commands → remote machine manages tmux/worktrees.

**Tech Stack:** TypeScript, Node.js `child_process.spawn` for SSH, shell scripts on remote, `gh` CLI for PR/CI checks.

**Design Doc:** `docs/plans/2026-02-25-agent-swarm-design.md`

**Key Design Decisions (from review):**
- **SSH execution uses script path + args array** — never freeform command strings. This eliminates shell injection entirely. `executeRemoteScript(target, scriptPath, args[])` passes each argument as a separate SSH positional parameter. Prompt writing uses `write-prompt.sh` with stdin piping.
- **Simple reads use `executeRemoteRead`** — a restricted variant for `cat` and `tail` only, with path validation. `readAgentLog` routes through `executeRemoteRead` with `tail` command.
- **IPC responses use poll-and-wait** — MCP tools write a request with a unique ID, then poll for a response file. The host writes the response to the IPC directory after SSH completes. This is a new NanoClaw pattern.
- **Prompts are file-based** — agent prompts are written to a temp file on the remote machine, not embedded in shell strings. `spawn-agent.sh` reads from the file.
- **Gemini coding CLI deferred** — the design doc lists `gemini` as "design specs -> Gemini -> Claude Code" (two-step workflow), not a standalone coding CLI. No gemini coding CLI exists comparable to Claude Code or Codex. Gemini Code Assist is a GitHub App for reviews (no script needed). Gemini can be added to the model enum when a CLI becomes available.
- **Repo routing source-of-truth is host env** — `SWARM_REPOS_JSON` in NanoClaw `.env` maps repo names to remote paths. `~/.agent-swarm/config.yaml` is optional human-readable reference only.

---

### Task 1: SSH bridge module

**Files:**
- Create: `.claude/skills/add-agent-swarm/add/src/agent-swarm.ts`
- Test: `.claude/skills/add-agent-swarm/tests/agent-swarm.test.ts`

**Step 1: Write the failing test**

Create `.claude/skills/add-agent-swarm/tests/agent-swarm.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --config .claude/skills/vitest.config.ts .claude/skills/add-agent-swarm/tests/agent-swarm.test.ts`
Expected: FAIL — module not found

**Step 3: Write the SSH bridge module**

Create `.claude/skills/add-agent-swarm/add/src/agent-swarm.ts`:

```typescript
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run --config .claude/skills/vitest.config.ts .claude/skills/add-agent-swarm/tests/agent-swarm.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-agent-swarm/
git commit -m "feat: add SSH bridge module for /add-agent-swarm skill"
```

---

### Task 2: Remote shell scripts

**Files:**
- Create: `.claude/skills/add-agent-swarm/remote/spawn-agent.sh`
- Create: `.claude/skills/add-agent-swarm/remote/run-agent.sh`
- Create: `.claude/skills/add-agent-swarm/remote/write-prompt.sh`
- Create: `.claude/skills/add-agent-swarm/remote/check-agents.sh`
- Create: `.claude/skills/add-agent-swarm/remote/redirect-agent.sh`
- Create: `.claude/skills/add-agent-swarm/remote/kill-agent.sh`
- Create: `.claude/skills/add-agent-swarm/remote/update-task-status.sh`
- Create: `.claude/skills/add-agent-swarm/remote/review-pr.sh`
- Create: `.claude/skills/add-agent-swarm/remote/cleanup-worktrees.sh`
- Create (optional reference): `.claude/skills/add-agent-swarm/remote/config.yaml.template`
- Create: `.claude/skills/add-agent-swarm/remote/setup-remote.sh`

These scripts run on the remote dev machine, not in NanoClaw.

**Step 1: Create `spawn-agent.sh`**

Key design: prompt is read from `~/.agent-swarm/prompts/$TASK_ID.txt` (written by `writePromptFile` over stdin), never passed as a shell argument.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: spawn-agent.sh <repo_path> <branch_name> <model> <task_id> <priority>
# Prompt is read from ~/.agent-swarm/prompts/$TASK_ID.txt

REPO_PATH="$1"
BRANCH_NAME="$2"
MODEL="$3"
TASK_ID="$4"
PRIORITY="${5:-normal}"

SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"
LOG_DIR="$SWARM_DIR/logs"
PROMPT_FILE="$SWARM_DIR/prompts/$TASK_ID.txt"

source "$SWARM_DIR/.env"

mkdir -p "$LOG_DIR" "$SWARM_DIR/prompts"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

# Create worktree
WORKTREE_DIR="$REPO_PATH/.worktrees/$TASK_ID"
cd "$REPO_PATH"
git fetch origin main
git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" origin/main 2>/dev/null || \
  git worktree add "$WORKTREE_DIR" "$BRANCH_NAME"

# Install deps
cd "$WORKTREE_DIR"

# Install deps — auto-detect package manager (Node.js or Python)
if [ -f "pnpm-lock.yaml" ]; then
  pnpm install --frozen-lockfile
elif [ -f "package-lock.json" ]; then
  npm ci
elif [ -f "yarn.lock" ]; then
  yarn install --frozen-lockfile
elif [ -f "pyproject.toml" ]; then
  if command -v poetry >/dev/null 2>&1; then
    poetry install --no-interaction
  elif command -v uv >/dev/null 2>&1; then
    uv sync
  else
    pip install -e ".[dev]" 2>/dev/null || pip install -e .
  fi
elif [ -f "requirements.txt" ]; then
  pip install -r requirements.txt
elif [ -f "Pipfile" ]; then
  pipenv install --dev
fi

# Launch in tmux via run-agent.sh wrapper (reads prompt from file safely).
# SAFETY: $MODEL and $PROMPT_FILE are safe to embed here because the host-side
# SAFE_ARG / SAFE_TASK_ID regexes guarantee no shell metacharacters (no quotes,
# backticks, spaces, or $) can reach this point.
tmux new-session -d -s "agent-$TASK_ID" \
  -c "$WORKTREE_DIR" \
  "source $SWARM_DIR/.env; $SWARM_DIR/run-agent.sh '$MODEL' '$PROMPT_FILE' 2>&1 | tee $LOG_DIR/$TASK_ID.log; echo '=== AGENT EXITED ===' >> $LOG_DIR/$TASK_ID.log"

# Update registry
if [ ! -f "$REGISTRY" ]; then
  echo '{"tasks":[]}' > "$REGISTRY"
fi

jq --arg id "$TASK_ID" \
   --arg repo "$(basename "$REPO_PATH")" \
   --arg branch "$BRANCH_NAME" \
   --arg worktree "$WORKTREE_DIR" \
   --arg model "$MODEL" \
   --arg promptFile "$PROMPT_FILE" \
   --arg started "$(date +%s)000" \
   --arg priority "$PRIORITY" \
   '.tasks += [{
     id: $id,
     repo: $repo,
     branch: $branch,
     worktree: $worktree,
     tmuxSession: ("agent-" + $id),
     model: $model,
     promptFile: $promptFile,
     status: "running",
     priority: $priority,
     startedAt: ($started | tonumber),
     retries: 0,
     maxRetries: 3,
     pr: null,
     checks: {ciPassed:false, codexReviewPassed:false, claudeReviewPassed:false, geminiReviewPassed:false, screenshotsIncluded:false},
     completedAt: null,
     notifyOnComplete: true
   }]' "$REGISTRY" > "$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"

echo "Spawned agent-$TASK_ID in $WORKTREE_DIR"
```

**Step 2: Create `run-agent.sh`**

Wrapper that reads the prompt from a file and execs the agent CLI. This avoids shell interpretation of prompt contents entirely — no quoting issues with `$`, backticks, or double quotes in prompts.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: run-agent.sh <model> <prompt_file>
# Reads prompt from file, execs the appropriate agent CLI.
# Called from tmux session created by spawn-agent.sh.

MODEL="$1"
PROMPT_FILE="$2"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

PROMPT=$(cat "$PROMPT_FILE")

case "$MODEL" in
  claude-code:opus)
    exec claude --model claude-opus-4-6 --dangerously-skip-permissions -p "$PROMPT"
    ;;
  claude-code:sonnet)
    exec claude --model claude-sonnet-4-6 --dangerously-skip-permissions -p "$PROMPT"
    ;;
  claude-code:haiku)
    exec claude --model claude-haiku-4-5-20251001 --dangerously-skip-permissions -p "$PROMPT"
    ;;
  codex)
    exec codex --model gpt-5.3-codex -c 'model_reasoning_effort=high' --dangerously-bypass-approvals-and-sandbox "$PROMPT"
    ;;
  *)
    echo "Unknown model: $MODEL" >&2
    exit 1
    ;;
esac
```

**Step 3: Create `write-prompt.sh`**

Reads prompt content from stdin and writes to a file. This eliminates the `cat > path` shell command exception — the host calls `executeRemoteScript` with this script instead.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: write-prompt.sh <task_id>
# Reads prompt content from stdin, writes to ~/.agent-swarm/prompts/<task_id>.txt

TASK_ID="$1"
SWARM_DIR="$HOME/.agent-swarm"
PROMPT_FILE="$SWARM_DIR/prompts/$TASK_ID.txt"

mkdir -p "$SWARM_DIR/prompts"
cat > "$PROMPT_FILE"
```

**Step 4: Create `check-agents.sh`**

Key design: per-task processing wrapped with `|| true` so one bad task doesn't kill the entire check. Uses `gh repo view` to resolve owner/repo instead of literal placeholder.

```bash
#!/usr/bin/env bash
set -uo pipefail
# NOTE: deliberately NOT set -e — individual task failures must not kill the loop

SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"

if [ ! -f "$REGISTRY" ]; then
  echo "[]"
  exit 0
fi

process_task() {
  local task="$1"
  local TASK_ID BRANCH WORKTREE TMUX_ALIVE PR_NUM CI_STATUS REVIEW_STATUS CRITICAL HAS_SCREENSHOTS

  TASK_ID=$(echo "$task" | jq -r '.id')
  BRANCH=$(echo "$task" | jq -r '.branch')
  WORKTREE=$(echo "$task" | jq -r '.worktree')

  # Check tmux session
  TMUX_ALIVE=false
  if tmux has-session -t "agent-$TASK_ID" 2>/dev/null; then
    TMUX_ALIVE=true
  fi

  # Defaults
  PR_NUM="null"
  CI_STATUS="null"
  REVIEW_STATUS="null"
  CRITICAL=0
  HAS_SCREENSHOTS=false

  if [ -d "$WORKTREE" ]; then
    local saved_dir
    saved_dir=$(pwd)
    cd "$WORKTREE" || return

    local pr_raw
    pr_raw=$(gh pr view "$BRANCH" --json number -q .number 2>/dev/null || echo "")

    if [ -n "$pr_raw" ]; then
      PR_NUM="$pr_raw"

      # Check CI
      local ci_raw
      ci_raw=$(gh pr checks "$pr_raw" --json state -q '.[].state' 2>/dev/null | sort -u || echo "")
      if echo "$ci_raw" | grep -q "FAILURE"; then
        CI_STATUS='"failing"'
      elif echo "$ci_raw" | grep -q "SUCCESS"; then
        CI_STATUS='"passing"'
      elif [ -n "$ci_raw" ]; then
        CI_STATUS='"pending"'
      fi

      # Check reviews
      local review_raw
      review_raw=$(gh pr view "$pr_raw" --json reviewDecision -q .reviewDecision 2>/dev/null || echo "")
      case "$review_raw" in
        APPROVED) REVIEW_STATUS='"approved"' ;;
        CHANGES_REQUESTED) REVIEW_STATUS='"changes_requested"' ;;
        *) REVIEW_STATUS='"pending"' ;;
      esac

      # Count critical comments — resolve owner/repo from git context
      local owner_repo
      owner_repo=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
      if [ -n "$owner_repo" ]; then
        CRITICAL=$(gh api "repos/$owner_repo/pulls/$pr_raw/comments" \
          --jq '[.[] | select(.body | test("critical|blocker"; "i"))] | length' 2>/dev/null || echo "0")
      fi

      # Check for screenshots in PR body
      if gh pr view "$pr_raw" --json body -q '.body' 2>/dev/null | grep -q '!\['; then
        HAS_SCREENSHOTS=true
      fi
    fi
    cd "$saved_dir" 2>/dev/null || true
  fi

  jq -n \
    --arg id "$TASK_ID" \
    --argjson tmux "$TMUX_ALIVE" \
    --argjson pr "$PR_NUM" \
    --argjson ci "$CI_STATUS" \
    --argjson review "$REVIEW_STATUS" \
    --argjson critical "$CRITICAL" \
    --argjson screenshots "$HAS_SCREENSHOTS" \
    '{id:$id, tmux_alive:$tmux, pr_number:$pr, ci_status:$ci, review_status:$review, critical_comments:$critical, has_screenshots:$screenshots}'
}

# Buffer process_task output to avoid emitting partial JSON on failure
jq -c '.tasks[] | select(.status != "merged" and .status != "failed")' "$REGISTRY" | while IFS= read -r task; do
  result=$(process_task "$task" 2>/dev/null) && echo "$result" || true
done | jq -s '.'
```

**Step 5: Create `redirect-agent.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: redirect-agent.sh <task_id>
# Message is read from ~/.agent-swarm/prompts/redirect-<task_id>.txt

TASK_ID="$1"
SWARM_DIR="$HOME/.agent-swarm"
MSG_FILE="$SWARM_DIR/prompts/redirect-$TASK_ID.txt"

if [ ! -f "$MSG_FILE" ]; then
  echo "ERROR: Message file not found: $MSG_FILE" >&2
  exit 1
fi

# Use load-buffer + paste-buffer instead of send-keys to safely handle
# arbitrary message content (avoids tmux escape sequence interpretation)
tmux load-buffer -b redirect "$MSG_FILE"
tmux paste-buffer -b redirect -t "agent-$TASK_ID"
tmux send-keys -t "agent-$TASK_ID" Enter
tmux delete-buffer -b redirect 2>/dev/null || true
rm -f "$MSG_FILE"
```

**Step 6: Create `kill-agent.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: kill-agent.sh <task_id> <cleanup|keep>

TASK_ID="$1"
CLEANUP="${2:-keep}"
SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"

# Kill tmux session
tmux kill-session -t "agent-$TASK_ID" 2>/dev/null || true

if [ "$CLEANUP" = "cleanup" ] && [ -f "$REGISTRY" ]; then
  WORKTREE=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .worktree' "$REGISTRY")
  BRANCH=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .branch' "$REGISTRY")

  if [ -n "$WORKTREE" ] && [ -d "$WORKTREE" ]; then
    REPO_ROOT=$(cd "$WORKTREE/.." && cd "$(git rev-parse --show-toplevel)" && pwd)
    cd "$REPO_ROOT"
    git worktree remove "$WORKTREE" --force 2>/dev/null || true
  fi

  if [ -n "$BRANCH" ]; then
    git branch -D "$BRANCH" 2>/dev/null || true
  fi

  # Update registry status — only overwrite if task was still active
  jq --arg id "$TASK_ID" \
    '(.tasks[] | select(.id == $id and (.status == "running" or .status == "pr_created" or .status == "reviewing"))).status = "failed" |
     (.tasks[] | select(.id == $id and .completedAt == null)).completedAt = (now * 1000 | floor)' \
    "$REGISTRY" > "$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"
fi

echo "Killed agent-$TASK_ID"
```

**Step 7: Create `update-task-status.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: update-task-status.sh <task_id> <status>

TASK_ID="$1"
NEW_STATUS="$2"
SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"

if [ ! -f "$REGISTRY" ]; then
  echo "Registry not found: $REGISTRY" >&2
  exit 1
fi

case "$NEW_STATUS" in
  running|pr_created|reviewing|ready_for_review|merged|failed) ;;
  *)
    echo "Invalid status: $NEW_STATUS" >&2
    exit 1
    ;;
esac

jq --arg id "$TASK_ID" --arg status "$NEW_STATUS" \
  '(.tasks[] | select(.id == $id)).status = $status |
   (if $status == "merged" or $status == "failed" then
      (.tasks[] | select(.id == $id)).completedAt = (now * 1000 | floor)
    else
      .
    end)' \
  "$REGISTRY" > "$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"

echo "Updated $TASK_ID status to $NEW_STATUS"
```

**Step 8: Create `review-pr.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: review-pr.sh <task_id>

TASK_ID="$1"
SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"
LOG_DIR="$SWARM_DIR/logs"

source "$SWARM_DIR/.env"

WORKTREE=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .worktree' "$REGISTRY")
BRANCH=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .branch' "$REGISTRY")

if [ ! -d "$WORKTREE" ]; then
  echo "Worktree not found: $WORKTREE" >&2
  exit 1
fi

cd "$WORKTREE"
PR_NUM=$(gh pr view "$BRANCH" --json number -q .number 2>/dev/null || echo "")

if [ -z "$PR_NUM" ]; then
  echo "No PR found for branch $BRANCH" >&2
  exit 1
fi

DIFF_FILE="$LOG_DIR/diff-$TASK_ID.patch"
gh pr diff "$PR_NUM" > "$DIFF_FILE"

# Truncate diff to ~100KB to avoid CLI arg/token limits.
# Truncate at last complete line to avoid mid-line or mid-UTF8 cuts.
if [ "$(wc -c < "$DIFF_FILE")" -gt 102400 ]; then
  head -c 102400 "$DIFF_FILE" | head -n -0 > "$DIFF_FILE.tmp"
  echo -e "\n\n... [diff truncated at ~100KB] ..." >> "$DIFF_FILE.tmp"
  mv "$DIFF_FILE.tmp" "$DIFF_FILE"
fi

echo "Starting code reviews for PR #$PR_NUM..."

# Codex reviewer (thorough — edge cases, logic errors)
if [ -n "${OPENAI_API_KEY:-}" ]; then
  (
    cd "$WORKTREE"
    codex --model gpt-5.3-codex \
      --dangerously-bypass-approvals-and-sandbox \
      "Review the PR diff in $DIFF_FILE. Focus on: logic errors, missing error handling, race conditions, edge cases. Post findings as gh pr review comments on PR #$PR_NUM." \
      2>&1 | tee "$LOG_DIR/review-codex-$TASK_ID.log"
  ) &
  CODEX_PID=$!
fi

# Claude Code reviewer (validation — critical issues only)
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  (
    cd "$WORKTREE"
    claude --model claude-sonnet-4-6 \
      --dangerously-skip-permissions \
      -p "Review the PR diff in $DIFF_FILE. Only flag critical issues. Skip style suggestions. Post findings as gh pr review comment on PR #$PR_NUM." \
      2>&1 | tee "$LOG_DIR/review-claude-$TASK_ID.log"
  ) &
  CLAUDE_PID=$!
fi

# Wait for parallel reviews
[ -n "${CODEX_PID:-}" ] && wait "$CODEX_PID" || true
[ -n "${CLAUDE_PID:-}" ] && wait "$CLAUDE_PID" || true

# Gemini Code Assist reviews automatically via GitHub App — no script needed

echo "Reviews complete for PR #$PR_NUM"
```

**Step 9: Create `cleanup-worktrees.sh`**

```bash
#!/usr/bin/env bash
set -uo pipefail

SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"

if [ ! -f "$REGISTRY" ]; then
  exit 0
fi

CUTOFF=$(( $(date +%s) - 86400 ))

jq -c '.tasks[] | select((.status == "merged" or .status == "failed") and (.completedAt != null) and ((.completedAt / 1000) < '"$CUTOFF"'))' "$REGISTRY" | while IFS= read -r task; do
  TASK_ID=$(echo "$task" | jq -r '.id')
  WORKTREE=$(echo "$task" | jq -r '.worktree')

  echo "Cleaning up: $TASK_ID"

  tmux kill-session -t "agent-$TASK_ID" 2>/dev/null || true

  if [ -d "$WORKTREE" ]; then
    REPO_ROOT=$(cd "$WORKTREE/.." && cd "$(git rev-parse --show-toplevel)" && pwd 2>/dev/null) || true
    if [ -n "$REPO_ROOT" ]; then
      (cd "$REPO_ROOT" && git worktree remove "$WORKTREE" --force 2>/dev/null) || true
    fi
  fi

  rm -f "$SWARM_DIR/logs/$TASK_ID.log"
  rm -f "$SWARM_DIR/logs/review-codex-$TASK_ID.log"
  rm -f "$SWARM_DIR/logs/review-claude-$TASK_ID.log"
  rm -f "$SWARM_DIR/prompts/$TASK_ID.txt"
done

jq --argjson cutoff "$CUTOFF" \
  '.tasks |= [.[] | select(
    .status == "running" or .status == "pr_created" or .status == "reviewing" or .status == "ready_for_review" or
    ((.completedAt == null) or ((.completedAt / 1000) >= $cutoff))
  )]' "$REGISTRY" > "$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"

echo "Cleanup complete"
```

**Step 10: Create `setup-remote.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

SWARM_DIR="$HOME/.agent-swarm"

echo "Setting up agent swarm at $SWARM_DIR..."

mkdir -p "$SWARM_DIR/logs" "$SWARM_DIR/prompts"

if [ ! -f "$SWARM_DIR/active-tasks.json" ]; then
  echo '{"tasks":[]}' > "$SWARM_DIR/active-tasks.json"
fi

chmod +x "$SWARM_DIR/spawn-agent.sh" "$SWARM_DIR/run-agent.sh" "$SWARM_DIR/write-prompt.sh" \
  "$SWARM_DIR/check-agents.sh" "$SWARM_DIR/redirect-agent.sh" \
  "$SWARM_DIR/kill-agent.sh" "$SWARM_DIR/update-task-status.sh" "$SWARM_DIR/review-pr.sh" \
  "$SWARM_DIR/cleanup-worktrees.sh"

echo "Checking prerequisites..."
command -v git >/dev/null || { echo "FAIL: git not installed"; exit 1; }
command -v tmux >/dev/null || { echo "FAIL: tmux not installed"; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq not installed"; exit 1; }
command -v gh >/dev/null || { echo "FAIL: gh CLI not installed"; exit 1; }

# At least one runtime is needed (Node.js or Python)
if command -v node >/dev/null; then echo "OK: node found"; else echo "INFO: node not found"; fi
if command -v python3 >/dev/null; then echo "OK: python3 found"; else echo "INFO: python3 not found"; fi
if ! command -v node >/dev/null && ! command -v python3 >/dev/null; then
  echo "FAIL: neither node nor python3 installed — at least one runtime is required"
  exit 1
fi

command -v claude >/dev/null && echo "OK: claude CLI found" || echo "WARN: claude CLI not found"
command -v codex >/dev/null && echo "OK: codex CLI found" || echo "WARN: codex CLI not found"
command -v poetry >/dev/null && echo "OK: poetry found" || echo "INFO: poetry not found (optional, for Python projects)"
command -v uv >/dev/null && echo "OK: uv found" || echo "INFO: uv not found (optional, for Python projects)"

gh auth status >/dev/null 2>&1 && echo "OK: gh authenticated" || echo "WARN: gh not authenticated — run 'gh auth login'"

if [ ! -f "$SWARM_DIR/.env" ]; then
  echo ""
  echo "Enter API keys (press Enter to skip):"
  read -rp "ANTHROPIC_API_KEY: " ANTHROPIC_KEY
  read -rp "OPENAI_API_KEY: " OPENAI_KEY
  read -rp "GOOGLE_API_KEY: " GOOGLE_KEY

  cat > "$SWARM_DIR/.env" <<ENVEOF
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
OPENAI_API_KEY=${OPENAI_KEY}
GOOGLE_API_KEY=${GOOGLE_KEY}
ENVEOF
  chmod 600 "$SWARM_DIR/.env"
  echo "Keys saved to $SWARM_DIR/.env"
fi

if ! grep -q 'history-limit' ~/.tmux.conf 2>/dev/null; then
  echo 'set -g history-limit 50000' >> ~/.tmux.conf
  echo "Added tmux history-limit to ~/.tmux.conf"
fi

echo ""
echo "Setup complete. Configure SWARM_SSH_TARGET and SWARM_REPOS_JSON in NanoClaw .env"
```

**Step 11 (optional): Create `config.yaml.template` for human reference**

```yaml
# Agent Swarm Configuration (optional reference)
# Not read by NanoClaw runtime; host uses SWARM_REPOS_JSON from NanoClaw .env
# You may copy to ~/.agent-swarm/config.yaml for manual ops notes

repos:
  project-a:
    path: /home/dev/project-a
    description: "SaaS backend (Node/TypeScript)"
    default_model: codex
    install_command: "npm ci"

  project-b:
    path: /home/dev/project-b
    description: "SaaS frontend (Next.js)"
    default_model: "claude-code:sonnet"
    install_command: "pnpm install --frozen-lockfile"

  project-c:
    path: /home/dev/project-c
    description: "API backend (Python/FastAPI)"
    default_model: codex
    install_command: "poetry install --no-interaction"

max_concurrent: 4
max_retries: 3
```

**Step 12: Make scripts executable and commit**

```bash
chmod +x .claude/skills/add-agent-swarm/remote/*.sh
git add .claude/skills/add-agent-swarm/remote/
git commit -m "feat: add remote shell scripts for agent swarm"
```

---

### Task 3: MCP tools and IPC handlers

**Files:**
- Create: `.claude/skills/add-agent-swarm/modify/container/agent-runner/src/ipc-mcp-stdio.ts`
- Create: `.claude/skills/add-agent-swarm/modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md`
- Create: `.claude/skills/add-agent-swarm/modify/src/ipc.ts`
- Create: `.claude/skills/add-agent-swarm/modify/src/ipc.ts.intent.md`
- Reference: `container/agent-runner/src/ipc-mcp-stdio.ts` (current source)
- Reference: `src/ipc.ts` (current source)

**Key design decision: Poll-and-wait IPC response pattern.**

Existing MCP tools are fire-and-forget (send_message, schedule_task). Swarm tools need to return results. The pattern:

1. MCP tool writes request with unique `requestId` to `/workspace/ipc/tasks/`
2. Host IPC watcher picks it up, executes SSH, writes response to `data/ipc/{groupFolder}/responses/{requestId}.json` (visible in-container as `/workspace/ipc/responses/{requestId}.json`)
3. MCP tool polls for the response file (check every 500ms, timeout 60s)
4. MCP tool reads response, deletes the file, returns result

**Step 1: Create the MCP tools modify file**

Start from current `container/agent-runner/src/ipc-mcp-stdio.ts` and add eight new MCP tools after existing tools. All restricted to main group. Add poll-and-wait helpers first.

**New helpers (after existing writeIpcFile):**

```typescript
import { randomUUID } from 'node:crypto';

const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

async function waitForResponse(requestId: string, timeoutMs: number = 60_000): Promise<string> {
  const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(responsePath)) {
      const data = fs.readFileSync(responsePath, 'utf-8');
      fs.unlinkSync(responsePath);
      return data;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for response ${requestId}`);
}

function generateRequestId(): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}
```

**New tools to add (complete code):**

```typescript
// --- Agent Swarm Tools (main group only) ---

server.tool(
  'spawn_agent',
  'Spawn a coding agent on the remote dev machine. Creates a git worktree, installs dependencies, and launches the agent in a tmux session. Returns the task ID. Use check_agents to monitor progress.',
  {
    repo: z.string().describe('Repository name from config (e.g., "project-a")'),
    branch_name: z.string().describe('Git branch name to create (e.g., "feat/custom-templates")'),
    prompt: z.string().describe('The full prompt/instructions for the coding agent'),
    model: z.enum(['claude-code:opus', 'claude-code:sonnet', 'claude-code:haiku', 'codex'])
      .describe('Which model/agent to use'),
    priority: z.enum(['high', 'normal', 'low']).default('normal')
      .describe('Task priority — affects retry behavior'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the orchestrator group can spawn agents.' }], isError: true };
    }

    const requestId = generateRequestId();
    const data = {
      type: 'swarm_spawn',
      requestId,
      repo: args.repo,
      branchName: args.branch_name,
      prompt: args.prompt,
      model: args.model,
      priority: args.priority,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    try {
      const response = await waitForResponse(requestId, 180_000); // 3 min for spawn
      return { content: [{ type: 'text' as const, text: response }] };
    } catch {
      return { content: [{ type: 'text' as const, text: `Spawn request sent but timed out waiting for confirmation. Use check_agents to verify.` }] };
    }
  },
);

server.tool(
  'check_agents',
  'Check the status of all running coding agents. Returns per-agent status: tmux alive, PR number, CI status, review status. No LLM tokens burned.',
  {},
  async () => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the orchestrator group can check agents.' }], isError: true };
    }

    const requestId = generateRequestId();
    const data = { type: 'swarm_check', requestId, groupFolder, timestamp: new Date().toISOString() };
    writeIpcFile(TASKS_DIR, data);

    try {
      const response = await waitForResponse(requestId, 90_000);
      return { content: [{ type: 'text' as const, text: response }] };
    } catch {
      return { content: [{ type: 'text' as const, text: 'Agent status check timed out. The remote machine may be slow or unreachable.' }], isError: true };
    }
  },
);

server.tool(
  'redirect_agent',
  'Send a correction or additional context to a running agent via tmux.',
  {
    task_id: z.string().describe('The task ID of the agent to redirect'),
    message: z.string().describe('The message to inject (e.g., "Stop. Focus on the API layer first.")'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the orchestrator group can redirect agents.' }], isError: true };
    }

    const requestId = generateRequestId();
    const data = { type: 'swarm_redirect', requestId, taskId: args.task_id, message: args.message, groupFolder, timestamp: new Date().toISOString() };
    writeIpcFile(TASKS_DIR, data);

    try {
      const response = await waitForResponse(requestId);
      return { content: [{ type: 'text' as const, text: response }] };
    } catch {
      return { content: [{ type: 'text' as const, text: `Redirect sent to ${args.task_id} but confirmation timed out.` }] };
    }
  },
);

server.tool(
  'kill_agent',
  'Kill a running agent and optionally clean up its worktree and branch.',
  {
    task_id: z.string().describe('The task ID of the agent to kill'),
    cleanup: z.boolean().default(false).describe('Also remove worktree and delete branch'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the orchestrator group can kill agents.' }], isError: true };
    }

    const requestId = generateRequestId();
    const data = { type: 'swarm_kill', requestId, taskId: args.task_id, cleanup: args.cleanup, groupFolder, timestamp: new Date().toISOString() };
    writeIpcFile(TASKS_DIR, data);

    try {
      const response = await waitForResponse(requestId);
      return { content: [{ type: 'text' as const, text: response }] };
    } catch {
      return { content: [{ type: 'text' as const, text: `Kill request sent for ${args.task_id} but confirmation timed out.` }] };
    }
  },
);

server.tool(
  'get_agent_output',
  'Read recent output from a running or completed agent log.',
  {
    task_id: z.string().describe('The task ID of the agent'),
    lines: z.number().default(100).describe('Number of lines to read from the end of the log'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the orchestrator group can read agent output.' }], isError: true };
    }

    const requestId = generateRequestId();
    const data = { type: 'swarm_output', requestId, taskId: args.task_id, lines: args.lines, groupFolder, timestamp: new Date().toISOString() };
    writeIpcFile(TASKS_DIR, data);

    try {
      const response = await waitForResponse(requestId);
      return { content: [{ type: 'text' as const, text: response }] };
    } catch {
      return { content: [{ type: 'text' as const, text: `Failed to retrieve output for ${args.task_id}.` }], isError: true };
    }
  },
);

server.tool(
  'run_review',
  'Trigger the multi-model PR review pipeline for a task. Runs Codex and Claude Code reviewers in parallel.',
  {
    task_id: z.string().describe('The task ID of the agent whose PR should be reviewed'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the orchestrator group can run reviews.' }], isError: true };
    }

    const requestId = generateRequestId();
    const data = { type: 'swarm_review', requestId, taskId: args.task_id, groupFolder, timestamp: new Date().toISOString() };
    writeIpcFile(TASKS_DIR, data);

    try {
      const response = await waitForResponse(requestId, 360_000); // 6 min for reviews
      return { content: [{ type: 'text' as const, text: response }] };
    } catch {
      return { content: [{ type: 'text' as const, text: `Review triggered for ${args.task_id} but timed out. Reviews may still be running on the remote machine.` }] };
    }
  },
);

server.tool(
  'update_task_status',
  'Update a swarm task status in the remote registry. Use this to persist state transitions like ready_for_review or failed so monitor loops do not re-notify.',
  {
    task_id: z.string().describe('The task ID to update'),
    status: z.enum(['running', 'pr_created', 'reviewing', 'ready_for_review', 'merged', 'failed'])
      .describe('The new lifecycle status'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the orchestrator group can update swarm task status.' }], isError: true };
    }

    const requestId = generateRequestId();
    const data = { type: 'swarm_update_status', requestId, taskId: args.task_id, status: args.status, groupFolder, timestamp: new Date().toISOString() };
    writeIpcFile(TASKS_DIR, data);

    try {
      const response = await waitForResponse(requestId);
      return { content: [{ type: 'text' as const, text: response }] };
    } catch {
      return { content: [{ type: 'text' as const, text: `Status update sent for ${args.task_id} but confirmation timed out.` }], isError: true };
    }
  },
);

server.tool(
  'run_cleanup',
  'Run remote cleanup for completed agent worktrees/logs older than 24 hours.',
  {},
  async () => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the orchestrator group can run cleanup.' }], isError: true };
    }

    const requestId = generateRequestId();
    const data = { type: 'swarm_cleanup', requestId, groupFolder, timestamp: new Date().toISOString() };
    writeIpcFile(TASKS_DIR, data);

    try {
      const response = await waitForResponse(requestId, 180_000);
      return { content: [{ type: 'text' as const, text: response }] };
    } catch {
      return { content: [{ type: 'text' as const, text: 'Cleanup request timed out. It may still be running remotely.' }], isError: true };
    }
  },
);
```

**Step 2: Create the IPC handler modify file**

Start from current `src/ipc.ts` and add:

**New imports (explicit list):**
```typescript
import fs from 'fs';  // Confirm already imported — if not, add
import path from 'path';  // Confirm already imported — if not, add
import { GROUPS_DIR, SWARM_SSH_TARGET, SWARM_ENABLED, SWARM_REPOS } from './config.js';
import {
  spawnAgent,
  checkAgents,
  redirectAgent,
  killAgent,
  updateTaskStatus,
  readAgentLog,
  runReview,
  runCleanup,
} from './agent-swarm.js';
```

**New type fields for `data` parameter in `processTaskIpc`:**
```typescript
// Add to the existing data type:
  requestId?: string;
  repo?: string;
  branchName?: string;
  model?: string;
  priority?: string;
  message?: string;
  cleanup?: boolean;
  status?: string;
  lines?: number;
```

**Helper function for writing IPC responses:**
```typescript
function writeIpcResponse(sourceGroup: string, requestId: string, result: string): void {
  const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${requestId}.json`);
  fs.writeFileSync(responsePath, result);
}
```

**New IPC cases (inside `switch(data.type)`):**

```typescript
case 'swarm_spawn': {
  // NOTE: The IPC task file in data/ipc/{group}/tasks/ contains the full
  // prompt text. This is a known limitation — the prompt sits unencrypted on
  // the host filesystem until the IPC file is processed and removed.
  if (!isMain) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can spawn swarm agents');
    break;
  }
  if (!SWARM_ENABLED) {
    logger.warn('Swarm operation attempted but SWARM_SSH_TARGET not configured');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
    break;
  }
  const repoConfig = SWARM_REPOS[data.repo!];
  if (!repoConfig) {
    logger.warn({ repo: data.repo }, 'Unknown repo in swarm_spawn');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Error: unknown repo "${data.repo}"`);
    break;
  }
  try {
    const taskId = await spawnAgent(SWARM_SSH_TARGET, {
      repo: data.repo!,
      repoPath: repoConfig.path,
      branchName: data.branchName!,
      prompt: data.prompt!,
      model: data.model!,
      priority: data.priority as any,
    });
    logger.info({ taskId, repo: data.repo, model: data.model }, 'Swarm agent spawned');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Agent spawned: ${taskId} (${data.model} on ${data.repo}, branch ${data.branchName})`);
  } catch (err) {
    logger.error({ err, repo: data.repo }, 'Failed to spawn swarm agent');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Spawn failed: ${(err as Error).message}`);
  }
  break;
}

case 'swarm_check': {
  if (!isMain) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can check swarm agents');
    break;
  }
  if (!SWARM_ENABLED) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
    break;
  }
  try {
    const statuses = await checkAgents(SWARM_SSH_TARGET);
    const result = JSON.stringify(statuses, null, 2);
    logger.info({ count: statuses.length }, 'Swarm status check complete');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, result);
  } catch (err) {
    logger.error({ err }, 'Failed to check swarm agents');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Check failed: ${(err as Error).message}`);
  }
  break;
}

case 'swarm_redirect': {
  if (!isMain) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can redirect swarm agents');
    break;
  }
  if (!SWARM_ENABLED) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
    break;
  }
  try {
    await redirectAgent(SWARM_SSH_TARGET, data.taskId!, data.message!);
    logger.info({ taskId: data.taskId }, 'Swarm agent redirected');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Redirect sent to ${data.taskId}`);
  } catch (err) {
    logger.error({ err, taskId: data.taskId }, 'Failed to redirect swarm agent');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Redirect failed: ${(err as Error).message}`);
  }
  break;
}

case 'swarm_kill': {
  if (!isMain) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can kill swarm agents');
    break;
  }
  if (!SWARM_ENABLED) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
    break;
  }
  try {
    await killAgent(SWARM_SSH_TARGET, data.taskId!, data.cleanup);
    logger.info({ taskId: data.taskId, cleanup: data.cleanup }, 'Swarm agent killed');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Killed agent ${data.taskId}${data.cleanup ? ' (cleaned up)' : ''}`);
  } catch (err) {
    logger.error({ err, taskId: data.taskId }, 'Failed to kill swarm agent');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Kill failed: ${(err as Error).message}`);
  }
  break;
}

case 'swarm_output': {
  if (!isMain) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can read swarm agent output');
    break;
  }
  if (!SWARM_ENABLED) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
    break;
  }
  try {
    const output = await readAgentLog(SWARM_SSH_TARGET, data.taskId!, data.lines);
    logger.info({ taskId: data.taskId }, 'Swarm agent output retrieved');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, output);
  } catch (err) {
    logger.error({ err, taskId: data.taskId }, 'Failed to get swarm agent output');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Output retrieval failed: ${(err as Error).message}`);
  }
  break;
}

case 'swarm_review': {
  if (!isMain) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can run swarm reviews');
    break;
  }
  if (!SWARM_ENABLED) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
    break;
  }
  try {
    await runReview(SWARM_SSH_TARGET, data.taskId!);
    logger.info({ taskId: data.taskId }, 'Swarm PR review complete');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Review complete for ${data.taskId}`);
  } catch (err) {
    logger.error({ err, taskId: data.taskId }, 'Failed to run swarm review');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Review failed: ${(err as Error).message}`);
  }
  break;
}

case 'swarm_update_status': {
  if (!isMain) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can update swarm task status');
    break;
  }
  if (!SWARM_ENABLED) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
    break;
  }
  try {
    await updateTaskStatus(SWARM_SSH_TARGET, data.taskId!, data.status as any);
    logger.info({ taskId: data.taskId, status: data.status }, 'Swarm task status updated');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Updated ${data.taskId} to ${data.status}`);
  } catch (err) {
    logger.error({ err, taskId: data.taskId, status: data.status }, 'Failed to update swarm task status');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Status update failed: ${(err as Error).message}`);
  }
  break;
}

case 'swarm_cleanup': {
  if (!isMain) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: only main group can run swarm cleanup');
    break;
  }
  if (!SWARM_ENABLED) {
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
    break;
  }
  try {
    await runCleanup(SWARM_SSH_TARGET);
    logger.info('Swarm cleanup completed');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, 'Cleanup complete');
  } catch (err) {
    logger.error({ err }, 'Failed to run swarm cleanup');
    if (data.requestId) writeIpcResponse(sourceGroup, data.requestId, `Cleanup failed: ${(err as Error).message}`);
  }
  break;
}
```

**Step 3: Create intent files**

Create `.claude/skills/add-agent-swarm/modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md`:

```markdown
# Intent: container/agent-runner/src/ipc-mcp-stdio.ts modifications

## What this skill adds
Eight MCP tools for agent swarm management: spawn_agent, check_agents, redirect_agent, kill_agent, get_agent_output, run_review, update_task_status, run_cleanup. All restricted to main group. Introduces poll-and-wait response pattern via `waitForResponse` helper.

## Key sections

### Helpers (after existing writeIpcFile)
- Added: `waitForResponse(requestId, timeoutMs)` — polls for response file in IPC responses dir
- Added: `generateRequestId()` — creates unique request ID
- Added: `RESPONSES_DIR` — path constant for IPC response files

### MCP tools (after existing tools)
- Added: 8 swarm tools, each writes IPC request with requestId, then polls for response

## Invariants
- All swarm tools check `isMain` before proceeding.
- Response polling uses 500ms intervals with configurable timeout.
- Timeouts return graceful error messages, not exceptions.

## Must-keep sections
- All existing tools (send_message, schedule_task, list_tasks, pause_task, resume_task, cancel_task, register_group, refresh_groups) unchanged
- writeIpcFile helper unchanged
- IPC directory constants unchanged
```

Create `.claude/skills/add-agent-swarm/modify/src/ipc.ts.intent.md`:

```markdown
# Intent: src/ipc.ts modifications

## What this skill adds
Eight IPC handler cases for swarm operations (swarm_spawn, swarm_check, swarm_redirect, swarm_kill, swarm_output, swarm_review, swarm_update_status, swarm_cleanup). Each calls the SSH bridge module and writes responses to IPC response directory. Adds `writeIpcResponse` helper and imports for `GROUPS_DIR`, `SWARM_SSH_TARGET`, `SWARM_ENABLED`, `SWARM_REPOS`, and agent-swarm module functions.

## Key sections

### Imports (top of file)
- Added: `fs` and `path` (confirm already imported)
- Added: `GROUPS_DIR`, `SWARM_SSH_TARGET`, `SWARM_ENABLED`, `SWARM_REPOS` from `./config.js`
- Added: `spawnAgent`, `checkAgents`, `redirectAgent`, `killAgent`, `updateTaskStatus`, `readAgentLog`, `runReview`, `runCleanup` from `./agent-swarm.js`

### processTaskIpc data type
- Extended with: `requestId?`, `repo?`, `branchName?`, `model?`, `priority?`, `message?`, `cleanup?`, `status?`, `lines?`

### writeIpcResponse helper (before processTaskIpc)
- Creates response directory under IPC path
- Writes result string to `{requestId}.json`

### Switch cases (inside processTaskIpc)
- Added: 8 swarm cases, each guarded by main/swarm-enabled checks with explicit blocked-operation responses

## Invariants
- All swarm handlers return explicit IPC responses when blocked (`!isMain` or `!SWARM_ENABLED`) so MCP tools fail fast instead of timing out.
- Errors are logged and written as response, never thrown.
- Response files cleaned up by MCP tool's `waitForResponse` after reading.

## Must-keep sections
- All existing IPC cases (message, schedule_task, pause/resume/cancel_task, register_group, refresh_groups) unchanged
- IPC watcher polling loop unchanged
- Authorization model (sourceGroup verification) unchanged
```

**Step 4: Add targeted IPC/MCP tests**

Create `.claude/skills/add-agent-swarm/tests/agent-swarm-ipc.test.ts` with focused coverage for the new lifecycle/cleanup paths:

- `update_task_status` MCP tool writes `type: "swarm_update_status"` with `taskId` and `status`.
- `run_cleanup` MCP tool writes `type: "swarm_cleanup"`.
- IPC handler returns explicit error response when `SWARM_ENABLED` is false for `swarm_update_status` and `swarm_cleanup`.
- Successful `swarm_update_status` and `swarm_cleanup` write response files (request/response roundtrip).

Run:

```bash
npx vitest run --config .claude/skills/vitest.config.ts .claude/skills/add-agent-swarm/tests/agent-swarm-ipc.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-agent-swarm/modify/
git add .claude/skills/add-agent-swarm/tests/agent-swarm-ipc.test.ts
git commit -m "feat: add MCP tools and IPC handlers for agent swarm"
```

---

### Task 4: Config and environment variables

**Files:**
- Create: `.claude/skills/add-agent-swarm/modify/src/config.ts`
- Create: `.claude/skills/add-agent-swarm/modify/src/config.ts.intent.md`

**Step 1: Create the config.ts modify file**

Start from current `src/config.ts`. Make these changes:

1. Add `'SWARM_SSH_TARGET'` and `'SWARM_REPOS_JSON'` to the `readEnvFile()` call:

```typescript
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'SWARM_SSH_TARGET',
  'SWARM_REPOS_JSON',
]);
```

2. Add exports at the end of the file:

```typescript
// Agent Swarm config
export const SWARM_SSH_TARGET = process.env.SWARM_SSH_TARGET || envConfig.SWARM_SSH_TARGET || '';
export const SWARM_ENABLED = !!SWARM_SSH_TARGET;

function parseSwarmRepos(): Record<string, { path: string; description?: string; default_model?: string }> {
  const raw = process.env.SWARM_REPOS_JSON || envConfig.SWARM_REPOS_JSON || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
export const SWARM_REPOS = parseSwarmRepos();
```

**Step 2: Create intent file**

Create `.claude/skills/add-agent-swarm/modify/src/config.ts.intent.md`:

```markdown
# Intent: src/config.ts modifications

## What this skill adds
Three new config exports: `SWARM_SSH_TARGET` (SSH connection string), `SWARM_ENABLED` (boolean guard), `SWARM_REPOS` (parsed repo config from JSON env var).

## Key sections

### readEnvFile call
- Added: `'SWARM_SSH_TARGET'` and `'SWARM_REPOS_JSON'` to the key array

### New exports (end of file)
- `SWARM_SSH_TARGET`: string, defaults to empty
- `SWARM_ENABLED`: boolean, true when SWARM_SSH_TARGET is non-empty
- `SWARM_REPOS`: parsed from SWARM_REPOS_JSON env var

## Invariants
- `SWARM_ENABLED` is false when `SWARM_SSH_TARGET` is empty — swarm handlers block execution and return explicit configuration errors.
- `SWARM_REPOS` returns empty object on parse failure — never throws.

## Must-keep sections
- All existing config exports unchanged
- readEnvFile import unchanged
- Path constants unchanged
```

**Step 3: Commit**

```bash
git add .claude/skills/add-agent-swarm/modify/src/config.ts*
git commit -m "feat: add swarm config variables"
```

---

### Task 5: Monitor task module

**Files:**
- Create: `.claude/skills/add-agent-swarm/add/src/agent-swarm-monitor.ts`
- Test: `.claude/skills/add-agent-swarm/tests/agent-swarm-monitor.test.ts`

**Step 1: Write the failing test**

Create `.claude/skills/add-agent-swarm/tests/agent-swarm-monitor.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --config .claude/skills/vitest.config.ts .claude/skills/add-agent-swarm/tests/agent-swarm-monitor.test.ts`
Expected: FAIL — module not found

**Step 3: Write the monitor module**

Create `.claude/skills/add-agent-swarm/add/src/agent-swarm-monitor.ts`:

```typescript
import {
  checkAgents,
  readTaskRegistry,
  AgentStatus,
  SwarmTask,
} from './agent-swarm.js';

export interface MonitorAction {
  taskId: string;
  action:
    | 'notify_ready'
    | 'notify_failed'
    | 'respawn'
    | 'trigger_review'
    | 'respawn_with_ci_fix'
    | 'respawn_with_review_fix';
  pr?: number | null;
  reason?: string;
}

export async function evaluateAgents(
  sshTarget: string,
): Promise<MonitorAction[]> {
  // This function is intentionally pure: it evaluates current state and
  // returns suggested actions. The caller is responsible for executing actions
  // and persisting lifecycle transitions via update_task_status.
  const registry = await readTaskRegistry(sshTarget);
  const statuses = await checkAgents(sshTarget);

  const statusMap = new Map<string, AgentStatus>();
  for (const s of statuses) {
    statusMap.set(s.id, s);
  }

  const actions: MonitorAction[] = [];

  for (const task of registry.tasks) {
    if (task.status === 'merged' || task.status === 'failed') continue;
    if (task.status === 'ready_for_review') continue;

    const status = statusMap.get(task.id);
    if (!status) continue;

    // Agent died without creating a PR
    if (!status.tmux_alive && !status.pr_number) {
      if (task.retries < task.maxRetries) {
        actions.push({
          taskId: task.id,
          action: 'respawn',
          reason: 'Agent exited without creating PR',
        });
      } else {
        actions.push({
          taskId: task.id,
          action: 'notify_failed',
          reason: `Agent failed after ${task.retries} retries`,
        });
      }
      continue;
    }

    // Agent died but PR exists — trigger review
    if (!status.tmux_alive && status.pr_number && task.status === 'running') {
      actions.push({
        taskId: task.id,
        action: 'trigger_review',
        pr: status.pr_number,
      });
      continue;
    }

    // Agent still running — let it work; don't evaluate PR status yet
    if (status.tmux_alive) continue;

    // PR exists — check CI and reviews (agent has exited)
    if (status.pr_number) {
      // CI failing — respawn with fix
      if (status.ci_status === 'failing') {
        if (task.retries < task.maxRetries) {
          actions.push({
            taskId: task.id,
            action: 'respawn_with_ci_fix',
            pr: status.pr_number,
            reason: 'CI failing',
          });
        } else {
          actions.push({
            taskId: task.id,
            action: 'notify_failed',
            pr: status.pr_number,
            reason: `CI failing after ${task.retries} retries`,
          });
        }
        continue;
      }

      // Critical review comments — respawn with review feedback
      if (status.critical_comments > 0) {
        if (task.retries < task.maxRetries) {
          actions.push({
            taskId: task.id,
            action: 'respawn_with_review_fix',
            pr: status.pr_number,
            reason: `${status.critical_comments} critical review comments`,
          });
        }
        continue;
      }

      // CI passing + no critical comments → ready for human review.
      // Accepts review_status 'pending' because Gemini Code Assist (GitHub App)
      // doesn't set reviewDecision, and we want to notify the human early so they
      // can look while automated reviews may still be running.
      if (
        status.ci_status === 'passing' &&
        (status.review_status === 'approved' || status.review_status === 'pending') &&
        status.critical_comments === 0
      ) {
        actions.push({
          taskId: task.id,
          action: 'notify_ready',
          pr: status.pr_number,
        });
        continue;
      }
    }
  }

  return actions;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run --config .claude/skills/vitest.config.ts .claude/skills/add-agent-swarm/tests/agent-swarm-monitor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add .claude/skills/add-agent-swarm/add/src/agent-swarm-monitor.ts
git add .claude/skills/add-agent-swarm/tests/agent-swarm-monitor.test.ts
git commit -m "feat: add monitor loop module for agent swarm"
```

---

### Task 6: Manifest and SKILL.md

**Files:**
- Create: `.claude/skills/add-agent-swarm/manifest.yaml`
- Create: `.claude/skills/add-agent-swarm/SKILL.md`
- Create: `.claude/skills/add-agent-swarm/templates/orchestrator-claude.md`

**Step 1: Create manifest.yaml**

```yaml
skill: agent-swarm
version: 1.0.0
description: "Orchestrate a fleet of Claude Code / Codex coding agents on a remote machine via SSH"
core_version: 0.1.0
adds:
  - src/agent-swarm.ts
  - src/agent-swarm-monitor.ts
modifies:
  - src/config.ts
  - src/ipc.ts
  - container/agent-runner/src/ipc-mcp-stdio.ts
structured:
  npm_dependencies: {}
  env_additions:
    - SWARM_SSH_TARGET
    - SWARM_REPOS_JSON
conflicts: []
depends: []
test: "npx vitest run --config .claude/skills/vitest.config.ts .claude/skills/add-agent-swarm/tests/"
```

**Step 2: Create SKILL.md**

```markdown
---
name: add-agent-swarm
description: Orchestrate a fleet of coding agents on a remote machine via SSH. Spawn Claude Code and Codex agents, monitor progress, auto-review PRs, and get WhatsApp notifications.
triggers:
  - agent swarm
  - coding agents
  - remote agents
  - swarm
  - spawn agents
---

# /add-agent-swarm

Turns your orchestrator group into a dev team manager — spawning and monitoring Claude Code / Codex coding agents on a remote machine via SSH.

## Phase 1: Pre-flight

Check if this skill has already been applied:

1. If `.nanoclaw/state.yaml` exists and lists `agent-swarm` as applied, skip to Phase 4.
2. If `.nanoclaw/` doesn't exist, run `initNanoclawDir()` from the skills engine.
3. Verify SSH connectivity to remote machine:
   - Ask the user for their SSH target (e.g., `dev@192.168.1.50`)
   - Run: `ssh -o BatchMode=yes -o ConnectTimeout=10 <target> echo ok`
   - If it fails, guide them to set up SSH key auth first.

## Phase 2: Apply

1. Run: `npx tsx scripts/apply-skill.ts .claude/skills/add-agent-swarm`
2. Run: `npm run build`
3. No new npm dependencies needed.

## Phase 3: Configure

1. Add to `.env`:
   ```
   SWARM_SSH_TARGET=user@remote-host
   SWARM_REPOS_JSON={"project-a":{"path":"/home/dev/project-a"},"project-b":{"path":"/home/dev/project-b"}}
   ```

2. Create remote swarm directory:
   ```bash
   ssh $SWARM_SSH_TARGET 'mkdir -p ~/.agent-swarm'
   ```

3. Copy remote scripts to remote machine:
   ```bash
   scp -r .claude/skills/add-agent-swarm/remote/* $SWARM_SSH_TARGET:~/.agent-swarm/
   ```

4. Run remote setup:
   ```bash
   ssh $SWARM_SSH_TARGET '~/.agent-swarm/setup-remote.sh'
   ```

5. Create or pick the orchestrator WhatsApp group:
   - If creating new: create a private WhatsApp group (you + the bot)
   - If using existing: use the main group or a dedicated orchestrator group

6. Copy the orchestrator template to the group's CLAUDE.md:
   ```bash
   cp .claude/skills/add-agent-swarm/templates/orchestrator-claude.md groups/<orchestrator-group>/CLAUDE.md
   ```
   Edit it to fill in your repos, model routing rules, and business context.

7. Rebuild container:
   ```bash
   ./container/build.sh
   ```

8. Restart NanoClaw:
   ```bash
   systemctl --user restart nanoclaw  # or: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```

9. Schedule the monitor task — send this to the orchestrator group (requires NanoClaw running with swarm MCP tools):
   ```
   @<ASSISTANT_NAME> Schedule a recurring task every 10 minutes: "Run check_agents. For each agent, apply ## Monitor Rules exactly. When a task becomes ready for human review, call update_task_status(task_id, ready_for_review) before notifying. When retries are exhausted, call update_task_status(task_id, failed) before notifying."
   ```

10. Schedule daily cleanup:
   ```
   @<ASSISTANT_NAME> Schedule a daily task at 3am: "Call run_cleanup and report summary."
   ```

## Phase 4: Verify

Test by sending this to the orchestrator group:

```
@<ASSISTANT_NAME> Spawn a test agent on project-a, branch test/hello-world, prompt "Create a file hello.txt with Hello World", model claude-code:haiku
```

Then verify:
1. `check_agents` returns the running task
2. On the remote machine: `tmux list-sessions` shows `agent-test-hello-world`
3. After the agent finishes: a PR is created on the repo
4. Kill the test: `@<ASSISTANT_NAME> Kill agent test-hello-world with cleanup`
```

**Step 3: Create orchestrator CLAUDE.md template**

Create `.claude/skills/add-agent-swarm/templates/orchestrator-claude.md`:

```markdown
# Orchestrator Agent

## Identity
You are the engineering orchestrator. You manage a fleet of coding agents working across multiple repos. You talk to the user via WhatsApp. You never write code directly — you spawn agents, write their prompts, monitor progress, and report results.

## Available Tools
- `spawn_agent(repo, branch_name, prompt, model, priority)` — launch a coding agent
- `check_agents()` — get status of all active agents (no LLM tokens burned)
- `redirect_agent(task_id, message)` — send correction to running agent
- `kill_agent(task_id, cleanup)` — stop an agent, optionally clean up
- `get_agent_output(task_id, lines)` — read agent's recent output
- `run_review(task_id)` — trigger multi-model PR review pipeline
- `update_task_status(task_id, status)` — persist lifecycle transitions in registry
- `run_cleanup()` — clean old merged/failed worktrees and logs

## Repos
<!-- CUSTOMIZE: Replace with your actual repos -->
- project-a: SaaS backend (Node/TypeScript) at /home/dev/project-a
- project-b: SaaS frontend (Next.js) at /home/dev/project-b
- project-c: API backend (Python/FastAPI) at /home/dev/project-c

## Model Routing Rules
- Backend logic, complex bugs, multi-file refactors (Node or Python) → codex
- Frontend components, UI fixes → claude-code:sonnet
- Complex architecture decisions → claude-code:opus
- Quick fixes, typos, docs → claude-code:haiku
- FastAPI endpoints, Python data pipelines → codex
- Python test fixes, typing issues → claude-code:sonnet

## Prompt Writing Rules
Always include in agent prompts:
- Relevant type definitions or Pydantic models (copy actual types, don't reference)
- Test file paths to run (pytest for Python, vitest/jest for Node)
- Definition of done: PR with passing CI, screenshots if UI
- "Do NOT modify files outside of [specific directories]"
- For Python repos: specify virtualenv activation if needed, mention pyproject.toml config

When retrying a failed agent:
- Read failure output first (get_agent_output)
- Include the specific error in the new prompt
- Narrow scope: "Focus only on [these files]"
- Reference past patterns from ## Learnings

## Monitor Rules
When running the 10-minute monitor check:

| Condition | Action |
|-----------|--------|
| tmux dead + no PR | Respawn with failure context (if retries left). Otherwise call `update_task_status(task_id, failed)` and notify. |
| tmux dead + PR exists | Trigger review pipeline via `run_review`, then call `update_task_status(task_id, reviewing)`. |
| PR + CI failing | Read CI logs. Respawn with fix context if retries left. |
| PR + CI pass + no critical comments | Call `update_task_status(task_id, ready_for_review)`. Notify user. |
| PR + critical review comments | Read comments. Respawn with review feedback. |
| Already ready_for_review | Skip. |

## Business Context
<!-- CUSTOMIZE: Add your project context -->

### Current Priorities
- ...

### Customer Notes
- ...

## Learnings
<!-- Auto-populated after successful/failed tasks -->
<!-- Examples:
- "Codex needs type definitions upfront for project-a billing module"
- "project-b E2E tests flaky on auth flow — always retry once"
- "Include test paths in prompt — agents skip tests otherwise"
-->

## Active Context
<!-- Updated by monitor loop — what's running now -->
```

**Step 4: Commit**

```bash
git add .claude/skills/add-agent-swarm/manifest.yaml
git add .claude/skills/add-agent-swarm/SKILL.md
git add .claude/skills/add-agent-swarm/templates/
git commit -m "feat: complete /add-agent-swarm skill with SKILL.md and manifest"
```

---

### Task 7: Integration verification

**Step 1: Verify skill structure**

```bash
ls -la .claude/skills/add-agent-swarm/SKILL.md
ls -la .claude/skills/add-agent-swarm/manifest.yaml
ls -la .claude/skills/add-agent-swarm/add/src/agent-swarm.ts
ls -la .claude/skills/add-agent-swarm/add/src/agent-swarm-monitor.ts
ls -la .claude/skills/add-agent-swarm/tests/agent-swarm.test.ts
ls -la .claude/skills/add-agent-swarm/tests/agent-swarm-monitor.test.ts
ls -la .claude/skills/add-agent-swarm/tests/agent-swarm-ipc.test.ts
ls -la .claude/skills/add-agent-swarm/modify/src/ipc.ts
ls -la .claude/skills/add-agent-swarm/modify/src/ipc.ts.intent.md
ls -la .claude/skills/add-agent-swarm/modify/src/config.ts
ls -la .claude/skills/add-agent-swarm/modify/src/config.ts.intent.md
ls -la .claude/skills/add-agent-swarm/modify/container/agent-runner/src/ipc-mcp-stdio.ts
ls -la .claude/skills/add-agent-swarm/modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md
ls -la .claude/skills/add-agent-swarm/remote/spawn-agent.sh
ls -la .claude/skills/add-agent-swarm/remote/run-agent.sh
ls -la .claude/skills/add-agent-swarm/remote/write-prompt.sh
ls -la .claude/skills/add-agent-swarm/remote/check-agents.sh
ls -la .claude/skills/add-agent-swarm/remote/redirect-agent.sh
ls -la .claude/skills/add-agent-swarm/remote/kill-agent.sh
ls -la .claude/skills/add-agent-swarm/remote/update-task-status.sh
ls -la .claude/skills/add-agent-swarm/remote/review-pr.sh
ls -la .claude/skills/add-agent-swarm/remote/cleanup-worktrees.sh
ls -la .claude/skills/add-agent-swarm/remote/setup-remote.sh
ls -la .claude/skills/add-agent-swarm/templates/orchestrator-claude.md
```

**Step 2: Run skill unit tests**

```bash
npx vitest run --config .claude/skills/vitest.config.ts .claude/skills/add-agent-swarm/tests/
```

Expected: all tests pass

**Step 3: Run full test suite (no regressions)**

```bash
npx vitest run
```

Expected: all existing tests pass (ignore pre-existing fetch-upstream failures)

**Step 4: Validate shell scripts**

```bash
bash -n .claude/skills/add-agent-swarm/remote/spawn-agent.sh
bash -n .claude/skills/add-agent-swarm/remote/run-agent.sh
bash -n .claude/skills/add-agent-swarm/remote/write-prompt.sh
bash -n .claude/skills/add-agent-swarm/remote/check-agents.sh
bash -n .claude/skills/add-agent-swarm/remote/redirect-agent.sh
bash -n .claude/skills/add-agent-swarm/remote/kill-agent.sh
bash -n .claude/skills/add-agent-swarm/remote/update-task-status.sh
bash -n .claude/skills/add-agent-swarm/remote/review-pr.sh
bash -n .claude/skills/add-agent-swarm/remote/cleanup-worktrees.sh
bash -n .claude/skills/add-agent-swarm/remote/setup-remote.sh
```

Expected: no syntax errors

**Step 5: Smoke test status/cleanup flows (requires remote configured)**

From the orchestrator group:

1. Spawn a quick test task.
2. Confirm `check_agents` shows it.
3. Call `update_task_status` to set `ready_for_review`, then run `check_agents` again and confirm monitor logic would skip it.
4. Call `run_cleanup` and confirm it returns `Cleanup complete`.

**Step 6: Commit any fixes**

```bash
git add .claude/skills/add-agent-swarm/
git commit -m "test: verify agent swarm skill integration"
```

---

## Task Dependency Graph

```
Task 1: SSH bridge module + tests
  ↓
Task 2: Remote shell scripts
  ↓
Task 3: MCP tools + IPC handlers (modify files)
  ↓
Task 4: Config + env vars (modify file)
  ↓
Task 5: Monitor module + tests
  ↓
Task 6: Manifest + SKILL.md + templates
  ↓
Task 7: Integration verification
```

---

## Environment Variables Added

| Variable | Example | Purpose |
|----------|---------|---------|
| `SWARM_SSH_TARGET` | `dev@192.168.1.50` | SSH connection string for remote dev machine |
| `SWARM_REPOS_JSON` | `{"project-a":{"path":"/home/dev/project-a"}}` | JSON map of repo names to paths on remote |
