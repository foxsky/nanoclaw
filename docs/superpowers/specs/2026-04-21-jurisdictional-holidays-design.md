# Jurisdictional holidays — design

**Status:** design approved conversationally 2026-04-21, awaiting implementation-plan.

## Problem

On 2026-04-21 (Tiradentes, Brazilian national holiday, Tuesday), every TaskFlow board's scheduled runners fired as usual:

- 27 standups at 08:00 local
- 25 digests at 18:00 local

The engine has a `board_holidays` table and a `checkNonBusinessDay()` function that consults it — but the scheduler dispatcher never calls it, and 9 of 27 boards in production don't have Tiradentes registered anyway. Manually seeding a public holiday on every board in the org is a maintenance chore that drifts by construction.

## Root cause

`board_holidays` conflates two independent concerns:

1. **Jurisdictional calendar** — national/state/city holidays defined by public law. Same for every board in a given country (state, city). Should not be per-board.
2. **Per-board exceptions** — team retreat, launch freeze. Genuinely per-board.

`board_runtime_config` already has `country`, `state`, `city` columns, so the schema's intent was jurisdictional. `board_holidays` became the manual workaround because no derivation logic was built.

## Target architecture

### Data model

**New table — source of truth for public holidays.**

```sql
CREATE TABLE IF NOT EXISTS jurisdictional_holidays (
  country TEXT NOT NULL,              -- e.g. 'BR'
  state TEXT,                         -- NULL = country-wide; 'CE' = Ceará-only
  city TEXT,                          -- NULL = state/country-wide; 'Teresina' = city-specific
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  label TEXT NOT NULL,                -- 'Tiradentes', 'Quarta-feira de Cinzas'
  work_start_hour_local INTEGER,      -- NULL = full day off; 12 = half-day starting at 12:00 local
  source TEXT DEFAULT 'manual',       -- 'fixed' | 'easter' | 'manual' — for audit/regen
  PRIMARY KEY (country, state, city, date)
);
```

**Repurposed — `board_holidays` becomes overrides-only.**

Add `work_start_hour_local INTEGER NULL` column. Semantics: a row here represents a board-specific exception (or a pre-migration legacy entry). Union'd with jurisdictional at read time. Managers keep using `taskflow_admin manage_holidays`, but the operation now targets board exceptions only — registering a public holiday here is a no-op (the jurisdictional table already covers it). UX: return a friendly "already covered by national/state calendar" confirmation instead of double-writing.

**Scheduler opt-out column.**

```sql
ALTER TABLE scheduled_tasks ADD COLUMN skip_on_holiday INTEGER DEFAULT 1;
```

Auto-provisioned standup/digest/review runners get `1` (skip on holiday). User-created scheduled tasks default to 1 but can pass `skip_on_holiday: false` at `schedule_task` creation for always-fire behavior (emergency notifications, external reminders, etc.).

### Moveable feasts

Brazilian holidays derived from Easter are NOT stored — they're computed per-year from the Gauss algorithm:

```
Sexta-Feira Santa     = Easter − 2 days
Páscoa (Easter)       = computed (Gauss)
Corpus Christi        = Easter + 60 days
Quarta-feira de Cinzas = Easter − 46 days  (HALF-DAY, work_start_hour_local=12)
Carnaval (Mon, Tue)   = Easter − 48, −47 days (national, sometimes half-day by state)
```

Computed once per audit/query, cached in-memory by year. No yearly backfill job.

### The one read-path helper

Single method on `TaskflowEngine`:

```ts
type HolidayInfo = {
  label: string;                  // 'Tiradentes'
  workStartHourLocal: number | null;  // null = full day, 12 = half-day starting noon
  source: 'jurisdictional' | 'board_override' | 'weekend';
};

isNonBusinessDay(boardId: string, localDate: string): HolidayInfo | null;
```

Returns `null` if it's a normal business day. Returns `HolidayInfo` if any of:

1. Saturday or Sunday in the board's timezone → `{ source: 'weekend', workStartHourLocal: null }`.
2. A jurisdictional row matches `(country, state|NULL, city|NULL, date)` against the board's `runtime_config`. Most-specific match wins the label; if both full-day and half-day rows exist for the same date, full-day wins (most restrictive).
3. A moveable feast falls on that date and board is country='BR'.
4. A `board_holidays` override exists for that board on that date.

Precedence for label: board override > jurisdictional specific (city > state > country) > moveable feast > weekend.

All existing callers — `checkNonBusinessDay` (meeting `scheduled_at` / task `due_date` guards), the soon-to-be-added scheduler preflight — use this single helper.

### Scheduler preflight

`task-scheduler.ts` before each scheduled_task fire:

