import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initTaskflowDb } from '../../taskflow-db.js';
import {
  createBoardFilesystem,
  generateClaudeMd,
  MCP_JSON_CONTENT,
  nextCronRun,
  ONBOARDING_FILES,
  sanitizeFolder,
  scheduleOnboarding,
  scheduleRunners,
  uniqueFolder,
} from './provision-shared.js';

const TMPROOT = path.join(os.tmpdir(), `nanoclaw-provision-shared-test-${process.pid}`);

describe('sanitizeFolder', () => {
  it('lowercases', () => {
    expect(sanitizeFolder('UX-SETD')).toBe('ux-setd');
  });

  it('strips diacritics via NFD + combining-mark range', () => {
    expect(sanitizeFolder('São Paulo')).toBe('sao-paulo');
    expect(sanitizeFolder('Caio Guimarães')).toBe('caio-guimaraes');
  });

  it('replaces non-alphanum with hyphens and collapses runs', () => {
    expect(sanitizeFolder('Hello, World!! 2026')).toBe('hello-world-2026');
  });

  it('strips leading and trailing hyphens', () => {
    expect(sanitizeFolder('---abc---')).toBe('abc');
  });

  it('handles empty input', () => {
    expect(sanitizeFolder('')).toBe('');
    expect(sanitizeFolder('!!!')).toBe('');
  });
});

describe('uniqueFolder', () => {
  it('returns base when no collision', () => {
    expect(uniqueFolder('foo', new Set())).toBe('foo');
  });

  it('appends -2 on first collision', () => {
    expect(uniqueFolder('foo', new Set(['foo']))).toBe('foo-2');
  });

  it('skips occupied suffixes', () => {
    expect(uniqueFolder('foo', new Set(['foo', 'foo-2', 'foo-3']))).toBe('foo-4');
  });
});

describe('generateClaudeMd', () => {
  it('replaces template tokens with their values', () => {
    const tmpl = '# {{ASSISTANT_NAME}}\n\nManager: {{MANAGER_NAME}} (ID {{MANAGER_ID}})';
    const out = generateClaudeMd(tmpl, {
      '{{ASSISTANT_NAME}}': 'Tars',
      '{{MANAGER_NAME}}': 'Caio',
      '{{MANAGER_ID}}': 'p-001',
    });
    expect(out).toBe('# Tars\n\nManager: Caio (ID p-001)');
  });

  it('replaces all occurrences of the same token', () => {
    expect(generateClaudeMd('{{X}} and {{X}} and {{X}}', { '{{X}}': 'foo' })).toBe('foo and foo and foo');
  });

  it('leaves unknown tokens in place', () => {
    expect(generateClaudeMd('{{KNOWN}} {{UNKNOWN}}', { '{{KNOWN}}': 'a' })).toBe('a {{UNKNOWN}}');
  });
});

