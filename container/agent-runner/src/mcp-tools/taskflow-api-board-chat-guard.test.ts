import { afterEach, describe, expect, it } from 'bun:test';

import { apiDeleteBoardTool, apiAddBoardPersonTool, fastApiOnly } from './taskflow-api-board.js';
import { setVerbatimIds } from './taskflow-helpers.js';

// SECURITY regression (audit + Codex BLOCKER): the api_*_board tools read board_id verbatim (no
// normalizeAgentIds) and rely on FastAPI-side owner auth. They must be unreachable from chat — a
// chat call could create/delete/mutate ANY board on the single global taskflow.db. The fix is
// two-layered: not imported into the chat barrel (index.ts), and fail-closed on !getVerbatimIds().
describe('api_*_board tools are FastAPI-only (cross-board escape closed)', () => {
  afterEach(() => setVerbatimIds(false));

  it('REFUSES api_delete_board from chat (non-verbatim) with not_available and runs no engine call', async () => {
    setVerbatimIds(false); // chat path
    const guarded = fastApiOnly(apiDeleteBoardTool);
    // A real engine call would need a DB; the guard must short-circuit BEFORE touching the engine,
    // so this resolves without a DB open. Target a foreign board id to model the escape attempt.
    const r = JSON.parse((await guarded.handler({ board_id: 'board-someone-elses' })).content[0].text);
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_available');
  });

  it('REFUSES api_add_board_person from chat (non-verbatim)', async () => {
    setVerbatimIds(false);
    const guarded = fastApiOnly(apiAddBoardPersonTool);
    const r = JSON.parse((await guarded.handler({ board_id: 'board-b', person_name: 'x' })).content[0].text);
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('not_available');
  });

  it('the chat barrel (index.ts) does NOT import taskflow-api-board', async () => {
    // Static guard against re-introduction: the cross-board tools must never re-enter the chat
    // surface. (The FastAPI entry registers them; the chat barrel must not.)
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).not.toContain("import './taskflow-api-board.js'");
  });
});