```
1. Read scheduled_tasks row. If skip_on_holiday = 0, fire normally.
2. Resolve board_id from group_folder.
3. Compute localDate = cron's intended fire time in board's tz.
4. holiday = engine.isNonBusinessDay(boardId, localDate)
5. If holiday is null → fire normally.
6. If holiday.workStartHourLocal is null (full day):
     log 'skipped_holiday(label)', advance next_run to next cron slot past today, return.
7. If holiday.workStartHourLocal is set (half day):
     if cron's hour < workStartHourLocal → skip (same as full-day skip).
     else → fire normally (standup at 08:00 on Ash Wed skips; digest at 18:00 fires).
```

### Env-var kill switch

`NANOCLAW_HOLIDAY_SKIP=0` forces all scheduled tasks to fire regardless of holiday calendar. Incident-response escape hatch — someone needs every team standup to fire on a holiday because a deploy rollback requires team acknowledgment. Default = unset = respect calendar.

## Design decisions

### Why a single `jurisdictional_holidays` table vs. hardcoded-in-code

Hardcoded was tempting (zero migration), but:

- Regional holidays (state, city) need to be user-editable — a city founding day isn't something we seed centrally.
- Corrections/additions shouldn't require a redeploy.
- Audit/display: users should be able to see "which holidays affect my board's calendar" without reading source.

Fixed national holidays + moveable feasts get seeded by the init migration (idempotent). Users/admins add state/city rows via an expanded `manage_holidays` action (scoped by country/state/city) as needed. Per-board overrides stay in `board_holidays`.

### Why half-day via `work_start_hour_local`

Ash Wednesday in Brazil starts at 12:00. We could model this as:

- (a) A boolean `half_day INTEGER DEFAULT 0` with the start time hardcoded → brittle (what about other countries' half-day rules?)
- (b) `work_start_hour_local INTEGER NULL` → simple, generalizes, handles the "fire tasks scheduled after noon" logic directly.

Going with (b). Start time is in LOCAL hour (0–23); the scheduler already has the board's timezone from `board_runtime_config`. No DST issues because we compare hours not minutes.

End-of-day is always 23:59 local when `work_start_hour_local` is set — the half means "morning off, afternoon on." Other shapes (morning on, afternoon off) don't exist in BR public holidays; if they ever do, add a `work_end_hour_local` column.

### State/city scope handled via nullable keys

All three scoping levels — country-wide, state-wide, city-specific — live in one table with nullable `state`/`city`. A lookup for (country='BR', state='CE', city='Teresina', date='2026-06-15') matches any of:

- `(BR, NULL, NULL, 2026-06-15)` — a national holiday
- `(BR, CE, NULL, 2026-06-15)` — a Ceará-state holiday
- `(BR, CE, Teresina, 2026-06-15)` — a Teresina city holiday

If multiple rows match, the most specific (city > state > country) wins for label. If any match is full-day, it's full-day.

### Why leave `board_holidays` in place (vs. migrate all rows to `jurisdictional_holidays`)

- Truly per-board overrides (team retreat) don't belong in the jurisdictional table.
- Existing rows may include regional or per-board facts we can't cleanly reclassify — audit/cleanup is Phase 4, optional.
- Keeping both tables keeps the read-path simple (union them) without a destructive migration.

## Migration phases

Each phase is independently shippable with its own rollback.

### Phase 1 — schema + seed (safe, additive, zero behavior change)

1. `src/taskflow-db.ts`: add `CREATE TABLE jurisdictional_holidays (...)` and `CREATE INDEX` on `(country, date)`. Add `ALTER TABLE scheduled_tasks ADD COLUMN skip_on_holiday INTEGER DEFAULT 1` wrapped in try/catch (like other ALTERs). Add `ALTER TABLE board_holidays ADD COLUMN work_start_hour_local INTEGER` (idempotent).
2. Add idempotent seed for BR 2026–2027 fixed-date national holidays:
   - Ano Novo 01-01, Tiradentes 04-21, Trabalho 05-01, Independência 09-07, N. Sra. Aparecida 10-12, Finados 11-02, Proclamação 11-15, Consciência Negra 11-20, Natal 12-25
   - All with `source='fixed'`, `state=NULL`, `city=NULL`, `work_start_hour_local=NULL`
3. Sanity-check prod: `SELECT DISTINCT country FROM board_runtime_config` — confirm BR-only. Then backfill any NULL country rows to 'BR': `UPDATE board_runtime_config SET country='BR' WHERE country IS NULL`.
4. No read-path integration yet. Engine still uses old `checkNonBusinessDay`. Rollback = drop table + column, no behavior change.

### Phase 2 — read-path integration

1. Add `computeBRMoveableHolidays(year: number): {date: string; label: string; workStartHourLocal: number | null}[]` to taskflow-engine.ts. Uses Gauss's Easter algorithm. In-memory cache keyed by year.
2. Add `isNonBusinessDay(boardId, localDate): HolidayInfo | null` on `TaskflowEngine`. Weekend check → jurisdictional SQL → moveable feasts (BR only) → `board_holidays` override.
3. Switch existing `checkNonBusinessDay` to use the new helper. The meeting `scheduled_at` / task `due_date` guards now respect the full union.
4. Tests:
   - Gauss algorithm against Easter dates 2024–2030 (known).
   - Ash Wednesday 2026 (Feb 17) returns `workStartHourLocal=12`.
   - Tiradentes 2026 returns full day.
   - Saturday/Sunday in board tz return weekend source.
   - Board with country=NULL returns null (no jurisdictional match) — logs warning.
   - Board override wins precedence test.
5. Deploy. Rollback = revert one file.

### Phase 3 — scheduler preflight

1. `src/task-scheduler.ts`: before dispatching each scheduled_task, read its row (including new `skip_on_holiday`), resolve board_id, call `engine.isNonBusinessDay(boardId, todayLocal)`. Apply the logic table in the target-architecture section.
2. When skipping: write `last_run = now`, `last_result = '__skipped_holiday(Tiradentes)__'`, advance `next_run` to the next cron slot past today. Log at INFO level.
3. Expose `skip_on_holiday` in the `schedule_task` IPC tool Zod schema (optional boolean, defaults true). When false, scheduler preflight is bypassed.
4. Tests:
   - Scheduled task cron'd at 08:00 local on Tiradentes → not fired, next_run advanced.
   - Scheduled task cron'd at 18:00 local on Ash Wed → fired (after half-day start).
   - Scheduled task cron'd at 08:00 local on Ash Wed → not fired (before half-day start).
   - `skip_on_holiday=0` task on Tiradentes → fired.
   - `NANOCLAW_HOLIDAY_SKIP=0` env → all tasks fire regardless.
5. Live e2e: schedule a one-shot task for today (still Tiradentes in this scenario), verify it doesn't fire; flip to `skip_on_holiday=0`, verify it does.
6. Deploy. Rollback = env var kill switch + one-file revert.

### Phase 4 — data cleanup (optional, defer)

1. Audit: which `board_holidays` rows duplicate a jurisdictional entry? `SELECT bh.* FROM board_holidays bh JOIN board_runtime_config brc ON brc.board_id=bh.board_id JOIN jurisdictional_holidays jh ON jh.country=brc.country AND (jh.state IS NULL OR jh.state=brc.state) AND (jh.city IS NULL OR jh.city=brc.city) AND jh.date=bh.holiday_date`.
2. Delete those — they're redundant after Phase 2. Leave truly per-board overrides alone.
3. Purely cosmetic; doesn't affect behavior.

## Edge cases

| Case | Behavior |
|---|---|
| Board has `country='BR'`, `state=NULL`, and state-only holiday exists for that date | No match (state IS NULL in lookup doesn't match state='CE'); only country-wide rows match. Expected — state can't be inferred. |
| `country=NULL` on a board | Jurisdictional lookup skipped; warning logged. Only weekend and per-board override apply. Prod fix: backfill country before Phase 2. |
| Manager registers "Tiradentes" via `manage_holidays` after Phase 2 | Still writes to `board_holidays` — union handles the double-match. Template update (future) should detect this and skip. |
| Double-match (jurisdictional + board override same date) | Union returns one hit. Label precedence: override > specific jurisdictional > less-specific. Full-day wins over half-day if conflicting. |
| User wants team to work on a holiday | `scheduled_tasks.skip_on_holiday=0` per-task OR env-var global override. |
| Moveable feast off by one year (e.g. cache stale) | In-memory cache keyed by year — invalidates automatically on year rollover. |
| Board with `city='teresina'` (lowercase) vs. jurisdictional row `city='Teresina'` | Use `LOWER()` on both sides in the lookup SQL. Test with mixed-case fixture. |
| DST transition date | BR doesn't observe DST since 2019. If reintroduced, `work_start_hour_local` is LOCAL hour and already respects tz — no extra work. |

## Out of scope

- Non-BR jurisdictions. Moveable-feast algorithm is BR-specific (relies on Gauss Easter + BR-specific offsets). Other countries would need their own `compute<Country>MoveableHolidays(year)` and their own seed.
- Automatic state/city holiday seeding. Phase 1 seeds national only. Regional rows get added as users register them via `manage_holidays`.
- Recurring board exceptions (e.g. "every first Friday is team-building, no meetings"). Stays deferred — `board_holidays` only stores explicit dates.
- Work-end-hour half days (morning on, afternoon off). Not observed in BR public holidays.
- Holiday calendar UI. Managers use `manage_holidays` via chat; no dashboard.

## Open questions

None — the four questions posed 2026-04-21 were answered inline:

1. State/city scope: yes, different states/cities matter → nullable keys in `jurisdictional_holidays`.
2. Half-day holidays: yes, Quarta-feira de Cinzas → `work_start_hour_local` column on both tables.
3. (skipped — `manage_holidays` UX is part of Phase 2/3, not blocking design)
4. Spec doc written to this file.
