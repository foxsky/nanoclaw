import { beforeEach, describe, expect, it } from 'bun:test';

import {
  __resetDedupForTesting,
  consumeDeterministicMutationFlag,
  markDeterministicMutationEmitted,
} from './mutation-dedup.ts';

// Phase-3 unit-2-core / Codex gate P4 (biggest risk before replay):
// deterministic mutation card emission + the model's same-turn bare-text
// final reply → double-emit. v1 only ever sent the deterministic card.
// This primitive lets `emitMutationConfirmation` mark on success and
// `dispatchResultText`'s bare-text fallback consume-and-suppress.
// Read-and-clear semantics so each turn naturally consumes the flag.

beforeEach(() => {
  __resetDedupForTesting();
});

describe('mutation-dedup', () => {
  it('starts unflagged', () => {
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });

  it('mark sets the flag; consume reads it as true', () => {
    markDeterministicMutationEmitted();
    expect(consumeDeterministicMutationFlag()).toBe(true);
  });

  it('consume clears the flag (read-and-clear)', () => {
    markDeterministicMutationEmitted();
    expect(consumeDeterministicMutationFlag()).toBe(true);
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });

  it('multiple marks before a consume → still one true, then cleared', () => {
    markDeterministicMutationEmitted();
    markDeterministicMutationEmitted();
    expect(consumeDeterministicMutationFlag()).toBe(true);
    expect(consumeDeterministicMutationFlag()).toBe(false);
  });
});
