# Codex GAP Validation — Apply plan/test vs runtime reframe

## Summary scorecard (post-validation)

| Severity | Count |
|---|---:|
| RUNTIME-BLOCKER | 25 |
| PLAN-BLOCKER | 101 |
| HIGH | 15 |
| MEDIUM | 9 |
| LOW | 14 |
| OVERCLAIM (audit was wrong) | 5 |
| DEAD-CODE-PRESERVED | 1 |
| DEPRECATED-CORRECTLY | 8 |
| DEPRECATED-WRONG | 0 |
| **Total** | **178** |

Notes: the synthesis says it consolidated 15 audits, but 19 audit docs exist on disk. This validation covers all 19 docs and keeps duplicate cross-audit GAPs when they map to different plan owners, so the total is higher than the synthesis' ~115 GAP count.

## Per-audit GAP table

### Audit 01 — Runners + rendering

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| R5 | `runner_*_task_id` column persistence | MEDIUM | PLAN-BLOCKER | Schedule-id behavior is migration/acceptance wording; no new engine behavior beyond schedule migration. |
| R6 | Per-board `*_cron_local` customization | LOW | LOW | Cron values migrate as data; add an invariant only. |
| R7 | DST guard runner + zombie crons | MEDIUM | MEDIUM | Dead production path, but cutover should filter zombie schedules and drop stale prompt text. |
| R8 | Local+UTC dual cron columns | MEDIUM | DEPRECATED-CORRECTLY | Dropping UTC shadow columns is correct after production round-hour validation. |
| R10 | Catch-up on missed runs | LOW | LOW | Explicit no-catch-up decision is enough. |
| R12 | `auditTrailDivergence` / delivery health | HIGH | RUNTIME-BLOCKER | v2 removes the v1 split-store bug class, so auditor code must drop or redefine the detector. |
| R14 | `selfCorrections` 60-min doublet | HIGH | PLAN-BLOCKER | Detector can port with auditor rewrite; plan needs explicit preservation criteria. |
| R15 | Kipp isolated session | HIGH | RUNTIME-BLOCKER | Requires new v2 session/provisioning shape for audit isolation, not just docs. |

### Audit 02 — Task lifecycle

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| L.16 | `restore_task` missing from spec inventory | LOW | PLAN-BLOCKER | Engine behavior exists; tool/spec inventory must name it. |
| L.18 | Three-variant completion notification | HIGH | PLAN-BLOCKER | Renderer ports with engine; acceptance tests must lock quiet/cheerful/loud policy. |
| L.19 | Auto-archive done tasks after 30d | MEDIUM | PLAN-BLOCKER | Hook behavior is existing domain logic; spec/test omission. |
| L.29-32 | `manage_holidays` 4 ops not enumerated | MEDIUM | PLAN-BLOCKER | Engine/admin action exists; MCP inventory must expose the ops. |
| L.34 | `allow_non_business_day` parameter | LOW | PLAN-BLOCKER | Existing parameter needs schema/test coverage. |
| L.3 + L.13 | `force_start` vs WIP limit | HIGH | PLAN-BLOCKER | Engine matrix exists; add regression cases. |
| L.8 | `requires_close_approval` routes through review | HIGH | PLAN-BLOCKER | Engine behavior exists; test must preserve the soft gate. |
| L.33 | Weekday-name validation guard | HIGH | PLAN-BLOCKER | Existing opt-in guard needs MCP schema/template/test coverage. |

### Audit 03 — Cross-board

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| I.4 | Spec/plan contradiction on `/aprovar` | BLOCKER | MEDIUM | Real doc conflict, but approval flow has zero production use. |
| J.1 | Rollup signals | BLOCKER | PLAN-BLOCKER | Engine code ports; plan needs an explicit rollup acceptance task. |
| J.2 | `visibleTaskScope` cross-board read | BLOCKER | PLAN-BLOCKER | Engine SQL primitive ports; missing plan/test coverage is the blocker. |
| J.3 | Linked-task marker rendering | BLOCKER | PLAN-BLOCKER | Renderer behavior ports with engine/template; must be enumerated. |
| J.5 | Cross-board write-path guards | HIGH | PLAN-BLOCKER | Existing guards port; add tests for cancel/restore/reparent/merge. |
| K.4 | Trigger context propagation | BLOCKER | RUNTIME-BLOCKER | v2 `messages_out`/`delivered` lack trigger fields; wrapper/auditor context plumbing is new runtime work. |
| K.5 | 5-second notification consolidation | HIGH | RUNTIME-BLOCKER | v2 native `send_message` queues per call; preserving merge semantics needs buffering code. |

