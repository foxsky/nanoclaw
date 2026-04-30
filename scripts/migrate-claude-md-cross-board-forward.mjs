#!/usr/bin/env node
/**
 * One-shot migration: insert the "Cross-board add_subtask forward" rule
 * into existing TaskFlow CLAUDE.md files that were not produced by the
 * generator (provisioned via src/ipc-plugins/provision-shared.ts and
 * have drifted from the template since).
 *
 * On prod: ssh nanoclaw@host 'cd /home/nanoclaw/nanoclaw && node scripts/migrate-claude-md-cross-board-forward.mjs groups'
 */
import { migrateClaudeMd } from './lib/migrate-claude-md.mjs';

const RULE_BODY = `

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

migrateClaudeMd({
  groupsDir: process.argv[2] || 'groups',
  ruleMarker: 'Cross-board add_subtask forward',
  // Anchor: closing sentence of the "No-op state updates: never silent"
  // rule. Older provisioned boards predate the cross_board_subtask_mode
  // block, so we anchor on the no-op rule instead — present in every
  // board after migrate-claude-md-no-op-rule.mjs has run.
  anchor: 'A silent no-op loses information.',
  ruleBody: RULE_BODY,
  deriveSubstitutions: (folderName, content) => {
    const titleMatch = content.match(/^#\s+\S+\s+—\s+TaskFlow\s+\(([^)]+)\)/m);
    if (!titleMatch) return null;
    return {
      BOARD_ID: `board-${folderName}`,
      GROUP_NAME: titleMatch[1].trim(),
    };
  },
});
