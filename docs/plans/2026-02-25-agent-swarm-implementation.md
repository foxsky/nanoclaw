# Agent Swarm Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the `/add-agent-swarm` NanoClaw skill — an orchestrator that spawns and monitors Claude Code / Codex / Gemini coding agents on a remote machine via SSH, with automated PR review and WhatsApp notifications.

**Architecture:** Follows the manifest-based skill pattern. Adds `src/agent-swarm.ts` (SSH bridge + task registry), `src/agent-swarm-monitor.ts` (monitor loop), remote shell scripts, and modifies `src/ipc.ts` + `container/agent-runner/src/ipc-mcp-stdio.ts` to register new MCP tools. The orchestrator group's agent calls MCP tools → IPC files → host processes SSH commands → remote machine manages tmux/worktrees.

**Tech Stack:** TypeScript, Node.js `child_process.spawn` for SSH, shell scripts on remote, `gh` CLI for PR/CI checks.

**Design Doc:** `docs/plans/2026-02-25-agent-swarm-design.md`

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

describe('agent-swarm SSH bridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('executes a remote command via SSH', async () => {
    const { executeRemote } = await import('../add/src/agent-swarm.js');

    const mockProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    (spawn as any).mockReturnValue(mockProcess);

    // Simulate successful completion
    const promise = executeRemote('dev@remote', 'echo hello');
    const dataHandler = mockProcess.stdout.on.mock.calls[0][1];
    dataHandler(Buffer.from('hello\n'));
    const closeHandler = mockProcess.on.mock.calls.find(
      (c: any[]) => c[0] === 'close',
    )![1];
    closeHandler(0);

    const result = await promise;
    expect(result).toBe('hello\n');
    expect(spawn).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining(['dev@remote', 'echo hello']),
      expect.any(Object),
    );
  });

  it('rejects on SSH failure', async () => {
    const { executeRemote } = await import('../add/src/agent-swarm.js');

    const mockProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    (spawn as any).mockReturnValue(mockProcess);

    const promise = executeRemote('dev@remote', 'bad-command');
    const stderrHandler = mockProcess.stderr.on.mock.calls[0][1];
    stderrHandler(Buffer.from('command not found'));
    const closeHandler = mockProcess.on.mock.calls.find(
      (c: any[]) => c[0] === 'close',
    )![1];
    closeHandler(1);

    await expect(promise).rejects.toThrow('SSH command failed');
  });

  it('rejects commands containing shell injection characters', async () => {
    const { executeRemote } = await import('../add/src/agent-swarm.js');
    await expect(executeRemote('dev@remote', 'echo; rm -rf /')).rejects.toThrow(
      'rejected',
    );
  });

  it('reads task registry from remote', async () => {
    const { readTaskRegistry } = await import('../add/src/agent-swarm.js');

    const mockProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    (spawn as any).mockReturnValue(mockProcess);

    const promise = readTaskRegistry('dev@remote');
    const dataHandler = mockProcess.stdout.on.mock.calls[0][1];
    dataHandler(
      Buffer.from(
        JSON.stringify({
          tasks: [
            {
              id: 'feat-x',
              status: 'running',
              repo: 'project-a',
              branch: 'feat/x',
            },
          ],
        }),
      ),
    );
    const closeHandler = mockProcess.on.mock.calls.find(
      (c: any[]) => c[0] === 'close',
    )![1];
    closeHandler(0);

    const registry = await promise;
    expect(registry.tasks).toHaveLength(1);
    expect(registry.tasks[0].id).toBe('feat-x');
  });

  it('validates task registry JSON structure', async () => {
    const { readTaskRegistry } = await import('../add/src/agent-swarm.js');

    const mockProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    (spawn as any).mockReturnValue(mockProcess);

    const promise = readTaskRegistry('dev@remote');
    const dataHandler = mockProcess.stdout.on.mock.calls[0][1];
    dataHandler(Buffer.from('not valid json'));
    const closeHandler = mockProcess.on.mock.calls.find(
      (c: any[]) => c[0] === 'close',
    )![1];
    closeHandler(0);

    await expect(promise).rejects.toThrow('Invalid task registry');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.skills.config.ts .claude/skills/add-agent-swarm/tests/agent-swarm.test.ts`
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
  prompt: string;
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

// SECURITY: Reject commands with obvious shell injection patterns.
// This is defense-in-depth — the remote scripts should also validate inputs.
const DANGEROUS_PATTERNS = /[;|&`$(){}]/;

export function executeRemote(
  sshTarget: string,
  command: string,
  timeoutMs: number = SSH_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (DANGEROUS_PATTERNS.test(command)) {
      reject(new Error(`Command rejected: contains shell metacharacters`));
      return;
    }

    const ssh = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshTarget, command],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';

    ssh.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    ssh.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      ssh.kill('SIGTERM');
      reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ssh.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `SSH command failed (exit ${code}): ${stderr || stdout}`,
          ),
        );
      }
    });

    ssh.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`SSH spawn error: ${err.message}`));
    });
  });
}

