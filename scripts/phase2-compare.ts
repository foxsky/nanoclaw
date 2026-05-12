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
  classification?: {
    kind:
      | 'missing_context'
      | 'state_drift'
      | 'documented_tool_surface_change'
      | 'read_only_extra'
      | 'fixed_after_baseline';
    note: string;
  };
}

const KNOWN_DIVERGENCES: Record<number, NonNullable<TurnDiff['classification']>> = {
  0: {
    kind: 'read_only_extra',
    note: 'v2 performs one grounding search but still asks before creating; no over-autonomy mutation.',
  },
  2: {
    kind: 'read_only_extra',
    note: 'v2 performs grounding reads for a standalone goal phrase, then asks how to register it; no mutation.',
  },
  3: {
    kind: 'read_only_extra',
    note: 'v2 performs one grounding search for a standalone activity phrase; no mutation.',
  },
  4: {
    kind: 'read_only_extra',
    note: 'v2 reads bare task id P11.20; v1 recorded no tool for this isolated turn.',
  },
  5: {
    kind: 'read_only_extra',
    note: 'v2 reads bare task id T43; v1 recorded no tool for this isolated turn.',
  },
  6: {
    kind: 'missing_context',
    note: 'Prompt gives only a deadline with no task id; v2 asks for the missing task instead of guessing.',
  },
  9: {
    kind: 'fixed_after_baseline',
    note: 'Post-baseline engine patch adds token-ranked search; first query "extrato contas PMT bancos" now returns T84.',
  },
  15: {
    kind: 'missing_context',
    note: 'Raw prompt says only "esta tarefa"; v1 relied on prior in-session T43 context and raw sqlite sibling-board lookup.',
  },
  16: {
    kind: 'missing_context',
    note: 'Raw prompt is only "sim"; v1 was answering a prior forwarding confirmation not present in this isolated replay turn.',
  },
  17: {
    kind: 'documented_tool_surface_change',
    note: 'v1 used raw sqlite to inspect sibling board task T43; v2 intentionally blocks raw sqlite and board-scoped api_query cannot read that sibling row.',
  },
  20: {
    kind: 'fixed_after_baseline',
    note: 'Post-baseline MCP compaction returns compact formatted_task_details for project IDs, avoiding tool-result file parsing loops.',
  },
  21: {
    kind: 'documented_tool_surface_change',
    note: 'v2 task_details includes enough task history in one api_query to answer; v1 used two taskflow_query calls.',
  },
  22: {
    kind: 'missing_context',
    note: 'Raw prompt is only "Sim"; v1 relied on the prior P6.7 confirmation context from the live session.',
  },
  23: {
    kind: 'missing_context',
    note: 'Prompt lacks the prior P6.7 task reference; v1 used raw sqlite write/read plus move to repair that specific task.',
  },
  25: {
    kind: 'missing_context',
    note: 'Prompt omits the task being assigned; v1 inherited T84 from the immediately prior live turn.',
  },
  27: {
    kind: 'missing_context',
    note: 'Prompt omits the task being assigned; v1 inherited T85 from the immediately prior live turn.',
  },
  28: {
    kind: 'state_drift',
    note: 'Current DB already has ana-beatriz on M1 and M2, so v2 correctly no-ops instead of replaying v1 mutations.',
  },
  29: {
    kind: 'documented_tool_surface_change',
    note: 'v1 used filesystem/Agent tools to gather meeting details; v2 obtains the same details via api_query and sends the outbound message.',
  },
};

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

  const diff: TurnDiff = {
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
  const classification = KNOWN_DIVERGENCES[turn.turn_index];
  if (classification && (diff.v1_had_unmatched || diff.v2_used_extra_tools)) {
    diff.classification = classification;
  }
  return diff;
}

function summarize(diffs: TurnDiff[]): string {
  const byCategory: Record<string, { total: number; v1_unmatched: number; v2_extra: number; clean: number; documented: number }> = {};
  for (const d of diffs) {
    const c = d.category;
    byCategory[c] = byCategory[c] ?? { total: 0, v1_unmatched: 0, v2_extra: 0, clean: 0, documented: 0 };
    byCategory[c].total += 1;
    if (d.v1_had_unmatched) byCategory[c].v1_unmatched += 1;
    if (d.v2_used_extra_tools) byCategory[c].v2_extra += 1;
    if (!d.v1_had_unmatched && !d.v2_used_extra_tools) byCategory[c].clean += 1;
    if (d.classification) byCategory[c].documented += 1;
  }

  const lines: string[] = [];
  lines.push('=== Phase 2 v1↔v2 tool-use comparison ===\n');
  lines.push(`Total turns analyzed: ${diffs.length}`);
  lines.push('');
  lines.push('By category:');
  lines.push('category      | total | clean | documented | v2 over-tool | v1 unmatched');
  lines.push('--------------|-------|-------|------------|--------------|-------------');
  for (const [c, s] of Object.entries(byCategory).sort()) {
    lines.push(`${c.padEnd(13)} | ${String(s.total).padStart(5)} | ${String(s.clean).padStart(5)} | ${String(s.documented).padStart(10)} | ${String(s.v2_extra).padStart(12)} | ${String(s.v1_unmatched).padStart(11)}`);
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
    if (d.classification) {
      lines.push(`  classification: ${d.classification.kind} — ${d.classification.note}`);
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
