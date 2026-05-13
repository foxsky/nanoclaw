#!/usr/bin/env tsx
/**
 * Phase 3 corpus auditor — finds v1 bot-error candidates in `task_history`
 * and cross-references against the curated WhatsApp-replay corpus so the
 * Phase 3 metadata can annotate them with `v1_bug` blocks.
 *
 * Extends the original date-field self-correction detector
 * (`Reunião reagendada` / `Prazo definido` pairs within 60 min) to also
 * cover:
 *
 *   - reassign round-trip (A→B then B→A on same task within 60 min,
 *     suggests the bot picked the wrong assignee and the user corrected)
 *   - conclude→reopen on same task within 60 min (bot moved too far)
 *
 * Output: a JSON list of findings + a human-readable summary. Each finding
 * carries the corpus turn index it lands on (if any) so an operator can
 * patch `scripts/phase3-seci-metadata.json` in one pass.
 *
 * Usage:
 *   pnpm exec tsx scripts/audit-v1-bugs.ts \
 *     --db /tmp/v2-pilot/taskflow.db \
 *     --board board-seci-taskflow \
 *     --corpus /tmp/whatsapp-curated-seci-v4.json \
 *     --out /tmp/audit-v1-bugs-seci.json
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';

interface Args {
  db: string;
  /** Single board id, or `all` to sweep every board with task_history rows. */
  board: string;
  /** Optional curated corpus path. Omit (or `--corpus -`) to skip the
   *  corpus cross-reference; useful for org-wide health audits where the
   *  corpus only covers one board. */
  corpus: string | null;
  out: string;
  windowMin: number;
  cancelGraceSec: number;
}

interface Finding {
  pattern: 'date_field_correction' | 'reassign_round_trip' | 'conclude_reopen';
  board_id: string;
  task_id: string;
  by: string;
  a_at: string;
  b_at: string;
  dt_min: number;
  a_details: string;
  b_details: string;
  /** Corpus turn whose user_timestamp falls within ±60s of a_at, or null. */
  corpus_turn_index: number | null;
  corpus_user_timestamp?: string;
}

function parseArgs(): Args {
  const a: Args = {
    db: '/tmp/v2-pilot/taskflow.db',
    board: 'board-seci-taskflow',
    corpus: '/tmp/whatsapp-curated-seci-v4.json',
    out: '/tmp/audit-v1-bugs-seci.json',
    windowMin: 60,
    cancelGraceSec: 60,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    if (k === '--db') a.db = process.argv[++i];
    else if (k === '--board') a.board = process.argv[++i];
    else if (k === '--corpus') {
      const v = process.argv[++i];
      a.corpus = v === '-' ? null : v;
    }
    else if (k === '--out') a.out = process.argv[++i];
    else if (k === '--window-min') a.windowMin = Number(process.argv[++i]);
    else throw new Error(`Unknown arg: ${k}`);
  }
  return a;
}

function resolveBoards(db: Database.Database, board: string): string[] {
  if (board !== 'all') return [board];
  const rows = db.prepare(
    `SELECT DISTINCT board_id FROM task_history ORDER BY board_id`,
  ).all() as Array<{ board_id: string }>;
  return rows.map((r) => r.board_id);
}

/** Wall-clock ms between two ISO timestamps. */
function diffMs(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime());
}

/** Find the curated corpus turn whose user_timestamp is within `graceMs`
 *  of `at`. The Phase 1 extractor records `user_timestamp` per turn, so a
 *  finding whose first-half mutation timestamp matches a turn's prompt is
 *  the turn that produced the v1 bug. */
function locateCorpusTurn(
  turns: Array<{ user_timestamp?: string }>,
  at: string,
  graceMs: number,
): { idx: number; ts: string } | null {
  for (let i = 0; i < turns.length; i++) {
    const ts = turns[i]?.user_timestamp;
    if (!ts) continue;
    if (diffMs(ts, at) <= graceMs) return { idx: i, ts };
  }
  return null;
}

function findDateFieldCorrections(
  db: Database.Database,
  board: string,
  windowMin: number,
): Array<Omit<Finding, 'pattern' | 'corpus_turn_index' | 'corpus_user_timestamp'>> {
  const sql = `
    SELECT a.task_id, a.by, a.at AS a_at, b.at AS b_at,
           round((julianday(b.at) - julianday(a.at)) * 1440, 1) AS dt_min,
           a.details AS a_details, b.details AS b_details
      FROM task_history a JOIN task_history b
        ON a.board_id = b.board_id AND a.task_id = b.task_id
       AND a.by = b.by AND a.id < b.id
       AND a.details <> b.details
       AND (julianday(b.at) - julianday(a.at)) * 1440 BETWEEN 0 AND ?
     WHERE a.board_id = ? AND a.action='updated' AND b.action='updated'
       AND (
         (a.details LIKE '%Reuni%reagendada%' AND b.details LIKE '%Reuni%reagendada%')
         OR (a.details LIKE '%Prazo definido%' AND b.details LIKE '%Prazo definido%')
       )
     ORDER BY a.at`;
  return db.prepare(sql).all(windowMin, board) as Array<Omit<Finding, 'pattern' | 'corpus_turn_index' | 'corpus_user_timestamp'>>;
}

