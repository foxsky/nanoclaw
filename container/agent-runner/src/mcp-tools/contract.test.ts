import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import { buildMcpContract } from './contract.ts';

// L0 guardrail for the L4 engine↔dashboard MCP contract (the tf-mcontrol seam).
//
// The committed `contract.json` is what the dashboard CI diffs against without
// booting bun. This test asserts that committed artifact still equals what the
// live registry produces — so it can NEVER go stale: change any allowlisted
// tool's inputSchema (the G5 silent-drop class) and this fails until you
// regenerate + commit:
//   bun src/mcp-tools/taskflow-server-entry.ts --dump-contract > src/mcp-tools/contract.json
//
// See `2026-06-15-INBOUND-from-tf-mcontrol-second-brain-playbook.md` + the
// engine-coordination request.
describe('MCP contract artifact (L4 tf-mcontrol seam)', () => {
  const committed = JSON.parse(readFileSync(join(import.meta.dir, 'contract.json'), 'utf8'));
  const built = buildMcpContract();

  it('committed contract.json is in sync with the live registry (regenerate via --dump-contract on drift)', () => {
    expect(built).toEqual(committed);
  });

  it('exposes exactly the 37-tool FastAPI surface tf-mcontrol baselined', () => {
    expect(built.tools).toHaveLength(37);
    expect(built.serverInfo).toEqual({ name: 'nanoclaw', version: '2.0.0' });
    expect(built.protocolVersion).toBe('2024-11-05');
    // send_otp added 2026-06-16 (Option A web-login OTP) — deliberately exposed.
    expect(built.tools.some((t) => t.name === 'send_otp')).toBe(true);
  });

  it('tools are sorted by name (stable diffs)', () => {
    const names = built.tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  it('NEVER exposes agent-only / escape tools to the FastAPI surface (security boundary)', () => {
    const names = new Set(built.tools.map((t) => t.name));
    // These are registered (api_admin/api_report/api_dependency) or registrable
    // but MUST stay off the dashboard surface — a leak would let the API drive
    // admin/hierarchy ops or impersonate the agent. If anyone adds one to
    // FASTAPI_ALLOWLIST, this fails.
    for (const forbidden of [
      'api_admin',
      'api_report',
      'api_dependency',
      'send_message',
      'send_file',
      'install_packages',
      'add_mcp_server',
      'create_agent',
    ]) {
      expect(names.has(forbidden), `${forbidden} must NEVER be in the FastAPI contract`).toBe(false);
    }
  });

  it('pins the silent-drop-critical fields (the G5 bug class)', () => {
    const byName = Object.fromEntries(built.tools.map((t) => [t.name, t]));
    const props = (name: string) =>
      Object.keys((byName[name]?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {});
    // api_create_task silently dropped parent_task_id pre-R4 — the exact G5 bug.
    expect(props('api_create_task')).toContain('parent_task_id');
    expect(props('api_create_task')).toContain('sender_is_service');
    // the serialized read tools tf-mcontrol depends on must keep their arg shapes.
    expect(byName.api_board_tasks).toBeDefined();
    expect(byName.api_runner_status_batch).toBeDefined();
  });
});