// --- Task registry ---

const REGISTRY_PATH = '~/.agent-swarm/active-tasks.json';

export async function readTaskRegistry(
  sshTarget: string,
): Promise<TaskRegistry> {
  const raw = await executeRemote(sshTarget, `cat ${REGISTRY_PATH}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid task registry: not valid JSON');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as TaskRegistry).tasks)
  ) {
    throw new Error('Invalid task registry: missing tasks array');
  }
  return parsed as TaskRegistry;
}

export async function writeTaskRegistry(
  sshTarget: string,
  registry: TaskRegistry,
): Promise<void> {
  const json = JSON.stringify(registry, null, 2);
  // Write atomically via temp file on remote
  const escaped = json.replace(/'/g, "'\\''");
  await executeRemote(
    sshTarget,
    `echo '${escaped}' > ${REGISTRY_PATH}.tmp && mv ${REGISTRY_PATH}.tmp ${REGISTRY_PATH}`,
  );
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
  const taskId = opts.branchName.replace(/\//g, '-');
  const escapedPrompt = opts.prompt.replace(/'/g, "'\\''");

  // spawn-agent.sh handles: worktree creation, dep install, tmux launch, registry update
  await executeRemote(
    sshTarget,
    `~/.agent-swarm/spawn-agent.sh '${opts.repoPath}' '${opts.branchName}' '${escapedPrompt}' '${opts.model}' '${taskId}'`,
    120_000, // 2 min timeout for install
  );

  return taskId;
}

export async function checkAgents(
  sshTarget: string,
): Promise<AgentStatus[]> {
  const raw = await executeRemote(sshTarget, '~/.agent-swarm/check-agents.sh');
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
  const escaped = message.replace(/'/g, "'\\''");
  await executeRemote(
    sshTarget,
    `tmux send-keys -t 'agent-${taskId}' '${escaped}' Enter`,
  );
}

export async function killAgent(
  sshTarget: string,
  taskId: string,
  cleanup: boolean = false,
): Promise<void> {
  await executeRemote(
    sshTarget,
    `tmux kill-session -t 'agent-${taskId}' 2>/dev/null || true`,
  );

  if (cleanup) {
    // Read registry to find worktree path, then remove
    const registry = await readTaskRegistry(sshTarget);
    const task = registry.tasks.find((t) => t.id === taskId);
    if (task) {
      await executeRemote(
        sshTarget,
        `cd '${task.worktree}/.' && cd .. && git worktree remove '${task.worktree}' --force 2>/dev/null || true`,
      );
      await executeRemote(
        sshTarget,
        `git -C '${task.worktree}/../..' branch -D '${task.branch}' 2>/dev/null || true`,
      );
    }
  }
}

export async function getAgentOutput(
  sshTarget: string,
  taskId: string,
  lines: number = 100,
): Promise<string> {
  return executeRemote(
    sshTarget,
    `tail -n ${lines} ~/.agent-swarm/logs/${taskId}.log 2>/dev/null || echo 'No log file found'`,
  );
}

export async function runReview(
  sshTarget: string,
  taskId: string,
): Promise<void> {
  await executeRemote(
    sshTarget,
    `~/.agent-swarm/review-pr.sh '${taskId}'`,
    300_000, // 5 min timeout for reviews
  );
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.skills.config.ts .claude/skills/add-agent-swarm/tests/agent-swarm.test.ts`
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
- Create: `.claude/skills/add-agent-swarm/remote/check-agents.sh`
- Create: `.claude/skills/add-agent-swarm/remote/review-pr.sh`
- Create: `.claude/skills/add-agent-swarm/remote/cleanup-worktrees.sh`
- Create: `.claude/skills/add-agent-swarm/remote/config.yaml.template`
- Create: `.claude/skills/add-agent-swarm/remote/setup-remote.sh`

These scripts run on the remote dev machine, not in NanoClaw.

**Step 1: Create `spawn-agent.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: spawn-agent.sh <repo_path> <branch_name> <prompt> <model> <task_id>

REPO_PATH="$1"
BRANCH_NAME="$2"
PROMPT="$3"
MODEL="$4"
TASK_ID="$5"

SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"
LOG_DIR="$SWARM_DIR/logs"

source "$SWARM_DIR/.env"

mkdir -p "$LOG_DIR"

# Create worktree
WORKTREE_DIR="$REPO_PATH/.worktrees/$TASK_ID"
cd "$REPO_PATH"
git fetch origin main
git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" origin/main 2>/dev/null || \
  git worktree add "$WORKTREE_DIR" "$BRANCH_NAME"

# Install deps
cd "$WORKTREE_DIR"
if [ -f "pnpm-lock.yaml" ]; then
  pnpm install --frozen-lockfile
elif [ -f "package-lock.json" ]; then
  npm ci
elif [ -f "yarn.lock" ]; then
  yarn install --frozen-lockfile
fi

# Build agent command based on model
case "$MODEL" in
  claude-code:opus)
    AGENT_CMD="claude --model claude-opus-4-6 --dangerously-skip-permissions -p '$PROMPT'"
    ;;
  claude-code:sonnet)
    AGENT_CMD="claude --model claude-sonnet-4-6 --dangerously-skip-permissions -p '$PROMPT'"
    ;;
  claude-code:haiku)
    AGENT_CMD="claude --model claude-haiku-4-5-20251001 --dangerously-skip-permissions -p '$PROMPT'"
    ;;
  codex)
    AGENT_CMD="codex --model gpt-5.3-codex -c 'model_reasoning_effort=high' --dangerously-bypass-approvals-and-sandbox '$PROMPT'"
    ;;
  *)
    echo "Unknown model: $MODEL" >&2
    exit 1
    ;;
esac

# Launch in tmux with logging
tmux new-session -d -s "agent-$TASK_ID" \
  -c "$WORKTREE_DIR" \
  "source $SWARM_DIR/.env; $AGENT_CMD 2>&1 | tee $LOG_DIR/$TASK_ID.log; echo '=== AGENT EXITED ===' >> $LOG_DIR/$TASK_ID.log"

# Update registry
if [ ! -f "$REGISTRY" ]; then
  echo '{"tasks":[]}' > "$REGISTRY"
fi

# Use jq to add task entry
jq --arg id "$TASK_ID" \
   --arg repo "$(basename "$REPO_PATH")" \
   --arg branch "$BRANCH_NAME" \
   --arg worktree "$WORKTREE_DIR" \
   --arg model "$MODEL" \
   --arg prompt "$PROMPT" \
   --arg started "$(date +%s)000" \
   '.tasks += [{
     id: $id,
     repo: $repo,
     branch: $branch,
     worktree: $worktree,
     tmuxSession: ("agent-" + $id),
     model: $model,
     prompt: $prompt,
     status: "running",
     priority: "normal",
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

**Step 2: Create `check-agents.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Deterministic status checker — no LLM tokens burned.
# Outputs JSON array of AgentStatus objects.

SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"

if [ ! -f "$REGISTRY" ]; then
  echo "[]"
  exit 0
fi

# Process each active task
jq -c '.tasks[] | select(.status != "merged" and .status != "failed")' "$REGISTRY" | while IFS= read -r task; do
  TASK_ID=$(echo "$task" | jq -r '.id')
  BRANCH=$(echo "$task" | jq -r '.branch')
  REPO=$(echo "$task" | jq -r '.repo')
  WORKTREE=$(echo "$task" | jq -r '.worktree')

  # Check tmux session
  TMUX_ALIVE=false
  if tmux has-session -t "agent-$TASK_ID" 2>/dev/null; then
    TMUX_ALIVE=true
  fi

  # Check for PR
  PR_NUM=""
  CI_STATUS="null"
  REVIEW_STATUS="null"
  CRITICAL=0
  HAS_SCREENSHOTS=false

  if [ -d "$WORKTREE" ]; then
    cd "$WORKTREE"
    PR_NUM=$(gh pr view "$BRANCH" --json number -q .number 2>/dev/null || echo "")

    if [ -n "$PR_NUM" ]; then
      # Check CI
      CI_RAW=$(gh pr checks "$PR_NUM" --json state -q '.[].state' 2>/dev/null | sort -u || echo "")
      if echo "$CI_RAW" | grep -q "FAILURE"; then
        CI_STATUS='"failing"'
      elif echo "$CI_RAW" | grep -q "SUCCESS"; then
        CI_STATUS='"passing"'
      elif [ -n "$CI_RAW" ]; then
        CI_STATUS='"pending"'
      fi

      # Check reviews
      REVIEW_RAW=$(gh pr view "$PR_NUM" --json reviewDecision -q .reviewDecision 2>/dev/null || echo "")
      case "$REVIEW_RAW" in
        APPROVED) REVIEW_STATUS='"approved"' ;;
        CHANGES_REQUESTED) REVIEW_STATUS='"changes_requested"' ;;
        *) REVIEW_STATUS='"pending"' ;;
      esac

      # Count critical comments
      CRITICAL=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUM/comments" \
        --jq '[.[] | select(.body | test("critical|blocker"; "i"))] | length' 2>/dev/null || echo "0")

      # Check for screenshots in PR body
      HAS_SCREENSHOTS=$(gh pr view "$PR_NUM" --json body -q '.body' 2>/dev/null | grep -cq '!\[' && echo true || echo false)
    fi
  fi

  # Output status JSON line
  jq -n \
    --arg id "$TASK_ID" \
    --argjson tmux "$TMUX_ALIVE" \
    --argjson pr "${PR_NUM:-null}" \
    --argjson ci "$CI_STATUS" \
    --argjson review "$REVIEW_STATUS" \
    --argjson critical "$CRITICAL" \
    --argjson screenshots "$HAS_SCREENSHOTS" \
    '{id:$id, tmux_alive:$tmux, pr_number:$pr, ci_status:$ci, review_status:$review, critical_comments:$critical, has_screenshots:$screenshots}'