function findReassignRoundTrips(
  db: Database.Database,
  board: string,
  windowMin: number,
): Array<Omit<Finding, 'pattern' | 'corpus_turn_index' | 'corpus_user_timestamp'>> {
  // Round-trip = A→B then B→A on same task / same user within window.
  // Bot picked the wrong assignee; user reverted.
  const sql = `
    SELECT a.task_id, a.by, a.at AS a_at, b.at AS b_at,
           round((julianday(b.at) - julianday(a.at)) * 1440, 1) AS dt_min,
           a.details AS a_details, b.details AS b_details
      FROM task_history a JOIN task_history b
        ON a.board_id = b.board_id AND a.task_id = b.task_id
       AND a.by = b.by AND a.id < b.id
       AND (julianday(b.at) - julianday(a.at)) * 1440 BETWEEN 0 AND ?
     WHERE a.board_id = ? AND a.action='reassigned' AND b.action='reassigned'
       AND json_extract(a.details, '$.from_assignee') = json_extract(b.details, '$.to_assignee')
       AND json_extract(a.details, '$.to_assignee')   = json_extract(b.details, '$.from_assignee')
     ORDER BY a.at`;
  return db.prepare(sql).all(windowMin, board) as Array<Omit<Finding, 'pattern' | 'corpus_turn_index' | 'corpus_user_timestamp'>>;
}

function findConcludeReopen(
  db: Database.Database,
  board: string,
  windowMin: number,
): Array<Omit<Finding, 'pattern' | 'corpus_turn_index' | 'corpus_user_timestamp'>> {
  // Conclude → reopen same task within window: bot concluded too early.
  // Production filter: only flag pairs by the SAME user (otherwise the
  // legitimate reviewer-approval flow shows up as noise).
  const sql = `
    SELECT a.task_id, a.by, a.at AS a_at, b.at AS b_at,
           round((julianday(b.at) - julianday(a.at)) * 1440, 1) AS dt_min,
           a.details AS a_details, b.details AS b_details
      FROM task_history a JOIN task_history b
        ON a.board_id = b.board_id AND a.task_id = b.task_id
       AND a.by = b.by AND a.id < b.id
       AND (julianday(b.at) - julianday(a.at)) * 1440 BETWEEN 0 AND ?
     WHERE a.board_id = ? AND a.action='conclude' AND b.action='reopen'
     ORDER BY a.at`;
  return db.prepare(sql).all(windowMin, board) as Array<Omit<Finding, 'pattern' | 'corpus_turn_index' | 'corpus_user_timestamp'>>;
}

function main(): void {
  const args = parseArgs();
  const db = new Database(args.db, { readonly: true });
  const turns: Array<{ user_timestamp?: string }> = args.corpus
    ? ((JSON.parse(fs.readFileSync(args.corpus, 'utf8')) as { turns?: unknown[] }).turns
        ?? (JSON.parse(fs.readFileSync(args.corpus, 'utf8')) as unknown[])) as Array<{ user_timestamp?: string }>
    : [];

  const boards = resolveBoards(db, args.board);
  const findings: Finding[] = [];
  const perBoard: Record<string, number> = {};

  for (const boardId of boards) {
    const rows = [
      ...findDateFieldCorrections(db, boardId, args.windowMin)
        .map((r) => ({ pattern: 'date_field_correction' as const, ...r })),
      ...findReassignRoundTrips(db, boardId, args.windowMin)
        .map((r) => ({ pattern: 'reassign_round_trip' as const, ...r })),
      ...findConcludeReopen(db, boardId, args.windowMin)
        .map((r) => ({ pattern: 'conclude_reopen' as const, ...r })),
    ];
    perBoard[boardId] = rows.length;
    for (const r of rows) {
      const hit = args.corpus
        ? locateCorpusTurn(turns, r.a_at, args.cancelGraceSec * 1000)
        : null;
      findings.push({
        ...r,
        board_id: boardId,
        corpus_turn_index: hit?.idx ?? null,
        corpus_user_timestamp: hit?.ts,
      });
    }
  }

  db.close();

  fs.writeFileSync(args.out, JSON.stringify({
    boards: boards.length === 1 ? boards[0] : boards,
    per_board_counts: perBoard,
    findings,
  }, null, 2));
  console.log(`Wrote ${findings.length} candidate v1-bug finding(s) across ${boards.length} board(s) → ${args.out}`);
  console.log();
  if (boards.length > 1) {
    console.log('Per-board counts:');
    for (const [b, n] of Object.entries(perBoard).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${b}: ${n}`);
    }
    console.log();
  }
  for (const f of findings) {
    const corpus = f.corpus_turn_index !== null
      ? `corpus turn ${f.corpus_turn_index}`
      : (args.corpus ? 'NOT in corpus' : 'no corpus');
    console.log(`- [${f.pattern}] ${f.board_id} ${f.task_id} / ${f.by} / ${f.a_at} → ${f.b_at} (${f.dt_min}min, ${corpus})`);
    console.log(`    before: ${f.a_details.slice(0, 110)}`);
    console.log(`    after:  ${f.b_details.slice(0, 110)}`);
  }
}

main();
