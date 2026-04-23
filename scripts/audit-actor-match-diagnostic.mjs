#!/usr/bin/env node
// Read-only diagnostic. Counts write-ish user messages in the given window
// and measures how many have a sameActor-matching task_history mutation in
// window under (a) the current auditor logic and (b) the proposed resolver.
//
// CRITICAL: WRITE_KEYWORDS / TERSE_PATTERN / isWriteRequest below are kept
// in sync with auditor-script.sh:87-113,251-254. If you change the live
// detection, update this script too — otherwise the diagnostic measures a
// different denominator than the live auditor.

import Database from 'better-sqlite3';

const MESSAGES_DB = process.env.MESSAGES_DB || '/root/nanoclaw/store/messages.db';
const TASKFLOW_DB = process.env.TASKFLOW_DB || '/root/nanoclaw/data/taskflow/taskflow.db';
const DAYS = Number(process.env.DAYS || 7);
const WINDOW_MS = 10 * 60 * 1000;

const nfd = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

// MIRRORS auditor-script.sh:87-96
const WRITE_KEYWORDS = [
  'concluir', 'concluída', 'concluido', 'finalizar', 'finalizado',
  'criar', 'adicionar', 'atribuir', 'aprovar', 'aprovada', 'aprovado',
  'descartar', 'cancelar', 'mover', 'adiar', 'renomear', 'alterar',
  'remover', 'em andamento', 'para aguardando', 'para revisão',
  'processar inbox', 'para inbox', 'nota', 'anotar', 'lembrar',
  'lembrete', 'prazo', 'próximo passo', 'próxima ação', 'descrição',
  'começando', 'comecando', 'aguardando', 'retomada', 'devolver',
  'done', 'feita', 'feito', 'pronta',
];
// MIRRORS auditor-script.sh:113
const TERSE_PATTERN = /^(?:(?:[A-Z]{2,}-)?(?:T|P|M|R)\S+|SEC-\S+)\s*(conclu|feita|feito|pronta|ok|aprovad|✅)/i;
// MIRRORS auditor-script.sh:251-254
function isWriteRequest(text) {
  const lower = String(text || '').toLowerCase();
  return WRITE_KEYWORDS.some((kw) => lower.includes(kw)) || TERSE_PATTERN.test(text);
}

function makeResolver(tfDb) {
  const exactName = tfDb.prepare(
    `SELECT person_id, name FROM board_people WHERE board_id = ?`,
  );
  const cache = new Map();
  let heuristicHits = 0;
  const resolve = (raw, boardIds) => {
    if (!raw) return null;
    const key = nfd(raw);
    if (!key) return null;
    for (const boardId of boardIds) {
      if (!boardId) continue;
      let people = cache.get(boardId);
      if (!people) {
        people = exactName.all(boardId);
        cache.set(boardId, people);
      }
      const exact = people.find((p) => nfd(p.name) === key || nfd(p.person_id) === key);
      if (exact) return exact.person_id;
      const first = key.split(/\s+/)[0];
      if (first) {
        const firstMatches = people.filter(
          (p) => nfd(p.name).split(/\s+/)[0] === first,
        );
        if (firstMatches.length === 1) {
          heuristicHits += 1;
          return firstMatches[0].person_id;
        }
      }
    }
    return null;
  };
  return { resolve, heuristicHits: () => heuristicHits };
}

