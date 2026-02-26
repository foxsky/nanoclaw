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
2. Capture the returned task ID from the spawn response (for example: `test-hello-world-mtg4k2-ab12`)
3. On the remote machine: `tmux list-sessions` shows `agent-<task-id>`
4. After the agent finishes: a PR is created on the repo
5. Kill the test: `@<ASSISTANT_NAME> Kill agent <task-id> with cleanup`
