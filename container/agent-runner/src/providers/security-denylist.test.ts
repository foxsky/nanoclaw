import { describe, it, expect } from 'bun:test';

import { SECURITY_DENYLIST, PARITY_DENYLIST } from './security-denylist.js';
import { SDK_DISALLOWED_TOOLS } from './claude.js';

// The exact denylist as it existed BEFORE the refactor. Snapshotted here so the
// extraction into security-denylist.ts is proven inert: the reconstructed
// SDK_DISALLOWED_TOOLS must contain exactly these names (order-insensitive,
// since the list is consumed via SDK `disallowedTools` and `.includes()` —
// neither cares about order).
const PRE_REFACTOR_DISALLOWED = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'LS',
  'Agent',
  'TodoWrite',
  'Skill',
  'NotebookEdit',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'ToolSearch',
  'WebSearch',
  'WebFetch',
  'mcp__nanoclaw__ask_user_question',
  'mcp__sqlite__read_query',
  'mcp__sqlite__write_query',
  'mcp__sqlite__list_tables',
  'mcp__sqlite__describe_table',
];

// The security-critical subset: tools that, if exposed, would let the agent
// escape the curated taskflow_*/api_* MCP surface and reach the RW-mounted
// global taskflow.db directly (Bash → sqlite, Read/Glob/Grep/LS → filesystem,
// Write/Edit → tampering/persistence, WebFetch/WebSearch → exfil, mcp__sqlite__*
// → direct DB access bypassing normalizeAgentIds board-id pinning). EVERY
// provider must deny these; misclassifying any as parity-only is a security
// regression.
const SECURITY_CRITICAL = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'mcp__sqlite__read_query',
  'mcp__sqlite__write_query',
  'mcp__sqlite__list_tables',
  'mcp__sqlite__describe_table',
];

// Parity/UX-only entries — deferred SDK builtins or v1-replay-shape
// preservation. Denying these is about observable reply shape, not a security
// boundary. They must live in PARITY_DENYLIST, never SECURITY_DENYLIST.
const PARITY_ONLY = [
  'Agent',
  'TodoWrite',
  'Skill',
  'NotebookEdit',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'ToolSearch',
  'mcp__nanoclaw__ask_user_question',
];

describe('SECURITY_DENYLIST', () => {
  it('contains every security-critical tool that escapes the MCP surface', () => {
    for (const tool of SECURITY_CRITICAL) {
      expect(SECURITY_DENYLIST).toContain(tool);
    }
  });

  it('is exactly the security-critical subset — no parity entries leak in', () => {
    expect([...SECURITY_DENYLIST].sort()).toEqual([...SECURITY_CRITICAL].sort());
  });

  it('does not contain any parity-only tool (misclassification guard)', () => {
    for (const tool of PARITY_ONLY) {
      expect(SECURITY_DENYLIST).not.toContain(tool);
    }
  });
});

describe('PARITY_DENYLIST', () => {
  it('contains the UX/parity-only tools', () => {
    expect([...PARITY_DENYLIST].sort()).toEqual([...PARITY_ONLY].sort());
  });

  it('does not contain any security-critical tool (misclassification guard)', () => {
    for (const tool of SECURITY_CRITICAL) {
      expect(PARITY_DENYLIST).not.toContain(tool);
    }
  });
});

describe('SECURITY_DENYLIST + PARITY_DENYLIST', () => {
  it('are disjoint — nothing double-listed', () => {
    const overlap = SECURITY_DENYLIST.filter((t) => PARITY_DENYLIST.includes(t));
    expect(overlap).toEqual([]);
  });

  it('reconstruct the pre-refactor SDK_DISALLOWED_TOOLS exactly (inert refactor)', () => {
    const union = [...SECURITY_DENYLIST, ...PARITY_DENYLIST];
    expect(union.length).toBe(PRE_REFACTOR_DISALLOWED.length);
    expect([...union].sort()).toEqual([...PRE_REFACTOR_DISALLOWED].sort());
  });
});

describe('SDK_DISALLOWED_TOOLS (claude.ts public export)', () => {
  it('remains byte-equivalent (set + length) to the pre-refactor list', () => {
    expect(SDK_DISALLOWED_TOOLS.length).toBe(PRE_REFACTOR_DISALLOWED.length);
    expect([...SDK_DISALLOWED_TOOLS].sort()).toEqual([...PRE_REFACTOR_DISALLOWED].sort());
  });
});