### Audit 04 — Reassignment

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| G-1 | Single-task reassign hidden by `bulk_reassign` naming | HIGH | PLAN-BLOCKER | Existing `reassign()` handles both; spec/tool name must say so. |
| G-3 | Cross-board reassign guard not enumerated | MEDIUM | PLAN-BLOCKER | Guard ports with engine; add error tests. |
| G-4 | Dry-run vs `ask_user_question` design drift | MEDIUM | MEDIUM | Bulk confirmation is zero-volume; choose a UX path but not a blocker. |
| G-aux | Auto-relink on reassign | LOW | PLAN-BLOCKER | Engine covers it, but 15.5% production reassign path needs acceptance tests. |

### Audit 05 — Meetings

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| K.1 | `add_task(type='meeting')` invariants | HIGH | PLAN-BLOCKER | Engine invariants exist; spec must state no due date, recurrence rules, and type lock. |
| K.3.design | Push-vs-pull external invite flow | HIGH | HIGH | External flow is dormant but design choice affects real runtime wiring. |
| K.3.window | 7-day external invite window | LOW | PLAN-BLOCKER | Existing constant/policy needs spec coverage. |
| K.4 | External participant removal shape | MEDIUM | PLAN-BLOCKER | Engine path exists; spec must decide polymorphic vs separate tool. |
| K.5 | Reinvite external participant missing | MEDIUM | PLAN-BLOCKER | Existing update field/tool surface needs enumeration if kept. |
| K.6.scope | dm-routing trim vs delete conflict | HIGH | PLAN-BLOCKER | Plan already ports dm-routing; spec must stop implying deletion. |
| K.6.bug | dm-routing anti-drift rules | BLOCKER | HIGH | Production incident is real, but v2 build differs and plan needs hardening, not cutover-stop. |
| K.7 | `process_minutes` collapsed | HIGH | PLAN-BLOCKER | Engine note triage exists; tool/spec naming must preserve it. |
| K.8-15 | 8 meeting query views not enumerated | MEDIUM | PLAN-BLOCKER | Query variants port with engine; tests/spec must name them. |
| K.16 | Cross-board meeting visibility | HIGH | PLAN-BLOCKER | Existing read rule ports; missing test can hide participant meetings. |
| K.17.weekday | `scheduled_at` non-business-day gate | MEDIUM | PLAN-BLOCKER | Existing guard applies to meeting `scheduled_at`; spec only names due dates. |
| K.17.phone-mask | Phone-mask display claim | LOW | OVERCLAIM | Audit itself found v1 meeting participant output shows plain phone, so masking is not a v1 feature. |

### Audit 06 — Quick capture

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| L.1.discriminator | `add_task(type='inbox')` carve-out | HIGH | PLAN-BLOCKER | Engine handles discriminator; MCP schema/tests must lock it. |
| L.1.phrasings | `anotar` / `capturar` / `inbox:` triggers | LOW | PLAN-BLOCKER | Prompt-side user contract must survive template rewrite. |
| L.2.invariant | Default assignee = sender | HIGH | PLAN-BLOCKER | Engine safety net exists; add acceptance test. |
| L.2.bypass | "para o inbox" is column-only | LOW | LOW | Clarification only. |
| L.3.transitions | Start directly from inbox | HIGH | PLAN-BLOCKER | Engine transition table exists; add move tests. |
| L.3.claim | Claim unassigned inbox item | HIGH | PLAN-BLOCKER | Engine claim rule exists; add explicit test. |
| L.4.tool | `process_inbox` MCP tool missing | BLOCKER | PLAN-BLOCKER | Admin action exists; v2 tool inventory/wrapper must expose it. |
| L.4.in_place | Promote inbox items in-place | HIGH | PLAN-BLOCKER | Engine reassign auto-move exists; spec/test must state it. |
| L.4.delegate | `process_inbox` delegate gate | HIGH | PLAN-BLOCKER | Same existing role gate as permissions; add test. |

