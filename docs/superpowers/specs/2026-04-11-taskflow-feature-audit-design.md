# TaskFlow Feature Audit & Documentation Sync

**Date:** 2026-04-11
**Status:** Design
**Type:** Documentation + research (no code changes)

## Problem

TaskFlow has grown by ~37 design/implementation plans across 10 weeks (2026-02-24 → 2026-04-11). User-facing docs (`taskflow-user-manual.md`, `taskflow-operator-guide.md`, `taskflow-quick-start.md`, `taskflow-meetings-reference.md`), the skill-facing `SKILL.md`, the agent behavior prompt `templates/CLAUDE.md.template`, and both changelogs have drifted. It is unclear which features are:

1. **Designed but never shipped** (plans without landed code)
2. **Shipped but undocumented** (commits without doc updates)
3. **Documented but not working in production** (docs describing broken/removed features)
4. **Working in production** (evidence in real WhatsApp interactions and taskflow DB on `.63`)

Without a single source of truth, each doc edit risks contradicting another. Users on the production boards already hit features the docs don't describe, and the auditor/digest flows are not represented in operator-facing materials.

## Goals

1. Produce a **feature matrix** that classifies every user-visible TaskFlow feature against four axes: designed, shipped, validated in prod, documented.
2. Use the matrix to drive **targeted doc edits** — one edit corresponds to one matrix cell marked `docs-stale` or `shipped-undocumented`.
3. Preserve the matrix as a reusable artifact at `docs/taskflow-feature-matrix.md`, so future audits start from it instead of from scratch.
4. **Do not touch implementation code.** This is research + docs only. Any code bug found is logged as a note in the matrix and reported back, not fixed in this pass.

## Non-goals

- Writing new features.
- Refactoring or simplifying engine code.
- Deploying to production or modifying production DBs.
- Covering non-TaskFlow skills (agent-swarm, travel-assistant, wiki, etc.) except where they intersect TaskFlow behavior.
- Translating docs (stays in the language each doc is currently written in — user manual is Portuguese, specs/plans are English).

## Split of responsibilities: dev vs. prod

| Role | Machine | Path | Allowed ops |
|---|---|---|---|
| Source of truth for code, plans, docs | dev (`/root/nanoclaw`) | this repo | read + write + commit |
| Source of truth for usage/interactions | prod (`nanoclaw@192.168.2.63`) | `/home/nanoclaw/nanoclaw` | **read-only** via SSH |

All DB queries for production evidence run on `.63` via `ssh nanoclaw@192.168.2.63 "sqlite3 …"`. No writes of any kind on prod. No service restarts. No file edits.

## Feature matrix format

**File:** `docs/taskflow-feature-matrix.md`

Grouped by capability area. Each row represents one user-visible feature.

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

### Columns

| Column | Meaning | Example |
|---|---|---|
| Feature | Short imperative name | "Reparent task across boards" |
| Area | One of the 10 areas above | "Cross-board" |
| Designed | Plan file(s) or `ad-hoc` | `docs/superpowers/plans/2026-03-27-reparent-task.md` |
| Shipped | `file.ts:NNN` pointer or `❌` | `taskflow-engine.ts:6163` |
| Validated in prod | Evidence count from `.63` or `❌ unused` | "7 reparent events in `task_history` across 3 boards" |
| Docs | 8-column bitmap over the docs below | `S.U..M.C` |
| Status | One of the five statuses below | `shipped-undocumented` |
| Notes | Free-form, max 1 sentence | "Only sec-taskflow uses it; no failures in history" |

**Docs bitmap columns (in order):** `S` = SKILL.md, `C1` = skill CHANGELOG, `U` = user-manual, `O` = operator-guide, `Q` = quick-start, `M` = meetings-reference, `T` = CLAUDE.md.template, `C2` = project CHANGELOG. A dot means absent, a letter means present.

### Status values

- `in-sync` — designed, shipped, validated, documented. No action.
- `docs-stale` — shipped and validated, but docs describe old behavior.
- `shipped-undocumented` — shipped and validated, but no doc mentions it.
- `designed-not-shipped` — plan exists, no code landed. Action: remove from docs if previously described; otherwise ignore.
- `broken` — shipped but production evidence shows it's not working (error logs, failed task_history entries, user complaints in WhatsApp). Action: log as note, do NOT fix.

## Discovery methodology

Four phases, with parallelism where safe.

### Phase 1: Enumerate features (parallel subagents, dev-only)

Dispatch 3 `Explore` subagents in parallel:

1. **Agent A — Plans enumeration.** Reads all 37 plans in `docs/plans/` + `docs/superpowers/plans/`. Output: one-line summary per plan + user-visible features each plan introduces. No code reading.
2. **Agent B — Engine code enumeration.** Walks `container/agent-runner/src/taskflow-engine.ts`, `auditor-script.sh`, `auditor-prompt.txt`. Output: list of action handlers, MCP tools, CLI entry points, and the file:line where each is defined. Cross-references: which handlers correspond to which plans.
3. **Agent C — Existing docs audit.** Reads the 8 doc files. Output: for each doc, a bullet list of features it currently describes (as the doc describes them, not as we wish). Flags anything that sounds aspirational or out-of-date.

