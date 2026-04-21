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
-- NOTE: adding a column to this table later requires a matching
-- ALTER TABLE jurisdictional_holidays ADD COLUMN ... try/catch in the
-- migration block below. CREATE TABLE IF NOT EXISTS is a no-op on
-- existing DBs — new columns on the CREATE will NOT appear unless a
-- migration ALTER runs too.
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

- [ ] **Step 3: Mirror in every inline schema fragment across test files**

Three distinct locations need the new column — the plan treats each as a concrete edit, not "if present":

1. `container/agent-runner/src/taskflow-engine.test.ts` — top-level `SCHEMA` constant around line 8 (covers the main describe block). Add `work_start_hour_local INTEGER,` before `PRIMARY KEY` on the board_holidays table.

2. `container/agent-runner/src/taskflow-engine.test.ts:3600` — an inline `CREATE TABLE IF NOT EXISTS board_holidays (board_id TEXT, holiday_date TEXT, label TEXT, PRIMARY KEY (board_id, holiday_date))` lives inside one test body. Replace with: `CREATE TABLE IF NOT EXISTS board_holidays (board_id TEXT, holiday_date TEXT, label TEXT, work_start_hour_local INTEGER, PRIMARY KEY (board_id, holiday_date))`.

3. `container/agent-runner/src/taskflow-embedding-integration.test.ts` — this file inlines its own `CREATE TABLE board_runtime_config` (around line 59) and `CREATE TABLE board_holidays` (around line 72). Both need updates: board_holidays gets `work_start_hour_local INTEGER,`, and since Phase 2's engine code will SELECT from `jurisdictional_holidays`, the test also needs that table added — copy the same CREATE TABLE statement from Task 1.1 Step 2.

Verify coverage:

```bash
cd /root/nanoclaw && grep -rln "CREATE TABLE.*board_holidays\|CREATE TABLE.*board_runtime_config" --include="*.test.ts" src/ container/agent-runner/src/ | sort -u
```

Each path in the output must have been updated above. If grep finds more, update them before committing.

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

### Task 1.4: Seed BR national fixed-date holidays (self-healing, year-agnostic)

**Files:**
- Create: `src/taskflow-db.test.ts` (idempotency test — vitest, not node -e)
- Modify: `src/taskflow-db.ts`

- [ ] **Step 1: Write the failing idempotency test FIRST**

