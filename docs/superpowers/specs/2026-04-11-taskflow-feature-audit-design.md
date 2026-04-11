# TaskFlow Feature Audit & Documentation Sync

**Date:** 2026-04-11
**Revision:** v2 (after two-reviewer pass)
**Status:** Design
**Type:** Documentation + research (no code changes)

## Problem

TaskFlow has grown by ~37 design/implementation plans across 10 weeks (2026-02-24 → 2026-04-11). User-facing docs (`taskflow-user-manual.md`, `taskflow-operator-guide.md`, `taskflow-quick-start.md`, `taskflow-meetings-reference.md`), the skill-facing `SKILL.md`, the agent behavior prompt `templates/CLAUDE.md.template`, and both changelogs have drifted. It is unclear which features are:

1. **Designed but never shipped** (plans without landed code)
2. **Shipped but undocumented** (commits without doc updates)
3. **Documented but not working in production** (docs describing broken/removed features)
4. **Shipped but dormant** (code exists, zero production usage in the last 30 days)
5. **Working in production** (evidence in real WhatsApp interactions and taskflow DB on `.63`)

Without a single source of truth, each doc edit risks contradicting another. A first-pass v1 of this spec was rejected after two independent reviewers found that its example SQL queries referenced columns and actions that don't exist in production, that its prod-safety claim was aspirational rather than enforced, and that it silently ignored several sources of documentation drift (per-group doc copies, per-group `CLAUDE.md` snapshots). v2 fixes those and tightens methodology.

## Goals

1. Produce a **feature matrix** that classifies every user-visible TaskFlow feature against four axes: designed, shipped, validated in prod, documented.
2. Use the matrix to drive **targeted doc edits** — one edit corresponds to one matrix cell marked `docs-stale`, `shipped-undocumented`, or `docs-describe-missing`.
3. Preserve the matrix as a reusable artifact at `docs/taskflow-feature-matrix.md`, with reproducibility anchors so a future audit can re-run deterministically.
4. **Do not touch implementation code.** This is research + docs only. Any code bug found is logged as a note in the matrix and reported back, not fixed in this pass.
5. Report (but do not fix) drift between the authoritative `CLAUDE.md.template` and each provisioned group's `groups/<name>/CLAUDE.md`.
6. Report (but do not fix) drift between authoritative `docs/taskflow-*.md` and the per-group copies at `groups/<name>/taskflow-*.md`.

## Non-goals

- Writing new features.
- Refactoring or simplifying engine code.
- Deploying to production or modifying production DBs.
- Editing per-group copies under `groups/<name>/` (they get a drift report, not a sync).
- Covering non-TaskFlow skills except where they intersect TaskFlow behavior.
- Translating docs (user manual is Portuguese; specs/plans are English).

## Canonical source declaration

Multiple file-system locations contain near-duplicate copies. To make the audit deterministic, this spec declares canonical sources. Anything not listed as canonical is read-only for this audit (drift-report only).

| Artifact | Canonical location | Non-canonical siblings (drift report only) |
|---|---|---|
| User manual | `docs/taskflow-user-manual.md` | `groups/{sec-secti,seci-taskflow,secti-taskflow,tec-taskflow}/taskflow-user-manual.md` |
| Quick start | `docs/taskflow-quick-start.md` | `groups/{sec-secti,seci-taskflow,secti-taskflow,tec-taskflow}/taskflow-quick-start.md` |
| Operator guide | `docs/taskflow-operator-guide.md` | (none) |
| Meetings reference | `docs/taskflow-meetings-reference.md` | (none) |
| Agent behavior prompt | `.claude/skills/add-taskflow/templates/CLAUDE.md.template` | 20+ `groups/<name>/CLAUDE.md` snapshots |
| Skill description | `.claude/skills/add-taskflow/SKILL.md` | (none) |
| Skill changelog | `.claude/skills/add-taskflow/CHANGELOG.md` | (none) |
| Project changelog | `CHANGELOG.md` | (none) |
| Auditor prompt | `container/agent-runner/src/auditor-prompt.txt` | (not a doc — read for feature enumeration only) |

