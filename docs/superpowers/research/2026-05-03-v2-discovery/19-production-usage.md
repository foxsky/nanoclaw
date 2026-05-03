# 19 — Production usage patterns (empirical)

Date: 2026-05-03
Source: live production at `nanoclaw@192.168.2.63`
DBs sampled:
- `/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db` (central TaskFlow domain)
- `/home/nanoclaw/nanoclaw/store/messages.db` (central messaging + scheduler)
- `/home/nanoclaw/nanoclaw/data/audit/semantic-dryrun-*.ndjson` (Kipp dryrun deviations)
- `/home/nanoclaw/nanoclaw/groups/whatsapp_main/logs/` (Kipp container logs)
- `/home/nanoclaw/nanoclaw/logs/nanoclaw.log` (host logs)

Goal: separate features that are *load-bearing in prod* from features that are *theoretical/dead* — to inform v2 migration scope.

---

## 0. Top-line fleet size

| Metric | Value |
|---|---|
| Boards in `boards` table | **37** |
| Boards registered as WhatsApp groups | **28** (28 with `taskflow_managed=1`, plus `whatsapp_main` non-TF) |
| Boards with ≥1 task created last 60d | **10** |
| Boards with **zero** task creation last 60d | **27** of 37 (73%) |
| Total tasks (all types, not archived) | **356** (302 simple, 31 project, 20 meeting, 2 recurring, 1 inbox) |
| Total task_history rows | **2,532** |
| Total archived tasks | **188** |
| `board_people` registered | 59 across 10 boards (most boards have 0–2) |
| `board_admins` rows | 30 |

**Hierarchy:** 1 board at level 1 (root), 6 at level 2, 21 at level 3, 9 with no level set (likely seed/test rows). 27 boards have a `parent_board_id`. 26 `child_board_registrations` rows (parent ↔ child link).

---

## 1. Task volume by board and type

### Top 10 boards by total tasks

| Board | Tasks (live) | Archive | Tasks last 14d | Tasks last 60d |
|---|--:|--:|--:|--:|
| `board-seci-taskflow` | 164 | 77 | 8 | 164 |
| `board-sec-taskflow` | 75 | 62 | 13 | 75 |
| `board-laizys-taskflow` | 48 | — | 4 | 48 |
| `board-thiago-taskflow` | 20 | 15 | 5 | 20 |
| `board-setec-secti-taskflow` | 18 | 4 | 2 | 18 |
| `board-asse-seci-taskflow` | 15 | 2 | 7 | 15 |
| `board-ci-seci-taskflow` | 8 | 22 | 0 | 8 |
| `board-tec-taskflow` | 4 | 2 | 1 | 4 |
| `board-est-secti-taskflow-3` | 2 | — | 0 | 2 |
| `board-seaf-rh-taskflow` | 2 | — | 0 | 2 |

The remaining 27 boards have **0 tasks live and 0 created in the last 60 days**. Most are SEAF division boards (`seaf-astec`, `seaf-contabilidade`, `seaf-geadmin`, `seaf-gefin`), SETD/SETEC subboards (`ux-setd-secti`, `sm-setd-secti`, `setd-secti`, `secti-taskflow`), or apparently abandoned per-person boards (`hudson-taskflow`, `edilson-taskflow`, `anali-geo-taskflow`, `anali-sist-secti-taskflow`).

### Tasks by type (all live)

| Type | Count |
|---|--:|
| `simple` | 302 |
| `project` | 31 |
| `meeting` | 20 |
| `recurring` | 2 |
| `inbox` | 1 |

### Tasks by GTD column

| Column | Count |
|---|--:|
| `next_action` | 152 |
| `done` | 138 |
| `waiting` | 34 |
| `inbox` | 19 |
| `in_progress` | 10 |
| `review` | 3 |

`done` is the second-largest column — manual archival is rare; closed tasks accumulate in-column. `in_progress` (10) and `review` (3) are tiny; the WIP-limit/Kanban-flow promise of GTD columns is essentially unused — most teams treat the board as **inbox / next / done** with `waiting` for blocked items.

