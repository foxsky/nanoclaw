# v2 Migration System

Researched against `remotes/upstream/v2` on 2026-05-03. All citations
reference v2 paths; v1 fork paths are absolute under `/root/nanoclaw/`.

## How migrations work in v2

### File shape and naming

Each migration is a TypeScript module under `src/db/migrations/` that
exports a single `Migration` object literal. The shared interface is
declared in the barrel:

```ts
// src/db/migrations/index.ts:14-18
export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}
```

A migration receives a `better-sqlite3` `Database.Database` handle and
runs synchronous SQL inside it. The barrel wraps each migration's `up()`
in a `db.transaction(...)` so the `up()` body itself just calls `db.exec`
and `db.prepare` directly (no transaction boilerplate inside the
migration). See `src/db/migrations/001-initial.ts:1-110` and
`src/db/migrations/012-channel-registration.ts:18-45` for canonical
examples.

Two filename conventions live in the same directory:

1. **Numbered core migrations**: `NNN-kebab-name.ts` exporting
   `migrationNNN: Migration`. Examples:
   `001-initial.ts`, `002-chat-sdk-state.ts`, `008-dropped-messages.ts`,
   `009-drop-pending-credentials.ts`, `010-engage-modes.ts`,
   `011-pending-sender-approvals.ts`,
   `012-channel-registration.ts`. The leading number is **applied-order
   on the host's main timeline**, not a strict sequence — note 001/002
   then a jump to 008 (003-007 were collapsed into the three `module-*`
   files described below).

2. **Module / skill-installable migrations**: `module-<area>-<thing>.ts`
   exporting a camelCase identifier. Examples:
   `module-agent-to-agent-destinations.ts` (`moduleAgentToAgentDestinations`),
   `module-approvals-pending-approvals.ts` (`moduleApprovalsPendingApprovals`),
   `module-approvals-title-options.ts` (`moduleApprovalsTitleOptions`).
   The leading `module-` filename prefix signals "this migration belongs
   to a module that may be installed by a skill" — the runtime treatment
   is identical to numbered migrations.

