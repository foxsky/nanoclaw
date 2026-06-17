/**
 * Unit tests for the generic migrate-v2 post-seed step registry (the core
 * extension contract that decouples the TaskFlow is_main_control carry-over
 * from setup/migrate-v2/db.ts).
 *
 * Intent: prove (a) pristine inertness — an unregistered core runs zero steps
 * and emits no summary fields (so migrate-v2 behaves exactly like upstream when
 * no overlay is installed); (b) name-keyed dup guard (consistent with the other
 * split registries); (c) registration-order execution + summary-field
 * collection (db.ts appends these to its OK: line).
 *
 * Each test imports the registry module FRESH (vi.resetModules) because the
 * registry is module-level singleton state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
});

async function freshRegistry() {
  vi.resetModules();
  return import('./migrate-v2-steps.js');
}

const emptyCtx = { migrated: [], skipped: [] };

describe('migrate-v2 step registry', () => {
  it('runs zero steps and returns no summary fields when nothing is registered (pristine core inertness)', async () => {
    const { runMigrateV2Steps } = await freshRegistry();
    const fields = await runMigrateV2Steps(emptyCtx);
    expect(fields).toEqual([]);
  });

  it('throws on a duplicate step name (name-keyed, like the sibling registries)', async () => {
    const { registerMigrateV2Step } = await freshRegistry();
    registerMigrateV2Step('dup', () => {});
    expect(() => registerMigrateV2Step('dup', () => {})).toThrow(/already registered/);
  });

  it('runs steps in registration order and concatenates their summary fields', async () => {
    const { registerMigrateV2Step, runMigrateV2Steps } = await freshRegistry();
    const order: string[] = [];
    registerMigrateV2Step('a', () => {
      order.push('a');
      return ['main_promoted=1'];
    });
    registerMigrateV2Step('b', () => {
      order.push('b');
      // a void-returning step contributes no fields
    });
    registerMigrateV2Step('c', async () => {
      order.push('c');
      return ['extra=2'];
    });
    const fields = await runMigrateV2Steps(emptyCtx);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(fields).toEqual(['main_promoted=1', 'extra=2']);
  });

  it('passes the seed-outcome context (migrated + skipped) through to each step', async () => {
    const { registerMigrateV2Step, runMigrateV2Steps } = await freshRegistry();
    const ctx = {
      migrated: [{ folder: 'f1', messagingGroupId: 'mg1', v1IsMain: true }],
      skipped: [{ folder: 'f2', jid: 'j2', reason: 'parse', v1IsMain: false }],
    };
    let seen: unknown;
    registerMigrateV2Step('capture', (c) => {
      seen = c;
    });
    await runMigrateV2Steps(ctx);
    expect(seen).toBe(ctx);
  });
});
