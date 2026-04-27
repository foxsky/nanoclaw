#!/usr/bin/env bash
# Daily Interaction Auditor — data-gathering script
# Runs inside the main group container during the scheduled task script phase.
# Opens both databases read-only, audits user interactions, outputs JSON.
# The LAST LINE of stdout must be the JSON result (agent-runner parses it).

set -euo pipefail
cd /app

# Write the script to a temp file to avoid shell quoting issues with node -e
cat > /tmp/auditor.js << 'SCRIPT_EOF'
const Database = require("better-sqlite3");
const fs = require("fs");

const MESSAGES_DB = "/workspace/store/messages.db";
const TASKFLOW_DB = "/workspace/taskflow/taskflow.db";

// Timezone offset for America/Fortaleza (UTC-3, no DST)
const TZ_OFFSET_HOURS = -3;

function toLocalDate(d) {
  const local = new Date(d.getTime() + TZ_OFFSET_HOURS * 3600000);
  return local.toISOString().slice(0, 10);
}

function todayLocal() {
  return toLocalDate(new Date());
}

function dayOfWeekLocal() {
  const now = new Date();
  const local = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600000);
  return local.getUTCDay(); // 0=Sun, 1=Mon, ...
}

// Build review period boundaries in UTC
// On Monday: review Fri 00:00 local -> Mon 00:00 local (covers Fri+Sat+Sun)
// Other days: review yesterday 00:00 local -> today 00:00 local
function getReviewPeriod() {
  const now = new Date();
  const localNow = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600000);
  const dow = localNow.getUTCDay();

  // `NANOCLAW_AUDIT_PERIOD_DAYS_BACK=N` forces a custom N-day backfill
  // window ending at start-of-today-local. Used for one-off dryrun
  // backfills; overrides the default 1-day (or 3-day Monday) behavior.
  const envBackfill = parseInt(process.env.NANOCLAW_AUDIT_PERIOD_DAYS_BACK || "", 10);
  const isBackfill = Number.isFinite(envBackfill) && envBackfill > 0;

  let daysBack = 1;
  let daysSpan = 1;
  if (isBackfill) {
    daysBack = envBackfill;
    daysSpan = envBackfill;
  } else if (dow === 1) { // Monday
    daysBack = 3; // back to Friday
    daysSpan = 3; // Fri, Sat, Sun
  }

  // Start of period in local time
  const startLocal = new Date(localNow);
  startLocal.setUTCHours(0, 0, 0, 0);
  startLocal.setUTCDate(startLocal.getUTCDate() - daysBack);

  // End of period in local time (start of today)
  const endLocal = new Date(localNow);
  endLocal.setUTCHours(0, 0, 0, 0);

  // Convert back to UTC for DB queries
  const startUtc = new Date(startLocal.getTime() - TZ_OFFSET_HOURS * 3600000);
  const endUtc = new Date(endLocal.getTime() - TZ_OFFSET_HOURS * 3600000);

  const spansMultipleDays = daysSpan > 1;
  const label = spansMultipleDays
    ? startLocal.toISOString().slice(0, 10) + " a " + new Date(endLocal.getTime() - 86400000).toISOString().slice(0, 10)
    : startLocal.toISOString().slice(0, 10);

  return {
    startIso: startUtc.toISOString(),
    endIso: endUtc.toISOString(),
    label,
    isWeekend: !isBackfill && dow === 1,
  };
}

// Write keywords (case-insensitive)
const WRITE_KEYWORDS = [
  "concluir", "concluída", "concluido", "finalizar", "finalizado",
  "criar", "adicionar", "atribuir", "aprovar", "aprovada", "aprovado",
  "descartar", "cancelar", "mover", "adiar", "renomear", "alterar",
  "remover", "em andamento", "para aguardando", "para revisão",
  "processar inbox", "para inbox", "nota", "anotar", "lembrar",
  "lembrete", "prazo", "próximo passo", "próxima ação", "descrição",
  "começando", "comecando", "aguardando", "retomada", "devolver",
  "done", "feita", "feito", "pronta"
];

// Strict subset of WRITE_KEYWORDS, with shared DM/task vocabulary
// ("prazo", "lembrete", "nota", "anotar", "lembrar", "próximo passo",
// "próxima ação", "descrição") excluded. Matching one of these means
// the message demands a task mutation even when also a DM-send intent.
const TASK_KEYWORDS = [
  "concluir", "concluída", "concluido", "finalizar", "finalizado",
  "criar", "adicionar", "atribuir", "aprovar", "aprovada", "aprovado",
  "descartar", "cancelar", "mover", "adiar", "renomear", "alterar",
  "remover", "em andamento", "para aguardando", "para revisão",
  "processar inbox", "para inbox",
  "começando", "comecando", "aguardando", "retomada", "devolver",
  "done", "feita", "feito", "pronta"
];

// Terse task-ref + action pattern
const TERSE_PATTERN = /^(?:(?:[A-Z]{2,}-)?(?:T|P|M|R)\S+|SEC-\S+)\s*(conclu|feita|feito|pronta|ok|aprovad|✅)/i;

// Cross-group send-intent patterns (Portuguese). Detected so we can
// exclude them from `unfulfilledWrite` — `send_message` never writes
// task_history, so requiring a mutation there would always false-positive.
//
// Each verb slot covers singular AND plural imperative forms. The plural
// (-em/-am/-quem) matters in WhatsApp group chats where a user addresses the
// bot-team or a group ("Mandem mensagem pro João", "Notifiquem o gestor").
// Missing plurals were a Codex-flagged recall gap in the first fix.
const DM_SEND_PATTERNS = [
  // "mande/manda/mandem/mandar [um|uma|o|a|os|as] mensagem/msg/... <prep> <recipient>".
  // Requiring a directional preposition + recipient AFTER the noun prevents
  // false positives on "escreva uma nota na T5" / "mande um lembrete na
  // tarefa T3" / "escreva um aviso na descrição da P4" — those use the
  // locative "na/no" (where), not a directional "a/ao/pra/..." (to whom).
  /\b(?:mand(?:ar|em|e|a)|envi(?:ar|em|e|a)|escrev(?:er|am|e|a))\s+(?:(?:um|uma|o|a|os|as)\s+)?(?:msg|mensagem|recado|aviso|alerta|lembrete|nota|email|e-?mail|notifica[cç][aã]o)\s+(?:a|ao|à|para|pro|pra|com)\s+\S/i,
  // "avise/avisem/notifique/notifiquem/alerte/alertem/comunique/comuniquem/informe/informem
  //  [o|a|ao|à|aos|às] <recipient>".
  // Trailing lookahead instead of \b so `à`/`às` (non-word chars in JS regex)
  // still count as the end of the match.
  /\b(?:avis(?:e|a|ar|em|ando)|notifi(?:que|quem|car|cando)|alert(?:e|a|ar|em|ando)|comuniqu(?:e|em|ar|ando)|inform(?:e|em|ar|ando))\s+(?:o|a|os|as|ao|à|aos|às)(?=[\s.,;!?]|$)/i,
  // "diga/digam/fale/falem/pergunte/perguntem/conte/contem/peça/peçam
  //  [a|ao|à|para|pro|pra|com] <recipient>".
  // Same lookahead trick for `à`.
  /\b(?:diga|digam|conte|contem|conta|fale|falem|fala|pergunte|perguntem|pergunta|peç[ao]|peçam|pe[cç]a|pecam)\s+(?:a|ao|à|para|pro|pra|com)(?=[\s.,;!?]|$)/i,
  // Informal WhatsApp shorthand: communication verb + directional preposition
  // + recipient, no noun required. Covers "avisa pro João", "pede pro Lucas",
  // "mande pro Reginaldo", "conta pro time", etc. Verb list kept curated to
  // communication/notification verbs to avoid matching generic movement verbs
  // like "vai/anda pro X". Plural forms (mandem/enviem/peçam/...) included
  // for group-addressed imperatives.
  /\b(?:mand[ae]|mandem|envi[ae]|enviem|avis[ae]|avisem|alert[ae]|alertem|comunic[ae]|comuniquem|inform[ae]|informem|pede|pedem|pergunt[ae]|perguntem|peç[ao]|peçam|pecam|diga|digam|fale|falem|fala|conta|contem|conte)\s+(?:pro|pra|ao|à)\s+\S/i,
];

