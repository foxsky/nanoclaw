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
