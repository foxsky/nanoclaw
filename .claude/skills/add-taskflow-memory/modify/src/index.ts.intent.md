# Intent: src/index.ts

## What Changed
- In the two sites that build `AgentTurnContext`, populate `senderJid` from the **last** message in the turn's batch.

## Key Sections
There are two `const turnContext: AgentTurnContext = { turnId: ... }` blocks:

1. **External-DM trigger-bypass path** (around the `pendingExternalDmPrompts` handler): the messages are `pendingDms.map((p) => p.triggerMessage)` — pick the sender of the last entry.
2. **Main message-loop path** (around the `processGroupMessages` body): the messages are `missedMessages.map(toTriggerMessageContext)` — pick the sender of the last entry.

## Patch shape (each site)
```ts
const turnTriggers = /* the array used in the createAgentTurn call */;
const turnContext: AgentTurnContext = {
  turnId: createAgentTurn({ ...messages: turnTriggers }).id,
  senderJid: turnTriggers[turnTriggers.length - 1]?.sender,
};
```

The choice of "last sender" is deliberate: a turn batch can contain messages from multiple senders, but the LAST one is the trigger that woke the agent. The memory layer attributes writes to this sender.

## Invariants (must-keep)
- The `turnId: createAgentTurn({...}).id` line MUST remain unchanged.
- `senderJid` is OPTIONAL — if the trigger array is empty (defensive, shouldn't happen) it stays undefined.
- Do NOT introduce a new dependency on the message contents — only the `.sender` field is read.
