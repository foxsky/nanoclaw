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

/** Boot a fresh DB + return the helpers each test needs. */
async function setupTestDb() {
  const [{ initDb }, { runMigrations }, agentGroupsMod, containerConfigsMod, backfillMod, mcpJsonMod] =
    await Promise.all([
      import('./db/connection.js'),
      import('./db/migrations/index.js'),
      import('./db/agent-groups.js'),
      import('./db/container-configs.js'),
      import('./backfill-container-configs.js'),
      // The .mcp.json carry-forward moved to the TaskFlow overlay step (ADR
      // 0006 #10). The host drains it via runBackfillSteps() right after
      // backfillContainerConfigs(); these tests invoke the same two steps.
      import('./modules/taskflow/backfill-mcp-json.js'),
    ]);
  const db = initDb(path.join(TEST_DATA_DIR, 'v2.db'));
  runMigrations(db);
  // Mirror the host startup order: core backfill, then the overlay .mcp.json
  // carry-forward step.
  const backfillContainerConfigs = () => {
    backfillMod.backfillContainerConfigs();
    mcpJsonMod.backfillMcpJsonServers();
  };
  return {
    createAgentGroup: agentGroupsMod.createAgentGroup,
    getContainerConfig: containerConfigsMod.getContainerConfig,
    createContainerConfig: containerConfigsMod.createContainerConfig,
    backfillContainerConfigs,
  };
}

function mkGroupDir(folder: string): string {
  const d = path.join(TEST_GROUPS_DIR, folder);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeAgentGroup(id: string, folder: string) {
  return { id, name: id, folder, agent_provider: null, created_at: new Date().toISOString() };
}

function makeEmptyContainerConfig(id: string, mcpServers: Record<string, unknown> = {}) {
  return {
    agent_group_id: id,
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: JSON.stringify('all'),
    mcp_servers: JSON.stringify(mcpServers),
    packages_apt: JSON.stringify([]),
    packages_npm: JSON.stringify([]),
    additional_mounts: JSON.stringify([]),
    cli_scope: 'group' as const,
    updated_at: new Date().toISOString(),
  };
}

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
    const { createAgentGroup, getContainerConfig, backfillContainerConfigs } = await setupTestDb();
    createAgentGroup(makeAgentGroup('ag-seci', 'seci-taskflow'));
    fs.writeFileSync(
      path.join(mkGroupDir('seci-taskflow'), '.mcp.json'),
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

    backfillContainerConfigs();

    const cfg = getContainerConfig('ag-seci');
    expect(cfg).toBeDefined();
    const mcp = JSON.parse(cfg!.mcp_servers as unknown as string) as Record<string, any>;
    expect(mcp.sqlite).toBeDefined();
    expect(mcp.sqlite.command).toBe('npx');
  });

  it('container.json mcpServers wins over .mcp.json on shared keys', async () => {
    const { createAgentGroup, getContainerConfig, backfillContainerConfigs } = await setupTestDb();
    createAgentGroup(makeAgentGroup('ag-mixed', 'mixed'));
    const d = mkGroupDir('mixed');
    fs.writeFileSync(
      path.join(d, 'container.json'),
      JSON.stringify({ mcpServers: { sqlite: { type: 'stdio', command: 'modern' } } }),
    );
    fs.writeFileSync(
      path.join(d, '.mcp.json'),
      JSON.stringify({ mcpServers: { sqlite: { type: 'stdio', command: 'legacy' } } }),
    );

    backfillContainerConfigs();

    const cfg = getContainerConfig('ag-mixed');
    const mcp = JSON.parse(cfg!.mcp_servers as unknown as string) as Record<string, any>;
    expect(mcp.sqlite.command).toBe('modern');
  });

  it('retrofills existing rows with empty mcp_servers from .mcp.json (Codex BLOCKER fix)', async () => {
    const { createAgentGroup, getContainerConfig, createContainerConfig, backfillContainerConfigs } =
      await setupTestDb();
    createAgentGroup(makeAgentGroup('ag-empty', 'empty-mcp'));
    fs.writeFileSync(
      path.join(mkGroupDir('empty-mcp'), '.mcp.json'),
      JSON.stringify({ mcpServers: { sqlite: { type: 'stdio', command: 'npx' } } }),
    );
    createContainerConfig(makeEmptyContainerConfig('ag-empty'));

    backfillContainerConfigs();

    const cfg = getContainerConfig('ag-empty');
    const mcp = JSON.parse(cfg!.mcp_servers as unknown as string) as Record<string, any>;
    expect(mcp.sqlite).toBeDefined();
    expect(mcp.sqlite.command).toBe('npx');
  });

  it('retrofill does NOT overwrite operator-set keys (absent-keys-only merge)', async () => {
    const { createAgentGroup, getContainerConfig, createContainerConfig, backfillContainerConfigs } =
      await setupTestDb();
    createAgentGroup(makeAgentGroup('ag-op', 'operator-set'));
    fs.writeFileSync(
      path.join(mkGroupDir('operator-set'), '.mcp.json'),
      JSON.stringify({
        mcpServers: { sqlite: { type: 'stdio', command: 'OLD' }, redis: { type: 'stdio', command: 'redis' } },
      }),
    );
    createContainerConfig(makeEmptyContainerConfig('ag-op', { sqlite: { type: 'stdio', command: 'NEW' } }));

    backfillContainerConfigs();

    const cfg = getContainerConfig('ag-op');
    const mcp = JSON.parse(cfg!.mcp_servers as unknown as string) as Record<string, any>;
    expect(mcp.sqlite.command).toBe('NEW');
    expect(mcp.redis).toBeDefined();
    expect(mcp.redis.command).toBe('redis');
  });

  it('handles malformed .mcp.json gracefully', async () => {
    const { createAgentGroup, getContainerConfig, backfillContainerConfigs } = await setupTestDb();
    createAgentGroup(makeAgentGroup('ag-bad', 'bad-json'));
    fs.writeFileSync(path.join(mkGroupDir('bad-json'), '.mcp.json'), '{ this is not valid JSON');

    expect(() => backfillContainerConfigs()).not.toThrow();

    const cfg = getContainerConfig('ag-bad');
    expect(cfg).toBeDefined();
    expect(cfg!.mcp_servers).toBe('{}');
  });

  it('rejects non-object mcpServers shape (e.g., string)', async () => {
    const { createAgentGroup, getContainerConfig, backfillContainerConfigs } = await setupTestDb();
    createAgentGroup(makeAgentGroup('ag-bad-shape', 'bad-shape'));
    fs.writeFileSync(path.join(mkGroupDir('bad-shape'), '.mcp.json'), JSON.stringify({ mcpServers: 'sqlite' }));

    backfillContainerConfigs();

    const cfg = getContainerConfig('ag-bad-shape');
    expect(cfg!.mcp_servers).toBe('{}');
  });

  it('skips groups with existing row and no .mcp.json', async () => {
    const { createAgentGroup, getContainerConfig, createContainerConfig, backfillContainerConfigs } =
      await setupTestDb();
    createAgentGroup(makeAgentGroup('ag-pre', 'pre-existing'));
    mkGroupDir('pre-existing'); // no .mcp.json
    createContainerConfig(makeEmptyContainerConfig('ag-pre', { existing: { type: 'stdio' } }));

    backfillContainerConfigs();

    const cfg = getContainerConfig('ag-pre');
    const mcp = JSON.parse(cfg!.mcp_servers as unknown as string) as Record<string, unknown>;
    expect(mcp.existing).toBeDefined();
  });
});

