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

sqlite3 dot-commands (`.schema`, `.headers`, `.mode`) can NOT be passed as a SQL
argument — sqlite3 parses that argument as SQL and rejects the leading `.` as a
syntax error. Dot-commands only work via stdin or `-cmd`. Feed them through the
SSH session's stdin:

```bash
ssh -o BatchMode=yes nanoclaw@192.168.2.63 \
  "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db" \
  > /root/nanoclaw/data/audit/phase0-schema.txt <<'SQL'
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
SQL
wc -l /root/nanoclaw/data/audit/phase0-schema.txt
```

Expected: file has ≥30 lines of CREATE TABLE output. If sqlite3 prints `near ".": syntax error`, the argument form was used by mistake — re-run with the heredoc-via-stdin form above.

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
prod_action_enum_file: data/audit/phase0-schema.txt
prod_schema_file: data/audit/phase0-schema.txt
phase0_executed_at_utc: $(date -u --iso-8601=seconds)
plans_included: <filled in at end of Task 2 Step 1b>
plans_excluded: <filled in at end of Task 2 Step 1b>
pre_audit_doc_shas:
<paste 8 lines from Step 12 here>
EOF
cat /root/nanoclaw/data/audit/phase0-anchor.txt
```

Expected: anchor file has all placeholders filled with real values. The `plans_included` / `plans_excluded` markers remain as literal placeholders until Task 2 Step 1d fills them in — that's expected at this point.

- [ ] **Step 13b: Validate the anchor has no unfilled placeholders**

Every `<paste …>` marker in the heredoc must be replaced with a concrete value before the audit proceeds. The two `plans_…` markers are allowed to remain until Task 2 Step 1d; every other `<paste …>` must already be resolved.

```bash
# Strip the two plans_ lines (they're filled in later by Task 2); everything
# else must be free of `<paste` markers.
grep -v '^plans_\(included\|excluded\):' /root/nanoclaw/data/audit/phase0-anchor.txt \
  | grep -n '<paste' && { echo "FAIL: anchor has unfilled <paste …> markers"; exit 1; }
echo "OK: anchor has no unfilled placeholders outside plans_ lines"
```

Expected: `OK` line. If `FAIL`, open the anchor, fill the remaining markers with real values from the earlier steps, and re-run.

- [ ] **Step 14: Commit nothing (Phase 0 produces gitignored files only)**

Phase 0 outputs live under `data/audit/` which is gitignored. No commit at end of Phase 0. The anchor is transcribed into the matrix file in Phase 3.

---

## Task 2: Phase 1A — Plans enumeration subagent

**Files:**
- Create: `data/audit/phase1-plans.txt`

Dispatch one `Explore` subagent to enumerate user-visible features introduced by each TaskFlow-relevant plan.

- [ ] **Step 1: Build the include/exclude plan lists**

Use `find -printf` so filenames retain their full path (`ls dir1 dir2` emits directory-heading lines and strips the parent prefix, which the subagent can't use to `Read` the file).

```bash
cd /root/nanoclaw
find docs/plans docs/superpowers/plans -maxdepth 1 -name '*.md' -printf '%p\n' | sort > /tmp/all-plans.txt
grep -iE 'taskflow|meeting|auditor|recurrence|cross-board|digest|standup|child_exec|reparent|subtask|board-layout|business-day|holiday|person|external|parent' /tmp/all-plans.txt > /tmp/included-plans.txt
grep -viE 'taskflow|meeting|auditor|recurrence|cross-board|digest|standup|child_exec|reparent|subtask|board-layout|business-day|holiday|person|external|parent' /tmp/all-plans.txt > /tmp/excluded-plans.txt
wc -l /tmp/included-plans.txt /tmp/excluded-plans.txt
```

Expected: included > 20, excluded < 15. Record both lists — excluded goes into the matrix "Plans excluded" appendix at Phase 3.

- [ ] **Step 1b: Human confirmation of the include/exclude split**

The keyword regex is imperfect: `person`, `parent`, `external` can match unrelated plans (e.g. a plan about `external-oauth-providers` or `parent-process-supervisor`). Conversely, a TaskFlow plan whose filename contains no keyword gets silently excluded.

```bash
echo "=== Included (${included_count:=$(wc -l < /tmp/included-plans.txt)}) ==="
cat /tmp/included-plans.txt
echo "=== Excluded (${excluded_count:=$(wc -l < /tmp/excluded-plans.txt)}) ==="
cat /tmp/excluded-plans.txt
```

Read both lists. For any INCLUDED plan whose filename looks unrelated, move it to the excluded list manually. For any EXCLUDED plan whose title looks TaskFlow-relevant, move it to the included list. Record the manual moves in the anchor (Step 4 below) so a re-run can reproduce the decision.

- [ ] **Step 1c: Estimate subagent input size**

Token budget sanity-check. The average audit-window plan is ~10k–40k tokens. A subagent asked to `Read` all 25+ plans in full will blow past its context window before it finishes analysis.

```bash
while IFS= read -r f; do
  wc -c "$f"
done < /tmp/included-plans.txt | awk '{total += $1} END {print "total bytes:", total, " approx tokens:", int(total/4)}'
```

If the approximate token count exceeds 80,000 (leaving ~120k for analysis + output in a 200k window), Agent A's prompt MUST restrict reading to section headers + TL;DR only, OR the included list MUST be split across two subagents (Agent A1 handles the first half by date, Agent A2 handles the second half). The split strategy is recorded in the anchor.

- [ ] **Step 1d: Write confirmed plan lists into the Phase 0 anchor**

Replace the two `<filled in at end of Task 2 Step 1b>` placeholders in `phase0-anchor.txt` with the final (post-confirmation) lists. This closes out Task 1 Step 13b's deferred placeholders.

**Idempotency.** The awk pass below is safe to re-run because it:

1. Verifies both `/tmp/included-plans.txt` and `/tmp/excluded-plans.txt` exist and are non-empty before mutating the anchor (missing input aborts rather than silently writing empty sections).
2. Strips any existing `plans_included:`/`plans_excluded:` blocks (including the nested `  - …` bullets) before re-inserting the fresh ones — so re-running does NOT append duplicate bullets.

```bash
set -e
[ -s /tmp/included-plans.txt ] || { echo "FAIL: /tmp/included-plans.txt missing or empty; rerun Task 2 Step 1"; exit 1; }
[ -s /tmp/excluded-plans.txt ] || { echo "FAIL: /tmp/excluded-plans.txt missing or empty; rerun Task 2 Step 1"; exit 1; }

