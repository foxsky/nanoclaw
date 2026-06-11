import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runbook = readFileSync('docs/v2-cutover-runbook.md', 'utf8');

describe('v2 cutover runbook', () => {
  it('documents the tf-mcontrol source+bun subprocess cutover, not the retired dist rebuild path', () => {
    expect(runbook).toContain('TASKFLOW_MCP_RUNTIME=bun');
    expect(runbook).toContain('TASKFLOW_MCP_SERVER_BIN=');
    expect(runbook).toContain('container/agent-runner/src/mcp-tools/taskflow-server-entry.ts');
    expect(runbook).toContain('TASKFLOW_SERVICE_OUTBOUND_DB');

    expect(runbook).not.toMatch(/rebuilt `dist\/taskflow-mcp-server\.js`/);
    expect(runbook).not.toMatch(/rebuilt dist/i);
    expect(runbook).not.toContain('Rebuild from the agent-runner tree');
  });
});
