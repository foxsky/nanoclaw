# Jurisdictional Holidays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop TaskFlow from firing standups and digests on Brazilian public holidays by introducing a jurisdictional holiday calendar and a scheduler preflight check.

**Architecture:** A new `jurisdictional_holidays` table (keyed by country/state/city) holds fixed-date public holidays, seeded at init with BR national dates. Moveable feasts (Carnaval, Ash Wednesday, Good Friday, Corpus Christi) are computed per-year via Gauss's Easter algorithm — not stored. A single engine method `isNonBusinessDay(localDate)` returns a `HolidayInfo | null` that unions weekend, jurisdictional, moveable feasts, and per-board `board_holidays` overrides, with half-day support via `work_start_hour_local`. The host-side scheduler (`task-scheduler.ts`) mirrors the logic in a new `src/holiday-calendar.ts` module and calls it as a preflight before dispatching each scheduled_task; on a holiday it advances `next_run` without spinning up a container.

**Tech Stack:** TypeScript, better-sqlite3, vitest, the existing TaskflowEngine class in `container/agent-runner/src/taskflow-engine.ts`, and the host scheduler in `src/task-scheduler.ts`.

**Spec:** `docs/superpowers/specs/2026-04-21-jurisdictional-holidays-design.md`

---

## File Structure

Phase 1 (schema + seed — 2 source files + 1 test fixture):
- Modify: `src/taskflow-db.ts` — adds `jurisdictional_holidays` CREATE, BR seed, `board_holidays.work_start_hour_local` migration, `board_runtime_config.country='BR'` backfill
- Modify: `src/db.ts` — adds `scheduled_tasks.skip_on_holiday` migration
- Modify: `container/agent-runner/src/taskflow-engine.test.ts` — updates in-memory SCHEMA to mirror the new table + column

Phase 2 (engine read-path — 2 new files + 2 modified):
- Create: `container/agent-runner/src/easter.ts` — `computeEaster(year)` + `computeBRMoveableFeasts(year)`, pure functions
- Create: `container/agent-runner/src/easter.test.ts` — Easter dates 2024–2030, moveable feast offsets
- Modify: `container/agent-runner/src/taskflow-engine.ts` — `HolidayInfo` type export, refactored `isNonBusinessDay(localDate): HolidayInfo | null`, new `getEffectiveHolidays(year)`
- Modify: `container/agent-runner/src/taskflow-engine.test.ts` — covers jurisdictional, moveable feasts, half-day, union precedence, null country

Phase 3 (host scheduler preflight — 4 modified + 2 new):
- Modify: `src/types.ts` — adds `skip_on_holiday: boolean` to `ScheduledTask`
- Modify: `src/db.ts` — `createTask` accepts `skip_on_holiday`, passes to INSERT
- Create: `src/holiday-calendar.ts` — host-side mirror (`computeEaster`, `computeBRMoveableFeasts`, `isNonBusinessDay(db, boardId, localDate)`)
- Create: `src/holiday-calendar.test.ts` — verifies host-side matches container-side behavior on reference dates
- Modify: `src/task-scheduler.ts` — preflight in `runTask` before the group lookup
- Modify: `src/task-scheduler.test.ts` — preflight unit tests
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` — `schedule_task` zod schema exposes optional `skip_on_holiday`

---

## Phase 1 — Schema + BR Seed (additive, zero behavior change)

### Task 1.1: Add `jurisdictional_holidays` CREATE TABLE in taskflow-db.ts

**Files:**
- Modify: `src/taskflow-db.ts`
- Modify: `container/agent-runner/src/taskflow-engine.test.ts:9` (SCHEMA constant for engine tests)

- [ ] **Step 1: Add the CREATE TABLE statement to the schema block in `src/taskflow-db.ts`**

Find `CREATE TABLE IF NOT EXISTS board_holidays (` (around line 177-182 in the `TASKFLOW_SCHEMA` template literal). Add this table immediately after `board_holidays`:

```sql
CREATE TABLE IF NOT EXISTS jurisdictional_holidays (
  country TEXT NOT NULL,
  state TEXT,
  city TEXT,
  date TEXT NOT NULL,
  label TEXT NOT NULL,
  work_start_hour_local INTEGER,
  source TEXT DEFAULT 'manual',
  PRIMARY KEY (country, state, city, date)
);

CREATE INDEX IF NOT EXISTS idx_juris_holidays_date ON jurisdictional_holidays(country, date);
```

- [ ] **Step 2: Mirror the schema in the engine test SCHEMA constant**

In `container/agent-runner/src/taskflow-engine.test.ts` around line 8 (the `SCHEMA` template literal that starts with `CREATE TABLE boards ...`). Add:

```sql
CREATE TABLE IF NOT EXISTS jurisdictional_holidays (country TEXT NOT NULL, state TEXT, city TEXT, date TEXT NOT NULL, label TEXT NOT NULL, work_start_hour_local INTEGER, source TEXT DEFAULT 'manual', PRIMARY KEY (country, state, city, date));
```

Add the line near `CREATE TABLE board_holidays` if one exists in that test's SCHEMA; if not, add it anywhere in the SCHEMA constant (order doesn't matter for IF NOT EXISTS).

- [ ] **Step 3: Run typecheck**

```bash
cd /root/nanoclaw && npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/taskflow-db.ts container/agent-runner/src/taskflow-engine.test.ts
git commit -m "schema(taskflow): add jurisdictional_holidays table

Keyed by (country, state, city, date) with nullable state/city for
country-wide vs region-specific holidays. work_start_hour_local column
supports half-day holidays (e.g. Ash Wednesday in BR).

Table only — read-path integration in Phase 2."
```

---

### Task 1.2: Add `work_start_hour_local` to `board_holidays`

**Files:**
- Modify: `src/taskflow-db.ts` (CREATE TABLE + migration ALTER)
- Modify: `container/agent-runner/src/taskflow-engine.test.ts:9` SCHEMA

- [ ] **Step 1: Add column to base CREATE TABLE**

In `src/taskflow-db.ts`, find the `CREATE TABLE IF NOT EXISTS board_holidays (`:

```sql
CREATE TABLE IF NOT EXISTS board_holidays (
  board_id TEXT NOT NULL,
  holiday_date TEXT NOT NULL,
  label TEXT,
  PRIMARY KEY (board_id, holiday_date)
);
```

Replace with:

```sql
CREATE TABLE IF NOT EXISTS board_holidays (
  board_id TEXT NOT NULL,
  holiday_date TEXT NOT NULL,
  label TEXT,
  work_start_hour_local INTEGER,
  PRIMARY KEY (board_id, holiday_date)
);
```

- [ ] **Step 2: Add idempotent ALTER migration**

In `src/taskflow-db.ts`, find the migration block (around line 584 where `ALTER TABLE boards ADD COLUMN short_code TEXT` lives). Add:

```typescript
try {
  db.exec(`ALTER TABLE board_holidays ADD COLUMN work_start_hour_local INTEGER`);
} catch {}
```

Place it near the other ALTER statements for `boards`.

- [ ] **Step 3: Mirror in engine test SCHEMA**

In `container/agent-runner/src/taskflow-engine.test.ts`, find any `CREATE TABLE ... board_holidays (` in the SCHEMA and add `work_start_hour_local INTEGER,` before `PRIMARY KEY`. If there is no `board_holidays` in the test's top SCHEMA constant (some tests inline their own), the fixture at line ~3600 that runs `CREATE TABLE IF NOT EXISTS board_holidays (board_id TEXT, holiday_date TEXT, label TEXT, PRIMARY KEY (board_id, holiday_date))` should be updated to include `, work_start_hour_local INTEGER` before `PRIMARY KEY`.

- [ ] **Step 4: Run all container tests**

```bash
cd /root/nanoclaw/container/agent-runner && npx vitest run
```

Expected: all tests still pass (no behavioral change).

- [ ] **Step 5: Commit**

```bash
git add src/taskflow-db.ts container/agent-runner/src/taskflow-engine.test.ts
git commit -m "schema(board_holidays): add work_start_hour_local column

Supports half-day holidays: NULL = full day off, 12 = half-day starting
at 12:00 local. Used by Phase 2 for Ash Wednesday in BR.

Idempotent ALTER migrates existing DBs on next service start."
```

---

### Task 1.3: Add `scheduled_tasks.skip_on_holiday` column

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Add column to base CREATE TABLE**

In `src/db.ts` line 45, find the `CREATE TABLE IF NOT EXISTS scheduled_tasks (` block. It currently ends with `created_at TEXT NOT NULL);`. Insert `skip_on_holiday INTEGER DEFAULT 1` as the last column:

Find:

```sql
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      ...
      created_at TEXT NOT NULL
    );
```

Replace the closing `    );` with:

```sql
      created_at TEXT NOT NULL,
      skip_on_holiday INTEGER DEFAULT 1
    );
