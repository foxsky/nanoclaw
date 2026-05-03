# Coverage Matrix — Section K: Meetings Domain

> **Date:** 2026-05-03
> **Scope:** validate v2 plan covers all 17 meeting features (K.1–K.17) including the 8 meeting query views, external participant flow, dm-routing, scheduled_at weekday validation, and triage state machine.
> **Inputs:**
> - Plan: `docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md` §A.3.2 step 2.3.g + §A.3.7 step 7.1 "Meetings (5 tools)"
> - Spec: `docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md` §"External meeting participant onboarding" + §"Meeting tools"
> - Discovery 12 (sender approval): `docs/superpowers/research/2026-05-03-v2-discovery/12-sender-approval.md` §7 §8
> - Discovery 19 (production usage): `docs/superpowers/research/2026-05-03-v2-discovery/19-production-usage.md` §5 §6
> - dm-routing prod bug: `~/.claude/projects/-root-nanoclaw/memory/project_dm_routing_silent_bug.md`
> - Engine: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` (8500 lines)
> - dm-routing source: `/root/nanoclaw/src/dm-routing.ts` (lines 43-55 contain the table-existence guard)
> - Production DB: `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`

---

## Production validation (refreshed 2026-05-03)

| Metric | Value | Source |
|---|---:|---|
| `tasks WHERE type='meeting'` (live) | **20** | confirms inventory + Discovery 19 §5 |
| `external_contacts` rows | **3** | Edmilson, Katia, Ismael |
| `meeting_external_participants` rows | **3** | one per external |
| MEP `invite_status='invited'` | 2 | Katia + Ismael (M5 sec, both stale 2026-04-02 expiry) |
| MEP `invite_status='revoked'` | 1 | Edmilson (M7 thiago, exp 2026-03-24) |
| MEP `invite_status='accepted'` | 0 | feature has never seen a confirmed acceptance |
| Meetings on `board-thiago-taskflow` (≤60d) | 7 | dominant calendar (M22 future, rest past) |
| Meetings on `board-seci-taskflow` (≤60d) | 4 | secondary |
| Meetings on `board-sec-taskflow` (≤60d) | 1 | tertiary; M5 holds external grants |
| 25 other boards: meetings | 0 | meetings concentrated on 3 boards |
| `resolveExternalDm` errors in `nanoclaw.log` | **10,863** | confirmed today: `sudo grep -c resolveExternalDm /home/nanoclaw/nanoclaw/logs/nanoclaw.log` |

**Recent meetings (top 10 by `scheduled_at` DESC, ≤60d):**

```
M22  2026-05-05 12:00  thiago   Reunião SDU Sul — Integração/QGIS/STM   (FUTURE)
M23  2026-04-30 11:30  thiago   Apresentação Avisa BR — Mensageria
M21  2026-04-27 11:00  thiago   Reunião Prestação de Contas — SECTI
M3   2026-04-24 12:00  seci     Reunião com Cleonildo da FMS
M1   2026-04-23 14:00  seci     Reunião alinhamento ATI-Timon × SECTI
M20  2026-04-23 14:00  thiago   Apresentação final estágio probatório
M6   2026-04-23 11:30  seci     Gabriel Freitas sobre Projetos
M14  2026-04-15 17:00  thiago   Bases Suas no Sebrae
M2   2026-04-15 11:00  seci     Pesquisa TIC Governo 2025
M19  2026-04-14 14:00  thiago   Levantamento Critérios — Portal Transparência
```

> Discovery 19 §5 verdict: meetings are **real but small** — 16 meetings in last 30d, 3 boards account for all 20 live; the other 25 boards have zero. Discovery 19 §6 verdict: external-guest is **dormant** — 3 contacts, 3 grants, 0 acceptances, 6-week-old data. The feature has been used three times in the entire history of the system.

---

## dm-routing prod incident validation

**Confirmed live today:** `sudo grep -c resolveExternalDm /home/nanoclaw/nanoclaw/logs/nanoclaw.log` returns **10,863**.

The prior version of this audit speculated that prod `dist/dm-routing.js` predated the table-existence guard added at `src/dm-routing.ts:47-53`:

```ts
const tableCheck = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='external_contacts'`)
  .get();
if (!tableCheck) return null;
```

