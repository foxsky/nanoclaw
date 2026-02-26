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
