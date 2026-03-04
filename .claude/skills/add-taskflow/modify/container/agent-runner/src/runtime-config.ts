export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isTaskflowManaged?: boolean;
  taskflowHierarchyLevel?: number;
  taskflowMaxDepth?: number;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
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

  // Derive board ID from folder name (convention: 'board-{folder}')
  if (containerInput.isTaskflowManaged) {
    env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-' + containerInput.groupFolder;
  }

  if (containerInput.taskflowHierarchyLevel !== undefined) {
    env.NANOCLAW_TASKFLOW_HIERARCHY_LEVEL = String(
      containerInput.taskflowHierarchyLevel,
    );
  }

  if (containerInput.taskflowMaxDepth !== undefined) {
    env.NANOCLAW_TASKFLOW_MAX_DEPTH = String(containerInput.taskflowMaxDepth);
  }

  return env;
}
