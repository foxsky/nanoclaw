# v2 Cutover Exception List

**Purpose.** Every v1→v2 behavioral divergence surfaced by Phase 3 replay, ad-hoc testing, or static review must land here before cutover. The list is the operator's signoff artifact: if it's not in this file and explicitly accepted, it's not approved for cutover.

**Scope.** v2 behavior under the Taskflow skill. NOT migrate-v2.sh mechanics (those have their own checklist in `migration-dev.md`).

**Lifecycle.** Append-only during validation; entries move `proposed → accepted | blocked-on-fix | rejected`. On cutover day, every entry must be `accepted`, `rejected`, or have a `blocked-on-fix` resolved to `accepted`. No `proposed` entries at cutover.

---

## Cutover Gate Status

Track each item before flipping the service. Update as passes complete.

### Behavioral parity

| Board | Phase 3 corpus | Match-rate threshold | Last run | Pass? |
|-------|----------------|----------------------|----------|-------|
| seci-secti | 30 turns | 0 real divergences (match-rate informational) | **Corrected comparator (`4ab2c0d6`) 2026-05-29: 21/30, `0 real_divergence`** (5 state_drift, 2 tool-surface [EX-010], 1 destination-gap, 1 v1-bug). Clean modulo destination-gap + v1-bug signoff. Matchers in `0dec5540` confirmed non-intercepting (0/30 gate sweep). | ☐ |
| **SETD Secti** (= `thiago-taskflow`; Thiago runs this board) | 40 turns (`thiago-taskflow.json`) | ≥ 75% semantic match, 0 real divergences | **NOT A CLEAN PASS — parity is non-deterministic.** Codex run 2026-05-28: 14/40, 0 real div. **Independent Claude re-run (identical code `0dec5540`, same corpus+snapshot) 2026-05-28: 14/40 but 4 real divergences** (turns 3,13,14,26 — v2 reads/asks instead of mutating; Codex matched all 4). The "0" is one favorable sample, not stable. See EX-011. **NOTE: `thiago-taskflow` IS the SETD Secti board.** | ✗ |
| ~~setd-secti (11-turn `whatsapp-curated-setd-secti-v1.json`)~~ | — | — | **INVALID — discard.** Replayed against a reconstructed snapshot with no SETD board (board defaulted to seci, T18/tasks absent) → 3/11 + bogus "not found"/timeouts are wrong-board artifacts, NOT a v2 assessment. The real SETD board is the `thiago-taskflow` row above. | n/a |
| sec-secti | TBD turns | ≥ 75% (cross-board complexity) | — | ☐ |
| (Laizys/SEAF re-pass) | — | clean re-run after latest fixes | — | ☐ |

Thresholds are set *before* the run, not negotiated *after*. If a run misses threshold, treat it as a blocker — land fixes, re-run, do not slip the threshold to make the run pass.

