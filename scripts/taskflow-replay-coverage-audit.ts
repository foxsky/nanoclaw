#!/usr/bin/env tsx
/**
 * Compare a validated Taskflow replay corpus against a larger historical
 * corpus and propose the next coverage-oriented replay set.
 *
 * This does not run agents or spend API budget. It only audits v1-recorded
 * tool-use shapes that are present in historical transcripts but absent or
 * undersampled in the validated replay slice.
 *
 * Usage:
 *   pnpm exec tsx scripts/taskflow-replay-coverage-audit.ts \
 *     --all /tmp/whatsapp-all-seci-20260514.json \
 *     --baseline /tmp/whatsapp-curated-seci-v4.json \
 *     --out-json /tmp/taskflow-full-history-coverage-20260514.json \
 *     --out-text /tmp/taskflow-full-history-coverage-20260514.txt \
 *     --candidate-out /tmp/whatsapp-seci-next-candidates-20260514.json
 */

import fs from 'node:fs';
import path from 'node:path';

interface Args {
  all: string;
  baseline: string;
  outJson: string;
  outText: string;
  candidateOut: string;
  candidateMax: number;
}

interface ToolUse {
  tool_name: string;
  input?: Record<string, unknown>;
}

interface CorpusTurn {
  jsonl?: string;
  turn_index?: number;
  category?: 'no_tools' | 'single_tool' | 'multi_tool';
  sender?: string;
  user_message: string;
  tool_uses: ToolUse[];
  selection_reason?: string;
  behavior_signature?: string;
  coverage_priority?: 'high' | 'medium' | 'low';
}

interface Corpus {
  source_dir?: string;
  total_turns?: number;
  rejected?: Record<string, number>;
  curated_count?: number;
  turns: CorpusTurn[];
}

interface SignatureStats {
  signature: string;
  all_count: number;
  baseline_count: number;
  priority: 'high' | 'medium' | 'low';
  examples: CorpusTurn[];
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--')) throw new Error(`Unexpected arg: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  for (const required of ['all', 'baseline', 'out-json', 'out-text', 'candidate-out']) {
    if (!args[required]) throw new Error(`Missing required --${required}`);
  }
  return {
    all: args.all,
    baseline: args.baseline,
    outJson: args['out-json'],
    outText: args['out-text'],
    candidateOut: args['candidate-out'],
    candidateMax: args['candidate-max'] ? Number.parseInt(args['candidate-max'], 10) : 40,
  };
}

function loadCorpus(filename: string): Corpus {
  const parsed = JSON.parse(fs.readFileSync(filename, 'utf8')) as Corpus;
  if (!Array.isArray(parsed.turns)) throw new Error(`Invalid corpus: ${filename}`);
  return parsed;
}

function toolAction(input: Record<string, unknown> | undefined): string {
  const action = input?.action;
  const query = input?.query;
  const type = input?.type;
  if (typeof action === 'string') return action;
  if (typeof query === 'string') return query;
  if (typeof type === 'string') return type;
  return '';
}

function sqliteSignature(toolName: string, input: Record<string, unknown> | undefined): string {
  const sql = typeof input?.query === 'string' ? input.query : '';
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  if (/from\s+tasks\b/.test(normalized)) {
    if (/join\s+registered_groups\b|registered_groups\b/.test(normalized)) {
      return `${toolName}:tasks+registered_groups`;
    }
    if (/notification_group_jid|target_chat_jid|participants/.test(normalized)) {
      return `${toolName}:tasks:routing`;
    }
    return `${toolName}:tasks`;
  }
  if (/from\s+registered_groups\b/.test(normalized)) return `${toolName}:registered_groups`;
  if (/update\s+tasks\b/.test(normalized)) return `${toolName}:update_tasks`;
  return toolName;
}

function toolSignature(tool: ToolUse): string {
  const name = tool.tool_name;
  if (name === 'mcp__sqlite__read_query' || name === 'mcp__sqlite__write_query') {
    return sqliteSignature(name, tool.input);
  }
  const action = toolAction(tool.input);
  return action ? `${name}:${action}` : name;
}

function noToolSignature(turn: CorpusTurn): string {
  const text = turn.user_message.toLowerCase();
  const stripped = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(sim|s|ok|certo|isso|pode|confirmo|confirma)\b/.test(stripped)) {
    return 'no_tools:bare_confirmation';
  }
  if (/\b(bom dia|boa tarde|boa noite|ola|olá|oi)\b/.test(stripped)) {
    return 'no_tools:greeting';
  }
  if (/\b(amanh[aã]|hoje|sexta|quinta|prazo|data|deadline)\b/.test(stripped) && !/\b(p\d+|t\d+|m\d+)\b/i.test(stripped)) {
    return 'no_tools:deadline_ambiguous';
  }
  if (stripped.length < 220 && !/[?.!]/.test(stripped) && !/\b(p\d+|t\d+|m\d+)\b/i.test(stripped)) {
    return 'no_tools:standalone_activity';
  }
  return 'no_tools:other_no_tool';
}

