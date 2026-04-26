# Intent: container/agent-runner/src/ipc-mcp-stdio.test.ts

## What Changed
Four new source-shape assertions covering the memory tools, added inside the existing `describe('ipc-mcp-stdio tool handler shapes', ...)` block.

These are fast regression tests on the source TEXT — they catch refactors that drop critical patterns (TaskFlow gating, audit-log calls, fail-soft `isError: true`, DRY use of `memory-client` helpers). They are NOT runtime tests; runtime/HTTP behavior is covered by `memory-client.test.ts`.

## Key Assertions

### `memory_store`
- `memoryEnabled` gate present
- `storeMemory(args.text` (delegates to memory-client)
- `audit.countWritesInTurn(turnId)` (quota check)
- `MAX_MEMORY_WRITES_PER_TURN` constant referenced
- `audit.recordStore(` (ownership recorded after success)
- `isError: true` on fail-soft
- `'fact NOT saved'` wording

### `memory_recall`
- `memoryEnabled` gate present
- `searchMemory(` delegation
- `'lower dist = closer match'` relevance hint
- `isError: true` on fail-soft

### `memory_list`
- `memoryEnabled` gate present
- `audit.listOwnedForBoard(taskflowBoardId!` (reads local audit DB, NOT the shared server)

### `memory_forget`
- `memoryEnabled` gate present
- `audit.isOwned(args.memory_id, taskflowBoardId!)` (ownership check before DELETE)
- `deleteMemoryById(` (delegated)
- `audit.removeOwned(args.memory_id)` (sidecar updated after DELETE)
- `'not owned by this board'` wording
- The OLD GET-then-DELETE pattern MUST NOT appear: `expect(body).not.toContain("method: 'GET'")`

## Invariants (must-keep)
- The pre-existing test "every tool handler that returns an error message uses isError: true" MUST still pass — the memory tools follow this rule.
- Use `extractToolHandlerBlock(toolName)` (the existing helper) — don't introduce a new test scaffold.
