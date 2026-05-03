# 16 — schedule_task: cron, DST, recurrence, catch-up

**Date:** 2026-05-03
**Branch:** `remotes/upstream/v2` @ HEAD
**Sources:** `container/agent-runner/src/mcp-tools/scheduling.ts` (299 LOC),
`container/agent-runner/src/timezone.ts` (107 LOC),
`src/modules/scheduling/{actions,db,recurrence,index}.ts`,
`src/host-sweep.ts`, `src/db/session-db.ts`,
`container/agent-runner/src/scheduling/task-script.ts`,
`.claude/skills/migrate-from-openclaw/MIGRATE_CRONS.md`

## TL;DR (verdict)

| Question | v1 (current) | v2 |
|---|---|---|
| Cron library | `cron-parser ^5.5.0` | `cron-parser ^5.0.0` (same major) |
| Cron eval | `interval.next()` | `interval.next()` |
| Cron timezone | `{ tz: TIMEZONE }` | `{ tz: TIMEZONE }` (host config.ts) |
| **DST handling** | cron-parser native (skip-spring / repeat-fall, **library-determined**) | **same library, same behavior** |
| **Catch-up on downtime** | `getDueTasks()` finds rows where `next_run <= now`, then runs **once** and recomputes from now → **fires once, then advances past missed slots** | `countDueMessages()` `WHERE process_after <= now`, container claims and runs **once**, recurrence inserts the next row from `interval.next()` (which is computed at recurrence time, i.e. **now**) → **fires once, advances past missed slots** |
| Storage | central `store/messages.db` table `scheduled_tasks` | per-session `data/v2-sessions/{ag}/{sid}/inbound.db` table `messages_in` with `kind='task'` |
| Pre-agent script | yes (`script` column, run by `container-runner.ts`) | yes (`scheduling/task-script.ts`, `applyPreTaskScripts` in poll-loop) |
| Once tasks with non-round minutes | yes (free-form `next_run` ISO) | yes (`processAfter` ISO; arbitrary precision) |
| One-shot `processAfter` of 7h30 | yes | **yes — naive ISO `2026-XX-XX T07:30:00` is interpreted in TZ correctly via `parseZonedToUtc`** |

**For Fortaleza (no DST since 2019):** behavior is identical between v1 and v2 — both libraries do exactly `interval.next()` in `America/Fortaleza`.

**For our 89-row migration:** v2 stores tasks in **per-session inbound.db**, NOT a central table. Each board needs (a) an `agent_groups` row, (b) an active `sessions` row, then (c) `INSERT INTO {sessionInboundDb}.messages_in` per task. **A 1:N migration script that just hits one DB does not work.**

---

## 1. `schedule_task` MCP signature

`container/agent-runner/src/mcp-tools/scheduling.ts:33-103`.

```ts
inputSchema: {
  type: 'object',
  properties: {
    prompt:       { type: 'string' },
    processAfter: { type: 'string', /* ISO 8601, naive→TZ or Z/offset→UTC */ },
    recurrence:   { type: 'string', /* cron expression in user TZ */ },
    script:       { type: 'string', /* optional pre-agent bash */ },
  },
  required: ['prompt', 'processAfter'],
}
```

Validation:
- `prompt && processAfter` are required (early return `err`).
- `processAfter` is parsed via `parseZonedToUtc(input, TIMEZONE)`. If the resulting `Date` is `NaN` → `err('invalid processAfter')`.
- `recurrence` is **NOT validated at insert time**. The string is forwarded as-is to `messages_in.recurrence`. Bad cron expressions only blow up later, on the sweep tick that calls `CronExpressionParser.parse(...)`. The `try/catch` in `recurrence.ts:32-50` logs and continues — the task is **not auto-paused**, the row stays in `completed` state with a non-null `recurrence` and silently never fires again because `clearRecurrence` only runs after a successful insert. (Compare v1 `task-scheduler.ts:152-170` which pauses on bad cron.)
- `script` is forwarded raw. No validation of bash syntax.

