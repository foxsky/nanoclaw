/**
 * Phase 2 tool_use capture — pure extractor + append-only writer.
 *
 * Hooks into the Claude SDK message stream (assistant + user messages) to
 * extract tool_use and tool_result content blocks, then appends them as
 * JSON Lines to a path supplied by the driver. The post-run comparator
 * pairs tool_use ↔ tool_result by id.
 *
 * Active only when the agent-runner is spawned with NANOCLAW_TOOL_USES_PATH
 * set — never in normal production.
 */

import fs from 'fs';
import path from 'path';

export type ToolEvent =
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; output: unknown; is_error: boolean };

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export function extractToolEvents(msg: unknown): ToolEvent[] {
  if (!msg || typeof msg !== 'object') return [];
  const m = msg as { type?: string; message?: { content?: unknown } };
  if (m.type !== 'assistant' && m.type !== 'user') return [];
  const content = m.message?.content;
  if (!Array.isArray(content)) return [];

  const events: ToolEvent[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as ContentBlock;
    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      events.push({ kind: 'tool_use', id: block.id, name: block.name, input: block.input });
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      events.push({
        kind: 'tool_result',
        id: block.tool_use_id,
        output: block.content,
        is_error: block.is_error === true,
      });
    }
  }
  return events;
}

export function appendToolEvents(filepath: string, events: ToolEvent[]): void {
  if (events.length === 0) return;
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(filepath, lines);
}
