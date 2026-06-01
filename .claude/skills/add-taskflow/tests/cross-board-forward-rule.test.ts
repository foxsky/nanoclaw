import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Guards the cross-board forward rule (the 2026-04-27 preemptive-refusal bug fix) in the
 * board-provisioning TEMPLATE — the surface every NEW board inherits. This replaces the old
 * migrate-cross-board-forward.test.ts, which exercised a one-time migration script
 * (scripts/migrate-claude-md-cross-board-forward.mjs) that was applied to all boards and then
 * removed; that test had become a broken reference to a deleted file.
 *
 * The rule is intentionally PROMPT-shaped: an engine-side "preemptive forward" path was
 * rejected in v1 because it would bypass the engine's cross_board_subtask_mode
 * (open/blocked/approval) gating. So the durable guardrail is "the rule must stay in the
 * template", which is exactly what this test enforces — without re-introducing an engine bypass.
 */
const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates/CLAUDE.md.template');

describe('cross-board forward rule (provisioning template)', () => {
  let tpl: string;
  let plain: string; // emphasis-stripped so `**Never**`-style markdown doesn't break phrase regex
  beforeAll(() => {
    tpl = fs.readFileSync(TEMPLATE, 'utf8');
    plain = tpl.replace(/\*\*/g, '');
  });

  it('ships the cross-board add_subtask forward rule', () => {
    expect(tpl).toContain('Cross-board add_subtask forward');
    expect(plain).toMatch(/try the tool first|always try/i);
    expect(tpl).toContain('taskflow_update');
  });

  // Bug 2026-04-27 (msg 3EB04ABD3417EAA72CA13F): the bot recognized P11 belonged to parent
  // SECI from a `[seci]` prefix and refused without forwarding. The rule must name the
  // recognition path AND ban preemptive refusal.
  it('bans preemptive refusal on the recognition path', () => {
    expect(tpl).toMatch(/recogni[sz]e|reconhece/i);
    expect(tpl).toContain('[seci]');
    expect(plain).toMatch(/never\s+refuse\s+preemptively/i);
  });

  // The literal Portuguese fragments from the bug that the rule explicitly forbids.
  it('forbids the exact refusal phrases observed in the 2026-04-27 bug', () => {
    expect(tpl).toContain('pertence ao quadro');
    expect(tpl).toContain('faça por lá');
    expect(tpl).toContain('precisará fazer pelo quadro');
  });

  // The rule must mandate calling the tool first so the engine's blocked/approval branches for
  // delegated tasks are never short-circuited by a client-side forward.
  it('preserves engine-first ordering (does not short-circuit cross_board_subtask_mode)', () => {
    expect(tpl).toContain('cross_board_subtask_mode');
    expect(tpl).toMatch(/\bopen\b/);
    expect(tpl).toMatch(/\bblocked\b/);
    expect(tpl).toMatch(/\bapproval\b/);
  });

  // Codex pre-merge guard from the original fix: `boards` has no `name` column, so the lookup
  // SQL must use group_folder / short_code, not b_parent.name.
  it('the forward-lookup SQL uses real boards columns (no b_parent.name)', () => {
    expect(tpl).not.toMatch(/b_parent\.name\b/);
    expect(tpl).toMatch(/group_folder|short_code/);
    expect(tpl).toContain("t.type = 'project'");
  });
});
