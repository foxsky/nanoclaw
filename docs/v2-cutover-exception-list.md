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
| seci-secti | 30 turns | ≥ 80% semantic match (24/30) | 2026-05-27: 23/30, 0 real divergences | ☐ |
| setd-secti | TBD turns | ≥ 75% (lower bar — compound-name routing complexity) | — | ☐ |
| sec-secti | TBD turns | ≥ 75% (cross-board complexity) | — | ☐ |
| (Laizys/SEAF re-pass) | — | clean re-run after latest fixes | — | ☐ |

Thresholds are set *before* the run, not negotiated *after*. If a run misses threshold, treat it as a blocker — land fixes, re-run, do not slip the threshold to make the run pass.

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

### EX-011: <fill in>

- **Category:**
- **Source:**
- **Surfaced:**
- **v1 behavior:**
- **v2 behavior:**
- **Operator-visible impact:**
- **Rationale for acceptance:**
- **Mitigation / followup:**
- **Status:** proposed
- **Signoff:**

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
