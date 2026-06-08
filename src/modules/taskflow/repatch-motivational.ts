import fs from 'node:fs';
import path from 'node:path';

/**
 * §6d cutover runner — convert DEPLOYED boards' `CLAUDE.local.md` from the old
 * "send the rendered board/report AND a separate motivational message" model to the
 * v2 "scheduled `[TF-*]` runs send ONLY the motivational message" model.
 *
 * `renderBoardClaudeMd` bakes the motivational-only instructions at NEW provision only,
 * so boards provisioned before that change keep telling the agent to send the metrics
 * digest on scheduled runs. This re-homes the behavior surgically.
 *
 * SAFE BY CONSTRUCTION — mirrors `patchRelayProse`, NOT the full migrate-board-claudemd
 * patcher (whose blanket `taskflow_*`→`api_*` renames could corrupt the agent's free-text
 * memory appended to the same file — Codex reverted the first full-patcher runner for
 * exactly this). Specifically:
 *  - Every edit matches an EXACT, multi-sentence span (or section-anchored regex), never a
 *    blanket token regex.
 *  - UNIQUENESS-REQUIRED: an edit applies ONLY when its old span occurs EXACTLY ONCE in the
 *    file. If the same span also appears in the agent's free-text memory (≥2 occurrences),
 *    or a NEW marker is present while the OLD span still is (a memory quote), the edit is
 *    `unmatched` and the board is refused — we never guess which occurrence is the rendered
 *    instruction. (Closes the whole-file-substring hazard Codex flagged.)
 *  - Tool-name VINTAGE is PRESERVED: the report-call edits capture `(taskflow|api)_report`
 *    and echo it back via `$1`, so a v1-vintage board keeps `taskflow_report` and a v2 board
 *    keeps `api_report` — the patch never reintroduces the wrong tool name.
 *  - Each edit is idempotent: a board already converted re-runs to a no-op.
 *  - ALL-OR-NOTHING per board: if ANY edit is `unmatched`, the board is NOT written and is
 *    flagged `needs_manual`. A half-converted board (some sections motivational, some metrics)
 *    is worse than a consistently-old one, so we never write a partial result.
 *
 * `write:false` is a dry-run (report only). Run with `write:true` as a cutover step,
 * AFTER reviewing the per-board diff — boards reported `needs_manual` are hand-edited.
 */

export type EditStatus = 'applied' | 'already' | 'unmatched';

export interface EditResult {
  id: string;
  status: EditStatus;
}

interface EvalResult {
  status: EditStatus;
  output: string;
}

interface Edit {
  id: string;
  /** Pure: classify this edit against `s` and, if applicable, return the converted text. */
  evaluate: (s: string) => EvalResult;
}

/** Count non-overlapping occurrences of a literal string or (global-ized) regex in `s`. */
function countMatches(s: string, needle: string | RegExp): number {
  if (typeof needle === 'string') {
    if (needle.length === 0) return 0;
    let n = 0;
    let i = s.indexOf(needle);
    while (i !== -1) {
      n++;
      i = s.indexOf(needle, i + needle.length);
    }
    return n;
  }
  const g = new RegExp(needle.source, needle.flags.includes('g') ? needle.flags : needle.flags + 'g');
  return (s.match(g) || []).length;
}

interface Variant {
  /** The exact old span (literal or non-global regex with a `$1` tool-name capture). */
  old: string | RegExp;
  /** The replacement (literal, or with `$1` to echo the captured tool-name vintage). */
  next: string;
}

/** A `[start, end)` header-bounded rendered-template region. Both anchors are rendered-template
 *  headers; agent free-text memory lives OUTSIDE them, so matching is scoped away from memory. */
type Region = [start: string, end: string];

/**
 * Isolate the rendered-template region `[start, end)`. Returns `null` (→ caller refuses) when the
 * start header is missing OR appears more than once (ambiguous — e.g. quoted in memory too), or
 * when the end header doesn't follow it. This is the structural guard that keeps every edit's
 * matching inside the rendered instructions and out of free-text memory.
 */
