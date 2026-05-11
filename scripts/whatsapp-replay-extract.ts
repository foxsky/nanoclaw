/**
 * Pure extractor that walks a session JSONL and pulls one record per
 * conversation turn. Phase 2 will feed `parsed_messages[*].text` (or the raw
 * `user_message`) into a v2 agent and compare v2's tool_use + outbound
 * messages against the v1 record captured here.
 */

export interface ToolUseRecord {
  tool_use_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
}

export interface ParsedMessage {
  sender: string;
  time: string;
  text: string;
}

export interface OutboundMessage {
  tool_use_id: string;
  destination: string | null;
  text: string;
}

export interface ConversationTurn {
  /** Raw prompt the v1 agent saw — preamble, context, and <message> envelope. */
  user_message: string;
  user_timestamp: string;
  /** All <message> blocks parsed from the prompt envelope (batched inbounds are
   *  multi-block). Empty array when the envelope is absent or malformed. */
  parsed_messages: ParsedMessage[];
  tool_uses: ToolUseRecord[];
  /** Each send_message call as a structured record (preserves per-call
   *  destination + tool_use_id for precise Phase 2 comparison). */
  outbound_messages: OutboundMessage[];
  /** Convenience scalar: outbound_messages joined by newline. Null when none. */
  outbound_text: string | null;
  /** Last assistant text block in the turn (often internal when send_message
   *  is the real outbound path). */
  final_response: string | null;
}

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: Array<{ type: string; text?: string }>;
}

interface JsonlLine {
  timestamp?: string;
  message?: { role?: string; content?: string | ContentBlock[] };
}

// Match <message ...attrs...>...body...</message>; attribute order is
// arbitrary, so we capture the full attr blob and parse by name.
const MESSAGE_TAG_RE = /<message\b([^>]*)>([\s\S]*?)<\/message>/g;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseAttrs(blob: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(blob))) out[m[1]] = m[2];
  return out;
}

function parseAllMessages(raw: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  MESSAGE_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MESSAGE_TAG_RE.exec(raw))) {
    const attrs = parseAttrs(m[1]);
    const sender = attrs.sender;
    const time = attrs.time;
    if (sender === undefined || time === undefined) continue;
    messages.push({
      sender: xmlUnescape(sender),
      time: xmlUnescape(time),
      text: xmlUnescape(m[2].trim()),
    });
  }
  return messages;
}

function stripMcpPrefix(name: string): string {
  return name.startsWith('mcp__nanoclaw__') ? name.slice('mcp__nanoclaw__'.length) : name;
}

function parseToolResultText(block: ContentBlock): Record<string, unknown> | null {
  const text = block.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function firstTextBlock(content: ContentBlock[]): string | null {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return null;
}

function attachToolResults(turn: ConversationTurn, blocks: ContentBlock[]): void {
  for (const block of blocks) {
    if (block.type === 'tool_result' && block.tool_use_id) {
      const tu = turn.tool_uses.find((t) => t.tool_use_id === block.tool_use_id);
      if (tu) tu.output = parseToolResultText(block);
    }
  }
}

export function extractConversationTurns(jsonl: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | null = null;

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let parsed: JsonlLine;
    try { parsed = JSON.parse(line); } catch { continue; }
    const msg = parsed.message;
    if (!msg || !msg.role) continue;

    if (msg.role === 'user') {
      if (current && Array.isArray(msg.content)) {
        attachToolResults(current, msg.content);
      }

      let newTurnText: string | null = null;
      if (typeof msg.content === 'string') {
        newTurnText = msg.content;
      } else if (Array.isArray(msg.content)) {
        newTurnText = firstTextBlock(msg.content);
      }

      if (newTurnText !== null) {
        current = {
          user_message: newTurnText,
          user_timestamp: parsed.timestamp ?? '',
          parsed_messages: parseAllMessages(newTurnText),
          tool_uses: [],
          outbound_messages: [],
          outbound_text: null,
          final_response: null,
        };
        turns.push(current);
      }
      continue;
    }

    if (msg.role === 'assistant' && current && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id && typeof block.name === 'string') {
          const toolName = stripMcpPrefix(block.name);
          const input = (block.input && typeof block.input === 'object'
            ? (block.input as Record<string, unknown>)
            : {});
          current.tool_uses.push({
            tool_use_id: block.id,
            tool_name: toolName,
            input,
            output: null,
          });
          if (toolName === 'send_message' && typeof input.text === 'string') {
            // Real v1 send_message uses `target_chat_jid`; some v2 variants
            // may use `destination`. Check both.
            const destination =
              typeof input.target_chat_jid === 'string' ? input.target_chat_jid :
              typeof input.destination === 'string' ? input.destination :
              null;
            current.outbound_messages.push({
              tool_use_id: block.id,
              destination,
              text: input.text,
            });
            current.outbound_text = current.outbound_text === null
              ? input.text
              : `${current.outbound_text}\n${input.text}`;
          }
        } else if (block.type === 'text' && typeof block.text === 'string') {
          current.final_response = block.text;
        }
      }
    }
  }

  return turns;
}
