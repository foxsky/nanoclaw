/**
 * Phase 2.5 Task 2.5.3: TaskFlow board hierarchy → v2 agent_destinations seeder.
 *
 * Reads TaskFlow's `boards.parent_board_id` and seeds `agent_destinations` so
 * each child board's agent has a `local_name='parent'` route to its parent
 * board's agent group. This is the outbound ACL underpinning cross-board
 * mutation forwarding (cross-board a2a in Phase 6 spec stub).
 *
 * v2 agent_destinations schema (single target_id, polymorphic by target_type):
 *   agent_group_id | local_name | target_type | target_id      | created_at
 *   ---------------+------------+-------------+----------------+---------------
 *   ag_<child>     | parent     | agent       | ag_<parent>    | <iso>
 *
 * Idempotent: PRIMARY KEY (agent_group_id, local_name) lets us OR IGNORE.
 *
 * Usage:
 *   bun run scripts/migrate-taskflow-destinations.ts \
 *     --taskflow-db /path/to/taskflow.db \
 *     --v2-db /path/to/v2.db \
 *     [--dry-run]
 */
import { Database } from 'bun:sqlite';

interface Args {
  taskflowDb: string;
  v2Db: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const taskflowDb = get('--taskflow-db');
  const v2Db = get('--v2-db');
  if (!taskflowDb || !v2Db) {
    console.error(
      'usage: bun run scripts/migrate-taskflow-destinations.ts --taskflow-db <path> --v2-db <path> [--dry-run]',
    );
    process.exit(2);
  }
  return { taskflowDb, v2Db, dryRun: argv.includes('--dry-run') };
}

interface BoardRow {
  id: string;
  group_folder: string;
  parent_board_id: string | null;
}

const NOW = new Date().toISOString();

interface SeedStats {
  parents_seeded: number;
  children_unmapped_to_v2: string[]; // child boards with no v2 agent_group
  parents_unmapped_to_v2: string[]; // parents with no v2 agent_group
  root_boards_skipped: number; // no parent → no destination row
}

function seed(tfDb: Database, v2Db: Database, dryRun: boolean): SeedStats {
  const stats: SeedStats = {
    parents_seeded: 0,
    children_unmapped_to_v2: [],
    parents_unmapped_to_v2: [],
    root_boards_skipped: 0,
  };

  // boards.group_folder ↔ agent_groups.folder (same mapping as users seeder)
  const boards = tfDb
    .prepare('SELECT id, group_folder, parent_board_id FROM boards')
    .all() as BoardRow[];
  const ags = v2Db
    .prepare('SELECT id, folder FROM agent_groups')
    .all() as Array<{ id: string; folder: string }>;
  const folderToAg = new Map(ags.map((r) => [r.folder, r.id]));
  const boardToFolder = new Map(boards.map((b) => [b.id, b.group_folder]));

  const insert = v2Db.prepare(
    'INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
  );

  for (const child of boards) {
    if (!child.parent_board_id) {
      stats.root_boards_skipped += 1;
      continue;
    }
    const childAg = folderToAg.get(child.group_folder);
    if (!childAg) {
      // Child board exists in TaskFlow DB but not in v2 (e.g. not in
      // registered_groups). Skip — destinations only apply to v2-managed
      // agent groups.
      if (!stats.children_unmapped_to_v2.includes(child.id)) {
        stats.children_unmapped_to_v2.push(child.id);
      }
      continue;
    }
    const parentFolder = boardToFolder.get(child.parent_board_id);
    const parentAg = parentFolder ? folderToAg.get(parentFolder) : undefined;
    if (!parentAg) {
      if (!stats.parents_unmapped_to_v2.includes(child.parent_board_id)) {
        stats.parents_unmapped_to_v2.push(child.parent_board_id);
      }
      continue;
    }

    if (dryRun) {
      stats.parents_seeded += 1;
    } else {
      const r = insert.run(childAg, 'parent', 'agent', parentAg, NOW);
      if (r.changes > 0) stats.parents_seeded += 1;
    }
  }

  return stats;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const tfDb = new Database(args.taskflowDb, { readonly: true });
  const v2Db = new Database(args.v2Db);
  v2Db.exec('PRAGMA busy_timeout = 5000');

  const inTxn = !args.dryRun;
  if (inTxn) v2Db.exec('BEGIN');
  let stats: SeedStats;
  try {
    stats = seed(tfDb, v2Db, args.dryRun);
    if (inTxn) v2Db.exec('COMMIT');
  } catch (err) {
    if (inTxn) v2Db.exec('ROLLBACK');
    throw err;
  } finally {
    tfDb.close();
    v2Db.close();
  }

  console.log(JSON.stringify({ dryRun: args.dryRun, ...stats }, null, 2));
}

main();
