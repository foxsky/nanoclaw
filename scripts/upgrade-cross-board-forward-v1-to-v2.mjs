#!/usr/bin/env node
/**
 * One-shot: upgrade the "Cross-board add_subtask forward" rule from v1
 * (shipped 2026-04-27) to v2 (shipped 2026-04-30, commits 7cce39ad +
 * 4867e1bb). v2 adds engine-first ordering, forbidden-phrase guidance,
 * and fixes a pre-existing SQL bug (b_parent.name → group_folder).
 *
 * The standard migrate-claude-md-cross-board-forward.mjs script is
 * idempotent and skips boards that already have the rule marker — so
 * boards that received v1 yesterday (~25 prod-only boards) cannot be
 * upgraded by re-running it. This one-shot replaces the v1 span in
 * place and is safe to run multiple times (skips boards already on v2).
 *
 * On prod: ssh nanoclaw@host 'cd /home/nanoclaw/nanoclaw && node scripts/upgrade-cross-board-forward-v1-to-v2.mjs groups'
 *
 * Delete this script after the prod sweep is verified.
 */
import fs from 'fs';
import path from 'path';

const RULE_START = '\n\n**Cross-board add_subtask forward.**';
// The v1 rule body's last line. Anchor here so we work on every board
// regardless of what follows the rule (older boards predate the
// "Handling subtask-approval" section that was added later).
const V1_LAST_LINE = 'fall back to the existing "task not found" refusal.';
const V2_SENTINEL = 'Forbidden refusal patterns';

const NEW_BODY_TEMPLATE = `

**Cross-board add_subtask forward.** Always try the tool first — \`taskflow_update({ task_id: 'PXXX', updates: { add_subtask: ... } })\` — even when you recognize the project lives on a parent board (e.g., from a \`[seci] P11\` prefix in your task views). The engine is the source of truth for what is writable from your board: it handles delegated tasks via \`cross_board_subtask_mode\` (\`open\` / \`blocked\` / \`approval\`) and returns a structured \`task not found\` only when the project is genuinely not reachable from here. **Never** refuse preemptively just because you can name the parent.

**Engine-error fallback (this rule).** If the tool call returns \`task not found\`, the project is delegated to a sibling or not delegated at all. Do NOT refuse flatly — forward the request to the parent board's group via \`send_message\`.

**Forbidden refusal patterns** (these are the bug, not the fix). After a \`task not found\` engine error, never reply with variants of these fragments:

- ❌ \`pertence ao quadro\` / \`pertence ao quadro pai\`
- ❌ \`precisará fazer pelo quadro\` / \`você terá que fazer pelo quadro\`
- ❌ \`faça por lá\` / \`adicione lá no quadro pai\`

Forward via the flow below instead.

The flow:

1. Look up THIS board's parent and verify the project lives there. Walk one level up via \`parent_board_id\`. Note: \`boards\` has no \`name\` column — use \`group_folder\` (or \`short_code\`) for the human-readable display name.
   \`\`\`sql
   SELECT b_parent.id          AS parent_board_id,
          b_parent.group_jid   AS parent_group_jid,
          COALESCE(b_parent.short_code, b_parent.group_folder, b_parent.id) AS parent_board_name
   FROM boards b_self
   JOIN boards b_parent ON b_parent.id = b_self.parent_board_id
   JOIN tasks  t        ON t.board_id = b_parent.id
                       AND t.id = '<TASK_ID>'
                       AND t.type = 'project'
   WHERE b_self.id = '{{BOARD_ID}}'
   LIMIT 1;
   \`\`\`
   If no row is returned, fall back to the normal task-not-found handling — the project ID truly does not exist on the parent. (Note: this rule covers the common one-level child→parent case. Deeper hierarchies are out of scope for Phase 1.)

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

let upgraded = 0;
let alreadyV2 = 0;
let noRule = 0;
let warned = 0;

for (const entry of fs.readdirSync(groupsDir)) {
  const claudeMd = path.join(groupsDir, entry, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) continue;
  const content = fs.readFileSync(claudeMd, 'utf8');
  if (!content.includes('taskflow_update')) continue;

  const startIdx = content.indexOf(RULE_START);
  if (startIdx === -1) {
    noRule += 1;
    continue;
  }

  if (content.includes(V2_SENTINEL)) {
    alreadyV2 += 1;
    continue;
  }

  const lastLineIdx = content.indexOf(V1_LAST_LINE, startIdx);
  if (lastLineIdx === -1) {
    console.warn(`WARN: v1 last line not found in ${claudeMd} — skipping`);
    warned += 1;
    continue;
  }
  // End just past the v1 last line (preserve the trailing newline so the
  // next rule's leading blank line isn't consumed).
  const endIdx = lastLineIdx + V1_LAST_LINE.length;

  const titleMatch = content.match(/^#\s+\S+\s+—\s+TaskFlow\s+\(([^)]+)\)/m);
  if (!titleMatch) {
    console.warn(`WARN: title not parseable in ${claudeMd} — skipping`);
    warned += 1;
    continue;
  }

  const body = NEW_BODY_TEMPLATE
    .replaceAll('{{BOARD_ID}}', `board-${entry}`)
    .replaceAll('{{GROUP_NAME}}', titleMatch[1].trim());

  const next = content.slice(0, startIdx) + body + content.slice(endIdx);
  fs.writeFileSync(claudeMd, next, 'utf8');
  console.log(`Upgraded: ${claudeMd}`);
  upgraded += 1;
}

console.log(
  `\nDone. Upgraded ${upgraded} files. Skipped ${alreadyV2} already-v2 + ${noRule} no-rule. Warned ${warned} customized files.`,
);