tmp_anchor=$(mktemp)
awk -v included_file=/tmp/included-plans.txt -v excluded_file=/tmp/excluded-plans.txt '
  # Entering a plans_ block: skip any previously-rendered bullets (including
  # the literal "<filled in …>" placeholder) until the next top-level key.
  /^plans_included:/ {
    print "plans_included:"
    while ((getline line < included_file) > 0) print "  - " line
    close(included_file)
    in_plans_block = 1
    next
  }
  /^plans_excluded:/ {
    print "plans_excluded:"
    while ((getline line < excluded_file) > 0) print "  - " line
    close(excluded_file)
    in_plans_block = 1
    next
  }
  # Inside a plans_ block, swallow every line until we see another top-level
  # key (a line that does not start with whitespace and contains ":").
  in_plans_block {
    if ($0 ~ /^[A-Za-z_]+:/) {
      in_plans_block = 0
      print
      next
    }
    next
  }
  { print }
' /root/nanoclaw/data/audit/phase0-anchor.txt > "$tmp_anchor"
mv "$tmp_anchor" /root/nanoclaw/data/audit/phase0-anchor.txt

# Re-run the placeholder validator now that the plans_ lines are populated
if grep -n '<paste\|<filled in' /root/nanoclaw/data/audit/phase0-anchor.txt; then
  echo "FAIL: anchor still has unresolved placeholders"
  exit 1
fi
echo "OK: anchor fully resolved"

# Sanity: re-running the same awk on the freshly-rewritten anchor must produce
# byte-identical output (proves idempotency).
tmp2=$(mktemp)
awk -v included_file=/tmp/included-plans.txt -v excluded_file=/tmp/excluded-plans.txt '
  /^plans_included:/ { print "plans_included:"; while ((getline line < included_file) > 0) print "  - " line; close(included_file); in_plans_block = 1; next }
  /^plans_excluded:/ { print "plans_excluded:"; while ((getline line < excluded_file) > 0) print "  - " line; close(excluded_file); in_plans_block = 1; next }
  in_plans_block { if ($0 ~ /^[A-Za-z_]+:/) { in_plans_block = 0; print; next } next }
  { print }
' /root/nanoclaw/data/audit/phase0-anchor.txt > "$tmp2"
diff -q "$tmp2" /root/nanoclaw/data/audit/phase0-anchor.txt \
  && echo "OK: Step 1d is idempotent" \
  || { echo "FAIL: Step 1d not idempotent — re-run would mutate the anchor"; exit 1; }
