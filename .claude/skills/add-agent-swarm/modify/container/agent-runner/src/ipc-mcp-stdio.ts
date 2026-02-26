/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { randomUUID } from 'node:crypto';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

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

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

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

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
