import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT = path.resolve('/root/nanoclaw/scripts/migrate-claude-md-cross-board-forward.mjs');

function setupFixture(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-cb-'));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function writeBoard(
  groupsDir: string,
  folder: string,
  body: string,
): string {
  const boardDir = path.join(groupsDir, folder);
  fs.mkdirSync(boardDir, { recursive: true });
  const file = path.join(boardDir, 'CLAUDE.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function runMigration(groupsDir: string): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('node', [SCRIPT, groupsDir], { encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 0 };
}

const ANCHOR =
  'A silent no-op loses information.';

const TEMPLATE_PRE_RULE = `# Case — TaskFlow (TEST-FIXTURE - TaskFlow)

This is a TaskFlow board prompt with the taskflow_update marker.
${ANCHOR}

(more content below)
`;

describe('migrate-claude-md-cross-board-forward', () => {
  let env: { dir: string; cleanup: () => void };
  beforeEach(() => { env = setupFixture(); });
  afterEach(() => env.cleanup());

  it('substitutes {{BOARD_ID}} from folder name', () => {
    writeBoard(env.dir, 'fixture-board', TEMPLATE_PRE_RULE);
    const result = runMigration(env.dir);
    expect(result.code).toBe(0);
    const after = fs.readFileSync(path.join(env.dir, 'fixture-board', 'CLAUDE.md'), 'utf8');
    expect(after).toContain('Cross-board add_subtask forward');
    // Substituted, not literal
    expect(after).not.toContain('{{BOARD_ID}}');
    expect(after).toContain("'board-fixture-board'");
  });

  it('substitutes {{GROUP_NAME}} from the file title', () => {
    writeBoard(env.dir, 'fixture-board', TEMPLATE_PRE_RULE);
    runMigration(env.dir);
    const after = fs.readFileSync(path.join(env.dir, 'fixture-board', 'CLAUDE.md'), 'utf8');
    expect(after).not.toContain('{{GROUP_NAME}}');
    expect(after).toContain('(de TEST-FIXTURE - TaskFlow)');
  });

  it('skips files where the title does not match the expected pattern', () => {
    // No "# X — TaskFlow (Y)" first line — can't derive GROUP_NAME
    writeBoard(
      env.dir,
      'malformed',
      `Some custom header line\n${ANCHOR}\n\nbody with taskflow_update marker.\n`,
    );
    const result = runMigration(env.dir);
    expect(result.code).toBe(0);
    const after = fs.readFileSync(path.join(env.dir, 'malformed', 'CLAUDE.md'), 'utf8');
    // Rule should NOT be inserted because GROUP_NAME could not be derived
    expect(after).not.toContain('Cross-board add_subtask forward');
    expect(result.stderr + result.stdout).toMatch(/skip|warn/i);
  });

  it('idempotent: second run does not re-insert', () => {
    writeBoard(env.dir, 'fixture-board', TEMPLATE_PRE_RULE);
    runMigration(env.dir);
    const r2 = runMigration(env.dir);
    expect(r2.stdout).toMatch(/Updated 0/);
    const after = fs.readFileSync(path.join(env.dir, 'fixture-board', 'CLAUDE.md'), 'utf8');
    // Marker appears exactly once
    expect((after.match(/Cross-board add_subtask forward/g) ?? []).length).toBe(1);
  });

  it('skips non-TaskFlow files (no taskflow_update marker)', () => {
    writeBoard(
      env.dir,
      'non-taskflow',
      `# Some Other Group\n${ANCHOR}\n\nNo taskflow stuff here.\n`,
    );
    runMigration(env.dir);
    const after = fs.readFileSync(path.join(env.dir, 'non-taskflow', 'CLAUDE.md'), 'utf8');
    expect(after).not.toContain('Cross-board add_subtask forward');
  });

  it('rule addresses preemptive cross-board recognition without bypassing the engine', () => {
    // Bug 2026-04-27: bot recognized P11 belonged to parent (SECI) board
    // upfront from the [seci] prefix in its task list and refused with
    // "pertence ao quadro X, faça por lá" instead of forwarding. The rule
    // must acknowledge that recognition path explicitly — and tell the
    // agent to STILL call the tool first, never refuse preemptively.
    writeBoard(env.dir, 'fixture-board', TEMPLATE_PRE_RULE);
    runMigration(env.dir);
    const after = fs.readFileSync(
      path.join(env.dir, 'fixture-board', 'CLAUDE.md'),
      'utf8',
    );
    // The rule must reference the recognition path AND ban preemptive refusal.
    expect(after).toMatch(/recogni[sz]e|reconhece/i);
    expect(after).toContain('[seci]');
    // The `**Never**` markdown emphasis can sit between the words, so allow
    // any non-greedy run of chars between "never" and "preemptively".
    expect(after).toMatch(/never\b[^\n]{0,40}refuse[^\n]{0,40}preemptively/i);
  });

  it('rule forbids the refusal phrases observed in the 2026-04-27 bug', () => {
    writeBoard(env.dir, 'fixture-board', TEMPLATE_PRE_RULE);
    runMigration(env.dir);
    const after = fs.readFileSync(
      path.join(env.dir, 'fixture-board', 'CLAUDE.md'),
      'utf8',
    );
    // The rule must explicitly forbid the bot's actual refusal phrasing so
    // a future agent can recognize the anti-pattern. These three Portuguese
    // fragments are the literal wording from msg 3EB04ABD3417EAA72CA13F.
    expect(after).toContain('pertence ao quadro');
    expect(after).toContain('faça por lá');
    expect(after).toContain('precisará fazer pelo quadro');
  });

  it('rule preserves engine-first ordering (does not short-circuit cross_board_subtask_mode)', () => {
    // Codex flagged this risk: a "preemptive forward" trigger that bypasses
    // the engine call would skip the engine's blocked/approval branches for
    // delegated tasks (cross_board_subtask_mode). The rule must instead say
    // "always try the tool first, even when you recognize cross-board context."
    writeBoard(env.dir, 'fixture-board', TEMPLATE_PRE_RULE);
    runMigration(env.dir);
    const after = fs.readFileSync(
      path.join(env.dir, 'fixture-board', 'CLAUDE.md'),
      'utf8',
    );
    // Must instruct "try the tool first" / "always try" before any forward.
    expect(after).toMatch(/try the tool first|always try/i);
    // Must reference taskflow_update as the tool to call first, not
    // recommend a manual forward upfront.
    expect(after).toContain('taskflow_update');
  });

  it('rule SQL uses real boards columns (no b_parent.name)', () => {
    // Codex caught this pre-existing bug: boards has no `name` column —
    // schema is (id, group_jid, group_folder, board_role, hierarchy_level,
    // max_depth, parent_board_id, short_code, owner_person_id). The
    // verification SQL must use group_folder/short_code, not name.
    writeBoard(env.dir, 'fixture-board', TEMPLATE_PRE_RULE);
    runMigration(env.dir);
    const after = fs.readFileSync(
      path.join(env.dir, 'fixture-board', 'CLAUDE.md'),
      'utf8',
    );
    expect(after).not.toMatch(/b_parent\.name/);
    // Real human-readable column substitutes:
    expect(after).toMatch(/group_folder|short_code/);
    // Filter to project type to avoid colliding with regular tasks.
    expect(after).toContain("t.type = 'project'");
  });
});
