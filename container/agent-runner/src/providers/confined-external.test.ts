import { describe, it, expect } from 'bun:test';

import { computeAllowedTools, TOOL_ALLOWLIST } from './claude.js';

// RC5-ext C4c — the confined-external provider mode. A turn driven by an
// authenticated external participant must expose NO built-in fs/bash tools
// (Read/Bash/Glob/… are NOT seen by the nanoclaw C7 MCP gate, so they would be an
// unguarded exfiltration path over board-private files) and ONLY the nanoclaw MCP
// server (C7 then narrows it to the external-safe whitelist). This locks the
// allowedTools computation that drives that restriction.

const BUILTIN_FS_BASH = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

describe('computeAllowedTools — confined-external restriction (C4c)', () => {
  it('a NORMAL turn keeps the full built-in allowlist + every visible MCP server', () => {
    const tools = computeAllowedTools(false, ['nanoclaw', 'someBoardServer']);
    for (const t of TOOL_ALLOWLIST) expect(tools).toContain(t);
    expect(tools).toContain('mcp__nanoclaw__*');
    expect(tools).toContain('mcp__someBoardServer__*');
  });

  it('a CONFINED turn drops EVERY built-in fs/bash tool', () => {
    const tools = computeAllowedTools(true, ['nanoclaw', 'someBoardServer']);
    for (const t of BUILTIN_FS_BASH) {
      expect(tools, `${t} must NOT be allowed on a confined external turn`).not.toContain(t);
    }
    // No built-in tool at all — the whole TOOL_ALLOWLIST is dropped.
    for (const t of TOOL_ALLOWLIST) expect(tools).not.toContain(t);
  });

  it('a CONFINED turn exposes ONLY the nanoclaw MCP server — not other installed MCP servers', () => {
    const tools = computeAllowedTools(true, ['nanoclaw', 'someBoardServer', 'anotherServer']);
    expect(tools).toEqual(['mcp__nanoclaw__*']);
  });

  it('a CONFINED turn still allows nanoclaw even if it is not in the visible list (C7 narrows it)', () => {
    // The nanoclaw server is always present in practice; the confined allowlist is
    // hard-pinned to it so the external-safe whitelist (api_task_add_note, etc.)
    // can run regardless of the caller-passed server set.
    const tools = computeAllowedTools(true, []);
    expect(tools).toEqual(['mcp__nanoclaw__*']);
  });
});
