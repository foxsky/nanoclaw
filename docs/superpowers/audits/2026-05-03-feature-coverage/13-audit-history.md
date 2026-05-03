# Feature coverage audit — audit + history domain

**Date:** 2026-05-03
**Scope:** TaskFlow's audit and history surface — `task_history` (60s undo + magnetism flags + trigger_turn_id), `archive` (soft-delete + reason tracking), Kipp daily auditor (`auditor-script.sh` + `auditor-prompt.txt`) including drift detection, self-correction detector, dryrun NDJSON, eight interaction-record signals, plus `send_message_log` and `attachment_audit_log` tables.
**Method:** enumerate features from `container/agent-runner/src/{taskflow-engine.ts,auditor-script.sh,auditor-prompt.txt,semantic-audit.ts}` + `src/{taskflow-db.ts,db.ts}` → cross-reference against the v2-native redesign spec (`docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md`) and the Phase A.3 Track A plan (`docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md`) → validate volumes against `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/{data/taskflow/taskflow.db,store/messages.db,data/audit/}`.

> **Anchor sources cited by ID below.** Engine line numbers reference `main`. Discovery 03 (`research/2026-05-03-v2-discovery/03-session-dbs.md`) is the load-bearing source for the **`send_message_log` DROP** decision in 2.3.m of the Track A plan. Discovery 19 (`19-production-usage.md`) is the source for the production volumes used here.

---

## Coverage matrix

