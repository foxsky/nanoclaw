#!/usr/bin/env tsx
/**
 * Curate a small set of WhatsApp-message turns for Phase 2 end-to-end
 * replay. Walks a board's session JSONLs, extracts conversation turns,
 * filters out subagent-launched and scheduled-task prompts (only REAL
 * human-WhatsApp messages qualify), then emits a representative subset.
 *
 * Usage:
 *   pnpm exec tsx scripts/whatsapp-replay-curate.ts \
 *     --jsonls /tmp/v2-pilot/all-sessions/seci-taskflow \
 *     --out /tmp/whatsapp-curated-seci-taskflow.json \
 *     [--max 20]
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  extractConversationTurns,
  type ConversationTurn,
} from './whatsapp-replay-extract.js';

interface Args { jsonls: string; out: string; max: number; }

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected arg: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  if (!args.jsonls || !args.out) {
    console.error('Usage: --jsonls <dir> --out <file.json> [--max N]');
    process.exit(2);
  }
  return { jsonls: args.jsonls, out: args.out, max: args.max ? parseInt(args.max, 10) : 20 };
}

/** Walk every .jsonl under root, skipping subagent transcripts (which are
 *  agent-tool-dispatched, not human WhatsApp inputs) and tolerating
 *  unreadable subdirs (EACCES on `.claude/projects/...` under some clones). */
function findHumanJsonls(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) {
      if (dir === root) throw e;
      console.warn(`  WARN: skipped unreadable ${dir}: ${e}`);
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'subagents') continue;
        walk(full);
      } else if (e.isFile() && full.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

/** Reason a turn was excluded from the curated set. Tracked separately so
 *  audit counts reveal whether we're losing legitimate human turns to the
 *  no-envelope filter (vs the scheduled-task filter, which is always safe). */
type RejectReason = 'scheduled' | 'no_envelope' | null;
const SCHEDULED_MARKER_RE = /\[SCHEDULED TASK\b/;
function rejectReason(t: ConversationTurn): RejectReason {
  if (SCHEDULED_MARKER_RE.test(t.user_message)) return 'scheduled';
  if (t.parsed_messages.length === 0) return 'no_envelope';
  return null;
}

interface AnnotatedTurn extends ConversationTurn {
  jsonl: string;
  turn_index: number;
  category: 'no_tools' | 'single_tool' | 'multi_tool';
}

function annotate(turn: ConversationTurn, jsonl: string, turnIndex: number): AnnotatedTurn {
  const n = turn.tool_uses.length;
  const category = n === 0 ? 'no_tools' : n === 1 ? 'single_tool' : 'multi_tool';
  return { ...turn, jsonl, turn_index: turnIndex, category };
}

/** Derive a signature for diversifying single-tool samples. Tools with an
 *  action/query/type discriminator get bucketed by it so we capture variety
 *  (taskflow_admin has 17 actions; taskflow_query has many query kinds). */
function singleToolSignature(turn: AnnotatedTurn): string {
  const tu = turn.tool_uses[0];
  const input = tu.input;
  const action = typeof input.action === 'string' ? input.action
    : typeof input.query === 'string' ? input.query
    : typeof input.type === 'string' ? input.type
    : '';
  return action ? `${tu.tool_name}:${action}` : tu.tool_name;
}

function main() {
  const args = parseArgs(process.argv);
  const jsonls = findHumanJsonls(args.jsonls);
  console.log(`Found ${jsonls.length} human-session JSONLs under ${args.jsonls}`);

  const all: AnnotatedTurn[] = [];
  const rejected = { scheduled: 0, no_envelope: 0 };
  for (const jsonl of jsonls) {
    let turns: ConversationTurn[];
    try { turns = extractConversationTurns(fs.readFileSync(jsonl, 'utf8')); }
    catch (e) { console.warn(`SKIP ${jsonl}: ${e}`); continue; }
    const rel = path.relative(args.jsonls, jsonl);
    for (let i = 0; i < turns.length; i++) {
      const reason = rejectReason(turns[i]);
      if (reason) { rejected[reason]++; continue; }
      all.push(annotate(turns[i], rel, i));
    }
  }

  console.log(`Total human turns extracted: ${all.length} (rejected scheduled=${rejected.scheduled}, no_envelope=${rejected.no_envelope})`);
  const noTools = all.filter((t) => t.category === 'no_tools');
  const singleTool = all.filter((t) => t.category === 'single_tool');
  const multiTool = all.filter((t) => t.category === 'multi_tool');
  console.log(`  no_tools: ${noTools.length}, single_tool: ${singleTool.length}, multi_tool: ${multiTool.length}`);

  // Single-tool bucketing: one sample per (tool_name, action/query/type)
  // signature, then a few extras per common signature for input-shape variety.
  const singleBySig = new Map<string, AnnotatedTurn[]>();
  for (const t of singleTool) {
    const sig = singleToolSignature(t);
    if (!singleBySig.has(sig)) singleBySig.set(sig, []);
    singleBySig.get(sig)!.push(t);
  }

  const slots = args.max;
  const noToolsBudget = Math.min(noTools.length, Math.floor(slots * 0.25));
  const multiBudget = Math.min(multiTool.length, Math.floor(slots * 0.35));
  const singleBudget = Math.max(0, slots - noToolsBudget - multiBudget);

  // Round-robin across signatures so we cover diverse tool/action combos.
  const singleCurated: AnnotatedTurn[] = [];
  const sigKeys = [...singleBySig.keys()];
  let cursor = 0;
  while (singleCurated.length < singleBudget && sigKeys.length > 0) {
    const sig = sigKeys[cursor % sigKeys.length];
    const bucket = singleBySig.get(sig)!;
    if (bucket.length > 0) singleCurated.push(bucket.shift()!);
    else sigKeys.splice(cursor % sigKeys.length, 1);
    if (sigKeys.length === 0) break;
    cursor = (cursor + 1) % Math.max(1, sigKeys.length);
  }

  const curated: AnnotatedTurn[] = [
    ...noTools.slice(0, noToolsBudget),
    ...singleCurated,
    ...multiTool.slice(0, multiBudget),
  ];

  console.log(`Curated subset: ${curated.length} turns ` +
    `(no_tools=${curated.filter((t) => t.category === 'no_tools').length}, ` +
    `single_tool=${curated.filter((t) => t.category === 'single_tool').length} across ${[...new Set(singleCurated.map(singleToolSignature))].length} distinct signatures, ` +
    `multi_tool=${curated.filter((t) => t.category === 'multi_tool').length})`);

  fs.writeFileSync(args.out, JSON.stringify({
    source_dir: args.jsonls,
    total_turns: all.length,
    rejected,
    curated_count: curated.length,
    turns: curated,
  }, null, 2));
  console.log(`Wrote ${args.out}`);

  const toolHist: Record<string, number> = {};
  for (const t of all) {
    for (const tu of t.tool_uses) toolHist[tu.tool_name] = (toolHist[tu.tool_name] ?? 0) + 1;
  }
  console.log('\nTool-call histogram across all human turns:');
  for (const [tool, n] of Object.entries(toolHist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tool}: ${n}`);
  }
}

main();
