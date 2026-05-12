#!/usr/bin/env tsx
/**
 * Phase 2 v1↔v2 tool_use comparator.
 *
 * Reads /tmp/phase2-v2-results.json (produced by phase2-driver.ts) and
 * produces a per-turn comparison + per-category aggregate.
 *
 * v1 → v2 tool name substitution map mirrors the A5 substitution recipe
 * (scripts/migrate-board-claudemd.ts). Fuzzy because some v1 tools have
 * many v2 equivalents (taskflow_admin had 17 sub-actions).
 *
 * Usage: tsx scripts/phase2-compare.ts [--in PATH] [--out PATH]
 */

import fs from 'node:fs';

interface ToolCall { name: string; input: unknown }
interface TurnResult {
  turn_index: number;
  category: string;
  sender: string;
  text: string;
  v1: { tools: ToolCall[]; final_response: string | null };
  v2: { tools: ToolCall[]; outbound: { kind: string; content: string }[]; elapsed_ms: number; settle_reason: string };
}

// v1 → v2 substitution. Multi-mapping when v1 tool fans out to multiple
// v2 tools (e.g. taskflow_admin → 17 api_admin sub-actions). The
// comparator's match logic accepts any v2 name in the array as equivalent.
const TOOL_MAP: Record<string, string[]> = {
  taskflow_query: ['mcp__nanoclaw__api_query', 'mcp__nanoclaw__api_hierarchy', 'mcp__nanoclaw__api_dependency'],
  taskflow_create: ['mcp__nanoclaw__api_create_task', 'mcp__nanoclaw__api_create_simple_task'],
  taskflow_update: [
    'mcp__nanoclaw__api_update_task',
    'mcp__nanoclaw__api_update_simple_task',
    'mcp__nanoclaw__api_admin',
  ],
  taskflow_delete: ['mcp__nanoclaw__api_delete_simple_task', 'mcp__nanoclaw__api_admin'],
  taskflow_move: ['mcp__nanoclaw__api_move'],
  taskflow_admin: ['mcp__nanoclaw__api_admin'],
  taskflow_reassign: ['mcp__nanoclaw__api_reassign'],
  taskflow_undo: ['mcp__nanoclaw__api_undo'],
  taskflow_report: ['mcp__nanoclaw__api_report'],
  taskflow_hierarchy: ['mcp__nanoclaw__api_hierarchy'],
  taskflow_dependency: ['mcp__nanoclaw__api_dependency'],
  // pass-through (same name with mcp__nanoclaw__ prefix)
  send_message: ['mcp__nanoclaw__send_message'],
  schedule_task: ['mcp__nanoclaw__schedule_task'],
  add_reaction: ['mcp__nanoclaw__add_reaction'],
  // v1 used raw SQL when no MCP tool existed; v2 ships api_* for the same
  // reads/writes. Keep self-match so legitimate v2 sqlite fallback (the
  // documented escape hatch) still counts as a match.
  mcp__sqlite__read_query: [
    'mcp__sqlite__read_query',
    'mcp__nanoclaw__api_query',
    'mcp__nanoclaw__api_board_activity',
    'mcp__nanoclaw__api_filter_board_tasks',
    'mcp__nanoclaw__api_linked_tasks',
  ],
  mcp__sqlite__write_query: [
    'mcp__sqlite__write_query',
    'mcp__nanoclaw__api_admin',
    'mcp__nanoclaw__api_update_task',
    'mcp__nanoclaw__api_update_simple_task',
  ],
  // SDK builtin "search" family — v1 and v2 both have these. v2 may pick
  // a sibling (Glob/Grep/Read swap for the same semantic intent).
  Grep: ['Grep', 'Glob', 'Read'],
  Glob: ['Glob', 'Grep', 'Read'],
  Read: ['Read'],
  Bash: ['Bash'],
};

/** Map a v1 tool name to its canonical v2 equivalent(s), or itself if no map entry. */
function v1ToV2Equivalents(name: string): string[] {
  return TOOL_MAP[name] ?? [`mcp__nanoclaw__${name}`, name];
}

interface TurnDiff {
  turn_index: number;
  category: string;
  text_excerpt: string;
  v1_tool_sequence: string[];
  v2_tool_sequence: string[];
  v1_unique: string[];
  v2_unique: string[];
  matched_pairs: { v1: string; v2: string }[];
  v2_used_extra_tools: boolean;
  v1_had_unmatched: boolean;
}

