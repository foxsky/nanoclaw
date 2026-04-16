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

  let daysBack = 1;
  let daysSpan = 1;
  if (dow === 1) { // Monday
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

  const label = dow === 1
    ? startLocal.toISOString().slice(0, 10) + " a " + new Date(endLocal.getTime() - 86400000).toISOString().slice(0, 10)
    : startLocal.toISOString().slice(0, 10);

  return {
    startIso: startUtc.toISOString(),
    endIso: endUtc.toISOString(),
    label,
    isWeekend: dow === 1,
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
const TERSE_PATTERN = /^(T|P|M|R|SEC-)\S+\s*(conclu|feita|feito|pronta|ok|aprovad|✅)/i;

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
  `SELECT content, timestamp FROM messages
   WHERE chat_jid = ? AND timestamp > ? AND timestamp <= ?
     AND (is_bot_message = 1 OR is_from_me = 1)
     AND content IS NOT NULL AND content != ''
   ORDER BY timestamp ASC LIMIT 1`
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
  `SELECT id FROM send_message_log
   WHERE source_group_folder = ? AND delivered_at >= ? AND delivered_at <= ?
   LIMIT 1`
);

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
    `SELECT action, task_id, at FROM task_history
     WHERE board_id IN (?) AND at >= ? AND at <= ?
     ORDER BY at ASC`
  ),
  2: tfDb.prepare(
    `SELECT action, task_id, at FROM task_history
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
            b.at AS second_at, b.details AS second_details
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
            b.at AS second_at, b.details AS second_details
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

const triggerMessageStmt = msgDb.prepare(
  `SELECT content, timestamp, sender_name FROM messages
   WHERE chat_jid = ? AND timestamp <= ? AND timestamp >= ?
     AND is_bot_message = 0 AND is_from_me = 0
     AND content IS NOT NULL AND content != ''
     AND sender_name LIKE ? ESCAPE '\\'
   ORDER BY timestamp DESC LIMIT 1`
);

for (const group of groups) {
  const board = boardStmt.get(group.folder);
  if (!board) continue;
  const boardIds = [board.id];
  if (board.parent_board_id) boardIds.push(board.parent_board_id);
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

    // Find bot response within 10 minutes
    const tenMinLater = new Date(new Date(msg.timestamp).getTime() + 600000).toISOString();
    const botResponse = botResponseStmt.get(group.jid, msg.timestamp, tenMinLater);

    const isWrite = isWriteRequest(msg.content);
    const isTaskWrite = isTaskWriteRequest(msg.content);
    const isDmSend = isDmSendRequest(msg.content);
    const isRead = isReadQuery(msg.content);
    const isIntent = isUserIntentDeclaration(msg.content);
    let taskMutationFound = false;
    let crossGroupSendLogged = false;
    let refusalDetected = false;

    // Asymmetric rule below: unambiguous task writes (isTaskWrite=true)
    // demand a real task-level mutation — a send_message_log row doesn't
    // prove the task was concluded. Shared-vocab writes ("mande mensagem
    // pro X sobre o prazo") also accept a send-log row as evidence.
    if (isWrite) {
      const mutations = taskHistoryStmt.all(...boardIds, msg.timestamp, tenMinLater);
      const scheduledTaskCreated = scheduledTasksStmt.get(group.folder, msg.timestamp, tenMinLater) !== undefined;
      taskMutationFound = mutations.length > 0 || scheduledTaskCreated;
      crossGroupSendLogged = sendMessageLogStmt.get(group.folder, msg.timestamp, tenMinLater) !== undefined;
    }
    const mutationFound = isTaskWrite
      ? taskMutationFound
      : (taskMutationFound || crossGroupSendLogged);

    if (botResponse) {
      refusalDetected = hasRefusal(botResponse.content);
    }

    const noResponse = !botResponse;
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
        taskMutationFound,
        crossGroupSendLogged,
        noResponse,
        delayedResponse: delayedResponse || false,
        responseTimeMs,
        unfulfilledWrite,
        refusalDetected,
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
    let displayName = null;
    for (const bid of boardIds) {
      const row = personNameByIdStmt.get(bid, pair.by);
      if (row && row.name) { displayName = row.name; break; }
    }
    if (displayName) {
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
      triggerMessage: trigger ? (trigger.content.length > 300 ? trigger.content.slice(0, 300) + '...' : trigger.content) : null,
      triggerSender: trigger ? (trigger.sender_name || null) : null,
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

const SEMANTIC_AUDIT_MODULE_PATH = '/app/dist/semantic-audit.js';

(async () => {
  try {
    const mode = process.env.NANOCLAW_SEMANTIC_AUDIT_MODE;
    if (mode === 'dryrun' || mode === 'enabled') {
      try {
        const { runSemanticAudit, runResponseAudit, writeDryRunLog } = await import(SEMANTIC_AUDIT_MODULE_PATH);
        const ollamaHost = process.env.OLLAMA_HOST || '';
        const rawCloud = (process.env.NANOCLAW_SEMANTIC_AUDIT_CLOUD || '').trim().toLowerCase();
        const cloudOptIn = rawCloud === '1' || rawCloud === 'true' || rawCloud === 'yes';
        const defaultModel = cloudOptIn
          ? 'minimax-m2.7:cloud'
          : 'qwen3.5:35b-a3b-coding-nvfp4';
        const ollamaModel =
          process.env.NANOCLAW_SEMANTIC_AUDIT_MODEL || defaultModel;
        if (ollamaHost) {
          // Phase 1: mutation-level audit (scheduled_at, due_date, assignee, title)
          const mutationAudit = await runSemanticAudit({
            msgDb, tfDb, period, ollamaHost, ollamaModel,
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
          });
          console.error(
            `Semantic audit — responses (${mode}, ${ollamaModel}): ` +
            `examined=${responseAudit.counters.examined} ` +
            `skippedCasual=${responseAudit.counters.skippedCasual} ` +
            `ollamaFail=${responseAudit.counters.ollamaFail} ` +
            `parseFail=${responseAudit.counters.parseFail} ` +
            `deviations=${responseAudit.deviations.length}`,
          );

          // Merge both phases
          const allDeviations = [...mutationAudit.deviations, ...responseAudit.deviations];

          if (mode === 'dryrun') {
            writeDryRunLog(allDeviations);
          } else if (mode === 'enabled') {
            // Attach deviations to existing boards AND surface boards that
            // only have semantic deviations (no heuristic flags). Without this,
            // a board with 0 heuristic issues + N semantic issues gets dropped.
            const boardIdSet = new Set(boards.map(b => b.boardId));
            for (const board of boards) {
              board.semanticDeviations = allDeviations.filter(d => d.boardId === board.boardId);
              if (board.semanticDeviations.length > 0) {
                result.data.summary.totalFlagged += board.semanticDeviations.length;
              }
            }
            // Add boards that only have semantic deviations
            const semanticOnlyBoardIds = new Set(
              allDeviations.map(d => d.boardId).filter(id => !boardIdSet.has(id)),
            );
            for (const boardId of semanticOnlyBoardIds) {
              const devs = allDeviations.filter(d => d.boardId === boardId);
              boards.push({
                group: boardId,
                folder: boardId.replace(/^board-/, ''),
                boardId,
                totalUserMessages: 0,
                flaggedInteractions: 0,
                auditTrailDivergence: false,
                deliveriesToGroup: 0,
                botRowsInGroup: 0,
                interactions: [],
                selfCorrections: [],
                semanticDeviations: devs,
              });
              result.data.summary.totalFlagged += devs.length;
              if (!result.data.summary.boardsWithIssues.includes(boardId.replace(/^board-/, ''))) {
                result.data.summary.boardsWithIssues.push(boardId.replace(/^board-/, ''));
              }
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
    try { msgDb.close(); } catch {}
    try { tfDb.close(); } catch {}
    console.log(JSON.stringify(result));
  }
})();
SCRIPT_EOF

NODE_PATH=/app/node_modules node /tmp/auditor.js