Submit path: container writes a `kind='system'` row to **outbound.db** with `content = JSON.stringify({ action:'schedule_task', taskId, prompt, script, processAfter, recurrence })`. Host's delivery pipe reads it, dispatches via `actionHandlers` registry to `handleScheduleTask` in `src/modules/scheduling/actions.ts:11-31`, which calls `insertTask` → row in **inbound.db** with `kind='task'`, `status='pending'`, `series_id = id`.

## 2. Recurrence storage

Single column: `messages_in.recurrence TEXT`. Stored verbatim as the cron expression. Parsed at fire time (specifically: at recurrence-fanout time inside `handleRecurrence`, called from the host sweep every 60s — `src/host-sweep.ts:152-156`).

`series_id` is the stable handle. On insert, `insertTask` sets `series_id = id`. On every recurrence fanout, `insertRecurrence` carries the original `series_id` forward to the new row. This means `cancel_task(seriesId)` matches all live (pending/paused) rows in the chain, which is exactly what `db.ts:31-50` does (`WHERE id = ? OR series_id = ?`).

## 3. Cron evaluation

Library: `cron-parser ^5.0.0` (`container/agent-runner/package.json`). Used via `CronExpressionParser.parse(expr, { tz: TIMEZONE })` in `src/modules/scheduling/recurrence.ts:30`.

Eval semantics: **`interval.next()` (next-from-now)**, NOT next-from-prior-`process_after`. This is identical to v1's `task-scheduler.ts:53` and identical to v1's `MIGRATE_CRONS.md` recommendation. Concrete consequence: if a row's `process_after = 2026-05-03T08:00` and the host sweep first sees the row `completed` at `09:30`, the next row is computed via `CronExpressionParser.parse('0 8 * * *', { tz }).next()` from `09:30` → `2026-05-04T08:00`, **not** `2026-05-03T09:00`. **Missed intermediate slots are never enqueued.**

## 4. DST handling for `0 8 * * *` daily

Both v1 and v2 use cron-parser v5 with `{ tz: 'America/Fortaleza' }`. Spring-forward and fall-back behavior is whatever cron-parser does natively:
- **Spring-forward (clock 02→03):** if the cron slot lands inside the missing hour, cron-parser advances to the next existing wall-clock hour. `0 8 * * *` is unaffected (8am exists on both sides). A `0 2 * * *` would fire at 03:00 local on the changeover day (slot skipped).
- **Fall-back (clock 02→01 repeats):** cron-parser fires once per cron expression, on the first occurrence of the wall-clock time. A `0 1 * * *` cron in a fall-back zone would fire at the *first* 01:00 (DST), not the second (post-DST).

**For Fortaleza (no DST since 2019)**: irrelevant. Every day has exactly 24 wall-clock hours. `0 8 * * *` fires at exactly one instant per day. **Codex#5 R1's "skipped/doubled near boundary" caveat does not apply.**

The container's `parseZonedToUtc` (timezone.ts:60-100) is a separate concern — it's used for the **one-shot `processAfter` field**. The doc-comment explicitly says "near DST boundaries this can be off by an hour for ~1h of wall-clock time per year; acceptable for scheduling where the agent normally picks round-hour targets." Again, n/a for Fortaleza.

## 5. Catch-up on downtime

**No catch-up.** Codex#5 R1 was correct.

Trace: host down 24h, comes up at 09:00 local with a `0 8 * * *` task whose last fire was 24h ago at `08:00 day-1`:

1. Sweep tick runs. `countDueMessages(inDb)` finds the live `pending` row from yesterday's fanout (`process_after = 08:00 today`, `now = 09:00 today` → due).
2. `wakeContainer(session)`. Container claims → runs **once**.
3. Container marks `processing_ack` → host syncs to `status='completed'`.
4. Next sweep: `getCompletedRecurring()` finds the just-completed row. `interval.next()` from now (`~09:01`) = **tomorrow 08:00**.
5. New `pending` row inserted with `process_after = tomorrow 08:00`.

So: missed window from 24h ago **fires once** (because the live row was sitting at `08:00 today` with `pending`), missed earlier windows from `day-1 09:00 → today 07:59` were already skipped (next-from-now semantics on every prior fanout).

Concrete: if host was down for 7 days, the daily standup fires **once** total when the host returns, then resumes normal cadence.

## 6. Per-session vs central

