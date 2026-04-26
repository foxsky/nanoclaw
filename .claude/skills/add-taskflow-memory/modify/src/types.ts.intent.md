# Intent: src/types.ts

## What Changed
- Added an optional `senderJid?: string` field to `AgentTurnContext`.
- Used by the memory layer to attribute writes to the trigger sender (audit trail in the sidecar SQLite).

## Key Sections
- **`AgentTurnContext` interface** (around the top of the types file): new optional field with a one-line JSDoc explaining it's used by the memory layer for attribution.

## Patch shape
```ts
export interface AgentTurnContext {
  turnId: string;
  /** Sender JID of the trigger message, used by the memory layer for attribution. */
  senderJid?: string;
}
```

## Invariants (must-keep)
- `turnId: string` is still required (existing callers depend on it).
- The new field MUST be optional — scheduled-task turns and other no-human contexts will not have a sender.
- All other types in the file are untouched.
