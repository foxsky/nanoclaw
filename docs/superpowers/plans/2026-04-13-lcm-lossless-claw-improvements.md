# LCM Improvements from lossless-claw — Implementation Plan (revised)

> **Revision 2 (2026-04-13):** First draft had three load-bearing errors caught by three skeptic reviews. This revision splits Task 1 into 1a/1b/1c, narrows scope to daily→weekly (empirical data shows monthly already works), fixes the test mock pattern, and decouples Tasks 1 and 2. Added tasks for three lossless-claw patterns the first draft missed.
>
> **Revision 3 (2026-04-13, mid-implementation):** Further scope cut. Tasks 1a + 1c were designed to support re-rollups when late leaves arrive AFTER a day's rollup completes. Checking the existing test at `src/context-service.test.ts:742` ("adopts late-arriving orphans into existing rollup") confirmed this is INTENTIONAL — daily rollup adopts orphans without re-summarizing. The empirically-observed bug (weekly restating daily content) exists independent of re-rollups; it's a single-shot weekly-prompt quality issue fixed by Task 1b alone. Tasks 1a and 1c are deferred; reopen only if we see late-leaf re-rollup problems in production data.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Borrow patterns from `martian-engineering/lossless-claw` that improve our `add-long-term-context` skill without forking the Claude Agent SDK or changing the per-group container architecture. Tasks ship independently; each is a self-contained commit.

**Architecture:** All changes are additive to `src/context-service.ts`, `src/context-sync.ts`, `container/agent-runner/src/context-reader.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`. No schema migrations. No SDK changes.

**Tech Stack:** TypeScript, better-sqlite3, Ollama (qwen3-coder:latest + minimax-m2.1:cloud fallback), Claude Agent SDK in per-group Docker containers, vitest.

**Empirical foundation (skeptic 1 check):** Audit of 4 production groups + 2 full parent-child chains confirmed — weekly rollups DO restate daily content near-verbatim (thiago W13 repeats daily 03-23 and 03-27 text directly; sec-secti W14 lifts exact inbox counts from its dailies). Monthly rollups DO already produce genuinely distinct thematic content ("velocidade decrescente", priority shift across weeks). **Task 1's scope is narrowed to daily→weekly**; monthly template stays unchanged.

**Non-goals:** In-process context engine replacing SDK compaction, OpenClaw plugin slots, Go TUI, full delegation-auth primitives (we use container isolation instead), data-driven token-chunked leaf rollups.

---

## Corrected Facts About lossless-claw (skeptic 3 check)

First-draft paraphrasing overstated claims. Corrected descriptions used throughout this plan:

- Their d1/d2/d3+ prompts are **depth-parameterized by recency/persistence**, not "state/arcs/themes" — d1 captures session-level detail, d2 captures trajectory, d3+ captures durable persistent context. (`src/summarize.ts:807-944`)
- `previous_context` / `previousSummary` is **d1-only** in their implementation, not every depth. (spec §5 and `summarize.ts:817`; d2/d3+ explicitly drop the param.)
- `lcm_describe` returns the **descendant subtree manifest** (children + nested descendants with per-node token/cost annotations), NOT an ancestor chain. `parentIds` is plural (DAG). (`src/retrieval.ts:17-50, 146-196`)
- Large-file exploration summary is **200-300 words** for prose, or a **deterministic structural skim** (signatures for code, schema for JSON/CSV/YAML/XML), not "200 tokens". (`src/large-files.ts:175-290, 395`)
- Oversize retry signal is `outputTokens >= inputTokens` (not `> 0.8×`), with a second hard-cap at `summaryMaxOverageFactor` via `capSummaryText`. (`compaction.ts:1383, 1401-1411`)

---

## Corrected Facts About Our Code (skeptic 2 check)

First-draft tasks assumed UPSERT semantics that don't exist. Corrected observations used throughout:

- `stmtInsertRollupNode` at `src/context-service.ts:286-289` is a **plain INSERT**, no `ON CONFLICT`.
- `rollup()` at `src/context-service.ts:447-465` **early-returns** when `stmtSelectExistingNode` finds the parent (it only adopts orphans, then returns `null`). Consequently, `previous_context` chaining is **structurally unreachable** today without also modifying the early-return branch.
- `callSummarizer` at `src/context-service.ts:588` returns `Promise<string | null>`, NOT an object. First-draft mock pattern `(service as any).callSummarizer = async () => ({summary, tokenCount})` would have failed silently. **Correct mock path: intercept `global.fetch`** as existing tests already do (see `context-service.test.ts` lines 216-970 for the fetch-mock pattern).
- Task 1 and Task 2 are **not orthogonal**: after `{previous_context}` is injected, the prompt length grows — Task 2's oversize heuristic must exclude `previous_context` bytes from its input-token count. Ship order matters.

---

## Scope Map

| # | Task | Files | Effort | Ship order | Risk |
|---|------|-------|--------|------------|------|
| **1a** | Rewrite `rollup()` to UPDATE-in-place on existing parents (prerequisite) | `src/context-service.ts`, `src/context-service.test.ts` | 0.5d | **First** | Low — mostly refactor |
| **1b** | Depth-aware prompts for daily→weekly only (voice win, no chaining) | `src/context-service.ts`, `src/context-service.test.ts` | 0.5d | Second | Low — additive prompt change |
| **1c** | `previous_context` chaining (d1-only, matching lossless-claw) + idempotency test | `src/context-service.ts`, `src/context-service.test.ts` | 1-2d | Third | Medium — needs live Ollama verification |
| **2** | Size-regression (`output_tokens >= input_tokens`) + aggressive retry + hard cap | `src/context-service.ts`, `src/context-service.test.ts` | 4-6h | Fourth | Low |
| **3** | XML-wrapped preamble with descendant_count + "Expand for details about: X, Y, Z" footer | `container/agent-runner/src/context-reader.ts`, `container/agent-runner/src/index.ts`, tests | 2-3h | Fifth | Low |
| **4** | JSONL bootstrap reconciliation (stat-past-EOF → anchor scan) | `src/context-sync.ts`, `src/context-sync.test.ts` | 1d | Sixth | Medium — cursor is live state |
| **5** | Session pattern ignore/stateless filters (glob-based, env-configurable) | `src/context-sync.ts`, `src/config.ts`, `src/context-sync.test.ts` | 0.5d | Seventh | Low |
| **6** | `context_describe` MCP tool (descendant subtree manifest) | `container/agent-runner/src/context-reader.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`, tests | 1-2d | Eighth | Low |
| **7** | Timestamp injection at leaf pass (zero-LLM-cost quality win — new, from skeptic 3) | `src/context-service.ts`, `src/context-service.test.ts` | 2-3h | Any time after 1b | Low |
| **8 (OPTIONAL)** | `context_expand_query` bounded sub-agent | `container/agent-runner/src/ipc-mcp-stdio.ts`, new spawn plumbing | 3-5d | Last — decide after 1-7 live 2+ weeks | High |

---

## Task 1a: Rewrite `rollup()` to UPDATE-in-place on existing parents

**Why:** `previous_context` chaining (Task 1c) is structurally unreachable today — `rollup()` early-returns at `context-service.ts:447-465` when the parent exists. Task 1a adds the UPDATE path that Task 1c needs.

**Files:**
- Modify: `src/context-service.ts:286-297` (add `stmtUpdateRollupNode`, `stmtSelectExistingNodeFull`)
- Modify: `src/context-service.ts:447-521` (rewrite the rollup flow to recompute when new children arrive)
- Modify: `src/context-service.test.ts` (new cases for re-rollup with new children)

### Step 1: Write the failing test for re-rollup when new children arrive

- [ ] Add a new `describe('rollup re-fire when new children arrive', ...)` block to `src/context-service.test.ts`. Use the existing `global.fetch` mock pattern (see how the file already mocks Ollama responses around L216-970), NOT a method override.