| ID | Feature (1-line) | Prod usage (60d unless noted) | Plan / spec coverage | Status |
|---|---|---|---|---|
| AH.1 | `task_history` table — every mutation appended (action, by, at, details, trigger_turn_id) | **2,511 rows last 60d** / 2,532 lifetime; 26 distinct action names. Schema at `taskflow-db.ts:106-115` | Spec line 25, 44: "`task_history` STAYS fork-private (v2 has no equivalent) — TaskFlow domain feature." Plan 2.3.d marks fork-private DB initializer for `data/taskflow/taskflow.db` (14 tables incl. task_history) | ADDRESSED |
| AH.2 | 60s undo via `_last_mutation` JSON snapshot in `tasks` (NOT in `task_history`); `recordHistory(taskId,'undone',...)` records the inverse | **2 `undone` rows last 60d** (rare, but load-bearing UX) — engine line 7259 `60_000` ms gate | Spec line 25 + line 255 (`cancel_task` — 60s undo via task_history). Engine code is preserved | ADDRESSED |
| AH.3 | Mutation attribution: `task_history.by` (sender_id / sender_name string) + `trigger_turn_id` for cross-message correlation | **all 2,511 rows last 60d have `by` set; 291 (11.6%) have `trigger_turn_id`** — column added via lazy `ALTER TABLE` (engine line 1199), so older rows lack it | Spec line 25 (preserved). Plan 2.3.n calls out **action-name canonicalization** (8 doublets) but does NOT call out the trigger_turn_id sparsity or the lazy-ALTER pattern | GAP (trigger_turn_id 89% absence + lazy-migration not enumerated) |
| AH.4 | Magnetism guard — shadow logging mode (records `magnetism_shadow_flag` + `magnetism_override` to `task_history`) | **0 rows last 60d** for either action. Action constants at `taskflow-engine.ts:65-66`; firing site at line 981-998 | Plan / spec **silent on magnetism guard entirely**. Not in tool-list, not in feature-deltas table. Plan 2026-04-24-t12-magnetism is a separate doc | GAP (feature exists in 9598-LOC engine + 0 prod hits but is not enumerated in the v2 spec) |
| AH.5 | Magnetism guard — enforce mode (`error_code='ambiguous_task_context'` blocks mutation when bot's prior turn was about a DIFFERENT task) | structurally — every `move_task`/`update_task` call runs `runMagnetismGuard` (engine line 3668, 4598). guardMode default is `'shadow'` (line 840), prod has not flipped to `'enforce'` | Same as AH.4 — silent | GAP (not enumerated; same root cause) |
| AH.6 | `archive` table — soft-delete with `task_snapshot` JSON + per-task history JSON | **188 lifetime archive rows; 0 archive rows touched outside cancel/conclude path**. Schema at `taskflow-db.ts:117-130`. archiveTask() at engine line 3478-3502 | Spec line 41 + 44 (`taskflow-engine.ts` Kanban + lifecycle stays fork-private). Plan 2.3.d covers as part of the 14-table fork-private initializer | ADDRESSED |
| AH.7 | `archive_reason` tracking (cancelled / completed-as-done / merged / deleted_via_web / cancelled_by_admin) | **prod distribution:** `cancelled=133`, `done=45`, `deleted_via_web=9`, `cancelled_by_admin=1`. (`merged` not seen; reserved for project-merge.) | Not enumerated as a discrete feature; archive is preserved as table but the reason taxonomy is not specified. Plan 2.3.d preserves table only | GAP (reason-taxonomy + per-reason behavior unverified) |
| AH.8 | Auditor — drift / `auditTrailDivergence` detector (`deliveriesToGroup ≥ 5` AND `botRowsInGroup < deliveries × 0.5`) | structurally — fires per-board on every Kipp run. Logic at `auditor-script.sh:608-616, 1045-1046, 1102-1115`. Reads from `send_message_log` (the table the plan proposes to DROP) | **Plan 2.3.m proposes to drop `send_message_log` and rewrite ~200 LOC of auditor.** Spec is silent on auditTrailDivergence. The 2026-04-13 silent-board incident specifically motivated this detector | GAP (drift detector depends on the table being dropped — rewrite cost not separately quantified beyond ~200 LOC line item) |
| AH.9 | Auditor — self-correction detector (same-user same-task date-field updates within 60min, scoped to `"Reunião reagendada"` or `"Prazo definido: "` details) | ndjson `kind:'self_correction'` — appears in samples (e.g. 2026-05-01 Giovanni M1-reschedule pattern). Logic at `auditor-script.sh:641-698, 1048-1055` | Plan 2.3.m treats the auditor rewrite as a single ~200 LOC line item; self-correction detector is not separately called out. Spec silent | GAP (detector logic needs explicit re-port in the auditor rewrite — not just send_message_log dependence) |
| AH.10 | Auditor — semantic dryrun NDJSON output to `/workspace/audit/semantic-dryrun-YYYY-MM-DD.ndjson` (interaction + self_correction kinds) | live: `data/audit/semantic-dryrun-2026-05-{01,02,03}.ndjson` exist; sample shows full interaction+self_correction records. Logic at `auditor-script.sh:453-490`; `semantic-audit.ts:1341-1347` | Plan / spec silent. The dryrun mechanism is the EVIDENCE STORE for the entire prevention-loop (Discovery 19: 502 deviations in 15 days driven down to 6/day) | GAP (load-bearing dryrun path not enumerated in plan; bound to `/workspace/audit/` mount) |
| AH.11 | `send_message_log` table — cross-group delivery audit (source_group_folder, target_chat_jid, trigger_*, delivered_at) | **1,488 rows lifetime, all in last 60d.** 184 rows (12.4%) carry `trigger_message_id`. Schema at `src/db.ts:83-100`. Discovery 19: 28% of all bot outbound is cross-board | **Plan 2.3.m proposes DROP** + auditor rewrite. Discovery 03 confirms v2 has no equivalent table; recommends Option 1 (skill-owned central `taskflow_send_message_log` written from delivery hook). Plan 2.3.c proposes `taskflow_send_message_with_audit` wrapper using **pre-queue insert + reconciliation sweep** (NOT `registerDeliveryAction`) | GAP (the DROP decision in 2.3.m and the REPLACEMENT in 2.3.c are inconsistent in placement: 2.3.c says we keep an equivalent under a new name; 2.3.m says we drop and rewrite. See deep-dive AH.11 below) |
| AH.12 | `attachment_audit_log` table — per-board attachment-source audit | **schema present in code AND on prod (`taskflow.db`), 0 rows lifetime.** `taskflow-db.ts:167-175` | Plan 2.3.d preserves the 14-table fork-private DB. Spec is silent on `attachment_audit_log` specifically. Discovery 19 §13: "code references it, table does not exist in central DB — schema gap" — **but it DOES exist on prod**, just empty | DEAD-CODE-PRESERVED (table exists, never written; preserved by 2.3.d but is genuinely unused in prod) |
| AH.13 | Eight interaction-record signals: `isWrite`, `isTaskWrite`, `isDmSend`, `isRead`, `isIntent`, `taskMutationFound`, `crossGroupSendLogged`, `isCrossBoardForward` | structurally — each Kipp run computes all 8 per inbound message. Logic at `auditor-script.sh:295-299, 843-1023`. `auditor-prompt.txt:20-27` documents semantics for the LLM | Plan 2.3.m says "rewrite Kipp auditor to query v2 session DBs directly" (~200 LOC). The eight signals — and especially `crossGroupSendLogged`'s direct dependence on `send_message_log` — are NOT enumerated as preservation requirements. Three of the eight (`isDmSend`, `crossGroupSendLogged`, `isCrossBoardForward`) READ from `send_message_log` | GAP (signal preservation not enumerated; 2.3.m's "200 LOC" estimate likely understates the rewrite cost — see deep-dive AH.13 below) |
| AH.14 | Action-name doublet drift in `task_history` (`create`/`created`, `update`/`updated`/`update_field`, `concluded`/`conclude`, etc.) | live: 4 vs 553 (`create`/`created`); 78 vs 963 vs 2 (`update`/`updated`/`update_field`); 3 vs 155 (`concluded`/`conclude`); 1 vs 10 (`add_note`/`note_added`) | Plan 2.3.n: "task_history action-name canonicalization (Discovery 19) — 8 unfixed doublets identified. Pick canonical names + UPDATE migration on cutover." | ADDRESSED |
| AH.15 | `_last_mutation: null` clear on cancel-then-restore (prevents undo from re-cancelling a restored task) | structurally — engine line 7784 explicitly clears it; load-bearing comment | Spec is silent on the precise undo↔archive interaction; plan inherits silence. Engine code preserved | ADDRESSED (engine domain logic transparent through 2.3.d) |
| AH.16 | Auditor LLM prompt (`auditor-prompt.txt`) — the 74-line behavioural contract for Kipp's reasoning over the 8 signals | active in prod; the Kipp run reads it via SDK. Critical line 20-27 explains the 8-bit signal set; line 32 specifies the auditTrailDivergence wording | Plan 2.3.m is silent on prompt updates. The prompt currently REFERENCES `send_message_log` 5 times explicitly (line 21, 25, 26 are load-bearing references). If the table is dropped, the prompt MUST be rewritten — not just the script | GAP (prompt-text rewrite alongside the 200-LOC script rewrite is unenumerated) |
| AH.17 | Auditor input lookup: per-board `taskHistoryStmts[1]` and `taskHistoryStmts[2]` parameterized by `board_id IN (?)` / `(?, ?)` arity (handles parent-child) | structurally — every Kipp run; `auditor-script.sh:620-631` | Plan 2.3.m and 2.3.d both preserve `task_history` table. Auditor rewrite would re-use this verbatim. `boards` table query at `:531-533` | ADDRESSED (read from same fork-private DB after migration) |