done | jq -s '.'
```

**Step 3: Create `review-pr.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Triggers multi-model PR review for a task.
# Usage: review-pr.sh <task_id>

TASK_ID="$1"
SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"
LOG_DIR="$SWARM_DIR/logs"

source "$SWARM_DIR/.env"

TASK=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' "$REGISTRY")
WORKTREE=$(echo "$TASK" | jq -r '.worktree')
BRANCH=$(echo "$TASK" | jq -r '.branch')

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

DIFF=$(gh pr diff "$PR_NUM")

# Run reviews in parallel
echo "Starting code reviews for PR #$PR_NUM..."

# Codex reviewer (thorough — edge cases, logic errors, race conditions)
if [ -n "${OPENAI_API_KEY:-}" ]; then
  (
    cd "$WORKTREE"
    codex --model gpt-5.3-codex \
      --dangerously-bypass-approvals-and-sandbox \
      "Review this PR diff. Focus on: logic errors, missing error handling, race conditions, edge cases. Be specific. Post your findings as a single review comment.

$DIFF" 2>&1 | tee "$LOG_DIR/review-codex-$TASK_ID.log"
  ) &
  CODEX_PID=$!
fi

# Claude Code reviewer (validation — critical issues only)
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  (
    cd "$WORKTREE"
    claude --model claude-sonnet-4-6 \
      --dangerously-skip-permissions \
      -p "Review this PR diff. Only flag critical issues. Skip style suggestions. Post findings as gh pr review comment on PR #$PR_NUM.

$DIFF" 2>&1 | tee "$LOG_DIR/review-claude-$TASK_ID.log"
  ) &
  CLAUDE_PID=$!