describe('nextCronRun', () => {
  it('returns an ISO timestamp for valid cron', () => {
    const next = nextCronRun('0 11 * * 1-5');
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('returns null for invalid cron', () => {
    expect(nextCronRun('not a cron')).toBeNull();
    expect(nextCronRun('99 99 * * *')).toBeNull();
  });
});

describe('scheduleRunners (integration via in-memory taskflow.db)', () => {
  let dbFile: string;
  let db: Database.Database;

  beforeEach(() => {
    fs.mkdirSync(TMPROOT, { recursive: true });
    dbFile = path.join(TMPROOT, `runners-${Date.now()}.db`);
    db = initTaskflowDb(dbFile);
    // Seed a board (FK target for board_runtime_config) and the config row.
    db.prepare(
      `INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code)
         VALUES ('board-test-1', '120363999@g.us', 'test-folder', 'hierarchy', 0, 3, NULL, 'TEST')`,
    ).run();
    db.prepare(
      `INSERT INTO board_runtime_config (board_id, language, timezone) VALUES ('board-test-1', 'pt-BR', 'America/Fortaleza')`,
    ).run();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(dbFile, { force: true });
  });

  it('writes 3 cron rows + UPDATEs runner ids on board_runtime_config', () => {
    scheduleRunners({
      tfDb: db,
      boardId: 'board-test-1',
      groupFolder: 'test-folder',
      groupJid: '120363999@g.us',
      standupCronUtc: '0 11 * * 1-5',
      digestCronUtc: '0 21 * * 1-5',
      reviewCronUtc: '0 14 * * 5',
      now: '2026-05-05T00:00:00Z',
    });

    const tasks = db
      .prepare('SELECT id, schedule_type, schedule_value, prompt FROM scheduled_tasks ORDER BY rowid')
      .all() as Array<{
      id: string;
      schedule_type: string;
      schedule_value: string;
      prompt: string;
    }>;
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.schedule_type === 'cron')).toBe(true);
    expect(tasks[0]!.schedule_value).toBe('0 11 * * 1-5');
    expect(tasks[1]!.schedule_value).toBe('0 21 * * 1-5');
    expect(tasks[2]!.schedule_value).toBe('0 14 * * 5');
    expect(tasks[0]!.prompt).toMatch(/STANDUP/);
    expect(tasks[1]!.prompt).toMatch(/DIGEST/);
    expect(tasks[2]!.prompt).toMatch(/REVIEW/);

    const cfg = db
      .prepare(
        'SELECT runner_standup_task_id, runner_digest_task_id, runner_review_task_id FROM board_runtime_config WHERE board_id = ?',
      )
      .get('board-test-1') as {
      runner_standup_task_id: string | null;
      runner_digest_task_id: string | null;
      runner_review_task_id: string | null;
    };
    expect(cfg.runner_standup_task_id).toBe(tasks[0]!.id);
    expect(cfg.runner_digest_task_id).toBe(tasks[1]!.id);
    expect(cfg.runner_review_task_id).toBe(tasks[2]!.id);
  });
});

describe('scheduleOnboarding (integration via in-memory taskflow.db)', () => {
  let dbFile: string;
  let db: Database.Database;

  beforeEach(() => {
    fs.mkdirSync(TMPROOT, { recursive: true });
    dbFile = path.join(TMPROOT, `onboarding-${Date.now()}.db`);
    db = initTaskflowDb(dbFile);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(dbFile, { force: true });
  });

  it('writes 5 once-rows for the GTD onboarding series, day 1 ~30min from now', () => {
    const before = Date.now();
    scheduleOnboarding(db, {
      groupFolder: 'test-folder',
      groupJid: '120363999@g.us',
      timezone: 'America/Fortaleza',
    });

    const tasks = db
      .prepare('SELECT id, schedule_type, prompt, next_run FROM scheduled_tasks ORDER BY next_run')
      .all() as Array<{ id: string; schedule_type: string; prompt: string; next_run: string }>;
    expect(tasks).toHaveLength(ONBOARDING_FILES.length);
    expect(tasks.every((t) => t.schedule_type === 'once')).toBe(true);
    expect(tasks.every((t) => /\[TF-ONBOARDING\]/.test(t.prompt))).toBe(true);
    // Day 1 is 30 minutes from "now"; allow ±90s drift for slow test machines.
    const day1Ms = new Date(tasks[0]!.next_run).getTime();
    expect(day1Ms - before).toBeGreaterThanOrEqual(30 * 60 * 1000 - 90_000);
    expect(day1Ms - before).toBeLessThanOrEqual(30 * 60 * 1000 + 90_000);
    // Day 2 onwards strictly later than day 1.
    for (let i = 1; i < tasks.length; i++) {
      expect(new Date(tasks[i]!.next_run).getTime()).toBeGreaterThan(new Date(tasks[i - 1]!.next_run).getTime());
    }
  });

  it('each onboarding prompt references its specific file', () => {
    scheduleOnboarding(db, {
      groupFolder: 'test-folder',
      groupJid: '120363999@g.us',
      timezone: 'America/Fortaleza',
    });
    const prompts = (
      db.prepare('SELECT prompt FROM scheduled_tasks ORDER BY next_run').all() as Array<{ prompt: string }>
    ).map((r) => r.prompt);
    for (let i = 0; i < ONBOARDING_FILES.length; i++) {
      expect(prompts[i]).toContain(ONBOARDING_FILES[i]!);
    }
  });
});

