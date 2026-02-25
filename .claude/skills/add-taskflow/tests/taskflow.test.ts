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

  it('has SKILL.md with all 5 phases', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('## Phase 1: Configuration');
    expect(skillMd).toContain('## Phase 2: Group Creation');
    expect(skillMd).toContain('## Phase 3: People Registration');
    expect(skillMd).toContain('## Phase 4: Runner Setup');
    expect(skillMd).toContain('## Phase 5: Verification');
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
      .replace(/\{\{WIP_LIMIT\}\}/g, '3')
      .replace(/\{\{STANDUP_CRON_LOCAL\}\}/g, '0 8 * * 1-5')
      .replace(/\{\{DIGEST_CRON_LOCAL\}\}/g, '0 18 * * 1-5')
      .replace(/\{\{REVIEW_CRON_LOCAL\}\}/g, '0 11 * * 5')
      .replace(/\{\{STANDUP_CRON\}\}/g, '0 11 * * 1-5')
      .replace(/\{\{DIGEST_CRON\}\}/g, '0 21 * * 1-5')
      .replace(/\{\{REVIEW_CRON\}\}/g, '0 14 * * 5');

    const parsed = JSON.parse(substituted);
    expect(parsed.meta.schema_version).toBe('1.0');
    expect(parsed.meta.columns).toHaveLength(6);
    expect(parsed.meta.wip_limit_default).toBe(3);
    expect(parsed.meta.runner_task_ids).toHaveProperty('standup');
    expect(parsed.meta.runner_task_ids).toHaveProperty('dst_guard');
    expect(parsed.meta.dst_sync).toHaveProperty('last_offset_minutes');
    expect(parsed.meta.attachment_policy.allowed_formats).toEqual(['pdf', 'jpg', 'png']);
    expect(parsed.people).toEqual([]);
    expect(parsed.tasks).toEqual([]);
    expect(parsed.next_id).toBe(1);
  });

  it('ARCHIVE.json.template is valid JSON after placeholder substitution', () => {
    const raw = fs.readFileSync(
      path.join(skillDir, 'templates', 'ARCHIVE.json.template'),
      'utf-8',
    );

    const substituted = raw.replace(/\{\{GROUP_NAME\}\}/g, 'Test Group');
    const parsed = JSON.parse(substituted);
    expect(parsed.meta.schema_version).toBe('1.0');
    expect(parsed.tasks).toEqual([]);
  });

  it('CLAUDE.md.template has all required sections', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    // Identity and data loading
    expect(content).toContain('CRITICAL: Load Data First');
    expect(content).toContain('TASKS.json');

    // Security
    expect(content).toContain('Security');
    expect(content).toContain('untrusted data');

    // Authorization
    expect(content).toContain('Authorization Rules');
    expect(content).toContain('Manager-only');

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
});
