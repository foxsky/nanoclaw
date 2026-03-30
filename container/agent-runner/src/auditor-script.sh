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

const MESSAGES_DB = "/workspace/project/store/messages.db";
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

// Terse task-ref + action pattern
const TERSE_PATTERN = /^(T|P|M|R|SEC-)\S+\s*(conclu|feita|feito|pronta|ok|aprovad|✅)/i;

// Refusal patterns in bot responses
const REFUSAL_PATTERN = /não consigo|não posso|não tenho como|não pode ser|bloqueado por limite|apenas o canal principal|não está cadastrad|o runtime atual|não oferece suporte|limite do sistema|deste quadro.*não consigo/i;

function isWriteRequest(text) {
  const lower = text.toLowerCase();
  for (const kw of WRITE_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  if (TERSE_PATTERN.test(text)) return true;
  return false;
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

for (const group of groups) {
  // Get the board_id for this group
  const board = tfDb.prepare(
    "SELECT id FROM boards WHERE group_folder = ?"
  ).get(group.folder);

  if (!board) continue;

  // Fetch non-bot user messages in the review period
  const userMessages = msgDb.prepare(
    `SELECT id, sender, sender_name, content, timestamp
     FROM messages
     WHERE chat_jid = ? AND timestamp >= ? AND timestamp < ?
       AND is_bot_message = 0 AND is_from_me = 0
       AND content IS NOT NULL AND content != ''
     ORDER BY timestamp`
  ).all(group.jid, period.startIso, period.endIso);

  if (userMessages.length === 0) continue;

  const interactions = [];

  for (const msg of userMessages) {
    // Find bot response within 10 minutes
    const tenMinLater = new Date(new Date(msg.timestamp).getTime() + 600000).toISOString();
    const botResponse = msgDb.prepare(
      `SELECT content, timestamp FROM messages
       WHERE chat_jid = ? AND timestamp > ? AND timestamp <= ?
         AND (is_bot_message = 1 OR is_from_me = 1)
         AND content IS NOT NULL AND content != ''
       ORDER BY timestamp ASC LIMIT 1`
    ).get(group.jid, msg.timestamp, tenMinLater);

    const isWrite = isWriteRequest(msg.content);
    let mutationFound = false;
    let refusalDetected = false;

    // For write requests, check task_history for matching mutations
    if (isWrite) {
      // Window: from message time to 10 min after
      const mutations = tfDb.prepare(
        `SELECT action, task_id, at FROM task_history
         WHERE board_id = ? AND at >= ? AND at <= ?
         ORDER BY at ASC`
      ).all(board.id, msg.timestamp, tenMinLater);

      mutationFound = mutations.length > 0;
    }

    // Check for refusals in bot response
    if (botResponse) {
      refusalDetected = hasRefusal(botResponse.content);
    }

    // Flag if: no bot response, write request with no mutation, or refusal
    const noResponse = !botResponse;
    const unfulfilledWrite = isWrite && !mutationFound && !refusalDetected;

    if (noResponse || unfulfilledWrite || refusalDetected) {
      interactions.push({
        timestamp: msg.timestamp,
        sender: msg.sender_name || msg.sender,
        message: msg.content.length > 300 ? msg.content.slice(0, 300) + "..." : msg.content,
        isWrite,
        noResponse,
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
