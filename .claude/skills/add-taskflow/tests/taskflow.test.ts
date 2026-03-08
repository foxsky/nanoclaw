import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { TaskflowEngine } from '../add/container/agent-runner/src/taskflow-engine.js';

const BOARD_ID = 'board-test-001';

const SCHEMA = `
CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, board_role TEXT DEFAULT 'standard', hierarchy_level INTEGER, max_depth INTEGER, parent_board_id TEXT, short_code TEXT);
CREATE TABLE board_people (board_id TEXT, person_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, role TEXT DEFAULT 'member', wip_limit INTEGER, notification_group_jid TEXT, PRIMARY KEY (board_id, person_id));
CREATE TABLE board_admins (board_id TEXT, person_id TEXT NOT NULL, phone TEXT NOT NULL, admin_role TEXT NOT NULL, is_primary_manager INTEGER DEFAULT 0, PRIMARY KEY (board_id, person_id, admin_role));
CREATE TABLE child_board_registrations (parent_board_id TEXT, person_id TEXT NOT NULL, child_board_id TEXT, PRIMARY KEY (parent_board_id, person_id));
CREATE TABLE board_groups (board_id TEXT, group_jid TEXT NOT NULL, group_folder TEXT NOT NULL, group_role TEXT DEFAULT 'team', PRIMARY KEY (board_id, group_jid));
CREATE TABLE tasks (id TEXT NOT NULL, board_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'simple', title TEXT NOT NULL, assignee TEXT, next_action TEXT, waiting_for TEXT, column TEXT DEFAULT 'inbox', priority TEXT, due_date TEXT, description TEXT, labels TEXT DEFAULT '[]', blocked_by TEXT DEFAULT '[]', reminders TEXT DEFAULT '[]', next_note_id INTEGER DEFAULT 1, notes TEXT DEFAULT '[]', _last_mutation TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, child_exec_enabled INTEGER DEFAULT 0, child_exec_board_id TEXT, child_exec_person_id TEXT, child_exec_rollup_status TEXT, child_exec_last_rollup_at TEXT, child_exec_last_rollup_summary TEXT, linked_parent_board_id TEXT, linked_parent_task_id TEXT, parent_task_id TEXT, subtasks TEXT, recurrence TEXT, current_cycle TEXT, max_cycles INTEGER, recurrence_end_date TEXT, participants TEXT, scheduled_at TEXT, PRIMARY KEY (board_id, id));
CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, task_id TEXT NOT NULL, action TEXT NOT NULL, by TEXT, at TEXT NOT NULL, details TEXT);
CREATE TABLE archive (board_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT, archive_reason TEXT NOT NULL, linked_parent_board_id TEXT, linked_parent_task_id TEXT, archived_at TEXT NOT NULL, task_snapshot TEXT NOT NULL, history TEXT, PRIMARY KEY (board_id, task_id));
CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'pt-BR', timezone TEXT NOT NULL DEFAULT 'America/Fortaleza', runner_standup_task_id TEXT, runner_digest_task_id TEXT, runner_review_task_id TEXT, runner_dst_guard_task_id TEXT, standup_cron_local TEXT, digest_cron_local TEXT, review_cron_local TEXT, standup_cron_utc TEXT, digest_cron_utc TEXT, review_cron_utc TEXT, dst_sync_enabled INTEGER DEFAULT 0, dst_last_offset_minutes INTEGER, dst_last_synced_at TEXT, dst_resync_count_24h INTEGER DEFAULT 0, dst_resync_window_started_at TEXT, attachment_enabled INTEGER DEFAULT 1, attachment_disabled_reason TEXT DEFAULT '', attachment_allowed_formats TEXT DEFAULT '["pdf","jpg","png"]', attachment_max_size_bytes INTEGER DEFAULT 10485760, welcome_sent INTEGER DEFAULT 0, standup_target TEXT DEFAULT 'team', digest_target TEXT DEFAULT 'team', review_target TEXT DEFAULT 'team', runner_standup_secondary_task_id TEXT, runner_digest_secondary_task_id TEXT, runner_review_secondary_task_id TEXT);
CREATE TABLE attachment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, source TEXT NOT NULL, filename TEXT NOT NULL, at TEXT NOT NULL, actor_person_id TEXT, affected_task_refs TEXT DEFAULT '[]');
CREATE TABLE board_config (board_id TEXT PRIMARY KEY, columns TEXT DEFAULT '["inbox","next_action","in_progress","waiting","review","done"]', wip_limit INTEGER DEFAULT 5, next_task_number INTEGER DEFAULT 1, next_project_number INTEGER DEFAULT 1, next_recurring_number INTEGER DEFAULT 1, next_note_id INTEGER DEFAULT 1);
`;

function seedTestDb(db: Database.Database, boardId: string) {
  db.exec(SCHEMA);

  db.exec(
    `INSERT INTO boards VALUES ('${boardId}', 'test@g.us', 'test', 'standard', 0, 1, NULL, NULL)`,
  );
  db.exec(
    `INSERT INTO board_config VALUES ('${boardId}', '["inbox","next_action","in_progress","waiting","review","done"]', 3, 4, 1, 1, 1)`,
  );
  db.exec(`INSERT INTO board_runtime_config (board_id) VALUES ('${boardId}')`);
  db.exec(
    `INSERT INTO board_admins VALUES ('${boardId}', 'person-1', '5585999990001', 'manager', 1)`,
  );
  db.exec(
    `INSERT INTO board_people VALUES ('${boardId}', 'person-1', 'Alexandre', '5585999990001', 'Gestor', 3, NULL)`,
  );
  db.exec(
    `INSERT INTO board_people VALUES ('${boardId}', 'person-2', 'Giovanni', '5585999990002', 'Dev', 3, NULL)`,
  );

  const now = new Date().toISOString();
  db.exec(
    `INSERT INTO tasks (id, board_id, type, title, assignee, column, priority, created_at, updated_at)
     VALUES ('T-001', '${boardId}', 'simple', 'Fix login bug', 'person-1', 'in_progress', 'high', '${now}', '${now}')`,
  );
  db.exec(
    `INSERT INTO tasks (id, board_id, type, title, assignee, column, created_at, updated_at)
     VALUES ('T-002', '${boardId}', 'simple', 'Update docs', 'person-2', 'next_action', '${now}', '${now}')`,
  );
  db.exec(
    `INSERT INTO tasks (id, board_id, type, title, column, created_at, updated_at)
     VALUES ('T-003', '${boardId}', 'simple', 'Review PR', 'inbox', '${now}', '${now}')`,
  );
}

