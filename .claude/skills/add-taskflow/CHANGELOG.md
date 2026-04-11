# TaskFlow Skill Package Changelog

## 2026-04-11 (later, Edilson premature-registration fix)

### Engine + template — prevent person-named child boards on hierarchy boards
Ground-truth investigation of Kipp's 2026-04-11 audit report found a real bug in the SETD-SECTI flow on 2026-04-10: a meeting-participant add for "Edilson" caused the bot to call `register_person` with only 3 fields (name/phone/role) on a hierarchy board, and the host's `src/ipc-plugins/provision-child-board.ts` fell back at L308-L317 to `sanitizeFolder(personId) + '-taskflow'`, creating a child board literally named "Edilson - TaskFlow" instead of the division name. Three-part fix, Codex-verified (gpt-5.4 high, clean review):

- **Engine** `container/agent-runner/src/taskflow-engine.ts` `buildOfferRegisterError` (L1824): now calls `canDelegateDown()` and appends the division/sigla ask to the base message on hierarchy boards. Leaf boards keep the unchanged 3-field wording. This removes the compliance burden from the bot — the engine-provided verbatim message already contains all four asks.
- **Engine** `container/agent-runner/src/taskflow-engine.ts` `register_person` case (L5907): hard validation at the top. If `canDelegateDown()` AND any of `phone`, `group_name`, or `group_folder` is missing or whitespace-only, returns `{ success: false, error: 'register_person on a hierarchy board requires <missing fields> alongside person_name — ...' }` BEFORE any INSERT into board_people. Leaf boards skip this validation so the "observer/stakeholder without WhatsApp" flow still works on flat boards. Phone was added to the required set in a follow-up tightening after Codex flagged it as a residual gap — without phone, `auto_provision_request` silently no-ops at L5971 (gated on `params.phone`), leaving the user confused about why the child board didn't appear. Managers/delegates that should NOT have their own child board must be added via `provision-root-board.ts` direct SQL or via `add_manager`/`add_delegate` on an existing row, not through `register_person`.
- **Template** `.claude/skills/add-taskflow/templates/CLAUDE.md.template` L545: strengthened the offer_register handler with "you MUST STOP and NOT call register_person until the user has given you all four fields" language and a note that the engine will now return a hard error if called without group_name/group_folder on a hierarchy board.

**Tests** `container/agent-runner/src/taskflow-engine.test.ts` — 6 new cases at the top of the admin describe (L3321):
1. Happy path: hierarchy board register_person with phone + group_name + group_folder succeeds
2. Regression guard: hierarchy board without group_name/group_folder → rejected, no row created
3. Whitespace-only group_name/group_folder → rejected (symmetric check)
4. Leaf board without group_name/group_folder → allowed (validation does NOT over-fire on leaves)
5. Hierarchy with group_name/group_folder but no phone → rejected with "phone" in error (was originally a locked-down documentation of the gap; promoted to rejection after the follow-up tightening)
6. Leaf board without phone → allowed (preserves observer/stakeholder flow on flat single-level boards)

Also updated the existing `offer_register for unknown assignee` test to assert the division ask is present in the hierarchy-fixture message, and fixed several stale drift-check tests in `.claude/skills/add-taskflow/tests/taskflow.test.ts` that still expected old template wording from before 626debd / 7c444ec / aca7940.

## 2026-04-11 (later, template LOW polish)

### CLAUDE.md.template — pt-BR accent polish on bot-output strings
Small polish pass focused on output-side Portuguese strings that were missing accents. Input-side command synonyms in the left column of command tables INTENTIONALLY stay unaccented (to match what users type in WhatsApp, which often drops accents) and were NOT touched.

- **L547** (`wip_warning` response handler) — `"[person] ja tem N tarefas em andamento"` → `"[person] já tem N tarefas em andamento"`. The backticked command reference `` `forcar TXXX para andamento` `` stays unaccented to match the canonical command-synonym row at L185 (users copy-paste the form they see).
- **L550** (`recurring_cycle` non-expired output) — `"Ciclo N concluido. Proximo ciclo: DUE_DATE"` → `"Ciclo N concluído. Próximo ciclo: DUE_DATE"`.
- **L552** (`recurring_cycle` expired output) — `"✅ RXXX concluida (ciclo final: N)"` → `"✅ RXXX concluída (ciclo final: N)"`.
- **L554** (`recurring_cycle` expired output) — `"Recorrencia encerrada. Deseja:"` → `"Recorrência encerrada. Deseja:"`.
- **L556** (`recurring_cycle` expired option 2) — `"2. Estender ate uma nova data"` → `"2. Estender até uma nova data"`.

Note: this is a partial LOW pass. The original three-agent review flagged ~17 LOW items but the review output wasn't persisted as a file, so only the items I could re-surface concretely in a focused search ship here. A deeper LOW-sweep remains open for a future commit if the user wants one.

## 2026-04-11 (later, template MEDIUM cleanups)

### CLAUDE.md.template — 15 MEDIUM template-side cleanups (follow-up to a49c292)
Template-only polish pass on items flagged MEDIUM by the three-agent review. All 15 have a clear canonical source (engine code, user manual, or the feature-matrix inventory), so they ship without requiring user design decisions.