Main agent merges the three outputs into a draft feature matrix (features rows, dev-side columns filled).

### Phase 2: Production validation (serial SSH queries)

For each matrix row, run a targeted SQL query against `/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db` on `.63` and record the evidence count. Examples:

- "Create task" → `SELECT COUNT(*) FROM tasks;`
- "Reparent task across boards" → `SELECT COUNT(*) FROM task_history WHERE action='reparent';` (or whatever the history action name is)
- "External participant in meeting" → `SELECT COUNT(*) FROM meeting_external_participants;`
- "Bounded recurrence" → `SELECT COUNT(*) FROM tasks WHERE recurrence_rule IS NOT NULL AND recurrence_count_limit IS NOT NULL;`

For a small set of high-impact features, also sample WhatsApp messages on `.63`:

```sql
SELECT content, sender_name, timestamp FROM messages
WHERE chat_jid = '<board>@g.us' AND content LIKE '%keyword%'
ORDER BY timestamp DESC LIMIT 20;
```

This catches features the docs mention but that users never actually invoke.

**Batched execution:** the main agent assembles the full list of SQL probes up front, then runs them in one SSH session (`sqlite3 db <<EOF ... EOF`) to minimize round trips.

### Phase 3: Classify and commit matrix

- Fill in the `Validated in prod` column.
- Assign each row a `Status` value from the 5-value set.
- Write `docs/taskflow-feature-matrix.md`.
- Commit: `docs(taskflow): feature matrix audit 2026-04-11`.

### Phase 4: Targeted doc edits

Iterate over matrix rows with status ∈ {`docs-stale`, `shipped-undocumented`}.

For each row:

1. Determine which doc(s) should cover the feature based on the doc's audience:
   - `SKILL.md` — anything user-installable that affects the skill's feature list
   - `CHANGELOG.md` (skill) — new feature since last version bump
   - `taskflow-user-manual.md` — anything a regular user needs to know
   - `taskflow-operator-guide.md` — anything an admin/operator configures or monitors
   - `taskflow-quick-start.md` — top-5 workflows only
   - `taskflow-meetings-reference.md` — meeting-related only
   - `CLAUDE.md.template` — anything the in-container agent needs to call or honor
   - `CHANGELOG.md` (project) — user-facing change since last version bump
2. Make the edit in each relevant doc.
3. Update the matrix row's Docs bitmap.

**Commit strategy:** one commit per doc file (not per feature), with a message that lists which matrix rows it addresses. Keeps diffs reviewable and bisectable. A final commit re-runs the matrix to flip updated rows to `in-sync`.

## What the matrix does NOT drive

- Code fixes for `broken` rows — these become a summary report at the end, not edits.
- Doc additions for `designed-not-shipped` rows — these are left out unless previously documented.
- Translation or tone changes unrelated to feature accuracy.
- Adding new capability areas or reorganizing doc structure — this audit preserves existing structure; any reorg is a separate task.

## Success criteria

1. `docs/taskflow-feature-matrix.md` exists, lists every user-visible feature grouped by area, and every row has a non-empty status.
2. Every `docs-stale` and `shipped-undocumented` row before the audit becomes `in-sync` after the doc edits (or has a note explaining why it was deliberately skipped).
3. The summary report at the end names any `broken` features found, with evidence — but does not fix them.
4. `git log --oneline` after the audit shows one matrix commit plus one commit per doc file touched, each with a message linking to the matrix rows it addresses.
5. No writes of any kind on production `.63`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Feature matrix becomes a moving target as engine code changes during audit | Snapshot engine file SHAs at Phase 1 start; re-verify shipped column at Phase 4 end |
| SSH queries to prod leak credentials into command lines | Use `sqlite3 db "query"` only; no API tokens or secrets needed for read-only SQL |
| Subagent in Phase 1 invents plans that don't exist | Each subagent must cite exact file paths; main agent spot-checks 3 random citations before accepting |
| Matrix grows past ~100 rows and becomes unmaintainable | If row count exceeds 80, split by capability area into separate files and link from index |
| Doc edits introduce contradictions between docs | Matrix bitmap lets us see at a glance which docs cover each feature; final pass re-reads each doc top-to-bottom for consistency |
| I accidentally SSH with a write query | All SQL probes are pre-assembled and reviewed before sending; prod queries use only `SELECT`; any script that could write is rejected before dispatch |

## Out of scope (explicit)

- Fixing any bugs found.
- Refactoring doc structure (e.g., merging quick-start into user-manual).
- Updating docs for other skills (add-whatsapp, add-agent-swarm, etc.).
- Adding features requested by users in WhatsApp messages that are not yet designed.
- Changing the trigger pattern, MCP tool surface, or IPC protocol.

## Deliverables

1. `docs/taskflow-feature-matrix.md` — the persistent matrix artifact.
2. Updated: `SKILL.md`, skill `CHANGELOG.md`, `taskflow-user-manual.md`, `taskflow-operator-guide.md`, `taskflow-quick-start.md`, `taskflow-meetings-reference.md`, `CLAUDE.md.template`, project `CHANGELOG.md` — only where matrix rows require.
3. Final summary comment to the user listing: rows audited, rows edited, rows left as `broken` with notes, rows left as `designed-not-shipped`.