// Read-query detector — split into HARD and SOFT interrogatives so
// Portuguese subordinate clauses don't exempt real commands.
//
// HARD interrogatives (`qual`, `quais`, `quanto(s)`, `quanta(s)`) are
// never used as subordinators in Portuguese — if they start a message,
// it IS a question. Safe to treat as read-only unconditionally.
//
// SOFT interrogatives (`que`, `quando`, `onde`, `quem`) CAN introduce
// subordinate clauses that wrap imperatives. Example:
//   "Quando concluir T5, avise o João"  ← NOT a read query; `quando`
//                                          is temporal subordinator and
//                                          the real command is `avise`.
// For these, require the message to be a clean single-clause question:
// either ends with `?` OR contains no comma (disqualifier for clause
// splits). This matches "Que tarefas têm prazo?" and "Onde está a P10"
// while rejecting the subordinator forms.
const READ_QUERY_HARD_PATTERN = /^\s*(?:qual|quais|quantos?|quantas?)\b/i;
const READ_QUERY_SOFT_PATTERN = /^\s*(?:que|quando|onde|quem)\b/i;

// Imperative verb detector — used to disqualify SOFT comma-less reads.
// The first-pass fix treated "Quando concluir T5 avise o João" (no comma,
// no `?`) as a read query because it couldn't tell the subordinator form
// from a real question. Codex second-pass flagged this as a recall gap:
// informal Portuguese often drops the comma. This pattern catches the
// 2nd/3rd person singular/plural imperative forms of TaskFlow task verbs
// so isReadQuery can veto the no-comma branch when any command verb
// appears in the message.
//
// Word-boundary matched (`\b...\b`) to avoid substring false positives
// like "criança" → "cria" or "extremos" → "mov". Verb list curated to
// task-write and send-intent verbs only; generic Portuguese verbs like
// "vai", "faz", "dá" are intentionally out-of-scope.
const IMPERATIVE_VERB_PATTERN = /\b(?:conclu[ai]m?|atribu[aei]m?|cri[ae]m?|cancel[ea]m?|adicion[ea]m?|aprov[ea]m?|descart[ea]m?|mov[ae]m?|adi[ae]m?|alter[ea]m?|remov[ae]m?|renomei[ea]m?|finaliz[ea]m?|process[ea]m?|devolv[ae]m?|retom[ae]m?|delegu[ea]m?|registr[ea]m?|avis[ea]m?|alert[ea]m?|inform[ea]m?|comuniqu[ea]m?|notifiqu[ea]m?|peç[ao]m?|pe[cç]am?)\b/i;

// First-person future-tense declarations. The user is describing THEIR own
// upcoming action, not commanding the bot: "vou concluir T5" means "I will
// conclude T5", not "conclude T5 (imperative)".
//
// Four alternatives, all first-person:
// 1. Periphrastic future — `vou/vamos/pretendo/estou indo/estamos indo`
//    + 0-2 intervening adverbs + infinitive (-ar/-er/-ir). Uses `\S+`/
//    `\S*` (not `\w+`/`\w*`) because JS regex `\w` is ASCII-only and
//    would fail on Portuguese accented adverbs like "já" and "também".
// 2. Synthetic future 1sg — 3+ char stem + (a|e|i) + "rei"
//    (e.g. "concluirei", "atualizarei", "finalizarei", "criarei").
//    `\S{3,}` prevents matching "rei" (king) and "Rei" (name).
// 3. Synthetic future 1pl — 3+ char stem + (a|e|i) + "remos"
//    (e.g. "concluiremos", "atualizaremos", "finalizaremos").
// 4. Future perfect 1sg/1pl — `terei`/`teremos` + 0-2 adverbs + past
//    participle ending in `ado|ido|ído|to|so`. The `ído` variant covers
//    accented forms like "concluído".
//
// Residual known gap: irregular-stem single-char synthetic futures
// ("farei", "serei", "direi", "darei") don't match because the stem is
// only 1-2 chars. These are rare in WhatsApp task contexts; accept.
const INTENT_DECLARATION_PATTERN = /\b(?:vou|vamos|pretendo|estou\s+indo|estamos\s+indo)\s+(?:\S+\s+){0,2}\S*(?:ar|er|ir)\b|\b\S{3,}(?:a|e|i)rei\b|\b\S{3,}(?:a|e|i)remos\b|\b(?:terei|teremos)\s+(?:\S+\s+){0,2}\S+(?:ado|ido|ído|to|so)\b/i;

// Multi-clause disqualifier for intent exemption. A message like
// "Vou concluir T5 depois, mas cria P2 agora" has a real imperative
// ("cria P2") AFTER the declaration clause — the exemption must NOT
// hide that. Uses contrast markers (`mas`, `porém`, semicolon) rather
// than plain comma, so compound pure declarations like "Vou atualizar
// ainda hoje, estou indo concluir uma das tarefas agora" still qualify
// for exemption.
const INTENT_MULTI_CLAUSE_PATTERN = /\b(?:mas|porém)\b|;/i;

// Refusal patterns in bot responses. NOTE: "não está cadastrad" was
// intentionally removed — the bot uses that phrase in HELPER OFFERS when
// mentioning an unregistered person while still doing real work
// ("✅ T5 atualizada. Terciane não está cadastrada. Quer que eu crie..."),
// and the old regex flagged every such response as a refusal. Genuine
// refusals still match via `não consigo` / `não posso` / etc.
const REFUSAL_PATTERN = /não consigo|não posso|não tenho como|não pode ser|bloqueado por limite|apenas o canal principal|o runtime atual|não oferece suporte|limite do sistema|deste quadro.*não consigo|recuso essa instrução/i;
const RESPONSE_THRESHOLD_MS = 300000; // 5 minutes
const TASK_REF_PATTERN = /\b(?:[A-Z]{2,}-)?(?:T|P|M|R)\d+(?:\.\d+)*\b|\bSEC-[A-Z0-9]+(?:[.-][A-Z0-9]+)*\b/gi;
const REMINDER_LIKE_PATTERN = /\b(?:lembr(?:ar|e|ete|etes)|me\s+avise|me\s+lembre|avise-me|avisa\s+me|avisar|lembret[ea]|agendar|agenda(?:r)?)\b/i;

