import { describe, expect, it } from 'vitest';

const { canUseCreateGroup } = await import(
  new URL('../container/agent-runner/src/ipc-tooling.js', import.meta.url).href
);

describe('agent-runner canUseCreateGroup', () => {
  it('allows the main group', () => {
    expect(
      canUseCreateGroup({
        isMain: true,
        isTaskflowManaged: false,
      }),
    ).toBe(true);
  });

  it('allows TaskFlow groups only when the next level stays below max depth', () => {
    expect(
      canUseCreateGroup({
        isMain: false,
        isTaskflowManaged: true,
        taskflowHierarchyLevel: 0,
        taskflowMaxDepth: 2,
      }),
    ).toBe(true);

    expect(
      canUseCreateGroup({
        isMain: false,
        isTaskflowManaged: true,
        taskflowHierarchyLevel: 1,
        taskflowMaxDepth: 2,
      }),
    ).toBe(false);
  });

  it('rejects TaskFlow groups without valid depth metadata', () => {
    expect(
      canUseCreateGroup({
        isMain: false,
        isTaskflowManaged: true,
      }),
    ).toBe(false);

    expect(
      canUseCreateGroup({
        isMain: false,
        isTaskflowManaged: true,
        taskflowHierarchyLevel: Number.NaN,
        taskflowMaxDepth: 3,
      }),
    ).toBe(false);
  });
});