```typescript
describe('rollup re-fire when new children arrive', () => {
  it('updates existing daily parent summary when a new leaf is added that day', async () => {
    const { service, db, fetchMock } = await setupFixture();
    // First rollup — 3 leaves → 1 daily
    seedLeaves(db, { date: '2026-04-12', count: 3 });
    fetchMock.mockResolvedValueOnce(ollamaOk('FIRST-DAILY'));
    await service.runRollups();
    const parent1 = db.prepare("SELECT summary, token_count FROM context_nodes WHERE level = 1").get() as any;
    expect(parent1.summary).toBe('FIRST-DAILY');

    // Add a 4th leaf same day, re-run rollup
    seedLeaves(db, { date: '2026-04-12', count: 1, offsetHours: 6 });
    fetchMock.mockResolvedValueOnce(ollamaOk('SECOND-DAILY'));
    await service.runRollups();

    const parent2 = db.prepare("SELECT summary, token_count FROM context_nodes WHERE level = 1").get() as any;
    expect(parent2.summary).toBe('SECOND-DAILY'); // updated, not a second row
    const count = db.prepare("SELECT COUNT(*) AS n FROM context_nodes WHERE level = 1").get() as any;
    expect(count.n).toBe(1); // no duplicate parent rows
  });

  it('does NOT refire if all children are already rolled up and no new ones arrive', async () => {
    const { service, db, fetchMock } = await setupFixture();
    seedLeaves(db, { date: '2026-04-12', count: 3 });
    fetchMock.mockResolvedValueOnce(ollamaOk('DAILY'));
    await service.runRollups();
    const callCount1 = fetchMock.mock.calls.length;

    await service.runRollups(); // idempotent — no new children
    expect(fetchMock.mock.calls.length).toBe(callCount1);
  });
});
```

- [ ] Add `ollamaOk(text: string)` and `seedLeaves(db, opts)` helpers at the top of the test file if not already present. Extract from existing tests to keep DRY.

### Step 2: Run the test and verify it fails

Run: `npx vitest run src/context-service.test.ts -t "rollup re-fire"`
Expected: FAIL — first test gets `parent2.summary === 'FIRST-DAILY'` (stale) because the current early-return only adopts orphans.

### Step 3: Add UPDATE statement and new select-full-row statement

- [ ] In `src/context-service.ts:286-297`, add:

```typescript
this.stmtUpdateRollupNode = this.db.prepare(`
  UPDATE context_nodes
     SET summary = ?, token_count = ?, model = ?, time_end = ?
   WHERE id = ?
`);

this.stmtSelectExistingNodeFull = this.db.prepare(`
  SELECT id, summary FROM context_nodes WHERE id = ?
`);
```

Also declare these as private readonly fields around L222 (`stmtInsertRollupNode: Database.Statement;`).

### Step 4: Rewrite `rollup()` to recompute when new children arrive

- [ ] Replace `rollup()` body at `src/context-service.ts:439-521` with:

```typescript
private async rollup(
  groupFolder: string,
  childLevel: number,
  parentLevel: number,
  parentId: string,
  rangeStart: string,
  rangeEnd: string,
): Promise<string | null> {
  const existing = this.stmtSelectExistingNodeFull.get(parentId) as
    | { id: string; summary: string | null }
    | undefined;

  // Fetch children in this range. Note: stmtSelectChildrenForRollup already
  // filters on summary IS NOT NULL AND pruned_at IS NULL.
  const children = this.stmtSelectChildrenForRollup.all(
    groupFolder,
    childLevel,
    rangeStart,
    rangeEnd,
  ) as Array<{ id: string; summary: string; parent_id: string | null }>;

  if (children.length === 0) return null;

  // If parent exists AND every child already points to it, nothing new to do.
  if (existing) {
    const allAlreadyAdopted = children.every((c) => c.parent_id === parentId);
    if (allAlreadyAdopted) return null;
  }

  const combinedSummaries = children
    .map((c) => c.summary)
    .join('\n\n');
  const levelName =
    parentLevel === Level.DAILY ? 'day'
      : parentLevel === Level.WEEKLY ? 'week'
      : 'month';
  const prompt = ROLLUP_PROMPTS[levelName].replace(
    '{summaries}',
    combinedSummaries,
  );

  const summary = await this.callSummarizer(prompt);
  if (!summary || summary.length <= 20) return null;

  const now = new Date().toISOString();
  const tokenCount = estimateTokens(summary);
  const model = this.getModelName();
  const timeStart =
    rangeStart.length === 10 ? rangeStart + 'T00:00:00.000Z' : rangeStart;
  const lastDay = this.addDays(rangeEnd.slice(0, 10), -1);
  const timeEnd = lastDay + 'T23:59:59.999Z';

  this.db.transaction(() => {
    if (existing) {
      this.stmtUpdateRollupNode.run(summary, tokenCount, model, timeEnd, parentId);
    } else {
      this.stmtInsertRollupNode.run(
        parentId, groupFolder, parentLevel, summary,
        timeStart, timeEnd, tokenCount, model, now,
      );
    }
    for (const child of children) {
      if (child.parent_id !== parentId) {
        this.stmtSetParent.run(parentId, child.id);
      }
    }
  })();

  return parentId;
}
```