function main() {
  const msgDb = new Database(MESSAGES_DB, { readonly: true });
  const tfDb = new Database(TASKFLOW_DB, { readonly: true });

  // ISO cutoff string — messages.timestamp and task_history.at are both
  // TEXT/ISO-Z, lexicographic comparison matches chronological order.
  const cutoffIso = new Date(Date.now() - DAYS * 86400 * 1000).toISOString();

  // MIRRORS auditor-script.sh:481-498. Only TaskFlow-managed groups, then
  // resolve their boards by group_folder.
  const groups = msgDb
    .prepare(
      `SELECT jid, name, folder FROM registered_groups WHERE taskflow_managed = 1`,
    )
    .all();
  const boardStmt = tfDb.prepare(
    `SELECT id, parent_board_id FROM boards WHERE group_folder = ?`,
  );

  const { resolve, heuristicHits } = makeResolver(tfDb);

  let totalWrites = 0;
  let writesWithAnyMutation = 0;
  let matchOld = 0;
  let matchNew = 0;
  const perBoard = [];

  for (const group of groups) {
    const board = boardStmt.get(group.folder);
    if (!board) continue;
    const boardIds = [board.id, board.parent_board_id].filter(Boolean);
    const placeholders = boardIds.map(() => '?').join(',');

    const msgs = msgDb
      .prepare(
        `SELECT id, chat_jid, timestamp, content, sender, sender_name
         FROM messages
         WHERE chat_jid = ?
           AND is_from_me = 0
           AND is_bot_message = 0
           AND content IS NOT NULL
           AND content <> ''
           AND timestamp >= ?`,
      )
      .all(group.jid, cutoffIso);

    const mutStmt = tfDb.prepare(
      `SELECT board_id, task_id, "by", at FROM task_history
       WHERE board_id IN (${placeholders}) AND at >= ? AND at <= ?`,
    );

    let bWrites = 0, bMutAny = 0, bMatchOld = 0, bMatchNew = 0;
    for (const m of msgs) {
      const content = m.content || '';
      if (!isWriteRequest(content)) continue;
      bWrites += 1;
      totalWrites += 1;

      const startMs = new Date(m.timestamp).getTime();
      if (!Number.isFinite(startMs)) continue;
      const endIso = new Date(startMs + WINDOW_MS).toISOString();
      const mutations = mutStmt.all(...boardIds, m.timestamp, endIso);
      if (mutations.length === 0) continue;
      bMutAny += 1;
      writesWithAnyMutation += 1;

      const rawSender = m.sender_name || m.sender || '';
      const oldSenderKey = nfd(rawSender);
      const newSenderPid = resolve(rawSender, boardIds);
      const newSenderKey = newSenderPid ?? oldSenderKey;

      const hasOld = mutations.some((mut) => {
        if (!oldSenderKey || !mut.by) return false;
        return nfd(mut.by) === oldSenderKey;
      });
      const hasNew = mutations.some((mut) => {
        if (!newSenderKey || !mut.by) return false;
        const mutPid = resolve(mut.by, [mut.board_id, ...boardIds]);
        const mutKey = mutPid ?? nfd(mut.by);
        return mutKey === newSenderKey;
      });

      if (hasOld) { bMatchOld += 1; matchOld += 1; }
      if (hasNew) { bMatchNew += 1; matchNew += 1; }
    }
    if (bWrites > 0) {
      perBoard.push({
        group: group.folder,
        board_id: board.id,
        writes: bWrites,
        writesWithAnyMutation: bMutAny,
        matchOld: bMatchOld,
        matchNew: bMatchNew,
      });
    }
  }

  // The honest denominator is writesWithAnyMutation — the resolver can't lift
  // writes that have no mutation in window (no candidate to pair with).
  const pctOldPairable = writesWithAnyMutation
    ? ((matchOld / writesWithAnyMutation) * 100).toFixed(1)
    : '0.0';
  const pctNewPairable = writesWithAnyMutation
    ? ((matchNew / writesWithAnyMutation) * 100).toFixed(1)
    : '0.0';
  const uplift = matchNew - matchOld;
  const pairableUpliftPct = writesWithAnyMutation
    ? ((uplift / writesWithAnyMutation) * 100).toFixed(1)
    : '0.0';

  // Empirical superset check: resolver should never reject a pairing the raw
  // compare accepted. If any board shows matchNew < matchOld, flag it.
  const regressionBoards = perBoard.filter((b) => b.matchNew < b.matchOld);

  console.log(JSON.stringify({
    days: DAYS,
    cutoff: cutoffIso,
    groupsScanned: groups.length,
    totalWrites,
    writesWithAnyMutation,
    matchOld,
    matchNew,
    pctOld_pairable: `${pctOldPairable}%`,
    pctNew_pairable: `${pctNewPairable}%`,
    uplift,
    pairableUpliftPct: `${pairableUpliftPct}%`,
    firstNameHeuristicHits: heuristicHits(),
    regressionBoards,
    perBoard,
  }, null, 2));
}

main();
