#!/usr/bin/env tsx
/**
 * Phase 3 semantic compliance comparator.
 *
 * Reads Phase 3 driver output and compares observable behavior, not just tool
 * names: action class, task IDs, mutation type, recipient, and raw-sqlite
 * parity decisions.
 */
import fs from 'node:fs';

import {
  classifyRawSqliteTurn,
  compareSemanticTurn,
  loadPhase3Metadata,
  phase3MetadataOverrideForResultTurn,
  type Phase3TurnResult,
  type RawSqliteDecision,
  type SemanticComparison,
} from './phase3-support.js';

interface Args {
  inPath: string;
  outJson: string;
  outText: string;
  metadata?: string;
}

function parseArgs(): Args {
  const args: Args = {
    inPath: '/tmp/phase3-v2-results.json',
    outJson: '/tmp/phase3-comparison.json',
    outText: '/tmp/phase3-comparison.txt',
  };
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (key === '--in') args.inPath = process.argv[++i];
    else if (key === '--out') args.outJson = process.argv[++i];
    else if (key === '--out-text') args.outText = process.argv[++i];
    else if (key === '--metadata') args.metadata = process.argv[++i];
    else throw new Error(`Unknown arg: ${key}`);
  }
  return args;
}

function statusIcon(value: boolean): string {
  return value ? 'ok' : 'diff';
}

function summarize(comparisons: SemanticComparison[], sqlite: RawSqliteDecision[]): string {
  const lines: string[] = [];
  const matches = comparisons.filter((c) => c.classification.kind === 'match').length;
  const byKind = new Map<string, number>();
  for (const c of comparisons) {
    byKind.set(c.classification.kind, (byKind.get(c.classification.kind) ?? 0) + 1);
  }

  lines.push('=== Phase 3 semantic compliance comparison ===');
  lines.push('');
  lines.push(`Turns analyzed: ${comparisons.length}`);
  lines.push(`Semantic matches: ${matches}/${comparisons.length}`);
  lines.push('');
  lines.push('By classification:');
  for (const [kind, count] of [...byKind.entries()].sort()) {
    lines.push(`- ${kind}: ${count}`);
  }

  lines.push('');
  lines.push('Per-turn semantic details:');
  for (const c of comparisons) {
    lines.push('');
    lines.push(`Turn ${c.turn_index}: ${c.classification.kind}`);
    lines.push(`  note: ${c.classification.note}`);
    lines.push(`  action: ${c.expected.action} -> ${c.actual.action} [${statusIcon(c.matches.action)}]`);
    lines.push(`  task_ids: [${c.expected.task_ids.join(', ') || '*'}] -> [${c.actual.task_ids.join(', ') || '∅'}] [${statusIcon(c.matches.task_ids)}]`);
    lines.push(`  mutation_types: [${c.expected.mutation_types.join(', ') || '*'}] -> [${c.actual.mutation_types.join(', ') || '∅'}] [${statusIcon(c.matches.mutation_types)}]`);
    lines.push(`  board_refs: [${c.expected.board_refs.join(', ') || '*'}] -> [${c.actual.board_refs.join(', ') || '∅'}] [${statusIcon(c.matches.board_refs)}]`);
    lines.push(`  recipient: ${c.expected.recipient ?? '*'} -> ${c.actual.recipient ?? '∅'} [${statusIcon(c.matches.recipient)}]`);
    lines.push(`  outbound_intent: ${c.expected.outbound_intent} -> ${c.actual.outbound_intent}`);
  }

  if (sqlite.length > 0) {
    lines.push('');
    lines.push('Raw sqlite parity decisions:');
    for (const row of sqlite) {
      lines.push(`- turn ${row.turn_index}: ${row.classification}; tools=[${row.sqlite_tools.join(', ')}]`);
      lines.push(`  recommendation: ${row.recommendation}`);
    }
  }

  return lines.join('\n');
}

function main(): void {
  const args = parseArgs();
  const raw = JSON.parse(fs.readFileSync(args.inPath, 'utf8'));
  const loadedTurns: Phase3TurnResult[] = Array.isArray(raw) ? raw : [raw];
  const metadata = loadPhase3Metadata(args.metadata);
  const turns = loadedTurns.map((turn) => {
    const override = phase3MetadataOverrideForResultTurn(metadata, turn);
    if (!override) return turn;
    return {
      ...turn,
      phase3: {
        ...(turn.phase3 ?? {}),
        metadata: {
          ...(turn.phase3?.metadata ?? {}),
          ...override,
          turn_index: turn.turn_index,
        },
      },
    };
  });
  const comparisons = turns.map(compareSemanticTurn);
  const rawSqlite = turns.map(classifyRawSqliteTurn).filter(Boolean) as RawSqliteDecision[];
  const out = { count: turns.length, comparisons, raw_sqlite: rawSqlite };
  fs.writeFileSync(args.outJson, JSON.stringify(out, null, 2));
  const text = summarize(comparisons, rawSqlite);
  fs.writeFileSync(args.outText, text);
  console.log(text);
  console.log(`\nWrote: ${args.outJson} (machine), ${args.outText} (human)`);
}

main();