fi

# Wait for parallel reviews
[ -n "${CODEX_PID:-}" ] && wait "$CODEX_PID" || true
[ -n "${CLAUDE_PID:-}" ] && wait "$CLAUDE_PID" || true

# Gemini Code Assist reviews automatically via GitHub App — no action needed

echo "Reviews complete for PR #$PR_NUM"
```

**Step 4: Create `cleanup-worktrees.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Daily cleanup of merged/failed task worktrees and stale tmux sessions.
# Usage: cleanup-worktrees.sh

SWARM_DIR="$HOME/.agent-swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"

if [ ! -f "$REGISTRY" ]; then
  exit 0
fi

# Clean up completed/failed tasks older than 24 hours
CUTOFF=$(( $(date +%s) - 86400 ))

jq -c '.tasks[] | select((.status == "merged" or .status == "failed") and (.completedAt != null) and ((.completedAt / 1000) < '"$CUTOFF"'))' "$REGISTRY" | while IFS= read -r task; do
  TASK_ID=$(echo "$task" | jq -r '.id')
  WORKTREE=$(echo "$task" | jq -r '.worktree')
  BRANCH=$(echo "$task" | jq -r '.branch')

  echo "Cleaning up: $TASK_ID"

  # Kill tmux if somehow still alive
  tmux kill-session -t "agent-$TASK_ID" 2>/dev/null || true

  # Remove worktree
  if [ -d "$WORKTREE" ]; then
    REPO_ROOT=$(cd "$WORKTREE/.." && cd "$(git rev-parse --show-toplevel)" && pwd)
    cd "$REPO_ROOT"
    git worktree remove "$WORKTREE" --force 2>/dev/null || true
  fi

  # Remove stale log
  rm -f "$SWARM_DIR/logs/$TASK_ID.log"
  rm -f "$SWARM_DIR/logs/review-codex-$TASK_ID.log"
  rm -f "$SWARM_DIR/logs/review-claude-$TASK_ID.log"