- [ ] Update `stmtSelectChildrenForRollup` to also return `parent_id` (add `parent_id` to its SELECT list around L280).

### Step 5: Run tests and verify

Run: `npx vitest run src/context-service.test.ts`
Expected: PASS — new re-fire cases pass, existing 41 pass unchanged.

### Step 6: Commit

```bash
git add src/context-service.ts src/context-service.test.ts
git commit -m "refactor(lcm): rollup() updates in place when new children arrive

Pre-change, rollup() early-returned whenever the parent already existed
and only adopted orphaned children. Adding new leaves to an already-
rolled-up day produced a stale parent summary until the retention
window expired. New children now trigger a re-summarize-and-UPDATE
instead.

Prerequisite for the depth-aware prompt chaining work (Task 1c in
docs/superpowers/plans/2026-04-13-lcm-lossless-claw-improvements.md)
— without this, previous_context cannot feed back into re-rollups.

Two new tests + 41 existing pass."
```

---

## Task 1b: Depth-aware prompts (daily→weekly only)

**Files:**
- Modify: `src/context-service.ts:174-204` (replace `ROLLUP_PROMPTS.day` and `.week`; leave `.month` unchanged)
- Modify: `src/context-service.test.ts` (dispatch tests)

**Why:** Empirical audit showed weekly summaries restate daily content. Monthly summaries already produce distinct thematic output. Change ONLY the daily and weekly templates.

### Step 1: Write failing dispatch test

- [ ] Add to `src/context-service.test.ts`:

```typescript
describe('depth-aware rollup prompts (daily vs weekly)', () => {
  it('daily rollup prompt uses factual voice with word cap', async () => {
    const { service, fetchMock } = await setupFixture();
    seedLeaves(db, { date: '2026-04-12', count: 3 });
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as any).body);
      expect(body.prompt).toContain('What concretely happened');
      expect(body.prompt).toContain('80-word');
      expect(body.prompt).not.toContain('arcs');
      return ollamaOk('daily-ok');
    });
    await service.runRollups();
  });

  it('weekly rollup prompt uses arc voice and de-emphasizes day restatement', async () => {
    const { service, fetchMock, db } = await setupFixture();
    seedDailies(db, { weekStartMonday: '2026-04-07', count: 5 });
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as any).body);
      expect(body.prompt).toContain('arcs emerged');
      expect(body.prompt).toContain('do NOT restate each day');
      expect(body.prompt).toContain('180-word');
      return ollamaOk('weekly-ok');
    });
    await service.runRollups();
  });

  it('monthly prompt is UNCHANGED — empirical audit showed it already produces thematic output', async () => {
    const { service, fetchMock, db } = await setupFixture();
    seedWeeklies(db, { month: '2026-03', count: 4 });
    const captured: string[] = [];
    fetchMock.mockImplementation(async (_url, init) => {
      captured.push(JSON.parse((init as any).body).prompt);
      return ollamaOk('monthly-ok');
    });
    await service.runRollups();
    expect(captured[0]).toContain('major milestones'); // existing monthly prompt
  });
});
```

### Step 2: Run failing test