**Justification:** the per-group copies are frozen snapshots taken at provisioning time. They cannot be reconciled to a single current-truth without either re-provisioning every group (out of scope) or deciding per-group whether local edits must be preserved. The audit produces a drift report so that decision can be made later with data in hand.

## Split of responsibilities: dev vs. prod

| Role | Machine | Path | Allowed ops |
|---|---|---|---|
| Source of truth for code, plans, docs | dev (`/root/nanoclaw`) | this repo | read + write + commit |
| Source of truth for usage/interactions | prod (`nanoclaw@192.168.2.63`) | `/home/nanoclaw/nanoclaw` | **read-only** via SSH |

**Mechanical prod-safety gate (not a statement of intent):**

1. Every SSH command that touches the DB MUST invoke `sqlite3` with `-readonly -bail` flags. Any other shape is rejected before dispatch.
2. The main agent must pre-assemble every SQL probe as a string, then run the string through a regex match: `^sqlite3 -readonly\b`. Probes that fail the regex never run.
3. Prod DB path is pinned to `/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`. Phase 0 verifies it is non-empty via `[ -s <path> ] && sqlite3 -readonly <path> 'SELECT COUNT(*) FROM tasks'`. The two 0-byte siblings (`data/taskflow.db`, `data/taskflow/data/taskflow.db`) are explicitly listed as traps in the Phase 0 check so a future audit cannot accidentally target them.
4. Prod is in WAL mode, so readers do not block the live writer, but consistency is still best-effort. Every SQL result is stamped with the `taskflow.db` mtime at query time so re-runs can diff against the same snapshot.
5. No `rsync`, `scp`, file-edit, service-restart, or any non-`sqlite3` command is issued against prod in the course of the audit. Phase 0 lists the literal set of allowed SSH commands; anything outside that set is a methodology violation.

## Feature matrix format

**File:** `docs/taskflow-feature-matrix.md`

Grouped by capability area. Each row represents one user-visible feature and has a stable row ID of the form `R001`–`R999`, assigned in Phase 3 and never reused.

### Capability areas

- **Tasks** — create, edit, assign, move column, due dates, cancel, reparent, subtasks
- **Recurrence** — bounded recurrence, non-business-day rounding, skip holidays
- **Meetings** — notes, external participants, cross-board visibility, scheduling
- **Auditor** — daily auditor, DM detection, suggestion generation, stalled-task surfacing
- **Cross-board** — hierarchical delegation (`child_exec`), cross-board rollup, cross-board assignee guard, cross-board subtask Phase 1
- **Digest & standup** — morning standup, evening digest, compact board digest, weekly review
- **Media & attachments** — image vision, PDF reader, voice transcription, attachment audit log
- **Embeddings & search** — semantic search over tasks, duplicate detection
- **External participants** — contact management, invitation, meeting inclusion
- **Admin & config** — board provisioning, per-board config, board holidays, admin list, short codes

### Granularity rule (concrete, not hand-waved)

One matrix row per **user-observable verb or configuration knob**. A verb is distinct if at least ONE of the following is true:

- It has its own handler function in `taskflow-engine.ts` (separately named, not a branch inside another handler).
- It has its own MCP tool name.
- It has its own `task_history.action` value.
- It has its own dedicated instruction block in `CLAUDE.md.template`.
- It is triggered by a distinct user-visible phrase in `auditor-prompt.txt` or operator-facing output.

Sub-variants collapse into the parent row when all of these apply: same handler (<5 lines of branching), same `task_history.action` value, same user phrase. Example: "move to in-progress" and "move to done" are one row because they share the `moveTask` handler and write `moved` to history. Example counterexample: "due date with explicit date" vs "due date with business-day rounding" are two rows because business-day rounding has its own logic even though both update `tasks.due_date`.

Row count estimation is performed at the Phase 1 → Phase 2 handoff, after all three subagents have returned. If the estimate exceeds 80, the main agent must stop and either split the matrix by capability area (into `docs/taskflow-feature-matrix/{area}.md` with an index at `docs/taskflow-feature-matrix.md`) or tighten the granularity rule and re-estimate. The split decision happens BEFORE SQL probes are authored so Phase 2 doesn't have to be redone.

