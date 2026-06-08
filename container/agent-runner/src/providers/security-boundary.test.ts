// SECURITY BOUNDARY (red-team) suite — the provider-level capability boundary.
//
// This file asserts the TaskFlow container boundary holds STRUCTURALLY (code,
// not model obedience). The deterministic guarantee for "the agent cannot reach
// a secret path or run raw SQL on taskflow.db" is the REMOVAL of the file/shell/
// web/raw-db CAPABILITIES — not the CLAUDE.md prompt. We assert that removal
// here, plus the second-wall PreToolUse block-decision.
//
// NOTE on scope (surfaced, not papered over):
//   - Secret-path refusal (.env / .mcp.json / credentials) is enforced
//     PROMPT-ONLY (templates/CLAUDE.md.template). There is NO path blocklist in
//     container/agent-runner/src. The deterministic fact is that Bash/Read/
//     Write/Edit/Grep/Glob/LS are all removed (no file-read tool exists), so the
//     agent cannot reach ANY file path regardless of the prompt. We assert THAT
//     (capability removal). We do NOT assert path-string refusal, because no
//     deterministic code path enforces it.
//   - The destructive-gate classifier (mass/delete/structure/broadcast) is
//     covered by destructive-gate.test.ts. As of this unit it is a PURE
//     classifier with ZERO non-test callers (not yet wired into the MCP tools);
//     its tests assert the classification, not an ACTIVE runtime gate.
import { describe, expect, it } from 'bun:test';

import { SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST, preToolUseHook } from './claude.js';

describe('SDK_DISALLOWED_TOOLS — dangerous-set completeness', () => {
  it('removes every file/shell/web/raw-db capability the agent could use to reach a secret path or bypass the curated API', () => {
    // WHY (intent): these are the ONLY tools that could read .env/.mcp.json/
    // credentials or run raw SQL on the RW-mounted global taskflow.db. Their
    // presence in SDK_DISALLOWED_TOOLS — not the CLAUDE.md prompt — is what makes
    // secret-path refusal and the taskflow.db-unreachable invariant deterministic.
    //
    // The DENYLIST is the enforcement wall for these (the SDK applies
    // disallowedTools on top of allowedTools, and disallowedTools wins). Several
    // of these builtins (Bash/Read/Write/Edit/Glob/Grep) are deliberately ALSO
    // in TOOL_ALLOWLIST — the codebase relies on the denylist, not allowlist
    // absence, to remove them (see factory.test.ts cluster tests, which assert
    // only denylist membership for that set). So we assert denylist membership
    // for ALL, and allowlist-absence only for the tools that are genuinely not
    // allowlisted (the others would give a false sense of a second wall here).
    const DANGEROUS = [
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
    for (const t of DANGEROUS) {
      expect(SDK_DISALLOWED_TOOLS).toContain(t);
    }
    // These dangerous tools are NOT in TOOL_ALLOWLIST at all — so for them the
    // denylist AND allowlist-absence both hold (two independent walls). The
    // sqlite raw-db tools matter most here: they must never be reachable via the
    // wildcard MCP allow pattern OR a literal allowlist entry.
    const NOT_ALLOWLISTED = [
      'MultiEdit',
      'LS',
      'WebFetch',
      'WebSearch',
      'mcp__sqlite__read_query',
      'mcp__sqlite__write_query',
      'mcp__sqlite__list_tables',
      'mcp__sqlite__describe_table',
    ];
    for (const t of NOT_ALLOWLISTED) {
      expect(TOOL_ALLOWLIST).not.toContain(t);
    }
  });

  it('also removes the interactive ask tool and the Agent/subagent spawn that could re-derive a shell', () => {
    // mcp__nanoclaw__ask_user_question: the v2 interactive card flow is denied
    // (parity + it changes observable reply shape). Agent: a subagent could
    // re-acquire a workspace toolset and indirectly reach a shell.
    expect(SDK_DISALLOWED_TOOLS).toContain('mcp__nanoclaw__ask_user_question');
    expect(SDK_DISALLOWED_TOOLS).toContain('Agent');
  });
});

describe('preToolUse block hook — deterministic deny on every disallowed tool', () => {
  it('returns decision:block for EVERY entry in SDK_DISALLOWED_TOOLS (defense-in-depth even if the SDK allowlist is bypassed)', async () => {
    // WHY (intent): SDK_DISALLOWED_TOOLS is the allowlist FILTER passed to the
    // SDK; the hook is the SECOND wall. The boundary must hold even if a future
    // SDK build ignores disallowedTools. This iterates the WHOLE set so a future
    // edit that adds a denylist entry but forgets the hook predicate is caught.
    for (const tool of SDK_DISALLOWED_TOOLS) {
      const r = await preToolUseHook({ tool_name: tool }, undefined as never, undefined as never);
      expect((r as { decision?: string }).decision).toBe('block');
      // The block reason must name the specific tool (host approval prompts and
      // logs key off it).
      expect((r as { stopReason?: string }).stopReason).toContain(tool);
    }
  });

  it('blocks a raw-sqlite call by exact name even though MCP namespaces are otherwise allowed', async () => {
    // Ties the hook to the taskflow.db-unreachable invariant: even though the
    // nanoclaw/taskflow MCP namespaces are allowlisted, the raw sqlite tools are
    // denied by EXACT name (the denylist enumerates them, not a wildcard).
    const r = await preToolUseHook({ tool_name: 'mcp__sqlite__write_query' }, undefined as never, undefined as never);
    expect((r as { decision?: string }).decision).toBe('block');
  });

  it('does NOT block a legitimate curated tool (the boundary must not over-block normal MCP work)', async () => {
    // The gate is asymmetric on purpose: deny the dangerous set, pass everything
    // else. If this flips, the agent can no longer do its actual job — a boundary
    // that blocks the curated taskflow tools is as broken as one that lets Bash
    // through. (The hook's setContainerToolInFlight side-effect fails soft inside
    // a try/catch when no outbound.db mount exists, so the return is unaffected.)
    const ok = await preToolUseHook(
      { tool_name: 'mcp__taskflow__taskflow_create', tool_input: {} },
      undefined as never,
      undefined as never,
    );
    expect((ok as { continue?: boolean }).continue).toBe(true);
    expect((ok as { decision?: string }).decision).toBeUndefined();
  });
});
