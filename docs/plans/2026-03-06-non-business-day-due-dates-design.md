# Non-Business Day Due Date Confirmation

**Date:** 2026-03-06
**Status:** Approved

## Problem

When a task's due date falls on a weekend or holiday, no one is working — the deadline is effectively meaningless. The engine should catch this and suggest the next business day.

## Design

### Database

New table for per-board holidays:

```sql
CREATE TABLE board_holidays (
  board_id TEXT NOT NULL,
  holiday_date TEXT NOT NULL,  -- YYYY-MM-DD
  label TEXT,                   -- optional: "Carnaval", "Tiradentes"
  PRIMARY KEY (board_id, holiday_date)
);
```

### Engine Helper Functions

```typescript
private isNonBusinessDay(dateStr: string): { weekend: boolean, holiday: boolean, label?: string }
private getNextBusinessDay(dateStr: string): string  // skips weekends AND holidays
```

### Due Date Validation (create, update)

When due date falls on weekend or holiday and `allow_non_business_day !== true`, return early:

```typescript
{
  success: false,
  non_business_day_warning: true,
  original_date: '2026-02-16',
  suggested_date: '2026-02-18',
  reason: 'feriado (Carnaval)',        // or 'sábado', 'domingo'
  error: 'Due date falls on Carnaval (16/02). Suggest 2026-02-18 (quarta-feira).'
}
```

Task is NOT created/updated. Agent re-calls with either `due_date: suggested_date` or `due_date: original_date, allow_non_business_day: true`.

### Parameter Changes

`create()` and `update()` params gain:

```typescript
allow_non_business_day?: boolean  // force weekend/holiday date
```

### Recurring Task Auto-Advance

`advanceRecurringTask()` auto-shifts to next business day silently — no user in the loop.

### Admin Actions

New `admin()` action `manage_holidays` with three operations:

**Add individual holidays:**
```typescript
engine.admin({ action: 'manage_holidays', operation: 'add',
  holidays: [{ date: '2026-02-16', label: 'Carnaval' }] })
```

**Remove holidays:**
```typescript
engine.admin({ action: 'manage_holidays', operation: 'remove',
  dates: ['2026-02-16'] })
```

**Bulk set (replaces all for given year):**
```typescript
engine.admin({ action: 'manage_holidays', operation: 'set_year',
  year: 2026,
  holidays: [
    { date: '2026-01-01', label: 'Confraternização' },
    { date: '2026-02-16', label: 'Carnaval' },
    { date: '2026-02-17', label: 'Carnaval' },
  ]})
```

**List holidays:**
```typescript
engine.admin({ action: 'manage_holidays', operation: 'list', year: 2026 })
// Returns { success: true, holidays: [{ date, label }] }
```

### CLAUDE.md Agent Instructions

```markdown
## Non-Business Day Due Dates
When engine returns `non_business_day_warning: true`, ask the user:
"A data limite cai em [reason] ([date]). Deseja mover para [suggested_date] ([weekday])?"
- User confirms → re-submit with suggested_date
- User insists → re-submit with allow_non_business_day: true

## Managing Holidays
Managers can set holidays via admin commands.
```

### Test Coverage

- Weekend (Sat/Sun) → warning with next business day
- Holiday → warning with label in reason
- Holiday on Friday + weekend → suggests Monday
- Holiday on Monday after weekend → suggests Tuesday
- `allow_non_business_day: true` → bypasses check
- Recurring auto-advance skips non-business days
- `manage_holidays` add/remove/set_year/list
- No due date → no check
- Weekday non-holiday → no check
