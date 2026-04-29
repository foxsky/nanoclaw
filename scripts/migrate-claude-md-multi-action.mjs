#!/usr/bin/env node
/**
 * One-shot migration: insert the "Multi-Action Turns" rule into existing
 * TaskFlow CLAUDE.md files that were not produced by the generator.
 *
 * On prod: ssh nanoclaw@host 'cd /home/nanoclaw/nanoclaw && node scripts/migrate-claude-md-multi-action.mjs groups'
 */
import { migrateClaudeMd } from './lib/migrate-claude-md.mjs';

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

migrateClaudeMd({
  groupsDir: process.argv[2] || 'groups',
  ruleMarker: '## Multi-Action Turns',
  anchor: 'confirm it in your response.',
  ruleBody: RULE_BODY,
});
