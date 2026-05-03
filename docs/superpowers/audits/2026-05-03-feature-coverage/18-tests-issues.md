# 18 — Tests + Known Issues + Deprecated Domains: Feature-Coverage Audit

**Date:** 2026-05-03
**Scope:** TaskFlow's combined **tests (X, 14 features) + known issues (Y, 8 features) + deprecated (Z, 5 features)** — 27 features total. These three domains are reviewed together because (a) every Y has at least one test in X, (b) every Z is a *removed* feature whose absence the test/plan must verify, and (c) the X tests are the only acceptance gate the plan actually inherits.
**Anchor plan:** `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md` (321 LOC)
**Anchor spec:** `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md` (389 LOC)
**Discovery synthesis:** `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/{19-production-usage.md,20-fork-divergence.md}`
**Engine source:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` (~9,600 LOC)
**Engine tests:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.test.ts` (7218 LOC, **330 `it()`**)
**Skill tests:** `/root/nanoclaw/.claude/skills/add-taskflow/tests/taskflow.test.ts` (7572 LOC, **374 `it()`**) + `migrate-cross-board-forward.test.ts` (9 `it()`)
**Auditor tests:** `auditor-dm-detection.test.ts` (58) + `auditor-delivery-health.test.ts` (7) + `semantic-audit.test.ts` (69) = **134 `it()`**

---

## 0. Production validation (queries run 2026-05-03 against `nanoclaw@192.168.2.63`)

### Test counts (verified, NOT estimated)

| Surface | `it()` count | Scope claim | Verdict |
|---|---:|---:|---|
| `container/agent-runner/src/taskflow-engine.test.ts` | **330** | "234+" engine tests | claim under-counts by 96 |
| `.claude/skills/add-taskflow/tests/taskflow.test.ts` | **374** | "901+" project tests | claim conflates skill-test with host+container+skill aggregate |
| Host + skill (all `it()`) | **1173** | — | spec/plan never enumerates this |
| Container (all `it()`) | **629** | — | spec/plan never enumerates this |
| Auditor sub-suite (3 files) | **134** | "126" claim | claim under-counts by 8 (close enough; 126 was probably a snapshot from a week earlier) |

The "234+ / 901+ / 126" figures in the user prompt are **stale snapshots**. Reality is 330 / 374 / 134. The plan inherits the stale numbers via spec line 5 ("7-8 weeks") but never quotes a test-count target — so the discrepancy doesn't break acceptance, it just makes "test-coverage parity" non-falsifiable.

### Magnetism guard production state

```sql
SELECT COUNT(*) FROM task_history WHERE action='magnetism_shadow_flag';  -- 0
SELECT COUNT(*) FROM task_history WHERE action='magnetism_override';      -- 0
```

**Zero rows lifetime** for either action across all 28 boards. Engine ships `guardMode='shadow'` default (`taskflow-engine.ts:840`), so this is either (a) bot never produces the prerequisite confirmation-question pattern, (b) `triggerTurnId`/`chatJid`/`messagesDb` are routinely null so guard fails open, or (c) prod has guardMode flipped to `'off'`. From AH.3 (89% null `trigger_turn_id` in last-60d `task_history`), explanation (b) is most likely. **The guard is effectively dead in prod**, but its test suite (18 `it()` tests, lines 6629-6977) is the largest test cluster covering a feature with zero production hits.

### Scope-guard refusal sample

```sql
SELECT chat_jid, COUNT(*) FROM messages
WHERE is_from_me=1 AND content LIKE '%Fora do escopo%'
GROUP BY chat_jid;
-- 120363406395935726@g.us | 1
-- 558699916064@s.whatsapp.net | 1
```

**Only 2 lifetime hits** of the literal "Fora do escopo" template. Broader pattern (`Sou assistente de gerenciamento`) hits **4 rows** — confirming the scope-guard REFUSES off-topic input but at extremely low volume. Prompt-side defense (template L9) is real, but exercised so rarely that any v2 regression here would not be caught in production until weeks-to-months later.

