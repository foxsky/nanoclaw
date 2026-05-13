#!/usr/bin/env tsx
/**
 * Daily v1-bug auditor wrapper. Runs the deterministic detector
 * (`scripts/audit-v1-bugs.ts`) org-wide and writes
 *
 *   data/audit/v1-bugs-YYYY-MM-DD.json   (raw findings)
 *   data/audit/v1-bugs-YYYY-MM-DD.md     (human-readable summary)
 *
 * Idempotent: same calendar day overwrites the same pair of files. The
 * intent is to feed a systemd timer (see `scripts/systemd/`) so the host
 * surfaces v1-mistake signal without touching agent containers.
 *
 * The wrapper only inspects production task_history; it never writes back
 * to the DB. Safe to run while the nanoclaw service is up — both processes
 * use better-sqlite3 with WAL journaling on the taskflow.db; the wrapper
 * opens read-only.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface RunArgs {
  db: string;
  outDir: string;
  tz: string;
  /** Override "today" for tests / backfill runs (YYYY-MM-DD). */
  date?: string;
}

interface AuditRow {
  pattern: 'date_field_correction' | 'reassign_round_trip' | 'conclude_reopen';
  board_id: string;
  task_id: string;
  by: string;
  a_at: string;
  b_at: string;
  dt_min: number;
  a_details: string;
  b_details: string;
}

interface AuditResult {
  boards: string[] | string;
  per_board_counts: Record<string, number>;
  findings: AuditRow[];
}

function parseArgs(): RunArgs {
  const a: RunArgs = {
    db: process.env.NANOCLAW_TASKFLOW_DB ?? '/root/nanoclaw/data/taskflow/taskflow.db',
    outDir: process.env.NANOCLAW_AUDIT_OUT_DIR ?? '/root/nanoclaw/data/audit',
    tz: 'America/Fortaleza',
  };
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    if (k === '--db') a.db = process.argv[++i];
    else if (k === '--out-dir') a.outDir = process.argv[++i];
    else if (k === '--date') a.date = process.argv[++i];
    else if (k === '--tz') a.tz = process.argv[++i];
    else throw new Error(`Unknown arg: ${k}`);
  }
  return a;
}

/** Local date in YYYY-MM-DD for the configured timezone. Exported for
 *  tests so the date math is verifiable without mocking the clock. */
export function localDateKey(now: Date, tz: string): string {
  // toLocaleDateString with en-CA gives ISO-shaped YYYY-MM-DD.
  return now.toLocaleDateString('en-CA', { timeZone: tz });
}

export function formatReport(result: AuditResult, date: string): string {
  const total = result.findings.length;
  const lines: string[] = [];
  lines.push(`# v1-bug audit — ${date}`);
  lines.push('');
  lines.push(`Detector: \`scripts/audit-v1-bugs.ts\` (same-task / same-user / <60min pairs).`);
  lines.push(`Findings: **${total}** across ${Object.keys(result.per_board_counts).length} board(s).`);
  lines.push('');
  if (total === 0) {
    lines.push('No v1 self-correction pairs detected on any board. Clean day.');
    return lines.join('\n');
  }
  lines.push('## Per-board counts');
  lines.push('');
  const nonzero = Object.entries(result.per_board_counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [board, n] of nonzero) lines.push(`- ${board}: ${n}`);
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  // Group by board so a reviewer can read one board's signal at a time.
  const byBoard = new Map<string, AuditRow[]>();
  for (const f of result.findings) {
    const arr = byBoard.get(f.board_id) ?? [];
    arr.push(f);
    byBoard.set(f.board_id, arr);
  }
  for (const [board, rows] of [...byBoard.entries()].sort()) {
    lines.push(`### ${board}`);
    lines.push('');
    for (const r of rows) {
      lines.push(`- **${r.pattern}** \`${r.task_id}\` / \`${r.by}\` (Δ ${r.dt_min} min)`);
      lines.push(`  - ${r.a_at} → ${r.b_at}`);
      lines.push(`  - before: \`${r.a_details.slice(0, 140).replace(/`/g, "'")}\``);
      lines.push(`  - after:  \`${r.b_details.slice(0, 140).replace(/`/g, "'")}\``);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function runAuditor(db: string, jsonOut: string): AuditResult {
  // Shell out to keep the underlying detector authoritative; if it grows
  // a new pattern, the daily report picks it up automatically.
  const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const script = path.join(process.cwd(), 'scripts', 'audit-v1-bugs.ts');
  const r = spawnSync(tsxBin, [
    script,
    '--db', db,
    '--board', 'all',
    '--corpus', '-',
    '--out', jsonOut,
  ], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`audit-v1-bugs.ts exited with status ${r.status}`);
  }
  return JSON.parse(fs.readFileSync(jsonOut, 'utf8')) as AuditResult;
}

function main(): void {
  const args = parseArgs();
  const date = args.date ?? localDateKey(new Date(), args.tz);
  fs.mkdirSync(args.outDir, { recursive: true });
  const jsonPath = path.join(args.outDir, `v1-bugs-${date}.json`);
  const mdPath = path.join(args.outDir, `v1-bugs-${date}.md`);

  const result = runAuditor(args.db, jsonPath);
  fs.writeFileSync(mdPath, formatReport(result, date));

  // One-line summary on stdout so systemd's StandardOutput=journal +
  // service log scrape pick up the count without parsing the JSON.
  const boards = Object.entries(result.per_board_counts).filter(([, n]) => n > 0).length;
  console.log(`[audit-v1-bugs] ${date}: ${result.findings.length} finding(s) across ${boards} board(s); report=${mdPath}`);
}

// ESM-safe entrypoint guard. The test imports `localDateKey` and
// `formatReport` directly; only run `main()` when invoked as a script.
const invokedDirectly = (() => {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return entry === fileURLToPath(import.meta.url);
})();
if (invokedDirectly) main();
