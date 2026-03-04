# runtime-config.ts Modifications

Add TaskFlow board ID to the MCP environment:

In `buildNanoclawMcpEnv()`, when `containerInput.isTaskflowManaged` is true:
```typescript
env.NANOCLAW_TASKFLOW_BOARD_ID = 'board-' + containerInput.groupFolder;
```
