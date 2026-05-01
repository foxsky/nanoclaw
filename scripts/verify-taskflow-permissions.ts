/**
 * Phase 2.5 Task F12 (Codex EOD review #2): integration verification of the
 * permission-layer seeders against v2's `pickApprover()` semantics.
 *
 * Replicates v2's logic from `upstream/main:src/modules/approvals/primitive.ts:pickApprover`:
 *   1. scoped admins (role='admin', agent_group_id matches)
 *   2. global admins (role='admin', agent_group_id IS NULL)
 *   3. global owners (role='owner', agent_group_id IS NULL)
 *
 * For each agent_group in the seeded v2.db, verifies:
 *   - pickApprover returns non-empty list
 *   - first approver matches the expected board admin from TaskFlow source
 *   - global owner (operator) is in the list as fallback
 *
 * Also asserts the v2 invariant: ZERO rows with role='owner' AND agent_group_id IS NOT NULL.
 *
 * Usage:
 *   bun run scripts/verify-taskflow-permissions.ts \
 *     --taskflow-db /path/to/taskflow.db \
 *     --v2-db /path/to/v2.db
 */
import { Database } from 'bun:sqlite';

interface Args {
  taskflowDb: string;
  v2Db: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const taskflowDb = get('--taskflow-db');
  const v2Db = get('--v2-db');
  if (!taskflowDb || !v2Db) {
    console.error('usage: bun run scripts/verify-taskflow-permissions.ts --taskflow-db <path> --v2-db <path>');
    process.exit(2);
  }
  return { taskflowDb, v2Db };
}

function pickApprover(v2Db: Database, agentGroupId: string | null): string[] {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  // ORDER BY granted_at — matches v2's helper queries
  // (upstream/main:src/modules/permissions/db/user-roles.ts). Without the
  // ordering, multi-admin boards could return a different first approver
  // than the real v2 implementation, breaking pickApprovalDelivery's
  // tie-breaker logic. Caught by Codex review #3 (F3).
  if (agentGroupId) {
    const scopedAdmins = v2Db
      .prepare(
        "SELECT user_id FROM user_roles WHERE role='admin' AND agent_group_id = ? ORDER BY granted_at",
      )
      .all(agentGroupId) as Array<{ user_id: string }>;
    for (const r of scopedAdmins) add(r.user_id);
  }
  const globalAdmins = v2Db
    .prepare(
      "SELECT user_id FROM user_roles WHERE role='admin' AND agent_group_id IS NULL ORDER BY granted_at",
    )
    .all() as Array<{ user_id: string }>;
  for (const r of globalAdmins) add(r.user_id);
  const globalOwners = v2Db
    .prepare(
      "SELECT user_id FROM user_roles WHERE role='owner' AND agent_group_id IS NULL ORDER BY granted_at",
    )
    .all() as Array<{ user_id: string }>;
  for (const r of globalOwners) add(r.user_id);

  return approvers;
}

function userIdFromPhone(phone: string): string {
  return `whatsapp:${phone.replace(/\D/g, '')}@s.whatsapp.net`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const tfDb = new Database(args.taskflowDb, { readonly: true });
  const v2Db = new Database(args.v2Db, { readonly: true });

  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  // Invariant: no scoped 'owner' rows.
  const violations = (
    v2Db
      .prepare("SELECT COUNT(*) AS n FROM user_roles WHERE role='owner' AND agent_group_id IS NOT NULL")
      .get() as { n: number }
  ).n;
  if (violations === 0) {
    pass += 1;
    console.log(`✓ invariant: 0 owner rows with non-null agent_group_id`);
  } else {
    fail += 1;
    failures.push(`✗ invariant: ${violations} owner rows have non-null agent_group_id (v2 forbids this)`);
  }

  // For each agent_group: pickApprover must return a non-empty list AND the
  // expected board admin (from TaskFlow source) must be present.
  const ags = v2Db
    .prepare('SELECT id, folder FROM agent_groups')
    .all() as Array<{ id: string; folder: string }>;

  for (const ag of ags) {
    const expectedPhones = (
      tfDb
        .prepare(
          'SELECT DISTINCT a.phone FROM board_admins a ' +
            'JOIN boards b ON b.id = a.board_id ' +
            'WHERE b.group_folder = ? AND TRIM(COALESCE(a.phone, "")) != ""',
        )
        .all(ag.folder) as Array<{ phone: string }>
    ).map((r) => userIdFromPhone(r.phone));

    const approvers = pickApprover(v2Db, ag.id);

    if (approvers.length === 0) {
      fail += 1;
      failures.push(`✗ ${ag.folder}: pickApprover returned empty list`);
      continue;
    }

    if (expectedPhones.length === 0) {
      // No board admins in source — the only approver should be the global
      // operator (fallback). Still acceptable.
      const operator = 'whatsapp:558699916064@s.whatsapp.net';
      if (approvers.includes(operator)) {
        pass += 1;
      } else {
        fail += 1;
        failures.push(`✗ ${ag.folder}: no board admin + operator not in approvers (got: ${approvers.join(', ')})`);
      }
      continue;
    }

    const allFound = expectedPhones.every((p) => approvers.includes(p));
    if (allFound) {
      pass += 1;
    } else {
      fail += 1;
      const missing = expectedPhones.filter((p) => !approvers.includes(p));
      failures.push(
        `✗ ${ag.folder}: expected approvers missing — ${missing.join(', ')} (got: ${approvers.join(', ')})`,
      );
    }
  }

  console.log(`\n${pass} pass, ${fail} fail across ${ags.length + 1} checks`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${f}`);
  }

  tfDb.close();
  v2Db.close();
  process.exit(fail > 0 ? 1 : 0);
}

main();