**Counts (17 total):** ADDRESSED **6** (AH.1, AH.2, AH.6, AH.14, AH.15, AH.17) — GAP **10** (AH.3, AH.4, AH.5, AH.7, AH.8, AH.9, AH.10, AH.11, AH.13, AH.16) — DEAD-CODE-PRESERVED **1** (AH.12) — DEPRECATED-CORRECTLY **0** — DEPRECATED-WRONG **0**.

User-stated 12 features map to: AH.1+AH.2+AH.15 (task_history+60s undo), AH.3 (attribution), AH.4 (magnetism shadow), AH.5 (magnetism enforce), AH.6 (archive), AH.7 (archive_reason), AH.8 (drift), AH.9 (self-correction), AH.10 (dryrun NDJSON), AH.11 (send_message_log), AH.12 (attachment_audit_log), AH.13 (eight signals). AH.14, AH.16, AH.17 are surfaced as collateral by code-walk; they ride alongside the same rewrite.

---

## Per-feature deep-dive on every GAP

### Notes on the matrix

The matrix groups features by source surface: AH.1-AH.7 are TaskFlow domain primitives (engine + fork-private DB); AH.8-AH.10 + AH.13 are auditor-internal mechanisms; AH.11-AH.12 are central audit tables in `messages.db` / `taskflow.db`; AH.14-AH.17 are cross-cutting concerns. The 12 user-scoped features map to: task_history with 60s undo (AH.1+AH.2+AH.15), mutation attribution (AH.3), magnetism shadow (AH.4), magnetism enforce (AH.5), task archive (AH.6), archive reason (AH.7), drift detection (AH.8), self-correction (AH.9), dryrun NDJSON (AH.10), send_message_log (AH.11), attachment_audit_log (AH.12), interaction record signals (AH.13). AH.14, AH.16, AH.17 are mechanisms surfaced by code-walk that should travel with the rewrite.

