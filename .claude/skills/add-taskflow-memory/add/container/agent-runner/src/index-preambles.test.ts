import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Source-level regression tests for the prompt-prepend blocks in
 * `src/index.ts`. The module is hard to import as a library (top-level
 * awaits and required env vars), so we assert on the source text instead.
 */

const SOURCE_PATH = path.join(__dirname, 'index.ts');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

describe('agent-runner prompt preambles', () => {
  it('memory preamble runs only on TaskFlow-managed boards with a board ID', () => {
    const start = source.indexOf('Memory layer: per-board recall preamble');
    expect(start, 'memory preamble block not found').toBeGreaterThan(-1);
    const block = source.slice(start, start + 5000);
    expect(block).toContain('memoryPreambleEnabled');
    expect(block).toContain('containerInput.isTaskflowManaged');
    expect(block).toContain('containerInput.taskflowBoardId');
  });

  it('memory preamble delegates scope + HTTP to memory-client (DRY with MCP tools)', () => {
    const start = source.indexOf('Memory layer: per-board recall preamble');
    const block = source.slice(start, start + 5000);
    expect(block).toContain("'./memory-client.js'");
    expect(block).toContain('searchMemory(');
    expect(block).toContain('formatPreamble(');
    expect(block).toContain('parseKillSwitch(');
  });

  it('memory preamble caps the token budget so it cannot dominate the prompt', () => {
    const start = source.indexOf('Memory layer: per-board recall preamble');
    const block = source.slice(start, start + 5000);
    expect(block).toContain('let budget = 500');
    expect(block).toContain('estimateTokens');
  });

  it('memory preamble fails soft (no thrown error escapes; uses 2s timeout)', () => {
    const start = source.indexOf('Memory layer: per-board recall preamble');
    const block = source.slice(start, start + 5000);
    expect(block).toMatch(/try\s*\{[\s\S]+?\}\s*catch\s*\(err\)\s*\{[\s\S]+?Memory preamble skipped/);
    expect(block).toContain('timeoutMs: 2000');
  });

  it('memory preamble is skipped for script-driven scheduled tasks', () => {
    const start = source.indexOf('Memory layer: per-board recall preamble');
    const block = source.slice(start, start + 5000);
    expect(block).toContain('containerInput.script && containerInput.isScheduledTask');
  });

  it('memory preamble uses the permissive kill-switch parser (handles typos by failing safe)', () => {
    const start = source.indexOf('Memory layer: per-board recall preamble');
    const block = source.slice(start, start + 5000);
    expect(block).toContain('NANOCLAW_MEMORY_PREAMBLE_ENABLED');
    expect(block).toContain('parseKillSwitch(process.env.NANOCLAW_MEMORY_PREAMBLE_ENABLED)');
    // Warn surface for unknown values must be logged.
    expect(block).toContain('killSwitch.warn');
  });
});