rm -f "$tmp2"
```

Expected: two `OK` lines. If the anchor still has any `<paste` or `<filled in` markers, the executor skipped an earlier step — go back and fix.

- [ ] **Step 2: Dispatch Agent A via the Agent tool**

Dispatch via `Agent` with `subagent_type: "Explore"` and the following prompt. Pass the post-Step-1b confirmed include list verbatim so the subagent doesn't re-filter.

If Step 1c flagged the input as exceeding the token budget, dispatch TWO subagents (Agent A1 and Agent A2) instead of one, each handling half of the include list by date. Merge their outputs in Task 5.

Prompt body:

> You are enumerating user-visible TaskFlow features from design/implementation plans. This is part of a feature-matrix audit; your output feeds downstream classification.
>
> **Budget discipline.** The plan file list below may be large. DO NOT `Read` entire plan files unless a section header or summary block is insufficient. For each plan:
>
> 1. First `Read` only the first 80 lines (goal + overview + file structure section usually fit here).
> 2. If that gives you enough to enumerate features, stop reading this file and move on.
> 3. Only if the header is inconclusive, `Grep` the plan for `Features|Goals|What|adds|introduces|Phase 1|Phase 2` and `Read` just those matched line ranges.
> 4. NEVER read plan files in full. If a plan exceeds 500 lines you may `Read` at most 200 lines of it, spread across the likely-relevant sections.
>
> Read ONLY these plan files (do not read any others, do not read code):
>
> \<paste confirmed list from Step 1b\>
>
> For each plan, produce an entry with:
> - **Plan file:** exact path relative to repo root
> - **One-sentence summary** of what it designs or implements
> - **Features introduced** — a bullet list, each bullet phrased as a user-observable verb or configuration knob. Use imperative form ("Reparent task across boards", "Skip non-business days for due date", not "reparenting").
> - **Area** — one of: Tasks, Recurrence, Meetings, Auditor, Cross-board, Digest & standup, Media & attachments, Embeddings & search, External participants, Admin & config.
> - **Status hint from the plan itself** — does the plan describe this as shipped, WIP, or aspirational? Quote the phrase that tells you (best-effort; if only the header was read, "unclear" is an acceptable answer).
>
> Do NOT read any code or any doc file. Cite every feature back to a line range in the plan file you actually read.
>
> If you truncate coverage of any plan due to token budget, say so explicitly at the end of that plan's entry: `_Truncated: header + grep-matched sections only, full body not read._`
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

`taskflow-engine.ts` is large (~7700 lines / ~80k tokens). The subagent must NOT `Read` it in full — doing so will consume most of its context before analysis. The prompt below requires Grep-first, Read-targeted-ranges.

Dispatch via `Agent` with `subagent_type: "Explore"` and the following prompt:

> You are enumerating user-visible TaskFlow features from the engine and auditor source code. This feeds a feature-matrix audit.
>
> Read ONLY these three files:
> 1. `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` — **do NOT read in full; use Grep to locate specific symbols, then Read narrow line ranges**
> 2. `/root/nanoclaw/container/agent-runner/src/auditor-script.sh`
> 3. `/root/nanoclaw/container/agent-runner/src/auditor-prompt.txt` — **read the full contents, not just the file path**
>
> Do NOT read any other file.
>
> **Budget discipline for `taskflow-engine.ts`:** start with `Grep` to enumerate:
> - `registerTool|tools\.register` → MCP tool names + line numbers
> - `recordHistory\(` → every call that writes `task_history` via the helper (the common path; gives you action values in context)
> - `INSERT INTO task_history` → every DIRECT `task_history` write that bypasses `recordHistory()`. These exist: there are at least three sites that insert directly without going through the helper (e.g., `add_external_participant`, `remove_external_participant`, `external_invite_accepted`). Grep them explicitly — a `recordHistory\(` scan alone WILL miss them.
> - `^\s*(public|private|async)?\s*(handle|run|do|execute)[A-Z]\w*\s*\(` → handler function signatures
> - `if \(!.*\) (throw|return)` near the top of each handler → permission guards
>
> Then `Read` narrow line ranges (say ±15 lines) around each interesting hit. Never `Read` more than 400 lines total from `taskflow-engine.ts` across all operations combined.
>
> **Completeness check for the action enum:** your final list of `task_history.action` values must be the UNION of values from `recordHistory()` calls AND from direct `INSERT INTO task_history` sites. A missing value here propagates into Phase 2 probes as a blind spot (the feature corresponds to zero rows).
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
- Apply the granularity rule (below — inlined from the spec so you do not need to re-open it).

**Granularity rule (inlined from `docs/superpowers/specs/2026-04-11-taskflow-feature-audit-design.md:90-100`):**

One matrix row per **user-observable verb or configuration knob**. A verb is distinct — i.e. gets its OWN row — if at least ONE of the following is true:

1. It has its own handler function in `taskflow-engine.ts` (separately named, not a branch inside another handler).
2. It has its own MCP tool name.
3. It has its own `task_history.action` value.
4. It has its own dedicated instruction block in `CLAUDE.md.template`.
5. It is triggered by a distinct user-visible phrase in `auditor-prompt.txt` or operator-facing output.

Sub-variants **collapse into one row** only when ALL of the following are true simultaneously:
- Same handler (<5 lines of branching between them).
- Same `task_history.action` value.
- Same user phrase.

Worked example (collapses): "move to in-progress" and "move to done" → one row. Shared `moveTask` handler, shared `moved` action, shared "move to <column>" phrasing.

Worked counter-example (does NOT collapse): "due date with explicit date" and "due date with business-day rounding" → two rows. Business-day rounding has its own logic branch even though both update `tasks.due_date`.

When the three conditions partly overlap, err on the side of TWO rows. It is cheaper to collapse during Phase 3 classification than to split after the probes are written.

Write to `/root/nanoclaw/data/audit/phase1-matrix-draft.md` as a markdown table with columns: `Feature | Area | Designed | Shipped | Docs-mentions`. Do NOT fill in `Prod evidence`, `Outcome signal`, `Docs expected`, `Status`, `Notes` yet — those come from Phase 2/3.

- [ ] **Step 2: Count rows and apply the matrix-split rule**

```bash
grep -c '^|' /root/nanoclaw/data/audit/phase1-matrix-draft.md
```

**Matrix-split rule (inlined from spec:102):** the estimate must fall in [40, 80]. The upper bound is load-bearing: more rows than 80 make the matrix unreviewable and the probe batch unwieldy.

- If `count > 80`: stop. Either (a) split the matrix by capability area into `docs/taskflow-feature-matrix/{area}.md` files with an index at `docs/taskflow-feature-matrix.md`, OR (b) tighten the granularity rule's collapse conditions and re-merge. Choose (a) if every area has 5+ rows; choose (b) if one area dominates and the other areas are sparse. The split decision MUST happen BEFORE Phase 2 probes are authored so Phase 2 does not have to be redone.
- If `count < 30`: granularity is too coarse. Re-apply the granularity rule more strictly — due-date, recurrence, and cross-board features are the usual under-splits. Re-merge and re-count.
- If `count` is in [30, 40): acceptable but lean toward splitting one or two densely-collapsed areas more finely.
- If `count` is in [40, 80]: proceed to Step 3.

Record the final row count in the matrix draft's leading comment so Phase 2 can cross-check.

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

For features not visible in `task_history` (e.g. meeting with external participant, board holidays, embeddings collection), probe the appropriate table directly. The real column names are pinned in `phase0-schema.txt` — cross-reference them before authoring any probe. For `meeting_external_participants` the columns are: `board_id, meeting_task_id, occurrence_scheduled_at, external_id, invite_status, invited_at, accepted_at, revoked_at, access_expires_at, created_by, created_at, updated_at` (NOT `task_id`, NOT `added_at`):

```sql
-- R0XX External participant in meeting
SELECT 'R0XX' AS id,
       COUNT(*) AS total,
       SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS last_30d,
       MAX(created_at) AS last_at
FROM meeting_external_participants;
```

Use ONLY tables and columns listed in `data/audit/phase0-schema.txt`. Any probe referencing a symbol outside the schema is rejected.

- [ ] **Step 2: Assign stable row IDs R001..R0NN**

Assign IDs in capability-area order (Tasks first, then Recurrence, Meetings, Auditor, Cross-board, Digest & standup, Media & attachments, Embeddings & search, External participants, Admin & config). Record the ID in both the draft matrix and the probe file as a leading comment.

- [ ] **Step 3: Author outcome signal probes**

For rows where "executed" ≠ "worked", add a secondary probe. The probe MUST reference only columns and action values that exist in `phase0-schema.txt`. Verified real columns in `task_history`: `board_id, task_id, action, by, at, details`. The `by` column is populated with the user's `sender_name` (passed into every `recordHistory(...)` call in `taskflow-engine.ts`) — it is NEVER `'auditor'`. The daily auditor (`container/agent-runner/src/auditor-script.sh`) is a read-only analyzer producing JSON; it does not write `task_history` rows at all. Do not invent an `'auditor'` actor value.

Examples:

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
-- R0XX-outcome: tasks with a due_date that has passed, still not moved to
-- `done` 48h later. Measures whether the due-date / overdue-surfacing flow
-- actually moves tasks to the done column, rather than merely recording a due
-- date.
--
-- Real column names (verified against phase0-schema.txt): `tasks.column`
-- (not `tasks.status` — there is no `status` column), with values
-- {inbox, next_action, in_progress, waiting, review, done}. Archived tasks
-- are MOVED to a separate `archive` table — they do not remain in `tasks`
-- with an `archived` column value. The "resolved" predicate here is therefore
-- simply `column = 'done'`, because archived tasks are not counted in
-- `tasks` at all and cancelled is not a column value.
SELECT 'R0XX-outcome' AS id,
       SUM(CASE WHEN column = 'done' THEN 1 ELSE 0 END) AS resolved,
       COUNT(*) AS overdue_48h
FROM tasks
WHERE due_date IS NOT NULL
  AND due_date < datetime('now','-48 hours');
```

For auditor-feature outcome probes specifically, the auditor leaves no trace in `task_history`. The only signal sources are (a) WhatsApp messages in `store/messages.db` (via the optional second SSH dispatch at Task 7 Step 2a) where the auditor's bot messages can be sampled, or (b) downstream user actions after an auditor run, correlated by time window. If neither signal is available, mark the row `executed-only` — do not fabricate an actor value.

Where no outcome signal is feasible, mark the row's `Outcome signal` column `executed-only` (no secondary probe). This is the correct treatment for features whose only trace is the primary action record.

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

- [ ] **Step 4b: Author `phase2-probes-messages.sql` only if any row needs it**

`store/messages.db` (WhatsApp message store) is the ONLY signal source for auditor-feature outcome probes and for a handful of other features whose user-visible trace is a bot-posted message, not a task_history row. Mixing the two DBs in one heredoc is forbidden by spec:217 — they need a separate file and a separate SSH invocation.

Walk the draft matrix. For any row whose `Outcome signal` requires sampling bot-posted messages (or whose evidence would otherwise be `executed-only`), author a messages-db probe here. Typical candidates:

- Auditor feature rows (daily auditor, DM detection, suggestion generation)
- Standup / digest rows that measure whether the bot actually posted the expected summary
- Reaction-feature rows if `store/messages.db` has a reactions table

The matrix file does not yet exist at this point in Phase 2 (it is written in Task 8 Step 5). Record the author/skip decision in a plain text marker file that Task 8 Step 5 later transcribes into the matrix's reproducibility anchor:

```bash
# Mark the decision for Task 8 Step 5 to read
mkdir -p /root/nanoclaw/data/audit
echo "decision: <AUTHORED|NOT AUTHORED>" > /root/nanoclaw/data/audit/phase2-messages-decision.txt
echo "reason: <brief reason, e.g. no row required store/messages.db evidence>" >> /root/nanoclaw/data/audit/phase2-messages-decision.txt
echo "row_count: <N or 0>" >> /root/nanoclaw/data/audit/phase2-messages-decision.txt
```

If NO row in the draft matrix needs a messages-db signal, skip the rest of this step. The marker file says `decision: NOT AUTHORED`. Task 7 Step 2a's existence check (`-s phase2-probes-messages.sql`) will then skip the dispatch. Task 8 Step 5 will read the marker file and include its contents in the matrix's reproducibility anchor block.

Otherwise, author the probes into the separate file:

```bash
cat > /root/nanoclaw/data/audit/phase2-probes-messages.sql <<'EOF'
.headers on
.mode tabs
-- Phase 2 messages-db probes batch, generated 2026-04-11
-- Pinned DB: /home/nanoclaw/nanoclaw/store/messages.db
-- Authored only for rows whose Outcome signal requires bot-message sampling.

<paste messages-db probes here, each prefixed with its R0XX id>

-- Sentinel
SELECT 'END-OF-BATCH-MESSAGES' AS id, 0 AS total, 0 AS last_30d, '-' AS last_at;
EOF
wc -l /root/nanoclaw/data/audit/phase2-probes-messages.sql
```

Update the marker file to reflect that the probes were authored:

```bash
cat > /root/nanoclaw/data/audit/phase2-messages-decision.txt <<EOF
decision: AUTHORED
row_count: <N>
dispatch_step: Task 7 Step 2a
EOF
```

Task 8 Step 5 MUST include this marker file's contents verbatim in the matrix's reproducibility anchor so the decision is auditable. (The template at Step 5 has a line `messages_db_probes: <paste contents of data/audit/phase2-messages-decision.txt>`.)

Static-check the messages probe file via Steps 5 and 6 below — both checks apply to it exactly as they apply to the main file; run them twice with the filename swapped. Note that the enum check (Step 5) only applies if a messages probe references `action` at all; `store/messages.db` has its own schema distinct from `taskflow.db`, so many messages probes won't have an `action` column to validate.

- [ ] **Step 5: Static-check every WHERE clause against the pinned enum**

The pinned enum lives in `phase0-schema.txt` as `action|count` lines (default sqlite3 pipe-delimited output from Step 9 of Task 1). The extractor must:

1. Strip `--` SQL comments before scanning, so commented-out action values don't show up as real references.
2. Collapse newlines inside `action IN (...)` lists so multi-line lists become single-line for the match step.
3. Find every line mentioning `action` in an `IN (...)` or `=` predicate and pull out *every* quoted value on that line — not just the first one.

Line-based grep alone will miss multiline `action IN (\n  'a',\n  'b'\n)` lists. The pipeline below normalizes whitespace with `tr` after stripping comments, then scans the normalized stream.

```bash
# 1. Strip SQL line comments
# 2. Collapse all whitespace (including newlines) to single spaces so IN() lists
#    that span multiple lines become one line for the grep step.
# 3. Break the stream on semicolons so each statement is one logical line.
# 4. Find every statement mentioning `action` in an IN(...) or = predicate.
# 5. Pull every quoted snake_case value from those statements.
sed -E 's;--[^\n]*$;;' /root/nanoclaw/data/audit/phase2-probes.sql \
  | tr '\n' ' ' \
  | tr ';' '\n' \
  | grep -iE "\baction\b[[:space:]]*(IN[[:space:]]*\(|=)" \
  | grep -oE "'[a-z_]+'" \
  | tr -d "'" \
  | sort -u \
  > /tmp/referenced-actions.txt

# Extract the pinned enum from Task 1 Step 9's output. Those lines look like
# `action_value|count`. The enum rows are the only lines in phase0-schema.txt
# whose first field is a bare snake_case identifier followed by `|`.
grep -E '^[a-z_]+\|[0-9]+' /root/nanoclaw/data/audit/phase0-schema.txt \
  | cut -d'|' -f1 \
  | sort -u \
  > /tmp/pinned-enum.txt

# Any referenced action must be in the pinned enum.
comm -23 /tmp/referenced-actions.txt /tmp/pinned-enum.txt
```

Expected: empty output (no lines). Any line means a probe references an action value that doesn't exist in prod — fix the probe before dispatch.

Sanity-check the extractor on three known-bad samples (single-line, multi-line, typo) before the real run:

```bash
# Single-line IN() — must capture both values
printf "WHERE action IN ('reparented','bogus_xyz');\n" \
  | sed -E 's;--[^\n]*$;;' \
  | tr '\n' ' ' | tr ';' '\n' \
  | grep -iE "\baction\b[[:space:]]*(IN[[:space:]]*\(|=)" \
  | grep -oE "'[a-z_]+'"
# Expected: 'reparented' and 'bogus_xyz'

# Multi-line IN() — must capture all three values
printf "WHERE action IN (\n  'approved',\n  'concluded',\n  'cancelled'\n);\n" \
  | sed -E 's;--[^\n]*$;;' \
  | tr '\n' ' ' | tr ';' '\n' \
  | grep -iE "\baction\b[[:space:]]*(IN[[:space:]]*\(|=)" \
  | grep -oE "'[a-z_]+'"
# Expected: 'approved', 'concluded', 'cancelled'

# Comment-guarded reference — must capture zero values
printf -- "-- WHERE action = 'should_not_match'\nSELECT 1;\n" \
  | sed -E 's;--[^\n]*$;;' \
  | tr '\n' ' ' | tr ';' '\n' \
  | grep -iE "\baction\b[[:space:]]*(IN[[:space:]]*\(|=)" \
  | grep -oE "'[a-z_]+'"
# Expected: (empty output)
```

If any of the three samples produces output different from the expected, the extractor is broken and must be fixed before the real run.

- [ ] **Step 6: Static-check for write statements**

Comments like `-- UPDATE example` and `-- INSERT a row` must NOT trigger a false positive. Strip comments before scanning:

```bash
sed -E 's;--.*$;;' /root/nanoclaw/data/audit/phase2-probes.sql \
  | grep -iE '(^|[^a-z_])(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH)[^a-z_]'
```

Expected: empty output. Any match is a write statement that must be removed. Sanity-check: run this pipeline against a synthetic input containing `-- INSERT example` and verify zero matches.

- [ ] **Step 7: Commit nothing (gitignored)**

---

## Task 7: Phase 2 — Dispatch probes via read-only SSH

**Files:**
- Create: `data/audit/phase2-results.tsv`

Run the pre-reviewed probe batch against prod, capture results.

- [ ] **Step 1: Define one dispatch string, regex-gate it, then eval it**

The original review found that an independent `CMD='…literal…'` variable is security theater: the literal string being regex-checked is hand-typed and not connected to the actual command that runs. Fix: store the dispatch command in a single bash variable, gate it through the allowlist regex, and only run it via `eval` if the gate passes. Any re-run uses the same variable — one source of truth, impossible to drift.

```bash
# ONE canonical dispatch string, used for both the regex check and execution.
DISPATCH_CMD='ssh -o BatchMode=yes nanoclaw@192.168.2.63 "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/data/taskflow/taskflow.db" < /root/nanoclaw/data/audit/phase2-probes.sql > /root/nanoclaw/data/audit/phase2-results.tsv 2>&1'

# Allowlist regex: must start with the canonical ssh/sqlite3-readonly shape.
# Any other shape is rejected — no sudo, no rm, no non-readonly sqlite3.
ALLOW_RE='^ssh -o BatchMode=yes nanoclaw@192\.168\.2\.63 "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/data/taskflow/taskflow\.db" < /root/nanoclaw/data/audit/phase2-probes\.sql > /root/nanoclaw/data/audit/phase2-results\.tsv 2>&1$'

if [[ "$DISPATCH_CMD" =~ $ALLOW_RE ]]; then
  echo "OK: dispatch shape matches allowlist"
else
  echo "REJECTED: dispatch shape does not match allowlist"
  echo "Got:      $DISPATCH_CMD"
  echo "Expected: $ALLOW_RE"
  exit 1
fi

# Defensive negative checks — none of these can appear in a safe dispatch.
for forbidden in 'rm ' 'sudo' 'systemctl' '--no-' '> /home/nanoclaw' 'scp ' 'rsync '; do
  if [[ "$DISPATCH_CMD" == *"$forbidden"* ]]; then
    echo "REJECTED: dispatch contains forbidden token: $forbidden"
    exit 1
  fi
done
echo "OK: dispatch has no forbidden tokens"
```

Expected: two `OK` lines. Export `DISPATCH_CMD` into the shell — Step 2 reuses it directly. If you need to re-run this task, re-define `DISPATCH_CMD` in the same way; do NOT hand-type the ssh command at the prompt.

- [ ] **Step 2: Run the batch**

Reuse `DISPATCH_CMD` from Step 1. `eval` it so the shell honors the redirections embedded in the string. Never retype the ssh command.

```bash
# Reuses $DISPATCH_CMD defined (and gated) in Step 1.
# If $DISPATCH_CMD is empty, the regex gate was not run — abort.
: "${DISPATCH_CMD:?DISPATCH_CMD unset; re-run Step 1 first}"
eval "$DISPATCH_CMD"
tail -5 /root/nanoclaw/data/audit/phase2-results.tsv
```

Expected: last row is `END-OF-BATCH   0   0   -` (the sentinel). If it's missing, a probe failed mid-batch — find the error and fix.

- [ ] **Step 2a: Optionally dispatch the messages-db probe batch**

Only run this step if Task 6 Step 4b authored `phase2-probes-messages.sql` for this audit run. If that file does not exist, skip to Step 3.

```bash
# Skip if the file was not authored
if [ ! -s /root/nanoclaw/data/audit/phase2-probes-messages.sql ]; then
  echo "SKIP: phase2-probes-messages.sql not authored; no messages-db dispatch"
else
  # Separate dispatch string, separate regex gate (different DB path).
  DISPATCH_MSG_CMD='ssh -o BatchMode=yes nanoclaw@192.168.2.63 "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/store/messages.db" < /root/nanoclaw/data/audit/phase2-probes-messages.sql > /root/nanoclaw/data/audit/phase2-results-messages.tsv 2>&1'
  ALLOW_MSG_RE='^ssh -o BatchMode=yes nanoclaw@192\.168\.2\.63 "sqlite3 -readonly -bail /home/nanoclaw/nanoclaw/store/messages\.db" < /root/nanoclaw/data/audit/phase2-probes-messages\.sql > /root/nanoclaw/data/audit/phase2-results-messages\.tsv 2>&1$'

  if [[ "$DISPATCH_MSG_CMD" =~ $ALLOW_MSG_RE ]]; then
    echo "OK: messages dispatch shape matches allowlist"
  else
    echo "REJECTED: messages dispatch shape"
    exit 1
  fi

  for forbidden in 'rm ' 'sudo' 'systemctl' '--no-' 'scp ' 'rsync '; do
    if [[ "$DISPATCH_MSG_CMD" == *"$forbidden"* ]]; then
      echo "REJECTED: messages dispatch contains forbidden token: $forbidden"
      exit 1
    fi
  done

  eval "$DISPATCH_MSG_CMD"
  tail -5 /root/nanoclaw/data/audit/phase2-results-messages.tsv
fi
```

Expected: either `SKIP:` line (no messages probes authored) OR last row is `END-OF-BATCH-MESSAGES   0   0   -`. If the sentinel is missing but the file exists, a messages probe errored mid-batch — find and fix.

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

Apply the derivation rule. Each bit is independent — conditions are **ORed** into the bitmap, never mutually exclusive. For each draft-matrix row, set each position to `1` (letter) if its condition is true, `0` (dot) otherwise. Bitmap order: `S C1 U O Q M T C2`.

| Position | Doc | Condition to set the bit |
|---|---|---|
| `S` | SKILL.md | The skill install advertises this feature (e.g. mentioned in "What it adds" / "Commands" / "Features" sections) |
| `C1` | skill CHANGELOG | The feature was added or changed inside the audit window (2026-02-24 → 2026-04-11) |
| `U` | user-manual | The feature is user-visible (every user-facing feature — this bit is effectively always set for user-visible rows) |
| `O` | operator-guide | Area is `Admin & config` OR it's an `Auditor` row with operator-tunable knobs |
| `Q` | quick-start | Row is in the top 20 by `total` from Phase 2 primary probe results |
| `M` | meetings-reference | Area is `Meetings` |
| `T` | CLAUDE.md.template | The in-container agent invokes this feature (handler is exposed as an MCP tool OR triggered by a user phrase the template tells the agent to handle) |
| `C2` | project CHANGELOG | The feature is user-facing AND was added or changed inside the audit window |

There are no mutual exclusions. A single row can have all 8 bits set simultaneously. If unsure whether a bit applies, default to setting it — Phase 4 will either match it against an existing doc mention or produce a `shipped-undocumented` entry for that specific bit.

- [ ] **Step 2: Compute `Docs present` per row from Agent C's output**

For each row, walk Agent C's feature list per doc file. If the feature appears in a doc, set that position in the bitmap.

- [ ] **Step 3: Assign `Status` per row**

Evaluation is **top-to-bottom, first match wins**. Broken is deliberately ranked above docs-stale / shipped-undocumented / in-sync so a feature that is simultaneously broken AND under-documented is classified `broken` (tripping the process gate in Step 4) — the doc edit waits.

Evaluate in this exact order:

| # | Condition | Status | Notes |
|---|---|---|---|
| 1 | `Shipped == ❌` AND `Designed != ad-hoc` | `designed-not-shipped` | plan exists, no landed code |
| 2 | `Shipped != ❌` AND `total > 0` AND outcome signal shows `failures > 50%` | `broken` | **process gate — see Step 4** |
| 3 | `Shipped != ❌` AND `total == 0` AND docs describe it | `docs-describe-missing` | docs describe unshipped behavior |
| 4 | `Shipped != ❌` AND `total > 0` AND `last_30d == 0` | `stale-in-prod` | dormant; informational, no edits |
| 5 | `Shipped != ❌` AND some doc describes the feature with wrong behavior | `docs-stale` | validated, but docs out of date |
| 6 | `Shipped != ❌` AND `(Docs expected & ~Docs present) != 0` AND matching doc is silent | `shipped-undocumented` | validated, needs doc additions |
| 7 | `Shipped != ❌` AND `Docs present == Docs expected` | `in-sync` | no action |

**Defining "failures > 50%"**: the outcome probe must itself declare its failure predicate in a comment. Examples: for `R037-outcome reparented tasks still present after 24h`, failures = `total_events - still_present` (a reparented task that vanished within 24h is a failed reparent). For the overdue-resolved example, failures = `overdue_48h - resolved` (an overdue task that stayed open is a failed resolution signal). If an outcome probe has no natural failure predicate, the row CANNOT be `broken` — use the earliest matching status in {3,4,5,6,7} instead.

**"validated"** is shorthand for `total > 0 AND outcome signal (if any) does not indicate broken`. A feature with zero prod evidence can never be `in-sync` or `shipped-undocumented` — it's either `docs-describe-missing` (row 3) or `stale-in-prod` (row 4) or `designed-not-shipped` (row 1).

**No mutual exclusions at the Docs-expected layer, but strict ordering here.** This is the asymmetry: bitmaps are unions; status is a single ordered scan.

- [ ] **Step 4: Handle broken rows first (process gate)**

For each row with status `broken`:

1. Open `/root/nanoclaw/docs/taskflow-feature-matrix.md` (creating it if needed with just a skeleton — anchor + empty table + empty "Broken features" section exactly as shown in Step 5 below, EXCEPT the per-area Tasks / Recurrence / Meetings / … sections are written as section headers only with an "_(populated in Step 5)_" placeholder underneath).
2. Append the broken row to the "Broken features" section with its note.
3. `git add /root/nanoclaw/docs/taskflow-feature-matrix.md` — and nothing else.
4. Commit: `git commit -m "docs(taskflow): record broken feature R0XX: <name>"`.
5. Continue classifying remaining rows.

Only after all broken rows are committed individually do we write the full matrix.

**Crucial ordering rule for Step 5 below:** Step 5 must **append** to (or edit in place) the file Step 4 already committed — it MUST NOT overwrite it. Specifically:

- The reproducibility anchor at the top was already committed in Step 4; Step 5 leaves it untouched.
- The "Broken features" section was populated in Step 4; Step 5 leaves those entries exactly as committed.
- Step 5's job is to populate the per-capability-area table sections (`## Tasks`, `## Recurrence`, etc.) that Step 4 stubbed out, and to add the "Plans excluded" and "Pre-audit doc SHAs" appendices.
- Never regenerate the matrix file from the Step 5 template as a single `cat >` or `Write` operation — that destroys the Step 4 content. Use per-section `Edit` calls instead.

If Step 4 never ran (no broken rows were found), Step 5 writes the full file from the template. In that case, the "Broken features" section is empty but still present.

- [ ] **Step 5: Write (or complete) the full matrix file**

Structure the file to match this template. If Step 4 committed a skeleton, leave the anchor, Docs legend, Status legend, and Broken features sections as-is and fill in only the missing per-area sections and appendices:

```markdown
# TaskFlow Feature Matrix

_Generated by the feature audit described in `docs/superpowers/specs/2026-04-11-taskflow-feature-audit-design.md`._

## Reproducibility anchor

<paste contents of data/audit/phase0-anchor.txt verbatim>
phase2_executed_at_utc: <ISO8601 from Phase 2 Step 2>
prod_taskflow_db_mtime_after_phase2: <from Phase 2 Step 3>
messages_db_probes: <paste contents of data/audit/phase2-messages-decision.txt>

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

## Phase 4 preamble — invariants that apply to every edit task (Tasks 9–17)

Before starting any Phase 4 edit task, these three invariants are in force and must be re-checked at the start of each task session.

**Preamble Check 1: dev_sha drift detection.** Phase 4 must run against a tree that only differs from Phase 0's `dev_sha` via the audit's own commits. If an EXTERNAL commit landed between Phase 0 and Phase 4 (someone merged an unrelated PR, a rebase happened), the matrix row `file:line` pointers may no longer resolve and the audit must abort.

This is **not** a `HEAD == dev_sha` equality check. After Phase 3, the matrix commit itself makes HEAD diverge from `dev_sha` by design; after the Phase 4 per-doc commits land, HEAD will be even further ahead. The check is: "every commit from `dev_sha` exclusive to `HEAD` inclusive must touch ONLY paths in the audit's allowlist." Any commit touching an engine source file or an unrelated area is external drift.

```bash
cd /root/nanoclaw
anchor_sha=$(grep '^dev_sha:' /root/nanoclaw/data/audit/phase0-anchor.txt | awk '{print $2}')
head_sha=$(git rev-parse HEAD)

if [ "$anchor_sha" = "$head_sha" ]; then
  echo "OK: HEAD == dev_sha ($head_sha) — Phase 4 has not started yet, no commits to audit"
else
  # Enumerate files touched by every commit in dev_sha..HEAD.
  # The allowlist is exactly the set of files this audit is permitted to commit:
  # the matrix, the drift report, and the 8 canonical doc files.
  allowed_re='^(docs/taskflow-feature-matrix\.md|docs/taskflow-drift-report\.md|\.claude/skills/add-taskflow/SKILL\.md|\.claude/skills/add-taskflow/CHANGELOG\.md|\.claude/skills/add-taskflow/templates/CLAUDE\.md\.template|docs/taskflow-user-manual\.md|docs/taskflow-operator-guide\.md|docs/taskflow-quick-start\.md|docs/taskflow-meetings-reference\.md|CHANGELOG\.md)$'

  drifted=$(git diff --name-only "$anchor_sha..$head_sha" | grep -vE "$allowed_re" || true)
  if [ -n "$drifted" ]; then
    echo "FAIL: external drift detected between dev_sha ($anchor_sha) and HEAD ($head_sha):"
    printf '  %s\n' $drifted
    echo "Abort Phase 4 and replay from Phase 0 — matrix row pointers may no longer resolve."
    exit 1
  fi
  echo "OK: all commits in dev_sha..HEAD touch only audit-allowlisted paths"
fi
```

If this check fails, abort Phase 4 and replay from Phase 0 — do NOT attempt to patch up the matrix against a different tree. If an external commit is detected, the matrix's `Shipped` column pointers (e.g., `taskflow-engine.ts:6163`) may refer to lines that moved or no longer exist.

Note on scope: this check measures the main working tree only. Spec:219's "worktree at `dev_sha`" mechanism (for engine-file lookups) is intentionally NOT used here — see Preamble Check 3. The drift-detection happens against `HEAD` on the primary branch.

**Preamble Check 2: engine-file lockout.** During Phase 4, `container/agent-runner/src/taskflow-engine.ts` and every other source file under `container/agent-runner/src/` is read-only-by-convention: the main agent MUST NOT open them. Every fact the edits need is already captured in the matrix row's `Notes`, `Shipped`, and `Outcome signal` columns (all of which Phase 1 Agent B populated). Violating this lockout is a methodology error that invalidates the audit.

Applies to Tasks 9, 10, 11, 12, 13, 14, 15, 16, 17 without exception. If a task's instructions seem to require opening an engine file, stop and escalate — the matrix row is incomplete and needs a Phase 1 re-dispatch, not a lockout bypass.

**Preamble Check 3: worktree decision.** The spec (`docs/superpowers/specs/2026-04-11-taskflow-feature-audit-design.md:219`) describes opening a git worktree at `dev_sha` for "engine-file lookups" during Phase 4. This plan resolves that sentence by enforcing Preamble Check 2 (engine-file lockout) as absolute: because no engine file is opened during Phase 4, no worktree is needed. Phase 1's Agent B captured all engine `file:line` pointers into the matrix, which is sufficient. If a future execution of this audit finds it genuinely needs an engine-file lookup, the worktree is the authorized mechanism — `git worktree add ../nanoclaw-audit-worktree $anchor_sha` — and using it voids the lockout only for that specific lookup, not for the edit itself.

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

First, re-run the Phase 4 preamble checks (dev_sha parity + engine-file lockout). Engine source files under `container/agent-runner/src/` must not be opened — use matrix row `Notes` / `Shipped` / `Outcome signal` columns as the source of truth.

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

First, re-run the Phase 4 preamble checks (dev_sha parity + engine-file lockout). Engine source files under `container/agent-runner/src/` must not be opened — use matrix row `Notes` / `Shipped` / `Outcome signal` columns as the source of truth.

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

First, re-run the Phase 4 preamble checks (dev_sha parity + engine-file lockout). Engine source files under `container/agent-runner/src/` must not be opened — use matrix row `Notes` / `Shipped` / `Outcome signal` columns as the source of truth.

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

First, re-run the Phase 4 preamble checks (dev_sha parity + engine-file lockout). Engine source files under `container/agent-runner/src/` must not be opened — use matrix row `Notes` / `Shipped` / `Outcome signal` columns as the source of truth.

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

First, re-run the Phase 4 preamble checks (dev_sha parity + engine-file lockout). Engine source files under `container/agent-runner/src/` must not be opened — use matrix row `Notes` / `Shipped` / `Outcome signal` columns as the source of truth.

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

First, re-run the Phase 4 preamble checks (dev_sha parity + engine-file lockout). Engine source files under `container/agent-runner/src/` must not be opened — use matrix row `Notes` / `Shipped` / `Outcome signal` columns as the source of truth.

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

For every row touched in Tasks 9–16, verify `Docs present == Docs expected` (bitwise equality). Only those rows are candidates for flipping to `in-sync`.

**Partial reconciliation rule (defensive fallback, NOT routine).** This rule exists for Phase-4-discovered execution blockers only — situations where a doc bit is still genuinely expected but the edit is blocked or out-of-scope. If a row was touched but its `Docs present` still has bits missing that `Docs expected` requires for one of the reasons below, leave the `Status` as its prior value (`shipped-undocumented` / `docs-stale`) and add a one-line Note explaining the skip. Only rows with fully-satisfied bitmaps become `in-sync`.

**Allowed reasons to leave a bit unsatisfied:**

- **Editorial decline.** The operator-guide maintainer (or another doc owner) rejected the edit because it duplicates content in another section. The `O` bit was legitimately expected; the edit didn't land; record: `"Partially reconciled: O bit declined as duplicative of §<section-name>"`.
- **Non-goal block.** The edit would require translating existing content, which is an explicit non-goal per `docs/superpowers/specs/2026-04-11-taskflow-feature-audit-design.md:36`. Example: quick-start is edited in English, but the corresponding user-manual paragraph needs Portuguese translation outside the audit's scope. Record: `"Partially reconciled: U bit deferred — Portuguese translation is a non-goal (spec:36)"`.

**Forbidden uses of this fallback.** The rule is NOT a license to skip reconciliation when the underlying matrix logic was wrong. If the executor discovers during Phase 4 that:

- `Docs expected` contains a bit that should never have been set (e.g., a row marked Q but not actually top-20 by `total`), or
- A row should have been split or merged at Phase 1 granularity time, or
- The area classification is wrong, or
- The `Docs expected` derivation rule (Task 8 Step 1) was misapplied,

then this is a **classification error upstream**, not a partial-reconciliation case. Stop the current Phase 4 task, correct the matrix logic or replay the earlier phase that made the mistake, and then resume. Do NOT use the Notes column to paper over the defect.

The distinction is load-bearing: partial-reconciliation preserves the matrix's ability to surface genuine doc gaps in a future audit. Using it to hide derivation mistakes does the opposite — it records a false-green signal that a later audit will believe.

- [ ] **Step 2: Verify no other rows changed**

```bash
cd /root/nanoclaw
git diff docs/taskflow-feature-matrix.md | grep -E '^[+-]' | head -50
```

Expected: only Status-column flips, bitmap updates, Notes appendages, and the post_audit_sha line (Step 3 below). No structural changes.

- [ ] **Step 3: Record `post_audit_sha` in the matrix anchor**

Spec:246 requires the close-out commit to record the post-audit SHA so a future audit can see exactly which tree this one completed against. Amend the reproducibility anchor block at the top of the matrix file to add a `post_audit_sha` field. This field is computed AFTER the per-doc commits land and BEFORE the close-out commit lands — it records the SHA of the last per-doc commit (i.e. the SHA about to become the close-out commit's parent).

```bash
cd /root/nanoclaw
post_sha=$(git rev-parse HEAD)
# Append to the reproducibility anchor block in docs/taskflow-feature-matrix.md.
# The anchor block is fenced by the "## Reproducibility anchor" heading. Insert
# the post_audit_sha line right before the "## Docs bitmap legend" heading.
awk -v sha="$post_sha" '
  /^## Docs bitmap legend/ && !inserted { print "post_audit_sha: " sha; print ""; inserted = 1 }
  { print }
' docs/taskflow-feature-matrix.md > docs/taskflow-feature-matrix.md.new
mv docs/taskflow-feature-matrix.md.new docs/taskflow-feature-matrix.md
grep '^post_audit_sha:' docs/taskflow-feature-matrix.md
```

Expected: one line printed showing `post_audit_sha: <sha>` where `<sha>` is the current HEAD. If the grep returns nothing, the awk insertion target didn't match — verify that the matrix still has the exact heading `## Docs bitmap legend`.

- [ ] **Step 4: Commit**

```bash
cd /root/nanoclaw
git add docs/taskflow-feature-matrix.md
git commit -m "$(cat <<'EOF'
docs(taskflow): feature matrix audit 2026-04-11 (phase 4 close-out)

Flips fully-reconciled rows to in-sync after per-doc commits in
tasks 9-16. Partially-reconciled rows retain their prior status
with a Notes explanation. Records post_audit_sha in the
reproducibility anchor block per spec:246.

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
- **Prod-safety gate** → Task 1 (verify DB path + `-readonly`), Task 6 Steps 5/6 (static-check enum + write statements), Task 7 Steps 1/2 (single `DISPATCH_CMD` variable regex-gated and `eval`ed).
- **Phase 0 pre-flight** → Task 1, including Step 13b placeholder validator.
- **Phase 1 parallel subagents** → Tasks 2, 3, 4 dispatched in parallel, then Task 5 merges. Agent A (Task 2) has budget discipline + optional A1/A2 split; Agent B (Task 3) has Grep-first constraint on `taskflow-engine.ts`.
- **Granularity rule + row-count split** → Task 5 Steps 1–2 (rule inlined from spec:90-102, no pointer-only reference).
- **Citation spot-check** → Task 5 Step 3.
- **Phase 2 pre-assembled probes** → Task 6, including Step 4b conditional messages-db probe file.
- **Phase 2 dispatch** → Task 7 Steps 1–2 (taskflow.db) and Step 2a (optional messages.db).
- **Phase 3 classification** → Task 8 (decision table is ordered top-to-bottom, first-match-wins, with `broken` ranked above other statuses).
- **Broken-feature process gate** → Task 8 Step 4 (commit matrix row before any other file). Evaluation ordering in Step 3 ensures `broken` is matched before `shipped-undocumented`/`docs-stale`/`in-sync`.
- **Docs expected bitmap** → Task 8 Steps 1–2 (bits are ORed, no mutual exclusions).
- **Six status values** → Task 8 Step 3 decision table with precedence rules.
- **Phase 4 one-commit-per-doc** → Tasks 9–16.
- **Engine-file lockout in Phase 4** → Phase 4 preamble (between Task 8 and Task 9) + reminder paragraph at the start of each Task 9–16 Step 3 ("Make edits" / "Add entries"). Lockout applies to all eight Phase 4 tasks plus Task 17.
- **Phase 4 dev_sha assertion** → Phase 4 preamble Check 1.
- **Phase 4 worktree decision** → Phase 4 preamble Check 3 (worktree explicitly not used; lockout makes it unnecessary).
- **`Matrix-rows:` commit trailer** → Every Phase 4 task commit message.
- **Phase 4 close-out** → Task 17 Steps 1–4. Step 1 has a partial-reconciliation rule; Step 3 records `post_audit_sha` in the matrix anchor per spec:246.
- **Phase 5 cross-doc invariants** → Task 18.
- **Phase 5 drift reports** → Task 19.
- **Phase 6 summary** → Task 20.
- **Reproducibility anchor** → Task 1 Step 13 writes initial anchor, Task 1 Step 13b validates no unfilled placeholders, Task 2 Step 1d backfills `plans_included`/`plans_excluded`, Task 8 Step 5 transcribes into matrix, Task 17 Step 3 appends `post_audit_sha`.

## Placeholder scan

Every task step contains executable commands or concrete content. No "TBD", no "add appropriate handling", no "similar to task N". Code/markdown bodies are shown in full where the engineer writes content. The only fillable placeholders are row IDs (`R0XX`) in commit message examples, which must be replaced with the actual IDs from Task 5 at execution time.

## Type consistency

- Capability area names consistent across tasks (10 areas, same list every time).
- Status values consistent (6 values) throughout.
- Bitmap column order consistent (`S C1 U O Q M T C2`) in every reference.
- Phase numbering consistent (0–6) across plan, spec, and commit messages.
- Row ID format consistent (`R0XX`) in all references.
