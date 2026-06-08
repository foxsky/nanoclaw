import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { patchMotivationalProse, repatchMotivationalClaudeMd } from './repatch-motivational.js';

// An OLD (pre-motivational-only) deployed board, parameterized by report-tool vintage so we
// can prove the patch preserves whichever the board already uses. Contains every span the
// patcher edits, plus agent free-text memory that must survive untouched.
function oldBoard(reportTool: 'taskflow_report' | 'api_report'): string {
  return `# Case — TaskFlow (board-x)

## Tool Response Handling

**On \`success: true\`:**
- **If \`data.formatted_report\` exists** (digest, weekly): output \`formatted_report\` EXACTLY as-is via \`send_message\`. Do NOT rebuild IDs, regroup tasks, or reword the report body. **Then send a separate motivational message** (see Motivational Message below).
- **If \`data.formatted_board\` exists** (board query, standup): output \`formatted_board\` EXACTLY as-is. Do NOT build your own layout from \`data.columns\` or any other structured fields. The engine already formats the board — your job is to relay it unchanged.
- For all other responses with \`data\`: format \`data\` for WhatsApp using the formatting templates below

**On \`success: false\`:**
- If \`error\` exists, present it in PT-BR.

## Rendered Output Format

**CRITICAL — MANDATORY RULE:** When \`data.formatted_board\` exists in a tool response, you MUST output it EXACTLY as-is. This applies to board queries and standup reports.

When \`data.formatted_report\` exists in a tool response, you MUST output it EXACTLY as-is. This applies to digest and weekly reports. After sending it, you MUST also send a separate motivational message (see Motivational Message section below).

### Meeting Display

Meetings appear with the 📅 prefix.

### Standup-specific behavior

Call \`${reportTool}({ type: 'standup' })\` — the result includes \`formatted_board\` (use as-is) plus structured data for the attention footer.

- **Skip if empty:** If no tasks exist on the board, do NOT send.

### Digest (Evening)

Call \`${reportTool}({ type: 'digest' })\`. **Skip if empty.** If the result includes \`formatted_report\`, send it exactly as returned via \`send_message\`. Then send the motivational message as a **separate** \`send_message\` (see below).

### Weekly Review (Friday)

Call \`${reportTool}({ type: 'weekly' })\`. **Skip if empty.** If the result includes \`formatted_report\`, send it exactly as returned via \`send_message\`. Then send the motivational message as a **separate** \`send_message\` (see below).

### Motivational Message (MANDATORY — separate send_message after every digest and weekly report)

After sending the \`formatted_report\`, you MUST send a second \`send_message\` with a motivational message. This is a separate message so it stands out — not buried in the board. It has two parts:

**Part 1 — Celebration line.** A short, punchy opening with emojis.

## Agent memory
- Thiago prefers PT-BR. We used to send \`formatted_report\` then a separate motivational message — keep this note.
`;
}

