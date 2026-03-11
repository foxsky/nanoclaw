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
      '{{BOARD_ID}}': 'board-sec-taskflow',
      '{{GROUP_NAME}}': 'SEC-SECTI - TaskFlow',
      '{{GROUP_CONTEXT}}': 'private management for the SECTI team',
      '{{GROUP_JID}}': '120363409319476199@g.us',
      '{{CONTROL_GROUP_HINT}}': '\nThis is the private management control group for Miguel. You operate the root board "SEC - TaskFlow". The team group "SECTI - TaskFlow" is a child board of this root. By default, `send_message` sends to this group — but the Notification System uses `target_chat_jid` to send cross-group notifications to assignees in their own groups.',
      '{{HIERARCHY_LEVEL}}': '1',
      '{{PARENT_BOARD_ID}}': '',
    },
  },
  {
    folder: 'e2e-taskflow',
    overrides: {
      '{{ASSISTANT_NAME}}': 'Tars',
      '{{BOARD_ID}}': 'board-e2e-taskflow',
      '{{GROUP_NAME}}': 'E2E Test Board',
      '{{GROUP_CONTEXT}}': 'E2E Test Board task board',
      '{{GROUP_JID}}': '120363406927955265@g.us',
      '{{CONTROL_GROUP_HINT}}': '',
      '{{HIERARCHY_LEVEL}}': '0',
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
    folder: 'setec-secti-taskflow',
    overrides: {
      '{{BOARD_ID}}': 'board-setec-secti-taskflow',
      '{{GROUP_NAME}}': 'SETEC-SECTI - TaskFlow',
      '{{GROUP_CONTEXT}}': "Rafael's tasks (private standup channel)",
      '{{GROUP_JID}}': '120363408810515104@g.us',
      '{{CONTROL_GROUP_HINT}}': '',
      '{{HIERARCHY_LEVEL}}': '2',
      '{{PARENT_BOARD_ID}}': 'board-sec-taskflow',
      '{{MANAGER_NAME}}': 'Rafael',
    },
  },
  {
    folder: 'laizys-taskflow',
    overrides: {
      '{{BOARD_ID}}': 'board-laizys-taskflow',
      '{{GROUP_NAME}}': 'SEAF-SECTI - TaskFlow',
      '{{GROUP_CONTEXT}}': "Laizys's tasks (private standup channel)",
      '{{GROUP_JID}}': '120363425774136187@g.us',
      '{{CONTROL_GROUP_HINT}}': '',
      '{{HIERARCHY_LEVEL}}': '2',
      '{{PARENT_BOARD_ID}}': 'board-sec-taskflow',
      '{{MANAGER_NAME}}': 'Laizys',
    },
  },
  {
    folder: 'thiago-taskflow',
    overrides: {
      '{{BOARD_ID}}': 'board-thiago-taskflow',
      '{{GROUP_NAME}}': 'SETD-SECTI - TaskFlow',
      '{{GROUP_CONTEXT}}': "Thiago's tasks (private standup channel)",
      '{{GROUP_JID}}': '120363423211033081@g.us',
      '{{CONTROL_GROUP_HINT}}': '',
      '{{HIERARCHY_LEVEL}}': '2',
      '{{PARENT_BOARD_ID}}': 'board-sec-taskflow',
      '{{MANAGER_NAME}}': 'Thiago',
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
  {
    folder: 'ux-setd-secti-taskflow',
    overrides: {
      '{{BOARD_ID}}': 'board-ux-setd-secti-taskflow',
      '{{GROUP_NAME}}': 'UX-SETD-SECTI - TaskFlow',
      '{{GROUP_CONTEXT}}': "Caio's tasks (private standup channel)",
      '{{GROUP_JID}}': '120363425088189365@g.us',
      '{{CONTROL_GROUP_HINT}}': '',
      '{{HIERARCHY_LEVEL}}': '3',
      '{{PARENT_BOARD_ID}}': 'board-thiago-taskflow',
      '{{MANAGER_NAME}}': 'Caio',
    },
  },
  {
    folder: 'test-taskflow',
    overrides: {
      '{{BOARD_ID}}': 'board-test-taskflow',
      '{{GROUP_NAME}}': 'TEST',
      '{{GROUP_CONTEXT}}': 'Test group for development',
      '{{GROUP_JID}}': '120363424971175850@g.us',
      '{{CONTROL_GROUP_HINT}}': '',
      '{{HIERARCHY_LEVEL}}': '0',
      '{{PARENT_BOARD_ID}}': '',
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