### Columns

| Column | Meaning | Example |
|---|---|---|
| ID | Stable row ID | `R037` |
| Feature | Short imperative name | "Reparent task across boards" |
| Area | One of the 10 areas above | "Cross-board" |
| Designed | Plan file(s) or `ad-hoc` | `docs/superpowers/plans/2026-03-27-reparent-task.md` |
| Shipped | `file.ts:NNN` pointer or `❌` | `taskflow-engine.ts:6163` |
| Prod evidence | Triple `{total; last_30d; last_at}` from pinned SQL or `❌ unused` | `{17; 4; 2026-04-02}` |
| Outcome signal | Secondary metric proving the feature *worked*, not just *ran* | `14 of 17 reparented tasks still present after 24h` |
| Docs present | 8-char bitmap over docs | `S.U..M.C` |
| Docs expected | 8-char bitmap over docs where this feature SHOULD appear | `SCUOQ.TC` |
| Status | One of the six statuses below | `shipped-undocumented` |
| Notes | Free-form, max 1 sentence | "Only sec-taskflow uses it; no failures in history" |

**Docs bitmap columns (in order):** `S` = SKILL.md, `C1` = skill CHANGELOG, `U` = user-manual, `O` = operator-guide, `Q` = quick-start, `M` = meetings-reference, `T` = CLAUDE.md.template, `C2` = project CHANGELOG. Dot = absent, letter = present.

**`Docs expected` derivation rule (not subjective):** the expected bitmap is computed from the feature's area:

- All features: `C1` (skill CHANGELOG if newly added in the audit window) and `C2` (project CHANGELOG if user-facing).
- All user-visible features: `U` (user-manual) + `T` (CLAUDE.md.template if the agent invokes the feature).
- Top-20 workflows by prod usage count: also `Q` (quick-start).
- Meetings area features: also `M` (meetings-reference).
- Admin/Config area features: also `O` (operator-guide).
- Anything the skill install surfaces: also `S` (SKILL.md).

The actionable set for Phase 4 is `Docs expected & ~Docs present` per row.

### Status values (6, up from v1's 5)

- `in-sync` — designed, shipped, validated, and `Docs present == Docs expected`. No action.
- `docs-stale` — shipped and validated, but docs describe old behavior.
- `shipped-undocumented` — shipped and validated, but `Docs expected & ~Docs present != 0`.
- `docs-describe-missing` — docs describe a feature that is NOT shipped or NOT validated. Action: remove from docs.
- `designed-not-shipped` — plan exists, no code landed. Action: ignored unless also `docs-describe-missing`.
- `stale-in-prod` — shipped and in docs, but `last_30d == 0`. Action: note in matrix; decide later whether to keep documenting. Does not drive doc edits in this pass.
- `broken` — shipped but production evidence shows it's not working (error logs, failed task_history entries, user complaints in WhatsApp). Action: write finding to matrix and `git add` matrix BEFORE any other file. Do NOT fix.

## "Broken" handling: hard process gate

The v1 spec acknowledged that a main agent holding 8 write-enabled doc files open will rationalize "one-line fix is smaller than a doc edit". v2 adds a mechanical gate.

When a row is classified `broken`:

1. Stop all other work in the current phase.
2. Write the finding into the matrix row's `Notes` column + an explicit `Broken features` section at the bottom of `docs/taskflow-feature-matrix.md`.
3. `git add docs/taskflow-feature-matrix.md` and nothing else.
4. Create a standalone commit: `docs(taskflow): record broken feature R0XX: <name>`.
5. Resume the previous phase.

This turns every broken finding into a tripwire in the commit log. Additionally, during Phase 4, `container/agent-runner/src/taskflow-engine.ts` is NOT opened. Phase 1's Agent B captured file:line pointers; those are sufficient for Phase 4 doc edits. Opening the engine file in Phase 4 is a methodology violation.

## Discovery methodology

Six phases. Phase 0 is new.

### Phase 0: Pre-flight (serial, no parallelism)

Mechanical assertions. Each must return a positive signal or the audit aborts.