---

## 2. Active vs idle boards

- **Active in last 14 days (created ≥1 task):** 7 boards. Top: `board-sec-taskflow` (13 new), `board-seci-taskflow` (8), `board-asse-seci-taskflow` (7), `board-thiago-taskflow` (5), `board-laizys-taskflow` (4), `board-setec-secti-taskflow` (2), `board-tec-taskflow` (1).
- **Active in last 60 days:** 10 boards (the table above). The 14d set is a strict subset.
- **Live boards (≥1 user mutation last 30d in `task_history`):** ~9 — same set, so historically there's been **no broader use**.
- **Effectively dead boards:** 27 (no creates in 60d, no archive churn, no `board_people` beyond zero or one). This is **73% of the fleet**.

The fleet looks like 28 WhatsApp groups got registered with onboarding scaffolding (the `[TF-ONBOARDING]` once-tasks fired 2026-04-23 across `seaf-*` boards), but only ~9 boards stuck.

---

## 3. Subtasks and depth

- 31 parent tasks have ≥1 subtask. 154 subtasks total (avg 4.97 per parent).
- Distribution: 8 parents have 1, 9 have 2, 3 have 3, 1 has 4, 1 has 5, 1 has 6, 2 have 7, 1 has 10, 1 has 11, 1 has 12, 2 have 15, **1 has 27** (likely the SECI big projects).
- **Recursive max depth = 2.** No grandchildren — every subtask is a direct child of a project.
- `parent_task_id` is the column carrying the relationship (a flat parent pointer, not a JSON tree). The `subtasks` JSON column on `tasks` is also populated but `parent_task_id` is what queries use.

### Cross-board parent links (linked_parent_*)

Only **3** tasks have `linked_parent_board_id IS NOT NULL` live. That's the *physical* surface of the cross-board subtask feature. There were 21 `reparented` history events recorded in 60d, so the link gets used and then often dissolved.

### subtask_requests table

**0 rows ever.** The cross-board subtask **approval** queue (`subtask_requests`) has never seen a single row in production. This matches the earlier finding that cross-board approval is dead code — `cross_board_subtask_mode` is `open` for **all 28 boards**, so no approval flow ever runs.

---

## 4. Project completion

Of 31 projects:
- `next_action`: 28 (open / in flight)
- `in_progress`: 1
- `waiting`: 1
- `done`: 1

So **only ~3% of projects** have been driven to `done`. Either projects don't get closed (they just go quiet) or the hierarchy is too young — most projects were created in the last 60 days. There is no `cancelled` column for projects in live tasks; cancelled work moves to `archive` (188 archived rows; 71% archived as `cancelled`).

---

## 5. Meeting frequency

- 20 meetings live, 16 in last 30d (by `scheduled_at`).
- Distribution by board:
  - `board-thiago-taskflow`: 13 meetings (11 in last 30d) — Thiago's calendar is the dominant user
  - `board-seci-taskflow`: 4 (4 in 30d)
  - `board-sec-taskflow`: 3 (1 in 30d)
- Most-recent meeting (top 5):
  - 2026-05-05 12:00Z — Thiago: "Reunião SDU Sul"
  - 2026-04-30 11:30Z — Thiago: "Apresentação Avisa BR — Projeto Mensageria"
  - 2026-04-27 11:00Z — Thiago: "Reunião Prestação de Contas — SECTI"
  - 2026-04-24 12:00Z — Seci: "Reunião com Cleonildo da FMS"
  - 2026-04-23 14:00Z — Seci: "Reunião de alinhamento ATI-Timon × SECTI"

**Verdict:** meetings are real but concentrated on one user. Three boards account for all 20 meetings; the other 25 boards have zero.

---

## 6. External participants flow