describe('createBoardFilesystem (integration via tmp groups dir)', () => {
  let savedCwd: string;
  let tmpProjectRoot: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    fs.mkdirSync(TMPROOT, { recursive: true });
    tmpProjectRoot = path.join(TMPROOT, `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(path.join(tmpProjectRoot, 'groups'), { recursive: true });
    // Pretend the project root is our tmp dir so GROUPS_DIR points at our sandbox.
    // GROUPS_DIR is computed from process.cwd() in src/config.ts at import time;
    // since the helper imports config.js once, we can't redirect mid-run. Instead
    // we use a sub-folder of the actual GROUPS_DIR for the test.
    process.chdir(tmpProjectRoot);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    fs.rmSync(tmpProjectRoot, { recursive: true, force: true });
  });

  it('creates groupDir/logs/ + .mcp.json (v1 contract: logs/ referenced by agent template)', () => {
    // We can't easily redirect GROUPS_DIR (frozen at config.ts import), so we
    // exercise the helper against the REAL groups/ dir under a unique folder name
    // and clean up after.
    const folder = `_test-folder-${Date.now()}`;
    try {
      createBoardFilesystem({
        groupFolder: folder,
        assistantName: 'Tars',
        personName: 'Test Manager',
        personPhone: '5585999991234',
        personId: 'p-test',
        language: 'pt-BR',
        timezone: 'America/Fortaleza',
        wipLimit: 5,
        boardId: 'board-test',
        groupName: 'Test Board',
        groupContext: 'test context',
        groupJid: '120363999@g.us',
        boardRole: 'hierarchy',
        hierarchyLevel: 0,
        maxDepth: 3,
        parentBoardId: '',
        standupCronUtc: '0 11 * * 1-5',
        digestCronUtc: '0 21 * * 1-5',
        reviewCronUtc: '0 14 * * 5',
        standupCronLocal: '0 8 * * 1-5',
        digestCronLocal: '0 18 * * 1-5',
        reviewCronLocal: '0 11 * * 5',
      });
      // Resolve actual groupDir via the same code path the helper used.
      const realGroupsDir = path.resolve(savedCwd, 'groups');
      const groupDir = path.join(realGroupsDir, folder);
      expect(fs.existsSync(groupDir)).toBe(true);
      // logs/ is required by the v1 contract (CLAUDE.md.template references it).
      expect(fs.existsSync(path.join(groupDir, 'logs'))).toBe(true);
      // .mcp.json must contain the canonical sqlite MCP config.
      const mcpJson = fs.readFileSync(path.join(groupDir, '.mcp.json'), 'utf-8').trimEnd();
      expect(mcpJson).toBe(MCP_JSON_CONTENT);
      // CLAUDE.local.md may or may not be created depending on whether the
      // template file exists in the real project tree. If it does, verify
      // tokens were rendered.
      const claudeLocal = path.join(groupDir, 'CLAUDE.local.md');
      if (fs.existsSync(claudeLocal)) {
        const body = fs.readFileSync(claudeLocal, 'utf-8');
        expect(body).toContain('Tars');
        expect(body).toContain('board-test');
        expect(body).not.toMatch(/\{\{ASSISTANT_NAME\}\}/);
      }
    } finally {
      const realGroupsDir = path.resolve(savedCwd, 'groups');
      const groupDir = path.join(realGroupsDir, folder);
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });
});
