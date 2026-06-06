import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Subprocess-gate invariant (Codex gpt-5.5/xhigh 2026-06-05).
 *
 * `isTaskflowSubprocess()` is the discriminator that stops the FastAPI/dashboard
 * subprocess from writing SESSION DBs — it gates dispatchNotificationEvents,
 * emitDeterministicToolMessage, the mutation-dedup write-side, and
 * emitAutoProvisionIfRequested. Those guards are SAFE for the in-session WhatsApp
 * agent ONLY because `getVerbatimIds()` is false there, which holds ONLY because
 * `setVerbatimIds(true)` is called EXCLUSIVELY by the subprocess entry
 * (taskflow-server-entry.ts) — never by the in-session MCP-tools barrel or any
 * tool module it loads.
 *
 * If a future change adds `setVerbatimIds(true)` to an in-session-loaded module,
 * the in-session guards would SILENTLY no-op the load-bearing cross-process dedup
 * (the "Tarefa criada" card + bare-text suppression) with no handler-level test
 * catching it. This test enforces the invariant at the source level.
 */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(p));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('subprocess-gate invariant: setVerbatimIds(true) is subprocess-entry-only', () => {
  it('only taskflow-server-entry.ts CALLS setVerbatimIds(true) in non-comment, non-test source', () => {
    const srcRoot = join(import.meta.dir, '..'); // container/agent-runner/src
    const callers = walkTsFiles(srcRoot)
      .filter((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .some((line) => !isCommentLine(line) && /setVerbatimIds\s*\(\s*true\s*\)/.test(line)),
      )
      .map((file) => file.replace(srcRoot + '/', ''));
    expect(callers).toEqual(['mcp-tools/taskflow-server-entry.ts']);
  });
});
