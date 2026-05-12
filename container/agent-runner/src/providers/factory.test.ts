import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import { ClaudeProvider, SDK_DISALLOWED_TOOLS, SDK_SETTING_SOURCES, TOOL_ALLOWLIST, mcpAllowPattern } from './claude.js';
import { MockProvider } from './mock.js';

describe('createProvider', () => {
  it('returns ClaudeProvider for claude', () => {
    expect(createProvider('claude')).toBeInstanceOf(ClaudeProvider);
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });
});

describe('ClaudeProvider tool surface', () => {
  it('does not expose ToolSearch in the default allowlist', () => {
    expect(TOOL_ALLOWLIST).not.toContain('ToolSearch');
    expect(SDK_DISALLOWED_TOOLS).toContain('ToolSearch');
  });

  it('does not expose web search/fetch in the default allowlist', () => {
    for (const tool of ['WebSearch', 'WebFetch']) {
      expect(TOOL_ALLOWLIST).not.toContain(tool);
      expect(SDK_DISALLOWED_TOOLS).toContain(tool);
    }
  });

  it('does not expose the v2-only interactive ask tool by default', () => {
    expect(SDK_DISALLOWED_TOOLS).toContain('mcp__nanoclaw__ask_user_question');
    expect(SDK_DISALLOWED_TOOLS).toContain('mcp__sqlite__read_query');
    expect(SDK_DISALLOWED_TOOLS).toContain('mcp__sqlite__write_query');
  });

  it('blocks general Claude Code workspace tools for TaskFlow parity', () => {
    for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'Agent']) {
      expect(SDK_DISALLOWED_TOOLS).toContain(tool);
    }
  });

  it('does not allow the raw sqlite MCP server namespace through the wildcard allowlist', () => {
    expect(mcpAllowPattern('sqlite')).toBeNull();
    expect(mcpAllowPattern('nanoclaw')).toBe('mcp__nanoclaw__*');
  });

  it('does not load project/user MCP settings that can reintroduce raw sqlite tools', () => {
    expect(SDK_SETTING_SOURCES).toEqual([]);
  });
});