1. **Dev repo state**: `git rev-parse HEAD` recorded; working tree must be clean or have only the spec itself pending.
2. **Dev file existence**: every canonical path in the "Canonical source declaration" table must `stat` successfully with nonzero size.
3. **Prod reachability**: `ssh -o BatchMode=yes nanoclaw@192.168.2.63 "hostname"` succeeds.
4. **Prod DB pin**: the canonical DB at `/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db` must be non-empty AND return a positive count on `SELECT COUNT(*) FROM tasks`. The two known-empty siblings must be explicitly confirmed 0 bytes (`stat -c %s`) so future runs can detect if they get populated.
5. **Prod schema parity**: introspect prod via `.schema tasks`, `.schema task_history`, `.schema boards`, `.schema meeting_external_participants`, `.schema board_holidays`. Record the full schema in a Phase 0 output file (`data/audit/phase0-schema.txt`, gitignored or committed alongside matrix depending on size).
6. **Prod action enum pin**: `SELECT action, COUNT(*) FROM task_history GROUP BY action ORDER BY COUNT(*) DESC` — record the full enum. Every SQL probe in Phase 2 must reference a value from this pinned enum; probes referencing strings not in the enum are rejected.
7. **SSH command allowlist declaration**: this spec lists the literal set of SSH command shapes allowed. Phase 0 does not enforce this automatically; the main agent is expected to match every dispatched command against the allowlist regex before sending.

The Phase 0 output file becomes part of the reproducibility anchor. Phases 1–4 must cite it explicitly.

### Phase 1: Enumerate features (parallel subagents, dev-only)

Dispatch 3 `Explore` subagents in parallel:

1. **Agent A — Plans enumeration.** Reads plans matching `*(taskflow|meeting|auditor|recurrence|cross-board|digest|standup|child_exec|reparent|subtask|board|person)*` in `docs/plans/` + `docs/superpowers/plans/`. Non-TaskFlow plans (agent-swarm, travel-assistant, media-support, long-term-context, channel-registry-migration, etc.) are excluded but logged in a "Plans excluded" appendix to the matrix. Agent A output: one-line summary per included plan + user-visible features each plan introduces. Must cite exact file paths.
2. **Agent B — Engine + auditor code enumeration.** Walks `container/agent-runner/src/taskflow-engine.ts`, `container/agent-runner/src/auditor-script.sh`, and — this is new in v2 — **reads the full contents of `container/agent-runner/src/auditor-prompt.txt`** to enumerate user-visible auditor behaviors (what it checks, what phrases it emits). Output: list of action handlers, MCP tool names, CLI entry points, file:line where each is defined, and the auditor behaviors from the prompt. Cross-references: which handlers map to which plans from Agent A.
3. **Agent C — Existing docs audit.** Reads the 8 canonical doc files from the Canonical source declaration table (`SKILL.md`, skill `CHANGELOG.md`, `taskflow-user-manual.md`, `taskflow-operator-guide.md`, `taskflow-quick-start.md`, `taskflow-meetings-reference.md`, `CLAUDE.md.template`, project `CHANGELOG.md`). `auditor-prompt.txt` is NOT audited by Agent C — it's a runtime prompt, not user-facing documentation, and Agent B covers it. Output: for each doc file, a bullet list of features it currently describes (as the doc describes them, not as we wish). Flags anything that sounds aspirational or out-of-date.

Main agent merges the three outputs into a draft feature matrix (feature rows, dev-side columns filled). The row-count estimate and the Phase 1 → Phase 2 split decision (see granularity rule) happen at this merge point, after all three subagents have returned and before any SQL probes are authored.

**Citation spot-check:** main agent samples `min(10, ceil(0.1 × row_count))` rows selected deterministically (every 10th row by row ID) and verifies each cited plan file / engine file:line exists. If any citation fails, the corresponding subagent is re-dispatched with the specific failures.

### Phase 2: Production validation (serial SSH queries)

For each matrix row, assemble a SQL probe that produces `{total; last_30d; last_at}` and, where possible, an outcome signal. The probe is assembled up front for all rows, written to `data/audit/phase2-probes.sql` on dev, reviewed against the Phase 0 pinned enum/schema, and dispatched in one batched heredoc against `/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`.