- `external_contacts`: **3 rows** (Edmilson, Katia, Ismael). All `last_seen_at` is `NULL` — the column is wired but never populated. Status is `active` for all 3.
- `meeting_external_participants`: **3 rows** (one per external).
  - `M5` in `board-sec-taskflow`: Ismael + Katia, both `invited` (sent 2026-03-18, ~6 weeks ago).
  - `M7` in `board-thiago-taskflow`: Edmilson, status `revoked` (2026-03-13).
- No `accepted_at` populated on any row.

**Verdict:** the external-guest feature works at the data layer but has been used **3 times in the entire history of the system, by 2 boards, none of which led to a confirmed acceptance**. Purely speculative real-world use.

---

## 7. Cross-board sends (digests / notifications / cross-team pings)

This is the most unexpected finding.

`send_message_log` (60d window) — classified by joining `source_group_folder` against `registered_groups.folder` and comparing `target_chat_jid` to that folder's own JID:

| Kind | Count | % |
|---|--:|--:|
| Same-board (bot replies into its own group) | 1066 | 71.6% |
| **Cross-board (bot reaches into another board's WhatsApp group)** | **422** | **28.4%** |

So roughly **3 in 10 outbound messages cross a board boundary**. The earlier finding ("send_message_log 100% group/0 DM") was correct on `target_kind` (everything is a group, no DMs go through this log) but masked the cross-board pattern.

### Top 20 cross-board pairs (60d)

| Source board | Target board | Sends |
|---|---|--:|
| asse-seci-taskflow | seci-taskflow | 98 |
| seci-taskflow | asse-seci-taskflow-2 | 34 |
| seci-taskflow | ci-seci-taskflow | 32 |
| seci-taskflow | asse-seci-taskflow-3 | 27 |
| seci-taskflow | asse-seci-taskflow | 19 |
| seaf-geadmin-taskflow | laizys-taskflow | 18 |
| hudson-taskflow | thiago-taskflow | 13 |
| laizys-taskflow | seaf-gefin-taskflow | 11 |
| seaf-gefin-taskflow | laizys-taskflow | 11 |
| est-secti-taskflow-2 | seci-taskflow | 10 |
| ge-sup-secti-taskflow | setec-secti-taskflow | 10 |
| laizys-taskflow | seaf-geadmin-taskflow | 10 |
| laizys-taskflow | sec-secti | 10 |
| laizys-taskflow | seaf-astec-taskflow | 9 |
| laizys-taskflow | seaf-rh-taskflow | 9 |
| thiago-taskflow | sec-secti | 9 |
| seaf-astec-taskflow | laizys-taskflow | 8 |
| sec-secti | thiago-taskflow | 7 |
| ci-seci-taskflow | seci-taskflow | 6 |
| est-secti-taskflow-3 | ci-seci-taskflow | 6 |

Two patterns dominate:
1. **Roll-up** (child → parent board): `asse-seci → seci`, `ci-seci → seci`, `est-secti-* → seci`, `seaf-* → laizys`, `hudson → thiago`. The child sends digests, status updates, escalations to the parent's group.
2. **Roll-down / fan-out** (parent → children): `seci → asse-seci-{1,2,3}`, `seci → ci-seci`, `laizys → seaf-{rh,gefin,geadmin,astec}`, `laizys → sec-secti`. The parent sends instructions, reminders, broadcasts back down.

### Sample cross-board content (3 most recent from `asse-seci-taskflow → seci`):

1. *2026-05-01 20:00Z* — Compliment-style end-of-day message after holiday: *"Feliz Dia do Trabalhador, Lucas! Hoje é feriado — e ainda assim o board foi atualizado, o despacho do Aditivo RGM foi enviado à UGF-SEMF…"*
2. *2026-05-01 20:00Z* — Daily digest header: *"📋 TASKFLOW BOARD — 01/05/2026 / 10 tarefas • 6 projetos • 6 subtarefas / 7 próximas • 3 aguardando / *Resumo do Dia*…"*
3. *2026-04-30 20:01Z* — Monthly close: *"Fim de abril! 🗓 Lucas, abril foi um mês denso de gestão — o Aditivo RGM avançou…"*

So the cross-board sends are mostly **digests + qualitative compliments to the parent board**, plus reminders/notifications. This is exactly the pattern v2 needs to support if it wants any chance of replacing v1 in this team.

---

## 8. Reminder usage (`schedule_task` once-rows)

`scheduled_tasks` totals (active + completed):
- 87 cron rows (all active, all routine standup/digest/review)
- 2 once rows active, 161 once rows completed in last 60d

Sample of recent fired once-prompts:

| Group | Last run | Prompt prefix |
|---|---|---|
| whatsapp_main | 2026-05-02 07:33Z | `[AUDITOR-CHECKIN] Re-evaluate semantic-audit mode flip…` |
| whatsapp_main | 2026-04-30 11:41Z | `[OPERATOR-CHECKIN] 12h follow-up on the SEAF-T2 reassign request to Laizys…` |
| thiago-taskflow | 2026-04-30 11:03Z | *Envie um lembrete para o grupo: "⏰ M23 começa em 30 minutos…"* |
| thiago-taskflow | 2026-04-30 11:03Z | *Enviar lembrete para Thiago: Reunião SDU Sul (M22) começa em 1 hora…* |
| whatsapp_main | 2026-04-30 07:33Z | `[AUDITOR-CHECKIN] Validate today's prevention changes…` |
| laizys-taskflow | 2026-04-29 22:23Z | `[OPERATOR-FIX] Hygiene reassign of SEAF-T2…` |
| seaf-rh-taskflow / seaf-contabilidade-taskflow / seaf-geadmin-taskflow / seaf-astec-taskflow | 2026-04-23 12:01Z | `[TF-ONBOARDING] Read /workspace/group/gtd-05-executar-whatsapp.md…` (4 boards seeded same minute) |

**Patterns:**
- ~70% of fired once-rows are `[AUDITOR-CHECKIN]` or `[OPERATOR-*]` — operator-driven self-supervision, NOT user-driven reminders.
- **User-driven reminders** ("lembrar amanhã às 7h30", meeting reminders): clearly happen but in much smaller volume (the Thiago reminders above are real). 4 onboarding broadcasts on 2026-04-23.
- Only **1** future once-row is queued right now — reminder usage is sparse.

The **89 cron schedules** (87 active) all sit on round hours: `0 14 * * 5` (28 — Friday 14:00 reviews), `0 8 * * 1-5` (16 standups), `0 18 * * 1-5` (14 digests), plus DST sync clones (`3 8 * * 1-5`, `6 8 * * 1-5`, `3 18 * * 1-5`, `6 18 * * 1-5`, 6 each). All boards get the same standup/digest/review trio.

---

## 9. Auditor (Kipp) findings

Kipp dryrun outputs are at `/home/nanoclaw/nanoclaw/data/audit/semantic-dryrun-YYYY-MM-DD.ndjson`. Daily deviation count:

| Date | Deviations | | Date | Deviations |
|---|--:|---|---|--:|
| 2026-04-19 | 147 | | 2026-04-27 | 7 |
| 2026-04-20 | 71 | | 2026-04-28 | 18 |
| 2026-04-21 | 35 | | 2026-04-29 | 36 |
| 2026-04-22 | 37 | | 2026-04-30 | 12 |
| 2026-04-23 | 67 | | 2026-05-01 | 12 |
| 2026-04-24 | 15 | | 2026-05-02 | 8 |
| 2026-04-25 | 19 | | 2026-05-03 | 6 |
| 2026-04-26 | 12 | | | |

Total: 502 deviations in 15 days. The trendline is good — early-window 100+/day dropped to 6–12/day after the prevention commits landed (2026-04-30).

### Recurring deviation patterns (sampled from 2026-05-01 ndjson):

1. **Multi-action prompts where bot does only the first** — *e.g.* `"p2.15 nota X / atribuir p2.15 para Ana Beatriz prazo 30/04/26 / p2.15 adicionar nota detalhada Y"` — bot adds the nota but ignores reassign + due_date + second nota. **Most common Kipp finding.**
2. **List queries answered by mutation** — *e.g.* user says `"aprovar tarefas josele / Quero os projetos e atividades atribuidas a cada pessoa da equipe"` — bot approves a task and returns a confirmation, never lists projects.
3. **Anthropic API surrogate-pair errors** — recent `400 invalid_request_error: no low surrogate in string` causes the bot to bubble the API error verbatim back to the user (e.g. P6.12 conclusion attempts on 2026-04-30).
4. **Auto-corrections** — user re-edits the same `due_date`/`scheduled_at` within 60 min using explicit DD/MM after the bot resolved a relative date wrongly. Kipp distinguishes 🔴 *bot error* from ⚪ *legit iteration*.
5. **Audit-trail divergence warnings** — `deliveriesToGroup ≥ 5` but `botRowsInGroup < deliveries × 0.5` (the 2026-04-13 silent-board pattern: `send_message_log` says 91 deliveries, `messages.db` has 0 bot rows because the host died mid-write).
6. **`broken_groups` for `secti-taskflow`** — bot has never delivered to that JID; humans don't post there either; group looks dormant.

Kipp delivery: 4 task-run failures in the last 30 days (out of 1843 success). Kipp DM thread (`558699916064@s.whatsapp.net`) received 47 bot reports across the last 15 days. The 2026-05-03 7:04 run shows the recent OAuth/API 401 failure: *"Your organization does not have access to Claude. Please login again or contact your administrator."*

---

## 10. Failed mutations and host errors

### `task_history` rollback / error / fail / revert actions

**Zero rows.** TaskFlow does not record rollbacks at the action level. Failed mutations either succeed silently, get retried, or get fixed manually (the `[OPERATOR-FIX]` once-tasks are the human equivalent of a rollback).

### `task_run_logs` (scheduled task health)

| Status | Count |
|---|--:|
| success | 1843 |
| error | 35 |

Scheduled cron health: 98.1% success.

### Host errors in `nanoclaw.log` (last 7d window)

- **Baileys WebSocket reconnects** — `connection errored / Connection Terminated by Server / Stream Errored` happens many times per day. Self-healing; no message loss observed.
- **Anthropic API `400 invalid_request_error: no low surrogate in string: line 1 column ~90000`** — happens when Anthropic gets passed a payload with a lone UTF-16 high surrogate (probably from a truncated emoji in board context). Bot bubbles the error to the user. **Recurring bug.**
- **`Primary Ollama model failed, trying fallback`** — Kipp model fallback path triggers 1–2 times per audit run (glm-5.1 cloud → glm-5.1 cloud fallback or local).
- **`Your organization does not have access to Claude`** — most recent (2026-05-03 04:04Z and 07:04Z) — Kipp Anthropic auth degraded. New issue.

---

## 11. Reassign / handoff patterns

`task_history` reassign analysis:
- Total `reassigned` actions: **210** (8.3% of all 2,532 history rows).
- Last-60d `reassigned`: 206 — virtually all reassigns are recent.
- Last-30d top boards: `board-seci-taskflow` 66, `board-laizys-taskflow` ~25, others <10.

Sample reassign details:
- *2026-04-30 12:35Z* `board-seci/P2.15`: by `giovanni`, `mauro → ana-beatriz`, `was_linked=true`, `relinked_to=board-asse-seci-taskflow-2` — **cross-board relink** preserved through reassign.
- *2026-04-30 11:41Z* `board-sec/T96`: by `laizys`, `laizys → maura-rodrigues-da-silva`, `was_linked=true`, `relinked_to=null` — link severed on reassign.
- *2026-04-30 09:32Z* `board-laizys/T48`: by `laizys`, `laizys → mario-jose-da-silva-junior` — vanilla in-board.

So reassign is **frequent and consequential**: ~15% of mutations on the busiest board (`seci-taskflow`) are reassigns, and they sometimes carry cross-board relink semantics. No bulk-reassign primitive surfaces in `task_history` (no single actor producing N reassigns in one minute) — every reassign is one-at-a-time.

### Top history actors (last 30d)

| Actor | Mutations | Notes |
|---|--:|---|
| `lucas` | 245 | asse-seci-taskflow primary |
| `giovanni` | 239 | seci primary, drives most projects |
| `mauro` | 159 | seci secondary |
| `laizys` | 87 | SEAF board owner, multi-board ops |
| `mariany` | 68 | seci |
| `thiago` | 65 | own board |
| `miguel` | 55 | platform operator |
| `web-api` | 42 | mutations from the web UI |
| `taskflow-api` | 13 | mutations from REST/MCP |

`web-api` + `taskflow-api` together are 55 mutations — about 2% of all mutations come from non-WhatsApp paths. **97%+ of TaskFlow activity happens through WhatsApp**.

---

## 12. Most-used MCP tools (by `task_history.action` frequency, last 60d)

| Action | Count | What it implies |
|---|--:|---|
| `updated` | 963 | Generic field updates (title, description, label) |
| `created` | 553 | New task |
| `reassigned` | 206 | `assignee` change (210 lifetime) |
| `conclude` | 155 | Move to done |
| `cancelled` | 130 | Archive as cancelled |
| `update` | 78 | Likely older variant of `updated` |
| `review` | 71 | Move to review column |
| `wait` | 63 | Move to waiting column |
| `start` | 58 | Move to in_progress |
| `approve` | 50 | Manager approves a task in review |
| `child_board_created` | 25 | Sub-board provisioned |
| `subtask_added` | 22 | Subtask created |
| `reparented` | 21 | Subtask moved between projects/boards |
| `note_added` | 10 | Notes written |
| `subtask_removed` | 9 | |
| `return` | 9 | Returned to inbox |
| `detached` | 9 | Cross-board link severed |
| `delete` | 9 | Hard delete |
| `resume` | 7 | Out of waiting |
| `moved` | 6 | Generic column move |
| `assigned` | 6 | First-time assignee set (vs reassign) |
| `comment` | 5 | |
| `child_rollup_updated` | 5 | Child-execution rollup |
| `parent_linked` | 4 | Cross-board link created |
| `add_external_participant` | 3 | External invited to meeting |
| `force_start` | 2 | Override WIP limit |
| Misc (≤3 each) | ~25 | type_corrected, reminder_added, person_registered, etc. |

The "long tail" of action names (~25 with ≤3 occurrences) reveals **action-name drift** in the engine: `created`/`create`, `updated`/`update`/`update_field`, `reassigned`/`assigned`, `concluded`/`conclude`, `approved`/`approve`, `cancelled` — three or four naming conventions coexist in production data. v2 should canonicalize.

---

## 13. Field usage (sparse-vs-dense fields)

| Field | Used (rows) | % of 356 live tasks |
|---|--:|--:|
| `due_date` | 135 | 38% |
| `priority` (any non-empty) | 60 | 17% |
| `labels` (≠ '[]') | ~25 | 7% |
| `recurrence` | 2 | 0.6% |
| `participants` (meeting only) | 20 | 100% of meetings, 5.6% of all |
| `child_exec_enabled` | 0 actively used (column populated mostly with NULLs/0 except sub-execution boards) | rare |
| `attachment_enabled` | 28 boards = ALL | 100% (default-on) |
| `reminders` JSON column | scattered (1 history row `reminder_added`) | ≤5% |

- **Priority** is mostly empty; when set, mostly `normal`/`low`/`high`. Native taxonomy is mixed Portuguese/English (`alta`, `urgente`, `urgent`).
- **Labels** are used by a small subset; format varies (escaped JSON `"[\"orgao:SECTI\"]"` vs canonical `["orgao:SECTI"]`) — **another canonicalization gap**.
- **Recurrence** is used by 2 SEC tasks (monthly relatórios) and 1 Thiago meeting (weekly IA team). Recurring engine code is mostly cold.
- `attachment_audit_log` table **does not exist in central taskflow.db** — schema present in code but never created/migrated. Attachments either flow through a different table or aren't being audited.

---

## 14. Inbound message split (router / dm-routing usage)

`messages` table, last 60 days, `is_from_me=0`:

| Where | Count |
|---|--:|
| Inbound to **groups** (`@g.us`) | 3,821 |
| Inbound to **DMs** (`@s.whatsapp.net`) | 45 |

DM senders (last 60d):
- Miguel Oliveira (operator) — 41 DMs across two of his JIDs (LID + s.whatsapp.net). These are Kipp-thread DMs.
- JFILHO 😎 — 2
- Ana Rita Rodrigues — 1
- Oliveira — 1

So **4 of the 45 DMs come from real users; 41 from the operator's own thread**. DM as a user-facing channel sees almost zero traffic. The 9 DM chats in `chats` (7 active in 30d) are mostly Kipp threads + a few one-off pings.

The earlier note about "44 inbound DMs / 323 outbound" reflected a longer window or different counting (probably included system messages); the 60d picture is **45 inbound DMs total, 4 from real users**.

### Inbound by group (top 10, 60d)

| Group | Inbound msgs |
|---|--:|
| ASSE-SECI/SECTI - TaskFlow (asse-seci-taskflow) | 474 |
| SECI-SECTI - TaskFlow (seci-taskflow) | 410 |
| CI-SECI-SECTI - TaskFlow | 135 |
| SETD-SECTI - TaskFlow | 77 |
| SEAF-SECTI - TaskFlow (laizys) | 69 |
| SETEC-SECTI - TaskFlow | 59 |
| EST-SECTI (João Antonio) - TaskFlow | 58 |
| ASSE-SECI - TaskFlow | 47 |
| EST-SECTI - TaskFlow | 40 |
| SEC-SECTI - TaskFlow | 37 |

Same shape as task creates — `asse-seci` and `seci` are the volume drivers.

### Bot outbound volume

Daily bot-outbound peaks around 200–425 messages/day mid-April; ~100–200/day late April; 2–4/day on the recent weekend (2026-05-01 to 05-03). The drop-off correlates with the recent OAuth/API auth failure (Kipp couldn't run, and most boards probably saw degraded responses too).

---

## 15. Verdict — load-bearing vs theoretical/dead

Categorized for v2 migration scope:

### LOAD-BEARING (must work in v2 day-1)

| Feature | Evidence |
|---|---|
| **Task CRUD on simple/project tasks via WhatsApp** | 553 creates, 963 updates, 155 conclude, 130 cancel in 60d. 97%+ of mutations come through WhatsApp |
| **Reassignment** | 210 reassigns, 15% of mutations on the top board. Used cross-board (link preservation logic must work) |
| **Subtasks (parent_task_id, depth ≤2)** | 31 parents, 154 subtasks, max depth 2. Flat parent pointer |
| **GTD column moves** (start/wait/review/conclude/return) | 358 column-move actions in 60d combined |
| **Approval flow** | 50 `approve` + 22 `subtask_added` + WIP enforcement (force_start used twice). Manager review pattern |
| **Daily routines** (standup 08:00, digest 18:00, weekly review Friday 14:00) | 87 active cron rows, 1843 successful runs |
| **`send_message` cross-board** | **422 deliveries in 60d (28% of all bot sends).** Two patterns: child→parent rollups, parent→child broadcasts |
| **Meetings on one board (Thiago)** | 13 meetings, 11 in last 30d, with reminders 30 min / 1 hour before via `schedule_task` |
| **Reminders via `schedule_task once`** | 161 fired in 60d. ~70% operator self-checkin, ~30% genuine user reminders |
| **Hierarchy (level 1/2/3 boards)** | 1 root + 6 mid + 21 leaf. 26 child_board_registrations rows. Works well, no bugs surfaced |
| **Kipp daily auditor** | 502 dryrun deviations flagged in 15d → drove down to ~6/day after prevention commits |

### THEORETICAL / DEAD (safe to drop or postpone)

| Feature | Evidence |
|---|---|
| **`subtask_requests` approval queue** | **0 rows ever.** All 28 boards have `cross_board_subtask_mode='open'`. Cross-board subtask approval has never been exercised in production |
| **External meeting participants** | 3 contacts total, 3 invite rows, 0 acceptances. 6-week-old data on 2 boards. Works but invisible |
| **`external_contacts.last_seen_at`** | Always NULL. Wired but unread |
| **Recurring tasks** | 2 boards × 3 tasks total. Monthly + weekly. Negligible |
| **Cross-board "linked parent" cleanup logic** | 3 live linked tasks; 21 reparented, 9 detached events in 60d. Used but tiny |
| **DM as a user channel** | 4 real-user DMs in 60d. Operator self-DM (Kipp thread) is the only steady-state DM traffic |
| **Bulk-reassign primitive** | Doesn't exist in history — every reassign is solo |
| **Labels** | ~25 tasks; format inconsistent (escaped vs raw JSON) |
| **Priority** | 17% set, mixed taxonomy (`alta` vs `high`, `urgent` vs `urgente`) |
| **`attachment_audit_log` table** | Code references it; **table does not exist** in central DB. Migration gap |
| **27 of 37 boards** | Zero tasks created in 60d. Dead boards |

### CANONICALIZATION DEBT (must clean during v2 cut)

- Action name drift: `created` vs `create`, `updated` vs `update` vs `update_field`, `concluded` vs `conclude`, `approved` vs `approve`, `cancelled` (one form), `reassigned` vs `assigned`, `note_added` vs `add_note`, `delete` vs `deleted_via_web`, `returned_to_inbox` vs `return`, `concluded` vs `conclude` — **at least 8 doublets**
- Priority: pt-BR/en mix — `alta`/`high`, `urgente`/`urgent`
- Labels: escaped-JSON-string vs raw-JSON storage
- Phone canonicalization debt already documented in `feedback_canonicalize_at_write.md`

### KEY SURPRISE

**28% of all bot outbound messages are cross-board.** Earlier validation said "send_message_log 100% group/0 DM" which is true, but it framed `send_message` as a same-board feature. **It isn't.** In production, sending into another board's WhatsApp group is a first-class, daily-volume routine — child boards push digests up to parents, parents broadcast back down. The cross-board subtask *approval* code is dead (0 `subtask_requests`), but cross-board *messaging* is one of the most-used features.

If v2 ships without `send_message` to arbitrary group JIDs, the SECTI fleet's roll-up/roll-down communication breaks immediately.

### Secondary surprise

The `subtask_requests` table has **never had a single row** in production despite 22 `subtask_added` and 21 `reparented` events in 60d. The cross-board subtask approval queue is paid-for, dead infrastructure. v2 should not port it; if cross-board subtasks need approval in v2, design fresh.

### Tertiary surprise

73% of registered boards are dead (no creates in 60d). Onboarding (the `[TF-ONBOARDING]` once-tasks fired 2026-04-23 across SEAF boards) doesn't convert — boards get registered but their teams don't adopt. Worth examining the 9 active boards for the pattern that makes them stick.

---

## Appendix — Methodology

All counts are point-in-time queries against the production DBs as of 2026-05-03. SQL is reproducible against the same DB paths. Timestamps in the DB are UTC; meeting `scheduled_at` and once-task `last_run` are UTC; per the timezone feedback note, user-facing displays should be `America/Fortaleza` (UTC−3).

Where percentages are reported for "last 60d", they're against `WHERE created_at >= date('now','-60 days')` (rolling). The `boards` table has 9 zombie rows with UUID-style IDs and no human-readable name; these are likely seeded test rows from earlier provisioning and should be considered for cleanup independently of v2 migration.