The two `module-*` files at versions 3, 4 and 7 carry an explicit
docstring explaining that the *filename* uses `module-` prefix but the
**`name` field is preserved verbatim** from the original migration that
existed under a different filename. Idempotency is keyed on `name`, not
filename, so renaming a file is safe; renaming the `name` field would
re-apply the migration. See `src/db/migrations/module-approvals-pending-approvals.ts:14-17`
("Retains the original `name` ('pending-approvals') so existing DBs that
already recorded this migration under that name don't re-run it.").

### Migration body conventions

- Pure `db.exec` for fresh table creation
  (`src/db/migrations/001-initial.ts:9-110`).
- Idempotent column add via `PRAGMA table_info` guard before
  `ALTER TABLE ADD COLUMN`
  (`src/db/migrations/012-channel-registration.ts:30-34`).
- `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` is
  acceptable when the migration may have been partially applied
  (`src/db/migrations/008-dropped-messages.ts:5-22`,
  `src/db/migrations/011-pending-sender-approvals.ts:25-37`).
- Per-column try/catch that swallows "duplicate column" errors only —
  re-throws everything else
  (`src/db/migrations/module-approvals-title-options.ts:21-37`). This
  pattern is used when an earlier migration was edited *after* deploy.
- Backfill from existing data: `db.prepare(...).all()` to read,
  `db.prepare(...).run(...)` per row to write
  (`src/db/migrations/010-engage-modes.ts:73-95`,
  `src/db/migrations/module-agent-to-agent-destinations.ts:39-77`).

### Barrel registration

The `migrations` array in
`src/db/migrations/index.ts:20-31` is the single source of truth. Order
in this array is application order — not the `version` field, not
filename collation:

```ts
// src/db/migrations/index.ts:20-31
const migrations: Migration[] = [
  migration001,
  migration002,
  moduleApprovalsPendingApprovals,
  moduleAgentToAgentDestinations,
  moduleApprovalsTitleOptions,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
];
```

To register a new migration: add the `import { migrationXYZ } from './XYZ.ts'`
near the other imports, and append `migrationXYZ` to the array.

### Runner orchestration

`runMigrations(db: Database.Database): void`
(`src/db/migrations/index.ts:34-67`) is the only public entrypoint. It:

1. Creates the tracker table if missing
   (`src/db/migrations/index.ts:35-41`):
   ```sql
   CREATE TABLE IF NOT EXISTS schema_version (
     version INTEGER PRIMARY KEY,
     name    TEXT NOT NULL,
     applied TEXT NOT NULL
   );
   CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
   ```
2. Reads applied names into a `Set<string>`
   (`src/db/migrations/index.ts:50-52`).
3. Filters `migrations` to those whose `name` is not yet applied
   (`src/db/migrations/index.ts:53`). Already-applied migrations are
   skipped with no-op cost.
4. For each pending migration, opens a transaction; runs `m.up(db)`;
   inserts into `schema_version` with an auto-assigned applied-order
   integer (`COALESCE(MAX(version), 0) + 1`) and the current ISO
   timestamp (`src/db/migrations/index.ts:57-66`).

The auto-assigned `version` column is **applied-order, not the
`Migration.version` field**. The header comment makes this explicit
(`src/db/migrations/index.ts:43-49`):

> "Uniqueness is keyed on `name`, not `version`. This lets module
> migrations (added later by install skills) pick arbitrary version
> numbers without coordinating across modules. `version` stays on the
> Migration object as an ordering hint within the barrel array; the
> stored `version` column is auto-assigned at insert time as an
> applied-order number."

### Callers

Two production callers and several test callers:

- `src/index.ts:64` — host bootstrap: `runMigrations(db)` immediately
  after `initDb(path.join(DATA_DIR, 'v2.db'))` at startup
  (`src/index.ts:62-65`).
- `src/db/db-v2.test.ts:42` — `it('should be idempotent')` invokes
  `runMigrations(db)` twice in a row and asserts no throw. The runner is
  designed for re-entry on every host restart.
- Test fixtures in `src/channels/channel-registry.test.ts:128`,
  `src/delivery.test.ts:69`, `src/host-core.test.ts:56`, and the
  `modules/permissions/*` and `modules/approvals/*` tests all use
  `initTestDb(); runMigrations(db);` as standard `beforeEach` setup.

### Database scope

Migrations operate on **the central app DB only** —
`data/v2.db` (`src/index.ts:62`, `src/config.ts:23` `DATA_DIR`).
Per-session DBs are a separate system: `src/db/session-db.ts:14-19`
exposes `ensureSchema(dbPath, 'inbound' | 'outbound')` which `db.exec`'s
the static `INBOUND_SCHEMA` / `OUTBOUND_SCHEMA` constants from
`src/db/schema.ts:160-258` directly. Per-session DBs are short-lived,
cross-mount with the container, and their schema never changes after
install — they have no tracker table, no migration runner, no
versioning. See header at `src/db/session-db.ts:1-7`.

### Rollback / down migrations

There are no `down()` methods. The `Migration` interface
(`src/db/migrations/index.ts:14-18`) defines only `version`, `name`,
`up`. Schema retraction is done by **forward migrations that drop**
(e.g. `src/db/migrations/009-drop-pending-credentials.ts:5-9` simply
drops the table the previous deploy created). v2 chose forward-only
migration as a deliberate simplification — this is consistent with the
fact that the central DB is recreated cheaply from messaging-channel
state on disaster.

### Tracker table schema

```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,   -- auto-assigned applied-order
  name    TEXT NOT NULL,         -- the dedup key
  applied TEXT NOT NULL          -- ISO8601 timestamp
);
CREATE UNIQUE INDEX idx_schema_version_name ON schema_version(name);
```
(`src/db/migrations/index.ts:35-41`)

The unique index on `name` is what makes module migrations from
different skills coexist without coordinating version numbers.

### The unrelated `scripts/run-migrations.ts`

There is also a script at `scripts/run-migrations.ts` in v2, but it is
not the central-DB runner described above. It is the **migrate-nanoclaw
skill's** customization-replay engine — it discovers
`migrations/<semver>/index.ts` directories from a downloaded core
upgrade and runs them sequentially via `tsx`
(`scripts/run-migrations.ts:50-65`). Different concern entirely
(version-to-version upgrade-replay tooling), do not conflate. This file
was likely cited by Codex but is not relevant to "how do I add a DB
table on a feature branch."

## v1 fork's current pattern

For contrast: v1 has **no migration runner and no tracker table**.
`/root/nanoclaw/src/db.ts` declares one big `createSchema(database)`
function (offset ~150-300) which calls `database.exec(...)` with all
`CREATE TABLE IF NOT EXISTS` statements concatenated, then a long
sequence of `try { ALTER TABLE ... } catch { /* column exists */ }`
blocks for every schema evolution since v1.0
(`/root/nanoclaw/src/db.ts:300-422`). Each ALTER attempt is wrapped in
its own try/catch swallowing both "duplicate column" and any other
error — effectively unscoped error suppression.

`createSchema()` is called from `initDatabase()` at
`/root/nanoclaw/src/db.ts:424-429` once per process. This works because
sqlite's `IF NOT EXISTS` and SQL's idempotent ALTER-with-catch make the
whole operation safe to re-run, but it has no record of *what was
applied when*, no way to backfill data conditionally on whether you're
on a fresh DB or upgrading, and no test-time isolation. There is no
`data/migrations/{NNN}.sql` directory in this v1 fork — that pattern
the plan named is incorrect for both v1 *and* v2.

The TaskFlow engine schema lives in a separate code path:
`/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:1185-1280`
calls `db.exec(...)` with a multi-statement string at engine init time,
adding `board_holidays`, `board_id_counters`, `external_contacts`,
`meeting_external_participants`, `subtask_requests`. This runs **inside
the container against a per-board taskflow.db**, not the central DB.

## TaskFlow migration plan on `skill/taskflow-v2` branch

### What v2 expects

A v2 TaskFlow skill that needs to add fork-private tables to the
**central** DB has two registration choices, both adding files under
`src/db/migrations/` and a one-line edit to `src/db/migrations/index.ts`:

1. **Single `module-taskflow-*.ts` per concern**, each picking a
   `version` number that doesn't collide with the latest core
   migration (currently 12). For 8-9 tables that share a tight blast
   radius, **one migration is fine** — `module-taskflow-bootstrap.ts`
   exporting `moduleTaskflowBootstrap` with `version: 100`,
   `name: 'taskflow-bootstrap'`, and a single `up()` that creates all
   the tables in one `db.exec` call.

2. **Multiple module files** if you anticipate later additions and want
   each evolution to land as a separate, individually-revertable
   migration. Recommended for TaskFlow given its history of
   schema-churn: split by responsibility (`module-taskflow-boards.ts`,
   `module-taskflow-people.ts`, `module-taskflow-history.ts`,
   `module-taskflow-meetings.ts`, `module-taskflow-attachments.ts`).

### Concrete recommended layout

For the 8-9 fork-private central tables on `skill/taskflow-v2`:

```
src/db/migrations/
├── module-taskflow-001-bootstrap.ts        # board_runtime_config, board_holidays, taskflow_group_settings
├── module-taskflow-002-people.ts           # board_admins-extension, board_people, external_contacts
├── module-taskflow-003-history.ts          # task_history, archive, send_message_log, attachment_audit_log
├── module-taskflow-004-subtasks.ts         # subtask_requests
└── module-taskflow-005-meetings.ts         # meeting_external_participants
```

Each file follows `src/db/migrations/module-approvals-pending-approvals.ts`'s
shape exactly:

```ts
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const moduleTaskflowBootstrap: Migration = {
  version: 100,                  // arbitrary, not used for ordering
  name: 'taskflow-bootstrap',    // STABLE — never edit after merging
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE board_runtime_config ( ... );
      CREATE TABLE board_holidays ( ... );
      CREATE TABLE taskflow_group_settings ( ... );
    `);
  },
};
```

`src/db/migrations/index.ts` gets one block of imports and one block of
array entries appended — these are the only edits to upstream files:

```ts
// src/db/migrations/index.ts (after the existing 12 imports)
import { moduleTaskflowBootstrap } from './module-taskflow-001-bootstrap.js';
import { moduleTaskflowPeople }    from './module-taskflow-002-people.js';
import { moduleTaskflowHistory }   from './module-taskflow-003-history.js';
import { moduleTaskflowSubtasks }  from './module-taskflow-004-subtasks.js';
import { moduleTaskflowMeetings }  from './module-taskflow-005-meetings.js';