function behaviorSignature(turn: CorpusTurn): string {
  if (turn.tool_uses.length === 0) return noToolSignature(turn);
  return turn.tool_uses.map(toolSignature).join(' + ');
}

function turnKey(turn: CorpusTurn): string {
  return `${turn.jsonl ?? ''}#${turn.turn_index ?? ''}#${turn.user_message.slice(0, 120)}`;
}

function signaturePriority(signature: string): 'high' | 'medium' | 'low' {
  if (/mcp__sqlite__|schedule_task|send_message|Agent|Bash|Read|Grep|Glob/.test(signature)) return 'high';
  if (/taskflow_create:(meeting|project|inbox)|taskflow_admin|taskflow_move|archive_search/.test(signature)) return 'high';
  if (signature.split(' + ').length >= 3) return 'high';
  if (/taskflow_(create|update|reassign|query|hierarchy)/.test(signature)) return 'medium';
  if (/no_tools:(bare_confirmation|deadline_ambiguous|standalone_activity)/.test(signature)) return 'medium';
  return 'low';
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedStats(
  allBySig: Map<string, CorpusTurn[]>,
  baselineCounts: Map<string, number>,
): SignatureStats[] {
  return [...allBySig.entries()]
    .map(([signature, examples]) => ({
      signature,
      all_count: examples.length,
      baseline_count: baselineCounts.get(signature) ?? 0,
      priority: signaturePriority(signature),
      examples,
    }))
    .sort((a, b) => {
      const priorityScore = { high: 0, medium: 1, low: 2 };
      return (
        priorityScore[a.priority] - priorityScore[b.priority] ||
        b.all_count - a.all_count ||
        a.signature.localeCompare(b.signature)
      );
    });
}

function chooseCandidates(
  stats: SignatureStats[],
  baselineKeys: Set<string>,
  max: number,
): CorpusTurn[] {
  const selected: CorpusTurn[] = [];
  const selectedKeys = new Set<string>();

  function addCandidate(turn: CorpusTurn, stat: SignatureStats, reason: string): void {
    const key = turnKey(turn);
    if (baselineKeys.has(key) || selectedKeys.has(key) || selected.length >= max) return;
    selected.push({
      ...turn,
      selection_reason: reason,
      behavior_signature: stat.signature,
      coverage_priority: stat.priority,
    });
    selectedKeys.add(key);
  }

  for (const stat of stats) {
    if (selected.length >= max) break;
    if (stat.baseline_count > 0) continue;
    const turn = stat.examples.find((candidate) => !baselineKeys.has(turnKey(candidate)));
    if (turn) addCandidate(turn, stat, 'uncovered_behavior_signature');
  }

  for (const stat of stats) {
    if (selected.length >= max) break;
    if (stat.all_count < 5) continue;
    const desired = Math.min(3, stat.all_count);
    if (stat.baseline_count >= desired) continue;
    let addedForSig = 0;
    for (const turn of stat.examples) {
      if (selected.length >= max || stat.baseline_count + addedForSig >= desired) break;
      const before = selected.length;
      addCandidate(turn, stat, 'under_sampled_common_signature');
      if (selected.length > before) addedForSig++;
    }
  }

  return selected;
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140);
}

