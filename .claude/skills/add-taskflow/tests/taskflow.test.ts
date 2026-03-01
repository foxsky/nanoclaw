import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('taskflow skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: taskflow');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('media-support');
  });

  it('has SKILL.md with required frontmatter', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('name: add-taskflow');
    expect(skillMd).toContain('description:');
  });

  it('SKILL.md top-level description distinguishes standard JSON mode from hierarchy mode', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('Standard boards run via CLAUDE.md + TASKS.json; hierarchy boards use the existing SQLite TaskFlow runtime support');
    expect(skillMd).toContain('Standard / separate mode remains config-only.');
    expect(skillMd).toContain('Hierarchy mode relies on already-implemented runtime support');
    expect(skillMd).not.toContain('All via CLAUDE.md + TASKS.json, no source code changes.');
  });

  it('SKILL.md makes the top-level DST/timezone storage policy mode-aware', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('store both local and UTC schedules in the correct board metadata store');
    expect(skillMd).toContain('`TASKS.json` meta for standard / separate boards, `board_runtime_config` for hierarchy boards');
    expect(skillMd).toContain('recreates runners using the same storage backend for that topology');
    expect(skillMd).not.toContain('store both local and UTC schedules in TASKS.json meta.');
  });

  it('SKILL.md explicitly initializes standard-board DST state after creating the DST guard', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('immediately persist the initial DST state in `groups/{{GROUP_FOLDER}}/TASKS.json`');
    expect(skillMd).toContain("board.meta.runner_task_ids.dst_guard = enabled ? process.env.DST_ID : null;");
    expect(skillMd).toContain('board.meta.dst_sync.last_offset_minutes = offsetMinutes;');
    expect(skillMd).toContain('board.meta.dst_sync.last_synced_at = enabled ? now : null;');
    expect(skillMd).toContain('board.meta.dst_sync.resync_count_24h = 0;');
    expect(skillMd).toContain('board.meta.dst_sync.resync_window_started_at = enabled ? now : null;');
  });

  it('SKILL.md makes people registration mode-aware for hierarchy boards', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('Always register the primary full manager in the active people store');
    expect(skillMd).toContain('sender identification and admin authorization work');
    expect(skillMd).toContain('### 2. Register People In The Active Board Store');
    expect(skillMd).toContain('**Standard / separate boards:** read `groups/{{GROUP_FOLDER}}/TASKS.json`');
    expect(skillMd).toContain('**Hierarchy boards:** do not update `TASKS.json`. Insert each person into `board_people`');
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

  it('SKILL.md scopes schema-version migration to standard and separate boards only', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('**Schema version boundary (standard / separate only):**');
    expect(skillMd).toContain('existing standard/separate board with missing `schema_version`');
    expect(skillMd).toContain('If an existing standard/separate board declares an unknown higher schema version');
    expect(skillMd).toContain('Hierarchy boards do not use `meta.schema_version`');
    expect(skillMd).toContain('their active data store is SQLite');
  });

  it('has SKILL.md with all 5 phases', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('## Phase 1: Configuration');
    expect(skillMd).toContain('## Phase 2: Group Creation');
    expect(skillMd).toContain('## Phase 3: People Registration');
    expect(skillMd).toContain('## Phase 4: Runner Setup');
    expect(skillMd).toContain('## Phase 5: Verification');
  });

  it('SKILL.md documents the schema_version migration boundary', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('TaskFlow board files now use `meta.schema_version: "2.0"` as a real migration boundary');
    expect(skillMd).toContain('normalize it before any further mutation');
    expect(skillMd).toContain('unknown higher schema version');
  });

  it('has all template files', () => {
    const templatesDir = path.join(skillDir, 'templates');
    expect(fs.existsSync(path.join(templatesDir, 'CLAUDE.md.template'))).toBe(true);
    expect(fs.existsSync(path.join(templatesDir, 'TASKS.json.template'))).toBe(true);
    expect(fs.existsSync(path.join(templatesDir, 'ARCHIVE.json.template'))).toBe(true);
  });

  it('TASKS.json.template is valid JSON after placeholder substitution', () => {
    const raw = fs.readFileSync(
      path.join(skillDir, 'templates', 'TASKS.json.template'),
      'utf-8',
    );

    // Substitute placeholders with test values
    const substituted = raw
      .replace(/\{\{LANGUAGE\}\}/g, 'pt-BR')
      .replace(/\{\{TIMEZONE\}\}/g, 'America/Fortaleza')
      .replace(/\{\{MANAGER_NAME\}\}/g, 'Test Manager')
      .replace(/\{\{MANAGER_PHONE\}\}/g, '5500000000000')
      .replace(/\{\{ATTACHMENT_IMPORT_ENABLED\}\}/g, 'true')
      .replace(/\{\{ATTACHMENT_IMPORT_REASON\}\}/g, '')
      .replace(/\{\{DST_GUARD_ENABLED\}\}/g, 'false')
      .replace(/\{\{WIP_LIMIT\}\}/g, '3')
      .replace(/\{\{STANDUP_CRON_LOCAL\}\}/g, '0 8 * * 1-5')
      .replace(/\{\{DIGEST_CRON_LOCAL\}\}/g, '0 18 * * 1-5')
      .replace(/\{\{REVIEW_CRON_LOCAL\}\}/g, '0 11 * * 5')
      .replace(/\{\{STANDUP_CRON\}\}/g, '0 11 * * 1-5')
      .replace(/\{\{DIGEST_CRON\}\}/g, '0 21 * * 1-5')
      .replace(/\{\{REVIEW_CRON\}\}/g, '0 14 * * 5');

    const parsed = JSON.parse(substituted);
    expect(parsed.meta.schema_version).toBe('2.0');
    expect(parsed.meta.manager.name).toBe('Test Manager');
    expect(parsed.meta.manager.phone).toBe('5500000000000');
    expect(parsed.meta.managers).toEqual([
      {
        name: 'Test Manager',
        phone: '5500000000000',
        role: 'manager',
      },
    ]);
    expect(parsed.meta.columns).toHaveLength(6);
    expect(parsed.meta.wip_limit_default).toBe(3);
    expect(parsed.meta.runner_task_ids).toHaveProperty('standup');
    expect(parsed.meta.runner_task_ids).toHaveProperty('dst_guard');
    expect(parsed.meta.attachment_policy.enabled).toBe(true);
    expect(parsed.meta.attachment_policy.disabled_reason).toBe('');
    expect(parsed.meta.dst_sync).toHaveProperty('last_offset_minutes');
    expect(parsed.meta.dst_sync.enabled).toBe(false);
    expect(parsed.meta.attachment_policy.allowed_formats).toEqual(['pdf', 'jpg', 'png']);
    expect(parsed.people).toEqual([]);
    expect(parsed.tasks).toEqual([]);
    expect(parsed.next_id).toBe(1);
  });

  it('TASKS.json.template handles disabled attachment reason with spaces', () => {
    const raw = fs.readFileSync(
      path.join(skillDir, 'templates', 'TASKS.json.template'),
      'utf-8',
    );

    const substituted = raw
      .replace(/\{\{LANGUAGE\}\}/g, 'pt-BR')
      .replace(/\{\{TIMEZONE\}\}/g, 'America/Fortaleza')
      .replace(/\{\{MANAGER_NAME\}\}/g, 'Test Manager')
      .replace(/\{\{MANAGER_PHONE\}\}/g, '5500000000000')
      .replace(/\{\{ATTACHMENT_IMPORT_ENABLED\}\}/g, 'false')
      .replace(/\{\{ATTACHMENT_IMPORT_REASON\}\}/g, 'media-support skill not installed')
      .replace(/\{\{DST_GUARD_ENABLED\}\}/g, 'true')
      .replace(/\{\{WIP_LIMIT\}\}/g, '3')
      .replace(/\{\{STANDUP_CRON_LOCAL\}\}/g, '0 8 * * 1-5')
      .replace(/\{\{DIGEST_CRON_LOCAL\}\}/g, '0 18 * * 1-5')
      .replace(/\{\{REVIEW_CRON_LOCAL\}\}/g, '0 11 * * 5')
      .replace(/\{\{STANDUP_CRON\}\}/g, '0 11 * * 1-5')
      .replace(/\{\{DIGEST_CRON\}\}/g, '0 21 * * 1-5')
      .replace(/\{\{REVIEW_CRON\}\}/g, '0 14 * * 5');

    const parsed = JSON.parse(substituted);
    expect(parsed.meta.attachment_policy.enabled).toBe(false);
    expect(parsed.meta.attachment_policy.disabled_reason).toBe('media-support skill not installed');
    expect(parsed.meta.dst_sync.enabled).toBe(true);
  });

  it('ARCHIVE.json.template is valid JSON after placeholder substitution', () => {
    const raw = fs.readFileSync(
      path.join(skillDir, 'templates', 'ARCHIVE.json.template'),
      'utf-8',
    );

    const substituted = raw
      .replace(/\{\{GROUP_NAME\}\}/g, 'Test Group')
      .replace(/\{\{LANGUAGE\}\}/g, 'pt-BR')
      .replace(/\{\{TIMEZONE\}\}/g, 'America/Fortaleza')
      .replace(/\{\{MANAGER_NAME\}\}/g, 'Test Manager')
      .replace(/\{\{MANAGER_PHONE\}\}/g, '5500000000000');
    const parsed = JSON.parse(substituted);
    expect(parsed.meta.schema_version).toBe('2.0');
    expect(parsed.meta.language).toBe('pt-BR');
    expect(parsed.meta.timezone).toBe('America/Fortaleza');
    expect(parsed.meta.manager.name).toBe('Test Manager');
    expect(parsed.meta.manager.phone).toBe('5500000000000');
    expect(parsed.meta.managers).toEqual([
      {
        name: 'Test Manager',
        phone: '5500000000000',
        role: 'manager',
      },
    ]);
    expect(parsed.people).toEqual([]);
    expect(parsed.tasks).toEqual([]);
    expect(parsed.next_id).toBe(1);
  });

  it('CLAUDE.md.template has all required sections', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Scope guard (token savings for off-topic queries)
    expect(content).toContain('Scope Guard');
    expect(content).toContain('task management assistant ONLY');
    expect(content).toContain('Do NOT read any board data');

    // Identity and data loading
    expect(content).toContain('CRITICAL: Load Data First');
    expect(content).toContain('TASKS.json');

    // Security
    expect(content).toContain('Security');
    expect(content).toContain('untrusted data');
    expect(content).toContain('cross-group operation');
    expect(content).toContain('Group-local `schedule_task`/`cancel_task` operations are allowed');

    // Authorization
    expect(content).toContain('Authorization Rules');
    expect(content).toContain('Full-manager-only');
    expect(content).toContain('`meta.schema_version`: real migration boundary');

    // Board rules
    expect(content).toContain('The Kanban Board');
    expect(content).toContain('Transition Rules');
    expect(content).toContain('WIP Limit');
    expect(content).toContain('History Cap');

    // GTD rules
    expect(content).toContain('GTD Rules');
    expect(content).toContain('Quick Capture');
    expect(content).toContain('Attachment Intake');

    // Command parsing
    expect(content).toContain('Command Parsing');

    // Runner formats
    expect(content).toContain('Standup Format');
    expect(content).toContain('Manager Digest Format');
    expect(content).toContain('Weekly Review Format');

    // MCP tools
    expect(content).toContain('send_message');
    expect(content).toContain('schedule_task');
    expect(content).toContain('cancel_task');

    // No individual DMs (architecture constraint)
    expect(content).toContain('Individual DMs are not supported');
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

  it('CLAUDE.md.template explicitly enforces full-manager task creation and delegate-enabled inbox processing', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('create full tasks (`tarefa`, `projeto`, `diario`, `semanal`, `mensal`, `anual`)');
    expect(content).toContain('process inbox (`processar inbox`, `T-XXX para [pessoa], prazo [data]`)');
    expect(content).toContain('Full-manager-only commands');
    expect(content).toContain('Delegate-or-manager commands:');
    expect(content).toContain('"processar inbox" / "o que tem no inbox?" | Delegate or full manager.');
    expect(content).toContain('"tarefa para X: Y ate Z" | Full manager only.');
    expect(content).toContain('"projeto para X: Y. Etapas: ..." | Full manager only.');
    expect(content).toContain('"mensal para X: Y todo dia Z" | Full manager only.');
    expect(content).toContain('"diario para X: Y" | Full manager only.');
    expect(content).toContain('"semanal para X: Y toda [dia da semana]" | Full manager only.');
    expect(content).toContain('"anual para X: Y todo dia D/M" | Full manager only.');
    expect(content).toContain('if a message matches a known command but the sender lacks permission');
  });

  it('CLAUDE.md.template documents the missing management commands and their permissions', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('"forcar T-XXX para andamento" | Full manager only.');
    expect(content).toContain('"reatribuir T-XXX para [pessoa]" | Full manager only.');
    expect(content).toContain('"remover [nome]" | Full manager only.');
    expect(content).toContain('"T-XXX rejeitada: [motivo]" | Delegate or full manager.');
    expect(content).toContain('Assignee or manager. Move to Done (shortcut)');
  });

  it('CLAUDE.md.template requires the exact attachment confirmation token', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('Apply only after the exact explicit confirmation command: `CONFIRM_IMPORT {import_action_id}`');
    expect(content).toContain('Generic replies like "ok", "confirmado", or "pode aplicar" are NOT sufficient');
  });

  it('CLAUDE.md.template does not assume unsupported per-task reminder scheduling', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).not.toContain('recreate reminders');
    expect(content).not.toContain('per-task reminder IDs');
    expect(content).toContain('Update `due_date` and record the change in the active history store');
    expect(content).toContain('Use `cancel_task` only for scheduled runner jobs');
  });

  it('CLAUDE.md.template defines project subtask IDs and recurring next-cycle creation', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('Subtasks use dotted IDs under the parent task');
    expect(content).toContain('`P-001.1`, `P-001.2`, `P-001.3`');
    expect(content).toContain('When a recurring task is completed, immediately create the next cycle');
  });

  it('CLAUDE.md.template has explicit data schemas for all object types', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Data Schemas section exists
    expect(content).toContain('## Data Schemas');
    expect(content).toContain('ISO-8601 UTC');
    expect(content).toContain('### Board Admin Roles (`meta`)');
    expect(content).toContain('`meta.managers[]`: source of truth for admin roles on new boards');
    expect(content).toContain('`meta.manager`: legacy compatibility alias for the primary full manager');

    // Person schema with all fields
    expect(content).toContain('### Person');
    expect(content).toContain('"id": "alexandre"');
    expect(content).toContain('"phone":');
    expect(content).toContain('"role":');
    expect(content).toContain('"wip_limit":');

    // Task schemas for all 3 types with required fields
    expect(content).toContain('### Task (simple');
    expect(content).toContain('"type": "simple"');
    expect(content).toContain('"column":');
    expect(content).toContain('"assignee":');
    expect(content).toContain('"next_action":');
    expect(content).toContain('"waiting_for":');
    expect(content).toContain('"due_date":');
    expect(content).toContain('"priority": "normal"');
    expect(content).toContain('"labels": []');
    expect(content).toContain('"next_note_id": 1');
    expect(content).toContain('"notes": []');
    expect(content).toContain('"created_at":');
    expect(content).toContain('"updated_at":');
    expect(content).toContain('"history": []');
    expect(content).toContain('Always initialize `notes` as an empty array: `[]`');
    expect(content).toContain('Always initialize `next_note_id` as `1`');

    expect(content).toContain('### Task (project');
    expect(content).toContain('"type": "project"');
    expect(content).toContain('"subtasks":');
    expect(content).toContain('"done": false');
    expect(content).toContain('"priority": "high"');
    expect(content).toContain('"labels": ["infra", "migracao"]');

    expect(content).toContain('### Task (recurring');
    expect(content).toContain('"type": "recurring"');
    expect(content).toContain('"recurrence":');
    expect(content).toContain('"frequency": "monthly"');
    expect(content).toContain('"current_cycle":');
    expect(content).toContain('"cycle": 1');
    expect(content).toContain('"labels": ["financeiro"]');

    // History entry schema
    expect(content).toContain('### History Entry');
    expect(content).toContain('"action": "moved"');
    expect(content).toContain('"from":');
    expect(content).toContain('"to":');
    expect(content).toContain('"by":');
  });

  it('CLAUDE.md.template scopes the top-level data schema examples to standard-mode JSON', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const schemaSection =
      content.match(/## Data Schemas[\s\S]*?## The Kanban Board/)?.[0] ?? '';

    expect(schemaSection).toContain('## Data Schemas (Standard-Mode JSON Reference)');
    expect(schemaSection).toContain('The JSON object shapes below describe the standard-board storage model');
    expect(schemaSection).toContain('Hierarchy boards use the same logical task concepts, but persist them in SQLite tables instead of `TASKS.json` / `ARCHIVE.json`');
    expect(schemaSection).toContain('use the hierarchy-mode section below for the authoritative hierarchy storage and access rules');
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
    const standupSection = content.split('## Standup Format')[1]?.split('## Manager Digest')[0] ?? '';
    const digestSection = content.split('## Manager Digest')[1]?.split('## Weekly Review')[0] ?? '';
    const reviewSection = content.split('## Weekly Review')[1]?.split('## MCP Tool')[0] ?? '';

    expect(standupSection).toContain('Skip if empty');
    expect(standupSection).toContain('there are no active tasks on this board');
    expect(digestSection).toContain('Skip if empty');
    expect(digestSection).toContain('there are no active tasks on this board');
    expect(reviewSection).toContain('Skip if empty');
    expect(reviewSection).toContain('there are no active tasks on this board');
  });

  it('SKILL.md runner prompts include skip-if-empty conditions', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toMatch(/STANDUP_PROMPT.*tasks\[\] is empty/);
    expect(skillMd).toMatch(/DIGEST_PROMPT.*tasks\[\] is empty/);
    expect(skillMd).toMatch(/REVIEW_PROMPT.*tasks\[\] is empty/);
    expect(skillMd).toContain('If tasks[] is empty, do NOT send any message — exit silently, even if there was archive activity this week.');
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
    // Keeps hierarchy setup separate from standard multi-board JSON setup
    expect(skillMd).toContain('If you create multiple groups for standard / separate mode');
    expect(skillMd).toContain('For hierarchy mode, create only the root board during initial setup');
  });

  it('CLAUDE.md.template scope guard appears before data loading', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const scopeGuardPos = content.indexOf('## Scope Guard');
    const loadDataPos = content.indexOf('## CRITICAL: Load Data First');
    expect(scopeGuardPos).toBeGreaterThan(-1);
    expect(loadDataPos).toBeGreaterThan(-1);
    expect(scopeGuardPos).toBeLessThan(loadDataPos);
  });

  it('CLAUDE.md.template scope guard blocks all board-data loads for off-topic queries', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const scopeSection =
      content.split('## Scope Guard')[1]?.split('## CRITICAL: Load Data First')[0] ?? '';

    expect(scopeSection).toContain('Do NOT read any board data');
    expect(scopeSection).toContain('neither `TASKS.json` nor the SQLite store');
  });

  it('CLAUDE.md.template makes the initial data load mode-aware for hierarchy boards', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    const loadSection = content.split('## CRITICAL: Load Data First')[1]?.split('## WhatsApp Formatting')[0] ?? '';

    expect(loadSection).toContain("Check `{{BOARD_ROLE}}`");
    expect(loadSection).toContain("If `{{BOARD_ROLE}}` is `hierarchy`, do **not** read `TASKS.json`");
    expect(loadSection).toContain('jump to the hierarchy-mode SQLite load steps below');
    expect(loadSection).toContain('After any standard-mode changes, write the updated TASKS.json back');
    expect(loadSection).toContain('in hierarchy mode you must load SQLite first');
  });

  it('SKILL.md documents per-group AI model configuration via settings.json', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('settings.json');
    expect(skillMd).toContain('ANTHROPIC_MODEL');
    expect(skillMd).toContain('data/sessions/{{GROUP_FOLDER}}/.claude/settings.json');
  });

  it('SKILL.md scope guard note is storage-mode aware', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('without reading any board data');
    expect(skillMd).toContain('TASKS.json` for standard boards or the SQLite store for hierarchy boards');
  });

  it('SKILL.md uses valid hierarchy depth values in setup snippets', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('taskflow_hierarchy_level, taskflow_max_depth) VALUES');
    expect(skillMd).toContain('NULL, 1, 1, 0, {{MAX_DEPTH}}');
    expect(skillMd).toContain('CHILD_BOARD_LEVEL=$((PARENT_BOARD_LEVEL + 1))');
    expect(skillMd).toContain('CHILD_RUNTIME_LEVEL=$((PARENT_RUNTIME_LEVEL + 1))');
    expect(skillMd).toContain('${CHILD_RUNTIME_LEVEL}');
    expect(skillMd).toContain('${CHILD_BOARD_LEVEL}');
    expect(skillMd).not.toContain('{{PARENT_LEVEL + 1}}');
  });

  it('SKILL.md skips TASKS.json and ARCHIVE.json generation for hierarchy boards', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('### 4. Generate TASKS.json (standard / separate only)');
    expect(skillMd).toContain('If topology is `Hierarchy`, skip this step. Hierarchy boards use SQLite');
    expect(skillMd).toContain('### 5. Generate ARCHIVE.json (standard / separate only)');
    expect(skillMd).toContain('If topology is `Hierarchy`, skip this step. Hierarchy boards archive completed/cancelled tasks in the shared SQLite database');
  });

  it('SKILL.md makes runner setup mode-aware for hierarchy boards', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('In hierarchy mode, the container still runs in the target group\'s folder, but the runner logic must use the SQLite-backed hierarchy flow');
    expect(skillMd).toContain('### Runner Prompts (standard / separate only)');
    expect(skillMd).toContain('For hierarchy boards, create equivalent runner prompts that follow the hierarchy-mode SQLite rules');
    expect(skillMd).toContain('do not write runner IDs into `TASKS.json`. Persist them in `board_runtime_config` instead');
    expect(skillMd).toContain('For hierarchy boards, use a SQLite-backed DST guard prompt instead');
    expect(skillMd).toContain('Hierarchy boards: `board_runtime_config`');
    expect(skillMd).toContain('runner_standup_task_id');
    expect(skillMd).toContain('runner_dst_guard_task_id');
  });

  it('SKILL.md makes verification and setup summary mode-aware for hierarchy boards', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('Standard / separate boards: read `TASKS.json`');
    expect(skillMd).toContain('Hierarchy boards: load the board from SQLite (`/workspace/taskflow/taskflow.db`)');
    expect(skillMd).toContain('Standard / separate boards only:');
    expect(skillMd).toContain('groups/{{GROUP_FOLDER}}/TASKS.json (task data)');
    expect(skillMd).toContain('Hierarchy boards only:');
    expect(skillMd).toContain('groups/{{GROUP_FOLDER}}/.mcp.json (SQLite MCP config)');
    expect(skillMd).toContain('data/taskflow/taskflow.db (shared hierarchy database)');
  });

  it('SKILL.md makes guardrails and lifecycle verification mode-aware for hierarchy boards', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('Standard / separate boards: agent can mutate only `TASKS.json` and `ARCHIVE.json`');
    expect(skillMd).toContain('Hierarchy boards: agent must mutate board data only through the SQLite task store');
    expect(skillMd).toContain('Hierarchy boards: done/cancelled items are retained in the SQLite `archive` table');
    expect(skillMd).toContain('Hierarchy boards: updating due dates persists the new `due_date` in the SQLite `tasks` table');
    expect(skillMd).toContain('Hierarchy boards: successful imports append rows to `attachment_audit_log`');
    expect(skillMd).toContain('board_runtime_config.dst_last_offset_minutes');
    expect(skillMd).toContain('Arbitrary file creation outside the supported board data store is refused');
  });

  it('SKILL.md makes attachment verification mode-aware for hierarchy boards', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('Standard / separate boards: if `meta.attachment_policy.enabled=false`, refuse import and request manual text input');
    expect(skillMd).toContain('Hierarchy boards: if `board_runtime_config.attachment_enabled=0`, refuse import and request manual text input');
    expect(skillMd).toContain('Standard / separate boards: append an entry to `meta.attachment_audit_trail`');
    expect(skillMd).toContain('Hierarchy boards: append a row to `attachment_audit_log`');
  });

  it('SKILL.md does not reference unsupported prompt helpers or reminder IDs', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).not.toContain('AskUserQuestion');
    expect(skillMd).not.toContain('reminder IDs');
    expect(skillMd).toContain('Ask the user directly to collect the following, one at a time:');
    expect(skillMd).toContain('Cancelling a task moves it to archive after confirmation');
    expect(skillMd).toContain('Standard / separate boards: updating due dates persists the new `due_date` in `TASKS.json`');
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

  it('CLAUDE.md.template documents schedule_task once timestamps according to the host parser', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('any timestamp format the host parser accepts');
    expect(content).toContain('"2026-02-01T15:30:00"');
    expect(content).toContain('"2026-02-01T15:30:00.000Z"');
  });

  it('CLAUDE.md.template MCP tool guidance is storage-mode aware for runners and normal task cancellation', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const mcpSection =
      content.match(/## MCP Tool Usage \(Preferred\)[\s\S]*?## Statistics Display Format/)?.[0] ?? '';

    expect(mcpSection).toContain('board data store (JSON for standard boards, SQLite for hierarchy boards)');
    expect(mcpSection).toContain('runner metadata store');
    expect(mcpSection).toContain('`meta.runner_task_ids` in standard mode, `board_runtime_config` in hierarchy mode');
  });

  it('CLAUDE.md.template statistics format is storage-mode aware', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const statsSection =
      content.match(/## Statistics Display Format[\s\S]*?## Hierarchy Mode/)?.[0] ?? '';

    expect(statsSection).toContain('Read active tasks plus the archive store');
    expect(statsSection).toContain('using completion records from the active history store for active tasks plus archived history snapshots from the archive store for archived tasks');
    expect(statsSection).toContain('matching completion record in the active history store or archived history snapshots');
    expect(statsSection).not.toContain('Read both `TASKS.json` and `ARCHIVE.json`');
    expect(statsSection).not.toContain('from history entries');
    expect(statsSection).not.toContain('the `moved` → `done` history entry');
  });

  it('CLAUDE.md.template manager digest format is storage-mode aware', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const digestSection =
      content.match(/## Manager Digest Format \(Evening\)[\s\S]*?## Weekly Review Format/)?.[0] ?? '';

    expect(digestSection).toContain('Read the current board data using the active storage mode and consolidate');
    expect(digestSection).toContain('Standard boards: read `/workspace/group/TASKS.json`');
    expect(digestSection).toContain('Hierarchy boards: read the SQLite board store');
    expect(digestSection).not.toContain('Read `/workspace/group/TASKS.json` and consolidate');
  });

  it('CLAUDE.md.template weekly review format defines inline per-person summaries', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const reviewSection =
      content.match(/## Weekly Review Format \(Friday\)[\s\S]*?## MCP Tool Usage/)?.[0] ?? '';

    expect(reviewSection).toContain('### Per-person weekly summaries (inline in group message)');
    expect(reviewSection).toContain('✅ Completed: N');
    expect(reviewSection).toContain('🔄 Active now:');
    expect(reviewSection).toContain('⏳ Waiting 5+ days:');
    expect(reviewSection).toContain('🔴 Overdue:');
    expect(reviewSection).toContain('📆 Next week:');
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
    expect(claudeTemplate).toContain('scheduler runtime timezone (`process.env.TZ` when set, otherwise the host system timezone)');
  });

  it('SKILL.md verification covers recurring cycles and dotted project subtasks', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('Completing a recurring task creates the next cycle in the same recurring series');
    expect(skillMd).toContain('Creating a project with steps produces dotted child IDs like `P-001.1`, `P-001.2`');
  });

  it('CLAUDE.md.template has ID generation rules using next_id', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('### ID Generation');
    expect(content).toContain('`next_id`');
    expect(content).toContain('zero-padded to 3 digits');
    expect(content).toContain('T-` + padded number');
    expect(content).toContain('P-` + padded number');
    expect(content).toContain('R-` + padded number');
    expect(content).toContain('Increment `next_id` by 1');
  });

  it('CLAUDE.md.template ID generation is storage-mode aware', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const idSection =
      content.match(/### ID Generation[\s\S]*?## The Kanban Board/)?.[0] ?? '';

    expect(idSection).toContain('Read `next_id` from the active board data store');
    expect(idSection).toContain('`TASKS.json` root in standard mode, or the board metadata row in hierarchy mode');
    expect(idSection).toContain('persist it back to the same active board data store');
    expect(idSection).not.toContain('Read `next_id` from the root of TASKS.json');
    expect(idSection).not.toContain('save to TASKS.json');
  });

  it('CLAUDE.md.template has sender identification rules', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('## Sender Identification');
    expect(content).toContain('Determine admin role from the active admin store');
    expect(content).toContain('`meta.managers[]` in standard mode, `board_admins` in hierarchy mode');
    expect(content).toContain('"role": "manager"');
    expect(content).toContain('"role": "delegate"');
    expect(content).toContain('sender name against the active people store');
    expect(content).toContain('`people[]` in standard mode, `board_people` in hierarchy mode');
    expect(content).toContain('legacy single-manager fields `meta.manager.phone` and `meta.manager.name`');
    expect(content).toContain('`meta.manager.phone`');
    expect(content).toContain('`meta.manager.name`');
    expect(content).toContain('task ownership');
  });

  it('TaskFlow templates support multi-manager metadata for new boards', () => {
    const tasksTemplate = fs.readFileSync(
      path.join(skillDir, 'templates', 'TASKS.json.template'),
      'utf-8',
    );
    const archiveTemplate = fs.readFileSync(
      path.join(skillDir, 'templates', 'ARCHIVE.json.template'),
      'utf-8',
    );

    expect(tasksTemplate).toContain('"managers": [');
    expect(tasksTemplate).toContain('"role": "manager"');
    expect(archiveTemplate).toContain('"managers": [');
    expect(archiveTemplate).toContain('"role": "manager"');
  });

  it('CLAUDE.md.template has review rejection and subtask completion workflows', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Review rejection flow
    expect(content).toContain('`review` → `in_progress`');
    expect(content).toContain('"T-XXX rejeitada: [motivo]" | Delegate or full manager.');
    expect(content).toContain('Task not in review');

    // GTD Rules section
    expect(content).toContain('Subtask completion:');
    expect(content).toContain('P-001.1 concluida');
    expect(content).toContain('Auto-update `next_action`');

    // Command Parsing table
    expect(content).toContain('"P-XXX.N concluida" / "P-XXX.N feita" / "P-XXX.N pronta"');
  });

  it('CLAUDE.md.template has all recurrence frequency commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('"diario para X: Y"');
    expect(content).toContain('"semanal para X: Y toda [dia da semana]"');
    expect(content).toContain('"mensal para X: Y todo dia Z"');
    expect(content).toContain('"anual para X: Y todo dia D/M"');
  });

  it('CLAUDE.md.template has task detail, history, due-date range, notes, rename, and my-tasks commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('"detalhes T-XXX" / "info T-XXX"');
    expect(content).toContain('"historico T-XXX"');
    expect(content).toContain('"minhas tarefas" / "meu quadro"');
    expect(content).toContain('"vence hoje" / "vencem hoje"');
    expect(content).toContain('"vence amanha" / "vencem amanha"');
    expect(content).toContain('"vence esta semana" / "vencem esta semana"');
    expect(content).toContain('"proximos 7 dias" / "vencem nos proximos 7 dias"');
    expect(content).toContain('"renomear T-XXX: novo titulo"');
    expect(content).toContain('"prioridade T-XXX: [baixa|normal|alta|urgente]"');
    expect(content).toContain('"rotulo T-XXX: [nome]"');
    expect(content).toContain('"remover rotulo T-XXX: [nome]"');
    expect(content).toContain('"nota T-XXX: texto" / "anotacao T-XXX: texto"');
    expect(content).toContain('"editar nota T-XXX #N: texto"');
    expect(content).toContain('"remover nota T-XXX #N"');
    expect(content).toContain('For any newly created task (simple, project, or recurring), always initialize `priority` as `"normal"`, `labels` as `[]`, `description` as `null`, `blocked_by` as `[]`, `reminders` as `[]`, `_last_mutation` as `null`, `next_note_id` as `1`, and `notes` as `[]`.');
    expect(content).toContain('Use the active history store for lifecycle records (`history[]` in standard mode, `task_history` in hierarchy mode).');
  });

  it('CLAUDE.md.template documents note editing and admin-role management commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('"editar nota T-XXX #N: texto" | Manager or assignee.');
    expect(content).toContain('"remover nota T-XXX #N" | Manager or assignee.');
    expect(content).toContain('"adicionar gestor [nome], telefone [numero]" | Full manager only. Add another full manager entry to the active admin store');
    expect(content).toContain('`meta.managers[]` in standard mode, `board_admins` in hierarchy mode');
    expect(content).toContain('"adicionar delegado [nome], telefone [numero]" | Full manager only. Add a delegate entry to the active admin store');
    expect(content).toContain('"remover gestor [nome]" / "remover delegado [nome]" | Full manager only. Remove that admin entry after confirmation.');
    expect(content).toContain('Never remove the last full manager');
  });

  it('CLAUDE.md.template people and admin management commands are storage-mode aware', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const commandSection =
      content.match(/### Queries & Management[\s\S]*?### Batch Operations/)?.[0] ?? '';

    expect(commandSection).toContain('Add the person to the active people store (`people[]` in standard mode, `board_people` in hierarchy mode)');
    expect(commandSection).toContain('Add another full manager entry to the active admin store (`meta.managers[]` in standard mode, `board_admins` in hierarchy mode)');
    expect(commandSection).toContain('Add a delegate entry to the active admin store (`meta.managers[]` in standard mode, `board_admins` in hierarchy mode)');
    expect(commandSection).toContain('Remove the person from the active people store after confirmation');
    expect(commandSection).not.toContain('| "cadastrar [nome], telefone [numero], [cargo]" | Full manager only. Add person to `people[]` |');
  });

  it('CLAUDE.md.template defines reopen, restore, and richer project subtask maintenance', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('restore archived task');
    expect(content).toContain('`done` → `next_action`: assignee or manager reopens the task');
    expect(content).toContain('### Reopen and Restore');
    expect(content).toContain('`reabrir T-XXX`: only valid for active tasks currently in `done`');
    expect(content).toContain('`restaurar T-XXX`: manager only.');
    expect(content).toContain('"reabrir T-XXX" | Assignee or manager. Move from Done back to Next Action');

    expect(content).toContain('Subtask maintenance:');
    expect(content).toContain('`adicionar etapa P-001: validar rollback`');
    expect(content).toContain('`renomear etapa P-001.2: instalar SO atualizado`');
    expect(content).toContain('`reabrir etapa P-001.2`');
    expect(content).toContain('"adicionar etapa P-XXX: [titulo]" | Assignee or manager.');
    expect(content).toContain('"renomear etapa P-XXX.N: [novo titulo]" | Assignee or manager.');
    expect(content).toContain('"reabrir etapa P-XXX.N" | Assignee or manager.');
  });

  it('CLAUDE.md.template shared lifecycle rules are storage-mode aware', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const lifecycleSection =
      content.match(/## The Kanban Board[\s\S]*?## GTD Rules/)?.[0] ?? '';

    expect(lifecycleSection).toContain('`cancelled` — moved to the archive store immediately');
    expect(lifecycleSection).toContain('Any → `cancelled`: manager confirms, move to the archive store');
    expect(lifecycleSection).toContain('Move them to the archive store.');
    expect(lifecycleSection).toContain('append a reopen entry to the task history store');
    expect(lifecycleSection).toContain('Look for the task in the archive store');
    expect(lifecycleSection).toContain('restore it to the active board data store');
    expect(lifecycleSection).toContain("Each task's active history must not exceed 50 entries");
    expect(lifecycleSection).not.toContain('`cancelled` — moved to ARCHIVE.json immediately');
    expect(lifecycleSection).not.toContain('Any → `cancelled`: manager confirms, move to ARCHIVE.json');
    expect(lifecycleSection).not.toContain('Move them to ARCHIVE.json.');
  });

  it('CLAUDE.md.template standard-mode restore appends a restored history entry', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const restoreSection =
      content.match(/### Reopen and Restore[\s\S]*?### History Cap/)?.[0] ?? '';

    // The reabrir (reopen) command records history — restore must too
    expect(restoreSection).toContain('append a reopen entry to the task history store');
    // Bug fix: restaurar must also record a "restored" history entry, matching
    // the hierarchy-mode restore (Step 5) which explicitly INSERTs action='restored'
    // into task_history. Without this, restored tasks have no audit trail.
    expect(restoreSection).toContain('append a `"restored"` entry to the task history store');
  });

  it('CLAUDE.md.template uses structured notes and richer filtered queries', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('New notes must be stored as objects');
    expect(content).toContain('"id": 1');
    expect(content).toContain('"text": "cliente pediu ajuste no item 3"');
    expect(content).toContain('"updated_at": "2026-02-27T15:00:00.000Z"');
    expect(content).toContain('Legacy string notes from older boards remain valid and readable');
    expect(content).toContain('Only structured note objects with `id` can be edited or removed');
    expect(content).toContain('Append a structured note object to `notes[]` with `text`, `by`, and `created_at`, plus `id` and `updated_at`');
    expect(content).toContain('notes (render structured note IDs plus any legacy strings)');

    expect(content).toContain('"inbox" / "mostrar inbox"');
    expect(content).toContain('"em revisao"');
    expect(content).toContain('"em revisao do [pessoa]"');
    expect(content).toContain('"proxima acao" / "proximas acoes"');
    expect(content).toContain('"em andamento"');
    expect(content).toContain('"aguardando do [pessoa]" / "bloqueadas do [pessoa]"');
    expect(content).toContain('"buscar [texto]"');
    expect(content).toContain('Search active tasks by case-insensitive substring across `title`, `next_action`, `waiting_for`, and note text');
    expect(content).toContain('"buscar [texto] com rotulo [nome]"');
    expect(content).toContain('"urgentes" / "prioridade urgente"');
    expect(content).toContain('"prioridade alta" / "alta prioridade"');
    expect(content).toContain('"rotulo [nome]" / "rotulo: [nome]"');
    expect(content).toContain('"buscar rotulo [nome]" / "buscar rotulo: [nome]"');
  });

  it('CLAUDE.md.template quick capture does not require inline history for hierarchy boards', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const gtdSection =
      content.match(/## GTD Rules[\s\S]*?### Processing Inbox/)?.[0] ?? '';

    expect(gtdSection).toContain('Standard boards: initialize `history` as `[]`');
    expect(gtdSection).toContain('Hierarchy boards: do not create inline `history`; record lifecycle entries in `task_history`');
    expect(gtdSection).not.toContain('- Always initialize `history` as `[]`');
  });

  it('CLAUDE.md.template task creation init lists keep inline history only in the mode-aware GTD examples', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // 1. Quick Capture section must initialize history (mode-aware)
    const quickCapture =
      content.match(/### Quick Capture \(Inbox\)[\s\S]*?(?=When the user provides assignee)/)?.[0] ?? '';
    expect(quickCapture).toContain('initialize `history`');

    // 2. Full creation (assignee+details) section must initialize history (mode-aware)
    const fullCreation =
      content.match(/When the user provides assignee and details from the start:[\s\S]*?### Processing Inbox/)?.[0] ?? '';
    expect(fullCreation).toContain('initialize `history`');

    // 3. General creation rule (Command Parsing summary) must use the shared active-history-store note
    const generalRule =
      content.match(/For any newly created task \(simple, project, or recurring\), always initialize[^\n]*/)?.[0] ?? '';
    expect(generalRule).not.toContain('`history` as `[]`');
    expect(generalRule).toContain('`_last_mutation` as `null`');
    expect(content).toContain('Use the active history store for lifecycle records (`history[]` in standard mode, `task_history` in hierarchy mode).');
  });

  it('CLAUDE.md.template shared command mutations record to the active history store', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const commandSection =
      content.match(/## Command Parsing[\s\S]*?### Batch Operations/)?.[0] ?? '';

    expect(commandSection).toContain('record the rework reason in the active history store');
    expect(commandSection).toContain('record `due_date_changed` in the active history store');
    expect(commandSection).toContain('record it in the active history store');
    expect(commandSection).toContain('Record `bulk_reassigned` in the active history store for each transferred task');
    expect(commandSection).toContain('Record `description_changed` in the active history store');
    expect(commandSection).toContain('Record the change in the active history store.');
    expect(commandSection).not.toContain('record `due_date_changed` in history');
    expect(commandSection).not.toContain('Record `bulk_reassigned` in history for each task');
  });

  it('CLAUDE.md.template shared history-driven queries use the active history store', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const querySection =
      content.match(/### Queries & Management[\s\S]*?### Batch Operations/)?.[0] ?? '';

    expect(querySection).toContain('the last 5 entries from the active history store');
    expect(querySection).toContain('latest completion record in the active history store');
    expect(querySection).toContain('completion records in the active history store for the current month');
    expect(querySection).toContain('completion records in the active history store for the current week');
    expect(querySection).toContain('Scan the active history store for entries with today\'s date');
    expect(querySection).toContain('scan the active history store for entries since yesterday');
    expect(querySection).toContain('scan the active history store for entries in the current week');
    expect(querySection).not.toContain('Show tasks moved to Done during the current week');
    expect(querySection).not.toContain('match by latest history entry with `action: "moved"`, `to: "done"` and today\'s date');
    expect(querySection).not.toContain('match by history `moved` → `done` in current month');
    expect(querySection).not.toContain('Scan all active task histories for entries with today\'s date');
  });

  it('CLAUDE.md.template error handling covers reopen and restore failures', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('Task not done');
    expect(content).toContain('Subtask not completed');
    expect(content).toContain('Archived task not found');
    expect(content).toContain('Note not found');
    expect(content).toContain('Legacy note immutable');
    expect(content).toContain('Last full manager');
  });

  it('CLAUDE.md.template defines task priority, labels, and display rules', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('`priority`: one of `"low"`, `"normal"`, `"high"`, `"urgent"`');
    expect(content).toContain('`labels`: ordered list of short lowercase tags');
    expect(content).toContain('"priority_changed"');
    expect(content).toContain('"label_added"');
    expect(content).toContain('"label_removed"');
    expect(content).toContain('Always initialize `priority` as `"normal"`');
    expect(content).toContain('Always initialize `labels` as `[]`');
    expect(content).toContain('Priority markers:');
    expect(content).toContain('`urgent` => `!!`');
    expect(content).toContain('`high` => `!`');
    expect(content).toContain('Label display:');
    expect(content).toContain('Prefer urgent tasks first when ordering digest sections');
  });

  it('CLAUDE.md.template has error handling section', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('### Error Handling');
    expect(content).toContain('Invalid task ID');
    expect(content).toContain('Unknown person name');
    expect(content).toContain('Task already in target column');
    expect(content).toContain('Invalid date');
    expect(content).toContain('Invalid subtask ID');
    expect(content).toContain('Never modify the board data store when an error occurs');
  });

  it('CLAUDE.md.template shared error examples do not hardcode ARCHIVE.json', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const errorSection =
      content.match(/### Error Handling[\s\S]*?## Standup Format/)?.[0] ?? '';

    expect(errorSection).toContain('Dependency target archived');
    expect(errorSection).toContain('T-002 is already in the archive store');
    expect(errorSection).not.toContain('T-002 is in ARCHIVE.json');
  });

  it('CLAUDE.md.template has project progress display in board format', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('subtask progress');
    expect(content).toContain('P-001 (2/4)');
  });

  it('SKILL.md documents ATTACHMENT_IMPORT_REASON as raw text (no quotes)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('ATTACHMENT_IMPORT_REASON=');
    expect(skillMd).not.toContain('ATTACHMENT_IMPORT_REASON="');
  });

  it('all placeholders in templates are consistent with SKILL.md', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const claudeTemplate = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const tasksTemplate = fs.readFileSync(
      path.join(skillDir, 'templates', 'TASKS.json.template'),
      'utf-8',
    );
    const archiveTemplate = fs.readFileSync(
      path.join(skillDir, 'templates', 'ARCHIVE.json.template'),
      'utf-8',
    );

    // Extract all {{PLACEHOLDER}} names from templates
    const templatePlaceholders = new Set<string>();
    for (const tmpl of [claudeTemplate, tasksTemplate, archiveTemplate]) {
      const matches = tmpl.matchAll(/\{\{([A-Z_]+)\}\}/g);
      for (const m of matches) templatePlaceholders.add(m[1]);
    }

    // Every placeholder should be documented in SKILL.md Phase 2
    for (const placeholder of templatePlaceholders) {
      expect(skillMd).toContain(`{{${placeholder}}}`);
    }
  });

  it('SKILL.md seeding code placeholders are all documented in the placeholder list', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    // Extract the placeholder list section (Phase 2 Step 3)
    const listSection =
      skillMd.match(
        /Substitute all.*?Write the result to/s,
      )?.[0] ?? '';

    // Extract all {{PLACEHOLDER}} names used in root board seeding (Phase 2 Step 8c)
    const seedingSection =
      skillMd.match(
        /Root board\n.*?db\.close\(\)/s,
      )?.[0] ?? '';

    const seedingPlaceholders = new Set<string>();
    for (const m of seedingSection.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
      seedingPlaceholders.add(m[1]);
    }

    // Every placeholder in seeding code must be in the list
    for (const placeholder of seedingPlaceholders) {
      expect(listSection).toContain(
        `{{${placeholder}}}`,
      );
    }
  });

  it('SKILL.md documents child provisioning PERSON_* placeholders before using them', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    const phase6 =
      skillMd.match(/## Phase 6:.*?## Phase 7:/s)?.[0] ??
      skillMd.match(/## Phase 6:.*$/s)?.[0] ??
      '';

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

  it('SKILL.md uses {{BOARD_ID}} consistently in hierarchy root-board snippets', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    const rootSeedSection =
      skillMd.match(/#### 8c\. Seed Root Board Data.*?#### 8e\./s)?.[0] ?? '';
    expect(rootSeedSection).toContain("const boardId = '{{BOARD_ID}}';");
    expect(rootSeedSection).not.toContain(
      "const boardId = 'board-{{GROUP_FOLDER}}';",
    );
    expect(rootSeedSection).toContain('Primary manager must also exist in board_people');
    expect(rootSeedSection).toContain("db.prepare('INSERT INTO board_people");

    const phase3HierarchyPeople =
      (
        skillMd.match(
          /\*\*Hierarchy boards:\*\*.*?source of truth for assignees/s,
        )?.[0]
      ) ?? '';
    expect(phase3HierarchyPeople).toContain("stmt.run('{{BOARD_ID}}'");
  });

  it('SKILL.md keeps runner prompt env vars topology-aware', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain(
      'Use the same environment variable names (`STANDUP_PROMPT`, `DIGEST_PROMPT`, `REVIEW_PROMPT`) for both topologies.',
    );
    expect(skillMd).toContain('do not reuse the JSON-mode prompt text');
    expect(skillMd).toContain(
      'using the prompt set that matches the selected topology',
    );
  });

  it('SKILL.md prompt-injection guardrails include create_group depth checks', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const guardrails =
      skillMd.match(/### 5\. Prompt-Injection Guardrails.*?### 6\./s)?.[0] ??
      '';

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

    expect(phase6).toContain(
      'mkdir -p groups/{{CHILD_GROUP_FOLDER}}/conversations groups/{{CHILD_GROUP_FOLDER}}/logs',
    );
    expect(phase6).toContain(
      'mkdir -p data/sessions/{{CHILD_GROUP_FOLDER}}/.claude',
    );
  });

  it('SKILL.md child provisioning explicitly remaps {{PARENT_BOARD_ID}} (not defaulting to none)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    // Extract the "Generate Child CLAUDE.md" step from Phase 6
    const phase6 = skillMd.match(/## Phase 6:.*$/s)?.[0] ?? '';
    const childClaudeMdStep =
      phase6.match(/### 6\. Generate Child CLAUDE\.md.*?### 7\./s)?.[0] ?? '';

    // The explicit placeholder remapping list must include {{PARENT_BOARD_ID}}
    // so the wizard doesn't fall back to the root-board default of "none".
    // Without this, the child board's CLAUDE.md would have PARENT_BOARD_ID=none
    // and linked_parent_board_id in SQL queries would use the literal string 'none'.
    expect(childClaudeMdStep).toContain('{{PARENT_BOARD_ID}}');
    expect(childClaudeMdStep).toContain('do NOT use `none`');
    expect(childClaudeMdStep).toContain('only for root boards');
  });

  it('CLAUDE.md.template has help command that skips all board-data loads', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('"ajuda" / "comandos" / "help"');
    expect(content).toContain('Do NOT read any board data for this');
    // Scope guard suggests ajuda for off-topic queries
    expect(content).toContain('suggest `ajuda`');
    // Help is in the Everyone permission group
    expect(content).toContain('help command');
  });

  it('CLAUDE.md.template has return-to-queue (devolver) command and transition', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Transition rule
    expect(content).toContain('`in_progress` → `next_action`');
    // Command in Board Movement table
    expect(content).toContain('"devolver T-XXX"');
    expect(content).toContain('Move from In Progress back to Next Action');
    // In assignee permissions
    expect(content).toContain('`in_progress -> next_action` (devolver)');
  });

  it('CLAUDE.md.template has completed tasks query commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('"concluidas hoje"');
    expect(content).toContain('"concluidas esta semana"');
  });

  it('CLAUDE.md.template shared query commands do not hardcode standard-mode storage', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const querySection =
      content.match(/### Queries & Management[\s\S]*?### Batch Operations/)?.[0] ??
      '';

    expect(querySection).toContain(
      'all entries from `history[]` in standard mode, or all rows from `task_history` in hierarchy mode',
    );
    expect(querySection).toContain('the archive store');
    expect(querySection).toContain('Read active tasks plus the archive store');
    expect(querySection).not.toContain('Show the 20 most recently archived tasks from ARCHIVE.json');
    expect(querySection).not.toContain('Search ARCHIVE.json');
  });

  it('CLAUDE.md.template has modify recurrence command', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('"alterar recorrencia R-XXX para [frequencia]"');
    expect(content).toContain('Change recurrence frequency');
    expect(content).toContain('"recurrence_changed"');
  });

  it('CLAUDE.md.template has date format convention tied to language', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(content).toContain('### Date Format Convention');
    expect(content).toContain('`pt-BR`, `es-ES`: DD/MM');
    expect(content).toContain('`en-US`: MM/DD');
    expect(content).toContain('{{LANGUAGE}}');
  });

  it('SKILL.md clarifies manager as team member in Phase 3', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('Manager as team member');
    expect(skillMd).toContain('Always register the primary full manager in the active people store');
    expect(skillMd).toContain('sender identification and admin authorization work');
    expect(skillMd).toContain('`meta.managers[]` / `meta.manager`');
    expect(skillMd).toContain('`board_admins`');
  });

  // ── New feature tests (F1–F15) ──────────────────────────────────────

  it('CLAUDE.md.template schema includes description, blocked_by, reminders, and _last_mutation fields', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // F15: description field in simple task schema
    expect(content).toContain('"description": null');
    // F15: max 500 characters limit
    expect(content).toContain('max 500 characters');
    // F15: description initialized as null in init rules
    expect(content).toContain('Always initialize `description` as `null`');

    // F11: blocked_by field in simple task schema
    expect(content).toContain('"blocked_by": []');
    // F11: blocked_by initialized as empty array
    expect(content).toContain('Always initialize `blocked_by` as `[]`');

    // F13: reminders field in simple task schema
    expect(content).toContain('"reminders": []');
    // F13: reminders initialized as empty array
    expect(content).toContain('Always initialize `reminders` as `[]`');
    // F13: offset_days in reminder object
    expect(content).toContain('offset_days');
    // F13: schedule_task(schedule_type: "once") for reminders
    expect(content).toContain('schedule_task(schedule_type: "once")');

    // F9: _last_mutation field in simple task schema
    expect(content).toContain('"_last_mutation": null');
    // F9: _last_mutation initialized as null
    expect(content).toContain('Always initialize `_last_mutation` as `null`');
  });

  it('CLAUDE.md.template history actions include new feature entries', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // F15: description_changed history action
    expect(content).toContain('"description_changed"');

    // F11: dependency history actions
    expect(content).toContain('"dependency_added"');
    expect(content).toContain('"dependency_removed"');
    expect(content).toContain('"dependency_resolved"');

    // F8: bulk_reassigned history action
    expect(content).toContain('"bulk_reassigned"');

    // F9: undone history action
    expect(content).toContain('"undone"');
  });

  it('CLAUDE.md.template has new command patterns for F1, F2, F3, F4, F5', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // F1: Remove due date command
    expect(content).toContain('"remover prazo T-XXX"');

    // F2: Completed by person
    expect(content).toContain('"concluidas do [pessoa]"');

    // F3: Completed this month
    expect(content).toContain('"concluidas do mes"');
    expect(content).toContain('"concluidas este mes"');

    // F4: Ad-hoc digest (distinct from resumo semanal)
    expect(content).toContain('"resumo"');
    // Verify it's documented as distinct from weekly review
    expect(content).toContain('Distinct from `"resumo semanal"`');

    // F5: Archive browsing
    expect(content).toContain('"listar arquivo"');
    expect(content).toContain('"buscar no arquivo [texto]"');
  });

  it('CLAUDE.md.template has new command patterns for F7, F8, F10, F11, F13, F15', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // F7: Calendar view commands
    expect(content).toContain('"agenda"');
    expect(content).toContain('"agenda da semana"');
    // F7: Agenda shows next 14 days
    expect(content).toContain('next 14 days');

    // F8: Bulk reassign command
    expect(content).toContain('"transferir tarefas do [pessoa] para [pessoa]"');

    // F10: Changelog view commands
    expect(content).toContain('"o que mudou hoje?"');
    expect(content).toContain('"mudancas hoje"');
    expect(content).toContain('"o que mudou desde ontem?"');
    expect(content).toContain('"o que mudou esta semana?"');

    // F11: Dependency commands
    expect(content).toContain('"T-XXX depende de T-YYY"');
    expect(content).toContain('"remover dependencia T-XXX de T-YYY"');

    // F13: Reminder commands
    expect(content).toContain('"lembrete T-XXX [N] dia(s) antes"');
    expect(content).toContain('"remover lembrete T-XXX"');

    // F15: Description command
    expect(content).toContain('"descricao T-XXX: [texto]"');
    // F15: Description in task creation syntax
    expect(content).toContain('Descricao:');
  });

  it('CLAUDE.md.template has new dedicated sections for dependencies, reminders, batch ops, undo, and statistics', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // F11: Task Dependencies section
    expect(content).toContain('### Task Dependencies');

    // F13: Deadline Reminders section
    expect(content).toContain('### Deadline Reminders');

    // F6: Batch Operations section
    expect(content).toContain('### Batch Operations');

    // F9: Undo section
    expect(content).toContain('### Undo');

    // F14: Statistics Display Format section
    expect(content).toContain('## Statistics Display Format');
  });

  it('CLAUDE.md.template has batch operation details with plural verb forms and result format', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // F6: Plural verb forms trigger batch mode
    expect(content).toContain('aprovadas');
    expect(content).toContain('concluidas');
    // F6: Result format
    expect(content).toContain('Resultado:');
  });

  it('CLAUDE.md.template has undo mechanics with 60-second window and desfazer command', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // F9: desfazer command
    expect(content).toContain('"desfazer"');
    // F9: 60-second window
    expect(content).toContain('60 second');
    // F9: undone history action
    expect(content).toContain('"undone"');
    // F9: _last_mutation snapshot mechanism
    expect(content).toContain('_last_mutation');
    expect(content).toContain('"snapshot"');
  });

  it('CLAUDE.md.template has error cases for new features', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // F11: Circular dependency error
    expect(content).toContain('Circular dependency');
    expect(content).toContain('circular chain');

    // F11: Self-dependency error
    expect(content).toContain('A task cannot depend on itself');

    // F11: Dependency already exists
    expect(content).toContain('already depends on');

    // F11: Dependency target archived
    expect(content).toContain('Dependencies can only reference active tasks');

    // F13: Reminder without due_date error
    expect(content).toContain('does not have a due date. Set a due date first');

    // F15: Description too long error
    expect(content).toContain('Description exceeds 500 characters');

    // F8: Bulk reassign same person error
    expect(content).toContain('Source and target are the same person.');

    // F1: No due date to remove error
    expect(content).toContain('does not have a due date');
  });

  it('CLAUDE.md.template has statistics metrics and recurring projects', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // F14: Statistics commands
    expect(content).toContain('"estatisticas"');
    expect(content).toContain('"estatisticas do [pessoa]"');
    expect(content).toContain('"estatisticas do mes"');
    // F14: Average cycle time metric
    expect(content).toContain('Average cycle time');
    // F14: Throughput trend metric
    expect(content).toContain('Throughput trend');
    // F14: Cap at 90 days
    expect(content).toContain('90 days');

    // F12: Recurring projects command
    expect(content).toContain('"projeto recorrente para X: Y. Etapas: ... todo [freq]"');
    // F12: Recurring projects documented in Projects section
    expect(content).toContain('Recurring projects');
  });

  it('CLAUDE.md.template authorization rules include new feature permissions', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // F15: update description in auth rules
    expect(content).toContain('update description');

    // F11: add or remove dependencies in auth rules
    expect(content).toContain('add or remove dependencies');

    // F13: add or remove deadline reminders in auth rules
    expect(content).toContain('add or remove deadline reminders');

    // F1: remove due dates in auth rules
    expect(content).toContain('remove due dates');

    // F8: bulk reassign in auth rules
    expect(content).toContain('bulk reassign');
  });

  it('CLAUDE.md.template documents recurring cycle reset behavior for new fields', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Recurring cycle resets blocked_by and reminders, preserves description
    expect(content).toContain('Reset `blocked_by` to `[]`');
    expect(content).toContain('clear `reminders` to `[]`');
    expect(content).toContain('Preserve `description` across cycles');

    // F1 x F13 cross-reference: removing due_date cancels reminders
    expect(content).toContain('Cancel on due_date removal');
    expect(content).toContain('cancel them all via `cancel_task` and clear `reminders[]`');
    expect(content).toContain('Cancel on task cancellation');
    expect(content).toContain('Before moving a task to archive via `cancelar`, cancel all reminder scheduled tasks');
    expect(content).toContain('Warn about tasks that will be unblocked');
    expect(content).toContain('blocking task was cancelled');
  });

  it('CLAUDE.md.template recurring cycle completion clears notes and resets next_note_id', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Extract the recurring task schema section (between "### Task (recurring" and "### History Entry")
    const recurringSection =
      content.match(/### Task \(recurring.*?### History Entry/s)?.[0] ?? '';
    expect(recurringSection.length).toBeGreaterThan(0);

    // The "On completion" rule must explicitly clear notes and reset next_note_id.
    // Notes are per-cycle operational context (like blocked_by and reminders),
    // not persistent task metadata (like description). Carrying stale notes from
    // a previous cycle into the next cycle would confuse the team with obsolete
    // per-cycle observations. Without this rule, the agent has no guidance on
    // whether to preserve or clear notes during cycle advancement, leading to
    // inconsistent behavior across recurring task completions.
    expect(recurringSection).toContain("Clear `notes` to `[]`");
    expect(recurringSection).toContain("reset `next_note_id` to `1`");
    expect(recurringSection).toContain('notes are per-cycle operational context');

    // Verify it appears in the same "On completion" sentence as the other resets
    const completionLine = content
      .split('\n')
      .find((l) => l.includes('On completion:') && l.includes('increment `cycle`'));
    expect(completionLine).toBeDefined();
    expect(completionLine!).toContain('Clear `notes` to `[]`');
    expect(completionLine!).toContain('reset `next_note_id` to `1`');
  });

  it('operator guide and user manual reflect reminders, cancellation cleanup, and schema migration boundary', () => {
    const repoRoot = path.resolve(skillDir, '..', '..', '..');
    const operatorGuide = fs.readFileSync(
      path.join(repoRoot, 'docs', 'taskflow-operator-guide.md'),
      'utf-8',
    );
    const userManual = fs.readFileSync(
      path.join(repoRoot, 'docs', 'taskflow-user-manual.md'),
      'utf-8',
    );

    expect(operatorGuide).toContain('Tasks can now track per-task reminders in `reminders[]`');
    expect(operatorGuide).toContain('Treat `meta.schema_version` as a real migration boundary');
    expect(operatorGuide).toContain('When upgrading a legacy `1.0` board:');
    expect(operatorGuide).toContain('Rewrite the board as `meta.schema_version: "2.0"`');
    expect(userManual).toContain('avisa antes da confirmação quais tarefas serão destravadas');
    expect(userManual).toContain('os lembretes ativos também são cancelados antes do arquivamento');
  });

  it('documents explicit 1.0 to 2.0 normalization and keeps archived plan examples aligned', () => {
    const repoRoot = path.resolve(skillDir, '..', '..', '..');
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const archivedDesign = fs.readFileSync(
      path.join(repoRoot, 'docs', 'plans', '2026-02-24-taskflow-design.md'),
      'utf-8',
    );
    const archivedImplementation = fs.readFileSync(
      path.join(repoRoot, 'docs', 'plans', '2026-02-24-taskflow-implementation.md'),
      'utf-8',
    );

    expect(content).toContain('Normalization for legacy `"1.0"` before the first mutation:');
    expect(content).toContain('If `meta.managers[]` is missing, synthesize it from `meta.manager`');
    expect(content).toContain('For every active task, backfill missing fields:');
    expect(content).toContain('If `next_note_id` is missing, set it to `max(structured note ids) + 1`');
    expect(content).toContain('persist the board back as `meta.schema_version = "2.0"`');

    expect(archivedDesign).toContain('"schema_version": "2.0"');
    expect(archivedImplementation).toContain('"schema_version": "2.0"');
    expect(archivedImplementation).toContain("expect(parsed.meta.schema_version).toBe('2.0');");
    expect(archivedImplementation).toContain('Per-task reminders, when enabled later, are task-local entries in `reminders[]`');
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

  it('SKILL.md has root board provisioning (Phase 2 Step 8)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    // DB init via CLI
    expect(skillMd).toContain('node dist/taskflow-db.js');
    // .mcp.json for SQLite MCP server
    expect(skillMd).toContain('.mcp.json');
    expect(skillMd).toContain('mcp-server-sqlite-npx');
    // Root board seeding
    expect(skillMd).toContain("'hierarchy'");
    expect(skillMd).toContain('board_config');
    expect(skillMd).toContain('board_runtime_config');
    expect(skillMd).toContain('board_admins');
  });

  it('SKILL.md has child board provisioning (Phase 6)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('## Phase 6: Child Board Provisioning');
    // Pre-flight checks
    expect(skillMd).toContain('CHILD_GROUP_JID');
    expect(skillMd).toContain('CHILD_GROUP_FOLDER');
    // Child board registration
    expect(skillMd).toContain('child_board_registrations');
    // Child CLAUDE.md generation
    expect(skillMd).toContain('Generate Child CLAUDE.md');
    // Board removal
    expect(skillMd).toContain('Board Removal');
  });

  it('SKILL.md child board provisioning uses {{PERSON_ROLE}} placeholder (not hardcoded role)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    // The board_people INSERT in child provisioning must use {{PERSON_ROLE}},
    // not a hardcoded value like 'manager'. board_people.role is for job
    // function (e.g., "Tecnico"), not admin permissions.
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
    // Pre-flight checks must mention reading role from parent board
    expect(childSection).toContain('board_people.role');
  });

  it('SKILL.md uses consistent admin_role "manager" for both root and child boards', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    // Root board admin (Phase 2 Step 8c)
    const rootAdminMatch = skillMd.match(
      /Root board.*?board_admins.*?'manager'/s,
    );
    expect(rootAdminMatch).not.toBeNull();
    // Child board admin (Phase 6 Step 5) — must also be 'manager'
    const childAdminMatch = skillMd.match(
      /Child board.*?board_admins.*?'manager'/s,
    );
    expect(childAdminMatch).not.toBeNull();
    // All board_admins INSERTs must use 'manager', not 'full'
    const adminInserts = skillMd.match(
      /INSERT INTO board_admins.*?'(full|manager)'/g,
    );
    for (const insert of adminInserts ?? []) {
      expect(insert).toContain("'manager'");
    }
  });

  it('CLAUDE.md.template has hierarchy mode section with board identity', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('## Hierarchy Mode (SQLite-Backed Boards)');
    expect(content).toContain('### Board Identity');
    expect(content).toContain('{{BOARD_ID}}');
    expect(content).toContain('{{BOARD_ROLE}}');
    expect(content).toContain('{{HIERARCHY_LEVEL}}');
    expect(content).toContain('{{MAX_DEPTH}}');
    expect(content).toContain('{{PARENT_BOARD_ID}}');
  });

  it('CLAUDE.md.template hierarchy uses SQLite MCP tools, not TASKS.json', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // SQLite MCP tools documented
    expect(content).toContain('mcp__sqlite__read_query');
    expect(content).toContain('mcp__sqlite__write_query');
    expect(content).toContain('mcp__sqlite__list_tables');
    expect(content).toContain('mcp__sqlite__describe_table');
    // Explicit exclusion of JSON files for hierarchy
    expect(content).toContain(
      'Do NOT use TASKS.json or ARCHIVE.json',
    );
    expect(content).toContain('hierarchy boards use SQLite exclusively');
  });

  it('CLAUDE.md.template hierarchy has board_role gate to skip section for standard boards', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain(
      "If `{{BOARD_ROLE}}` is `standard` or missing, **skip this entire section**",
    );
  });

  it('CLAUDE.md.template hierarchy has ID generation using a single global board_config counter', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### ID Generation (Hierarchy)');
    expect(content).toContain('next_task_number');
    // Hierarchy mode must use a single global counter (next_task_number) for ALL
    // task types (T/P/R), matching standard mode's global next_id invariant.
    // Separate per-type counters (next_project_number, next_recurring_number) would
    // let T-001 and P-001 coexist with the same number, violating the documented
    // rule: "The counter is global across all types."
    expect(content).not.toContain('next_project_number');
    expect(content).not.toContain('next_recurring_number');
    expect(content).toContain('Use `next_task_number` for ALL task types');
  });

  it('CLAUDE.md.template hierarchy has sender identification from board_people/board_admins', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Sender Identification (Hierarchy)');
    expect(content).toContain('board_people.name');
    expect(content).toContain("board_admins.admin_role");
    expect(content).toContain("'manager'` = manager");
    expect(content).toContain("'delegate'` = delegate");
    expect(content).toContain('is_primary_manager = 1');
  });

  it('CLAUDE.md.template hierarchy has WIP limits from board_people then board_config fallback', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### WIP Limits (Hierarchy)');
    expect(content).toContain('board_people.wip_limit');
    expect(content).toContain('board_config.wip_limit');
  });

  it('CLAUDE.md.template hierarchy has archival and history via SQL', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Archival (Hierarchy)');
    expect(content).toContain('archive');
    expect(content).toContain('task_snapshot');
    expect(content).toContain('### History (Hierarchy)');
    expect(content).toContain('task_history');
    // History caps
    expect(content).toContain('Cap at 50 active entries per task');
    expect(content).toContain('latest 20 history entries');
  });

  it('CLAUDE.md.template hierarchy archival cleans up task_history (no orphaned rows)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const archivalSection =
      content.match(/### Archival \(Hierarchy\).*?### History/s)?.[0] ?? '';
    // Must instruct the agent to DELETE from task_history during archival
    expect(archivalSection).toContain('DELETE from `task_history`');
    // Must also cover cancellation cleanup
    expect(content).toContain("archive_reason = 'cancelled'");
    // The cancellation cleanup note must mention task_history
    const cancelCleanup = content.match(
      /cancell.*?task.*?archive.*?task_history|task_history.*?cancel/is,
    );
    expect(cancelCleanup).not.toBeNull();
  });

  it('CLAUDE.md.template hierarchy has restore (restaurar) flow with SQL queries', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // Must have a dedicated Restore (Hierarchy) section
    expect(content).toContain('### Restore (Hierarchy)');
    // Must include SQL to query archive
    const restoreSection =
      content.match(/### Restore \(Hierarchy\).*?###/s)?.[0] ?? '';
    expect(restoreSection).toContain('archive');
    // Must include INSERT back into tasks
    expect(restoreSection).toMatch(/INSERT.*tasks/i);
    // Must include DELETE from archive after restore
    expect(restoreSection).toMatch(/DELETE.*archive/i);
  });

  it('CLAUDE.md.template review → in_progress transition checks WIP', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // The review → in_progress transition rule must mention WIP checking
    const reviewTransition = content.match(
      /review.*?→.*?in_progress.*?(?:\n|.){0,200}/i,
    )?.[0] ?? '';
    expect(reviewTransition.toLowerCase()).toContain('wip');
  });

  it('CLAUDE.md.template hierarchy attachment_audit_log INSERT uses correct SQLite column names', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // Must have an explicit INSERT INTO attachment_audit_log with correct column names
    const insertMatch = content.match(
      /INSERT INTO attachment_audit_log\s*\([^)]+\)/i,
    )?.[0] ?? '';
    expect(insertMatch).toContain('board_id');
    expect(insertMatch).toContain('actor_person_id');
    expect(insertMatch).toContain('affected_task_refs');
  });

  it('CLAUDE.md.template hierarchy has child board registration queries', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Child Board Registrations');
    expect(content).toContain('child_board_registrations');
  });

  it('CLAUDE.md.template hierarchy has all provisioning commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // Board creation
    expect(content).toContain('criar quadro para [pessoa]');
    expect(content).toContain('registrar quadro para [pessoa]');
    // Board removal
    expect(content).toContain('remover quadro do [pessoa]');
    // History actions
    expect(content).toContain('child_board_created');
    expect(content).toContain('child_board_removed');
  });

  it('CLAUDE.md.template hierarchy provisioning uses confirmed request flow', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const section =
      content.match(/### Hierarchy Commands[\s\S]*?#### Task hierarchy/)?.[0] ??
      '';

    expect(section).toContain('operator or approved automation');
    expect(section).toContain('TaskFlow setup skill (Phase 6)');
    expect(section).toContain(
      'only after provisioning is confirmed and `child_board_registrations` contains the new child board',
    );
  });

  it('CLAUDE.md.template hierarchy has task link/unlink/refresh/view commands', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // Link
    expect(content).toContain('vincular T-XXX ao quadro do [pessoa]');
    expect(content).toContain('usar equipe de [pessoa] para T-XXX');
    // Unlink
    expect(content).toContain('desvincular T-XXX');
    // Refresh
    expect(content).toContain('atualizar status T-XXX');
    expect(content).toContain('sincronizar T-XXX');
    // View
    expect(content).toContain('resumo de execucao T-XXX');
    // History actions
    expect(content).toContain('child_board_linked');
    expect(content).toContain('child_board_unlinked');
    expect(content).toContain('child_rollup_updated');
  });

  it('CLAUDE.md.template hierarchy has upward tagging command', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('ligar tarefa ao pai T-XXX');
    expect(content).toContain('linked_parent_board_id');
    expect(content).toContain('linked_parent_task_id');
    // Root board restriction
    expect(content).toContain(
      'Este e o quadro raiz. Nao ha quadro pai.',
    );
  });

  it('CLAUDE.md.template hierarchy has leaf board restrictions', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // Leaf cannot create child boards
    expect(content).toContain(
      'Este e um quadro folha',
    );
    // Leaf cannot link tasks downward
    expect(content).toContain('Cannot link on leaf boards');
  });

  it('CLAUDE.md.template hierarchy has auto-link on assignment', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Auto-Link on Assignment');
    expect(content).toContain(
      'tem um quadro registrado. Vincular T-XXX automaticamente?',
    );
  });

  it('CLAUDE.md.template hierarchy has authority while linked rules', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Authority While Linked');
    expect(content).toContain('child_exec_enabled = 1');
    expect(content).toContain('column` is rollup-managed');
    expect(content).toContain('normal assignee movement is disabled');
    expect(content).toContain('board owner must unlink first');
  });

  it('CLAUDE.md.template hierarchy has reassignment rules while linked', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Reassignment While Linked');
    expect(content).toContain('No silent transfer of linkage');
  });

  it('CLAUDE.md.template hierarchy has review rejection while linked', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Review Rejection While Linked');
    expect(content).toContain("rollup_status` resets to `active");
  });

  it('CLAUDE.md.template hierarchy has task type restrictions (R-XXX cannot be linked)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Task Type Restrictions');
    expect(content).toContain(
      'Recurring tasks (R-XXX): Cannot be linked',
    );
    expect(content).toContain(
      'Tarefas recorrentes nao podem ser vinculadas a quadros',
    );
  });

  it('CLAUDE.md.template hierarchy has display markers for linked tasks', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Display Markers');
    // Board view marker
    expect(content).toContain('🔗 T-004');
    // Standup format
    expect(content).toContain('🔗 Alexandre');
    // Stale rollup warning
    expect(content).toContain('rollup desatualizado');
  });

  it('CLAUDE.md.template hierarchy has rollup engine with SQL queries and mapping table', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Rollup Engine');
    // Step 1: active work query
    expect(content).toContain('total_count');
    expect(content).toContain('open_count');
    expect(content).toContain('waiting_count');
    expect(content).toContain('overdue_count');
    // Step 2: cancelled work query
    expect(content).toContain('cancelled_count');
    expect(content).toContain("archive_reason = 'cancelled'");
    // Step 3: mapping table
    expect(content).toContain('Apply mapping rules');
    expect(content).toContain('`total_count > 0` AND `open_count = 0` AND `cancelled_count = 0`');
    // Step 4: update parent task
    expect(content).toContain('child_exec_rollup_status');
    expect(content).toContain('child_exec_last_rollup_at');
    expect(content).toContain('child_exec_last_rollup_summary');
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
    // Priority order documented — cancelled_needs_decision must be highest
    expect(content).toContain(
      'cancelled_needs_decision` > `ready_for_review` > `blocked` > `at_risk` > `active` > `no_work_yet',
    );
  });

  it('CLAUDE.md.template hierarchy has staleness detection and failure handling', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // 24h staleness threshold
    expect(content).toContain('older than 24 hours');
    // Failure handling
    expect(content).toContain('SQL query fails');
    expect(content).toContain('child board registration is missing');
    expect(content).toContain('child board has been deleted');
  });

  it('CLAUDE.md.template hierarchy enforces non-adjacent boundary', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Non-Adjacent Boundary');
    expect(content).toContain('must NOT');
    expect(content).toContain('Query boards more than one level away');
    expect(content).toContain('grandchild rollup');
    expect(content).toContain('Mutate non-adjacent state');
    expect(content).toContain('Reference sibling boards');
  });

  it('CLAUDE.md.template hierarchy documents v2 feature interactions', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Interaction with v2 Features');
    // blocked_by is board-local
    expect(content).toContain('board-local only');
    // reminders unaffected
    expect(content).toContain('reminders` continue to fire');
    // description does not roll up
    expect(content).toContain('description` does not roll up');
    // _last_mutation excluded from rollup
    expect(content).toContain(
      'Rollup-driven column changes are NOT captured in `_last_mutation`',
    );
    // attachment policy
    expect(content).toContain('board_runtime_config.attachment_');
    expect(content).toContain('attachment_audit_log');
  });

  it('CLAUDE.md.template hierarchy has disambiguation between resumo and rollup view', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('### Disambiguation');
    expect(content).toContain(
      '`"resumo"` alone',
    );
    expect(content).toContain(
      '`"resumo de execucao T-XXX"`',
    );
    expect(content).toContain('task ID suffix disambiguates');
  });

  it('CLAUDE.md.template has hierarchy placeholders in configuration footer', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // Configuration section should include hierarchy fields
    const configSection = content.split('## Configuration')[1] ?? '';
    expect(configSection).toContain('Board role: {{BOARD_ROLE}}');
    expect(configSection).toContain('Board ID: {{BOARD_ID}}');
    expect(configSection).toContain('Hierarchy level: {{HIERARCHY_LEVEL}}');
    expect(configSection).toContain('Max depth: {{MAX_DEPTH}}');
    expect(configSection).toContain('Parent board ID: {{PARENT_BOARD_ID}}');
  });

  it('design doc has no_work_yet in allowed rollup_status list', () => {
    const repoRoot = path.resolve(skillDir, '..', '..', '..');
    const design = fs.readFileSync(
      path.join(
        repoRoot,
        'docs',
        'plans',
        '2026-02-28-taskflow-hierarchical-delegation-design.md',
      ),
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

  it('design doc and template agree on all 9 hierarchy history actions', () => {
    const repoRoot = path.resolve(skillDir, '..', '..', '..');
    const design = fs.readFileSync(
      path.join(
        repoRoot,
        'docs',
        'plans',
        '2026-02-28-taskflow-hierarchical-delegation-design.md',
      ),
      'utf-8',
    );
    const template = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const historyActions = [
      'child_board_created',
      'child_board_removed',
      'child_board_linked',
      'child_board_unlinked',
      'child_rollup_updated',
      'child_rollup_blocked',
      'child_rollup_at_risk',
      'child_rollup_completed',
      'child_rollup_cancelled',
    ];
    for (const action of historyActions) {
      expect(design).toContain(action);
      expect(template).toContain(action);
    }
  });

  // ── Negative assertions (prevent regressions) ──────────────────────

  it('CLAUDE.md.template does NOT use per-level field names instead of generic child_exec_*', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // Must use generic child_exec_*, not level-specific names
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
    // The hierarchy section should not reference reading other groups' TASKS.json
    const hierarchySection =
      content.split('## Hierarchy Mode')[1]?.split('## Configuration')[0] ?? '';
    expect(hierarchySection).not.toContain('groups/');
    expect(hierarchySection).not.toMatch(/\/workspace\/group\/.*TASKS\.json/);
  });

  it('CLAUDE.md.template hierarchy does NOT allow recurring tasks to be linked', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain(
      'Recurring tasks (R-XXX): Cannot be linked',
    );
  });

  it('taskflow-db schema has all required tables and hierarchy columns', () => {
    const repoRoot = path.resolve(skillDir, '..', '..', '..');
    const dbModule = fs.readFileSync(
      path.join(repoRoot, 'src', 'taskflow-db.ts'),
      'utf-8',
    );
    // Tables
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
    // Hierarchy columns on tasks
    expect(dbModule).toContain('child_exec_enabled');
    expect(dbModule).toContain('child_exec_board_id');
    expect(dbModule).toContain('child_exec_rollup_status');
    expect(dbModule).toContain('linked_parent_board_id');
    expect(dbModule).toContain('linked_parent_task_id');
    // WAL mode
    expect(dbModule).toContain("journal_mode = WAL");
    // Foreign keys
    expect(dbModule).toContain("foreign_keys = ON");
  });

  it('existing IPC tools still documented for runners on hierarchy boards', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // Even hierarchy boards use IPC tools for runners/reminders
    expect(content).toContain('send_message');
    expect(content).toContain('schedule_task');
    expect(content).toContain('cancel_task');
    expect(content).toContain('list_tasks');
  });

  it('CLAUDE.md.template rollup SQL scopes by both parent board and parent task for independent multi-link', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // The rollup query must filter by BOTH parent board ID and parent task ID
    // so multiple parent tasks linking to the same child board get independent rollup
    const rollupSection =
      content.split('### Rollup Engine')[1]?.split('### Non-Adjacent')[0] ?? '';
    expect(rollupSection).toContain('linked_parent_board_id');
    expect(rollupSection).toContain('linked_parent_task_id');
    // Both must appear in the WHERE clause of the active-work query
    expect(rollupSection).toContain(
      "AND linked_parent_board_id = '{{BOARD_ID}}'",
    );
    expect(rollupSection).toContain(
      'AND linked_parent_task_id = :task_id',
    );
  });

  it('CLAUDE.md.template hierarchy documents assistant as direct root-level role', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    // The design says "assistant is a direct root-level role" — the user manual
    // mentions it, and the template should not introduce a separate tier
    expect(content).not.toContain('assistant board');
    expect(content).not.toContain('assistant tier');
  });

  it('CLAUDE.md.template hierarchy provisioning refuses duplicate child boards', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('Refuse if already registered');
    expect(content).toContain('child_board_registrations');
  });

  it('CLAUDE.md.template hierarchy board removal refuses when active linked tasks exist', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain('Refuse if linked tasks exist');
    expect(content).toContain('child_exec_enabled = 1');
    expect(content).toContain('child_exec_person_id');
  });

  it('CLAUDE.md.template hierarchy board removal keeps detached child board alive', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    expect(content).toContain(
      'child board itself remains operational as a detached hierarchy board',
    );
    expect(content).toContain('re-parented or decommissioned separately');
  });

  it('CLAUDE.md.template hierarchy review rejection does not require non-main cross-group send', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const section =
      content.match(/### Review Rejection While Linked[\s\S]*?### Task Type Restrictions/)?.[0] ??
      '';

    expect(section).toContain(
      'Do NOT assume this board can send cross-group messages',
    );
    expect(section).toContain(
      'Only the main group can use cross-group `send_message`',
    );
    expect(section).toContain('notify the child board manually');
  });

  it('CLAUDE.md.template done shortcut (concluida/feita) is Assignee-or-manager, not Assignee-only', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Extract the Authorization Rules section
    const authSection =
      content.match(/## Authorization Rules[\s\S]*?## File Paths/)?.[0] ?? '';

    // Extract the Assignee-only block
    const assigneeOnlyBlock =
      authSection.match(/Assignee-only commands:[\s\S]*?(?=- Assignee-or-manager|- Delegate|- Full|- Everyone|- Attachment|- Enforcement)/)?.[0] ?? '';

    // Extract the Assignee-or-manager block
    const assigneeOrManagerBlock =
      authSection.match(/Assignee-or-manager commands:[\s\S]*?(?=- Attachment|- Everyone|- Enforcement)/)?.[0] ?? '';

    // The done shortcut must NOT be in the Assignee-only section
    expect(assigneeOnlyBlock).not.toContain('concluida');
    expect(assigneeOnlyBlock).not.toContain('feita');

    // The done shortcut MUST be in the Assignee-or-manager section
    // (consistent with Transition Rules "Any -> done: assignee or manager"
    // and Command Parsing table "Assignee or manager. Move to Done (shortcut)")
    expect(assigneeOrManagerBlock).toContain('concluida');
    expect(assigneeOrManagerBlock).toContain('feita');

    // Cross-check: Transition Rules say "assignee or manager"
    expect(content).toContain('Any → `done`: assignee or manager can shortcut');
    // Cross-check: Command Parsing table says "Assignee or manager"
    expect(content).toContain('"T-XXX concluida" / "T-XXX feita" | Assignee or manager.');
  });

  it('CLAUDE.md.template hierarchy archival specifies archive_reason for both done and cancelled paths', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const archivalSection =
      content.match(/### Archival \(Hierarchy\)[\s\S]*?### Restore \(Hierarchy\)/)?.[0] ?? '';

    // The archive table has archive_reason TEXT NOT NULL, so every INSERT must
    // specify a value. The cancel path already uses 'cancelled'. The done-task
    // auto-archival (30-day cleanup) must explicitly specify 'done' so that:
    //   1. The NOT NULL constraint is satisfied
    //   2. The Rollup Engine's "archive_reason = 'cancelled'" filter correctly
    //      excludes done-archived tasks from the cancelled_count
    expect(archivalSection).toContain("archive_reason = 'done'");
    expect(archivalSection).toContain("archive_reason = 'cancelled'");
  });

  it('CLAUDE.md.template rollup engine Step 4 sets waiting_for when column moves to waiting and clears it otherwise', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const rollupSection =
      content.split('### Rollup Engine')[1]?.split('### Non-Adjacent')[0] ?? '';

    // The Step 4 UPDATE must include waiting_for in its SET clause.
    // When rollup_status = 'blocked' the parent column moves to 'waiting',
    // and the Waiting For Rule requires waiting_for to be filled.
    // When the parent column transitions away from 'waiting', waiting_for
    // must be cleared to NULL.
    expect(rollupSection).toContain('waiting_for');
    // Must conditionally set based on new_column
    expect(rollupSection).toContain("WHEN :new_column = 'waiting'");
    // Must clear to NULL when not waiting
    expect(rollupSection).toContain('ELSE NULL');
  });

  it('CLAUDE.md.template command table disambiguates "revisao" (weekly review) from "em revisao" (Review column filter)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const commandSection =
      content.split('### Queries & Management')[1]?.split('###')[0] ?? '';

    // "em revisao" should show Review column tasks (board query)
    expect(commandSection).toContain('"em revisao"');
    expect(commandSection).toMatch(/"em revisao".*Show only tasks currently in Review/);

    // "revisao" alone must NOT be mapped to the Review column filter.
    // It must instead trigger the Weekly Review format (like "resumo semanal").
    // The old bug had: "revisao" / "em revisao" | Show only tasks currently in Review
    // which conflicted with the "resumo" row's note that "revisao" triggers weekly review.
    const reviewColumnRow = commandSection.match(
      /\|\s*"revisao"\s*\/\s*"em revisao"\s*\|/,
    );
    expect(reviewColumnRow).toBeNull();

    // "resumo semanal" / "revisao" should trigger the weekly review
    expect(commandSection).toMatch(/"resumo semanal"\s*\/\s*"revisao"/);
    expect(commandSection).toMatch(/"resumo semanal".*Weekly Review/);

    // "resumo" (without "semanal") should trigger the Manager Digest, not the weekly review
    expect(commandSection).toMatch(/"resumo"\s*\|.*Manager Digest/);
  });

  it('SKILL.md Phase 6 Step 8 uses child board ID (not {{BOARD_ID}}) for runner ID UPDATE', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    // Extract Phase 6 Step 8 (Schedule Child Runners)
    const phase6 = skillMd.match(/## Phase 6:.*$/s)?.[0] ?? '';
    const step8 =
      phase6.match(/### 8\. Schedule Child Runners.*?### 9\./s)?.[0] ?? '';

    // The UPDATE board_runtime_config in Phase 6 Step 8 must target the
    // CHILD board's row, not the parent board's row. The global placeholder
    // {{BOARD_ID}} refers to the parent board in the SKILL.md context (it is
    // only remapped for CLAUDE.md template generation in Step 6). Using
    // {{BOARD_ID}} in the Step 8 SQL snippet would overwrite the parent
    // board's runner IDs instead of persisting the child board's runner IDs.
    // The fix is to use 'board-{{CHILD_GROUP_FOLDER}}' explicitly.
    expect(step8).toContain("const childBoardId = 'board-{{CHILD_GROUP_FOLDER}}'");
    expect(step8).toContain('childBoardId');
    // Must NOT use the bare {{BOARD_ID}} placeholder in the WHERE clause
    expect(step8).not.toContain("'{{BOARD_ID}}'");
  });

  it('CLAUDE.md.template reassignment and bulk transfer check WIP on target assignee', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Single reassignment must check WIP on the new assignee when task is in_progress
    const reatribuirLine = content
      .split('\n')
      .find((l) => l.includes('reatribuir T-XXX para [pessoa]'));
    expect(reatribuirLine).toBeDefined();
    expect(reatribuirLine!.toLowerCase()).toContain('wip');
    expect(reatribuirLine).toContain('in_progress');

    // Bulk transfer must check WIP on the target person
    const transferirLine = content
      .split('\n')
      .find((l) => l.includes('transferir tarefas do [pessoa] para [pessoa]'));
    expect(transferirLine).toBeDefined();
    expect(transferirLine!.toLowerCase()).toContain('wip');

    // Error messages must cover both reassignment and bulk transfer WIP cases
    expect(content).toContain('Reassign WIP exceeded');
    expect(content).toContain('Bulk transfer WIP exceeded');

    // Person removal must also warn about WIP when reassigning in_progress tasks
    const removerLine = content
      .split('\n')
      .find((l) => l.includes('"remover [nome]"'));
    expect(removerLine).toBeDefined();
    expect(removerLine!.toLowerCase()).toContain('wip');
  });

  it('CLAUDE.md.template hierarchy board removal requires confirmation and scopes linked-task check to board_id', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Extract the board removal section from Hierarchy Commands (not Confirmation Required)
    const hierarchyCommands =
      content.match(/#### Board provisioning[\s\S]*?#### Task hierarchy/)?.[0] ?? '';
    const removalSection =
      hierarchyCommands.match(/- `remover quadro do \[pessoa\]`[\s\S]*?(?=\n#### Task hierarchy)/)?.[0] ?? '';
    expect(removalSection.length).toBeGreaterThan(0);

    // Bug fix: board removal is a destructive operation that severs the
    // parent-child relationship. It must require explicit confirmation,
    // consistent with all other destructive operations (cancel, reassign,
    // delete person, remove manager/delegate).
    expect(removalSection).toContain('Confirmation required');

    // Bug fix: the linked-task check must include board_id = '{{BOARD_ID}}'
    // to scope the query to the current board. Without it, tasks on other
    // boards in a multi-level hierarchy could incorrectly block removal.
    expect(removalSection).toContain("board_id = '{{BOARD_ID}}'");
    expect(removalSection).toContain('child_exec_enabled = 1');
    expect(removalSection).toContain('child_exec_person_id = :person_id');

    // The Confirmation Required section must list board removal
    const confirmSection =
      content.match(/### Confirmation Required[\s\S]*?### Error Handling/)?.[0] ?? '';
    expect(confirmSection).toContain('remover quadro');
  });

  it('SKILL.md Step 8d UPDATE sets dst_sync_enabled and dst_last_offset_minutes alongside runner IDs', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    // Extract Phase 2 Step 8d section
    const step8d =
      skillMd.match(/#### 8d\. Runner Task IDs.*?#### 8e\./s)?.[0] ?? '';
    expect(step8d).not.toBe('');

    // The UPDATE must set DST state columns, not just runner task IDs.
    // Without dst_sync_enabled, the DST guard thinks sync is disabled (column defaults to 0).
    // Without dst_last_offset_minutes, the first guard run cannot compare offsets (column defaults to NULL).
    expect(step8d).toContain('dst_sync_enabled');
    expect(step8d).toContain('dst_last_offset_minutes');
    expect(step8d).toContain('dst_last_synced_at');

    // The UPDATE must pass DST_GUARD_ENABLED and TIMEZONE as env vars
    // so it can conditionally compute the current offset
    expect(step8d).toContain('DST_GUARD_ENABLED');
    expect(step8d).toContain('TIMEZONE');
  });

  it('SKILL.md Phase 6 Step 8 child runner UPDATE also sets DST state columns', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    // Extract Phase 6 Step 8
    const phase6 = skillMd.match(/## Phase 6:.*$/s)?.[0] ?? '';
    const step8 =
      phase6.match(/### 8\. Schedule Child Runners.*?### 9\./s)?.[0] ?? '';
    expect(step8).not.toBe('');

    // Child board UPDATE must also set DST state columns, same as root board Step 8d
    expect(step8).toContain('dst_sync_enabled');
    expect(step8).toContain('dst_last_offset_minutes');
    expect(step8).toContain('dst_last_synced_at');
    expect(step8).toContain('DST_GUARD_ENABLED');
    expect(step8).toContain('TIMEZONE');
  });

  it('CLAUDE.md.template Attachment Intake section is storage-mode aware for hierarchy boards', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Extract the Attachment Intake section
    const attachmentSection =
      content.match(
        /### Attachment Intake[\s\S]*?## Command Parsing/,
      )?.[0] ?? '';
    expect(attachmentSection.length).toBeGreaterThan(0);

    // Bug fix: The Attachment Intake section previously only referenced
    // standard-mode TASKS.json fields (meta.attachment_policy.enabled) for the
    // attachment policy gate and (meta.attachment_audit_trail) for the audit
    // trail. In hierarchy mode, the agent never reads TASKS.json, so it would
    // have no way to check attachment policy or record audit entries.
    //
    // The fix adds dual-mode instructions:
    // - Policy gate: hierarchy boards check board_runtime_config.attachment_enabled
    // - Audit trail: hierarchy boards INSERT into attachment_audit_log

    // Policy gate must reference both standard and hierarchy paths
    expect(attachmentSection).toContain(
      'Standard / separate boards: check `meta.attachment_policy.enabled`',
    );
    expect(attachmentSection).toContain('board_runtime_config');
    expect(attachmentSection).toContain('attachment_enabled');
    expect(attachmentSection).toContain('attachment_disabled_reason');

    // Audit trail must have both standard and hierarchy paths
    expect(attachmentSection).toContain(
      'Standard / separate boards: on every confirmed attachment import',
    );
    expect(attachmentSection).toContain('meta.attachment_audit_trail');
    expect(attachmentSection).toContain(
      'Hierarchy boards: on every confirmed attachment import',
    );
    expect(attachmentSection).toContain('INSERT');
    expect(attachmentSection).toContain('attachment_audit_log');

    // Must NOT have the old standard-only policy gate
    expect(attachmentSection).not.toMatch(
      /^Before doing any attachment import logic, check `meta\.attachment_policy\.enabled`:/m,
    );
    // Must NOT have the old standard-only audit trail
    expect(attachmentSection).not.toMatch(
      /^- On every confirmed attachment import, append an entry to `meta\.attachment_audit_trail` in `TASKS\.json`:/m,
    );
  });

  it('hierarchy mode uses a single global counter for all task types (no per-type counters)', () => {
    // REGRESSION: hierarchy mode previously used separate counters
    // (next_task_number, next_project_number, next_recurring_number) which let
    // T-001 and P-001 coexist with the same number, violating the documented
    // rule: "The counter is global across all types."

    // 1. CLAUDE.md.template hierarchy section must NOT reference per-type counters
    const claudeTemplate = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );
    const hierarchyIdSection =
      claudeTemplate.match(
        /### ID Generation \(Hierarchy\)[\s\S]*?### Sender Identification/,
      )?.[0] ?? '';
    expect(hierarchyIdSection).toContain('next_task_number');
    expect(hierarchyIdSection).toContain(
      'Use `next_task_number` for ALL task types',
    );
    expect(hierarchyIdSection).not.toContain('next_project_number');
    expect(hierarchyIdSection).not.toContain('next_recurring_number');
    // Must state the counter is global, matching standard mode invariant
    expect(hierarchyIdSection).toContain('global across all types');

    // 2. taskflow-db.ts schema must NOT have per-type counter columns
    const dbSchema = fs.readFileSync(
      path.resolve(skillDir, '../../../src/taskflow-db.ts'),
      'utf-8',
    );
    expect(dbSchema).toContain('next_task_number');
    expect(dbSchema).not.toContain('next_project_number');
    expect(dbSchema).not.toContain('next_recurring_number');
  });

  it('CLAUDE.md.template recurrence schema has month field for yearly tasks', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // The yearly creation command takes D/M (day and month), so the recurrence
    // schema must have a `month` field to store the month component.
    expect(content).toContain('`recurrence.month`: month 1-12. Required for yearly');

    // recurrence.day should describe day-of-month for yearly (not day-of-year)
    // because the creation command "anual para X: Y todo dia D/M" uses D/M format
    expect(content).toContain('day of month 1-31 (monthly/yearly)');

    // Must NOT use the broken "day of year" definition for yearly recurrence
    expect(content).not.toContain('day of year');
  });

  it('CLAUDE.md.template digest Waiting/Blocked section differentiates waiting_for from blocked_by', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Extract the Manager Digest section
    const digestSection =
      content.split('## Manager Digest')[1]?.split('## Weekly Review')[0] ?? '';
    expect(digestSection.length).toBeGreaterThan(0);

    // The "Waiting / Blocked" section must distinguish between two kinds of items:
    // 1. Tasks in the `waiting` column — these have `waiting_for` set
    // 2. Tasks with non-empty `blocked_by` — these may be in any column and do NOT
    //    have `waiting_for` set. They need to display the blocking task IDs instead.
    //
    // The old format used a single line: [waiting_for] ([X days])
    // which would render blank for blocked tasks since waiting_for is null for them.
    // The fix adds separate format lines for each case.

    // Must have format line for waiting tasks referencing waiting_for
    expect(digestSection).toContain('waiting` column');
    expect(digestSection).toContain('[waiting_for]');

    // Must have format line for blocked tasks referencing blocked_by
    expect(digestSection).toContain('blocked_by');
    expect(digestSection).toContain('blocked by');

    // Blocked tasks format must exclude done column (done tasks can't be "blocked")
    expect(digestSection).toContain('except `done`');

    // Must NOT have the old single-format-line that only used [waiting_for]
    // for both waiting and blocked tasks
    const waitingBlockedSection =
      digestSection.match(/Waiting \/ Blocked[\s\S]*?(?=\n[^\n]*\*No update)/)?.[0] ?? '';
    expect(waitingBlockedSection).not.toMatch(
      /^[^F]*\[ID\].*\[waiting_for\].*\[X days\]\)$/m,
    );
  });

  it('SKILL.md Phase 5 Step 8 scopes schema_version checks to standard/separate boards only', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    // The archive and lifecycle verification step must scope schema_version
    // normalization to standard/separate boards only, since hierarchy boards
    // do not use meta.schema_version (they use SQLite as their data store).
    const archiveSection =
      skillMd.split('### 8. Archive and Lifecycle Checks')[1]?.split('### 9.')[0] ?? '';

    // The schema_version bullet must be scoped to standard/separate boards
    expect(archiveSection).toContain('Standard / separate boards only:');
    expect(archiveSection).toContain('hierarchy boards do not use `meta.schema_version`');

    // It must NOT have an unscoped schema_version check
    expect(archiveSection).not.toMatch(
      /^- Existing legacy/m,
    );
  });

  it('CLAUDE.md.template undo checks WIP limit when restoring a task to in_progress', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // The Undo section must mention WIP guard when snapshot column is in_progress
    const undoSection =
      content.split('### Undo')[1]?.split('###')[0] ?? '';
    expect(undoSection).toContain('WIP guard');
    expect(undoSection).toContain('in_progress');
    expect(undoSection).toContain('forcar desfazer');

    // The error handling section must include the undo WIP error
    expect(content).toContain('Undo WIP exceeded');
    expect(content).toContain("forcar desfazer");
  });

  it('CLAUDE.md.template "remover [nome]" cascades cleanup to admin entries and child board registrations', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Extract the "remover [nome]" command line from the commands table
    const removerLine = content
      .split('\n')
      .find((l) => l.includes('"remover [nome]"'));
    expect(removerLine).toBeDefined();

    // Bug fix: removing a person must also cascade-delete their admin entries
    // (board_admins in hierarchy / meta.managers[] in standard) and their
    // child_board_registrations row in hierarchy mode. Without this, orphaned
    // admin rows and child board registrations persist because the schema has
    // no ON DELETE CASCADE between board_people ↔ board_admins / child_board_registrations.
    expect(removerLine!).toContain('board_admins');
    expect(removerLine!).toContain('meta.managers[]');
    expect(removerLine!).toContain('child_board_registrations');

    // Must refuse if cascade would remove the last full manager
    expect(removerLine!).toContain('last full manager');

    // Must refuse if linked tasks reference this person's child board
    expect(removerLine!).toContain('child_exec_person_id');
  });

  it('CLAUDE.md.template digest "No update" section includes priority marker and labels', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Extract the Manager Digest section
    const digestSection =
      content.split('## Manager Digest')[1]?.split('## Weekly Review')[0] ?? '';
    expect(digestSection.length).toBeGreaterThan(0);

    // The "No update (24h+)" section shows active tasks that have been stale.
    // These are actionable tasks and must include [priority marker] [labels]
    // just like every other active-task digest section (Overdue, Next 48h,
    // Waiting/Blocked). Without them, the manager loses context needed to
    // triage stale tasks.
    const noUpdateLine = digestSection
      .split('\n')
      .find((l) => l.includes('last update [date]'));
    expect(noUpdateLine).toBeDefined();
    expect(noUpdateLine!).toContain('[priority marker]');
    expect(noUpdateLine!).toContain('[labels]');
  });

  it('CLAUDE.md.template bulk transfer and single reassign enforce linked-task guard for hierarchy mode', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Bug: bulk transfer ("transferir tarefas do [pessoa] para [pessoa]") and
    // single reassign ("reatribuir T-XXX para [pessoa]") did not check for
    // child_exec_enabled linked tasks. The "Reassignment While Linked" section
    // requires unlinking before reassignment, but neither command enforced it.
    // This could silently break the child execution invariant where
    // task.assignee != task.child_exec_person_id.

    // Single reassign must refuse when the task has child_exec_enabled = 1
    const reatribuirLine = content
      .split('\n')
      .find((l) => l.includes('reatribuir T-XXX para [pessoa]'));
    expect(reatribuirLine).toBeDefined();
    expect(reatribuirLine!).toContain('child_exec_enabled');
    expect(reatribuirLine!).toContain('desvincular');

    // Bulk transfer must exclude linked tasks from the transfer set
    const transferirLine = content
      .split('\n')
      .find((l) => l.includes('transferir tarefas do [pessoa] para [pessoa]'));
    expect(transferirLine).toBeDefined();
    expect(transferirLine!).toContain('child_exec_enabled');
    expect(transferirLine!).toContain('Linked-task guard');
    expect(transferirLine!).toContain('desvincular');

    // Error messages must cover both reassignment and bulk transfer linked-task cases
    expect(content).toContain('Reassign linked task');
    expect(content).toContain('Bulk transfer linked tasks');
    expect(content).toContain('desvincular T-001');
  });

  it('CLAUDE.md.template has hierarchy-mode SQL for blocked_by dependency resolution on done and cancel', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Bug: The hierarchy-mode section had no SQL guidance for resolving
    // blocked_by references when a task moves to done or is cancelled.
    // The general Task Dependencies section describes the logic in terms
    // of blocked_by[] array manipulation (standard-mode TASKS.json), but
    // hierarchy mode stores blocked_by as a TEXT column with a JSON string.
    // Without explicit SQL steps, an agent would leave stale task IDs in
    // other tasks' blocked_by arrays after completing or cancelling a
    // blocking task in hierarchy mode.

    // Must have a dedicated "Dependency Resolution (Hierarchy)" section
    const hierSection = content.split('If `{{BOARD_ROLE}}` is `standard` or missing')[1] ?? '';
    expect(hierSection).toContain('### Dependency Resolution (Hierarchy)');

    // Must include SQL to find affected tasks by LIKE match on blocked_by
    const depSection =
      hierSection.split('### Dependency Resolution (Hierarchy)')[1]?.split('###')[0] ?? '';
    expect(depSection.length).toBeGreaterThan(0);
    expect(depSection).toContain('blocked_by LIKE');
    expect(depSection).toContain(':resolved_task_id');

    // Must include SQL to update blocked_by with filtered JSON
    expect(depSection).toContain('UPDATE tasks');
    expect(depSection).toContain(':new_blocked_by_json');

    // Must include SQL to record dependency_resolved in task_history
    expect(depSection).toContain('dependency_resolved');
    expect(depSection).toContain('INSERT INTO task_history');

    // Must specify both trigger situations: done and cancelled
    expect(depSection).toContain('moves to `done`');
    expect(depSection).toContain('cancelled');

    // The hierarchy cancellation procedure must reference dependency resolution
    const archivalSection =
      hierSection.split('### Archival (Hierarchy)')[1]?.split('### Restore')[0] ?? '';
    expect(archivalSection).toContain('blocked_by');
    expect(archivalSection).toContain('dependency_resolved');
    expect(archivalSection).toContain('Dependency Resolution');
  });

  it('SKILL.md hierarchy DST offset calculation has division inside Math.round (not outside)', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    // Phase 2 Step 8d: hierarchy board DST offset in board_runtime_config
    // The division by 60000 must be INSIDE Math.round() to ensure an integer result.
    // Bug: `-Math.round(diff) / 60000` produces fractional minutes (e.g., 180.5)
    //       when the millisecond difference has sub-minute precision from toLocaleString.
    // Fix: `-Math.round(diff / 60000)` rounds after converting to minutes.
    //
    // The Phase 4 Step 3 standard-board version already does this correctly:
    //   `-Math.round((... .getTime() - ... .getTime()) / 60000)`
    // The hierarchy version must match.
    const phase2Section =
      skillMd.match(/#### 8d\. Runner Task IDs.*?#### 8e\./s)?.[0] ?? '';

    // Must NOT have the buggy pattern: round first, then divide
    // Buggy:  -Math.round(new Date(...).getTime() - new Date(...).getTime()) / 60000
    //         This parses as (-Math.round(diff)) / 60000 — division is outside round
    expect(phase2Section).not.toMatch(
      /Math\.round\([^)]*getTime\(\)[^)]*getTime\(\)\)\s*\/\s*60000/,
    );

    // Must HAVE the correct pattern: divide first, then round
    // Correct: -Math.round((new Date(...).getTime() - new Date(...).getTime()) / 60000)
    //          This ensures the result is always an integer.
    //          The outer Math.round(...) closes AFTER "/ 60000", wrapping the division.
    expect(phase2Section).toMatch(
      /Math\.round\(\(new Date.*?getTime\(\).*?\/\s*60000\)/,
    );
  });

  it('CLAUDE.md.template changelog queries include archived history for cancelled/archived tasks', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // "o que mudou hoje?" must scan archived history too, not just active history store.
    // Without this, cancellations and same-day archival events disappear from the changelog
    // because archival removes the task (and in hierarchy mode, deletes task_history rows).

    // Extract the full line for each changelog command (table rows end with " |")
    const lines = content.split('\n');
    const mudouHojeLine = lines.find(l => l.includes('"o que mudou hoje?"')) ?? '';
    const mudouOntemLine = lines.find(l => l.includes('"o que mudou desde ontem?"')) ?? '';
    const mudouSemanaLine = lines.find(l => l.includes('"o que mudou esta semana?"')) ?? '';

    expect(mudouHojeLine).toContain('archived history snapshots');
    expect(mudouOntemLine).toContain('archived history snapshots');
    expect(mudouSemanaLine).toContain('archived history snapshots');

    // Verify the "hoje" line doesn't only scan the active history store
    // (the old buggy pattern was: "Scan the active history store for entries with today's date. Display")
    expect(mudouHojeLine).not.toMatch(
      /Scan the active history store for entries with today's date\. Display/,
    );
  });

  it('CLAUDE.md.template recurring PROJECT completion also clears notes and resets next_note_id', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Extract the recurring projects section (the "Recurring projects:" block in the Projects subsection)
    const recurringProjectSection =
      content.match(/Recurring projects: Project tasks can optionally.*?Recurring projects follow the same permission rules/s)?.[0] ?? '';
    expect(recurringProjectSection.length).toBeGreaterThan(0);

    // The "On completion" rule for recurring projects must explicitly clear notes
    // and reset next_note_id, matching the behavior of recurring simple tasks (R-NNN).
    // Notes are per-cycle operational context. Without this, recurring projects
    // would carry stale notes from one cycle into the next, while recurring simple
    // tasks would correctly clear them — an inconsistency across recurring types
    // that affects both standard and hierarchy board topologies equally.
    expect(recurringProjectSection).toContain("Clear `notes` to `[]`");
    expect(recurringProjectSection).toContain("reset `next_note_id` to `1`");
    expect(recurringProjectSection).toContain('notes are per-cycle operational context');

    // Verify the recurring project "On completion" line contains the notes-clearing
    // instruction alongside the other cycle-reset steps
    const projectCompletionLine = content
      .split('\n')
      .find((l) => l.includes('On completion') && l.includes('Clone subtasks'));
    expect(projectCompletionLine).toBeDefined();
    expect(projectCompletionLine!).toContain('Clear `notes` to `[]`');
    expect(projectCompletionLine!).toContain('reset `next_note_id` to `1`');
    expect(projectCompletionLine!).toContain('Preserve `description` across cycles');
  });

});
