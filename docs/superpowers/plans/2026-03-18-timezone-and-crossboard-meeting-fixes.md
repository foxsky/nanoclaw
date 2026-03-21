# Timezone & Cross-Board Meeting Visibility Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs: (1) agents store local time as UTC in `scheduled_at`, causing wrong display; (2) child board agents can't see parent board meetings they're invited to, and external participants are missing from task details.

**Architecture:** Add `localToUtc`/`utcToLocal` helpers to the engine, normalize `scheduled_at` on write (no-Z → convert from board TZ to UTC; has-Z → keep as-is), format all display paths through `utcToLocal`. For cross-board visibility, extend `getTask()` to allow meeting participants, fix all meeting query handlers to use the owning board's ID for lookups.

**Tech Stack:** TypeScript, Node.js `Intl.DateTimeFormat`, SQLite (better-sqlite3)

---

## File Structure

| File | Role |
|------|------|
| `container/agent-runner/src/taskflow-engine.ts` | All engine changes: helpers, normalization, visibility, display formatting |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Tool description updates for `scheduled_at` |
| `.claude/skills/add-taskflow/templates/CLAUDE.md.template` | Agent instruction updates |
| `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts` | Skill mirror |
| `.claude/skills/add-taskflow/modify/container/agent-runner/src/taskflow-engine.ts` | Skill mirror |
| `.claude/skills/add-taskflow/add/container/agent-runner/src/ipc-mcp-stdio.ts` | Skill mirror |
| `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts` | Skill mirror |
| `.claude/skills/add-taskflow/CHANGELOG.md` | Changelog entry |

---

### Task 1: Add timezone conversion helpers

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:300-430` (helpers section)

- [ ] **Step 1: Add `localToUtc` helper after line 376 (after `reminderDateFromScheduledAt`)**

```typescript
/**
 * Normalize a scheduled_at value to UTC.
 * - No 'Z' suffix and no offset → treat as local time in `tz`, convert to UTC.
 * - Has 'Z' or ±HH:MM offset → already timezone-aware, return as ISO string.
 * Falls back to appending 'Z' if parsing fails.
 */
function localToUtc(naive: string, tz: string): string {
  // Already timezone-aware — keep as-is
  if (/[Zz]$/.test(naive) || /[+-]\d{2}:?\d{2}$/.test(naive)) {
    return new Date(naive).toISOString();
  }

  // Parse components from naive ISO string (e.g. "2026-03-26T08:00:00")
  const match = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return naive.endsWith('Z') ? naive : naive + 'Z'; // unparseable fallback
  const [, yr, mo, dy, hr, mn, sc = '0'] = match;

  // Step 1: Create a UTC timestamp with the naive components
  const utcGuess = Date.UTC(+yr, +mo - 1, +dy, +hr, +mn, +sc);

  // Step 2: Find what local time this UTC instant maps to in the target timezone
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(
    fmt.formatToParts(new Date(utcGuess)).map(x => [x.type, x.value]),
  );
  const localAtGuess = Date.UTC(
    +p.year, +p.month - 1, +p.day,
    p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second,
  );

  // Step 3: offset = localAtGuess - utcGuess; actual UTC = utcGuess - offset
  const offsetMs = localAtGuess - utcGuess;
  return new Date(utcGuess - offsetMs).toISOString();
}
```

- [ ] **Step 2: Add `utcToLocal` helper right after `localToUtc`**

```typescript
/**
 * Format a UTC ISO string as a human-readable local date/time.
 * Returns e.g. "26/03/2026 às 08:00".
 */
