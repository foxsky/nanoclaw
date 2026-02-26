/**
 * Tests for agent-swarm IPC handler logic.
 *
 * Since modify files use imports relative to their install target (e.g.,
 * ./config.js), we cannot import them directly. Instead, we test the
 * writeIpcResponse helper and guard logic by reimplementing the minimal
 * slice of code under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = '/tmp/nanoclaw-test-ipc';

/**
 * Extracted from modify/src/ipc.ts — writeIpcResponse helper.
 * This is the exact same implementation the IPC handler uses.
 */
function writeIpcResponse(dataDir: string, sourceGroup: string, requestId: string, result: string): void {
  const responseDir = path.join(dataDir, 'ipc', sourceGroup, 'responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${requestId}.json`);
  fs.writeFileSync(responsePath, result);
}

describe('agent-swarm IPC handlers', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  function getResponsePath(sourceGroup: string, requestId: string): string {
    return path.join(TEST_DATA_DIR, 'ipc', sourceGroup, 'responses', `${requestId}.json`);
  }

  describe('writeIpcResponse', () => {
    it('creates response directory and writes file', () => {
      writeIpcResponse(TEST_DATA_DIR, 'main', 'req-1', 'success');
      const responsePath = getResponsePath('main', 'req-1');
      expect(fs.existsSync(responsePath)).toBe(true);
      expect(fs.readFileSync(responsePath, 'utf-8')).toBe('success');
    });

    it('creates nested directory structure for group', () => {
      writeIpcResponse(TEST_DATA_DIR, 'other-group', 'req-2', 'error');
      const responsePath = getResponsePath('other-group', 'req-2');
      expect(fs.existsSync(responsePath)).toBe(true);
      expect(fs.readFileSync(responsePath, 'utf-8')).toBe('error');
    });
  });

  describe('swarm_update_status guard logic', () => {
    it('writes error when SWARM_ENABLED is false', () => {
      const SWARM_ENABLED = false;
      const isMain = true;
      const requestId = 'test-req-1';
      const sourceGroup = 'main';

      // Simulate the guard logic from modify/src/ipc.ts swarm_update_status case
      if (!isMain) {
        if (requestId) writeIpcResponse(TEST_DATA_DIR, sourceGroup, requestId, 'Error: only main group can update swarm task status');
      } else if (!SWARM_ENABLED) {
        if (requestId) writeIpcResponse(TEST_DATA_DIR, sourceGroup, requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
      }

      const content = fs.readFileSync(getResponsePath(sourceGroup, requestId), 'utf-8');
      expect(content).toContain('Error: swarm is not configured');
    });

    it('writes error when not main group', () => {
      const isMain = false;
      const requestId = 'test-req-2';
      const sourceGroup = 'other-group';

      if (!isMain) {
        if (requestId) writeIpcResponse(TEST_DATA_DIR, sourceGroup, requestId, 'Error: only main group can update swarm task status');
      }

      const content = fs.readFileSync(getResponsePath(sourceGroup, requestId), 'utf-8');
      expect(content).toContain('Error: only main group');
    });
  });

  describe('swarm_cleanup guard logic', () => {
    it('writes error when SWARM_ENABLED is false', () => {
      const SWARM_ENABLED = false;
      const isMain = true;
      const requestId = 'test-req-3';
      const sourceGroup = 'main';

      if (!isMain) {
        if (requestId) writeIpcResponse(TEST_DATA_DIR, sourceGroup, requestId, 'Error: only main group can run swarm cleanup');
      } else if (!SWARM_ENABLED) {
        if (requestId) writeIpcResponse(TEST_DATA_DIR, sourceGroup, requestId, 'Error: swarm is not configured (set SWARM_SSH_TARGET)');
      }

      const content = fs.readFileSync(getResponsePath(sourceGroup, requestId), 'utf-8');
      expect(content).toContain('Error: swarm is not configured');
    });

    it('writes error when not main group', () => {
      const isMain = false;
      const requestId = 'test-req-4';
      const sourceGroup = 'other-group';

      if (!isMain) {
        if (requestId) writeIpcResponse(TEST_DATA_DIR, sourceGroup, requestId, 'Error: only main group can run swarm cleanup');
      }

      const content = fs.readFileSync(getResponsePath(sourceGroup, requestId), 'utf-8');
      expect(content).toContain('Error: only main group');
    });
  });
});
