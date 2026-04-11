# TaskFlow Feature Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a feature matrix (`docs/taskflow-feature-matrix.md`) cross-referencing every user-visible TaskFlow feature against designed/shipped/validated-in-prod/documented axes, use it to drive targeted doc edits across 8 canonical docs, and publish a drift report for per-group copies — all without touching implementation code or writing to production.

**Architecture:** Six phases executed in order. Phase 0 is mechanical pre-flight that pins all reproducibility anchors. Phase 1 dispatches three parallel Explore subagents (plans / engine / docs) to enumerate features. Phase 2 runs pre-reviewed SQL probes against a read-only pinned prod DB. Phase 3 writes the matrix. Phase 4 edits canonical docs one per commit, each with a `Matrix-rows:` trailer. Phase 5 runs cross-doc invariants and produces the template-to-groups drift report. Phase 6 reports results to the user.

**Tech Stack:** Bash, sqlite3 (with `-readonly -bail`), ssh, git, Claude Code `Agent` subagents (Explore type), Markdown.

**Spec:** `docs/superpowers/specs/2026-04-11-taskflow-feature-audit-design.md` (commit `8458ae8`)

---

## File Structure

**Created (committed to git):**
- `docs/taskflow-feature-matrix.md` — persistent matrix artifact with reproducibility anchor embedded at top, capability-area sections, Broken features section, Plans excluded appendix, pre-audit doc SHAs footer.
- `docs/taskflow-drift-report.md` — Phase 5 drift diffs for `groups/<name>/CLAUDE.md` vs `CLAUDE.md.template` and `groups/<name>/taskflow-*.md` vs `docs/taskflow-*.md`.

**Created (gitignored, working files under `data/audit/`):**
- `data/audit/phase0-schema.txt` — `.schema` output for `tasks`, `task_history`, `boards`, `meeting_external_participants`, `board_holidays`, plus the pinned `task_history.action` enum.
- `data/audit/phase0-anchor.txt` — reproducibility anchor (dev_sha, prod mtime, row counts). Copied into the matrix top at Phase 3.
- `data/audit/phase1-plans.txt`, `phase1-engine.txt`, `phase1-docs.txt` — raw subagent outputs.
- `data/audit/phase1-matrix-draft.md` — merged draft before Phase 2.
- `data/audit/phase2-probes.sql` — pre-assembled SQL probe batch for `taskflow.db`.
- `data/audit/phase2-probes-messages.sql` — optional message-sampling batch for `store/messages.db`.
- `data/audit/phase2-results.tsv` — TSV output of batched SSH probe dispatch.
- `data/audit/phase2-results-messages.tsv` — optional message probe results.
- `data/audit/phase5-invariants.txt` — cross-doc invariant check output.
- `data/audit/phase5-drift-template.txt` — per-group `CLAUDE.md` diffstat.
- `data/audit/phase5-drift-docs.txt` — per-group `taskflow-*.md` diffstat.

**Modified (committed, Phase 4, one commit each):**
- `.claude/skills/add-taskflow/SKILL.md`
- `.claude/skills/add-taskflow/CHANGELOG.md`
- `.claude/skills/add-taskflow/templates/CLAUDE.md.template`
- `docs/taskflow-user-manual.md`
- `docs/taskflow-operator-guide.md`
- `docs/taskflow-quick-start.md`
- `docs/taskflow-meetings-reference.md`
- `CHANGELOG.md` (project root)

Not every doc will be modified — only those that have matrix rows in `{docs-stale, shipped-undocumented, docs-describe-missing}` whose `Docs expected` mask includes them.

**Read-only (never modified):**
- `container/agent-runner/src/taskflow-engine.ts` — read in Phase 1 (Agent B) only; locked out in Phase 4.
- `container/agent-runner/src/auditor-script.sh`, `auditor-prompt.txt` — read in Phase 1 (Agent B) only.
- All 37 plan files — read in Phase 1 (Agent A) after filtering.
- Production `.63` — read-only via SSH `sqlite3 -readonly -bail` exclusively.
- `groups/<name>/CLAUDE.md`, `groups/<name>/taskflow-*.md` — read in Phase 5 for drift report; never edited.

---

## Task 1: Phase 0 — Pre-flight assertions

**Files:**
- Create: `data/audit/phase0-schema.txt`
- Create: `data/audit/phase0-anchor.txt`

Run mechanical assertions before any other work. Each step must succeed or the audit aborts.

- [ ] **Step 1: Verify dev repo state**

```bash
git -C /root/nanoclaw status --porcelain
git -C /root/nanoclaw rev-parse HEAD
```

Expected: working tree has at most the spec + this plan file dirty. No other uncommitted changes. Record `HEAD` sha as `dev_sha`.

- [ ] **Step 2: Verify all 8 canonical doc files exist and are writable**

```bash
for f in \
  .claude/skills/add-taskflow/SKILL.md \
  .claude/skills/add-taskflow/CHANGELOG.md \
  .claude/skills/add-taskflow/templates/CLAUDE.md.template \
  docs/taskflow-user-manual.md \
  docs/taskflow-operator-guide.md \
  docs/taskflow-quick-start.md \
  docs/taskflow-meetings-reference.md \
  CHANGELOG.md; do
  test -s "/root/nanoclaw/$f" && test -w "/root/nanoclaw/$f" && echo "OK  $f" || echo "FAIL $f"
done
```

Expected: 8 `OK` lines, 0 `FAIL` lines.

- [ ] **Step 3: Verify auditor source files exist (Agent B input)**

```bash
for f in \
  container/agent-runner/src/taskflow-engine.ts \
  container/agent-runner/src/auditor-script.sh \
  container/agent-runner/src/auditor-prompt.txt; do
  test -s "/root/nanoclaw/$f" && echo "OK  $f" || echo "FAIL $f"
done
```

Expected: 3 `OK` lines.

- [ ] **Step 4: Create audit working directory**

```bash
mkdir -p /root/nanoclaw/data/audit
ls -la /root/nanoclaw/data/audit
```

Expected: directory exists and is empty.

- [ ] **Step 5: Probe prod reachability**

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 nanoclaw@192.168.2.63 "hostname"
```

Expected: prints `TaskFlow` (or the current prod hostname). If this fails, abort the audit and report the connectivity issue.

- [ ] **Step 6: Pin prod DB path and verify non-empty**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 \
  "stat -c '%s %Y %n' /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db /home/nanoclaw/nanoclaw/data/taskflow.db /home/nanoclaw/nanoclaw/data/taskflow/data/taskflow.db 2>&1"
```

Expected: the canonical path is non-zero (≥1MB); the two siblings are exactly `0` bytes. If a sibling is non-zero, abort and report — some other process populated it and the canonical assumption breaks.

- [ ] **Step 7: Verify canonical DB is queryable**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 \
  "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db 'SELECT COUNT(*) FROM tasks; SELECT COUNT(*) FROM boards; SELECT COUNT(*) FROM task_history;'"