function utcToLocal(utcIso: string, tz: string): string {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return utcIso; // unparseable fallback
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map(x => [x.type, x.value]),
  );
  return `${parts.day}/${parts.month}/${parts.year} às ${parts.hour}:${parts.minute}`;
}
```

- [ ] **Step 3: Add `getBoardTimezone` helper right after `utcToLocal`**

```typescript
/** Read the board timezone from board_runtime_config. Queried per-call (no stale cache). */
function getBoardTimezone(db: Database.Database, boardId: string): string {
  const row = db.prepare(
    `SELECT timezone FROM board_runtime_config WHERE board_id = ?`,
  ).get(boardId) as { timezone: string } | undefined;
  return row?.timezone ?? 'America/Fortaleza';
}
```

- [ ] **Step 4: Verify build compiles**

Run: `cd /root/nanoclaw && npm run build 2>&1 | tail -5`
Expected: No errors (helpers are defined but not yet called)

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "feat(taskflow): add localToUtc, utcToLocal, getBoardTimezone helpers"
```

---

### Task 2: Normalize `scheduled_at` on write in `create()` and `update()`

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:1814-1820` (create) and `container/agent-runner/src/taskflow-engine.ts:2942-2943,3672-3690` (update)

- [ ] **Step 1: Normalize in `create()` — insert before line 1814 (before recurring meeting validation)**

Insert at the top of the `create()` method body, right after `const now = ...` line (around line 1774), or right before line 1814:

```typescript
      /* --- Normalize scheduled_at from local time to UTC --- */
      if (params.scheduled_at) {
        const tz = getBoardTimezone(this.db, this.boardId);
        params = { ...params, scheduled_at: localToUtc(params.scheduled_at, tz) };
      }
```

This MUST go before line 1819 (`recurrence_anchor` default) so the anchor also gets the correct UTC value.

- [ ] **Step 2: Normalize in `update()` — insert AFTER line 2951 (`const taskBoardId = this.taskBoardId(task);`)**

The normalization must go after the task is fetched (line 2950-2951) so we can use the owning board's timezone, not `this.boardId`. This is critical for cross-board scenarios where a child board agent reschedules a parent board meeting.

Insert after line 2951:

```typescript
      /* --- Normalize scheduled_at from local time to UTC --- */
      const tz = getBoardTimezone(this.db, taskBoardId);
      if (updates.scheduled_at !== undefined) {
        updates.scheduled_at = localToUtc(updates.scheduled_at, tz);
      }
```

Note: `tz` is declared outside the `if` block so it can be reused by display formatting in Task 3 (avoids redundant `getBoardTimezone` calls). This MUST be before `add_external_participant` (line 3477) which uses `updates.scheduled_at`.

- [ ] **Step 3: Verify build compiles**

Run: `cd /root/nanoclaw && npm run build 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "feat(taskflow): normalize scheduled_at from local time to UTC on create/update"
```

---

### Task 3: Format all display paths through `utcToLocal`

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts` — lines 435-448, 1551, 1596, 3398, 3522, 3655, 3690, 3693

- [ ] **Step 1: Update `buildExternalInviteMessage` (lines 435-448) to accept and use timezone**

Change function signature and body:

```typescript
function buildExternalInviteMessage(
  taskId: string,
  taskTitle: string,
  scheduledAt: string,
  organizerName: string,
  tz: string,
): string {
  const when = utcToLocal(scheduledAt, tz);
  return (
    `\u{1f4c5} *Convite para reuni\u00e3o*\n\n` +
    `Voc\u00ea foi convidado para *${taskId} \u2014 ${taskTitle}*\n` +
    `*Quando:* ${when}\n` +
    `*Organizador:* ${organizerName}\n\n` +
    `Responda nesta conversa para participar da pauta e da ata.\n` +
    `Para confirmar, diga: aceitar convite ${taskId}`
  );
}
```

- [ ] **Step 2: Update meeting reminder notification (line 1551)**

The `getMeetingReminderNotifications` method needs the timezone. Add at the top of the method:

```typescript
const tz = getBoardTimezone(this.db, this.boardId);
```

