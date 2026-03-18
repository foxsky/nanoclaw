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
import Database from 'better-sqlite3';
import {
  canUseCreateGroup,
  normalizeCreateGroupRequest,
} from './ipc-tooling.js';
import { TaskflowEngine } from './taskflow-engine.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const BUNDLED_MCP_PLUGIN_FILES = ['create-group.js'] as const;
// Allowlist: only reviewed plugins may register MCP tools.
// Bundled plugins are loaded from the agent-runner itself. The workspace
// directory is reserved for additional reviewed plugins that may be added later.
const ALLOWED_MCP_PLUGIN_FILES = new Set<string>();

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const isTaskflowManaged = process.env.NANOCLAW_IS_TASKFLOW_MANAGED === '1';
const taskflowHierarchyLevel =
  process.env.NANOCLAW_TASKFLOW_HIERARCHY_LEVEL !== undefined
    ? Number.parseInt(process.env.NANOCLAW_TASKFLOW_HIERARCHY_LEVEL, 10)
    : undefined;
const taskflowMaxDepth =
  process.env.NANOCLAW_TASKFLOW_MAX_DEPTH !== undefined
    ? Number.parseInt(process.env.NANOCLAW_TASKFLOW_MAX_DEPTH, 10)
    : undefined;

// Embedding config (shared by search wrapping + duplicate detection)
const ollamaHost = process.env.NANOCLAW_OLLAMA_HOST ?? '';
const embeddingModel = process.env.NANOCLAW_EMBEDDING_MODEL || 'bge-m3';
const EMBEDDINGS_DB_PATH = '/workspace/embeddings/embeddings.db';

