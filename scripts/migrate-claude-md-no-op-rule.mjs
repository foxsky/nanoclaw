#!/usr/bin/env node
/**
 * One-shot migration: insert the "No-op state updates: never silent"
 * rule into existing TaskFlow CLAUDE.md files that were not produced
 * by the generator (i.e., provisioned per-board CLAUDE.md files on
 * prod that drift from the template after provisioning).
 *
 * Idempotent: skips files that already contain the rule. Safe: only
 * inserts after a specific anchor; warns and skips files that don't
 * contain the anchor (those are too customized to touch automatically).
 *
 * Usage:
 *   node scripts/migrate-claude-md-no-op-rule.mjs <groups-dir>
 *
 * Locally: node scripts/migrate-claude-md-no-op-rule.mjs groups
 * On prod: ssh nanoclaw@host 'cd /home/nanoclaw/nanoclaw && node scripts/migrate-claude-md-no-op-rule.mjs groups'
 */
import fs from 'fs';
import path from 'path';

const RULE_MARKER = 'No-op state updates: never silent';
const ANCHOR =
  'If a task has close approval enabled, an assignee\'s `conclude` request moves it to `review` instead of `done`. Managers and delegates still approve from `review`.';
const REJECT_ANCHOR =
  '| "TXXX rejeitada: motivo" | `taskflow_move({ task_id: \'TXXX\', action: \'reject\', reason: \'motivo\', sender_name: SENDER })` |';
const WAIT_ANCHOR =
  '| "TXXX aguardando Y" | `taskflow_move({ task_id: \'TXXX\', action: \'wait\', reason: \'Y\', sender_name: SENDER })` |';

const RULE_BODY = `

**No-op state updates: never silent.** When a user restates a task's current state with new wording or new context (e.g., \`"SEAF-T2: aguardando análise do mapa comparativo"\` while T2 is already in \`waiting\`; or \`"T1 rejeitada: faltou anexar X"\` after T1 is already past \`review\`), it is NOT a no-op — the user is providing fresh context.

**Default**: call the matching \`taskflow_move\` action with the new \`reason\`. Same-column moves are accepted by the engine and produce a \`task_history\` row. This applies to any action that takes a \`reason\` (\`wait\`, \`reject\`, \`return\`, etc.) — not just \`wait\`.

**Exception**: only call \`taskflow_update({ add_note: '<the new wording>' })\` instead of \`taskflow_move\` when the new wording is clearly an **additional fact** rather than a restatement of why (e.g., \`"avisar Maria semana que vem"\` is a future commitment to add as a note; \`"aguardando análise"\` is a refined reason that should replace the current one).

When in doubt, call \`taskflow_move\` with the new \`reason\`. The engine preserves the previous reason in \`task_history\`; you don't lose information by replacing.

NEVER reply \`"a tarefa já está em <state>"\` without persisting the user's new wording somewhere. A silent no-op loses information.`;

const WAIT_REPLACEMENT =
  WAIT_ANCHOR.replace(
    /\|$/,
    '— call this even when the task is **already in `waiting`** with a different reason. The engine accepts same-column moves and records the new reason in `task_history`. Never respond `"já está em Aguardando"` without persisting the user\'s new wording. |',
  );

const REJECT_REPLACEMENT =
  REJECT_ANCHOR.replace(
    /\|$/,
    '— same no-op rule as `wait`: call this even when the task already left `review`. The engine handles redundant moves and records the new `reason`. |',
  );

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
  let content = fs.readFileSync(claudeMd, 'utf8');
  // Only TaskFlow boards
  if (!content.includes('taskflow_move')) {
    continue;
  }
  if (content.includes(RULE_MARKER)) {
    skipped += 1;
    continue;
  }
  if (!content.includes(ANCHOR)) {
    console.warn(`WARN: anchor not found in ${claudeMd} — skipping`);
    warned += 1;
    continue;
  }
  let next = content.replace(ANCHOR, ANCHOR + RULE_BODY);
  // Best-effort enrichment of the wait/reject rows. Only replaces when
  // the unenriched original row is present.
  if (next.includes(WAIT_ANCHOR)) {
    next = next.replace(WAIT_ANCHOR, WAIT_REPLACEMENT);
  }
  if (next.includes(REJECT_ANCHOR)) {
    next = next.replace(REJECT_ANCHOR, REJECT_REPLACEMENT);
  }
  fs.writeFileSync(claudeMd, next, 'utf8');
  console.log(`Updated: ${claudeMd}`);
  touched += 1;
}

console.log(
  `\nDone. Updated ${touched} files. Skipped ${skipped} already-current files. Warned ${warned} customized files.`,
);