Then change line 1551 from:
```typescript
message: `📅 *Lembrete de reunião*\n\n*${meeting.id}* — ${meeting.title}\n*Quando:* ${meeting.scheduled_at}\n*Faltam:* ${reminder.days} dia(s)`,
```
to:
```typescript
message: `📅 *Lembrete de reunião*\n\n*${meeting.id}* — ${meeting.title}\n*Quando:* ${utcToLocal(meeting.scheduled_at, tz)}\n*Faltam:* ${reminder.days} dia(s)`,
```

- [ ] **Step 3: Update meeting start notification (line 1596)**

Add `const tz = getBoardTimezone(this.db, this.boardId);` at the top of `getMeetingStartingNotifications` method.

Then change line 1596 from:
```typescript
message: `📅 *Reunião começando*\n\n*${meeting.id}* — ${meeting.title}\n*Agora:* ${meeting.scheduled_at}`,
```
to:
```typescript
message: `📅 *Reunião começando*\n\n*${meeting.id}* — ${meeting.title}\n*Agora:* ${utcToLocal(meeting.scheduled_at, tz)}`,
```

- [ ] **Step 4: Update participant-added notification (line 3398)**

In the `update()` method, `tz` is already available from the normalization step in Task 2. No extra `getBoardTimezone` call needed.

Change line 3398 from:
```typescript
const scheduledInfo = task.scheduled_at ? `\n*Quando:* ${task.scheduled_at}` : '';
```
to:
```typescript
const scheduledInfo = task.scheduled_at ? `\n*Quando:* ${utcToLocal(task.scheduled_at, tz)}` : '';
```

- [ ] **Step 5: Update external invite — add participant (line 3522)**

Change from:
```typescript
message: buildExternalInviteMessage(task.id, task.title, updates.scheduled_at ?? task.scheduled_at, organizerName),
```
to:
```typescript
message: buildExternalInviteMessage(task.id, task.title, updates.scheduled_at ?? task.scheduled_at, organizerName, tz),
```

- [ ] **Step 6: Update external invite — reinvite (line 3655)**

Change from:
```typescript
message: buildExternalInviteMessage(task.id, task.title, task.scheduled_at, organizerName),
```
to:
```typescript
message: buildExternalInviteMessage(task.id, task.title, task.scheduled_at, organizerName, tz),
```

- [ ] **Step 7: Update reschedule change log and notification (lines 3690, 3693)**

Change line 3690 from:
```typescript
changes.push(`Reunião reagendada para ${updates.scheduled_at}`);
```
to:
```typescript
changes.push(`Reunião reagendada para ${utcToLocal(updates.scheduled_at, tz)}`);
```

Change line 3693 from:
```typescript
const rescheduleMsg = `📅 *Reunião reagendada*\n\n*${task.id}* — ${task.title}\n*Novo horário:* ${updates.scheduled_at}\n*Por:* ${sender?.name ?? params.sender_name}`;
```
to:
```typescript
const rescheduleMsg = `📅 *Reunião reagendada*\n\n*${task.id}* — ${task.title}\n*Novo horário:* ${utcToLocal(updates.scheduled_at, tz)}\n*Por:* ${sender?.name ?? params.sender_name}`;
```

- [ ] **Step 8: Update `formatMeetingMinutes` (lines 4126-4128)**

This method manually slices the raw UTC string. Replace with `utcToLocal`. The method doesn't have access to `tz`, so add a `tz` parameter.

Change the method signature (line 4124):
```typescript
  private formatMeetingMinutes(task: any, notes: Array<any>, tz?: string): string {
```

Then change lines 4126-4128 from:
```typescript
    const scheduledStr = task.scheduled_at
      ? (() => { const d = task.scheduled_at; return `${d.slice(8,10)}/${d.slice(5,7)}/${d.slice(0,4)} ${d.slice(11,16)}`; })()
      : 'sem data';
```
to:
```typescript
    const effectiveTz = tz ?? getBoardTimezone(this.db, this.taskBoardId(task));
    const scheduledStr = task.scheduled_at
      ? utcToLocal(task.scheduled_at, effectiveTz)
      : 'sem data';
```

