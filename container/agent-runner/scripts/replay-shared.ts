/**
 * Shared infrastructure for A2.2 / A2.4 corpus replay orchestrators.
 *
 * A2.2 (replay-corpus.ts) forks the reference DB per-mutation; A2.4
 * (replay-corpus-sequential.ts) forks once per board and replays
 * chronologically. Both share argument parsing, JSONL discovery,
 * board-id derivation, scratch cleanup, and an engine-error budget
 * guard that aborts the run when a misconfigured ref DB causes most
 * mutations to throw.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Verdict } from '../../../scripts/mutation-replay-compare.ts';

export type BoardFrom =
  | { kind: 'path'; index: number }
  | { kind: 'const'; value: string };

export interface SharedArgs {
  jsonlsRoot: string;
  refDb: string;
  scratchDir: string;
  boardFrom: BoardFrom;
  boardPrefix: string;
  reportJson?: string;
  extra: Record<string, string>;
}

export function parseSharedArgs(argv: string[], defaultScratchDir: string): SharedArgs {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) {
      throw new Error(`Unexpected positional arg: ${argv[i]}`);
    }
    args[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  if (!args.jsonls || !args['ref-db']) {
    throw new Error(
      'Required: --jsonls <root-dir> --ref-db <taskflow.db> ' +
        '[--board-from path:N|const:<id>] [--board-prefix board-] [--report-json <file>]',
    );
  }
  const boardFromRaw = args['board-from'] ?? 'path:0';
  let boardFrom: BoardFrom;
  if (boardFromRaw.startsWith('path:')) {
    boardFrom = { kind: 'path', index: parseInt(boardFromRaw.slice(5), 10) };
  } else if (boardFromRaw.startsWith('const:')) {
    boardFrom = { kind: 'const', value: boardFromRaw.slice(6) };
  } else {
    throw new Error(`Invalid --board-from: ${boardFromRaw}`);
  }
  return {
    jsonlsRoot: args.jsonls,
    refDb: args['ref-db'],
    scratchDir: args['scratch-dir'] ?? defaultScratchDir,
    boardFrom,
    boardPrefix: args['board-prefix'] ?? '',
    reportJson: args['report-json'],
    extra: args,
  };
}

export function findJsonls(root: string): string[] {
  const rootStat = fs.statSync(root);
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

export function deriveBoardId(
  jsonlPath: string,
  jsonlsRoot: string,
  boardFrom: BoardFrom,
  boardPrefix: string,
): string {
  if (boardFrom.kind === 'const') return boardFrom.value;
  const rel = path.relative(jsonlsRoot, jsonlPath);
  const segs = rel.split(path.sep);
  const seg = segs[boardFrom.index];
  if (!seg) {
    throw new Error(`Cannot derive board_id from ${jsonlPath} at segment ${boardFrom.index}`);
  }
  return `${boardPrefix}${seg}`;
}

// SQLite leaves -wal/-shm in WAL mode and -journal in DELETE mode; clean both.
const SCRATCH_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

export function cleanScratch(scratchPath: string): void {
  for (const suffix of SCRATCH_SUFFIXES) {
    try { fs.unlinkSync(scratchPath + suffix); } catch { /* not present */ }
  }
}

export const VERDICTS_PRINT_ORDER: readonly Verdict[] = [
  'match',
  'both_rejected',
  'relaxation',
  'regression',
  'divergent_payload',
  'cannot_compare',
];

export interface EngineErrorRecord {
  tool_name: string;
  engine_error?: string;
}

/**
 * If more than half the mutations hit engine errors, the ref DB is almost
 * certainly misconfigured (wrong schema, missing tables). Exit nonzero so
 * the result table isn't mistaken for a successful comparison.
 */
export function assertEngineErrorBudget(records: EngineErrorRecord[]): void {
  const errors = records.filter((r) => r.engine_error);
  if (records.length === 0 || errors.length / records.length < 0.5) return;
  console.error(
    `\nFAIL: ${errors.length}/${records.length} mutations hit engine errors. ` +
      `Likely the ref DB is missing tables or has incompatible schema.`,
  );
  for (const r of errors.slice(0, 5)) {
    console.error(`  [${r.tool_name}] ${r.engine_error}`);
  }
  process.exit(1);
}
