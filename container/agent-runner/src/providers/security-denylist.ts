// Single source of truth for the container agent's tool denylist.
//
// Split into two buckets so the *security boundary* is separable from the
// *parity/UX* preferences. claude.ts spreads both into SDK_DISALLOWED_TOOLS,
// preserving its existing public export and runtime behavior; the eventual
// non-default providers (opencode/codex, on the `providers` branch) should
// import SECURITY_DENYLIST and enforce it under their own permission/sandbox
// models — see the providers-branch follow-up.

// SECURITY BOUNDARY. Exposing any of these lets the agent escape the curated
// taskflow_*/api_* MCP surface and reach the RW-mounted global taskflow.db (or
// the rest of the filesystem) directly. EVERY provider must deny these.
//
// - Bash is the keystone — without it, taskflow.db (mounted RW at
//   /workspace/taskflow) is unreachable via the sqlite CLI.
// - Read/Glob/Grep/LS give filesystem reach; Write/Edit/MultiEdit give
//   persistence and tampering.
// - WebFetch/WebSearch are exfiltration vectors.
// - mcp__sqlite__*: raw database access bypasses the TaskFlow API surface and
//   normalizeAgentIds board-id pinning. These are enumerated explicitly (not a
//   glob) because the SDK disallowedTools matches exact tool ids and would not
//   expand a wildcard. Belt-and-suspenders with the allowlist side, where
//   mcpAllowPattern('sqlite') returns null — both mechanisms must remain.
export const SECURITY_DENYLIST: readonly string[] = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'mcp__sqlite__read_query',
  'mcp__sqlite__write_query',
  'mcp__sqlite__list_tables',
  'mcp__sqlite__describe_table',
  // #412 (audit MEDIUM + Codex): these SDK builtins are in TOOL_ALLOWLIST (advertised) but were denied
  // by NEITHER list — so the agent could actually call them. They are capability-ESCAPES, not parity:
  //  - Task/TaskOutput/TaskStop spawn + drive SUBAGENTS, which do NOT inherit this denylist/PreToolUse
  //    hook — a subagent with Bash reaches the RW-mounted taskflow.db, defeating the whole boundary.
  //  - TeamCreate/TeamDelete manage agent teams (another spawn/escape surface).
  //  - SendMessage is the SDK's built-in send — it bypasses the curated send_message MCP tool and its
  //    #410 broadcast/forward gate. (Confirmed present in @anthropic-ai/claude-agent-sdk sdk-tools.d.ts.)
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
];

// PARITY / UX ONLY — not a security boundary. These are deferred SDK builtins
// that sidestep nanoclaw's own scheduling / async message-passing model, or
// entries kept to preserve v1's recorded TaskFlow reply shape.
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a real
//   answer — we use mcp__nanoclaw__ask_user_question, which persists the
//   question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude Code UI
//   affordances; in a headless container they'd appear stuck.
// - ToolSearch: introduced by newer Claude Code/SDK builds. v1's recorded
//   TaskFlow behavior did not expose it, and Phase 2 replay shows it adds
//   selection-only tool calls before every routine MCP operation.
// - Agent / TodoWrite / Skill / NotebookEdit: general Claude Code workspace
//   tools. The TaskFlow v1 replay surface is MCP-tool driven; exposing these in
//   v2 caused routine greetings to spawn subagent/todo/notebook exploration
//   instead of the recorded no-tool behavior.
// - mcp__nanoclaw__ask_user_question: newer interactive card flow. v1 TaskFlow
//   asked ambiguity questions in plain text, so exposing this changes the
//   observable reply shape and adds extra tool calls in Phase 2 replay.
export const PARITY_DENYLIST: readonly string[] = [
  'Agent',
  'TodoWrite',
  'Skill',
  'NotebookEdit',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'ToolSearch',
  'mcp__nanoclaw__ask_user_question',
];