Then update ALL call sites of `formatMeetingMinutes` to pass `tz` when available:
- Line 5314 (meeting_minutes): add `const fmtTz = getBoardTimezone(this.db, this.taskBoardId(task));` before the call, pass as 3rd arg
- Line 5394 (meeting_minutes_at in occurrences loop): pass `getBoardTimezone(this.db, this.taskBoardId(mTask))` — use `mTask` from the fix in Task 6
- Line 5403 (meeting_minutes_at fallback): same timezone variable

- [ ] **Step 9: Update `meetingSfx` in `formatBoardView()` (lines 4316-4322)**

`meetingSfx` is inside `formatBoardView()` (line 4212), NOT `formatReport`. Add `const boardViewTz = getBoardTimezone(this.db, this.boardId);` near the top of `formatBoardView` (after line 4213).

Then change lines 4319-4321 from:
```typescript
      if (t.scheduled_at) {
        const d = t.scheduled_at;
        parts.push(`${d.slice(8,10)}/${d.slice(5,7)} ${d.slice(11,16)}`);
      }
```
to:
```typescript
      if (t.scheduled_at) {
        parts.push(utcToLocal(t.scheduled_at, boardViewTz));
      }
```

- [ ] **Step 10: Update `meetingLine` in `formatDigestOrWeeklyReport()` (lines 4485-4487)**

`meetingLine` is inside `formatDigestOrWeeklyReport()` (line 4468), a DIFFERENT method from `formatBoardView`. Add `const digestTz = getBoardTimezone(this.db, this.boardId);` near the top of `formatDigestOrWeeklyReport` (after line 4473).

Change lines 4485-4487 from:
```typescript
    const meetingLine = (meeting: { id: string; title: string; scheduled_at: string; participant_count: number }): string => {
      const when = `${meeting.scheduled_at.slice(8, 10)}/${meeting.scheduled_at.slice(5, 7)} ${meeting.scheduled_at.slice(11, 16)}`;
      return `• *${meeting.id}* — ${meeting.title} (${when}) — ${meeting.participant_count} participante(s)`;
    };
```
to:
```typescript
    const meetingLine = (meeting: { id: string; title: string; scheduled_at: string; participant_count: number }): string => {
      const when = utcToLocal(meeting.scheduled_at, digestTz);
      return `• *${meeting.id}* — ${meeting.title} (${when}) — ${meeting.participant_count} participante(s)`;
    };
```

- [ ] **Step 11: Verify build compiles**

Run: `cd /root/nanoclaw && npm run build 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 12: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "feat(taskflow): format all scheduled_at display paths through utcToLocal"
```

---

### Task 4: Update tool descriptions and CLAUDE.md template

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:652,792`
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template:276-282,313`

- [ ] **Step 1: Update `taskflow_create` tool description (ipc-mcp-stdio.ts line 652)**

Change from:
```typescript
scheduled_at: z.string().optional().describe('Scheduled datetime (ISO-8601 UTC) for meetings'),
```
to:
```typescript
scheduled_at: z.string().optional().describe('Meeting date/time in LOCAL time (board timezone, e.g. "2026-03-26T08:00:00"). Do NOT append "Z" — the engine converts to UTC automatically.'),
```

- [ ] **Step 2: Update `taskflow_update` tool description (ipc-mcp-stdio.ts line 792)**

Change from:
```typescript
scheduled_at: z.string().optional().describe('Reschedule meeting (ISO-8601 UTC)'),
```
to:
```typescript
scheduled_at: z.string().optional().describe('Reschedule meeting — LOCAL time (board timezone, e.g. "2026-03-26T08:00:00"). Do NOT append "Z".'),
```

- [ ] **Step 3: Update CLAUDE.md template meeting examples (lines 276-282)**

