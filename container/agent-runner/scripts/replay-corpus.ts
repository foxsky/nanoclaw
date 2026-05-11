#!/usr/bin/env bun
/**
 * A2.2 — Corpus replay orchestrator (per-mutation fork).
 *
 * For each v1 mutation captured in session JSONL files: fork the reference
 * `taskflow.db` to scratch, dispatch the equivalent v2 engine call, compare
 * v1 ↔ v2 results, aggregate per-verdict counts. Forks are PER MUTATION —
 * each call runs against the same post-state snapshot in isolation.
 * A2.4's sequential variant (replay-corpus-sequential.ts) forks once per
 * board instead and replays chronologically.
 *
 * Usage:
 *   bun container/agent-runner/scripts/replay-corpus.ts \
 *     --jsonls /tmp/v2-pilot/all-sessions \
 *     --ref-db /tmp/v2-pilot/taskflow.db \
 *     --board-from path:0 \
 *     [--report-json /tmp/replay-report.json] \
 *     [--limit 50]
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  parseJsonlForMutations,
  v1ToV2EngineCall,
  type ExtractedMutation,
} from '../../../scripts/mutation-replay-harness.ts';
import { forkSqliteDb } from '../../../scripts/mutation-replay-fork.ts';
import {
  compareReplayResult,
  type Verdict,
} from '../../../scripts/mutation-replay-compare.ts';
import { Database } from 'bun:sqlite';
import { TaskflowEngine } from '../src/taskflow-engine.ts';
import { runMutation } from '../src/mutation-replay-runner.ts';
import {
  parseSharedArgs,
  findJsonls,
  deriveBoardId,
  cleanScratch,
  VERDICTS_PRINT_ORDER,
  assertEngineErrorBudget,
  type SharedArgs,
} from './replay-shared.ts';

interface ReplayRecord {
  jsonl: string;
  board_id: string;
  tool_use_id: string;
  tool_name: string;
  verdict: Verdict;
  v1_success: boolean | null;
  v2_success: boolean | null;
  v2_error_code?: string;
  divergence?: string;
  engine_error?: string;
}

async function main() {
  let shared: SharedArgs;
  try {
    shared = parseSharedArgs(process.argv, '/tmp/replay-scratch');
  } catch (e) {
    console.error(`${(e as Error).message}\n  [--limit N] additionally caps total mutations replayed.`);
    process.exit(2);
  }
  const limit = shared.extra.limit ? parseInt(shared.extra.limit, 10) : undefined;
  fs.mkdirSync(shared.scratchDir, { recursive: true });

  const refDbStat = fs.statSync(shared.refDb);
  if (!refDbStat.isFile()) {
    throw new Error(`--ref-db must be a file, got: ${shared.refDb}`);
  }

  const jsonls = findJsonls(shared.jsonlsRoot);
  if (jsonls.length === 0) {
    console.error(`No .jsonl files under ${shared.jsonlsRoot}`);
    process.exit(1);
  }
  console.log(`Found ${jsonls.length} JSONL files; using ref DB ${shared.refDb}`);

  const records: ReplayRecord[] = [];
  let total = 0;

  outer: for (const jsonl of jsonls) {
    const boardId = deriveBoardId(jsonl, shared.jsonlsRoot, shared.boardFrom, shared.boardPrefix);
    let mutations: ExtractedMutation[];
    try {
      mutations = parseJsonlForMutations(fs.readFileSync(jsonl, 'utf8'));
    } catch (e) {
      console.warn(`SKIP malformed JSONL ${jsonl}: ${e}`);
      continue;
    }

    for (const m of mutations) {
      if (limit && total >= limit) break outer;
      total++;

      const scratch = path.join(
        shared.scratchDir,
        `${path.basename(jsonl, '.jsonl')}-${m.tool_use_id}.db`,
      );
      let v2Out: Record<string, unknown> | null = null;
      let engineError: string | undefined;
      try {
        forkSqliteDb(shared.refDb, scratch);
        const call = v1ToV2EngineCall(m.tool_name, m.input, boardId);
        const db = new Database(scratch);
        try {
          const engine = new TaskflowEngine(db, boardId);
          v2Out = runMutation(engine, call) as Record<string, unknown>;
        } finally {
          db.close();
        }
      } catch (e: unknown) {
        engineError = e instanceof Error ? e.message : String(e);
      } finally {
        cleanScratch(scratch);
      }

      const comparison = compareReplayResult(m.output, v2Out);
      records.push({
        jsonl: path.relative(shared.jsonlsRoot, jsonl),
        board_id: boardId,
        tool_use_id: m.tool_use_id,
        tool_name: m.tool_name,
        verdict: comparison.verdict,
        v1_success: comparison.v1_success,
        v2_success: comparison.v2_success,
        v2_error_code: comparison.v2_error_code,
        divergence: comparison.divergence,
        engine_error: engineError,
      });

      if ((records.length % 25) === 0) {
        process.stdout.write(`  ... ${records.length} mutations replayed\n`);
      }
    }
  }

  const verdictCounts: Partial<Record<Verdict, number>> = {};
  const toolCounts: Record<string, Partial<Record<Verdict, number>>> = {};
  for (const r of records) {
    verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1;
    toolCounts[r.tool_name] ??= {};
    toolCounts[r.tool_name][r.verdict] = (toolCounts[r.tool_name][r.verdict] ?? 0) + 1;
  }

  console.log('\n=== Replay summary ===');
  console.log(`Total mutations: ${records.length}`);
  console.log('\nBy verdict:');
  for (const v of VERDICTS_PRINT_ORDER) {
    if (verdictCounts[v]) console.log(`  ${v}: ${verdictCounts[v]}`);
  }
  console.log('\nBy tool:');
  for (const [tool, counts] of Object.entries(toolCounts).sort((a, b) =>
    Object.values(b[1]).reduce((s, n) => s + (n ?? 0), 0) -
    Object.values(a[1]).reduce((s, n) => s + (n ?? 0), 0)
  )) {
    const total = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);
    const verdictPairs = Object.entries(counts).map(([v, n]) => `${v}=${n}`).join(' ');
    console.log(`  ${tool}: ${total} (${verdictPairs})`);
  }

  const regressions = records.filter((r) => r.verdict === 'regression');
  if (regressions.length > 0) {
    console.log('\n=== Regressions (priority for A2.3 triage) ===');
    for (const r of regressions.slice(0, 30)) {
      console.log(`  [${r.tool_name}] ${r.jsonl} → ${r.divergence}`);
    }
    if (regressions.length > 30) {
      console.log(`  ... and ${regressions.length - 30} more`);
    }
  }

  if (shared.reportJson) {
    fs.writeFileSync(shared.reportJson, JSON.stringify({ records, verdictCounts, toolCounts }, null, 2));
    console.log(`\nWrote full report to ${shared.reportJson}`);
  }

  assertEngineErrorBudget(records);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