done

# Remove cleaned tasks from registry
jq --argjson cutoff "$CUTOFF" \
  '.tasks |= [.[] | select(
    .status == "running" or .status == "pr_created" or .status == "reviewing" or .status == "ready_for_review" or
    ((.completedAt == null) or ((.completedAt / 1000) >= $cutoff))
  )]' "$REGISTRY" > "$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"

echo "Cleanup complete"
```

**Step 5: Create `setup-remote.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Bootstrap ~/.agent-swarm on the remote machine.
# Usage: setup-remote.sh

SWARM_DIR="$HOME/.agent-swarm"

echo "Setting up agent swarm at $SWARM_DIR..."

mkdir -p "$SWARM_DIR/logs"

# Initialize empty registry
if [ ! -f "$SWARM_DIR/active-tasks.json" ]; then
  echo '{"tasks":[]}' > "$SWARM_DIR/active-tasks.json"
fi

# Make scripts executable
chmod +x "$SWARM_DIR/spawn-agent.sh"
chmod +x "$SWARM_DIR/check-agents.sh"
chmod +x "$SWARM_DIR/review-pr.sh"
chmod +x "$SWARM_DIR/cleanup-worktrees.sh"

# Check prerequisites
echo "Checking prerequisites..."
command -v git >/dev/null || { echo "FAIL: git not installed"; exit 1; }
command -v tmux >/dev/null || { echo "FAIL: tmux not installed"; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq not installed"; exit 1; }
command -v gh >/dev/null || { echo "FAIL: gh CLI not installed"; exit 1; }
command -v node >/dev/null || { echo "FAIL: node not installed"; exit 1; }

# Check optional CLIs
command -v claude >/dev/null && echo "OK: claude CLI found" || echo "WARN: claude CLI not found — Claude Code agents won't work"
command -v codex >/dev/null && echo "OK: codex CLI found" || echo "WARN: codex CLI not found — Codex agents won't work"

# Check gh auth
gh auth status >/dev/null 2>&1 && echo "OK: gh authenticated" || echo "WARN: gh not authenticated — run 'gh auth login'"

# Prompt for API keys if .env doesn't exist
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

# Configure tmux logging
if ! grep -q 'history-limit' ~/.tmux.conf 2>/dev/null; then
  echo 'set -g history-limit 50000' >> ~/.tmux.conf
  echo "Added tmux history-limit to ~/.tmux.conf"
fi

echo ""
echo "Setup complete. Add your repos to $SWARM_DIR/config.yaml"
```

**Step 6: Create `config.yaml.template`**

```yaml
# Agent Swarm Configuration
# Copy to ~/.agent-swarm/config.yaml and edit

repos:
  project-a:
    path: /home/dev/project-a
    description: "SaaS backend"
    default_model: codex
    install_command: "npm ci"

  project-b:
    path: /home/dev/project-b
    description: "SaaS frontend"
    default_model: "claude-code:sonnet"
    install_command: "pnpm install --frozen-lockfile"

# Max concurrent agents (depends on RAM)
max_concurrent: 4

# Max retries for failed agents
max_retries: 3
```

**Step 7: Make scripts executable and commit**

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

**Step 1: Create the MCP tools modify file**

Start from the current `container/agent-runner/src/ipc-mcp-stdio.ts` and add five new MCP tools after the existing tools. All five are restricted to main group only (the orchestrator group).

**New tools to add:**

```typescript
// --- Agent Swarm Tools (main group only) ---

server.tool(
  'spawn_agent',
  'Spawn a coding agent on the remote dev machine. Creates a git worktree, installs dependencies, and launches the agent in a tmux session. Returns the task ID.',
  {
    repo: z.string().describe('Repository name from config (e.g., "project-a")'),
    branch_name: z
      .string()
      .describe('Git branch name to create (e.g., "feat/custom-templates")'),
    prompt: z
      .string()
      .describe('The full prompt/instructions for the coding agent'),
    model: z
      .enum([
        'claude-code:opus',
        'claude-code:sonnet',
        'claude-code:haiku',
        'codex',
      ])
      .describe('Which model/agent to use'),
    priority: z
      .enum(['high', 'normal', 'low'])
      .default('normal')
      .describe('Task priority — affects retry behavior'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the orchestrator group can spawn agents.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'swarm_spawn',
      repo: args.repo,
      branchName: args.branch_name,
      prompt: args.prompt,
      model: args.model,
      priority: args.priority,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Spawning agent: repo=${args.repo}, branch=${args.branch_name}, model=${args.model}. Use check_agents to monitor status.`,
        },
      ],
    };
  },
);

server.tool(
  'check_agents',
  'Check the status of all running coding agents on the remote machine. Returns per-agent status including tmux alive, PR number, CI status, and review status. No LLM tokens burned — uses deterministic shell script.',
  {},
  async () => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the orchestrator group can check agents.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'swarm_check',
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Agent status check requested. Results will be written to /workspace/group/swarm-status.json.',
        },
      ],
    };
  },
);

server.tool(
  'redirect_agent',
  'Send a correction or additional context to a running agent via tmux. Use when an agent is going the wrong direction or needs more information.',
  {
    task_id: z.string().describe('The task ID of the agent to redirect'),
    message: z
      .string()
      .describe('The message to inject (e.g., "Stop. Focus on the API layer first.")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the orchestrator group can redirect agents.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'swarm_redirect',
      taskId: args.task_id,
      message: args.message,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Redirect sent to agent ${args.task_id}.`,
        },
      ],
    };
  },
);