function sliceRegion(s: string, [start, end]: Region): { pre: string; mid: string; post: string } | null {
  // BOTH bounding headers must occur EXACTLY ONCE. Requiring the end header to be unique too
  // closes the case where the real rendered end header was renamed/removed and the SAME header
  // text reappears in agent memory — without this, `mid` could stretch from the rendered start
  // into memory and an edit could count/replace a memory copy.
  if (countMatches(s, start) !== 1 || countMatches(s, end) !== 1) return null;
  const a = s.indexOf(start);
  const b = s.indexOf(end, a + start.length);
  if (b === -1) return null; // the sole `end` occurrence is before `start` → region not well-formed
  return { pre: s.slice(0, a), mid: s.slice(a, b), post: s.slice(b) };
}

/**
 * A span-REPLACE edit with one variant per known wording vintage, all converging on the same
 * target. Matching is confined to the header-bounded rendered region `within`; the edit is:
 *  - `unmatched` — the region can't be isolated (missing/duplicated bounding header → refuse);
 *  - `already`   — newMarker present in the region AND no old variant remains (genuinely converted);
 *  - `applied`   — newMarker absent AND exactly one variant's old span occurs EXACTLY ONCE in-region;
 *  - `unmatched` — anything else (no old span, a duplicated old span, or a stray newMarker while
 *                  the old span persists → refuse). Matches OUTSIDE the region never count.
 */
function replaceEdit(id: string, within: Region, newMarker: string, variants: Variant[]): Edit {
  return {
    id,
    evaluate(s) {
      const r = sliceRegion(s, within);
      if (!r) return { status: 'unmatched', output: s };
      const nNew = countMatches(r.mid, newMarker);
      const counts = variants.map((v) => countMatches(r.mid, v.old));
      const oldTotal = counts.reduce((a, b) => a + b, 0);
      if (nNew >= 1 && oldTotal === 0) return { status: 'already', output: s };
      const matchedIdxs = counts.map((n, i) => (n >= 1 ? i : -1)).filter((i) => i >= 0);
      const onlyOneVariant = matchedIdxs.length === 1 && counts[matchedIdxs[0]] === 1;
      if (nNew === 0 && onlyOneVariant) {
        const mid = r.mid.replace(variants[matchedIdxs[0]].old, variants[matchedIdxs[0]].next);
        return { status: 'applied', output: r.pre + mid + r.post };
      }
      return { status: 'unmatched', output: s };
    },
  };
}

/**
 * A section-INSERT edit (the new Scheduled Task Tags section), confined to the region `within`.
 * `convertedMarker` is the exact inserted-section-tail→anchor adjacency that exists ONLY after a
 * real insertion (so a stray heading in memory can't read as converted). Inserts only when the
 * anchor occurs EXACTLY ONCE inside the region.
 */
function insertEdit(id: string, within: Region, convertedMarker: string, anchor: string, section: string): Edit {
  return {
    id,
    evaluate(s) {
      const r = sliceRegion(s, within);
      if (!r) return { status: 'unmatched', output: s };
      if (r.mid.includes(convertedMarker)) return { status: 'already', output: s };
      if (countMatches(r.mid, anchor) === 1) {
        const mid = r.mid.replace(anchor, section + anchor);
        return { status: 'applied', output: r.pre + mid + r.post };
      }
      return { status: 'unmatched', output: s };
    },
  };
}