```

- [ ] **Step 2: Add idempotent ALTER migration**

In `src/db.ts`, find the migration block around line 184 (existing ALTERs for `context_mode`, `script`, `trigger_message_id`). Add at the end of that block:

```typescript
try {
  database.exec(
    `ALTER TABLE scheduled_tasks ADD COLUMN skip_on_holiday INTEGER DEFAULT 1`,
  );
} catch {
  /* column already exists */
}
```

- [ ] **Step 3: Run host tests**

```bash
cd /root/nanoclaw && npm test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/db.ts
git commit -m "schema(scheduled_tasks): add skip_on_holiday column

Default 1 — new tasks skip on holidays unless caller opts out. Preflight
logic in Phase 3 reads this column before dispatching.

Idempotent ALTER migrates existing DBs on next service start."
```

---

### Task 1.4: Seed BR national fixed-date holidays for 2026–2027

**Files:**
- Modify: `src/taskflow-db.ts`

- [ ] **Step 1: Add the seed constant near the top of the file**

In `src/taskflow-db.ts`, below the imports and before the `TASKFLOW_SCHEMA` template literal, add:

```typescript
const BR_FIXED_HOLIDAYS: Array<{ date: string; label: string }> = [
  { date: '2026-01-01', label: 'Ano Novo' },
  { date: '2026-04-21', label: 'Tiradentes' },
  { date: '2026-05-01', label: 'Dia do Trabalho' },
  { date: '2026-09-07', label: 'Independência do Brasil' },
  { date: '2026-10-12', label: 'Nossa Senhora Aparecida' },
  { date: '2026-11-02', label: 'Finados' },
  { date: '2026-11-15', label: 'Proclamação da República' },
  { date: '2026-11-20', label: 'Consciência Negra' },
  { date: '2026-12-25', label: 'Natal' },
  { date: '2027-01-01', label: 'Ano Novo' },
  { date: '2027-04-21', label: 'Tiradentes' },
  { date: '2027-05-01', label: 'Dia do Trabalho' },
  { date: '2027-09-07', label: 'Independência do Brasil' },
  { date: '2027-10-12', label: 'Nossa Senhora Aparecida' },
  { date: '2027-11-02', label: 'Finados' },
  { date: '2027-11-15', label: 'Proclamação da República' },
  { date: '2027-11-20', label: 'Consciência Negra' },
  { date: '2027-12-25', label: 'Natal' },
];
```

- [ ] **Step 2: Add the seed call inside `initTaskflowDb`**

Find `export function initTaskflowDb(` in `src/taskflow-db.ts` and locate the end of the migration block (after the `ALTER TABLE board_runtime_config ADD COLUMN city TEXT` try/catch, around line 594). Before the function returns, add:

```typescript
// Seed BR national fixed-date holidays (idempotent via INSERT OR IGNORE).
// Moveable feasts (Easter-derived) are computed at query time, not stored.
const juris = db.prepare(
  `INSERT OR IGNORE INTO jurisdictional_holidays (country, state, city, date, label, work_start_hour_local, source)
   VALUES ('BR', NULL, NULL, ?, ?, NULL, 'fixed')`,
);
for (const h of BR_FIXED_HOLIDAYS) {
  juris.run(h.date, h.label);
}
```

- [ ] **Step 3: Verify seed is idempotent**

Run `initTaskflowDb` twice mentally — second call's INSERT OR IGNORE produces zero row changes, no duplicates, no errors. Write this manual test to confirm:

```bash
cd /root/nanoclaw && node -e "
const Database = require('better-sqlite3');
const fs = require('fs');
const { initTaskflowDb } = require('./dist/taskflow-db.js');
const path = '/tmp/test-juris-seed.db';
try { fs.unlinkSync(path); } catch {}
initTaskflowDb(path);
const db = new Database(path);
const before = db.prepare('SELECT COUNT(*) AS c FROM jurisdictional_holidays').get().c;
initTaskflowDb(path); // idempotency check
const after = db.prepare('SELECT COUNT(*) AS c FROM jurisdictional_holidays').get().c;
console.log('before:', before, 'after:', after, before === after ? 'IDEMPOTENT' : 'NOT IDEMPOTENT');
db.close();
fs.unlinkSync(path);
"
```

First run: `npm run build` first to produce `dist/taskflow-db.js`. Expected output: `before: 18 after: 18 IDEMPOTENT`.

- [ ] **Step 4: Commit**

```bash
git add src/taskflow-db.ts
git commit -m "seed(jurisdictional_holidays): BR national fixed-date holidays 2026-2027

9 holidays per year seeded idempotently via INSERT OR IGNORE. Moveable
feasts (Carnaval, Ash Wed, Good Friday, Corpus Christi) are NOT seeded —
computed per-year in Phase 2 via Gauss Easter algorithm, so no yearly
backfill job is ever needed.

Regional (state/city) holidays seeded manually via manage_holidays as
admins register them."
```

---

### Task 1.5: Backfill `country='BR'` on existing prod DB (one-off, already-running prod)

**Files:** None (direct SQL on prod).

- [ ] **Step 1: Sanity-check before writing**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && sqlite3 data/taskflow/taskflow.db \"SELECT DISTINCT country FROM board_runtime_config;\""
```

Expected output: one row, either `NULL` (empty) or `BR`. If anything else appears, STOP — investigate before backfilling.

- [ ] **Step 2: Apply backfill**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && sqlite3 data/taskflow/taskflow.db \"UPDATE board_runtime_config SET country='BR' WHERE country IS NULL; SELECT 'updated=' || changes();\""
```

Expected: `updated=<N>` where N is the count of previously-NULL rows.

- [ ] **Step 3: Verify**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && sqlite3 data/taskflow/taskflow.db \"SELECT DISTINCT country, COUNT(*) FROM board_runtime_config GROUP BY country;\""
```

Expected: single row `BR|<total boards>`.

- [ ] **Step 4: Deploy so future `initTaskflowDb` runs see the seed**

Only deploy after Phase 1 Tasks 1.1–1.4 are committed. Run:

```bash
cd /root/nanoclaw && ./scripts/deploy.sh
```

Expected: deploy succeeds, service restarts, WhatsApp reconnects. `initTaskflowDb` runs on service start and seeds BR holidays idempotently.

- [ ] **Step 5: Spot-check the seed reached prod**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && sqlite3 data/taskflow/taskflow.db \"SELECT date, label FROM jurisdictional_holidays WHERE country='BR' AND date LIKE '2026-%' ORDER BY date;\""
```

Expected: 9 rows (Tiradentes, Natal, etc.).

**NOTE:** This task has no commit — it's a prod operation. Record the `updated=<N>` number from Step 2 in the deploy log for audit.

---

## Phase 2 — Engine Read-Path Integration

### Task 2.1: Create Easter algorithm + BR moveable feasts module

**Files:**
- Create: `container/agent-runner/src/easter.ts`
- Create: `container/agent-runner/src/easter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `container/agent-runner/src/easter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeEaster, computeBRMoveableFeasts } from './easter.js';

describe('computeEaster', () => {
  // Reference dates verified against a public ecclesiastical calendar.
  const cases: Array<[number, string]> = [
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2028, '2028-04-16'],
    [2029, '2029-04-01'],
    [2030, '2030-04-21'],
  ];

  for (const [year, expected] of cases) {
    it(`Easter ${year} = ${expected}`, () => {
      expect(computeEaster(year)).toBe(expected);
    });
  }
});

describe('computeBRMoveableFeasts', () => {
  it('2026: returns Carnaval, Ash Wednesday, Good Friday, Corpus Christi', () => {
    const feasts = computeBRMoveableFeasts(2026);
    // Easter 2026 = 2026-04-05 (Sunday).
    // Carnaval Monday = Easter - 48 = 2026-02-16
    // Carnaval Tuesday = Easter - 47 = 2026-02-17
    // Ash Wednesday = Easter - 46 = 2026-02-18 (HALF-DAY, work_start=12)
    // Good Friday = Easter - 2 = 2026-04-03
    // Corpus Christi = Easter + 60 = 2026-06-04
    const byDate = Object.fromEntries(feasts.map((f) => [f.date, f]));
    expect(byDate['2026-02-16']).toEqual({
      date: '2026-02-16',
      label: 'Carnaval (segunda-feira)',
      workStartHourLocal: null,
    });
    expect(byDate['2026-02-17']).toEqual({
      date: '2026-02-17',
      label: 'Carnaval (terça-feira)',
      workStartHourLocal: null,
    });
    expect(byDate['2026-02-18']).toEqual({
      date: '2026-02-18',
      label: 'Quarta-feira de Cinzas',
      workStartHourLocal: 12,
    });
    expect(byDate['2026-04-03']).toEqual({
      date: '2026-04-03',
      label: 'Sexta-Feira Santa',
      workStartHourLocal: null,
    });
    expect(byDate['2026-06-04']).toEqual({
      date: '2026-06-04',
      label: 'Corpus Christi',
      workStartHourLocal: null,
    });
  });

  it('caches results per year (same reference returned for repeat calls)', () => {
    const a = computeBRMoveableFeasts(2026);
    const b = computeBRMoveableFeasts(2026);
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /root/nanoclaw/container/agent-runner && npx vitest run src/easter.test.ts
```

Expected: FAIL with "Cannot find module './easter.js'".

- [ ] **Step 3: Write the implementation**

Create `container/agent-runner/src/easter.ts`:

```typescript
/**
 * Gauss's Easter algorithm + Brazilian moveable feasts computation.
 *
 * No year-by-year seeding: Easter is derived from lunar arithmetic, and
 * every BR moveable holiday is a fixed offset from Easter. This module
 * replaces the otherwise-needed yearly backfill of Carnaval / Ash
 * Wednesday / Good Friday / Corpus Christi rows in `jurisdictional_holidays`.
 */

export interface MoveableFeast {
  date: string; // YYYY-MM-DD
  label: string;
  workStartHourLocal: number | null; // null = full day off; 12 = half-day starting at 12:00 local
}

/** Compute the Gregorian date of Easter Sunday for a given year. */
export function computeEaster(year: number): string {
  // Gauss's Easter algorithm (Meeus/Jones/Butcher version).
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const L = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * L) / 451);
  const month = Math.floor((h + L - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + L - 7 * m + 114) % 31) + 1;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** Shift an ISO date (YYYY-MM-DD) by N days. */
function shiftDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const _feastCache: Map<number, MoveableFeast[]> = new Map();

/**
 * All Brazilian moveable feasts for a given year, computed from Easter.
 * Result is cached per-year (reference-stable across repeat calls).
 */
export function computeBRMoveableFeasts(year: number): MoveableFeast[] {
  const cached = _feastCache.get(year);
  if (cached) return cached;

  const easter = computeEaster(year);
  const feasts: MoveableFeast[] = [
    {
      date: shiftDays(easter, -48),
      label: 'Carnaval (segunda-feira)',
      workStartHourLocal: null,
    },
    {
      date: shiftDays(easter, -47),
      label: 'Carnaval (terça-feira)',
      workStartHourLocal: null,
    },
    {
      date: shiftDays(easter, -46),
      label: 'Quarta-feira de Cinzas',
      workStartHourLocal: 12,
    },
    {
      date: shiftDays(easter, -2),
      label: 'Sexta-Feira Santa',
      workStartHourLocal: null,
    },
    {
      date: shiftDays(easter, 60),
      label: 'Corpus Christi',
      workStartHourLocal: null,
    },
  ];
  _feastCache.set(year, feasts);
  return feasts;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd /root/nanoclaw/container/agent-runner && npx vitest run src/easter.test.ts
```

Expected: 8 passed (7 Easter dates + 2 moveable-feast tests, but `describe.each`-style counts 7+2 = 9 — verify actual count is reasonable).

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/easter.ts container/agent-runner/src/easter.test.ts
git commit -m "feat(engine): add Gauss Easter + BR moveable feasts module

computeEaster(year) and computeBRMoveableFeasts(year) — pure functions,
no DB. Replaces the need to seed Carnaval/Ash-Wed/Good-Friday/Corpus-
Christi yearly. Ash Wednesday carries workStartHourLocal=12 to drive
Phase 2's half-day scheduler skip.

Verified against reference Easter dates 2024–2030."
```

---

### Task 2.2: Add `HolidayInfo` type + register `easter.ts` for deploy sync

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts` (export the HolidayInfo type)
- Modify: `src/container-runner.ts` (add `easter.ts` to CORE_AGENT_RUNNER_FILES)

- [ ] **Step 1: Export HolidayInfo from taskflow-engine.ts**

In `container/agent-runner/src/taskflow-engine.ts`, near the other exported types at the top (search for `export type` or `export interface`), add:

```typescript
export interface HolidayInfo {
  /** Human-readable label (e.g. 'Tiradentes', 'Quarta-feira de Cinzas'). */
  label: string;
  /** null = full day off; 12 = half-day starting at 12:00 local. */
  workStartHourLocal: number | null;
  /** Where the hit came from. Used for logging + precedence. */
  source: 'weekend' | 'jurisdictional' | 'moveable_feast' | 'board_override';
}
```

- [ ] **Step 2: Add `easter.ts` to the container sync list**

In `src/container-runner.ts`, find `const CORE_AGENT_RUNNER_FILES = [`. Add `'easter.ts',` alphabetically near the existing entries:

```typescript
const CORE_AGENT_RUNNER_FILES = [
  'auditor-prompt.txt',
  'auditor-script.sh',
  'context-reader.ts',
  'db-util.ts',
  'digest-skip-script.sh',
  'easter.ts',
  'embedding-reader.ts',
  'index.ts',
  'ipc-mcp-stdio.ts',
  'ipc-tooling.ts',
  'runtime-config.ts',
  'semantic-audit.ts',
  'taskflow-engine.ts',
  'tz-util.ts',
  path.join('mcp-plugins', 'create-group.ts'),
] as const;
```

Preserve whatever order the file already uses; just insert `easter.ts`.

- [ ] **Step 3: Typecheck**

```bash
cd /root/nanoclaw && npm run build && cd container/agent-runner && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts src/container-runner.ts
git commit -m "feat(engine): export HolidayInfo + sync easter.ts to containers

HolidayInfo is the return shape of the soon-to-be-refactored
isNonBusinessDay. Added easter.ts to CORE_AGENT_RUNNER_FILES so per-group
session src copies pick it up automatically on next container run."
```

---

### Task 2.3: Refactor `isNonBusinessDay` to return HolidayInfo with jurisdictional union

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts`

- [ ] **Step 1: Write failing tests FIRST**

In `container/agent-runner/src/taskflow-engine.test.ts`, add a new `describe` block (near the existing `describe('query: find_person_in_organization')`):

```typescript
describe('engine holiday resolution', () => {
  function seedOrgWithBR() {
    // Same engine instance — set board's country to BR on the default test DB.
    db.exec(`
      UPDATE board_runtime_config SET country='BR', timezone='America/Fortaleza' WHERE board_id = '${BOARD_ID}';
      INSERT INTO jurisdictional_holidays (country, state, city, date, label, work_start_hour_local, source)
        VALUES ('BR', NULL, NULL, '2026-04-21', 'Tiradentes', NULL, 'fixed');
    `);
  }

  it('returns jurisdictional holiday for national BR dates', () => {
    seedOrgWithBR();
    const info = (engine as any).isNonBusinessDay('2026-04-21');
    expect(info).toEqual({
      label: 'Tiradentes',
      workStartHourLocal: null,
      source: 'jurisdictional',
    });
  });

  it('returns moveable feast for Ash Wednesday with workStartHourLocal=12', () => {
    seedOrgWithBR();
    // Easter 2026 = Apr 5, Ash Wed = Feb 18.
    const info = (engine as any).isNonBusinessDay('2026-02-18');
    expect(info).toEqual({
      label: 'Quarta-feira de Cinzas',
      workStartHourLocal: 12,
      source: 'moveable_feast',
    });
  });

  it('returns null on a regular business day', () => {
    seedOrgWithBR();
    // 2026-04-22 is a Wednesday with no BR holiday.
    const info = (engine as any).isNonBusinessDay('2026-04-22');
    expect(info).toBeNull();
  });

  it('returns weekend source for Saturday', () => {
    seedOrgWithBR();
    // 2026-04-18 is a Saturday.
    const info = (engine as any).isNonBusinessDay('2026-04-18');
    expect(info?.source).toBe('weekend');
  });

  it('board override wins precedence over jurisdictional', () => {
    seedOrgWithBR();
    db.exec(`
      INSERT INTO board_holidays (board_id, holiday_date, label, work_start_hour_local)
        VALUES ('${BOARD_ID}', '2026-04-21', 'Retiro da equipe', NULL)
    `);
    const info = (engine as any).isNonBusinessDay('2026-04-21');
    expect(info?.source).toBe('board_override');
    expect(info?.label).toBe('Retiro da equipe');
  });

  it('skips jurisdictional lookup when country is NULL (logs warning)', () => {
    db.exec(
      `UPDATE board_runtime_config SET country = NULL WHERE board_id = '${BOARD_ID}'`,
    );
    db.exec(`
      INSERT INTO jurisdictional_holidays (country, state, city, date, label, work_start_hour_local, source)
        VALUES ('BR', NULL, NULL, '2026-04-21', 'Tiradentes', NULL, 'fixed');
    `);
    const info = (engine as any).isNonBusinessDay('2026-04-21');
    // Tuesday 2026-04-21 — no board_override, no weekend, no country → null.
    expect(info).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /root/nanoclaw/container/agent-runner && npx vitest run src/taskflow-engine.test.ts -t 'engine holiday resolution'
```

Expected: FAILS because the current `isNonBusinessDay` returns `{weekend, holiday, dow}`, not `HolidayInfo | null`.

- [ ] **Step 3: Refactor the engine method**

In `container/agent-runner/src/taskflow-engine.ts`, replace the existing `getBoardHolidays`, `isNonBusinessDay`, and `getNextBusinessDay` (around lines 853–893). Replace the whole block with:

```typescript
private _holidayCache: Map<string, HolidayInfo> | null = null;
private _holidayCacheYear: number | null = null;

/**
 * Lazily load all holidays that affect this board, for ONE year, keyed by
 * date. Union of:
 *   1. jurisdictional_holidays matching board's (country, state?, city?)
 *   2. BR moveable feasts if country='BR'
 *   3. board_holidays overrides (always win precedence over 1 & 2)
 *
 * Cached per-year per-engine-instance. Invalidated when manage_holidays
 * mutates the override table.
 */
private getEffectiveHolidays(year: number): Map<string, HolidayInfo> {
  if (this._holidayCache && this._holidayCacheYear === year) {
    return this._holidayCache;
  }
  const map = new Map<string, HolidayInfo>();
  const cfg = this.db
    .prepare(
      `SELECT country, state, city FROM board_runtime_config WHERE board_id = ?`,
    )
    .get(this.boardId) as
    | { country: string | null; state: string | null; city: string | null }
    | undefined;
  const country = cfg?.country ?? null;
  const state = cfg?.state ?? null;
  const city = cfg?.city ?? null;

  // 1. Jurisdictional rows for this year, scoped to country/state/city.
  //    NULL state/city in the table means "applies to any state/city under
  //    this country" — we match with (row.state IS NULL OR row.state = ?).
  if (country !== null) {
    const rows = this.db
      .prepare(
        `SELECT date, label, work_start_hour_local
         FROM jurisdictional_holidays
         WHERE country = ?
           AND (state IS NULL OR state = ?)
           AND (city IS NULL OR city = ?)
           AND date >= ? AND date <= ?`,
      )
      .all(country, state, city, `${year}-01-01`, `${year}-12-31`) as Array<{
        date: string;
        label: string;
        work_start_hour_local: number | null;
      }>;
    for (const r of rows) {
      map.set(r.date, {
        label: r.label,
        workStartHourLocal: r.work_start_hour_local,
        source: 'jurisdictional',
      });
    }
    // 2. BR moveable feasts.
    if (country === 'BR') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { computeBRMoveableFeasts } = require('./easter.js') as typeof import('./easter.js');
      for (const f of computeBRMoveableFeasts(year)) {
        // Only set if no more-specific override already covers this date.
        if (!map.has(f.date)) {
          map.set(f.date, {
            label: f.label,
            workStartHourLocal: f.workStartHourLocal,
            source: 'moveable_feast',
          });
        }
      }
    }
  }

  // 3. Per-board overrides (always win).
  const overrides = this.db
    .prepare(
      `SELECT holiday_date, label, work_start_hour_local FROM board_holidays WHERE board_id = ? AND holiday_date >= ? AND holiday_date <= ?`,
    )
    .all(this.boardId, `${year}-01-01`, `${year}-12-31`) as Array<{
      holiday_date: string;
      label: string | null;
      work_start_hour_local: number | null;
    }>;
  for (const o of overrides) {
    map.set(o.holiday_date, {
      label: o.label ?? 'Feriado',
      workStartHourLocal: o.work_start_hour_local,
      source: 'board_override',
    });
  }

  this._holidayCache = map;
  this._holidayCacheYear = year;
  return map;
}

/**
 * Check whether `dateStr` (YYYY-MM-DD) is a non-business day for this board.
 * Returns HolidayInfo describing the reason or null on a normal business day.
 */
isNonBusinessDay(dateStr: string): HolidayInfo | null {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) {
    return {
      label: dow === 0 ? 'domingo' : 'sábado',
      workStartHourLocal: null,
      source: 'weekend',
    };
  }
  const year = Number.parseInt(dateStr.slice(0, 4), 10);
  const hit = this.getEffectiveHolidays(year).get(dateStr);
  return hit ?? null;
}

/** Return the next business day (YYYY-MM-DD) that is not a weekend or holiday. */
private getNextBusinessDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  for (let i = 0; i < 30; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const candidate = d.toISOString().slice(0, 10);
    if (!this.isNonBusinessDay(candidate)) return candidate;
  }
  return dateStr;
}

/** Shift a date to the next business day if it falls on a weekend or holiday. */
private shiftToBusinessDay(dateStr: string): string {
  if (this.isNonBusinessDay(dateStr)) return this.getNextBusinessDay(dateStr);
  return dateStr;
}
```

Key changes: (a) `isNonBusinessDay` is now PUBLIC (no `private` keyword — needed by tests and future callers). (b) Return shape is `HolidayInfo | null` instead of the `{weekend, holiday, dow}` object. (c) `getEffectiveHolidays` replaces the old `getBoardHolidays` (still private).

- [ ] **Step 4: Update `checkNonBusinessDay` to consume the new shape**

Find `private checkNonBusinessDay(` (around line 897). Replace its body:

```typescript
private checkNonBusinessDay(
  dateStr: string,
  allowOverride: boolean,
  fieldLabel: 'Due date' | 'Meeting date' = 'Due date',
): TaskflowResult | null {
  if (allowOverride) return null;
  const info = this.isNonBusinessDay(dateStr);
  if (!info) return null;
  const suggested = this.getNextBusinessDay(dateStr);
  const sugDow = new Date(suggested + 'T12:00:00Z').getUTCDay();
  const sugDayName = WEEKDAY_NAMES_PT[sugDow];
  return {
    success: false,
    non_business_day_warning: true,
    original_date: dateStr,
    suggested_date: suggested,
    reason: info.label,
    error: `${fieldLabel} falls on ${info.label} (${dateStr}). Suggest ${suggested} (${sugDayName}).`,
  };
}
```

- [ ] **Step 5: Invalidate the cache on override mutations**

In `container/agent-runner/src/taskflow-engine.ts`, find the three places where `this._holidayCache = null;` currently appears (inside the `manage_holidays` admin case). Replace each with:

```typescript
this._holidayCache = null;
this._holidayCacheYear = null;
```

- [ ] **Step 6: Run all engine tests**

```bash
cd /root/nanoclaw/container/agent-runner && npx vitest run src/taskflow-engine.test.ts
```

Expected: all tests pass including the 6 new ones from Step 1.

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts container/agent-runner/src/taskflow-engine.test.ts
git commit -m "feat(engine): isNonBusinessDay returns HolidayInfo with jurisdictional union

Unions weekend + jurisdictional_holidays (scoped by board country/state/
city) + BR moveable feasts + board_holidays overrides. Override always
wins precedence. Half-day holidays (workStartHourLocal set) are returned
for the Phase 3 scheduler preflight to distinguish morning-skip from
full-day-skip.

Cache keyed by year; invalidated on manage_holidays mutations."
```

---

## Phase 3 — Host Scheduler Preflight

### Task 3.1: Extend `ScheduledTask` type + DB createTask

**Files:**
- Modify: `src/types.ts`
- Modify: `src/db.ts`

- [ ] **Step 1: Add `skip_on_holiday` to the interface**

In `src/types.ts` line 95 (`ScheduledTask` interface), add the field before the trigger_* fields:

```typescript
export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  skip_on_holiday: boolean;
  trigger_message_id?: string | null;
  trigger_chat_jid?: string | null;
  trigger_sender?: string | null;
  trigger_sender_name?: string | null;
  trigger_message_timestamp?: string | null;
  trigger_turn_id?: string | null;
}
```

- [ ] **Step 2: Update `createTask` to pass it through**

In `src/db.ts` around line 675, find `export function createTask(`. Update the INSERT to include the new column:

```typescript
export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (
      id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value,
      context_mode, next_run, status, created_at, skip_on_holiday,
      trigger_message_id, trigger_chat_jid, trigger_sender,
      trigger_sender_name, trigger_message_timestamp, trigger_turn_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
    task.skip_on_holiday === false ? 0 : 1,
    task.trigger_message_id ?? null,
    task.trigger_chat_jid ?? null,
    task.trigger_sender ?? null,
    task.trigger_sender_name ?? null,
    task.trigger_message_timestamp ?? null,
    task.trigger_turn_id ?? null,
  );
}
```

Note: SQLite stores bool as 0/1. The `=== false ? 0 : 1` coercion matches the schema default of 1 when callers omit the field.

- [ ] **Step 3: Coerce boolean in reads**

SQLite returns the INTEGER column as 0 or 1, but the TS interface expects `boolean`. Find every `as ScheduledTask` and `as ScheduledTask[]` cast in `src/db.ts` (getTaskById, getTasksForGroup, getAllTasks, getDueTasks). Each read path should map the raw row to coerce the int to boolean. Simplest: add a helper and use it:

At the top of `src/db.ts` after imports:

```typescript
function hydrateTask(row: Record<string, unknown>): ScheduledTask {
  return { ...row, skip_on_holiday: row.skip_on_holiday !== 0 } as ScheduledTask;
}
```

Then update each read:

```typescript
export function getTaskById(id: string): ScheduledTask | undefined {
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? hydrateTask(row) : undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return (
    db
      .prepare(
        'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
      )
      .all(groupFolder) as Record<string, unknown>[]
  ).map(hydrateTask);
}

export function getAllTasks(): ScheduledTask[] {
  return (
    db
      .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
      .all() as Record<string, unknown>[]
  ).map(hydrateTask);
}
```

Do the same for `getDueTasks` around line 784.

- [ ] **Step 4: Run host tests**

```bash
cd /root/nanoclaw && npm test
```

Expected: all pass. Any tests creating a ScheduledTask object need `skip_on_holiday: true` added — follow typechecker errors and fix in-place (don't write new tests).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/db.ts
git commit -m "feat(scheduler): wire skip_on_holiday through ScheduledTask CRUD

Default true — callers can opt out by passing skip_on_holiday:false.
SQLite stores as int; hydrateTask() coerces on read. Preflight consumer
lands in Task 3.3."
```

---

### Task 3.2: Create host-side `holiday-calendar.ts`

**Files:**
- Create: `src/holiday-calendar.ts`
- Create: `src/holiday-calendar.test.ts`

- [ ] **Step 1: Write failing tests FIRST**

Create `src/holiday-calendar.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  computeEaster,
  computeBRMoveableFeasts,
  isNonBusinessDay,
} from './holiday-calendar.js';

describe('host computeEaster', () => {
  // Must match container/agent-runner/src/easter.ts exactly — divergence
  // between host and container is a real bug (user creates meeting via host
  // path, engine audits via container path; disagreement means false
  // non-business-day warnings).
  const cases: Array<[number, string]> = [
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2030, '2030-04-21'],
  ];
  for (const [year, expected] of cases) {
    it(`Easter ${year} = ${expected}`, () => {
      expect(computeEaster(year)).toBe(expected);
    });
  }
});

describe('host isNonBusinessDay', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE board_runtime_config (
        board_id TEXT PRIMARY KEY,
        country TEXT,
        state TEXT,
        city TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Fortaleza'
      );
      CREATE TABLE jurisdictional_holidays (
        country TEXT NOT NULL,
        state TEXT,
        city TEXT,
        date TEXT NOT NULL,
        label TEXT NOT NULL,
        work_start_hour_local INTEGER,
        source TEXT DEFAULT 'manual',
        PRIMARY KEY (country, state, city, date)
      );
      CREATE TABLE board_holidays (
        board_id TEXT NOT NULL,
        holiday_date TEXT NOT NULL,
        label TEXT,
        work_start_hour_local INTEGER,
        PRIMARY KEY (board_id, holiday_date)
      );
      INSERT INTO board_runtime_config (board_id, country) VALUES ('b1', 'BR');
      INSERT INTO jurisdictional_holidays VALUES
        ('BR', NULL, NULL, '2026-04-21', 'Tiradentes', NULL, 'fixed');
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('returns jurisdictional BR holiday', () => {
    expect(isNonBusinessDay(db, 'b1', '2026-04-21')).toEqual({
      label: 'Tiradentes',
      workStartHourLocal: null,
      source: 'jurisdictional',
    });
  });

  it('returns Ash Wednesday moveable feast with workStartHourLocal=12', () => {
    expect(isNonBusinessDay(db, 'b1', '2026-02-18')).toEqual({
      label: 'Quarta-feira de Cinzas',
      workStartHourLocal: 12,
      source: 'moveable_feast',
    });
  });

  it('returns weekend for Saturday', () => {
    expect(isNonBusinessDay(db, 'b1', '2026-04-18')?.source).toBe('weekend');
  });

  it('returns null on regular business day', () => {
    expect(isNonBusinessDay(db, 'b1', '2026-04-22')).toBeNull();
  });

  it('board override wins precedence', () => {
    db.exec(
      `INSERT INTO board_holidays VALUES ('b1', '2026-04-21', 'Retiro', NULL)`,
    );
    expect(isNonBusinessDay(db, 'b1', '2026-04-21')?.source).toBe(
      'board_override',
    );
  });

  it('country=NULL returns null on a jurisdictional-only date', () => {
    db.exec(`UPDATE board_runtime_config SET country = NULL WHERE board_id = 'b1'`);
    expect(isNonBusinessDay(db, 'b1', '2026-04-21')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /root/nanoclaw && npx vitest run src/holiday-calendar.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Write the implementation**

Create `src/holiday-calendar.ts`:

```typescript
/**
 * Host-side mirror of container/agent-runner/src/easter.ts + the engine's
 * isNonBusinessDay logic. Used by task-scheduler.ts for preflight before
 * dispatching a scheduled_task.
 *
 * Kept independently testable so host/container versions can't drift
 * silently — unit tests reference the same Easter dates on both sides.
 */
import type Database from 'better-sqlite3';

export interface HolidayInfo {
  label: string;
  workStartHourLocal: number | null;
  source: 'weekend' | 'jurisdictional' | 'moveable_feast' | 'board_override';
}

export function computeEaster(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const L = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * L) / 451);
  const month = Math.floor((h + L - 7 * m + 114) / 31);
  const day = ((h + L - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface MoveableFeast {
  date: string;
  label: string;
  workStartHourLocal: number | null;
}

const _feastCache: Map<number, MoveableFeast[]> = new Map();

export function computeBRMoveableFeasts(year: number): MoveableFeast[] {
  const cached = _feastCache.get(year);
  if (cached) return cached;
  const easter = computeEaster(year);
  const feasts: MoveableFeast[] = [
    { date: shiftDays(easter, -48), label: 'Carnaval (segunda-feira)', workStartHourLocal: null },
    { date: shiftDays(easter, -47), label: 'Carnaval (terça-feira)', workStartHourLocal: null },
    { date: shiftDays(easter, -46), label: 'Quarta-feira de Cinzas', workStartHourLocal: 12 },
    { date: shiftDays(easter, -2), label: 'Sexta-Feira Santa', workStartHourLocal: null },
    { date: shiftDays(easter, 60), label: 'Corpus Christi', workStartHourLocal: null },
  ];
  _feastCache.set(year, feasts);
  return feasts;
}

/**
 * Check whether a given local date is a non-business day for a specific
 * board. Opens no files — takes a db handle the caller already has.
 */
export function isNonBusinessDay(
  db: Database.Database,
  boardId: string,
  localDate: string,
): HolidayInfo | null {
  const d = new Date(localDate + 'T12:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) {
    return {
      label: dow === 0 ? 'domingo' : 'sábado',
      workStartHourLocal: null,
      source: 'weekend',
    };
  }

  // Board override wins precedence.
  const override = db
    .prepare(
      `SELECT label, work_start_hour_local FROM board_holidays WHERE board_id = ? AND holiday_date = ?`,
    )
    .get(boardId, localDate) as
    | { label: string | null; work_start_hour_local: number | null }
    | undefined;
  if (override) {
    return {
      label: override.label ?? 'Feriado',
      workStartHourLocal: override.work_start_hour_local,
      source: 'board_override',
    };
  }

  const cfg = db
    .prepare(
      `SELECT country, state, city FROM board_runtime_config WHERE board_id = ?`,
    )
    .get(boardId) as
    | { country: string | null; state: string | null; city: string | null }
    | undefined;
  const country = cfg?.country ?? null;
  if (country === null) return null;

  const juris = db
    .prepare(
      `SELECT label, work_start_hour_local FROM jurisdictional_holidays
       WHERE country = ?
         AND (state IS NULL OR state = ?)
         AND (city IS NULL OR city = ?)
         AND date = ?
       ORDER BY (city IS NULL) ASC, (state IS NULL) ASC
       LIMIT 1`,
    )
    .get(country, cfg?.state ?? null, cfg?.city ?? null, localDate) as
    | { label: string; work_start_hour_local: number | null }
    | undefined;
  if (juris) {
    return {
      label: juris.label,
      workStartHourLocal: juris.work_start_hour_local,
      source: 'jurisdictional',
    };
  }

  if (country === 'BR') {
    const year = Number.parseInt(localDate.slice(0, 4), 10);
    const feast = computeBRMoveableFeasts(year).find((f) => f.date === localDate);
    if (feast) {
      return {
        label: feast.label,
        workStartHourLocal: feast.workStartHourLocal,
        source: 'moveable_feast',
      };
    }
  }

  return null;
}
```

- [ ] **Step 4: Run tests**

```bash
cd /root/nanoclaw && npx vitest run src/holiday-calendar.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/holiday-calendar.ts src/holiday-calendar.test.ts
git commit -m "feat(scheduler): host-side holiday-calendar module

Mirrors container/agent-runner/src/easter.ts + engine
isNonBusinessDay. Takes a db handle — scheduler opens taskflow.db once
and calls this per scheduled_task fire. Weekend + board override +
jurisdictional lookup + BR moveable feasts, same precedence rules as
engine-side."
```

---

### Task 3.3: Scheduler preflight in `runTask`

**Files:**
- Modify: `src/task-scheduler.ts`
- Modify: `src/task-scheduler.test.ts`

- [ ] **Step 1: Write failing test**

In `src/task-scheduler.test.ts`, add at the end of the existing describe block:

```typescript
  it('runTask skips scheduled_tasks that fall on a holiday (skip_on_holiday=1)', async () => {
    // Seed a board in BR + Tiradentes 2026 in taskflow.db.
    const tfDb = new Database(TASKFLOW_DB_PATH);
    tfDb.exec(`
      INSERT INTO boards VALUES ('board-hol-test', 'hol@g.us', 'hol-taskflow', 'standard', 0, 1, NULL, NULL, NULL);
      INSERT INTO board_runtime_config (board_id, country) VALUES ('board-hol-test', 'BR');
      INSERT INTO jurisdictional_holidays (country, state, city, date, label, work_start_hour_local, source)
        VALUES ('BR', NULL, NULL, '2026-04-21', 'Tiradentes', NULL, 'fixed');
    `);
    tfDb.close();

    const task = {
      id: 'task-holiday-test',
      group_folder: 'hol-taskflow',
      chat_jid: 'hol@g.us',
      prompt: '[TF-STANDUP] run me',
      schedule_type: 'cron' as const,
      schedule_value: '0 8 * * 1-5',
      context_mode: 'isolated' as const,
      next_run: '2026-04-21T11:00:00.000Z', // 08:00 Fortaleza
      status: 'active' as const,
      created_at: new Date().toISOString(),
      skip_on_holiday: true,
      last_run: null,
      last_result: null,
    };
    createTask(task);

    const deps = makeSchedulerDeps();
    // Call runTask at 2026-04-21T11:00:01Z — scheduler loop would pick up this task.
    await runTask(task, deps, new Date('2026-04-21T11:00:01.000Z'));

    const row = getTaskById(task.id);
    expect(row?.last_result).toMatch(/skipped_holiday/);
    expect(deps.runContainerAgent).not.toHaveBeenCalled();
  });
```

NOTE: `runTask`'s existing signature takes `(task, deps)`. Adding a third arg for the current clock is a TEST affordance — acceptable here. If the existing signature doesn't allow it, add an optional third parameter: `now?: Date`.

- [ ] **Step 2: Run test — verify it fails**

```bash
cd /root/nanoclaw && npx vitest run src/task-scheduler.test.ts -t 'skips scheduled_tasks that fall on a holiday'
```

Expected: FAIL (preflight not implemented).

- [ ] **Step 3: Add the preflight**

In `src/task-scheduler.ts`, find `async function runTask(` around line 88. Near the top of the function (right after `logger.info(..., 'Running scheduled task')`), add:

```typescript
// --- Holiday preflight ---
// Stops standup/digest/review from firing on public holidays. Default
// skip_on_holiday=1 for auto-provisioned runners; callers can opt out via
// schedule_task.skip_on_holiday=false. NANOCLAW_HOLIDAY_SKIP=0 env-var is
// an incident-response global kill switch.
if (
  task.skip_on_holiday &&
  process.env.NANOCLAW_HOLIDAY_SKIP !== '0'
) {
  try {
    const tfDb = new Database(TASKFLOW_DB_PATH, { readonly: true });
    try {
      const boardRow = tfDb
        .prepare(`SELECT id, group_jid FROM boards WHERE group_folder = ?`)
        .get(task.group_folder) as { id: string } | undefined;
      if (boardRow) {
        const nowUtc = now ?? new Date();
        // The board's timezone governs "today" — standups at cron 0 8 local
        // should look at the local day, not the UTC day.
        const tzRow = tfDb
          .prepare(`SELECT timezone FROM board_runtime_config WHERE board_id = ?`)
          .get(boardRow.id) as { timezone: string } | undefined;
        const tz = tzRow?.timezone ?? 'America/Fortaleza';
        const localDate = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(nowUtc);
        const holiday = isNonBusinessDay(tfDb, boardRow.id, localDate);
        if (holiday) {
          const localHour = Number.parseInt(
            new Intl.DateTimeFormat('en-GB', {
              timeZone: tz,
              hour: '2-digit',
              hour12: false,
            }).format(nowUtc),
            10,
          );
          const fullDaySkip = holiday.workStartHourLocal === null;
          const halfDayStillMorning =
            holiday.workStartHourLocal !== null &&
            localHour < holiday.workStartHourLocal;
          if (fullDaySkip || halfDayStillMorning) {
            updateTask(task.id, {
              // Preserve advanced next_run that computeNextRun will set below.
            });
            markLastResult(
              task.id,
              `__skipped_holiday(${holiday.label}, source=${holiday.source})__`,
            );
            logger.info(
              {
                taskId: task.id,
                groupFolder: task.group_folder,
                holiday: holiday.label,
                source: holiday.source,
                localDate,
              },
              'Scheduled task skipped: holiday',
            );
            // Advance next_run past today — fall through to the normal advance
            // logic below by returning early AFTER setting last_run.
            const nextRun = computeNextRun(task);
            if (nextRun) updateTask(task.id, { next_run: nextRun });
            logTaskRun({
              task_id: task.id,
              run_at: new Date().toISOString(),
              duration_ms: Date.now() - startTime,
              status: 'success',
              result: `skipped_holiday(${holiday.label})`,
              error: null,
            });
            return;
          }
        }
      }
    } finally {
      tfDb.close();
    }
  } catch (err) {
    // Holiday-check failure must NOT block dispatch — log and continue.
    logger.warn(
      { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
      'Holiday preflight failed — firing anyway',
    );
  }
}
// --- end holiday preflight ---
```

- [ ] **Step 4: Add imports at top of `src/task-scheduler.ts`**

Add:

```typescript
import Database from 'better-sqlite3';
import { TASKFLOW_DB_PATH } from './ipc-plugins/provision-shared.js';
import { isNonBusinessDay } from './holiday-calendar.js';
```

Also make sure `markLastResult` (or the equivalent helper for writing `last_result`) is imported/defined. If it doesn't exist, use the existing `updateTask` + a direct DB write pattern already in the file.

- [ ] **Step 5: Thread `now` through the function signature**

Change `async function runTask(task, deps)` to `async function runTask(task, deps, now?: Date)`. Update the single call site in the scheduler loop (somewhere in the file — search for `runTask(`) to pass no third argument — `undefined` falls through to the default `new Date()`.

- [ ] **Step 6: Run tests**

```bash
cd /root/nanoclaw && npx vitest run src/task-scheduler.test.ts
```

Expected: all tests pass, including the new one.

- [ ] **Step 7: Run full host + container suites**

```bash
cd /root/nanoclaw && npm test && cd container/agent-runner && npx vitest run
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/task-scheduler.ts src/task-scheduler.test.ts
git commit -m "feat(scheduler): holiday preflight skips runners on public holidays

Before firing a scheduled_task, resolve its board, compute today in board
tz, union weekend + jurisdictional + BR moveable feasts + board
overrides. If full-day holiday OR half-day morning (cron fire < work
start hour) → skip + advance next_run + log skipped_holiday. Half-day
afternoon tasks still fire.

NANOCLAW_HOLIDAY_SKIP=0 env-var = incident-response global override.
skip_on_holiday=0 per-task = permanent opt-out for emergency tasks."
```

---

### Task 3.4: Expose `skip_on_holiday` in the `schedule_task` MCP schema

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Find the `schedule_task` tool registration**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, locate `server.tool(\n  'schedule_task',`. Its zod schema object has fields like `prompt`, `schedule_type`, `schedule_value`, `context_mode`, etc.

- [ ] **Step 2: Add the field**

In the zod schema object, add:

```typescript
skip_on_holiday: z
  .boolean()
  .optional()
  .describe(
    "If true (default), the task is skipped on Brazilian public holidays (national/state/city per board's country/state/city, plus Carnaval, Ash Wednesday, Good Friday, Corpus Christi). Half-day holidays like Quarta-feira de Cinzas skip only tasks scheduled before 12:00 local. Set false for emergency/always-fire tasks.",
  ),
```

- [ ] **Step 3: Thread the value through the IPC payload**

In the same tool's `async (args) => { ... }` handler, find where the IPC payload is built (object with `prompt`, `schedule_type`, etc.) and add:

```typescript
skip_on_holiday: args.skip_on_holiday === false ? false : true,
```

Make sure the IPC type in `src/ipc.ts` (the host-side that parses the `schedule_task` IPC write) also reads this field and passes it to `createTask`.

- [ ] **Step 4: Update the host-side IPC handler to read the field**

In `src/ipc.ts`, find where `schedule_task` IPC files are consumed (search for `schedule_task` or `createTask(`). Pass `skip_on_holiday` through:

```typescript
createTask({
  ...other_fields,
  skip_on_holiday: data.skip_on_holiday === false ? false : true,
});
```

- [ ] **Step 5: Run tests**

```bash
cd /root/nanoclaw && npm test && cd container/agent-runner && npx vitest run
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts src/ipc.ts
git commit -m "feat(mcp): expose skip_on_holiday in schedule_task tool

Optional boolean, defaults true (skip on holidays). Agents creating
emergency/always-fire tasks can set false. Documented in the zod .describe
so the SDK-injected tool spec tells the agent how to use it."
```

---

### Task 3.5: Live e2e validation

**Files:** None (prod operation).

- [ ] **Step 1: Deploy**

```bash
cd /root/nanoclaw && ./scripts/deploy.sh
```

Expected: deploy succeeds, service restarts, WhatsApp reconnects.

- [ ] **Step 2: Verify seed landed**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && sqlite3 data/taskflow/taskflow.db \"SELECT COUNT(*) FROM jurisdictional_holidays WHERE country='BR';\""
```

Expected: 18 (9 holidays × 2 years). Fewer = seed didn't run; more = duplicate inserts.

- [ ] **Step 3: Spot-check prod scheduler behavior via a one-shot fake-holiday board**

For a live test, pick a board with timezone `America/Fortaleza`, verify its `board_runtime_config.country='BR'`, and schedule a one-shot task for `2026-04-21T11:00:00Z` (Tiradentes 08:00 local) and another for `2026-04-22T11:00:00Z` (next business day).

Use the e2e scheduled-task pattern:

```bash
TASK_HOL_ID="e2e-hol-$(date +%s)"
TASK_OK_ID="e2e-ok-$(date +%s)"

ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && sqlite3 store/messages.db \"
  INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, skip_on_holiday)
    VALUES ('$TASK_HOL_ID', 'seci-taskflow', '120363406395935726@g.us', 'E2E-HOLIDAY-TEST ' || '$(date +%s)' || ' — should NOT fire', 'once', '2026-04-21T11:00:00.000Z', '2026-04-21T11:00:00.000Z', 'active', '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', 1);
  INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, skip_on_holiday)
    VALUES ('$TASK_OK_ID', 'seci-taskflow', '120363406395935726@g.us', 'E2E-HOLIDAY-TEST ' || '$(date +%s)' || ' — SHOULD fire', 'once', '$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%S.000Z)', '$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%S.000Z)', 'active', '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', 1);
\""
```

Wait ~2 minutes.

- [ ] **Step 4: Verify**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && sqlite3 store/messages.db \"SELECT id, last_run IS NOT NULL AS ran, substr(last_result, 1, 120) FROM scheduled_tasks WHERE id IN ('$TASK_HOL_ID', '$TASK_OK_ID');\""
```

Expected:
- `$TASK_HOL_ID` — `ran=1`, `last_result` contains `skipped_holiday(Tiradentes, ...)`
- `$TASK_OK_ID` — `ran=1`, `last_result` is the normal agent output (not a skip)

- [ ] **Step 5: Clean up**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && sqlite3 store/messages.db \"DELETE FROM scheduled_tasks WHERE id IN ('$TASK_HOL_ID', '$TASK_OK_ID');\""
```

- [ ] **Step 6: Record the validation in the deploy log + close out**

No commit.

---

## Self-Review Checklist

**1. Spec coverage:**
- Target architecture (4 columns, half-day work_start_hour_local, moveable feasts computed, single helper method) → Phase 1 tasks 1.1–1.4 + Phase 2 task 2.3 ✓
- Phased migration: each phase shippable independently → Phase 1 = schema + seed, Phase 2 = engine, Phase 3 = scheduler. Each phase has its own test + commit gate ✓
- Half-day holidays (Quarta-feira de Cinzas → work_start_hour_local=12) → Task 2.1 (computed) + Task 2.3 (returned by engine) + Task 3.3 (half-day morning-skip logic) ✓
- State/city scope via nullable keys → Task 1.1 schema + Task 3.2 query `state IS NULL OR state = ?` ✓
- Env-var kill switch `NANOCLAW_HOLIDAY_SKIP=0` → Task 3.3 preflight ✓
- Phase 4 (data cleanup) → deferred per spec, intentionally not in plan ✓

**2. Placeholder scan:** No `TBD`, `TODO`, or "similar to" references. Every code step shows the full code. ✓

**3. Type consistency:**
- `HolidayInfo` defined identically in `taskflow-engine.ts` (Task 2.2) and `holiday-calendar.ts` (Task 3.2). Same fields, same source enum. ✓
- `skip_on_holiday: boolean` is the TS type; SQLite column is INTEGER with coercion in `hydrateTask` (Task 3.1). ✓
- `computeEaster(year): string` return type identical on host and container sides. ✓
- `MoveableFeast` interface identical on both sides (date/label/workStartHourLocal). ✓

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-21-jurisdictional-holidays.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Appropriate for this plan because each task is genuinely independent (one commit each, tests ship with the code).

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
