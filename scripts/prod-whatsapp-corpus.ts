#!/usr/bin/env tsx
/**
 * Build Phase 3 candidate corpora from a cloned production messages.db.
 *
 * Claude JSONL corpora remain the strongest oracle because they include v1
 * tool calls. This script covers the wider WhatsApp history stored in
 * messages.db: it extracts agent turns, reconstructs the user message envelope,
 * attaches the observed v1 bot reply when available, and emits semantic
 * expectations suitable for Phase 3 candidate replays.
 *
 * Usage:
 *   pnpm exec tsx scripts/prod-whatsapp-corpus.ts \
 *     --db /tmp/prod-interactions-latest/messages.db \
 *     --out-dir /tmp/prod-interactions-latest/corpora \
 *     --max-per-board 40 \
 *     --reply-window-minutes 15 \
 *     --state-snapshot /tmp/prod-interactions-latest/taskflow.db
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  classifyOutboundIntent,
  extractBoardRefsFromText,
  extractTaskIdsFromText,
  type Phase3ExpectedBehavior,
  type Phase3SemanticAction,
} from './phase3-support.js';

interface Args {
  db: string;
  outDir: string;
  folder?: string;
  maxPerBoard: number;
  replyWindowMinutes: number;
  stateSnapshot?: string;
}

interface RegisteredGroupRow {
  jid: string;
  name: string;
  folder: string;
}

interface AgentTurnRow {
  id: string;
  group_folder: string;
  chat_jid: string;
  chat_name: string | null;
  created_at: string;
}

interface TurnMessageRow {
  message_id: string;
  message_chat_jid: string;
  sender: string;
  sender_name: string;
  message_timestamp: string;
  ordinal: number;
  content: string | null;
}

interface BotReplyRow {
  id: string;
  timestamp: string;
  sender_name: string | null;
  content: string | null;
}

interface ParsedMessage {
  sender: string;
  time: string;
  text: string;
}

interface CandidateTurn {
  user_message: string;
  user_timestamp: string;
  parsed_messages: ParsedMessage[];
  tool_uses: [];
  outbound_messages: [];
  outbound_text: string | null;
  final_response: string | null;
  turn_index: number;
  jsonl: string;
  category: 'no_tools';
  state_snapshot?: string;
  requires_state_snapshot?: boolean;
  source_kind: 'prod_messages_db';
  source_turn_id: string;
  source_chat_jid: string;
  source_chat_name: string | null;
  source_group_folder: string;
  behavior_signature: string;
  selection_reason?: string;
  coverage_priority: 'high' | 'medium' | 'low';
  expected_behavior: Phase3ExpectedBehavior;
}

interface BoardCorpus {
  source: 'prod_messages_db';
  source_db: string;
  generated_at: string;
  board: RegisteredGroupRow;
  total_turns: number;
  curated_count: number;
  selection: 'semantic_message_candidates';
  note: string;
  turns: CandidateTurn[];
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--')) throw new Error(`Unexpected arg: ${key}`);
    args[key.slice(2)] = argv[i + 1] ?? '';
  }
  if (!args.db || !args['out-dir']) {
    throw new Error('Usage: --db <messages.db> --out-dir <dir> [--folder FOLDER] [--max-per-board N]');
  }
  return {
    db: args.db,
    outDir: args['out-dir'],
    folder: args.folder,
    maxPerBoard: args['max-per-board'] ? Number.parseInt(args['max-per-board'], 10) : 40,
    replyWindowMinutes: args['reply-window-minutes'] ? Number.parseInt(args['reply-window-minutes'], 10) : 15,
    stateSnapshot: args['state-snapshot'] || defaultStateSnapshot(args.db),
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function messageEnvelope(messages: ParsedMessage[]): string {
  const body = messages
    .map((message) =>
      `<message sender="${xmlEscape(message.sender)}" time="${xmlEscape(message.time)}">${xmlEscape(message.text)}</message>`,
    )
    .join('\n');
  return `<messages>\n${body}\n</messages>`;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function requestSignature(text: string): string {
  const normalized = normalizeText(text);
  const compact = normalized.replace(/\s+/g, ' ').trim();
  if (/^(sim|s|ok|certo|isso|pode|confirmo|confirma|nao|não)\b/.test(compact)) return 'bare_confirmation';
  if (/\b(quadro|board|status geral|relatorio|relatório)\b/.test(normalized)) return 'board_report';
  if (/\b(aprovar|aprove)\b[\s\S]{0,80}\b(todas|todos)\b/.test(normalized)) return 'bulk_approval';
  if (/\b(encaminh|envi|mande|mandar|avise|avisar)\b/.test(normalized)) return 'forward_or_notify';
  if (/\b(reuniao|reunião|ata|participante|participantes)\b/.test(normalized)) return 'meeting';
  if (/\b(alocar|atribuir|responsavel|responsável|adicionar|inclui|incluir)\b/.test(normalized)) return 'assignment_or_participant';
  if (/\b(conclu|finaliz|pronto|feito|aprovad|andamento|aguardando|mover|mova)\b/.test(normalized)) return 'status_update';
  if (/^\s*(?:[A-Z]{2,}-)?[TPMR]\d+(?:\.\d+)?\s*[-:]/i.test(text)) return 'exact_id_note';
  if (/\b(?:[A-Z]{2,}-)?[TPMR]\d+(?:\.\d+)?\b/i.test(text)) return 'exact_id_reference';
  if (/\b(qual|quais|buscar|busque|encontr|detalhes|sobre)\b/.test(normalized)) return 'search_or_read';
  if (compact.length < 220 && !/[?.!]/.test(compact)) return 'standalone_activity';
  return 'other';
}

function expectedActionFromReply(replyText: string | null): Phase3SemanticAction {
  if (!replyText?.trim()) return 'no-op';
  if (/\b(nenhuma a[cç][aã]o realizada|sem a[cç][aã]o|n[aã]o fiz nenhuma altera[cç][aã]o)\b/i.test(replyText)) return 'no-op';
  if (
    /\b(tarefa criada|criad[ao]s?|atualizad[ao]s?|nota registrada|prazo definido|movid[ao]s?|enviada para|registrad[ao]s?)\b/i.test(replyText) ||
    /✅[\s\S]{0,80}\b(?:Tarefa|[TPMR]\d+(?:\.\d+)?)\b/i.test(replyText)
  ) {
    return 'mutate';
  }
  const intent = classifyOutboundIntent(replyText);
  if (intent === 'asks_user' || intent === 'not_found_or_unclear') return 'ask';
  if (intent === 'forward_confirmation') return 'forward';
  if (intent === 'mutation_confirmation') return 'mutate';
  if (intent === 'informational') return 'read';
  return 'no-op';
}

function priorityFor(signature: string, expectedAction: Phase3SemanticAction): 'high' | 'medium' | 'low' {
  if (expectedAction === 'mutate' || expectedAction === 'forward') return 'high';
  if (/bulk_approval|meeting|assignment_or_participant|exact_id_note|bare_confirmation/.test(signature)) return 'high';
  if (expectedAction === 'ask' || /status_update|forward_or_notify|search_or_read/.test(signature)) return 'medium';
  return 'low';
}

function outputSafeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function defaultStateSnapshot(messagesDb: string): string | undefined {
  const candidate = path.join(path.dirname(messagesDb), 'taskflow.db');
  return fs.existsSync(candidate) ? candidate : undefined;
}

function addMinutes(timestamp: string, minutes: number): string {
  return new Date(new Date(timestamp).getTime() + minutes * 60_000).toISOString().replace('.000Z', '.000Z');
}

function earliestTimestamp(values: Array<string | null | undefined>): string | null {
  return values.filter((value): value is string => !!value).sort()[0] ?? null;
}

function loadGroups(db: Database.Database, folder?: string): RegisteredGroupRow[] {
  const sql = `
    SELECT jid, name, folder
    FROM registered_groups
    WHERE taskflow_managed = 1
      ${folder ? 'AND folder = ?' : ''}
    ORDER BY folder
  `;
  return (folder ? db.prepare(sql).all(folder) : db.prepare(sql).all()) as RegisteredGroupRow[];
}

function loadTurns(db: Database.Database, folder: string): AgentTurnRow[] {
  return db.prepare(`
    SELECT t.id, t.group_folder, t.chat_jid, c.name AS chat_name, t.created_at
    FROM agent_turns t
    LEFT JOIN chats c ON c.jid = t.chat_jid
    WHERE t.group_folder = ?
    ORDER BY t.created_at, t.id
  `).all(folder) as AgentTurnRow[];
}

function loadTurnMessages(db: Database.Database, turnId: string): TurnMessageRow[] {
  return db.prepare(`
    SELECT
      atm.message_id,
      atm.message_chat_jid,
      atm.sender,
      atm.sender_name,
      atm.message_timestamp,
      atm.ordinal,
      m.content
    FROM agent_turn_messages atm
    LEFT JOIN messages m
      ON m.id = atm.message_id
     AND m.chat_jid = atm.message_chat_jid
    WHERE atm.turn_id = ?
    ORDER BY atm.ordinal
  `).all(turnId) as TurnMessageRow[];
}

function loadBotReplies(
  db: Database.Database,
  chatJid: string,
  afterTimestamp: string,
  beforeTimestamp: string | null,
): BotReplyRow[] {
  return db.prepare(`
    SELECT id, timestamp, sender_name, content
    FROM messages
    WHERE chat_jid = ?
      AND timestamp >= ?
      AND (? IS NULL OR timestamp < ?)
      AND (is_bot_message = 1 OR is_from_me = 1)
    ORDER BY timestamp, id
  `).all(chatJid, afterTimestamp, beforeTimestamp, beforeTimestamp) as BotReplyRow[];
}

function nextHumanMessageTimestamp(
  db: Database.Database,
  chatJid: string,
  afterTimestamp: string,
): string | null {
  const row = db.prepare(`
    SELECT timestamp
    FROM messages
    WHERE chat_jid = ?
      AND timestamp > ?
      AND COALESCE(is_bot_message, 0) = 0
      AND COALESCE(is_from_me, 0) = 0
    ORDER BY timestamp, id
    LIMIT 1
  `).get(chatJid, afterTimestamp) as { timestamp: string } | undefined;
  return row?.timestamp ?? null;
}

function nextTurnByChat(turns: AgentTurnRow[]): Map<string, AgentTurnRow | null> {
  const out = new Map<string, AgentTurnRow | null>();
  const byChat = new Map<string, AgentTurnRow[]>();
  for (const turn of turns) {
    const rows = byChat.get(turn.chat_jid) ?? [];
    rows.push(turn);
    byChat.set(turn.chat_jid, rows);
  }
  for (const rows of byChat.values()) {
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    for (let i = 0; i < rows.length; i++) out.set(rows[i].id, rows[i + 1] ?? null);
  }
  return out;
}

function buildCandidate(
  args: Args,
  db: Database.Database,
  turn: AgentTurnRow,
  nextTurn: AgentTurnRow | null,
  index: number,
): CandidateTurn | null {
  const messages = loadTurnMessages(db, turn.id)
    .filter((message) => typeof message.content === 'string' && message.content.trim())
    .map((message) => ({
      sender: message.sender_name || message.sender,
      time: message.message_timestamp,
      text: message.content!.trim(),
    }));
  if (messages.length === 0) return null;

  const lastInputTimestamp = messages[messages.length - 1].time;
  const nextHuman = nextHumanMessageTimestamp(db, turn.chat_jid, lastInputTimestamp);
  const nextBoundary = earliestTimestamp([
    nextTurn?.created_at,
    nextHuman,
    addMinutes(lastInputTimestamp, args.replyWindowMinutes),
  ]);
  const replies = loadBotReplies(db, turn.chat_jid, lastInputTimestamp, nextBoundary)
    .filter((reply) => typeof reply.content === 'string' && reply.content.trim());
  const replyText = replies.map((reply) => reply.content!.trim()).join('\n\n') || null;
  const userText = messages.map((message) => message.text).join('\n');
  const signature = requestSignature(userText);
  const expectedAction = expectedActionFromReply(replyText);
  const outboundIntent = replyText ? classifyOutboundIntent(replyText) : 'none';
  const taskIds = [...new Set([
    ...extractTaskIdsFromText(userText),
    ...extractTaskIdsFromText(replyText ?? ''),
  ])].sort();

  return {
    user_message: messageEnvelope(messages),
    user_timestamp: messages[0].time,
    parsed_messages: messages,
    tool_uses: [],
    outbound_messages: [],
    outbound_text: replyText,
    final_response: replyText,
    turn_index: index,
    jsonl: `messages.db#agent_turns/${turn.id}`,
    category: 'no_tools',
    state_snapshot: args.stateSnapshot,
    requires_state_snapshot: !!args.stateSnapshot,
    source_kind: 'prod_messages_db',
    source_turn_id: turn.id,
    source_chat_jid: turn.chat_jid,
    source_chat_name: turn.chat_name,
    source_group_folder: turn.group_folder,
    behavior_signature: `${signature}:${expectedAction}:${outboundIntent}`,
    coverage_priority: priorityFor(signature, expectedAction),
    expected_behavior: {
      action: expectedAction,
      task_ids: taskIds,
      allow_extra_task_ids: true,
      board_refs: extractBoardRefsFromText(`${userText}\n${replyText ?? ''}`),
      outbound_intent: outboundIntent,
    },
  };
}

function chooseCandidates(turns: CandidateTurn[], max: number): CandidateTurn[] {
  const bySignature = new Map<string, CandidateTurn[]>();
  for (const turn of turns) {
    const rows = bySignature.get(turn.behavior_signature) ?? [];
    rows.push(turn);
    bySignature.set(turn.behavior_signature, rows);
  }

  const priorityScore = { high: 0, medium: 1, low: 2 };
  const signatures = [...bySignature.entries()].sort((a, b) => {
    const ap = Math.min(...a[1].map((turn) => priorityScore[turn.coverage_priority]));
    const bp = Math.min(...b[1].map((turn) => priorityScore[turn.coverage_priority]));
    return ap - bp || b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });

  const selected: CandidateTurn[] = [];
  for (const [signature, rows] of signatures) {
    if (selected.length >= max) break;
    const row = rows[0];
    selected.push({
      ...row,
      selection_reason: `first_example_for_signature:${signature}`,
    });
  }

  for (const [signature, rows] of signatures) {
    if (selected.length >= max) break;
    const desired = Math.min(3, rows.length);
    let already = selected.filter((turn) => turn.behavior_signature === signature).length;
    for (let i = 1; i < rows.length && already < desired && selected.length < max; i++) {
      selected.push({
        ...rows[i],
        selection_reason: `additional_common_signature_example:${signature}`,
      });
      already++;
    }
  }

  return selected.map((turn, index) => ({ ...turn, turn_index: index }));
}

function writeBoardCorpus(args: Args, db: Database.Database, group: RegisteredGroupRow): BoardCorpus {
  const turns = loadTurns(db, group.folder);
  const nextByTurn = nextTurnByChat(turns);
  const allCandidates = turns
    .map((turn, index) => buildCandidate(args, db, turn, nextByTurn.get(turn.id) ?? null, index))
    .filter((turn): turn is CandidateTurn => turn !== null);
  const selected = chooseCandidates(allCandidates, args.maxPerBoard);
  const corpus: BoardCorpus = {
    source: 'prod_messages_db',
    source_db: args.db,
    generated_at: new Date().toISOString(),
    board: group,
    total_turns: allCandidates.length,
    curated_count: selected.length,
    selection: 'semantic_message_candidates',
    note: 'Generated from production messages.db. These turns have semantic/outbound expectations but no v1 tool-use oracle.',
    turns: selected,
  };

  const filename = path.join(args.outDir, `${outputSafeName(group.folder)}.json`);
  fs.writeFileSync(filename, JSON.stringify(corpus, null, 2));
  return corpus;
}

function writeSummary(args: Args, corpora: BoardCorpus[]): void {
  const lines: string[] = [];
  lines.push('Production WhatsApp Phase 3 Candidate Corpus Summary');
  lines.push('');
  lines.push(`Source DB: ${args.db}`);
  lines.push(`State snapshot: ${args.stateSnapshot ?? '<none>'}`);
  lines.push(`Output dir: ${args.outDir}`);
  lines.push(`Boards: ${corpora.length}`);
  lines.push(`Candidate turns: ${corpora.reduce((sum, corpus) => sum + corpus.curated_count, 0)}`);
  lines.push(`Extracted agent turns: ${corpora.reduce((sum, corpus) => sum + corpus.total_turns, 0)}`);
  lines.push('');
  lines.push('Per Board');
  for (const corpus of corpora) {
    const high = corpus.turns.filter((turn) => turn.coverage_priority === 'high').length;
    const medium = corpus.turns.filter((turn) => turn.coverage_priority === 'medium').length;
    const low = corpus.turns.filter((turn) => turn.coverage_priority === 'low').length;
    lines.push(`- ${corpus.board.folder}: ${corpus.curated_count}/${corpus.total_turns} candidates (high=${high}, medium=${medium}, low=${low})`);
  }
  lines.push('');
  lines.push('Use these as paid Phase 3 candidates only after selecting a board and confirming the DB snapshot/state policy.');
  fs.writeFileSync(path.join(args.outDir, 'summary.txt'), `${lines.join('\n')}\n`);

  fs.writeFileSync(path.join(args.outDir, 'summary.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    source_db: args.db,
    state_snapshot: args.stateSnapshot,
    boards: corpora.map((corpus) => ({
      folder: corpus.board.folder,
      jid: corpus.board.jid,
      name: corpus.board.name,
      total_turns: corpus.total_turns,
      curated_count: corpus.curated_count,
      high_priority: corpus.turns.filter((turn) => turn.coverage_priority === 'high').length,
      medium_priority: corpus.turns.filter((turn) => turn.coverage_priority === 'medium').length,
      low_priority: corpus.turns.filter((turn) => turn.coverage_priority === 'low').length,
      file: `${outputSafeName(corpus.board.folder)}.json`,
    })),
  }, null, 2));
}

function main(): void {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.outDir, { recursive: true });
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  try {
    const groups = loadGroups(db, args.folder);
    if (groups.length === 0) throw new Error(args.folder ? `No taskflow group found for ${args.folder}` : 'No taskflow groups found');
    const corpora = groups.map((group) => writeBoardCorpus(args, db, group));
    writeSummary(args, corpora);
    console.log(`Wrote ${corpora.length} board corpora to ${args.outDir}`);
    console.log(`Candidate turns: ${corpora.reduce((sum, corpus) => sum + corpus.curated_count, 0)}`);
    console.log(`Summary: ${path.join(args.outDir, 'summary.txt')}`);
  } finally {
    db.close();
  }
}

main();
