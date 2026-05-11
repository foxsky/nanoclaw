import { describe, expect, it } from 'vitest';
import { migrateBoardClaudeMd } from './migrate-board-claudemd.js';

describe('migrateBoardClaudeMd — A5 Phase 1 direct substitution', () => {
  it('substitutes taskflow_move( → api_move({ board_id: BOARD_ID,', () => {
    const input = `Call \`taskflow_move({ task_id: 'TXXX', action: 'start', sender_name: SENDER })\``;
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_move({ board_id: BOARD_ID, task_id:');
    expect(result.output).not.toMatch(/taskflow_move\(/);
    expect(result.substituted).toBeGreaterThan(0);
  });

  it('substitutes all 5 direct-substitute tools with board_id injection', () => {
    const input = [
      "`taskflow_move({ task_id: 'T1', action: 'start', sender_name: 'alice' })`",
      "`taskflow_admin({ action: 'register_person', sender_name: 'alice' })`",
      "`taskflow_reassign({ task_id: 'T1', target_person: 'bob', sender_name: 'alice', confirmed: true })`",
      "`taskflow_undo({ sender_name: 'alice' })`",
      "`taskflow_report({ type: 'standup' })`",
    ].join('\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_move({ board_id: BOARD_ID,');
    expect(result.output).toContain('api_admin({ board_id: BOARD_ID,');
    expect(result.output).toContain('api_reassign({ board_id: BOARD_ID,');
    expect(result.output).toContain('api_undo({ board_id: BOARD_ID,');
    expect(result.output).toContain('api_report({ board_id: BOARD_ID,');
    expect(result.substituted).toBe(5);
  });

  it('substitutes bare references (no paren) to v2 names', () => {
    const input = 'When you call taskflow_move, the engine validates.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe('When you call api_move, the engine validates.');
  });

  it('all v1 taskflow_* tools now have a v2 substitute (Phase 2 complete)', () => {
    const result = migrateBoardClaudeMd('');
    // unmigrated dict has no keys — every former v1 tool routes somewhere
    expect(Object.keys(result.unmigrated)).toEqual([]);
  });

  it('taskflow_hierarchy → api_hierarchy with action body preserved', () => {
    const input =
      "`taskflow_hierarchy({ task_id: 'P1', action: 'link', person_name: 'bob', sender_name: SENDER })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_hierarchy({ board_id: BOARD_ID, task_id: 'P1',");
    expect(result.output).toContain("action: 'link'");
  });

  it('taskflow_dependency → api_dependency with action body preserved', () => {
    const input =
      "`taskflow_dependency({ task_id: 'T1', action: 'add_dep', target_task_id: 'T2', sender_name: SENDER })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_dependency({ board_id: BOARD_ID, task_id: 'T1',");
    expect(result.output).toContain("action: 'add_dep'");
  });

  it('bare taskflow_hierarchy / taskflow_dependency mentions → api_*', () => {
    const input = 'Use taskflow_hierarchy or taskflow_dependency for these flows.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe('Use api_hierarchy or api_dependency for these flows.');
  });

  it('taskflow_query → api_query with discriminator body preserved', () => {
    const input = "`taskflow_query({ query: 'task_details', task_id: 'T1' })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain(
      "api_query({ board_id: BOARD_ID, query: 'task_details', task_id: 'T1' })",
    );
    expect(result.output).not.toMatch(/taskflow_query/);
  });

  it('taskflow_query with person_name → api_query body preserved', () => {
    const input = "taskflow_query({ query: 'person_tasks', person_name: 'alice' })";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_query({ board_id: BOARD_ID, query: 'person_tasks',");
    expect(result.output).toContain("person_name: 'alice'");
  });

  it('bare taskflow_query mention → api_query', () => {
    const input = 'Use taskflow_query for reads.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe('Use api_query for reads.');
  });

  it('taskflow_update → api_update_task with composite updates body preserved', () => {
    const input = "`taskflow_update({ task_id: 'T1', updates: { add_note: 'X' }, sender_name: SENDER })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain(
      "api_update_task({ board_id: BOARD_ID, task_id: 'T1', updates: { add_note: 'X' }, sender_name: SENDER })",
    );
    expect(result.output).not.toMatch(/taskflow_update/);
  });

  it('taskflow_update with multi-field updates body → preserved verbatim', () => {
    const input = "taskflow_update({ task_id: 'T14', updates: { due_date: '2026-04-30' }, sender_name: SENDER })";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_update_task({ board_id: BOARD_ID, task_id: 'T14',");
    expect(result.output).toContain("updates: { due_date: '2026-04-30' }");
  });

  it('bare taskflow_update mention → api_update_task', () => {
    const input = 'Use taskflow_update to add a note.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe('Use api_update_task to add a note.');
  });

  it('taskflow_create with type:simple → api_create_task with type preserved', () => {
    const input = "`taskflow_create({ type: 'simple', title: 'X', sender_name: 'alice' })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_create_task({ board_id: BOARD_ID, type: 'simple',");
    expect(result.output).not.toMatch(/taskflow_create/);
  });

  it('taskflow_create with type:meeting → api_create_meeting_task (type dropped)', () => {
    const input =
      "`taskflow_create({ type: 'meeting', title: 'SEMA', scheduled_at: '2026-06-15T14:00:00Z', sender_name: 'alice' })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_create_meeting_task({ board_id: BOARD_ID,');
    expect(result.output).not.toContain("type: 'meeting'");
    expect(result.output).not.toMatch(/taskflow_create/);
  });

  it('taskflow_create with type:project preserved → api_create_task with type:project', () => {
    const input =
      "`taskflow_create({ type: 'project', title: 'Big', subtasks: ['A', 'B'], sender_name: 'alice' })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_create_task({ board_id: BOARD_ID, type: 'project',");
  });

  it('taskflow_create without inline type literal falls back to api_create_task', () => {
    const input = '`taskflow_create({title: VAR, type: VAR2, sender_name: SENDER})`';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_create_task({ board_id: BOARD_ID,');
  });

  it('bare `taskflow_create` mention (no paren) → api_create_task', () => {
    const input = 'Use taskflow_create to register new tasks.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe('Use api_create_task to register new tasks.');
  });

  it('taskflow_create with type NOT first field still routes by type (Codex BLOCKER fix)', () => {
    const input =
      "`taskflow_create({ title: 'SEMA', type: 'meeting', scheduled_at: '2026-06-15T14:00:00Z', sender_name: 'alice' })`";
    const result = migrateBoardClaudeMd(input);
    // type is the second field; routing must still detect 'meeting'
    expect(result.output).toContain('api_create_meeting_task({ board_id: BOARD_ID,');
    expect(result.output).not.toMatch(/taskflow_create/);
  });

  it('taskflow_create with double-quoted type → routes by type (Codex BLOCKER fix)', () => {
    const input = `taskflow_create({ type: "meeting", title: "X", sender_name: "alice" })`;
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_create_meeting_task({ board_id: BOARD_ID,');
  });

  it('taskflow_create with type buried after multiple fields → still routes correctly', () => {
    const input =
      "`taskflow_create({ title: 'X', assignee: 'bob', priority: 'high', type: 'project', sender_name: 'alice' })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_create_task({ board_id: BOARD_ID,');
    // Body preserves the type literal so engine still routes by it
    expect(result.output).toContain("type: 'project'");
  });

  it('empty body `taskflow_create({})` → no trailing comma in output', () => {
    const input = 'taskflow_create({})';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe('api_create_task({ board_id: BOARD_ID })');
    expect(result.output).not.toMatch(/,\s*\}/);
  });

  it('taskflow_create with type:meeting as LAST field → no trailing comma after strip', () => {
    const input = "taskflow_create({ title: 'X', type: 'meeting' })";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe("api_create_meeting_task({ board_id: BOARD_ID, title: 'X' })");
    expect(result.output).not.toMatch(/,\s*\}/);
  });

  it('reports counts: substituted (formerly also unmigrated; Phase 2 complete leaves unmigrated empty)', () => {
    const input = [
      "`taskflow_move({ task_id: 'T1', action: 'start', sender_name: 'alice' })`",
      "`taskflow_move({ task_id: 'T2', action: 'wait', sender_name: 'alice' })`",
      "`taskflow_hierarchy({ task_id: 'P1', action: 'unlink', sender_name: 'alice' })`",
    ].join('\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.substituted).toBe(3);
    // After Phase 2, every v1 tool routes somewhere; no unmigrated keys.
    expect(Object.keys(result.unmigrated)).toEqual([]);
  });

  it('idempotent: running twice on the same input produces the same output', () => {
    const input = "`taskflow_move({ task_id: 'T1', action: 'start', sender_name: 'alice' })`";
    const r1 = migrateBoardClaudeMd(input);
    const r2 = migrateBoardClaudeMd(r1.output);
    expect(r2.output).toBe(r1.output);
    expect(r2.substituted).toBe(0); // nothing left to substitute on 2nd pass
  });

  it('preserves spacing — single space after { with no double-comma', () => {
    const input = "taskflow_move({ task_id: 'T1' })";
    const result = migrateBoardClaudeMd(input);
    // No "{,", no "{ ,", no double-comma. Output must be syntactically valid.
    expect(result.output).not.toMatch(/\{\s*,/);
    expect(result.output).not.toMatch(/,\s*,/);
  });

  it('handles zero whitespace after { — `taskflow_move({task_id:...})`', () => {
    const input = "taskflow_move({task_id:'T1',action:'start'})";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe("api_move({ board_id: BOARD_ID, task_id:'T1',action:'start'})");
    expect(result.substituted).toBe(1);
  });

  it('handles a real-world block from v1 CLAUDE.md', () => {
    const input =
      "| \"comecando TXXX\" / \"iniciando TXXX\" | `taskflow_move({ task_id: 'TXXX', action: 'start', sender_name: SENDER })` |";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe(
      "| \"comecando TXXX\" / \"iniciando TXXX\" | `api_move({ board_id: BOARD_ID, task_id: 'TXXX', action: 'start', sender_name: SENDER })` |",
    );
  });
});
