#!/usr/bin/env bun
/**
 * A2.2 — Corpus replay orchestrator for the v1→v2 mutation parity test.
 *
 * Glues the A2.1 building blocks (host-side pure helpers in scripts/,
 * Bun-side runner in src/) into one runnable command. For each v1 mutation
 * captured in session JSONL files:
 *
 *   1. parseJsonlForMutations  → extract paired (tool_use, tool_result)
 *   2. v1ToV2EngineCall        → map to engine method + params (inject board_id)
 *   3. forkSqliteDb            → clone the reference taskflow.db to scratch
 *   4. runMutation             → dispatch engine[method](params) on scratch
 *   5. compareReplayResult     → judge v1 ↔ v2 parity (verdict tag)
 *
 * Aggregates per-verdict counts and surfaces regressions for A2.3 triage.
 *
 * Usage:
 *   bun container/agent-runner/scripts/replay-corpus.ts \\
 *     --jsonls /tmp/v2-pilot/all-sessions \\
 *     --ref-db /tmp/v2-pilot/taskflow.db \\
 *     --board-from path:0 \\
 *     [--report-json /tmp/replay-report.json] \\
 *     [--limit 50]
 *
 * `--jsonls` is a ROOT DIRECTORY (the script walks it recursively for any
 * `.jsonl` file). Don't pass a shell glob — quoting/expansion mismatches
 * would silently zero-match.
 *
 * The `--board-from` arg controls how board_id is derived from a JSONL path:
 *   path:N        — split the JSONL's path-relative-to-the-jsonls-root and
 *                   take segment N (0 = first folder, e.g. "secti-taskflow")
 *   const:<id>    — use a literal board_id for every JSONL
 *
 * For prod data the board folder under all-sessions/ usually matches the
 * board_id without a prefix (e.g. "seci-taskflow" → "board-seci-taskflow"),
 * so the common invocation derives "<segment0>" and adds a "board-" prefix:
 * use `--board-prefix board-` to opt in.
 *
 * The orchestrator NEVER mutates the reference DB. It forks per call to
 * a scratch file under `--scratch-dir` (default `/tmp/replay-scratch/`),
 * then unlinks the scratch after the engine call returns.
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

interface CliArgs {
  jsonlsRoot: string;
  refDb: string;
  scratchDir: string;
  boardFrom: { kind: 'path'; index: number } | { kind: 'const'; value: string };
  boardPrefix: string;
  reportJson?: string;
  limit?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) {
      throw new Error(`Unexpected positional arg: ${argv[i]}`);
    }
    args[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  const jsonlsRoot = args.jsonls;
  const refDb = args['ref-db'];
  if (!jsonlsRoot || !refDb) {
    console.error('Usage: --jsonls <root-dir> --ref-db <taskflow.db> [--board-from path:N|const:<id>] [--board-prefix board-] [--report-json <file>] [--limit N]');
    process.exit(2);
  }
  const boardFromRaw = args['board-from'] ?? 'path:0';
  let boardFrom: CliArgs['boardFrom'];
  if (boardFromRaw.startsWith('path:')) {
    boardFrom = { kind: 'path', index: parseInt(boardFromRaw.slice(5), 10) };
  } else if (boardFromRaw.startsWith('const:')) {
    boardFrom = { kind: 'const', value: boardFromRaw.slice(6) };
  } else {
    throw new Error(`Invalid --board-from: ${boardFromRaw}`);
  }
  return {
    jsonlsRoot,
    refDb,
    scratchDir: args['scratch-dir'] ?? '/tmp/replay-scratch',
    boardFrom,
    boardPrefix: args['board-prefix'] ?? '',
    reportJson: args['report-json'],
    limit: args.limit ? parseInt(args.limit, 10) : undefined,
  };
}

function findJsonls(root: string): string[] {
  // Surface the root readdir error explicitly (Codex flagged silent swallow).
  // Nested readdir errors are still tolerated — a single unreadable sub-dir
  // shouldn't kill the corpus, just trim what we replay. The summary will
  // surface engine_error counts so a wholesale failure is still visible.
  const rootStat = fs.statSync(root); // throws ENOENT if root is missing
  if (!rootStat.isDirectory()) {
    throw new Error(`--jsonls must be a directory, got: ${root}`);
  }
  const out: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) {
      if (dir === root) throw e;
      console.warn(`  WARN: skipped unreadable subdir ${dir}: ${e}`);
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && full.endsWith('.jsonl')) out.push(full);
    }
  }
  walk(root);
  return out;
}

function deriveBoardId(jsonlPath: string, args: CliArgs): string {
  if (args.boardFrom.kind === 'const') return args.boardFrom.value;
  const rel = path.relative(args.jsonlsRoot, jsonlPath);
  const segs = rel.split(path.sep);
  const seg = segs[args.boardFrom.index];
  if (!seg) {
    throw new Error(`Cannot derive board_id from ${jsonlPath} at segment ${args.boardFrom.index}`);
  }
  return `${args.boardPrefix}${seg}`;
}

interface Record {
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
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.scratchDir, { recursive: true });

  // Preflight: refDb must exist + be readable. Without this check, a wrong
  // path silently fails per-mutation as engine_error and shows up only as
  // `cannot_compare` in the final summary (Codex flagged this).
  const refDbStat = fs.statSync(args.refDb); // ENOENT throws
  if (!refDbStat.isFile()) {
    throw new Error(`--ref-db must be a file, got: ${args.refDb}`);
  }

  const jsonls = findJsonls(args.jsonlsRoot);
  if (jsonls.length === 0) {
    console.error(`No .jsonl files under ${args.jsonlsRoot}`);
    process.exit(1);
  }
  console.log(`Found ${jsonls.length} JSONL files; using ref DB ${args.refDb}`);

  const records: Record[] = [];
  let total = 0;

  outer: for (const jsonl of jsonls) {
    const boardId = deriveBoardId(jsonl, args);
    let mutations: ExtractedMutation[];
    try {
      mutations = parseJsonlForMutations(fs.readFileSync(jsonl, 'utf8'));
    } catch (e) {
      console.warn(`SKIP malformed JSONL ${jsonl}: ${e}`);
      continue;
    }

    for (const m of mutations) {
      if (args.limit && total >= args.limit) break outer;
      total++;

      const scratch = path.join(
        args.scratchDir,
        `${path.basename(jsonl, '.jsonl')}-${m.tool_use_id}.db`,
      );
      let v2Out: globalThis.Record<string, unknown> | null = null;
      let engineError: string | undefined;
      try {
        forkSqliteDb(args.refDb, scratch);
        const call = v1ToV2EngineCall(m.tool_name, m.input, boardId);
        const db = new Database(scratch);
        try {
          const engine = new TaskflowEngine(db, boardId);
          v2Out = runMutation(engine, call) as globalThis.Record<string, unknown>;
        } finally {
          db.close();
        }
      } catch (e: unknown) {
        engineError = e instanceof Error ? e.message : String(e);
      } finally {
        // Include -journal alongside -wal/-shm — DELETE-mode and rollback
        // journals leave a different sidecar than WAL mode (Codex NICE).
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          try { fs.unlinkSync(scratch + suffix); } catch { /* not present */ }
        }
      }

      const comparison = compareReplayResult(m.output, v2Out);
      records.push({
        jsonl: path.relative(args.jsonlsRoot, jsonl),
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

  // Aggregate
  const verdictCounts: Partial<globalThis.Record<Verdict, number>> = {};
  const toolCounts: globalThis.Record<string, Partial<globalThis.Record<Verdict, number>>> = {};
  for (const r of records) {
    verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1;
    toolCounts[r.tool_name] ??= {};
    toolCounts[r.tool_name][r.verdict] = (toolCounts[r.tool_name][r.verdict] ?? 0) + 1;
  }

  console.log('\n=== Replay summary ===');
  console.log(`Total mutations: ${records.length}`);
  console.log('\nBy verdict:');
  for (const v of ['match', 'both_rejected', 'relaxation', 'regression', 'divergent_payload', 'cannot_compare'] as Verdict[]) {
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

  if (args.reportJson) {
    fs.writeFileSync(args.reportJson, JSON.stringify({ records, verdictCounts, toolCounts }, null, 2));
    console.log(`\nWrote full report to ${args.reportJson}`);
  }

  // Codex IMPORTANT: if engine errors dominate, treat as broken-run rather
  // than a successful corpus comparison. A misconfigured --ref-db or
  // missing tables in the cloned DB will surface here as a wall of
  // engine_error → all `cannot_compare`. Exit nonzero so the user knows
  // the run is invalid.
  const engineErrorCount = records.filter((r) => r.engine_error).length;
  if (records.length > 0 && engineErrorCount / records.length >= 0.5) {
    console.error(
      `\nFAIL: ${engineErrorCount}/${records.length} mutations hit engine errors. ` +
      `Likely the ref DB is missing tables or has incompatible schema. ` +
      `Sample errors:`,
    );
    for (const r of records.filter((r) => r.engine_error).slice(0, 5)) {
      console.error(`  [${r.tool_name}] ${r.engine_error}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
