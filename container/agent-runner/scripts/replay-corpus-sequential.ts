#!/usr/bin/env bun
/**
 * A2.4 — Sequential corpus replay (per-board chronological).
 *
 * Companion to A2.2's `replay-corpus.ts`. A2.2 forks PER MUTATION (each
 * call sees the same post-state snapshot). A2.4 forks ONCE PER BOARD and
 * replays that board's mutations in JSONL-chronological order against
 * the persistent fork — step N sees step N-1's effect, mirroring how the
 * engine ran in production.
 *
 * The replay still starts from the post-state snapshot (we have no
 * pre-state), so early steps still hit clone-state drift (`already done`,
 * `already assigned`, …). The goal isn't 100% parity — it's to verify v2
 * stays consistent under a real chronological stream.
 *
 * Usage:
 *   bun container/agent-runner/scripts/replay-corpus-sequential.ts \
 *     --jsonls /tmp/v2-pilot/all-sessions \
 *     --ref-db /tmp/v2-pilot/taskflow.db \
 *     --board-from path:0 --board-prefix board- \
 *     [--report-json /tmp/replay-sequential.json] [--limit-boards 5]
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

interface SeqRecord {
  jsonl: string;
  board_id: string;
  tool_use_id: string;
  tool_name: string;
  timestamp?: string;
  sequence_index: number;
  verdict: Verdict;
  v1_success: boolean | null;
  v2_success: boolean | null;
  v2_error_code?: string;
  divergence?: string;
  engine_error?: string;
}

interface BoardSummary {
  board_id: string;
  mutations: number;
  by_verdict: Partial<Record<Verdict, number>>;
  comparator_match: number;
  non_regression_rate: number;
}

/**
 * Order: timestamp asc → within-file line_index asc → tool_use_id.
 * Mutations without a timestamp sort to the END.
 *
 * line_index is per-JSONL monotonic (parser counter resets per file), so it
 * is ONLY meaningful when comparing two mutations from the same jsonl. For
 * cross-JSONL ties (parallel sessions same timestamp), we fall back to
 * tool_use_id — arbitrary but stable. See `sameTimestampCrossFileTies` in
 * the report to audit how often this fallback fires.
 */
function compareEntries(
  a: { mutation: ExtractedMutation; jsonl: string },
  b: { mutation: ExtractedMutation; jsonl: string },
): number {
  const am = a.mutation, bm = b.mutation;
  if (!am.timestamp !== !bm.timestamp) return am.timestamp ? -1 : 1;
  if (am.timestamp && bm.timestamp && am.timestamp !== bm.timestamp) {
    return am.timestamp < bm.timestamp ? -1 : 1;
  }
  if (a.jsonl === b.jsonl &&
      am.line_index !== undefined && bm.line_index !== undefined &&
      am.line_index !== bm.line_index) {
    return am.line_index - bm.line_index;
  }
  return am.tool_use_id.localeCompare(bm.tool_use_id);
}

