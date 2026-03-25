# Compact Board Header for Digest and Weekly Reports

## Problem

Digest and weekly report messages are too long and repetitive. Each starts with the full Kanban board (every task in every column), then lists many of the same tasks again in themed sections below (completed, overdue, blocked, stale). A task that's overdue appears in its column AND in the "Pendências" section. A completed task appears in Done AND in the celebration section. On boards with 15+ tasks, this creates a wall of text that's hard to read on mobile.

## Solution

Replace the full board view with a compact summary header in digest and weekly reports only. The compact header shows column counts — not individual tasks. The themed sections below become the only place tasks appear, eliminating all repetition.

Standup and on-demand board queries continue to use the full detailed board.

## Compact Header Format

```
📋 TASKFLOW BOARD — 22/03/2026
📊 12 tarefas • 2 projetos • 3 subtarefas
━━━━━━━━━━━━━━
  📥 1 inbox
  ⏭️ 3 próximas
  🔄 4 andamento
  ⏳ 2 aguardando
  🔍 1 revisão
  ✅ 3 concluída(s) hoje
```

Rules:
- Keep the original board header line (`📋 TASKFLOW BOARD — d/m/y`) and stats line (`📊 X tarefas • Y projetos • Z subtarefas`) and separator.
- One line per non-empty column with its emoji prefix and count.
- Skip columns with zero tasks.
- Last line: `✅ X concluída(s) hoje` for digest, `✅ X concluída(s) na semana` for weekly. Omit if zero completions.
- Done column is never shown (same as current behavior).

## What Changes Where

| Report Type | Board View | Report Sections | Motivational |
|---|---|---|---|
| **Standup** | Full board (unchanged) | Structured data (unchanged) | None |
| **Digest** | **Compact header (new)** | Unchanged (celebrations, momentum, pendências, meetings, priorities) | Separate message (unchanged) |
| **Weekly** | **Compact header (new)** | Unchanged (headline, recognition, completed list, operational, upcoming, team summary) | Separate message (unchanged) |
| **On-demand** (`@Tars quadro`) | Full board (unchanged) | N/A | N/A |

## Trade-off: tasks only visible in full board

Tasks that sit quietly in a column with no special condition (not overdue, not blocked, not stale, not completed) will no longer appear individually in digest/weekly reports. They're represented only by a count ("🔄 4 andamento"). This is intentional — those tasks don't need the manager's attention. The full detail is available via the morning standup or on-demand board query.

This affects the existing test "digest and weekly formatted reports preserve prefixed linked task ids" which asserts that a linked task ID (`SEC-T9`) appears in `formatted_report`. That task was only visible because the full board was embedded. The test must be updated to check `formatted_report` for the compact header pattern instead, or move the linked task into a condition (e.g., overdue) that surfaces it in a themed section.

## Implementation

### New method: `formatCompactBoard(completedCount: number, completedLabel: 'hoje' | 'na semana'): string`

Add a private method to `TaskflowEngine` that renders the compact header. It reuses the same task-fetching and counting logic from `formatBoardView` (lines 4380-4413) — including orphan subtask promotion and linked board handling — to ensure counts are consistent with the full board. It diverges only in rendering: one line per column with a count instead of individual task lines.

**Data source:** Same queries and logic as `formatBoardView` for consistency. Extract the header/stats portion and column grouping into shared code that both methods can call, or duplicate the lightweight query. The key constraint is that column counts in the compact header must match what the full board would show.

**Column label mapping** (lowercase for readability, not the uppercase bold labels from the full board):

| Column key | Compact label |
|---|---|
| `inbox` | `inbox` |
| `next_action` | `próximas` |
| `in_progress` | `andamento` |
| `waiting` | `aguardando` |
| `review` | `revisão` |

**Column emojis:** Use the same emojis from the existing `colOrder` constant in `formatBoardView` (`📥`, `⏭️`, `🔄`, `⏳`, `🔍`). Extract into a shared constant if not already.

**Stats line:** Same counting logic as the existing `formatBoardView` header (`topLevel.length`, `projectCount`, `subtaskCount`).

**Plural handling:** Use `concluída(s)` for all counts (matching existing convention throughout the codebase).

### Change in `formatDigestOrWeeklyReport()`

Line 4616 currently calls `this.formatBoardView('board')` as the first line of the report. Replace with `this.formatCompactBoard(completedCount, completedLabel)` where:
- Digest: `completedCount = data.completed_today.length`, `completedLabel = 'hoje'`
- Weekly: `completedCount = data.completed_week?.length ?? 0`, `completedLabel = 'na semana'`

### No changes to:
- `formatBoardView()` — stays intact for standup and on-demand
- Report sections (celebration, pendências, etc.) — stay as-is
- Standup report path
- MCP tool interface
- CLAUDE.md template instructions (the agent still outputs `formatted_report` as-is)

### Files to modify:
1. `container/agent-runner/src/taskflow-engine.ts` — add `formatCompactBoard()`, change one line in `formatDigestOrWeeklyReport()`
2. `container/agent-runner/src/taskflow-engine.test.ts` — update digest/weekly tests to expect compact header instead of full board; update linked task test
3. `.claude/skills/add-taskflow/add/` and `modify/` — sync copies
4. `.claude/skills/add-taskflow/templates/CLAUDE.md.template` — no changes needed

### Testing

- Digest with completions: compact header shows column counts + "✅ X concluída(s) hoje"
- Digest with zero completions: compact header without ✅ line
- Weekly with completions: compact header + "✅ X concluída(s) na semana"
- Empty board: compact header with zero counts in stats line, no column lines
- Linked task in normal column: does NOT appear in `formatted_report` (only as a count)
- Standup: still uses full board (regression check)
- On-demand board query: still uses full board (regression check)