Probe template:

```sql
-- R037 reparent task across boards
SELECT 'R037' AS id,
       COUNT(*) AS total,
       SUM(CASE WHEN at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS last_30d,
       MAX(at) AS last_at
FROM task_history
WHERE action IN ('reparented');

-- R037 outcome: how many reparented tasks still present 24h later
SELECT 'R037-outcome' AS id,
       SUM(CASE WHEN t.id IS NOT NULL THEN 1 ELSE 0 END) AS still_present,
       COUNT(*) AS reparent_events
FROM task_history h
LEFT JOIN tasks t ON t.board_id = h.board_id AND t.id = h.task_id
WHERE h.action = 'reparented'
  AND h.at < datetime('now','-1 day');
```

**Rules for probes:**

- Every `WHERE action = X` clause must cite a value from the Phase 0 pinned enum. For verbs with known duplicates (e.g. `conclude`/`concluded`, `approve`/`approved`, `create`/`created`, `reassigned`/`assigned`, `update`/`updated`/`update_field`), use `IN (…)` and list every variant; the list of variants is recorded in the matrix `Notes` column so re-runs are deterministic.
- Every probe must produce a row even on zero matches (use `COUNT(*)` not `SELECT ... WHERE …`).
- Probes must be idempotent and side-effect-free (SELECT only, `-readonly` enforced at the `sqlite3` binary level).
- Probes that require a second DB (e.g. WhatsApp message sampling from `store/messages.db`) go in a SEPARATE batch file `data/audit/phase2-probes-messages.sql` and dispatch in a separate SSH invocation. Mixing databases in one heredoc is forbidden.

**Matrix drift mechanism:** the `git rev-parse HEAD` recorded in Phase 0 is pinned as `dev_sha`. For Phase 4, the main agent opens a git worktree at `dev_sha` for any engine-file lookups it still needs. If new commits land on `main` between Phase 0 and Phase 4, they are deferred to the next audit — not merged into this one. The matrix is explicit about the sha it was computed against.

### Phase 3: Classify, write matrix, commit

- Assign stable IDs `R001…` in capability-area order, never reused.
- Fill in the `Prod evidence` and `Outcome signal` columns.
- Compute `Docs expected` from the derivation rule.
- Compute `Docs present` from Agent C's output.
- Assign `Status` using the decision table above.
- Write `docs/taskflow-feature-matrix.md` with:
  - Reproducibility anchor at top: dev `git rev-parse HEAD`, prod `taskflow.db` mtime + row counts per table + `PRAGMA user_version`, Phase 0 schema + action enum file paths, UTC timestamp of Phase 2 execution, list of plans included/excluded.
  - Capability-area sections with rows in ID order.
  - "Broken features" section at the bottom (may be empty).
  - "Plans excluded" appendix.
  - Footer listing pre-audit commit SHA for each canonical doc so `git show <sha>:<path>` restores the pre-audit state of any file.
- Commit: `docs(taskflow): feature matrix audit 2026-04-11 (phase 3)`.

### Phase 4: Targeted doc edits

Iterate over matrix rows with status ∈ {`docs-stale`, `shipped-undocumented`, `docs-describe-missing`}. For each row:

1. Compute `Docs expected & ~Docs present` (for `shipped-undocumented`) or the opposite (for `docs-describe-missing`). This is the set of doc files to touch.
2. Edit each required doc.
3. Update the matrix row's `Docs present` bitmap in the same edit session.

**Commit strategy:** one commit per canonical doc file (not per feature). Each commit message body contains a `Matrix-rows: R0XX,R0YY,...` trailer listing the IDs it addresses. A reviewer investigating feature R037 can run `git log --grep='Matrix-rows:.*R037'` to see every doc touched for that row.

After all doc commits land, a final commit re-writes `docs/taskflow-feature-matrix.md` to flip updated rows to `in-sync` and records the post-audit SHA. Commit message: `docs(taskflow): feature matrix audit 2026-04-11 (phase 4 close-out)`.