server.tool(
  'kill_agent',
  'Kill a running agent and optionally clean up its worktree and branch.',
  {
    task_id: z.string().describe('The task ID of the agent to kill'),
    cleanup: z
      .boolean()
      .default(false)
      .describe('Also remove worktree and delete branch'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the orchestrator group can kill agents.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'swarm_kill',
      taskId: args.task_id,
      cleanup: args.cleanup,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Kill request sent for agent ${args.task_id}${args.cleanup ? ' (with cleanup)' : ''}.`,
        },
      ],
    };
  },
);

server.tool(
  'get_agent_output',
  'Read recent output from a running or completed agent. Useful for inspecting what the agent is doing or why it failed.',
  {
    task_id: z.string().describe('The task ID of the agent'),
    lines: z
      .number()
      .default(100)
      .describe('Number of lines to read from the end of the log'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the orchestrator group can read agent output.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'swarm_output',
      taskId: args.task_id,
      lines: args.lines,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Output request sent for agent ${args.task_id}. Results will be written to /workspace/group/swarm-output-${args.task_id}.txt.`,
        },
      ],
    };
  },
);
```

**Step 2: Create the IPC handler modify file**

Start from the current `src/ipc.ts` and add a new section inside `processTaskIpc` for swarm operations. Add `import { executeRemote, spawnAgent, checkAgents, redirectAgent, killAgent, getAgentOutput, runReview } from '../agent-swarm.js';` and import `SWARM_SSH_TARGET, SWARM_REPOS` from `../config.js`.

**New IPC cases to add (inside the `switch(data.type)` block):**

```typescript
case 'swarm_spawn': {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized swarm_spawn attempt');
    break;
  }
  const repoConfig = SWARM_REPOS[data.repo];
  if (!repoConfig) {
    logger.warn({ repo: data.repo }, 'Unknown repo in swarm_spawn');
    break;
  }
  try {
    const taskId = await spawnAgent(SWARM_SSH_TARGET, {
      repo: data.repo,
      repoPath: repoConfig.path,
      branchName: data.branchName,
      prompt: data.prompt,
      model: data.model,
      priority: data.priority,
    });
    logger.info({ taskId, repo: data.repo, model: data.model }, 'Swarm agent spawned');
  } catch (err) {
    logger.error({ err, repo: data.repo }, 'Failed to spawn swarm agent');
  }
  break;
}

case 'swarm_check': {
  if (!isMain) break;
  try {
    const statuses = await checkAgents(SWARM_SSH_TARGET);
    // Write results to orchestrator group folder for agent to read
    const groupDir = path.join(GROUPS_DIR, sourceGroup);
    fs.writeFileSync(
      path.join(groupDir, 'swarm-status.json'),
      JSON.stringify(statuses, null, 2),
    );
    logger.info({ count: statuses.length }, 'Swarm status check complete');
  } catch (err) {
    logger.error({ err }, 'Failed to check swarm agents');
  }
  break;
}

