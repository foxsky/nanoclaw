import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INBOUND_SCHEMA } from '../../db/schema.js';
import { initTaskflowDb } from '../../taskflow-db.js';
import {
  createBoardFilesystem,
  DIGEST_PROMPT,
  findBoardByFolder,
  generateClaudeMd,
  renderBoardClaudeMd,
  MCP_JSON_CONTENT,
  nextCronRun,
  ONBOARDING_FILES,
  REVIEW_PROMPT,
  resolveParticipantJid,
  sanitizeFolder,
  scheduleOnboarding,
  scheduleRunners,
  seedBoardCore,
  STANDUP_PROMPT,
  uniqueFolder,
} from './provision-shared.js';
import type { ChannelAdapter } from '../../channels/adapter.js';

const TMPROOT = path.join(os.tmpdir(), `nanoclaw-provision-shared-test-${process.pid}`);

describe('runner prompts are motivational-only (V1 parity)', () => {
  // WHY: a scheduled [TF-STANDUP]/[TF-DIGEST]/[TF-REVIEW] post must send ONLY a
  // warm motivational narrative written FROM the report data — never the rendered
  // formatted_board / formatted_report task list. The rendered board/report is
  // reserved for explicit on-demand human requests ("mostrar o quadro"). These are
  // the prompts baked into every board's recurring runner at provision; if they
  // instruct the agent to send the rendered field, every provisioned board
  // regresses to the high-volume list-dump the motivational-only rule exists to
  // kill. The host runner gate decides WHETHER a runner fires (cadence) — these
  // tests pin the CONTENT contract, which is orthogonal to the gate.
  const cases: Array<{ name: string; prompt: string; tag: string }> = [
    { name: 'STANDUP_PROMPT', prompt: STANDUP_PROMPT, tag: '[TF-STANDUP]' },
    { name: 'DIGEST_PROMPT', prompt: DIGEST_PROMPT, tag: '[TF-DIGEST]' },
    { name: 'REVIEW_PROMPT', prompt: REVIEW_PROMPT, tag: '[TF-REVIEW]' },
  ];

  for (const { name, prompt, tag } of cases) {
    describe(name, () => {
      it(`is anchored at the ${tag} tag so the gate/parser classifies it as a scheduled post`, () => {
        expect(prompt.startsWith(tag)).toBe(true);
      });

      it('explicitly forbids sending the rendered formatted_board / formatted_report', () => {
        // The prompt may (and should) NAME the rendered field — but only inside a
        // prohibition. Every mention of formatted_board/formatted_report must sit
        // in a sentence whose verb is negated ("do NOT send", "never send"); there
        // must be no affirmative "send the formatted_*" directive. Split on
        // sentence boundaries and require each field-naming sentence to be a
        // negation.
        const sentences = prompt.split(/(?<=[.])\s+/);
        const fieldSentences = sentences.filter((s) => /formatted_(?:board|report)/i.test(s));
        expect(fieldSentences.length).toBeGreaterThan(0); // it does address the rendered field
        for (const s of fieldSentences) {
          expect(s).toMatch(/\b(?:do not|don't|never|not)\b/i);
        }
      });

      it('NEVER instructs sending the full Kanban board / list / column breakdown', () => {
        // Guard against the pre-motivational prompts: "Send the Kanban board",
        // "send the digest", "send the full review", "consolidate ... columns".
        expect(prompt).not.toMatch(/Kanban|grouped by column|every column|full board breakdown|full review/i);
      });

      it('instructs READING the report data and sending ONE motivational message', () => {
        // Reads from the report tool (api_report / taskflow_report) ...
        expect(prompt).toMatch(/report/i);
        // ... then sends a single motivational narrative.
        expect(prompt).toMatch(/motivational/i);
      });

      it('keeps the skip-if-empty rule', () => {
        expect(prompt).toMatch(/skip|do NOT send|exit silently|no message/i);
      });
    });
  }

  it('the Friday digest/review prompts carry the close-the-week intent', () => {
    expect(`${DIGEST_PROMPT} ${REVIEW_PROMPT}`).toMatch(/Friday|close the week|week/i);
  });
});

describe('findBoardByFolder', () => {
  // v1-level folder drift (registered_groups.folder ≠ boards.group_folder) is
  // resolved via the board_groups many-to-many fallback. Without that fallback,
  // post-migration agents with drifted folders silently lose access to
  // provision_child_board and create_group (they query boards directly).
  // See /migrate-from-v1 Phase 1b.
  let tfDb: Database.Database;
  beforeEach(() => {
    tfDb = initTaskflowDb(':memory:');
    tfDb
      .prepare(
        `INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('board-eng', '120363111@g.us', 'eng-taskflow', 'hierarchy', 0, 3, null, 'ENG');
  });
  afterEach(() => {
    tfDb.close();
  });

  it('resolves direct match via boards.group_folder', () => {
    const board = findBoardByFolder(tfDb, 'eng-taskflow');
    expect(board?.id).toBe('board-eng');
  });

  it('resolves drift match via board_groups.group_folder', () => {
    tfDb
      .prepare(`INSERT INTO board_groups (board_id, group_jid, group_folder, group_role) VALUES (?, ?, ?, ?)`)
      .run('board-eng', '120363222@g.us', 'asse-eng-secti-taskflow', 'team');
    const board = findBoardByFolder(tfDb, 'asse-eng-secti-taskflow');
    expect(board?.id).toBe('board-eng');
  });

  it('returns undefined when neither boards nor board_groups matches', () => {
    const board = findBoardByFolder(tfDb, 'never-existed-taskflow');
    expect(board).toBeUndefined();
  });

  it('resolves to the lowest board_id (deterministic) when multiple board_groups rows map the same folder', () => {
    // board_groups PRIMARY KEY is (board_id, group_jid), so the same
    // group_folder can legally appear in multiple rows. Regression guard:
    // without ORDER BY in findBoardByFolder, SQLite's row order is
    // unspecified — same input could resolve to different boards across
    // reruns or after a VACUUM.
    tfDb
      .prepare(
        `INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('board-aaa', '120363aaa@g.us', 'board-aaa-actual', 'hierarchy', 0, 3, null, 'AAA');
    tfDb
      .prepare(
        `INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('board-zzz', '120363zzz@g.us', 'board-zzz-actual', 'hierarchy', 0, 3, null, 'ZZZ');
    // Map the SAME folder to BOTH boards via board_groups (legal per PK).
    tfDb
      .prepare(`INSERT INTO board_groups (board_id, group_jid, group_folder, group_role) VALUES (?, ?, ?, ?)`)
      .run('board-zzz', '120363zzz@g.us', 'ambiguous-folder', 'team');
    tfDb
      .prepare(`INSERT INTO board_groups (board_id, group_jid, group_folder, group_role) VALUES (?, ?, ?, ?)`)
      .run('board-aaa', '120363aaa@g.us', 'ambiguous-folder', 'team');
    // ORDER BY board_id → 'board-aaa' wins regardless of insert order.
    const board = findBoardByFolder(tfDb, 'ambiguous-folder');
    expect(board?.id).toBe('board-aaa');
  });
});

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

describe('renderBoardClaudeMd', () => {
  it('fills placeholders AND rewrites the template v1 tool vocabulary to registered v2 api_* names', () => {
    // The template ships in v1 (taskflow_*) vocabulary, but only api_* tools are registered.
    // A newly-provisioned board must call the real tools, so the render step must substitute.
    const tmpl = "# {{ASSISTANT_NAME}}\n\nUse taskflow_move({ task_id: 'T1', action: 'start' }) to start.";
    const out = renderBoardClaudeMd(tmpl, { '{{ASSISTANT_NAME}}': 'Tars' });
    expect(out).toContain('# Tars');
    expect(out).toContain('api_move(');
    expect(out).not.toContain('taskflow_move');
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

describe('scheduleRunners (writes to session messages_in)', () => {
  let dbFile: string;
  let db: Database.Database;
  let inboundDb: Database.Database;

  beforeEach(() => {
    fs.mkdirSync(TMPROOT, { recursive: true });
    dbFile = path.join(TMPROOT, `runners-${Date.now()}.db`);
    db = initTaskflowDb(dbFile);
    db.prepare(
      `INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code)
         VALUES ('board-test-1', '120363999@g.us', 'test-folder', 'hierarchy', 0, 3, NULL, 'TEST')`,
    ).run();
    db.prepare(
      `INSERT INTO board_runtime_config (board_id, language, timezone) VALUES ('board-test-1', 'pt-BR', 'America/Fortaleza')`,
    ).run();
    inboundDb = new Database(':memory:');
    inboundDb.exec(INBOUND_SCHEMA);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      inboundDb.close();
    } catch {}
    fs.rmSync(dbFile, { force: true });
  });

  it('computes first-run in the BOARD timezone when boardTimezone is given (not the global TZ)', () => {
    // Freeze time so scheduleRunners' nextCronRun and the test's expected share one "now" (no flake
    // if an 08:00 cron boundary fell between the two calls).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    try {
      scheduleRunners({
        tfDb: db,
        inboundDb,
        boardId: 'board-test-1',
        standupCronLocal: '0 8 * * 1-5',
        digestCronLocal: '0 18 * * 1-5',
        reviewCronLocal: '0 11 * * 5',
        boardTimezone: 'America/New_York',
      });
      const standup = inboundDb
        .prepare("SELECT process_after FROM messages_in WHERE content LIKE '%STANDUP%'")
        .get() as { process_after: string };
      // First run must be the next 08:00 in New York, not 08:00 in the deploy/global zone.
      expect(standup.process_after).toBe(nextCronRun('0 8 * * 1-5', 'America/New_York'));
      expect(standup.process_after).not.toBe(nextCronRun('0 8 * * 1-5', 'America/Fortaleza'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the global TIMEZONE when boardTimezone is garbage (board still gets its runners)', () => {
    // A corrupt board_runtime_config.timezone must NOT throw out of scheduleRunners (which would
    // leave the board with zero runners); it degrades to the global zone. (Codex review hardening.)
    scheduleRunners({
      tfDb: db,
      inboundDb,
      boardId: 'board-test-1',
      standupCronLocal: '0 8 * * 1-5',
      digestCronLocal: '0 18 * * 1-5',
      reviewCronLocal: '0 11 * * 5',
      boardTimezone: 'Not/ARealZone',
    });
    const { n } = inboundDb.prepare('SELECT COUNT(*) n FROM messages_in').get() as { n: number };
    expect(n).toBe(3);
  });

  it('writes 3 kind=task rows to messages_in (NOT scheduled_tasks) and UPDATEs runner ids', () => {
    scheduleRunners({
      tfDb: db,
      inboundDb,
      boardId: 'board-test-1',
      standupCronLocal: '0 8 * * 1-5',
      digestCronLocal: '0 18 * * 1-5',
      reviewCronLocal: '0 11 * * 5',
    });

    // Three task messages with cron recurrence + JSON content shape.
    const tasks = inboundDb
      .prepare(`SELECT id, kind, recurrence, content, process_after FROM messages_in ORDER BY seq`)
      .all() as Array<{
      id: string;
      kind: string;
      recurrence: string | null;
      content: string;
      process_after: string | null;
    }>;
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.kind === 'task')).toBe(true);
    expect(tasks[0]!.recurrence).toBe('0 8 * * 1-5');
    expect(tasks[1]!.recurrence).toBe('0 18 * * 1-5');
    expect(tasks[2]!.recurrence).toBe('0 11 * * 5');
    // Content is the v2 task envelope: { prompt, script } JSON string.
    const parsed = tasks.map((t) => JSON.parse(t.content) as { prompt: string; script: null });
    expect(parsed[0]!.prompt).toMatch(/STANDUP/);
    expect(parsed[1]!.prompt).toMatch(/DIGEST/);
    expect(parsed[2]!.prompt).toMatch(/REVIEW/);
    expect(parsed.every((p) => p.script === null)).toBe(true);
    expect(tasks.every((t) => t.process_after !== null)).toBe(true);

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
  let inboundDb: Database.Database;

  beforeEach(() => {
    fs.mkdirSync(TMPROOT, { recursive: true });
    dbFile = path.join(TMPROOT, `onboarding-${Date.now()}.db`);
    db = initTaskflowDb(dbFile);
    inboundDb = new Database(':memory:');
    inboundDb.exec(INBOUND_SCHEMA);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      inboundDb.close();
    } catch {}
    fs.rmSync(dbFile, { force: true });
  });

  it('writes onboarding rows to messages_in (kind=task, recurrence=null) — day 1 ~30min from now', () => {
    const before = Date.now();
    scheduleOnboarding({
      inboundDb,
      timezone: 'America/Fortaleza',
    });

    const tasks = inboundDb
      .prepare(`SELECT id, kind, recurrence, content, process_after FROM messages_in ORDER BY process_after`)
      .all() as Array<{
      id: string;
      kind: string;
      recurrence: string | null;
      content: string;
      process_after: string;
    }>;
    expect(tasks).toHaveLength(ONBOARDING_FILES.length);
    expect(tasks.every((t) => t.kind === 'task')).toBe(true);
    // Onboarding is one-shot — no recurrence.
    expect(tasks.every((t) => t.recurrence === null)).toBe(true);
    const parsed = tasks.map((t) => JSON.parse(t.content) as { prompt: string; script: null });
    expect(parsed.every((p) => /\[TF-ONBOARDING\]/.test(p.prompt))).toBe(true);
    expect(parsed.every((p) => p.script === null)).toBe(true);
    // Day 1 is 30 minutes from "now"; allow ±90s drift for slow test machines.
    const day1Ms = new Date(tasks[0]!.process_after).getTime();
    expect(day1Ms - before).toBeGreaterThanOrEqual(30 * 60 * 1000 - 90_000);
    expect(day1Ms - before).toBeLessThanOrEqual(30 * 60 * 1000 + 90_000);
    for (let i = 1; i < tasks.length; i++) {
      expect(new Date(tasks[i]!.process_after).getTime()).toBeGreaterThan(
        new Date(tasks[i - 1]!.process_after).getTime(),
      );
    }
  });

  it('each onboarding prompt references its specific file', () => {
    scheduleOnboarding({
      inboundDb,
      timezone: 'America/Fortaleza',
    });
    const prompts = (
      inboundDb.prepare('SELECT content FROM messages_in ORDER BY process_after').all() as Array<{ content: string }>
    ).map((r) => r.content);
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

describe('seedBoardCore', () => {
  // Both provision_root_board and provision_child_board depend on this helper
  // to persist the caller-RESOLVED values verbatim across the five
  // board-defining tables. The test pins that contract: whatever the caller
  // decided (root from input, child inherited from the parent) lands exactly,
  // including the nullable owner_person_id that distinguishes a child board.
  let tfDb: Database.Database;
  beforeEach(() => {
    tfDb = initTaskflowDb(':memory:');
  });
  afterEach(() => {
    tfDb.close();
  });

  const RUNTIME = {
    language: 'pt-BR',
    timezone: 'America/Fortaleza',
    standup_cron_local: '0 8 * * 1-5',
    digest_cron_local: '0 18 * * 1-5',
    review_cron_local: '0 9 * * 1',
    standup_cron_utc: '0 11 * * 1-5',
    digest_cron_utc: '0 21 * * 1-5',
    review_cron_utc: '0 12 * * 1',
    attachment_enabled: 1,
    attachment_disabled_reason: '',
    dst_sync_enabled: 1,
  };

  it('writes all five board-defining rows with the resolved values (child board, owner set)', () => {
    // boards.parent_board_id is a FK to boards.id — the parent must exist.
    tfDb
      .prepare(
        `INSERT INTO boards (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code)
         VALUES ('board-parent', '120363parent@g.us', 'parent-taskflow', 'hierarchy', 1, 3, NULL, 'PAR')`,
      )
      .run();
    seedBoardCore(tfDb, {
      boardId: 'board-x',
      groupJid: '120363999@g.us',
      folder: 'x-taskflow',
      hierarchyLevel: 2,
      maxDepth: 3,
      parentBoardId: 'board-parent',
      shortCode: 'X',
      ownerPersonId: 'ana',
      wipLimit: 5,
      runtime: RUNTIME,
      person: { personId: 'ana', name: 'Ana Souza', phone: '5511999999999', role: 'manager' },
    });

    const board = tfDb.prepare('SELECT * FROM boards WHERE id = ?').get('board-x') as any;
    expect(board.hierarchy_level).toBe(2);
    expect(board.parent_board_id).toBe('board-parent');
    expect(board.owner_person_id).toBe('ana');
    expect(board.board_role).toBe('hierarchy');
    expect(board.short_code).toBe('X');

    expect(
      (tfDb.prepare('SELECT wip_limit FROM board_config WHERE board_id = ?').get('board-x') as any).wip_limit,
    ).toBe(5);

    const rt = tfDb.prepare('SELECT * FROM board_runtime_config WHERE board_id = ?').get('board-x') as any;
    expect(rt.timezone).toBe('America/Fortaleza');
    expect(rt.standup_cron_utc).toBe('0 11 * * 1-5');

    const admin = tfDb.prepare('SELECT * FROM board_admins WHERE board_id = ?').get('board-x') as any;
    expect(admin.person_id).toBe('ana');
    expect(admin.is_primary_manager).toBe(1);

    const person = tfDb.prepare('SELECT * FROM board_people WHERE board_id = ?').get('board-x') as any;
    expect(person.name).toBe('Ana Souza');
    expect(person.wip_limit).toBe(5);
    expect(person.notification_group_jid).toBeNull();
  });

  it('persists a root board with null parent and null owner_person_id', () => {
    seedBoardCore(tfDb, {
      boardId: 'board-root',
      groupJid: '120363000@g.us',
      folder: 'root-taskflow',
      hierarchyLevel: 0,
      maxDepth: 3,
      parentBoardId: null,
      shortCode: 'ROOT',
      ownerPersonId: null,
      wipLimit: 8,
      runtime: RUNTIME,
      person: { personId: 'bob', name: 'Bob', phone: '5511888888888', role: 'manager' },
    });
    const board = tfDb.prepare('SELECT * FROM boards WHERE id = ?').get('board-root') as any;
    expect(board.hierarchy_level).toBe(0);
    expect(board.parent_board_id).toBeNull();
    expect(board.owner_person_id).toBeNull();
  });
});

describe('resolveParticipantJid (RC5 — BR 9th-digit reconciliation)', () => {
  // The stored phone is the 12-digit form; WhatsApp's canonical JID is the
  // 13-digit form. The round-trip MUST win so the participant is not dropped.
  const STORED = '558599992345'; // 12-digit
  const CANONICAL_JID = '5585999992345@s.whatsapp.net'; // 13-digit, from WhatsApp

  it('prefers the onWhatsApp() round-trip JID over the string-built one', async () => {
    const adapter = {
      lookupPhoneJid: vi.fn(async () => CANONICAL_JID),
      resolvePhoneJid: vi.fn(async (p: string) => `${p.replace(/\D/g, '')}@s.whatsapp.net`),
    } as unknown as ChannelAdapter;
    expect(await resolveParticipantJid(adapter, STORED)).toBe(CANONICAL_JID);
    expect(adapter.resolvePhoneJid).not.toHaveBeenCalled();
  });

  it('falls back to the string-built JID when the number is not on WhatsApp', async () => {
    const adapter = {
      lookupPhoneJid: vi.fn(async () => null),
      resolvePhoneJid: vi.fn(async (p: string) => `${p.replace(/\D/g, '')}@s.whatsapp.net`),
    } as unknown as ChannelAdapter;
    expect(await resolveParticipantJid(adapter, STORED)).toBe(`${STORED}@s.whatsapp.net`);
  });

  it('falls back to the string-built JID when the round-trip throws', async () => {
    const adapter = {
      lookupPhoneJid: vi.fn(async () => {
        throw new Error('socket down');
      }),
      resolvePhoneJid: vi.fn(async (p: string) => `${p.replace(/\D/g, '')}@s.whatsapp.net`),
    } as unknown as ChannelAdapter;
    expect(await resolveParticipantJid(adapter, STORED)).toBe(`${STORED}@s.whatsapp.net`);
  });

  it('falls back to phoneToWhatsAppJid when the adapter lacks both capabilities', async () => {
    const adapter = {} as unknown as ChannelAdapter;
    // phoneToWhatsAppJid canonicalizes the 10/11-digit local form by prepending 55.
    expect(await resolveParticipantJid(adapter, STORED)).toBe(`${STORED}@s.whatsapp.net`);
  });
});