---

### GAP — AH.3: `trigger_turn_id` is 89% absent in live data + lazy-migration pattern

**v1 reality.** `task_history.trigger_turn_id` was added late via `ALTER TABLE task_history ADD COLUMN trigger_turn_id TEXT` (engine line 1199) inside `ensureTaskSchema()`. This is the load-bearing column for the Kipp self-correction detector and several cross-message attribution paths — but only **291 of 2,511 last-60d rows (11.6%)** have it set.

**Spec coverage.** Plan 2.3.d preserves the 14-table fork-private DB. Plan 2.3.n addresses action-name canonicalization but is silent on column-population gaps, the lazy-ALTER migration pattern, or what to do when older history rows lack the column.

**Recommendation.** Add a Phase A.3.2 step under 2.3.d: explicitly enumerate columns added via lazy-ALTER (`task_history.trigger_turn_id`, plus any others sweep finds). Decide whether the v2 cutover script back-fills NULL values (almost certainly should not — historic correlation is unrecoverable) and document the 89% sparsity as a known limit on the self-correction detector's lookback.

### GAP — AH.4 / AH.5: magnetism guard not enumerated in spec

**v1 reality.** The magnetism guard is a runtime safeguard against the agent calling a mutation with a `task_id` that the user's current turn never referenced, when the bot's immediately prior message was a confirmation-question about a DIFFERENT task. Three modes (`off`/`shadow`/`enforce`); shadow logs to `task_history`, enforce returns `error_code='ambiguous_task_context'` and refuses the mutation. Constants at engine line 49-67; logic at line 850-1001; firing sites at line 3668 (move_task) and line 4598 (update_task).

**Production volume.** Last 60d: **0 rows** of action `magnetism_shadow_flag` or `magnetism_override`. Either (a) the guard is in `'off'` mode in prod, (b) `messagesDb`/`chatJid`/`triggerTurnId` are routinely null so the guard fails open at line 872 (`{ shape: 'clear' }`), or (c) the bot never produces the prerequisite confirmation-question pattern. From AH.3 (89% null trigger_turn_id), explanation (b) is most likely.

**Spec coverage.** Spec line 41 lists "Kanban state machine, WIP limits, task lifecycle (...) exposed as MCP tools" but no mention of the magnetism guard. Plan 2.3.a-n is silent. The standalone plan `2026-04-24-t12-magnetism.md` is not referenced from the redesign spec.

**Recommendation.** Spec needs an explicit decision: keep the guard, drop it (zero hits suggests dead code), or simplify to enforce-only. If kept, the v2 port must inject `triggerTurnId`/`chatJid`/`messagesDb` in the new session-DB shape (Discovery 03: `messages_in.id` + chat_jid lookups change semantics under v2). The current heuristic depends on `agent_turn_messages` table (in `messages.db`) which v2 deletes — so the guard is functionally broken under v2 unless re-implemented against `messages_in` ⨝ session DB. **This is a hidden Track A blocker not currently enumerated.**

### GAP — AH.7: archive_reason taxonomy partially undocumented + `merged` reason unverified

**v1 reality.** Five reason values appear in code: `'cancelled'`, `'done'` (auto-archive of done tasks >30d in standup hook, engine line 8930), `'deleted_via_web'` (web admin path), `'cancelled_by_admin'`, and `'meeting_occurrence_archived'` (engine line 3573, distinct path).