```

Expected: three positive integers. Record them for the reproducibility anchor.

- [ ] **Step 8: Capture full prod schema to Phase 0 file**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 \
  "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db '
    .headers on
    .mode column
    .schema tasks
    .schema task_history
    .schema boards
    .schema board_people
    .schema board_groups
    .schema meeting_external_participants
    .schema external_contacts
    .schema board_holidays
    .schema board_admins
    .schema attachment_audit_log
    .schema board_config
    .schema board_runtime_config
    .schema child_board_registrations
    .schema archive
  '" > /root/nanoclaw/data/audit/phase0-schema.txt
wc -l /root/nanoclaw/data/audit/phase0-schema.txt
```

Expected: file has ≥30 lines of CREATE TABLE output.

- [ ] **Step 9: Pin the prod `task_history.action` enum**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 \
  "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db \
  'SELECT action, COUNT(*) FROM task_history GROUP BY action ORDER BY COUNT(*) DESC;'" \
  >> /root/nanoclaw/data/audit/phase0-schema.txt
echo "---" >> /root/nanoclaw/data/audit/phase0-schema.txt
```

Expected: ~40 rows. This is the only valid set of `action` values for Phase 2 probes.

- [ ] **Step 10: Capture prod row counts per table**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 \
  "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db '
    SELECT \"boards\", COUNT(*) FROM boards UNION ALL
    SELECT \"tasks\", COUNT(*) FROM tasks UNION ALL
    SELECT \"task_history\", COUNT(*) FROM task_history UNION ALL
    SELECT \"board_people\", COUNT(*) FROM board_people UNION ALL
    SELECT \"board_groups\", COUNT(*) FROM board_groups UNION ALL
    SELECT \"meeting_external_participants\", COUNT(*) FROM meeting_external_participants UNION ALL
    SELECT \"external_contacts\", COUNT(*) FROM external_contacts UNION ALL
    SELECT \"board_holidays\", COUNT(*) FROM board_holidays UNION ALL
    SELECT \"attachment_audit_log\", COUNT(*) FROM attachment_audit_log UNION ALL
    SELECT \"child_board_registrations\", COUNT(*) FROM child_board_registrations UNION ALL
    SELECT \"archive\", COUNT(*) FROM archive;
  '"
```

Expected: 11 rows. Record in anchor file.

- [ ] **Step 11: Capture prod DB mtime and PRAGMA user_version**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 \
  "stat -c '%Y' /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db && \
   sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db 'PRAGMA user_version;'"
```

Expected: epoch seconds + integer. Record both.

- [ ] **Step 12: Capture pre-audit doc SHAs for rollback**

```bash
cd /root/nanoclaw
for f in \
  .claude/skills/add-taskflow/SKILL.md \
  .claude/skills/add-taskflow/CHANGELOG.md \
  .claude/skills/add-taskflow/templates/CLAUDE.md.template \
  docs/taskflow-user-manual.md \
  docs/taskflow-operator-guide.md \
  docs/taskflow-quick-start.md \
  docs/taskflow-meetings-reference.md \
  CHANGELOG.md; do
  echo "$(git log -1 --format=%H -- "$f") $f"
done
```

Expected: 8 lines, each with a commit SHA + path. These go in the matrix footer.

- [ ] **Step 13: Write reproducibility anchor file**

```bash
cat > /root/nanoclaw/data/audit/phase0-anchor.txt <<EOF
dev_sha: <paste from Step 1>
dev_tree_clean: <true or false from Step 1>
prod_host: nanoclaw@192.168.2.63
prod_taskflow_db: /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db
prod_taskflow_db_size: <paste from Step 6>
prod_taskflow_db_mtime: <paste epoch from Step 11>
prod_user_version: <paste from Step 11>
prod_row_counts:
  boards: <N>
  tasks: <N>
  task_history: <N>
  board_people: <N>
  board_groups: <N>
  meeting_external_participants: <N>
  external_contacts: <N>
  board_holidays: <N>
  attachment_audit_log: <N>
  child_board_registrations: <N>
  archive: <N>
