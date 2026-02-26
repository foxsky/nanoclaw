import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

type ProcessTaskIpc = (typeof import('../modify/src/ipc.ts'))['processTaskIpc'];

const IPC_SOURCE = path.resolve(
  __dirname,
  '../modify/src/ipc.ts',
);

let fixtureDir: string;
let processTaskIpc: ProcessTaskIpc;

function writeStub(filename: string, content: string): void {
  fs.writeFileSync(path.join(fixtureDir, filename), content);
}

function responsePath(group: string, requestId: string): string {
  return path.join(fixtureDir, 'ipc', group, 'responses', `${requestId}.json`);
}

beforeEach(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-test-'));
  fs.copyFileSync(IPC_SOURCE, path.join(fixtureDir, 'ipc.ts'));

  writeStub(
    'config.js',
    `
export const DATA_DIR = ${JSON.stringify(fixtureDir)};
export const IPC_POLL_INTERVAL = 1000;
export const MAIN_GROUP_FOLDER = 'main';
export const TIMEZONE = 'UTC';
export const SWARM_SSH_TARGET = 'dev@remote';
export const SWARM_ENABLED = false;
export const SWARM_REPOS = {};
`,
  );

  writeStub('container-runner.js', 'export const AvailableGroup = {};');
  writeStub(
    'db.js',
    `
export function createTask() {}
export function deleteTask() {}
export function getTaskById() { return null; }
export function updateTask() {}
`,
  );
  writeStub('group-folder.js', 'export function isValidGroupFolder() { return true; }');
  writeStub(
    'logger.js',
    `
export const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
`,
  );
  writeStub(
    'agent-swarm.js',
    `
export async function spawnAgent() { throw new Error('not expected'); }
export async function checkAgents() { return []; }
export async function redirectAgent() { throw new Error('not expected'); }
export async function killAgent() { throw new Error('not expected'); }
export async function updateTaskStatus() { throw new Error('not expected'); }
export async function readAgentLog() { return ''; }
export async function runReview() { throw new Error('not expected'); }
export async function runCleanup() { throw new Error('not expected'); }
`,
  );

  const moduleUrl = `${pathToFileURL(path.join(fixtureDir, 'ipc.ts')).href}?t=${Date.now()}`;
  const imported = await import(moduleUrl);
  processTaskIpc = imported.processTaskIpc as ProcessTaskIpc;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function baseDeps() {
  return {
    sendMessage: vi.fn(),
    registeredGroups: () => ({}),
    registerGroup: vi.fn(),
    syncGroupMetadata: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
  };
}

describe('agent-swarm IPC handlers', () => {
  it('writes guard error for swarm_update_status when SWARM_ENABLED is false', async () => {
    await processTaskIpc(
      {
        type: 'swarm_update_status',
        requestId: 'req-1',
        taskId: 'task-1',
        status: 'ready_for_review',
      },
      'main',
      true,
      baseDeps(),
    );

    expect(fs.readFileSync(responsePath('main', 'req-1'), 'utf-8')).toContain(
      'Error: swarm is not configured',
    );
  });

  it('writes guard error for swarm_cleanup when caller is not main', async () => {
    await processTaskIpc(
      {
        type: 'swarm_cleanup',
        requestId: 'req-2',
      },
      'other-group',
      false,
      baseDeps(),
    );

    expect(
      fs.readFileSync(responsePath('other-group', 'req-2'), 'utf-8'),
    ).toContain('Error: only main group');
  });

  it('drops unsafe request IDs instead of writing outside responses directory', async () => {
    await processTaskIpc(
      {
        type: 'swarm_cleanup',
        requestId: '../escape',
      },
      'main',
      false,
      baseDeps(),
    );

    expect(fs.existsSync(responsePath('main', '../escape'))).toBe(false);
  });
});