// The new Scheduled Task Tags section (tool-name-neutral) inserted before the standup section
// on boards that predate it. Kept vintage-neutral ("the relevant report") so it never bakes a
// specific tool name into a board of the other vintage.
const STANDUP_ANCHOR = '### Standup-specific behavior';
const SCHEDULED_TASK_TAGS_SECTION = `### Scheduled Task Tags

When your prompt is a bare tag, follow the corresponding section:
- \`[TF-STANDUP]\` → Follow "Standup-specific behavior" below
- \`[TF-DIGEST]\` → Follow "Digest (Evening)" below
- \`[TF-REVIEW]\` → Follow "Weekly Review (Friday)" below

**Scheduled posts are motivational-only (no task list).** For every scheduled \`[TF-STANDUP]\`, \`[TF-DIGEST]\`, and \`[TF-REVIEW]\` run, send EXACTLY ONE \`send_message\`: the motivational message described in "Motivational Message" below. Never send \`formatted_board\` or \`formatted_report\` (the rendered task list) from a scheduled run. Still call the relevant report so you have the \`data\` to write the narrative from — just don't send the rendered list. The full board/report is reserved for **explicit, on-demand** requests from a person in the chat (e.g. "mostrar o quadro"), never for automated posts.

**\`[TF-SUMMARY-ONLY]\`:** legacy marker. Scheduled posts are already motivational-only (see the rule above), so treat this marker the same way — send just the motivational message, never \`formatted_board\` or \`formatted_report\`.

`;
// Present only after a real insertion: the section's last line is immediately followed by the
// standup anchor. A bare "### Scheduled Task Tags" heading quoted in memory would NOT create this.
const SCHEDULED_TAGS_INSERTED =
  'send just the motivational message, never `formatted_board` or `formatted_report`.\n\n' + STANDUP_ANCHOR;

// The motivational-only TARGETS — identical regardless of source vintage. The report-call
// targets keep `$1` so the board's own tool-name vintage (taskflow_report | api_report) is
// echoed back, never rewritten.
const NEW_TRH_BULLETS =
  "- **Scheduled `[TF-STANDUP]` / `[TF-DIGEST]` / `[TF-REVIEW]` runs:** do NOT send `formatted_board` or `formatted_report`. Send only the motivational message (see Scheduled Task Tags and Motivational Message below). Still call the report so you have the `data` to write the narrative from — just don't send the rendered list.\n" +
  '- **If `data.formatted_report` exists** and a person explicitly asked for the digest/weekly report on demand: output `formatted_report` EXACTLY as-is. Do NOT rebuild IDs, regroup tasks, or reword the report body. For interactive user turns, make it your normal reply.\n' +
  '- **If `data.formatted_board` exists** and a person explicitly asked for the board on demand: output `formatted_board` EXACTLY as-is. Do NOT build your own layout from `data.columns` or any other structured fields. For interactive user turns, make it your normal reply.';
const NEW_RENDERED_INTRO =
  '**Rendered fields are for explicit, on-demand human requests only.** When `data.formatted_board` exists and a person explicitly asked to see the board (e.g. "quadro", "mostrar o quadro", "status"), you MUST output it EXACTLY as-is. When `data.formatted_report` exists and a person explicitly asked for the digest/weekly report on demand, you MUST output it EXACTLY as-is.\n\n' +
  '**Scheduled `[TF-STANDUP]` / `[TF-DIGEST]` / `[TF-REVIEW]` runs are the exception — they send only the motivational message, NEVER `formatted_board` or `formatted_report`. See Scheduled Task Tags and Motivational Message.**';
const NEW_STANDUP =
  "Call `$1({ type: 'standup' })` to read the board **data** (in-progress, overdue, due-today, waiting, completions, streaks). Do NOT send `formatted_board`. Send only the motivational message (see below): a warm good-morning narrative written from that data.";
const NEW_DIGEST =
  'Call `$1({ type: \'digest\' })`. **Skip if empty.** Do NOT send `formatted_report`. Send only the motivational message (see below) — a warm evening narrative written from the data. (On-demand "resumo"/digest requests from a person still reply with the rendered `formatted_report` as-is; this motivational-only rule applies to scheduled `[TF-DIGEST]` runs.)';
const NEW_WEEKLY =
  'Call `$1({ type: \'weekly\' })`. **Skip if empty.** Do NOT send `formatted_report`. Send only the motivational message (see below) — a warm end-of-week narrative written from the data. (On-demand "revisão"/"resumo semanal" requests from a person still reply with the rendered `formatted_report` as-is; this motivational-only rule applies to scheduled `[TF-REVIEW]` runs.)';
