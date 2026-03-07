# Board View Layout Redesign

**Date:** 2026-03-07
**Status:** Approved

## Problem

The board view (`"quadro"` / `"status"`) and standup report used different layouts. The board view had no explicit formatting rules (agent improvised), and the standup used a hybrid column-then-person format that was hard to scan.

## Design

Replace both with a shared layout: **column-first grouping with person sub-grouping within each column**.

### Layout

- Header (board-specific or standup-specific)
- Inbox section (unassigned tasks, simple bullet list)
- Column sections (Next Action, In Progress, Waiting, Review) — skip empty
  - Within each column: tasks grouped by person (👤 marker)
  - Within each person: tasks sorted by due date, subtasks under parent with ↳
- Summary footer with counts and overdue alerts

### Task Line Format

Prefix (mutually exclusive, in priority): ⚠️ overdue > 🔗 linked > 📁 project > 🔄 recurring > (none)
Suffixes: ⏰ DD/MM due date, 💬 has notes

### Scope

- CLAUDE.md template formatting only — no engine changes
- Applied to: board query, standup report, all 6 runtime CLAUDE.md files