**Production volume.** prod distribution: cancelled=133, done=45, deleted_via_web=9, cancelled_by_admin=1. Total=188 archive rows. **`merged` reason claimed in scope but absent from prod data.** Project-merge code path (engine line 8313) writes `archiveTask(..., 'cancelled')` per `archive_triggered=true` flag — so projects archive as `cancelled`, not `merged`.

**Spec coverage.** Plan 2.3.d preserves the table; reason taxonomy not enumerated. The standup auto-archive (`done` reason, line 8932) is part of the silent housekeeping that Audit 02 also flagged as GAP L.19.

**Recommendation.** v2 cutover migration must NOT canonicalize `cancelled` and `cancelled_by_admin` together — they have different actor semantics (peer-cancel vs manager-cancel). Document the 4-reason taxonomy in spec § "What stays fork-private" and explicitly remove `merged` from any plan-listed reasons.

### GAP — AH.8: drift detector (`auditTrailDivergence`) is the load-bearing reason `send_message_log` exists

**v1 reality.** The detector exists because of the 2026-04-13 silent-board incident — `send_message_log` had 91 deliveries; `messages.db` had 0 bot rows. Without this detector, Kipp would have flagged 91 false `noResponse` rows. Logic at `auditor-script.sh:608-616, 1045-1046, 1102-1115`. The detector's threshold (`deliveriesToGroup >= 5 AND botRowsInGroup < deliveriesToGroup * 0.5`) is documented in the prompt at line 32 of `auditor-prompt.txt` as a behavioural contract for the LLM.