**Engine-file lockout:** during Phase 4, the main agent MUST NOT open `container/agent-runner/src/taskflow-engine.ts` or any other source file under `container/agent-runner/src/`. All the information needed comes from the matrix rows written in Phase 3. Violating this lockout is a methodology error that invalidates the audit.

### Phase 5: Cross-doc invariant check + drift reports

Mechanical checks (main agent, no subagents):

1. **Cross-doc invariants:** every feature mentioned in `taskflow-quick-start.md` must also appear in `taskflow-user-manual.md`; every MCP tool in `SKILL.md` must appear in `CLAUDE.md.template`; every `in-sync` row's bitmap must match its `Docs expected` mask. Any violation is fixed in-place with a final sweep commit.
2. **Template-to-groups drift report:** diff `.claude/skills/add-taskflow/templates/CLAUDE.md.template` against each `groups/<name>/CLAUDE.md` on dev. Output summary to `docs/taskflow-drift-report.md`: lines added/removed per group, top-3 divergent sections. NO edits to group files.
3. **Docs-to-groups drift report:** diff canonical `docs/taskflow-user-manual.md` and `docs/taskflow-quick-start.md` against each `groups/<name>/taskflow-*.md`. Append to the same drift report. NO edits.
4. Commit drift report: `docs(taskflow): template + user-manual drift report 2026-04-11`.

### Phase 6: Final summary

Main agent returns a single summary to the user listing:

- Total rows in matrix, count by status, count by capability area.
- Rows touched in Phase 4 with their row IDs.
- Rows left as `broken` with one-line descriptions (for separate follow-up work).
- Rows left as `stale-in-prod` (candidates for deprecation).
- Drift-report highlights (most-drifted group, most-drifted section).
- Commit SHAs of every commit created by the audit so the whole run can be reverted or reviewed together.

## Allowed SSH command shapes (literal allowlist)

Every SSH invocation during the audit must match one of these shapes. Any other shape is a methodology violation.

1. `ssh -o BatchMode=yes nanoclaw@192.168.2.63 "hostname"` — Phase 0 reachability probe only.
2. `ssh -o BatchMode=yes nanoclaw@192.168.2.63 "stat -c '%s %Y' <allowlisted-path>"` — Phase 0 file stat checks.
3. `ssh -o BatchMode=yes nanoclaw@192.168.2.63 "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db '<SELECT-only SQL>'"` — schema introspection and Phase 2 probes.
4. `ssh -o BatchMode=yes nanoclaw@192.168.2.63 "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/store/messages.db '<SELECT-only SQL>'"` — optional WhatsApp message sampling, only for features where taskflow.db evidence is insufficient.

No `rm`, `cp`, `mv`, `>` redirection, `rsync`, `scp`, `sudo`, `systemctl`, or any shell metacharacter that could initiate a write. Heredocs are allowed only for the sqlite3 commands above and only containing SELECT statements; each heredoc is inspected as a whole before dispatch.

## Reproducibility anchor (captured in Phase 0, embedded in matrix top)

```
dev_sha: <git rev-parse HEAD at Phase 0 start>
dev_tree_clean: true|false
prod_host: nanoclaw@192.168.2.63
prod_taskflow_db: /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db
prod_taskflow_db_mtime: <stat -c %Y>
prod_taskflow_db_size: <stat -c %s>
prod_user_version: <PRAGMA user_version>
prod_row_counts:
  boards: <N>
  tasks: <N>
  task_history: <N>
  meeting_external_participants: <N>
  ...
prod_action_enum_file: data/audit/phase0-schema.txt
phase2_executed_at_utc: <ISO8601>
plans_included: <list>
plans_excluded: <list>
pre_audit_doc_shas:
  docs/taskflow-user-manual.md: <sha>
  docs/taskflow-operator-guide.md: <sha>
  ...
```

