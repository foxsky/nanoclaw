# Changelog

All notable changes to NanoClaw will be documented in this file.

For detailed release notes, see the [full changelog on the documentation site](https://docs.nanoclaw.dev/changelog).

## 2026-04-13 — Task container leak when agent result is null

Production incident: sec-secti container had been `Up 2 hours` since the 08:00 TF-STANDUP fired. Miguel sent "Anotar: Reparo do boile, para: Alexandre, prazo: hoje" at 08:35 BRT; the router logged `Container active, message queued` and the message stuck in `pendingMessages` for 1.5h — never reached the container because task containers refuse `sendMessage` IPC (`isTaskContainer` guard).

- **Root cause** — `src/task-scheduler.ts` called `scheduleClose()` only when `streamedOutput.result` was truthy. The standup agent emits its board output via `send_message` MCP (not a final assistant text), so the SDK result is `null`, `scheduleClose` never fires, and the agent-runner loop in the container keeps awaiting more IPC input indefinitely. The message path (`src/index.ts:579`) already handles this correctly by resetting the idle timer on every `status === 'success'` regardless of result text.
- **Fix** — moved `scheduleClose()` into the `status === 'success'` branch so task containers always close promptly after completion, whether the agent returned text or only emitted `send_message` calls.
- **Recovery** — wrote `_close` sentinel into `data/ipc/sec-secti/input/` to release the stuck container; `drainGroup` then ran Miguel's queued message and created task **T94 "Reparo do boiler" → Alexandre** on `board-sec-taskflow`.

Memory `feedback_task_container_close.md` saved.

## 2026-04-12 (evening) — Brazilian phone canonicalization at write boundaries

Production audit of `data/taskflow/taskflow.db` found 22 of 72 phone rows (30%) stored without the `55` country-code prefix — the same human could appear on two boards with different prefixes, silently breaking cross-board person matching and external_contacts lookup. Reginaldo's rows on three boards confirmed the active impact.

- **New canonical helper** — `src/phone.ts` exports a Brazilian-aware `normalizePhone`: strip non-digits → 12-13 digits starting with `55` kept → 10-11 digits with non-zero first digit get `55` prepended → otherwise returned unchanged (international, trunk-prefixed, too short/long). Idempotent fixed-point on already-canonical input. `container/agent-runner/src/taskflow-engine.ts` ships an identical copy (container/host isolation preserved); parity-fixture tests in both suites prevent drift.
- **Write-site canonicalization** — 7 INSERT/UPDATE sites across `src/ipc-plugins/provision-root-board.ts`, `src/ipc-plugins/provision-child-board.ts`, `container/agent-runner/src/taskflow-engine.ts` (`register_person`, `add_manager`, `add_delegate`, `external_contacts`) now canonicalize at the boundary instead of storing raw agent input. Three fallback JID builders (`provision-*.ts`, `channels/whatsapp.ts`) also switched to canonical digits — previously they would produce invalid `85999991234@s.whatsapp.net` JIDs missing the CC.
- **One-time DB migration** — `canonicalizePhoneColumns()` runs in `initTaskflowDb()` after schema migrations. Idempotent. `external_contacts.phone` is UNIQUE-aware (skips on would-collide); `board_people` / `board_admins` are NOT UNIQUE and must canonicalize every row (the whole point of cross-board matching is multiple rows sharing a canonical phone). A first prod deploy had this inverted — fix in commit `26db08c` caught via post-deploy verification that left 8 rows uncanonicalized.
- **provision-child-board cross-board match** — dropped the brittle SQL `REPLACE(REPLACE(...))` chain. Match now fetches candidates and filters in JS with `normalizePhone`, avoiding per-site duplication of separator-stripping rules.
- **Codex gpt-5.4 high review** — reviewed the staged diff before commit (per `feedback_review_before_deploy`). Flagged: missing canonicalization in `add_manager` / `add_delegate` board_admins insert paths, `external_contacts.phone` UNIQUE collision hazard, and two raw-fallback JID builders in provision plugins. All three addressed before commit.
- **Post-deploy verification** — production `board_people` / `board_admins` / `external_contacts` now 100% canonical (was 70%). Reginaldo's three rows all converged on `5586999986334`.

Test coverage: 962 host tests (+25), 456 container tests (+10), clean build. Memory `feedback_canonicalize_at_write.md` saved.

## 2026-04-12 (evening) — Regression tests for cross-board match + subtask ordering

Two Codex-flagged concerns from the 20-commit bug-hunt review turned into pinning tests. Neither was a new bug; both document the existing contract so a future refactor cannot silently re-introduce the original problem.

- **`src/ipc-plugins/provision-child-board.test.ts`** — two new tests around the cross-board person match tightened in `6e3b210`. (1) Phone-only fallback for rename case: different `person_id` + same phone → links and unifies. (2) Both person_id AND phone differ → new board created (intentional false negative; name matching stays excluded).
- **`container/agent-runner/src/taskflow-engine.test.ts`** — legacy-subtask-suffix regression test for `getSubtaskRows`. Production has 8 anomalous rows (reparented subtasks whose IDs don't match the canonical `{parent}.{N}` naming). `CAST(SUBSTR(...))` returns 0 for empty-suffix rows and the numeric suffix for same-length-prefix reparented rows. Test pins the interleaving behavior — strictly no-worse than pre-fix lex order, and the canonical case is fixed.

## 2026-04-12 (evening) — 20-subagent bug hunt (19 real bugs + 1 dead-test fix)

Parallel bug hunt across the codebase, 4 batches of 5 subagents each. All 20 commits reviewed by Codex gpt-5.4 high: 17 real bugs + correct fixes, 2 with concerns (addressed with pinning tests above), 1 dead-test correction. Zero false positives. Highlights:

- `eea67fb` — container.stdin lacks `'error'` listener, EPIPE crashes orchestrator
- `98fb3a5` — `handleDeferredNotification` re-queues without stamping timestamp, TTL expiry disabled
- `182d204` — `schedule_value` parse failure before `computeNextRun` loops forever
- `e4cfc97` — `/compact` slash detection runs on preamble-mutated prompt, demotes to chat
- `6b38008` — `stripInternalTags` case-sensitive, reasoning leaks when LLM emits `<INTERNAL>`
- `092cdda` — `setRegisteredGroup(isMain: undefined)` silently writes `is_main = 0`, demotes main group
- `6ae3d6c` — WhatsApp `messages.upsert` with `type='append'` is history replay; processing duplicates agent actions
- `9efe8cb` — `JSON.stringify` on cyclic Baileys objects throws inside log callbacks
- `8257b4f` — Telegram bot-mention rewrite used global `TRIGGER_PATTERN` for per-group trigger overrides, silently drops mentions
- `e65d285` — `DEFAULT_REVIEW_UTC` was `0 17 * * 1` (14:00 local) when the intent was 11:00 local (Fortaleza is UTC-3 year-round, correct UTC is `0 14`)
- `9812787` — `create_group` forwards duplicate participant JIDs when phone resolution maps two inputs to the same canonical JID; WhatsApp silently drops duplicates
- `2ddcf62` — `getSubtaskRows` lexicographic `ORDER BY t.id` places `P10.10` before `P10.2` for projects with 10+ subtasks
- `9886330` — `unassign_subtask` calls `recordHistory` without `taskBoardId`, history lands on executing board instead of owning board for delegated subtasks
- `3597901` — auditor web-origin filter used `sender_name || sender` OR precedence instead of checking both independently
- `6e3b210` — cross-board person match on `person_id` alone cross-linked unrelated humans sharing an aliased person_id string; now requires `person_id + phone` with phone-only fallback
- `69a4ab7` — WhatsApp pairing-code auth passes raw user phone to Baileys; sanitize to digits + reject obviously-invalid inputs

Full list in the git log between `fd2b217` and `9886330`. Test suites: 933 host / 445 container pass.

## 2026-04-12 (later) — Cross-board subtask Phase 2 (approval flow)

Phase 2 activates on `cross_board_subtask_mode = 'approval'` — previously a stub error, now a real approval workflow. All changes stay within the add-taskflow skill (container/agent-runner + .claude/skills/add-taskflow), no host-side code touched.

- **Schema** — `subtask_requests` table + status index in engine DB init. Persists pending requests across agent restarts.
- **Engine** — `add_subtask` approval-mode branch now inserts a request row and returns `{ success: false, pending_approval: { request_id, target_chat_jid, message, parent_board_id } }` instead of the stub error. The child-board agent relays the formatted message to the parent board's group via `send_message`.
- **Engine** — new `handle_subtask_approval` admin action: parent-board manager approves/rejects pending requests. Approve creates the subtask(s) on the parent board via the existing `insertSubtaskRow` path (no mode-check concern — same-board operation). Reject marks the request rejected with reason. Either way, returns `notifications` with the child-board's `target_chat_jid` + success/rejection text for the agent to relay.
- **IPC Zod** — `handle_subtask_approval` added to action enum. `decision` widened to `'approve'|'reject'|'create_task'|'create_inbox'` (shared with process_minutes_decision). New `request_id` and `reason` params.
- **Template** — child-board guidance for the `pending_approval` response (send message verbatim, show request_id to user). Parent-board guidance for incoming `🔔 *Solicitação de subtarefa*` messages (parse, handle manager's `aprovar req-XXX` / `rejeitar req-XXX [motivo]` reply, relay notifications back).
- **Tests** — 5 new engine tests for handle_subtask_approval (approve, reject with reason, idempotency on non-pending, unknown request_id, non-manager rejected) + 1 updated mode=approval test (validates pending_approval shape + persistence). 234 engine tests / 901 project tests pass. 3 new skill drift-guard tests.

## 2026-04-12 — Cross-board subtask Phase 1

- **`cross_board_subtask_mode` flag** — new `board_runtime_config` column (`TEXT NOT NULL DEFAULT 'open'`). Three values: `open` (direct creation), `approval` (stub for Phase 2), `blocked` (refuse with guidance). Engine check in `add_subtask` path reads the PARENT board's mode; only fires cross-board, same-board always allowed.
- **`merge_project` admin action** — UPDATE-in-place merge of source project subtasks into target project. Rekeys task_history + blocked_by references, adds migration notes on every affected entity, archives source with `reason='merged'`. Manager-only. Source must be local to the current board (Codex review finding: `archiveTask` uses `this.boardId` for archive rows, so delegated sources would land on the wrong board). IPC Zod updated with new action + params.
- **`nextSubtaskNum` helper** — extracted from the duplicated subtask-ID max+1 computation in both `add_subtask` and `merge_project` (/simplify review).
- **Template** — mode-aware guidance after delegated-tasks block, mode-change admin commands (`"modo subtarefa cross-board: aberto|aprovação|bloqueado"`), merge command row (`"mesclar PXXX em PYYY"`), `cross_board_subtask_mode` in schema reference.
- **Tests** — 4 mode tests + 7 merge tests (incl. delegated-source rejection) + 2 drift-guard tests. 229 engine / 898 project tests pass.

## 2026-04-11 (later) — Edilson premature-registration fix (engine + template)

Kipp's 2026-04-11 audit report flagged a "race condition" in SETD-SECTI. Ground-truth investigation of the 2026-04-10 Edilson flow showed it was NOT a race condition — it was `register_person` accepting a 3-field call on a hierarchy board, then the host's `src/ipc-plugins/provision-child-board.ts` fallback at L308-L317 naming the child board "Edilson - TaskFlow" (person name) instead of the division. Three-part fix, Codex gpt-5.4 high-effort review clean:

- **Engine** `container/agent-runner/src/taskflow-engine.ts` — `buildOfferRegisterError` (L1824) now appends the division/sigla ask on hierarchy boards so the verbatim offer_register message already contains all four asks; bot no longer has to "remember" to add it.
- **Engine** `container/agent-runner/src/taskflow-engine.ts` — `register_person` case (L5907) rejects calls on hierarchy boards missing any of `phone`, `group_name`, `group_folder` (or with whitespace-only values) BEFORE any INSERT into board_people. Leaf boards skip the validation so the "observer/stakeholder without WhatsApp" flow still works on flat boards. Phone was added to the required set after Codex review to close a silent no-op: without phone, `auto_provision_request` never fires and the user would be left confused about why the child board didn't appear.
- **Template** `.claude/skills/add-taskflow/templates/CLAUDE.md.template` L545 — `offer_register` handler strengthened with STOP-before-register language and a reference to the new engine hard error.

**Test coverage:** `container/agent-runner/src/taskflow-engine.test.ts` gains 6 new cases (happy path, hierarchy without group_name/folder → rejected, whitespace-only → rejected, leaf board without group_name/folder → allowed, hierarchy without phone → rejected, leaf without phone → allowed) + one assertion added to the existing offer_register test. All 214 container engine tests pass (up from 210 → 4 net new). Several stale drift-check tests in `.claude/skills/add-taskflow/tests/taskflow.test.ts` also updated to match post-626debd/7c444ec/aca7940 template wording.

After Codex flagged the phone-optional silent no-op as a residual gap, the fix was tightened in the same commit to require phone alongside group_name/group_folder on hierarchy boards. Leaf boards still accept phone-less registration to preserve the observer/stakeholder flow on flat single-level boards.

## 2026-04-11 (later) — deploy.sh regenerates group CLAUDE.md

`scripts/deploy.sh` gains a new pre-sync step that runs `node scripts/generate-claude-md.mjs` before the rsync to production. This makes the per-group rendered copies in `groups/*/CLAUDE.md` always consistent with the canonical template at `.claude/skills/add-taskflow/templates/CLAUDE.md.template` on every deploy — removes the manual "did I remember to regen?" footgun.

- Step ordering: `[1/5]…[5/5]` → `[1/6]…[6/6]`. New step `[3/6]` regenerates group CLAUDE.md; the old sync step is now `[4/6]`, container rebuild is `[5/6]`, production import check is `[6/6]`.
- Regen is idempotent — no diff if the template hasn't changed since last deploy, so rsync's delta sync produces no network traffic for unchanged files.
- Regen failure aborts the deploy BEFORE any remote changes happen, matching the existing fail-fast pattern for build and import errors.

## 2026-04-11 (later) — TaskFlow CLAUDE.md.template pt-BR output polish

Partial LOW pass focused on pt-BR accent correctness in bot-output strings. Input-side command synonyms (left column of command tables) intentionally stay unaccented to match WhatsApp user input; only the OUTPUT strings the agent emits to users were corrected.

- `wip_warning` output — `"ja tem"` → `"já tem"` (L547).
- `recurring_cycle` output strings — `"concluido"` → `"concluído"`, `"Proximo"` → `"Próximo"`, `"concluida"` → `"concluída"`, `"Recorrencia"` → `"Recorrência"`, `"ate"` → `"até"` (L550-L556).

Note: partial pass — the original three-agent review flagged ~17 LOW items but the review output wasn't persisted, so only the subset I could re-surface in a focused search ships here.

## 2026-04-11 (later) — TaskFlow CLAUDE.md.template 15 MEDIUM cleanups

Follow-up to a49c292. Fifteen MEDIUM items from the three-agent template review — all template-side polish with clear canonical sources (engine code, user manual, feature matrix). Template file only; no engine or docs-side changes.

- **M1** Reconciled three "create child board" names (`create_group`, `provision_child_board`, auto-provision via `register_person`) into one canonical path with explicit scopes for each.
- **M2** Normalized subtask update operations into two clear categories: structural operations use the parent-project ID + operation's inner `id`; plain-field updates pass the subtask ID directly (subtasks are real task rows).
- **M3 / M4** Added `boards`, `external_contacts`, and `meeting_external_participants` tables to the Schema Reference for ad-hoc SQL.
- **M5** Authorization Matrix heading now explicitly marks the table as descriptive-not-prescriptive.
- **M6 / M7** Documented the `confirmed` flag as `taskflow_reassign`-only and the engine's uniform dry-run semantics (`!confirmed → summary; confirmed: true → execute` for both single and bulk).
- **M8** Cross-Board Assignee Guard now routes through the `offer_register` response path when the engine returns one, instead of having the agent compose its own "person not found" message.
- **M9** Cron vs once scheduling semantics clarified: cron has no `Z`/UTC concept; `once` accepts `Z` but naive local is the canonical form. Matches `src/ipc.ts:156` and `src/task-scheduler.ts:50-57`.
- **M10** Raw `DELETE FROM child_board_registrations` path now carries a ⚠️ warning naming the three missing guarantees (no undo, no notifications, no engine validation) and updated confirmation prompt wording.
- **M11** `allow_non_business_day` placement documented separately for create (top-level) vs update (inside `updates`), matching engine interfaces at `taskflow-engine.ts:65` and `:156`.
- **M12** `o que mudou hoje|desde ontem|esta semana` accepted as alternate phrasings to `mudancas hoje|desde ontem|esta semana`.
- **M13** `como está?` / `como está o quadro?` added as quadro query aliases.
- **M14** Four user-level holiday command rows added to the Admin section (`adicionar feriado`, `remover feriado`, `feriados YYYY`, `definir feriados YYYY`), all using the corrected `manage_holidays` + `holiday_operation` shape from 626debd.
- **M15** Raw `INSERT INTO attachment_audit_log` marked dormant — the engine writes this row automatically through the MCP attachment intake path; the raw SQL form is retained only as a manual-import fallback.

## 2026-04-11 (later) — TaskFlow CLAUDE.md.template cross-doc drift fixes

Follow-up to 626debd (5 HIGH internal-inconsistency fixes). The three-agent template review surfaced 7 more HIGH items that drift between the template, engine source, and the meetings reference doc. All 7 ship in this commit.

- **H1** `.claude/skills/add-taskflow/templates/CLAUDE.md.template:426` — accept bare `"revisao"` alongside `"em revisao"` for the Review-column query.
- **H2** `.claude/skills/add-taskflow/templates/CLAUDE.md.template:294-295` — add `"mover TXXX para dentro de PYYY"` (reparent) and `"destacar PXXX.N"` (detach) as equivalent triggers to the existing rows.
- **H3** `.claude/skills/add-taskflow/templates/CLAUDE.md.template:286` — rewrite `"cadastrar Nome, telefone NUM, cargo"` row to make the 2-step flow explicit: on hierarchy boards (`HIERARCHY_LEVEL < MAX_DEPTH`), ask for the division sigla FIRST, then call `register_person`; on leaf boards, call directly with 3 fields.
- **H4** `.claude/skills/add-taskflow/templates/CLAUDE.md.template:220` — new row for inbox one-shot shortcut `"TXXX para Y, prazo DD/MM"` that fires `taskflow_reassign` then `taskflow_update` with `due_date` in a single turn.
- **H5** `docs/taskflow-meetings-reference.md` — `add_external_participant` parameter renamed `display_name` → `name` to match engine `taskflow-engine.ts:144`.
- **H6** `docs/taskflow-meetings-reference.md` — `remove_external_participant` shape corrected from bare `external_id` to `{ external_id?, phone?, name? }` to match engine `taskflow-engine.ts:145`.
- **H7** `docs/taskflow-meetings-reference.md` — `scheduled_at` documented as accepting naive local-time strings (engine converts via `localToUtc` at `taskflow-engine.ts:387`); updated Common Examples from `"…Z"` to naive local form.

## 2026-04-11 — TaskFlow CLAUDE.md.template 5 HIGH bugs (Codex-verified)

Three-agent template review + Codex second pass flagged 5 HIGH-severity bugs in the rendered-per-group template. All 5 ship in 626debd.

- `manage_holidays` params (`operation` → `holiday_operation`, arrays for `holidays`/`holiday_dates`/`holiday_year`) to match `ipc-mcp-stdio.ts:940-943` + `taskflow-engine.ts:6289-6366`. Pre-fix: every `"adicionar feriado"` would error.
- `taskflow_move` action list: removed `cancel` (cancellation is `taskflow_admin({ action: 'cancel_task' })`, not a move action).
- Internal Rendered-Output-Format reference fixed (`Board View Format` → `Rendered Output Format`).
- Hierarchy depth off-by-one: `current level + 1 < max_depth` → `current level + 1 <= max_depth` to match engine `ipc-tooling.ts:31`.
- Cycle arithmetic + schema nullable: `CURRENT_CYCLE + N` → `parseInt(CURRENT_CYCLE, 10) + N`; schema row rewritten from "JSON object" to "nullable decimal integer as string".

## 2026-04-11 — TaskFlow feature audit backfill

The 2026-04-11 TaskFlow feature-audit pass confirmed these 38 shipped
and validated TaskFlow features had no coverage in the project CHANGELOG.
They were introduced progressively across 2026-02-24 → 2026-04-11 as part
of foundational work but were not individually logged in CHANGELOG at the
time. Backfilled here so the project CHANGELOG matches the feature-matrix
inventory at `docs/taskflow-feature-matrix.md`.

### TaskFlow — Tasks
- **Create simple task with assignee** — base task-creation handler accepting title, assignee, priority, labels, description (R001; 438 prod events).
- **Create project with subtasks** — `type=project` creation path for hierarchical work with child subtasks (R002).
- **Quick capture to inbox** — lightweight capture into the `inbox` column for later triage (R003).
- **Start task (move to in_progress)** — `action=start` transition from next_action/inbox into in_progress, respecting WIP (R004).
- **Force start task (WIP override)** — `action=force_start` bypass of per-person WIP limits for urgent work (R005).
- **Wait task (move to waiting)** — `action=wait` transition parking a task in the waiting column (R006).
- **Resume task (from waiting)** — `action=resume` transition bringing a waiting task back into in_progress (R007).
- **Return task (back to queue)** — `action=return` transition pushing a task back to next_action (R008).
- **Submit task for review** — `action=review` transition into the review column (R009).
- **Approve task (done from review)** — `action=approve` transition marking a reviewed task as done (R010).
- **Reject task (back from review)** — `action=reject` transition returning a review task to in_progress (R011).
- **Conclude task (done without review)** — `action=conclude` transition marking a task done directly (R012; 100 prod events).
- **Reopen task (from done)** — `action=reopen` transition bringing a done task back into in_progress (R013).
- **Reassign task** — change a task's assignee, preserving history and notifications (R014; 195 prod events).
- **Update task fields** — edit title, priority, labels, and description on existing tasks (R015; 685 prod events — highest usage).
- **Add/edit/remove task notes** — freeform note management on tasks (R016).
- **Undo last mutation (60s window)** — `undo_last` restoring the sender's most recent task mutation within 60 seconds (R020).
- **Cancel task (soft-delete, undoable)** — `cancel` action soft-deleting a task with 60-second undo window (R021; 128 prod events).
- **Reparent task across boards** — `reparent` action moving a task between boards while preserving history (R023).
- **Add subtask to project** — attach a new or existing task as a subtask of a project (R024).
- **Remove subtask from project** — detach a subtask from its parent project (R025).
- **Detach subtask (promote to standalone)** — promote a subtask to a standalone task (R026).
- **Bulk reassign tasks** — reassign multiple tasks in a single operation (R028; 189 prod events).

### TaskFlow — Recurrence
- **Simple recurring tasks** — `diario`, `semanal`, `mensal`, `anual` recurrence with automatic next-cycle creation (R031).
- **Skip non-business days on due date** — holiday-aware rounding of due dates forward past weekends and configured holidays (R034; 252 holiday lookups).

### TaskFlow — Meetings
- **Add/remove meeting participants (internal)** — manage internal meeting participant lists alongside the assignee (R037).
- **Meeting workflow state transitions** — `start`, `wait`, `resume`, `conclude` transitions specific to `type=meeting` tasks (R040).
- **Meeting WIP exemption** — meetings bypass the per-person WIP cap since they represent scheduled events rather than active execution work (R043).

### TaskFlow — Auditor
- **Detect delayed response (>5 min threshold)** — auditor heuristic flagging agent replies that arrive more than 5 minutes after the triggering user message (R046).
- **Detect agent refusal** — auditor heuristic pattern-matching refusal phrases in bot responses (R047).
- **Classify interactions by severity (5 emoji buckets)** — auditor rubric bucketing every interaction into one of five severity levels (red/orange/yellow/blue/white) (R048).

### TaskFlow — Cross-board
- **Cross-board rollup update** — child boards emit `child_rollup_updated` events that surface on the parent board (R050).
- **Cross-board rollup blocked signal** — `child_rollup_blocked` signal propagating a blocker from child to parent (R051).
- **Cross-board rollup at_risk signal** — `child_rollup_at_risk` signal surfacing at-risk child work on the parent (R052).
- **Cross-board rollup completed signal** — `child_rollup_completed` signal closing the loop when delegated child work finishes (R053).
- **Cross-board assignee guard** — reassignment guard preventing a child-board task from being reassigned to someone off that board (R054).

### TaskFlow — Digest & standup
- **Weekly review (Friday automatic report)** — `type=weekly` automated report summarizing the week's completed, pending, and blocked work (R058).

### TaskFlow — External participants
- **Send external invite via DM** — dispatcher sending meeting invites to external participants as DMs using their stored phone number (R070).

### TaskFlow — Admin & config
- **Manage board holidays (add/remove/set_year)** — admin action maintaining the per-board holiday list that feeds non-business-day due-date rounding (R077; 252 holiday rows).

## [1.2.52] - 2026-04-11

### Refactor: simplify send_message_log wiring after /simplify review
- `/simplify` pass on `b3590d7` + `c3592d1` (three parallel review agents: reuse, quality, efficiency) produced four concrete fixes. Net: 49+/68- across 4 files.
- **`src/types.ts`**: new exported `SendTargetKind = 'group' | 'dm'` type alias. Replaces the literal union that was duplicated at `src/ipc.ts:544` and `src/db.ts:247`.
- **`src/db.ts`**: `SendMessageLogEntry.targetKind` typed via `SendTargetKind`. Preview truncation collapsed from defensive `len > 200 ? slice : x` ternary to plain `entry.contentPreview.slice(0, 200)` — matches `src/task-scheduler.ts:242/299` style (slice is a no-op on short strings).
- **`src/ipc.ts`**: two `recordSendMessageLog` call sites consolidated into one. Each auth branch now sets a `deliveredKind: SendTargetKind | null` + `deliveredSender` local after its `deps.sendMessage()`, and a single post-branch block writes the audit row exactly once. ~30 → 20 lines, one `try`/`catch` instead of two, one `logger.warn` instead of two. `deliveredKind` stays `null` on blocked-send paths (no auth, DM disambiguation failure) so nothing gets logged.
- **`container/agent-runner/src/auditor-script.sh`**: trimmed 22 lines of narrating comments that restated the next line in prose: three-source preamble above `if (isWrite)` collapsed (kept asymmetric-rule justification); `mutationFound` ternary narration deleted; `writeNeedsMutation` multi-line comment collapsed to 3 lines keeping only the `!isDmSend gate removed` WHY.
- Explicitly skipped (pre-existing or out-of-scope): `sendMessageLogStmt` short-circuit when `isTaskWrite && taskMutationFound` (narrative payload consistency for Kipp), `send_message_log` retention policy, `taskHistoryStmts` `LIMIT 1`, hoisting `db.prepare()` to module-level.

### Feat: verifiable send_message audit trail (TaskFlow architectural cleanup)
- Finally kills the regex-based DM-send exemption that has been the source of every auditor false-positive round this session. Two-part change:
  - **Host (src/db.ts, src/ipc.ts)**: new `send_message_log` table in `store/messages.db` with columns `(id, source_group_folder, target_chat_jid, target_kind, sender_label, content_preview, delivered_at)`. Populated by `src/ipc.ts` after every successful `deps.sendMessage()` call in both the authorized-group and authorized-DM branches. Failure is best-effort: a schema error logs a warn but never breaks the IPC delivery path. Schema migration is idempotent via `CREATE TABLE IF NOT EXISTS`, no ALTER, no backfill.
  - **Auditor (container/agent-runner/src/auditor-script.sh)**: new `sendMessageLogStmt` queries the table alongside `task_history` and `scheduled_tasks`. The three evidence sources split:
    - `taskMutationFound = mutations.length > 0 || scheduledTaskCreated` — task-level evidence
    - `crossGroupSendLogged = sendMessageLogStmt.get(...) !== undefined` — delivery evidence
    - `mutationFound = isTaskWrite ? taskMutationFound : (taskMutationFound || crossGroupSendLogged)` — task-write messages STILL require a real task mutation, so "avise a equipe e concluir T5" with no T5 conclusion still flags.
- `writeNeedsMutation` simplified from `!isRead && !isIntent && (isTaskWrite || (isWrite && !isDmSend))` to `!isRead && !isIntent && isWrite`. The `!isDmSend` gate is gone — DM-send evidence now comes from the log, not from regex matching. `DM_SEND_PATTERNS` remains computed for the informational `isDmSend` bit in the interaction record (Kipp's narrative layer still uses it) but no longer gates flagging.
- Interaction record gains two new fields: `taskMutationFound` and `crossGroupSendLogged`. Kipp's rule 4 is rewritten to explain the seven-bit signal matrix: `isWrite`, `isTaskWrite`, `isDmSend`, `isRead`, `isIntent`, `taskMutationFound`, `crossGroupSendLogged`. The mixed-intent rule is made explicit: when `isDmSend=true && isTaskWrite=true`, `taskMutationFound=true` is required regardless of `crossGroupSendLogged`.
- Tests: drift guards extended — new assertions pin `sendMessageLogStmt` preparation against `msgDb`, the `send_message_log` SQL shape, the three-way `if (isWrite)` query block, the split `taskMutationFound` / `mutationFound` composition, and the new fields in `interactions.push`. A guard also blocks re-introduction of the `!isDmSend` gate in `writeNeedsMutation`. Suite counts: `auditor-dm-detection.test.ts` stays at 144, full container agent-runner suite 406/407 (1 pre-existing todo).
- Host ships as one commit, auditor ships as follow-up — the table exists and is populated before any consumer exists, so containers running the old script are unaffected while the new script gets a working trail from day one.
- Note: existing in-flight messages won't have log rows until the host is restarted with the new code. The auditor's 10-minute window means the transition is self-healing within a day of deploy.

### Fix: auditor scheduled_tasks + read-query + intent exemptions (TaskFlow follow-up)
- Kipp's 2026-04-10 audit surfaced four more structural false-positive classes in the auditor, all driven by the same root cause: the auditor's only mutation-detection path checks `task_history` in `taskflow.db`, which misses every legitimate non-mutation action path the bot takes.
- **Scheduled tasks (2 🔴 false positives)**: reminder requests like `"lembrar na segunda às 7h30 de verificar T86"` create rows in `store/messages.db → scheduled_tasks` via the `schedule_task` tool, never in `task_history`. Verified in prod via SSH that both SECI-SECTI 🔴 flags correspond to `active` scheduled_tasks rows with correct schedule (Monday 2026-04-13 at 07:30 / 08:00), content, and target. The bot did the work; the auditor was structurally blind. Fix: new `scheduledTasksStmt` queries `scheduled_tasks WHERE group_folder = ? AND created_at >= ? AND created_at <= ?` and rolls any hit into `mutationFound`.
- **Read-query exemption (1 ⚪ false positive)**: pure information requests like `"quais tarefas tem o prazo pra essa semana?"` trip `unfulfilledWrite` because `prazo` is in WRITE_KEYWORDS. Fix: `isReadQuery()` split into HARD interrogatives (`qual`, `quais`, `quantos`, `quantas` — never subordinators) that match unconditionally, and SOFT interrogatives (`que`, `quando`, `onde`, `quem` — can introduce subordinate clauses wrapping imperatives) that require the message to end with `?` OR contain no comma. This catches Codex's false negative `"Que tarefas têm prazo hoje?"` AND the false positive `"Quando concluir T5, avise o João"` (temporal subordinator wrapping a real command).
- **User-intent declaration exemption (1 ⚪ false positive)**: first-person future-tense like `"Vou concluir T5 depois do almoço"` exempted via `isUserIntentDeclaration()`. Pattern: modal (`vou`/`vamos`/`pretendo`/`estou indo`/`estamos indo`) + 0-2 intervening adverbs + infinitive verb ending in `-ar`/`-er`/`-ir`. Uses `\S+`/`\S*` (not `\w+`/`\w*`) because JS regex `\w` is ASCII-only and would fail on Portuguese accented adverbs like `já` and `também`. Multi-clause disqualifier `\b(?:mas|porém)\b|;` prevents compound "declaration + real command" messages from slipping through the exemption (e.g. `"Vou concluir T5 depois, mas cria P2 agora"` — the `mas cria` part must still run the mutation check). Plain comma is NOT a disqualifier so that compound pure declarations like `"Vou atualizar ainda hoje, estou indo concluir uma das tarefas agora"` stay exempted.
- **REFUSAL_PATTERN helper-offer carve-out (1 🟡 false positive)**: removed `"não está cadastrad"` from `REFUSAL_PATTERN`. The bot uses that phrase in HELPER OFFERS after successful work (e.g. `"✅ P20.4 atualizada. ... Terciane não está cadastrada no quadro. Quer que eu crie uma tarefa no inbox?"`). Confirmed false positive: the ASSE-INOV-SECTI P20.4 task was updated successfully (nota registrada, próxima ação, prazo ajustado) — the cadastrad mention is an auxiliary offer, not a refusal. Real refusals still match via `não consigo`, `não posso`, `recuso essa instrução`, etc.
- **Flagging logic (interim form; superseded by the architectural cleanup above)**:
    ```js
    writeNeedsMutation = !isRead && !isIntent && (isTaskWrite || (isWrite && !isDmSend));
    ```
- **Interaction record** now emits `isRead` and `isIntent` so Kipp's narrative layer can see the reasoning even when the auditor has already suppressed the flag.
- **`auditor-prompt.txt`**: rule 1 adds `schedule_task` to the supported-engine list; rule 2 notes the cadastrad-based refusal match was removed; rule 4 documents all five intent bits (`isWrite`, `isTaskWrite`, `isDmSend`, `isRead`, `isIntent`) and the full exemption matrix.
- **Tests**: `auditor-dm-detection.test.ts` grew from 66 → 126 (+10 read-query positives, +4 read-query negatives, +8 intent positives, +3 intent negatives, +2 refusal negatives, +5 refusal positives, +5 new drift guards). Full container agent-runner suite: 328/329 pass (1 pre-existing todo).
- **Codex validation (gpt-5, high, read-only sandbox)**: first-pass review flagged HIGH (`isReadQuery` too coarse — subordinator false negatives + missing `que`), MEDIUM (`isIntent` whole-message exemption hiding real commands), LOW (scheduled_tasks off-by-one upper bound), LOW (drift guards don't pin mutationFound composition or interaction-record shape). All four addressed in this commit.

### Fix: auditor DM-send plural-imperative recall gap (TaskFlow follow-up)
- Second-pass Codex review of commit `391226b` surfaced a recall gap in `DM_SEND_PATTERNS`: plural imperative forms (`Mandem mensagem pro João sobre o prazo`, `Enviem msg pra equipe...`, `Escrevam um aviso pro time...`, `Notifiquem o gestor...`, `Falem com o João...`, `Peçam ao João...`) all evaluated to `isWrite=true`, `isTaskWrite=false`, `isDmSend=false` — meaning the original false-positive path (`writeNeedsMutation=true` → flag as `unfulfilledWrite`) was still reachable for group-addressed DM requests containing shared vocabulary like `prazo`.
- Root cause: first-pass regex roots like `mand[ea]r?` / `envi[ea]r?` / `escrev[ea]r?` covered singular (`mande`, `envie`) and infinitive (`mandar`) forms but not the plural imperative / present-subjunctive `-em` / `-am` endings used when addressing a group (`mandem`, `enviem`, `escrevam`). Same gap in patterns 2-4: `notifi(?:que|car|cando)` was missing `quem`, `comuniqu(?:e|ar|ando)` was missing `em`, `inform(?:e|ar|ando)` was missing `em`, and patterns 3/4 had no plural-form alternatives at all (`falem`, `digam`, `peçam`, `contem`, `perguntem`).
- Expanded all four patterns to include plural forms:
    - Pattern 1: `mand(?:ar|em|e|a)` / `envi(?:ar|em|e|a)` / `escrev(?:er|am|e|a)`
    - Pattern 2: added `notifi(?:quem)`, `comuniqu(?:em)`, `inform(?:em)`
    - Pattern 3: added `digam`, `contem`, `falem`, `perguntem`, `peçam` / `pecam`
    - Pattern 4: same plurals + `pedem`, `comuniquem`, `informem`
- Past-tense perfect (`mandaram`, `enviaram`, `escreveram`, `notificaram`) continues not to match — the surrounding `\s+` after the verb slot blocks it cleanly; three new negative tests lock this in.
- Tightened the drift guard at `auditor-dm-detection.test.ts:156` to check `/${pattern.source}/${pattern.flags}` instead of just `pattern.source`. The previous form would silently accept removing `/i` from the shell-script regex (a real regression path). New check asserts both that every `DM_SEND_PATTERNS` entry has `flags === 'i'` AND that the full `/.../i` literal appears byte-for-byte in `auditor-script.sh`.
- Tests: `auditor-dm-detection.test.ts` grew from 53 to 66 tests (+10 plural positives, +3 past-tense negatives). Full agent-runner suite: 328/329 pass (1 pre-existing todo).

## [1.2.52] - 2026-04-10

### Fix: auditor false-positive on DM-send requests (TaskFlow)
- `auditor-script.sh` used to classify any user message containing write keywords like `"prazo"`, `"lembrar"`, `"lembrete"`, `"nota"` as a write request and then look for a matching `task_history` mutation. Cross-group DM requests (e.g. *"Mande mensagem pro Reginaldo alertando sobre o prazo"*) never touch `task_history` — so every such request was structurally guaranteed to be flagged as `unfulfilledWrite=true`, leading Kipp to infer "the bot lied about sending" even when the bot had correctly called `send_message` and the cross-group message had landed.
- Root cause found by tracing the 2026-04-09 audit: Thiago's DM request in `thiago-taskflow` spawned two `send_message` tool calls with `target_chat_jid=120363427128623315` (Reginaldo's PO board), the outbound message landed in Reginaldo's group at 18:04:43, and the bot's confirmation was truthful — but the auditor's `task_history` check couldn't see any of that.
- Added `DM_SEND_PATTERNS` regex array (4 patterns) and `isDmSendRequest()` to detect cross-group send intents. Patterns cover: explicit noun+prep+recipient (`mande mensagem pro X`), notify verbs + article (`avise o João`), say/ask verbs + preposition (`diga ao Pedro`), and informal WhatsApp shorthand (`avisa pro João`, `pede pro Lucas`, `mande pro X`). Pattern 1 requires a trailing directional preposition so locative phrasings (`escreva uma nota na T5`) don't false-match.
- Added `TASK_KEYWORDS` — a strict subset of `WRITE_KEYWORDS` with shared vocabulary removed (`nota`, `anotar`, `lembrar`, `lembrete`, `prazo`, etc.) — and `isTaskWriteRequest()`. Used in the flagging logic to force a `task_history` check on mixed-intent messages like *"avise a equipe e concluir T5"* — if the task-mutation half silently fails, the audit still flags, even when the DM-send half succeeded. The `task_history` query now ALWAYS runs when `isWrite`; the DM-send exemption only applies to pure shared-vocabulary writes.
- Flagging logic is now: `isTaskWrite ? (!mutationFound && !refusalDetected) : (isWrite && !isDmSend && !mutationFound && !refusalDetected)`. The interaction record now includes both `isDmSend` and `isTaskWrite` so downstream reviewers can see why each decision was made.
- Updated `auditor-prompt.txt` so Kipp knows that pure DM-send interactions (`isDmSend=true && isTaskWrite=false`) cannot be verified via `task_history` and should not be accused of "false send claims" on that basis alone; and that mixed-intent interactions (`isTaskWrite=true && isDmSend=true`) still demand a task mutation. `send_message` is also now listed in the engine-supported-operations rule so Kipp doesn't classify it as "feature ausente".
- New vitest file `container/agent-runner/src/auditor-dm-detection.test.ts` — 53 tests covering: DM-send positive cases (including `msg` abbreviation and informal shorthand), task-mutation negative cases (including the Codex-flagged `na/no` locative patterns), mixed-intent `isTaskWrite` cases, shared-vocabulary carve-out validation, and drift guards that force the regex and wiring in `auditor-script.sh` to stay in sync with the test literals and prevent regressions like the always-run-query bypass.
- Two rounds of review: Codex (gpt-5.4, high) flagged three real regressions in the first pass — pattern 1 overreach (would exempt `escreva uma nota na T5`), mixed-intent whole-message bypass (would hide `concluir T5` failures when combined with a DM-send), and missing informal phrasings (`mande msg`, `avisa pro X`, etc.). All three addressed in this commit. Architectural follow-up to emit an audit trail for `send_message` tool calls (rather than regex-exempting) deferred.

### Investigation: SECI-SECTI unresponsive window 2026-04-09
- The 4 SECI-SECTI issues Kipp flagged (`noResponse` on "atividades josele" / "olá" / fiscalização question, plus a 7.5min delay on `p9`) are **one incident**, not four. The `seci-taskflow` container was silent between 08:42 and 12:23 local, then woke up and batch-replied to all 5 accumulated user messages in a single 1422-char response (verified via session `eaf02875-...` queue-operation log and `messages.db`).
- The incident happened BEFORE the zombie container fix was deployed — commit `eb64b44` was made at 16:17 local on the same day and the service restart (deploy) happened at 16:20. The 7.5min `p9` delay Kipp reported is itself a second-order artifact: the auditor matched against the next `is_bot_message=1` message (a P9.7 update IPC notification at 12:15), not the actual agent reply at 12:23 — the real delay was 16 minutes, preceded by 3h41min of silence.
- No additional code fix required for these four — they should not recur in the post-deploy code. Next step: sample Apr 10 traffic to confirm the zombie fix is holding.

### Housekeeping: skill/taskflow branch is stale
- `skill/taskflow` is 90 commits behind `main` (merge-base = `ba4d25c` = `skill/taskflow`'s own HEAD). All TaskFlow work since then has been committed directly to `main`, which means future upstream merges will be noisier than they need to be on shared infrastructure files. The auditor fix landed on `main` for the same pragmatic reason. A dedicated `skill/taskflow` refresh operation (catching it up to match `main`'s TaskFlow state) is now overdue and should be scheduled as a follow-up task — it's the cleanest way to restore the "upstream → skill/taskflow → main" flow described in `docs/skills-as-branches.md`.

### Design: cross-board subtask creation
- Design spec for enabling child boards to create subtasks on delegated parent board tasks
- Code review revealed the engine already supports this — the bot was self-censoring, not engine-blocked
- Phase 1 (template fix): add explicit guidance to CLAUDE.md template allowing `add_subtask` on delegated tasks
- Phase 2 (deferred): optional IPC approval workflow if governance is required
- Spec: `docs/superpowers/specs/2026-04-09-cross-board-subtask-approval-design.md`

### Fix: zombie container on null agent result
- When an agent query returned null (e.g., API rate limit), the idle timer was never started — the container hung forever as a zombie, silently dropping all follow-up user messages
- Root cause: `resetIdleTimer()` was inside `if (result.result)`, skipping null results; moved into `if (result.status === 'success')` so ALL successful query completions start the idle countdown
- `IDLE_TIMEOUT` reduced from 6h to 30min — zombie window capped at 30 minutes instead of indefinite
- Added diagnostic logging to `sendMessage()` and `closeStdin()` in group-queue — failures now log which condition failed instead of silently returning false

## [1.2.52] - 2026-04-07

### Long-term context: filter automation noise
- Scheduled-task turns (`TF-STANDUP`, `TF-DIGEST`, `TF-REVIEW`) are now excluded from conversation capture — the recency preamble was dominated by self-referential runner chatter instead of human interactions
- Cursor still advances past filtered turns; Ollama summarization workload reduced by ~75%
- Summarization model switched from `qwen3.5:cloud` (401 Unauthorized / broken output) to `qwen3-coder:latest` (local, 30.5B, 3s/summary, excellent quality)

### TaskFlow: parent_title fix
- `taskflow_query` person_tasks (and 21 other query paths) now include `parent_title` via LEFT JOIN — prevents agent hallucination of project names when subtasks have `parent_task_id` but no parent context (e.g., "Spia Patrimonial" instead of "Dados Abertos e Internos")
- New `queryVisibleTasks()` shared helper centralizes the JOIN pattern across all task-returning queries (net -61 lines from dedup)
- Unit test added: asserts `parent_title` is present on subtasks and null on top-level tasks

### TaskFlow: template improvements (auditor report 2026-04-06)
- Prazo disambiguation: bare `[task] prazo` now defaults to showing the deadline (query), not asking "consultar ou alterar?"
- Cross-board note routing: bot now explains parent board ownership and offers to route instead of just refusing
- Self-approval guidance: bot now names who can approve when blocking self-approval

## [1.2.52] - 2026-04-05

### Upstream Merge (1.2.50 → 1.2.52)
- Writable `/workspace/global` mount for main agent �� enables global memory writes from the main container
- `ONECLI_URL` default removed — `undefined` when unset (aligns with native credential proxy)
- `.npmrc` with 7-day minimum npm release age (supply-chain safety)
- Setup telemetry + diagnostics improvements
- `groups/main/CLAUDE.md` global memory path corrected to `/workspace/global/CLAUDE.md`

## [1.2.50] - 2026-04-05

### Upstream Merge (1.2.47 → 1.2.50)
- **Agent SDK 0.2.76 → 0.2.92**: 1M context window, 200k-token auto-compact support
- **Auto-compact threshold** set to 165k tokens via `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var in `sdkEnv`
- **Session artifact pruning** (`src/session-cleanup.ts` + `scripts/cleanup-sessions.sh`): daily cleanup of stale session transcripts (30d), debug logs (7d), todos (7d), telemetry (30d), group logs (30d). Active sessions always preserved.
- New skills: `/add-karpathy-llm-wiki`, `/migrate-from-openclaw`, `/migrate-nanoclaw`
- `setup` and `update-nanoclaw` skills gained diagnostic telemetry entries

### Auth (native credential proxy)
- Placeholder auth args (`-e CLAUDE_CODE_OAUTH_TOKEN=placeholder` or `ANTHROPIC_API_KEY=placeholder`) added to container `docker run` args — SDK 0.2.80+ does a local auth-state check before HTTP; the credential proxy substitutes the real token during the OAuth exchange. Matches `upstream/skill/native-credential-proxy` pattern. `readSecrets()` stdin injection removed (replaced by the placeholder).
- `detectAuthMode()` result cached after first call to avoid re-reading `.env` on every container spawn.

### Container Build
- `container/.dockerignore` added — excludes `agent-runner/node_modules`, `agent-runner/dist`, `agent-runner/docs`. Prevents the Dockerfile's `COPY agent-runner/ ./` from overwriting freshly-installed dependencies with stale host-side copies.
- `ImageContentBlock.source.media_type` narrowed from `string` to SDK 0.2.92's literal union (`image/jpeg | image/png | image/gif | image/webp`) with runtime guard.

### TaskFlow
- Dropped orphan `task_comments` table at service startup — its single-column FK to composite-PK `tasks` was blocking all task deletes. The table had no code consumers; 44 rows were abandoned QA data.
- `initTaskflowDb()` now called from `main()` at service startup to apply pending schema migrations before containers open the DB.

### Deploy Script
- `scripts/deploy.sh` syncs container build inputs (Dockerfile, .dockerignore, build.sh, agent-runner package files) and rebuilds the Docker image on the remote when a sha256 fingerprint changes. Fingerprint covers all Dockerfile COPY inputs including source and tsconfig, computed via `find | sort` for deterministic ordering.
- Build failure propagation fixed — removed `| tail` pipe that masked remote exit codes.
- `npm install` failure on remote now aborts the deploy.

## [1.2.47] - 2026-04-03

### Upstream Merge (1.2.46 → 1.2.47)
- Mount `store/` read-write for main agent — direct SQLite DB access from the main container
- Shadow `.env` in main container mount (security: credentials via proxy only)
- `requiresTrigger` param added to `register_group` MCP tool (was host-IPC only)
- Breaking change detection relaxed to match `[BREAKING]` anywhere in changelog lines

### Holidays Calendar
- Populated `board_holidays` with 14 feriados for 2026 (12 nacionais + Batalha do Jenipapo PI + Aniversário de Teresina) across all 18 boards in the hierarchy
- Annual renewal already scheduled: `TF-HOLIDAY-SEEKER` cron fires Dec 15 to search and propose next year's holidays

## [1.2.46] - 2026-04-02

### Upstream Merge (1.2.45 → 1.2.46)
- Reply/quoted message context: messages now store `reply_to_message_id`, `reply_to_message_content`, `reply_to_sender_name` — DB migration adds 3 columns, `formatMessages` renders `<quoted_message>` XML when a message is a reply
- `getNewMessages` gains subquery pagination with configurable `limit` (default 200)
- `formatMessages` now uses `formatLocalTime` with configured timezone (America/Fortaleza) instead of raw ISO timestamps
- Code of Conduct added upstream

## [1.2.45] - 2026-04-01

### Upstream (1.2.43 → 1.2.45)
- Prettier/ESLint formatting on `src/` and `container/agent-runner/src/` (no logic changes)

### Queue Priority + Concurrency
- User messages now drain before scheduled tasks in the group queue — prevents 2h+ delays when scheduled task backlog fills all container slots after a restart
- `MAX_CONCURRENT_CONTAINERS` raised from 5 to 12 — accommodates all TaskFlow boards firing simultaneously while staying within 8 GB RAM bounds

### Auditor Improvements
- Parent board mutation check: `task_history` query now checks both child and parent board IDs — eliminates false `unfulfilledWrite` flags for delegated task operations (ASSE-SECI, Ana Beatriz boards)
- Web origin filter: messages from `web:` prefix senders (QA/test) skipped in auditor — eliminates SEC-SECTI test noise
- Command synonyms: added "consolidar", "atividades", "cancelar" to template

### Schedule Alignment
- Aligned all 18 boards to same BRT times: 08:00 standup, 18:00 digest, 14:00 Friday review (newer boards were 3h late)
- Staggered bursts across 6-minute windows (6 boards at :00, :03, :06) to prevent API rate limit exhaustion
- Fixed `board_runtime_config` source data (19 rows) — new child boards now inherit correct times from provisioning

### Anti-Hallucination Safeguards (refined)
- Post-write verification moved outside `db.transaction()` — now verifies after commit, not inside the transaction where it was dead code (better-sqlite3 guarantees visibility within synchronous transactions)

## [1.2.43] - 2026-03-31

### Upstream (1.2.42 → 1.2.43)
- Stale session auto-recovery: detects `no conversation found|ENOENT|session.*not found` errors and clears broken session IDs so the next retry starts fresh
- npm audit fixes (dependency updates)

### TaskFlow Web Channel
- `send_board_chat` MCP tool: agents can write messages to `board_chat` table for web UI consumption
- `NANOCLAW_ASSISTANT_NAME` env var injected into containers for agent self-identification
- Web origin trigger bypass: messages with `web:` sender prefix skip `requiresTrigger` check
- Web origin output routing: agent responses routed to `board_chat` table instead of WhatsApp for web-originated messages, with WhatsApp fallback on error

### Scheduled Task Prompt Simplification
- Replaced verbose inline prompts for standup/digest/weekly with bare tags (`[TF-STANDUP]`, `[TF-DIGEST]`, `[TF-REVIEW]`)
- Added "Scheduled Task Tags" section to CLAUDE.md template mapping tags to their instruction sections
- Single source of truth: all report behavior defined in the template, not duplicated in 55 DB prompts
- **Before:** agents queried raw SQL and dumped every task → wall of stress on large boards
- **After:** agents call `taskflow_report()` → engine-formatted concise digest with counts, top items, and 3 actionable suggestions

### Anti-Hallucination Safeguards
- **Engine-level post-write verification:** `createTaskInternal()` now SELECT-verifies the inserted row before returning `success: true` — if the INSERT was rolled back or lost, the tool returns `success: false` instead of silently lying
- Template: never display task details from memory — always query DB first (prevents hallucinated task info persisting through session resume)
- Template: post-write verification — agents must check tool response for `success: true` before confirming to user
- Bare task ID mapping: "TXXX" triggers `task_details` query automatically

### Auditor Fix
- Fixed auditor `chat_jid` mismatch: task pointed to old group JID (`120363408855255405@g.us`) instead of registered main channel (`558699916064@s.whatsapp.net`) — reports were sent to a non-existent group and silently lost

### Production Incident (2026-03-30)
- **Root cause:** null dereference in agent-runner `scriptResult.data` (committed in previous session) caused TypeScript strict mode (`TS18047`) to reject compilation inside every container
- **Impact:** all 12 boards down from ~08:00 to 08:15 BRT — zero morning standups delivered, user messages unanswered
- **Resolution:** deployed the `else` block fix, manually re-triggered 18 standup tasks by clearing `last_run` (the `cronSlotAlreadyRan` idempotency guard was blocking re-runs)
- **Lesson:** deploy script should validate container-side TypeScript compilation, not just host-side `tsc`

### WhatsApp Reconnection Resilience
- Reconnect loop now retries indefinitely (exponential backoff 5s→60s, then 2-min intervals) instead of giving up after 5 attempts
- Added 2-minute health check watchdog: detects silently dead connections and triggers recovery
- Stored health check timer handle to prevent duplicate intervals

### Fix: TaskFlow groups silently re-requiring trigger
- MCP `register_group` tool now passes `requiresTrigger` (defaults to `false` for TaskFlow groups)
- `setRegisteredGroup` preserves existing `requires_trigger` value when the field is undefined, instead of resetting to `1` via `INSERT OR REPLACE`
- Root cause: any agent re-registering a group would silently flip `requires_trigger` back to `1` because the MCP tool omitted the field

## [1.2.41] - 2026-03-27

### Upstream (1.2.35 → 1.2.41)
- Replace pino with built-in logger
- Prevent message history overflow via `MAX_MESSAGES_PER_PROMPT`
- `stopContainer` uses `execFileSync` (no shell injection)
- Preserve `isMain` on IPC updates
- Fix single-char `.env` crash
- Remove unused deps (yaml, zod, pino, pino-pretty)
- Ollama skill: opt-in model management tools

### WhatsApp Reconnection Fix
- Fixed reconnection deadlock: `connectInternal()` now awaits `connection='open'` before returning, preventing the reconnect loop from exiting prematurely (8h production outage)
- Fixed half-dead socket stall: `sendMessage()` transport failures now trigger reconnection (filtered to avoid false reconnects on application errors)
- Initial connect retries with backoff on transient startup failures
- LoggedOut (401) during reconnect exits immediately
- 30s timeout on `connectInternal()` — prevents reconnect loop from hanging forever on silent socket failures
- Outgoing message queue persisted to disk — survives process restarts (29 messages lost in Mar 27 incident)

### Image Vision
- Wired end-to-end: WhatsApp image download → sharp resize → base64 → Claude multimodal content blocks
- Handles wrapped images (viewOnceMessageV2, ephemeralMessage)

### Logger Baileys Compatibility
- Added `level`, `child()`, `trace()` to built-in logger for Baileys `ILogger` interface — prevents runtime crash after pino removal

### TaskFlow Isolation
- Moved `getGroupSenderName()` from `config.ts` to `src/group-sender.ts`
- Moved `resolveTaskflowBoardId()` from `container-runner.ts` to `src/taskflow-db.ts`
- Reduces upstream merge conflicts — TaskFlow code no longer modifies core upstream files

### TaskFlow Features
- `reparent_task`: move standalone tasks under existing projects as subtasks (preserves all metadata, undoable)
- `detach_task`: detach subtasks from projects back to standalone (preserves all metadata, undoable)
- Subtask individual deadlines: agents can now set `due_date` on subtasks independently of the parent project
- Fixed duplicate cross-board notifications when assignee is on the parent board
- Template: save notes before completing tasks, multi-assignee guidance, task splitting pattern, archive fallback on "Task not found", enforce reparent over copy+cancel, always confirm write operations in sender's group, link child board projects to parent tasks, delegated tasks fully operable from child boards, "consolidado" synonym, contextual task inference

### Child Board Cross-Board Operations Fix
- Child boards can now modify delegated parent board tasks (move, update, add subtasks, complete)
- Root cause: template led agents to infer a blanket "can't modify parent board" restriction that doesn't exist in the engine
- Caused all CI-SECI (Mauro) failures: 7 missing subtasks, 2 missed renames, 1 missing subtask

### Data Corrections (interaction review)
- SECI: 65 task histories migrated from old T-ids to P-subtask ids after copy+cancel migration
- SECI: P1.4 assignee fixed (lucas), P1.2 assignee fixed (ana-beatriz), P1.10/P20.4 deadlines set
- SECI: P1 (Laizys) linked back to T41 via tag_parent
- TEC: T1 approved (stuck in review 7 days)
- SEC: T80 completed (Thiago's request from Mar 25)
- Thiago: T15 note added ("enviado ao João os nomes")
- Mauro: 7 P2 subtasks created, P3.4 created, P11 renamed "Estratégia", P13 renamed "Ecossistema de Inovação"
- Lucas: T1/T2 orphans archived, P5.5 created for ReadyTI February payment

### Cross-Board Project Rollup
- `refresh_rollup` now counts subtasks of tagged projects, not just directly-tagged tasks
- Auto-triggers rollup from `move()`, `cancel_task`, and `restore_task` when any task with an upward link changes status
- Parent board sees real-time progress of child board project subtasks
- Extracted shared `computeAndApplyRollup` helper — eliminates 80 lines of duplication
- Change-detection guard prevents history spam on no-op rollups
- Added indexes on `linked_parent_board_id`/`linked_parent_task_id` for query performance

### Daily Interaction Auditor
- Automated daily review of all board interactions at 04:00 BRT
- Script phase gathers data from both DBs (messages + TaskFlow) inside container
- AI phase analyzes findings: unfulfilled requests, delays, refusals, template gaps, missing features
- Zero AI cost on clean days (`wakeAgent: false`)
- Detects delayed responses (>5min), agent refusals, write requests without DB mutations
- Weekend catch-up: Monday reviews Fri+Sat+Sun

### Infrastructure
- New `scripts/deploy.sh` with pre-flight import verification on local and production
- Fixed `ContainerInput.script` type (was missing, broke all container agents)
- Fixed `is_main` mapping: added to schema, migration, `getAllRegisteredGroups`, and `setRegisteredGroup`
- Fixed scheduler `isMain` resolution: uses `group.isMain` DB flag instead of folder string comparison
- Fixed null dereference in agent-runner when script errors: prompt enrichment now guarded by `else` block
- Context summarizer switched to `qwen3.5:cloud` primary with `qwen3-coder:latest` fallback

### Post-Merge Test Fixes
- Fixed OneCLI null-safety, TaskFlow test paths, ISO date assertions, English→Portuguese strings
- 899 tests passing across 40 test files

## [1.2.36] - 2026-03-26

- [BREAKING] Replaced pino logger with built-in logger. WhatsApp users must re-merge the WhatsApp fork to pick up the Baileys logger compatibility fix: `git fetch whatsapp main && git merge whatsapp/main`. If the `whatsapp` remote is not configured: `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git`.

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault replaces the built-in credential proxy. Check your runtime: `grep CONTAINER_RUNTIME_BIN src/container-runtime.ts` — if it shows `'container'` you are on Apple Container, if `'docker'` you are on Docker. Docker users: run `/init-onecli` to install OneCLI and migrate `.env` credentials to the vault. Apple Container users: re-merge the skill branch (`git fetch upstream skill/apple-container && git merge upstream/skill/apple-container`) then run `/convert-to-apple-container` and follow all instructions (configures credential proxy networking) — do NOT run `/init-onecli`, it requires Docker.

## [1.2.21] - 2026-03-22

- Added opt-in diagnostics via PostHog with explicit user consent (Yes / No / Never ask again)

## [1.2.20] - 2026-03-21

- Added ESLint configuration with error-handling rules

## [1.2.19] - 2026-03-19

- Reduced `docker stop` timeout for faster container restarts (`-t 1` flag)

## [1.2.18] - 2026-03-19

- User prompt content no longer logged on container errors — only input metadata
- Added Japanese README translation

## [1.2.17] - 2026-03-18

- Added `/capabilities` and `/status` container-agent skills

## [1.2.16] - 2026-03-18

- Tasks snapshot now refreshes immediately after IPC task mutations

## [1.2.15] - 2026-03-16

- Fixed remote-control prompt auto-accept to prevent immediate exit
- Added `KillMode=process` so remote-control survives service restarts

## [1.2.14] - 2026-03-14

- Added `/remote-control` command for host-level Claude Code access from within containers

## [1.2.13] - 2026-03-14

**Breaking:** Skills are now git branches, channels are separate fork repos.

- Skills live as `skill/*` git branches merged via `git merge`
- Added Docker Sandboxes support
- Fixed setup registration to use correct CLI commands

## [1.2.12] - 2026-03-08

- Added `/compact` skill for manual context compaction
- Enhanced container environment isolation via credential proxy

## [1.2.11] - 2026-03-08

- Added PDF reader, image vision, and WhatsApp reactions skills
- Fixed task container to close promptly when agent uses IPC-only messaging

## [1.2.10] - 2026-03-06

- Added `LIMIT` to unbounded message history queries for better performance

## [1.2.9] - 2026-03-06

- Agent prompts now include timezone context for accurate time references

## [1.2.8] - 2026-03-06

- Fixed misleading `send_message` tool description for scheduled tasks

## [1.2.7] - 2026-03-06

- Added `/add-ollama` skill for local model inference
- Added `update_task` tool and return task ID from `schedule_task`

## [1.2.6] - 2026-03-04

- Updated `claude-agent-sdk` to 0.2.68

## [1.2.5] - 2026-03-04

- CI formatting fix

## [1.2.4] - 2026-03-04

- Fixed `_chatJid` rename to `chatJid` in `onMessage` callback

## [1.2.3] - 2026-03-04

- Added sender allowlist for per-chat access control

## [1.2.2] - 2026-03-04

- Added `/use-local-whisper` skill for local voice transcription
- Atomic task claims prevent scheduled tasks from executing twice

## [1.2.1] - 2026-03-02

- Version bump (no functional changes)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add.

- Channel registry: channels self-register at startup via `registerChannel()` factory pattern
- `isMain` flag replaces folder-name-based main group detection
- `ENABLED_CHANNELS` removed — channels detected by credential presence
- Prevent scheduled tasks from executing twice when container runtime exceeds poll interval

## [1.1.6] - 2026-03-01

- Added CJK font support for Chromium screenshots

## [1.1.5] - 2026-03-01

- Fixed wrapped WhatsApp message normalization

## [1.1.4] - 2026-03-01

- Added third-party model support
- Added `/update-nanoclaw` skill for syncing with upstream

## [1.1.3] - 2026-02-25

- Added `/add-slack` skill
- Restructured Gmail skill for new architecture

## [1.1.2] - 2026-02-24

- Improved error handling for WhatsApp Web version fetch

## [1.1.1] - 2026-02-24

- Added Qodo skills and codebase intelligence
- Fixed WhatsApp 405 connection failures

## [1.1.0] - 2026-02-23

- Added `/update` skill to pull upstream changes from within Claude Code
- Enhanced container environment isolation via credential proxy