prod_action_enum_count: <N from Step 9>
prod_schema_file: data/audit/phase0-schema.txt
phase0_executed_at_utc: $(date -u --iso-8601=seconds)
pre_audit_doc_shas:
<paste 8 lines from Step 12 here>
EOF
cat /root/nanoclaw/data/audit/phase0-anchor.txt
```

Expected: anchor file has all placeholders filled with real values.

- [ ] **Step 14: Commit nothing (Phase 0 produces gitignored files only)**

Phase 0 outputs live under `data/audit/` which is gitignored. No commit at end of Phase 0. The anchor is transcribed into the matrix file in Phase 3.

---

## Task 2: Phase 1A — Plans enumeration subagent

**Files:**
- Create: `data/audit/phase1-plans.txt`

Dispatch one `Explore` subagent to enumerate user-visible features introduced by each TaskFlow-relevant plan.

- [ ] **Step 1: Build the include/exclude plan lists**

```bash
cd /root/nanoclaw
ls docs/plans/ docs/superpowers/plans/ | grep -v '^$' > /tmp/all-plans.txt
grep -iE 'taskflow|meeting|auditor|recurrence|cross-board|digest|standup|child_exec|reparent|subtask|board-layout|business-day|holiday|person|external|parent' /tmp/all-plans.txt > /tmp/included-plans.txt
grep -viE 'taskflow|meeting|auditor|recurrence|cross-board|digest|standup|child_exec|reparent|subtask|board-layout|business-day|holiday|person|external|parent' /tmp/all-plans.txt > /tmp/excluded-plans.txt
wc -l /tmp/included-plans.txt /tmp/excluded-plans.txt
```

Expected: included > 20, excluded < 15. Record both lists — excluded goes into the matrix "Plans excluded" appendix at Phase 3.

- [ ] **Step 2: Dispatch Agent A via the Agent tool**

Dispatch via `Agent` with `subagent_type: "Explore"` and the following prompt. Pass the include list from Step 1 verbatim in the prompt so the subagent doesn't re-filter.

Prompt body:

> You are enumerating user-visible TaskFlow features from design/implementation plans. This is part of a feature-matrix audit; your output feeds downstream classification.
>
> Read ONLY these plan files (do not read any others, do not read code):
>
> \<paste list from Step 1\>
>
> For each plan, produce an entry with:
> - **Plan file:** exact path relative to repo root
> - **One-sentence summary** of what it designs or implements
> - **Features introduced** — a bullet list, each bullet phrased as a user-observable verb or configuration knob. Use imperative form ("Reparent task across boards", "Skip non-business days for due date", not "reparenting").
> - **Area** — one of: Tasks, Recurrence, Meetings, Auditor, Cross-board, Digest & standup, Media & attachments, Embeddings & search, External participants, Admin & config.
> - **Status hint from the plan itself** — does the plan describe this as shipped, WIP, or aspirational? Quote the phrase that tells you.
>
> Do NOT read any code or any doc file. Cite every feature back to a section/line in the plan file.
>
> Return plain markdown. No preamble, no summary — just the per-plan entries in the order listed. Under 3000 words total.

- [ ] **Step 3: Save subagent output to file**

Save the returned markdown to `/root/nanoclaw/data/audit/phase1-plans.txt`.

```bash
wc -l /root/nanoclaw/data/audit/phase1-plans.txt
head -30 /root/nanoclaw/data/audit/phase1-plans.txt
```

Expected: ≥100 lines, first entry references a valid plan file from the include list.

- [ ] **Step 4: Commit nothing (gitignored)**

---

## Task 3: Phase 1B — Engine + auditor enumeration subagent

**Files:**
- Create: `data/audit/phase1-engine.txt`

Dispatch one `Explore` subagent to walk the engine and auditor files.

- [ ] **Step 1: Dispatch Agent B via the Agent tool**

Dispatch via `Agent` with `subagent_type: "Explore"` and the following prompt:

> You are enumerating user-visible TaskFlow features from the engine and auditor source code. This feeds a feature-matrix audit.
>
> Read ONLY these three files:
> 1. `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts`
> 2. `/root/nanoclaw/container/agent-runner/src/auditor-script.sh`
> 3. `/root/nanoclaw/container/agent-runner/src/auditor-prompt.txt` — **read the full contents, not just the file path**
>
> Do NOT read any other file.
>
> For the engine (`taskflow-engine.ts`), produce:
> - A list of every exported **action handler** — function that mutates state or responds to a user command. For each: handler name, the `task_history.action` value it writes (if any), and the file:line where it's defined.
> - A list of every **MCP tool** registered by the engine (search for `registerTool`, `tools.register`, or similar). For each: tool name and file:line.
> - A list of every **permission check** or **guard clause** that blocks an action (e.g. `requireTask`, `canUseCreateGroup`, cross-board assignee guard). For each: the check name, the action it gates, and the file:line.
>
> For the auditor (`auditor-script.sh`), produce:
> - The list of checks the script performs (idle tasks, stalled cards, missing assignees, etc.). For each: the shell function or block that implements it, with the file:line.
> - The output channels (DM, group post, IPC message).
>
> For `auditor-prompt.txt`, produce:
> - A list of every **user-observable behavior** the prompt tells the model to perform. For each: the quoted phrase from the prompt and a line number.
> - A list of every **constraint or refusal** the prompt imposes (e.g. "NEVER send DMs unless X").
>
> Cross-reference: for each handler, tool, or auditor check, map it to a plan filename under `docs/plans/` or `docs/superpowers/plans/` if an obvious match exists (best-effort, not exhaustive).
>
> Return plain markdown with three top-level sections: `## Engine handlers`, `## MCP tools`, `## Permission guards`, `## Auditor checks`, `## Auditor prompt behaviors`. Under 4000 words total.

- [ ] **Step 2: Save to file**

```bash
wc -l /root/nanoclaw/data/audit/phase1-engine.txt
head -50 /root/nanoclaw/data/audit/phase1-engine.txt
```

Expected: ≥150 lines, first section is Engine handlers with at least 20 entries.

- [ ] **Step 3: Commit nothing (gitignored)**

---

## Task 4: Phase 1C — Docs audit subagent

**Files:**
- Create: `data/audit/phase1-docs.txt`

Dispatch one `Explore` subagent to audit the 8 canonical doc files.

- [ ] **Step 1: Dispatch Agent C via the Agent tool**

Dispatch via `Agent` with `subagent_type: "Explore"` and the following prompt:

> You are auditing TaskFlow documentation coverage for a feature-matrix audit. For each of the 8 canonical doc files below, list the features it currently describes, AS THE DOC DESCRIBES THEM (do not normalize; do not infer; quote phrasing if it matters).
>
> Read ONLY these 8 files. Do NOT read code, plans, or any other file:
>
> 1. `/root/nanoclaw/.claude/skills/add-taskflow/SKILL.md`
> 2. `/root/nanoclaw/.claude/skills/add-taskflow/CHANGELOG.md`
> 3. `/root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template`
> 4. `/root/nanoclaw/docs/taskflow-user-manual.md`
> 5. `/root/nanoclaw/docs/taskflow-operator-guide.md`
> 6. `/root/nanoclaw/docs/taskflow-quick-start.md`
> 7. `/root/nanoclaw/docs/taskflow-meetings-reference.md`
> 8. `/root/nanoclaw/CHANGELOG.md`
>
> For each file, produce:
> - **File:** path
> - **Length:** line count
> - **Features described** — bullet list, each bullet phrased as a user-observable verb or knob, with a line-number range where the doc discusses it.
> - **Aspirational or unclear content** — bullet list of anything that sounds like "we plan to" or "coming soon" or references a feature without explaining it, with line numbers.
> - **Contradictions** — any place the doc contradicts itself or another doc you've already read, with line numbers.
>
> Return plain markdown. Under 4000 words total.

- [ ] **Step 2: Save to file**

```bash
wc -l /root/nanoclaw/data/audit/phase1-docs.txt
```

Expected: ≥200 lines.

- [ ] **Step 3: Commit nothing (gitignored)**

---

## Task 5: Phase 1 merge + row-count estimate + split decision

**Files:**
- Create: `data/audit/phase1-matrix-draft.md`

Merge the three subagent outputs into a draft feature matrix. Decide whether to split.

- [ ] **Step 1: Deduplicate features across the three sources**

Read `phase1-plans.txt`, `phase1-engine.txt`, `phase1-docs.txt`. For every feature mentioned in any source:

- Pick a canonical name (imperative verb form, match Agent B's engine handler name where possible).
- Record sources: plan file(s), engine file:line, doc location(s).
- Apply the granularity rule from the spec: collapse sub-variants if they share handler + `task_history.action` + user phrase.

Write to `/root/nanoclaw/data/audit/phase1-matrix-draft.md` as a markdown table with columns: `Feature | Area | Designed | Shipped | Docs-mentions`. Do NOT fill in `Prod evidence`, `Outcome signal`, `Docs expected`, `Status`, `Notes` yet — those come from Phase 2/3.

- [ ] **Step 2: Count rows and estimate**

```bash
grep -c '^|' /root/nanoclaw/data/audit/phase1-matrix-draft.md
```

Expected: 40–80 rows. If > 80: stop and apply the matrix-split rule from the spec (split by capability area into `docs/taskflow-feature-matrix/{area}.md`). If < 30: granularity is too coarse — split due-date/recurrence/cross-board features more finely and re-merge.

- [ ] **Step 3: Citation spot-check**

Compute `min(10, ceil(0.1 × row_count))`. Pick that many rows deterministically by selecting every `ceil(row_count / sample_size)`-th row. For each sampled row:

1. If `Designed` cites a plan: `test -s <plan-path>` and `grep -l "<feature-keyword>" <plan-path>`.
2. If `Shipped` cites `file.ts:NNN`: `sed -n '<NNN>p' /root/nanoclaw/<file.ts>` and confirm the line is inside a function that matches the feature.
3. If `Docs-mentions` cites a doc line: confirm the line exists.

Expected: every cited reference resolves. If any fail, re-dispatch the offending subagent with the specific failure.

- [ ] **Step 4: Commit nothing (gitignored)**

---

## Task 6: Phase 2 — Author SQL probes

**Files:**
- Create: `data/audit/phase2-probes.sql`

Translate each draft-matrix row into a SELECT-only probe grounded in the Phase 0 pinned action enum.

- [ ] **Step 1: Build the canonical probe template**

Each row in the draft matrix gets ONE primary probe (evidence count) and zero-or-one outcome probes. The template:

```sql
-- R0XX <feature name>
-- variants: <list of action values used in IN clause, from phase0-schema.txt>
SELECT 'R0XX' AS id,
       COUNT(*) AS total,
       SUM(CASE WHEN at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS last_30d,
       MAX(at) AS last_at
FROM task_history
WHERE action IN ('<variant1>', '<variant2>', ...);
```

For features not visible in `task_history` (e.g. meeting with external participant, board holidays, embeddings collection), probe the appropriate table directly:

```sql
-- R0XX External participant in meeting
SELECT 'R0XX' AS id,
       COUNT(*) AS total,
       COUNT(DISTINCT task_id) AS last_30d,  -- reuse column name; interpret in matrix
       MAX(added_at) AS last_at
FROM meeting_external_participants;
```

Use ONLY tables and columns listed in `data/audit/phase0-schema.txt`. Any probe referencing a symbol outside the schema is rejected.

- [ ] **Step 2: Assign stable row IDs R001..R0NN**

Assign IDs in capability-area order (Tasks first, then Recurrence, Meetings, Auditor, Cross-board, Digest & standup, Media & attachments, Embeddings & search, External participants, Admin & config). Record the ID in both the draft matrix and the probe file as a leading comment.

- [ ] **Step 3: Author outcome signal probes**

For rows where "executed" ≠ "worked", add a secondary probe. Examples:

```sql
-- R0XX-outcome reparented tasks still present after 24h
SELECT 'R0XX-outcome' AS id,
       SUM(CASE WHEN t.id IS NOT NULL THEN 1 ELSE 0 END) AS still_present,
       COUNT(*) AS total_events
FROM task_history h
LEFT JOIN tasks t ON t.board_id = h.board_id AND t.id = h.task_id
WHERE h.action = 'reparented'
  AND h.at < datetime('now','-1 day');
```

```sql
-- R0XX-outcome auditor suggestions followed by resolution
SELECT 'R0XX-outcome' AS id,
       COUNT(*) AS resolved_within_48h
FROM task_history h1
JOIN task_history h2
  ON h2.board_id = h1.board_id AND h2.task_id = h1.task_id
 AND h2.action IN ('approve','approved','cancelled','conclude','concluded')
 AND h2.at BETWEEN h1.at AND datetime(h1.at, '+48 hours')
WHERE h1.action = 'comment' AND h1.by = 'auditor';
```

Where no outcome signal is feasible, mark the row's `Outcome signal` column `executed-only` (no secondary probe).

- [ ] **Step 4: Wrap probes in a single batch file with a trailing sentinel**

```bash
cat > /root/nanoclaw/data/audit/phase2-probes.sql <<'EOF'
.headers on
.mode tabs
-- Phase 2 probes batch, generated 2026-04-11
-- Pinned DB: /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db
-- Pinned action enum: see data/audit/phase0-schema.txt

<paste all probes here, one per row, preserving comments>

-- Sentinel (never matches real data, confirms the batch ran to completion)
SELECT 'END-OF-BATCH' AS id, 0 AS total, 0 AS last_30d, '-' AS last_at;
EOF
wc -l /root/nanoclaw/data/audit/phase2-probes.sql
```

Expected: line count = ~3 × row count + 5 (three lines per probe + header).

- [ ] **Step 5: Static-check every WHERE clause against the pinned enum**

```bash
# Extract every action value referenced by the probes
grep -oE "action (IN|=) \('?[a-z_]+'?" /root/nanoclaw/data/audit/phase2-probes.sql | \
  grep -oE "'[a-z_]+'" | tr -d "'" | sort -u > /tmp/referenced-actions.txt
# Extract the pinned enum
grep -oE '^[a-z_]+\|' /root/nanoclaw/data/audit/phase0-schema.txt | tr -d '|' | sort -u > /tmp/pinned-enum.txt
# Any referenced action must be in the pinned enum
comm -23 /tmp/referenced-actions.txt /tmp/pinned-enum.txt
```

Expected: empty output (no lines). Any line means a probe references an action value that doesn't exist in prod — fix the probe before dispatch.

- [ ] **Step 6: Static-check for write statements**

```bash
grep -iE '(^|[^a-z_])(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH)[^a-z_]' /root/nanoclaw/data/audit/phase2-probes.sql
```

Expected: empty output. Any match is a write statement that must be removed.

- [ ] **Step 7: Commit nothing (gitignored)**

---

## Task 7: Phase 2 — Dispatch probes via read-only SSH

**Files:**
- Create: `data/audit/phase2-results.tsv`

Run the pre-reviewed probe batch against prod, capture results.

- [ ] **Step 1: Sanity-check the dispatch command shape**

The command that will be dispatched:

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 \
  "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db" \
  < /root/nanoclaw/data/audit/phase2-probes.sql
```

This command MUST match the allowlist regex. Verify mechanically:

```bash
CMD='ssh -o BatchMode=yes nanoclaw@192.168.2.63 "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db"'
echo "$CMD" | grep -qE '^ssh -o BatchMode=yes nanoclaw@192\.168\.2\.63 "sqlite3 -readonly -bail ' && echo "OK" || echo "REJECTED"
```

Expected: `OK`.

- [ ] **Step 2: Run the batch**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 \
  "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db" \
  < /root/nanoclaw/data/audit/phase2-probes.sql \
  > /root/nanoclaw/data/audit/phase2-results.tsv 2>&1
tail -5 /root/nanoclaw/data/audit/phase2-results.tsv
```

Expected: last row is `END-OF-BATCH   0   0   -` (the sentinel). If it's missing, a probe failed mid-batch — find the error and fix.

- [ ] **Step 3: Re-record prod DB mtime immediately after batch**

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 \
  "stat -c '%Y %s' /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db"
```

Compare against the Phase 0 mtime. If different, the prod service wrote to the DB during our read; since prod is in WAL mode this is fine, but record both mtimes in the anchor so a re-run can detect inconsistency.

- [ ] **Step 4: Verify every row got a result**

```bash
# Count R0XX primary probes in the batch
grep -cE '^SELECT .R0[0-9]+. AS id,' /root/nanoclaw/data/audit/phase2-probes.sql
# Count R0XX rows in results
grep -cE '^R0[0-9]+\b' /root/nanoclaw/data/audit/phase2-results.tsv
```

Expected: both counts equal. Any mismatch means a probe errored silently — find and fix.

- [ ] **Step 5: Commit nothing (gitignored)**

---

## Task 8: Phase 3 — Classify rows and write matrix

**Files:**
- Create: `docs/taskflow-feature-matrix.md`

Assemble the final matrix with reproducibility anchor, classified rows, and appendices.

- [ ] **Step 1: Compute `Docs expected` per row**

Apply the spec's derivation rule. For each draft-matrix row:

- Always include `C1` (skill CHANGELOG) and `C2` (project CHANGELOG) if the feature was added or changed in the audit window.
- Always include `U` (user-manual).
- Include `T` (CLAUDE.md.template) if the feature is invocable by the in-container agent.
- Include `Q` (quick-start) only for the top 20 features ranked by `total` from Phase 2 results.
- Include `M` (meetings-reference) if area is Meetings.
- Include `O` (operator-guide) if area is Admin & config.
- Include `S` (SKILL.md) if the skill install advertises the feature.

Write each row's `Docs expected` as an 8-char bitmap in the order `S C1 U O Q M T C2`.

- [ ] **Step 2: Compute `Docs present` per row from Agent C's output**

For each row, walk Agent C's feature list per doc file. If the feature appears in a doc, set that position in the bitmap.

- [ ] **Step 3: Assign `Status` per row**

Decision table:

| Condition | Status |
|---|---|
| `Shipped == ❌` AND `Designed != ad-hoc` | `designed-not-shipped` |
| `Shipped != ❌` AND `total == 0` AND docs describe it | `docs-describe-missing` |
| `Shipped != ❌` AND `total > 0` AND `last_30d == 0` | `stale-in-prod` |
| `Shipped != ❌` AND `total > 0` AND outcome signal shows failures > 50% | `broken` |
| `Shipped != ❌` AND validated AND `Docs present == Docs expected` | `in-sync` |
| `Shipped != ❌` AND validated AND `(Docs expected & ~Docs present) != 0` AND matching doc currently silent | `shipped-undocumented` |
| `Shipped != ❌` AND validated AND some doc describes the feature with wrong behavior | `docs-stale` |

- [ ] **Step 4: Handle broken rows first (process gate)**

For each row with status `broken`:

1. Open `/root/nanoclaw/docs/taskflow-feature-matrix.md` (creating it if needed with just a skeleton — anchor + empty table + empty "Broken features" section).
2. Append the broken row to the "Broken features" section with its note.
3. `git add /root/nanoclaw/docs/taskflow-feature-matrix.md` — and nothing else.
4. Commit: `git commit -m "docs(taskflow): record broken feature R0XX: <name>"`.
5. Continue classifying remaining rows.

Only after all broken rows are committed individually do we write the full matrix.

- [ ] **Step 5: Write the full matrix file**

Structure:

```markdown
# TaskFlow Feature Matrix

_Generated by the feature audit described in `docs/superpowers/specs/2026-04-11-taskflow-feature-audit-design.md`._

## Reproducibility anchor

<paste contents of data/audit/phase0-anchor.txt verbatim>
phase2_executed_at_utc: <ISO8601 from Phase 2 Step 2>
prod_taskflow_db_mtime_after_phase2: <from Phase 2 Step 3>

## Docs bitmap legend

Position (left-to-right): `S` SKILL.md · `C1` skill CHANGELOG · `U` user-manual · `O` operator-guide · `Q` quick-start · `M` meetings-reference · `T` CLAUDE.md.template · `C2` project CHANGELOG. Dot = absent, letter = present.

## Status legend

- `in-sync` — no action
- `docs-stale` — doc describes old behavior; rewrite
- `shipped-undocumented` — shipped+validated, not in expected docs; add
- `docs-describe-missing` — docs describe unshipped feature; remove
- `designed-not-shipped` — no action unless also `docs-describe-missing`
- `stale-in-prod` — no 30-day usage; note only
- `broken` — production evidence of failure; recorded, NOT fixed

## Tasks (R001–R0NN)

| ID | Feature | Designed | Shipped | Prod evidence | Outcome signal | Docs present | Docs expected | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| R001 | ... | ... | ... | {N;M;YYYY-MM-DD} | ... | S.U..M.C | SCUOQ.TC | in-sync | ... |
| ... |

## Recurrence (R0XX–R0XX)
...

## Meetings (R0XX–R0XX)
...

## Auditor (R0XX–R0XX)
...

## Cross-board (R0XX–R0XX)
...

## Digest & standup (R0XX–R0XX)
...

## Media & attachments (R0XX–R0XX)
...

## Embeddings & search (R0XX–R0XX)
...

## External participants (R0XX–R0XX)
...

## Admin & config (R0XX–R0XX)
...

## Broken features

<individually-committed entries from Step 4 end up here>

## Plans excluded

<list from Task 2 Step 1 /tmp/excluded-plans.txt>

## Pre-audit doc SHAs (rollback anchor)

<8-line list from Task 1 Step 12>
```

- [ ] **Step 6: Sanity-check the matrix**

```bash
grep -c '^| R' /root/nanoclaw/docs/taskflow-feature-matrix.md
grep -c 'Status' /root/nanoclaw/docs/taskflow-feature-matrix.md
```

Expected: row count matches Phase 1 row count. Status column has a value on every row.

- [ ] **Step 7: Commit the matrix**

```bash
cd /root/nanoclaw
git add docs/taskflow-feature-matrix.md
git commit -m "$(cat <<'EOF'
docs(taskflow): feature matrix audit 2026-04-11 (phase 3)

Generated by the audit methodology in
docs/superpowers/specs/2026-04-11-taskflow-feature-audit-design.md.

Contains reproducibility anchor, per-capability-area rows with
Designed/Shipped/Prod-evidence/Outcome-signal/Docs-present/
Docs-expected/Status, Broken features section, Plans excluded
appendix, and pre-audit doc SHAs footer for rollback.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: one commit, one file changed.

---

## Task 9: Phase 4 — Edit SKILL.md

**Files:**
- Modify: `.claude/skills/add-taskflow/SKILL.md`

Iterate over every matrix row with status ∈ {`docs-stale`, `shipped-undocumented`, `docs-describe-missing`} whose `Docs expected & ~Docs present` bitmap has the `S` position set (or for `docs-describe-missing`, whose `Docs present` has the `S` position set and `Docs expected` does not).

- [ ] **Step 1: Select applicable rows**

Read the matrix. Filter to rows where SKILL.md is the edit target. Write the list of row IDs to `/tmp/phase4-skill-rows.txt`.

- [ ] **Step 2: Read SKILL.md to understand current structure**

```bash
wc -l /root/nanoclaw/.claude/skills/add-taskflow/SKILL.md
```

Read the file fully. Identify sections where features are listed (usually under "What it adds" or "Commands" or "Features").

- [ ] **Step 3: Make edits**

For each row in the filter:

- If status = `shipped-undocumented`: add a brief description of the feature in the appropriate section, using phrasing consistent with adjacent entries.
- If status = `docs-stale`: replace the existing mention with corrected behavior.
- If status = `docs-describe-missing`: remove the mention.

Do NOT open `container/agent-runner/src/taskflow-engine.ts` or any other engine source file. Everything you need is in the matrix row's `Notes` and `Outcome signal` columns.

- [ ] **Step 4: Update the matrix row bitmaps**

For each row touched, update its `Docs present` bitmap in `docs/taskflow-feature-matrix.md` to reflect the new state.

- [ ] **Step 5: Commit**

```bash
cd /root/nanoclaw
git add .claude/skills/add-taskflow/SKILL.md docs/taskflow-feature-matrix.md
git commit -m "$(cat <<'EOF'
docs(taskflow): sync SKILL.md with feature matrix

Matrix-rows: R0XX,R0YY,R0ZZ

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Replace `R0XX,R0YY,R0ZZ` with the actual row IDs from Step 1.

Expected: one commit, two files changed (SKILL.md + matrix).

---

## Task 10: Phase 4 — Edit skill CHANGELOG.md

**Files:**
- Modify: `.claude/skills/add-taskflow/CHANGELOG.md`

- [ ] **Step 1: Select applicable rows**

Read the matrix. Filter to rows where the `C1` position needs updating. Write to `/tmp/phase4-skillchangelog-rows.txt`.

- [ ] **Step 2: Read current CHANGELOG.md structure**

```bash
head -30 /root/nanoclaw/.claude/skills/add-taskflow/CHANGELOG.md
```

Identify the format used (entry per version? entry per date?).

- [ ] **Step 3: Add entries**

For each row where `C1` is missing and expected: add a bullet under the most recent entry (or create a new entry if the most recent is too old) describing the feature in one line.

Do NOT reorganize the file. Do NOT rewrite old entries. Only add missing ones.

- [ ] **Step 4: Update matrix row bitmaps**

- [ ] **Step 5: Commit**

```bash
cd /root/nanoclaw
git add .claude/skills/add-taskflow/CHANGELOG.md docs/taskflow-feature-matrix.md
git commit -m "$(cat <<'EOF'
docs(taskflow): sync skill CHANGELOG with feature matrix

Matrix-rows: R0XX,R0YY,R0ZZ

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Phase 4 — Edit CLAUDE.md.template

**Files:**
- Modify: `.claude/skills/add-taskflow/templates/CLAUDE.md.template`

This is the 82KB agent behavior prompt. Edit with care.

- [ ] **Step 1: Select applicable rows**

Read the matrix. Filter to rows where `T` is in the edit target set.

- [ ] **Step 2: Read template structure (top-level headings only)**

```bash
grep -nE '^#{1,3} ' /root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template | head -100
```

Use the heading map to locate the correct section for each edit.

- [ ] **Step 3: Make edits**

For each row:

- `shipped-undocumented`: add a guidance block near the most relevant existing section. Match surrounding tone (the template uses imperative instructions to the model).
- `docs-stale`: replace stale guidance.
- `docs-describe-missing`: remove the block.

**Engine-file lockout:** do NOT open `container/agent-runner/src/taskflow-engine.ts`. Everything needed is in the matrix row.

- [ ] **Step 4: Update matrix row bitmaps**

- [ ] **Step 5: Commit**

```bash
cd /root/nanoclaw
git add .claude/skills/add-taskflow/templates/CLAUDE.md.template docs/taskflow-feature-matrix.md
git commit -m "$(cat <<'EOF'
docs(taskflow): sync CLAUDE.md.template with feature matrix

Matrix-rows: R0XX,R0YY,R0ZZ

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Phase 4 — Edit taskflow-user-manual.md

**Files:**
- Modify: `docs/taskflow-user-manual.md`

User-facing manual (999 lines, Portuguese). Preserve the Portuguese voice.

- [ ] **Step 1: Select applicable rows**

Filter matrix to rows where `U` is in the edit target.

- [ ] **Step 2: Read manual structure (headings only)**

```bash
grep -nE '^#{1,3} ' /root/nanoclaw/docs/taskflow-user-manual.md
```

- [ ] **Step 3: Make edits**

For each row:

- Add/correct/remove the feature description in the matching section.
- Use Portuguese. Match the voice of existing nearby content.
- For user-facing features, show the trigger phrase the user types and a one-line example of what the bot does.

Do NOT translate other sections. Do NOT reorganize structure.

- [ ] **Step 4: Update matrix row bitmaps**

- [ ] **Step 5: Commit**

```bash
cd /root/nanoclaw
git add docs/taskflow-user-manual.md docs/taskflow-feature-matrix.md
git commit -m "$(cat <<'EOF'
docs(taskflow): sync user-manual with feature matrix

Matrix-rows: R0XX,R0YY,R0ZZ

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Phase 4 — Edit taskflow-operator-guide.md

**Files:**
- Modify: `docs/taskflow-operator-guide.md`

Operator-facing (614 lines). Covers Admin & config features, auditor tuning, board provisioning.

- [ ] **Step 1: Select applicable rows**

Filter matrix to rows where `O` is in the edit target. Typically Admin & config area, plus any Auditor row with operator-tunable knobs.

- [ ] **Step 2: Read operator guide structure**

```bash
grep -nE '^#{1,3} ' /root/nanoclaw/docs/taskflow-operator-guide.md
```

- [ ] **Step 3: Make edits**

For each row: add/correct/remove as with Task 12. Preserve the existing voice (operator-oriented, instruction-heavy).

- [ ] **Step 4: Update matrix row bitmaps**

- [ ] **Step 5: Commit**

```bash
cd /root/nanoclaw
git add docs/taskflow-operator-guide.md docs/taskflow-feature-matrix.md
git commit -m "$(cat <<'EOF'
docs(taskflow): sync operator-guide with feature matrix

Matrix-rows: R0XX,R0YY,R0ZZ

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Phase 4 — Edit taskflow-quick-start.md

**Files:**
- Modify: `docs/taskflow-quick-start.md`

Quick-start (235 lines). Only top-20 features by prod usage.

- [ ] **Step 1: Select applicable rows**

From the matrix, select rows where:
- `Q` is in `Docs expected` (top-20 ranked by `total`)
- AND `(Docs expected & ~Docs present)` has the `Q` position set, or status is `docs-stale`/`docs-describe-missing` for this doc.

- [ ] **Step 2: Read quick-start structure**

```bash
cat /root/nanoclaw/docs/taskflow-quick-start.md | head -50
```

- [ ] **Step 3: Make edits**

Keep it short. Each entry is one paragraph or one code block. Do NOT add detailed explanations — that's for user-manual.

- [ ] **Step 4: Update matrix row bitmaps**

- [ ] **Step 5: Commit**

```bash
cd /root/nanoclaw
git add docs/taskflow-quick-start.md docs/taskflow-feature-matrix.md
git commit -m "$(cat <<'EOF'
docs(taskflow): sync quick-start with feature matrix

Matrix-rows: R0XX,R0YY

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Phase 4 — Edit taskflow-meetings-reference.md

**Files:**
- Modify: `docs/taskflow-meetings-reference.md`

Meetings reference (181 lines). Only Meetings-area features.

- [ ] **Step 1: Select applicable rows**

Filter matrix to rows where area is Meetings AND `M` is in the edit target.

- [ ] **Step 2: Read meetings reference**

```bash
cat /root/nanoclaw/docs/taskflow-meetings-reference.md
```

- [ ] **Step 3: Make edits**

Add/correct/remove meeting features (external participants, cross-board visibility, meeting notes, scheduling).

- [ ] **Step 4: Update matrix row bitmaps**

- [ ] **Step 5: Commit**

```bash
cd /root/nanoclaw
git add docs/taskflow-meetings-reference.md docs/taskflow-feature-matrix.md
git commit -m "$(cat <<'EOF'
docs(taskflow): sync meetings-reference with feature matrix

Matrix-rows: R0XX,R0YY

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Phase 4 — Edit project CHANGELOG.md

**Files:**
- Modify: `CHANGELOG.md` (project root)

Project-wide changelog. One entry per user-facing change in the audit window.

- [ ] **Step 1: Select applicable rows**

Filter matrix to rows where `C2` is in the edit target (every user-facing feature shipped since the last version bump).

- [ ] **Step 2: Read current changelog structure**

```bash
head -50 /root/nanoclaw/CHANGELOG.md
```

Identify current version number and format.

- [ ] **Step 3: Add entries under the current (unreleased) version section**

If there is no unreleased section, add one. Match existing entry format exactly — the project uses a specific style (see `git log --format=%B -n 5 -- CHANGELOG.md` for examples).

- [ ] **Step 4: Update matrix row bitmaps**

- [ ] **Step 5: Commit**

```bash
cd /root/nanoclaw
git add CHANGELOG.md docs/taskflow-feature-matrix.md
git commit -m "$(cat <<'EOF'
docs(taskflow): sync project CHANGELOG with feature matrix

Matrix-rows: R0XX,R0YY,R0ZZ

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Phase 4 close-out — Matrix update to in-sync

**Files:**
- Modify: `docs/taskflow-feature-matrix.md`

All touched rows should now have `Docs present == Docs expected`.

- [ ] **Step 1: Re-read the matrix and verify bitmaps**

For every row touched in Tasks 9–16, verify `Docs present == Docs expected`. Flip `Status` to `in-sync`.

- [ ] **Step 2: Verify no other rows changed**

```bash
cd /root/nanoclaw
git diff docs/taskflow-feature-matrix.md | grep -E '^[+-]' | head -50
```

Expected: only Status-column flips and bitmap updates. No structural changes.

- [ ] **Step 3: Commit**

```bash
cd /root/nanoclaw
git add docs/taskflow-feature-matrix.md
git commit -m "$(cat <<'EOF'
docs(taskflow): feature matrix audit 2026-04-11 (phase 4 close-out)

Flips updated rows to in-sync after per-doc commits in tasks 9-16.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Phase 5 — Cross-doc invariant check

**Files:**
- Create: `data/audit/phase5-invariants.txt`

Mechanical checks across the 8 docs.

- [ ] **Step 1: Verify every quick-start feature appears in user-manual**

```bash
# Extract feature names from quick-start (heuristic: lines starting with `**` or `###`)
grep -oE '^###? [^#].+$' /root/nanoclaw/docs/taskflow-quick-start.md | sort > /tmp/qs-features.txt
grep -oE '^###? [^#].+$' /root/nanoclaw/docs/taskflow-user-manual.md | sort > /tmp/um-features.txt
comm -23 /tmp/qs-features.txt /tmp/um-features.txt
```

Expected: empty (every quick-start heading has a matching user-manual heading). Any mismatch: open the matrix, find the row, and decide whether the quick-start heading should be renamed (to match user-manual) or whether user-manual needs the corresponding heading added. Fix in-place.

- [ ] **Step 2: Verify every SKILL.md MCP tool appears in CLAUDE.md.template**

```bash
grep -oE '`[a-z_]+_[a-z_]+`' /root/nanoclaw/.claude/skills/add-taskflow/SKILL.md | sort -u > /tmp/skill-tools.txt
grep -oE '[a-z_]+_[a-z_]+' /root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template | sort -u > /tmp/template-tools.txt
comm -23 /tmp/skill-tools.txt /tmp/template-tools.txt
```

Expected: empty (every SKILL.md-advertised tool is invocable per the template). Any missing tool → add to template in a fix-up commit.

- [ ] **Step 3: Verify every in-sync matrix row has `Docs present == Docs expected`**

Parse the matrix, row by row. For every `in-sync` row, compare the two bitmaps. Any mismatch: the row was incorrectly marked in-sync — revert to the appropriate stale status and open a follow-up matrix row.

- [ ] **Step 4: Save invariant output**

```bash
{
  echo "Cross-doc invariant check - $(date -u --iso-8601=seconds)"
  echo "--- Step 1: quick-start in user-manual"
  comm -23 /tmp/qs-features.txt /tmp/um-features.txt
  echo "--- Step 2: SKILL tools in template"
  comm -23 /tmp/skill-tools.txt /tmp/template-tools.txt
  echo "--- Step 3: in-sync bitmap check"
  echo "<manual audit result>"
} > /root/nanoclaw/data/audit/phase5-invariants.txt
```

- [ ] **Step 5: If any fix-ups were needed, commit them**

```bash
cd /root/nanoclaw
git status --porcelain
# If any files changed:
git add -A
git commit -m "$(cat <<'EOF'
docs(taskflow): cross-doc invariant fix-ups (phase 5)

Fixes inconsistencies found by mechanical cross-doc checks:
quick-start/user-manual heading parity and SKILL.md/template
tool-name parity.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no fix-ups were needed, no commit.

---

## Task 19: Phase 5 — Drift report for group copies

**Files:**
- Create: `docs/taskflow-drift-report.md`
- Create: `data/audit/phase5-drift-template.txt`
- Create: `data/audit/phase5-drift-docs.txt`

Diff canonical files against per-group copies. No edits to group files.

- [ ] **Step 1: Diff CLAUDE.md.template against every groups/<name>/CLAUDE.md**

```bash
cd /root/nanoclaw
for f in groups/*/CLAUDE.md; do
  group=$(basename $(dirname "$f"))
  added=$(diff <(sort .claude/skills/add-taskflow/templates/CLAUDE.md.template) <(sort "$f") | grep -c '^> ')
  removed=$(diff <(sort .claude/skills/add-taskflow/templates/CLAUDE.md.template) <(sort "$f") | grep -c '^< ')
  total=$(wc -l < "$f")
  echo "$group added=$added removed=$removed total=$total"
done | tee /root/nanoclaw/data/audit/phase5-drift-template.txt
```

Expected: one line per group. Some groups will have large drift (expected for heavily-customized boards); record highest-drift groups for the report.

- [ ] **Step 2: Diff docs/taskflow-user-manual.md and quick-start against every group copy**

```bash
cd /root/nanoclaw
{
  echo "=== user-manual ==="
  for f in groups/*/taskflow-user-manual.md; do
    group=$(basename $(dirname "$f"))
    diffstat=$(diff -u docs/taskflow-user-manual.md "$f" | grep -cE '^[+-][^+-]')
    echo "$group diff-lines=$diffstat"
  done
  echo "=== quick-start ==="
  for f in groups/*/taskflow-quick-start.md; do
    group=$(basename $(dirname "$f"))
    diffstat=$(diff -u docs/taskflow-quick-start.md "$f" | grep -cE '^[+-][^+-]')
    echo "$group diff-lines=$diffstat"
  done
} | tee /root/nanoclaw/data/audit/phase5-drift-docs.txt
```

Expected: one line per group per file. Group copies are currently frozen at provisioning snapshots so drift will equal the total audit-window changes.

- [ ] **Step 3: Write the drift report**

Create `docs/taskflow-drift-report.md`:

```markdown
# TaskFlow Doc Drift Report

**Date:** 2026-04-11
**Generated by:** TaskFlow feature audit — Phase 5

## Purpose

The `CLAUDE.md.template` and `docs/taskflow-*.md` files are the canonical sources. Each provisioned group retains a frozen snapshot under `groups/<name>/` that was copied at provisioning time. This report measures how far each group has drifted from the canonical source so future work can decide whether to re-sync.

## CLAUDE.md template drift

| Group | Lines added (group has, template lacks) | Lines removed (template has, group lacks) | Total group lines |
|---|---|---|---|
<paste from phase5-drift-template.txt>

**Highest drift:** <top 3 groups>

## User manual drift

| Group | Diff lines vs canonical |
|---|---|
<from phase5-drift-docs.txt>

## Quick-start drift

| Group | Diff lines vs canonical |
|---|---|
<from phase5-drift-docs.txt>

## Recommendation

This report does NOT drive any edits in the current audit. Use it to scope a separate reconciliation task if desired.
```

- [ ] **Step 4: Commit the drift report**

```bash
cd /root/nanoclaw
git add docs/taskflow-drift-report.md
git commit -m "$(cat <<'EOF'
docs(taskflow): template + user-manual drift report 2026-04-11

Diffs canonical docs and CLAUDE.md.template against each
provisioned groups/<name>/ snapshot. Read-only report; group
copies are never edited by this audit.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Phase 6 — Final summary to user

**Files:**
- No files created/modified.

Return a single concise summary to the user.

- [ ] **Step 1: Gather audit-wide statistics**

```bash
cd /root/nanoclaw
# Matrix row counts by status
grep -oE '\| (in-sync|docs-stale|shipped-undocumented|docs-describe-missing|designed-not-shipped|stale-in-prod|broken) \|' docs/taskflow-feature-matrix.md | sort | uniq -c
# Commits created by the audit
git log --oneline 8458ae8..HEAD -- docs/taskflow-feature-matrix.md docs/taskflow-drift-report.md .claude/skills/add-taskflow/ docs/taskflow-*.md CHANGELOG.md
```

- [ ] **Step 2: Compose the summary**

Report to the user:

- Total matrix rows, broken down by status.
- Row count per capability area.
- Commits created (count + oldest..newest SHA range).
- Rows left as `broken` — list row ID + one-line description from Notes.
- Rows left as `stale-in-prod` — list row ID + feature name (candidates for deprecation).
- Drift report highlights: top-3 most-drifted groups.
- The spec commit (`8458ae8`) and this plan's first and last commits so the whole audit can be reviewed as a range.

No commit in this task — just a user-facing summary.

---

## Spec coverage check

Each spec section mapped to tasks:

- **Canonical source declaration** → Task 1 (verify existence), Tasks 9–16 (edit canonicals only), Task 19 (drift report for non-canonicals).
- **Prod-safety gate** → Task 1 (verify DB path + `-readonly`), Task 6 (`-readonly` enforced in probe dispatch), Task 7 (command shape static-check).
- **Phase 0 pre-flight** → Task 1.
- **Phase 1 parallel subagents** → Tasks 2, 3, 4 dispatched in parallel, then Task 5 merges.
- **Granularity rule + row-count split** → Task 5.
- **Citation spot-check** → Task 5 Step 3.
- **Phase 2 pre-assembled probes** → Task 6.
- **Phase 2 dispatch** → Task 7.
- **Phase 3 classification** → Task 8.
- **Broken-feature process gate** → Task 8 Step 4 (commit matrix row before any other file).
- **Docs expected bitmap** → Task 8 Steps 1–2.
- **Six status values** → Task 8 Step 3 decision table.
- **Phase 4 one-commit-per-doc** → Tasks 9–16.
- **Engine-file lockout in Phase 4** → Task 11 Step 3 (explicit).
- **`Matrix-rows:` commit trailer** → Every Phase 4 task commit message.
- **Phase 4 close-out** → Task 17.
- **Phase 5 cross-doc invariants** → Task 18.
- **Phase 5 drift reports** → Task 19.
- **Phase 6 summary** → Task 20.
- **Reproducibility anchor** → Task 1 Step 13, embedded into matrix in Task 8 Step 5.

## Placeholder scan

Every task step contains executable commands or concrete content. No "TBD", no "add appropriate handling", no "similar to task N". Code/markdown bodies are shown in full where the engineer writes content. The only fillable placeholders are row IDs (`R0XX`) in commit message examples, which must be replaced with the actual IDs from Task 5 at execution time.

## Type consistency

- Capability area names consistent across tasks (10 areas, same list every time).
- Status values consistent (6 values) throughout.
- Bitmap column order consistent (`S C1 U O Q M T C2`) in every reference.
- Phase numbering consistent (0–6) across plan, spec, and commit messages.
- Row ID format consistent (`R0XX`) in all references.
