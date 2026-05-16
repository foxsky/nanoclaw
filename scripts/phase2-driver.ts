#!/usr/bin/env tsx
/**
 * Phase 2 end-to-end driver.
 *
 * Drives N curated WhatsApp turns through the v2 stack against the
 * pre-seeded ag-phase2-seci board, with fresh-per-turn isolation so each
 * v2 turn starts from the same baseline v1's recorded turn started from
 * (different sampled conversations, no prior synthetic context).
 *
 * Per turn:
 *   1. Drop any existing session row + dir (fresh isolation)
 *   2. resolveSession → creates new session row + per-session DBs
 *   3. writeSessionMessage → inbound.db.messages_in
 *   4. wakeContainer → spawns docker container
 *   5. polls outbound.db.messages_out for stability (no new rows for 10s)
 *   6. docker stop the container
 *   7. reads .tool-uses.jsonl + outbound.db
 *   8. appends to results JSON
 *
 * Requires:
 *   - NANOCLAW_TOOL_USES_PATH set
 *   - File ownership: run as nanoclaw (uid 1000) so the container can write
 *   - OneCLI .env: ONECLI_URL + ONECLI_API_KEY
 *
 * Usage:
 *   sudo -u nanoclaw -H env LOG_LEVEL=info \
 *     NANOCLAW_TOOL_USES_PATH=/workspace/.tool-uses.jsonl \
 *     bash -c '/root/nanoclaw/node_modules/.bin/tsx scripts/phase2-driver.ts \
 *       [--corpus PATH] [--turn N] [--all] [--from N] [--to N] [--resume]'
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { resolveSession, writeSessionMessage, sessionDir, outboundDbPath } from '../src/session-manager.js';
import { wakeContainer } from '../src/container-runner.js';
import { extractConversationTurns, type ConversationTurn } from './whatsapp-replay-extract.js';
import { taskflowDbPath } from '../src/taskflow-mount.js';

const AGENT_GROUP_ID = process.env.NANOCLAW_PHASE_REPLAY_AGENT_GROUP_ID ?? 'ag-phase2-seci';
const MESSAGING_GROUP_ID = process.env.NANOCLAW_PHASE_REPLAY_MESSAGING_GROUP_ID ?? 'mg-phase2-seci';
const GROUP_JID = process.env.NANOCLAW_PHASE_REPLAY_GROUP_JID ?? '120363406395935726@g.us';
const CONTAINER_NAME_FILTER = process.env.NANOCLAW_PHASE_REPLAY_CONTAINER_NAME_FILTER ?? 'nanoclaw-v2-seci-taskflow-';
const CORPUS = '/tmp/whatsapp-curated-seci-v4.json';
const OUT_FILE = '/tmp/phase2-v2-results.json';

const SETTLE_QUIET_MS = 12_000; // outbound stable for this long → agent done
const SETTLE_INITIAL_MS = 20_000; // grace before first stability check (container startup)
const CONTAINER_TIMEOUT_MS = 6 * 60_000; // hard cap per turn
const POLL_INTERVAL_MS = 2_000;

interface ParsedMessage { sender: string; time: string; text: string }
interface CuratedTurn {
  user_message: string;
  parsed_messages: ParsedMessage[];
  tool_uses: { tool_use_id: string; tool_name: string; input: unknown; output: unknown }[];
  turn_index: number;
  jsonl?: string;
  category: string;
  final_response: string | null;
}
interface Corpus { curated_count: number; total_turns: number; turns: CuratedTurn[]; source_db?: string }
interface V2ToolEvent {
  kind: 'tool_use' | 'tool_result';
  id: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  is_error?: boolean;
}
interface TurnResult {
  turn_index: number;
  category: string;
  sender: string;
  text: string;
  session_id: string;
  v1: { tools: { name: string; input: unknown }[]; final_response: string | null };
  v2: {
    tools: { name: string; input: unknown }[];
    results: { id: string; is_error: boolean }[];
    outbound: { kind: string; content: string }[];
    elapsed_ms: number;
    settle_reason: string;
  };
}

interface AgentTurnRow {
  id: string;
  group_folder: string;
  chat_jid: string;
  created_at: string;
}

interface AgentTurnMessageRow {
  sender: string | null;
  sender_name: string | null;
  message_timestamp: string;
  content: string | null;
}

interface Args {
  corpus: string;
  turn?: number;
  all: boolean;
  from?: number;
  to?: number;
  resume: boolean;
  chain?: { targetCorpusIdx: number; depth: number };
  sourceRoot: string;
}

function parseArgs(): Args {
  const a: Args = {
    corpus: CORPUS,
    all: false,
    resume: false,
    sourceRoot: '/tmp/v2-pilot/all-sessions/seci-taskflow',
  };
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    if (k === '--corpus') a.corpus = process.argv[++i];
    else if (k === '--turn') a.turn = Number.parseInt(process.argv[++i], 10);
    else if (k === '--all') a.all = true;
    else if (k === '--from') a.from = Number.parseInt(process.argv[++i], 10);
    else if (k === '--to') a.to = Number.parseInt(process.argv[++i], 10);
    else if (k === '--resume') a.resume = true;
    else if (k === '--source-root') a.sourceRoot = process.argv[++i];
    else if (k === '--chain') {
      // --chain N or --chain N:K
      const raw = process.argv[++i];
      const [tgt, depthStr] = raw.split(':');
      a.chain = {
        targetCorpusIdx: Number.parseInt(tgt, 10),
        depth: depthStr ? Number.parseInt(depthStr, 10) : 1,
      };
    }
    else throw new Error(`Unknown arg: ${k}`);
  }
  return a;
}

function readToolEvents(captureFile: string): V2ToolEvent[] {
  if (!fs.existsSync(captureFile)) return [];
  return fs.readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as V2ToolEvent);
}

function readOutboundMessages(agentGroupId: string, sessionId: string, afterSeq = 0): { kind: string; content: string }[] {
  const dbPath = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT kind, content FROM messages_out WHERE seq > ? ORDER BY seq').all(afterSeq) as { kind: string; content: string }[];
  } finally {
    db.close();
  }
}

function maxOutboundSeq(agentGroupId: string, sessionId: string): number {
  const dbPath = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM messages_out').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Drop the existing session row + dir so the next resolveSession is fresh.
 *  Manual cascade in a transaction for FK refs
 *  (sessions(id) ← pending_questions, pending_approvals). Phase 2 multi_tool
 *  turns leave pending_questions behind when v2 emits an ask-question card;
 *  without cascade the FK fires. The transaction prevents a half-deleted
 *  state if the script is interrupted mid-cascade. */
