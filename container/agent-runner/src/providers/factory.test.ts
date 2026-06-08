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

  it('keeps the full dangerous tool set disallowed — guards against an accidental denylist regression', () => {
    // The tests above check tools one cluster at a time; this asserts the WHOLE
    // dangerous set in one place so a partial deletion (one tool slipping out of
    // the denylist) is caught even if the cluster tests are edited. The DENYLIST
    // is the enforcement wall — the SDK applies disallowedTools on top of
    // allowedTools, and disallowedTools wins. Some of these (Bash/Read/Write/
    // Edit/Glob/Grep) are deliberately ALSO in TOOL_ALLOWLIST, so we do NOT
    // assert allowlist-absence here for the whole set (that would encode a false
    // invariant). The allowlist-absence wall for the genuinely-not-allowlisted
    // subset lives in security-boundary.test.ts.
    const MUST_STAY_DISALLOWED = [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'MultiEdit',
      'Glob',
      'Grep',
      'LS',
      'Agent',
      'WebSearch',
      'WebFetch',
      'mcp__sqlite__read_query',
      'mcp__sqlite__write_query',
      'mcp__sqlite__list_tables',
      'mcp__sqlite__describe_table',
      'mcp__nanoclaw__ask_user_question',
    ];
    for (const t of MUST_STAY_DISALLOWED) {
      expect(SDK_DISALLOWED_TOOLS).toContain(t);
    }
  });
});