const NEW_MOTIV_HEADER =
  '### Motivational Message (MANDATORY — the only message for scheduled standup, digest, and weekly runs)\n\n' +
  'For scheduled `[TF-STANDUP]`, `[TF-DIGEST]`, and `[TF-REVIEW]` runs, this motivational message is the ONLY thing you send — a single `send_message`, with no task list before or after it. For interactive user-requested board/digest/weekly replies, stay on the normal rendered-reply path; do NOT open a same-group `send_message` just to add a pep talk. It has two parts:';

// Each edit lists one old→new variant per KNOWN wording vintage (V1 = "board + separate
// motivational"; V2 = "scheduled runs send via send_message + separate motivational follow-up").
// Both map to the same motivational-only target above. A board matching no variant uniquely is
// flagged needs_manual.
const EDITS: Edit[] = [
  replaceEdit(
    'tool-response-success-bullets',
    ['**On `success: true`:**', '**On `success: false`:**'],
    NEW_TRH_BULLETS,
    [
      {
        old:
          '- **If `data.formatted_report` exists** (digest, weekly): output `formatted_report` EXACTLY as-is via `send_message`. Do NOT rebuild IDs, regroup tasks, or reword the report body. **Then send a separate motivational message** (see Motivational Message below).\n' +
          '- **If `data.formatted_board` exists** (board query, standup): output `formatted_board` EXACTLY as-is. Do NOT build your own layout from `data.columns` or any other structured fields. The engine already formats the board — your job is to relay it unchanged.',
        next: NEW_TRH_BULLETS,
      },
      {
        old:
          '- **If `data.formatted_report` exists** (digest, weekly): output `formatted_report` EXACTLY as-is. Do NOT rebuild IDs, regroup tasks, or reword the report body. For interactive user turns, make it your normal reply. For scheduled `[TF-DIGEST]` / `[TF-REVIEW]` runs, deliver it via `send_message` and then send the separate motivational follow-up from the section below.\n' +
          '- **If `data.formatted_board` exists** (board query, standup): output `formatted_board` EXACTLY as-is. Do NOT build your own layout from `data.columns` or any other structured fields. For interactive user turns, make it your normal reply. For scheduled `[TF-STANDUP]` runs, deliver it via `send_message`.',
        next: NEW_TRH_BULLETS,
      },
    ],
  ),
  replaceEdit('rendered-output-intro', ['## Rendered Output Format', '### Meeting Display'], NEW_RENDERED_INTRO, [
    {
      old:
        '**CRITICAL — MANDATORY RULE:** When `data.formatted_board` exists in a tool response, you MUST output it EXACTLY as-is. This applies to board queries and standup reports.\n\n' +
        'When `data.formatted_report` exists in a tool response, you MUST output it EXACTLY as-is. This applies to digest and weekly reports. After sending it, you MUST also send a separate motivational message (see Motivational Message section below).',
      next: NEW_RENDERED_INTRO,
    },
    {
      old:
        '**CRITICAL — MANDATORY RULE:** When `data.formatted_board` exists in a tool response, you MUST output it EXACTLY as-is. This applies to board queries and standup reports. Interactive current-group turns use the normal assistant reply path; scheduled `[TF-STANDUP]` runs send the same body via `send_message`.\n\n' +
        'When `data.formatted_report` exists in a tool response, you MUST output it EXACTLY as-is. This applies to digest and weekly reports. Interactive current-group turns use the normal assistant reply path; scheduled `[TF-DIGEST]` / `[TF-REVIEW]` runs send the same body via `send_message`, then send the separate motivational follow-up below.',
      next: NEW_RENDERED_INTRO,
    },
  ]),
  insertEdit(
    'scheduled-task-tags-section',
    ['## Rendered Output Format', '### Digest (Evening)'],
    SCHEDULED_TAGS_INSERTED,
    STANDUP_ANCHOR,
    SCHEDULED_TASK_TAGS_SECTION,
  ),
  replaceEdit(
    'standup-behavior',
    ['### Standup-specific behavior', '### Digest (Evening)'],
    NEW_STANDUP.slice(NEW_STANDUP.indexOf('to read the board')),
    [
      {
        old: /Call `((?:taskflow|api)_report)\(\{ type: 'standup' \}\)` — the result includes `formatted_board` \(use as-is\) plus structured data for the attention footer\./,
        next: NEW_STANDUP,
      },
    ],
  ),
  replaceEdit(
    'digest-behavior',
    ['### Digest (Evening)', '### Weekly Review (Friday)'],
    NEW_DIGEST.slice(NEW_DIGEST.indexOf('**Skip if empty.**')),
    [
      {
        old: /Call `((?:taskflow|api)_report)\(\{ type: 'digest' \}\)`\. \*\*Skip if empty\.\*\* If the result includes `formatted_report`, send it exactly as returned via `send_message`\. Then send the motivational message as a \*\*separate\*\* `send_message` \(see below\)\./,
        next: NEW_DIGEST,
      },
      {
        old: /Call `((?:taskflow|api)_report)\(\{ type: 'digest' \}\)`\. \*\*Skip if empty\.\*\* If the result includes `formatted_report`, keep the rendered body exact\. Interactive user requests reply with it normally\. Scheduled `\[TF-DIGEST\]` runs send it via `send_message`, then send the motivational message as a \*\*separate\*\* `send_message` \(see below\)\./,
        next: NEW_DIGEST,
      },
    ],
  ),
  replaceEdit(
    'weekly-behavior',
    ['### Weekly Review (Friday)', '### Motivational Message'],
    NEW_WEEKLY.slice(NEW_WEEKLY.indexOf('**Skip if empty.**')),
    [
      {
        old: /Call `((?:taskflow|api)_report)\(\{ type: 'weekly' \}\)`\. \*\*Skip if empty\.\*\* If the result includes `formatted_report`, send it exactly as returned via `send_message`\. Then send the motivational message as a \*\*separate\*\* `send_message` \(see below\)\./,
        next: NEW_WEEKLY,
      },
      {
        old: /Call `((?:taskflow|api)_report)\(\{ type: 'weekly' \}\)`\. \*\*Skip if empty\.\*\* If the result includes `formatted_report`, keep the rendered body exact\. Interactive user requests reply with it normally\. Scheduled `\[TF-REVIEW\]` runs send it via `send_message`, then send the motivational message as a \*\*separate\*\* `send_message` \(see below\)\./,
        next: NEW_WEEKLY,
      },
    ],
  ),
  replaceEdit('motivational-header', ['### Motivational Message', '**Part 1 — Celebration line.**'], NEW_MOTIV_HEADER, [
    {
      old:
        '### Motivational Message (MANDATORY — separate send_message after every digest and weekly report)\n\n' +
        'After sending the `formatted_report`, you MUST send a second `send_message` with a motivational message. This is a separate message so it stands out — not buried in the board. It has two parts:',
      next: NEW_MOTIV_HEADER,
    },
    {
      old:
        '### Motivational Message (MANDATORY for scheduled digest/weekly runners)\n\n' +
        'After a scheduled `[TF-DIGEST]` or `[TF-REVIEW]` run sends the `formatted_report`, you MUST send a second `send_message` with a motivational message. This is a separate message so it stands out — not buried in the board. For interactive user-requested digest/weekly replies, stay on the normal reply path; do NOT open a same-group `send_message` just to separate the pep talk. It has two parts:',
      next: NEW_MOTIV_HEADER,
    },
  ]),
];