// A second, more-evolved deployed vintage ("scheduled runs send via send_message + a separate
// motivational follow-up"). Different wording for the same spans — the patcher must recognize it
// via its second variant and converge on the identical motivational-only target.
function oldBoardV2(): string {
  return `# Case — TaskFlow (board-y)

## Tool Response Handling

**On \`success: true\`:**
- **If \`data.formatted_report\` exists** (digest, weekly): output \`formatted_report\` EXACTLY as-is. Do NOT rebuild IDs, regroup tasks, or reword the report body. For interactive user turns, make it your normal reply. For scheduled \`[TF-DIGEST]\` / \`[TF-REVIEW]\` runs, deliver it via \`send_message\` and then send the separate motivational follow-up from the section below.
- **If \`data.formatted_board\` exists** (board query, standup): output \`formatted_board\` EXACTLY as-is. Do NOT build your own layout from \`data.columns\` or any other structured fields. For interactive user turns, make it your normal reply. For scheduled \`[TF-STANDUP]\` runs, deliver it via \`send_message\`.

**On \`success: false\`:**
- If \`error\` exists, present it in PT-BR.

## Rendered Output Format

**CRITICAL — MANDATORY RULE:** When \`data.formatted_board\` exists in a tool response, you MUST output it EXACTLY as-is. This applies to board queries and standup reports. Interactive current-group turns use the normal assistant reply path; scheduled \`[TF-STANDUP]\` runs send the same body via \`send_message\`.

When \`data.formatted_report\` exists in a tool response, you MUST output it EXACTLY as-is. This applies to digest and weekly reports. Interactive current-group turns use the normal assistant reply path; scheduled \`[TF-DIGEST]\` / \`[TF-REVIEW]\` runs send the same body via \`send_message\`, then send the separate motivational follow-up below.

### Meeting Display

Meetings appear with the 📅 prefix.

### Standup-specific behavior

Call \`api_report({ type: 'standup' })\` — the result includes \`formatted_board\` (use as-is) plus structured data for the attention footer.

### Digest (Evening)

Call \`api_report({ type: 'digest' })\`. **Skip if empty.** If the result includes \`formatted_report\`, keep the rendered body exact. Interactive user requests reply with it normally. Scheduled \`[TF-DIGEST]\` runs send it via \`send_message\`, then send the motivational message as a **separate** \`send_message\` (see below).

### Weekly Review (Friday)

Call \`api_report({ type: 'weekly' })\`. **Skip if empty.** If the result includes \`formatted_report\`, keep the rendered body exact. Interactive user requests reply with it normally. Scheduled \`[TF-REVIEW]\` runs send it via \`send_message\`, then send the motivational message as a **separate** \`send_message\` (see below).

### Motivational Message (MANDATORY for scheduled digest/weekly runners)

After a scheduled \`[TF-DIGEST]\` or \`[TF-REVIEW]\` run sends the \`formatted_report\`, you MUST send a second \`send_message\` with a motivational message. This is a separate message so it stands out — not buried in the board. For interactive user-requested digest/weekly replies, stay on the normal reply path; do NOT open a same-group \`send_message\` just to separate the pep talk. It has two parts:

**Part 1 — Celebration line.** A short, punchy opening with emojis.
`;
}