- **M1** `(L878, Hierarchy Commands)` — reconciled the three conceptually adjacent "create child board" names. `provision_child_board` is now documented as the canonical MCP tool (no longer marked `(if available)`), with explicit notes that: (1) the primary path is auto-provision triggered by `register_person`; (2) manual `provision_child_board` is for when auto-provision didn't fire or when overriding `group_name`/`group_folder`; (3) the low-level `create_group` tool at L30 is for non-board WhatsApp groups only.
- **M2** `(L264-L265, Updates section)` — replaced the due-date-only rule with a clear two-category explanation: (1) structural operations on the subtask array (`add_subtask`/`rename_subtask`/`reopen_subtask`/`assign_subtask`/`unassign_subtask`) route through the **parent** project ID with the subtask referenced via the operation's inner `id` field; (2) plain field updates (`due_date`/`priority`/`labels`/`title`/`notes`/etc.) pass the **subtask** ID as `task_id` directly because subtasks are real task rows.
- **M3** `(L845, Schema Reference)` — added the `boards` table row with its full column list (id, group_jid, group_folder, board_role, hierarchy_level, max_depth, parent_board_id, short_code) plus the use-case hint for `offer_register` uniqueness validation.
- **M4** `(L846, Schema Reference)` — added the `external_contacts` table row (external_id, display_name, phone, direct_chat_jid, status, created_at, updated_at, last_seen_at) and the `meeting_external_participants` join table. Includes a call-out that the column is `display_name` while the `add_external_participant` API parameter is `name` — different names for the same field.
- **M5** `(L73, Authorization Matrix heading)` — title now reads "Authorization Matrix (descriptive — engine enforces, never pre-filter)" with a 2-line preamble making it unambiguous that the table DESCRIBES role scopes and is not a client-side gate. The existing L83 enforcement note stayed in place as the longer explanation.
- **M6** `(new prose after Reassignment table, L222)` — added a paragraph clarifying that `confirmed` is a `taskflow_reassign`-only parameter and is NOT accepted by any other tool. Prevents the "why doesn't my `taskflow_admin` dry-run work?" confusion.
- **M7** `(same prose, L222)` — documented the engine's uniform dry-run semantics: `confirmed: false` or omitted → returns `requires_confirmation` summary without executing; `confirmed: true` → executes. Applies to both single-task and bulk reassigns. Explains why the table uses `true` directly for single-task reassigns (clear user intent) and `false → summary → true` for bulk transfers (blast radius warrants the summary).
- **M8** `(L932-L938, Cross-Board Assignee Guard)` — rewrote the diagnose steps to match the engine's actual `offer_register` response. Step 1 now routes `offer_register`-carrying rejections through the existing Tool Result Handling branch (send the engine-supplied message verbatim, collect fields, register, retry), instead of pretending the error is always a bare string that the agent must compose its own response to.
- **M9** `(L1086-L1088, schedule_task)` — clarified cron vs once semantics: cron is always in the board's local timezone and has no `Z`/UTC concept; `once` is an ISO-8601 timestamp where naive-local form is preferred (host `new Date()` interprets as local time in process TZ). `Z` IS accepted by the once-parser but means UTC and will fire at a different wall-clock time — only use when the user explicitly asked for UTC. The TIMEZONE rule at the bottom of the list still says "write naive local, do not append Z" as the pragmatic default.
- **M10** `(L877, "remover quadro do [pessoa]")` — prefixed the row with a ⚠️ warning naming the three missing guarantees compared to MCP-tool paths: no 60-second undo snapshot, no cross-group notification dispatch, no engine validation. Confirmation prompt updated from "remover quadro é irreversível" to "remover quadro é irreversível — não há undo e ninguém será notificado". Added guidance that the agent must send manual `send_message` notes to both parent and child groups if the user expected notifications.
- **M11** `(L965, non-business-day override)` — documented that `allow_non_business_day` lives at **top level** for `taskflow_create` (sibling of `title`/`due_date`) but **inside `updates`** for `taskflow_update` (sibling of the field being set). Added two concrete example call shapes side-by-side. Mirrors the engine interface asymmetry at `taskflow-engine.ts:65` (CreateParams) vs `taskflow-engine.ts:156` (UpdateParams.updates).
- **M12** `(L456-L458, changes_* queries)` — accept both verb forms. Each `mudancas hoje|desde ontem|esta semana` row now also accepts the equivalent `o que mudou ...` phrasing.
- **M13** `(L424, quadro/status row)` — added `como está?` and `como está o quadro?` as additional aliases for the board query. Matches informal user phrasing from the 2026-04 prod interaction corpus.
- **M14** `(new rows L296-L299, Admin section)` — added 4 user-level holiday command rows that reference the fixed `manage_holidays` shape (add / remove / list / set_year). The rows use `holiday_operation` + arrays (matches 626debd), making them directly usable without forcing the agent to re-derive the API shape from the trailing prose at L302-L307. The `set_year` row carries a "prefer this over many add calls when the user provides an annual calendar" hint.
- **M15** `(L1124, attachment_audit_log INSERT)` — marked the raw `INSERT` dormant. The engine writes this row automatically when the attachment intake MCP tool handles the import, so the agent should NOT issue the manual INSERT in that path. The raw SQL form is kept only as a fallback for operators doing one-off manual imports — with a check-with-user warning when the agent finds itself outside the normal flow.

## 2026-04-11 (later, template cross-doc drift backfill)

### CLAUDE.md.template — 7 HIGH cross-doc drift fixes (follow-up to 626debd)
After shipping the 5 HIGH bugs in 626debd (`manage_holidays` params + 4 internal inconsistencies), the same three-agent review surfaced 7 additional HIGH items that drift between the template, engine source, and the meetings reference doc. All 7 have a canonical source in the engine or user manual.

- **H1** L426 — accept bare `"revisao"` as alias for the Review-column query alongside `"em revisao"` (matches user-manual phrasing from the 2026-04 interaction corpus).
- **H2** L294-L295 — add `"mover TXXX para dentro de PYYY"` as an equivalent trigger for `reparent_task`, and `"destacar PXXX.N"` as an equivalent trigger for `detach_task`. Both phrasings appear in prod interaction history but had no template row.
- **H3** L286 — rewrite the `"cadastrar Nome, telefone NUM, cargo"` row to make the 2-step flow explicit: on hierarchy boards (`HIERARCHY_LEVEL < MAX_DEPTH`), STOP after the 3-field form and ask for the division/sector sigla first; only after receiving it call `register_person` with `group_name`/`group_folder`. On leaf boards (`HIERARCHY_LEVEL == MAX_DEPTH`), call `register_person` directly with the 3 fields. Previously conflated these paths and buried the ask in a trailing note.
- **H4** L220 (new row) — add inbox one-shot shortcut `"TXXX para Y, prazo DD/MM"` that fires `taskflow_reassign` (auto-moves inbox→next_action) then `taskflow_update` with `due_date` in a single agent turn, reporting both outcomes in one reply.
- **H5** docs/taskflow-meetings-reference.md L82, L103 — `add_external_participant` parameter renamed `display_name` → `name` to match engine `taskflow-engine.ts:144` (`add_external_participant?: { name: string; phone: string }`).
- **H6** docs/taskflow-meetings-reference.md L92 — `remove_external_participant` shape corrected from bare `external_id` to `{ external_id?, phone?, name? }` to match engine `taskflow-engine.ts:145`.
- **H7** docs/taskflow-meetings-reference.md L13, L43, L163, L192 — clarified `scheduled_at` input format. Engine at `taskflow-engine.ts:387` (`localToUtc`) accepts naive local-time (no `Z`/offset) and converts via board timezone; `Z`/offset inputs are kept as-is; the DB always stores UTC. Updated overview, create-option table, and both Common Examples to use naive local strings so the canonical pattern is consistent.

