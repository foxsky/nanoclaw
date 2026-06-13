import fs from 'fs';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { captureSessionMemories, precompactHookTimeoutSec } from '../memory-capture.js';
import { openMemoryDbEnsuringDir } from '../memory-store.js';
import { appendToolEvents, extractToolEvents } from './claude-tool-capture.js';
import { registerProvider } from './provider-registry.js';
import { SECURITY_DENYLIST, PARITY_DENYLIST } from './security-denylist.js';
import { containsLoneSurrogate, toWellFormedText, truncateChars, wellFormedToolResult } from '../well-formed.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// The tool denylist lives in ./security-denylist.ts as the single source of
// truth: SECURITY_DENYLIST (the security boundary — every provider must enforce
// it) plus PARITY_DENYLIST (v1-replay-shape / deferred-builtin preferences).
// The union here is byte-identical (as a set) to the prior inline literal; the
// preToolUseHook and query() disallowedTools wiring below keep checking it.
export const SDK_DISALLOWED_TOOLS = [...SECURITY_DENYLIST, ...PARITY_DENYLIST];

// Re-export the security subset so providers-branch code (opencode/codex) can
// import the boundary from the same module it already imports claude constants.
export { SECURITY_DENYLIST } from './security-denylist.js';

// Tool allowlist for NanoClaw agent containers. MCP-tool entries are derived
// at the call site from the registered `mcpServers` map so that any server
// added via `add_mcp_server` (or wired in container.json directly) is
// reachable to the agent — without this, the SDK's allowedTools filter
// silently drops every MCP namespace not listed here.
export const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'Skill',
  'NotebookEdit',
];

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
export function mcpAllowPattern(serverName: string): string | null {
  const sanitized = serverName.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitized === 'sqlite') return null;
  return `mcp__${sanitized}__*`;
}

function isSdkVisibleMcpServer(serverName: string): boolean {
  return mcpAllowPattern(serverName) !== null;
}

export const SDK_SETTING_SOURCES: [] = [];

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      // Sanitize here so EVERY user message — the initial prompt AND every
      // follow-up push (poll-loop.ts query.push) — is well-formed before the
      // SDK serializes it into the request body.
      message: { role: 'user', content: toWellFormedText(text) },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? truncateChars(msg.content, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
export const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/**
 * Clear in-flight tool on PostToolUse / PostToolUseFailure, and sanitize lone
 * UTF-16 surrogates out of the tool OUTPUT before it reaches the model.
 *
 * This is the chokepoint the in-container `mcp-tools/server.ts` wrapper can't
 * reach: PostToolUse fires for EVERY tool the SDK runs — built-in tools (Read,
 * Bash output of a file with malformed UTF-8) AND external/config-wired MCP
 * servers (whose results the SDK transports directly). A lone surrogate in any
 * of those would otherwise be recorded as a `tool_result` and make the next
 * request body invalid JSON (400 "no low surrogate in string"). We only rewrite
 * when a lone surrogate is actually present, so well-formed output is untouched.
 *
 * Residual: only the SUCCESS path (`tool_response`) is rewritable —
 * PostToolUseFailure carries an `error` string with no `updatedToolOutput`
 * field, so a malformed error message from a failed built-in/external tool
 * can't be sanitized here (hard SDK limit; narrow).
 */
export const postToolUseHook: HookCallback = async (input) => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  const resp = (input as { tool_response?: unknown }).tool_response;
  if (resp !== undefined && containsLoneSurrogate(resp)) {
    return {
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: wellFormedToolResult(resp) },
    } as unknown as ReturnType<HookCallback>;
  }
  return { continue: true };
};

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const { transcript_path: transcriptPath, session_id: sessionId } = preCompact;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    let messages: ParsedMessage[] = [];
    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      messages = parseTranscript(content);
      if (messages.length === 0) return {};

      // Try to get summary from sessions index
      let summary: string | undefined;
      const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          summary = index.entries?.find(
            (e: { sessionId: string; summary?: string }) => e.sessionId === sessionId,
          )?.summary;
        } catch {
          /* ignore */
        }
      }

      const name = summary
        ? summary
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 50)
        : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

      const conversationsDir = '/workspace/agent/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
      fs.writeFileSync(
        path.join(conversationsDir, filename),
        formatTranscriptMarkdown(messages, summary, assistantName),
      );
      log(`Archived conversation to ${filename}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    // P2 auto-capture: distil durable facts into the board's memory. Best-effort and
    // independent of archiving — a slow/failed extraction must never break compaction
    // (extractMemories is timeout-bounded and fails soft).
    try {
      const boardId = process.env.NANOCLAW_TASKFLOW_BOARD_ID?.trim() || null;
      const captured = await captureSessionMemories({
        messages,
        boardId,
        sessionId: sessionId ?? 'unknown',
        openDb: () => openMemoryDbEnsuringDir(),
      });
      if (captured) log(`Captured ${captured} memories`);
    } catch (err) {
      log(`Memory capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private model?: string;
  private effort?: string;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = options.model;
    this.effort = options.effort;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt); // MessageStream.push() strips lone surrogates

    const instructions = input.systemContext?.instructions
      ? toWellFormedText(input.systemContext.instructions) // appended to systemPrompt, not via push()
      : undefined;
    const visibleMcpServers = Object.fromEntries(
      Object.entries(this.mcpServers).filter(([serverName]) => isSdkVisibleMcpServer(serverName)),
    );

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        allowedTools: [
          ...TOOL_ALLOWLIST,
          ...Object.keys(visibleMcpServers)
            .map(mcpAllowPattern)
            .filter((tool): tool is string => tool !== null),
        ],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        model: this.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.effort as any,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: SDK_SETTING_SOURCES,
        mcpServers: visibleMcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          // Timeout (s) is DERIVED from the extraction budget (+ buffer) so capture's own
          // AbortSignal fires first and writes cleanly before the SDK could kill the hook —
          // raising NANOCLAW_MEMORY_EXTRACT_TIMEOUT_MS for a slow local model lifts this too.
          PreCompact: [{ timeout: precompactHookTimeoutSec(), hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    // Opt-in tool_use capture for the v1↔v2 comparator harness; off in prod.
    const toolCapturePath = process.env.NANOCLAW_TOOL_USES_PATH;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        if (toolCapturePath) {
          try {
            const events = extractToolEvents(message);
            if (events.length > 0) appendToolEvents(toolCapturePath, events);
          } catch (err) {
            log(`tool-capture: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'result') {
          const text = 'result' in message ? ((message as { result?: string }).result ?? null) : null;
          yield { type: 'result', text };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
          yield { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          yield { type: 'compacted', text: `Context compacted${detail}.` };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