### Audit 07 — Recurring tasks

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| R.1.scope | Five `add_task.type` values | MEDIUM | PLAN-BLOCKER | Engine supports types; spec must enumerate. |
| R.1.canonicalize | Free-form `recurrence` values | BLOCKER | HIGH | Live malformed row needs data fix/canonicalization, but low volume and v1 already has the bug. |
| R.2.contract | Recurring conclude side effects | HIGH | PLAN-BLOCKER | Existing `advanceRecurringTask()` ports; acceptance tests must lock side effects. |
| R.2.web-divergence | Web path bypasses cycle advance | HIGH | HIGH | Needs a guard or single-path policy to prevent repeat divergence. |
| R.3.bounds | `max_cycles` / `recurrence_end_date` | MEDIUM | PLAN-BLOCKER | Existing bounded recurrence behavior needs spec/tests. |
| R.4 | Quiet recurring completion notification | HIGH | PLAN-BLOCKER | Existing renderer behavior; add notification variant tests. |

### Audit 08 — Projects + subtasks

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| S.2 | Dotted ID format | BLOCKER | PLAN-BLOCKER | Engine parses dotted IDs; spec must mark it as a contract. |
| S.4 | Spec names nonexistent `remove_subtask` | HIGH | PLAN-BLOCKER | Audit is correct; fix spec/tool mapping to cancel/detach semantics. |
| S.6 | `reopen_subtask` has different gate | MEDIUM | PLAN-BLOCKER | Existing body-key behavior needs spec footnote/test. |
| S.7 | `assign_subtask` body-key | LOW | PLAN-BLOCKER | Existing body-key needs inventory coverage. |
| S.8 | `unassign_subtask` body-key | LOW | PLAN-BLOCKER | Existing body-key needs inventory coverage. |
| S.9 | `detach_task` missing from tool inventory | HIGH | PLAN-BLOCKER | Engine action exists; spec/tool inventory must name it. |
| S.10 | `reparent_task` missing from tool inventory | HIGH | PLAN-BLOCKER | Engine action exists; spec/tool inventory must name ID-preserving behavior. |
| S.12 | Numeric subtask ordering | HIGH | PLAN-BLOCKER | Existing render/query behavior needs acceptance test. |

### Audit 09 — Search + semantic

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| F.1 | Semantic search ranking | HIGH | PLAN-BLOCKER | Embeddings code ports; thresholds and tests must be enumerated. |
| F.2 | Duplicate detection thresholds | HIGH | PLAN-BLOCKER | Existing semantic thresholds need explicit tests. |
| F.3 | Context preamble injection gate | HIGH | PLAN-BLOCKER | Long-term context code ports; plan must lock the 3-way gate. |
| F.4 | `find_person_in_organization` phone mask | HIGH | PLAN-BLOCKER | Existing query masks phone; add privacy test. |
| F.5 | Homonym disambiguation template | MEDIUM | PLAN-BLOCKER | Prompt contract must survive template rewrite. |
| F.6 | Contact reuse before asking phone | MEDIUM | PLAN-BLOCKER | Prompt/query contract must survive template rewrite. |

### Audit 10 — Admin actions

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| 10.1.tool | `manage_holidays` 4 ops | MEDIUM | PLAN-BLOCKER | Existing admin action needs MCP inventory. |
| 10.1.cache | Holiday cache invalidation | MEDIUM | PLAN-BLOCKER | Existing cache behavior needs contract/test. |
| 10.1.year-prefix | Holiday `set_year` validation | LOW | LOW | Error-path test only. |
| 10.2.contract | `add_manager` idempotency + phone canonicalization | HIGH | PLAN-BLOCKER | Existing behavior needs spec/tool schema. |
| 10.2.merge-meta | Runtime dual-write user role + meta | HIGH | RUNTIME-BLOCKER | v2 must write both `user_roles` and TaskFlow meta atomically. |
| 10.3.tool | `add_delegate` separate vs parameter | MEDIUM | PLAN-BLOCKER | Tool-surface decision only if gate logic is separately fixed. |
| 10.3.permission-matrix | Delegate carve-out | HIGH | RUNTIME-BLOCKER | v2 binary role model needs TaskFlow-specific runtime gate code. |
| 10.4.linked-guard | Authority while linked | HIGH | PLAN-BLOCKER | Engine guard exists; add tests. |
| 10.4.notifications | Cancel notification recipient set | MEDIUM | PLAN-BLOCKER | Existing notification policy needs spec/test. |
| 10.4.undo | `restore_task` separate action | LOW | PLAN-BLOCKER | Existing action needs inventory. |
| 10.5.surface | Remove child board raw-SQL recipe | MEDIUM | MEDIUM | Low-use admin surface; decide keep/drop. |
| 10.6.surface | Set cross-board subtask mode raw-SQL recipe | MEDIUM | MEDIUM | Dormant but live config; document or test one path. |
| 10.7.surface | `merge_project` not in tool inventory | MEDIUM | PLAN-BLOCKER | Engine action exists; inventory omission. |
| 10.7.invariants | Merge-project invariants | HIGH | PLAN-BLOCKER | Existing invariants need spec/tests. |
| 10.8.spec-plan-conflict | `/aprovar` spec vs plan conflict | BLOCKER | MEDIUM | Same dormant approval contradiction as I.4. |

