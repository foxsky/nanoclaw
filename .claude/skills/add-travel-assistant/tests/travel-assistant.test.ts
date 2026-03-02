import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('travel assistant skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has SKILL.md and template files', () => {
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
    expect(
      fs.existsSync(path.join(skillDir, 'templates', 'CLAUDE.md.template')),
    ).toBe(true);
  });

  it('SKILL.md includes required phases and post-trip decommissioning', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('## Phase 1: Pre-flight & Information Gathering');
    expect(skillMd).toContain('## Phase 2: Generate Group Files');
    expect(skillMd).toContain('## Phase 3: Register Group & Create Scheduled Tasks');
    expect(skillMd).toContain('## Phase 4: Advanced Features & Refinement');
    expect(skillMd).toContain('### 6. Phase 5: Trip Decommissioning');
  });

  it('SKILL.md documents runtime-based host timezone detection', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain(
      'TIMEZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone',
    );
    expect(skillMd).toContain('echo $TZ');
    expect(skillMd).toContain(
      'node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"',
    );
  });

  it('SKILL.md uses current SQLite schema for decommission fallback', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('sqlite3 store/messages.db');
    expect(skillMd).toContain('FROM scheduled_tasks');
    expect(skillMd).toContain("chat_jid = '{{GROUP_JID}}'");

    expect(skillMd).not.toContain('data/nanoclaw.db');
    expect(skillMd).not.toContain('FROM tasks');
    expect(skillMd).not.toContain('UPDATE tasks SET');
  });

  it('SKILL.md includes post-trip placeholders and reminder task', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('{{TRIP_END_DATE}}');
    expect(skillMd).toContain('{{HOME_TIMEZONE}}');
    expect(skillMd).toContain('Post-trip admin reminder');
  });

  it('template includes transit directions and post-trip lifecycle sections', () => {
    const template = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(template).toContain('## 12b. Public Transport Directions & Google Maps Links');
    expect(template).toContain('travelmode=transit');
    expect(template).toContain('## 15. Trip Lifecycle & Post-Trip Mode');
    expect(template).toContain('{{TRIP_END_DATE}}');
    expect(template).toContain('{{HOME_TIMEZONE}}');
    expect(template).toContain('wind-down');
    expect(template).toContain('archive mode');
  });

  it('template enforces group path usage only', () => {
    const template = fs.readFileSync(
      path.join(skillDir, 'templates', 'CLAUDE.md.template'),
      'utf-8',
    );

    expect(template).toContain('/workspace/group/');
    expect(template).not.toContain('/workspace/project/groups/');
  });
});
