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

## 4. R2 (`ea37203f`) — stale header comment (LOW, trivial)

- `taskflow-server-entry.ts` header (~lines 38-44) still says `api_undo` is "deliberately excluded" from the allowlist; R2 added it ~60 lines below. Update the comment.

## FYI — this audit session changed surfaces adjacent to yours (all committed, suites green)

- `f9525e5a`: all 23 deterministic poll-loop mutation sites now dispatch engine notifications via the #389/#396/#397 finalizer contract (V1 parity HIGH — the deterministic fast-paths committed mutations but discarded assignee/parent/invite notifications). Plus `formatFortalezaDateTimePt` now renders minutes.
- `d4b58ba0`: #419 live-adapter fix — `normalizeAgentIds`' actor bind and the comment-author bind now resolve a JID-shaped authenticated sender via `board_people.phone` (shared `actor-person-resolution.ts`); the WhatsApp adapter restores V1's participant LID→phone translation (`resolveParticipantSender`). Your verbatim/FastAPI paths are untouched (bind still skipped under `getVerbatimIds()`).
- `docs/v2-cutover-exception-list.md`: EX-017 (consolidated SEC#1-13 gate divergences) + EX-018 (magnetism guard wiring) + checklist items 7-8 (HOLIDAY_EXEMPT→TASKFLOW_HOLIDAY_EXEMPT mapping; scheduled-task script scan).