export interface MotivationalPatchResult {
  output: string;
  changed: boolean;
  /** True iff every edit is applied-or-already (no unmatched span) — the board is on-vintage. */
  fullyConverted: boolean;
  edits: EditResult[];
}

/**
 * Pure transform. Evaluates each edit in order, recording per-edit status.
 * Idempotent: re-running a converted file yields `changed:false` with every edit `already`.
 */
export function patchMotivationalProse(input: string): MotivationalPatchResult {
  let output = input;
  const edits: EditResult[] = [];
  for (const edit of EDITS) {
    const { status, output: next } = edit.evaluate(output);
    output = next;
    edits.push({ id: edit.id, status });
  }
  const fullyConverted = edits.every((e) => e.status !== 'unmatched');
  return { output, changed: output !== input, fullyConverted, edits };
}

export interface MotivationalRepatchReport {
  path: string;
  /** 'patched': edits applied + written; 'dry-run': would patch; 'already': on new template;
   *  'needs_manual': some span unmatched (wording vintage not recognized) — NOT written;
   *  'skipped': not a scheduled TaskFlow board prompt. */
  outcome: 'patched' | 'dry-run' | 'already' | 'needs_manual' | 'skipped';
  edits: EditResult[];
}

function isScheduledTaskflowPrompt(s: string): boolean {
  return (
    s.includes('## Rendered Output Format') ||
    s.includes('### Standup-specific behavior') ||
    s.includes('### Digest (Evening)') ||
    s.includes('### Weekly Review (Friday)') ||
    s.includes('### Motivational Message')
  );
}

