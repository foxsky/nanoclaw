import { describe, expect, it } from 'bun:test';

import './approved-executors.js'; // the production wiring — must register executors in THIS process
import { getApprovedExecutor } from './taskflow-approval.js';

// #407 regression (Codex BLOCKER): the MCP tool modules (core.ts, taskflow-api-mutate.ts) run in a
// SEPARATE subprocess (the SDK spawns `bun run mcp-tools/index.ts`), so their registerApprovedExecutor
// side effects do NOT reach the poll-loop's process where the approved-action replay runs. The MAIN
// runner imports approved-executors.ts to populate its own registry. This test loads ONLY that wiring
// module (not the tool modules directly) and asserts every gated tool has an executor — so a gated
// tool added without wiring its replay executor fails loudly here instead of silently no-op'ing an
// admin-approved action in production.
describe('approved-executors wiring (#407)', () => {
  it('registers an executor for every gated tool via the wiring module alone', () => {
    for (const tool of [
      'api_admin',
      'api_move',
      'api_reassign',
      'api_delete_simple_task',
      'send_message',
      'send_file',
      'provision_child_board', // SEC#11
      'create_group', // SEC#11
    ]) {
      expect(getApprovedExecutor(tool)).toBeDefined();
    }
  });
});
