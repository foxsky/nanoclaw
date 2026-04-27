#!/usr/bin/env node
/**
 * One-shot migration: insert the "Cross-board add_subtask forward" rule
 * into existing TaskFlow CLAUDE.md files that were not produced by the
 * generator (provisioned via src/ipc-plugins/provision-shared.ts and
 * have drifted from the template since).
 *
 * Idempotent: skips files that already contain the rule.
 * Safe: only inserts after a unique anchor; warns and skips files
 * where the anchor appears 0 or >1 times.
 *
 * Usage:
 *   node scripts/migrate-claude-md-cross-board-forward.mjs <groups-dir>
 *
 * Locally (smoke test): node scripts/migrate-claude-md-cross-board-forward.mjs groups
 * On prod:               ssh nanoclaw@host 'cd /home/nanoclaw/nanoclaw && node scripts/migrate-claude-md-cross-board-forward.mjs groups'
 */
import fs from 'fs';
import path from 'path';

const RULE_MARKER = 'Cross-board add_subtask forward';
// Anchor: closing sentence of the existing Mode=approval paragraph.
const ANCHOR =
  'Do NOT invent or paraphrase the message — relay it verbatim.';

const RULE_BODY = `

**Cross-board add_subtask forward.** If you call \`taskflow_update({ task_id: 'PXXX', updates: { add_subtask: ... } })\` and the engine returns a \`task not found\` error, the project is on a board you don't have direct or delegated access to (delegated to a sibling, or not delegated at all). Do NOT refuse flatly — forward the request to the parent board's group via \`send_message\`.

The flow:

1. Look up THIS board's parent and verify the task lives there. Walk one level up via \`parent_board_id\`:
   \`\`\`sql
   SELECT b_parent.id   AS parent_board_id,
          b_parent.group_jid AS parent_group_jid,
          b_parent.name AS parent_board_name
   FROM boards b_self
   JOIN boards b_parent ON b_parent.id = b_self.parent_board_id
   JOIN tasks  t        ON t.board_id = b_parent.id AND t.id = '<TASK_ID>'
   WHERE b_self.id = '{{BOARD_ID}}'
   LIMIT 1;
   \`\`\`
   If no row is returned, fall back to the original "task not found" refusal — the task ID truly does not exist on the parent. (Note: this rule covers the common one-level child→parent case. Deeper hierarchies are out of scope for Phase 1.)

2. Compose the forward message naming the asker and their board (identity disclosure is intentional — the parent admin needs to know who to contact). The format is:
   \`\`\`
   📨 *{SENDER}* (de {{GROUP_NAME}}) pediu adicionar uma subtarefa em *{TASK_ID}*:
   _{SUBTASK_TITLE}_

   Se aprovar, adicione com: \`adicionar etapa {TASK_ID}: {SUBTASK_TITLE}\` neste quadro.
   \`\`\`

3. Send to the **parent board only** (NOT to delegate siblings — apenas o quadro pai). Even if \`P11\` is delegated to multiple sibling child boards, the project itself lives on the parent — the manager there owns the decision.
   \`\`\`
   send_message({ target_chat_jid: '<parent_group_jid>', text: '<forward message>' })
   \`\`\`

4. Reply to the user confirming the forward:
   \`\`\`
   ✉️ Pedido encaminhado ao quadro *{parent_board_name}*. O gestor de lá decide e adiciona se aprovar.
   \`\`\`

The auditor recognizes this forward shape and won't flag it as \`unfulfilledWrite\` — the bot's \`encaminhad\` reply pattern + a \`send_message_log\` row to a parent board is the evidence.

This rule applies ONLY to \`add_subtask\` in Phase 1. Other cross-board mutation patterns (\`move\`, \`reassign\`, \`update\`) fall back to the existing "task not found" refusal.`;

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