case 'swarm_redirect': {
  if (!isMain) break;
  try {
    await redirectAgent(SWARM_SSH_TARGET, data.taskId, data.message);
    logger.info({ taskId: data.taskId }, 'Swarm agent redirected');
  } catch (err) {
    logger.error({ err, taskId: data.taskId }, 'Failed to redirect swarm agent');
  }
  break;
}

case 'swarm_kill': {
  if (!isMain) break;
  try {
    await killAgent(SWARM_SSH_TARGET, data.taskId, data.cleanup);
    logger.info({ taskId: data.taskId, cleanup: data.cleanup }, 'Swarm agent killed');
  } catch (err) {
    logger.error({ err, taskId: data.taskId }, 'Failed to kill swarm agent');
  }
  break;
}

case 'swarm_output': {
  if (!isMain) break;
  try {
    const output = await getAgentOutput(SWARM_SSH_TARGET, data.taskId, data.lines);
    const groupDir = path.join(GROUPS_DIR, sourceGroup);
    fs.writeFileSync(
      path.join(groupDir, `swarm-output-${data.taskId}.txt`),
      output,
    );
    logger.info({ taskId: data.taskId }, 'Swarm agent output retrieved');
  } catch (err) {
    logger.error({ err, taskId: data.taskId }, 'Failed to get swarm agent output');
  }
  break;
}
```

**Step 3: Create intent files**

Create `.claude/skills/add-agent-swarm/modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md`:
- **What this skill adds:** Five MCP tools for agent swarm management (spawn_agent, check_agents, redirect_agent, kill_agent, get_agent_output). All restricted to main group.
- **Key sections:** New tools added after existing tools. Each writes IPC files with `type: 'swarm_*'`.
- **Invariants:** Existing tools unchanged. Authorization pattern matches existing `isMain` checks.
- **Must-keep sections:** All existing tools (send_message, schedule_task, list_tasks, pause_task, resume_task, cancel_task, register_group, refresh_groups).

Create `.claude/skills/add-agent-swarm/modify/src/ipc.ts.intent.md`:
- **What this skill adds:** Five IPC handler cases for swarm operations. Each calls the SSH bridge module (`agent-swarm.ts`). Results written to group folder files for agent to read.
- **Key sections:** New cases in `processTaskIpc` switch statement. New imports for swarm module and config.
- **Invariants:** Existing IPC cases unchanged. Authorization via `isMain` check. Error handling follows existing pattern (log + break).
- **Must-keep sections:** All existing IPC cases (message, schedule_task, pause/resume/cancel_task, register_group, refresh_groups).

**Step 4: Commit**

```bash
git add .claude/skills/add-agent-swarm/modify/
git commit -m "feat: add MCP tools and IPC handlers for agent swarm"
```

---

### Task 4: Config and environment variables

**Files:**
- Create: `.claude/skills/add-agent-swarm/modify/src/config.ts`
- Create: `.claude/skills/add-agent-swarm/modify/src/config.ts.intent.md`

**Step 1: Add swarm config to the config.ts modify file**

Start from current `src/config.ts` and add:

```typescript
// Agent Swarm config
export const SWARM_SSH_TARGET = process.env.SWARM_SSH_TARGET || envConfig.SWARM_SSH_TARGET || '';
export const SWARM_ENABLED = !!SWARM_SSH_TARGET;

// Parse repo config from SWARM_REPOS_JSON env var
// Format: {"project-a": {"path": "/home/dev/project-a"}, ...}
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

Also add `'SWARM_SSH_TARGET'` and `'SWARM_REPOS_JSON'` to the `readEnvFile()` call.

**Step 2: Create intent file**

Create `.claude/skills/add-agent-swarm/modify/src/config.ts.intent.md`:
- **What this skill adds:** `SWARM_SSH_TARGET` (SSH connection string), `SWARM_ENABLED` (boolean), and `SWARM_REPOS` (parsed repo config) exports.
- **Invariants:** All existing config exports unchanged.
- **Must-keep sections:** All existing env var loading, paths, intervals.

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
  writeTaskRegistry: vi.fn(),
  spawnAgent: vi.fn(),
  getAgentOutput: vi.fn(),
  runReview: vi.fn(),
}));

