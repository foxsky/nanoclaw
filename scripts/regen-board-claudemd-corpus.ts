#!/usr/bin/env tsx
/**
 * A5: walk a directory of v1 per-board CLAUDE.md files and emit v2
 * versions via migrate-board-claudemd substitution. Reports per-board
 * substitution counts + a summary table for spot-checking.
 *
 * Usage:
 *   pnpm exec tsx scripts/regen-board-claudemd-corpus.ts \
 *     --in  /tmp/v2-pilot/board-claudemd \
 *     --out /tmp/v2-pilot/board-claudemd-v2 \
 *     [--report /tmp/regen-report.json]
 *
 * The board_id is derived as `board-<folder_name>` to match v1 prod
 * convention (taskflow.db: boards.id = 'board-' + boards.group_folder).
 */

import fs from 'node:fs';
import path from 'node:path';
import { migrateBoardClaudeMd } from './migrate-board-claudemd.js';

interface Args {
  in: string;
  out: string;
  report?: string;
  /** Pre-substitution board_id remaps for prod rename history. Applied
   *  before migrateBoardClaudeMd, so SQL/prose references that hardcode
   *  an old board_id get rewritten to the current one. Required when v1
   *  source files predate a boards-table rename (e.g., the 'sec-taskflow'
   *  → 'sec-secti' rename surfaced by Codex on 2026-05-11). */
  aliases: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  const aliases: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k.startsWith('--')) throw new Error(`Unexpected arg: ${k}`);
    const name = k.slice(2);
    const val = argv[i + 1] ?? '';
    if (name === 'alias') {
      const eq = val.indexOf('=');
      if (eq < 1) throw new Error(`--alias requires OLD=NEW, got ${val}`);
      aliases[val.slice(0, eq)] = val.slice(eq + 1);
    } else {
      args[name] = val;
    }
  }
  if (!args.in || !args.out) {
    console.error('Usage: --in <dir> --out <dir> [--report <file.json>] [--alias OLD=NEW]...');
    process.exit(2);
  }
  return { in: args.in, out: args.out, report: args.report, aliases };
}

/** Escape a literal string for safe use inside a global RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface PerBoard {
  folder: string;
  board_id: string;
  v1_lines: number;
  v2_lines: number;
  v1_bytes: number;
  v2_bytes: number;
  substituted: number;
  unmigrated: Record<string, number>;
  error?: string;
}

function main() {
  const args = parseArgs(process.argv);
  if (!fs.statSync(args.in).isDirectory()) {
    console.error(`--in must be a directory: ${args.in}`);
    process.exit(1);
  }
  fs.mkdirSync(args.out, { recursive: true });

  const folders = fs.readdirSync(args.in).filter((name) => {
    const p = path.join(args.in, name);
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'CLAUDE.md'));
  });
  console.log(`Found ${folders.length} board CLAUDE.md files under ${args.in}`);

  const reports: PerBoard[] = [];
  for (const folder of folders) {
    const v1Path = path.join(args.in, folder, 'CLAUDE.md');
    const boardId = `board-${folder}`;
    let raw: string;
    try {
      raw = fs.readFileSync(v1Path, 'utf8');
    } catch (e) {
      reports.push({
        folder, board_id: boardId, v1_lines: 0, v2_lines: 0,
        v1_bytes: 0, v2_bytes: 0, substituted: 0, unmigrated: {},
        error: `read failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    for (const [oldId, newId] of Object.entries(args.aliases)) {
      raw = raw.replace(new RegExp(escapeRegex(oldId), 'g'), newId);
    }
    const result = migrateBoardClaudeMd(raw, { boardId });
    const outDir = path.join(args.out, folder);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'CLAUDE.md'), result.output);
    reports.push({
      folder,
      board_id: boardId,
      v1_lines: raw.split('\n').length,
      v2_lines: result.output.split('\n').length,
      v1_bytes: raw.length,
      v2_bytes: result.output.length,
      substituted: result.substituted,
      unmigrated: result.unmigrated as unknown as Record<string, number>,
    });
  }

  // Summary table — sorted by substitution count desc.
  console.log('\n=== Per-board regen summary ===');
  console.log('substituted | bytes Δ  | folder');
  console.log('------------|----------|-------');
  const sorted = [...reports].sort((a, b) => b.substituted - a.substituted);
  for (const r of sorted) {
    if (r.error) {
      console.log(`        ERR | ${r.error.slice(0, 40).padEnd(8)} | ${r.folder}`);
      continue;
    }
    const byteDelta = r.v2_bytes - r.v1_bytes;
    const sign = byteDelta >= 0 ? '+' : '';
    console.log(`${String(r.substituted).padStart(11)} | ${(sign + byteDelta).padStart(8)} | ${r.folder}`);
  }

  // Aggregate
  const totalSub = reports.reduce((s, r) => s + r.substituted, 0);
  const errCount = reports.filter((r) => r.error).length;
  const zeroSubBoards = reports.filter((r) => !r.error && r.substituted === 0).map((r) => r.folder);
  console.log(`\nTotal boards: ${reports.length}, total substitutions: ${totalSub}, errors: ${errCount}`);
  if (zeroSubBoards.length > 0) {
    console.log(`Zero-substitution boards (suspect — review): ${zeroSubBoards.join(', ')}`);
  }

  if (args.report) {
    fs.writeFileSync(args.report, JSON.stringify({
      input_dir: args.in,
      output_dir: args.out,
      boards: reports,
      totals: { boards: reports.length, substitutions: totalSub, errors: errCount },
    }, null, 2));
    console.log(`\nReport: ${args.report}`);
  }
  console.log(`\nv2 files written under ${args.out}`);
}

main();
