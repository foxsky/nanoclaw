#!/usr/bin/env node
/**
 * One-shot migration: insert the strengthened `intended_weekday` rule
 * and the new "Contradictory weekday + date" rule into TaskFlow
 * CLAUDE.md files that predate them. Required for prod-only boards
 * not covered by scripts/generate-claude-md.mjs's hardcoded list.
 *
 * Idempotent: skips files that already contain the contradiction rule.
 * Safe: only inserts after a unique anchor; warns on missing/duplicate
 * anchors.
 *
 * Usage:
 *   node scripts/migrate-claude-md-weekday-contradiction.mjs <groups-dir>
 *
 * On prod: ssh nanoclaw@host 'cd /home/nanoclaw/nanoclaw && node scripts/migrate-claude-md-weekday-contradiction.mjs groups'
 */
import fs from 'fs';
import path from 'path';

const RULE_MARKER = 'Contradictory weekday + date';
// Anchor: closing line of the existing short "Date Parsing" section.
// Present in every CLAUDE.md that has any Date Parsing section.
const ANCHOR =
  '- When a date could be ambiguous, ask a clarification question before mutating data';

const RULE_BODY = `

**Every user message carries a \`<context timezone="..." today="YYYY-MM-DD" weekday="..." />\` header.** Use \`today\` and \`weekday\` as the ground truth when resolving relative dates ("quinta-feira", "amanhã", "próxima semana"). Do NOT derive the weekday from the date yourself — read it from the header. Example: header says \`today="2026-04-14" weekday="terça-feira"\`, user says "quinta-feira" → target date is \`2026-04-16\` (terça + 2 days = quinta).

**\`intended_weekday\` is REQUIRED when the user mentions a weekday name.** If the user says "alterar M1 para quinta-feira 11h", include \`intended_weekday: "quinta-feira"\` in your \`taskflow_update\` OR \`taskflow_create\` call alongside \`scheduled_at\`. Applies to BOTH \`taskflow_create\` (meetings, tasks) AND \`taskflow_update\` (reschedules, deadlines). The engine validates that the resolved \`scheduled_at\`/\`due_date\` actually lands on that weekday in board timezone and returns \`weekday_mismatch\` if not. On \`weekday_mismatch\`, do NOT retry blindly — re-read the \`<context>\` header, recompute the correct date, and confirm with the user before mutating.

**Contradictory weekday + date in user input — ASK, don't pick.** When the user provides BOTH a weekday name AND a specific date number that don't match in the current year, do NOT silently choose one. Ask which they meant before calling any tool. Example trigger: _"reunião para quinta, dia 30/05"_ — in 2026, 30/05 is a Saturday, not Thursday. Reply: _"Você disse 'quinta' e '30/05', mas 30/05/2026 cai no sábado. Quis dizer quinta-feira 30/04 ou sábado 30/05?"_. Wait for the user's choice before creating/updating. This prevents silently scheduling a meeting on the wrong date when the user's two date references disagree.`;

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