const migrations: Migration[] = [
  // ... existing 10 entries unchanged ...
  moduleTaskflowBootstrap,
  moduleTaskflowPeople,
  moduleTaskflowHistory,
  moduleTaskflowSubtasks,
  moduleTaskflowMeetings,
];
```

### Why this minimizes upstream merge-forward pain

- The five module files are 100% additive — upstream never touches
  them. Merge conflicts on these files are impossible.
- The barrel `index.ts` has exactly two append-only edit zones (imports
  block, array tail). Conflicts here are 3-way mergeable mechanically.
  Even if upstream adds a 013 migration, our `module-taskflow-*` lines
  stay below it untouched.
- **Each `name` is fork-namespaced** (`taskflow-*` prefix). Upstream
  cannot accidentally collide. The unique index on
  `schema_version(name)` (see `src/db/migrations/index.ts:39`) makes
  collision a runtime error, not a silent skip.

### What would break upstream merge-forward

- **Editing `name` after a deploy**: changes the dedup key, makes the
  runner re-apply the migration on next restart — likely failing on
  duplicate-table error (`src/db/migrations/module-approvals-title-options.ts:1-15`
  is precisely the cleanup migration that exists because someone did
  this).
- **Numbering as `013-taskflow-*.ts`**: looks like a core migration.
  Upstream's next migration will also want 013 and you'll have a
  filename collision plus an ambiguous-history audit trail. Use the
  `module-` prefix exactly as the existing three skill-installed
  migrations do.
- **Inserting in the middle of the `migrations` array**: changes
  applied-order for fresh installs vs. existing prod, can break
  data-dependent backfills. Append-only.
- **Modifying `up()` body after merge**: any post-deploy edit to a
  migration that's already been applied is invisible to the runner
  (dedup keys on `name`). The pattern for "I forgot a column" is to add
  a *new* migration with a new `name`
  (`src/db/migrations/module-approvals-title-options.ts:7-15`).

### Per-session vs central DB decision

The 8-9 tables in question (`board_runtime_config`, `board_holidays`,
`board_people`, `task_history`, `archive`, `subtask_requests`,
`taskflow_group_settings`, `external_contacts`,
`meeting_external_participants`, `send_message_log`,
`attachment_audit_log`) are **per-board operational state** — they
should NOT live in the central `data/v2.db`. The central DB in v2 holds
host orchestration state only (agent groups, sessions, channels, users,
permissions). Look at
`src/db/migrations/001-initial.ts:9-110` to see the design intent: 9
tables, all about *who's allowed to talk to which agent group*.

The TaskFlow tables match the per-session/per-board pattern that
`src/db/schema.ts:160-258` (`INBOUND_SCHEMA`, `OUTBOUND_SCHEMA`)
already uses. **Recommendation:** add a third static schema constant in
`src/db/schema.ts` (e.g. `TASKFLOW_BOARD_SCHEMA`) and apply it via an
analog of `ensureSchema()` against the per-board DB at engine init —
same model as `src/db/session-db.ts:14-19`. Central-DB migrations are
the wrong tool for per-board tables.

The migrations ladder above (5 module files in `src/db/migrations/`)
applies *only* to truly-central additions — for example, a
`taskflow_boards_registry` table that lists which agent groups have
TaskFlow installed and where their per-board DB lives. If TaskFlow
needs zero central-DB rows (each board's state is fully contained in
its per-board DB), don't write any migrations against `data/v2.db` at
all — the entire TaskFlow schema becomes a `TASKFLOW_BOARD_SCHEMA`
constant + an `ensureTaskflowSchema(boardDbPath)` function under the
skill's `src/` directory.

## Implications for the Phase A.3 plan

1. **Rename in the plan**: every reference to
   `data/migrations/{NNN}.sql` should become
   `src/db/migrations/module-taskflow-NNN-<area>.ts`. The `data/`
   directory is for runtime data (the SQLite file itself), not schema.

2. **The plan's migration list needs splitting by DB scope.** Walk each
   of the 8-9 tables and decide central-DB vs per-board-DB. From the
   names:
   - `board_runtime_config`, `board_holidays`, `board_people`,
     `task_history`, `archive`, `subtask_requests`,
     `taskflow_group_settings`, `external_contacts`,
     `meeting_external_participants`, `send_message_log`,
     `attachment_audit_log` — all per-board. None of these belong in
     `data/v2.db`. Use a `TASKFLOW_BOARD_SCHEMA` static + per-board
     `ensureSchema()` like v2 does for inbound/outbound.
   - The only candidate central-DB table I can imagine is a
     `taskflow_boards` registry mapping `agent_group_id → board_db_path`
     so the host can enumerate TaskFlow boards without scanning the
     filesystem. If the plan needs that, that's where the
     `module-taskflow-*` central migrations earn their keep — likely
     just one migration creating one table.

3. **Idempotency expectation**: every migration must survive being
   re-run on the same host (test in `src/db/db-v2.test.ts:53-58`).
   Default to `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT
   EXISTS` rather than relying on the runner's name-skip — name-skip
   protects against re-run after `applied`, IF-NOT-EXISTS protects
   against re-run when something interrupted the previous attempt
   between `up()` and the `INSERT INTO schema_version`.

4. **Test-first**: every new migration gets a corresponding case in
   `src/db/db-v2.test.ts` (or a new test file under the skill's tests
   dir) that asserts: (a) `runMigrations(db)` succeeds twice without
   throw, (b) the new tables exist via
   `db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(...)`,
   (c) the schema_version row is present with the correct `name`.

5. **No `down()` migrations**: the plan should not specify rollback
   SQL. v2's pattern is forward-only retract via a new migration
   (`src/db/migrations/009-drop-pending-credentials.ts:5-9`).

6. **The `module-` prefix is load-bearing**: don't number TaskFlow
   migrations as `013-...`, `014-...`. Use `module-taskflow-*-...` so
   upstream's next core migrations don't collide with our filenames or
   our place in the barrel array.

7. **TaskFlow engine schema (`taskflow-engine.ts:1185-1280`) stays
   inside the container**: those CREATE TABLE statements are the
   per-board schema. Either lift them into the skill's
   `TASKFLOW_BOARD_SCHEMA` constant + `ensureSchema()` analog (clean v2
   pattern) or leave them in `taskflow-engine.ts` exactly as-is until a
   later phase. They are NOT central-DB migrations.