**Per-session.** Tasks live at:
```
data/v2-sessions/{agent_group_id}/{session_id}/inbound.db
                                                └── messages_in WHERE kind = 'task'
```

Path resolved by `src/session-manager.ts:50` `inboundDbPath(agentGroupId, sessionId)`. There is **no central `scheduled_tasks` table** in v2.

This means: each board with scheduled tasks must have a live `(agent_group_id, session_id)` pair in central `nanoclaw.db` BEFORE any task can be inserted. The 89 v1 rows can't be migrated by writing to one DB; the migration must iterate per board.

## 7. Cancel API

`cancel_task(taskId)` → `cancelTask(inDb, taskId)` (`src/modules/scheduling/db.ts:30`):

```sql
UPDATE messages_in
   SET status = 'completed', recurrence = NULL
 WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending','paused')
```

The `recurrence = NULL` is the key bit — without it, the next sweep tick would clone a fresh follow-up. By matching `id OR series_id`, a cancellation from the agent (which only knows about the latest completed row) reaches the live next occurrence.

Effect on running session: none. Cancel only updates inbound.db rows. If the container is mid-execution on a row that was just cancelled, it finishes and the `processing_ack` sync is a no-op (status is already `completed`).

`pause_task` / `resume_task` follow the same pattern — toggle `pending↔paused` across the series. `update_task` merges `prompt` / `script` into the JSON content and replaces `process_after` / `recurrence` columns; `recurrence=''` clears, `recurrence` undefined leaves alone.

## 8. Pre-agent script support

**Yes.** Two-stage:

(a) MCP accepts `script` field (`scheduling.ts:65-95`), forwards it inside `content` JSON (NOT a column).

(b) Container poll-loop (`container/agent-runner/src/poll-loop.ts:130-139`, MODULE-HOOK marker `scheduling-pre-task`) calls `applyPreTaskScripts(messages)` BEFORE the provider call. For each `kind='task'` message with a `script` in content:
- Writes `/tmp/task-script-{taskId}.sh`, `chmod 0755`, `execFile('bash', [path], { timeout: 30s, maxBuffer: 1MB })`
- Parses the **last line** of stdout as JSON `{ wakeAgent: bool, data?: any }`
- `wakeAgent: false` → task drops out of the message batch (skipped)
- `wakeAgent: true` → `content.scriptOutput = data`, message proceeds to the agent

This is functionally equivalent to v1's `script` column + `container-runner.ts` runner. Kipp audit's `auditor-prompt.txt` script will work as-is.

## 9. Migration script for the 89 v1 rows

**Per-board iteration required.** Pseudocode:

```ts
import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import { TIMEZONE } from 'src/config.js';
import { getAgentGroupByFolder } from 'src/db/agent-groups.js';
import { getActiveSessions } from 'src/db/sessions.js';
import { openInboundDb, inboundDbPath } from 'src/session-manager.js';
import { insertTask } from 'src/modules/scheduling/db.js';

const v1 = new Database('store/messages.db', { readonly: true });
const v1rows = v1.prepare(
  `SELECT id, group_folder, chat_jid, prompt, script,
          schedule_type, schedule_value, context_mode,
          status, next_run
     FROM scheduled_tasks
    WHERE status IN ('active','paused')`
).all();

let migrated = 0, skipped = 0;
for (const t of v1rows) {
  // 1. Resolve agent_group from group_folder
  const ag = getAgentGroupByFolder(t.group_folder);
  if (!ag) { skipped++; continue; }

  // 2. Find an active session for this agent_group
  const sessions = getActiveSessions().filter(s => s.agent_group_id === ag.id);
  if (sessions.length === 0) { skipped++; continue; }
  const session = sessions[0]; // latest

  // 3. Compute processAfter (next_run UTC ISO)
  let processAfter: string;
  let recurrence: string | null = null;
  if (t.schedule_type === 'cron') {
    recurrence = t.schedule_value;
    processAfter = CronExpressionParser
      .parse(t.schedule_value, { tz: TIMEZONE })
      .next().toISOString();
  } else if (t.schedule_type === 'interval') {
    // v2 has no native interval — convert by computing one-shot, recurrence stays null.
    // Discuss with user: convert to a cron approximation (e.g. every 5min → '*/5 * * * *')
    skipped++; continue;
  } else if (t.schedule_type === 'once') {
    processAfter = new Date(t.schedule_value).toISOString();
    recurrence = null;
  } else {
    skipped++; continue;
  }

  // 4. Insert into the session's inbound.db
  const dbPath = inboundDbPath(ag.id, session.id);
  const inDb = openInboundDb(dbPath);
  try {
    insertTask(inDb, {
      id: `migrated-${t.id}`,
      processAfter,
      recurrence,
      platformId: null,           // host fills via session_routing on fanout
      channelType: null,
      threadId: null,
      content: JSON.stringify({
        prompt: t.prompt,
        script: t.script ?? null,
      }),
    });
    migrated++;
  } finally {
    inDb.close();
  }
}
console.log(`migrated=${migrated} skipped=${skipped}`);
```

