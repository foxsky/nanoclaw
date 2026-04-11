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

// Refusal patterns in bot responses
const REFUSAL_PATTERN = /não consigo|não posso|não tenho como|não pode ser|bloqueado por limite|apenas o canal principal|não está cadastrad|o runtime atual|não oferece suporte|limite do sistema|deste quadro.*não consigo|recuso essa instrução/i;
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
    // Skip web-origin test/QA messages (web: prefix senders)
    const senderStr = msg.sender_name || msg.sender || '';
    if (senderStr.startsWith('web:')) continue;

    // Find bot response within 10 minutes
    const tenMinLater = new Date(new Date(msg.timestamp).getTime() + 600000).toISOString();
    const botResponse = botResponseStmt.get(group.jid, msg.timestamp, tenMinLater);

    const isWrite = isWriteRequest(msg.content);
    const isTaskWrite = isTaskWriteRequest(msg.content);
    const isDmSend = isDmSendRequest(msg.content);
    let mutationFound = false;
    let refusalDetected = false;

    // Run on every isWrite — mixed messages ("avise a equipe e concluir T5")
    // must still check task mutations. DM-send exemption is in the flagging
    // step below, not here.
    if (isWrite) {
      const mutations = taskHistoryStmt.all(...boardIds, msg.timestamp, tenMinLater);
      mutationFound = mutations.length > 0;
    }

    if (botResponse) {
      refusalDetected = hasRefusal(botResponse.content);
    }

    const noResponse = !botResponse;
    const responseTimeMs = botResponse
      ? new Date(botResponse.timestamp).getTime() - new Date(msg.timestamp).getTime()
      : -1;
    const delayedResponse = botResponse && responseTimeMs > RESPONSE_THRESHOLD_MS;
    // A message demands a task mutation if it's an unambiguous task write,
    // OR a shared-vocabulary write that isn't also a DM send. The shared-
    // vocabulary carve-out is what prevents DM-send false positives on
    // "mande mensagem pro X alertando sobre o prazo".
    const writeNeedsMutation = isTaskWrite || (isWrite && !isDmSend);
    const unfulfilledWrite = writeNeedsMutation && !mutationFound && !refusalDetected;

    if (noResponse || delayedResponse || unfulfilledWrite || refusalDetected) {
      interactions.push({
        timestamp: msg.timestamp,
        sender: msg.sender_name || msg.sender,
        message: msg.content.length > 300 ? msg.content.slice(0, 300) + "..." : msg.content,
        isWrite,
        isTaskWrite,
        isDmSend,
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

  if (interactions.length > 0) {
    boards.push({
      group: group.name,
      folder: group.folder,
      boardId: board.id,
      totalUserMessages: userMessages.length,
      flaggedInteractions: interactions.length,
      interactions,
    });
  }
}

msgDb.close();
tfDb.close();

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

console.log(JSON.stringify(result));
SCRIPT_EOF

NODE_PATH=/app/node_modules node /tmp/auditor.js