Change lines 276-282 from:
```
| "reunião: X em DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ', sender_name: SENDER })` |
| "reunião: X" | `taskflow_create({ type: 'meeting', title: 'X', sender_name: SENDER })` |
| "reunião com Y, Z: X em DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ', participants: ['Y', 'Z'], sender_name: SENDER })` |
| "reunião semanal: X começando DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ', recurrence: 'weekly', sender_name: SENDER })` |
| "reunião semanal com Y, Z: X começando DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ', recurrence: 'weekly', participants: ['Y', 'Z'], sender_name: SENDER })` |

Parse `scheduled_at` in the board timezone ({{TIMEZONE}}) from the user's date/time expression, then store in ISO-8601 UTC (with `Z` suffix). Note: this is for the `taskflow_create` DB field only — `schedule_task`'s `schedule_value` uses LOCAL time (see schedule_task section below).
```

to:
```
| "reunião: X em DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SS', sender_name: SENDER })` |
| "reunião: X" | `taskflow_create({ type: 'meeting', title: 'X', sender_name: SENDER })` |
| "reunião com Y, Z: X em DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SS', participants: ['Y', 'Z'], sender_name: SENDER })` |
| "reunião semanal: X começando DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SS', recurrence: 'weekly', sender_name: SENDER })` |
| "reunião semanal com Y, Z: X começando DD/MM às HH:MM" | `taskflow_create({ type: 'meeting', title: 'X', scheduled_at: 'YYYY-MM-DDTHH:MM:SS', recurrence: 'weekly', participants: ['Y', 'Z'], sender_name: SENDER })` |

Pass `scheduled_at` as LOCAL time ({{TIMEZONE}}) directly from the user's date/time expression. Do NOT convert to UTC or append `Z` — the engine handles conversion automatically. This is consistent with `schedule_task`'s `schedule_value`, which also uses local time.
```

- [ ] **Step 4: Update CLAUDE.md template reschedule example (line 313)**

Change from:
```
| "reagendar M1 para DD/MM às HH:MM" | `taskflow_update({ task_id: 'M1', updates: { scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ' }, sender_name: SENDER })` |
```
to:
```
| "reagendar M1 para DD/MM às HH:MM" | `taskflow_update({ task_id: 'M1', updates: { scheduled_at: 'YYYY-MM-DDTHH:MM:SS' }, sender_name: SENDER })` |
```

- [ ] **Step 5: Verify build compiles**

Run: `cd /root/nanoclaw && npm run build 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts .claude/skills/add-taskflow/templates/CLAUDE.md.template
git commit -m "docs(taskflow): update scheduled_at tool descriptions and template to accept local time"
```

---

### Task 5: Extend `getTask()` for cross-board meeting participant visibility

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:981-1001`

- [ ] **Step 1: Add `isBoardMeetingParticipant` private method after `getTask()` (after line 1001)**

```typescript
  /**
   * Check if any person registered on this board is a participant or organizer
   * of the given meeting task (which may belong to a different board).
   */
  private isBoardMeetingParticipant(task: any): boolean {
    const participants: string[] = JSON.parse(task.participants ?? '[]');
    const involved = [task.assignee, ...participants].filter(Boolean);
    if (involved.length === 0) return false;
    const ph = involved.map(() => '?').join(',');
    return !!this.db.prepare(
      `SELECT 1 FROM board_people WHERE board_id = ? AND person_id IN (${ph}) LIMIT 1`,
    ).get(this.boardId, ...involved);
  }
```

- [ ] **Step 2: Add third visibility check in `getTask()` (after line 989)**

In `getTask()`, after the `child_exec_board_id` check (line 988-989) and before `return null` (line 989), add:

```typescript
      // Allow cross-board visibility for meeting participants
      if (task.type === 'meeting' && this.isBoardMeetingParticipant(task)) return task;
```