### CLAUDE.md.template — 5 HIGH-severity fixes (shipped in 626debd, backfilled here)
- **manage_holidays params** L302-L306 — `operation` → `holiday_operation`, `dates/year` → `holidays[]/holiday_dates[]/holiday_year` arrays. Also documented the `list` operation. Evidence: `ipc-mcp-stdio.ts:940-943` + `taskflow-engine.ts:6289-6366`. Pre-fix every `"adicionar feriado"` would error with `Missing required parameter: holiday_operation`.
- **taskflow_move action list** L1017 — removed `cancel` from the listed move actions (cancellation is `taskflow_admin({ action: 'cancel_task' })`, not a move action).
- **Rendered Output Format reference** L424 — `(see Board View Format)` → `(see Rendered Output Format)` to match the section it links to.
- **Hierarchy depth off-by-one** L30 — `current level + 1 < taskflow_max_depth` → `current level + 1 <= taskflow_max_depth` to match engine `ipc-tooling.ts:31`.
- **Cycle arithmetic + schema nullable** L258 + L833 — `CURRENT_CYCLE + N` → `parseInt(CURRENT_CYCLE, 10) + N` (stored as decimal-integer string, not JSON); `current_cycle TEXT (JSON object)` → `nullable decimal integer as string — parse with parseInt; NOT a JSON object`. Also corrected adjacent `recurrence TEXT` description from "JSON object" to "frequency string: daily/weekly/monthly/yearly".

## 2026-04-11 (later)

### Auditor — scheduled_tasks + read-query + intent exemptions (follow-up to 910f87f)
- **Problem**: Kipp's 2026-04-10 audit flagged 9 interactions across 7 boards. After investigation, ZERO were real bot bugs — all were auditor structural false positives from the same root cause: the auditor's only mutation-detection path checks `task_history` in `taskflow.db`, which misses every legitimate non-mutation action path.
- **Four false-positive classes surfaced and fixed**:
  1. **Scheduled tasks (2 🔴)**: reminder requests (`"lembrar na segunda às 7h30 de X"`) create rows in `store/messages.db → scheduled_tasks`, never in `task_history`. Verified in prod — both SECI-SECTI flags corresponded to `active` scheduled_tasks rows with correct schedule/content/target. Fix: new `scheduledTasksStmt` query against `messages.db`, rolled into `mutationFound`.
  2. **Read-query (1 ⚪)**: `"quais tarefas tem o prazo pra essa semana?"` is a pure info request, but `prazo` is a WRITE_KEYWORD. Fix: `isReadQuery()` with HARD/SOFT split — `qual`/`quais`/`quantos`/`quantas` always read; `que`/`quando`/`onde`/`quem` only when message ends with `?` OR has no comma (not a subordinate clause wrapping an imperative like `"Quando concluir T5, avise o João"`).
  3. **User-intent declaration (1 ⚪)**: `"Vou concluir T5 depois"` is user announcing own action, not commanding bot. Fix: `isUserIntentDeclaration()` with first-person modal (`vou`/`vamos`/`pretendo`/`estou indo`/`estamos indo`) + 0-2 intervening adverbs + infinitive verb. Uses `\S` (not `\w`) for Unicode safety on accented Portuguese adverbs like `já`/`também`. Multi-clause disqualifier `\b(?:mas|porém)\b|;` so compound "declaration + real command" still flags.
  4. **Refusal false positive (1 🟡)**: `"não está cadastrad"` removed from `REFUSAL_PATTERN`. The bot emits it in HELPER OFFERS after successful work (`"✅ T5 atualizada. X não está cadastrada. Quer que eu crie uma tarefa no inbox?"`). Real refusals still match via `não consigo`/`não posso`/etc.
- **Flagging logic (interim form, later superseded by the architectural cleanup)**: `writeNeedsMutation = !isRead && !isIntent && (isTaskWrite || (isWrite && !isDmSend))`
- **Interaction record**: now emits `isRead` and `isIntent` alongside `isDmSend` so Kipp can reason about suppression reasons narratively.
- **Prompt updates**: `schedule_task` added to supported-engine list; the cadastrad removal + all 5 intent bits documented in rule 4.
- **Tests**: 66 → 126 tests. +5 drift guards (HARD, SOFT, INTENT, INTENT_MULTI_CLAUSE, REFUSAL patterns byte-identical with flag check, mutationFound composition, interaction-record shape, scheduled_tasks `<=` upper bound).
- **Review**: Codex (gpt-5, high, read-only sandbox) first pass flagged HIGH/MEDIUM/LOW/LOW — all four addressed in the same commit: read-query hard/soft split, intent multi-clause disqualifier, scheduled_tasks `<=` boundary match, drift guard tightening.

