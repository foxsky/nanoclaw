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
    expect(block).toContain('selectWithinTokenBudget');
    expect(block).toContain('500'); // budget literal
  });

  it('memory preamble fails soft (no thrown error escapes; tight 800ms timeout caps outage cost)', () => {
    const start = source.indexOf('Memory layer: per-board recall preamble');
    const block = source.slice(start, start + 5000);
    expect(block).toMatch(/try\s*\{[\s\S]+?\}\s*catch\s*\(err\)\s*\{[\s\S]+?Memory preamble skipped/);
    expect(block).toContain('timeoutMs: 800');
  });

  it('memory preamble pre-checks audit DB existence before HTTP (saves RTT on never-stored boards)', () => {
    const start = source.indexOf('Memory layer: per-board recall preamble');
    const block = source.slice(start, start + 5000);
    expect(block).toContain("'/workspace/group/.nanoclaw/memory/memory.db'");
    expect(block).toContain('fs.existsSync(auditDbPath)');
    expect(block).toContain('no local audit sidecar');
  });

  it('memory preamble uses strict token budget so a single oversized fact cannot dominate', () => {
    const start = source.indexOf('Memory layer: per-board recall preamble');
    const block = source.slice(start, start + 5000);
    expect(block).toContain('strict: true');
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
    expect(block).toContain('memoryClient.parseKillSwitch');
    // Warn surface for unknown values must be logged.
    expect(block).toContain('killSwitch.warn');
  });

  it('preambles fetch in parallel via Promise.all (memory HTTP + 2 DB reads)', () => {
    // The three preamble fetches are independent — memory talks to
    // agent-memory-server over HTTP, summary opens context.db,
    // verbatim opens messages.db. Running them sequentially adds the
    // HTTP roundtrip latency to every TaskFlow turn. Promise.all is
    // the higher-leverage fix from the simplify pass.
    expect(source).toMatch(/Promise\.all\(\s*\[/);
    // Each Promise.all entry must be one of the three build helpers,
    // dispatched in the order they push into preambleBlocks.
    const promiseAllIdx = source.indexOf('Promise.all([');
    expect(promiseAllIdx).toBeGreaterThan(0);
    const block = source.slice(promiseAllIdx, promiseAllIdx + 500);
    expect(block).toContain('buildMemoryPreamble');
    expect(block).toContain('buildSummaryRecap');
    expect(block).toContain('buildVerbatimRecap');
  });

  it('preambles assemble in summary -> memory -> verbatim -> user_msg order', () => {
    // The final prompt the agent sees must be:
    //   summary (oldest context, farthest)
    //   memory (per-board facts, middle)
    //   verbatim (most recent context, closest to user message)
    //   user message
    //
    // Regression for review #4 finding B2: the original prepend-each-block
    // order produced verbatim FARTHEST from the user message, opposite to
    // intent. The fix is to build each block as a string variable and
    // concatenate once in the desired order.
    expect(source).toContain('preambleBlocks');
    // Exactly one final assembly that prepends preamble blocks to prompt.
    expect(source).toMatch(
      /preambleBlocks\.join\(['"]\\n\\n['"]\)\s*\+\s*['"]\\n\\n['"]\s*\+\s*prompt/,
    );
    // The push order must be summary -> memory -> verbatim. Each push
    // call uses the variable holding that block's string.
    const pushSummaryIdx = source.indexOf('preambleBlocks.push(summaryRecapStr');
    const pushMemoryIdx = source.indexOf('preambleBlocks.push(memoryPreambleStr');
    const pushVerbatimIdx = source.indexOf('preambleBlocks.push(verbatimRecapStr');
    expect(pushSummaryIdx).toBeGreaterThan(0);
    expect(pushMemoryIdx).toBeGreaterThan(0);
    expect(pushVerbatimIdx).toBeGreaterThan(0);
    expect(pushSummaryIdx).toBeLessThan(pushMemoryIdx);
    expect(pushMemoryIdx).toBeLessThan(pushVerbatimIdx);
  });

  it('verbatim recap passes currentMessageTimestamp as the excludeFrom boundary', () => {
    // Review #4 finding B1: the wallclock heuristic (now - 5s) does not
    // match sender-claimed WhatsApp timestamps under delivery latency.
    // Callers MUST pass containerInput.currentMessageTimestamp.
    const callIdx = source.indexOf('getRecentVerbatimTurns(');
    expect(callIdx).toBeGreaterThan(0);
    const callBlock = source.slice(callIdx, callIdx + 1000);
    expect(callBlock).toContain('excludeFrom');
    expect(callBlock).toContain('containerInput.currentMessageTimestamp');
  });

  it('all three preamble blocks are skipped for script-driven scheduled tasks', () => {
    // memory + summary + verbatim recaps are agent context. Script-driven
    // scheduled tasks (the daily auditor) must have a deterministic
    // prompt — no leaking conversation history.
    const guardIdx = source.indexOf(
      'containerInput.script && containerInput.isScheduledTask',
    );
    expect(guardIdx).toBeGreaterThan(0);
    // The script-task guard appears at least once before the assembly.
    const assemblyIdx = source.indexOf('preambleBlocks.join');
    expect(assemblyIdx).toBeGreaterThan(guardIdx);
  });
});
