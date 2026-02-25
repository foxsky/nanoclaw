# Agent Swarm Design — `/add-agent-swarm`

> NanoClaw skill that turns the orchestrator group into a dev team manager, spawning and monitoring Claude Code / Codex / Gemini agents on a remote machine via SSH.

## Problem

Using coding agents one at a time is bottlenecked by the human. You scope a task, spawn an agent, wait, review, merge, repeat. With an orchestrator agent holding business context and a fleet of worker agents running in parallel, throughput scales to dozens of PRs per day with minimal human intervention.

## Architecture

```
Your Phone (WhatsApp)
    ↕
NanoClaw Server
├── Orchestrator Group ("Zoe")
│   ├── CLAUDE.md (business context, learnings, project rules)
│   ├── MCP Tools: spawn_agent, check_agents, redirect_agent,
│   │              kill_agent, get_agent_output, run_review
│   └── Scheduled Tasks:
│       ├── monitor_agents (every 10 min)
│       └── cleanup_worktrees (daily)
│
    ↕ SSH
Remote Dev Machine
├── ~/.agent-swarm/
│   ├── config.yaml            (repos, models, SSH-local env)
│   ├── active-tasks.json      (task registry)
│   ├── check-agents.sh        (deterministic status checker)
│   ├── spawn-agent.sh         (worktree + tmux launcher)
│   ├── review-pr.sh           (multi-model PR review)
│   ├── cleanup-worktrees.sh   (daily orphan cleanup)
│   └── logs/                  (per-agent tmux output)
│
├── /home/dev/project-a/       (SaaS backend)
│   └── .worktrees/feat-xxx/
├── /home/dev/project-b/       (SaaS frontend)
│   └── .worktrees/fix-yyy/
└── /home/dev/project-c/       (infrastructure)
```

## MCP Tools

### `spawn_agent(repo, branch_name, prompt, model, priority?)`

Creates a git worktree, installs deps, launches the agent CLI in a tmux session with logging.

- `repo`: one of the configured repo names (e.g., `"project-a"`)
- `branch_name`: branch to create (e.g., `"feat/custom-templates"`)
- `model`: one of `claude-code:opus`, `claude-code:sonnet`, `claude-code:haiku`, `codex`, `gemini`
- `priority`: optional `"high"` | `"normal"` | `"low"` — affects retry behavior

Implementation:
```bash
# On remote via SSH:
cd $REPO_PATH
git worktree add .worktrees/$BRANCH_NAME -b $BRANCH_NAME origin/main
cd .worktrees/$BRANCH_NAME && npm install  # or pnpm/yarn

tmux new-session -d -s "agent-$BRANCH_NAME" \
  -c "$REPO_PATH/.worktrees/$BRANCH_NAME" \
  "$AGENT_CMD"

# $AGENT_CMD depends on model:
# claude-code:opus  → claude --model claude-opus-4-6 -p "$PROMPT"
# claude-code:sonnet → claude --model claude-sonnet-4-6 -p "$PROMPT"
# codex             → codex --model gpt-5.3-codex -c "model_reasoning_effort=high" "$PROMPT"
# gemini            → (gemini CLI or API call for design, then hand off to claude)
```

Writes entry to `active-tasks.json` and returns the task ID.

### `check_agents()`

Reads `active-tasks.json` and runs `check-agents.sh` via SSH. Returns per-agent status without burning LLM tokens.

Status fields per task:
- `tmux_alive`: boolean (is the tmux session still running?)
- `pr_number`: number | null (has a PR been created?)
- `ci_status`: `"pending"` | `"passing"` | `"failing"` | null
- `review_status`: `"pending"` | `"approved"` | `"changes_requested"` | null
- `critical_comments`: number (count of unresolved critical/blocker comments)
- `has_screenshots`: boolean (if UI change, are screenshots in PR?)

### `redirect_agent(task_id, message)`

Sends a correction to a running agent via `tmux send-keys`:
```bash
tmux send-keys -t "agent-$TASK_ID" "$MESSAGE" Enter
```

Use cases:
- "Stop. Focus on the API layer first, not the UI."
- "The schema is in src/types/template.ts. Use that."
- "Customer wants X, not Y. Here's what they said."

### `kill_agent(task_id, cleanup?)`

Kills the tmux session. If `cleanup=true`, also removes the worktree and deletes the remote branch.

### `get_agent_output(task_id, lines?)`

Tails the tmux log file. Defaults to last 100 lines. Lets the orchestrator inspect what an agent is doing or why it failed.

### `run_review(task_id)`

Triggers the multi-model PR review pipeline for a task's PR. Can be called manually or auto-triggered by the monitor loop.

