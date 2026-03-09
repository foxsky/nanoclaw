#!/usr/bin/env node
/**
 * Generate CLAUDE.md for TaskFlow groups from template.
 * Usage: node scripts/generate-claude-md.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const templatePath = path.join(PROJECT_ROOT, '.claude/skills/add-taskflow/templates/CLAUDE.md.template');
const template = fs.readFileSync(templatePath, 'utf-8');

// Shared values (common across all TaskFlow groups)
const shared = {
  '{{ASSISTANT_NAME}}': 'Case',
  '{{MANAGER_NAME}}': 'Miguel',
  '{{LANGUAGE}}': 'pt-BR',
  '{{TIMEZONE}}': 'America/Fortaleza',
  '{{WIP_LIMIT}}': '3',
  '{{STANDUP_CRON}}': '0 11 * * 1-5',
  '{{DIGEST_CRON}}': '0 21 * * 1-5',
  '{{REVIEW_CRON}}': '0 14 * * 5',
  '{{STANDUP_CRON_LOCAL}}': '0 8 * * 1-5',
  '{{DIGEST_CRON_LOCAL}}': '0 18 * * 1-5',
  '{{REVIEW_CRON_LOCAL}}': '0 11 * * 5',
  '{{ATTACHMENT_IMPORT_ENABLED}}': 'true',
  '{{ATTACHMENT_IMPORT_REASON}}': '',
  '{{DST_GUARD_ENABLED}}': 'false',
  '{{BOARD_ROLE}}': 'hierarchy',
  '{{HIERARCHY_LEVEL}}': '',
  '{{MAX_DEPTH}}': '3',
  '{{PARENT_BOARD_ID}}': '',
};

// Group-specific values (each group has its own BOARD_ID, JID, context, etc.)
const groups = [
  {
    folder: 'secti-taskflow',
    overrides: {
      '{{BOARD_ID}}': 'board-secti-taskflow',
      '{{GROUP_NAME}}': 'SECTI - TaskFlow',
      '{{GROUP_CONTEXT}}': 'the SECTI team',
      '{{GROUP_JID}}': '120363407145013007@g.us',
      '{{CONTROL_GROUP_HINT}}': '',
      '{{HIERARCHY_LEVEL}}': '1',
      '{{PARENT_BOARD_ID}}': '',
    },
  },
  {
    folder: 'sec-secti',
    overrides: {
      '{{BOARD_ID}}': 'board-secti-taskflow',
      '{{GROUP_NAME}}': 'SEC-SECTI - TaskFlow',
      '{{GROUP_CONTEXT}}': 'private management for the SECTI team',
      '{{GROUP_JID}}': '120363409319476199@g.us',
      '{{CONTROL_GROUP_HINT}}': '\nThis is the private management control group for Miguel. You share the same board as the team group "SECTI - TaskFlow". Commands you execute here affect the shared board. Messages sent via send_message go to this group only — the team group is not notified directly.',
      '{{HIERARCHY_LEVEL}}': '1',
      '{{PARENT_BOARD_ID}}': '',
    },
  },
  {
    folder: 'seci-taskflow',
    overrides: {
      '{{BOARD_ID}}': 'board-seci-taskflow',
      '{{GROUP_NAME}}': 'SECI-SECTI - TaskFlow',
      '{{GROUP_CONTEXT}}': "Giovanni's tasks (private standup channel)",
      '{{GROUP_JID}}': '120363406395935726@g.us',
      '{{CONTROL_GROUP_HINT}}': '',
      '{{HIERARCHY_LEVEL}}': '2',
      '{{PARENT_BOARD_ID}}': 'board-sec-taskflow',
      '{{MANAGER_NAME}}': 'Giovanni',
    },
  },
  {
    folder: 'tec-taskflow',
    overrides: {
      '{{BOARD_ID}}': 'board-tec-taskflow',
      '{{GROUP_NAME}}': 'Tec - TaskFlow',
      '{{GROUP_CONTEXT}}': "Alexandre's tasks (private standup channel)",
      '{{GROUP_JID}}': '120363407802260805@g.us',
      '{{CONTROL_GROUP_HINT}}': '',
      '{{HIERARCHY_LEVEL}}': '2',
      '{{PARENT_BOARD_ID}}': 'board-sec-taskflow',
      '{{MANAGER_NAME}}': 'Alexandre',
    },
  },
  {
    folder: 'ci-seci-taskflow',
    overrides: {
      '{{BOARD_ID}}': 'board-ci-seci-taskflow',
      '{{GROUP_NAME}}': 'CI-SECI-SECTI - TaskFlow',
      '{{GROUP_CONTEXT}}': "Mauro's tasks (private standup channel)",
      '{{GROUP_JID}}': '120363407206502707@g.us',
      '{{CONTROL_GROUP_HINT}}': '',
      '{{HIERARCHY_LEVEL}}': '3',
      '{{PARENT_BOARD_ID}}': 'board-seci-taskflow',
      '{{MANAGER_NAME}}': 'Mauro',
    },
  },
];

for (const group of groups) {
  const replacements = { ...shared, ...group.overrides };
  let content = template;
  for (const [key, value] of Object.entries(replacements)) {
    content = content.split(key).join(value);
  }

  const outputDir = path.join(PROJECT_ROOT, 'groups', group.folder);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'CLAUDE.md');
  fs.writeFileSync(outputPath, content, 'utf-8');
  console.log(`Written: ${outputPath} (${content.length} bytes)`);
}