describe('agent-swarm-monitor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('detects ready-for-review tasks', async () => {
    const { checkAgents, readTaskRegistry } = await import(
      '../add/src/agent-swarm.js'
    );
    const { evaluateAgents } = await import(
      '../add/src/agent-swarm-monitor.js'
    );

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

    const actions = await evaluateAgents('dev@remote', {});
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

    const actions = await evaluateAgents('dev@remote', {});
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

    const actions = await evaluateAgents('dev@remote', {});
    expect(actions).toContainEqual(
      expect.objectContaining({
        taskId: 'fix-z',
        action: 'notify_failed',
      }),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.skills.config.ts .claude/skills/add-agent-swarm/tests/agent-swarm-monitor.test.ts`
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
  repoConfig: Record<string, { path: string }>,
): Promise<MonitorAction[]> {
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

    // PR exists — check CI and reviews
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

      // CI passing + no critical comments → ready for human review
      if (
        status.ci_status === 'passing' &&
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

Run: `npx vitest run --config vitest.skills.config.ts .claude/skills/add-agent-swarm/tests/agent-swarm-monitor.test.ts`
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
description: "Orchestrate a fleet of Claude Code / Codex / Gemini coding agents on a remote machine via SSH"
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
test: "npx vitest run src/ipc.test.ts"
```

**Step 2: Create SKILL.md**

Write a 4-phase SKILL.md following the pattern from `/add-media-support/SKILL.md`:

- **Phase 1 (Pre-flight):** Check `.nanoclaw/state.yaml` — if `agent-swarm` already applied, skip to Phase 4. If `.nanoclaw/` doesn't exist, initialize with `initNanoclawDir()`. Verify SSH connectivity to remote machine.
- **Phase 2 (Apply):** Run `npx tsx scripts/apply-skill.ts .claude/skills/add-agent-swarm`. Build with `npm run build`. No new npm deps needed.
- **Phase 3 (Configure):**
  1. Add `SWARM_SSH_TARGET=user@remote-host` to `.env`
  2. Add `SWARM_REPOS_JSON={"project-a":{"path":"/home/dev/project-a"}}` to `.env`
  3. Copy remote scripts to remote machine: `scp -r .claude/skills/add-agent-swarm/remote/* $SWARM_SSH_TARGET:~/.agent-swarm/`
  4. Run remote setup: `ssh $SWARM_SSH_TARGET '~/.agent-swarm/setup-remote.sh'`
  5. Create orchestrator WhatsApp group and register it as the main group (or use existing main group)
  6. Copy `templates/orchestrator-claude.md` to the orchestrator group's `CLAUDE.md` and customize
  7. Schedule monitor task: agent calls `schedule_task(prompt: "Run check_agents and evaluate results...", schedule_type: "interval", schedule_value: "600000")`
  8. Rebuild container: `./container/build.sh`
  9. Restart NanoClaw
- **Phase 4 (Verify):** Test by sending "Spawn a test agent on project-a, branch test/hello-world, prompt 'Create a file hello.txt with Hello World', model claude-code:haiku" to the orchestrator group. Verify tmux session appears on remote. Verify `check_agents` returns the running task.

**Step 3: Create orchestrator CLAUDE.md template**

Write `templates/orchestrator-claude.md` with the structure from the design doc (Identity, Repos, Model Routing Rules, Prompt Writing Rules, Business Context, Learnings, Active Context sections).

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
ls -la .claude/skills/add-agent-swarm/modify/src/ipc.ts
ls -la .claude/skills/add-agent-swarm/modify/src/ipc.ts.intent.md
ls -la .claude/skills/add-agent-swarm/modify/src/config.ts
ls -la .claude/skills/add-agent-swarm/modify/container/agent-runner/src/ipc-mcp-stdio.ts
ls -la .claude/skills/add-agent-swarm/remote/spawn-agent.sh
ls -la .claude/skills/add-agent-swarm/remote/check-agents.sh
ls -la .claude/skills/add-agent-swarm/remote/review-pr.sh
ls -la .claude/skills/add-agent-swarm/remote/cleanup-worktrees.sh
ls -la .claude/skills/add-agent-swarm/remote/setup-remote.sh
```

**Step 2: Run skill unit tests**

```bash
npx vitest run --config vitest.skills.config.ts .claude/skills/add-agent-swarm/tests/
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
bash -n .claude/skills/add-agent-swarm/remote/check-agents.sh
bash -n .claude/skills/add-agent-swarm/remote/review-pr.sh
bash -n .claude/skills/add-agent-swarm/remote/cleanup-worktrees.sh
bash -n .claude/skills/add-agent-swarm/remote/setup-remote.sh
```

Expected: no syntax errors

**Step 5: Commit any fixes**

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
