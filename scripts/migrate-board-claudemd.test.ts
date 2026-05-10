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

  it('leaves taskflow_query, taskflow_create, taskflow_update, taskflow_hierarchy, taskflow_dependency UNTOUCHED', () => {
    const input = [
      "`taskflow_query({ query: 'task_details', task_id: 'T1' })`",
      "`taskflow_create({ type: 'simple', title: 'X', sender_name: 'alice' })`",
      "`taskflow_update({ task_id: 'T1', updates: { add_note: 'X' }, sender_name: 'alice' })`",
      "`taskflow_hierarchy({ task_id: 'P1' })`",
      "`taskflow_dependency({ task_id: 'T1' })`",
    ].join('\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe(input);
    expect(result.unmigrated.taskflow_query).toBe(1);
    expect(result.unmigrated.taskflow_create).toBe(1);
    expect(result.unmigrated.taskflow_update).toBe(1);
    expect(result.unmigrated.taskflow_hierarchy).toBe(1);
    expect(result.unmigrated.taskflow_dependency).toBe(1);
  });

  it('reports counts: substituted vs unmigrated', () => {
    const input = [
      "`taskflow_move({ task_id: 'T1', action: 'start', sender_name: 'alice' })`",
      "`taskflow_move({ task_id: 'T2', action: 'wait', sender_name: 'alice' })`",
      "`taskflow_query({ query: 'task_details', task_id: 'T1' })`",
    ].join('\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.substituted).toBe(2);
    expect(result.unmigrated.taskflow_query).toBe(1);
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
