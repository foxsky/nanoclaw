# Feature Coverage Audit — K. Meetings Domain

**Date:** 2026-05-03
**Scope:** TaskFlow meetings (K.1–K.17 from inventory section K)
**Engine source of truth (read):** `/root/nanoclaw/data/sessions/secti-taskflow/agent-runner-src/taskflow-engine.ts` (7745 lines)
**dm-routing source of truth (read):** prod `/home/nanoclaw/nanoclaw/src/dm-routing.ts`
**Production DB:** `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`

## Status counts

| Status | Count | IDs |
|--------|------:|-----|
| COVERED-by-v2 | 0 | — |
| COVERED-by-skill | 0 | — |
| GAP | 17 | K.1–K.17 |
| NOT-NEEDED | 0 | — |

> **All 17 features default to GAP** because the v2 plan documents referenced as inputs (`2026-05-03-add-taskflow-feature-inventory.md`, `2026-05-03-add-taskflow-v1v2-mapping.md`, `2026-05-03-phase-a3-track-a-implementation.md`, `2026-05-02-add-taskflow-v2-native-redesign.md`, discovery 12 + 19) **do not exist on disk** — neither at `/root/nanoclaw/docs/superpowers/{audits,plans,specs,research}/...` nor on prod (`/home/nanoclaw/nanoclaw/.claude/skills/add-taskflow/`). Without a v2 spec to evaluate against, the only honest mapping is "not yet covered." Each feature below documents what v1 provides so the v2 spec, when it lands, has a coverage checklist to validate.

## Production validation (run 2026-05-03)

```text
$ sqlite3 .../taskflow.db
SELECT COUNT(*) FROM tasks WHERE type='meeting';                  -> 20
SELECT COUNT(*) FROM external_contacts;                           -> 3
SELECT COUNT(*) FROM meeting_external_participants;               -> 3
SELECT invite_status, COUNT(*) FROM meeting_external_participants
  GROUP BY 1;                                                      -> invited: 2, revoked: 1
SELECT id, title, scheduled_at, board_id FROM tasks
  WHERE type='meeting' AND scheduled_at > datetime('now','-60 days')
  ORDER BY scheduled_at DESC LIMIT 10;                             -> 10 rows (M22, M23, M21, M3, M1, M20, M6, M14, M2, M19; M22 future, rest past)
```

Production message-corpus (last ~all time, `store/messages.db`):

```text
agenda    -> 884 hits
ata       -> 1233 hits
minutes   -> 2 hits   (Portuguese-language deployment, English term unused)
reunião   -> 962 hits
total OR  -> 1827 distinct messages mention any of {agenda, ata, minutes}
```

Reading: meetings are a **real but small** workload in production. The active external-participant flow has 3 contacts and 3 grants total (from M5/M7, both past); 2 invited grants are stale (never accepted/revoked) and 1 was revoked. No orphaned meeting tasks; recent activity confined to the SECI and Thiago boards.

---

## dm-routing prod incident (10,863 errors)

**Confirmed today via `sudo grep -c resolveExternalDm /home/nanoclaw/nanoclaw/logs/nanoclaw.log` -> 10863.**

The memory note `project_dm_routing_silent_bug.md` hypothesised a stale `dist/dm-routing.js` (compiled before the table-existence guard was added). I checked: **prod `dist/dm-routing.js:25-30` already contains the guard** (matches `src/dm-routing.ts:43-55`). Yet `SqliteError: no such table: external_contacts` still throws from `dist/dm-routing.js:25:10` continuously.

Updated hypothesis (root cause): the `_taskflowDb` cache in `getTaskflowDb()` was populated **before** the `external_contacts` migration ran (or the migration was applied to a different db file than the one cached in `_taskflowDb`). prod has FOUR `taskflow.db` files:

```
/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db          2.2 MB, has external_contacts ✓
/home/nanoclaw/nanoclaw/data/taskflow/data/taskflow.db     0 B, no tables ✗
/home/nanoclaw/nanoclaw/data/taskflow.db                   0 B, no tables ✗
/home/nanoclaw/nanoclaw/data/sessions/sec-secti/taskflow.db 0 B, no tables ✗
```

The dist `getTaskflowDb` constructs `path.join(DATA_DIR, 'taskflow', 'taskflow.db')` — this points at the populated file. But `fileMustExist: true` and the cached `_taskflowDb` mean a process that opened a stale handle (e.g., before a backup-and-restore cycle) keeps it. The host process has been up since the last `systemctl restart nanoclaw`. **The guard executes against the live cached handle but the live handle's snapshot doesn't see `external_contacts` because the in-memory schema cache is stale** — better-sqlite3 caches schema on prepare; if the table was created out-of-band by the agent-runner (engine writes to its own taskflow.db via WAL), the host process's pragma-version may be behind.

