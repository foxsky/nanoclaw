#!/usr/bin/env node
/**
 * One-shot migration: insert the "Multi-Action Turns" rule into existing
 * TaskFlow CLAUDE.md files that were not produced by the generator
 * (provisioned via src/ipc-plugins/provision-shared.ts and never
 * regenerated against the updated template).
 *
 * Idempotent: skips files that already contain the rule.
 * Safe: only inserts after a unique anchor; warns and skips files
 * where the anchor appears 0 or >1 times.
 *
 * Usage:
 *   node scripts/migrate-claude-md-multi-action.mjs <groups-dir>
 *
 * Locally (smoke test): node scripts/migrate-claude-md-multi-action.mjs groups
 * On prod:               ssh nanoclaw@host 'cd /home/nanoclaw/nanoclaw && node scripts/migrate-claude-md-multi-action.mjs groups'
 */
import fs from 'fs';
import path from 'path';

const RULE_MARKER = '## Multi-Action Turns';
// Anchor: closing sentence of the "Multiple Messages in a Session"
// rule. The new section follows immediately after — placement matches
// the canonical template at .claude/skills/add-taskflow/templates/CLAUDE.md.template.
const ANCHOR = 'confirm it in your response.';

const RULE_BODY = `

## Multi-Action Turns

When a single user message contains 2+ distinct write **action instances** (e.g., "adicionar nota X e alterar prazo da T14 para 30/04", "adicionar nota A, adicionar nota B, finalizar T13"), you MUST:

1. Identify every requested write operation, **including repeated uses of the same verb** — two \`adicionar nota\` requests are TWO actions, not one. Each note, each prazo change, each column move, each finalize is its own action.
2. Execute each action via its own \`taskflow_*\` tool call IN SEQUENCE — \`taskflow_update\`'s \`updates\` payload only fits one \`add_note\`, one \`due_date\`, etc., so multiple actions require multiple calls
3. After all calls complete (success or error), produce ONE reply that lists every action's outcome as a bullet point

**Do not let a single successful tool call satisfy a multi-action request.** After each tool call, re-read the user's original message action-by-action: if any action you identified is still pending, call the next tool BEFORE replying. do NOT stop after the first action just because the engine returned \`success: true\`.

**Anti-pattern (do NOT do this):** user says _"adicionar nota X e alterar prazo da T14 para 30/04"_ → bot calls \`taskflow_update({ task_id: 'T14', updates: { add_note: 'X' }, sender_name: SENDER })\` → engine returns success → bot replies _"✅ T14 atualizada"_. The prazo never executed and the user has no idea it was dropped.

**Correct pattern:** the same user message →
1. \`taskflow_update({ task_id: 'T14', updates: { add_note: 'X' }, sender_name: SENDER })\` → success
2. \`taskflow_update({ task_id: 'T14', updates: { due_date: '2026-04-30' }, sender_name: SENDER })\` → success
3. Reply: _"✅ T14 atualizada\\n• Nota: X\\n⏰ Prazo definido: 30/04/2026"_.`;

const groupsDir = process.argv[2] || 'groups';
if (!fs.existsSync(groupsDir)) {
  console.error(`Groups dir not found: ${groupsDir}`);
  process.exit(1);
}

let touched = 0;
let skipped = 0;
let warned = 0;

for (const entry of fs.readdirSync(groupsDir)) {
  const claudeMd = path.join(groupsDir, entry, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) continue;
  const content = fs.readFileSync(claudeMd, 'utf8');
  if (!content.includes('taskflow_update')) continue;
  if (content.includes(RULE_MARKER)) {
    skipped += 1;
    continue;
  }
  const anchorCount = content.split(ANCHOR).length - 1;
  if (anchorCount === 0) {
    console.warn(`WARN: anchor not found in ${claudeMd} — skipping`);
    warned += 1;
    continue;
  }
  if (anchorCount > 1) {
    console.warn(
      `WARN: anchor appears ${anchorCount}x in ${claudeMd} — skipping (manual fix required)`,
    );
    warned += 1;
    continue;
  }
  const next = content.replace(ANCHOR, ANCHOR + RULE_BODY);
  fs.writeFileSync(claudeMd, next, 'utf8');
  console.log(`Updated: ${claudeMd}`);
  touched += 1;
}

console.log(
  `\nDone. Updated ${touched} files. Skipped ${skipped} already-current files. Warned ${warned} customized files.`,
);
