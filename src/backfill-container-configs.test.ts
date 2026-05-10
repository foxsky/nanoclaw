import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMPROOT = path.join(os.tmpdir(), `backfill-mcp-test-${process.pid}-${Date.now()}`);
const TEST_DATA_DIR = path.join(TMPROOT, 'data');
const TEST_GROUPS_DIR = path.join(TMPROOT, 'groups');

vi.mock('./config.js', async (orig) => {
  const real = await orig<typeof import('./config.js')>();
  return { ...real, GROUPS_DIR: TEST_GROUPS_DIR, DATA_DIR: TEST_DATA_DIR };
});

beforeEach(() => {
  fs.rmSync(TMPROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMPROOT, { recursive: true, force: true });
});

describe('backfillContainerConfigs — .mcp.json carry-forward (A6 fix)', () => {
  it('reads .mcp.json sqlite server when container.json is absent', async () => {
    const { initDb } = await import('./db/connection.js');
    const { runMigrations } = await import('./db/migrations/index.js');
    const { createAgentGroup } = await import('./db/agent-groups.js');
    const { getContainerConfig } = await import('./db/container-configs.js');

    const db = initDb(path.join(TEST_DATA_DIR, 'v2.db'));
    runMigrations(db);

    const id = 'ag-seci';
    createAgentGroup({ id, name: 'SECI', folder: 'seci-taskflow', agent_provider: null, created_at: new Date().toISOString() });
    const groupDir = path.join(TEST_GROUPS_DIR, 'seci-taskflow');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          sqlite: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'mcp-server-sqlite-npx', '/workspace/taskflow/taskflow.db'],
          },
        },
      }),
    );

    const { backfillContainerConfigs } = await import('./backfill-container-configs.js');
    backfillContainerConfigs();

    const cfg = getContainerConfig(id);
    expect(cfg).toBeDefined();
    const mcp = JSON.parse(cfg!.mcp_servers as unknown as string) as Record<string, any>;
    expect(mcp.sqlite).toBeDefined();
    expect(mcp.sqlite.command).toBe('npx');
  });

  it('container.json mcpServers wins over .mcp.json on shared keys', async () => {
    const { initDb } = await import('./db/connection.js');
    const { runMigrations } = await import('./db/migrations/index.js');
    const { createAgentGroup } = await import('./db/agent-groups.js');
    const { getContainerConfig } = await import('./db/container-configs.js');

    const db = initDb(path.join(TEST_DATA_DIR, 'v2.db'));
    runMigrations(db);

    const id = 'ag-mixed';
    createAgentGroup({ id, name: 'Mixed', folder: 'mixed', agent_provider: null, created_at: new Date().toISOString() });
    const groupDir = path.join(TEST_GROUPS_DIR, 'mixed');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'container.json'),
      JSON.stringify({ mcpServers: { sqlite: { type: 'stdio', command: 'modern' } } }),
    );
    fs.writeFileSync(
      path.join(groupDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { sqlite: { type: 'stdio', command: 'legacy' } } }),
    );

    const { backfillContainerConfigs } = await import('./backfill-container-configs.js');
    backfillContainerConfigs();

    const cfg = getContainerConfig(id);
    const mcp = JSON.parse(cfg!.mcp_servers as unknown as string) as Record<string, any>;
    expect(mcp.sqlite.command).toBe('modern');
  });

  it('skips groups that already have a container_config row', async () => {
    const { initDb } = await import('./db/connection.js');
    const { runMigrations } = await import('./db/migrations/index.js');
    const { createAgentGroup } = await import('./db/agent-groups.js');
    const { getContainerConfig, createContainerConfig } = await import('./db/container-configs.js');

    const db = initDb(path.join(TEST_DATA_DIR, 'v2.db'));
    runMigrations(db);

    const id = 'ag-pre';
    createAgentGroup({ id, name: 'P', folder: 'pre-existing', agent_provider: null, created_at: new Date().toISOString() });
    const groupDir = path.join(TEST_GROUPS_DIR, 'pre-existing');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, '.mcp.json'), JSON.stringify({ mcpServers: { sqlite: { type: 'stdio' } } }));

    createContainerConfig({
      agent_group_id: id,
      provider: null,
      model: null,
      effort: null,
      image_tag: null,
      assistant_name: null,
      max_messages_per_prompt: null,
      skills: JSON.stringify('all'),
      mcp_servers: JSON.stringify({ existing: { type: 'stdio' } }),
      packages_apt: JSON.stringify([]),
      packages_npm: JSON.stringify([]),
      additional_mounts: JSON.stringify([]),
      cli_scope: 'group',
      updated_at: new Date().toISOString(),
    });

    const { backfillContainerConfigs } = await import('./backfill-container-configs.js');
    backfillContainerConfigs();

    const cfg = getContainerConfig(id);
    const mcp = JSON.parse(cfg!.mcp_servers as unknown as string) as Record<string, unknown>;
    expect(mcp.existing).toBeDefined();
    expect(mcp.sqlite).toBeUndefined();
  });
});