The full block becomes:
```typescript
    if (targetBoardId) {
      const task = this.db.prepare(TaskflowEngine.TASK_BY_BOARD_SQL).get(targetBoardId, rawId) as any | undefined;
      if (!task) return null;
      if (task.board_id === this.boardId) return task;
      if (task.child_exec_board_id === this.boardId && task.child_exec_enabled === 1) return task;
      if (task.type === 'meeting' && this.isBoardMeetingParticipant(task)) return task;
      return null;
    }
```

- [ ] **Step 3: Verify build compiles**

Run: `cd /root/nanoclaw && npm run build 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "feat(taskflow): allow cross-board meeting visibility for participants"
```

---

### Task 6: Fix meeting query handlers to use owning board ID

**Files:**
- Modify: `container/agent-runner/src/taskflow-engine.ts:5331-5365,5376-5405,4964-4980`

- [ ] **Step 1: Fix `meeting_participants` handler (lines 5331-5365)**

Replace the entire case block. The key changes:
- Use `const owningBoard = this.taskBoardId(task);` for all lookups
- Query `board_people` on `owningBoard` instead of `this.boardId`

```typescript
        case 'meeting_participants': {
          if (!params.task_id) return { success: false, error: 'Missing required parameter: task_id' };
          const task = this.requireTask(params.task_id);
          if (task.type !== 'meeting') return { success: false, error: `Task ${params.task_id} is not a meeting.` };
          const owningBoard = this.taskBoardId(task);
          const participantIds: string[] = JSON.parse(task.participants ?? '[]');
          const organizerRow = task.assignee
            ? this.db.prepare(`SELECT person_id, name, role FROM board_people WHERE board_id = ? AND person_id = ?`).get(owningBoard, task.assignee) as any
            : null;
          const people = participantIds.length === 0
            ? []
            : this.db
                .prepare(`SELECT person_id, name, role FROM board_people WHERE board_id = ? AND person_id IN (${participantIds.map(() => '?').join(',')})`)
                .all(owningBoard, ...participantIds) as Array<{ person_id: string; name: string; role: string }>;
          const epNow = new Date().toISOString();
          const externalParticipants = this.db.prepare(
            `SELECT ec.external_id, ec.display_name, mep.invite_status
             FROM meeting_external_participants mep
             JOIN external_contacts ec ON ec.external_id = mep.external_id
             WHERE mep.board_id = ? AND mep.meeting_task_id = ?
               AND mep.invite_status NOT IN ('revoked', 'expired')
               AND (mep.access_expires_at IS NULL OR mep.access_expires_at >= ?)`
          ).all(owningBoard, task.id, epNow) as Array<{
            external_id: string;
            display_name: string;
            invite_status: string;
          }>;
          return {
            success: true,
            data: {
              organizer: organizerRow ?? { person_id: task.assignee, name: task.assignee },
              participants: people,
              external_participants: externalParticipants,
            },
          };
        }
```

- [ ] **Step 2: Fix `meeting_history` handler (line 5378)**

Change from:
```typescript
          const history = this.getHistory(params.task_id);
```
to:
```typescript
          const task = this.requireTask(params.task_id);
          const history = this.getHistory(task.id, undefined, this.taskBoardId(task));
```

- [ ] **Step 3: Fix `meeting_minutes_at` handler (line 5385)**

Change from:
```typescript
          const occurrences = this.getHistory(params.task_id)
```
to:
```typescript
          const mTask = this.requireTask(params.task_id);
          const occurrences = this.getHistory(mTask.id, undefined, this.taskBoardId(mTask))
```

- [ ] **Step 4: Enrich `task_details` with external participants for meetings (after line 4979)**

After the existing `parent_project` block, add:

```typescript
          // Include external participants for meetings
          if (task.type === 'meeting') {
            const owningBoard = this.taskBoardId(task);
            const epNow = new Date().toISOString();
            data.external_participants = this.db.prepare(
              `SELECT ec.external_id, ec.display_name, mep.invite_status
               FROM meeting_external_participants mep
               JOIN external_contacts ec ON ec.external_id = mep.external_id
               WHERE mep.board_id = ? AND mep.meeting_task_id = ?
                 AND mep.invite_status NOT IN ('revoked', 'expired')
                 AND (mep.access_expires_at IS NULL OR mep.access_expires_at >= ?)`
            ).all(owningBoard, task.id, epNow);
          }
```

- [ ] **Step 5: Verify build compiles**

Run: `cd /root/nanoclaw && npm run build 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/taskflow-engine.ts
git commit -m "fix(taskflow): use owning board ID in meeting query handlers, enrich task_details with external participants"
```

---

### Task 7: Update skill bundled files and changelog

**Files:**
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts`
- Modify: `.claude/skills/add-taskflow/modify/container/agent-runner/src/taskflow-engine.ts`
- Modify: `.claude/skills/add-taskflow/add/container/agent-runner/src/ipc-mcp-stdio.ts`
- Modify: `.claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts`
- Modify: `.claude/skills/add-taskflow/CHANGELOG.md`

- [ ] **Step 1: Copy updated engine to skill add/ directory**

```bash
cp container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/add/container/agent-runner/src/taskflow-engine.ts
```

- [ ] **Step 2: Copy updated engine to skill modify/ directory**

```bash
cp container/agent-runner/src/taskflow-engine.ts .claude/skills/add-taskflow/modify/container/agent-runner/src/taskflow-engine.ts
```

- [ ] **Step 3: Copy updated ipc-mcp-stdio.ts to skill add/ directory**

```bash
cp container/agent-runner/src/ipc-mcp-stdio.ts .claude/skills/add-taskflow/add/container/agent-runner/src/ipc-mcp-stdio.ts
```

- [ ] **Step 4: Copy updated ipc-mcp-stdio.ts to skill modify/ directory**

```bash
cp container/agent-runner/src/ipc-mcp-stdio.ts .claude/skills/add-taskflow/modify/container/agent-runner/src/ipc-mcp-stdio.ts
```

- [ ] **Step 5: Update CHANGELOG.md**

Add entry at the top of the changelog:

```markdown
## 2026-03-18

### Fixed
- **Timezone handling**: `scheduled_at` passed without `Z` suffix is now treated as local time (board timezone) and automatically converted to UTC by the engine. Values with `Z` are kept as-is for backward compatibility. All notification messages (reminders, start, reschedule, invites) now display local time via `utcToLocal`.
- **Cross-board meeting visibility**: Child board agents can now view meetings on parent boards where their people are participants or organizer. `getTask()` extended with `isBoardMeetingParticipant` check.
- **External participants in task_details**: `task_details` query now includes `external_participants` for meeting tasks.
- **Meeting query board_id**: `meeting_participants`, `meeting_history`, and `meeting_minutes_at` now use the owning board ID for all lookups, fixing incorrect results when queried from child boards.
- **Tool descriptions**: `scheduled_at` in `taskflow_create` and `taskflow_update` now describes local time format, explicitly instructing agents not to append `Z`.
```

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/add-taskflow/
git commit -m "chore(taskflow-skill): sync bundled files and update changelog for timezone + cross-board fixes"
```

---

### Task 8: Update existing group CLAUDE.md files

**Files:**
- Modify: all `groups/*/CLAUDE.md` files that contain the old `scheduled_at` instructions

- [ ] **Step 1: Find all group CLAUDE.md files with old instructions**

```bash
grep -rl 'YYYY-MM-DDTHH:MM:SSZ' groups/*/CLAUDE.md
```

- [ ] **Step 2: Update each file — replace meeting examples**

For each file found, apply the same changes as Task 4 Step 3:
- Replace `'YYYY-MM-DDTHH:MM:SSZ'` with `'YYYY-MM-DDTHH:MM:SS'` in the meeting management tables
- Replace the "Parse `scheduled_at` in the board timezone..." paragraph with the new "Pass `scheduled_at` as LOCAL time..." paragraph
- Replace the reschedule example similarly