**Spec coverage.** Plan 2.3.m says "rewrite Kipp auditor to query v2 session DBs directly (`outbound.db.messages_out` ⨝ `inbound.db.delivered` ⨝ `inbound.db.messages_in`) for cross-board send detection. ~200 LOC auditor change." — but the **drift detector compares two independent persistence layers** (the audit trail AND the bot's own message table). v2's session DB only has ONE persistence layer (`messages_out` ⨝ `delivered`). There is no equivalent of "I sent it but the bot's message table doesn't show it" because in v2, `messages_out` IS the bot's message table. **The class of bug this detector catches cannot occur in v2 the same way** — but a different class (delivery succeeded, downstream `messages.db` mirror failed) might still be relevant if any v1 mirror persists.

**Recommendation.** Plan 2.3.m must explicitly decide: (a) drop the drift detector entirely (the bug class disappears), (b) re-define divergence as `messages_out exists` + `delivered.status != 'delivered'` (a different class, smaller risk), or (c) preserve a fork-private mirror table specifically to keep the dual-source check. None of these is currently in scope.

### GAP — AH.9: self-correction detector specifics (60min window, scoped LIKE patterns) absent from rewrite scope

**v1 reality.** Detector at `auditor-script.sh:641-698`. SQL is intentionally tight: `julianday(b.at) - julianday(a.at)) * 86400 <= 3600` (60min) AND details LIKE `%"Reunião reagendada%"` OR `%"Prazo definido: "%`. Scoped to avoid flagging legitimate iterative edits (notes, labels). The auditor LLM gets pairs + the triggering user message for context.

**Spec coverage.** Plan 2.3.m's "200 LOC" rewrite line item subsumes this entire detector. Spec silent.

**Recommendation.** The 60min window + the `%Reunião reagendada%`/`%Prazo definido: %` LIKE patterns are bound to PT-BR engine output. When the auditor rewrites against v2 session DBs, the `task_history` source is unchanged (`details` JSON still flows from engine), so the detector logic ports verbatim. **The risk is forgetting it exists** — Plan 2.3.m should explicitly list "self-correction detector + 60min window + 2 detail patterns" as a preservation requirement, not just "rewrite ~200 LOC."

### GAP — AH.10: dryrun NDJSON output path + format unspecified

**v1 reality.** `auditor-script.sh:453-490` writes to `/workspace/audit/semantic-dryrun-YYYY-MM-DD.ndjson` (mounted as `data/audit/` on the host). NDJSON shape: `{kind:'interaction'|'self_correction', period, boardId, boardFolder, boardGroup, ...}`. This is the durable evidence trail that drove the 502→6 deviation reduction (Discovery 19). `semantic-audit.ts:1341-1347` reads back the same path for dedup across days.

**Spec coverage.** Plan 2.3.m treats the auditor as one item; Plan-wide silence on the `data/audit/` mount or the NDJSON contract.

**Recommendation.** v2 mount-allowlist (Plan 2.3 step 4d for taskflow mounts) must explicitly include `data/audit/`. The NDJSON dedup key (`boardId+taskId+fieldKind+at`) is documented in `semantic-audit.ts:1279` and must survive the rewrite.

### GAP — AH.11 + AH.13 + AH.16: `send_message_log` DROP decision

See **special call-out** below — covered in dedicated section.

### GAP — AH.16: auditor-prompt.txt rewrite alongside script rewrite

**v1 reality.** `auditor-prompt.txt` (74 lines) is the LLM's behavioural contract. Lines 21, 25, 26 explicitly reference `send_message_log` and the 8 signal bits. Line 32 specifies the exact PT-BR wording for the auditTrailDivergence warning ("🚨 *Trilha de auditoria divergente*: {deliveriesToGroup} entregas..."). Line 22-27 documents the semantics of all 8 signal bits — this is what the LLM uses to classify findings.

**Spec coverage.** Plan 2.3.m focuses on the script (~200 LOC). Prompt rewrite is unenumerated. Per memory `reference_auditor_prompt_db_vs_file.md`: editing the file changes nothing unless `scheduled_tasks.prompt` column is also UPDATEd. **Three rewrite surfaces minimum:** the .sh heredoc, the prompt .txt file, AND the cron row in `scheduled_tasks` (in v1) / `messages_in` (in v2).

**Recommendation.** Plan 2.3.m must enumerate all three rewrite surfaces. Per the memory note, the DB-stored prompt is the canonical one — rewriting only the file is a no-op until the cron row is migrated.

### GAP — AH.17: arity-aware `task_history` lookup statements + parent-child board scope

**v1 reality.** `auditor-script.sh:620-631` defines `taskHistoryStmts` indexed by `[1]` (single-board case) and `[2]` (parent-child case where Kipp audits a parent + its child board together). The board's parent is fetched via `boardStmt` at `:531-533` and joined dynamically based on the existence of `parent_board_id`. Same arity pattern reappears in `tasksColumnStmts`, `selfCorrectionStmts`, and `personNameByIdStmt`.

**Spec coverage.** Plan 2.3.m's auditor rewrite is silent on the parent-child arity. Under v2, `boards` table moves to fork-private `data/taskflow/taskflow.db` (preserved in 2.3.d), so the join shape is preserved — but the rewrite must explicitly handle the parent-child case for cross-board mutations, which Discovery 19 §7 confirms is 28% of all bot outbound.

**Recommendation.** v2 auditor rewrite preserves the same arity-aware statement pattern. Mechanically simple but **MUST** be explicitly listed in the 2.3.m plan, because parent-child audit is exactly the case where AH.8/AH.13 cross-board signals matter most.

---

## Special call-out: does the ~200 LOC auditor rewrite (Plan 2.3.m) preserve all 12 in-scope features?

**Plan 2.3.m claim:** "Drop `send_message_log` table entirely. Rewrite Kipp auditor to query v2 session DBs directly (`outbound.db.messages_out` ⨝ `inbound.db.delivered` ⨝ `inbound.db.messages_in`) for cross-board send detection. ~200 LOC auditor change."

**Audit answer: NO. The 200-LOC line item underestimates the rewrite by missing 4 distinct preservation requirements.** Here's the per-signal accounting against the eight interaction-record signals (AH.13) plus drift (AH.8) and self-correction (AH.9):

| Signal | Source under v1 | Source under v2 (after drop) | Rewrite cost |
|---|---|---|---|
| `isWrite` | regex on user message text | unchanged | 0 LOC |
| `isTaskWrite` | regex on user message text | unchanged | 0 LOC |
| `isDmSend` | regex on user message text | unchanged | 0 LOC |
| `isRead` | regex on user message text | unchanged | 0 LOC |
| `isIntent` | regex on user message text | unchanged | 0 LOC |
| `taskMutationFound` | `task_history` lookup | `task_history` lookup (taskflow.db preserved) | 0 LOC |
| **`crossGroupSendLogged`** | `send_message_log` SELECT (`auditor-script.sh:843-877`) | **must be reconstructed** by walking N session DBs (`data/v2-sessions/*/outbound.db`) joining `messages_out.in_reply_to → inbound.messages_in.id` per Discovery 03 | ~80-150 LOC, plus per-session DB-open overhead — slow if N>>10 |
| **`isCrossBoardForward`** | regex on bot reply + `send_message_log` row presence | same regex + N-session lookup | bound to crossGroupSendLogged cost; +20-40 LOC |
| **`auditTrailDivergence` (AH.8)** | `COUNT FROM send_message_log` vs `COUNT FROM messages` | **bug class disappears under v2** (single persistence layer) — but it's a feature loss, not a port | **detector becomes vestigial; either dropped or redefined.** Plan must decide |
| **selfCorrections (AH.9)** | `task_history` self-join | unchanged | 0 LOC |
| **dryrun NDJSON (AH.10)** | unchanged | unchanged | 0 LOC + mount-allowlist line |
| **prompt text + DB-stored cron row (AH.16)** | references `send_message_log` 5× | every reference rewritten in PT-BR | ~30-50 prompt-text lines + 1 DB UPDATE per board |

**Total realistic rewrite cost:** ~150-250 LOC of script + prompt-text rewrites + a per-session DB-walk that runs once per Kipp invocation across ~28 board folders. **Performance regression risk:** the v1 query was 2 indexed SELECTs; v2 needs to open 28 SQLite files per audit run. At 1843 successful audit runs over 30 days (Discovery 19 §10), that's ~52K file-opens/month — bounded but not free.

**Net:** Plan 2.3.m's "~200 LOC" estimate is in the right ballpark for the script alone, but it elides:
1. The auditTrailDivergence redefinition (bug class disappears — feature decision needed).
2. The auditor-prompt.txt rewrite (~30-50 lines of PT-BR + a `scheduled_tasks.prompt` UPDATE).
3. The per-session DB-walk performance characteristic (28 file-opens × N days).
4. The hidden Track A blocker that **magnetism guard (AH.4/AH.5) reads `agent_turn_messages` from `messages.db`** which v2 also deletes — so even if Plan 2.3.m succeeds, the guard breaks separately and is unenumerated (see GAP AH.4/AH.5 above).

**Recommendation.** Plan 2.3.m should be split into 4 sub-tasks before execution:
- **2.3.m.1** Auditor script rewrite (~150 LOC).
- **2.3.m.2** Prompt-text rewrite + per-board DB row UPDATE (~50 LOC + N rows).
- **2.3.m.3** auditTrailDivergence: drop or redefine (decision item).
- **2.3.m.4** Magnetism guard re-implementation against v2 session DBs (separate GAP, ~80-120 LOC) — currently unenumerated as a blocker.

The `send_message_log` DROP **does** preserve interaction-record signals 1-6 and 10-11 mechanically, but signals 7-9 + the prompt + the magnetism guard require explicit work that Plan 2.3.m does not currently call out. **Net finding: the DROP is feasible but more expensive than the line item suggests.**

---

## Production-validation summary

| Probe | Result | Conclusion |
|---|---|---|
| `task_history` total / last 60d | **2,532 / 2,511** | High volume; AH.1 load-bearing |
| `task_history.action LIKE '%magnet%'` | **0 rows** | Magnetism shadow flags zero in prod (AH.4/AH.5 — likely fails-open) |
| `archive_reason` distribution | cancelled=133 / done=45 / deleted_via_web=9 / cancelled_by_admin=1 | 4 of 5 documented reasons in active use; `merged` not seen (AH.7) |
| `send_message_log` lifetime / last 60d | **1,488 / 1,488** (all rows fit in 60d window) | Cross-group audit is recent + heavy; AH.11 = the table whose DROP triggers the rewrite |
| `task_history.trigger_turn_id` populated | **291 / 2,511 = 11.6%** | Lazy-ALTER + sparse fill (AH.3) |
| `send_message_log.trigger_message_id` populated | **184 / 1,488 = 12.4%** | Same shape — the trigger-correlation columns are sparsely populated across BOTH audit tables |
| `attachment_audit_log` exists / row count | **schema present / 0 rows** | Confirms Discovery 19 §13 — AH.12 dead-code-preserved |
| Recent Kipp dryrun NDJSON | `semantic-dryrun-2026-05-{01,02,03}.ndjson` present, samples show `kind:'interaction'` records with full deviation analysis | AH.10 active in prod |
| Self-correction NDJSON kind | `kind:'self_correction'` present in samples | AH.9 active in prod |

**Cross-cut insight.** Both audit tables (`task_history.trigger_turn_id` and `send_message_log.trigger_message_id`) have ~12% population rates. The auditor's correlation logic must continue to handle the 88% NULL case gracefully — this is preserved through Plan 2.3.m only because the `LEFT JOIN` semantics naturally fall through, not because anyone has explicitly verified it.

---

## File paths (load-bearing)

- `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` (engine: lines 65-67, 850-1001, 1199, 2447-2469, 3478-3502, 7259-7347)
- `/root/nanoclaw/container/agent-runner/src/auditor-script.sh` (lines 295-299, 420-490, 608-698, 843-1023, 1043-1116, 1296-1442)
- `/root/nanoclaw/container/agent-runner/src/auditor-prompt.txt` (lines 20-32: 8-signal contract + auditTrailDivergence wording)
- `/root/nanoclaw/container/agent-runner/src/semantic-audit.ts` (lines 877, 1279, 1341-1347)
- `/root/nanoclaw/src/db.ts` (lines 83-100: send_message_log schema)
- `/root/nanoclaw/src/taskflow-db.ts` (lines 106-115: task_history / 117-130: archive / 167-175: attachment_audit_log)
- `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md` (line 25, 41-44: what stays fork-private)
- `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md` (lines 130-145: 2.3.a-n; 285: open question on send_message_log drop)
- `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/03-session-dbs.md` (Option 1 recommendation for taskflow_send_message_log)
- `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/19-production-usage.md` (§7 cross-board sends; §9 Kipp findings; §13 attachment_audit_log gap)

---

## Recommendations summary

1. **Spec gap — magnetism guard (AH.4/AH.5)** is silent in spec but lives in 9598-LOC engine. Reads `agent_turn_messages` from `messages.db` which v2 deletes. Either drop the guard or re-implement against v2 session DBs. **Hidden Track A blocker.**
2. **Plan 2.3.m underestimated.** Split into 2.3.m.1–2.3.m.4 covering script + prompt + DB-stored prompt + auditTrailDivergence decision. ~200 LOC is the SCRIPT alone; total rewrite is closer to 250-350 LOC + 28 prompt UPDATEs.
3. **`auditTrailDivergence` (AH.8)** bug class disappears under v2. Plan must explicitly decide: drop the detector, or redefine it against `delivered.status != 'delivered'`.
4. **Mount allowlist** (per Plan 2.3 step 4d) must include `data/audit/` so AH.10 dryrun NDJSON keeps writing.
5. **`trigger_turn_id` 89% absent** in `task_history` — document as a known limit; do not back-fill at cutover.
6. **`attachment_audit_log` (AH.12)** is dead in prod — consider dropping from the 2.3.d 14-table list to keep the schema honest, OR explicitly mark it as reserved for the (unimplemented) attachment-source audit feature.

---

**Self-review.** Audit covers 17 features across the audit + history domain (12 in user-stated scope + 5 surfaced by code-walk: auditor prompt text AH.16, last_mutation:null undo guard AH.15, action-name doublets AH.14, board-arity statements AH.17, dryrun NDJSON AH.10). 6 ADDRESSED + 10 GAP + 1 DEAD-CODE-PRESERVED. The biggest finding is that Plan 2.3.m's "~200 LOC" auditor rewrite hides 3 distinct sub-tasks (prompt rewrite, divergence-detector decision, magnetism re-implementation) plus the per-session DB-walk performance regression. None of these is fatal; all need explicit enumeration before Phase A.3.2 step 2.3.m starts.