describe('patchMotivationalProse', () => {
  it('converts the second deployed vintage too (multi-variant), converging on the same target', () => {
    const result = patchMotivationalProse(oldBoardV2());
    expect(result.fullyConverted).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.edits.every((e) => e.status === 'applied')).toBe(true);
    expect(result.output).toContain('### Scheduled Task Tags');
    expect(result.output).toContain('the only message for scheduled standup, digest, and weekly runs');
    expect(result.output).toContain(
      'Send only the motivational message (see below) — a warm evening narrative written from the data.',
    );
    // The old "send via send_message then separate follow-up" wording is gone.
    expect(result.output).not.toContain('send the separate motivational follow-up');
    expect(result.output).not.toContain('then send the motivational message as a **separate**');
  });

  it('both vintages converge on the byte-identical inserted Scheduled Task Tags section', () => {
    // The inserted section is single-sourced (one constant), so both vintages must land the
    // exact same block — regardless of which old wording the board started from. (We slice to
    // the next header so per-fixture differences in the standup body don't enter the compare.)
    const v1 = patchMotivationalProse(oldBoard('api_report')).output;
    const v2 = patchMotivationalProse(oldBoardV2()).output;
    const tags = (s: string) =>
      s.slice(s.indexOf('### Scheduled Task Tags'), s.indexOf('### Standup-specific behavior'));
    expect(tags(v1)).toBe(tags(v2));
    expect(tags(v1)).toContain('**Scheduled posts are motivational-only (no task list).**');
  });

  it('converts an api_report-vintage board fully and preserves the api_report tool name', () => {
    const result = patchMotivationalProse(oldBoard('api_report'));
    expect(result.fullyConverted).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.edits.every((e) => e.status === 'applied')).toBe(true);
    // Behavioral flip landed:
    expect(result.output).toContain(
      '**Scheduled `[TF-STANDUP]` / `[TF-DIGEST]` / `[TF-REVIEW]` runs:** do NOT send `formatted_board` or `formatted_report`',
    );
    expect(result.output).toContain('### Scheduled Task Tags');
    expect(result.output).toContain('the only message for scheduled standup, digest, and weekly runs');
    // Vintage preserved — api_report kept, taskflow_report NOT introduced:
    expect(result.output).toContain("Call `api_report({ type: 'standup' })`");
    expect(result.output).not.toContain('taskflow_report');
    // The old "send a separate motivational message" model is gone from standup/digest:
    expect(result.output).not.toContain('Then send the motivational message as a **separate**');
  });

  it('preserves the taskflow_report vintage on a v1-vintage board (never rewrites the tool name)', () => {
    const result = patchMotivationalProse(oldBoard('taskflow_report'));
    expect(result.fullyConverted).toBe(true);
    expect(result.output).toContain("Call `taskflow_report({ type: 'standup' })`");
    expect(result.output).not.toContain('api_report');
  });

  it('leaves agent free-text memory untouched', () => {
    const result = patchMotivationalProse(oldBoard('api_report'));
    expect(result.output).toContain(
      '- Thiago prefers PT-BR. We used to send `formatted_report` then a separate motivational message — keep this note.',
    );
  });

  it('is idempotent — re-running a converted board is a no-op (every edit already-present)', () => {
    const once = patchMotivationalProse(oldBoard('api_report'));
    const twice = patchMotivationalProse(once.output);
    expect(twice.changed).toBe(false);
    expect(twice.output).toBe(once.output);
    expect(twice.edits.every((e) => e.status === 'already')).toBe(true);
  });

  it('section-bounding: a copy of the old span in MEMORY is ignored; the rendered span converts, memory untouched', () => {
    // Codex BLOCKER (whole-file matching): matching is now confined to the digest section, so a
    // verbatim copy of the old rule sitting in an appended memory section is OUT of scope — the
    // rendered span converts cleanly and the memory copy is left byte-for-byte intact.
    const memoryLine =
      "- For reference, the old digest rule was: Call `api_report({ type: 'digest' })`. **Skip if empty.** If the result includes `formatted_report`, send it exactly as returned via `send_message`. Then send the motivational message as a **separate** `send_message` (see below).";
    const result = patchMotivationalProse(oldBoard('api_report') + '\n## More memory\n' + memoryLine + '\n');
    expect(result.fullyConverted).toBe(true);
    expect(result.edits.find((e) => e.id === 'digest-behavior')?.status).toBe('applied');
    expect(result.output).toContain(memoryLine); // memory copy preserved verbatim
  });

  it('Codex residual: an old span that exists ONLY in memory (rendered section customized) is NOT patched', () => {
    // The decisive section-bounding property: if the RENDERED digest section is hand-customized
    // (no recognized old span) and a verbatim old span sits only in memory, the edit must refuse
    // (unmatched → needs_manual) rather than reach into memory and mutate the quote.
    const customRendered = oldBoard('api_report').replace(
      /Call `api_report\(\{ type: 'digest' \}\)`\. \*\*Skip if empty\.\*\* If the result includes `formatted_report`, send it exactly as returned via `send_message`\. Then send the motivational message as a \*\*separate\*\* `send_message` \(see below\)\./,
      "Call `api_report({ type: 'digest' })`. CUSTOM HAND-EDITED DIGEST WORDING.",
    );
    const memoryLine =
      "- Old digest rule: Call `api_report({ type: 'digest' })`. **Skip if empty.** If the result includes `formatted_report`, send it exactly as returned via `send_message`. Then send the motivational message as a **separate** `send_message` (see below).";
    const result = patchMotivationalProse(customRendered + '\n## Memory\n' + memoryLine + '\n');
    expect(result.fullyConverted).toBe(false);
    expect(result.edits.find((e) => e.id === 'digest-behavior')?.status).toBe('unmatched');
    expect(result.output).toContain(memoryLine); // memory quote never touched
    expect(result.output).toContain('CUSTOM HAND-EDITED DIGEST WORDING.'); // rendered left as-is
  });

  it('section-bounding: a NEW marker quoted in memory does not affect the rendered conversion', () => {
    // A new-marker phrase quoted in an appended notes section is outside the digest region, so it
    // neither blocks the real conversion nor gets mutated.
    const noteLine =
      '- Reminder to self: the digest should "Send only the motivational message (see below) — a warm evening narrative written from the data."';
    const withMarkerInMemory = oldBoard('api_report') + '\n## Notes\n' + noteLine + '\n';
    const result = patchMotivationalProse(withMarkerInMemory);
    expect(result.fullyConverted).toBe(true);
    expect(result.edits.find((e) => e.id === 'digest-behavior')?.status).toBe('applied');
    expect(result.output).toContain(noteLine); // the quoted marker in memory is preserved
  });

  it('REFUSES when a bounding section header is duplicated (e.g. quoted in memory) — region not well-formed', () => {
    // Codex BLOCKER #2: sliceRegion now requires BOTH bounding headers to occur exactly once,
    // so a memory copy of an end/section header can't let `mid` stretch into memory.
    const dup = oldBoard('api_report') + '\n## Memory\n- I once wrote a "### Digest (Evening)" header in my notes.\n';
    const result = patchMotivationalProse(dup);
    expect(result.fullyConverted).toBe(false);
    // '### Digest (Evening)' bounds both the standup region (end) and the digest region (start):
    expect(result.edits.find((e) => e.id === 'standup-behavior')?.status).toBe('unmatched');
    expect(result.edits.find((e) => e.id === 'digest-behavior')?.status).toBe('unmatched');
  });

  it('does NOT report `already` for a partially-converted section — `already` needs the full canonical span', () => {
    // Codex IMPORTANT: a section that contains a short motivational phrase but not the exact
    // canonical new output (and no recognized old span) must be `unmatched`, not `already`.
    const converted = patchMotivationalProse(oldBoard('api_report')).output;
    // Truncate the digest's canonical tail (drop the parenthetical) so it's no longer the exact
    // new span, and remove the old span — neither old nor full-new is present.
    const partial = converted.replace(
      ' (On-demand "resumo"/digest requests from a person still reply with the rendered `formatted_report` as-is; this motivational-only rule applies to scheduled `[TF-DIGEST]` runs.)',
      '',
    );
    const result = patchMotivationalProse(partial);
    expect(result.edits.find((e) => e.id === 'digest-behavior')?.status).toBe('unmatched');
  });

  it('flags an unrecognized-vintage board as NOT fully converted when a span is missing', () => {
    // Drop the standup span → that edit can neither match nor be already-present.
    const broken = oldBoard('api_report').replace(
      /Call `api_report\(\{ type: 'standup' \}\)` — the result includes `formatted_board` \(use as-is\) plus structured data for the attention footer\./,
      "Call `api_report({ type: 'standup' })` — CUSTOM HAND-EDITED STANDUP WORDING.",
    );
    const result = patchMotivationalProse(broken);
    expect(result.fullyConverted).toBe(false);
    expect(result.edits.find((e) => e.id === 'standup-behavior')?.status).toBe('unmatched');
  });
});

