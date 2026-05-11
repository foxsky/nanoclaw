/**
 * Pure mutation-replay building blocks. SQLite-free so they are
 * unit-testable on the host. The Bun-side runner (mutation-replay-runner.ts)
 * dispatches engine[method](params) using the call shape produced here.
 */

const V1_MUTATION_TOOLS = [
  'taskflow_move',
  'taskflow_admin',
  'taskflow_reassign',
  'taskflow_undo',
  'taskflow_create',
  'taskflow_update',
  'taskflow_dependency',
  'taskflow_hierarchy',
] as const;

type V1MutationTool = (typeof V1_MUTATION_TOOLS)[number];

const V1_TOOL_TO_V2_METHOD: Record<V1MutationTool, string> = {
  taskflow_move: 'move',
  taskflow_admin: 'admin',
  taskflow_reassign: 'reassign',
  taskflow_undo: 'undo',
  taskflow_create: 'create',
  taskflow_update: 'update',
  taskflow_dependency: 'dependency',
  taskflow_hierarchy: 'hierarchy',
};

export interface ExtractedMutation {
  tool_use_id: string;
  tool_name: V1MutationTool;
  input: Record<string, unknown>;
  /** Parsed JSON of the tool_result.content[0].text, or null if no result paired. */
  output: Record<string, unknown> | null;
  /** ISO-8601 timestamp of the JSONL line that emitted the tool_use, if present. */
  timestamp?: string;
  /** Monotonic 0-based index across all tool_use blocks in this JSONL file.
   *  Secondary sort key for same-timestamp mutations. */
  line_index?: number;
}

export interface V2EngineCall {
  method: string;
  params: Record<string, unknown>;
}

/** Strip the `mcp__nanoclaw__` prefix and recognise only v1 mutation tools. */
function bareToolName(fullName: string): V1MutationTool | null {
  const stripped = fullName.startsWith('mcp__nanoclaw__')
    ? fullName.slice('mcp__nanoclaw__'.length)
    : fullName;
  return (V1_MUTATION_TOOLS as readonly string[]).includes(stripped)
    ? (stripped as V1MutationTool)
    : null;
}

interface JsonlContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: Array<{ type: string; text?: string }>;
}

export function parseJsonlForMutations(jsonl: string): ExtractedMutation[] {
  const uses = new Map<string, ExtractedMutation>();
  const lines = jsonl.split('\n');
  let toolUseIndex = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: { message?: { content?: JsonlContentBlock[] }; timestamp?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const content = parsed?.message?.content;
    if (!Array.isArray(content)) continue;
    const lineTimestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined;

    for (const block of content) {
      if (block.type === 'tool_use' && block.id && typeof block.name === 'string') {
        const bare = bareToolName(block.name);
        if (bare && block.input && typeof block.input === 'object') {
          uses.set(block.id, {
            tool_use_id: block.id,
            tool_name: bare,
            input: block.input as Record<string, unknown>,
            output: null,
            line_index: toolUseIndex++,
            ...(lineTimestamp ? { timestamp: lineTimestamp } : {}),
          });
        }
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const existing = uses.get(block.tool_use_id);
        if (existing) {
          existing.output = extractToolResultJson(block);
        }
      }
    }
  }

  return [...uses.values()];
}

function extractToolResultJson(block: JsonlContentBlock): Record<string, unknown> | null {
  const text = block.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function v1ToV2EngineCall(
  v1ToolName: string,
  input: Record<string, unknown>,
  boardId: string,
): V2EngineCall {
  if (!(V1_MUTATION_TOOLS as readonly string[]).includes(v1ToolName)) {
    throw new Error(`Unknown v1 mutation tool: ${v1ToolName}`);
  }
  const method = V1_TOOL_TO_V2_METHOD[v1ToolName as V1MutationTool];
  return {
    method,
    // board_id wins over any input.board_id — mirrors v1's
    // `engine.method({ ...args, board_id })` ordering.
    params: { ...input, board_id: boardId },
  };
}