That guard exists in current src; the per-handle prepared-statement schema cache in better-sqlite3 (combined with a possibly-stale `_taskflowDb` cache) is the more likely root cause. **Either way, the v2 plan's regression coverage is the right shape.**

**Plan §A.3.2 step 2.3.g** explicitly addresses this:

> Test: missing `external_contacts` table returns null without throwing (regression for prod dist drift bug per memory `project_dm_routing_silent_bug.md`).

**Validation of the plan's regression coverage:**

| Risk vector | Plan addresses? | Notes |
|---|---|---|
| `external_contacts` table missing → throw | **YES** (§2.3.g explicit regression test) | matches the symptom |
| Stale dist/src divergence | **PARTIAL** (Risk table line "dm-routing.ts prod dist drift reproduces on v2 build" → "step 2.3.g adds explicit table-existence regression test") | Test catches the throw but not the underlying build-pipeline drift |
| `_taskflowDb` cache opened pre-migration | **MISSING** | No spec/plan language requires `db.pragma('user_version')` recheck on cache; no language requires invalidation on schema bump |
| Multiple `taskflow.db` candidates on disk (prod has 4 — three are zero-byte) | **MISSING** | No spec/plan language requires single-source-of-truth path resolution or fail-fast on multiple candidates |
| Prepared-statement schema cache mismatch when external_contacts is created out-of-band | **PARTIAL** | The §2.3.g test would not reproduce this scenario unless explicitly written to create-then-prepare-then-create-again |

**Verdict on the special call-out:** the plan's regression test (§2.3.g) **addresses the surface symptom** (table-existence guard) cleanly. It does **not** address the four anti-drift hardening recommendations from the memory file (single DB path, user_version recheck, cache invalidation on migration, dist/src fingerprint check). Those remain as **GAP-K.6.bug** to be added to the spec or plan.

---

## Coverage matrix

### K.1 — Create meeting task (`type='meeting'`)

| | |
|---|---|
| v1 source | engine:3150 (type discriminator), :3184 (participants on create), :3202 (scheduled_at on create), :3221–:3231 (recurrence + due_date invariants) |
| v1 behavior | `create_task` accepts `type='meeting'`. Invariants: meetings cannot have `due_date` (line 3231); recurring meetings require `scheduled_at` for first occurrence (3221); `recurrence_anchor` defaults to `scheduled_at` (3226). |
| v2 plan/spec | Spec §"Meeting tools" lists 5 MCP tools but does NOT enumerate `create_task(type='meeting')` — meetings are created via the unified `add_task` (Kanban tools row in spec) or implicitly. No invariants restated. |
| **Status** | **PARTIAL** |
| **GAP-K.1** | Spec must explicitly state: (a) meetings created via `add_task(type='meeting')` or a dedicated `create_meeting`; (b) the 4 invariants (no due_date, recurrence requires scheduled_at, recurrence_anchor default, type-locked-on-create) survive into v2. Plan §A.3.7 step 7.1 "Meetings (5 tools)" must include create-meeting in its happy-path + error-path tests. |

### K.2 — Internal participant management (add/remove)

| | |
|---|---|
| v1 source | engine:4930–:4990 (add/remove via update_task), :184 (`add_participant` / `remove_participant` update fields) |
| v1 behavior | Only meeting tasks. Resolves person via `resolvePerson` → `buildOfferRegisterError` if unknown. Mutates `tasks.participants` JSON-array. Notifies the added/removed person. |
| v2 plan/spec | Spec §"Meeting tools" lists `add_meeting_participant` (internal) + `remove_meeting_participant`. Plan §7.1 budgets 5 meeting tools with happy + error paths. |
| **Status** | **COVERED** (named) |
| **GAP-K.2** | Spec must restate: (a) meeting-only gate; (b) `tasks.participants` JSON column is the storage shape; (c) `resolvePerson` `offer_register` error path; (d) notification recipient = the added/removed person. Plan §7.1 error-path test should include "person not on board → offer_register". |

