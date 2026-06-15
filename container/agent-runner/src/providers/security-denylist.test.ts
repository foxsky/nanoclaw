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
  // #412: subagent-spawn (Task*) + teams (Team*) + the SDK's built-in SendMessage are capability
  // escapes — a subagent doesn't inherit this denylist, and SendMessage bypasses the curated/gated
  // send_message. They were in TOOL_ALLOWLIST but denied by neither list before #412.
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  // RC5-ext C4c: MCP-resource readers (see security-denylist.ts).
  'ListMcpResources',
  'ReadMcpResource',
];

// #412 additions to the disallowed set — capability escapes that were advertised in TOOL_ALLOWLIST
// but previously denied by neither list. The union/SDK assertions below expect PRE_REFACTOR + these.
const SEC412_ADDITIONS = ['Task', 'TaskOutput', 'TaskStop', 'TeamCreate', 'TeamDelete', 'SendMessage'];
// RC5-ext C4c additions — MCP-resource readers denied for every turn.
const RC5EXT_ADDITIONS = ['ListMcpResources', 'ReadMcpResource'];

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

  it('equal the pre-refactor set plus the #412 capability-escape additions', () => {
    const expected = [...PRE_REFACTOR_DISALLOWED, ...SEC412_ADDITIONS, ...RC5EXT_ADDITIONS];
    const union = [...SECURITY_DENYLIST, ...PARITY_DENYLIST];
    expect(union.length).toBe(expected.length);
    expect([...union].sort()).toEqual([...expected].sort());
  });
});

describe('SDK_DISALLOWED_TOOLS (claude.ts public export)', () => {
  it('equals the pre-refactor set plus the #412 capability-escape additions', () => {
    const expected = [...PRE_REFACTOR_DISALLOWED, ...SEC412_ADDITIONS, ...RC5EXT_ADDITIONS];
    expect(SDK_DISALLOWED_TOOLS.length).toBe(expected.length);
    expect([...SDK_DISALLOWED_TOOLS].sort()).toEqual([...expected].sort());
  });

  it('#412: actually denies the subagent-spawn / teams / SDK-send escape tools', () => {
    for (const tool of SEC412_ADDITIONS) {
      expect(SDK_DISALLOWED_TOOLS).toContain(tool);
    }
  });
});