> **⚠ Methodology caveat (Codex review 2026-05-28 + workflow adversarial-verify 2026-05-29) — applies to EVERY number in this table.** Two validity problems in the parity-measurement itself:
> 1. **The comparator's `task_ids` field was polluted by prose-parsed IDs — FIXED 2026-05-29 (`4ab2c0d6`, TDD).** `summarizeSemanticBehavior` merged IDs parsed from the confirmation *text* into `task_ids` (v1 parent breadcrumbs `📁 P6`; v2 `api_query` "N tarefas encontradas: …" listings), so `task_ids:[M20]->[M13,…6 ids]` never meant v2 touched 6 tasks — it mutated only M20. Fix: added `SemanticSummary.mutation_task_ids` (ids from MUTATION tool-args only / hand-authored expected) and, for `expected.action==='mutate'`, compare those **exactly**; reads/forwards keep the lenient logic. 87 phase3-support + 243 scripts tests pass, typecheck clean.
> 2. **Single-run numbers aren't stable** (SETD: independent re-run flipped turns vs a projected baseline). Treat every single-run row as provisional; **re-run ≥2–3× and report the range.**
>
> **Trustworthy numbers (corrected comparator, re-graded 2026-05-29 — no replay needed):**
> - **SECI: 21/30, `0 real_divergence`** (5 state_drift, 2 documented_tool_surface_change [EX-010], 1 destination_registration_gap, 1 v1_bug_flagged). The 23 was lenient inflation; the 17 was the reverted over-flag; **21 is the truth, and 0 real divergences** — SECI is clean modulo the destination-gap + v1-bug signoff.
> - **SETD/thiago-projected: 14/40, 0 real_divergence** — that run's v2 mutated correctly (a favorable sample).
> - **SETD/thiago-INDEP: 14/40, 4 real_divergence** (turns 3,13,14,26) — UNCHANGED by the fix; confirmed real, not artifacts (Codex gpt-5.5 re-ran + verified). Two failure shapes: **turns 3/14/26 are action-level** (v2 ran `read`/`api_query`, made *no* mutation call); **turn 13 is a wrong-target mutation** (v2 ran `api_task_add_note(P8)` vs expected `M26`+`T21`). Flip-rate across 3 fresh runs: 13/14/26 diverge 3/3, turn 3 diverges 2/3 — **observed instability (N=3), not proven systematic.** Enough to block a 0-real-divergence cutover claim; not enough to call "durable" — needs ≥2–3 more runs to characterize.
>
> **⚠ Residual comparator limitation (Codex gpt-5.5 review 2026-05-29 — NOT exercised by the 5 re-graded runs, but a latent false-positive source):** `mutation_task_ids` is built by scanning *all* string args of a mutation tool (`collectStrings`), so it still picks up **context ids that aren't the mutated target** — `api_admin.target_parent_id/source_project_id/target_project_id`, `api_hierarchy.parent_task_id`, `api_dependency.target_task_id`, and any task id mentioned in `api_task_add_note.text`. On a hierarchy/dependency/admin-move/note turn this could wrongly flag `real_divergence`. Also, in generated-corpus mode `expected_behavior.task_ids` is derived from user+reply text (not guaranteed the mutated set), so the expected side can carry the same pollution. **Follow-up fix ATTEMPTED + REVERTED 2026-05-29:** the obvious fix — extract only `task_id`/`confirmed_task_id` + an explicit `expected_behavior.mutation_task_ids` field — was implemented (TDD, green) but **regressed**: it flipped projected-baseline turn 26 (a `schedule_task` reminder, a true match) to a false `real_divergence`, because `schedule_task` (and `provision_*_board`) carry their target in `prompt`/`group_folder`, not `task_id` → the extractor returned `[]` while expected had `[M26]`. So neither `collectStrings` (over-broad) nor `task_id`-only (under-broad) is right; correct extraction is **tool-specific**, and for "schedule a reminder *about* M26" whether that even counts as a mutation *of* M26 is semantically ambiguous. Reverted to `4ab2c0d6`. **Real follow-up:** a tool-aware target-id map (per mutation tool, which field(s) name the mutated object) — not a single-field rule. The current `4ab2c0d6` collectStrings version is correct for the 5 captured runs; its over-broad risk remains latent (not active on any captured turn). Do not call it "complete."

### Operational readiness

| Item | Pass criteria | Done? |
|------|---------------|-------|
| End-to-end migration dry-run on prod snapshot | `migrate-v2.sh` runs cleanly against a copy of `.63` state; resulting v2 instance answers a real-message smoke test | ☐ |
| Container restart mid-conversation | Container killed at turn boundary recovers from session DB; no duplicate replies, no lost work | ☐ |
| Canary success metric | First N=50 real messages on prod-equivalent v2 produce no operator intervention AND ≥ 95% human-judged-correct | ☐ |
| Rollback runbook | Written + tested: stop v2, restart v1, reconcile taskflow.db divergence. Time-bound: rollback viable for ≤ 24h post-cutover; after that, divergence reconciliation is hand-work | ☐ |
| Regenerated board prompts / templates | Every board's CLAUDE.local.md regenerated from current taskflow template; per-board walks confirmed | ☐ |
| Idempotency: re-run migrate-v2.sh on a v2 install | No-op or surfaces what's already done; doesn't corrupt state | ☐ |

### v1-correction signoff

Every entry categorized `v1-bug-corrected` below must have an explicit operator initial in the Signoff column. Cutover blocks until all are signed.

---

## Categories

Each exception lands in exactly ONE category. If you can't pick one, the exception is malformed — refine it.

### `state-drift`
**Definition.** v2 reaches an equivalent end-state via a different path (different IDs, different intermediate rows). Operator sees the same outcome.
**Acceptance rule.** Deterministic across reruns. Does NOT change task assignment, due dates, or any operator-observable field. The drift is in IDs / timestamps / intermediate state only.
**Examples.** v1 created board IDs like `board-1748...` (timestamp-derived); v2 creates `board-<folder>`. End-state operator-visible: same tasks, same people, same columns.

### `v1-bug-corrected`
**Definition.** v1 had a bug; v2 deliberately does the right thing.
**Acceptance rule.** Explicit operator signoff per entry. Must include: (a) one-line description of the v1 bug, (b) why v2's behavior is correct, (c) whether any v1 data captured under the bug needs hand-migration.
**Examples.** v1 silently dropped messages from unregistered senders in some flows; v2 surfaces them via `unknown_sender_policy`. v1's date arithmetic was wrong in DST-spanning ranges; v2 uses the host TZ correctly.

