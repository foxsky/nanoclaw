#!/usr/bin/env node
/**
 * One-shot migration: insert the strengthened `intended_weekday` rule
 * and the new "Contradictory weekday + date" rule into TaskFlow
 * CLAUDE.md files that predate them. Required for prod-only boards
 * not covered by scripts/generate-claude-md.mjs's hardcoded list.
 *
 * On prod: ssh nanoclaw@host 'cd /home/nanoclaw/nanoclaw && node scripts/migrate-claude-md-weekday-contradiction.mjs groups'
 */
import { migrateClaudeMd } from './lib/migrate-claude-md.mjs';

const RULE_BODY = `

**Every user message carries a \`<context timezone="..." today="YYYY-MM-DD" weekday="..." />\` header.** Use \`today\` and \`weekday\` as the ground truth when resolving relative dates ("quinta-feira", "amanhã", "próxima semana"). Do NOT derive the weekday from the date yourself — read it from the header. Example: header says \`today="2026-04-14" weekday="terça-feira"\`, user says "quinta-feira" → target date is \`2026-04-16\` (terça + 2 days = quinta).

**\`intended_weekday\` is REQUIRED when the user mentions a weekday name.** If the user says "alterar M1 para quinta-feira 11h", include \`intended_weekday: "quinta-feira"\` in your \`taskflow_update\` OR \`taskflow_create\` call alongside \`scheduled_at\`. Applies to BOTH \`taskflow_create\` (meetings, tasks) AND \`taskflow_update\` (reschedules, deadlines). The engine validates that the resolved \`scheduled_at\`/\`due_date\` actually lands on that weekday in board timezone and returns \`weekday_mismatch\` if not. On \`weekday_mismatch\`, do NOT retry blindly — re-read the \`<context>\` header, recompute the correct date, and confirm with the user before mutating.

**Contradictory weekday + date in user input — ASK, don't pick.** Special case of the date-ambiguity rule above and the \`ambiguous_task_context\` ask-pattern: when the user provides BOTH a weekday name AND a specific date number that don't match in the current year, do NOT silently choose one. Ask which they meant before calling any tool. Example trigger: _"reunião para quinta, dia 30/05"_ — in 2026, 30/05 is a Saturday, not Thursday. Reply: _"Você disse 'quinta' e '30/05', mas 30/05/2026 cai no sábado. Quis dizer quinta-feira 30/04 ou sábado 30/05?"_. Wait for the user's choice before creating/updating.`;

migrateClaudeMd({
  groupsDir: process.argv[2] || 'groups',
  ruleMarker: 'Contradictory weekday + date',
  anchor: '- When a date could be ambiguous, ask a clarification question before mutating data',
  ruleBody: RULE_BODY,
});