Status mapping notes:
- v1 `paused` → v2 `paused`. Caller would need to `pauseTask(inDb, id)` after insert (insertTask hardcodes `pending`). Alternative: insert with `pending`, then UPDATE.
- v1 `cancelled` (1 row) → skip.
- v1 `completed` `once` (56 rows) → skip; they're already done.
- v1 `script` → goes into content JSON, NOT a column.
- v1 `context_mode='isolated'` vs `'group'` → **no v2 equivalent**. v2 always runs the task in the group's session. v1 isolated mode (Kipp uses it) → has no v2 mapping. **Open question.**

Estimated migration scope from this dev DB:
- 6 active cron + 24 paused cron = 30 cron rows to migrate
- The user states production has 89 active. Same query shape applies.
- 0 interval rows in dev (interval is rare in production too — verify before migrating).

## 10. One-shot reminders with non-round minutes (e.g. 07:30)

**Fully supported, timezone-correct.**

Path:
1. Agent calls `schedule_task({ prompt, processAfter: '2026-05-03T07:30:00' })` (naive ISO).
2. `parseZonedToUtc('2026-05-03T07:30:00', 'America/Fortaleza')` returns `Date('2026-05-03T10:30:00.000Z')` (Fortaleza is UTC-3, no DST).
3. Stored as `process_after = '2026-05-03T10:30:00.000Z'` in inbound.db.
4. Sweep tick after 07:30 local sees `process_after <= now` → fires.

The 26 once-completed rows from v1 with non-round minutes are post-cutover-irrelevant (already fired). For ongoing creation, v2's MCP handles minute-precision fine. The per-second precision works too — `parseZonedToUtc` parses `seconds` cleanly.

**Caveat for non-round-hour cron expressions** (e.g. `30 7 * * *` for 07:30 daily): cron-parser v5 with `tz` option handles arbitrary minutes correctly. Tested in `recurrence.test.ts` with `0 9 * * *` only, but the library spec is well-known to support any 5-field cron.

---

## Cross-checks against Codex feedback

- **Codex#5 R1 "no catch-up":** confirmed exactly. Single fire per missed window, advance from now.
- **Codex DST caveat (~1h ambiguous):** applies to `parseZonedToUtc` only (one-shot tasks), not to cron recurrence. Library handles DST natively for cron. Fortaleza has neither concern (no DST since 2019).
- **Codex #5 "round-hour only" assumption for production:** matches our v1 inventory check (only `0 H * * *` and `0 H D M *` patterns observed in active+paused crons in the dev DB).

## Open questions

1. **`context_mode='isolated'` v1 → v2 mapping unclear.** Kipp audit relies on isolated mode (no group-conversation contamination — see CLAUDE.md "audit actor canonicalization"). v2 always runs the task in the group's session via `getSession(session.id)`. Either v2 offers a way to flag "task-only session" we missed, or this is a behavioral regression for Kipp. Needs a follow-up file scan.
2. **`interval` schedule type has no native v2 mapping.** Production has 0 interval rows in dev — verify on prod before deciding skip-vs-convert-to-cron policy.
3. **89 production rows vs 30 dev rows discrepancy.** Either prod has more boards or different lifecycle. Re-run inventory query against prod `store/messages.db` before migration.
4. **Recurrence-string validation gap.** Bad cron expression makes a recurring task silently die after first fire. v1 catches this and pauses; v2 doesn't. Worth flagging upstream.
