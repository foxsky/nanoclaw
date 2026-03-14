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
  assistantName?: string;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
  secrets?: Record<string, string>;
  queryVector?: string; // base64-encoded Float32Array
  ollamaHost?: string;
  embeddingModel?: string;
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
  }
  if (containerInput.embeddingModel) {
    env.NANOCLAW_EMBEDDING_MODEL = containerInput.embeddingModel;
  }

  return env;
}