Use sed or manual edits — verify each file.

- [ ] **Step 3: Commit**

```bash
git add groups/*/CLAUDE.md
git commit -m "docs: update group CLAUDE.md files to use local time for scheduled_at"
```

---

### Task 9: Rebuild container and deploy

- [ ] **Step 1: Build TypeScript**

```bash
cd /root/nanoclaw && npm run build
```

- [ ] **Step 2: Rebuild container**

```bash
cd /root/nanoclaw && ./container/build.sh
```

- [ ] **Step 3: Sync to remote and restart**

```bash
rsync -avz --delete /root/nanoclaw/dist/ nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/dist/
rsync -avz /root/nanoclaw/container/ nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/container/
rsync -avz /root/nanoclaw/groups/ nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/groups/
rsync -avz /root/nanoclaw/.claude/skills/add-taskflow/ nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/.claude/skills/add-taskflow/
ssh nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && ./container/build.sh"
ssh nanoclaw@192.168.2.63 "systemctl --user restart nanoclaw"
```

- [ ] **Step 4: Fix the existing M5 meeting time**

The M5 meeting on board-sec-taskflow currently has `scheduled_at: "2026-03-26T08:00:00Z"` but should be `"2026-03-26T11:00:00Z"` (08:00 Fortaleza = 11:00 UTC). Fix via direct DB update on the remote:

```bash
ssh nanoclaw@192.168.2.63 "cd /home/nanoclaw/nanoclaw && node -e \"
const Database = require('better-sqlite3');
const db = new Database('data/taskflow/taskflow.db');
db.prepare(\\\"UPDATE tasks SET scheduled_at = '2026-03-26T11:00:00.000Z' WHERE board_id = 'board-sec-taskflow' AND id = 'M5'\\\").run();
db.prepare(\\\"UPDATE meeting_external_participants SET occurrence_scheduled_at = '2026-03-26T11:00:00.000Z' WHERE board_id = 'board-sec-taskflow' AND meeting_task_id = 'M5' AND occurrence_scheduled_at = '2026-03-26T08:00:00Z'\\\").run();
console.log('Fixed M5 scheduled_at to 11:00 UTC (08:00 Fortaleza)');
db.close();
\""
```

- [ ] **Step 5: Commit deployment notes**

No code commit needed — deployment is operational.

---

## Known Limitations & Notes

1. **DST ambiguous times**: `localToUtc` picks one deterministic interpretation for ambiguous times during DST fall-back transitions. America/Fortaleza does not observe DST, so this is not a practical concern for current boards. Document if adding boards in DST-observing timezones.

2. **Cross-board manager permissions**: After Task 5, a child board manager could potentially pass the `isMgr` check (which checks `this.boardId`) for privileged updates on a parent board meeting accessed via meeting participant visibility. This is acceptable in the current hierarchy model (child board managers are subordinate managers) but should be revisited if the security model changes.

3. **`reminderDateFromScheduledAt` date extraction**: This function extracts the date portion from the UTC string (`scheduledAt.slice(0, 10)`). For late-night meetings (e.g., 22:00 local = 01:00+1 UTC), the UTC date is the next day, causing the reminder to fire one day later than expected. This is a pre-existing issue not introduced by these changes, but worth noting for a future fix.

4. **Shared person_ids across boards**: `isBoardMeetingParticipant` assumes person_ids are consistent across parent and child boards. This is guaranteed by the current provisioning system (`child_board_registrations` uses the same `person_id`).

5. **Existing bad data**: The M5 meeting fix in Task 9 Step 4 corrects one known bad value. Other meetings created before this fix may have incorrect UTC values if agents appended Z to local times. A one-time audit query can identify them: `SELECT id, board_id, scheduled_at FROM tasks WHERE type='meeting' AND scheduled_at IS NOT NULL`.