// F3 (model) + F4 (assistant_name): the migrate groups.ts step writes these into
// container.json; the backfill imports them into container_configs. Without F3,
// model was hardcoded null and a migrated board lost its v1 model override.
describe('backfillContainerConfigs — model + assistant_name from container.json (F3/F4)', () => {
  it('imports model AND assistantName from container.json into the row', async () => {
    const { createAgentGroup, getContainerConfig, backfillContainerConfigs } = await setupTestDb();
    createAgentGroup(makeAgentGroup('ag-case', 'case-board'));
    fs.writeFileSync(
      path.join(mkGroupDir('case-board'), 'container.json'),
      JSON.stringify({ model: 'claude-sonnet-4-6', assistantName: 'Case' }),
    );

    backfillContainerConfigs();

    const cfg = getContainerConfig('ag-case');
    expect(cfg!.model).toBe('claude-sonnet-4-6');
    expect(cfg!.assistant_name).toBe('Case');
  });

  it('leaves model null when container.json has none (board inherits SDK default)', async () => {
    const { createAgentGroup, getContainerConfig, backfillContainerConfigs } = await setupTestDb();
    createAgentGroup(makeAgentGroup('ag-default', 'default-board'));
    fs.writeFileSync(
      path.join(mkGroupDir('default-board'), 'container.json'),
      JSON.stringify({ assistantName: 'Tars' }),
    );

    backfillContainerConfigs();

    const cfg = getContainerConfig('ag-default');
    expect(cfg!.model).toBeNull();
    expect(cfg!.assistant_name).toBe('Tars');
  });

  it('does NOT clobber an operator-set model/assistant_name on an existing row', async () => {
    const { createAgentGroup, getContainerConfig, createContainerConfig, backfillContainerConfigs } =
      await setupTestDb();
    createAgentGroup(makeAgentGroup('ag-keep', 'keep-board'));
    fs.writeFileSync(
      path.join(mkGroupDir('keep-board'), 'container.json'),
      JSON.stringify({ model: 'claude-sonnet-4-6', assistantName: 'Case' }),
    );
    // Row already exists with operator values — backfill must not overwrite it.
    createContainerConfig({
      ...makeEmptyContainerConfig('ag-keep'),
      model: 'claude-opus-4-8',
      assistant_name: 'Operator',
    });

    backfillContainerConfigs();

    const cfg = getContainerConfig('ag-keep');
    expect(cfg!.model).toBe('claude-opus-4-8');
    expect(cfg!.assistant_name).toBe('Operator');
  });
});
