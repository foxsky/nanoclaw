# Intent: container/agent-runner/src/runtime-config.test.ts

## What Changed
Two new test cases at the bottom of the existing `describe` block, asserting that `buildNanoclawMcpEnv` correctly emits / omits `NANOCLAW_TURN_SENDER_JID` based on whether the turn carries a sender.

## Key Sections
After the existing "passes through the host-issued turn ID when present" test, add two `it(...)` blocks.

## Test 1: emission when sender is present
```ts
it('emits the sender JID env var when the turn carries one (audit attribution)', () => {
  const env = buildNanoclawMcpEnv({
    prompt: 'test',
    groupFolder: 'taskflow-root',
    chatJid: '123@g.us',
    isMain: false,
    isTaskflowManaged: true,
    taskflowBoardId: 'board-foo',
    turnContext: { turnId: 'turn-99', senderJid: '5586999999999@s.whatsapp.net' },
  });
  expect(env.NANOCLAW_TURN_SENDER_JID).toBe('5586999999999@s.whatsapp.net');
});
```

## Test 2: omission when no sender (e.g. scheduled tasks)
```ts
it('omits the sender JID env var when no sender is present (e.g. scheduled tasks)', () => {
  const env = buildNanoclawMcpEnv({ /* same shape as above but without senderJid */ });
  expect(env).not.toHaveProperty('NANOCLAW_TURN_SENDER_JID');
});
```

## Invariants (must-keep)
- All existing tests MUST continue to pass — the new field is purely additive.
- Use `not.toHaveProperty` (not `toEqual`) for the omission test, so the assertion stays robust against later additions to the env shape.