### K.3 — External participant invite (`add_external_participant`)

| | |
|---|---|
| v1 source | engine:4992–:5106 (115 lines: gate, normalize, upsert external_contacts, insert/update MEP, set 7d window, send DM, history) |
| v1 behavior | Manager/organizer-only. Phone normalized. `external_contacts(phone UNIQUE)` upserted. `meeting_external_participants(board_id, meeting_task_id, occurrence_scheduled_at, external_id)` 4-tuple PK. `invite_status='invited'`, `access_expires_at = scheduled_at + 7d`. Sends DM if `direct_chat_jid` known; otherwise relies on first-DM phone-fallback (see K.6). `task_history` action `add_external_participant`. |
| v2 plan/spec | Spec §"External meeting participant onboarding" rewrites the flow: bot DMs the participant → if unknown, `unknown_sender_policy='request_approval'` triggers admin card → on approve, INSERT users + user_dms + agent_group_members + replay_inbound. Spec proposes a smaller `meeting_externals` table (meeting↔user_id pairings only). Spec §"Meeting tools" names `add_meeting_participant_external`. |
| **Status** | **PARTIAL — design drift** |
| **GAP-K.3.design** | The spec's redesigned flow is **invitation-pull** (admin card on first DM), not the v1 **invitation-push** (organizer issues invite by name+phone, bot sends outbound DM). Discovery 12 §7 option (c) is the recommended bridge: TaskFlow's invitation-send flow calls `addMember()` to seed `agent_group_members` so v2's first-contact gate doesn't fire — but spec doesn't lock this in. Decision needed: (a) keep v1's push (TaskFlow MCP tool calls `addMember()` + sends DM directly), or (b) adopt v2's pull (admin card on first DM). Plan §7.1 cannot test this until decided. **3 prod contacts will need migration handling per Discovery 12 §8** — recommended Strategy 1 (do nothing; all 3 are expired). |
| **GAP-K.3.window** | The 7-day `access_expires_at` constant (engine line ~5050) is not restated in spec. v2 design must preserve or replace. |

### K.4 — Remove external participant (`remove_external_participant`)

| | |
|---|---|
| v1 source | engine:5108–:5170 (62 lines) |
| v1 behavior | Manager/organizer-only. 3-way fallback resolution: external_id → phone → name. UPDATE `meeting_external_participants.invite_status='revoked'`, `revoked_at`. Notifies via DM if `direct_chat_jid` known. `task_history` action `remove_external_participant`. |
| v2 plan/spec | Spec §"Meeting tools" implicit in `remove_meeting_participant` (single tool covers internal + external? — unclear). Plan §7.1 budgets 5 meeting tools. |
| **Status** | **PARTIAL** |
| **GAP-K.4** | Spec must clarify: is `remove_meeting_participant` polymorphic (internal vs external) or are there two tools? v1 has separate update fields (`remove_participant` vs `remove_external_participant`). Spec must also preserve the 3-way fallback resolver (external_id / phone / name). |

### K.5 — Reinvite external participant (`reinvite_external_participant`)

| | |
|---|---|
| v1 source | engine:5173–:5220 (47 lines) |
| v1 behavior | Resurrect a `revoked` or `expired` grant on the **current occurrence** only. UPDATE → `invite_status='invited'`, reset `access_expires_at = scheduled_at + 7d`, `invited_at = now`. Re-sends DM. |
| v2 plan/spec | Not enumerated as a distinct MCP tool. Spec §"Meeting tools" has no reinvite primitive. |
| **Status** | **MISSING** |
| **GAP-K.5** | Spec must add `reinvite_meeting_participant_external` OR document that reinvite is reachable via remove-then-add. v1's "current occurrence only" semantics matters for recurring meetings (don't resurrect grants on past occurrences). |

