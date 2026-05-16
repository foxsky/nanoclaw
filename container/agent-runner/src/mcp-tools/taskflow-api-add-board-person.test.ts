import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeTaskflowDb } from '../db/connection.js';
import { applyBoardConfigColumns, setupEngineDb } from './taskflow-test-fixtures.js';
import { normalizePhone } from '../taskflow-engine.js';

/**
 * `api_add_board_person` engine-behavior contract (R2.8 step 4b-iii).
 * Repointed from pure-SQL to `engine.addBoardPerson` → shared
 * `_addBoardPersonCore`. DELIBERATE behavior changes (design Revision
 * 2.1):
 *   - R2.2: a delegating/hierarchy board is rejected with
 *     `hierarchy_provision_unsupported` (UI can't host-dispatch
 *     child-board auto-provision); WhatsApp keeps full provisioning.
 *   - phone is now CANONICALIZED via the same `normalizePhone` the
 *     WhatsApp `register_person` path applies (single-engine parity) —
 *     the stored AND echoed phone differ from the old raw store.
 *   - the handler still owns validation_error and derives person_id
 *     (phone-digits / uuid4); the engine does ZERO owner auth (R2.3).
 * tf-mcontrol re-baselines the golden AFTER wiring (R2.8 step 5).
 * Split to its own file because the engine-backed tool needs the full
 * `setupEngineDb` schema.
 */
const BOARD = 'board-b1';
let db: Database;

beforeEach(() => {
  db = setupEngineDb(BOARD, { withBoardAdmins: true });
  applyBoardConfigColumns(db); // prod board-config superset (NICE 1)
});

afterEach(() => {
  closeTaskflowDb();
});

async function add(args: Record<string, unknown>) {
  const { apiAddBoardPersonTool } = await import('./taskflow-api-board.ts');
  return JSON.parse((await apiAddBoardPersonTool.handler(args)).content[0].text);
}

describe('api_add_board_person MCP tool (engine-backed)', () => {
  it('exports a tool named api_add_board_person', async () => {
    const { apiAddBoardPersonTool } = await import('./taskflow-api-board.ts');
    expect(apiAddBoardPersonTool.tool.name).toBe('api_add_board_person');
  });

  it('person_id = phone digits; phone canonicalized (stored == echoed); row inserted', async () => {
    const input = '+55 (85) 99999-0001';
    const r = await add({ board_id: BOARD, name: 'Alice', phone: input, role: 'Tecnico' });
    expect(r.success).toBe(true);
    const expectedPhone = normalizePhone(input) || input;
    expect(r.data).toEqual({
      ok: true,
      person_id: '5585999990001', // handler-derived from raw digits
      name: 'Alice',
      phone: expectedPhone, // single-engine: canonicalized, not raw
      role: 'Tecnico',
    });
    const row = db
      .prepare('SELECT name, phone, role FROM board_people WHERE board_id = ? AND person_id = ?')
      .get(BOARD, '5585999990001') as { name: string; phone: string; role: string };
    expect(row).toEqual({ name: 'Alice', phone: expectedPhone, role: 'Tecnico' });
  });

  it('uuid person_id when no phone; stores + echoes phone null; role defaults member', async () => {
    const r = await add({ board_id: BOARD, name: 'Bob' });
    expect(r.success).toBe(true);
    expect(r.data.person_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(r.data.phone).toBeNull();
    expect(r.data.role).toBe('member');
    const row = db
      .prepare('SELECT phone FROM board_people WHERE board_id = ? AND person_id = ?')
      .get(BOARD, r.data.person_id) as { phone: string | null };
    expect(row.phone).toBeNull();
  });

  it('handler validation: missing/empty name and digit-less phone → validation_error', async () => {
    expect((await add({ board_id: BOARD })).error_code).toBe('validation_error');
    expect((await add({ board_id: BOARD, name: '   ' })).error_code).toBe('validation_error');
    const r = await add({ board_id: BOARD, name: 'X', phone: 'abc-def' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('validation_error');
  });

  it('duplicate person_id → conflict (core dup mapped to FastAPI shape)', async () => {
    await add({ board_id: BOARD, name: 'Alice', phone: '5585999990001' });
    const r = await add({ board_id: BOARD, name: 'Alice again', phone: '5585999990001' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('conflict');
    expect(r.error).toBe('Person already on this board');
  });

  it('role defaults to member when absent or empty', async () => {
    expect((await add({ board_id: BOARD, name: 'A', phone: '111' })).data.role).toBe('member');
    expect(
      (await add({ board_id: BOARD, name: 'B', phone: '222', role: '' })).data.role,
    ).toBe('member');
  });

  it('missing board → not_found', async () => {
    const r = await add({ board_id: 'board-nope', name: 'A', phone: '999' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_found');
    expect(r.error).toBe('Board not found');
  });

  it('R2.2: delegating board → hierarchy_provision_unsupported, NO row inserted', async () => {
    db.prepare(`UPDATE boards SET hierarchy_level = 0, max_depth = 2 WHERE id = ?`).run(BOARD);
    const r = await add({ board_id: BOARD, name: 'Eve', phone: '333' });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('hierarchy_provision_unsupported');
    expect(r.error).toBe(
      'Add this member via WhatsApp until UI child-board provisioning lands',
    );
    expect(
      db.prepare('SELECT 1 FROM board_people WHERE board_id = ? AND person_id = ?').get(BOARD, '333'),
    ).toBeNull();
  });
});

/**
 * R2.7 shipped-bug regression (moved here with the engine repoint):
 * the tool must pass the URL board_id to the engine VERBATIM — never
 * `normalizeAgentIds` (which `board-`-prefixes plain-UUID FastAPI
 * boards and would write to the wrong board).
 */
describe('api_add_board_person — plain-UUID board ids', () => {
  const UUID_BOARD = '550e8400-e29b-41d4-a716-446655440000';
  beforeEach(() => {
    db.prepare(`INSERT INTO boards (id, name) VALUES (?, 'UUID Board')`).run(UUID_BOARD);
  });

  it('operates on the exact UUID board id (no board- prefixing)', async () => {
    const r = await add({ board_id: UUID_BOARD, name: 'Z', phone: '111' });
    expect(r.success).toBe(true);
    expect(
      db.prepare('SELECT 1 FROM board_people WHERE board_id = ? AND person_id = ?').get(UUID_BOARD, '111'),
    ).not.toBeNull();
    expect(
      db.prepare("SELECT 1 FROM boards WHERE id = 'board-' || ?").get(UUID_BOARD),
    ).toBeNull();
  });
});
