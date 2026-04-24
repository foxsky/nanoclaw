#!/usr/bin/env node
// Phase 0 backfill analyzer for the T12-magnetism guard (see
// docs/superpowers/plans/2026-04-24-t12-magnetism.md).
//
// Counts "magnetism candidate" mutations: task_history rows where the user
// message had no explicit T#/P#/SEC- reference, the bot's immediately prior
// message (concatenated across ≤30s of consecutive bot messages) contained
// exactly one task ref in a confirmation-question shape, and the bot ref
// doesn't match the mutation's task_id.
//
// Read-only. No mutations. Outputs JSON for the gate decision at
// Phase 0 Task 0.1 Step 3.

import Database from 'better-sqlite3';

const MESSAGES_DB =
  process.env.MESSAGES_DB || '/tmp/prod-snapshot-20260424/messages.db';
const TASKFLOW_DB =
  process.env.TASKFLOW_DB || '/tmp/prod-snapshot-20260424/taskflow.db';
const DAYS = Number(process.env.DAYS || 30);
const WINDOW_MS = 10 * 60 * 1000;
const BOT_CONCAT_WINDOW_MS = 30_000;

const TASK_REF_RE =
  /\b(?:[A-Z]{2,}-)?(?:T|P|M|R)\d+(?:\.\d+)*\b|\bSEC-[A-Z0-9]+(?:[.-][A-Z0-9]+)*\b/gi;
const CONFIRM_VERBS =
  /\b(Cancelar|Mover|Atualizar|Reagendar|Concluir|Aprovar|Rejeitar|Remover|Arquivar|Fechar|Finalizar|Iniciar|Reabrir|Atribuir|Reatribuir)\b/i;

function extractTaskRefs(text) {
  if (!text) return [];
  const matches = String(text).match(TASK_REF_RE);
  return matches ? Array.from(new Set(matches.map((m) => m.toUpperCase()))) : [];
}

function isConfirmationQuestion(text) {
  if (!text) return false;
  return text.includes('?') || CONFIRM_VERBS.test(text);
}

function main() {
  const msgDb = new Database(MESSAGES_DB, { readonly: true });
  const tfDb = new Database(TASKFLOW_DB, { readonly: true });

  const cutoff = new Date(Date.now() - DAYS * 86_400_000).toISOString();

  const mutations = tfDb
    .prepare(
      `SELECT board_id, task_id, action, by, at, details FROM task_history
       WHERE action IN ('updated', 'moved', 'approve', 'conclude', 'cancel', 'reopen')
         AND at >= ? ORDER BY at ASC`,
    )
    .all(cutoff);

  const boardStmt = tfDb.prepare(
    `SELECT group_jid FROM boards WHERE id = ?`,
  );
  const userStmt = msgDb.prepare(
    `SELECT content, timestamp FROM messages
     WHERE chat_jid = ? AND is_from_me = 0 AND is_bot_message = 0
       AND timestamp >= ? AND timestamp <= ?
     ORDER BY timestamp DESC LIMIT 1`,
  );
  const botStmt = msgDb.prepare(
    `SELECT content, timestamp FROM messages
     WHERE chat_jid = ? AND (is_from_me = 1 OR is_bot_message = 1)
       AND timestamp < ? AND timestamp >= ?
     ORDER BY timestamp DESC LIMIT 3`,
  );

  let totalMutations = 0;
  let candidates = 0;
  const byBoard = new Map();
  const activeBoardDays = new Map();
  const samples = [];

  for (const mut of mutations) {
    totalMutations += 1;
    const dayKey = String(mut.at).slice(0, 10);
    if (!activeBoardDays.has(mut.board_id)) {
      activeBoardDays.set(mut.board_id, new Set());
    }
    activeBoardDays.get(mut.board_id).add(dayKey);

    const board = boardStmt.get(mut.board_id);
    if (!board?.group_jid) continue;
    const chatJid = board.group_jid;

    const mutMs = new Date(mut.at).getTime();
    if (!Number.isFinite(mutMs)) continue;
    const windowStartIso = new Date(mutMs - WINDOW_MS).toISOString();

    const userMsg = userStmt.get(chatJid, windowStartIso, mut.at);
    if (!userMsg) continue;
    if (extractTaskRefs(userMsg.content).length > 0) continue;

    const botFloor = new Date(
      new Date(userMsg.timestamp).getTime() - BOT_CONCAT_WINDOW_MS,
    ).toISOString();
    const botRows = botStmt.all(chatJid, userMsg.timestamp, botFloor);
    if (botRows.length === 0) continue;
    const botContent = botRows
      .map((r) => r.content || '')
      .reverse()
      .join('\n');

    const botRefs = extractTaskRefs(botContent);
    if (botRefs.length !== 1) continue;
    if (!isConfirmationQuestion(botContent)) continue;
    if (botRefs[0].toUpperCase() === String(mut.task_id).toUpperCase()) continue;

    candidates += 1;
    byBoard.set(mut.board_id, (byBoard.get(mut.board_id) ?? 0) + 1);
    if (samples.length < 10) {
      samples.push({
        board_id: mut.board_id,
        task_id: mut.task_id,
        expected: botRefs[0],
        at: mut.at,
        user_msg_preview: String(userMsg.content || '').slice(0, 80),
        bot_msg_preview: botContent.slice(0, 140),
      });
    }
  }

  const perBoardRates = [];
  for (const [boardId, count] of byBoard) {
    const activeDays = activeBoardDays.get(boardId)?.size ?? 0;
    perBoardRates.push({
      board_id: boardId,
      candidates: count,
      active_days: activeDays,
      weekly_normalized: activeDays > 0 ? (count / activeDays) * 7 : 0,
    });
  }
  perBoardRates.sort((a, b) => b.weekly_normalized - a.weekly_normalized);

  const report = {
    days: DAYS,
    totalMutations,
    magnetismCandidates: candidates,
    projectedWeekly_fleet: Number(((candidates / DAYS) * 7).toFixed(2)),
    max_per_board_weekly: Number(
      Math.max(0, ...perBoardRates.map((b) => b.weekly_normalized)).toFixed(2),
    ),
    perBoardRates,
    samples,
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