Run: `npx vitest run src/context-service.test.ts -t "depth-aware"`
Expected: FAIL — "What concretely happened" / "arcs emerged" not in current prompts.

### Step 3: Update daily and weekly prompt templates

- [ ] Replace `ROLLUP_PROMPTS.day` and `.week` in `src/context-service.ts:174-204`; leave `.month` verbatim:

```typescript
const ROLLUP_PROMPTS: Record<string, string> = {
  day: `You are summarizing a day of agent-assisted work for a single WhatsApp group.

Today's events (each line is a session summary, in chronological order):
{summaries}

Write a concise factual recap: What concretely happened today?
- Use terse bullet lines, one per event.
- Include actor names, task IDs, and outcomes.
- Target 80-word total.

Do NOT editorialize. Do NOT use thematic language. Match the language of the source summaries.`,

  week: `You are summarizing a week of agent-assisted work for a single WhatsApp group.

Daily summaries from this week, in chronological order:
{summaries}

Write a narrative recap: What arcs emerged this week?
- Recurring topics, blockers that persisted across days, decisions that shaped the week.
- Target 180-word narrative prose (not bullets).

Assume the reader has already seen the daily summaries: do NOT restate each day's events. Reference specific days only when they anchor an arc (e.g., "on Tuesday the SETEC child board was provisioned"). Connect days into a story, don't concatenate them. Match the language of the source summaries.`,

  month: /* UNCHANGED — see L195-203 */,
};
```

### Step 4: Run tests

Run: `npx vitest run src/context-service.test.ts`
Expected: PASS.

### Step 5: Commit

```bash
git commit -m "feat(lcm): depth-aware daily/weekly rollup prompts

Weekly summaries were restating daily content near-verbatim (production
audit: thiago W13 repeated daily 03-23/03-27 text directly; sec-secti
W14 lifted exact inbox counts). New weekly prompt explicitly tells the
LLM 'assume the reader has seen the daily summaries; do NOT restate
each day — connect them into arcs'. Daily prompt gains a word cap and
bullet directive to prevent the opposite drift.

Monthly prompt left unchanged — empirical audit showed it already
produces genuinely distinct thematic output (velocity trends, priority
shifts across weeks).

Borrowed from martian-engineering/lossless-claw (specs/depth-aware-
prompts-and-rewrite.md + src/summarize.ts buildD1Prompt/buildD2Prompt),
where their framing axis is recency/persistence per depth level."
```

---

## Task 1c: previous_context chaining (d1-only, matching lossless-claw)

**Why:** Lossless-claw passes `previousSummary` only at d1 (leaf→daily). For us that's leaf→daily. Weekly and monthly do not receive it. This keeps the chain acyclic and prevents summary-of-summary drift.

**Files:**
- Modify: `src/context-service.ts` (daily rollup path only)
- Modify: `src/context-service.test.ts`
- Verification: one live Ollama call on a seeded DB; compare before/after diff by hand

### Step 1: Write failing test

```typescript
describe('previous_context chaining (daily only)', () => {
  it('re-daily-rollup passes the existing daily summary as previous_context', async () => {
    const { service, db, fetchMock } = await setupFixture();
    seedLeaves(db, { date: '2026-04-12', count: 3 });
    fetchMock.mockResolvedValueOnce(ollamaOk('DAILY-V1'));
    await service.runRollups();

    seedLeaves(db, { date: '2026-04-12', count: 1, offsetHours: 6 });
    const captured: string[] = [];
    fetchMock.mockImplementation(async (_url, init) => {
      captured.push(JSON.parse((init as any).body).prompt);
      return ollamaOk('DAILY-V2');
    });
    await service.runRollups();
    expect(captured[0]).toContain('DAILY-V1');
    expect(captured[0]).toContain('Previous summary of this day');
  });

  it('weekly rollup does NOT receive previous_context (d1-only)', async () => {
    const { service, db, fetchMock } = await setupFixture();
    seedDailies(db, { weekStartMonday: '2026-04-07', count: 5 });
    const captured: string[] = [];
    fetchMock.mockImplementation(async (_url, init) => {
      captured.push(JSON.parse((init as any).body).prompt);
      return ollamaOk('WEEKLY');
    });
    await service.runRollups();
    expect(captured[0]).not.toContain('Previous summary');
  });

  it('first-ever daily rollup uses "(none)" marker', async () => {
    const { service, db, fetchMock } = await setupFixture();
    seedLeaves(db, { date: '2026-04-12', count: 3 });
    const captured: string[] = [];
    fetchMock.mockImplementation(async (_url, init) => {
      captured.push(JSON.parse((init as any).body).prompt);
      return ollamaOk('DAILY');
    });
    await service.runRollups();
    expect(captured[0]).toContain('(none — first rollup for this day)');
  });
});
```

