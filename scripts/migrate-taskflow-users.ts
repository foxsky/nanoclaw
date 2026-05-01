/**
 * Phase 2.5 Task 2.5.2: TaskFlow users → v2 permissions seeder.
 *
 * Reads TaskFlow's source-of-truth (`board_people` + `board_admins` from
 * `data/taskflow/taskflow.db`) and seeds the v2 central DB (`data/v2.db`):
 *   - users (id, kind, display_name, created_at)
 *   - user_roles (user_id, role, agent_group_id, granted_by, granted_at)
 *   - agent_group_members (user_id, agent_group_id, added_by, added_at)
 *
 * Mapping rules:
 *   - users.id     = whatsapp:<phone>@s.whatsapp.net (matches the migrator's owner format)
 *   - users.kind   = 'whatsapp' (channel type — convention from migrator's owner row)
 *   - role         = always 'admin' (scoped to agent_group_id). v2's user_roles
 *                    invariant (Codex B3, src/modules/permissions/db/user-roles.ts:9):
 *                    `owner` role MUST be global (agent_group_id IS NULL); any
 *                    INSERT with role='owner' AND agent_group_id != NULL is
 *                    silently ignored by isOwner()/pickApprover(). Board-scoped
 *                    privilege is 'admin' regardless of board_admins.is_primary_manager.
 *   - agent_group  = looked up via boards.group_folder ↔ agent_groups.folder
 *   - granted_by/added_by = the operator user (already seeded by migrate-v2.sh,
 *                    holds the global 'owner' role)
 *
 * Idempotent: every INSERT is OR IGNORE, keyed on the natural primary key.
 *
 * Usage:
 *   bun run scripts/migrate-taskflow-users.ts \
 *     --taskflow-db /path/to/taskflow.db \
 *     --v2-db /path/to/v2.db \
 *     [--dry-run]
 *
 * In dry-run, no INSERTs are issued; the script prints what it would do.
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
      'usage: bun run scripts/migrate-taskflow-users.ts --taskflow-db <path> --v2-db <path> [--dry-run]',
    );
    process.exit(2);
  }
  return { taskflowDb, v2Db, dryRun: argv.includes('--dry-run') };
}

interface BoardRow {
  id: string;
  group_folder: string;
}
interface PersonRow {
  board_id: string;
  person_id: string;
  name: string;
  phone: string | null;
  role: string | null;
}
interface AdminRow {
  board_id: string;
  person_id: string;
  phone: string;
  admin_role: string;
  is_primary_manager: number;
}

const NOW = new Date().toISOString();
const OPERATOR_ID = 'whatsapp:558699916064@s.whatsapp.net';

function userIdFromPhone(phone: string): string | null {
  // Some rows in board_admins/board_people have null/blank phones (e.g. delegates
  // recorded by name only). Refuse to materialize a user for them — a phone-less
  // user is meaningless under the WhatsApp identity model and would corrupt
  // user_roles + agent_group_members FK joins.
  const trimmed = phone?.replace(/\D/g, '') ?? '';
  if (!trimmed) return null;
  return `whatsapp:${trimmed}@s.whatsapp.net`;
}

function adminRoleFor(_row: AdminRow): 'admin' {
  // v2 reserves 'owner' role for global admins (agent_group_id IS NULL).
  // Board-scoped admins map to 'admin' regardless of is_primary_manager.
  // The is_primary_manager bit can be preserved separately in a sidecar
  // table later if we need to distinguish; for the permission gate, scoped
  // 'admin' is the only valid v2 value here.
  return 'admin';
}

interface SeedStats {
  users_inserted: number;
  users_skipped_no_phone: number;
  user_roles_inserted: number;
  user_roles_skipped_no_phone: number;
  agent_group_members_inserted: number;
  agent_group_members_skipped_no_phone: number;
  boards_unmapped: string[];
}

function loadBoardFolderMap(tfDb: Database, v2Db: Database): Map<string, string> {
  // Build board_id → agent_group_id via boards.group_folder ↔ agent_groups.folder
  const boards = tfDb.prepare('SELECT id, group_folder FROM boards').all() as BoardRow[];
  const ags = v2Db
    .prepare('SELECT id, folder FROM agent_groups')
    .all() as Array<{ id: string; folder: string }>;
  const folderToAg = new Map(ags.map((r) => [r.folder, r.id]));
  const map = new Map<string, string>();
  for (const b of boards) {
    const ag = folderToAg.get(b.group_folder);
    if (ag) map.set(b.id, ag);
  }
  return map;
}

function seed(tfDb: Database, v2Db: Database, dryRun: boolean): SeedStats {
  const stats: SeedStats = {
    users_inserted: 0,
    users_skipped_no_phone: 0,
    user_roles_inserted: 0,
    user_roles_skipped_no_phone: 0,
    agent_group_members_inserted: 0,
    agent_group_members_skipped_no_phone: 0,
    boards_unmapped: [],
  };

  const boardToAg = loadBoardFolderMap(tfDb, v2Db);

  const people = tfDb
    .prepare('SELECT board_id, person_id, name, phone, role FROM board_people')
    .all() as PersonRow[];
  const admins = tfDb
    .prepare(
      'SELECT board_id, person_id, phone, admin_role, is_primary_manager FROM board_admins',
    )
    .all() as AdminRow[];

  // ── Step 1: users (distinct by phone, prefer board_admins.phone over board_people.phone)
  const userByPhone = new Map<string, { id: string; display_name: string }>();
  for (const a of admins) {
    const id = userIdFromPhone(a.phone);
    if (!id) continue;
    // person_id from admins is usually the canonical name; use it if no people-row name exists
    userByPhone.set(a.phone, { id, display_name: a.person_id });
  }
  for (const p of people) {
    const id = p.phone ? userIdFromPhone(p.phone) : null;
    if (!id || !p.phone) {
      stats.users_skipped_no_phone += 1;
      continue;
    }
    // people.name is more human-readable than admins.person_id; prefer it
    const existing = userByPhone.get(p.phone);
    userByPhone.set(p.phone, { id, display_name: p.name || existing?.display_name || p.person_id });
  }

  const insertUser = v2Db.prepare(
    'INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const u of userByPhone.values()) {
    if (dryRun) {
      stats.users_inserted += 1;
    } else {
      const r = insertUser.run(u.id, 'whatsapp', u.display_name, NOW);
      if (r.changes > 0) stats.users_inserted += 1;
    }
  }

  // ── Step 2: user_roles (one per board_admins row)
  const insertRole = v2Db.prepare(
    'INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const a of admins) {
    const ag = boardToAg.get(a.board_id);
    if (!ag) {
      if (!stats.boards_unmapped.includes(a.board_id)) stats.boards_unmapped.push(a.board_id);
      continue;
    }
    const userId = userIdFromPhone(a.phone);
    if (!userId) {
      stats.user_roles_skipped_no_phone += 1;
      continue;
    }
    const role = adminRoleFor(a);
    if (dryRun) {
      stats.user_roles_inserted += 1;
    } else {
      const r = insertRole.run(userId, role, ag, OPERATOR_ID, NOW);
      if (r.changes > 0) stats.user_roles_inserted += 1;
    }
  }

  // ── Step 3: agent_group_members (every board_people row + every board_admins row, deduped)
  const memberships = new Set<string>(); // key = `${userId}|${ag}`
  for (const p of people) {
    const userId = p.phone ? userIdFromPhone(p.phone) : null;
    if (!userId) {
      stats.agent_group_members_skipped_no_phone += 1;
      continue;
    }
    const ag = boardToAg.get(p.board_id);
    if (!ag) {
      if (!stats.boards_unmapped.includes(p.board_id)) stats.boards_unmapped.push(p.board_id);
      continue;
    }
    memberships.add(`${userId}|${ag}`);
  }
  for (const a of admins) {
    const userId = userIdFromPhone(a.phone);
    if (!userId) {
      stats.agent_group_members_skipped_no_phone += 1;
      continue;
    }
    const ag = boardToAg.get(a.board_id);
    if (!ag) continue;
    memberships.add(`${userId}|${ag}`);
  }

  const insertMember = v2Db.prepare(
    'INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, ?, ?)',
  );
  for (const m of memberships) {
    const [userId, ag] = m.split('|');
    if (dryRun) {
      stats.agent_group_members_inserted += 1;
    } else {
      const r = insertMember.run(userId, ag, OPERATOR_ID, NOW);
      if (r.changes > 0) stats.agent_group_members_inserted += 1;
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