### Audit 11 — Permissions

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| 11.1.gate-shape | 3-tier gate not specified | BLOCKER | RUNTIME-BLOCKER | v2 has binary admin roles; TaskFlow must add role-label runtime gates. |
| 11.1.sender-id | `sender_name` to `user_id` bridge | HIGH | RUNTIME-BLOCKER | v2 identity is `user_id`; wrappers need reliable caller mapping. |
| 11.2.self-approval | Manager-assignee cannot approve own task | HIGH | PLAN-BLOCKER | Engine rule exists; test/spec must preserve. |
| 11.3.delegate-gate | Delegate eligible for only select actions | HIGH | RUNTIME-BLOCKER | Requires runtime gate over `taskflow_board_admin_meta`. |
| 11.3.process-inbox | `process_inbox` missing from spec | HIGH | PLAN-BLOCKER | Same inventory omission as L.4. |
| 11.4.gate | Subtask approval handler manager-only | HIGH | PLAN-BLOCKER | Dead-code path; specify if preserved. |
| 11.5.matrix | `move_task` permission matrix | HIGH | PLAN-BLOCKER | Engine matrix exists; enumerate/test. |
| 11.5.canClaim | Unassigned inbox claim rule | HIGH | PLAN-BLOCKER | Existing rule needs test. |
| 11.6.parent-link-guard | Cross-board mutation guard | HIGH | PLAN-BLOCKER | Existing guard needs test. |
| 11.7.local-resolve | Board-local person resolution | HIGH | PLAN-BLOCKER | Central `board_people` keeps behavior; spec must state lookup scope. |
| 11.7.offer-register | `offer_register` response shape | MEDIUM | PLAN-BLOCKER | Existing response contract needs schema/test. |
| 11.8.engine-rule | `register_person` hierarchy guard | HIGH | PLAN-BLOCKER | Engine already rejects missing hierarchy fields; add spec/test. |
| 11.8.auto-provision | `auto_provision_request` wiring | MEDIUM | RUNTIME-BLOCKER | v2 must re-create the second-step provisioning trigger. |
| 11.9.template-hint | Proactive self-approval hint | HIGH | PLAN-BLOCKER | Prompt-side UX must survive template rewrite. |

### Audit 12 — Person management

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| P.1.spec | `register_person` MCP tool | BLOCKER | PLAN-BLOCKER | Engine action exists; MCP inventory/wrapper must expose it. |
| P.2.contract | Slug derivation algorithm | MEDIUM | PLAN-BLOCKER | Existing algorithm needs contract. |
| P.3.contract | Phone canonicalization at write | HIGH | PLAN-BLOCKER | Existing host/container canonicalizers need tests/spec. |
| P.4.contract | Phone validation policy | LOW | LOW | Brazilian-number assumption documentation only. |
| P.5.policy | Person ID collision policy | MEDIUM | PLAN-BLOCKER | Existing fail-not-suffix behavior needs spec. |
| P.6.contract | `boards.owner_person_id` semantics | MEDIUM | PLAN-BLOCKER | Existing org/home-board semantics need schema contract. |
| P.7.tool | `is_primary_manager` flag | HIGH | RUNTIME-BLOCKER | Runtime admin tools must preserve/write primary-manager metadata. |
| P.8.permission | Delegate restriction | HIGH | RUNTIME-BLOCKER | Same runtime role-label gate as permissions. |
| P.9.history | `remove_person` audit row missing | MEDIUM | HIGH | This is a new improvement, not required for parity, but worthwhile. |
| P.10.contract | Phoneless observer mapping | MEDIUM | HIGH | One prod row needs migration handling; not broad enough for blocker. |