function writeTextReport(
  filename: string,
  all: Corpus,
  baseline: Corpus,
  stats: SignatureStats[],
  candidates: CorpusTurn[],
): void {
  const totalSignatures = stats.length;
  const coveredSignatures = stats.filter((s) => s.baseline_count > 0).length;
  const uncovered = stats.filter((s) => s.baseline_count === 0);
  const highUncovered = uncovered.filter((s) => s.priority === 'high');
  const underSampled = stats.filter((s) => s.all_count >= 5 && s.baseline_count < Math.min(3, s.all_count));

  const lines: string[] = [];
  lines.push('Taskflow Full-History Coverage Audit');
  lines.push('');
  lines.push(`All corpus turns: ${all.turns.length}`);
  lines.push(`Validated baseline turns: ${baseline.turns.length}`);
  lines.push(`Behavior signatures covered: ${coveredSignatures}/${totalSignatures}`);
  lines.push(`Uncovered signatures: ${uncovered.length} (${highUncovered.length} high-priority)`);
  lines.push(`Under-sampled common signatures: ${underSampled.length}`);
  lines.push(`Suggested next replay candidates: ${candidates.length}`);
  lines.push('');
  lines.push('Top Uncovered Signatures');
  for (const stat of uncovered.slice(0, 30)) {
    lines.push(`- [${stat.priority}] ${stat.signature} :: ${stat.all_count} turn(s)`);
  }
  lines.push('');
  lines.push('Under-Sampled Common Signatures');
  for (const stat of underSampled.slice(0, 20)) {
    lines.push(`- [${stat.priority}] ${stat.signature} :: baseline ${stat.baseline_count}/${stat.all_count}`);
  }
  lines.push('');
  lines.push('Next Candidate Replay Set');
  for (let i = 0; i < candidates.length; i++) {
    const turn = candidates[i];
    lines.push(`${i + 1}. [${turn.coverage_priority}] ${turn.behavior_signature}`);
    lines.push(`   source: ${turn.jsonl ?? '<unknown>'}#${turn.turn_index ?? '?'}`);
    lines.push(`   reason: ${turn.selection_reason}`);
    lines.push(`   text: ${excerpt(turn.user_message)}`);
  }
  lines.push('');
  lines.push('Interpretation');
  lines.push('- The original 30-turn corpus remains valid for the fixed Phase 3 compliance claim.');
  lines.push('- It does not exhaust the historical behavior space: validate the candidate set before claiming full-board migration confidence.');
  lines.push('- Do not run this candidate set as a paid replay without explicit approval.');

  fs.writeFileSync(filename, `${lines.join('\n')}\n`);
}

function main(): void {
  const args = parseArgs(process.argv);
  const all = loadCorpus(args.all);
  const baseline = loadCorpus(args.baseline);
  const baselineKeys = new Set(baseline.turns.map(turnKey));

  const allBySig = new Map<string, CorpusTurn[]>();
  const baselineCounts = new Map<string, number>();
  const toolHistogram = new Map<string, number>();

  for (const turn of all.turns) {
    const signature = behaviorSignature(turn);
    if (!allBySig.has(signature)) allBySig.set(signature, []);
    allBySig.get(signature)!.push(turn);
    for (const tool of turn.tool_uses) increment(toolHistogram, tool.tool_name);
  }

  for (const turn of baseline.turns) {
    increment(baselineCounts, behaviorSignature(turn));
  }

  const stats = sortedStats(allBySig, baselineCounts);
  const candidates = chooseCandidates(stats, baselineKeys, args.candidateMax);

  fs.mkdirSync(path.dirname(args.outJson), { recursive: true });
  fs.mkdirSync(path.dirname(args.outText), { recursive: true });
  fs.mkdirSync(path.dirname(args.candidateOut), { recursive: true });

  const uncovered = stats.filter((s) => s.baseline_count === 0);
  const report = {
    generated_at: new Date().toISOString(),
    all_corpus: args.all,
    baseline_corpus: args.baseline,
    all_turns: all.turns.length,
    baseline_turns: baseline.turns.length,
    total_signatures: stats.length,
    covered_signatures: stats.filter((s) => s.baseline_count > 0).length,
    uncovered_signatures: uncovered.length,
    high_priority_uncovered_signatures: uncovered.filter((s) => s.priority === 'high').length,
    under_sampled_common_signatures: stats.filter((s) => s.all_count >= 5 && s.baseline_count < Math.min(3, s.all_count)).length,
    tool_histogram: Object.fromEntries([...toolHistogram.entries()].sort((a, b) => b[1] - a[1])),
    signatures: stats.map((s) => ({
      signature: s.signature,
      all_count: s.all_count,
      baseline_count: s.baseline_count,
      priority: s.priority,
      first_example: {
        jsonl: s.examples[0]?.jsonl,
        turn_index: s.examples[0]?.turn_index,
        text_excerpt: s.examples[0] ? excerpt(s.examples[0].user_message) : '',
      },
    })),
    candidate_count: candidates.length,
    candidate_out: args.candidateOut,
  };

  fs.writeFileSync(args.outJson, JSON.stringify(report, null, 2));
  fs.writeFileSync(args.candidateOut, JSON.stringify({
    source_dir: all.source_dir,
    total_turns: all.turns.length,
    curated_count: candidates.length,
    selection: 'coverage_audit_candidates',
    turns: candidates,
  }, null, 2));
  writeTextReport(args.outText, all, baseline, stats, candidates);

  console.log(`Wrote ${args.outJson}`);
  console.log(`Wrote ${args.outText}`);
  console.log(`Wrote ${args.candidateOut}`);
  console.log(`Coverage: ${report.covered_signatures}/${report.total_signatures} signatures, candidates=${candidates.length}`);
}

main();
