# Intent: container/agent-runner/src/db-util.ts

## What Changed
Adds two new exports the memory layer depends on:
- `openWritableDb(dbPath: string): Database.Database` — symmetric to the existing `openReadonlyDb`. Creates parent directories, sets `journal_mode = WAL`, sets `busy_timeout = 5000`. Used by `MemoryAudit` for the per-board sidecar at `/workspace/group/.nanoclaw/memory/memory.db`.
- `selectWithinTokenBudget<T>(items, getText, budgetTokens, options?)` — greedy item selector with two modes. Soft (default) emits at least one item even if it overshoots; matches the historic conversation-recap behavior. Strict drops items whose individual cost exceeds the budget; required by the auto-recall preamble so a single oversized stored fact cannot dominate the prompt. The `truncateChars` option is available for callers that want truncation instead of dropping.

Also adds the `path` import for the new `mkdirSync(dirname(...), { recursive: true })` call inside `openWritableDb`.

## Key Sections

### Imports (top of file)
```ts
import path from 'path';
```

### After `closeDb` (or anywhere alongside the existing helpers)
```ts
export function openWritableDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

export interface SelectWithinTokenBudgetOptions<T> {
  strict?: boolean;
  truncateChars?: number;
}

export function selectWithinTokenBudget<T>(
  items: readonly T[],
  getText: (item: T) => string,
  budgetTokens: number,
  options: SelectWithinTokenBudgetOptions<T> = {},
): T[] {
  const { strict = false, truncateChars } = options;
  const selected: T[] = [];
  let remaining = budgetTokens;
  for (const item of items) {
    let text = getText(item);
    let cost = estimateTokens(text);
    if (cost > budgetTokens) {
      if (truncateChars !== undefined) {
        text = text.slice(0, truncateChars);
        cost = estimateTokens(text);
      } else if (strict) {
        continue;
      }
    }
    if (remaining - cost < 0) {
      if (strict || selected.length > 0) break;
    }
    selected.push(item);
    remaining -= cost;
  }
  return selected;
}
```

## Invariants (must-keep)
- The existing `estimateTokens`, `openReadonlyDb`, and `closeDb` helpers MUST be left untouched. They are used by `EmbeddingReader`, `ContextReader`, and the conversation-recap preamble.
- `openWritableDb` MUST set `busy_timeout` — the previous in-place `new Database(...)` call inside MemoryAudit had no timeout and would error on contention instead of waiting.
- `selectWithinTokenBudget` defaults to soft mode for backward compatibility with the conversation-recap caller; strict mode is opt-in.