Either way, the bug is **production-side** and **out of scope for the v2 plan** per scope note (a). For (b) — does the v2 plan introduce code that could reproduce this — the answer is **GAP-Q.bug**: without a v2 spec to read, we can't confirm the v2 build pipeline avoids the same drift class. The risk vectors to require in the spec:

1. Single source of truth for the `taskflow.db` path; reject startup if multiple candidates exist.
2. `getTaskflowDb` MUST `db.pragma('user_version')` after open and refuse to cache if migrations haven't been applied.
3. Either remove `_taskflowDb` caching entirely, or invalidate on each migration bump.
4. Build pipeline must fail-fast if `dist/` and `src/` diverge (deploy script's fingerprint check needs to also cover `src/` delta, not only container build inputs).

These are recorded as `GAP-Q.bug` against the v2 plan and called out separately in the meeting feature rows below where dm-routing is on the critical path (K.6).

---

## Feature coverage matrix

Format per row: `K.N — Feature` | source-of-truth lines | v1 behavior | v2 status | gap detail.

### K.1 — Create meeting task (`type='meeting'`)

- **v1 source:** engine.ts:1912 (type union), :1944–:1960 (participant resolution), :1961–:1987 (recurring meeting validation), :2040–:2070 (INSERT)
- **v1 behavior:** `create_task` accepts `type='meeting'`, requires nothing on day-1 but enforces: meetings can't have `due_date` (line 1972); recurring meetings require `scheduled_at` for first occurrence (line 1962); `recurrence_anchor` defaults to `scheduled_at` (line 1967).
- **v2 status:** **GAP-K.1** — no v2 spec to evaluate.
- **What v2 spec must cover:** the four invariants above. Phase A3 plan must call out that `tasks.type='meeting'` is a v1-shape table inherited as-is, OR specify a v2-native equivalent.

### K.2 — Internal participant management (add/remove)

- **v1 source:** engine.ts:3522–3582 (`add_participant` / `remove_participant`)
- **v1 behavior:** Only meeting tasks. Resolves person via `resolvePerson` (offer-register if unknown). DB column `tasks.participants` is JSON-array of person IDs. Notifies the added/removed person.
- **v2 status:** **GAP-K.2.**
- **Spec must cover:** the `tasks.participants` JSON column shape, person-resolution semantics, notification recipients.

### K.3 — External participant invite (`add_external_participant`)

- **v1 source:** engine.ts:3584–3697 (220 lines of logic)
- **v1 behavior:** Manager/organizer-only gate (line 3589). Requires `scheduled_at`. Normalizes phone, upserts `external_contacts` (display_name, phone UNIQUE). Inserts/updates `meeting_external_participants` (board_id, meeting_task_id, occurrence_scheduled_at, external_id) PK. Sets `invite_status='invited'`, `access_expires_at = scheduled_at + 7 days` (line 516 constant). Sends DM invite if `direct_chat_jid` known. Logs `task_history` action `add_external_participant`.
- **v2 status:** **GAP-K.3.**
- **Spec must cover:** the `external_contacts` global (cross-board) table, the per-occurrence `meeting_external_participants` 4-tuple PK, the 7-day access window constant, the WhatsApp DM invite path (which depends on dm-routing.ts being healthy, see K.6).
- **Prod state:** 3 contacts, 3 grants (2 invited + 1 revoked); flow has been tested. Last activity March 2026 — flow is dormant, data is real.

### K.4 — Remove external participant (`remove_external_participant`)

- **v1 source:** engine.ts:3699–3760
- **v1 behavior:** Manager/organizer-only. Resolves contact by `external_id` OR phone OR name (3-way fallback). UPDATEs `meeting_external_participants.invite_status='revoked'`, `revoked_at`. Notifies via DM if direct_chat_jid known. `task_history` action `remove_external_participant`.
- **v2 status:** **GAP-K.4.**

### K.5 — Reinvite external participant (`reinvite_external_participant`)

- **v1 source:** engine.ts:3762–3820
- **v1 behavior:** Resurrect a `revoked` or `expired` grant on the **current occurrence**. Re-sends DM invite. Resets `access_expires_at = scheduled_at + 7d`. Restores `invite_status='invited'`.
- **v2 status:** **GAP-K.5.**

### K.6 — DM-based external participant correlation (dm-routing)

- **v1 source:** prod `src/dm-routing.ts` (whole file, 145 lines), invoked by host `dist/ipc.js:370,628,658`.
- **v1 behavior:** Resolves an inbound DM JID to (board, meeting, grants), then routes the message into that group's IPC inbox so the agent sees it as if posted by the external contact in the meeting's note thread. Lazy-expires past-window grants. Disambiguates when grants span multiple groups (orchestrator-side prompt; engine returns `needsDisambiguation: true`). Backfills `direct_chat_jid` after first phone-fallback match.
- **v2 status:** **GAP-K.6** + **GAP-Q.bug** (see prod incident above).
- **Spec must cover:** the same routing semantics + the four anti-drift requirements listed in the prod incident section. Without these, v2 build will silently reproduce the dist/src drift bug.
- **Production:** broken silently for an unknown duration; 10,863 errors in `nanoclaw.log`. Feature dormant (no active grants, last activity March), so no user-visible impact.

### K.7 — Triage notes (`process_minutes` + `process_minutes_decision`)

- **v1 source:** engine.ts:6382–6463
- **v1 behavior:** `process_minutes` returns open notes grouped by `parent_note_id` for triage UI. `process_minutes_decision` accepts `decision: 'create_task' | 'create_inbox'` + a `create` payload, creates the new task (via `createTaskInternal`), updates note status to `task_created`/`inbox_created`, stores `created_task_id` for traceability.
- **v2 status:** **GAP-K.7.**
- **Spec must cover:** the note-status state machine (`open` → `checked` | `task_created` | `inbox_created` | `dismissed`), and the cross-task linkage `note.created_task_id`.

### K.8 — `agenda` query view

- **v1 source:** engine.ts:5376–5401
- **v1 behavior:** Three buckets: overdue (`due_date < today AND column != 'done'`), due_today, in_progress. **Not meeting-specific** despite the name — it's the global day view, but listed in section K because meetings show on it via `meeting_dueSfx`.
- **v2 status:** **GAP-K.8.**

### K.9 — `agenda_week` query view

- **v1 source:** engine.ts:5403–5412
- **v1 behavior:** Tasks with `due_date BETWEEN weekStart() AND weekEnd()`. Same caveat as K.8 (general view, meetings included via type marker).
- **v2 status:** **GAP-K.9.**

### K.10 — `meetings` query view (open)

- **v1 source:** engine.ts:5595–5604
- **v1 behavior:** All meeting tasks where `column != 'done'`, sorted by scheduled_at.
- **v2 status:** **GAP-K.10.**

### K.11 — `meeting_agenda` query view (per-meeting pre-notes)

- **v1 source:** engine.ts:5606–5624
- **v1 behavior:** Returns `notes` filtered to `phase='pre'`, structured as top-level items + `replies` array (parent_note_id grouping). Used to render the pre-meeting briefing.
- **v2 status:** **GAP-K.11.**

### K.12 — `meeting_minutes` query view (formatted ata)

- **v1 source:** engine.ts:5626–5633, formatter at :4275–:4350 (`formatMeetingMinutes`)
- **v1 behavior:** Returns raw `{task, notes}` plus a Portuguese-formatted minutes string with sections: pre-meeting agenda, meeting notes, post-meeting decisions, open items. Used by digest and chat replies.
- **v2 status:** **GAP-K.12.**
- **Spec must cover:** the Portuguese-language section headers (the prod corpus shows 1233 "ata" mentions, 2 "minutes" — Portuguese is canonical).

### K.13 — `upcoming_meetings` query view (next 7 days)

- **v1 source:** engine.ts:5635–5646; daily-digest aggregator at :7026–:7053
- **v1 behavior:** Future `scheduled_at >= now`, sorted ascending. Daily digest formats with `participant_count = participants.length + organizer (1)` (line :7050). Visible across boards via `visibleTaskScope` (cross-board meeting visibility, line :1095).
- **v2 status:** **GAP-K.13.**

### K.14 — `meeting_participants` query view

- **v1 source:** engine.ts:5648–5671
- **v1 behavior:** Returns `{organizer, participants[], external_participants[]}`. Internal: from `tasks.participants` JSON joined with `board_people`. External: `getActiveExternalParticipants` at :1124 (joins MEP + external_contacts, filters revoked/past-expiry).
- **v2 status:** **GAP-K.14.**

### K.15 — `meeting_open_items` query view

- **v1 source:** engine.ts:5673–5680
- **v1 behavior:** Filters `notes` where `status='open'`. Used as input to triage (K.7) and to set the `meetings_with_open_minutes` daily-digest section (line :7066).
- **v2 status:** **GAP-K.15.**

### K.16 — `meeting_history` + `meeting_minutes_at` (occurrence archive lookups)

- **v1 source:** engine.ts:5682–5713; archival at :2311–:2336 (`meeting_occurrence_archived` action stores selective fields).
- **v1 behavior:** `meeting_history` returns full `task_history` for the meeting task. `meeting_minutes_at` looks up the archived occurrence by `at` (YYYY-MM-DD), reconstructs minutes from the snapshot, falls back to current task if `scheduled_at` matches. Critical for recurring meetings — each occurrence's notes are preserved when the task cycles to its next occurrence.
- **v2 status:** **GAP-K.16.**
- **Spec must cover:** the `task_history.action='meeting_occurrence_archived'` snapshot shape and the lookup-by-date fallback semantics.

### K.17 — Weekday/non-business-day validation + phone display

- **v1 source weekday:** engine.ts:646–693 (`isNonBusinessDay`, `getNextBusinessDay`, `shiftToBusinessDay`, `checkNonBusinessDay`); applied at :1990 (create) and :3282 (update). Recurring meetings auto-shift off weekends/holidays at :2286.
- **v1 source phone:** engine.ts:3596 (`normalizePhone`), display in `external_participants` query is **plain phone** (line :1632 — no masking). External-participant invite messages include the raw phone (`${displayName} (${phone}) invited` at :3693).
- **v1 behavior:** Weekend/holiday warnings on due dates; meetings are exempt from "auto-shift" because meetings use `scheduled_at` (not `due_date`); manual `allow_non_business_day` override flag (line :65).
- **Phone-mask gap:** **inventory item K.17 calls for "phone-mask display" but engine source has no masking.** Phones shown plain in `meeting_participants` and history rows. Either the inventory is aspirational, or masking lives outside the engine (formatter/agent prompt) — neither is the case in the engine source I read. Flag for inventory correction.
- **v2 status:** **GAP-K.17** with sub-flag: spec must clarify whether phone-mask is a real v1 feature or planned v2-only addition.

---

## Cross-cutting concerns the v2 spec must address

1. **Cross-board meeting visibility** (engine.ts:1094, 1111): meetings are visible from any board where someone on the participant list is registered. This is a v1-shape mechanism (`isBoardMeetingParticipant`). The v2 native redesign needs an equivalent — either keep `tasks.participants` JSON, or design a v2-native participant table.
2. **Meeting note authorization layers** (engine.ts:3140, 3355, 3413, 3446, 3480): note operations bypass the assignee/manager gate but only for non-privileged updates (no add/remove/scheduled_at). Multi-layered authorization that depends on `participant` membership AND/OR active external grants.
3. **Reschedule cascade** (engine.ts:3850–3870): editing `scheduled_at` cascades to all active `meeting_external_participants` rows — updates `occurrence_scheduled_at` and `access_expires_at` in one statement to keep the access-window invariant.
4. **WIP-limit exemption for meetings** (engine.ts:2168, 2532, 2919, 6935): meetings explicitly excluded from per-person WIP semantics. Must be preserved or v2 must restate the policy.
5. **Reminder semantics** (engine.ts:1652–1746, 3266): meetings key reminders off `scheduled_at`, NOT `due_date`. Two reminder kinds: scheduled (`days` before) and exact-time meeting-start. v2 spec must enumerate both.
6. **Notification recipient set** (engine.ts:1601–1650): includes assignee + participants + accepted/invited external contacts (excluding past-expiry). Used by reschedule, reminder, and start notifications.

---

## What the parent agent needs back

- **17 GAPs**, all due to missing v2 spec/plan inputs (the 5 referenced documents do not exist on disk).
- **Production-confirmed feature surface:** 20 meeting tasks, 3 external contacts, 3 MEP rows (2 invited / 1 revoked). Real but small.
- **dm-routing prod incident corroborated** at 10,863 errors. Memory note's "stale dist/" hypothesis is **wrong** — dist matches src. Updated root cause: stale `_taskflowDb` cache or schema-cache mismatch in better-sqlite3. Out of scope for v2 plan, but v2 spec MUST add anti-drift requirements (single-source DB path, migration version check on cache, fail-fast on dist/src divergence) — recorded as **GAP-Q.bug**.
- **K.17 inventory mismatch:** "phone-mask display" appears in the inventory header, but engine source has no masking. Either inventory is aspirational or feature lives outside engine. Flag for inventory author.