/**
 * Walk `groups/<folder>/CLAUDE.local.md` and apply the motivational conversion.
 * ALL-OR-NOTHING: a file with any unmatched span is left untouched and flagged
 * `needs_manual` (never half-written). `write:false` reports only.
 */
export function repatchMotivationalClaudeMd(groupsDir: string, opts: { write: boolean }): MotivationalRepatchReport[] {
  const report: MotivationalRepatchReport[] = [];
  for (const ent of fs.readdirSync(groupsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const file = path.join(groupsDir, ent.name, 'CLAUDE.local.md');
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    if (!isScheduledTaskflowPrompt(before)) {
      report.push({ path: file, outcome: 'skipped', edits: [] });
      continue;
    }
    const { output, changed, fullyConverted, edits } = patchMotivationalProse(before);

    let outcome: MotivationalRepatchReport['outcome'];
    if (!fullyConverted) {
      outcome = 'needs_manual';
    } else if (!changed) {
      outcome = 'already';
    } else if (opts.write) {
      fs.writeFileSync(file, output);
      outcome = 'patched';
    } else {
      outcome = 'dry-run';
    }
    report.push({ path: file, outcome, edits });
  }
  return report;
}

function main(): void {
  const groupsDir = process.argv[2];
  const write = process.argv.includes('--write');
  if (!groupsDir || groupsDir.startsWith('--')) {
    console.error('usage: tsx src/modules/taskflow/repatch-motivational.ts <groupsDir> [--write]   (default: dry-run)');
    process.exit(2);
  }
  const report = repatchMotivationalClaudeMd(groupsDir, { write });
  console.log(`\n=== §6d motivational-only refresh (${write ? 'WRITE' : 'DRY-RUN'}) on ${groupsDir} ===\n`);
  for (const r of report) {
    const detail =
      r.outcome === 'needs_manual'
        ? ` [unmatched: ${r.edits
            .filter((e) => e.status === 'unmatched')
            .map((e) => e.id)
            .join(', ')}]`
        : '';
    console.log(`  ${r.outcome.padEnd(12)} ${r.path}${detail}`);
  }
  const manual = report.filter((r) => r.outcome === 'needs_manual');
  console.log(
    `\n${report.filter((r) => r.outcome === 'patched').length} patched, ` +
      `${report.filter((r) => r.outcome === 'dry-run').length} would-patch, ` +
      `${report.filter((r) => r.outcome === 'already').length} already, ` +
      `${report.filter((r) => r.outcome === 'skipped').length} skipped, ` +
      `${manual.length} needs-manual`,
  );
  if (manual.length) {
    console.log(
      `\n⚠ ${manual.length} board(s) have an unrecognized wording vintage — review + hand-edit each (NOT auto-written):`,
    );
    for (const r of manual) console.log(`    ${r.path}`);
  }
  console.log(`\n=== done (${write ? 'changes written' : 'no changes — dry-run'}) ===\n`);
}

if (process.argv[1] && process.argv[1].endsWith('repatch-motivational.ts')) {
  main();
}