### Audit 13 — Audit + history

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| AH.3 | `trigger_turn_id` sparsity | MEDIUM | MEDIUM | Document known historical limit; do not backfill. |
| AH.4 / AH.5 | Magnetism guard reads deleted v2 table | BLOCKER | HIGH | Real incompatibility, but zero prod hits and v1 fails open. |
| AH.7 | `archive_reason` taxonomy | MEDIUM | PLAN-BLOCKER | Existing values need doc/test cleanup. |
| AH.8 | `auditTrailDivergence` disappears | HIGH | RUNTIME-BLOCKER | Auditor must explicitly drop or redefine the detector. |
| AH.9 | `selfCorrections` detector | HIGH | PLAN-BLOCKER | Detector can port with auditor; add preservation criterion. |
| AH.10 | Dryrun NDJSON mount | HIGH | HIGH | Requires v2 mount/allowlist config, but small and isolated. |
| AH.11 | `send_message_log` drop/replacement coupling | HIGH | RUNTIME-BLOCKER | Auditor + wrapper + reconciliation semantics must be resolved together. |
| AH.13 | 8 interaction-record signals | HIGH | RUNTIME-BLOCKER | Several signals depend on removed storage and need auditor rewrite. |
| AH.16 | `auditor-prompt.txt` references `send_message_log` | HIGH | PLAN-BLOCKER | Prompt/DB-row update must be enumerated with auditor rewrite. |

### Audit 14 — Attachments

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| 14.1.spec | Media-support preflight protocol | LOW | DEPRECATED-CORRECTLY | Prompt-only feature has zero production use; replace with honest note. |
| 14.3.contract-mismatch | OCR promise vs actual code | MEDIUM | DEPRECATED-CORRECTLY | OCR import path is not implemented and unused. |
| 14.4.engine-tool | Claimed automatic audit-row writer | MEDIUM | DEPRECATED-CORRECTLY | No engine tool exists; remove claim rather than port vaporware. |
| 14.6.rejected-table | `rejected_mutations` table missing | MEDIUM | DEPRECATED-CORRECTLY | Nonexistent table should be removed from tests/docs. |
| 14.11.specific-clause | Attachment-specific injection clause | LOW | LOW | Keep only if attachment intake is revived. |

### Audit 15 — Templates + runtime

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| G-15.1.1 | Template size estimate wrong | HIGH | PLAN-BLOCKER | Spec/plan must target 1316 LOC baseline, not ~400. |
| G-15.1.2 | No retro-render mechanism | HIGH | PLAN-BLOCKER | Renderer exists; plan needs cutover invariant and script step. |
| G-15.1.3 | Per-board variation strategy unselected | MEDIUM | PLAN-BLOCKER | Provision-time generation must be chosen and tested. |
| G-15.2.1 | Rollback template `.v1` absent | LOW | LOW | Optional rollback hygiene. |
| G-15.3.1 | Scope guard prompt-only | MEDIUM | PLAN-BLOCKER | Defensive prompt line needs survival test. |
| G-15.4.1 | Prompt-injection guardrails untested | HIGH | PLAN-BLOCKER | Existing prompt contract needs adversarial test. |
| G-15.4.2 | v2 sensitive paths missing | HIGH | PLAN-BLOCKER | Template block list must add v2 paths. |
| G-15.5.1 | `target_chat_jid` sites vs v2 destinations | HIGH | PLAN-BLOCKER | Template rewrite, not new engine logic. |
| G-15.6.1 | `board_admins` sites vs v2 roles/meta | HIGH | PLAN-BLOCKER | Template rewrite must reflect v2 role storage. |
| G-15.7.1 | `<context>` header missing attrs | MEDIUM | PLAN-BLOCKER | Host/context renderer must preserve timezone/today/weekday. |
| G-15.7.2 | `<context>` header ownership unclear | LOW | LOW | Architecture note only. |
| G-15.8.1 | Host-side `normalizePhone` owner unclear | HIGH | PLAN-BLOCKER | Behavior test and ownership note are enough. |
| G-15.8.2 | `maskPhoneForDisplay` not in port list | LOW | LOW | Small export/test inventory item. |
| G-15.9.1 | `intended_weekday` optionality | LOW | HIGH | Production evidence shows opt-in guard is rarely used; add observability or stronger prompt/test. |
| G-15.9.2 | No en-US display map | LOW | LOW | 28/28 prod boards are pt-BR; defer. |