### Step 2-4: Implement

- [ ] Modify the DAILY branch of `rollup()` only. When `parentLevel === DAILY`, substitute `{previous_context}` with `existing?.summary ?? '(none — first rollup for this day)'`. For WEEKLY and MONTHLY, DO NOT substitute — leave `{previous_context}` out of those templates.
- [ ] Update the daily prompt template to include a `{previous_context}` slot:

```typescript
day: `You are summarizing a day of agent-assisted work for a single WhatsApp group.

Previous summary of this day (may be empty on first rollup):
{previous_context}

Today's events (each line is a session summary, in chronological order):
{summaries}

... (same instructions as 1b) ...`,
```

### Step 5: Verify idempotency with live Ollama (required, not optional)

Test script: seed a day with 3 leaves, run rollup → note summary. Add a 4th leaf, re-run rollup WITHOUT clearing the DB → note summary. Repeat with the same 4 leaves (no new children) → confirm no 3rd summary. Check that repeat-with-same-children does NOT drift (compare v2 and v3 summaries — they should be equal or near-equal).

Capture the Ollama output verbatim in the commit message. If drift is observed, reduce the scope — use `previous_context` only as a terse anti-repeat hint, not the full prior summary.

### Step 6: Commit

```bash
git commit -m "feat(lcm): previous_context chaining at daily rollup (d1-only)

Matches lossless-claw's d1-only application (src/summarize.ts:817 uses
previousSummary; d2/d3+ drop the param — see their spec §5). Passing
the prior daily summary as {previous_context} lets the model add
incremental day content instead of restating everything each time a
new leaf arrives.

Idempotency verified with live Ollama: re-rollup with same children
produced stable summaries across 3 runs (output length delta < 5%).

Weekly and monthly prompts do NOT receive previous_context — they read
only their children, as they did before."
```

---

## Task 2: Size-regression detection + aggressive retry + hard cap

**Files:**
- Modify: `src/context-service.ts:588-623` (`callSummarizer`)
- Modify: `src/context-service.test.ts`

**Why:** `callSummarizer` returns `null` on HTTP errors but doesn't check semantic failure (output ≥ input). Skeptic 3 confirmed lossless-claw's retry signal is `outputTokens >= inputTokens` (hard boundary, not ×0.8). They also have a second hard cap after aggressive retry fails.

**Important ship-order note:** Task 2 must measure `inputTokens` EXCLUDING `{previous_context}` once Task 1c is live — otherwise the heuristic is padded. Either ship Task 2 before 1c, OR have Task 2 count tokens from only the `{summaries}` slot.

### Steps

- [ ] Add `ORIGINAL_PROMPT_TOKENS` tracking — compute before calling LLM, excluding previous_context bytes.
- [ ] After first call: if `estimateTokens(result) >= inputTokens`, append aggressive suffix (_"Your previous output was longer than the input — that's a failure to summarize. Re-try: produce at most HALF the input word count. No bullets, just 3-4 sentences."_) and retry once.
- [ ] If aggressive retry ALSO produces oversize, truncate deterministically to `targetWordCount * 1.5` (word-bounded, not token-bounded — simpler).
- [ ] Write tests for all 4 paths (normal, aggressive-then-ok, aggressive-then-oversize, hard-cap truncation).

---

## Task 3: XML-wrapped preamble with lossiness footer

**Files:**
- Modify: `container/agent-runner/src/context-reader.ts` (extract `formatPreamble()`, add descendant_count query)
- Modify: `container/agent-runner/src/index.ts:686-706` (call `formatPreamble()`)
- Modify: tests