### `accepted-tool-surface-change`
**Definition.** v1 MCP tool name or shape doesn't exist in v2 (e.g., `taskflow_create` → `api_create_task`; `taskflow_query` query shape changed).
**Acceptance rule.** v2's equivalent must cover ALL inputs v1's tool accepted (no parameter dropped without rationale). Operator-facing impact must be characterized: do downstream prompts / CLAUDE.md / skills reference the old name? Are they updated?
**Examples.** `taskflow_create` removed; `api_create_simple_task` + `api_create_task` + others split the surface. add-taskflow template updated.

### `missing-historical-snapshot`
**Definition.** Phase 3 replay can't compare because the DB snapshot at the turn's timestamp doesn't exist (corpus pre-dates snapshotting, or snapshot was pruned).
**Acceptance rule.** Tag and move on. Note in the entry whether the un-snapshotted turn is on a code path covered by *other* turns that DID snapshot — if so, transitive coverage. If not, treat as `command-shape-not-exercised`.
**Examples.** Turns before 2026-04 don't have taskflow.db snapshots; their behavior is unverified by replay.

### `command-shape-not-exercised`
**Definition.** A v2 command shape / code path that the corpus does not cover. Could be untested rare admin commands, edge cases (empty inputs, max-length inputs), multi-actor races, error paths.
**Acceptance rule.** Either (a) covered by a hand-run test before cutover, or (b) explicitly accepted as untested-but-low-risk with a one-line rationale (e.g., "admin command used <1×/month historically; manual recovery cheap").
**Examples.** `api_undo` with stacked undos; `api_admin` action types that don't appear in the SECI corpus.

---

## Schema