A future audit reruns the same methodology; comparing anchors shows what changed.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| SQL probe references a column/action that doesn't exist | Phase 0 pins schema and enum; every probe matched against pinned enum before dispatch |
| Accidental write to prod | `-readonly -bail` at sqlite3 binary level + SSH command regex gate + literal allowlist |
| Racing prod writer for inconsistent reads | Record `taskflow.db` mtime with every query; WAL mode means readers don't block writers; any probe touching same row before/after is re-run |
| Main agent rationalizes fixing a "broken" feature | Broken findings commit the matrix row by itself BEFORE any other file; engine file lockout in Phase 4 |
| Matrix drifts during audit | Phase 0 pins `dev_sha`; Phase 4 opens worktree at pinned sha; commits landing on main deferred |
| Doc edits introduce cross-doc contradictions | Phase 5 runs mechanical cross-doc invariants, not re-reading |
| Group-copy drift propagates silently | Phase 5 produces an explicit drift report; group copies never edited |
| Subagent hallucinates plan citations | Phase 1 citation spot-check: every 10th row verified (up from v1's 3 rows) |
| Row count explodes past 80 | Matrix split decision at Phase 1→Phase 2 handoff, by capability area, before SQL probes are authored |
| Features validated by count alone look "working" when they're not | Every row carries an outcome signal beyond `COUNT(*)`; `stale-in-prod` status distinguishes dormant from missing |
| `store/messages.db` probes get mixed into taskflow.db heredoc | Separate probe files, separate SSH invocations, strict per-DB dispatch |
| DB path ambiguity (3 `taskflow.db` files, 2 empty) | Path pinned to canonical; empty siblings explicitly asserted as 0 bytes in Phase 0 so a future audit catches if they get populated |

## Out of scope (explicit)

- Fixing any bugs found.
- Editing per-group `groups/<name>/taskflow-*.md` or `groups/<name>/CLAUDE.md`.
- Refactoring doc structure (e.g., merging quick-start into user-manual).
- Updating docs for other skills (add-whatsapp, add-agent-swarm, etc.).
- Adding features requested by users in WhatsApp messages that are not yet designed.
- Changing the trigger pattern, MCP tool surface, or IPC protocol.
- Reconciling or removing the two 0-byte sibling `taskflow.db` files on prod.

## Deliverables

1. `docs/taskflow-feature-matrix.md` — persistent matrix artifact with reproducibility anchor + Broken features section + Plans excluded appendix + pre-audit doc SHAs footer.
2. `docs/taskflow-drift-report.md` — template-to-groups and docs-to-groups drift, produced in Phase 5.
3. `data/audit/phase0-schema.txt` — pinned prod schema + action enum (either committed or gitignored — decision at Phase 0).
4. `data/audit/phase2-probes.sql` and `data/audit/phase2-probes-messages.sql` — pre-reviewed SQL probe files.
5. Edited canonical docs: `SKILL.md`, skill `CHANGELOG.md`, `taskflow-user-manual.md`, `taskflow-operator-guide.md`, `taskflow-quick-start.md`, `taskflow-meetings-reference.md`, `CLAUDE.md.template`, project `CHANGELOG.md` — only where matrix rows require.
6. Final summary to user with commit SHAs, status counts, broken/stale findings, drift highlights.

## Success criteria

1. `docs/taskflow-feature-matrix.md` exists with every row having all columns filled and a non-empty status.
2. Every pre-audit row in `{docs-stale, shipped-undocumented, docs-describe-missing}` becomes `in-sync` post-audit, or has an explicit note explaining why it was deliberately skipped.
3. The matrix's "Broken features" section names any broken features with evidence — but contains no code fixes.
4. Phase 5 cross-doc invariant check passes: every quick-start feature appears in user-manual; every SKILL.md MCP tool appears in CLAUDE.md.template; every `in-sync` row's bitmap matches its `Docs expected` mask.
5. Phase 5 drift report exists at `docs/taskflow-drift-report.md` with diffs for each provisioned group.
6. `git log --oneline` after the audit shows the commits in this order: spec v2 → matrix v1 (Phase 3) → zero-or-more `Broken features` commits → one commit per touched canonical doc → matrix v2 (Phase 4 close-out) → drift report (Phase 5).
7. Reproducibility anchor is embedded in the matrix.
8. Zero writes of any kind on production `.63`. Every SSH command issued matches the literal allowlist.
9. Engine source file `container/agent-runner/src/taskflow-engine.ts` is never opened during Phase 4 (verifiable from the commit history: any edit to an engine file during Phase 4 voids the audit).