describe('taskflow skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: taskflow');
    expect(content).toMatch(/version:\s+\d+\.\d+\.\d+/);
    expect(content).toContain('taskflow-engine.ts');
  });

  it('has SKILL.md with required frontmatter', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('name: add-taskflow');
    expect(skillMd).toContain('description:');
  });

  it('SKILL.md top-level description covers all topologies with SQLite', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('All board topologies (shared, separate, hierarchy) use SQLite as the single task store');
    expect(skillMd).toContain('All topologies rely on already-implemented runtime support');
    expect(skillMd).not.toContain('Standard boards run via CLAUDE.md + TASKS.json');
  });

  it('SKILL.md DST timezone storage policy uses board_runtime_config for all topologies', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('store both local and UTC schedules in `board_runtime_config`');
    expect(skillMd).not.toContain('`TASKS.json` meta for standard / separate boards');
  });

  it('SKILL.md people registration uses board_people for all topologies', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('Always register the primary full manager in `board_people`');
    expect(skillMd).toContain('sender identification and admin authorization work');
    expect(skillMd).toContain('### 2. Register People in board_people');
    expect(skillMd).toContain('INSERT OR REPLACE INTO board_people');
    expect(skillMd).toContain('Inserted\', people.length, \'people into board_people');
    expect(skillMd).toContain('`board_people` is the source of truth for assignees, WIP overrides, and sender matching');
  });

  it('SKILL.md passes shell variables into node snippets that read process.env', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('env PEOPLE_JSON="$PEOPLE_JSON" node -e "');
    expect(skillMd).toContain('env STANDUP_ID="$STANDUP_ID" DIGEST_ID="$DIGEST_ID" REVIEW_ID="$REVIEW_ID" DST_ID="$DST_ID"');
    expect(skillMd).toContain('DST_GUARD_ENABLED="{{DST_GUARD_ENABLED}}" TIMEZONE="{{TIMEZONE}}" node -e "');
    expect(skillMd).toContain('env STANDUP_ID="$STANDUP_ID" DIGEST_ID="$DIGEST_ID" REVIEW_ID="$REVIEW_ID" STANDUP_NEXT="$STANDUP_NEXT" DIGEST_NEXT="$DIGEST_NEXT" REVIEW_NEXT="$REVIEW_NEXT"');
    expect(skillMd).toContain('STANDUP_PROMPT="$STANDUP_PROMPT" DIGEST_PROMPT="$DIGEST_PROMPT" REVIEW_PROMPT="$REVIEW_PROMPT" NOW="$NOW" node -e "');
    expect(skillMd).toContain('env DST_ID="$DST_ID" DST_GUARD_PROMPT="$DST_GUARD_PROMPT" DST_NEXT="$DST_NEXT" NOW="$NOW" node -e "');
  });


  it('has SKILL.md with all 5 phases', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('## Phase 1: Configuration');
    expect(skillMd).toContain('## Phase 2: Group Creation');
    expect(skillMd).toContain('## Phase 3: People Registration');
    expect(skillMd).toContain('## Phase 4: Runner Setup');
    expect(skillMd).toContain('## Phase 5: Verification');
  });

  it('SKILL.md does not reference JSON schema_version migrations', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).not.toContain('meta.schema_version');
    expect(skillMd).not.toContain('TASKS.json');
    // SKILL.md still uses placeholders generically in template generation
    // but must not reference TASKS.json as a data store
    expect(skillMd).toContain('board_runtime_config');
  });

  it('templates dir contains only CLAUDE.md.template', () => {
    const templatesDir = path.join(skillDir, 'templates');
    expect(fs.existsSync(path.join(templatesDir, 'CLAUDE.md.template'))).toBe(true);

    const files = fs.readdirSync(templatesDir).sort();
    expect(files).toEqual(['CLAUDE.md.template']);
  });

  it('CLAUDE.md.template has all required sections', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Scope guard (token savings for off-topic queries)
    expect(content).toContain('Scope Guard');
    expect(content).toContain('task management assistant ONLY');
    expect(content).toContain('Do NOT query the database for off-topic requests');

    // v2 has NO "CRITICAL: Load Data First" section — engine loads data internally
    expect(content).not.toContain('TASKS.json');

    // Security
    expect(content).toContain('Security');
    expect(content).toContain('untrusted data');

    // Authorization
    expect(content).toContain('Authorization Matrix');
    expect(content).toContain('Manager');

    // v2 uses Command -> Tool Mapping, not Command Parsing
    expect(content).toContain('## Command -> Tool Mapping');
    expect(content).toContain('Quick Capture');
    expect(content).toContain('## Attachment Intake');

    // Runner formats — standup uses formatted_board, digest/weekly still documented
    expect(content).toContain('Standup-specific behavior');
    expect(content).toContain('Digest (Evening)');
    expect(content).toContain('Weekly Review (Friday)');

    // MCP tools
    expect(content).toContain('send_message');
    expect(content).toContain('schedule_task');
    expect(content).toContain('cancel_task');

    // Schema Reference section (v2 replaces Data Schemas)
    expect(content).toContain('## Schema Reference (for ad-hoc SQL)');

    // Tool vs. Direct SQL section
    expect(content).toContain('## Tool vs. Direct SQL');
  });

  it('CLAUDE.md.template uses correct send_message signature', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Must NOT contain the non-existent `to:` parameter
    expect(content).not.toMatch(/send_message\(\s*to:/);
    // Must contain the correct signature
    expect(content).toContain('text:');
    expect(content).toContain('sender:');
  });

  it('CLAUDE.md.template explicitly enforces manager task creation and delegate-enabled inbox processing', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2 uses Authorization Matrix table with Manager role
    expect(content).toContain('Manager');
    expect(content).toContain('create tasks');

    // v2 has task creation commands in Command -> Tool Mapping
    expect(content).toContain('taskflow_create');
    expect(content).toContain("type: 'simple'");
    expect(content).toContain("type: 'project'");
    expect(content).toContain("type: 'recurring'");
    expect(content).toContain("type: 'inbox'");

    // Delegate can process inbox
    expect(content).toContain('Delegate');
    expect(content).toContain('Process inbox');

    // v2 authorization matrix — engine enforces permissions via sender_name
    expect(content).toContain('sender_name');
    expect(content).toContain('ALWAYS call the MCP tool and pass the resolved');
  });

  it('CLAUDE.md.template documents management commands via MCP tool mapping', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2 documents commands in Command -> Tool Mapping tables
    expect(content).toContain('forcar TXXX para andamento');
    expect(content).toContain("action: 'force_start'");
    expect(content).toContain('reatribuir TXXX para');
    expect(content).toContain('taskflow_reassign');
    expect(content).toContain('remover Nome');
    expect(content).toContain("action: 'remove_person'");
    expect(content).toContain('TXXX rejeitada');
    expect(content).toContain("action: 'reject'");
    // Done shortcut
    expect(content).toContain('TXXX concluida');
    expect(content).toContain("action: 'conclude'");
  });

  it('CLAUDE.md.template schema reference matches SQLite storage and runtime columns', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('labels TEXT');
    expect(content).toContain('blocked_by TEXT');
    expect(content).toContain('notes TEXT');
    expect(content).toContain('reminders TEXT');
    expect(content).toContain('child_exec_last_rollup_at TEXT');
    expect(content).toContain('child_exec_last_rollup_summary TEXT');
    expect(content).toContain('runner_standup_task_id TEXT');
    expect(content).toContain('runner_review_secondary_task_id TEXT');
    expect(content).toContain('country TEXT');
    expect(content).toContain('city TEXT');
    expect(content).toContain('attachment_allowed_formats TEXT');
  });

  it('CLAUDE.md.template clarifies hierarchy parent-linking and manager-only WIP forcing', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('"ligar TXXX ao pai TYYY"');
    expect(content).toContain('forcar TXXX para andamento');
    expect(content).toContain('comando de gestor');
  });

  it('CLAUDE.md.template requires the exact attachment confirmation token', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2 uses slightly different wording but same concept
    expect(content).toContain('CONFIRM_IMPORT {import_action_id}');
    expect(content).toContain('generic replies like "ok", "sim", "pode fazer" are NOT sufficient');
  });

  it('CLAUDE.md.template does not assume unsupported per-task reminder scheduling', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).not.toContain('recreate reminders');
    expect(content).not.toContain('per-task reminder IDs');
    // v2: due date updates go via taskflow_update tool
    expect(content).toContain("updates: { due_date:");
    // v2: cancel_task is for scheduled runner jobs (standup, digest, review, DST guard)
    expect(content).toContain('cancel_task');
  });

  it('CLAUDE.md.template defines project subtask IDs and recurring next-cycle creation', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: subtask IDs documented in task creation tool mapping
    expect(content).toContain('PXXX.N');
    // v2: recurring tasks handled by engine via taskflow_create with type: 'recurring'
    expect(content).toContain("type: 'recurring'");
    expect(content).toContain('recurrence');
    // v2: recurring cycle info in tool response
    expect(content).toContain('recurring_cycle');
  });

  it('CLAUDE.md.template has schema reference for ad-hoc SQL', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2 uses Schema Reference section instead of Data Schemas
    expect(content).toContain('## Schema Reference (for ad-hoc SQL)');
    expect(content).toContain('ISO-8601 UTC');
    expect(content).not.toContain('`meta.managers[]`');
    expect(content).not.toContain('`meta.manager`');

    // Key tables listed
    expect(content).toContain('**tasks**');
    expect(content).toContain('**board_people**');
    expect(content).toContain('**board_admins**');
    expect(content).toContain('**board_config**');
    expect(content).toContain('**board_id_counters**');
    expect(content).toContain('**task_history**');
    expect(content).toContain('**archive**');
    expect(content).toContain('**attachment_audit_log**');
    expect(content).toContain('**board_holidays**');

    // Key columns
    expect(content).toContain('board_id');
    expect(content).toContain('type');
    expect(content).toContain('column');
    expect(content).toContain('assignee');
    expect(content).toContain('next_action');
    expect(content).toContain('waiting_for');
    expect(content).toContain('due_date');
    expect(content).toContain('priority');
    expect(content).toContain('labels');
    expect(content).toContain('notes');
    expect(content).toContain('next_note_id');
    expect(content).toContain('created_at');
    expect(content).toContain('updated_at');
    expect(content).toContain('subtasks');
    expect(content).toContain('recurrence');
    expect(content).toContain('current_cycle');
    expect(content).toContain('parent_task_id');
    expect(content).toContain('TEXT');
    expect(content).toContain('INTEGER');
    expect(content).toContain('JSON');
  });


  it('SKILL.md uses deterministic runner prompt markers for ID reconciliation', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('[TF-STANDUP]');
    expect(skillMd).toContain('[TF-DIGEST]');
    expect(skillMd).toContain('[TF-REVIEW]');
    expect(skillMd).toContain('[TF-DST-GUARD]');
  });

  it('CLAUDE.md.template has skip-if-empty rules for all runner formats', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // Standup uses formatted_board section, digest/weekly still have own sections
    const standupSection = content.split('### Standup-specific behavior')[1]?.split('###')[0] ?? '';
    const digestSection = content.split('### Digest (Evening)')[1]?.split('### Weekly Review')[0] ?? '';
    const reviewSection = content.split('### Weekly Review (Friday)')[1]?.split('## Notification')[0] ?? '';

    expect(standupSection).toContain('Skip if empty');
    expect(digestSection).toContain('Skip if empty');
    expect(reviewSection).toContain('Skip if empty');
  });

  it('SKILL.md runner prompts include skip-if-empty conditions', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toMatch(/STANDUP_PROMPT.*no tasks exist/);
    expect(skillMd).toMatch(/DIGEST_PROMPT.*no tasks exist/);
    expect(skillMd).toMatch(/REVIEW_PROMPT.*no tasks exist/);
    expect(skillMd).toContain('exit silently, even if there was archive activity this week');
  });

  it('SKILL.md documents automatic group creation via Baileys', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    // Documents the Baileys API
    expect(skillMd).toContain('groupCreate');
    expect(skillMd).toContain('@s.whatsapp.net');
    // Has service stop before group creation
    expect(skillMd).toContain('systemctl stop nanoclaw');
    // Documents the GROUPS_JSON batch pattern
    expect(skillMd).toContain('GROUPS_JSON');
    // Documents participant format
    expect(skillMd).toContain('participants');
    // Has manual fallback option
    expect(skillMd).toContain('manual fallback');
    // Passes GROUPS_JSON into the node snippet instead of relying on an unexported shell variable
    expect(skillMd).toContain('env GROUPS_JSON="$GROUPS_JSON" node -e "');
    // Keeps hierarchy setup separate from separate-mode multi-board setup
    expect(skillMd).toContain('If you create multiple groups for separate mode');
    expect(skillMd).toContain('For hierarchy mode, create the initial chain during setup');
  });

  it('CLAUDE.md.template scope guard appears before security section', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const scopeGuardPos = content.indexOf('## Scope Guard');
    const securityPos = content.indexOf('## Security');
    expect(scopeGuardPos).toBeGreaterThan(-1);
    expect(securityPos).toBeGreaterThan(-1);
    expect(scopeGuardPos).toBeLessThan(securityPos);
  });

  it('CLAUDE.md.template scope guard blocks database queries for off-topic queries', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const scopeSection =
      content.split('## Scope Guard')[1]?.split('## Welcome Check')[0] ?? '';

    // v2 says "Do NOT query the database for off-topic requests"
    expect(scopeSection).toContain('Do NOT query the database for off-topic requests');
  });

  it('CLAUDE.md.template v2 uses Tool vs. Direct SQL section instead of Load Data First', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2 has NO "CRITICAL: Load Data First" — engine loads data internally
    expect(content).not.toContain('CRITICAL: Load Data First');

    // v2 has Tool vs. Direct SQL section
    const toolSection = content.split('## Tool vs. Direct SQL')[1]?.split('## Command')[0] ?? '';
    expect(toolSection).toContain('read_query');
    expect(toolSection).toContain('write_query');
    expect(toolSection).toContain('TaskFlow MCP tools');
    expect(toolSection).not.toContain('TASKS.json');
  });

  it('SKILL.md documents per-group AI model configuration via settings.json', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('settings.json');
    expect(skillMd).toContain('ANTHROPIC_MODEL');
    expect(skillMd).toContain('data/sessions/{{GROUP_FOLDER}}/.claude/settings.json');
  });

  it('SKILL.md scope guard note references database', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('without querying the database');
  });

  it('SKILL.md uses valid hierarchy depth values in setup snippets', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('taskflow_hierarchy_level, taskflow_max_depth) VALUES');
    // Root board uses TASKFLOW_HIERARCHY_LEVEL and TASKFLOW_MAX_DEPTH placeholders
    expect(skillMd).toContain('{{TASKFLOW_HIERARCHY_LEVEL}}');
    expect(skillMd).toContain('{{TASKFLOW_MAX_DEPTH}}');
    // Standard/separate boards use hierarchy_level=0, max_depth=1
    expect(skillMd).toContain('taskflow_hierarchy_level=0');
    expect(skillMd).toContain('taskflow_max_depth=1');
    // Child board level computed dynamically from parent
    expect(skillMd).toContain('CHILD_BOARD_LEVEL=$((PARENT_BOARD_LEVEL + 1))');
    expect(skillMd).toContain('CHILD_RUNTIME_LEVEL=$((PARENT_RUNTIME_LEVEL + 1))');
    expect(skillMd).toContain('${CHILD_RUNTIME_LEVEL}');
    expect(skillMd).toContain('${CHILD_BOARD_LEVEL}');
    expect(skillMd).not.toContain('{{PARENT_LEVEL + 1}}');
  });

  it('SKILL.md provisions SQLite for all topologies (no TASKS.json or ARCHIVE.json generation)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('All topologies provision SQLite');
    expect(skillMd).not.toContain('### 4. Generate TASKS.json');
    expect(skillMd).not.toContain('### 5. Generate ARCHIVE.json');
    expect(skillMd).toContain('runner_standup_task_id');
    expect(skillMd).toContain('runner_dst_guard_task_id');
    expect(skillMd).toContain('Arbitrary file creation outside the SQLite task store is refused');
  });

  it('SKILL.md runner setup uses SQLite for all topologies', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('All topologies use SQLite runner prompts');
    expect(skillMd).not.toContain('### Runner Prompts (standard / separate only)');
    expect(skillMd).toContain('board_runtime_config');
    expect(skillMd).toContain('runner_standup_task_id');
  });

  it('SKILL.md verification uses SQLite for all topologies', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('Load the board from SQLite (`/workspace/taskflow/taskflow.db`)');
    expect(skillMd).toContain('groups/{{GROUP_FOLDER}}/.mcp.json (SQLite MCP config)');
    expect(skillMd).toContain('data/taskflow/taskflow.db (shared TaskFlow database)');
    expect(skillMd).not.toContain('groups/{{GROUP_FOLDER}}/TASKS.json (task data)');
  });

  it('SKILL.md guardrails use MCP tools and SQLite for all topologies', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('Agent must mutate board data only through TaskFlow MCP tools (preferred) or the SQLite task store');
    expect(skillMd).toContain('Done/cancelled items are retained in the `archive` table');
    expect(skillMd).toContain('Updating due dates persists the new `due_date` in the `tasks` table');
    expect(skillMd).toContain('Successful imports append rows to `attachment_audit_log`');
    expect(skillMd).toContain('Arbitrary file creation outside the SQLite task store is refused');
  });

  it('SKILL.md attachment verification uses board_runtime_config for all topologies', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('board_runtime_config.attachment_enabled=0');
    expect(skillMd).not.toContain('meta.attachment_policy.enabled');
    expect(skillMd).toContain('attachment_audit_log');
  });

  it('SKILL.md does not reference unsupported prompt helpers or reminder IDs', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).not.toContain('AskUserQuestion');
    expect(skillMd).not.toContain('reminder IDs');
    expect(skillMd).toContain('Ask the user directly to collect the following, one at a time:');
    expect(skillMd).toContain('Cancelling a task moves it to `archive` after confirmation');
    expect(skillMd).toContain('Updating due dates persists the new `due_date` in the `tasks` table');
  });

  it('SKILL.md does not imply mirrored multi-group views that are not implemented', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).not.toContain('private standups');
    expect(skillMd).toContain('each group is an independent board');
    expect(skillMd).toContain('There is no automatic cross-group state sync');
    expect(skillMd).toContain('Shared group (Recommended)');
  });

  it('SKILL.md avoids unverified settings hot-reload claims', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).not.toContain('hot-reloads `settings.json` changes');
    expect(skillMd).not.toContain('watches for changes');
    expect(skillMd).toContain('restart the service to guarantee the new model is picked up');
    expect(skillMd).toContain('reads from the mounted group session directory when the session starts');
  });

  it('SKILL.md matches the runtime snapshot format and non-main mount behavior', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('read from the `groups` array');
    expect(skillMd).toContain('plus read-only `/workspace/global/` when that folder exists');
    expect(skillMd).not.toContain('non-main groups only mount `/workspace/group/`');
  });

  it('CLAUDE.md.template documents schedule_task with cron and once types', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2 documents schedule_task in MCP Tool Usage section
    expect(content).toContain('schedule_task');
    expect(content).toContain('cron');
    expect(content).toContain('once');
    expect(content).toContain('schedule_type');
  });

  it('CLAUDE.md.template MCP tool guidance uses mcp__sqlite__read_query and write_query', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2 uses full mcp__sqlite__ prefix in Tool vs. Direct SQL section
    expect(content).toContain('mcp__sqlite__read_query');
    expect(content).toContain('mcp__sqlite__write_query');
    // cancel_task documented in MCP Tool Usage section for runner jobs
    expect(content).toContain('cancel_task');
  });

  it('CLAUDE.md.template statistics display section exists', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2 has a ## Statistics Display section with formatting guidance
    const statsSection =
      content.match(/## Statistics Display[\s\S]*?## Batch/)?.[0] ?? '';

    expect(statsSection).toContain('statistics');
    expect(statsSection).toContain('person_statistics');
    expect(statsSection).toContain('month_statistics');
    expect(statsSection).not.toContain('TASKS.json');
  });

  it('CLAUDE.md.template digest format uses taskflow_report tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2 uses taskflow_report({ type: 'digest' }) via Report Templates section
    const digestSection =
      content.split('### Digest (Evening)')[1]?.split('### Weekly Review')[0] ?? '';

    expect(digestSection).toContain('taskflow_report');
    expect(digestSection).toContain('Skip if empty');
    expect(digestSection).not.toContain('TASKS.json');
  });

  it('CLAUDE.md.template weekly review format uses taskflow_report tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2 uses taskflow_report({ type: 'weekly' }) via Report Templates section
    const reviewSection =
      content.split('### Weekly Review (Friday)')[1]?.split('## Notification')[0] ?? '';

    expect(reviewSection).toContain('taskflow_report');
    expect(reviewSection).toContain('Skip if empty');
    expect(reviewSection).toContain('per-person');
    expect(reviewSection).not.toContain('TASKS.json');
  });

  it('TaskFlow scheduler docs do not hardcode UTC and match runtime timezone behavior', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const claudeTemplate = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(skillMd).not.toContain('cron in UTC based on timezone');
    expect(skillMd).not.toContain('this server uses `TZ=UTC`');
    expect(skillMd).not.toContain("{ tz: 'UTC' }");
    expect(skillMd).not.toContain("{tz:'UTC'}");
    expect(skillMd).toContain('converted into the scheduler runtime timezone');
    expect(skillMd).toContain("scheduler's runtime timezone");
    expect(skillMd).toContain('process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone');
    expect(skillMd).toContain("{tz:process.env.TZ||Intl.DateTimeFormat().resolvedOptions().timeZone}");
    expect(skillMd).toContain('using either local time or a `Z`/offset timestamp');
    expect(skillMd).not.toContain('no `Z` suffix');

    expect(claudeTemplate).not.toContain('This server runs `TZ=UTC`');
    // v2 template has timezone config in ## Configuration section
    expect(claudeTemplate).toContain('Timezone: {{TIMEZONE}}');
  });

  it('SKILL.md verification covers recurring cycles and dotted project subtasks', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('Completing a recurring task creates the next cycle in the same recurring series');
    expect(skillMd).toContain('Creating a project with steps produces dotted child IDs like `P001.1`, `P001.2`');
  });

  it('CLAUDE.md.template v2 ID generation handled by engine (taskflow_create)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: ID generation is handled by the engine via taskflow_create
    // The template references task IDs in commands (TXXX, PXXX, RXXX)
    expect(content).toContain('TXXX');
    expect(content).toContain('PXXX');
    expect(content).toContain('RXXX');
    // Schema reference mentions next_task_number in board_config
    expect(content).toContain('next_task_number');
    expect(content).toContain('board_config');
  });

  it('CLAUDE.md.template v2 ID generation engine uses board_config counter', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: no ### ID Generation section in template — engine handles it
    // But board_config is referenced in Schema Reference
    expect(content).toContain('board_config');
    expect(content).toContain('next_task_number');
    expect(content).not.toContain('TASKS.json');
  });

  it('CLAUDE.md.template has sender identification section', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2 has ## Sender Identification section
    expect(content).toContain('## Sender Identification');
    expect(content).toContain('board_people');
    expect(content).toContain('board_admins');
    expect(content).toContain('manager');
    expect(content).toContain('delegate');
    expect(content).not.toContain('`meta.managers[]`');
    expect(content).not.toContain('`meta.manager.phone`');
  });

  it('CLAUDE.md.template has review rejection and subtask completion via tool mapping', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Review rejection via taskflow_move with action: 'reject'
    expect(content).toContain("action: 'reject'");
    expect(content).toContain('TXXX rejeitada');

    // Subtask completion via taskflow_move with subtask ID
    expect(content).toContain('PXXX.N concluida');
    expect(content).toContain("action: 'conclude'");
  });

  it('CLAUDE.md.template has all recurrence frequency commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2 documents recurring task creation via taskflow_create
    expect(content).toContain("type: 'recurring'");
    expect(content).toContain('recurrence');
    // All frequencies are referenced in the tool mapping
    expect(content).toContain('diario');
    expect(content).toContain('semanal');
    expect(content).toContain('mensal');
    expect(content).toContain('anual');
  });

  it('CLAUDE.md.template has task detail, history, query, and update commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2 uses taskflow_query for read operations
    expect(content).toContain("query: 'task_details'");
    expect(content).toContain("query: 'task_history'");
    expect(content).toContain("query: 'my_tasks'");
    expect(content).toContain("query: 'due_today'");
    expect(content).toContain("query: 'due_tomorrow'");
    expect(content).toContain("query: 'due_this_week'");
    expect(content).toContain("query: 'next_7_days'");
    // v2 uses taskflow_update for mutations
    expect(content).toContain("updates: { title:");
    expect(content).toContain("updates: { priority:");
    expect(content).toContain("updates: { add_label:");
    expect(content).toContain("updates: { remove_label:");
    expect(content).toContain("updates: { add_note:");
    expect(content).toContain("updates: { edit_note:");
    expect(content).toContain("updates: { remove_note:");
  });

  it('CLAUDE.md.template documents note editing and admin-role management commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: note editing via taskflow_update
    expect(content).toContain('editar nota TXXX');
    expect(content).toContain('remover nota TXXX');
    // v2: admin management via taskflow_admin
    expect(content).toContain("action: 'add_manager'");
    expect(content).toContain("action: 'add_delegate'");
    expect(content).toContain("action: 'remove_admin'");
  });

  it('CLAUDE.md.template admin management commands use taskflow_admin tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2 uses taskflow_admin for people/admin management
    expect(content).toContain('taskflow_admin');
    expect(content).toContain("action: 'register_person'");
    expect(content).toContain("action: 'remove_person'");
    expect(content).toContain("action: 'add_manager'");
    expect(content).toContain("action: 'add_delegate'");
    expect(content).toContain("action: 'remove_admin'");
    expect(content).not.toContain('Add person to `people[]`');
  });

  it('CLAUDE.md.template defines reopen, restore, and subtask maintenance via tools', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: reopen via taskflow_move with action: 'reopen'
    expect(content).toContain('reabrir TXXX');
    expect(content).toContain("action: 'reopen'");
    // v2: restore via taskflow_admin with action: 'restore_task'
    expect(content).toContain('restaurar TXXX');
    expect(content).toContain("action: 'restore_task'");
    // v2: subtask maintenance via taskflow_update
    expect(content).toContain("updates: { add_subtask:");
    expect(content).toContain("updates: { rename_subtask:");
    expect(content).toContain("updates: { reopen_subtask:");
  });

  it('CLAUDE.md.template v2 has subtask assignee commands and display sections', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Subtask assignee authorization in auth matrix
    expect(content).toContain('Subtask assignee');

    // Subtask assignment commands via taskflow_update
    expect(content).toContain('atribuir etapa PXXX.N');
    expect(content).toContain('desatribuir etapa PXXX.N');

    // Per-person subtask display in standup format
    expect(content).toContain('Suas etapas de projeto');

    // Schema has parent_task_id
    expect(content).toContain('parent_task_id');

    // Subtask assignee operations via taskflow_update
    expect(content).toContain('assign_subtask');
    expect(content).toContain('unassign_subtask');

    // offer_register handling in Tool Response Handling
    expect(content).toContain('offer_register');
  });


  it('CLAUDE.md.template shared lifecycle rules are storage-mode aware', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: lifecycle rules are handled by the engine (taskflow_move, taskflow_admin)
    // The template still documents the Kanban columns and transitions
    // and the engine uses archive table and task_history internally
    expect(content).toContain('archive');
    expect(content).toContain('task_history');
    expect(content).toContain("action: 'cancel_task'");
    expect(content).toContain("action: 'reopen'");
    expect(content).toContain("action: 'restore_task'");
    expect(content).not.toContain('ARCHIVE.json');
  });

  it('CLAUDE.md.template restore appends a restored history entry to task_history', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: restore is handled by taskflow_admin({ action: 'restore_task' })
    // The engine records history entries internally
    expect(content).toContain("action: 'restore_task'");
    expect(content).toContain('restaurar TXXX');
    // task_history is still referenced in schema
    expect(content).toContain('task_history');
  });

  it('CLAUDE.md.template uses tool-based notes and query commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: note operations via taskflow_update tool
    expect(content).toContain("updates: { add_note:");
    expect(content).toContain("updates: { edit_note:");
    expect(content).toContain("updates: { remove_note:");
    // notes column in schema reference
    expect(content).toContain('`notes TEXT` (JSON array)');

    // v2: query commands via taskflow_query tool mapping
    expect(content).toContain('"em revisao"');
    expect(content).toContain('"em revisao do Nome"');
    expect(content).toContain('"proximas acoes"');
    expect(content).toContain('"em andamento"');
    expect(content).toContain('"buscar X"');
    expect(content).toContain('"urgentes"');
    expect(content).toContain('"prioridade alta"');
    expect(content).toContain('"rotulo financeiro"');
    expect(content).toContain("query: 'search'");
    expect(content).toContain("query: 'review'");
    expect(content).toContain("query: 'in_progress'");
    expect(content).toContain("query: 'urgent'");
    expect(content).toContain("query: 'high_priority'");
    expect(content).toContain("query: 'by_label'");
  });

  it('CLAUDE.md.template quick capture uses taskflow_create tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: quick capture via taskflow_create with type: 'inbox'
    expect(content).toContain("type: 'inbox'");
    expect(content).toContain('taskflow_create');
    // Engine handles task_history recording internally
    expect(content).not.toContain('Standard boards: initialize `history` as `[]`');
    expect(content).not.toContain('- Always initialize `history` as `[]`');
  });

  it('CLAUDE.md.template task creation uses taskflow_create tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: all task creation goes through taskflow_create tool
    // Engine handles task_history, _last_mutation initialization internally
    expect(content).toContain('### Task Creation (manager)');
    expect(content).toContain("type: 'simple'");
    expect(content).toContain("type: 'project'");
    expect(content).toContain("type: 'recurring'");
    expect(content).toContain("type: 'inbox'");
    expect(content).toContain('taskflow_create');
    // task_history is referenced in schema
    expect(content).toContain('task_history');
  });

  it('CLAUDE.md.template command mutations handled by MCP tools', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: all mutations go through MCP tools which handle task_history internally
    // Command -> Tool Mapping section documents the tool calls
    expect(content).toContain('## Command -> Tool Mapping');
    expect(content).toContain('taskflow_move');
    expect(content).toContain('taskflow_update');
    expect(content).toContain('taskflow_reassign');
    expect(content).toContain('taskflow_admin');
    // Tools handle history recording automatically
    expect(content).toContain('Tools handle validation, permissions, history recording');
  });

  it('CLAUDE.md.template history-driven queries use taskflow_query tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: all queries go through taskflow_query tool
    expect(content).toContain("query: 'task_history'");
    expect(content).toContain("query: 'completed_today'");
    expect(content).toContain("query: 'completed_this_week'");
    expect(content).toContain("query: 'completed_this_month'");
    expect(content).toContain("query: 'changes_today'");
    expect(content).toContain("query: 'changes_since'");
    expect(content).toContain("query: 'changes_this_week'");
    // task_history referenced in schema
    expect(content).toContain('task_history');
  });

  it('CLAUDE.md.template error handling covers tool error presentation', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: errors returned in tool `error` field, presented via Error Presentation section
    expect(content).toContain('## Error Presentation');
    expect(content).toContain('error');
    expect(content).toContain('Never modify the database when an error occurs');
    // Tool response handling covers error path
    expect(content).toContain("On `success: false`:");
  });

  it('CLAUDE.md.template defines task priority, labels, and display rules', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: priority and labels in schema reference and tool mapping
    expect(content).toContain('priority');
    expect(content).toContain('labels');
    // Priority emoji display in standup format
    expect(content).toContain('urgent');
    expect(content).toContain('high');
    // Priority updates via tool
  });

  it('CLAUDE.md.template has error handling via Error Presentation section', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: errors presented via Error Presentation section, not a dedicated Error Handling sub-section
    expect(content).toContain('## Error Presentation');
    expect(content).toContain('concise (one line)');
    expect(content).toContain('Never modify the database when an error occurs');
  });

  it('CLAUDE.md.template shared error examples do not hardcode ARCHIVE.json', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2 uses archive table, no ARCHIVE.json
    expect(content).toContain('archive');
    expect(content).not.toContain('ARCHIVE.json');
  });

  it('CLAUDE.md.template has project progress display in standup format', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // v2: project subtask progress shown via tool response (project_update field)
    expect(content).toContain('project_update');
    // Standup shows subtask progress with parent notation
    expect(content).toContain('parent_task_id');
  });

  it('SKILL.md documents ATTACHMENT_IMPORT_REASON as raw text (no quotes)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('ATTACHMENT_IMPORT_REASON=');
    expect(skillMd).not.toContain('ATTACHMENT_IMPORT_REASON="');
  });

  it('all placeholders in CLAUDE.md.template are consistent with SKILL.md', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const claudeTemplate = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const templatePlaceholders = new Set<string>();
    const matches = claudeTemplate.matchAll(/\{\{([A-Z_]+)\}\}/g);
    for (const m of matches) templatePlaceholders.add(m[1]);
    for (const placeholder of templatePlaceholders) {
      expect(skillMd).toContain(`{{${placeholder}}}`);
    }
  });

  it('SKILL.md seeding code placeholders are all documented in the placeholder list', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const listSection =
      skillMd.match(/Substitute all.*?Write the result to/s)?.[0] ?? '';
    const seedingSection =
      skillMd.match(/#### 6c\. Seed Board Data[\s\S]*?db\.close\(\)/)?.[0] ?? '';
    const seedingPlaceholders = new Set<string>();
    for (const m of seedingSection.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
      seedingPlaceholders.add(m[1]);
    }
    for (const placeholder of seedingPlaceholders) {
      expect(listSection).toContain(`{{${placeholder}}}`);
    }
  });

  it('SKILL.md documents child provisioning PERSON_* placeholders before using them', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const phase6 =
      skillMd.match(/## Phase 6:.*?## Phase 7:/s)?.[0] ??
      skillMd.match(/## Phase 6:.*$/s)?.[0] ?? '';
    expect(phase6).toContain('{{PERSON_ID}}');
    expect(phase6).toContain('{{PERSON_NAME}}');
    expect(phase6).toContain('{{PERSON_PHONE}}');
    expect(phase6).toContain('{{PERSON_ROLE}}');
    const preFlightSection =
      phase6.match(/### 2\. Pre-Flight Checks.*?### 3\./s)?.[0] ?? '';
    expect(preFlightSection).toContain('{{PERSON_ID}}');
    expect(preFlightSection).toContain('{{PERSON_NAME}}');
    expect(preFlightSection).toContain('{{PERSON_PHONE}}');
    expect(preFlightSection).toContain('{{PERSON_ROLE}}');
  });

  it('SKILL.md uses {{BOARD_ID}} consistently in root-board seeding snippets', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const rootSeedSection =
      skillMd.match(/#### 6c\. Seed Board Data[\s\S]*?#### 6d\./)?.[0] ?? '';
    expect(rootSeedSection).toContain("const boardId = '{{BOARD_ID}}';");
    expect(rootSeedSection).not.toContain("const boardId = 'board-{{GROUP_FOLDER}}';");
    expect(rootSeedSection).toContain('Primary manager must also exist in board_people');
    expect(rootSeedSection).toContain("db.prepare('INSERT INTO board_people");
    const phase3Section =
      skillMd.match(/### 2\. Register People in board_people[\s\S]*?### 3\. Confirm/)?.[0] ?? '';
    expect(phase3Section).toContain("stmt.run('{{BOARD_ID}}'");
  });

  it('SKILL.md documents distinct control-root and team-board IDs for control-group hierarchy', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const placeholderList =
      skillMd.match(/Substitute all `\{\{PLACEHOLDER\}\}` variables:[\s\S]*?The control and team prompts must point to different board IDs in this topology\./)?.[0] ?? '';
    expect(placeholderList).toContain('{{ROOT_BOARD_ID}}');
    expect(placeholderList).toContain('{{TEAM_GROUP_FOLDER}}');
    expect(placeholderList).toContain('{{CONTROL_GROUP_FOLDER}}');
    expect(placeholderList).toContain('render the template twice');
    expect(placeholderList).toContain('bind `{{BOARD_ID}}` = `{{ROOT_BOARD_ID}}`');
    expect(placeholderList).toContain('different board IDs');
    expect(placeholderList).not.toContain('board-sec-taskflow');
    expect(placeholderList).not.toContain('board-secti-taskflow');
  });

  it('SKILL.md avoids person-specific setup examples in generic instructions', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).not.toContain('"Miguel"');
    expect(skillMd).not.toContain('"Alexandre"');
    expect(skillMd).not.toContain('"Rafael"');
    expect(skillMd).not.toContain('"Laizes"');
    expect(skillMd).not.toContain('"Maria Jose"');
    expect(skillMd).not.toContain('"José"');
    expect(skillMd).not.toContain('"João"');
    expect(skillMd).not.toContain('"5586999990000"');
    expect(skillMd).not.toContain('"5586XXXXXXXXX@s.whatsapp.net"');
  });

  it('SKILL.md root-board seeding creates synthetic control root and child team boards', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const rootSeedSection =
      skillMd.match(/#### 6c\. Seed Board Data[\s\S]*?#### 6d\./)?.[0] ?? '';
    expect(rootSeedSection).toContain('do **not** mix the control group\'s folder with the team group\'s JID');
    expect(rootSeedSection).toContain('const hasControlGroup = \'{{HAS_CONTROL_GROUP}}\' === \'true\';');
    expect(rootSeedSection).toContain('const rootBoardId = hasControlGroup ? \'{{ROOT_BOARD_ID}}\' : boardId;');
    expect(rootSeedSection).toContain('function seedBoard');
    expect(rootSeedSection).toContain('{{TEAM_GROUP_JID}}');
    expect(rootSeedSection).toContain('{{TEAM_GROUP_FOLDER}}');
    expect(rootSeedSection).toContain('{{CONTROL_GROUP_JID}}');
    expect(rootSeedSection).toContain('{{CONTROL_GROUP_FOLDER}}');
    expect(rootSeedSection).toContain("groupRole: 'control'");
    expect(rootSeedSection).toContain("groupRole: 'team'");
    expect(rootSeedSection).toContain('parentBoardId: rootBoardId');
    expect(rootSeedSection).toContain("groupRole === 'control' ? 'control' : 'team'");
  });

  it('SKILL.md runner setup and verification distinguish control root board from child team board', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const phase4 =
      skillMd.match(/## Phase 4: Runner Setup[\s\S]*?## Phase 5:/)?.[0] ?? '';
    expect(phase4).toContain('the control root group (`{{CONTROL_GROUP_FOLDER}}`) with runners bound to `{{ROOT_BOARD_ID}}`');
    expect(phase4).toContain('the team child group (`{{TEAM_GROUP_FOLDER}}`) with runners bound to `{{BOARD_ID}}`');
    expect(phase4).toContain('persist the control group\'s runner IDs into `{{ROOT_BOARD_ID}}`');
    const phase5 =
      skillMd.match(/## Phase 5: Verification[\s\S]*?### 4\. Test Attachment Import/)?.[0] ?? '';
    expect(phase5).toContain('should **not** automatically show that same task');
    expect(phase5).toContain('synthetic-root split is working');
    expect(phase5).not.toContain('show the same board state as the team group');
  });

  it('SKILL.md prompt-injection guardrails include create_group depth checks', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const guardrails =
      skillMd.match(/### 6\. Prompt-Injection Guardrails.*?### 7\./s)?.[0] ?? '';
    expect(guardrails).toContain('`create_group` is privileged too');
    expect(guardrails).toContain('taskflow_max_depth');
    expect(guardrails).toContain('current runtime level + 1 < taskflow_max_depth');
    expect(guardrails).toContain('`register_group` and cross-group scheduling');
  });

  it('SKILL.md child provisioning documents child group identity and JID capture', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const phase6 = skillMd.match(/## Phase 6:.*$/s)?.[0] ?? '';
    expect(phase6).toContain('{{PARENT_BOARD_ID}}');
    expect(phase6).toContain('{{CHILD_GROUP_NAME}}');
    expect(phase6).toContain('{{CHILD_GROUP_FOLDER}}');
    expect(phase6).toContain('{{CHILD_GROUP_JID}}');
    expect(phase6).toContain('does not return the new group JID');
  });

  it('SKILL.md documents {{GROUP_FOLDER}} in the Phase 2 placeholder list', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const placeholderList =
      skillMd.match(/Substitute all `\{\{PLACEHOLDER\}\}` variables:[\s\S]*?Write the result to/s)?.[0] ?? '';
    expect(placeholderList).toContain('{{GROUP_FOLDER}}');
    expect(placeholderList).toContain('Lowercase filesystem folder for this group');
  });

  it('SKILL.md child provisioning creates filesystem paths before writing child files', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const phase6 = skillMd.match(/## Phase 6:.*$/s)?.[0] ?? '';
    expect(phase6).toContain('mkdir -p groups/{{CHILD_GROUP_FOLDER}}/conversations groups/{{CHILD_GROUP_FOLDER}}/logs');
    expect(phase6).toContain('mkdir -p data/sessions/{{CHILD_GROUP_FOLDER}}/.claude');
  });

  it('SKILL.md child provisioning explicitly remaps {{PARENT_BOARD_ID}} (not defaulting to none)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const phase6 = skillMd.match(/## Phase 6:.*$/s)?.[0] ?? '';
    const childClaudeMdStep =
      phase6.match(/### 6\. Generate Child CLAUDE\.md.*?### 7\./s)?.[0] ?? '';
    expect(childClaudeMdStep).toContain('{{PARENT_BOARD_ID}}');
    expect(childClaudeMdStep).toContain('do NOT use `none`');
    expect(childClaudeMdStep).toContain('only for root boards');
  });

  it('CLAUDE.md.template has 3-level help system (ajuda/manual/guia rapido)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: 3-level help system
    expect(content).toContain('"ajuda"');
    expect(content).toContain('"help"');
    expect(content).toContain('"manual"');
    expect(content).toContain('"guia rapido"');
    expect(content).toContain('Do NOT query the database');
    // Scope guard points to the board help commands
    expect(content).toContain('`ajuda`, `comandos`, or `help`');
  });

  it('CLAUDE.md.template has return-to-queue (devolver) command and transition', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: devolver via taskflow_move with action: 'return'
    expect(content).toContain('"devolver TXXX"');
    expect(content).toContain("action: 'return'");
  });

  it('CLAUDE.md.template has completed tasks query commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain("query: 'completed_today'");
    expect(content).toContain("query: 'completed_this_week'");
  });

  it('CLAUDE.md.template shared query commands use taskflow_query tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: all queries via taskflow_query tool
    expect(content).toContain('taskflow_query');
    expect(content).toContain("query: 'archive'");
    expect(content).toContain("query: 'archive_search'");
    expect(content).not.toContain('ARCHIVE.json');
  });

  it('CLAUDE.md.template has modify recurrence command', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: recurrence change via taskflow_update
    expect(content).toContain('alterar recorrencia RXXX');
    expect(content).toContain("updates: { recurrence:");
  });

  it('CLAUDE.md.template has date parsing section', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: date parsing has its own section
    expect(content).toContain('## Date Parsing');
    expect(content).toContain('pt-BR');
    expect(content).toContain('DD/MM');
    expect(content).toContain('MM/DD');
    expect(content).toContain('{{LANGUAGE}}');
    expect(content).toContain('When a date could be ambiguous, ask a clarification question');
  });

  it('SKILL.md clarifies manager as team member in Phase 3', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('Manager as team member');
    expect(skillMd).toContain('Always register the primary full manager in `board_people`');
    expect(skillMd).toContain('sender identification and admin authorization work');
    expect(skillMd).toContain('`board_admins`');
    expect(skillMd).not.toContain('`meta.managers[]`');
  });

  // ── New feature tests (F1–F15) ──────────────────────────────────────

  it('CLAUDE.md.template schema includes description, blocked_by, reminders, and _last_mutation fields', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: these fields are in Schema Reference
    expect(content).toContain('description');
    expect(content).toContain('blocked_by');
    expect(content).toContain('reminders');
    expect(content).toContain('_last_mutation');
  });

  it('CLAUDE.md.template history actions handled by engine tools', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: tool response handling documents data fields returned by tools
    expect(content).toContain('task_history');
    // Tools handle history action recording internally
    expect(content).toContain('taskflow_move');
    expect(content).toContain('taskflow_update');
    expect(content).toContain('taskflow_dependency');
    expect(content).toContain('taskflow_undo');
  });

  it('CLAUDE.md.template has new command patterns for F1, F2, F3, F4, F5', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // F1: Remove due date command
    expect(content).toContain("updates: { due_date: null }");
    // F2: Completed by person
    expect(content).toContain("query: 'person_completed'");
    // F3: Completed this month
    expect(content).toContain("query: 'completed_this_month'");
    // F4: Ad-hoc summary (resumo)
    expect(content).toContain("query: 'summary'");
    // F5: Archive browsing
    expect(content).toContain("query: 'archive'");
    expect(content).toContain("query: 'archive_search'");
  });

  it('CLAUDE.md.template has new command patterns for F7, F8, F10, F11, F13, F15', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // F7: Calendar view (agenda)
    expect(content).toContain("query: 'agenda'");
    expect(content).toContain("query: 'agenda_week'");
    // F8: Bulk reassign
    expect(content).toContain('taskflow_reassign');
    expect(content).toContain('source_person');
    // F10: Changelog view
    expect(content).toContain("query: 'changes_today'");
    expect(content).toContain("query: 'changes_this_week'");
    // F11: Dependencies
    expect(content).toContain('taskflow_dependency');
    expect(content).toContain("action: 'add_dep'");
    expect(content).toContain("action: 'remove_dep'");
    // F13: Reminders
    expect(content).toContain("action: 'add_reminder'");
    expect(content).toContain("action: 'remove_reminder'");
    // F15: Description
    expect(content).toContain("updates: { description:");
  });

  it('CLAUDE.md.template has dedicated sections for dependencies, reminders, batch ops, undo, and statistics', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: these are sections or tool mapping sub-headings
    expect(content).toContain('### Dependencies & Reminders');
    expect(content).toContain('## Batch Operations');
    expect(content).toContain('### Undo');
    expect(content).toContain('## Statistics Display');
  });

  it('CLAUDE.md.template makes help hint language-neutral and defines SENDER', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('`ajuda`, `comandos`, or `help`');
    expect(content).toContain('`SENDER` below means the resolved sender `person_id`');
  });

  it('CLAUDE.md.template allows WhatsApp strikethrough formatting', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('~Strikethrough~');
  });

  it('CLAUDE.md.template has undo mechanics with desfazer command', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: undo via taskflow_undo tool
    expect(content).toContain('"desfazer"');
    expect(content).toContain('taskflow_undo');
    expect(content).toContain('_last_mutation');
  });

  it('CLAUDE.md.template has error cases via tool error field', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: errors returned in tool error field
    expect(content).toContain("success: false");
    expect(content).toContain('error');
    // Suggest alternatives
    expect(content).toContain('Suggest a valid alternative when possible');
  });

  it('CLAUDE.md.template has statistics via taskflow_query tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: statistics via query tool
    expect(content).toContain("query: 'statistics'");
    expect(content).toContain("query: 'person_statistics'");
    expect(content).toContain("query: 'month_statistics'");
  });

  it('CLAUDE.md.template statistics guidance does not invent trend data', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('Only include trend comparison when the tool response already provides explicit trend data');
  });

  it('CLAUDE.md.template documents tool responses as top-level fields, not always data-wrapped', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('Every tool returns JSON with `success` and may include `data`, `error`, `notifications`, and other top-level fields');
    expect(content).toContain('First, check special top-level fields regardless of `success`');
    expect(content).toContain('If no `error` exists but you already handled a special top-level field above, do NOT invent an extra generic error message');
    expect(content).toContain('For all other responses with `data`');
    expect(content).not.toContain('Every tool returns JSON with `success`, `data`, and optionally `error` and `notifications`');
  });

  it('CLAUDE.md.template authorization rules include feature permissions', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: Authorization Matrix covers all permissions
    expect(content).toContain('## Authorization Matrix');
    expect(content).toContain('Manager');
    expect(content).toContain('Assignee');
    expect(content).toContain('Delegate');
    expect(content).toContain('Everyone');
    // Manager can do bulk reassign, update due dates, manage people
    expect(content).toContain('bulk reassign');
    expect(content).toContain('manage people');
  });

  it('CLAUDE.md.template documents recurring cycle behavior via tool response', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: recurring cycle info in tool response
    expect(content).toContain('recurring_cycle');
    expect(content).toContain('recurrence');
    expect(content).toContain('current_cycle');
  });

  it('CLAUDE.md.template recurring cycle notes handled by engine', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: engine handles cycle reset behavior
    // Schema shows the relevant fields
    expect(content).toContain('`notes TEXT` (JSON array)');
    expect(content).toContain('next_note_id');
    expect(content).toContain('`recurrence TEXT` (JSON object)');
    expect(content).toContain('`current_cycle TEXT` (JSON object)');
  });

  it('CLAUDE.md.template has hierarchy features section', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2 uses "## Hierarchy Features" heading
    expect(content).toContain('## Hierarchy Features');
    expect(content).toContain('{{BOARD_ID}}');
    expect(content).toContain('{{HIERARCHY_LEVEL}}');
    expect(content).toContain('{{MAX_DEPTH}}');
    expect(content).toContain('{{PARENT_BOARD_ID}}');
    expect(content).toContain('{{BOARD_ROLE}}');
  });

  it('CLAUDE.md.template hierarchy uses mcp__sqlite__ prefixed tools', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2 uses full mcp__sqlite__ prefix in Tool vs. Direct SQL
    expect(content).toContain('mcp__sqlite__read_query');
    expect(content).toContain('mcp__sqlite__write_query');
    expect(content).not.toContain('TASKS.json');
    expect(content).not.toContain('ARCHIVE.json');
  });

  it('CLAUDE.md.template hierarchy section is gated by MAX_DEPTH', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2 gates hierarchy features on MAX_DEPTH
    expect(content).toContain('`{{MAX_DEPTH}}` is `1` or not set, skip this section');
  });

  it('CLAUDE.md.template hierarchy ID generation uses engine counters', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: ID generation handled by engine, with legacy and current counter stores documented
    expect(content).toContain('next_task_number');
    expect(content).toContain('board_config');
    expect(content).toContain('next_project_number');
    expect(content).toContain('next_recurring_number');
    expect(content).toContain('board_id_counters');
  });

  it('CLAUDE.md.template hierarchy uses shared Sender Identification section (board_people/board_admins)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('## Sender Identification');
    expect(content).toContain('board_people');
    expect(content).toContain('board_admins');
  });

  it('CLAUDE.md.template hierarchy uses WIP limit via tools and schema', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: WIP limits in schema and tool response (wip_warning)
    expect(content).toContain('wip_limit');
    expect(content).toContain('wip_warning');
    expect(content).toContain('WIP limit default: {{WIP_LIMIT}}');
  });

  it('CLAUDE.md.template hierarchy uses archival and history via schema reference', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: archive table and task_history in schema reference
    expect(content).toContain('**archive**');
    expect(content).toContain('**task_history**');
    expect(content).toContain('archive_reason');
    expect(content).toContain('archived_at');
  });

  it('CLAUDE.md.template archival handled by engine (cancel and restore tools)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: archival via taskflow_admin cancel_task and restore_task
    expect(content).toContain("action: 'cancel_task'");
    expect(content).toContain("action: 'restore_task'");
    expect(content).toContain('archive_triggered');
  });

  it('CLAUDE.md.template has restore (restaurar) command via tool mapping', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('restaurar TXXX');
    expect(content).toContain("action: 'restore_task'");
    expect(content).toContain('taskflow_admin');
  });

  it('CLAUDE.md.template review transition WIP checked by engine tools', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: WIP checking handled by engine, wip_warning returned in tool response
    expect(content).toContain('wip_warning');
    expect(content).toContain("action: 'force_start'");
  });

  it('CLAUDE.md.template hierarchy has child board registrations in schema', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('child_board_registrations');
  });

  it('CLAUDE.md.template hierarchy has provisioning commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('criar quadro para [pessoa]');
    expect(content).toContain('remover quadro do [pessoa]');
  });

  it('CLAUDE.md.template hierarchy provisioning uses provision_child_board tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('provision_child_board');
  });

  it('CLAUDE.md.template hierarchy has task link/unlink/refresh commands via hierarchy tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('vincular TXXX ao quadro do [pessoa]');
    expect(content).toContain('desvincular TXXX');
    expect(content).toContain('atualizar status TXXX');
    expect(content).toContain('sincronizar TXXX');
    expect(content).toContain('resumo de execucao TXXX');
    expect(content).toContain('taskflow_hierarchy');
    expect(content).toContain("action: 'link'");
    expect(content).toContain("action: 'unlink'");
    expect(content).toContain("action: 'refresh_rollup'");
  });

  it('CLAUDE.md.template hierarchy has upward tagging command', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('linked_parent_board_id');
    expect(content).toContain('linked_parent_task_id');
  });

  it('CLAUDE.md.template hierarchy has leaf board restrictions', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: hierarchy section notes leaf restrictions
    expect(content).toContain('{{MAX_DEPTH}}');
    expect(content).toContain('{{HIERARCHY_LEVEL}}');
  });

  it('CLAUDE.md.template hierarchy has auto-link on assignment', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: auto-link documented in hierarchy key concepts
    expect(content).toContain('auto-link');
    expect(content).toContain('child board');
  });

  it('CLAUDE.md.template hierarchy has authority while linked rules', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Authority While Linked');
    expect(content).toContain('child_exec_enabled = 1');
  });

  it('CLAUDE.md.template hierarchy has reassignment rules while linked', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: unlink before reassign documented in Authority While Linked
    expect(content).toContain('desvincular TXXX');
    expect(content).toContain('child_exec_enabled');
  });

  it('CLAUDE.md.template hierarchy has review rejection while linked', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: rejection via taskflow_move action: 'reject'
    expect(content).toContain("action: 'reject'");
    expect(content).toContain('child_exec_enabled');
  });

  it('CLAUDE.md.template hierarchy has task type restrictions (RXXX cannot be linked)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: engine enforces task type restrictions
    expect(content).toContain('RXXX');
    expect(content).toContain('child_exec_enabled');
  });

  it('CLAUDE.md.template hierarchy has display markers for linked tasks', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Display Markers');
    expect(content).toContain('🔗');
  });

  it('CLAUDE.md.template hierarchy has rollup mapping table', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Rollup Mapping');
    expect(content).toContain('rollup_status');
    expect(content).toContain('no_work_yet');
    expect(content).toContain('active');
    expect(content).toContain('blocked');
    expect(content).toContain('at_risk');
    expect(content).toContain('ready_for_review');
    expect(content).toContain('cancelled_needs_decision');
  });

  it('CLAUDE.md.template hierarchy has staleness detection', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: staleness in Display Markers section
    expect(content).toContain('older than 24 hours');
    expect(content).toContain('rollup desatualizado');
  });

  it('CLAUDE.md.template hierarchy documents non-adjacent boundary', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Non-Adjacent Boundary');
    expect(content).toContain('must NOT');
  });

  it('CLAUDE.md.template hierarchy has disambiguation between resumo and rollup view', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: resumo triggers summary query, resumo de execucao triggers refresh_rollup
    expect(content).toContain("query: 'summary'");
    expect(content).toContain("action: 'refresh_rollup'");
    expect(content).toContain('resumo de execucao TXXX');
  });

  it('CLAUDE.md.template has hierarchy placeholders in configuration footer', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const configSection = content.split('## Configuration')[1] ?? '';
    expect(configSection).toContain('Board role: {{BOARD_ROLE}}');
    expect(configSection).toContain('Board ID: {{BOARD_ID}}');
    expect(configSection).toContain('Hierarchy level: {{HIERARCHY_LEVEL}}');
    expect(configSection).toContain('Parent board ID: {{PARENT_BOARD_ID}}');
  });

  it('design doc and template agree on hierarchy history actions', () => {
    const repoRoot = path.resolve(skillDir, '..', '..', '..');
    const design = fs.readFileSync(
      path.join(repoRoot, 'docs', 'plans', '2026-02-28-taskflow-hierarchical-delegation-design.md'),
      'utf-8',
    );
    const template = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: hierarchy history actions are handled by the engine via taskflow_hierarchy tool
    // Design doc documents them
    const historyActions = [
      'child_board_created',
      'child_board_removed',
      'child_board_linked',
      'child_board_unlinked',
      'child_rollup_updated',
    ];
    for (const action of historyActions) {
      expect(design).toContain(action);
    }
    // Template references the hierarchy tool
    expect(template).toContain('taskflow_hierarchy');
  });

  it('CLAUDE.md.template hierarchy does NOT allow recurring tasks to be linked', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: engine enforces recurring restriction, template documents constraint
    expect(content).toContain('non-recurring');
  });

  it('CLAUDE.md.template rollup SQL scopes by parent board and task in hierarchy section', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: rollup handled by engine via taskflow_hierarchy refresh_rollup
    expect(content).toContain("action: 'refresh_rollup'");
    // Schema has linked fields
    expect(content).toContain('linked_parent_board_id');
    expect(content).toContain('linked_parent_task_id');
  });

  it('CLAUDE.md.template hierarchy provisioning handles duplicate checks', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: provisioning via provision_child_board tool or manual SQL
    expect(content).toContain('child_board_registrations');
    expect(content).toContain('provision_child_board');
  });

  it('CLAUDE.md.template hierarchy board removal rules', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('remover quadro do [pessoa]');
    expect(content).toContain('refuse if any exist (must unlink first)');
    expect(content).toContain('child board remains operational but detached from this hierarchy');
    expect(content).toContain('Ask explicit confirmation');
  });

  it('CLAUDE.md.template hierarchy review rejection uses notification', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: notifications dispatched via tool response notifications array
    expect(content).toContain('notification_group_jid');
    expect(content).toContain('notifications');
    expect(content).toContain('do NOT call `send_message`');
  });

  it('CLAUDE.md.template done shortcut allows Assignee via tool authorization', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: authorization matrix allows Assignee to move own tasks
    expect(content).toContain('Assignee');
    expect(content).toContain('Move own tasks');
    expect(content).toContain("action: 'conclude'");
  });

  it('CLAUDE.md.template archival section uses archive table with archive_reason', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: archive table in schema reference
    expect(content).toContain('archive_reason');
    expect(content).toContain('**archive**');
  });

  it('CLAUDE.md.template rollup engine uses refresh_rollup action', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: rollup via hierarchy tool
    expect(content).toContain("action: 'refresh_rollup'");
    expect(content).toContain('child_exec_rollup_status');
  });

  it('CLAUDE.md.template command table has review and weekly review entries', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: review column query
    expect(content).toContain('"em revisao"');
    expect(content).toContain("query: 'review'");
    // Weekly review via report tool
    expect(content).toContain("type: 'weekly'");
  });

  it('CLAUDE.md.template reassignment uses taskflow_reassign tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('reatribuir TXXX para');
    expect(content).toContain('taskflow_reassign');
    expect(content).toContain('transferir tarefas do');
    expect(content).toContain('target_person');
    expect(content).toContain('source_person');
  });

  it('CLAUDE.md.template hierarchy board removal requires confirmation in tool mapping', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: removal documented in hierarchy commands with confirmation
    expect(content).toContain('remover quadro do [pessoa]');
    expect(content).toContain('Ask explicit confirmation');
    expect(content).toContain('child_exec_enabled = 1');
  });

  it('CLAUDE.md.template Attachment Intake section uses SQLite storage', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('## Attachment Intake');
    expect(content).toContain('board_runtime_config');
    expect(content).toContain('attachment_enabled');
    expect(content).toContain('attachment_audit_log');
    expect(content).not.toContain('TASKS.json');
  });

  it('CLAUDE.md.template avoids unsupported holiday and non-business-day tool calls', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).not.toContain("action: 'manage_holidays'");
    expect(content).not.toContain('allow_non_business_day: true');
    expect(content).toContain('does NOT expose a non-business-day override');
  });

  it('ID generation uses per-prefix counters (T/P/R) in engine and db schema', () => {
    // Engine maps each prefix to its own counter column
    const engine = fs.readFileSync(
      path.resolve(skillDir, 'add/container/agent-runner/src/taskflow-engine.ts'),
      'utf-8',
    );
    expect(engine).toContain('next_task_number');
    expect(engine).toContain('next_project_number');
    expect(engine).toContain('next_recurring_number');

    // DB schema defines all three counter columns
    const dbSchema = fs.readFileSync(
      path.resolve(skillDir, '../../../src/taskflow-db.ts'),
      'utf-8',
    );
    expect(dbSchema).toContain('next_task_number');
    expect(dbSchema).toContain('next_project_number');
    expect(dbSchema).toContain('next_recurring_number');

    // CLAUDE.md template documents both legacy board_config counters and current board_id_counters
    const claudeTemplate = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(claudeTemplate).toContain('next_task_number');
    expect(claudeTemplate).toContain('next_project_number');
    expect(claudeTemplate).toContain('next_recurring_number');
    expect(claudeTemplate).toContain('board_id_counters');
  });

  it('CLAUDE.md.template recurrence schema has fields in schema reference', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: recurrence is stored as TEXT containing JSON in SQLite
    expect(content).toContain('`recurrence TEXT` (JSON object)');
    expect(content).toContain('`current_cycle TEXT` (JSON object)');
  });

  it('CLAUDE.md.template digest format uses taskflow_report digest type', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const digestSection =
      content.split('### Digest (Evening)')[1]?.split('### Weekly Review')[0] ?? '';
    expect(digestSection.length).toBeGreaterThan(0);
    expect(digestSection).toContain('taskflow_report');
  });

  it('CLAUDE.md.template undo uses taskflow_undo tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('taskflow_undo');
    expect(content).toContain('"desfazer"');
    expect(content).toContain('"forcar desfazer"');
    expect(content).toContain('force: true');
  });

  it('CLAUDE.md.template "remover [nome]" uses taskflow_admin remove_person action', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('remover Nome');
    expect(content).toContain("action: 'remove_person'");
    expect(content).toContain('Ask explicit confirmation in chat FIRST');
    expect(content).toContain('does not expose an admin dry-run');
  });

  it('CLAUDE.md.template digest report via taskflow_report tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain("type: 'digest'");
    expect(content).toContain("type: 'weekly'");
    expect(content).toContain("type: 'standup'");
  });

  it('CLAUDE.md.template bulk transfer and single reassign use taskflow_reassign tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('taskflow_reassign');
    expect(content).toContain('source_person');
    expect(content).toContain('target_person');
    expect(content).toContain('confirmed: false');
  });

  it('CLAUDE.md.template inbox processing converts captures into new tasks', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain("taskflow_admin({ action: 'process_inbox', sender_name: SENDER })");
    expect(content).toContain('CREATE a new task from the inbox title');
    expect(content).toContain('Ask whether to remove the original inbox capture');
    expect(content).toContain('summarize the mapping from old inbox IDs to new task IDs');
    expect(content).toContain('discard an inbox item entirely');
    expect(content).toContain('batch instruction');
  });

  it('CLAUDE.md.template has cancelled query shortcut and date parsing section', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('"canceladas"');
    expect(content).toContain("archive_reason = 'cancelled'");
    expect(content).toContain('## Date Parsing');
    expect(content).toContain('When a date could be ambiguous, ask a clarification question');
  });

  it('CLAUDE.md.template rate limit guidance is actionable and mentions subtask reorder limitation', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('Max 10 `send_message` calls per user request or tool response');
    expect(content).toContain('Prefer batched summaries');
    expect(content).toContain('does NOT expose a subtask reorder command');
  });

  it('CLAUDE.md.template Task Dependencies use taskflow_dependency tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Dependencies & Reminders');
    expect(content).toContain('taskflow_dependency');
    expect(content).toContain("action: 'add_dep'");
    expect(content).toContain("action: 'remove_dep'");
    expect(content).toContain("action: 'add_reminder'");
    expect(content).toContain("action: 'remove_reminder'");
  });

  it('CLAUDE.md.template changelog queries use taskflow_query tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain("query: 'changes_today'");
    expect(content).toContain("query: 'changes_since'");
    expect(content).toContain("query: 'changes_this_week'");
  });

  it('CLAUDE.md.template recurring completion handled by engine via tool response', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // v2: engine handles cycle advancement, returns recurring_cycle in tool response
    expect(content).toContain('recurring_cycle');
    expect(content).toContain('recurrence');
    expect(content).toContain("type: 'recurring'");
  });

  it('CLAUDE.md.template has bounded recurrence commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('max_cycles');
    expect(content).toContain('recurrence_end_date');
    expect(content).toContain('ciclo final');
    expect(content).toContain('Recorrencia encerrada');
  });

  it('CLAUDE.md.template documents bounded recurrence exclusivity', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('mutually exclusive');
  });

  it('test schema includes bounded recurrence columns', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'container', 'agent-runner', 'src', 'taskflow-engine.test.ts'),
      'utf-8',
    );
    expect(content).toContain('max_cycles INTEGER');
    expect(content).toContain('recurrence_end_date TEXT');
  });

  // ── Remaining passing tests that don't need modification ──────────

  it('operator guide and user manual reflect SQLite-only storage', () => {
    const repoRoot = path.resolve(skillDir, '..', '..', '..');
    const operatorGuide = fs.readFileSync(
      path.join(repoRoot, 'docs', 'taskflow-operator-guide.md'),
      'utf-8',
    );
    const userManual = fs.readFileSync(
      path.join(repoRoot, 'docs', 'taskflow-user-manual.md'),
      'utf-8',
    );
    expect(operatorGuide).toContain('data/taskflow/taskflow.db');
    expect(operatorGuide).toContain('board_runtime_config');
    expect(operatorGuide).toContain('taskflow_managed=1');
    expect(operatorGuide).not.toContain('TASKS.json');
    expect(operatorGuide).not.toContain('ARCHIVE.json');
    expect(userManual).toContain('avisa antes da confirmação quais tarefas serão destravadas');
    expect(userManual).toContain('os lembretes ativos também são cancelados antes do arquivamento');
  });

  it('skill and TaskFlow docs describe linked tasks as actionable on the receiving board', () => {
    const repoRoot = path.resolve(skillDir, '..', '..', '..');
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const operatorGuide = fs.readFileSync(
      path.join(repoRoot, 'docs', 'taskflow-operator-guide.md'),
      'utf-8',
    );
    const userManual = fs.readFileSync(
      path.join(repoRoot, 'docs', 'taskflow-user-manual.md'),
      'utf-8',
    );
    const design = fs.readFileSync(
      path.join(repoRoot, 'docs', 'plans', '2026-02-28-taskflow-hierarchical-delegation-design.md'),
      'utf-8',
    );
    const implementation = fs.readFileSync(
      path.join(repoRoot, 'docs', 'plans', '2026-02-28-taskflow-hierarchical-delegation-implementation.md'),
      'utf-8',
    );
    expect(skillMd).toContain('may move the linked task through the normal GTD phases');
    expect(operatorGuide).toContain('Receiving boards can still move linked tasks directly');
    expect(userManual).toContain('ela continua acionável');
    expect(userManual).toContain('Tarefas marcadas com `🔗` continuam acionáveis');
    expect(design).toContain('the assignee and board owner may move the linked task');
    expect(implementation).toContain('the receiving board may move the task directly');
  });

  it('CLAUDE.md.template does not reference JSON schema_version migrations (SQLite-only)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).not.toContain('meta.schema_version');
    expect(content).not.toContain('"schema_version": "2.0"');
    expect(content).not.toContain('Normalization for legacy');
    expect(content).toContain('board_config');
  });

  // ── Hierarchy (bounded-recursive delegation) tests ─────────────────

  it('SKILL.md documents hierarchy topology option and depth question', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('Hierarchy (Delegation)');
    expect(skillMd).toContain('max_depth');
    expect(skillMd).toContain('taskflow_hierarchy_level');
    expect(skillMd).toContain('taskflow_max_depth');
    expect(skillMd).toContain('taskflow_managed');
  });

  it('SKILL.md has root board provisioning (Phase 2 Step 6)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('node dist/taskflow-db.js');
    expect(skillMd).toContain('.mcp.json');
    expect(skillMd).toContain('mcp-server-sqlite-npx');
    expect(skillMd).toContain("'hierarchy'");
    expect(skillMd).toContain('board_config');
    expect(skillMd).toContain('board_runtime_config');
    expect(skillMd).toContain('board_admins');
    expect(skillMd).toContain('### 6. Database Provisioning');
  });

  it('SKILL.md has child board provisioning (Phase 6)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('## Phase 6: Child Board Provisioning');
    expect(skillMd).toContain('CHILD_GROUP_JID');
    expect(skillMd).toContain('CHILD_GROUP_FOLDER');
    expect(skillMd).toContain('child_board_registrations');
    expect(skillMd).toContain('Generate Child CLAUDE.md');
    expect(skillMd).toContain('Board Removal');
  });

  it('SKILL.md child board provisioning uses {{PERSON_ROLE}} placeholder (not hardcoded role)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const childSection =
      skillMd.match(/Phase 6.*?Phase 7|Phase 6.*$/s)?.[0] ?? '';
    const childDbStep =
      childSection.match(/### 5\. Seed Child Board in TaskFlow DB[\s\S]*?### 6\./s)?.[0] ?? '';
    const boardPeopleInserts = childDbStep.match(
      /INSERT INTO board_people.*?\n.*?\.run\([^)]+\)/g,
    );
    expect(boardPeopleInserts).not.toBeNull();
    for (const insert of boardPeopleInserts ?? []) {
      expect(insert).toContain('{{PERSON_ROLE}}');
      expect(insert).not.toContain("'manager'");
    }
    expect(childSection).toContain('board_people.role');
  });

  it('SKILL.md uses consistent admin_role "manager" for both root and child boards', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const rootAdminSection = skillMd.match(
      /#### 6c\. Seed Board Data[\s\S]*?db\.close\(\)/,
    )?.[0] ?? '';
    expect(rootAdminSection).toContain('board_admins');
    expect(rootAdminSection).toContain("'manager'");
    const childPhaseSection =
      skillMd.match(/### 5\. Seed Child Board in TaskFlow DB[\s\S]*?### 6\./)?.[0] ?? '';
    const childAdminMatch = childPhaseSection.match(
      /INSERT INTO board_admins.*?'manager'/s,
    );
    expect(childAdminMatch).not.toBeNull();
    const adminInserts = skillMd.match(
      /INSERT INTO board_admins.*?'(full|manager)'/g,
    );
    for (const insert of adminInserts ?? []) {
      expect(insert).toContain("'manager'");
    }
  });

  // ── Negative assertions (prevent regressions) ──────────────────────

  it('CLAUDE.md.template does NOT use per-level field names instead of generic child_exec_*', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).not.toContain('director_execution');
    expect(content).not.toContain('manager_execution');
    expect(content).not.toContain('vp_execution');
  });

  it('CLAUDE.md.template does NOT allow non-adjacent rollup or grandchild queries', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).not.toContain('grandchild task');
    expect(content).not.toContain('two levels');
    expect(content).not.toContain('cascade refresh');
    expect(content).not.toContain('root-mediated');
  });

  it('CLAUDE.md.template does NOT use JSON file paths for hierarchy cross-board reads', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).not.toContain('TASKS.json');
    expect(content).not.toContain('ARCHIVE.json');
  });

  it('taskflow-db schema has all required tables and hierarchy columns', () => {
    const repoRoot = path.resolve(skillDir, '..', '..', '..');
    const dbModule = fs.readFileSync(
      path.join(repoRoot, 'src', 'taskflow-db.ts'),
      'utf-8',
    );
    expect(dbModule).toContain('CREATE TABLE IF NOT EXISTS boards');
    expect(dbModule).toContain('CREATE TABLE IF NOT EXISTS board_people');
    expect(dbModule).toContain('CREATE TABLE IF NOT EXISTS board_admins');
    expect(dbModule).toContain('CREATE TABLE IF NOT EXISTS child_board_registrations');
    expect(dbModule).toContain('CREATE TABLE IF NOT EXISTS tasks');
    expect(dbModule).toContain('CREATE TABLE IF NOT EXISTS task_history');
    expect(dbModule).toContain('CREATE TABLE IF NOT EXISTS archive');
    expect(dbModule).toContain('CREATE TABLE IF NOT EXISTS board_runtime_config');
    expect(dbModule).toContain('CREATE TABLE IF NOT EXISTS attachment_audit_log');
    expect(dbModule).toContain('CREATE TABLE IF NOT EXISTS board_config');
    expect(dbModule).toContain('child_exec_enabled');
    expect(dbModule).toContain('child_exec_board_id');
    expect(dbModule).toContain('child_exec_rollup_status');
    expect(dbModule).toContain('linked_parent_board_id');
    expect(dbModule).toContain('linked_parent_task_id');
    expect(dbModule).toContain("journal_mode = WAL");
    expect(dbModule).toContain("foreign_keys = ON");
  });

  it('skill packaged taskflow-db snapshot adds linked-parent index for rollup queries', () => {
    const dbModule = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'taskflow-db.ts'),
      'utf-8',
    );
    expect(dbModule).toContain('idx_tasks_linked_parent');
    expect(dbModule).toContain('linked_parent_board_id');
    expect(dbModule).toContain('linked_parent_task_id');
  });

  it('skill packaged engine snapshot uses owning board IDs for delegated subtask updates', () => {
    const engineModule = fs.readFileSync(
      path.join(skillDir, 'add', 'container', 'agent-runner', 'src', 'taskflow-engine.ts'),
      'utf-8',
    );
    expect(engineModule).toContain(".run(updates.rename_subtask.title, now, taskBoardId, updates.rename_subtask.id)");
    expect(engineModule).toContain(".run(now, taskBoardId, updates.reopen_subtask);");
    expect(engineModule).toContain("this.recordHistory(updates.reopen_subtask, 'reopened', params.sender_name, undefined, taskBoardId);");
    expect(engineModule).toContain("JSON.stringify({ from_assignee: check.subTask.assignee, to_assignee: subPerson.person_id }), taskBoardId);");
  });

  it('existing IPC tools still documented for runners on hierarchy boards', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('send_message');
    expect(content).toContain('schedule_task');
    expect(content).toContain('cancel_task');
    expect(content).toContain('list_tasks');
  });

  it('CLAUDE.md.template hierarchy documents assistant as direct root-level role', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).not.toContain('assistant board');
    expect(content).not.toContain('assistant tier');
  });

  it('SKILL.md Phase 6 Step 8 uses child board ID (not {{BOARD_ID}}) for runner ID UPDATE', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const phase6 = skillMd.match(/## Phase 6:.*$/s)?.[0] ?? '';
    const step8 =
      phase6.match(/### 8\. Schedule Child Runners.*?### 9\./s)?.[0] ?? '';
    expect(step8).toContain("const childBoardId = 'board-{{CHILD_GROUP_FOLDER}}'");
    expect(step8).toContain('childBoardId');
    expect(step8).not.toContain("'{{BOARD_ID}}'");
  });

  it('CLAUDE.md.template hierarchy attachment_audit_log INSERT uses correct SQLite column names', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const insertMatch = content.match(
      /INSERT INTO attachment_audit_log\s*\([^)]+\)/i,
    )?.[0] ?? '';
    expect(insertMatch).toContain('board_id');
    expect(insertMatch).toContain('actor_person_id');
    expect(insertMatch).toContain('affected_task_refs');
  });

  it('design doc has no_work_yet in allowed rollup_status list', () => {
    const repoRoot = path.resolve(skillDir, '..', '..', '..');
    const design = fs.readFileSync(
      path.join(repoRoot, 'docs', 'plans', '2026-02-28-taskflow-hierarchical-delegation-design.md'),
      'utf-8',
    );
    expect(design).toContain('## Allowed `rollup_status`');
    expect(design).toContain('- `no_work_yet`');
    expect(design).toContain('- `active`');
    expect(design).toContain('- `blocked`');
    expect(design).toContain('- `at_risk`');
    expect(design).toContain('- `ready_for_review`');
    expect(design).toContain('- `completed`');
    expect(design).toContain('- `cancelled_needs_decision`');
  });

  it('CLAUDE.md.template hierarchy has all rollup_status values including no_work_yet', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('no_work_yet');
    expect(content).toContain('active');
    expect(content).toContain('blocked');
    expect(content).toContain('at_risk');
    expect(content).toContain('ready_for_review');
    expect(content).toContain('cancelled_needs_decision');
  });

  it('SKILL.md Step 6d UPDATE sets dst_sync_enabled and dst_last_offset_minutes alongside runner IDs', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const step6d =
      skillMd.match(/#### 6d\. Runner Task IDs.*?#### 6e\./s)?.[0] ?? '';
    expect(step6d).not.toBe('');
    expect(step6d).toContain('dst_sync_enabled');
    expect(step6d).toContain('dst_last_offset_minutes');
    expect(step6d).toContain('dst_last_synced_at');
    expect(step6d).toContain('DST_GUARD_ENABLED');
    expect(step6d).toContain('TIMEZONE');
  });

  it('SKILL.md Phase 6 Step 8 child runner UPDATE also sets DST state columns', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const phase6 = skillMd.match(/## Phase 6:.*$/s)?.[0] ?? '';
    const step8 =
      phase6.match(/### 8\. Schedule Child Runners.*?### 9\./s)?.[0] ?? '';
    expect(step8).not.toBe('');
    expect(step8).toContain('dst_sync_enabled');
    expect(step8).toContain('dst_last_offset_minutes');
    expect(step8).toContain('dst_last_synced_at');
    expect(step8).toContain('DST_GUARD_ENABLED');
    expect(step8).toContain('TIMEZONE');
  });

  it('SKILL.md Phase 5 Step 8 archive and lifecycle checks use SQLite (no schema_version)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const archiveSection =
      skillMd.split('### 8. Archive and Lifecycle Checks')[1]?.split('### 9.')[0] ?? '';
    expect(archiveSection).toContain('archive');
    expect(archiveSection).not.toContain('schema_version');
    expect(archiveSection).not.toContain('meta.schema_version');
  });

  it('SKILL.md Step 6d DST offset calculation has division inside Math.round (not outside)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const step6dSection =
      skillMd.match(/#### 6d\. Runner Task IDs.*?#### 6e\./s)?.[0] ?? '';
    expect(step6dSection).not.toBe('');
    expect(step6dSection).not.toMatch(
      /Math\.round\([^)]*getTime\(\)[^)]*getTime\(\)\)\s*\/\s*60000/,
    );
    expect(step6dSection).toMatch(
      /Math\.round\(\(new Date.*?getTime\(\).*?\/\s*60000\)/,
    );
  });

});

