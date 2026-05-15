#!/usr/bin/env tsx
/**
 * Phase 3 compliance replay orchestrator.
 *
 * Phase 2 remains the canonical fresh-per-turn driver. This script adds a
 * separate compliance mode that can:
 *   - infer/support per-turn context metadata,
 *   - restore a per-turn DB snapshot when one exists,
 *   - run fresh or real-source context-chain replay through phase2-driver,
 *   - preserve Phase 2's fresh isolation for normal turns.
 *
 * It deliberately shells out to phase2-driver.ts instead of importing its
 * internals, so existing Phase 2 behavior stays untouched.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../src/config.js';
import {
  inferPhase3Metadata,
  loadPhase3Metadata,
  restoreDbSnapshot,
  taskflowDbPath,
  withTaskflowDbSnapshot,
  type Phase3CorpusTurn,
  type Phase3TurnMetadata,
  type Phase3TurnResult,
} from './phase3-support.js';

const DEFAULT_CORPUS = '/tmp/whatsapp-curated-seci-v4.json';
const DEFAULT_OUT = '/tmp/phase3-v2-results.json';
const DEFAULT_PHASE2_OUT = '/tmp/phase2-v2-results.json';
const PHASE2_DRIVER_OUT = '/tmp/phase2-v2-results.json';

interface Args {
  corpus: string;
  metadata?: string;
  out: string;
  phase2Out: string;
  sourceRoot: string;
  turn?: number;
  turns?: number[];
  all: boolean;
  from?: number;
  to?: number;
  resume: boolean;
  planOnly: boolean;
}

interface Corpus {
  turns: Phase3CorpusTurn[];
}

function parseArgs(): Args {
  const args: Args = {
    corpus: DEFAULT_CORPUS,
    out: DEFAULT_OUT,
    phase2Out: DEFAULT_PHASE2_OUT,
    sourceRoot: '/tmp/v2-pilot/all-sessions/seci-taskflow',
    all: false,
    resume: false,
    planOnly: false,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (key === '--corpus') args.corpus = process.argv[++i];
    else if (key === '--metadata') args.metadata = process.argv[++i];
    else if (key === '--out') args.out = process.argv[++i];
    else if (key === '--phase2-out') args.phase2Out = process.argv[++i];
    else if (key === '--source-root') args.sourceRoot = process.argv[++i];
    else if (key === '--turn') args.turn = Number.parseInt(process.argv[++i], 10);
    else if (key === '--turns') args.turns = process.argv[++i].split(',').map((value) => Number.parseInt(value, 10));
    else if (key === '--all') args.all = true;
    else if (key === '--from') args.from = Number.parseInt(process.argv[++i], 10);
    else if (key === '--to') args.to = Number.parseInt(process.argv[++i], 10);
    else if (key === '--resume') args.resume = true;
    else if (key === '--plan-only') args.planOnly = true;
    else throw new Error(`Unknown arg: ${key}`);
  }
  return args;
}

function assertExclusiveReplayHost(): void {
  if (process.env.NANOCLAW_PHASE3_ALLOW_ACTIVE_HOST === '1') return;
  const result = spawnSync('systemctl', ['is-active', 'nanoclaw'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0 && result.stdout.trim() === 'active') {
    throw new Error(
      'Phase 3 replay requires exclusive access to the replay session DB. Stop the background host first: systemctl stop nanoclaw. Set NANOCLAW_PHASE3_ALLOW_ACTIVE_HOST=1 only if you are using an isolated DB.',
    );
  }
}

function selectedIndices(args: Args, corpus: Corpus): number[] {
  if (args.all) return corpus.turns.map((_, i) => i);
  if (args.turns) return args.turns;
  if (args.from !== undefined || args.to !== undefined) {
    const from = args.from ?? 0;
    const to = args.to ?? corpus.turns.length - 1;
    const out: number[] = [];
    for (let i = from; i <= to; i++) out.push(i);
    return out;
  }
  if (args.turn !== undefined) return [args.turn];
  throw new Error('Must pass --turn N, --turns A,B, --all, --from/--to, or --plan-only with one of those selectors.');
}

function loadExisting(outPath: string): Phase3TurnResult[] {
  if (!fs.existsSync(outPath)) return [];
  const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  return Array.isArray(parsed) ? parsed : [parsed];
}

function saveResults(outPath: string, rows: Phase3TurnResult[]): void {
  fs.writeFileSync(outPath, JSON.stringify(rows.sort((a, b) => a.turn_index - b.turn_index), null, 2));
}

function runPhase2Driver(metadata: Phase3TurnMetadata, args: Args): void {
  const phase2Args = metadata.context_mode === 'chain'
    ? ['scripts/phase2-driver.ts', '--corpus', args.corpus, '--chain', `${metadata.turn_index}:${metadata.prior_turn_depth ?? 1}`, '--source-root', args.sourceRoot]
    : ['scripts/phase2-driver.ts', '--corpus', args.corpus, '--turn', String(metadata.turn_index)];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NANOCLAW_PHASE2_RAW_PROMPT: '1',
  };
  if (!env.NANOCLAW_TOOL_USES_PATH) env.NANOCLAW_TOOL_USES_PATH = '/workspace/.tool-uses.jsonl';
  if (metadata.target_state_snapshot) {
    env.NANOCLAW_PHASE3_TARGET_STATE_SNAPSHOT = metadata.target_state_snapshot;
  } else {
    delete env.NANOCLAW_PHASE3_TARGET_STATE_SNAPSHOT;
  }
  if (metadata.taskflow_board_id) {
    env.NANOCLAW_PHASE_REPLAY_TASKFLOW_BOARD_ID = metadata.taskflow_board_id;
  }

  fs.rmSync(PHASE2_DRIVER_OUT, { force: true });
  if (args.phase2Out !== PHASE2_DRIVER_OUT) fs.rmSync(args.phase2Out, { force: true });
  const result = spawnSync(path.join(process.cwd(), 'node_modules', '.bin', 'tsx'), phase2Args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`phase2-driver failed for turn ${metadata.turn_index} with status ${result.status}`);
  }
  if (!fs.existsSync(PHASE2_DRIVER_OUT)) {
    throw new Error(`phase2-driver did not write ${PHASE2_DRIVER_OUT}`);
  }
  if (args.phase2Out !== PHASE2_DRIVER_OUT) {
    fs.copyFileSync(PHASE2_DRIVER_OUT, args.phase2Out);
  }
}

function readPhase2TargetResult(phase2Out: string, turnIndex: number): Phase3TurnResult {
  const parsed = JSON.parse(fs.readFileSync(phase2Out, 'utf8'));
  const rows: Phase3TurnResult[] = Array.isArray(parsed) ? parsed : [parsed];
  const row = rows.find((item) => item.turn_index === turnIndex) ?? rows[rows.length - 1];
  if (!row) throw new Error(`No Phase 2 result for turn ${turnIndex}`);
  return row;
}

function printPlan(rows: Phase3TurnMetadata[]): void {
  console.log('=== Phase 3 replay plan ===');
  for (const row of rows) {
    const state = row.state_snapshot ? `snapshot=${row.state_snapshot}` : 'snapshot=<none>';
    const targetState = row.target_state_snapshot ? ` target_snapshot=${row.target_state_snapshot}` : '';
    const source = row.source_jsonl ? `source=${row.source_jsonl}#${row.source_turn_index ?? '?'}` : 'source=<none>';
    const depth = row.context_mode === 'chain' ? ` depth=${row.prior_turn_depth ?? 1}` : '';
    console.log(`turn ${row.turn_index}: ${row.context_mode}${depth}; ${source}; ${state}${targetState}`);
  }
}

function main(): void {
  const args = parseArgs();
  if (!args.planOnly) assertExclusiveReplayHost();
  const corpus = JSON.parse(fs.readFileSync(args.corpus, 'utf8')) as Corpus;
  const overrides = loadPhase3Metadata(args.metadata);
  const indices = selectedIndices(args, corpus);
  const useDefaultChainDepths = path.resolve(args.corpus) === path.resolve(DEFAULT_CORPUS);
  const plan = indices.map((index) => inferPhase3Metadata(
    corpus.turns[index],
    index,
    overrides.get(index),
    { useDefaultChainDepths },
  ));

  if (args.planOnly) {
    printPlan(plan);
    return;
  }

  let results = args.resume ? loadExisting(args.out) : [];
  const done = new Set(results.map((row) => row.turn_index));
  for (const metadata of plan) {
    if (done.has(metadata.turn_index)) continue;
    const run = () => {
      const restoreStatus = restoreDbSnapshot(metadata.state_snapshot, DATA_DIR, metadata.requires_state_snapshot === true);
      runPhase2Driver(metadata, args);
      const row = readPhase2TargetResult(args.phase2Out, metadata.turn_index);
      row.phase3 = {
        ...(row.phase3 ?? {}),
        metadata,
        db_snapshot_status: restoreStatus,
      };
      return row;
    };

    const row = withTaskflowDbSnapshot(DATA_DIR, run);
    results.push(row);
    saveResults(args.out, results);
    console.log(`Phase 3 saved turn ${metadata.turn_index} → ${args.out}`);
  }

  // Ensure no stale phase2 output gets mistaken for the canonical Phase 3 file.
  if (args.phase2Out !== args.out) fs.rmSync(args.phase2Out, { force: true });
  console.log(`Done. ${results.length} Phase 3 turn(s) recorded → ${args.out}`);
  console.log(`Live taskflow DB restored: ${taskflowDbPath(DATA_DIR)}`);
}

main();