Each exception is a section. Stable IDs (don't renumber on insert).

```markdown
### EX-NNN: <short title>

- **Category:** <one of the 5>
- **Source:** <board>/<turn> | <ad-hoc test name> | <static review>
- **Surfaced:** YYYY-MM-DD
- **v1 behavior:** <what v1 did>
- **v2 behavior:** <what v2 does>
- **Operator-visible impact:** <none | <description>>
- **Rationale for acceptance:** <one paragraph>
- **Mitigation / followup:** <if any — e.g., "documented in skill X", "logged for v2.1">
- **Status:** proposed | accepted | blocked-on-fix | rejected
- **Signoff:** <initials + date when accepted; required for `v1-bug-corrected`>
```

---

## Example Entry

### EX-001: v2 omits silent message-drop for unknown senders

- **Category:** v1-bug-corrected
- **Source:** seci-secti / turn 25
- **Surfaced:** 2026-05-27
- **v1 behavior:** Messages from senders not in `registered_groups.sender_allowlist` were silently dropped in some flows (specifically the taskflow group routing) without logging or notification — operator only noticed when expected tasks didn't appear.
- **v2 behavior:** `messaging_groups.unknown_sender_policy` controls routing explicitly. `public` accepts all; `known` drops with log; `approval` triggers an owner approval flow.
- **Operator-visible impact:** Migration sets all messaging_groups to `public` initially (matches v1's effective behavior for most groups). Operator can tighten via Phase 1 access policy in /migrate-from-v1.
- **Rationale for acceptance:** v1's silent drop was a real incident vector (lost messages, no audit trail). v2's explicit policy is the right behavior; operator has migration-time choice over how strict.
- **Mitigation / followup:** /migrate-from-v1 Phase 1 walks the operator through choosing a policy per messaging group. Documented in SKILL.md.
- **Status:** accepted
- **Signoff:** MA 2026-05-27

---

## Entries

(Add new entries below as they surface. Keep them in surfacing order; don't sort.)

### EX-002: SECI turn 7 — task-set differs without a per-turn DB snapshot

- **Category:** missing-historical-snapshot
- **Source:** seci-secti / turn 7 — Codex Phase 3 comparator 2026-05-27 postfix run
- **Surfaced:** 2026-05-27
- **v1 behavior:** read action returned task set `[P15, P15.7]`.
- **v2 behavior:** read action returned task set `[P15.7]`.
- **Operator-visible impact:** v2 omits P15 from the listing. Cannot determine from replay alone whether v1 had P15 active at that timestamp or whether v2 dropped it incorrectly — the comparator explicitly flags "no restored per-turn DB snapshot to disambiguate."
- **Rationale for acceptance:** Both versions performed `read`, same outbound intent (informational), same recipient. Without a snapshot to restore the historical board state, the diff is a corpus-coverage artifact, not a v2 behavior regression. If/when a snapshot becomes available, re-run and re-evaluate.
- **Mitigation / followup:** If SECI re-snapshot to that timestamp becomes available, re-run turn 7 alone. If still diverges with snapshot, escalate.
- **Status:** proposed
- **Signoff:**

### EX-003: SECI turn 11 — task ID sequence allocation drift

- **Category:** state-drift
- **Source:** seci-secti / turn 11 — Codex Phase 3 comparator 2026-05-27 postfix run
- **Surfaced:** 2026-05-27
- **v1 behavior:** create+admin sequence allocated task ID `P11.22`.
- **v2 behavior:** same create+admin sequence allocated task ID `P11.26`.
- **Operator-visible impact:** Different ID number on the new task. The task is created with the same content, same assignee, same column. Operator sees a different number in chat confirmations.
- **Rationale for acceptance:** Comparator: "task IDs differ only because v2 allocated the next free sequence number." Deterministic given current taskflow.db state. End-state equivalent (same task content, same parent). The drift is purely in ID allocation, which is a function of taskflow.db's row count at replay time — not a v2 behavior change.
- **Mitigation / followup:** None. If we restore a per-turn DB snapshot, the allocated IDs would match v1 exactly.
- **Status:** proposed
- **Signoff:**

### EX-004: SECI turn 13 — extra task in v2 read set, no snapshot

- **Category:** missing-historical-snapshot
- **Source:** seci-secti / turn 13 — Codex Phase 3 comparator 2026-05-27 postfix run
- **Surfaced:** 2026-05-27
- **v1 behavior:** read returned `[P20, P20.1, P22]`.
- **v2 behavior:** read returned `[P20, P20.1, P22, P22.2]`.
- **Operator-visible impact:** v2 listing includes an extra row P22.2 that v1's listing did not.
- **Rationale for acceptance:** Comparator flags as "differs without a restored per-turn DB snapshot." The extra row likely reflects later state in the synced DB (P22.2 created after the turn 13 timestamp in v1's history). Both versions executed `read` with same outbound intent.
- **Mitigation / followup:** Restore per-turn snapshot to disambiguate, OR re-run from a clean DB seeded to the turn 13 timestamp.
- **Status:** proposed
- **Signoff:**

### EX-005: SECI turn 14 — v2 no-op when DB already in target state

- **Category:** state-drift
- **Source:** seci-secti / turn 14 — Codex Phase 3 comparator 2026-05-27 postfix run
- **Surfaced:** 2026-05-27
- **v1 behavior:** mutate action — moved P11.16 to a target column.
- **v2 behavior:** read action — returned P11.16's current state (no mutation issued).
- **Operator-visible impact:** v2 informs the user of P11.16's current state instead of issuing a redundant move. v1 would have issued the move and reported "moved" even though the target state already matched.
- **Rationale for acceptance:** The synced taskflow.db already reflects v1's historical move (because we replayed against current state, not the timestamp-restored state). v2 correctly detects "no change needed" and returns informational. This is a replay artifact, not a behavioral divergence — under real-time operation, v2 would issue the move when the column actually differs.
- **Mitigation / followup:** Confirm with per-turn snapshot replay that v2 issues the move when the DB column doesn't already match. If snapshot replay also shows no-op when source != target, escalate.
- **Status:** proposed
- **Signoff:**

### EX-006: SECI turn 18 — api_hierarchy refresh_rollup confirmation restored

- **Category:** accepted-tool-surface-change
- **Source:** seci-secti / turn 18 — Codex Phase 3 comparator 2026-05-27 post-hierarchy run
- **Surfaced:** 2026-05-27
- **v1 behavior:** mutate action — api_hierarchy refresh_rollup on P11.19 — produced user-visible reply.
- **v2 behavior:** `api_hierarchy({ action: "refresh_rollup" })` executes, emits a deterministic rollup confirmation, and suppresses duplicate model echoes.
- **Operator-visible impact:** Restored v1-observable confirmation for rollup refresh commands. The exact wording comes from v2's typed rollup result; no silent mutation remains.
- **Rationale for acceptance:** Fix landed in `7e225b53`. Single-turn replay confirmed 1/1 match with one outbound row; full SECI Phase 3 post-hierarchy run confirmed turn 18 as `match` and removed the previous `no_outbound_timeout` classification.
- **Mitigation / followup:** None for SECI. Re-watch hierarchy refresh_rollup on SETD/SEC board passes because child-board rollup wording may vary by board state.
- **Status:** accepted
- **Signoff:** Codex evidence 2026-05-27

### EX-007: SECI turn 19 — v2 no-op when DB already in target state

- **Category:** state-drift
- **Source:** seci-secti / turn 19 — Codex Phase 3 comparator 2026-05-27 postfix run
- **Surfaced:** 2026-05-27
- **v1 behavior:** mutate — moved tasks P20.2, P20.5.
- **v2 behavior:** read — returned P20.2's current state.
- **Operator-visible impact:** Same pattern as EX-005 — v2 detects target state already matches, doesn't issue the move.
- **Rationale for acceptance:** Same reasoning as EX-005 — replay artifact, not behavior divergence.
- **Mitigation / followup:** Same as EX-005.
- **Status:** proposed
- **Signoff:**

### EX-008: SECI turn 20 — large task-set drift, no snapshot

- **Category:** missing-historical-snapshot
- **Source:** seci-secti / turn 20 — Codex Phase 3 comparator 2026-05-27 postfix run
- **Surfaced:** 2026-05-27
- **v1 behavior:** read returned 16-task list including P11.15, P11.17, P11.19, P11.3, T88 (among others).
- **v2 behavior:** read returned 14-task list including P11.24, P11.25, T90 (among others) — overlapping but with several distinct IDs.
- **Operator-visible impact:** Listings differ by ~5 task IDs in each direction.
- **Rationale for acceptance:** Comparator flags as snapshot-required to disambiguate. v1's set reflects state at the turn timestamp; v2's set reflects current synced state. Several v2-only IDs (P11.24, P11.25, T90) are higher-numbered than v1's list — consistent with tasks created after the turn 20 timestamp in v1's history.
- **Mitigation / followup:** Restore per-turn snapshot OR accept as state-drift artifact. Don't escalate without snapshot evidence.
- **Status:** proposed
- **Signoff:**

### EX-009: SECI turn 28 — v1-flagged bug on M1/M2/P11 update

- **Category:** v1-bug-corrected
- **Source:** seci-secti / turn 28 — Codex Phase 3 comparator 2026-05-27 postfix run
- **Surfaced:** 2026-05-27
- **v1 behavior:** update mutation on tasks `[M1, M2, P11]` — corpus auditor flagged this turn as v1 bug (P11 unintended inclusion).
- **v2 behavior:** update mutation on tasks `[M1, M2]` — P11 not included.
- **Operator-visible impact:** v2 correctly limits the update to the two intended tasks (M1, M2). v1 included a third (P11) that the user did not intend.
- **Rationale for acceptance:** Corpus annotation explicitly flags this as v1 mistake. v2's narrower scope is the correct behavior. Requires operator signoff per the v1-bug-corrected category rule.
- **Mitigation / followup:** Verify with the operator that P11 inclusion in turn 28 was unintended in v1. If confirmed, accept v2's behavior. If turn 28 was intentional in v1 (auditor mis-annotation), escalate — v2 may be missing a third task.
- **Status:** proposed
- **Signoff:** _(awaiting operator confirmation)_

### EX-010: Raw sqlite tool surface removed (turns 15, 17, 23)

- **Category:** accepted-tool-surface-change
- **Source:** seci-secti / turns 15, 17, 23 — Codex Phase 3 comparator raw-sqlite parity decisions
- **Surfaced:** 2026-05-27
- **v1 behavior:** Agent issued `mcp__sqlite__read_query` (turns 15, 17) and `mcp__sqlite__write_query` + `read_query` (turn 23) for direct DB inspection / mutation.
- **v2 behavior:** Raw sqlite MCP tools blocked. Equivalent operations available via `api_*` MCP tools (api_query, api_admin, api_create_*, api_update_*, api_reassign, etc.).
- **Operator-visible impact:** Agent no longer issues raw SQL. All mutations go through typed API surface with explicit confirmation, validation, and notification side-effects. Read queries go through `api_query` which returns structured results.
- **Rationale for acceptance:** Comparator: "Covered by first-class api_* / MCP equivalent; keep raw sqlite blocked." Raw sqlite was an escape hatch in v1 that bypassed v2's notification/destination model. v2's typed surface is correct.
- **Mitigation / followup:** Per-board CLAUDE.local.md regenerated to remove raw-sqlite tool references. Verify on cutover day that no per-board prompt still instructs the agent to use raw sqlite.
- **Status:** proposed
- **Signoff:**

### EX-011: SETD Secti board (`thiago-taskflow`) pass — 26 non-direct-match turns, 0 real divergences

- **Category:** state-drift (rollup; see sub-buckets)
- **Note:** `thiago-taskflow` IS the SETD Secti board (Thiago runs it) — this is the SETD parity pass, not a separate board.
- **Source:** thiago-taskflow / 40-turn Phase 3 pass (the real SETD Secti corpus) — comparator `phase3-compare-thiago-setd-20260528-projected-after-turn15-27`, per-turn classifications committed in `scripts/phase3-thiago-metadata.json` (`0dec5540`)
- **Surfaced:** 2026-05-28
- **v1 behavior:** 40 historical production turns on Thiago's cross-board scope.
- **v2 behavior:** 14/40 direct semantic matches; the remaining 26 classified as: 16 `state-drift` (synced May-16 DB already reflects later corrections, or different intermediate IDs), 4 `v1-bug-flagged` (see below — require signoff), 4 `no-v1-observable` (turns 28/29/31/32 — v1 produced no comparable observable), 1 `missing-context` (turn 21 "E Laizys?" depends on a prior bot prompt absent from the replay window), 1 `state-allocation-drift` (turn 9). **0 `real_divergence`.**
- **Operator-visible impact:** None for the state-drift / no-v1-observable / missing-context buckets — these are replay-snapshot artifacts, not behavior changes. The 4 v1-bug turns DO change behavior vs v1 and need signoff.
- **Rationale for acceptance:** Same falsification standard as the SECI pass: each non-match turn carries a category with evidence in the metadata file, and none is a v2 regression. The 14/40 direct-match rate is low because the May-16 synced DB has drifted far from the historical per-turn states (most turns are reads against a moved-on board), not because v2 misbehaves.
- **v1-bug turns requiring signoff (per `v1-bug-corrected` rule) — verified 2026-05-28 against the thiago corpus messages + v1 replies:**
  - **Turn 2** (`"Próxima ação: Enviar mensagem para Alyne aprovar a visualização dos recursos de multa no SEI"`) — v1 applied it to `P6` and restored a deadline (unrelated); v2 targets `T56`, whose title *is* that next-action. **v2 appears correct (right task); v1 mis-targeted.** Operator confirm which task owns this next-action.
  - **Turn 7** (`"Prazo até 24/04."` — bare date, no task id) — v1 guessed `P6` ("Prazo alterado de 30/04 para 24/04"); v2 **asks** which task instead of guessing. **Behavior change, not clearly a bug-fix:** v2 is safer (no guess) but loses v1's conversational context-resolution. Judgment call — note the interplay with turn 19 below.
  - **Turn 15** (`"Na sexta, faremos a migração dos Novos Sites"`) — v1 wrote the note dated Friday `16/05/2026` (**wrong — 16/05 was a Saturday; the Friday was 15/05**); v2 writes `15/05/2026` (the `0dec5540` fix). **Clear v1-bug-corrected.** Confirm v1's secondary `T21` 15/05 reminder isn't silently dropped by v2.
  - **Turn 19** (`"P6 é pra manter dia 30/04"`) — v1 replied `"Não entendi a referência"` (failed to parse an explicit task-id + date); v2 correctly updates `P6` to keep 30/04. **Clear v1-bug-corrected.**
- **Status:** BLOCKED (see non-determinism warning below); 4 v1-bug turns also `blocked-on-fix` pending operator signoff
- **Signoff:** ☐ turn 2 · ☐ turn 7 · ☐ turn 15 · ☐ turn 19

> **⚠ BLOCKER — non-deterministic parity (independent re-run, 2026-05-28).** An independent Claude replay of the *identical* code (`0dec5540`), same corpus + prod snapshot, did NOT reproduce Codex's 0 real divergences. It surfaced **4 real divergences** where v2 read/listed/asked instead of performing v1's mutation:
> - **Turn 3** ("alterar o horário para as 11 horas", SEMEC mtg): v1 rescheduled M20; v2 ran 3 `api_query` and listed 5 tasks — no reschedule.
> - **Turn 13** ("lançamento 25/05, enviar ofício circular e notícia"): v1 noted M26 + created T21; v2 added the note to **P8** (wrong task) and created nothing.
> - **Turn 14** ("Reunião SDU Sul remarcada terça 9h"): v1 rescheduled M22; v2 listed 3 tasks — no reschedule.
> - **Turn 26** ("Mande mensagem aos participantes 30min antes"): v1 scheduled the reminder; v2 asked which meeting.
>
> Codex's run matched all four. **Flip-rate measured across 3 independent runs (2026-05-28):**
> - **Turn 13: 0/3 match** — stable divergence (v2 notes wrong task P8 instead of M26+T21).
> - **Turn 14: 0/3 match** — stable divergence (v2 *finds* M22 in its list but reports instead of rescheduling — a report-vs-mutate behavior choice, not a lookup failure).
> - **Turn 26: 0/3 match** — stable, but **defensible** (v2 asks which of 2 candidate meetings; v1 picked M26).
> - **Turn 3: 1/3 match** — genuinely flaky (true non-determinism).
>
> Conclusion (revised after Codex gpt-5.5/high review, 2026-05-28): turns 13/14 show **repeated** report-instead-of-mutate divergence across all 3 of my runs — call it **observed instability, not "proven systematic"** (N=3 is small). The board scope was correct (INDEP turn 0 resolved M20 minutes → it ran on `board-thiago-taskflow` via the corpus per-turn `taskflow_board_id`, not the seci default), so these are **real-board** divergences, not wrong-board artifacts. **Three caveats Codex raised that I accept:**
> 1. **Codex's "0" was a PROJECTED baseline** (`…projected-after-turn15-27`), not a clean independent replay — so "Codex 0 vs Claude 4" is partly apples-to-oranges.
> 2. **The comparator is coarse** (see Methodology caveat in Cutover Gate Status). It marked the projected turn 3 `match` with `task_ids: [M20] -> [M13,M18,M20,P6,T76,T99] [ok]` — accepting a 6-task actual against a 1-task expected. Both my divergence counts and the projected "0" rest on a comparator that does NOT enforce exact task-set parity.
> 3. **Fix options (not "only one"):** prompt-strengthening in the add-taskflow template **OR** a narrow engine helper that resolves a *uniquely* visible meeting by title tokens + explicit weekday/time then calls the normal update. Both carry turn-shaped-NLU / over-mutation risk; choosing prompt-only is a **conscious risk acceptance**, not a lack of alternatives.
> 4. **Prompt-strengthen ATTEMPTED + VERIFIED INEFFECTIVE (2026-05-29, `4c5550eb`).** Added a "resolve-then-act on a unique match, list-and-stop is the failure" block to the template, ported it into the replay board prompt (confirmed loaded), and re-ran turns 3/13/14/26 ×2. Result: **13/14/26 still diverged (0–1/4 match), identical to baseline.** On turn 14 the agent read the new guidance, ran a generic `api_query(search)` (not the recommended `upcoming_meetings`), got M22+2 other tasks, and **listed-and-stopped anyway.** Conclusion: the prompt nudge does NOT fix this — the agent's report-vs-mutate choice on name-referenced meetings is not reliably steerable by board-prompt guidance. **Remaining realistic paths: (a) accept bounded non-determinism + canary/monitor, or (b) a deterministic resolve-and-mutate engine intercept (real work, turn-shaped-NLU risk). Prompt-tuning is not the answer.** The added template guidance is harmless and kept (reasonable on other phrasings) but is NOT a fix.
>
> 5. **Build fix — `api_reschedule_meeting` tool — VERIFIED EFFECTIVE on its target case (2026-05-29, `35674eb0`/`e862cbdc`).** Since prompt-tuning failed, shipped a purpose tool that resolves a meeting by name (scoped to `type='meeting'` AND board-local — both matter; e.g. the same-keyword tasks T102/T114 are on `board-sec-taskflow` while the meeting M22 is on `board-thiago-taskflow`) and reschedules the unique match. Re-ran turns 3/13/14/26 ×2 with the tool + a CLAUDE.md pointer:
> - **Turn 14 (reschedule-by-name): FIXED.** Agent SELECTED `api_reschedule_meeting`, it resolved "SDU Sul"→M22 uniquely, and rescheduled correctly — outbound `✅ M22 reagendada terça 05/05 09:00` = v1. **Tool-selection is a stronger lever than the prose that failed.** (The comparator still scores it `real_divergence` because `api_reschedule_meeting` isn't in its mutation patterns AND the tool capture stores only name+input, so the resolved M22 lives only in the confirmation prose — a measurement gap, not a v2 failure. Verified by reading the outbound.)
> - **Turn 3 (SEMEC reschedule): state-drift, correct decline.** All SEMEC meetings (M13/M18/M20) are `column='done'` in the May-16 snapshot; v2 rightly returned "não encontrei" rather than reschedule a done meeting. v1 rescheduled M20 historically when it was live. Not a tool/v2 bug.
> - **Turns 13 (note→wrong task) & 26 (reminder): out of this tool's scope** — still diverge; would need analogous name-resolving note/reminder tools (follow-on).
>
> **Follow-on build (2026-05-29, `47346575`/`cafbde83`): `api_note_meeting` shipped; turn 26 NOT built.**
> - **`api_note_meeting`** (note-on-meeting-by-name, scoped to meetings) is built + unit-tested (notes M26, not the same-named project P8) + has a CLAUDE.md pointer. **BUT verification (turns 13/14 ×2) shows the agent does NOT select it on turn 13** — both passes it used the generic `api_task_add_note` and noted **P8** again (identical to baseline). Tool-selection is reliable only when the purpose tool is the *obvious unique match* (reschedule/turn 14 = 4/4 across runs); on turn 13 the agent's habit (it already has "Novos Sites"→P8 in context, `api_task_add_note` is the familiar path) wins even with the pointer. **So turn 13 is NOT fixed in practice** — the tool is correct + available (may help on clearer note-on-meeting phrasings) but the LLM doesn't reach for it here. Steering `api_task_add_note` away from meetings would be prompt-steering (verified weak); a deterministic intercept is the only lever that would force it.
> - **Turn 26 (reminder) NOT built** — correction (Codex gpt-5.5/xhigh review): it IS buildable. The engine's *reminder field* is day-granular, but v2's `schedule_task` tool **is minute-granular** (ISO local timestamps), so a reminder tool could wrap `schedule_task` + meeting-participant resolution. Not built because turn 26's replay sees **two** meetings tomorrow → v2 asking "which one?" is **defensible** (genuine ambiguity), and it's diminishing returns. → **accept-bounded** (for the ambiguity reason, NOT impossibility). v1 used a separate scheduler ("Kipp"; empty `tool_uses`).
>
> **Net SETD behavior status:** turn 14 (reschedule-by-name) FIXED + reliable; turn 3 state-drift; turns 13 + 26 remain (note-selection unreliable / reminder out-of-scope) → **accept-bounded for 13 & 26**, monitored at cutover. The tool-selection lever has a clear boundary: it fixes the obvious-unique-match case, not cases where a generic tool + a known id offer an easier path.
>
> **Net: the addressable SETD reschedule-by-name divergence is fixed (ground-truth verified); the rest is state-drift or out-of-scope.** Follow-ups: (a) teach the comparator about `api_reschedule_meeting` + capture tool *results* in phase2-driver so name-resolving mutations auto-score (the only reason turn 14 still shows red); (b) optionally analogous tools for note/reminder-by-name (turns 13/26).
>
> **SETD 0-real-divergence bar:** the raw INDEP run was 14/40 with 4 real_divergence; turn 14 is now demonstrably fixed and turn 3 is state-drift, so the genuine open behavior gaps narrow to turns 13/26 (note/reminder by name). **Decision pending operator** on whether to build those too or accept-bounded. Artifacts: `/tmp/phase3-thiago-TOOL{1,2}-20260529.json`.

---

## v2 code-quality findings (not v1 divergences — post-cutover follow-ups)

Surfaced by the 2026-05-28 independent review of `0dec5540` (three reviewers + Codex authorship). These are NOT v1→v2 behavioral divergences — they don't fit the five categories — but recording them here keeps the signoff artifact honest. None blocks cutover on the current Fortaleza-TZ host; each needs a tracked follow-up.

- **FU-1 — org-meeting display TZ bug.** `formatTaskflowOrgMeetingDraftPrompt` / `handleTaskflowOrgMeetingCreateForwardConfirmation` format the user-facing meeting time from the un-normalized naive-local `scheduledAt` through hard-coded GMT-3 formatters. The engine stores the correct UTC value, but the displayed/forwarded hour is off by 3h under `TZ=UTC`. **Masked on this host (America/Fortaleza)** → no cutover impact for `.63`, but wrong for any other-zone deployment and unguarded by tests. Follow-up: format from the UTC-normalized value via the tz-aware helper; add a `TZ=UTC` display assertion.
- **FU-2 — sector-placement hint swallows a trailing shared-role word.** `BOARD_PERSON_PLACEMENT_RE` (with the `i` flag) captures a trailing "também" into the board hint ("SM-SETD-SECTI também"), so a trailing shared-role signal breaks board resolution. The shared-role bypass works only when the signal is separated (e.g. after a comma — covered by the new test). Follow-up: anchor the hint capture to stop before shared-role tokens.
- **FU-3 — `find_person_in_organization` dropped its SQL LIKE prefilter.** Now loads the full org `board_people` set per call and filters in JS. Fine at current (~31-board) scale; revisit if the org tree grows. Also removed a load-bearing LIKE-escaping comment (moot under literal `.includes`, but the row-count bound is gone).

---

## Cutover-Day Checklist

Before flipping the service:

1. **All gate items in `Cutover Gate Status` checked.**
2. **No `proposed` entries below.** Every entry is `accepted`, `rejected`, or has a resolved `blocked-on-fix`.
3. **Every `v1-bug-corrected` entry has a Signoff line.**
4. **Rollback runbook smoke-tested within 7 days.**
5. **Canary plan agreed: first N messages, success criteria, who watches, what triggers rollback.**
6. **Operator (user) does a final pass-through of the entire file and confirms.**

If any of these fails, the cutover is not approved.
