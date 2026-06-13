import { describe, it, expect } from 'bun:test';

import { postToolUseHook } from './claude.ts';

// Gap #2: external/config-wired MCP servers and built-in SDK tools (Read/Bash)
// never pass through mcp-tools/server.ts, so their output is sanitized HERE via
// the PostToolUse hook's `updatedToolOutput`. A lone surrogate in tool output
// would otherwise be recorded as a tool_result and 400 the next request.
describe('postToolUseHook surrogate sanitization', () => {
  it('rewrites tool_response that contains a lone surrogate', async () => {
    const out = (await postToolUseHook(
      { tool_response: { content: [{ type: 'text', text: 'bad \uD83D end' }] } } as never,
      'tu-1' as never,
      {} as never,
    )) as { hookSpecificOutput?: { hookEventName: string; updatedToolOutput: unknown } };
    expect(out.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput?.updatedToolOutput).toEqual({
      content: [{ type: 'text', text: 'bad � end' }],
    });
  });

  it('leaves well-formed tool_response alone (no updatedToolOutput)', async () => {
    const out = (await postToolUseHook(
      { tool_response: { content: [{ type: 'text', text: 'ok 👋' }] } } as never,
      'tu-2' as never,
      {} as never,
    )) as { hookSpecificOutput?: unknown };
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it('is a no-op on the failure path (no tool_response)', async () => {
    const out = (await postToolUseHook({ error: 'boom' } as never, 'tu-3' as never, {} as never)) as {
      hookSpecificOutput?: unknown;
    };
    expect(out.hookSpecificOutput).toBeUndefined();
  });
});