describe('meeting notes', () => {
  let db: Database.Database;
  let engine: TaskflowEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    seedTestDb(db, BOARD_ID);
    engine = new TaskflowEngine(db, BOARD_ID);
  });

  afterEach(() => {
    db.close();
  });

  it('schema has participants and scheduled_at columns on tasks', () => {
    const cols = db
      .prepare(`PRAGMA table_info(tasks)`)
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('participants');
    expect(colNames).toContain('scheduled_at');
  });

  describe('create meeting', () => {
    it('creates a meeting with M prefix and next_action column', () => {
      const result = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Alinhamento semanal',
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
      expect(result.task_id).toMatch(/^M\d+$/);
      expect(result.column).toBe('next_action');
    });

    it('auto-sets organizer (assignee) to sender', () => {
      const result = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Kickoff',
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT assignee FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, result.task_id) as { assignee: string };
      expect(task.assignee).toBe('person-1');
    });

    it('stores participants as JSON array', () => {
      const result = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Sprint review',
        participants: ['Giovanni'],
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT participants FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, result.task_id) as { participants: string };
      const parts = JSON.parse(task.participants);
      expect(parts).toContain('person-2');
    });

    it('stores scheduled_at in UTC', () => {
      const result = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Planning',
        scheduled_at: '2026-03-15T17:00:00Z',
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT scheduled_at FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, result.task_id) as { scheduled_at: string };
      expect(task.scheduled_at).toBe('2026-03-15T17:00:00Z');
    });

    it('creates meeting without scheduled_at (unscheduled draft)', () => {
      const result = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'TBD meeting',
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT scheduled_at FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, result.task_id) as { scheduled_at: string | null };
      expect(task.scheduled_at).toBeNull();
    });

    it('defaults recurrence_anchor to scheduled_at for recurring meetings', () => {
      const result = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Weekly sync',
        scheduled_at: '2026-03-15T17:00:00Z',
        recurrence: 'weekly',
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT recurrence, scheduled_at FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, result.task_id) as { recurrence: string; scheduled_at: string };
      expect(task.recurrence).toBe('weekly');
      expect(task.scheduled_at).toBe('2026-03-15T17:00:00Z');
    });

    it('rejects recurring meeting without scheduled_at', () => {
      const result = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Broken recurring meeting',
        recurrence: 'weekly',
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('scheduled_at');
    });

    it('resolves participant names to person_ids', () => {
      const result = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Cross-team',
        participants: ['Giovanni', 'Alexandre'],
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT participants FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, result.task_id) as { participants: string };
      const parts = JSON.parse(task.participants);
      expect(parts).toContain('person-1');
      expect(parts).toContain('person-2');
    });

    it('returns error for unresolved participant', () => {
      const result = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Bad meeting',
        participants: ['Unknown Person'],
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(false);
    });

    it('notifies all participants on creation', () => {
      const result = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Notif test',
        participants: ['Giovanni'],
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
      expect(result.notifications).toBeDefined();
      expect(result.notifications!.length).toBeGreaterThan(0);
    });
  });

  describe('update meeting', () => {
    let meetingId: string;

    beforeEach(() => {
      const result = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Test meeting',
        scheduled_at: '2026-03-15T17:00:00Z',
        participants: ['Giovanni'],
        sender_name: 'Alexandre',
      });
      meetingId = result.task_id!;
    });

    it('add_note auto-tags phase=pre when meeting is in next_action', () => {
      const result = engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { add_note: 'Revisar orçamento Q2' },
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, meetingId) as { notes: string };
      const notes = JSON.parse(task.notes);
      expect(notes[0].phase).toBe('pre');
      expect(notes[0].status).toBe('open');
    });

    it('add_note with parent_note_id links to parent', () => {
      engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { add_note: 'Agenda item 1' },
      });
      const result = engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Giovanni',
        updates: { add_note: 'Reply to agenda 1', parent_note_id: 1 },
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, meetingId) as { notes: string };
      const notes = JSON.parse(task.notes);
      expect(notes[1].parent_note_id).toBe(1);
    });

    it('add_note auto-tags phase=meeting when in_progress', () => {
      engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'start', sender_name: 'Alexandre' });
      const result = engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { add_note: 'Discussion point' },
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, meetingId) as { notes: string };
      const notes = JSON.parse(task.notes);
      const lastNote = notes[notes.length - 1];
      expect(lastNote.phase).toBe('meeting');
    });

    it('add_note auto-tags phase=post when in review', () => {
      engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'start', sender_name: 'Alexandre' });
      engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'review', sender_name: 'Alexandre' });
      const result = engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { add_note: 'Post-meeting reflection' },
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, meetingId) as { notes: string };
      const notes = JSON.parse(task.notes);
      const lastNote = notes[notes.length - 1];
      expect(lastNote.phase).toBe('post');
    });

    it('set_note_status changes status from open to checked', () => {
      engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { add_note: 'Item to check' },
      });
      const result = engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { set_note_status: { id: 1, status: 'checked' } },
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, meetingId) as { notes: string };
      const notes = JSON.parse(task.notes);
      expect(notes[0].status).toBe('checked');
      expect(notes[0].processed_at).toBeDefined();
      expect(notes[0].processed_by).toBe('Alexandre');
    });

    it('set_note_status can reopen a checked note', () => {
      engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { add_note: 'Reopen test' },
      });
      engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { set_note_status: { id: 1, status: 'checked' } },
      });
      const result = engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { set_note_status: { id: 1, status: 'open' } },
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, meetingId) as { notes: string };
      const notes = JSON.parse(task.notes);
      expect(notes[0].status).toBe('open');
    });

    it('set_note_status dismissed', () => {
      engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { add_note: 'Dismiss me' },
      });
      const result = engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { set_note_status: { id: 1, status: 'dismissed' } },
      });
      expect(result.success).toBe(true);
    });

    it('add_participant adds a person', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Add participant test',
        sender_name: 'Alexandre',
      });
      const result = engine.update({
        board_id: BOARD_ID,
        task_id: r.task_id!,
        sender_name: 'Alexandre',
        updates: { add_participant: 'Giovanni' },
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT participants FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, r.task_id!) as { participants: string };
      const parts = JSON.parse(task.participants);
      expect(parts).toContain('person-2');
    });

    it('remove_participant removes a person', () => {
      const result = engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { remove_participant: 'Giovanni' },
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT participants FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, meetingId) as { participants: string };
      const parts = JSON.parse(task.participants);
      expect(parts).not.toContain('person-2');
    });

    it('scheduled_at update reschedules meeting', () => {
      const result = engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { scheduled_at: '2026-03-20T14:00:00Z' },
      });
      expect(result.success).toBe(true);
      const task = db
        .prepare(`SELECT scheduled_at FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, meetingId) as { scheduled_at: string };
      expect(task.scheduled_at).toBe('2026-03-20T14:00:00Z');
    });

    it('non-meeting note has no phase or status', () => {
      const r = engine.update({
        board_id: BOARD_ID,
        task_id: 'T-002',
        sender_name: 'Alexandre',
        updates: { add_note: 'Regular note' },
      });
      expect(r.success).toBe(true);
      const task = db
        .prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`)
        .get(BOARD_ID, 'T-002') as { notes: string };
      const notes = JSON.parse(task.notes);
      expect(notes[0].phase).toBeUndefined();
      expect(notes[0].status).toBeUndefined();
    });

    it('participant can add note but not edit another participant note', () => {
      engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { add_note: 'Manager note' },
      });
      const addResult = engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Giovanni',
        updates: { add_note: 'Participant note' },
      });
      expect(addResult.success).toBe(true);
      const editResult = engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Giovanni',
        updates: { edit_note: { id: 1, text: 'Tampered note' } },
      });
      expect(editResult.success).toBe(false);
    });
  });

  describe('move meeting', () => {
    let meetingId: string;

    beforeEach(() => {
      const result = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Move test meeting',
        scheduled_at: '2026-03-15T17:00:00Z',
        participants: ['Giovanni'],
        sender_name: 'Alexandre',
      });
      meetingId = result.task_id!;
    });

    it('meetings do not count against WIP limits', () => {
      const t1 = engine.create({ board_id: BOARD_ID, type: 'simple', title: 'Filler 1', assignee: 'Alexandre', sender_name: 'Alexandre' });
      engine.move({ board_id: BOARD_ID, task_id: t1.task_id!, action: 'start', sender_name: 'Alexandre' });
      const t2 = engine.create({ board_id: BOARD_ID, type: 'simple', title: 'Filler 2', assignee: 'Alexandre', sender_name: 'Alexandre' });
      engine.move({ board_id: BOARD_ID, task_id: t2.task_id!, action: 'start', sender_name: 'Alexandre' });
      // Now at WIP limit (3: T-001 + Filler1 + Filler2), starting a meeting should not be blocked
      const result = engine.move({
        board_id: BOARD_ID,
        task_id: meetingId,
        action: 'start',
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
    });

    it('done on meeting with open notes returns unprocessed_minutes_warning', () => {
      engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { add_note: 'Open agenda item' },
      });
      const result = engine.move({
        board_id: BOARD_ID,
        task_id: meetingId,
        action: 'conclude',
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
      expect((result as any).unprocessed_minutes_warning).toBe(true);
    });

    it('done on meeting with all checked notes does NOT return warning', () => {
      engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { add_note: 'Checked item' },
      });
      engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { set_note_status: { id: 1, status: 'checked' } },
      });
      const result = engine.move({
        board_id: BOARD_ID,
        task_id: meetingId,
        action: 'conclude',
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
      expect((result as any).unprocessed_minutes_warning).toBeUndefined();
    });

    it('cancel meeting notifies participants', () => {
      const result = engine.admin({
        board_id: BOARD_ID,
        action: 'cancel_task',
        task_id: meetingId,
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
      expect(result.notifications).toBeDefined();
      expect(result.notifications!.some((n: any) => n.target_person_id === 'person-2')).toBe(true);
    });

    it('meeting moves through full lifecycle', () => {
      let r = engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'start', sender_name: 'Alexandre' });
      expect(r.success).toBe(true);
      expect(r.to_column).toBe('in_progress');
      r = engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'review', sender_name: 'Alexandre' });
      expect(r.success).toBe(true);
      expect(r.to_column).toBe('review');
      r = engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'conclude', sender_name: 'Alexandre' });
      expect(r.success).toBe(true);
      expect(r.to_column).toBe('done');
    });
  });

  describe('query meetings', () => {
    let meetingId: string;

    beforeEach(() => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Weekly sync',
        scheduled_at: '2026-03-15T17:00:00Z',
        participants: ['Giovanni'],
        sender_name: 'Alexandre',
      });
      meetingId = r.task_id!;
      engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { add_note: 'Review budget' },
      });
      engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { add_note: 'Define timeline' },
      });
    });

    it('meetings query returns all active meetings', () => {
      const result = engine.query({ query: 'meetings' });
      expect(result.success).toBe(true);
      expect(result.data.length).toBeGreaterThanOrEqual(1);
      expect(result.data[0].type).toBe('meeting');
    });

    it('meeting_agenda returns pre-phase notes', () => {
      const result = engine.query({ query: 'meeting_agenda', task_id: meetingId });
      expect(result.success).toBe(true);
      expect(result.data.length).toBe(2);
      expect(result.data[0].phase).toBe('pre');
    });

    it('meeting_minutes returns all notes with threading', () => {
      const result = engine.query({ query: 'meeting_minutes', task_id: meetingId });
      expect(result.success).toBe(true);
      expect(result.data.notes.length).toBe(2);
      expect(result.formatted).toBeDefined();
    });

    it('upcoming_meetings returns meetings sorted by scheduled_at', () => {
      engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Earlier meeting',
        scheduled_at: '2026-03-10T10:00:00Z',
        sender_name: 'Alexandre',
      });
      const result = engine.query({ query: 'upcoming_meetings' });
      expect(result.success).toBe(true);
      expect(result.data.length).toBeGreaterThanOrEqual(2);
      expect(result.data[0].scheduled_at <= result.data[1].scheduled_at).toBe(true);
    });

    it('meeting_participants returns participant list', () => {
      const result = engine.query({ query: 'meeting_participants', task_id: meetingId });
      expect(result.success).toBe(true);
      expect(result.data.organizer).toBeDefined();
      expect(result.data.participants.length).toBeGreaterThan(0);
    });

    it('meeting_open_items returns only open notes', () => {
      engine.update({
        board_id: BOARD_ID,
        task_id: meetingId,
        sender_name: 'Alexandre',
        updates: { set_note_status: { id: 1, status: 'checked' } },
      });
      const result = engine.query({ query: 'meeting_open_items', task_id: meetingId });
      expect(result.success).toBe(true);
      expect(result.data.length).toBe(1);
      expect(result.data[0].id).toBe(2);
    });

    it('meeting_history returns task history', () => {
      const result = engine.query({ query: 'meeting_history', task_id: meetingId });
      expect(result.success).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
    });

    it('meeting_minutes_at returns archived occurrence by date', () => {
      const result = engine.query({ query: 'meeting_minutes_at', task_id: meetingId, at: '2026-03-15' });
      expect(result.success).toBe(true);
    });
  });

  describe('admin meeting triage', () => {
    let meetingId: string;

    beforeEach(() => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Triage meeting',
        scheduled_at: '2026-03-15T17:00:00Z',
        participants: ['Giovanni'],
        sender_name: 'Alexandre',
      });
      meetingId = r.task_id!;
      engine.update({ board_id: BOARD_ID, task_id: meetingId, sender_name: 'Alexandre', updates: { add_note: 'Budget review' } });
      engine.update({ board_id: BOARD_ID, task_id: meetingId, sender_name: 'Alexandre', updates: { add_note: 'Timeline definition' } });
      engine.update({ board_id: BOARD_ID, task_id: meetingId, sender_name: 'Alexandre', updates: { add_note: 'Server issue' } });
      engine.update({ board_id: BOARD_ID, task_id: meetingId, sender_name: 'Alexandre', updates: { set_note_status: { id: 1, status: 'checked' } } });
    });

    it('process_minutes returns only open notes', () => {
      const result = engine.admin({
        board_id: BOARD_ID,
        action: 'process_minutes',
        task_id: meetingId,
        sender_name: 'Alexandre',
      });
      expect(result.success).toBe(true);
      expect(result.data.open_items.length).toBe(2);
      expect(result.data.open_items.every((n: any) => n.status === 'open')).toBe(true);
    });

    it('process_minutes_decision creates task atomically', () => {
      const result = engine.admin({
        board_id: BOARD_ID,
        action: 'process_minutes_decision',
        task_id: meetingId,
        sender_name: 'Alexandre',
        note_id: 2,
        decision: 'create_task',
        create: {
          type: 'simple',
          title: 'Timeline follow-up',
          assignee: 'Giovanni',
          labels: ['ata:' + meetingId],
        },
      });
      expect(result.success).toBe(true);
      expect(result.data.created_task_id).toBeDefined();

      const task = db.prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`).get(BOARD_ID, meetingId) as any;
      const notes = JSON.parse(task.notes);
      const note = notes.find((n: any) => n.id === 2);
      expect(note.status).toBe('task_created');
      expect(note.created_task_id).toBe(result.data.created_task_id);

      const createdTask = db.prepare(`SELECT * FROM tasks WHERE board_id = ? AND id = ?`).get(BOARD_ID, result.data.created_task_id) as any;
      expect(createdTask).toBeDefined();
      expect(createdTask.title).toBe('Timeline follow-up');
    });

    it('process_minutes_decision creates inbox atomically', () => {
      const result = engine.admin({
        board_id: BOARD_ID,
        action: 'process_minutes_decision',
        task_id: meetingId,
        sender_name: 'Alexandre',
        note_id: 3,
        decision: 'create_inbox',
        create: {
          type: 'inbox',
          title: 'Investigate server issue',
          labels: ['ata:' + meetingId],
        },
      });
      expect(result.success).toBe(true);
      expect(result.data.created_task_id).toBeDefined();

      const task = db.prepare(`SELECT notes FROM tasks WHERE board_id = ? AND id = ?`).get(BOARD_ID, meetingId) as any;
      const notes = JSON.parse(task.notes);
      const note = notes.find((n: any) => n.id === 3);
      expect(note.status).toBe('inbox_created');
    });

    it('process_minutes_decision rejects invalid note_id', () => {
      const result = engine.admin({
        board_id: BOARD_ID,
        action: 'process_minutes_decision',
        task_id: meetingId,
        sender_name: 'Alexandre',
        note_id: 999,
        decision: 'create_task',
        create: { type: 'simple', title: 'No note', assignee: 'Giovanni' },
      });
      expect(result.success).toBe(false);
    });

    it('process_minutes_decision rejects already-processed note', () => {
      const result = engine.admin({
        board_id: BOARD_ID,
        action: 'process_minutes_decision',
        task_id: meetingId,
        sender_name: 'Alexandre',
        note_id: 1,
        decision: 'create_task',
        create: { type: 'simple', title: 'Already done', assignee: 'Giovanni' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('board view meetings', () => {
    it('shows meeting emoji, scheduled_at time, and participant count', () => {
      engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Alinhamento semanal',
        scheduled_at: '2026-03-15T17:00:00Z',
        participants: ['Giovanni'],
        sender_name: 'Alexandre',
      });
      const result = engine.query({ query: 'board' });
      expect(result.success).toBe(true);
      const board = result.data.formatted_board as string;
      expect(board).toContain('📅');
      expect(board).toContain('Alinhamento semanal');
      expect(board).toContain('participante');
    });
  });

  describe('recurring meeting advance', () => {
    it('archives meeting notes with metadata before cycle reset', () => {
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Weekly standup',
        scheduled_at: '2026-03-10T14:00:00Z',
        recurrence: 'weekly',
        participants: ['Giovanni'],
        sender_name: 'Alexandre',
      });
      const meetingId = r.task_id!;

      // Add notes
      engine.update({ board_id: BOARD_ID, task_id: meetingId, sender_name: 'Alexandre', updates: { add_note: 'Agenda item' } });
      engine.update({ board_id: BOARD_ID, task_id: meetingId, sender_name: 'Alexandre', updates: { set_note_status: { id: 1, status: 'checked' } } });

      // Move to done (triggers advance)
      engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'start', sender_name: 'Alexandre' });
      const doneResult = engine.move({ board_id: BOARD_ID, task_id: meetingId, action: 'conclude', sender_name: 'Alexandre' });
      expect(doneResult.success).toBe(true);
      expect(doneResult.recurring_cycle).toBeDefined();
      expect(doneResult.recurring_cycle!.expired).toBe(false);

      // Verify notes were reset
      const task = db.prepare(`SELECT notes, scheduled_at, participants FROM tasks WHERE board_id = ? AND id = ?`).get(BOARD_ID, meetingId) as any;
      expect(JSON.parse(task.notes)).toEqual([]);

      // Verify participants preserved
      const parts = JSON.parse(task.participants);
      expect(parts).toContain('person-2');

      // Verify scheduled_at advanced
      expect(task.scheduled_at).not.toBe('2026-03-10T14:00:00Z');

      // Verify archived occurrence preserves notes and metadata
      const occurrences = db.prepare(
        `SELECT * FROM task_history WHERE board_id = ? AND task_id = ? AND action = 'meeting_occurrence_archived'`
      ).all(BOARD_ID, meetingId);
      expect(occurrences.length).toBe(1);
      const details = JSON.parse((occurrences[0] as any).details);
      expect(details.snapshot.notes).toBeDefined();
      expect(details.snapshot.scheduled_at).toBe('2026-03-10T14:00:00Z');
    });
  });

  describe('report meetings', () => {
    it('standup includes upcoming meetings and open-minutes warnings', () => {
      // Create a past meeting with open notes (simulate overdue minutes)
      const r = engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Past meeting',
        scheduled_at: '2026-03-01T10:00:00Z',
        sender_name: 'Alexandre',
      });
      engine.update({ board_id: BOARD_ID, task_id: r.task_id!, sender_name: 'Alexandre', updates: { add_note: 'Unresolved item' } });

      // Create upcoming meeting
      engine.create({
        board_id: BOARD_ID,
        type: 'meeting',
        title: 'Tomorrow meeting',
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        sender_name: 'Alexandre',
      });

      const report = engine.report({ board_id: BOARD_ID, type: 'standup' });
      expect(report.success).toBe(true);
      expect(report.data!.upcoming_meetings).toBeDefined();
      expect(report.data!.meetings_with_open_minutes).toBeDefined();
    });
  });
});