### User weekday-input sample

```sql
SELECT COUNT(*) FROM messages WHERE is_from_me=0
  AND (content LIKE '%terça%' OR content LIKE '%quinta%'
    OR content LIKE '%amanhã%' OR content LIKE '%amanha%' OR content LIKE '%segunda%');
-- 78
```

78 user messages mention a weekday or "tomorrow" in last-60d — confirming `WEEKDAY_ALIASES` (engine:572-590) is in active use. But:

```sql
SELECT COUNT(*) FROM task_history WHERE details LIKE '%weekday%' OR details LIKE '%mismatch%'; -- 0
```

**Zero `weekday_mismatch` rows** in `task_history` lifetime. The guard is opt-in (`intended_weekday` parameter, engine:629) — the agent has never invoked it. This is the same pattern as magnetism: large test surface (18 `it()` in `describe('weekday guard')`, lines 3427-3833) for a guardrail with zero prod evidence.

### Engine internals validated

- `normalizePhone()` fixtures verified: `taskflow-engine.test.ts:7200-7218` — 10 fixtures (`'5585999991234'`, `'+55 (85) 99999-1234'`, …, `'442079460958'`) all pairing the engine with host `src/phone.ts`.
- DST round-trip: 1 `it()` covers fall-back + unambiguous + spring-forward gap in `America/New_York` (`:3558`); 1 more for fall-back-with-weekday (`:3787`). **2 DST tests total** — guards both the original spring-forward bug AND the regression-window for weekday × DST interaction.
- Subtask numeric ordering: 1 `it()` (`:348`) — inserts 12 subtasks reverse-order, asserts numeric (not lexicographic).
- Delegated subtask history: 1 `it()` (`:3123`) for `unassign_subtask`; **1 `it.todo`** at `:3071` for "delegated subtask rename and reopen" — TODO is unaddressed.
- `subtask_requests` table: 6 ref-sites in cross-board mode tests (`:6233-6418`) covering open/blocked/approval modes.
- Cross-board subtask mode: `describe('cross-board subtask mode')` at `:6137` has **11 `it()` tests** (open/blocked/approval each have ≥3 cases, plus delegated approval and project-merge interplay).
- `merge_project`: `describe('merge_project')` at `:5947` has **7 `it()` tests** — confirms the "7 variants" scope claim.

---

## 1. Coverage tables

### 1.1 Scope X — Tests (14 features)