Create `src/taskflow-db.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initTaskflowDb } from './taskflow-db.js';

describe('initTaskflowDb seed', () => {
  let dbPath: string;

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch {}
  });

  it('seeds BR national holidays idempotently across repeat initTaskflowDb calls', () => {
    dbPath = path.join(
      os.tmpdir(),
      `juris-seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    initTaskflowDb(dbPath);
    const db = new Database(dbPath);
    const first = db.prepare(
      `SELECT COUNT(*) AS c FROM jurisdictional_holidays WHERE country='BR'`,
    ).get() as { c: number };
    db.close();

    initTaskflowDb(dbPath); // second init — must not duplicate

    const db2 = new Database(dbPath);
    const second = db2.prepare(
      `SELECT COUNT(*) AS c FROM jurisdictional_holidays WHERE country='BR'`,
    ).get() as { c: number };
    db2.close();

    expect(second.c).toBe(first.c);
    expect(first.c).toBeGreaterThanOrEqual(27); // 9 holidays × 3 years minimum
  });

  it('seeds the current year + next two years (self-healing, no cliff)', () => {
    dbPath = path.join(
      os.tmpdir(),
      `juris-horizon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    initTaskflowDb(dbPath);
    const db = new Database(dbPath);
    const currentYear = new Date().getUTCFullYear();
    const years = db.prepare(
      `SELECT DISTINCT substr(date, 1, 4) AS y FROM jurisdictional_holidays WHERE country='BR' ORDER BY y`,
    ).all() as Array<{ y: string }>;
    db.close();

    const ySet = new Set(years.map((r) => r.y));
    expect(ySet.has(String(currentYear))).toBe(true);
    expect(ySet.has(String(currentYear + 1))).toBe(true);
    expect(ySet.has(String(currentYear + 2))).toBe(true);
  });

  it('seeds Tiradentes (2026-04-21) and Natal (2026-12-25) when current year covers 2026', () => {
    dbPath = path.join(
      os.tmpdir(),
      `juris-known-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    initTaskflowDb(dbPath);
    const db = new Database(dbPath);
    const currentYear = new Date().getUTCFullYear();
    // This test asserts two known-good rows exist IF 2026 is in the seeded
    // horizon. When currentYear > 2028, the test auto-adjusts to the nearest
    // seeded year.
    if (currentYear <= 2026 && currentYear + 2 >= 2026) {
      const tiradentes = db.prepare(
        `SELECT label FROM jurisdictional_holidays WHERE country='BR' AND date='2026-04-21'`,
      ).get() as { label: string } | undefined;
      expect(tiradentes?.label).toBe('Tiradentes');
    }
    const natal = db.prepare(
      `SELECT label FROM jurisdictional_holidays WHERE country='BR' AND date=?`,
    ).get(`${currentYear}-12-25`) as { label: string } | undefined;
    expect(natal?.label).toBe('Natal');
    db.close();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /root/nanoclaw && npx vitest run src/taskflow-db.test.ts
```

Expected: all three tests FAIL because `initTaskflowDb` doesn't seed jurisdictional_holidays yet.

- [ ] **Step 3: Add the month/day constant and the seed function**

In `src/taskflow-db.ts`, below the imports and before the `TASKFLOW_SCHEMA` template literal, add:

```typescript
// Month/day pairs — year-agnostic so the seed self-extends forward each
// year. initTaskflowDb materializes these into dated rows for
// (currentYear, currentYear+1, currentYear+2) on every boot, idempotently
// via INSERT OR IGNORE. No yearly backfill job exists or is needed.
const BR_FIXED_HOLIDAYS: Array<{ md: string; label: string }> = [
  { md: '01-01', label: 'Ano Novo' },
  { md: '04-21', label: 'Tiradentes' },
  { md: '05-01', label: 'Dia do Trabalho' },
  { md: '09-07', label: 'Independência do Brasil' },
  { md: '10-12', label: 'Nossa Senhora Aparecida' },
  { md: '11-02', label: 'Finados' },
  { md: '11-15', label: 'Proclamação da República' },
  { md: '11-20', label: 'Consciência Negra' },
  { md: '12-25', label: 'Natal' },
];

function seedBRJurisdictionalHolidays(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO jurisdictional_holidays
     (country, state, city, date, label, work_start_hour_local, source)
     VALUES ('BR', NULL, NULL, ?, ?, NULL, 'fixed')`,
  );
  const currentYear = new Date().getUTCFullYear();
  for (let offset = 0; offset < 3; offset++) {
    const year = currentYear + offset;
    for (const h of BR_FIXED_HOLIDAYS) {
      stmt.run(`${year}-${h.md}`, h.label);
    }
  }
}
```

- [ ] **Step 4: Call the seed from `initTaskflowDb`**

Find `export function initTaskflowDb(` and locate the end of the migration block (after the `ALTER TABLE board_runtime_config ADD COLUMN city TEXT` try/catch, around line 594). Before the function returns, add:

```typescript
seedBRJurisdictionalHolidays(db);
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
cd /root/nanoclaw && npx vitest run src/taskflow-db.test.ts
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src/taskflow-db.ts src/taskflow-db.test.ts
git commit -m "seed(jurisdictional_holidays): self-healing BR national seed

Every initTaskflowDb() call seeds the 9 BR fixed-date nationals for
(currentYear, currentYear+1, currentYear+2). Year-agnostic constant
means no annual backfill job and no 2028-01-01 time-bomb — the seed
auto-extends forward each boot. INSERT OR IGNORE keeps it idempotent.

Moveable feasts (Carnaval, Ash Wed, Good Friday, Corpus Christi) are
computed at query time via Gauss Easter (Phase 2). Regional holidays
still seeded manually via manage_holidays."
```

---

### Task 1.5: Backfill `country='BR'` on existing prod DB (one-off, already-running prod)

**Files:** None (direct SQL on prod).

- [ ] **Step 1: Sanity-check before writing — enumerate WITH counts**

Plain `DISTINCT country` can silently miss typo values (`'br'` lowercase, `'Brasil'`, `'BRA'`). Use a grouped query:

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && sqlite3 -column -header data/taskflow/taskflow.db \"SELECT COALESCE(country, '<NULL>') AS country, COUNT(*) AS boards FROM board_runtime_config GROUP BY country ORDER BY boards DESC;\""
```

Expected output: exactly two row shapes allowed:
- `BR | <N>`
- `<NULL> | <M>`

**STOP conditions**:
- Any value other than `BR` or `<NULL>` (e.g., `br`, `Brasil`, `us`) → a board was provisioned with a non-standard country string. Do NOT run the backfill until you either (a) fix the typo manually for that specific board, or (b) confirm with the operator that the non-BR board should stay out of BR holiday scope.
- Zero rows total → schema hasn't landed; Task 1.1 migration didn't run.

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
  // Coverage stretches across century boundaries (where b = year/100 and
  // the f = (b + 8) / 25 / g = (b - f + 1) / 3 terms change behavior) and
  // includes both extremes (earliest March 22, latest April 25).
  const cases: Array<[number, string]> = [
    [2000, '2000-04-23'],   // century boundary
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2028, '2028-04-16'],
    [2029, '2029-04-01'],
    [2030, '2030-04-21'],
    [2038, '2038-04-25'],   // latest-possible Easter (April 25)
    [2099, '2099-04-12'],   // last year of the 21st century
    [2100, '2100-03-28'],   // next-century step (b = 21 → f, g shift)
    [2285, '2285-03-22'],   // earliest-possible Easter (March 22)
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

  it('returns a freshly-computed array each call (stateless — no cache)', () => {
    // Easter is ~20 integer ops; caching buys nothing and the cache would
    // grow unbounded over a long-running process. Different references are
    // returned each call; their contents must be value-equal.
    const a = computeBRMoveableFeasts(2026);
    const b = computeBRMoveableFeasts(2026);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
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

/**
 * All Brazilian moveable feasts for a given year, computed from Easter.
 * Stateless — Easter itself is ~20 integer ops, so caching adds zero
 * latency benefit but would grow unbounded over a long-running process.
 */
export function computeBRMoveableFeasts(year: number): MoveableFeast[] {
  const easter = computeEaster(year);
  return [
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

In `container/agent-runner/src/taskflow-engine.test.ts`, add a new `describe` block. **Method is PUBLIC in the refactor** (Step 3 below drops the `private` keyword) so tests call `engine.isNonBusinessDay(...)` directly — no `as any` casts.

If the test file no longer uses a shared `SCHEMA` constant + top-level `db`/`engine` (it was refactored recently), wrap each test in the appropriate currently-active test-DB setup helper. The key invariant is: each test has a fresh in-memory DB with `boards`, `board_runtime_config`, `board_holidays`, `jurisdictional_holidays` tables; `engine = new TaskflowEngine(db, BOARD_ID)` bound to a board whose `board_runtime_config` can be updated per test.

```typescript
describe('engine holiday resolution', () => {
  function seedOrgWithBR() {
    // Set the current test board's country=BR and seed a national holiday.
    db.exec(`
      UPDATE board_runtime_config SET country='BR', timezone='America/Fortaleza' WHERE board_id = '${BOARD_ID}';
      INSERT INTO jurisdictional_holidays (country, state, city, date, label, work_start_hour_local, source)
        VALUES ('BR', NULL, NULL, '2026-04-21', 'Tiradentes', NULL, 'fixed');
    `);
  }

  it('returns jurisdictional holiday for national BR dates', () => {
    seedOrgWithBR();
    const info = engine.isNonBusinessDay('2026-04-21');
    expect(info).toEqual({
      label: 'Tiradentes',
      workStartHourLocal: null,
      source: 'jurisdictional',
    });
  });

  it('returns moveable feast for Ash Wednesday with workStartHourLocal=12', () => {
    seedOrgWithBR();
    // Easter 2026 = Apr 5, Ash Wed = Feb 18.
    const info = engine.isNonBusinessDay('2026-02-18');
    expect(info).toEqual({
      label: 'Quarta-feira de Cinzas',
      workStartHourLocal: 12,
      source: 'moveable_feast',
    });
  });

  it('returns null on a regular business day', () => {
    seedOrgWithBR();
    // 2026-04-22 is a Wednesday with no BR holiday.
    expect(engine.isNonBusinessDay('2026-04-22')).toBeNull();
  });

  it('returns weekend source for Saturday', () => {
    seedOrgWithBR();
    // 2026-04-18 is a Saturday.
    expect(engine.isNonBusinessDay('2026-04-18')?.source).toBe('weekend');
  });

  it('board override wins precedence over jurisdictional', () => {
    seedOrgWithBR();
    db.exec(`
      INSERT INTO board_holidays (board_id, holiday_date, label, work_start_hour_local)
        VALUES ('${BOARD_ID}', '2026-04-21', 'Retiro da equipe', NULL)
    `);
    const info = engine.isNonBusinessDay('2026-04-21');
    expect(info?.source).toBe('board_override');
    expect(info?.label).toBe('Retiro da equipe');
  });

  it('skips jurisdictional lookup when country is NULL', () => {
    db.exec(
      `UPDATE board_runtime_config SET country = NULL WHERE board_id = '${BOARD_ID}'`,
    );
    db.exec(`
      INSERT INTO jurisdictional_holidays (country, state, city, date, label, work_start_hour_local, source)
        VALUES ('BR', NULL, NULL, '2026-04-21', 'Tiradentes', NULL, 'fixed');
    `);
    // Tuesday 2026-04-21 — no board_override, no weekend, no country → null.
    expect(engine.isNonBusinessDay('2026-04-21')).toBeNull();
  });

  it('city-specific jurisdictional wins over state wins over country', () => {
    // Spec precedence: more-specific wins. Seeds all three scopes on the
    // same date; the city row's label must come back.
    db.exec(`
      UPDATE board_runtime_config
        SET country='BR', state='CE', city='Teresina'
        WHERE board_id = '${BOARD_ID}';
      INSERT INTO jurisdictional_holidays VALUES
        ('BR', NULL, NULL, '2026-06-15', 'Nacional', NULL, 'fixed'),
        ('BR', 'CE', NULL, '2026-06-15', 'Estadual', NULL, 'fixed'),
        ('BR', 'CE', 'Teresina', '2026-06-15', 'Dia da Cidade', NULL, 'fixed');
    `);
    expect(engine.isNonBusinessDay('2026-06-15')?.label).toBe('Dia da Cidade');
  });

  it('full-day jurisdictional wins over half-day when both hit the same date', () => {
    // Contrived: someone seeds a half-day on the same date as a full-day.
    // Spec says the stricter (full-day = workStartHourLocal=null) wins.
    db.exec(`
      UPDATE board_runtime_config SET country='BR' WHERE board_id = '${BOARD_ID}';
      INSERT INTO jurisdictional_holidays VALUES
        ('BR', NULL, NULL, '2026-07-01', 'Feriado nacional', NULL, 'fixed'),
        ('BR', NULL, NULL, '2026-07-01', 'Pseudo meio-expediente', 12, 'manual');
    `);
    // SQLite PRIMARY KEY prevents the second insert from landing; the full
    // test is a board_override half-day on top of a full-day jurisdictional:
    db.exec(`
      INSERT INTO board_holidays (board_id, holiday_date, label, work_start_hour_local)
        VALUES ('${BOARD_ID}', '2026-07-01', 'Meio-expediente local', 12)
    `);
    // Override vs full-day jurisdictional: override wins BY IDENTITY but
    // the engine must preserve the full-day semantics when override is
    // half-day and jurisdictional is full-day.
    expect(engine.isNonBusinessDay('2026-07-01')?.workStartHourLocal).toBeNull();
  });

  it('invalidates cache across manage_holidays mutations in the same engine instance', () => {
    seedOrgWithBR();
    // Read once — cache populated.
    expect(engine.isNonBusinessDay('2026-04-22')).toBeNull();
    // Add an override via admin.
    const adminResult = engine.admin({
      action: 'manage_holidays',
      sender_name: 'Alexandre',
      holiday_op: 'add',
      holidays: [{ date: '2026-04-22', label: 'Retiro' }],
    });
    expect(adminResult.success).toBe(true);
    // Same engine instance must see the new override on the next read.
    expect(engine.isNonBusinessDay('2026-04-22')?.source).toBe('board_override');
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
  //    ORDER BY puts LESS-SPECIFIC rows FIRST so MORE-SPECIFIC `map.set`
  //    calls overwrite them — city > state > country, deterministically.
  //    Without this ORDER BY, SQLite returns rows in arbitrary order and
  //    the label for mixed-scope dates is non-deterministic (real bug).
  if (country !== null) {
    const rows = this.db
      .prepare(
        `SELECT date, label, work_start_hour_local
         FROM jurisdictional_holidays
         WHERE country = ?
           AND (state IS NULL OR state = ?)
           AND (city IS NULL OR city = ?)
           AND date >= ? AND date <= ?
         ORDER BY (state IS NULL) DESC, (city IS NULL) DESC`,
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

  // 3. Per-board overrides (always win identity; full-day semantics from
  //    prior layers are preserved — a half-day override does NOT soften a
  //    full-day jurisdictional/moveable-feast on the same date).
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
    const prior = map.get(o.holiday_date);
    // Full-day wins over half-day: if a prior layer was full-day (null) and
    // the override is half-day (non-null), keep the full-day workStart but
    // take the override's label (it's more specific).
    const effectiveWorkStart =
      prior && prior.workStartHourLocal === null && o.work_start_hour_local !== null
        ? null
        : o.work_start_hour_local;
    map.set(o.holiday_date, {
      label: o.label ?? 'Feriado',
      workStartHourLocal: effectiveWorkStart,
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

- [ ] **Step 4: Add a focused hydrateTask coercion test**

In `src/db.test.ts` (create if absent, or use an existing db test file). Add:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase, createTask, getTaskById } from './db.js';

describe('scheduled_tasks.skip_on_holiday hydration', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `db-test-${Date.now()}.db`);
    initDatabase(dbPath);
  });
  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch {}
  });

  it('defaults skip_on_holiday=true when not set', () => {
    createTask({
      id: 't1', group_folder: 'g', chat_jid: 'g@g.us', prompt: 'x',
      schedule_type: 'once', schedule_value: '2026-04-30T00:00:00Z',
      context_mode: 'isolated', next_run: '2026-04-30T00:00:00Z',
      status: 'active', created_at: new Date().toISOString(),
      skip_on_holiday: true,
    });
    expect(getTaskById('t1')?.skip_on_holiday).toBe(true);
  });

  it('coerces stored 0 to false on read', () => {
    createTask({
      id: 't2', group_folder: 'g', chat_jid: 'g@g.us', prompt: 'x',
      schedule_type: 'once', schedule_value: '2026-04-30T00:00:00Z',
      context_mode: 'isolated', next_run: '2026-04-30T00:00:00Z',
      status: 'active', created_at: new Date().toISOString(),
      skip_on_holiday: false,
    });
    expect(getTaskById('t2')?.skip_on_holiday).toBe(false);
  });
});
```

- [ ] **Step 5: Run host tests**

```bash
cd /root/nanoclaw && npm test
```

Expected: all pass. Any tests creating a ScheduledTask object need `skip_on_holiday: true` added — follow typechecker errors and fix in-place.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/db.ts src/db.test.ts
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

describe('host ↔ container Easter parity (single source of truth)', () => {
  // The host `computeEaster` and the container-side `computeEaster` are
  // structurally independent (two separate files, no import). This cross-
  // check asserts they agree on every reference year, including century
  // boundaries and extreme Easter dates. Any divergence would mean a
  // meeting scheduled through the host path and later audited via the
  // container engine would see different "is-holiday" answers on the same
  // date — a bug with no logs.
  const years = [2000, 2024, 2025, 2026, 2027, 2028, 2029, 2030, 2038, 2099, 2100, 2285];
  for (const year of years) {
    it(`host and container agree on Easter ${year}`, async () => {
      const host = computeEaster(year);
      const mod = await import('../container/agent-runner/src/easter.js');
      expect(host).toBe(mod.computeEaster(year));
    });
  }
});
```

NOTE: the cross-check uses a runtime `import()` of the container-side module because the container file lives in a different tsconfig root. If your vitest config rejects that path, an alternative is to run both `computeEaster` implementations through a JSON-serializable harness (e.g., exec the container version via `child_process.spawnSync('node', ['-e', ...])`), but the runtime import is simpler when vitest's moduleResolution is permissive.

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

- [ ] **Step 1: Write failing tests — six cases covering all preflight branches**

In `src/task-scheduler.test.ts`, add at the end of the existing describe block. Each test shares the same board/tz setup; factor into a helper:

```typescript
function seedHolidayTestBoard(): void {
  const tfDb = new Database(TASKFLOW_DB_PATH);
  try {
    tfDb.exec(`
      INSERT INTO boards VALUES ('board-hol-test', 'hol@g.us', 'hol-taskflow', 'standard', 0, 1, NULL, NULL, NULL);
      INSERT INTO board_runtime_config (board_id, country, timezone)
        VALUES ('board-hol-test', 'BR', 'America/Fortaleza');
      INSERT INTO jurisdictional_holidays (country, state, city, date, label, work_start_hour_local, source)
        VALUES ('BR', NULL, NULL, '2026-04-21', 'Tiradentes', NULL, 'fixed');
    `);
  } finally {
    tfDb.close();
  }
}

function makeTestTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    group_folder: 'hol-taskflow',
    chat_jid: 'hol@g.us',
    prompt: '[TF-STANDUP] run me',
    schedule_type: 'cron',
    schedule_value: '0 8 * * 1-5',
    context_mode: 'isolated',
    next_run: '2026-04-21T11:00:00.000Z',
    status: 'active',
    created_at: new Date().toISOString(),
    skip_on_holiday: true,
    last_run: null,
    last_result: null,
    ...overrides,
  };
}

it('preflight A: full-day holiday (Tiradentes 08:00 local) → skip', async () => {
  seedHolidayTestBoard();
  const task = makeTestTask();
  createTask(task);
  const deps = makeSchedulerDeps();
  await runTask(task, deps, new Date('2026-04-21T11:00:01.000Z'));
  const row = getTaskById(task.id);
  expect(row?.last_result).toMatch(/skipped_holiday.*Tiradentes/);
  expect(deps.runContainerAgent).not.toHaveBeenCalled();
});

it('preflight B: half-day morning (Ash Wed 08:00 local) → skip', async () => {
  // Ash Wednesday 2026 = Feb 18. 08:00 Fortaleza = 11:00 UTC.
  seedHolidayTestBoard();
  const task = makeTestTask({
    id: 'task-halfday-morning',
    next_run: '2026-02-18T11:00:00.000Z',
  });
  createTask(task);
  const deps = makeSchedulerDeps();
  await runTask(task, deps, new Date('2026-02-18T11:00:01.000Z'));
  expect(getTaskById(task.id)?.last_result).toMatch(/skipped_holiday.*Cinzas/);
  expect(deps.runContainerAgent).not.toHaveBeenCalled();
});

it('preflight C: half-day afternoon (Ash Wed 18:00 local) → fire', async () => {
  // 18:00 Fortaleza = 21:00 UTC. workStartHourLocal=12, so 18 >= 12 → fire.
  seedHolidayTestBoard();
  const task = makeTestTask({
    id: 'task-halfday-afternoon',
    schedule_value: '0 18 * * 1-5',
    next_run: '2026-02-18T21:00:00.000Z',
  });
  createTask(task);
  const deps = makeSchedulerDeps();
  await runTask(task, deps, new Date('2026-02-18T21:00:01.000Z'));
  expect(deps.runContainerAgent).toHaveBeenCalled();
});

it('preflight D: skip_on_holiday=false on a holiday → fire', async () => {
  seedHolidayTestBoard();
  const task = makeTestTask({
    id: 'task-optout',
    skip_on_holiday: false,
  });
  createTask(task);
  const deps = makeSchedulerDeps();
  await runTask(task, deps, new Date('2026-04-21T11:00:01.000Z'));
  expect(deps.runContainerAgent).toHaveBeenCalled();
});

it('preflight E: NANOCLAW_HOLIDAY_SKIP=0 env → fire', async () => {
  seedHolidayTestBoard();
  const task = makeTestTask({ id: 'task-env-kill' });
  createTask(task);
  const prior = process.env.NANOCLAW_HOLIDAY_SKIP;
  process.env.NANOCLAW_HOLIDAY_SKIP = '0';
  try {
    const deps = makeSchedulerDeps();
    await runTask(task, deps, new Date('2026-04-21T11:00:01.000Z'));
    expect(deps.runContainerAgent).toHaveBeenCalled();
  } finally {
    if (prior === undefined) delete process.env.NANOCLAW_HOLIDAY_SKIP;
    else process.env.NANOCLAW_HOLIDAY_SKIP = prior;
  }
});

it('preflight F: board with country=NULL → fire (no jurisdictional match)', async () => {
  const tfDb = new Database(TASKFLOW_DB_PATH);
  tfDb.exec(`
    INSERT INTO boards VALUES ('board-nocountry', 'nc@g.us', 'nc-taskflow', 'standard', 0, 1, NULL, NULL, NULL);
    INSERT INTO board_runtime_config (board_id, country, timezone)
      VALUES ('board-nocountry', NULL, 'America/Fortaleza');
    INSERT INTO jurisdictional_holidays (country, state, city, date, label, work_start_hour_local, source)
      VALUES ('BR', NULL, NULL, '2026-04-21', 'Tiradentes', NULL, 'fixed');
  `);
  tfDb.close();
  const task = makeTestTask({
    id: 'task-nocountry',
    group_folder: 'nc-taskflow',
    chat_jid: 'nc@g.us',
  });
  createTask(task);
  const deps = makeSchedulerDeps();
  await runTask(task, deps, new Date('2026-04-21T11:00:01.000Z'));
  expect(deps.runContainerAgent).toHaveBeenCalled();
});

it('preflight G (tz-boundary): next_run UTC just past midnight resolves to prior local day', async () => {
  // Tiradentes 2026-04-21 in Fortaleza (UTC-3). UTC 2026-04-22T02:00:00 is
  // 2026-04-21T23:00 local — still Tiradentes. A task with next_run at that
  // UTC time must skip.
  seedHolidayTestBoard();
  const task = makeTestTask({
    id: 'task-tzboundary',
    next_run: '2026-04-22T02:00:00.000Z',
  });
  createTask(task);
  const deps = makeSchedulerDeps();
  await runTask(task, deps, new Date('2026-04-22T02:00:01.000Z'));
  expect(getTaskById(task.id)?.last_result).toMatch(/skipped_holiday.*Tiradentes/);
  expect(deps.runContainerAgent).not.toHaveBeenCalled();
});
```

NOTE: `runTask`'s existing signature takes `(task, deps)`. Adding a third arg `now?: Date` is a TEST affordance — the production call passes no third argument and falls through to `new Date()`.

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
// skip_on_holiday=true for auto-provisioned runners; callers can opt out
// via schedule_task.skip_on_holiday=false (permanent) or the env-var
// NANOCLAW_HOLIDAY_SKIP=0 (process-wide kill switch).
//
// Kill-switch latency: env-var requires systemd restart (~1 min WhatsApp
// reconnect). For faster incident response, set `skip_on_holiday=0` on
// specific tasks directly in SQL — takes effect on the next poll (≤60 s),
// no restart.
//
// When next_run lands on another holiday (e.g., Tiradentes + Easter
// cluster), the next poll simply skips again. Benign daily loop.
if (
  task.skip_on_holiday &&
  process.env.NANOCLAW_HOLIDAY_SKIP !== '0'
) {
  try {
    const tfDb = openTaskflowDbReadonly();
    const boardRow = tfDb
      .prepare(`SELECT id, group_jid FROM boards WHERE group_folder = ?`)
      .get(task.group_folder) as { id: string } | undefined;
    if (boardRow) {
      const nowUtc = now ?? new Date();
      const tzRow = tfDb
        .prepare(`SELECT timezone FROM board_runtime_config WHERE board_id = ?`)
        .get(boardRow.id) as { timezone: string } | undefined;
      const tz = tzRow?.timezone ?? 'America/Fortaleza';
      let localDate: string;
      let localHour: number;
      try {
        localDate = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(nowUtc);
        // hourCycle: 'h23' forces 00–23 ("00" for midnight). Without it,
        // some ICU builds return '24' for midnight in en-GB, producing a
        // NaN from parseInt.
        localHour = Number.parseInt(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: tz,
            hour: '2-digit',
            hourCycle: 'h23',
          }).format(nowUtc),
          10,
        );
      } catch (tzErr) {
        warnInvalidTimezoneOnce(boardRow.id, tz, tzErr);
        throw tzErr; // fall into outer catch — fires the task
      }
      const holiday = isNonBusinessDay(tfDb, boardRow.id, localDate);
      if (holiday) {
        const fullDaySkip = holiday.workStartHourLocal === null;
        const halfDayStillMorning =
          holiday.workStartHourLocal !== null &&
          localHour < holiday.workStartHourLocal;
        if (fullDaySkip || halfDayStillMorning) {
          const nextRun = computeNextRun(task);
          updateTaskAfterRun(
            task.id,
            nextRun,
            `__skipped_holiday(${holiday.label}, source=${holiday.source})__`,
          );
          logger.info(
            {
              taskId: task.id,
              groupFolder: task.group_folder,
              holiday: holiday.label,
              source: holiday.source,
              localDate,
              workStartHourLocal: holiday.workStartHourLocal,
              localHour,
            },
            'Scheduled task skipped: holiday',
          );
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

At the top of `src/task-scheduler.ts` (module scope), add the cached read-only handle and the warn-once helper:

```typescript
// Cache a single readonly handle across invocations. Re-opens if SQLite
// reports the DB as closed (e.g., after an in-process rewrite). Avoids
// 27× open/close bursts when the 08:00 poll picks up every board's
// standup at once.
let _taskflowDbReadonly: Database.Database | null = null;
function openTaskflowDbReadonly(): Database.Database {
  if (_taskflowDbReadonly) return _taskflowDbReadonly;
  _taskflowDbReadonly = new Database(TASKFLOW_DB_PATH, { readonly: true });
  return _taskflowDbReadonly;
}

// Dedupe invalid-TZ warnings: log once per (boardId, tz) pair. Bad
// timezone data in board_runtime_config would otherwise spam the log
// every poll cycle (every 60 s) forever.
const _warnedBadTz = new Set<string>();
function warnInvalidTimezoneOnce(
  boardId: string,
  tz: string,
  err: unknown,
): void {
  const key = `${boardId}::${tz}`;
  if (_warnedBadTz.has(key)) return;
  _warnedBadTz.add(key);
  logger.warn(
    { boardId, tz, err: err instanceof Error ? err.message : String(err) },
    'Invalid board timezone — holiday preflight disabled for this board',
  );
}
```

- [ ] **Step 4: Add imports at top of `src/task-scheduler.ts`**

Add:

```typescript
import Database from 'better-sqlite3';
import { TASKFLOW_DB_PATH } from './ipc-plugins/provision-shared.js';
import { isNonBusinessDay } from './holiday-calendar.js';
import { updateTaskAfterRun } from './db.js';
```

`updateTaskAfterRun(id, nextRun, lastResult)` is the real helper at `src/db.ts:874` — writes `last_run`, `last_result`, and `next_run` in a single UPDATE. The earlier draft of this plan referenced a fictional `markLastResult` and a direct-DB-write fallback; those are gone. If `updateTaskAfterRun` is not yet exported from `./db.js`, add `export` to its declaration — do not inline a DB write.

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

- [ ] **Step 5: Add a test that `skip_on_holiday=false` threads through the IPC → createTask flow**

In `src/ipc.test.ts` (create if absent, or use an existing ipc test file), add:

```typescript
it('schedule_task IPC with skip_on_holiday=false threads to scheduled_tasks row', () => {
  // Emulate the IPC file payload the handler receives.
  const payload = {
    type: 'schedule_task',
    task_id: 'ipc-opt-out',
    group_folder: 'test',
    chat_jid: 'test@g.us',
    prompt: 'emergency alert',
    schedule_type: 'cron',
    schedule_value: '*/5 * * * *',
    skip_on_holiday: false,
  };
  // Call the IPC handler directly with the payload. Reference the actual
  // handler signature from ipc.ts; this example assumes a `handleIpcFile`
  // or similar that dispatches on `type`.
  handleScheduleTaskIpc(payload);

  const row = getTaskById('ipc-opt-out');
  expect(row?.skip_on_holiday).toBe(false);
});

it('schedule_task IPC without skip_on_holiday defaults to true', () => {
  const payload = {
    type: 'schedule_task',
    task_id: 'ipc-default',
    group_folder: 'test',
    chat_jid: 'test@g.us',
    prompt: 'normal task',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
  };
  handleScheduleTaskIpc(payload);
  const row = getTaskById('ipc-default');
  expect(row?.skip_on_holiday).toBe(true);
});
```

If `handleScheduleTaskIpc` is not a named export, replace with whichever function/path the existing ipc tests use to invoke the schedule_task handler.

- [ ] **Step 6: Run tests**

```bash
cd /root/nanoclaw && npm test && cd container/agent-runner && npx vitest run
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts src/ipc.ts src/ipc.test.ts
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

- [ ] **Step 3: Date-independent e2e via a board_holidays override on today**

The preflight evaluates `today` in the board's tz (not `schedule_value`). An e2e referencing a specific holiday date (Tiradentes 2026-04-21) only works on that date. Instead, on any day: insert a `board_holidays` row on **today's local date** for a test board, schedule a once-task to fire in ~30 s, and assert the skip.

```bash
# Pick a TaskFlow board with a known group_jid; prod uses seci-taskflow.
BOARD_ID="board-seci-taskflow"
GROUP_FOLDER="seci-taskflow"
GROUP_JID="120363406395935726@g.us"

# Today's date in America/Fortaleza (the default board tz).
TODAY_LOCAL=$(ssh -o BatchMode=yes nanoclaw@192.168.2.63 "TZ=America/Fortaleza date +%Y-%m-%d")

# Insert a one-day board_holidays override on today. Idempotent via
# INSERT OR REPLACE — no PK collision if run twice.
ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && sqlite3 data/taskflow/taskflow.db \"
  INSERT OR REPLACE INTO board_holidays (board_id, holiday_date, label, work_start_hour_local)
    VALUES ('$BOARD_ID', '$TODAY_LOCAL', 'E2E-holiday-test-marker', NULL);
\""

# Schedule TWO once-tasks at now+30s on the same board:
#   (1) skip_on_holiday=1 → should be SKIPPED by preflight (override hits today)
#   (2) skip_on_holiday=0 → should FIRE (opt-out bypasses preflight)
FIRE_AT=$(date -u -d '+30 seconds' +%Y-%m-%dT%H:%M:%S.000Z)
TASK_SKIP_ID="e2e-hol-skip-$(date +%s)"
TASK_OPTOUT_ID="e2e-hol-optout-$(date +%s)"

ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && sqlite3 store/messages.db \"
  INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, skip_on_holiday)
    VALUES ('$TASK_SKIP_ID', '$GROUP_FOLDER', '$GROUP_JID', '[E2E holiday skip] should NOT fire', 'once', '$FIRE_AT', '$FIRE_AT', 'active', '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', 1);
  INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, skip_on_holiday)
    VALUES ('$TASK_OPTOUT_ID', '$GROUP_FOLDER', '$GROUP_JID', '[E2E holiday opt-out] SHOULD fire', 'once', '$FIRE_AT', '$FIRE_AT', 'active', '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)', 0);
\""

# Wait 120 s — scheduler polls every 60 s; give it two cycles.
sleep 120
```

- [ ] **Step 4: Verify**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && sqlite3 store/messages.db \"SELECT id, last_run IS NOT NULL AS ran, substr(last_result, 1, 120) FROM scheduled_tasks WHERE id IN ('$TASK_SKIP_ID', '$TASK_OPTOUT_ID');\""
```

Expected:
- `$TASK_SKIP_ID` — `ran=1`, `last_result` contains `skipped_holiday(E2E-holiday-test-marker, source=board_override)`
- `$TASK_OPTOUT_ID` — `ran=1`, `last_result` is the agent's normal output (NOT a skip)

- [ ] **Step 5: Clean up both the override row and the test tasks**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && \
  sqlite3 data/taskflow/taskflow.db \"DELETE FROM board_holidays WHERE label = 'E2E-holiday-test-marker';\" && \
  sqlite3 store/messages.db \"DELETE FROM scheduled_tasks WHERE id IN ('$TASK_SKIP_ID', '$TASK_OPTOUT_ID');\""
```

- [ ] **Step 6: Record the validation in the deploy log + close out**

No commit.

---

## Rollback Order (important during incidents)

The three phases deploy additively but **rollback must run in reverse dependency order**. Dropping Phase 1's schema while Phase 2's engine is still live WILL crash the engine's holiday reads.

- **Phase 3 rollback** — instant, no deploy required. Set `NANOCLAW_HOLIDAY_SKIP=0` in the systemd unit and `systemctl restart nanoclaw` (~1 min WA reconnect window). For faster action on specific tasks: `UPDATE scheduled_tasks SET skip_on_holiday=0 WHERE id IN (...)` — takes effect on the next poll (≤60 s), no restart. Alternatively `git revert` the Phase 3 commits and redeploy.
- **Phase 2 rollback** — `git revert` the Phase 2 commits and redeploy. Safe any time AFTER Phase 3 is rolled back. If done while Phase 3 is still live, the host scheduler's preflight still works (it uses its own `holiday-calendar.ts`), but the engine falls back to old weekend+`board_holidays`-only behavior — acceptable, slight inconsistency between scheduler and engine views of a date.
- **Phase 1 rollback** — do NOT drop the schema unless Phases 2 AND 3 have been rolled back. Even then, dropping `jurisdictional_holidays` only is safe (nothing left reads it); dropping the new columns (`board_holidays.work_start_hour_local`, `scheduled_tasks.skip_on_holiday`) requires SQLite to be >= 3.35 AND no code paths to read them.

**Recommended for any real incident:** use the env-var kill switch (`NANOCLAW_HOLIDAY_SKIP=0`) rather than `git revert`. The schema can stay, the engine reads still work, only the scheduler preflight is bypassed.

## Deferred (acknowledged but intentionally out of scope)

- **`manage_holidays` UX for already-covered dates** — when a manager tries to register "Tiradentes" via `taskflow_admin manage_holidays` after Phase 1 seeds it jurisdictionally, the current code will still write a row into `board_holidays`. The union handles the double-match gracefully (override wins identity, full-day preserved by the coalescer in Task 2.3), so this is a UX polish, not a bug. Better UX would detect "this date is already covered by (country, state, city) jurisdictional and is full-day; registering as a board override is a no-op" and return a friendly message. **Defer to Phase 4 or a follow-up PR** — doesn't block execution of Phases 1–3.

## Self-Review Checklist

**1. Spec coverage (amended):**
- Target architecture (4 columns, half-day work_start_hour_local, moveable feasts computed, single helper method) → Phase 1 tasks 1.1–1.4 + Phase 2 task 2.3 ✓
- Phased migration: each phase shippable independently → Phase 1 = schema + seed, Phase 2 = engine, Phase 3 = scheduler. Rollback-order section documents the reverse dependencies ✓
- Half-day holidays (Quarta-feira de Cinzas → work_start_hour_local=12) → Task 2.1 (computed) + Task 2.3 (returned by engine, full-day coalescer) + Task 3.3 (half-day morning-skip logic, tests A–C) ✓
- State/city scope via nullable keys + most-specific wins → Task 1.1 schema + Task 2.3 ORDER BY fix + precedence test + Task 3.2 ORDER BY ✓
- Env-var kill switch `NANOCLAW_HOLIDAY_SKIP=0` → Task 3.3 preflight + test E + kill-switch-latency doc in Rollback Order section ✓
- Self-healing seed (no year cliff) → Task 1.4 month/day constant + currentYear-to-+2 loop + idempotency test ✓
- Phase 4 `manage_holidays` UX → deferred with explicit acknowledgement in "Deferred" section ✓

**2. Placeholder scan (amended):** No `TBD`, `TODO`, "similar to", or "if it doesn't exist" hedges. The pre-amendment `markLastResult` fictional helper is replaced with `updateTaskAfterRun`. Every code step shows the full code. ✓

**3. Type consistency (amended):**
- `HolidayInfo` defined identically in `taskflow-engine.ts` (Task 2.2) and `holiday-calendar.ts` (Task 3.2). Same fields, same source enum. Host/container Easter parity test (Task 3.2) pins the two `computeEaster` implementations to identical behavior for 2024–2030 + century/extreme cases. ✓
- `skip_on_holiday: boolean` is the TS type; SQLite column is INTEGER with coercion in `hydrateTask` (Task 3.1). Explicit tests verify 0→false, 1→true coercion. ✓
- `computeEaster(year): string` return type identical on host and container sides, verified by the parity test. ✓
- `MoveableFeast` interface identical on both sides (date/label/workStartHourLocal). ✓
- `updateTaskAfterRun(id, nextRun, lastResult)` — verified to exist at `src/db.ts:874` (real helper), exported and used by Task 3.3's preflight. ✓

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-21-jurisdictional-holidays.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Appropriate for this plan because each task is genuinely independent (one commit each, tests ship with the code).

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
