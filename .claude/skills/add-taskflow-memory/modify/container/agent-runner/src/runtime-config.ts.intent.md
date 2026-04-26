# Intent: container/agent-runner/src/runtime-config.ts

## What Changed
1. Mirror the host-side `AgentTurnContext` shape (add the optional `senderJid?: string`).
2. In `buildNanoclawMcpEnv`, emit `NANOCLAW_TURN_SENDER_JID` when the turn carries a `senderJid`.

## Key Sections
- **`AgentTurnContext` interface** (top of the file, near the existing one).
- **`buildNanoclawMcpEnv`**: a new branch right after the existing `if (containerInput.turnContext?.turnId)` block.

## Patch shapes
```ts
export interface AgentTurnContext {
  turnId: string;
  /** Sender JID of the trigger message, used by the memory layer for attribution. */
  senderJid?: string;
}
```

```ts
if (containerInput.turnContext?.turnId) {
  env.NANOCLAW_TURN_ID = containerInput.turnContext.turnId;
}

// NEW:
if (containerInput.turnContext?.senderJid) {
  env.NANOCLAW_TURN_SENDER_JID = containerInput.turnContext.senderJid;
}
```

## Invariants (must-keep)
- The container-side `AgentTurnContext` MUST stay structurally compatible with the host-side one (same fields, same types). They are deserialized from the same JSON payload.
- All other env emissions (`NANOCLAW_CHAT_JID`, `NANOCLAW_GROUP_FOLDER`, `NANOCLAW_IS_MAIN`, `NANOCLAW_IS_TASKFLOW_MANAGED`, etc.) are unchanged.
- `NANOCLAW_TURN_SENDER_JID` is omitted entirely when no sender is present — never emit an empty string.