## Task Registry (`active-tasks.json`)

```json
{
  "tasks": [
    {
      "id": "feat-templates",
      "repo": "project-a",
      "branch": "feat/custom-templates",
      "worktree": "/home/dev/project-a/.worktrees/feat-templates",
      "tmuxSession": "agent-feat-templates",
      "model": "codex",
      "prompt": "Implement template system for...",
      "status": "running",
      "priority": "high",
      "startedAt": 1740268800000,
      "retries": 0,
      "maxRetries": 3,
      "pr": null,
      "checks": {
        "ciPassed": false,
        "codexReviewPassed": false,
        "claudeReviewPassed": false,
        "geminiReviewPassed": false,
        "screenshotsIncluded": false
      },
      "completedAt": null,
      "notifyOnComplete": true
    }
  ]
}
```

Status lifecycle: `running` → `pr_created` → `reviewing` → `ready_for_review` → `merged` | `failed`

## Monitor Loop

A NanoClaw scheduled task runs every 10 minutes in the orchestrator group:

1. Call `check_agents()` — get status of all active tasks
2. For each task:

| Condition | Action |
|-----------|--------|
| tmux dead + no PR | Mark failed. If retries < max, respawn with failure context. |
| tmux dead + PR created | Trigger review pipeline. |
| PR + CI failing | Read CI logs. Respawn agent with fix context if retries left. |
| PR + CI pass + reviews pass + no critical comments | Mark `ready_for_review`. Notify user on WhatsApp. |
| PR + critical review comments | Read comments. Respawn agent with review feedback. |
| Already `ready_for_review` | Skip. |

3. On respawn, the orchestrator uses its business context and learnings to write a better prompt — not just "retry", but "here's what went wrong, here's the context you were missing."

## Code Review Pipeline

When a task reaches `pr_created` status, the monitor triggers three parallel reviews:

### Codex Reviewer (thorough)
```bash
cd $WORKTREE
codex -p "Review PR. Focus on: logic errors, missing error handling, race conditions, edge cases. Post findings as gh pr review comments." --dangerously-bypass-approvals-and-sandbox
```

### Gemini Code Assist (free)
GitHub App — installs once, auto-triggers on every PR. Catches security issues, scalability problems. No script needed.

### Claude Code Reviewer (validation)
```bash
cd $WORKTREE
claude -p "Review PR. Only flag critical issues. Skip style suggestions." --dangerously-skip-permissions
```

### Definition of Done
```bash
# check-agents.sh evaluates:
PR_NUM=$(gh pr view "$BRANCH" --json number -q .number 2>/dev/null)
CI_STATES=$(gh pr checks "$PR_NUM" --json state -q '.[].state' | sort -u)
CRITICAL=$(gh api repos/$OWNER/$REPO/pulls/$PR_NUM/comments \
  --jq '[.[] | select(.body | test("critical|blocker"; "i"))] | length')

if [[ "$CI_STATES" == "SUCCESS" && "$CRITICAL" == "0" ]]; then
  echo "ready_for_review"
fi
```

## Orchestrator CLAUDE.md Structure

The orchestrator group's `CLAUDE.md` is the brain — holds context worker agents never see:

```markdown
# Orchestrator Agent

## Identity
You are the engineering orchestrator. You manage a fleet of coding agents
working across multiple repos. You talk to the user via WhatsApp. You never
write code directly — you spawn agents, write their prompts, monitor
progress, and report results.

## Repos
- project-a: SaaS backend (Node/TypeScript) at /home/dev/project-a
- project-b: SaaS frontend (Next.js) at /home/dev/project-b
- project-c: Infrastructure (Terraform) at /home/dev/project-c

## Model Routing Rules
- Backend logic, complex bugs, multi-file refactors → codex
- Frontend components, UI fixes → claude-code:sonnet
- Complex architecture decisions → claude-code:opus
- UI design specs → gemini (design) → claude-code (implement)
- Quick fixes, typos, docs → claude-code:haiku

## Prompt Writing Rules
Always include in agent prompts:
- Relevant type definitions (copy actual types, don't reference)
- Test file paths to run
- Definition of done: PR with passing CI, screenshots if UI
- "Do NOT modify files outside of [specific directories]"

When retrying a failed agent:
- Read failure output first (get_agent_output)
- Include the specific error in the new prompt
- Narrow scope: "Focus only on [these files]"
- Reference past patterns from ## Learnings

## Business Context
[Grows over time — meeting notes, customer data, priorities]

### Current Priorities
- ...

### Customer Notes
- ...

## Learnings
[Auto-populated after successful/failed tasks]
- "Codex needs type definitions upfront for project-a billing module"
- "project-b E2E tests flaky on auth flow — always retry once"
- "Include test paths in prompt — agents skip tests otherwise"

## Active Context
[Updated by monitor loop — what's running now]
```