/** Call Ollama embed API. Returns Float32Array or null on failure. */
async function ollamaEmbed(text: string): Promise<Float32Array | null> {
  if (!ollamaHost) return null;
  try {
    const resp = await fetch(`${ollamaHost}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embeddingModel, input: text }),
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { embeddings: number[][] };
    return data.embeddings?.[0] ? new Float32Array(data.embeddings[0]) : null;
  } catch {
    return null;
  }
}

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

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Queue a message for the user or group while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Optional role/identity label to use as the visible sender name. Channels that do not support separate bot identities will fall back to a text prefix.'),
    target_chat_jid: z.string().optional().describe('(Main and TaskFlow groups only) Send to a different group or DM by JID. Use for cross-group notifications or external participant DMs. Groups must be registered; DMs must be known external contacts.'),
  },
  async (args) => {
    const isCrossGroupAttempt =
      args.target_chat_jid !== undefined && args.target_chat_jid !== chatJid;
    if (isCrossGroupAttempt && !isMain && !isTaskflowManaged) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group and TaskFlow-managed groups can target a different group.',
          },
        ],
        isError: true,
      };
    }
    if (
      args.target_chat_jid &&
      !args.target_chat_jid.endsWith('@g.us') &&
      !args.target_chat_jid.endsWith('@s.whatsapp.net')
    ) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'target_chat_jid must be a WhatsApp JID ending in "@g.us" or "@s.whatsapp.net".',
          },
        ],
        isError: true,
      };
    }

    const targetJid = args.target_chat_jid ?? chatJid;

    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid: targetJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    const targetDescription =
      targetJid === chatJid ? 'this group' : targetJid;
    return {
      content: [
        {
          type: 'text' as const,
          text: `Message queued for delivery to ${targetDescription}. Delivery will be skipped if the target group is not registered or not authorized.`,
        },
      ],
    };
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

MESSAGING BEHAVIOR - The task agent should use send_message for any output that must reach the user or group. Plain result text is forwarded as a fallback, but send_message is the reliable path. Wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT:
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Any timestamp the host parser accepts (e.g., "2026-02-01T15:30:00" for local time or "2026-02-01T15:30:00Z" for UTC).`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: timestamp like "2026-02-01T15:30:00" or "2026-02-01T15:30:00Z"'),
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
      const ms = Number(args.schedule_value);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use a valid timestamp like "2026-02-01T15:30:00" or "2026-02-01T15:30:00Z".` }],
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
    taskflow_managed: z.boolean().optional().describe('Set true for TaskFlow-provisioned groups. When true, hierarchy metadata is also required.'),
    taskflow_hierarchy_level: z.number().int().min(0).optional().describe('0-based TaskFlow runtime level. Required when taskflow_managed=true.'),
    taskflow_max_depth: z.number().int().min(0).optional().describe('TaskFlow maximum depth. Required when taskflow_managed=true.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    if (
      args.taskflow_managed === true &&
      (
        args.taskflow_hierarchy_level === undefined ||
        args.taskflow_max_depth === undefined
      )
    ) {
      return {
        content: [{ type: 'text' as const, text: 'TaskFlow groups require taskflow_hierarchy_level and taskflow_max_depth.' }],
        isError: true,
      };
    }

    if (
      args.taskflow_managed === true &&
      args.taskflow_hierarchy_level !== undefined &&
      args.taskflow_max_depth !== undefined &&
      args.taskflow_hierarchy_level > args.taskflow_max_depth
    ) {
      return {
        content: [{ type: 'text' as const, text: 'TaskFlow hierarchy level cannot exceed taskflow_max_depth.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      taskflowManaged: args.taskflow_managed,
      taskflowHierarchyLevel: args.taskflow_hierarchy_level,
      taskflowMaxDepth: args.taskflow_max_depth,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'create_group',
  `Create a new WhatsApp group. Main can create any group. TaskFlow-managed groups can create child groups only when their next runtime level still fits under taskflow_max_depth. The host creates the group asynchronously, so this tool confirms the request was queued, not the final group JID.`,
  {
    subject: z.string().describe('Group subject/name'),
    participants: z
      .array(z.string())
      .describe(
        'WhatsApp user JIDs to add (e.g. "5585999998888@s.whatsapp.net")',
      ),
  },
  async (args) => {
    const createGroupContext = {
      isMain,
      isTaskflowManaged,
      taskflowHierarchyLevel,
      taskflowMaxDepth,
    };

    if (!canUseCreateGroup(createGroupContext)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'This group is not allowed to create new groups.',
          },
        ],
        isError: true,
      };
    }

    const normalized = normalizeCreateGroupRequest(
      args.subject,
      args.participants,
    );
    if (!normalized) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Invalid create_group request. Use a non-empty subject (max 100 chars) and 1-256 unique WhatsApp user JIDs.',
          },
        ],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'create_group',
      subject: normalized.subject,
      participants: normalized.participants,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Group creation requested. The host will create it asynchronously.',
        },
      ],
    };
  },
);

server.tool(
  'provision_child_board',
  'Provision a child board for a person on a hierarchy board. Creates a WhatsApp group, registers it, seeds the board database, generates CLAUDE.md, and schedules runners. Only non-leaf TaskFlow boards can provision children. The host processes this asynchronously.',
  {
    person_id: z
      .string()
      .describe('The person_id from board_people (e.g., "joao")'),
    person_name: z.string().describe('Display name (e.g., "João")'),
    person_phone: z
      .string()
      .describe('Phone number, digits only (e.g., "5585999990000")'),
    person_role: z.string().describe('Job role (e.g., "desenvolvedor")'),
    group_name: z
      .string()
      .optional()
      .describe(
        'WhatsApp group name — MUST be the division/sector name (e.g., "SETD-SECTI - TaskFlow"), never the person name. Falls back to person name if omitted (not recommended).',
      ),
    group_folder: z
      .string()
      .optional()
      .describe(
        'Folder name — MUST be the division/sector abbreviation (e.g., "setd-secti-taskflow"), never the person name. Falls back to person_id if omitted (not recommended).',
      ),
  },
  async (args) => {
    if (
      !canUseCreateGroup({
        isMain: false,
        isTaskflowManaged,
        taskflowHierarchyLevel,
        taskflowMaxDepth,
      })
    ) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only non-leaf TaskFlow-managed groups can provision child boards.',
          },
        ],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'provision_child_board',
      person_id: args.person_id,
      person_name: args.person_name,
      person_phone: args.person_phone,
      person_role: args.person_role,
      group_name: args.group_name,
      group_folder: args.group_folder,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Child board provisioning requested. The host will create the WhatsApp group, register it, seed the database, generate CLAUDE.md, and schedule runners asynchronously.',
        },
      ],
    };
  },
);

// Register TaskFlow tools only for TaskFlow-managed groups
if (process.env.NANOCLAW_IS_TASKFLOW_MANAGED === '1') {
  const dbPath = '/workspace/taskflow/taskflow.db';
  const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID;

  if (boardId) {
    const tfDb = new Database(dbPath);
    process.on('exit', () => tfDb.close());
    const engine = new TaskflowEngine(tfDb, boardId);

    /** Write IPC message files for any notifications returned by the engine. */
    function dispatchNotifications(result: Record<string, unknown>): void {
      if (Array.isArray(result.notifications)) {
        for (const notif of result.notifications as Array<{
          target_kind?: 'group' | 'dm';
          target_person_id?: string;
          notification_group_jid?: string | null;
          target_chat_jid?: string | null;
          message: string;
        }>) {
          // Determine target JID: new DM-aware shape or legacy group-only shape
          const targetJid =
            notif.target_kind === 'dm'
              ? notif.target_chat_jid
              : notif.notification_group_jid;
          if (targetJid) {
            writeIpcFile(MESSAGES_DIR, {
              type: 'message',
              chatJid: targetJid,
              text: notif.message,
              groupFolder,
              timestamp: new Date().toISOString(),
            });
          } else if (notif.target_kind !== 'dm' && notif.target_person_id) {
            // Person has no notification group yet (board being provisioned).
            // Write a deferred notification — the orchestrator will dispatch
            // it once the board is provisioned and notification_group_jid is set.
            writeIpcFile(TASKS_DIR, {
              type: 'deferred_notification',
              target_person_id: notif.target_person_id,
              text: notif.message,
              groupFolder,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
      // Keep the parent_notification block unchanged
      const pn = result.parent_notification as { parent_group_jid?: string; message?: string } | undefined;
      if (pn?.parent_group_jid && pn.message) {
        writeIpcFile(MESSAGES_DIR, {
          type: 'message',
          chatJid: pn.parent_group_jid,
          text: pn.message,
          groupFolder,
          timestamp: new Date().toISOString(),
        });
      }
    }

    function stripDispatchOnlyFields(
      result: Record<string, unknown>,
    ): Record<string, unknown> {
      const sanitized = { ...result };
      delete sanitized.notifications;
      delete sanitized.parent_notification;
      return sanitized;
    }

    server.tool(
      'taskflow_query',
      'Query the TaskFlow board. Returns structured data for board views, task details, search, statistics, etc.',
      {
        query: z.enum(['board', 'inbox', 'review', 'in_progress', 'next_action', 'waiting',
          'my_tasks', 'overdue', 'due_today', 'due_tomorrow', 'due_this_week', 'next_7_days',
          'search', 'urgent', 'high_priority', 'by_label', 'completed_today', 'completed_this_week',
          'completed_this_month', 'person_tasks', 'person_waiting', 'person_completed', 'person_review',
          'task_details', 'task_history', 'archive', 'archive_search', 'agenda', 'agenda_week',
          'changes_today', 'changes_since', 'changes_this_week', 'statistics', 'person_statistics',
          'month_statistics', 'summary',
          'meetings', 'meeting_agenda', 'meeting_minutes', 'upcoming_meetings',
          'meeting_participants', 'meeting_open_items', 'meeting_history', 'meeting_minutes_at']).describe('Query type'),
        sender_name: z.string().optional().describe('Sender name for my_tasks'),
        person_name: z.string().optional().describe('Person name for person_* queries'),
        task_id: z.string().optional().describe('Task ID for task_details/history'),
        search_text: z.string().optional().describe('Search text'),
        label: z.string().optional().describe('Label filter'),
        since: z.string().optional().describe('ISO date for changes_since'),
        at: z.string().optional().describe('Date (YYYY-MM-DD) for meeting_minutes_at query'),
      },
      async (args: any) => {
        // Semantic search: embed query text, inject reader + vector into engine
        if (args.query === 'search' && args.search_text) {
          const queryVector = await ollamaEmbed(args.search_text);
          if (queryVector) {
            const { EmbeddingReader } = await import('./embedding-reader.js');
            args.query_vector = queryVector;
            args.embedding_reader = new EmbeddingReader(EMBEDDINGS_DB_PATH);
          }
        }
        let result: ReturnType<typeof engine.query>;
        try {
          result = engine.query(args);
        } finally {
          if (args.embedding_reader) {
            try { args.embedding_reader.close(); } catch {}
          }
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: !result.success,
        };
      },
    );

    server.tool(
      'taskflow_create',
      'Create a new task on the TaskFlow board.',
      {
        type: z.enum(['simple', 'project', 'recurring', 'inbox', 'meeting']).describe('Task type'),
        title: z.string().describe('Task title'),
        assignee: z.string().optional().describe('Person to assign the task to'),
        due_date: z.string().optional().describe('Due date (ISO format)'),
        allow_non_business_day: z.boolean().optional().describe('Allow due_date on weekends/holidays'),
        scheduled_at: z.string().optional().describe('Scheduled datetime (ISO-8601 UTC) for meetings'),
        participants: z.array(z.string()).optional().describe('Participant names for meetings'),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Task priority'),
        labels: z.array(z.string()).optional().describe('Labels to attach'),
        subtasks: z.array(z.union([
          z.string(),
          z.object({ title: z.string(), assignee: z.string().optional() }),
        ])).optional().describe('Subtask titles (strings) or objects with title and optional assignee'),
        recurrence: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional().describe('Recurrence pattern (for recurring type)'),
        recurrence_anchor: z.string().optional().describe('Recurrence anchor date (ISO format)'),
        max_cycles: z.number().int().positive().optional().describe('Maximum number of cycles before expiry (mutually exclusive with recurrence_end_date)'),
        recurrence_end_date: z.string().optional().describe('ISO date after which recurrence stops (mutually exclusive with max_cycles)'),
        sender_name: z.string().describe('Name of the person creating the task'),
        force_create: z.boolean().optional().describe('Skip duplicate detection (set true after user confirms a duplicate warning)'),
      },
      async (args: any) => {
        // Duplicate detection — embed title, check for similar existing tasks
        // Always check, even with force_create — block >= 95% duplicates unconditionally
        try {
          const titleText = [args.title, args.description].filter(Boolean).join(' ');
          const vector = await ollamaEmbed(titleText);
          if (vector) {
            const { EmbeddingReader } = await import('./embedding-reader.js');
            const reader = new EmbeddingReader(EMBEDDINGS_DB_PATH);
            const similar = reader.findSimilar(`tasks:${boardId}`, vector, 0.85);
            reader.close();
            if (similar) {
              const pct = Math.round(similar.score * 100);
              // Hard block: >= 95% similarity cannot be overridden
              if (pct >= 95) {
                return {
                  content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                      success: false,
                      error: `Tarefa já existe: ${similar.itemId} — ${similar.metadata?.title ?? '?'} (${pct}% idêntica). Não é possível criar duplicata. Use a tarefa existente.`,
                    }),
                  }],
                };
              }
              // Soft warning: 85-94% similarity, allow force_create override
              if (!args.force_create) {
                return {
                  content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                      success: false,
                      duplicate_warning: {
                        similar_task_id: similar.itemId,
                        similar_task_title: similar.metadata?.title ?? similar.itemId,
                        similarity: pct,
                      },
                      error: `Tarefa similar encontrada: ${similar.itemId} — ${similar.metadata?.title ?? '?'} (${pct}%). Criar mesmo assim?`,
                    }),
                  }],
                };
              }
            }
          }
        } catch {
          console.warn('[embeddings] Duplicate detection skipped: Ollama unreachable');
        }
        const { force_create: _, ...createArgs } = args;
        const result = engine.create({ ...createArgs, board_id: boardId });
        if (result.success) dispatchNotifications(result);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(stripDispatchOnlyFields(result)) }],
          isError: !result.success,
        };
      },
    );

    server.tool(
      'taskflow_move',
      'Move a task through workflow stages (start, wait, resume, review, approve, reject, conclude, reopen, etc.).',
      {
        task_id: z.string().describe('Task ID to move. For project subtasks (e.g. P16.2), use the PARENT project ID (e.g. P16) and pass the subtask ID in subtask_id'),
        action: z.enum(['start', 'wait', 'resume', 'return', 'review', 'approve', 'reject', 'conclude', 'reopen', 'force_start']).describe('Workflow action'),
        sender_name: z.string().describe('Name of the person performing the action'),
        reason: z.string().optional().describe('Reason for the action (e.g., wait/reject reason)'),
        subtask_id: z.string().optional().describe('Subtask ID to complete within a project (e.g. P16.2). When provided, task_id must be the parent project ID (e.g. P16)'),
      },
      async (args: any) => {
        const result = engine.move({ ...args, board_id: boardId });
        if (result.success) dispatchNotifications(result);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(stripDispatchOnlyFields(result)) }],
          isError: !result.success,
        };
      },
    );

    server.tool(
      'taskflow_reassign',
      'Reassign a task or all tasks from one person to another.',
      {
        task_id: z.string().optional().describe('Specific task ID to reassign'),
        source_person: z.string().optional().describe('Reassign all tasks from this person'),
        target_person: z.string().describe('Person to assign to'),
        sender_name: z.string().describe('Name of the person performing the reassignment'),
        confirmed: z.boolean().describe('Must be true to confirm the reassignment'),
      },
      async (args: any) => {
        const result = engine.reassign({ ...args, board_id: boardId });
        if (result.success) dispatchNotifications(result);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(stripDispatchOnlyFields(result)) }],
          isError: !result.success,
        };
      },
    );

    server.tool(
      'taskflow_update',
      'Update task fields: title, priority, due date, description, next action, labels, notes, subtasks, recurrence.',
      {
        task_id: z.string().describe('Task ID to update'),
        sender_name: z.string().describe('Name of the person making the update'),
        sender_external_id: z.string().optional().describe('External contact ID when the caller is an external participant'),
        updates: z.object({
          title: z.string().optional().describe('New title'),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority'),
          due_date: z.string().nullable().optional().describe('New due date (ISO) or null to clear'),
          allow_non_business_day: z.boolean().optional().describe('Allow due_date on weekends/holidays'),
          description: z.string().optional().describe('New description'),
          next_action: z.string().optional().describe('New next action text'),
          add_label: z.string().optional().describe('Label to add'),
          remove_label: z.string().optional().describe('Label to remove'),
          add_note: z.string().optional().describe('Note text to add'),
          edit_note: z.object({ id: z.number(), text: z.string() }).optional().describe('Edit an existing note by ID'),
          remove_note: z.number().optional().describe('Note ID to remove'),
          add_subtask: z.string().optional().describe('Subtask title to add'),
          rename_subtask: z.object({ id: z.string(), title: z.string() }).optional().describe('Rename a subtask'),
          reopen_subtask: z.string().optional().describe('Subtask ID to reopen'),
          assign_subtask: z.object({ id: z.string(), assignee: z.string() }).optional().describe('Assign a person to a project subtask'),
          unassign_subtask: z.string().optional().describe('Subtask ID to unassign'),
          recurrence: z.string().optional().describe('New recurrence pattern'),
          max_cycles: z.number().int().positive().nullable().optional().describe('Maximum cycles (null to remove; setting clears recurrence_end_date)'),
          recurrence_end_date: z.string().nullable().optional().describe('End date for recurrence (null to remove; setting clears max_cycles)'),
          parent_note_id: z.number().optional().describe('Parent note ID for threaded meeting notes'),
          scheduled_at: z.string().optional().describe('Reschedule meeting (ISO-8601 UTC)'),
          add_participant: z.string().optional().describe('Add a participant to a meeting'),
          remove_participant: z.string().optional().describe('Remove a participant from a meeting'),
          add_external_participant: z.object({
            name: z.string(),
            phone: z.string(),
          }).optional().describe('Add an external participant (name + phone) to a meeting'),
          remove_external_participant: z.object({
            external_id: z.string().optional(),
            phone: z.string().optional(),
            name: z.string().optional(),
          }).optional().describe('Remove an external participant from a meeting'),
          reinvite_external_participant: z.object({
            external_id: z.string().optional(),
            phone: z.string().optional(),
          }).optional().describe('Resend invite to an external participant'),
          set_note_status: z.object({
            id: z.number(),
            status: z.enum(['open', 'checked', 'task_created', 'inbox_created', 'dismissed']),
          }).optional().describe('Set meeting note status'),
        }).describe('Fields to update'),
      },
      async (args: any) => {
        const result = engine.update({ ...args, board_id: boardId });
        if (result.success) dispatchNotifications(result);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(stripDispatchOnlyFields(result)) }],
          isError: !result.success,
        };
      },
    );

    server.tool(
      'taskflow_dependency',
      'Manage task dependencies and reminders. Add/remove blocking dependencies or due-date reminders.',
      {
        action: z.enum(['add_dep', 'remove_dep', 'add_reminder', 'remove_reminder']).describe('Dependency action'),
        task_id: z.string().describe('Source task ID'),
        target_task_id: z.string().optional().describe('Target task ID (for add_dep/remove_dep)'),
        reminder_days: z.number().optional().describe('Days before due date to send reminder (for add_reminder)'),
        sender_name: z.string().describe('Name of the person managing dependencies'),
      },
      async (args: any) => {
        const result = engine.dependency({ ...args, board_id: boardId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: !result.success,
        };
      },
    );

    server.tool(
      'taskflow_admin',
      'Board administration: register/remove people, manage roles, set WIP limits, cancel/restore tasks, process inbox, manage holidays.',
      {
        action: z.enum(['register_person', 'remove_person', 'add_manager', 'add_delegate', 'remove_admin', 'set_wip_limit', 'cancel_task', 'restore_task', 'process_inbox', 'manage_holidays', 'process_minutes', 'process_minutes_decision', 'accept_external_invite']).describe('Admin action'),
        sender_name: z.string().describe('Name of the person performing the admin action'),
        person_name: z.string().optional().describe('Person name (for person-related actions)'),
        phone: z.string().optional().describe('Phone number (for register_person)'),
        role: z.string().optional().describe('Role (for register_person, add_manager, add_delegate)'),
        wip_limit: z.number().optional().describe('WIP limit (for set_wip_limit)'),
        task_id: z.string().optional().describe('Task ID (for cancel_task, restore_task, process_minutes, process_minutes_decision)'),
        confirmed: z.boolean().optional().describe('Confirmation flag (for destructive actions)'),
        force: z.boolean().optional().describe('Force flag (bypasses safety checks)'),
        group_name: z.string().optional().describe('Division/sector name for child board WhatsApp group (for register_person on hierarchy boards, e.g., "SETD-SECTI - TaskFlow")'),
        group_folder: z.string().optional().describe('Division/sector folder name for child board (for register_person on hierarchy boards, e.g., "setd-secti-taskflow")'),
        note_id: z.number().optional().describe('Note ID for process_minutes_decision'),
        decision: z.enum(['create_task', 'create_inbox']).optional().describe('Decision for process_minutes_decision'),
        create: z.object({
          type: z.string(),
          title: z.string(),
          assignee: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }).optional().describe('Task creation params for process_minutes_decision'),
        holiday_operation: z.enum(['add', 'remove', 'set_year', 'list']).optional().describe('Holiday sub-operation (for manage_holidays)'),
        holidays: z.array(z.object({ date: z.string(), label: z.string().optional() })).optional().describe('Holiday entries with date (YYYY-MM-DD) and optional label (for manage_holidays add/set_year)'),
        holiday_dates: z.array(z.string()).optional().describe('Holiday dates to remove (YYYY-MM-DD) (for manage_holidays remove)'),
        holiday_year: z.number().optional().describe('Year filter for listing or target year for set_year (for manage_holidays list/set_year)'),
        sender_external_id: z.string().optional().describe('External contact ID when the caller is an external participant'),
      },
      async (args: any) => {
        const result = engine.admin({ ...args, board_id: boardId });
        if (
          args.action === 'register_person' &&
          result.success &&
          result.auto_provision_request &&
          canUseCreateGroup({
            isMain: false,
            isTaskflowManaged,
            taskflowHierarchyLevel,
            taskflowMaxDepth,
          })
        ) {
          const ap = result.auto_provision_request;
          writeIpcFile(TASKS_DIR, {
            type: 'provision_child_board',
            person_id: ap.person_id,
            person_name: ap.person_name,
            person_phone: ap.person_phone,
            person_role: ap.person_role,
            group_name: ap.group_name,
            group_folder: ap.group_folder,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString(),
          });
        }
        if (result.success) dispatchNotifications(result);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(stripDispatchOnlyFields(result)) }],
          isError: !result.success,
        };
      },
    );

    server.tool(
      'taskflow_undo',
      'Undo the last mutation on the board. Can only undo the most recent action.',
      {
        sender_name: z.string().describe('Name of the person requesting the undo'),
        force: z.boolean().optional().describe('Force undo even if action was by a different person'),
      },
      async (args: any) => {
        const result = engine.undo({ ...args, board_id: boardId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: !result.success,
        };
      },
    );

    server.tool(
      'taskflow_hierarchy',
      'Manage hierarchy links between parent and child boards. Link/unlink tasks to child boards, refresh rollup status, or tag a local task to a parent deliverable.',
      {
        action: z.enum(['link', 'unlink', 'refresh_rollup', 'tag_parent']).describe('Hierarchy action'),
        task_id: z.string().describe('Task ID to operate on'),
        person_name: z.string().optional().describe('Target person with child board (for link action)'),
        parent_task_id: z.string().optional().describe('Parent task ID (for tag_parent action)'),
        sender_name: z.string().describe('Name of the person performing the action'),
      },
      async (args: any) => {
        const result = engine.hierarchy({ ...args, board_id: boardId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: !result.success,
        };
      },
    );

    server.tool(
      'taskflow_report',
      'Generate a TaskFlow report: standup (daily summary), digest (detailed overview), or weekly (week summary).',
      {
        type: z.enum(['standup', 'digest', 'weekly']).describe('Report type'),
      },
      async (args: any) => {
        const result = engine.report({ ...args, board_id: boardId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: !result.success,
        };
      },
    );
  }
}

// --- add-long-term-context skill: MCP retrieval tools ---
{
  const { ContextReader } = await import('./context-reader.js');
  const ctxReader = new ContextReader('/workspace/context/context.db');

  // Always register: context_search, context_recall
  server.tool(
    'context_search',
    'Search conversation history for this group. Returns summaries matching the query.',
    {
      query: z.string().describe('Search terms (keywords, names, task IDs)'),
      date_from: z
        .string()
        .optional()
        .describe('ISO date, e.g. 2026-03-01'),
      date_to: z.string().optional().describe('ISO date, e.g. 2026-03-15'),
      limit: z.number().optional().default(10),
    },
    async (args) => {
      const results = ctxReader.search(groupFolder, args.query, {
        dateFrom: args.date_from,
        dateTo: args.date_to,
        limit: args.limit,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              results.map((r) => ({
                node_id: r.id,
                summary: r.summary,
                date: r.time_start,
                level: r.level,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    'context_recall',
    'Expand a summary to see original session messages. Use after context_search to get details.',
    {
      node_id: z.string().describe('Node ID from context_search results'),
    },
    async (args) => {
      const result = ctxReader.recall(groupFolder, args.node_id);
      if (!result) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Node not found or access denied.',
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // Progressive unlock: timeline + topics at >50 nodes
  const nodeCount = ctxReader.getNodeCount(groupFolder);
  if (nodeCount > 50) {
    server.tool(
      'context_timeline',
      'Chronological summary list for a date range. Auto-selects best detail level.',
      {
        date_from: z.string().describe('Start date (ISO)'),
        date_to: z.string().describe('End date (ISO)'),
      },
      async (args) => {
        const results = ctxReader.timeline(
          groupFolder,
          args.date_from,
          args.date_to,
        );
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(results, null, 2) },
          ],
        };
      },
    );

    server.tool(
      'context_topics',
      'List distinct topics from conversation history with frequency and last seen date.',
      {},
      async () => {
        const topics = ctxReader.topics(groupFolder);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(topics, null, 2) },
          ],
        };
      },
    );
  }

  // Cleanup reader on process exit
  process.on('exit', () => ctxReader.close());
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