### Audit 16 — Schema

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| S1.web-cols | Extra `boards` web-UI columns/FK | GAP | MEDIUM | Preserve or null `org_id`; not central to agent cutover. |
| S2 | Drop `board_groups` requires wiring sweep | GAP | PLAN-BLOCKER | Drop is correct, but plan needs `messaging_group_agents` coverage invariant. |
| S4 | `board_runtime_config` zombie columns | GAP | MEDIUM | Dead-column cleanup decision; behavior survives if carried. |
| S5 | `board_people` two-table write | GAP | RUNTIME-BLOCKER | Live add-person path needs cross-DB write/reconciliation design. |
| S12.user_id | `external_contacts.user_id` backfill not explicit | GAP | HIGH | Small migration/NULL policy needed for v2 identity link. |
| S13 | `meeting_external_participants` column trim | GAP | OVERCLAIM | Audit's deep dive finds no dedicated delivery-state columns to drop; keep all 12. |
| S15 | `send_message_log` drop vs new audit table | GAP | RUNTIME-BLOCKER | Same unresolved audit-storage design as AH.11/W.5. |
| S16 | WAL mode not explicit | GAP | HIGH | Fresh DB initializer must set WAL/synchronous; simple but runtime-affecting. |
| S19 | `board_chat` web-UI table absent from plan | GAP | HIGH | 224 rows need owner decision, but likely out-of-skill. |
| S20 | Web-UI auth tables collide with v2 names | GAP | RUNTIME-BLOCKER | Two `users`/`sessions` domains need placement decision before migration. |
| S21 | `agent_heartbeats` table | GAP | DEAD-CODE-PRESERVED | Zero rows; keep or drop explicitly. |
| S22 | `people` stub table | GAP | DEPRECATED-CORRECTLY | Zero rows and superseded by `board_people`/v2 `users`. |

### Audit 17 — MCP / IPC

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| V.10 | Weekday alias map not enumerated | GAP | PLAN-BLOCKER | Engine map ports; name its module/test. |
| V.11 | DST `localToUtc` not enumerated | GAP | PLAN-BLOCKER | Engine helper ports; add preservation test. |
| V.12 | Non-business-day guard call sites | GAP | PLAN-BLOCKER | Existing call sites need MCP schema/test coverage. |
| V.13 | `find_person_in_organization` vs v2 DB access | GAP | RUNTIME-BLOCKER | Cross-board org walk requires central DB mount/access decision. |
| W.1 | Raw sqlite MCP access | GAP | RUNTIME-BLOCKER | Need keep/drop/read-only architecture decision; affects guard bypass. |
| W.5 | Send audit hook placement contradiction | GAP | RUNTIME-BLOCKER | Pre-queue vs post-delivery semantics changes runtime audit truth. |
| W.7 | Auto-fire child provisioning | GAP | RUNTIME-BLOCKER | Need v2 replacement for MCP result triggering provisioning side effect. |
| W.8 | `provision_root_board` not enumerated | GAP | PLAN-BLOCKER | Existing host plugin path needs tool/ops inventory. |
| W.9 | `register_group` hierarchy metadata | GAP | RUNTIME-BLOCKER | v2 `create_agent` lacks hierarchy fields; sidecar metadata needed. |
| W.10 | `send_otp` IPC path | GAP | RUNTIME-BLOCKER | Web-admin OTP path needs v2 input/delivery design. |
| W.11 | Attachment intake MCP | DEAD | DEPRECATED-CORRECTLY | No engine/MCP path and zero prod rows; do not port as real tool. |
| W.12 | Duplicated phone normalizers | GAP | PLAN-BLOCKER | Accept duplication but add parity test. |