| ID | Feature (1-line) | Verified count | Plan / spec coverage | Status |
|---|---|---:|---|---|
| X.1 | 234+ engine tests | **330 actual** | Plan 2.2 says "Adapt all test imports for v2 paths"; no count target | ADDRESSED (count under-claimed but suite intact) |
| X.2 | 901+ project tests | **374 skill `it()` + 1173 host+skill aggregate** | Plan 2.4 references engine-canonical regression suite | ADDRESSED (claim was conflated; suite in place) |
| X.3 | Phone canonicalization parity (10 fixtures) | **10 fixtures, exactly** (`:7201-7212`) | Plan 2.3.d preserves; 2.4 regression-suite covers | ADDRESSED |
| X.4 | Subtask numeric ordering regression | **1 `it()`** (`:348`) | Implicit via 2.4 (no enumerated test case) | ADDRESSED (test exists; v2 must port verbatim) |
| X.5 | Delegated subtask history fix | **1 `it()`** (`:3123`) + **1 `it.todo`** (`:3071`) | Plan silent on the `it.todo` | GAP (G-X.5 — `it.todo` for rename/reopen still pending) |
| X.6 | Cross-board mode tests (open/blocked/approval) | **11 `it()`** in `describe('cross-board subtask mode')` (`:6137`) | Plan 2.3.h mentions `/aprovar`+`subtask_requests` preservation; doesn't enumerate the 11 cases | ADDRESSED (suite ports as-is) |
| X.7 | merge_project tests (7 variants) | **7 `it()`** in `describe('merge_project')` (`:5947`) | Plan silent on count; 2.4 covers via regression suite | ADDRESSED |
| X.8 | subtask_requests idempotency | covered by X.6 (3 of the 11 cases hit replay/duplicate paths) | Plan 2.3.h preserves protocol | ADDRESSED |
| X.9 | Magnetism guard shadow logging | **18 `it()`** in `describe('T12 magnetism guard')` (`:6629`) | Plan + spec **silent** | GAP (G-X.9 — see AH.4/AH.5; v2 cutover must port `messagesDb`/`triggerTurnId`/`chatJid` injection or guard breaks) |
| X.10 | Weekday/DST/non-business-day fixtures | **18 `it()` weekday** (`:3427`) + **2 DST round-trip** + holiday/business-day cluster (`:3638-3782`); ~40 cases total, NOT 54 | Plan silent on count; 2.4 covers via regression suite | GAP (G-X.10 — claim "54 fixtures" overstates; reality ~40. Either reconcile claim or back-port more) |
| X.11 | Auditor (126 cases) | **134 `it()`** across 3 files (58+7+69) | Plan 2.3.m: "rewrite Kipp auditor to query v2 session DBs directly (~200 LOC)". The 134 tests do not currently target v2 session-DB shape | GAP (G-X.11 — auditor rewrite invalidates ~half the auditor test suite; rewrite cost in plan understates re-test cost) |
| X.12 | Smoke tests for runners (standup/digest/review) | **0 dedicated runner `it()`** in skill tests; runner output covered indirectly via SKILL.md Phase-6 string-match tests | Plan A.3.7 step 7.2 lists "morning standup, evening digest, weekly review" as cross-cutting flows requiring at-least-one happy + one error path | GAP (G-X.12 — runner functional tests don't exist; A.3.7 will need to author them, not port them) |
| X.13 | Attachment import functional tests | **0 functional `it()`** — only template-string-match tests (`:510, 2826`); engine has 0 hits for `attachment`, `CONFIRM_IMPORT`, `import_action_id`; `attachment_audit_log` 0 prod rows lifetime | Plan 2.3.d preserves the table; A.3.7 silent on attachment functional path | GAP (G-X.13 — attachment intake is CLAUDE.md-instruction-only; no engine action; no functional test; prod row count zero. v2 cutover loses the feature with zero detection.) |
| X.14 | Adversarial security tests | **2 `it()`** at `:396, 1522` (CLAUDE.md prompt-injection defense + create_group depth check) | Plan silent | GAP (G-X.14 — only 2 adversarial tests for a feature class that includes secret-disclosure refusal, indirect prompt injection via attachment, off-topic scope-guard, magnetism. Cluster needs explicit port-forward verification) |

**X totals (14):** ADDRESSED **8** (X.1, X.2, X.3, X.4, X.6, X.7, X.8) + ADDRESSED-but-claim-stale **0** — GAP **6** (X.5, X.9, X.10, X.11, X.12, X.13, X.14 — 7 actually; X.5 has dual status). Recount: **ADDRESSED 7 / GAP 7**.

### 1.2 Scope Y — Known issues (8 features)

| ID | Issue (1-line) | Origin | Engine fix in v1 fork | Plan / spec coverage | Status |
|---|---|---|---|---|---|
| Y.1 | task-id magnetism bug — agent picks T12 when bot just confirmed-asked T13 | 2026-04-23 production incident | `checkTaskIdMagnetism()` engine:850-1001 + 18 tests; `guardMode='shadow'` default | Plan + spec **silent**; 0 prod hits despite 60d window | NEEDS-PORT-FORWARD (G-Y.1) |
| Y.2 | weekday LLM error — Giovanni rescheduled "para quinta" but agent stored Wednesday | 2026-04-?? "Giovanni regression" | `intended_weekday` opt-in; `checkIntendedWeekday()` engine:629; 18 `it()` covering create/update/due_date/scheduled_at | Spec + plan silent on the *opt-in nature*; agent must ALWAYS pass `intended_weekday` to get the guard | NEEDS-PORT-FORWARD (G-Y.2) |
| Y.3 | DST spring-forward gap (`02:30` on transition Sunday is non-existent) | 2026-04-?? — schedule_at stored as `06:30Z` instead of `07:30Z` (1h drift) | `tz-util.ts` round-forward + 2 `it()` round-trip tests | Spec line 5 says "America/Fortaleza no DST since 2019" — true for prod, but engine still must handle America/New_York etc. v2 cutover ships America/Fortaleza prod boards but other-zone boards exist in test fixtures | ADDRESSED-in-tests (no port-forward needed; engine code preserved by 2.3.d) |
| Y.4 | subtask lexicographic ordering — `P1.10 < P1.2` confused users on 10+ subtasks | 2026-?? UX bug | natural-numeric sort baked into `task_details` query (not a separate function); 1 `it()` | Plan silent | ADDRESSED-in-tests (no port-forward needed) |
| Y.5 | delegated subtask history written to wrong board | engine recordHistory missing taskBoardId arg | unassign path covers; rename/reopen path is **`it.todo`** | Plan silent | NEEDS-PORT-FORWARD (G-Y.5) — `it.todo` is unaddressed; v2 inherits the latent bug |
| Y.6 | premature person registration — agent calls `register_person` with 3 fields on hierarchy boards (missing sigla) | 2026-04-?? — child board misnamed as person | Template L398 instructs ask-for-sigla; engine guards "before MAX_DEPTH" | Plan silent on the **template-instruction-vs-engine-rule split** — engine doesn't refuse a 3-field call; the rule lives only in the prompt | NEEDS-PORT-FORWARD (G-Y.6) — prompt-only defense; no functional test; v2 spec rewrite of template (G-15.1.1) could drop the line |
| Y.7 | off-topic queries token-burn — agent queries DB before refusing | template L9 fix: "Do NOT query the database for off-topic requests" | Template-only; engine no-op | Plan silent; spec Q2 ("`'.'` vs more specific engage_pattern") is adjacent but doesn't cover this | NEEDS-PORT-FORWARD (G-Y.7) — template-only; v2 redesign threatens to drop the line |
| Y.8 | auditor false-positives — auditor flagged delivered messages as `noResponse` because `send_message_log` had deliveries that `messages.db` didn't show | 2026-04-13 silent-board incident | `auditTrailDivergence` detector + 8-signal interaction record in auditor-prompt.txt | Plan 2.3.m proposes DROP `send_message_log` + auditor rewrite; AH.8 (audit 13) flags this as the **load-bearing reason `send_message_log` exists** | GAP-CHAIN (G-Y.8) — fix relies on a table the plan drops; same gap as AH.8/AH.11 in audit 13 |

**Y totals (8):** ADDRESSED-in-tests **2** (Y.3, Y.4) — NEEDS-PORT-FORWARD **5** (Y.1, Y.2, Y.5, Y.6, Y.7) — GAP-CHAIN-with-AH-domain **1** (Y.8).

### 1.3 Scope Z — Deprecated (5 features)

| ID | Deprecated feature | Replaced by | Plan / spec acknowledges removal? | Status |
|---|---|---|---|---|
| Z.1 | v1 template (1200 lines, claim) | v2 redesign sketched at spec L325-336, "~300 lines" target | Spec L48 + L335 quote "~400 lines"/"~300 lines" — but **actual current template is 1316 lines** (audit 15 G-15.1.1). The "1200 lines" deprecation target in this audit's scope is also wrong by ~100 LOC | DEPRECATED-INCORRECTLY (Z.1: spec quotes wrong baseline; audit 15 GAP G-15.1.1) |
| Z.2 | raw `cadastrar Nome, telefone, cargo` without sigla on hierarchy boards | Template L398 ask-for-sigla protocol | Template enforces; **no engine guard**; no test asserts engine refuses | DEPRECATED-CORRECTLY-BUT-WEAKLY (Z.2: behavior change; v2 redesign of template could lose the protective wording) — same root as Y.6 |
| Z.3 | manual `schedule_task` via raw SQL | `taskflow_admin` MCP wrapper around `manage_holidays`/runner-management; SDK `schedule_task` IPC tool | Template L1104: "Do NOT fake a workaround via raw SQL". Plan 2.3.d preserves the cron tables; spec is silent on the deprecation | DEPRECATED-CORRECTLY (Z.3: documented in template; behavior preserved) |
| Z.4 | column grouping unsupported (engine doesn't expose grouped views) | Engine returns flat list; template L923 says "grouping is a formatting choice" — **never claim it's a system limitation** | Template carries the explicit "Never claim column grouping is impossible" rule; v2 redesign threatens to drop it | DEPRECATED-CORRECTLY-BUT-FRAGILE (Z.4: prompt-only; template rewrite risk) |
| Z.5 | `find_person` without org-wide scope | `find_person_in_organization` (engine:7138) walks tree from this board up to root then descends | Engine + template L443/L453 require org-wide scope BEFORE asking for phone or registering | DEPRECATED-CORRECTLY (Z.5: engine-enforced; tests at `:682-889` cover) |

**Z totals (5):** DEPRECATED-CORRECTLY **2** (Z.3, Z.5) — DEPRECATED-CORRECTLY-BUT-FRAGILE **2** (Z.2, Z.4 — prompt-only) — DEPRECATED-INCORRECTLY **1** (Z.1 — wrong baseline; same as audit 15 G-15.1.1).

---

## 2. Combined status counts (X + Y + Z = 27 features)

- **ADDRESSED:** 11 (X.1, X.2, X.3, X.4, X.6, X.7, X.8, Y.3, Y.4, Z.3, Z.5)
- **GAP / NEEDS-PORT-FORWARD:** 13 (X.5, X.9, X.10, X.11, X.12, X.13, X.14, Y.1, Y.2, Y.5, Y.6, Y.7, Y.8)
- **DEPRECATED-INCORRECTLY (spec wrong):** 1 (Z.1)
- **DEPRECATED-CORRECTLY-BUT-FRAGILE:** 2 (Z.2, Z.4)

---

## 3. Per-gap deep-dive

### G-X.5 / Y.5 — `it.todo` for delegated subtask rename/reopen

`taskflow-engine.test.ts:3071` declares `it.todo('delegated subtask rename and reopen write to the owning board and history')`. Two of the engine's history-write paths (rename, reopen) are **not covered** — only `unassign` (`:3123`) is asserted. The bug shape is identical to the unassign fix (missing `taskBoardId` arg in `recordHistory`). Plan silent on the todo.

**Recommendation:** Phase A.3.2 step 2.3 should resolve the `it.todo` BEFORE the v2 port lands — otherwise the latent bug crosses the cutover and the test surface shrinks rather than grows.

### G-X.9 / Y.1 — Magnetism guard is functionally broken under v2

The guard depends on `agent_turn_messages` table in `messages.db` (engine:850-1001 reads `messagesDb` + `triggerTurnId` + `chatJid` to find the bot's prior turn). v2 deletes this table (Discovery 03). **The guard is not just untested under v2 — it cannot run at all.**

Plan 2.3.m talks about "v2 session DBs (`outbound.db.messages_out` ⨝ `inbound.db.delivered` ⨝ `inbound.db.messages_in`)". The magnetism guard needs to be re-implemented against this shape, OR documented-as-dropped. 0 prod hits suggests the latter is acceptable.

**Recommendation:** Spec needs an explicit decision in Phase A.3.2 step 2.3: keep the guard (port to session-DB) OR drop it (engine line 49-67 + 850-1001 + 18 tests removed). Hidden Track A blocker.

### G-X.10 — Weekday/DST/non-business-day fixture count claim ("54") is wrong

Reality: 18 weekday + 2 DST + ~20 non-business-day/holiday cases ≈ **40 fixtures**, not 54. Either back-port more cases (4 cases per Brazilian regional holiday × 5 regions = 20 missing) OR correct the scope claim. Material because the audit cites "(54 fixtures)" as ADDRESSED quantity.

### G-X.11 — Auditor rewrite invalidates ~half the auditor test suite

134 auditor `it()` cases assume the v1 input shape (`send_message_log` + `messages.db` + `agent_turn_messages`). Plan 2.3.m says "~200 LOC auditor change" — but the test rewrite is comparable size. Plan does not separately quantify auditor-test rewrite cost.

**Recommendation:** Add to Plan 2.3.m: explicit acceptance criterion "all 134 auditor `it()` cases pass against v2 session-DB inputs OR are explicitly skipped+commented with v2-replacement test". Without this, "Codex clean" is too weak a gate.

### G-X.12 — Runner smoke tests don't exist; A.3.7 must author from scratch

Skill tests cover **runner output formatting via SKILL.md string-matching** (e.g. `:602, :2876`) but NO end-to-end happy-path test that runs `runStandupForBoard()` against a seeded DB and asserts the output structure. Plan A.3.7 step 7.2 implicitly requires this without enumerating it.

**Recommendation:** Promote A.3.7 step 7.2 from a TODO marker to an enumerated 3-test minimum: standup, digest, review — happy-path each.

### G-X.13 — Attachment intake has zero functional tests + zero prod hits

Engine has 0 references for `attachment`, `CONFIRM_IMPORT`, `OCR`, `import_action_id`. Skill tests `:510` + `:2826` are template-string-match only. `attachment_audit_log` has 0 lifetime rows in prod (audit 14 confirmed). The intake flow is **CLAUDE.md-instruction-only**, not coded behavior.

**Recommendation:** v2 cutover MUST decide explicitly — either (a) the attachment intake gets its own MCP tool + functional test in v2, OR (b) it remains prompt-only and the audit acknowledges this as DEAD-CODE-PRESERVED. Spec line silent.

### G-X.14 — Adversarial security tests are 2-strong; needs cluster review

`:396` covers the 4-pillar prompt-injection defense (read-only off-platform, no autonomous mutations from injected text, no secret disclosure, untrusted-input flagging). `:1522` covers create_group depth check. **NO test covers:**
- Secret-disclosure refusal at runtime (template L9-12)
- Magnetism-guard refusal under attack (e.g. user crafts confirmed_task_id ≠ task_id — actually IS covered in commit b39ed2c6 "refuse confirmed_task_id when not equal to task_id" but no `it()` matches the keyword)
- Off-topic-scope refusal at engine level (entirely template-only)

**Recommendation:** Add to Plan 2.3 a sub-task "adversarial test cluster — author 4-6 `it()` covering secret refusal, off-topic refusal, magnetism override under attack, attachment-injection refusal".

### G-Y.1 — see G-X.9 above (same root)

### G-Y.2 — Weekday guard is opt-in; agent must remember to pass `intended_weekday`

The guard fires only when the agent's MCP-tool call carries `intended_weekday`. If the agent forgets, no guard. Production: 0 `weekday_mismatch` rows in 60d despite 78 user weekday-input messages — meaning the agent is either always right (unlikely given Y.2's origin) OR rarely passing `intended_weekday`. Template L1188 instructs to pass it; effectiveness unverified.

**Recommendation:** Add observability invariant in A.3.6: log `intended_weekday` presence rate; alert if <50% of mutations on weekday-mentioning turns omit the parameter.

### G-Y.5 — see G-X.5 above

### G-Y.6 — Premature person registration on hierarchy boards is template-only defense

**Engine does NOT refuse a 3-field `register_person` call on a hierarchy board.** The defense is entirely in CLAUDE.md L398. v2 redesign of template (audit 15 G-15.1.1) could drop the line; engine fallback would silently misname child boards.

**Recommendation:** Move the protection from prompt to engine — `taskflow_admin({action:'register_person', ...})` should refuse `group_name`-omitted calls on hierarchy boards (HIERARCHY_LEVEL < MAX_DEPTH) with `error_code='requires_division_sigla'`. Add functional test to Plan 2.3.

### G-Y.7 — Off-topic-query token-burn defense is template-only

Same shape as G-Y.6: defense is one prompt line ("Do NOT query the database for off-topic requests"). v2 template rewrite could drop it. Engine has no scope-guard; the prompt is the only barrier against cost-explosion attacks (large attachment + off-topic query).

**Recommendation:** Either (a) add engine-level engage-pattern enforcement (intersect with v2's `engage_mode='pattern'` decision in spec Q2), or (b) functionally test the template includes the line, and add prompt-survival to A.3.6 invariants.

### G-Y.8 — auditor false-positives fix depends on the table the plan drops

Cross-reference with audit 13 AH.8 / AH.11. The 2026-04-13 silent-board incident *required* `send_message_log` to detect drift. Plan 2.3.m's drop-and-rewrite path eliminates the drift class structurally (v2 has a single `messages_out` ⨝ `delivered` persistence) — but the auditor test suite (134 cases) carries the OLD assumptions.

**Recommendation:** see audit 13 AH.8/AH.11/AH.13 deep-dives — same fix plan applies.

### G-Z.1 — v1 template "1200 lines" is wrong baseline (also wrong in spec L48 + L335)

Audit 15 already flagged this (G-15.1.1). Reality: 1316 lines. Audit 18 inherits the same gap. Fix is to correct spec quoting AND ensure the v2 redesign target is set against 1316 LOC, not 400.

---

## 4. Port-forward checklist (the v1 known-issue fixes that v2 architecture is still vulnerable to)

| Y / Z item | v1 fix lives in | v2 architecture vulnerability | Required port-forward |
|---|---|---|---|
| Y.1 (magnetism) | engine:850-1001 + `messagesDb`/`triggerTurnId`/`chatJid` injection | v2 deletes `agent_turn_messages`; guard cannot read prior bot turn | **Re-implement against `messages_out` ⨝ `delivered` ⨝ `messages_in`** OR drop with documentation. Spec needs explicit decision. |
| Y.2 (weekday opt-in) | engine:629 `checkIntendedWeekday()`; agent prompt L1188 | Same as v1 — opt-in, agent must pass parameter; v2 inherits same hole | **Add observability + consider make-mandatory** for any mutation on a weekday-mentioning turn. |
| Y.5 (delegated history) | engine `recordHistory(taskId, taskBoardId, ...)`; `it.todo` for rename/reopen | rename/reopen still write to wrong board | **Resolve `it.todo` before cutover.** |
| Y.6 (premature register) | template L398 ask-for-sigla protocol | template rewrite in v2 can drop the line | **Promote from prompt to engine** — refuse omitted `group_name` on hierarchy boards. |
| Y.7 (off-topic burn) | template L9 "Do NOT query the database for off-topic requests" | template rewrite in v2 can drop the line; v2's `engage_mode='pattern'` is adjacent but not equivalent | **Either engine-level engage enforcement or test that the prompt line survives template rewrite.** |
| Y.8 (auditor FPs) | `send_message_log` + drift detector + 8-signal interaction record | v2 drops `send_message_log`; drift class restructured | **Cross-reference audit 13 AH.8/AH.11/AH.13** — explicit auditor-rewrite acceptance criterion needed. |
| Z.2 (raw cadastrar) | template L398 (same as Y.6) | same as Y.6 | same as Y.6 |
| Z.4 (column grouping) | template L923 | template rewrite in v2 can drop | **Test the line survives** OR move to engine error message. |

---

## 5. Notes for Phase A.3.2 plan

The X/Y/Z trio surfaces a single architectural truth: **TaskFlow's defense-in-depth is overwhelmingly prompt-side, not engine-side.** Magnetism, weekday-mismatch, off-topic-burn, premature-register, secret-disclosure, column-grouping — all six are gated in CLAUDE.md, not in `taskflow-engine.ts`. The engine's defenses are only `find_person_in_organization` (Z.5), `cross_board_subtask_mode` (X.6), `merge_project` permission (X.7), and `intended_weekday` opt-in (Y.2 — opt-in, so partial).

This means **a v2 template rewrite is a defensive-posture rewrite**, not a documentation rewrite. Plan A.3.2 step 2.3.i ("CLAUDE.md.template ports — manual review") underestimates the security-posture surface.

**Action:** add to Plan a dedicated Phase A.3.2 sub-task "defensive-posture port-forward audit" that walks each of the 6 prompt-side defenses, decides per-defense whether to (a) preserve verbatim, (b) promote to engine, or (c) drop with risk-acceptance. Today the plan has none of these decisions enumerated.

---

## 6. Cross-cuts to other audit docs

| This audit's gap | Related audit doc | Cross-cut |
|---|---|---|
| G-X.9 / Y.1 magnetism | audit 13 AH.4, AH.5 | Both flag magnetism as silent in spec; this audit adds the *test-suite* dimension (18 `it()` for a feature with 0 prod hits). |
| G-X.11 / Y.8 auditor rewrite | audit 13 AH.8, AH.11, AH.13, AH.16 | Audit 13 flags 4 aspects of auditor rewrite scope; this audit adds the test-rewrite cost (134 `it()`) and `auditor-prompt.txt`'s 5 explicit `send_message_log` references. |
| G-X.13 attachment intake | audit 14 (entire doc) | Audit 14 confirms 0 prod rows + intake is prompt-only; this audit adds the test-side gap (template-string match only, 0 functional). |
| G-Z.1 / spec line 5 + 48 + 335 | audit 15 G-15.1.1, G-15.1.2 | Both note the wrong baseline (~400 LOC claim vs 1316 actual). This audit adds the deprecation-target dimension. |

---

## 7. Production-validation invariants for Phase A.3.6 (cutover dry-run)

For each gap above, the cutover dry-run (Plan A.3.6) should assert at least one runtime invariant. Recommended additions:

1. **Magnetism guard runtime check.** After cutover, `SELECT COUNT(*) FROM task_history WHERE action IN ('magnetism_shadow_flag','magnetism_override')` should be ≥0 (any value) AND the engine code path must execute without throwing on the new session-DB shape — verify by injecting a synthetic test message at cutover-day-1.
2. **Weekday opt-in coverage.** Sample 100 last-day mutations on weekday-mentioning turns; assert `intended_weekday` was passed in ≥X% (set X based on production observation; today X is unknown because opt-in usage is unobserved).
3. **Scope-guard refusal preserved.** Add a synthetic off-topic message to the cutover smoke; assert response matches `Fora do escopo|Sou assistente de gerenciamento`.
4. **`it.todo` resolved.** Before cutover branch merges, fail CI if `taskflow-engine.test.ts` contains `it.todo` strings.
5. **Auditor sub-suite green on v2 inputs.** All 134 auditor `it()` cases run against fixtures derived from `messages_out`+`delivered`+`messages_in`, NOT from `messages.db`+`send_message_log`+`agent_turn_messages`.
6. **Attachment intake decision recorded.** Either (a) `attachment_audit_log` schema preserved AND a v2 functional test exists, OR (b) audit explicitly notes "DEAD-CODE-PRESERVED" with operator sign-off.
7. **Template-line survival tests.** For each of the 6 prompt-side defenses (G-Y.6, G-Y.7, Z.2, Z.4 + secret-disclosure + magnetism-as-prompted), add a `tests/taskflow.test.ts` `expect(template).toContain(...)` assertion so the template rewrite cannot silently drop them.

These 7 invariants are NOT additive busywork — each is the only protection against a regression class that today is gated by either prompt-only defenses or by tests we'd have to manually grep for. Each one is small (≤20 LOC); together they close the gap between "tests pass" and "production behaviour preserved".