### K.6 — DM-based external participant correlation (dm-routing)

| | |
|---|---|
| v1 source | `/root/nanoclaw/src/dm-routing.ts` (145 lines, `resolveExternalDm`); host `dist/ipc.js:370,628,658` invokes |
| v1 behavior | Resolve inbound DM JID → (board, meeting_task_id, grants). Phone-fallback: extract phone from JID, match `external_contacts.phone`, backfill `direct_chat_jid` on hit. Lazy-expire grants where `access_expires_at < now`. Disambiguate when active grants span multiple boards. Inject `[External participant: <name> (<id>), grants: M1,M3]` context tag into the host board's session. |
| v2 plan/spec | Spec §"External meeting participant onboarding" — proposes deletion of `dm-routing.ts` (~250 LOC) absorbed by v2 sender-approval. Discovery 12 §7 option (c) recommends keeping `resolveExternalDm` as a context-tag layer (no longer drops messages, since v2's request_approval gate handles unknown senders). Plan §A.3.2 step 2.3.g: ports `dm-routing.ts` to skill branch + adds table-existence regression test. |
| **Status** | **PARTIAL — port-forward decision unclear** |
| **GAP-K.6.scope** | Spec says "delete dm-routing.ts"; plan §2.3.g says "port + regression test". Internally inconsistent. Decision: Discovery 12 option (c) is correct — context-tag layer survives, message-drop semantics move to v2 sender-approval. Spec must be amended to say "trim, don't delete." |
| **GAP-K.6.bug** | The plan's table-existence regression test (§2.3.g) is **necessary but not sufficient** to prevent the prod incident (10,863 errors). The four anti-drift requirements from `project_dm_routing_silent_bug.md` are unaddressed: (1) single source of truth for `taskflow.db` path with multi-candidate fail-fast; (2) `db.pragma('user_version')` recheck on cache reuse; (3) `_taskflowDb` cache invalidation on schema bump (or remove caching); (4) deploy-pipeline fingerprint check covering `src/` delta, not only container build inputs. **Recommendation:** add these as A.3.2 §2.3.g acceptance subitems. Production incident is dormant (no active grants) so out-of-scope for v1 hotfix per memory note, but in-scope for v2 to not reproduce. |

### K.7 — Triage meeting notes (`process_minutes` + `process_minutes_decision`)

| | |
|---|---|
| v1 source | engine:7932–:8050 (`process_minutes`, `process_minutes_decision`); :189 (set_note_status update field); :4919–:4925 (set_note_status mutator); note phase computed at :2965 (`getMeetingNotePhase`); phase filter at :4397, :5795–5798 (pre / meeting / post / other). |
| v1 behavior | `process_minutes` returns notes grouped by parent_note_id where `status='open'` for triage. `process_minutes_decision({decision: 'create_task'\|'create_inbox', create: <payload>})` creates the new task via `createTaskInternal`, updates `note.status='task_created'\|'inbox_created'`, stores `note.created_task_id` for traceability. `set_note_status` flips between {open, checked, task_created, inbox_created, dismissed}. Note `phase` is derived from current task `column` (pre = before scheduled_at; meeting = day-of; post = after). |
| v2 plan/spec | Spec §"Meeting tools" lists `set_meeting_note_status` ("Pre/meeting/post note triage") + `transition_meeting` (state machine planned→confirmed→in_progress→done). No `process_minutes` orchestrator. |
| **Status** | **PARTIAL** |
| **GAP-K.7.tools** | Spec collapses v1's two-step triage (`process_minutes` listing + `process_minutes_decision` action) into `set_meeting_note_status`. The "decision creates a task" branch (the most useful path — turn an open item into a `next_action` task with linkage) is not enumerated in spec. Either add a `triage_meeting_note` MCP tool or document that `add_task(parent_note_id=...)` + `set_meeting_note_status` is the v2 idiom. |
| **GAP-K.7.statemachine** | Spec's `transition_meeting` invents a planned/confirmed/in_progress/done state machine that v1 does NOT have. v1 derives `phase` from `column` automatically. Decision needed: keep v1's column-derived phase (simpler, port-forward), or adopt the explicit transition_meeting state machine (re-design). |

### K.8–K.15 — 8 meeting query views

Per the inventory's "8 meeting query views (upcoming, today, overdue, by_status, external, internal, participants, open_items)", v1 actually exposes a slightly different set (10 cases in the engine query dispatcher). The mapping:

| Inventory view | v1 case (engine:6818–:7125) | v1 lines |
|---|---|---|
| K.8 `agenda` (today) | `case 'agenda'` (overdue + due_today + in_progress) | 6818–:6831 |
| K.9 `agenda_week` | `case 'agenda_week'` | 6832–:6841 |
| K.10 `meetings` (open / by_status) | `case 'meetings'` (`type='meeting' AND column != 'done'`) | 7020–:7026 |
| K.11 `meeting_agenda` (per-meeting pre-notes) | `case 'meeting_agenda'` (filters notes phase='pre') | 7027–:7046 |
| K.12 `meeting_minutes` (formatted ata) | `case 'meeting_minutes'` (calls `formatMeetingMinutes` at :5768) | 7047–:7055 |
| K.13 `upcoming_meetings` (next N) | `case 'upcoming_meetings'` (scheduled_at >= now, sorted asc) | 7056–:7062 |
| K.14 `meeting_participants` | `case 'meeting_participants'` (organizer + internal + external) | 7063–:7087 |
| K.15 `meeting_open_items` | `case 'meeting_open_items'` (`notes.status='open'`) | 7088–:7096 |

| | |
|---|---|
| v2 plan/spec | Spec §"Query tools" line 283: `list_meetings (8 view-shaped variants)` — names exist but variants not enumerated. Plan §A.3.7 step 7.1 "Query (3+ tools)" budgets generic query tool tests. |
| **Status** | **COVERED** (by name, single line) |
| **GAP-K.8-15.enumerate** | Spec must enumerate the 8 variants by name + filter shape + return shape so the engine port-forward has a coverage checklist. v1 has 10 distinct query cases for meetings (counting `agenda`/`agenda_week` as part of the meetings UX); spec's "8" matches the inventory but the mapping is non-obvious. Plan §7.1 must include 1 happy-path test per variant (8 tests minimum). |
| **GAP-K.12.formatter** | `formatMeetingMinutes` (engine:5768–:5827) emits Portuguese-language section headers ("Pré-reunião", "Pós-reunião"). v2 spec must keep the formatter port-forward; production corpus shows 1233 "ata" hits vs 2 "minutes" — pt-BR is canonical. |

### K.16 — Cross-board meeting visibility

| | |
|---|---|
| v1 source | engine:1011 (`visibleTaskScope`), :1720 (`isBoardMeetingParticipant`), :1648/:1658 (visibility resolution) |
| v1 behavior | Meetings are visible from any board where someone on the meeting's `participants` list is registered (`board_people`). Implemented as an OR clause in every read query: `WHERE board_id = this.boardId OR (type='meeting' AND visibleAsParticipant)`. Used by 13 query views and ~30 read paths. |
| v2 plan/spec | Not enumerated. Spec §"External meeting participant onboarding" rewrites the external participant flow but does not restate the cross-board visibility primitive for **internal** participants. |
| **Status** | **MISSING** |
| **GAP-K.16** | Spec must restate the cross-board visibility rule. Without it, `agent_group`-scoped queries on v2 will hide a meeting from a participant whose home board ≠ the meeting's host board. Discovery 19 §11 reassign analysis showed `was_linked` reassigns rely on the same cross-board surface. Plan §A.3.7 must include a test: "user U on board A is on participant list of meeting on board B → query from board A's session sees the meeting". |

### K.17 — Non-business-day weekday validation on `scheduled_at` + phone display

| | |
|---|---|
| v1 source weekday | engine:1084 (`isNonBusinessDay`), :1099 (`getNextBusinessDay`), :1107 (`shiftToBusinessDay`), :1119 (`checkNonBusinessDay`); applied at :3202 (create) + :4613 (update); recurring auto-shift at :4674 |
| v1 behavior weekday | Detects weekend OR jurisdictional holiday (per `board_holidays` table). On meeting create/update with weekend `scheduled_at`, returns warning. `allow_non_business_day` override flag bypasses. Recurring meetings auto-shift to next business day. |
| v1 source phone | engine:5004 (`normalizePhone`); display in `meeting_participants` query at :7063–:7087 (returns plain phone, NO masking); external invite history at :5101 (raw phone); contact lookup at :5150. |
| v1 behavior phone | Phones are stored canonical (`normalizePhone`) and displayed **plain** — no masking anywhere in engine source. |
| v2 plan/spec | Spec §"Kanban tools" mentions `set_due_date` "(skip-non-business-days option)" — but `scheduled_at` (meetings) is separate from `due_date` (tasks). Plan §A.3.6 verifies `board_holidays` row count matches v1 post-migration. No spec language on phone-mask. |
| **Status** | **PARTIAL — weekday COVERED, phone-mask MISSING but inventory-wrong** |
| **GAP-K.17.weekday** | Spec must mention that `scheduled_at` mutations (meetings) use the same `isNonBusinessDay` gate as `due_date` mutations. The recurring auto-shift (engine:4674) is a corner case the plan's port-forward must preserve. |
| **GAP-K.17.phone-mask** | Inventory item K.17 calls for "phone-mask display + match" but **engine source has no masking** — phones are shown plain in `meeting_participants` query and history rows. Either (a) the inventory is aspirational ("we want this in v2"), or (b) masking lives outside the engine (not in source I read). Flag for inventory author: clarify whether phone-mask is real-v1 or v2-want. **If v2-want:** add to spec §"Meeting tools" with explicit "display: last-4-digits-only, match: full canonical normalize". |

---

## Cross-cutting concerns the v2 spec must address (preserved from prior audit)

1. **Reschedule cascade** (engine:5260–:5275): editing `scheduled_at` cascades to all active `meeting_external_participants` rows — updates `occurrence_scheduled_at` AND `access_expires_at = new_scheduled_at + 7d` in one statement. Spec must preserve.
2. **WIP-limit exemption for meetings** (engine:2880, 2938, and elsewhere): meetings explicitly excluded from per-person WIP semantics. Plan §A.3.7 step 7.1 Kanban error-path "WIP exceeded" must NOT fire on meetings.
3. **Reminder semantics**: meetings key reminders off `scheduled_at`, NOT `due_date`. Two reminder kinds (scheduled days-before + exact-time meeting-start). Discovery 19 §8 confirmed Thiago board uses both.
4. **Notification recipient set** (engine:4392, 5101, 5163): includes assignee + participants + accepted/invited external contacts (excluding past-expiry). Used by reschedule, reminder, and start notifications.
5. **Note authorization layers** (engine:4372, 4443, 4489): meeting note operations bypass the assignee/manager gate but only for non-privileged updates. Multi-layered (participant membership AND/OR active external grant). Must port forward.

---

## Status counts

| Status | Count | IDs |
|---|---:|---|
| COVERED | 2 | K.2 (named), K.8-15 (named single-line) |
| PARTIAL | 7 | K.1, K.3 (design drift), K.4, K.6 (scope+bug), K.7, K.16, K.17 (weekday side) |
| MISSING | 1 | K.5 (reinvite tool) |
| GAP totals | **10 distinct GAPs** | K.1, K.3.design, K.3.window, K.4, K.5, K.6.scope, K.6.bug, K.7.tools, K.7.statemachine, K.16, K.17.weekday, K.17.phone-mask, K.8-15.enumerate, K.12.formatter |

(K.6.bug and K.3.design are the highest-impact: dm-routing prod incident risk + the push-vs-pull invitation flow ambiguity respectively.)

---

## Recommended plan/spec amendments

1. **Spec §"Meeting tools" expansion** (≈1 page): enumerate the 5 (or 6) MCP tools — `add_meeting_participant`, `add_meeting_participant_external`, `remove_meeting_participant`, `reinvite_meeting_participant_external`, `transition_meeting` (or `set_meeting_phase`), `triage_meeting_note` — with input/output schemas, gate (manager-only), notification policy, and error cases. **Resolves K.1, K.2, K.3, K.4, K.5, K.7.**
2. **Spec §"External meeting participant onboarding" reconciliation** (≈4 paragraphs): commit to Discovery 12 §7 option (c) — "TaskFlow's invitation-send flow calls `addMember()` to seed `agent_group_members` so v2's first-contact gate doesn't fire for invited externals; `dm-routing.ts` survives as a context-tag layer." Re-word the spec away from "delete dm-routing.ts" to "trim and reposition." **Resolves K.3.design, K.6.scope.**
3. **Plan §A.3.2 step 2.3.g acceptance expansion** (≈4 sub-bullets): add (a) single-source-of-truth path resolution with multi-candidate fail-fast; (b) `db.pragma('user_version')` recheck on cached handle reuse; (c) `_taskflowDb` cache invalidation on schema bump; (d) deploy-pipeline fingerprint check covering `src/` delta. Without these, v2 build silently inherits the same drift class. **Resolves K.6.bug.**
4. **Spec §"Query tools" `list_meetings` enumeration** (≈1 table, 8 rows): name + filter + return shape per variant. **Resolves K.8-15.enumerate.**
5. **Spec §"Cross-cutting" addendum on cross-board meeting visibility** (≈1 paragraph): restate `visibleTaskScope` rule for meetings — meeting visible from any board where a participant is registered. Plan §A.3.7 must add a test. **Resolves K.16.**
6. **Inventory clarification on K.17 phone-mask**: spec author or inventory author resolves whether masking is a real-v1 feature or a v2 want. If v2-want, add to spec §"Meeting tools" output schemas. **Resolves K.17.phone-mask.**
7. **Plan §A.3.7 step 7.1 "Meetings (5 tools)" expansion**: bump from 5 to 6 tool tests, plus 8 query-view tests, plus 1 cross-board-visibility test, plus 1 weekday-validation test, plus 1 reschedule-cascade test, plus 1 phase-derivation test, plus 1 reinvite test. Total ≈18 meeting-domain tests for production parity.

---

## Production source code references

- **Engine entry points (5 mutators + 8 query views):** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:4930-5220` (mutators) and `:6818-:7125` (query dispatcher)
- **`isBoardMeetingParticipant`:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:1720`
- **`visibleTaskScope`:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:1011`
- **`formatMeetingMinutes`:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:5768-5827`
- **`isNonBusinessDay` family:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:1084-1130`
- **`getMeetingNotePhase`:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:2965`
- **`process_minutes` / `process_minutes_decision`:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:7932-8050`
- **`external_contacts` + `meeting_external_participants` schema:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts:1213-1240`
- **dm-routing source:** `/root/nanoclaw/src/dm-routing.ts:43-145` (guard at 47-53)
- **Production DB:** `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`
- **Production log (10,863 errors):** `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/logs/nanoclaw.log`

## Anchor references

- Plan §A.3.2 step 2.3.g (dm-routing port + regression test): `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md:138`
- Plan §A.3.7 "Meetings (5 tools)": `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md:244`
- Plan risk row "dm-routing.ts prod dist drift": `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md:298`
- Spec §"External meeting participant onboarding": `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md:158-180`
- Spec §"Meeting tools": `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md:268-276`
- Spec §"Query tools `list_meetings`": `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md:283`
- Discovery 12 §7 (TaskFlow dm-routing layering options) and §8 (3-contact migration strategy): `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/12-sender-approval.md:172-288`
- Discovery 19 §5 (meeting frequency) and §6 (external participants flow): `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/19-production-usage.md:118-145`
- dm-routing prod bug memory: `~/.claude/projects/-root-nanoclaw/memory/project_dm_routing_silent_bug.md`
