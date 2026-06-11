# Delta-parity audit 2026-06-10 — findings on in-flight R1–R5 surfaces (handoff)

**From:** the delta-parity audit session (workflow `w8cegb8gt`, 60 agents, + follow-up commit audit at `3e698a02`).
**To:** the session implementing the tf-mcontrol INBOUND R1–R5 requests.
**Context:** a full V1→V2 delta parity audit ran against `06d5b470..HEAD`. Three commits in your R-series landed mid-audit and were re-audited separately. Everything below is verified against source at `3e698a02`; nothing here blocks your work, but two items deserve a fix before the R-series is called done.

## 1. R4 (`3e698a02`) — atomic `parent_task_id` is weaker-gated than every existing add-to-project path (MED)

- `engine.admin('reparent_task')` requires `isManager` (engine.ts:9521-9543; V1 identical). `engine.update add_subtask` requires manager OR assignee. The atomic path (`createTaskInternal` + `validateCreateParent`, engine.ts:4110-4141) checks parent exists/is-project/same-board but has **zero actor gating** — any single resolved chat sender (member, or even a non-board person) can create a self-/un-assigned task directly inside any project, which both existing paths deny.
- On FastAPI: `api_admin` is NOT allowlisted but `api_create_task` IS — the dashboard add-to-project rests entirely on tf-mcontrol auth, no engine role gate.
- Not documented/signed-off anywhere; the commit message describes validation mirroring but not the gate asymmetry.
- **Suggested fix:** apply the `add_subtask` gate (manager-or-assignee-of-parent) inside `validateCreateParent`, or manager-only to mirror `reparent_task`. Decide + document.

## 2. R4 — card/history divergence on the atomic path (MED-LOW)

- The V1-byte-faithful "✅ *id adicionada* … 📁 *parent*" card is wired only onto `api_admin(reparent_task)` (mutate.ts:962/971/1794). The atomic path flushes the standalone "Tarefa criada … ⏭️ Coluna" card (`buildCreatedTaskCard` ignores `parent_task_id`) — no project reference.
- History: reparent records `reparented` + `subtask_added` on the parent (engine.ts:10256-10263); the atomic path records only `created` — the project's audit trail never shows the subtask arriving.
- Undo: atomic create → `_last_mutation='created'` → undo refused; the reparent step of the two-step was undoable.
- The `api_create_task` description now steers BOTH ways (old text says create-then-reparent for "adicionar em P3…", new `parent_task_id` text says it avoids the two-step) — contradictory steering in one schema.

## 3. R1 (`225d4cac`) — migration-ordering dependency is undocumented (MED-LOW, doc-only)

- The 4 board-workflow columns (objective/max_agents/require_approval_for_done/require_review_before_done) are owned by tf-mcontrol Python migrations; `ensureTaskSchema` deliberately does not create them. On a cutover-migrated `taskflow.db` without the Python migration, a dashboard board-settings save touching them → `{success:false, error_code:'internal_error', error:'no such column: …'}` (structured, no crash — verified). But the ordering requirement lives ONLY in the commit message + a fixture comment. Add it to the coordination doc and/or the cutover runbook.

## 3b. SEC#11 gap — the DETERMINISTIC register_person fast-path bypasses the auto-provision approval (MAJOR, security, pre-existing — YOUR gate to extend)

> **✅ CLOSED 2026-06-11** on branch `sec/provision-child-board-park` (commit `88656829`, built in an
> isolated worktree to avoid colliding with the active poll-loop work). The deterministic handler now
> routes the emit through the SAME `emitAutoProvisionIfRequested` gate (one gate source); the gate
> additionally accepts the caller-RESOLVED board id (`deps.boardId || env`) so env-less boards
> (message-content / CLAUDE.local.md fallback) park too; `buildPersonRegisteredAck` got the
> "aguarda aprovação" wording (+ a fail-loud 'failed' mode for a thrown emit). 5 integration tests
> drive the real handler/engine; suite 1729/0. TWO Codex gpt-5.5/xhigh rounds: round 1 found the
> env-less BLOCKER (independently self-caught + fixed pre-report) + the failed-emit-ack MEDIUM;
> round 2 CONFIRMED both, 0 new findings, SAFE-TO-MERGE. Merge this branch into skill/taskflow-v2
> when the poll-loop churn settles.

- The MCP `api_admin register_person` auto-provision is correctly PARKED for NanoClaw-admin approval: `emitAutoProvisionIfRequested` (taskflow-api-mutate.ts:~535) calls `parkForApproval({tool:'provision_child_board_auto', …})` on a board chat.
- But the DETERMINISTIC poll-loop handler `handleTaskflowPendingChildBoardRegistration` (poll-loop.ts:~2990) writes the **real** `{action:'provision_child_board', …}` system row directly — no park. The host `handleProvisionChildBoard` is registered with NO approval gate (taskflow/index.ts:15), so this provisions a child board (creates a WhatsApp group, seeds a DB) on a board member's command without admin approval.
- Reachability: it fires from `taskflowPendingChildBoardRegistrationCommand` over trigger=1 wake-eligible rows (#413-scoped), so it needs a genuine inbound message, but the whole point of SEC#11 is that provisioning needs NanoClaw-ADMIN approval, not just a board action. This is a side door around that gate.
- The delta-parity session left the deterministic ack as "está sendo provisionado" (accurate for the current no-park behavior). When you route this emit through the same `parkForApproval`, also flip `buildPersonRegisteredAck` (poll-loop.ts) to the "aguarda aprovação" wording.

## 4. R2 (`ea37203f`) — stale header comment (LOW, trivial)

- `taskflow-server-entry.ts` header (~lines 38-44) still says `api_undo` is "deliberately excluded" from the allowlist; R2 added it ~60 lines below. Update the comment.

## FYI — this audit session changed surfaces adjacent to yours (all committed, suites green)

- `f9525e5a`: all 23 deterministic poll-loop mutation sites now dispatch engine notifications via the #389/#396/#397 finalizer contract (V1 parity HIGH — the deterministic fast-paths committed mutations but discarded assignee/parent/invite notifications). Plus `formatFortalezaDateTimePt` now renders minutes.
- `d4b58ba0` → `c2dbf443` → `98a66c88` → `70970665`: #419 live-adapter fix (landed across these commits — this doc predates the last two). `normalizeAgentIds`' actor bind, the comment-author bind, and the deterministic poll-loop `senderName()` now resolve a JID-shaped authenticated sender via `board_people.phone` (shared `actor-person-resolution.ts`). **`98a66c88`** changed the deterministic bind from the person's NAME (the original `c2dbf443` behavior) to the canonical **person_id** — name is not unique, so binding the name and letting the engine re-resolve it could escalate to a same-named manager (Codex BLOCKER); `displaySenderName()` (`98a66c88` + `70970665`) renders the name only for outbound text. Phone matching is restricted to `@s.whatsapp.net` (anti-spoof). The WhatsApp adapter restores V1's participant LID→phone translation (`resolveParticipantSender`). Your verbatim/FastAPI paths are untouched (bind still skipped under `getVerbatimIds()`).
- `docs/v2-cutover-exception-list.md`: EX-017 (consolidated SEC#1-13 gate divergences) + EX-018 (magnetism guard wiring) + checklist items 7-8 (HOLIDAY_EXEMPT→TASKFLOW_HOLIDAY_EXEMPT mapping; scheduled-task script scan).
