# container-runner.ts Modifications

Add `taskflow-engine.ts` to the `CORE_AGENT_RUNNER_FILES` array so it gets synced to per-group agent-runner directories:

```typescript
const CORE_AGENT_RUNNER_FILES = [
  'index.ts',
  'ipc-mcp-stdio.ts',
  'ipc-tooling.ts',
  'runtime-config.ts',
  'taskflow-engine.ts',   // ← ADD
  path.join('mcp-plugins', 'create-group.ts'),
] as const;
```