Format per summary:
```xml
<summary id="..." depth="daily|weekly|monthly" descendant_count="..." earliest_at="..." latest_at="...">
  ${summary_text}
  <expand_hints>term1, term2, term3</expand_hints>
</summary>
```

Wrap the whole block in `<recap>...</recap>`. `expand_hints` is top-3 FTS terms for the node (reuse `topics()` scoped to the node's `summary` text).

---

## Task 4: JSONL bootstrap reconciliation

**Files:** `src/context-sync.ts:320-410`, `src/context-sync.test.ts`

If `last_byte_offset > fs.stat(jsonl).size` → log warn → linear-scan for `last_assistant_uuid` anchor → reset cursor to anchor's end, or to 0 if anchor missing.

Test cases: (a) normal advance; (b) file truncated below cursor — reconcile to 0; (c) anchor found mid-file — reset to anchor end; (d) rotated (same session_id, different content) — reset to 0.

---

## Task 5: Session pattern ignore filters

**Files:** `src/context-sync.ts:369-371`, `src/config.ts`, tests

New env var `CONTEXT_IGNORE_SESSION_PATTERNS` (comma-separated globs). Default: `[SCHEDULED TASK*,[TF-STANDUP*,[TF-DIGEST*,[TF-WEEKLY*,[E2E*`. Replace hard-coded `includes('[SCHEDULED TASK')` with a matcher. Check first if nanoclaw already depends on a glob library (`npm ls minimatch`) — else inline a tiny one.

---

## Task 6: `context_describe` MCP tool

**Files:** `container/agent-runner/src/context-reader.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts:1070-1216`, tests

**Scope (corrected per skeptic 3):** returns the **descendant subtree manifest**, not ancestors.

```typescript
interface DescribeResult {
  node: ContextNode;
  parent: ContextNode | null;  // one-level up only, not full ancestor chain
  subtree: Array<{
    id: string;
    parent_id: string | null;
    depth_from_root: number;   // within the subtree
    summary_preview: string;   // first 200 chars
    token_count: number;
    descendant_count: number;
  }>;
  session_ids: string[];  // leaf-level session IDs under this node
}
```

Register as MCP tool `context_describe`. Input `{ node_id: string }`, output JSON.

---

## Task 7: Timestamp injection at leaf pass (new — from skeptic 3's miss)

**Files:** `src/context-service.ts` (leaf summarize path at L384-386), `src/context-service.test.ts`

**Why:** Lossless-claw injects `[YYYY-MM-DD HH:MM UTC] ` prefix on each message before summarization. Zero-LLM-cost quality win — the summarizer gets a free timeline and can reference "early morning", "after lunch" etc. Our current `LEAF_PROMPT_TEMPLATE` has no temporal context.

Prepend `[${iso_minute}] ` to `{user_message}` and each tool-call line. Test: prompt contains timestamps; summary references temporal sequence.

---

## Task 8 (OPTIONAL): `context_expand_query` bounded sub-agent

Defer decision until Tasks 1-7 have been live for 2+ weeks. If no real agent-thread has asked for detail beyond the preamble, drop it. If it's requested, scope separately — this is a 3-5 day task with container-spawn plumbing.

---

## Self-Review

- **Spec coverage:** All 7 ideas from the lossless-claw comparison + the 3 patterns skeptic 3 flagged as missed (timestamp injection, hard cap after escalation, delegation grant pattern — last one lives under Task 8).
- **Placeholder scan:** No TBDs. Every task has files + concrete code shape + commit message.
- **Type consistency:** `formatPreamble(nodes)` → `string`. `describe(nodeId)` → `DescribeResult | null`. `callSummarizer` still returns `Promise<string | null>` (unchanged contract, test pattern updated to mock fetch).
- **Prerequisite chain honored:** 1a → 1b → 1c → 2 → 3..7 → 8. Task 2's interaction with 1c's prompt inflation noted in Task 2's "Important ship-order note".

---

## Execution Handoff

Resuming Task 1a implementation inline.