async function main() {
  let shared: SharedArgs;
  try {
    shared = parseSharedArgs(process.argv, '/tmp/replay-scratch-seq');
  } catch (e) {
    console.error(`${(e as Error).message}\n  [--limit-boards N] caps how many boards to replay (smoke-test).`);
    process.exit(2);
  }
  const limitBoards = shared.extra['limit-boards']
    ? parseInt(shared.extra['limit-boards'], 10)
    : undefined;
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

  // Group mutations by board_id; remember the jsonl each came from as a
  // parallel array so the records aren't gratuitously cloned.
  const byBoard = new Map<string, { mutation: ExtractedMutation; jsonl: string }[]>();
  let totalExtracted = 0;
  for (const jsonl of jsonls) {
    const boardId = deriveBoardId(jsonl, shared.jsonlsRoot, shared.boardFrom, shared.boardPrefix);
    let mutations: ExtractedMutation[];
    try {
      mutations = parseJsonlForMutations(fs.readFileSync(jsonl, 'utf8'));
    } catch (e) {
      console.warn(`SKIP malformed JSONL ${jsonl}: ${e}`);
      continue;
    }
    if (!mutations.length) continue;
    const bucket = byBoard.get(boardId) ?? [];
    for (const m of mutations) bucket.push({ mutation: m, jsonl });
    byBoard.set(boardId, bucket);
    totalExtracted += mutations.length;
  }

  // Count same-timestamp cross-JSONL ties so the report makes the ordering
  // approximation auditable (Codex IMPORTANT). Counted before sort because
  // sort is in-place and we want pre-resolution stats.
  let sameTimestampCrossFileTies = 0;
  for (const bucket of byBoard.values()) {
    bucket.sort(compareEntries);
    for (let i = 1; i < bucket.length; i++) {
      const prev = bucket[i - 1], cur = bucket[i];
      if (
        prev.mutation.timestamp &&
        prev.mutation.timestamp === cur.mutation.timestamp &&
        prev.jsonl !== cur.jsonl
      ) {
        sameTimestampCrossFileTies++;
      }
    }
  }
  if (sameTimestampCrossFileTies > 0) {
    console.log(
      `  NOTE: ${sameTimestampCrossFileTies} same-timestamp cross-JSONL ties resolved by tool_use_id (arbitrary).`,
    );
  }

  console.log(`Boards: ${byBoard.size}; total mutations: ${totalExtracted}`);
  for (const [bid, list] of byBoard) {
    console.log(`  ${bid}: ${list.length} mutations`);
  }

  // Single-pass aggregation: fold per-board counts into the global accumulator
  // while iterating; no second pass over `records`.
  const records: SeqRecord[] = [];
  const boardSummaries: BoardSummary[] = [];
  const globalVerdictCounts: Partial<Record<Verdict, number>> = {};

  let boardsProcessed = 0;
  for (const [boardId, mutations] of byBoard) {
    if (limitBoards && boardsProcessed >= limitBoards) break;
    boardsProcessed++;

    const scratch = path.join(shared.scratchDir, `${boardId}.db`);
    const perBoard: SeqRecord[] = [];
    const boardVerdictCounts: Partial<Record<Verdict, number>> = {};
    let executable = 0;
    let matches = 0;        // strict v1≡v2 (verdict='match' only)
    let nonRegression = 0;  // matches + divergent_payload + relaxation

    // Open the persistent DB fork once per board. Engine is fresh per
    // mutation — mirrors production where each MCP tool call instantiates
    // a new TaskflowEngine (constructor runs ensureTaskSchema +
    // reconcileDelegationLinks; cached _boardTz / _holidayCache can otherwise
    // go stale mid-sequence if a mutation changes timezone or holidays).
    let db: Database | null = null;
    try {
      forkSqliteDb(shared.refDb, scratch);
      db = new Database(scratch);
    } catch (e: unknown) {
      // Whole-board setup failure (Codex BLOCKER): emit one engine-error
      // record per intended mutation so assertEngineErrorBudget can see them.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Board ${boardId} setup failed: ${msg}`);
      for (const [idx0, { mutation: m, jsonl }] of mutations.entries()) {
        const rec: SeqRecord = {
          jsonl: path.relative(shared.jsonlsRoot, jsonl),
          board_id: boardId,
          tool_use_id: m.tool_use_id,
          tool_name: m.tool_name,
          timestamp: m.timestamp,
          sequence_index: idx0 + 1,
          verdict: 'cannot_compare',
          v1_success: m.output ? Boolean(m.output.success) : null,
          v2_success: null,
          divergence: `board setup failed: ${msg}`,
          engine_error: msg,
        };
        perBoard.push(rec);
        boardVerdictCounts.cannot_compare = (boardVerdictCounts.cannot_compare ?? 0) + 1;
        globalVerdictCounts.cannot_compare = (globalVerdictCounts.cannot_compare ?? 0) + 1;
      }
    }

    if (db) {
      try {
        for (const [idx0, { mutation: m, jsonl }] of mutations.entries()) {
          let v2Out: Record<string, unknown> | null = null;
          let engineError: string | undefined;
          try {
            const engine = new TaskflowEngine(db, boardId);
            const call = v1ToV2EngineCall(m.tool_name, m.input, boardId);
            v2Out = runMutation(engine, call) as Record<string, unknown>;
          } catch (e: unknown) {
            engineError = e instanceof Error ? e.message : String(e);
          }
          const comparison = compareReplayResult(m.output, v2Out);
          const rec: SeqRecord = {
            jsonl: path.relative(shared.jsonlsRoot, jsonl),
            board_id: boardId,
            tool_use_id: m.tool_use_id,
            tool_name: m.tool_name,
            timestamp: m.timestamp,
            sequence_index: idx0 + 1,
            verdict: comparison.verdict,
            v1_success: comparison.v1_success,
            v2_success: comparison.v2_success,
            v2_error_code: comparison.v2_error_code,
            divergence: comparison.divergence,
            engine_error: engineError,
          };
          perBoard.push(rec);
          boardVerdictCounts[rec.verdict] = (boardVerdictCounts[rec.verdict] ?? 0) + 1;
          globalVerdictCounts[rec.verdict] = (globalVerdictCounts[rec.verdict] ?? 0) + 1;
          if (rec.verdict !== 'cannot_compare') executable++;
          if (rec.verdict === 'match') matches++;
          if (rec.verdict === 'divergent_payload' || rec.verdict === 'relaxation') nonRegression++;
        }
      } finally {
        db.close();
        cleanScratch(scratch);
      }
    } else {
      cleanScratch(scratch);
    }

    const comparatorMatch = executable === 0 ? 0 : matches / executable;
    const nonRegressionRate = executable === 0 ? 0 : (matches + nonRegression) / executable;
    boardSummaries.push({
      board_id: boardId,
      mutations: perBoard.length,
      by_verdict: boardVerdictCounts,
      comparator_match: comparatorMatch,
      non_regression_rate: nonRegressionRate,
    });
    records.push(...perBoard);

    process.stdout.write(
      `  ${boardId}: ${perBoard.length} replayed; ` +
        `comparator-match ${(comparatorMatch * 100).toFixed(1)}%, non-regression ${(nonRegressionRate * 100).toFixed(1)}%\n`,
    );
  }

  const executable = records.length - (globalVerdictCounts.cannot_compare ?? 0);
  const comparatorMatches = globalVerdictCounts.match ?? 0;
  const nonRegressionTotal =
    comparatorMatches +
    (globalVerdictCounts.divergent_payload ?? 0) +
    (globalVerdictCounts.relaxation ?? 0);
  const comparatorMatch = executable === 0 ? 0 : comparatorMatches / executable;
  const nonRegressionRate = executable === 0 ? 0 : nonRegressionTotal / executable;

  console.log('\n=== Sequential replay summary ===');
  console.log(`Boards replayed: ${boardSummaries.length}`);
  console.log(`Total mutations: ${records.length}`);
  console.log(`Executable: ${executable}`);
  // Comparator-match: compareReplayResult returned 'match'. Note this is NOT
  // strict byte-equality — successful results compare only task_id, and
  // failed results compare only error_code (compareReplayResult.ts:74,89).
  // Non-regression: comparator-match + divergent_payload (ID-counter drift)
  // + relaxation (v2 more permissive). Useful for cutover go/no-go, but
  // tighten the comparator if you need stricter semantic parity.
  console.log(`Comparator-match: ${(comparatorMatch * 100).toFixed(1)}% (${comparatorMatches}/${executable})`);
  console.log(`Non-regression rate: ${(nonRegressionRate * 100).toFixed(1)}% (${nonRegressionTotal}/${executable})`);
  console.log('\nBy verdict:');
  for (const v of VERDICTS_PRINT_ORDER) {
    if (globalVerdictCounts[v]) console.log(`  ${v}: ${globalVerdictCounts[v]}`);
  }
  console.log('\nTop 10 boards by mutation count:');
  for (const s of boardSummaries.sort((a, b) => b.mutations - a.mutations).slice(0, 10)) {
    console.log(
      `  ${s.board_id}: ${s.mutations} muts, cmp-match ${(s.comparator_match * 100).toFixed(1)}%, ` +
        `non-reg ${(s.non_regression_rate * 100).toFixed(1)}%, ` +
        Object.entries(s.by_verdict).map(([v, n]) => `${v}=${n}`).join(' '),
    );
  }

  if (shared.reportJson) {
    fs.writeFileSync(
      shared.reportJson,
      JSON.stringify(
        {
          records,
          verdictCounts: globalVerdictCounts,
          boardSummaries,
          overall_comparator_match: comparatorMatch,
          overall_non_regression_rate: nonRegressionRate,
          same_timestamp_cross_file_ties: sameTimestampCrossFileTies,
        },
        null,
        2,
      ),
    );
    console.log(`\nWrote full report to ${shared.reportJson}`);
  }

  assertEngineErrorBudget(records);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