### Audit 18 — Tests + known issues + deprecated

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| X.5 / Y.5 | Delegated subtask rename/reopen `it.todo` | GAP | HIGH | Latent bug/test debt; fix before port if practical, but not broad cutover blocker. |
| X.9 / Y.1 | Magnetism tests/port | GAP | HIGH | Same zero-prod, fail-open magnetism decision as AH.4/AH.5. |
| X.10 | Weekday/DST fixture count claim | GAP | OVERCLAIM | Audit corrects stale count; no v2 blocker if existing tests port. |
| X.11 | Auditor tests invalidated by rewrite | GAP | PLAN-BLOCKER | Add explicit acceptance for rewritten auditor test suite. |
| X.12 | Runner smoke tests missing | GAP | PLAN-BLOCKER | A.3.7 must author standup/digest/review functional tests. |
| X.13 | Attachment functional tests absent | GAP | DEPRECATED-CORRECTLY | Attachment intake is prompt-only/dead; do not invent tests unless revived. |
| X.14 | Adversarial test cluster thin | GAP | PLAN-BLOCKER | Add security prompt/guard survival tests. |
| Y.2 | Weekday guard is opt-in | NEEDS-PORT | HIGH | Production suggests low parameter use; add observability or stronger template rule. |
| Y.6 | Premature person registration is prompt-only | NEEDS-PORT | OVERCLAIM | Engine already rejects missing phone/group_name/group_folder on hierarchy boards. |
| Y.7 | Off-topic DB-query defense is prompt-only | NEEDS-PORT | PLAN-BLOCKER | Preserve/test defensive prompt line. |
| Y.8 | Auditor false-positive fix depends on dropped table | GAP-CHAIN | RUNTIME-BLOCKER | Same unresolved auditor storage rewrite as AH.8/AH.11. |
| Z.1 | Deprecated template baseline wrong | DEPRECATED-INCORRECTLY | PLAN-BLOCKER | Same 1316-line baseline correction as G-15.1.1. |
| Z.2 | Raw `cadastrar` without sigla weakly deprecated | DEPRECATED-CORRECTLY-BUT-WEAKLY | OVERCLAIM | Engine hierarchy guard now rejects missing fields; prompt is not the only defense. |
| Z.4 | Column grouping rule prompt-only | DEPRECATED-CORRECTLY-BUT-FRAGILE | LOW | Preserve prompt line or accept UX drift. |

### Audit 19 — Supporting skills

| GAP ID | Description | Audit severity | Codex reclass | Justification |
|---|---|---|---|---|
| GAP-1 | `add-long-term-context` stale branch vs v1 main | LOW | LOW | Source selection clarification only. |
| GAP-2 | `add-embeddings` scope/auditor ownership unclear | MEDIUM | PLAN-BLOCKER | Plan must assign auditor stack ownership before branch work. |
| GAP-3 | Auditor Ollama env var omitted | LOW | LOW | Env-var matrix cleanup. |
| memory-recap-test | `recent-turns-recap.test.ts` not in plan list | LOW | LOW | Possible test-file omission; low risk if full test suite is ported. |

## Surprises / OVERCLAIMs

- K.17.phone-mask: audit confirms v1 meeting participant paths display plain phones, so "phone-mask display" is not a v1 parity requirement.
- S13: the same audit's deep dive finds no dedicated delivery-state columns in `meeting_external_participants`; the trim recommendation is speculative.
- X.10: the fixture-count claim is stale; this is accounting drift, not a behavior gap.
- Y.6 / Z.2: the audit says premature hierarchy registration is prompt-only, but `taskflow-engine.ts:7423-7437` rejects missing `phone`, `group_name`, or `group_folder`.
- W.11 / attachment intake: the claimed tool surface is vapor; deprecating the protocol is correct unless a new v2 feature is intentionally built.
- Synthesis scope: `20-coverage-synthesis.md` says 15 audits, but 19 audit docs exist and are included here.

## Cross-cutting findings

- The biggest RUNTIME-BLOCKER cluster is identity/role/audit plumbing: sender identity bridge, role-label gates, audit send log semantics, and web-UI table placement.
- The biggest PLAN-BLOCKER cluster is "engine behavior exists but is invisible": TaskFlow's engine port-forward covers many features, but the spec/plan lacks contracts and tests.
- Template migration is a defensive-posture migration: several guardrails are prompt-side, so `CLAUDE.md.template` needs acceptance tests, not only manual review.
- Several findings are duplicates across audits; counts keep duplicates because each duplicate maps to a different plan owner or acceptance surface.
