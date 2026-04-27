export interface TriggerMessageContext {
  messageId: string;
  chatJid: string;
  sender: string;
  senderName: string;
  timestamp: string;
}

export interface AgentTurnContext {
  turnId: string;
  /** Sender JID of the trigger message, used by the memory layer for attribution. */
  senderJid?: string;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isTaskflowManaged?: boolean;
  taskflowBoardId?: string;
  taskflowHierarchyLevel?: number;
  taskflowMaxDepth?: number;
  isScheduledTask?: boolean;
  /**
   * Timestamp (ISO 8601) of the earliest user message in the batch
   * currently being processed. Used by the recent-turns recap to
   * exclude the in-flight messages from the verbatim history slice.
   * Required: the wallclock heuristic alone (now-5s) does not match
   * sender-claimed WhatsApp timestamps under delivery latency.
   */
  currentMessageTimestamp?: string;
  assistantName?: string;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
  script?: string;
  queryVector?: string; // base64-encoded Float32Array
  ollamaHost?: string;
  embeddingModel?: string;
  turnContext?: AgentTurnContext;
}

/**
 * Session-level slash commands that are intercepted by the agent-runner
 * and forwarded to the SDK as-is (bypassing normal prompt processing).
 *
 * These must be matched against the ORIGINAL user prompt, NOT against
 * any prompt that has been mutated with prepended context (e.g. recent
 * conversation recap or embedding preambles). Otherwise a user sending
 * `/compact` with recent context history present would have the prompt
 * silently rewritten to `<recap>\n\n/compact`, and slash-command
 * detection would fail — shipping the compact literal as a chat message
 * instead of triggering session compaction.
 */
const KNOWN_SESSION_COMMANDS = new Set(['/compact']);

export function isSessionSlashCommand(rawPrompt: string): boolean {
  return KNOWN_SESSION_COMMANDS.has(rawPrompt.trim());
}

export const NANOCLAW_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
  'mcp__sqlite__*',
  'mcp__qmd__*',
] as const;

export function buildNanoclawMcpEnv(
  containerInput: ContainerInput,
): Record<string, string> {
  const env: Record<string, string> = {
    NANOCLAW_CHAT_JID: containerInput.chatJid,
    NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
    NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    NANOCLAW_IS_TASKFLOW_MANAGED: containerInput.isTaskflowManaged ? '1' : '0',
  };

  if (containerInput.turnContext?.turnId) {
    env.NANOCLAW_TURN_ID = containerInput.turnContext.turnId;
  }

  if (containerInput.turnContext?.senderJid) {
    env.NANOCLAW_TURN_SENDER_JID = containerInput.turnContext.senderJid;
  }

  if (containerInput.isTaskflowManaged && containerInput.taskflowBoardId) {
    env.NANOCLAW_TASKFLOW_BOARD_ID = containerInput.taskflowBoardId;
  }

  if (containerInput.taskflowHierarchyLevel !== undefined) {
    env.NANOCLAW_TASKFLOW_HIERARCHY_LEVEL = String(
      containerInput.taskflowHierarchyLevel,
    );
  }

  if (containerInput.taskflowMaxDepth !== undefined) {
    env.NANOCLAW_TASKFLOW_MAX_DEPTH = String(containerInput.taskflowMaxDepth);
  }

  if (containerInput.ollamaHost) {
    env.NANOCLAW_OLLAMA_HOST = containerInput.ollamaHost;
    if (containerInput.embeddingModel) {
      env.NANOCLAW_EMBEDDING_MODEL = containerInput.embeddingModel;
    }
  }

  if (containerInput.assistantName) {
    env.NANOCLAW_ASSISTANT_NAME = containerInput.assistantName;
  }

  return env;
}
