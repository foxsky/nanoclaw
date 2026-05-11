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
 *       [--turn N] [--all] [--from N] [--to N] [--resume]'
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

const AGENT_GROUP_ID = 'ag-phase2-seci';
const MESSAGING_GROUP_ID = 'mg-phase2-seci';
const GROUP_JID = '120363406395935726@g.us';
const CORPUS = '/tmp/whatsapp-curated-seci-v4.json';
const OUT_FILE = '/tmp/phase2-v2-results.json';

const SETTLE_QUIET_MS = 12_000; // outbound stable for this long → agent done
const SETTLE_INITIAL_MS = 20_000; // grace before first stability check (container startup)
const CONTAINER_TIMEOUT_MS = 6 * 60_000; // hard cap per turn
const POLL_INTERVAL_MS = 2_000;

interface ParsedMessage { sender: string; time: string; text: string }
interface CuratedTurn {
  parsed_messages: ParsedMessage[];
  tool_uses: { tool_use_id: string; tool_name: string; input: unknown; output: unknown }[];
  turn_index: number;
  category: string;
  final_response: string | null;
}
interface Corpus { curated_count: number; total_turns: number; turns: CuratedTurn[] }
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

interface Args { turn?: number; all: boolean; from?: number; to?: number; resume: boolean }

function parseArgs(): Args {
  const a: Args = { all: false, resume: false };
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    if (k === '--turn') a.turn = Number.parseInt(process.argv[++i], 10);
    else if (k === '--all') a.all = true;
    else if (k === '--from') a.from = Number.parseInt(process.argv[++i], 10);
    else if (k === '--to') a.to = Number.parseInt(process.argv[++i], 10);
    else if (k === '--resume') a.resume = true;
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

function readOutboundMessages(agentGroupId: string, sessionId: string): { kind: string; content: string }[] {
  const dbPath = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT kind, content FROM messages_out ORDER BY seq').all() as { kind: string; content: string }[];
  } finally {
    db.close();
  }
}

function countOutbound(agentGroupId: string, sessionId: string): number {
  const dbPath = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Drop the existing session row + dir so the next resolveSession is fresh.
 *  Manual cascade for FK refs (sessions(id) ← pending_questions, pending_approvals).
 *  Phase 2 multi_tool turns left pending_questions behind when v2 emitted an
 *  ask-question card mid-flow; without this cascade the FK constraint fires. */
function resetSession(agentGroupId: string, messagingGroupId: string): void {
  const db = getDb();
  const rows = db.prepare(`SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ?`)
    .all(agentGroupId, messagingGroupId) as { id: string }[];
  for (const r of rows) {
    db.prepare('DELETE FROM pending_questions WHERE session_id = ?').run(r.id);
    db.prepare('DELETE FROM pending_approvals WHERE session_id = ?').run(r.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(r.id);
    const dir = sessionDir(agentGroupId, r.id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function findRunningContainer(): string | null {
  try {
    const out = execSync(`docker ps --filter "name=nanoclaw-v2-seci-taskflow-" --format "{{.Names}}"`, { encoding: 'utf8' });
    const name = out.trim().split('\n').filter(Boolean)[0];
    return name || null;
  } catch {
    return null;
  }
}

function stopContainer(name: string): void {
  try {
    execSync(`docker stop ${name}`, { stdio: 'pipe', timeout: 15_000 });
  } catch (err) {
    console.error(`  docker stop ${name} failed:`, err instanceof Error ? err.message : err);
  }
}

async function waitForSettled(agentGroupId: string, sessionId: string): Promise<{ settle_reason: string; elapsed_ms: number }> {
  const start = Date.now();
  let lastCount = 0;
  let lastChange = start;
  await new Promise((r) => setTimeout(r, SETTLE_INITIAL_MS));
  while (Date.now() - start < CONTAINER_TIMEOUT_MS) {
    const n = countOutbound(agentGroupId, sessionId);
    if (n !== lastCount) {
      lastCount = n;
      lastChange = Date.now();
      console.log(`  [poll] outbound rows: ${n} (t+${Math.round((Date.now() - start) / 1000)}s)`);
    } else if (n > 0 && Date.now() - lastChange >= SETTLE_QUIET_MS) {
      return { settle_reason: 'outbound_stable', elapsed_ms: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { settle_reason: 'timeout', elapsed_ms: Date.now() - start };
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
  const messageId = `phase2-msg-${idx}-${Date.now()}`;
  const content = JSON.stringify({ sender: parsed.sender, text: parsed.text });
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

  const woke = await wakeContainer(session);
  if (!woke) throw new Error(`wakeContainer returned false for turn ${idx}`);

  const settled = await waitForSettled(AGENT_GROUP_ID, session.id);
  console.log(`  settled: ${settled.settle_reason} (${Math.round(settled.elapsed_ms / 1000)}s)`);

  const running = findRunningContainer();
  if (running) {
    console.log(`  stopping container: ${running}`);
    stopContainer(running);
    await new Promise((r) => setTimeout(r, 3_000));
  }

  const events = readToolEvents(captureFile);
  const outbound = readOutboundMessages(AGENT_GROUP_ID, session.id);

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
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const args = parseArgs();
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8')) as Corpus;

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
    console.error('Must pass --turn N, --all, or --from/--to range');
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