The `## Learnings` section is the self-improving part. After each task (success or failure), the orchestrator appends what it learned. Over time, prompts get more precise.

## Model Routing

| Task Type | Model | Why |
|-----------|-------|-----|
| Backend logic, complex bugs | Codex | Best multi-file reasoning |
| Frontend, UI components | Claude Code (Sonnet) | Fast, good at frontend |
| Complex architecture | Claude Code (Opus) | Deep reasoning |
| UI design specs | Gemini → Claude Code | Gemini designs, Claude implements |
| Quick fixes, typos, docs | Claude Code (Haiku) | Cheapest, fastest |

The orchestrator picks the model based on `## Model Routing Rules` in its CLAUDE.md. These rules evolve as the orchestrator learns which model performs best for which task type.

## Remote Machine Setup

### Prerequisites
- SSH access from NanoClaw server (key-based auth)
- Git, Node.js, tmux installed
- `gh` CLI authenticated (for PR creation and CI checks)
- Claude Code CLI installed and authenticated
- Codex CLI installed and authenticated
- Gemini Code Assist GitHub App installed on repos

### Bootstrap (`remote-setup.sh`)
1. Creates `~/.agent-swarm/` directory structure
2. Copies shell scripts (spawn, check, review, cleanup)
3. Prompts for API keys → writes to `~/.agent-swarm/.env`
4. Creates `config.yaml` with repo paths
5. Sets up tmux logging: `set -g history-limit 50000`
6. Verifies: SSH works, git access works, CLIs authenticated

### Environment (stays on remote machine)
```bash
# ~/.agent-swarm/.env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIza...
GITHUB_TOKEN=ghp_...
```

NanoClaw never stores or proxies these keys. Agents talk directly to their providers.

## Skill Structure

```
.claude/skills/add-agent-swarm/
├── SKILL.md                         (setup guide, 4 phases)
├── manifest.yaml
├── add/
│   ├── src/agent-swarm.ts           (SSH bridge + MCP tool handlers)
│   └── src/agent-swarm-monitor.ts   (monitor loop logic)
├── remote/                          (deployed to remote machine)
│   ├── spawn-agent.sh
│   ├── check-agents.sh
│   ├── review-pr.sh
│   ├── cleanup-worktrees.sh
│   └── config.yaml.template
├── modify/
│   ├── src/ipc.ts                   (register swarm MCP tools)
│   ├── src/ipc.ts.intent.md
│   └── container/agent-runner/src/ipc-mcp-stdio.ts
│       (expose swarm tools to orchestrator group's agent)
├── tests/
│   └── agent-swarm.test.ts
└── templates/
    └── orchestrator-claude.md       (starter CLAUDE.md for orchestrator group)
```

## Security Considerations

- SSH key used by NanoClaw should have restricted access (no root, no sudo)
- Remote API keys stored in `~/.agent-swarm/.env` with `chmod 600`
- Agent CLI flags (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`) are required for unattended operation — the code review pipeline + CI are the safety nets
- Worktrees are isolated branches — agents can't push to main directly
- `maxRetries` cap prevents infinite respawn loops
- Monitor loop is deterministic (shell script) — doesn't burn LLM tokens for status checks
- Orchestrator group should be a private WhatsApp group (you + the bot only)

## Cost Estimate

Based on Elvis's numbers and multi-vendor setup:
- Claude API: ~$100/month (Opus for complex, Sonnet for routine, Haiku for quick)
- Codex: ~$90/month (heavy backend workload)
- Gemini Code Assist: Free (GitHub App)
- Total: ~$190/month for a full "dev team"

Startable at ~$20/month with Claude Code only (Haiku + Sonnet), adding Codex and Opus as needed.

## Limitations

- **SSH latency**: Each tool call involves an SSH roundtrip (~100-500ms). Acceptable for spawn/check/kill operations.
- **No real-time streaming**: The orchestrator reads tmux logs on-demand, not in real-time. The 10-minute monitor loop is the heartbeat.
- **Single remote machine**: This design targets one dev machine. Multi-machine would need a registry/routing layer.
- **Agent CLI auth**: Claude Code and Codex CLIs need their own auth setup on the remote machine. This is a one-time manual step.
- **RAM on remote**: Each agent + worktree + node_modules + build uses ~2-4GB RAM. Plan for 4-5 concurrent agents on 16GB, more on 32GB+.