function resetSession(agentGroupId: string, messagingGroupId: string): void {
  const db = getDb();
  const rows = db.prepare(`SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ?`)
    .all(agentGroupId, messagingGroupId) as { id: string }[];
  const cascade = db.transaction((sessionIds: string[]) => {
    for (const id of sessionIds) {
      db.prepare('DELETE FROM pending_questions WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM pending_approvals WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }
  });
  cascade(rows.map((r) => r.id));
  for (const r of rows) {
    const dir = sessionDir(agentGroupId, r.id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function findRunningContainers(): string[] {
  try {
    const out = execSync(`docker ps --filter "name=${CONTAINER_NAME_FILTER}" --format "{{.Names}}"`, { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function stopContainer(name: string): void {
  try {
    execSync(`docker stop ${name}`, { stdio: 'pipe', timeout: 15_000 });
  } catch (err) {
    console.error(`  docker stop ${name} failed:`, err instanceof Error ? err.message : err);
  }
}

function makeContainerWritable(hostPath: string): void {
  if (!fs.existsSync(hostPath)) return;
  const result = spawnSync('docker', [
    'run',
    '--rm',
    '-v',
    `${hostPath}:/target`,
    'busybox',
    'chown',
    '-R',
    '1000:1000',
    '/target',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`docker chown fallback failed for ${hostPath}: ${result.stderr || result.stdout}`);
  }
}

function prepareReplayContainerWritablePaths(sessionId: string): void {
  makeContainerWritable(sessionDir(AGENT_GROUP_ID, sessionId));
  makeContainerWritable(path.join(DATA_DIR, 'v2-sessions', AGENT_GROUP_ID, '.claude-shared'));
}

function sqliteSidecarPaths(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
}

function copyIfExists(from: string, to: string): boolean {
  if (!fs.existsSync(from)) return false;
  fs.copyFileSync(from, to);
  return true;
}

function removeSQLiteSidecars(dbPath: string): void {
  for (const sidecar of sqliteSidecarPaths(dbPath)) {
    fs.rmSync(sidecar, { force: true });
  }
}

async function waitForSettled(agentGroupId: string, sessionId: string, baselineSeq = 0): Promise<{ settle_reason: string; elapsed_ms: number }> {
  const start = Date.now();
  let lastSeq = baselineSeq;
  let lastChange = start;
  await new Promise((r) => setTimeout(r, SETTLE_INITIAL_MS));
  while (Date.now() - start < CONTAINER_TIMEOUT_MS) {
    const n = maxOutboundSeq(agentGroupId, sessionId);
    if (n !== lastSeq) {
      lastSeq = n;
      lastChange = Date.now();
      console.log(`  [poll] outbound max seq: ${n} (t+${Math.round((Date.now() - start) / 1000)}s)`);
    } else if (n > baselineSeq && Date.now() - lastChange >= SETTLE_QUIET_MS) {
      return { settle_reason: 'outbound_stable', elapsed_ms: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { settle_reason: 'timeout', elapsed_ms: Date.now() - start };
}

/** Drive one prompt through the v2 stack without resetting the session +
 *  without capturing/scoring. Used for "context-building" turns ahead of
 *  the target in --chain mode. Returns when the agent settles. */
async function driveContextTurn(
  session: { id: string },
  text: string,
  sender: string,
  userMessage: string,
  tag: string,
): Promise<void> {
  const captureFile = path.join(sessionDir(AGENT_GROUP_ID, session.id), '.tool-uses.jsonl');
  const messageId = `phase2-ctx-${tag}-${Date.now()}`;
  const content = JSON.stringify({
    sender,
    text,
    phase2RawPrompt: userMessage,
    ...(process.env.NANOCLAW_PHASE_REPLAY_TASKFLOW_BOARD_ID
      ? { phase3TaskflowBoardId: process.env.NANOCLAW_PHASE_REPLAY_TASKFLOW_BOARD_ID }
      : {}),
  });
  writeSessionMessage(AGENT_GROUP_ID, session.id, {
    id: messageId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: GROUP_JID,
    channelType: 'whatsapp',
    threadId: null,
    content,
    trigger: 1,
  });
  prepareReplayContainerWritablePaths(session.id);

  const outboundBaselineSeq = maxOutboundSeq(AGENT_GROUP_ID, session.id);
  const captureBytesBefore = fs.existsSync(captureFile) ? fs.statSync(captureFile).size : 0;
  const woke = await wakeContainer(session as never);
  if (!woke) throw new Error(`wakeContainer returned false for context turn ${tag}`);

  const settled = await waitForSettled(AGENT_GROUP_ID, session.id, outboundBaselineSeq);
  console.log(`    [ctx ${tag}] settled: ${settled.settle_reason} (${Math.round(settled.elapsed_ms / 1000)}s)`);

  const running = findRunningContainers();
  if (running.length > 0) {
    for (const name of running) stopContainer(name);
    await new Promise((r) => setTimeout(r, 2_000));
  }

  // Audit: how much capture got appended (so the chain summary shows context cost)
  const captureBytesAfter = fs.existsSync(captureFile) ? fs.statSync(captureFile).size : 0;
  console.log(`    [ctx ${tag}] context tool-events: ~${captureBytesAfter - captureBytesBefore}B`);
}

/** Snapshot taskflow.db to a temp file so chain context-turns can mutate it
 *  freely; restored after the target turn captures. Returns the snapshot
 *  path; pass to restoreTaskflowDb. */
function snapshotTaskflowDb(): string {
  const src = taskflowDbPath(DATA_DIR);
  const dst = `${src}.phase2-chain-${process.pid}-${Date.now()}`;
  fs.copyFileSync(src, dst);
  for (const sidecar of sqliteSidecarPaths(src)) {
    copyIfExists(sidecar, `${dst}${sidecar.slice(src.length)}`);
  }
  return dst;
}

function restoreTaskflowDb(snapshot: string): void {
  const src = taskflowDbPath(DATA_DIR);
  removeSQLiteSidecars(src);
  fs.copyFileSync(snapshot, src);
  for (const sidecar of sqliteSidecarPaths(src)) {
    const suffix = sidecar.slice(src.length);
    const sidecarSnapshot = `${snapshot}${suffix}`;
    if (fs.existsSync(sidecarSnapshot)) {
      fs.copyFileSync(sidecarSnapshot, sidecar);
      fs.rmSync(sidecarSnapshot, { force: true });
    } else {
      fs.rmSync(sidecar, { force: true });
    }
  }
  fs.rmSync(snapshot, { force: true });
}

function restoreTargetTaskflowDbIfRequested(): void {
  const targetSnapshot = process.env.NANOCLAW_PHASE3_TARGET_STATE_SNAPSHOT;
  if (!targetSnapshot) return;
  if (!fs.existsSync(targetSnapshot)) {
    throw new Error(`NANOCLAW_PHASE3_TARGET_STATE_SNAPSHOT does not exist: ${targetSnapshot}`);
  }
  const livePath = taskflowDbPath(DATA_DIR);
  removeSQLiteSidecars(livePath);
  fs.copyFileSync(targetSnapshot, livePath);
  removeSQLiteSidecars(livePath);
  console.log(`  target taskflow.db restored from ${targetSnapshot}`);
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

function sourceTurnIdFromMessagesDbRef(ref: string | undefined): string | null {
  const match = ref?.match(/^messages\.db#agent_turns\/(.+)$/);
  return match?.[1] ?? null;
}

function resolveMessagesDbPath(corpus: Corpus, corpusPath: string, sourceRoot: string): string {
  const candidates = [
    corpus.source_db,
    path.join(path.dirname(corpusPath), '..', 'messages.db'),
    path.join(path.dirname(corpusPath), 'messages.db'),
    path.join(sourceRoot, 'messages.db'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  throw new Error(`Could not resolve messages.db for generated corpus ${corpusPath}`);
}

function loadMessagesDbConversationTurn(db: Database.Database, turnId: string): ConversationTurn {
  const rows = db.prepare(`
    SELECT
      atm.sender,
      atm.sender_name,
      atm.message_timestamp,
      m.content
    FROM agent_turn_messages atm
    LEFT JOIN messages m
      ON m.id = atm.message_id
     AND m.chat_jid = atm.message_chat_jid
    WHERE atm.turn_id = ?
    ORDER BY atm.ordinal
  `).all(turnId) as AgentTurnMessageRow[];
  const messages = rows
    .filter((row) => typeof row.content === 'string' && row.content.trim())
    .map((row) => ({
      sender: row.sender_name || row.sender || 'context',
      time: row.message_timestamp,
      text: row.content!.trim(),
    }));
  return {
    user_message: messageEnvelope(messages),
    user_timestamp: messages[0]?.time ?? '',
    parsed_messages: messages,
    tool_uses: [],
    outbound_messages: [],
    outbound_text: null,
    final_response: null,
  };
}

function resolveMessagesDbChain(
  corpus: Corpus,
  corpusPath: string,
  targetCorpusIdx: number,
  depth: number,
  sourceRoot: string,
): { prior: ConversationTurn[]; target: ConversationTurn; corpusTurn: CuratedTurn } {
  const corpusTurn = corpus.turns[targetCorpusIdx];
  if (!corpusTurn) throw new Error(`Corpus has no turn at index ${targetCorpusIdx}`);
  const targetTurnId = sourceTurnIdFromMessagesDbRef(corpusTurn.jsonl);
  if (!targetTurnId) throw new Error(`Corpus turn ${targetCorpusIdx} is not a messages.db source: ${corpusTurn.jsonl}`);
  const dbPath = resolveMessagesDbPath(corpus, corpusPath, sourceRoot);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const targetRow = db.prepare(`
      SELECT id, group_folder, chat_jid, created_at
      FROM agent_turns
      WHERE id = ?
    `).get(targetTurnId) as AgentTurnRow | undefined;
    if (!targetRow) throw new Error(`messages.db has no agent_turns row for ${targetTurnId}`);
    const priorRows = db.prepare(`
      SELECT id, group_folder, chat_jid, created_at
      FROM agent_turns
      WHERE group_folder = ?
        AND chat_jid = ?
        AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(
      targetRow.group_folder,
      targetRow.chat_jid,
      targetRow.created_at,
      targetRow.created_at,
      targetRow.id,
      depth,
    ) as AgentTurnRow[];
    const prior = priorRows
      .reverse()
      .map((row) => loadMessagesDbConversationTurn(db, row.id));
    const target = loadMessagesDbConversationTurn(db, targetRow.id);
    return { prior, target, corpusTurn };
  } finally {
    db.close();
  }
}

/** Resolve a chain of prior turns from the source JSONL up to the target.
 *  Returns the prior turns (oldest first) and the target turn from the
 *  re-extracted source list, plus the matching corpus entry (for v1 scoring). */
function resolveChain(
  corpus: Corpus,
  corpusPath: string,
  targetCorpusIdx: number,
  depth: number,
  sourceRoot: string,
): { prior: ConversationTurn[]; target: ConversationTurn; corpusTurn: CuratedTurn } {
  const corpusTurn = corpus.turns[targetCorpusIdx];
  if (!corpusTurn) throw new Error(`Corpus has no turn at index ${targetCorpusIdx}`);
  if (!corpusTurn.jsonl) throw new Error(`Corpus turn ${targetCorpusIdx} has no jsonl field`);
  if (sourceTurnIdFromMessagesDbRef(corpusTurn.jsonl)) {
    return resolveMessagesDbChain(corpus, corpusPath, targetCorpusIdx, depth, sourceRoot);
  }
  const absJsonl = path.join(sourceRoot, corpusTurn.jsonl);
  if (!fs.existsSync(absJsonl)) throw new Error(`Source JSONL not found: ${absJsonl}`);
  const sourceTurns = extractConversationTurns(fs.readFileSync(absJsonl, 'utf8'));
  const target = sourceTurns[corpusTurn.turn_index];
  if (!target) throw new Error(`Target turn index ${corpusTurn.turn_index} not present in ${absJsonl}`);
  const start = Math.max(0, corpusTurn.turn_index - depth);
  const prior = sourceTurns.slice(start, corpusTurn.turn_index);
  return { prior, target, corpusTurn };
}

async function processChain(corpus: Corpus, corpusPath: string, targetCorpusIdx: number, depth: number, sourceRoot: string): Promise<TurnResult> {
  const { prior, target, corpusTurn } = resolveChain(corpus, corpusPath, targetCorpusIdx, depth, sourceRoot);
  const targetParsed = corpusTurn.parsed_messages[0];
  console.log(`\n=== Chain to corpus turn ${targetCorpusIdx} (${corpusTurn.category}) ===`);
  console.log(`  source: ${corpusTurn.jsonl}#${corpusTurn.turn_index}`);
  console.log(`  chain depth: ${prior.length} prior turn(s) before target`);
  console.log(`  target sender: ${targetParsed.sender}`);
  console.log(`  target text:   ${targetParsed.text.slice(0, 100)}`);
  console.log(`  v1 tool sequence (target): [${corpusTurn.tool_uses.map((t) => t.tool_name).join(', ')}]`);

  // Snapshot taskflow.db so context-turn mutations don't bleed into the
  // pristine DB between chain runs.
  const snapshot = snapshotTaskflowDb();
  resetSession(AGENT_GROUP_ID, MESSAGING_GROUP_ID);
  const { session } = resolveSession(AGENT_GROUP_ID, MESSAGING_GROUP_ID, null, 'shared');
  console.log(`  session: ${session.id} (fresh; will be reused for all chain turns)`);

  try {
    for (let i = 0; i < prior.length; i++) {
      const p = prior[i];
      const psm = p.parsed_messages[0];
      const psender = psm?.sender ?? 'context';
      const ptext = psm?.text ?? '<no parsed_messages — using raw user_message>';
      console.log(`  --- context turn ${i + 1}/${prior.length}: ${psender}: "${ptext.slice(0, 80)}"`);
      await driveContextTurn(session, ptext, psender, p.user_message, `${targetCorpusIdx}-pre${i}`);
    }

    restoreTargetTaskflowDbIfRequested();

    // Now drive the target turn, capturing tool_use + outbound just for it.
    const captureFile = path.join(sessionDir(AGENT_GROUP_ID, session.id), '.tool-uses.jsonl');
    const captureBytesBefore = fs.existsSync(captureFile) ? fs.statSync(captureFile).size : 0;
    const messageId = `phase2-tgt-${targetCorpusIdx}-${Date.now()}`;
    const content = JSON.stringify({
      sender: targetParsed.sender,
      text: targetParsed.text,
      phase2RawPrompt: corpusTurn.user_message,
      ...(process.env.NANOCLAW_PHASE_REPLAY_TASKFLOW_BOARD_ID
        ? { phase3TaskflowBoardId: process.env.NANOCLAW_PHASE_REPLAY_TASKFLOW_BOARD_ID }
        : {}),
    });
    writeSessionMessage(AGENT_GROUP_ID, session.id, {
      id: messageId,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: GROUP_JID,
      channelType: 'whatsapp',
      threadId: null,
      content,
      trigger: 1,
    });
    prepareReplayContainerWritablePaths(session.id);

    const outboundBaselineSeq = maxOutboundSeq(AGENT_GROUP_ID, session.id);
    const woke = await wakeContainer(session);
    if (!woke) throw new Error(`wakeContainer returned false for target turn ${targetCorpusIdx}`);
    const settled = await waitForSettled(AGENT_GROUP_ID, session.id, outboundBaselineSeq);
    console.log(`  [target] settled: ${settled.settle_reason} (${Math.round(settled.elapsed_ms / 1000)}s)`);
    const running = findRunningContainers();
    if (running.length > 0) {
      console.log(`  stopping containers: ${running.join(', ')}`);
      for (const name of running) stopContainer(name);
      await new Promise((r) => setTimeout(r, 3_000));
    }

    // Read ONLY the target-turn events (everything appended after the
    // context-turn snapshot point).
    let allEvents = readToolEvents(captureFile);
    if (captureBytesBefore > 0) {
      // Drop the first N events that fit in the byte prefix from context turns.
      // Simpler: read raw bytes after offset. Use Buffer slicing because
      // captureBytesBefore is a byte count, not a JavaScript string index.
      const rawAfter = fs.readFileSync(captureFile).subarray(captureBytesBefore).toString('utf8');
      allEvents = rawAfter.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as V2ToolEvent);
    }
    const outbound = readOutboundMessages(AGENT_GROUP_ID, session.id, outboundBaselineSeq);

    const result: TurnResult = {
      turn_index: targetCorpusIdx,
      category: corpusTurn.category,
      sender: targetParsed.sender,
      text: targetParsed.text,
      session_id: session.id,
      v1: {
        tools: corpusTurn.tool_uses.map((t) => ({ name: t.tool_name, input: t.input })),
        final_response: corpusTurn.final_response,
      },
      v2: {
        tools: allEvents.filter((e) => e.kind === 'tool_use').map((e) => ({ name: e.name as string, input: e.input })),
        results: allEvents.filter((e) => e.kind === 'tool_result').map((e) => ({ id: e.id, is_error: e.is_error === true })),
        outbound,
        elapsed_ms: settled.elapsed_ms,
        settle_reason: settled.settle_reason,
      },
    };
    console.log(`  [target] v2 tool sequence: [${result.v2.tools.map((t) => t.name).join(', ')}]`);
    console.log(`  [target] v2 outbound: ${outbound.length} rows`);
    return result;
  } finally {
    restoreTaskflowDb(snapshot);
    console.log(`  taskflow.db restored from snapshot`);
  }
}

async function processTurn(turn: CuratedTurn, idx: number): Promise<TurnResult> {
  const parsed = turn.parsed_messages[0];
  console.log(`\n=== Turn ${idx} (${turn.category}) ===`);
  console.log(`  sender: ${parsed.sender}`);
  console.log(`  text:   ${parsed.text.slice(0, 100)}${parsed.text.length > 100 ? '…' : ''}`);
  console.log(`  v1 tool sequence: [${turn.tool_uses.map((t) => t.tool_name).join(', ')}]`);

  resetSession(AGENT_GROUP_ID, MESSAGING_GROUP_ID);
  const { session } = resolveSession(AGENT_GROUP_ID, MESSAGING_GROUP_ID, null, 'shared');
  console.log(`  session: ${session.id} (fresh)`);

  const captureFile = path.join(sessionDir(AGENT_GROUP_ID, session.id), '.tool-uses.jsonl');
  fs.rmSync(captureFile, { force: true });
  const messageId = `phase2-msg-${idx}-${Date.now()}`;
  const content = JSON.stringify({
    sender: parsed.sender,
    text: parsed.text,
    phase2RawPrompt: turn.user_message,
    ...(process.env.NANOCLAW_PHASE_REPLAY_TASKFLOW_BOARD_ID
      ? { phase3TaskflowBoardId: process.env.NANOCLAW_PHASE_REPLAY_TASKFLOW_BOARD_ID }
      : {}),
  });
  writeSessionMessage(AGENT_GROUP_ID, session.id, {
    id: messageId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: GROUP_JID,
    channelType: 'whatsapp',
    threadId: null,
    content,
    trigger: 1,
  });
  prepareReplayContainerWritablePaths(session.id);

  const outboundBaselineSeq = maxOutboundSeq(AGENT_GROUP_ID, session.id);
  const woke = await wakeContainer(session);
  if (!woke) throw new Error(`wakeContainer returned false for turn ${idx}`);

  const settled = await waitForSettled(AGENT_GROUP_ID, session.id, outboundBaselineSeq);
  console.log(`  settled: ${settled.settle_reason} (${Math.round(settled.elapsed_ms / 1000)}s)`);

  const running = findRunningContainers();
  if (running.length > 0) {
    console.log(`  stopping containers: ${running.join(', ')}`);
    for (const name of running) stopContainer(name);
    await new Promise((r) => setTimeout(r, 3_000));
  }

  const events = readToolEvents(captureFile);
  const outbound = readOutboundMessages(AGENT_GROUP_ID, session.id, outboundBaselineSeq);

  const result: TurnResult = {
    turn_index: idx,
    category: turn.category,
    sender: parsed.sender,
    text: parsed.text,
    session_id: session.id,
    v1: {
      tools: turn.tool_uses.map((t) => ({ name: t.tool_name, input: t.input })),
      final_response: turn.final_response,
    },
    v2: {
      tools: events.filter((e) => e.kind === 'tool_use').map((e) => ({ name: e.name as string, input: e.input })),
      results: events.filter((e) => e.kind === 'tool_result').map((e) => ({ id: e.id, is_error: e.is_error === true })),
      outbound,
      elapsed_ms: settled.elapsed_ms,
      settle_reason: settled.settle_reason,
    },
  };
  console.log(`  v2 tool sequence: [${result.v2.tools.map((t) => t.name).join(', ')}]`);
  console.log(`  v2 outbound: ${outbound.length} rows`);
  return result;
}

function loadExistingResults(): TurnResult[] {
  if (!fs.existsSync(OUT_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function saveResults(results: TurnResult[]): void {
  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
}

async function main(): Promise<void> {
  if (!process.env.NANOCLAW_TOOL_USES_PATH) {
    console.error('NANOCLAW_TOOL_USES_PATH must be set');
    process.exit(2);
  }
  process.env.NANOCLAW_PHASE2_RAW_PROMPT = '1';
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const args = parseArgs();
  const corpus = JSON.parse(fs.readFileSync(args.corpus, 'utf8')) as Corpus;

  // --chain mode: drive K prior turns from the same source JSONL into the
  // session (no reset between), then drive + capture the target turn. Lets
  // v2 build genuine in-session context the way v1 had it. taskflow.db is
  // snapshotted before and restored after so context mutations don't pollute
  // future runs.
  if (args.chain) {
    const result = await processChain(corpus, args.corpus, args.chain.targetCorpusIdx, args.chain.depth, args.sourceRoot);
    const results = args.resume ? loadExistingResults() : [];
    results.push(result);
    saveResults(results);
    console.log(`\nDone. Chain target ${args.chain.targetCorpusIdx} recorded → ${OUT_FILE}`);
    return;
  }

  let indices: number[];
  if (args.all) {
    indices = corpus.turns.map((_, i) => i);
  } else if (args.from !== undefined || args.to !== undefined) {
    const from = args.from ?? 0;
    const to = args.to ?? corpus.turns.length - 1;
    indices = [];
    for (let i = from; i <= to; i++) indices.push(i);
  } else if (args.turn !== undefined) {
    indices = [args.turn];
  } else {
    console.error('Must pass --turn N, --all, --from/--to range, or --chain N[:K]');
    process.exit(2);
  }

  let results = args.resume ? loadExistingResults() : [];
  const done = new Set(results.map((r) => r.turn_index));
  const todo = indices.filter((i) => !done.has(i));
  console.log(`Plan: ${todo.length} turn(s) (${indices.length} requested, ${done.size} already in results)`);

  for (const i of todo) {
    const turn = corpus.turns[i];
    if (!turn) {
      console.error(`No corpus turn at index ${i} — skipping`);
      continue;
    }
    try {
      const r = await processTurn(turn, i);
      results.push(r);
      saveResults(results);
      console.log(`  saved (${results.length} total)`);
    } catch (err) {
      console.error(`Turn ${i} failed:`, err instanceof Error ? err.message : err);
      // Save what we have; continue
      saveResults(results);
    }
  }

  console.log(`\nDone. ${results.length} turns recorded → ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('Driver fatal:', err);
  process.exit(1);
});