function normalizeForCompare(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function extractTaskRefs(text) {
  const matches = text.match(TASK_REF_PATTERN) || [];
  return new Set(matches.map((m) => m.toUpperCase()));
}

function isReminderLikeWrite(text) {
  return REMINDER_LIKE_PATTERN.test(text || '');
}

function buildTaskIdAliases(taskId, boardId, boardShortCodes) {
  const rawId = String(taskId || '').toUpperCase();
  if (!rawId) return [];
  const aliases = new Set([rawId]);
  const shortCode = boardId ? boardShortCodes.get(boardId) : null;
  if (shortCode) aliases.add(`${shortCode}-${rawId}`);
  return Array.from(aliases);
}

function isWriteRequest(text) {
  const lower = text.toLowerCase();
  return WRITE_KEYWORDS.some((kw) => lower.includes(kw)) || TERSE_PATTERN.test(text);
}

function isTaskWriteRequest(text) {
  const lower = text.toLowerCase();
  return TASK_KEYWORDS.some((kw) => lower.includes(kw)) || TERSE_PATTERN.test(text);
}

function isDmSendRequest(text) {
  return DM_SEND_PATTERNS.some((p) => p.test(text));
}

function isReadQuery(text) {
  if (READ_QUERY_HARD_PATTERN.test(text)) return true;
  if (READ_QUERY_SOFT_PATTERN.test(text)) {
    // Soft interrogative counted as read only when the message is a
    // clear single-clause question:
    //   - ends with `?`, OR
    //   - has no comma AND no imperative verb (not a subordinate
    //     clause wrapping a command — catches "Quando concluir T5
    //     avise o João" where the comma is dropped informally).
    if (/\?\s*$/.test(text)) return true;
    if (text.includes(',')) return false;
    return !IMPERATIVE_VERB_PATTERN.test(text);
  }
  return false;
}

function isUserIntentDeclaration(text) {
  if (!INTENT_DECLARATION_PATTERN.test(text)) return false;
  // Only exempt single-clause declarations. Multi-clause messages
  // ("vou X depois, mas cria Y agora") may still contain a real command
  // after the declaration — those need to run through the mutation check.
  return !INTENT_MULTI_CLAUSE_PATTERN.test(text);
}

function hasRefusal(text) {
  return REFUSAL_PATTERN.test(text);
}

function interactionSenderKey(msg) {
  const sender = (msg.sender || '').trim();
  if (sender) return `sender:${sender}`;
  return `name:${(msg.sender_name || '').trim()}`;
}

function hasTable(db, tableName) {
  const row = db.prepare(
    `SELECT 1 AS exists_flag
       FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1`,
  ).get(tableName);
  return !!row;
}

function getTableColumns(db, tableName) {
  if (!hasTable(db, tableName)) return new Set();
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set(rows.map((row) => row.name));
}

function isWebOriginMessage(msg) {
  const sender = msg.sender || '';
  const senderName = msg.sender_name || '';
  return sender.startsWith('web:') || senderName.startsWith('web:');
}

function resolveExactTurnMessages(turnMessages, preferredDisplayName) {
  const visible = turnMessages.filter((message) =>
    message.content &&
    !isWebOriginMessage(message),
  );
  if (visible.length === 0) return null;

  let selected = visible;
  const actorKey = normalizeForCompare(preferredDisplayName);
  if (actorKey) {
    const matched = visible.filter((message) => {
      return normalizeForCompare(message.sender_name) === actorKey ||
        normalizeForCompare(message.sender) === actorKey;
    });
    if (matched.length > 0) selected = matched;
  }

  const senderKeys = new Set(selected.map((message) => interactionSenderKey(message)));
  const sameSender = senderKeys.size <= 1;
  const triggerMessage = sameSender
    ? selected.map((message) => message.content.trim()).join('\n')
    : selected
        .map((message) => {
          const senderLabel =
            (message.sender_name || '').trim() ||
            (message.sender || '').trim() ||
            'desconhecido';
          return `[${senderLabel}] ${message.content.trim()}`;
        })
        .join('\n');
  const lastMessage = selected[selected.length - 1];
  return {
    triggerTurnId: lastMessage.turn_id || null,
    triggerMessageIds: selected.map((message) => message.message_id),
    triggerMessage,
    triggerSender:
      sameSender
        ? ((lastMessage.sender_name || '').trim() || (lastMessage.sender || '').trim() || null)
        : null,
  };
}

function buildInteractionRefs(interaction) {
  const refs = [];
  if (interaction.sourceMessageId) refs.push(`msg ${interaction.sourceMessageId}`);
  if (interaction.botResponseMessageId) refs.push(`resp ${interaction.botResponseMessageId}`);
  return refs;
}

function buildSelfCorrectionRefs(correction) {
  const refs = [];
  if (correction.triggerTurnId) refs.push(`turn ${correction.triggerTurnId}`);
  if (correction.triggerMessageIds && correction.triggerMessageIds.length > 0) {
    refs.push(`msgs ${correction.triggerMessageIds.join(', ')}`);
  }
  return refs;
}

function escapeMdQuote(text, limit) {
  const flat = String(text ?? '').replace(/\r/g, '').replace(/\n+/g, ' ');
  const capped = flat.length > limit ? flat.slice(0, limit) + '…' : flat;
  return capped.replace(/([*_`~\\])/g, '\\$1');
}

function buildRefsAppendBlock(boards) {
  const lines = [];
  for (const board of boards) {
    const boardLines = [];
    for (const interaction of board.interactions || []) {
      const refs = buildInteractionRefs(interaction);
      if (refs.length === 0) continue;
      const sender = interaction.sender || 'desconhecido';
      boardLines.push(
        `- Interação ${escapeMdQuote(interaction.timestamp, 64)} (${escapeMdQuote(sender, 80)}): ${escapeMdQuote(refs.join(' | '), 480)}`,
      );
    }
    for (const correction of board.selfCorrections || []) {
      const refs = buildSelfCorrectionRefs(correction);
      if (refs.length === 0) continue;
      const taskId = correction.taskId || 'sem-task';
      boardLines.push(
        `- Auto-correção ${escapeMdQuote(taskId, 64)} (${escapeMdQuote(correction.secondAt, 64)}): ${escapeMdQuote(refs.join(' | '), 480)}`,
      );
    }
    if (boardLines.length === 0) continue;
    lines.push(`*${escapeMdQuote(board.group, 120)}*`);
    lines.push(...boardLines);
    lines.push('');
  }
  if (lines.length === 0) return null;
  return [
    '',
    '🔎 *Refs estruturais* — _metadados de correlação preservados pelo host_',
    '',
    ...lines,
  ].join('\n');
}

function writeAuditDryRunLog(data, rootDir = '/workspace/audit', now = new Date()) {
  const entries = [];
  for (const board of data.boards || []) {
    for (const interaction of board.interactions || []) {
      entries.push({
        kind: 'interaction',
        period: data.period,
        boardId: board.boardId,
        boardFolder: board.folder,
        boardGroup: board.group,
        timestamp: interaction.timestamp,
        sender: interaction.sender || null,
        message: interaction.message || null,
        sourceMessageId: interaction.sourceMessageId || null,
        botResponseMessageId: interaction.botResponseMessageId || null,
      });
    }
    for (const correction of board.selfCorrections || []) {
      entries.push({
        kind: 'self_correction',
        period: data.period,
        boardId: board.boardId,
        boardFolder: board.folder,
        boardGroup: board.group,
        taskId: correction.taskId || null,
        secondAt: correction.secondAt,
        triggerTurnId: correction.triggerTurnId || null,
        triggerMessageIds: correction.triggerMessageIds || null,
      });
    }
  }
  if (entries.length === 0) return;
  fs.mkdirSync(rootDir, { recursive: true });
  const dateStr = now.toISOString().slice(0, 10);
  const file = `${rootDir}/semantic-dryrun-${dateStr}.ndjson`;
  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  fs.appendFileSync(file, lines);
}

// ---- Main ----

if (!fs.existsSync(MESSAGES_DB)) {
  console.error("messages.db not found");
  console.log(JSON.stringify({ wakeAgent: false }));
  process.exit(0);
}
if (!fs.existsSync(TASKFLOW_DB)) {
  console.error("taskflow.db not found");
  console.log(JSON.stringify({ wakeAgent: false }));
  process.exit(0);
}

const msgDb = new Database(MESSAGES_DB, { readonly: true });
const tfDb = new Database(TASKFLOW_DB, { readonly: true });
const taskHistoryColumns = getTableColumns(tfDb, 'task_history');
const hasTaskHistoryTriggerTurnId = taskHistoryColumns.has('trigger_turn_id');
const hasAgentTurnMessages =
  hasTable(msgDb, 'agent_turn_messages') && hasTable(msgDb, 'messages');
const sendMessageLogColumns = getTableColumns(msgDb, 'send_message_log');
const hasSendMessageTriggerMessageId = sendMessageLogColumns.has('trigger_message_id');
const hasSendMessageTriggerTurnId = sendMessageLogColumns.has('trigger_turn_id');

// Get all TaskFlow-managed groups
const groups = msgDb.prepare(
  "SELECT jid, name, folder, trigger_pattern FROM registered_groups WHERE taskflow_managed = 1"
).all();

if (groups.length === 0) {
  console.error("No TaskFlow-managed groups found");
  console.log(JSON.stringify({ wakeAgent: false }));
  process.exit(0);
}

const period = getReviewPeriod();
const boards = [];
let totalIssues = 0;

// Statements that don't depend on group context — prepared once.
const boardStmt = tfDb.prepare(
  "SELECT id, parent_board_id FROM boards WHERE group_folder = ?"
);
const userMessagesStmt = msgDb.prepare(
  `SELECT id, sender, sender_name, content, timestamp
   FROM messages
   WHERE chat_jid = ? AND timestamp >= ? AND timestamp < ?
     AND is_bot_message = 0 AND is_from_me = 0
     AND content IS NOT NULL AND content != ''
   ORDER BY timestamp`
);
const botResponseStmt = msgDb.prepare(
  `SELECT id, content, timestamp FROM messages
   WHERE chat_jid = ? AND timestamp > ? AND timestamp <= ?
     AND (is_bot_message = 1 OR is_from_me = 1)
     AND content IS NOT NULL AND content != ''
   ORDER BY timestamp ASC LIMIT 1`
);
const boardShortCodeStmt = tfDb.prepare(
  `SELECT short_code FROM boards WHERE id = ? LIMIT 1`
);

// `scheduled_tasks` lives in messages.db (host store), NOT taskflow.db —
// reminder requests ("lembrar na segunda às 7h30 de X") create rows here
// via the `schedule_task` tool, never in task_history. Any row created by
// the group within the bot's 10-minute response window counts as a
// mutation for audit purposes. Upper bound is inclusive (`<=`) to match
// task_history's boundary convention — a reminder created exactly at the
// 10-minute mark must still count.
const scheduledTasksStmt = msgDb.prepare(
  `SELECT id FROM scheduled_tasks
   WHERE group_folder = ? AND created_at >= ? AND created_at <= ?
   LIMIT 1`
);

// `send_message_log` is the verifiable audit trail for cross-group and
// DM `send_message` deliveries. Populated by src/ipc.ts after each
// successful `deps.sendMessage()` call. Replaces the older regex-based
// DM-send exemption (DM_SEND_PATTERNS) as the authoritative evidence
// that a cross-group send actually happened. A hit here satisfies the
// mutation requirement for shared-vocabulary writes (e.g. "mande
// mensagem pro X sobre o prazo"), but does NOT satisfy an unambiguous
// task-write intent (e.g. "concluir T5") — those still require a real
// task_history or scheduled_tasks mutation.
const sendMessageLogStmt = msgDb.prepare(
  `SELECT id${
    hasSendMessageTriggerMessageId
      ? ', trigger_message_id'
      : ', NULL AS trigger_message_id'
  }${
    hasSendMessageTriggerTurnId
      ? ', trigger_turn_id'
      : ', NULL AS trigger_turn_id'
  } FROM send_message_log
   WHERE source_group_folder = ? AND delivered_at >= ? AND delivered_at <= ?
   ORDER BY delivered_at ASC`
);
const sendMessageTurnMatchStmt =
  hasSendMessageTriggerTurnId && hasAgentTurnMessages
    ? msgDb.prepare(
        `SELECT 1
         FROM send_message_log sml
         JOIN agent_turn_messages atm ON atm.turn_id = sml.trigger_turn_id
         WHERE sml.source_group_folder = ?
           AND sml.delivered_at >= ?
           AND sml.delivered_at <= ?
           AND atm.message_id = ?
         LIMIT 1`,
      )
    : null;

// Group-level divergence detection: compare bot-deliveries-to-this-group
// (send_message_log.target_chat_jid) against bot-rows-in-messages.db
// (is_from_me=1 OR is_bot_message=1). If sends >> stored, the messages.db
// audit trail itself is broken — not the bot. The 2026-04-13 self-echo
// filter regression (fixed in cf93d42) would have surfaced immediately
// with this check: 91 sends logged, 0 bot rows stored.
const deliveriesToGroupCountStmt = msgDb.prepare(
  `SELECT COUNT(*) AS n FROM send_message_log
   WHERE target_chat_jid = ? AND delivered_at >= ? AND delivered_at < ?`
);
const botRowsInGroupCountStmt = msgDb.prepare(
  `SELECT COUNT(*) AS n FROM messages
   WHERE chat_jid = ? AND timestamp >= ? AND timestamp < ?
     AND (is_from_me = 1 OR is_bot_message = 1)`
);

// task_history placeholders depend on boardIds.length (1 or 2),
// so prepare one statement per arity and reuse across groups.
const taskHistoryStmts = {
  1: tfDb.prepare(
    `SELECT board_id, action, task_id, by, at FROM task_history
     WHERE board_id IN (?) AND at >= ? AND at <= ?
     ORDER BY at ASC`
  ),
  2: tfDb.prepare(
    `SELECT board_id, action, task_id, by, at FROM task_history
     WHERE board_id IN (?, ?) AND at >= ? AND at <= ?
     ORDER BY at ASC`
  ),
};

// Self-correction detector: find pairs of same-user same-task date-field
// mutations within 60 min. The canonical signal is a user having to fix
// what the bot just did — e.g. Giovanni 2026-04-14 rescheduled M1 twice
// in 32 min (first "quinta-feira" resolved to Friday, then explicit
// "16/04/26"). Scoped to details containing "reagendada" (meeting
// reschedule) or "Prazo" (due date set/changed) to avoid flagging
// legitimate iterative edits (notes, labels). The auditor LLM classifies
// each pair with the triggering user message for context.
const selfCorrectionStmts = {
  1: tfDb.prepare(
    `SELECT a.task_id, a.by, a.at AS first_at, a.details AS first_details,
            b.at AS second_at, b.details AS second_details${
              hasTaskHistoryTriggerTurnId
                ? ', b.trigger_turn_id AS second_trigger_turn_id'
                : ', NULL AS second_trigger_turn_id'
            }
     FROM task_history a
     JOIN task_history b ON a.task_id = b.task_id
       AND a.by = b.by
       AND a.board_id = b.board_id
       AND b.at > a.at
       AND (julianday(b.at) - julianday(a.at)) * 86400 <= 3600
     WHERE a.board_id IN (?) AND a.at >= ? AND a.at <= ?
       AND a.action = 'updated' AND b.action = 'updated'
       AND a.by IS NOT NULL
       AND a.details <> b.details
       AND (
         (a.details LIKE '%"Reunião reagendada%' AND b.details LIKE '%"Reunião reagendada%')
         OR
         (a.details LIKE '%"Prazo definido: %' AND b.details LIKE '%"Prazo definido: %')
       )
     ORDER BY b.at ASC`
  ),
  2: tfDb.prepare(
    `SELECT a.task_id, a.by, a.at AS first_at, a.details AS first_details,
            b.at AS second_at, b.details AS second_details${
              hasTaskHistoryTriggerTurnId
                ? ', b.trigger_turn_id AS second_trigger_turn_id'
                : ', NULL AS second_trigger_turn_id'
            }
     FROM task_history a
     JOIN task_history b ON a.task_id = b.task_id
       AND a.by = b.by
       AND a.board_id = b.board_id
       AND b.at > a.at
       AND (julianday(b.at) - julianday(a.at)) * 86400 <= 3600
     WHERE a.board_id IN (?, ?) AND a.at >= ? AND a.at <= ?
       AND a.action = 'updated' AND b.action = 'updated'
       AND a.by IS NOT NULL
       AND a.details <> b.details
       AND (
         (a.details LIKE '%"Reunião reagendada%' AND b.details LIKE '%"Reunião reagendada%')
         OR
         (a.details LIKE '%"Prazo definido: %' AND b.details LIKE '%"Prazo definido: %')
       )
     ORDER BY b.at ASC`
  ),
};

// Resolve a task_history.by person_id to a display name via board_people,
// then filter the trigger-message lookup to messages whose sender_name
// matches. Without this, a busy chat silently attributes the correction
// to whoever typed last in the 10-min window.
const personNameByIdStmt = tfDb.prepare(
  `SELECT name FROM board_people WHERE board_id = ? AND person_id = ? LIMIT 1`
);

// Symmetric with taskflow-engine.ts:resolvePerson but uses NFD (not SQLite
// LOWER(), which is ASCII-only and drops diacritics). Loads per-board people
// once, matches in JS against pre-normalized fields.
const boardPeopleStmt = tfDb.prepare(
  `SELECT person_id, name FROM board_people WHERE board_id = ?`
);
const boardPeopleCache = new Map();
let firstNameHeuristicHits = 0;
let firstNameAmbiguityMisses = 0;
function getBoardPeopleNormalized(boardId) {
  let people = boardPeopleCache.get(boardId);
  if (!people) {
    people = boardPeopleStmt.all(boardId).map((p) => {
      const nfdName = normalizeForCompare(p.name);
      return {
        person_id: p.person_id,
        nfdName,
        nfdId: normalizeForCompare(p.person_id),
        nfdFirst: nfdName.split(/\s+/)[0],
      };
    });
    boardPeopleCache.set(boardId, people);
  }
  return people;
}
// searchBoardsInOrder: caller controls precedence (mutation.board_id first
// on the mutation side, sender's scope on the sender side).
function resolveActorToPersonId(rawName, searchBoardsInOrder) {
  if (!rawName) return null;
  const key = normalizeForCompare(rawName);
  if (!key) return null;
  const firstKey = key.split(/\s+/)[0];
  for (const boardId of searchBoardsInOrder) {
    if (!boardId) continue;
    const people = getBoardPeopleNormalized(boardId);
    const exact = people.find((p) => p.nfdName === key || p.nfdId === key);
    if (exact) return exact.person_id;
    if (firstKey) {
      const firstMatches = people.filter((p) => p.nfdFirst === firstKey);
      if (firstMatches.length === 1) {
        firstNameHeuristicHits += 1;
        return firstMatches[0].person_id;
      }
      if (firstMatches.length > 1) {
        firstNameAmbiguityMisses += 1;
      }
    }
  }
  return null;
}

const triggerMessageStmt = msgDb.prepare(
  `SELECT id, content, timestamp, sender_name FROM messages
   WHERE chat_jid = ? AND timestamp <= ? AND timestamp >= ?
     AND is_bot_message = 0 AND is_from_me = 0
     AND content IS NOT NULL AND content != ''
     AND sender_name LIKE ? ESCAPE '\\'
   ORDER BY timestamp DESC LIMIT 1`
);
const exactTurnMessagesStmt = hasAgentTurnMessages
  ? msgDb.prepare(
      `SELECT
         atm.turn_id AS turn_id,
         atm.message_id AS message_id,
         m.content AS content,
         COALESCE(m.timestamp, atm.message_timestamp) AS timestamp,
         COALESCE(m.sender_name, atm.sender_name) AS sender_name,
         COALESCE(m.sender, atm.sender) AS sender,
         atm.ordinal AS ordinal
       FROM agent_turn_messages atm
       LEFT JOIN messages m
         ON m.id = atm.message_id
        AND m.chat_jid = atm.message_chat_jid
       WHERE atm.turn_id = ?
       ORDER BY atm.ordinal ASC`,
    )
  : null;

for (const group of groups) {
  const board = boardStmt.get(group.folder);
  if (!board) continue;
  const boardIds = [board.id];
  if (board.parent_board_id) boardIds.push(board.parent_board_id);
  const boardShortCodes = new Map(
    boardIds.map((boardId) => {
      const row = boardShortCodeStmt.get(boardId);
      const shortCode = typeof row?.short_code === 'string'
        ? row.short_code.trim().toUpperCase()
        : null;
      return [boardId, shortCode];
    }),
  );
  const taskHistoryStmt = taskHistoryStmts[boardIds.length];

  const userMessages = userMessagesStmt.all(group.jid, period.startIso, period.endIso);
  if (userMessages.length === 0) continue;

  const interactions = [];

  for (const msg of userMessages) {
    // Skip web-origin test/QA messages (web: prefix senders). Mirrors
    // `isWebOriginMessage` in src/index.ts: a message is web-origin when
    // EITHER `sender` OR `sender_name` starts with `web:`. The old check
    // (`sender_name || sender || ''`, then one `.startsWith`) only
    // inspected whichever field won the fallback — a non-empty human
    // `sender_name` masked a `web:`-prefixed `sender`, leaking QA
    // injections (e.g. secti-taskflow harness) into the audit.
    const senderField = msg.sender || '';
    const senderNameField = msg.sender_name || '';
    if (senderField.startsWith('web:') || senderNameField.startsWith('web:')) continue;

    // Find bot response within 10 minutes. In busy groups, do NOT attribute
    // the first bot message to this user if another real user speaks before
    // that reply arrives — the reply may belong to the later speaker.
    const tenMinLater = new Date(new Date(msg.timestamp).getTime() + 600000).toISOString();
    let botResponse = botResponseStmt.get(group.jid, msg.timestamp, tenMinLater);
    let interleavedUserBeforeReply = false;
    if (botResponse) {
      const headKey = interactionSenderKey(msg);
      for (const next of userMessages) {
        if (next.timestamp <= msg.timestamp) continue;
        if (next.timestamp >= botResponse.timestamp) break;
        const nextSender = next.sender || '';
        const nextSenderName = next.sender_name || '';
        if (nextSender.startsWith('web:') || nextSenderName.startsWith('web:')) continue;
        if (interactionSenderKey(next) !== headKey) {
          interleavedUserBeforeReply = true;
          botResponse = null;
          break;
        }
      }
    }

    const isWrite = isWriteRequest(msg.content);
    const isTaskWrite = isTaskWriteRequest(msg.content);
    const isDmSend = isDmSendRequest(msg.content);
    const isRead = isReadQuery(msg.content);
    const isIntent = isUserIntentDeclaration(msg.content);
    const messageTaskRefs = extractTaskRefs(msg.content);
    const reminderLikeWrite = isReminderLikeWrite(msg.content);
    let taskMutationFound = false;
    let crossGroupSendLogged = false;
    let refusalDetected = false;

    if (isDmSend) {
      const sendLogs = sendMessageLogStmt.all(
        group.folder,
        msg.timestamp,
        tenMinLater,
      );
      const directMessageMatch = hasSendMessageTriggerMessageId &&
        sendLogs.some((row) => row.trigger_message_id === msg.id);
      const turnMembershipMatch = !directMessageMatch &&
        sendMessageTurnMatchStmt
        ? sendMessageTurnMatchStmt.get(
            group.folder,
            msg.timestamp,
            tenMinLater,
            msg.id,
          ) !== undefined
        : false;
      const hasAnyExactCorrelation = sendLogs.some(
        (row) => !!row.trigger_message_id || !!row.trigger_turn_id,
      );
      crossGroupSendLogged = directMessageMatch ||
        turnMembershipMatch ||
        (!hasAnyExactCorrelation && sendLogs.length > 0);
    }

    // Asymmetric rule below: unambiguous task writes (isTaskWrite=true)
    // demand a real task-level mutation — a send_message_log row doesn't
    // prove the task was concluded. Shared-vocab writes ("mande mensagem
    // pro X sobre o prazo") also accept a send-log row as evidence.
    if (isWrite) {
      // Extend the search window 60s backward so a confirming follow-up
      // ("só retire o prazo" 33s after the bot already removed it) is
      // not flagged as unfulfilledWrite. Backward matches only count
      // when the bot's reply to THIS message echoes "already done" —
      // see acceptedMutations below.
      const sixtySecBefore = new Date(
        new Date(msg.timestamp).getTime() - 60000,
      ).toISOString();
      const mutations = taskHistoryStmt.all(...boardIds, sixtySecBefore, tenMinLater);
      const rawSender = msg.sender_name || msg.sender || '';
      const senderPersonId = resolveActorToPersonId(rawSender, boardIds);
      // Resolver hit → canonical person_id; miss (phone-number sender,
      // external contact, unregistered) → fall back to NFD-normalized string.
      // Not a strict superset of pre-fix logic: cross-board precedence could
      // theoretically cause matchNew < matchOld. Verified empirically clean
      // on prod snapshot (2026-04-23, 0 regression boards across 28 groups).
      const senderKey = senderPersonId ?? normalizeForCompare(rawSender);
      const matchingMutations = mutations.filter((mutation) => {
        let sameActor;
        if (!senderKey || !mutation.by) {
          // Preserve original semantics: when one side is unknown, don't
          // gate on actor; fall through to the task-ref filter below.
          sameActor = true;
        } else {
          const mutPersonId = resolveActorToPersonId(
            mutation.by,
            [mutation.board_id, ...boardIds],
          );
          const mutationKey = mutPersonId ?? normalizeForCompare(mutation.by);
          sameActor = mutationKey === senderKey;
        }
        if (!sameActor) return false;
        if (messageTaskRefs.size === 0) return true;
        return buildTaskIdAliases(
          mutation.task_id,
          mutation.board_id,
          boardShortCodes,
        ).some((alias) => messageTaskRefs.has(alias));
      });
      // Backward-window matches are noisy: an unrelated earlier mutation
      // on a different task (or by a different actor) can leak in,
      // especially for terse messages ("só retire o prazo") with empty
      // task_refs where the filter returns every match. Trust forward
      // matches by default; trust backward matches only when the bot's
      // reply explicitly acknowledges the work was already done.
      const msgTimeMs = new Date(msg.timestamp).getTime();
      const forwardMatches = matchingMutations.filter(
        (m) => new Date(m.at).getTime() >= msgTimeMs,
      );
      const backwardMatches = matchingMutations.filter(
        (m) => new Date(m.at).getTime() < msgTimeMs,
      );
      // The verb pattern: "já" plus a Portuguese acknowledgment verb.
      // Used by botEchoesAlreadyDone() below — exposed for source-grep
      // tests in auditor-dm-detection.test.ts.
      const ALREADY_DONE_RE =
        /\bj[aá]\s+(foi|fiz|feito|est[aáà]|conclu[íi]d|atualizad|removid|adicionad|criad|registrad|marcad)/i;
      // Returns true only when the bot's reply contains an "already done"
      // acknowledgment in an AFFIRMATIVE context. Phrases like "ela já foi
      // removida anteriormente" inside an error report ("a nota #6 não
      // existe") would falsely trigger ALREADY_DONE_RE alone, so we also
      // require that no negation token ("não|nunca|antes|nem") appears
      // within the 50 chars preceding the match.
      const NEGATION_NEAR_RE = /\b(n[aã]o|nunca|antes|nem)\b/i;
      const botEchoesAlreadyDone = (content) => {
        if (!content) return false;
        const m = ALREADY_DONE_RE.exec(content);
        if (!m) return false;
        const before = content.slice(Math.max(0, m.index - 50), m.index);
        return !NEGATION_NEAR_RE.test(before);
      };
      const responseEchoesAlreadyDone = botResponse &&
        botEchoesAlreadyDone(botResponse.content || '');
      let acceptedMutations;
      if (forwardMatches.length > 0) {
        acceptedMutations = forwardMatches;
      } else if (responseEchoesAlreadyDone) {
        acceptedMutations = backwardMatches;
      } else {
        acceptedMutations = [];
      }
      const scheduledTaskCreated = reminderLikeWrite &&
        scheduledTasksStmt.get(group.folder, msg.timestamp, tenMinLater) !== undefined;
      taskMutationFound = acceptedMutations.length > 0 || scheduledTaskCreated;
    }
    const mutationFound = isTaskWrite
      ? taskMutationFound
      : (taskMutationFound || crossGroupSendLogged);

    if (botResponse) {
      refusalDetected = hasRefusal(botResponse.content);
    }

    const noResponse = !botResponse &&
      !(isDmSend && crossGroupSendLogged && !isTaskWrite);
    const responseTimeMs = botResponse
      ? new Date(botResponse.timestamp).getTime() - new Date(msg.timestamp).getTime()
      : -1;
    const delayedResponse = botResponse && responseTimeMs > RESPONSE_THRESHOLD_MS;
    // `!isDmSend` gate removed: authoritative DM-send evidence is now
    // `send_message_log`, checked via `mutationFound` above. `isDmSend`
    // survives only as an informational bit in the interaction record.
    const writeNeedsMutation = !isRead && !isIntent && isWrite;
    const unfulfilledWrite = writeNeedsMutation && !mutationFound && !refusalDetected;

    if (noResponse || delayedResponse || unfulfilledWrite || refusalDetected) {
      interactions.push({
        timestamp: msg.timestamp,
        sender: msg.sender_name || msg.sender,
        message: msg.content.length > 300 ? msg.content.slice(0, 300) + "..." : msg.content,
        isWrite,
        isTaskWrite,
        isDmSend,
        isRead,
        isIntent,
        taskRefs: Array.from(messageTaskRefs),
        reminderLikeWrite,
        taskMutationFound,
        crossGroupSendLogged,
        interleavedUserBeforeReply,
        sourceMessageId: msg.id,
        noResponse,
        delayedResponse: delayedResponse || false,
        responseTimeMs,
        unfulfilledWrite,
        refusalDetected,
        botResponseMessageId: botResponse ? botResponse.id : null,
        botResponsePreview: botResponse
          ? (botResponse.content.length > 200 ? botResponse.content.slice(0, 200) + "..." : botResponse.content)
          : null,
      });
      totalIssues++;
    }
  }

  // Audit-trail divergence: if bot deliveries were logged for this group
  // but few/none landed in messages.db, the noResponse flags are probably
  // data-layer artifacts, not a real bot outage. Minimum absolute count
  // of 5 deliveries keeps one-off quiet-day variance from spurious flags.
  const deliveriesToGroup = deliveriesToGroupCountStmt.get(group.jid, period.startIso, period.endIso).n;
  const botRowsInGroup = botRowsInGroupCountStmt.get(group.jid, period.startIso, period.endIso).n;
  const auditTrailDivergence =
    deliveriesToGroup >= 5 && botRowsInGroup < deliveriesToGroup * 0.5;

  // Self-corrections: same-user same-task date-field mutation pairs within
  // 60 min. Proxies the "user had to fix what the bot did" signal. Each
  // pair requires `a.details <> b.details` (excludes programmatic
  // duplicate writes) and fetches the triggering message filtered to the
  // acting user's display name (board_people.name for pair.by).
  const correctionPairs = selfCorrectionStmts[boardIds.length]
    .all(...boardIds, period.startIso, period.endIso);
  const selfCorrections = correctionPairs.map((pair) => {
    const windowStart = new Date(new Date(pair.second_at).getTime() - 600000).toISOString();
    let trigger = null;
    let exactTrigger = null;
    let displayName = null;
    for (const bid of boardIds) {
      const row = personNameByIdStmt.get(bid, pair.by);
      if (row && row.name) { displayName = row.name; break; }
    }
    if (pair.second_trigger_turn_id && exactTurnMessagesStmt) {
      exactTrigger = resolveExactTurnMessages(
        exactTurnMessagesStmt.all(pair.second_trigger_turn_id),
        displayName,
      );
    }
    if (!exactTrigger && displayName) {
      // Escape LIKE wildcards in the user-controlled board_people.name
      // before interpolating into the pattern — otherwise a person named
      // "50% off" or "foo_bar" would broaden the match unexpectedly.
      const escaped = displayName.replace(/[\\%_]/g, (ch) => '\\' + ch);
      const likeName = `%${escaped}%`;
      trigger = triggerMessageStmt.get(group.jid, pair.second_at, windowStart, likeName);
    }
    return {
      taskId: pair.task_id,
      by: pair.by,
      byDisplayName: displayName,
      firstAt: pair.first_at,
      secondAt: pair.second_at,
      windowMinutes: Math.round((new Date(pair.second_at).getTime() - new Date(pair.first_at).getTime()) / 60000),
      firstDetails: pair.first_details,
      secondDetails: pair.second_details,
      triggerTurnId: exactTrigger ? exactTrigger.triggerTurnId : null,
      triggerMessageIds: exactTrigger
        ? exactTrigger.triggerMessageIds
        : (trigger ? [trigger.id] : null),
      triggerMessage: exactTrigger
        ? (exactTrigger.triggerMessage.length > 300
            ? exactTrigger.triggerMessage.slice(0, 300) + '...'
            : exactTrigger.triggerMessage)
        : trigger
          ? (trigger.content.length > 300 ? trigger.content.slice(0, 300) + '...' : trigger.content)
          : null,
      triggerSender: exactTrigger ? exactTrigger.triggerSender : (trigger ? (trigger.sender_name || null) : null),
    };
  });

  if (interactions.length > 0 || auditTrailDivergence || selfCorrections.length > 0) {
    boards.push({
      group: group.name,
      folder: group.folder,
      boardId: board.id,
      totalUserMessages: userMessages.length,
      flaggedInteractions: interactions.length,
      auditTrailDivergence,
      deliveriesToGroup,
      botRowsInGroup,
      interactions,
      selfCorrections,
    });
    if (auditTrailDivergence) totalIssues++;
    totalIssues += selfCorrections.length;
  }
}

const hasIssues = totalIssues > 0;

const result = {
  wakeAgent: hasIssues,
  data: {
    period: period.label,
    isWeekendReview: period.isWeekend,
    reviewWindow: { start: period.startIso, end: period.endIso },
    boards,
    summary: {
      totalBoards: boards.length,
      totalFlagged: totalIssues,
      boardsWithIssues: boards.map(b => b.folder),
    },
  },
};

const structuralAppendBlocks = [];
const refsAppendBlock = buildRefsAppendBlock(boards);
if (refsAppendBlock) {
  structuralAppendBlocks.push(refsAppendBlock);
}

const SEMANTIC_AUDIT_MODULE_PATH = '/app/dist/semantic-audit.js';

(async () => {
  const mode = process.env.NANOCLAW_SEMANTIC_AUDIT_MODE;
  try {
    if (mode === 'dryrun' || mode === 'enabled') {
      try {
        const { runSemanticAudit, runResponseAudit, writeDryRunLog } = await import(SEMANTIC_AUDIT_MODULE_PATH);
        const rawCloud = (process.env.NANOCLAW_SEMANTIC_AUDIT_CLOUD || '').trim().toLowerCase();
        const cloudOptIn = rawCloud === '1' || rawCloud === 'true' || rawCloud === 'yes';
        // Classifier selection. Two backends:
        //   - Ollama (all `*:cloud` / local model tags): uses OLLAMA_HOST
        //   - Anthropic (model starts with `claude-` or `anthropic:`): uses
        //     the container's credential-proxy at ANTHROPIC_BASE_URL, which
        //     injects auth and forwards to api.anthropic.com.
        // Bench notes: glm-5.1:cloud was the Ollama winner (6/6 on curated
        // cases) but produced 4/4 false positives on real production data
        // on 2026-04-19 — timezone arithmetic, dialogue-state reasoning,
        // and note-vs-action semantics all failed. Haiku was introduced
        // to address that class.
        const defaultModel = cloudOptIn
          ? 'minimax-m2.7:cloud'
          : 'claude-sonnet-4-6';
        const ollamaModel =
          process.env.NANOCLAW_SEMANTIC_AUDIT_MODEL || defaultModel;
        const isAnthropic = ollamaModel.startsWith('claude-') || ollamaModel.startsWith('anthropic:');
        // The `host` field is backend-specific but the module's arg name is
        // historical. For Anthropic, feed the credential-proxy base URL.
        const ollamaHost = isAnthropic
          ? (process.env.ANTHROPIC_BASE_URL || '')
          : (process.env.NANOCLAW_SEMANTIC_AUDIT_OLLAMA_HOST ||
             process.env.OLLAMA_HOST ||
             '');
        const ollamaFallbackHost =
          process.env.NANOCLAW_SEMANTIC_AUDIT_FALLBACK_OLLAMA_HOST || '';
        // Auto-wire a local fallback whenever the primary can tail-latency.
        // Anthropic rarely does (<<1%) but ollama cloud stubs ~20%. Users
        // override with NANOCLAW_SEMANTIC_AUDIT_FALLBACK_MODEL; `none`
        // disables; empty defaults to qwen3-coder:latest for cloud/anthropic
        // primaries, nothing for local primaries.
        const envFallback = process.env.NANOCLAW_SEMANTIC_AUDIT_FALLBACK_MODEL;
        const needsFallback = isAnthropic || ollamaModel.endsWith(':cloud');
        const ollamaFallbackModel = envFallback === 'none'
          ? ''
          : envFallback || (needsFallback ? 'qwen3-coder:latest' : '');
        if (ollamaHost) {
          // Phase 1: mutation-level audit (scheduled_at, due_date, assignee, title)
          const mutationAudit = await runSemanticAudit({
            msgDb, tfDb, period, ollamaHost, ollamaModel,
            ollamaFallbackHost, ollamaFallbackModel,
          });
          console.error(
            `Semantic audit — mutations (${mode}, ${ollamaModel}): ` +
            `examined=${mutationAudit.counters.examined} ` +
            `noTrigger=${mutationAudit.counters.noTrigger} ` +
            `boardMapFail=${mutationAudit.counters.boardMapFail} ` +
            `ollamaFail=${mutationAudit.counters.ollamaFail} ` +
            `parseFail=${mutationAudit.counters.parseFail} ` +
            `deviations=${mutationAudit.deviations.length}`,
          );

          // Phase 2: response-level audit (all user→bot interaction pairs)
          const responseAudit = await runResponseAudit({
            msgDb, tfDb, period, ollamaHost, ollamaModel,
            ollamaFallbackHost, ollamaFallbackModel,
          });
          console.error(
            `Semantic audit — responses (${mode}, ${ollamaModel}): ` +
            `examined=${responseAudit.counters.examined} ` +
            `skippedCasual=${responseAudit.counters.skippedCasual} ` +
            `skippedNoResponse=${responseAudit.counters.skippedNoResponse} ` +
            `boardMapFail=${responseAudit.counters.boardMapFail} ` +
            `ollamaFail=${responseAudit.counters.ollamaFail} ` +
            `parseFail=${responseAudit.counters.parseFail} ` +
            `deviations=${responseAudit.deviations.length}`,
          );

          // Merge both phases
          const allDeviations = [...mutationAudit.deviations, ...responseAudit.deviations];

          if (mode === 'dryrun') {
            writeDryRunLog(allDeviations);
          } else if (mode === 'enabled') {
            // Semantic candidates are kept OUT of the agent's payload and
            // appended verbatim by the host after the agent produces its
            // report. The in-prompt "Regra 10 — copy verbatim" approach
            // failed in Kipp run 7: the agent rewrote findings with
            // severity emojis and reinstated fabricated specifics. Only
            // a structural fix — the agent can't see them — prevents that.
            const devsByBoard = new Map();
            for (const d of allDeviations) {
              const arr = devsByBoard.get(d.boardId) || [];
              arr.push(d);
              devsByBoard.set(d.boardId, arr);
            }
            const boardMetaStmt = tfDb.prepare('SELECT group_jid, group_folder FROM boards WHERE id = ?');
            const groupMetaStmt = msgDb.prepare('SELECT folder, name FROM registered_groups WHERE jid = ?');
            const resolveBoardName = (boardId) => {
              const existing = boards.find(b => b.boardId === boardId);
              if (existing) return existing.group;
              const boardMeta = boardMetaStmt.get(boardId);
              if (boardMeta && boardMeta.group_jid) {
                const groupMeta = groupMetaStmt.get(boardMeta.group_jid);
                if (groupMeta) return groupMeta.name || groupMeta.folder;
                if (boardMeta.group_folder) return boardMeta.group_folder;
              }
              return boardId;
            };
            for (const [boardId, devs] of devsByBoard) {
              if (devs.length === 0) continue;
              const boardName = resolveBoardName(boardId);
              const lines = [];
              lines.push(
                `\n📋 *${boardName}* — _possíveis divergências semânticas (${devs.length} candidato${devs.length > 1 ? 's' : ''}, verificação manual recomendada; heurística de associação em revisão):_\n`,
              );
              for (const d of devs) {
                lines.push(`⚠️ *Candidato* _(confiança ${d.confidence}, ${d.fieldKind}${d.taskId ? `, task ${d.taskId}` : ''})_`);
                if (d.userMessage) {
                  lines.push(`> _Mensagem do usuário:_ ${escapeMdQuote(d.userMessage, 320)}`);
                }
                const stored = d.storedValue || d.responsePreview || '';
                if (stored) {
                  lines.push(`> _Valor armazenado / resposta do bot:_ ${escapeMdQuote(stored, 320)}`);
                }
                if (d.deviation) {
                  lines.push(`> _Apontamento do classificador:_ ${escapeMdQuote(d.deviation, 480)}`);
                }
                const refs = [];
                if (d.sourceTurnId) refs.push(`turn ${d.sourceTurnId}`);
                if (d.sourceMessageIds && d.sourceMessageIds.length > 0) {
                  refs.push(`msgs ${d.sourceMessageIds.join(', ')}`);
                }
                if (d.responseMessageId) refs.push(`resp ${d.responseMessageId}`);
                if (refs.length > 0) {
                  lines.push(`> _Refs:_ ${escapeMdQuote(refs.join(' | '), 480)}`);
                }
                lines.push('');
              }
              structuralAppendBlocks.push(lines.join('\n'));
            }
          }
        } else {
          console.error('Semantic audit skipped: OLLAMA_HOST not set');
        }
      } catch (err) {
        console.error(
          `Semantic audit failed (module path ${SEMANTIC_AUDIT_MODULE_PATH}):`,
          err && err.message ? err.message : err,
        );
      }
    }
  } finally {
    // --- Delivery health (registered groups whose bot output is silent) ---
    // Catches the failure mode where a group is registered but the bot is
    // not actually a member (kicked, never accepted invite, group deleted),
    // so every send to that JID fails and Kipp's semantic audit sees no
    // bot activity to evaluate. Caller-side check on messages.db only —
    // the WA outbound queue file is not mounted in the auditor container.
    // MUST run before msgDb.close() below.
    try {
      const RECENT_DAYS = 7;
      const cutoff = new Date(
        Date.now() - RECENT_DAYS * 86400 * 1000,
      ).toISOString();
      const flagged = msgDb
        .prepare(
          `
          SELECT g.folder AS folder, g.jid AS jid,
            (SELECT MAX(timestamp) FROM messages m
              WHERE m.chat_jid = g.jid AND m.is_from_me = 1) AS last_bot_send,
            (SELECT COUNT(*) FROM messages m
              WHERE m.chat_jid = g.jid AND m.is_from_me = 0
                AND m.is_bot_message = 0
                AND m.timestamp > ?) AS human_recent_n,
            (SELECT MAX(timestamp) FROM messages m
              WHERE m.chat_jid = g.jid AND m.is_from_me = 0) AS last_human
          FROM registered_groups g
          WHERE g.taskflow_managed = 1
          `,
        )
        .all(cutoff);
      const broken = [];
      for (const row of flagged) {
        if (row.last_bot_send === null && row.last_human !== null) {
          broken.push({
            folder: row.folder,
            jid: row.jid,
            kind: 'never_sent',
            last_human: row.last_human,
            human_recent_n: row.human_recent_n,
          });
        } else if (
          row.last_bot_send !== null &&
          row.last_bot_send < cutoff &&
          row.human_recent_n > 0
        ) {
          broken.push({
            folder: row.folder,
            jid: row.jid,
            kind: 'silent_with_recent_human_activity',
            last_bot_send: row.last_bot_send,
            human_recent_n: row.human_recent_n,
          });
        }
      }
      result.data.delivery_health = {
        recent_window_days: RECENT_DAYS,
        broken_groups: broken,
      };
    } catch (err) {
      result.data.delivery_health = {
        error: err && err.message ? err.message : String(err),
      };
    }

    try { msgDb.close(); } catch {}
    try { tfDb.close(); } catch {}
    if (mode === 'dryrun') {
      try { writeAuditDryRunLog(result.data); } catch (err) {
        console.error('Audit dryrun log failed:', err && err.message ? err.message : err);
      }
    }
    if (structuralAppendBlocks.length > 0) {
      result.mandatoryAppendBlocks = structuralAppendBlocks;
      // Structural appendices must survive even if the agent omits inline
      // refs; this also preserves the semantic candidate quarantine path.
      result.wakeAgent = true;
    }
    result.data.actor_first_name_heuristic_hits = firstNameHeuristicHits;
    result.data.actor_first_name_ambiguity_misses = firstNameAmbiguityMisses;

    console.log(JSON.stringify(result));
  }
})();
SCRIPT_EOF

NODE_PATH=/app/node_modules node /tmp/auditor.js