describe('repatchMotivationalClaudeMd (all-or-nothing runner)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repatch-motiv-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function seed(folder: string, body: string): string {
    const g = path.join(dir, folder);
    fs.mkdirSync(g, { recursive: true });
    const f = path.join(g, 'CLAUDE.local.md');
    fs.writeFileSync(f, body);
    return f;
  }

  it('dry-run reports would-patch without writing', () => {
    const f = seed('board-a', oldBoard('api_report'));
    const before = fs.readFileSync(f, 'utf8');
    const report = repatchMotivationalClaudeMd(dir, { write: false });
    expect(report).toHaveLength(1);
    expect(report[0].outcome).toBe('dry-run');
    expect(fs.readFileSync(f, 'utf8')).toBe(before); // untouched
  });

  it('write converts a recognized board and is idempotent on a second write run', () => {
    const f = seed('board-a', oldBoard('api_report'));
    expect(repatchMotivationalClaudeMd(dir, { write: true })[0].outcome).toBe('patched');
    const patched = fs.readFileSync(f, 'utf8');
    expect(patched).toContain('### Scheduled Task Tags');
    // Second run: already converted → no-op, no further change.
    const second = repatchMotivationalClaudeMd(dir, { write: true });
    expect(second[0].outcome).toBe('already');
    expect(fs.readFileSync(f, 'utf8')).toBe(patched);
  });

  it('NEVER half-writes a board of an unrecognized vintage (all-or-nothing → needs_manual)', () => {
    const broken = oldBoard('api_report').replace(
      "Call `api_report({ type: 'digest' })`. **Skip if empty.** If the result includes `formatted_report`, send it exactly as returned via `send_message`. Then send the motivational message as a **separate** `send_message` (see below).",
      "Call `api_report({ type: 'digest' })`. CUSTOM DIGEST WORDING.",
    );
    const f = seed('board-weird', broken);
    const before = fs.readFileSync(f, 'utf8');
    const report = repatchMotivationalClaudeMd(dir, { write: true });
    expect(report[0].outcome).toBe('needs_manual');
    // The decisive safety property: a board we don't fully recognize is left EXACTLY as-is,
    // never half-converted (some sections motivational, some metrics).
    expect(fs.readFileSync(f, 'utf8')).toBe(before);
  });

  it('skips non-scheduled TaskFlow prompts instead of reporting manual work', () => {
    const f = seed('main', '# Main\n\nYou are a general assistant.\n');
    const before = fs.readFileSync(f, 'utf8');
    const report = repatchMotivationalClaudeMd(dir, { write: true });
    expect(report[0].outcome).toBe('skipped');
    expect(report[0].edits).toEqual([]);
    expect(fs.readFileSync(f, 'utf8')).toBe(before);
  });
});