function diffTurn(turn: TurnResult): TurnDiff {
  const v1Names = turn.v1.tools.map((t) => t.name);
  const v2Names = turn.v2.tools.map((t) => t.name);

  // Multiset consumption: each v1 call consumes exactly one v2 occurrence
  // of an equivalent tool. Without this, a v1 call to `taskflow_query` that
  // maps to `api_query` would mark ALL repeated api_query uses in v2 as
  // matched, hiding the over-tool ratio (Codex BLOCKER 2026-05-11).
  const v2Remaining = [...v2Names];
  const matched: { v1: string; v2: string }[] = [];
  const v1Unmatched: string[] = [];

  for (const v1Name of v1Names) {
    const equivalents = v1ToV2Equivalents(v1Name);
    let consumedAt = -1;
    for (const eq of equivalents) {
      const idx = v2Remaining.indexOf(eq);
      if (idx >= 0) { consumedAt = idx; break; }
    }
    if (consumedAt >= 0) {
      matched.push({ v1: v1Name, v2: v2Remaining[consumedAt] });
      v2Remaining.splice(consumedAt, 1);
    } else {
      v1Unmatched.push(v1Name);
    }
  }

  // v2-only: whatever's left after consumption.
  const v2Unique = v2Remaining;

  return {
    turn_index: turn.turn_index,
    category: turn.category,
    text_excerpt: turn.text.slice(0, 80),
    v1_tool_sequence: v1Names,
    v2_tool_sequence: v2Names,
    v1_unique: v1Unmatched,
    v2_unique: v2Unique,
    matched_pairs: matched,
    v2_used_extra_tools: v2Unique.length > 0,
    v1_had_unmatched: v1Unmatched.length > 0,
  };
}

function summarize(diffs: TurnDiff[]): string {
  const byCategory: Record<string, { total: number; v1_unmatched: number; v2_extra: number; clean: number }> = {};
  for (const d of diffs) {
    const c = d.category;
    byCategory[c] = byCategory[c] ?? { total: 0, v1_unmatched: 0, v2_extra: 0, clean: 0 };
    byCategory[c].total += 1;
    if (d.v1_had_unmatched) byCategory[c].v1_unmatched += 1;
    if (d.v2_used_extra_tools) byCategory[c].v2_extra += 1;
    if (!d.v1_had_unmatched && !d.v2_used_extra_tools) byCategory[c].clean += 1;
  }

  const lines: string[] = [];
  lines.push('=== Phase 2 v1↔v2 tool-use comparison ===\n');
  lines.push(`Total turns analyzed: ${diffs.length}`);
  lines.push('');
  lines.push('By category:');
  lines.push('category      | total | clean | v2 over-tool | v1 unmatched');
  lines.push('--------------|-------|-------|--------------|-------------');
  for (const [c, s] of Object.entries(byCategory).sort()) {
    lines.push(`${c.padEnd(13)} | ${String(s.total).padStart(5)} | ${String(s.clean).padStart(5)} | ${String(s.v2_extra).padStart(12)} | ${String(s.v1_unmatched).padStart(11)}`);
  }
  lines.push('');
  lines.push('Per-turn details (problem turns first):');
  const problemTurns = diffs.filter((d) => d.v1_had_unmatched || d.v2_used_extra_tools);
  const cleanTurns = diffs.filter((d) => !d.v1_had_unmatched && !d.v2_used_extra_tools);
  for (const d of [...problemTurns, ...cleanTurns]) {
    lines.push(`\nTurn ${d.turn_index} [${d.category}]: "${d.text_excerpt}${d.text_excerpt.length >= 80 ? '…' : ''}"`);
    lines.push(`  v1: [${d.v1_tool_sequence.join(', ') || '∅'}]`);
    lines.push(`  v2: [${d.v2_tool_sequence.join(', ') || '∅'}]`);
    if (d.matched_pairs.length > 0) {
      lines.push(`  matched: ${d.matched_pairs.map((p) => `${p.v1}→${p.v2}`).join(', ')}`);
    }
    if (d.v1_unique.length > 0) {
      lines.push(`  v1 unmatched: [${d.v1_unique.join(', ')}]`);
    }
    if (d.v2_unique.length > 0) {
      lines.push(`  v2 extra: [${d.v2_unique.join(', ')}]`);
    }
  }
  return lines.join('\n');
}

function parseArgs(): { inPath: string; outJson: string; outText: string } {
  let inPath = '/tmp/phase2-v2-results.json';
  let outJson = '/tmp/phase2-comparison.json';
  let outText = '/tmp/phase2-comparison.txt';
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--in') inPath = process.argv[++i];
    else if (process.argv[i] === '--out') outJson = process.argv[++i];
    else if (process.argv[i] === '--out-text') outText = process.argv[++i];
  }
  return { inPath, outJson, outText };
}

function main(): void {
  const { inPath, outJson, outText } = parseArgs();
  const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const turns: TurnResult[] = Array.isArray(raw) ? raw : [raw];
  const diffs = turns.map(diffTurn);
  fs.writeFileSync(outJson, JSON.stringify({ diffs, count: diffs.length }, null, 2));
  const text = summarize(diffs);
  fs.writeFileSync(outText, text);
  console.log(text);
  console.log(`\nWrote: ${outJson} (machine), ${outText} (human)`);
}

main();
