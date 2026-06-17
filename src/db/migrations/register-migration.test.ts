/**
 * registerMigration dup-name guard (ADR 0006 contract #3 consistency).
 *
 * The apply layer dedups on `name`, so a duplicate registration would silently
 * never re-apply — a second module choosing the same migration name would lose
 * its migration with no error. The guard fails loud at registration instead,
 * matching the sibling registries (startup-registry, container-contributor,
 * migrate-v2-steps). Fresh module import per test isolates the module-level
 * registry array.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
});

async function freshRegistry() {
  vi.resetModules();
  return import('./index.js');
}

const noop = { version: 999, name: 'module-test-x', up: () => {} };

describe('registerMigration dup guard', () => {
  it('registers a uniquely-named module migration', async () => {
    const { registerMigration, getRegisteredMigrations } = await freshRegistry();
    registerMigration(noop);
    expect(getRegisteredMigrations().map((m) => m.name)).toContain('module-test-x');
  });

  it('throws on a duplicate module-migration name (double register)', async () => {
    const { registerMigration } = await freshRegistry();
    registerMigration(noop);
    expect(() => registerMigration({ ...noop, version: 1000 })).toThrow(/already registered/);
  });

  it('throws on a name that collides with a CORE migration (would silently never apply)', async () => {
    const { registerMigration } = await freshRegistry();
    // 'initial-v2-schema' is migration001's name (a core migration).
    expect(() => registerMigration({ version: 1, name: 'initial-v2-schema', up: () => {} })).toThrow(
      /already registered/,
    );
  });
});