### Auditor — verifiable send_message audit trail (architectural follow-up, supersedes regex DM exemption)
- Parallel to the scheduled_tasks fix: the regex-based DM-send exemption (`DM_SEND_PATTERNS` → `!isDmSend` gate) had been the source of every auditor false-positive round this session. Replaced with a verifiable `send_message_log` table populated host-side after every successful delivery.
- **Host-side** (src/db.ts + src/ipc.ts): new `send_message_log` table in `store/messages.db`, `recordSendMessageLog()` helper, wiring in the two IPC delivery branches (group + DM). Schema migration is idempotent via `CREATE TABLE IF NOT EXISTS`.
- **Auditor-side** (auditor-script.sh): new `sendMessageLogStmt` queried alongside `task_history` and `scheduled_tasks`. Split evidence model:
    - `taskMutationFound = mutations.length > 0 || scheduledTaskCreated`
    - `crossGroupSendLogged = sendMessageLogStmt.get(...) !== undefined`
    - `mutationFound = isTaskWrite ? taskMutationFound : (taskMutationFound || crossGroupSendLogged)` — task-write messages STILL require a real task mutation, preserving mixed-intent correctness ("avise a equipe e concluir T5" still flags if T5 didn't get concluded).
- `writeNeedsMutation` simplified to `!isRead && !isIntent && isWrite`. `!isDmSend` gate removed entirely. `DM_SEND_PATTERNS` is still compiled but `isDmSend` is now purely informational in the interaction record for Kipp's narrative layer.
- Interaction record gains `taskMutationFound` and `crossGroupSendLogged` fields (seven-signal matrix total with the five existing intent bits).
- **Follow-up /simplify pass**: three parallel review agents (reuse, quality, efficiency) then produced four concrete refinements — extracted `SendTargetKind = 'group' | 'dm'` type alias into `src/types.ts` (eliminates stringly-typed duplication), consolidated the two `recordSendMessageLog` call sites in `ipc.ts` using a `deliveredKind` discriminator (30 → 20 lines, one try/catch), collapsed preview-truncation ternary to plain `.slice(0, 200)`, trimmed 22 lines of narrating comments in `auditor-script.sh`.
- **Rollout**: host commit ships before the auditor-side consumer; the schema exists and is populated before any reader queries it, and the auditor's 10-minute window makes the transition self-healing within a day of deploy.

## 2026-04-11 — Feature audit backfill

The 2026-04-11 TaskFlow feature audit found these shipped and validated
features had no skill-CHANGELOG coverage. They were introduced earlier in
the 2026-02-24 → 2026-04-11 window as part of foundational work but were
not individually logged at the time. Backfilled here so the CHANGELOG
matches the feature-matrix inventory.

### Tasks (foundational)
- **Create simple task with assignee** — base `taskflow_create` path (top-20 usage across boards).
- **Create project with subtasks** — `type=project` with nested subtasks, foundation for the hierarchical delegation model.
- **Quick capture to inbox** — `column=inbox` create path for frictionless capture before triage.
- **Start task — move to in_progress** — `action=start` transition (top-20).
- **Force start task** — `action=force_start` manager override that bypasses WIP limits.
- **Resume task from waiting** — `action=resume` transition back to in_progress.
- **Approve task — done from review** — `action=approve` transition (top-20).
- **Reject task — back from review** — `action=reject` transition returning to in_progress.
- **Conclude task — done without review** — `action=conclude` transition for review-less completion (top-20).
- **Reopen task from done** — `action=reopen` transition for post-done corrections.
- **Reassign task** — single-task reassignment through `taskflow_update` (top-20).
- **Update task fields** — title, priority, labels, description edits via `taskflow_update` (highest usage of any action at 685 executions).
- **Add, edit, and remove task notes** — notes branch of `taskflow_update`.
- **Cancel task** — soft-delete with 60-second undo window (top-20).
- **Add subtask to project** — `subtask_added` admin action (top-20, tied).
- **Remove subtask from project** — `subtask_removed` admin action.
- **Detach subtask — promote to standalone** — `detached` admin action that severs the parent link without deleting the task.
- **Bulk reassign tasks** — multi-task reassignment in a single call (top-20).

### Recurrence
- **Simple recurring tasks** — diário, semanal, mensal, anual cadences via `advanceRecurringTask`.
- **Skip non-business days on due date** — holiday-aware rounding with 252 holidays configured; used by every due-date calculation.

### Meetings
- **Meeting workflow state transitions** — start, wait, resume, and conclude transitions on the `meeting` task type (complementing the meeting-notes feature already logged on 2026-03-08).

### Auditor (2026-03-29 daily audit subsystem)
- **Daily auditor run at 04:00 BRT** — cron-driven run over the previous day's interactions.
- **Detect unfulfilled write requests** — flags messages that requested a mutation but produced no matching `task_history` row.
- **Detect delayed response** — flags responses that took more than 5 minutes.
- **Detect agent refusal** — pattern match on known refusal phrases.
- **Classify interactions by severity** — 5 emoji buckets (🔴🟠🟡🔵⚪) applied by `auditor-prompt.txt`.

### Cross-board
- **Cross-board assignee guard** — prevents child boards from reassigning parent-board tasks to people unknown to the parent.
- **Cross-board meeting visibility** — child-board users invited to parent-board meetings can see and participate in them (2026-03-18 timezone-and-crossboard-meeting-fixes plan).

### Digest and standup
- **Weekly review** — Friday automatic report summarizing the week across the board.

### External participants
- **Send external invite via DM** — cross-group invitation flow that DMs external meeting participants from an organizer-authenticated context.

### Admin and config
- **Manage board holidays** — add, remove, and bulk `set_year` operations on `board_holidays` (feeds R034 rounding).
- **Scheduled task cron management** — register, edit, and remove cron-based scheduled runners through the IPC `scheduled_task` plugin.

## 2026-03-27

### Cross-Board Project Rollup
- `refresh_rollup` now counts subtasks of tagged projects, not just directly-tagged tasks
- Auto-triggers rollup from `move()`, `cancel_task`, and `restore_task` when any task with an upward link changes status
- Parent board sees real-time progress of child board project subtasks
- Removed inline rollup hardcoding in `move()` — unified counting-based rollup for all paths

### Reparent Task
- New `reparent_task` admin action: move standalone tasks under existing projects as subtasks
- Preserves all metadata (due_date, priority, notes, history, column)
- Task keeps its original ID (no broken references)
- Undoable within 60 seconds
- Manager-only operation with guards: target must be a project, task must not already be a subtask

### Duplicate Notification Fix
- Cross-board notifications no longer send duplicates when assignee is on the parent board

### Subtask Deadlines
- Agents can now set individual due_date on subtasks (template documentation gap fixed)

### Post-Merge Test Fixes (1.2.23 → 1.2.35)
- Updated test file paths from old `add/`/`modify/` skill dirs to source tree (branch-based migration)
- Exported `groups`, `renderGroup`, `checkGroup` from `generate-claude-md.mjs` for test imports
- Fixed ISO date assertions: engine returns `.000Z` suffix, updated 11 assertions
- Fixed English→Portuguese string expectations for external participant notifications
- Fixed external participant grant expiry dates (near-present → far-future to avoid test-time expiry)
- Added `external_contacts` prereqs for DM notification tests
- Fixed board view sort test (cancel seeded task to stay under summary threshold)
- All 338 TaskFlow tests now pass

## 2026-03-26

### Cross-Board Delegation Display
- Child board agents can reassign parent board tasks to subordinates (delegation allowed)
- Parent board displays delegated tasks under the accountable person (last internal assignee)
- Delegation indicator `➤ _delegateName_` on individual task lines
- Delegation count in summary mode (`_4 tarefa(s), 1 delegada(s)_`)
- `task_details` includes `delegation_chain` array showing full assignment path
- Subordinates never added to parent board's `board_people`
- Cross-board name cache (`extName`) avoids repeated lookups
- Production data cleanup: reverted leaked external assignees on SEC board

## 2026-03-23

### Evening Digest — No-Stress Mode
- Digest stripped of pendências/overdue/stale/priorities — calm evening closing
- Removed duplicate overdue footer from board view (⚠️ in columns is enough)
- Date injection in scheduled prompts — prevents wrong day-of-week in messages
- CLAUDE.md regenerated for all 12 boards
- Stabilized flaky weekly trend test

### Board Provisioning
- Cross-board person matching: reuse existing board by phone number, auto-unify person_id
- Hardened: transaction wrapping, PK collision handling, board_admins cleanup
- Forwardable invite for external meeting participants with organizer name
- Honest invite status (pending vs sent)

### WhatsApp
- Participant count verification fixes false LID JID mismatches
- 2s delay + enriched JID matching from metadata

### Template
- Always include task title when referencing by ID
- Parent project shown first for subtask display

### Upstream Merge Compatibility
- Synced all skill modify/ and add/ copies after upstream merge (deee4b2)
- `cleanupOrphans` aligned with `stopContainer` — individual stops with `-t 1`
- Resolved merge conflicts in container-runtime.ts (kept command injection fix), index.ts (kept stripInternalTags + createGroup deps), ipc.ts (kept handler registry)
- WhatsApp participant verification fix tracked in modify/ with updated intent file

### Board Provisioning Fixes
- **fix:** Seed `available_groups.json` during provisioning via new `seedAvailableGroupsJson()` helper
- **fix:** Include IPC dir in `fixOwnership` for child boards (was only fixing groups/ dir)
- **fix:** Skip TaskflowEngine schema migrations when opened readonly — fixes `SqliteError` on context preamble for new boards

## 2026-03-22

### UX Overhaul — Board Readability
- **Compact board header**: Digest/weekly reports replace full Kanban board with column counts, cutting message length ~50%
- **Smart board view**: Standup/on-demand board shows summaries for 3+ tasks per person, details for fewer; board owner first
- **Motivational message**: Separate send_message after digest/weekly — celebration line + warm human summary
- **Person briefing**: "Tarefas do Rafael" returns structured dispatch view grouped by urgency, projects expanded with subtasks
- **Stale summaries**: 3+ stale tasks show per-person counts instead of individual listings
- **Parent project context**: Subtasks display parent project (📁 P24 — Agência INOVATHE / P24.1)
- **Notification layout**: Unified format with single separator, removed redundant actor names
- **Separator cleanup**: Confirmations use one separator after title, no double separators

### Direct Transitions
- **wait/review/return** accept more source columns — no intermediate chaining, one move = one notification
- **waiting_for cleanup**: Cleared on any exit from waiting column, not just resume/done/review

### Container Reliability
- **No busy preemption**: Scheduled tasks wait for idle containers instead of killing mid-query
- **Starvation timer**: 2-minute timeout forces close if container never goes idle
- **pendingClose leak fix**: Stale close requests don't carry to next container run

### Code Quality
- Extracted `fetchActiveTasks`, `renderStaleTasks`, `cleanupRun` shared helpers
- Hoisted SEP to class constant
- Fixed 17 pre-existing test failures (Portuguese localization)
- Added 15 new tests (compact board, direct transitions, starvation, drain lifecycle)

## 2026-03-18

### Fixed
- **Auto-assign to sender**: Tasks created without an explicit assignee are now auto-assigned to the sender (board owner). Previously only meetings did this; other types sat unassigned in inbox. Eliminates unowned tasks and the confusion of assigned-vs-unassigned inbox states.
- **Start from inbox**: `start` and `force_start` now allow tasks in `inbox` column directly, removing two special-case branches. Previously, assigned inbox tasks had no valid `start` path — agents would thrash and resort to raw SQL.
- **Digest credits assignee**: Evening digest closing now names the person who completed a task ("Laizys resolveu") rather than crediting the board owner.
- **Timezone handling**: `scheduled_at` passed without `Z` suffix is now treated as local time (board timezone) and automatically converted to UTC by the engine. Values with `Z` are kept as-is for backward compatibility. All notification messages (reminders, start, reschedule, invites) now display local time via `utcToLocal`.
- **Cross-board meeting visibility**: Child board agents can now view meetings on parent boards where their people are participants or organizer. `getTask()` extended with `isBoardMeetingParticipant` check.
- **External participants in task_details**: `task_details` query now includes `external_participants` for meeting tasks.
- **Meeting query board_id**: `meeting_participants`, `meeting_history`, and `meeting_minutes_at` now use the owning board ID for all lookups, fixing incorrect results when queried from child boards.
- **Tool descriptions**: `scheduled_at` in `taskflow_create` and `taskflow_update` now describes local time format, explicitly instructing agents not to append `Z`.

### Parent Board Notifications for Task Updates
- **feat:** `taskflow_update` now sends parent board notifications when a child board updates a delegated task (notes, priority, due date changes). Previously only `taskflow_move` (column transitions) notified the parent board, so update notes from child boards went unnoticed.
- **refactor:** Extracted `buildParentNotification()`, `getBoardGroupJid()`, and `deduplicateNotificationsForParent()` helpers — shared between `move()` and `update()`, eliminating duplicated parent notification logic.
- **refactor:** Extracted `ParentNotification` type — replaces inline `{ parent_group_jid: string; message: string }` in `MoveResult`, `UpdateResult`, and `ipc-mcp-stdio.ts`.

### Timezone Fix for schedule_task Reminders
- **fix:** CLAUDE.md template now explicitly instructs agents that `schedule_value` for `once` tasks is LOCAL time (no `Z` suffix). Previously agents would store UTC values without `Z`, causing `new Date()` to interpret them as local time — reminders fired 3 hours late in GMT-3 zones.
- **fix:** Clarified `scheduled_at` (taskflow_create DB field, stored as UTC with `Z`) vs `schedule_value` (schedule_task IPC, interpreted as local time without `Z`).

## 2026-03-17

### Ollama Configuration
- **keep_alive: -1** on all Ollama calls (embed + generate) — models stay loaded in GPU permanently
- **Default summarizer model** changed from `llama3.1:8b` to `frob/qwen3.5-instruct:27b`
- **Summarizer timeout** increased from 30s to 60s for larger model

### Duplicate Prevention (engine-level)
- **Hard block ≥95% similarity**: `taskflow_create` refuses creation, `force_create` cannot override
- **Soft warning 85-94%**: unchanged behavior, `force_create` still works
- **CLAUDE.md**: repeated "Inbox: ..." is not a confirmation — agent must remind user task exists

### Motivational Digest Closing
- **Explicit prohibitions** against pressure/blame language in evening digest
- **Bad day guidance**: "find the human story" even with zero completions and many overdue items
- **Friday close**: perspective on the week, not just the day

### Default Assignment
- Tasks created without explicit assignee are automatically assigned to the sender

### Reminder Time Handling
- Agent must ask for time when not specified, never silently default to 12h
- If user doesn't answer or says "tanto faz", default to 08:00 (start of business)

### Recovery Noise Filter (core)
- `recoverPendingMessages()` now filters `⏳ Processando...` and typing indicators
- Prevents spurious container starts and unwanted standups on service restart

### Skill File Sync
- Populated missing files in 4 skills to match their manifests:
  - add-embeddings: `add/` (4 files) + `modify/` (3 files)
  - add-image-vision: `add/plugins/image-vision/` (4 files)
  - add-long-term-context: `add/` test files (3 files)
  - add-taskflow: `modify/` (container-runtime.ts, group-queue.ts)

## 2026-03-15 (continued)

### Bug Hunt Fixes (rounds 1-4, 20 agents)

- **fix:** Counter seeding regression — split OR-joined UPDATE into two independent statements so one counter's default doesn't trigger regression of the other (taskflow-db.ts)
- **fix:** Subtask ID collision after deletion — use max existing suffix instead of count to prevent P1.3 collision when P1.2 was cancelled (taskflow-engine.ts)
- **fix:** Delegated task duplication in `buildContextSummary` — use actual `task.board_id` for rankedIds set instead of `this.boardId` (taskflow-engine.ts)
- **fix:** Group name deduplication fails without ` - TaskFlow` suffix — fallback appends `(personName)` directly (provision-child-board.ts)
- **fix:** SDK error results reported as `status: 'success'` — now correctly reports `status: 'error'` with error details for max_turns, budget, execution errors (agent-runner/index.ts)

### Long-Term Context Integration

- **Conversation recap preamble**: Up to 3 recent summaries injected before each agent session (after embedding preamble)
- **MCP tools**: `context_search`, `context_recall` available to all agents for conversation history search

### Flood Prevention (core)

- **Message noise filter**: Skip WhatsApp "Processando..." indicators — prevented 786-message flood on Giovanni's board
- **Per-group rate limit**: 5-second minimum between agent invocations with drain-loop prevention

### Template Updates

- **Reminder vs inbox**: Intent-based analysis replaces keyword-to-tool mapping. "Lembrar" defaults to reminder, asks for time if missing.
- **Implicit inbox promotion**: Auto-assign to board owner on organic interaction with inbox tasks

## 2026-03-15

### Embeddings Integration (semantic search, duplicate detection, context preamble)

- **Semantic search**: MCP handler embeds query via Ollama, injects `embedding_reader` into engine; engine owns ranking with composite keys (`board_id:task_id`) and +0.2 semantic boost
- **Duplicate detection**: `force_create` flag in `taskflow_create` Zod schema; 0.85 cosine threshold via `ollamaEmbed()` + `findSimilar()`; returns `duplicate_warning` with similar task info
- **Context preamble**: Host embeds user message → `containerInput.queryVector` (base64) → container builds preamble via `engine.buildContextSummary(queryVector, reader)` using `visibleTaskScope()` → prepended to prompt
- **Taskflow embedding sync**: `src/taskflow-embedding-sync.ts` polls taskflow.db every 15s, feeds `EmbeddingService` with `buildSourceText(task)` = title + description + next_action
- **CLAUDE.md template**: Added Duplicate Detection section to all 11 group templates

### Inbox Processing Fix

- **In-place promotion**: Inbox items now promoted via `taskflow_reassign` + `taskflow_update` on existing task instead of create-new + cancel-original; preserves task ID, history, and counter
- **CLAUDE.md template**: Updated Inbox Processing section with WRONG/RIGHT examples and `taskflow_reassign` auto-moves inbox→next_action

### Implicit Inbox Promotion

- **Auto-assign on organic interaction**: When a user reports progress on an inbox task without specifying an assignee, agent auto-assigns to board owner and executes immediately — no more asking "do you want me to assign it first?"
- **CLAUDE.md template**: Added "Implicit inbox promotion (organic interaction)" subsection before formal triage flow

### WhatsApp Group Plugin Fixes (37-bug audit)

- **#9**: Null guard on `groupCreate` result — crash on `result.id` when API returns null
- **#20**: Off-by-one participant cap — creator not counted in 1024 limit
- **#21**: LID JID participants falsely reported as "dropped" — added `translateJid()` in verify steps
- **#22**: Stale listener after socket reconnect — `reconnecting` flag prevents concurrent reconnects, `sock.end(undefined)` before new socket
- **#24**: `@c.us` and `@lid` JID suffixes not stripped in `resolvePhoneJid()` — normalize to `@s.whatsapp.net`
- **#33**: `droppedParticipants` tracking — caller now knows which participants need invite link
- **#36**: Re-verify catch block now sets `allAdded = false` instead of assuming success

### Message Formatting Standardization

- **Consistent response format**: All TaskFlow agent responses use standardized formatting with separator lines, bold headers, and emoji column indicators

### Bug Fixes (61+ across 3 rounds of 20 subagents)

- Comprehensive sweep across 14 files — see commit `1a1d95a` for full list
- Key fixes: env.ts path resolution, group-folder.ts sanitization, credential-proxy.ts auth, mount-security.ts validation, sender-allowlist.ts device suffix normalization
- WhatsApp: message queue re-queue on send failure, LID translation for group message senders, `participantAlt` fallback

### Skill Manifest Updates

- Added to manifest: `dm-routing.ts`, `taskflow-embedding-sync.ts`, `container-runtime.ts`, `group-queue.ts`, `whatsapp-add-participants.ts`, `whatsapp-check-groups.ts`, `whatsapp-fix-groups.ts`
- All add/modify reference copies synced to match live code

## 2026-03-08

### Meeting Notes Feature

- **Meeting type** with `M`-prefix IDs via `board_id_counters`
- **Schema**: `participants TEXT` and `scheduled_at TEXT` columns on tasks
- **Recurring anchor**: `recurrence_anchor TEXT` persisted for recurring meetings
- **Phase-tagged notes**: auto-tagged from column state (`pre`/`meeting`/`post`), with `parent_note_id`, `status` (`open`/`checked`/`task_created`/`inbox_created`/`dismissed`), `processed_at`, `processed_by`, `created_task_id`
- **8 meeting query types**: `meetings`, `meeting_agenda`, `meeting_minutes`, `upcoming_meetings`, `meeting_participants`, `meeting_open_items`, `meeting_history`, `meeting_minutes_at`
- **Minutes triage**: `process_minutes` lists open items, `process_minutes_decision` atomically creates follow-up task/inbox and marks note
- **WIP exclusion**: meetings do not count against WIP limits
- **Open-minutes warning**: soft warning when concluding meeting with unprocessed notes
- **Cancel notifications**: participants notified on meeting cancellation
- **Recurring meeting advance**: archives occurrence to `task_history` (not `archive` table), advances `scheduled_at`, preserves participants
- **Base packaged schema sync**: bundled `taskflow-db.ts` and restore paths include meeting fields
- **Board view**: calendar prefix, `scheduled_at` time, participant count display
- **Report integration**: `upcoming_meetings` and `meetings_with_open_minutes` in standup/digest/weekly
- **Scheduled notifications**: day-based reminders and exact-time start notifications keyed to `scheduled_at`, plus minutes-processed notifications propagated
- **MCP schema**: meeting type in `taskflow_create`, 8 queries in `taskflow_query`, meeting fields in `taskflow_update`, `process_minutes`/`process_minutes_decision` in `taskflow_admin`
- **CLAUDE.md template**: meeting commands, notes, scheduling, participants, movement, triage, queries, display, schema reference
- **Participant permissions**: meeting participants can add/triage notes without being assignee or manager

## 2026-04-09

### TaskFlow Web API — WhatsApp Notifications
- **feat:** Web dashboard task events now trigger WhatsApp notifications via NanoClaw IPC
- Supported events: task create (assignee notified), move/status change, reassign, comment
- Uses `deferred_notification` IPC type — NanoClaw watcher resolves `target_person_id` → `notification_group_jid` automatically
- Self-comment suppression: assignee not notified when they comment on their own task
- Notification messages in Portuguese with WhatsApp markdown formatting
- Error logging via `logger.warning` instead of silent `except: pass`

### TaskFlow Web API — Unified Task ID Counters
- **fix:** `next_task_id()` now uses `board_id_counters` table (same as NanoClaw engine)
- Previously used `board_config.next_task_number` — separate counter caused UNIQUE constraint failures
- Supports per-prefix counters (T, P, R, M) matching NanoClaw's `getNextNumberForPrefix()`
- First-use fallback: computes from existing tasks if counter row doesn't exist yet

### TaskFlow Web API — User Profile & Auth
- **feat:** `/auth/me` now resolves `person_id`, `role`, and `primary_board_id` from `board_people` via phone number matching (last 8 digits)
- Auto-populates `users.name` from `board_people.name` if empty on login
- Profile page shows actual role (e.g. Gestor) instead of hardcoded Membro

### TaskFlow Web API — Board Filtering by Ownership
- **feat:** `/boards` endpoint filters by `owner_person_id` + all descendant boards (BFS traversal)
- Added `owner_person_id` column to boards table
- Each logged-in user sees only their boards and children — root owner sees everything
- Test/seed boards no longer visible to authenticated users

### TaskFlow Web API — Parent Task Title
- **feat:** `fetch_tasks` includes `parent_task_title` via correlated subquery (cross-board)
- Enables dashboard to show project context on subtask cards (e.g. P1 - Migração SEI)

### TaskFlow Dashboard — Kanban Layout Restoration
- **fix:** Restored last-week's kanban layout that agents had broken via deploy drift
- Columns default expanded (not auto-collapsed when empty)
- Gray `bg-slate-200` backdrop restored behind kanban
- Horizontal scrollbar pinned at viewport bottom via `height: calc(100vh - 262px)`
- Columns sized to content via `items-start`, capped at viewport height via per-column `maxHeight`
- Vertical scrollbar restored on columns with many tasks
- People panel scrollbar added for large teams (e.g. Seci with 13 members)
- Negative margins moved to wrapper div to fix scrollbar start position
- Cancelled column removed from `TASK_COLUMNS` (kept in type for future use)

### TaskFlow Dashboard — Personal Board Task Aggregation
- **feat:** Personal boards (hierarchy with `parent_board_id`) aggregate tasks assigned to the owner from parent board
- Orphan subtasks (parent not in same column) render as top-level cards
- Deduplication: parent board tasks not shown twice if also on own board

### TaskFlow Dashboard — Owner Name UX
- **feat:** Board owner's name hidden on their own task cards (redundant info)
- Uses `owner_person_id` from board config, resolves via `people` list + `matchesAssigneeName`
- Works across all boards, not just personal boards

### TaskFlow Dashboard — Delegation Chain Display
- **feat:** Non-member assignees resolved to board member via subtask assignees (cross-column)
- P27/P24 on Sec Secti show Carlos Giovanni (delegator) instead of Mauro (delegate's delegate)
- `resolvedAssignees` map computed in BoardDetail, passed to KanbanColumn
- TaskCard now displays `assigneeAvatarName` (resolved) instead of raw `task.assignee`

### TaskFlow Dashboard — Deploy Incident Fix
- **fix:** DevOps agent broke dashboard with `rsync --delete` flattening `dist/` structure
- Restored `dist/` with correct build, restarted serve from `dist/`
- Deploy freeze enforced — no agent deploys without operator approval

## 2026-04-11 — Verifiable send_message audit trail (architectural)

### Auditor — replace DM-send regex exemption with send_message_log
- **Motivation**: Every auditor round this session surfaced a new Portuguese conjugation gap in `DM_SEND_PATTERNS` (singular → plural, infinitive → synthetic future, subordinator clauses, etc.). The root cause is using regex to **infer** whether the bot sent a message, instead of checking whether it actually did. This commit replaces the inference with a verifiable audit trail.
- **Host (new `send_message_log` table)**: `src/db.ts` adds the table via `CREATE TABLE IF NOT EXISTS` (idempotent, no migration needed). `src/ipc.ts` writes a row after every successful `deps.sendMessage()` in both the authorized-group and authorized-DM branches, recording `source_group_folder`, `target_chat_jid`, `target_kind` (group|dm), `sender_label`, `content_preview` (200-char truncated), `delivered_at`. Write is wrapped in try/catch so a schema error never breaks IPC delivery.
- **Auditor (container-side consumer)**: new `sendMessageLogStmt` queries the table within the same 10-minute window as task_history and scheduled_tasks. The flagging logic splits mutation evidence into two buckets:
  - `taskMutationFound`: task_history row OR scheduled_tasks row — task-level evidence
  - `crossGroupSendLogged`: send_message_log row — delivery evidence
  - `mutationFound = isTaskWrite ? taskMutationFound : (taskMutationFound || crossGroupSendLogged)` — unambiguous task writes still demand a real task mutation, so mixed-intent messages like "avise a equipe e concluir T5" still flag if the T5 conclusion didn't happen.
- **writeNeedsMutation simplified**: was `!isRead && !isIntent && (isTaskWrite || (isWrite && !isDmSend))`, now `!isRead && !isIntent && isWrite`. The `!isDmSend` regex gate is gone — authoritative DM-send evidence now comes from the log. `DM_SEND_PATTERNS` stays compiled and `isDmSend` stays in the interaction record as a narrative classifier for Kipp's rule 4 reasoning, but it no longer gates anything.
- **Interaction record** now exposes `taskMutationFound` and `crossGroupSendLogged` alongside the five existing bits (`isWrite`, `isTaskWrite`, `isDmSend`, `isRead`, `isIntent`). Kipp's rule 4 rewritten around the 7-signal matrix, with the mixed-intent exception made explicit.
- **Tests**: drift guards extended to pin the new SQL shape (`WHERE source_group_folder = ? AND delivered_at >= ? AND delivered_at <= ?`), the three-way `if (isWrite)` query block that consults all three tables, the `taskMutationFound` / `mutationFound` composition, and the new interaction-record fields. A guard blocks re-introduction of `!isDmSend` in `writeNeedsMutation`. `auditor-dm-detection.test.ts` stays at 144 tests (no new runtime tests — the regex helpers unchanged), full container agent-runner suite 406/407 pass (1 pre-existing todo).
- **Rollout**: Host changes must deploy before the auditor changes to populate the log. Transition is self-healing: the auditor's 10-minute window means old pre-deploy interactions use the old regex path one last time, and everything after deploy uses the verified path.

## 2026-04-10

### TaskFlow API — Codex Review Fixes (6 issues, 5 regression tests)
- **fix:** Schema migrations: `boards.owner_person_id` column + `board_id_counters` table added to `ensure_support_tables` for fresh installs and legacy DB upgrades
- **fix:** `/auth/me` backfill UPDATE now runs on separate read-write connection after read conn closes — prevents write-on-read-only errors
- **fix:** `_resolve_person_id` rewritten — requires 9+ digits, pre-filters last 9 in SQL, confirms full-digit equivalence in Python, returns None on ambiguity (no silent LIMIT 1 mis-mapping)
- **fix:** `TaskNotePayload.normalize_fields` strips whitespace before emptiness check
- **fix:** Debug `traceback.print_exc()` replaced with `logger.exception()`
- 76 tests pass (71 original + 5 new regression tests)

### Gateway Agent Recovery
- Gateway Agent heartbeat was stale since Apr 8 — reset wake_attempts, sent manual heartbeat, now online
- Board agent heartbeat intervals doubled (PF 30m, PB 30m, Architect 20m, QA-Unit 20m, QA-E2E 20m, DevOps 40m)
- Supervisor kept at 5m, Gateway Agent kept at 10m
- MC DB heartbeat_config synced to match gateway config

## 2026-04-10

### Auditor — DM-send false positive fix
- **Problem**: `auditor-script.sh`'s `isWriteRequest()` matched messages containing shared vocabulary like `"prazo"`, `"lembrar"`, `"lembrete"`, `"nota"` as write requests, then expected a matching `task_history` row. DM-send requests (`mande mensagem pro X alertando sobre o prazo`) never touch `task_history` — they call `send_message`. Result: every cross-group DM with a deadline/reminder was guaranteed to trip `unfulfilledWrite=true`, and Kipp's report then accused the bot of lying about sending. Confirmed structurally by tracing the 2026-04-09 audit: Thiago's DM in `thiago-taskflow` actually did land in Reginaldo's PO board at 18:04:43, the bot's `send_message` calls fired correctly, but the auditor couldn't verify any of it.
- **Fix (regex)**: added `DM_SEND_PATTERNS` (4 patterns) covering explicit "send a message/reminder/note to X" constructions, notify/alert verbs, conversational "say to / ask X" verbs, and informal WhatsApp shorthand (`avisa pro João`, `pede pro Lucas`, `mande pro X`). Pattern 1 requires a trailing directional preposition so locative patterns (`escreva uma nota na T5`) don't false-match. Pattern 4 handles `msg` abbreviation and verb+preposition shorthand.
- **Fix (logic)**: introduced `TASK_KEYWORDS` — a strict subset of `WRITE_KEYWORDS` with shared vocabulary (`nota`, `anotar`, `lembrar`, `lembrete`, `prazo`, `próximo passo`, `próxima ação`, `descrição`) excluded — and `isTaskWriteRequest()`. The `task_history` query now ALWAYS runs when `isWrite=true`, and the flagging decision splits: unambiguous task writes (`isTaskWrite`) still demand a mutation even when `isDmSend` is also true; shared-vocabulary writes are only exempted when they're also DM sends.
- **Fix (prompt)**: `auditor-prompt.txt` rule 1 now lists `send_message` as an engine-supported operation (no more "feature ausente" misclassification); rule 4 explains the `isDmSend`/`isTaskWrite` split so Kipp doesn't accuse the bot of false send claims on pure DM interactions but still surfaces genuine task-mutation failures in mixed messages.
- **Tests**: new `container/agent-runner/src/auditor-dm-detection.test.ts` with 53 tests — DM-send positives (including `msg` abbreviation and informal shorthand), task-write negatives (including the Codex-flagged `na/no` locative cases), mixed-intent `isTaskWrite` cases, shared-vocabulary carve-out validation, and drift guards that force the regex and wiring in `auditor-script.sh` to stay in sync with the test literals. All 53 pass, 315/316 pass across the full agent-runner suite.
- **Review**: validated by Codex (gpt-5.4, high reasoning) which flagged three real regressions in the first pass — pattern 1 overreach on locative phrasings, mixed-intent whole-message bypass, and missing informal shorthand — all three addressed in this commit. Architectural follow-up to emit a verifiable audit trail for `send_message` tool calls (rather than regex-exempting) is deferred.

## 2026-04-11

### Auditor — DM-send plural-imperative recall gap (follow-up to 391226b)
- **Problem**: Second-pass Codex review of the DM-send fix surfaced a recall gap — plural imperative forms like `Mandem mensagem pro João sobre o prazo` / `Enviem msg pra equipe sobre o prazo` / `Escrevam um aviso pro time sobre o prazo` / `Notifiquem o gestor sobre o prazo` / `Falem com o João sobre o prazo` / `Peçam ao João para revisar` all evaluated to `isWrite=true`, `isTaskWrite=false`, `isDmSend=false`, meaning `writeNeedsMutation=true` and the original false-positive path was still reachable for group-addressed DM requests.
- **Root cause**: First-pass roots like `mand[ea]r?` / `envi[ea]r?` / `escrev[ea]r?` covered singular (`mande`, `envie`) and infinitive (`mandar`) but not the plural imperative `-em` / `-am` endings. Pattern 2 was missing `notifiquem`, `comuniquem`, `informem`. Patterns 3/4 had no plural verb alternatives at all (`falem`, `digam`, `peçam`, `contem`, `perguntem`). Positive-test set only covered singular/infinitive/gerund forms, so the gap was unguarded.
- **Fix**: Expanded all four patterns to include plural imperative forms — pattern 1 roots restructured as `mand(?:ar|em|e|a)` / `envi(?:ar|em|e|a)` / `escrev(?:er|am|e|a)`; pattern 2 grew `notifi(?:quem)` / `comuniqu(?:em)` / `inform(?:em)`; pattern 3 added `digam|contem|falem|perguntem|peçam|pecam`; pattern 4 added the same plurals plus `pedem`.
- **Drift guard tightening (Codex LOW)**: The existing guard used `script.includes(pattern.source)` which only checked regex source text, not flags — dropping `/i` from the shell-script regex was a silent regression path. Rewrote the check to assert `pattern.flags === 'i'` AND that the full `/${source}/i` literal appears byte-for-byte in `auditor-script.sh`.
- **Tests**: grew from 53 to 66 tests (+10 plural positives, +3 past-tense negatives to lock in that `mandaram`/`enviaram`/`escreveram`/`notificaram` don't match the plural slots). Full agent-runner suite: 328/329 pass (1 pre-existing todo). Heredoc validated with `node --check`.
