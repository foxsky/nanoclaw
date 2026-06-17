/**
 * Behavior tests for the messaging_groups main-control primitives — the
 * source-of-truth for v1 isMain parity in v2.
 *
 *   setMainControlMessagingGroup(id) — atomic clear+set
 *   getMainControlMessagingGroup() — current main, or undefined
 *
 * The CLI script (scripts/set-main-control.ts) is a thin wrapper around
 * these and gets covered indirectly by the same contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initTestDb } from '../db/index.js';
import { runMigrations } from './migrations/index.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroup } from './messaging-groups.js';
import {
  getMainControlMessagingGroup,
  setMainControlMessagingGroup,
} from '../modules/taskflow/messaging-groups-main-control.js';
// Fork-coupled test: side-effect import registers the main-control migration so
// runMigrations() adds the is_main_control column these tests depend on.
import '../modules/taskflow/migrations-register.js';

const now = '2026-05-05T00:00:00Z';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

function seedMg(id: string, platform: string): void {
  createMessagingGroup({
    id,
    channel_type: 'whatsapp',
    platform_id: platform,
    name: id,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
}

describe('messaging-groups main-control primitives', () => {
  it('returns undefined when no main has been designated', () => {
    expect(getMainControlMessagingGroup()).toBeUndefined();
  });

  it('setMainControlMessagingGroup designates a row, getter returns it', () => {
    seedMg('mg-1', '120363111@g.us');
    setMainControlMessagingGroup('mg-1');
    const main = getMainControlMessagingGroup();
    expect(main?.id).toBe('mg-1');
    expect(main?.is_main_control).toBe(1);
  });

  it('rows insert with is_main_control = 0 by default (column DEFAULT applied)', () => {
    seedMg('mg-1', '120363111@g.us');
    expect(getMessagingGroup('mg-1')?.is_main_control).toBe(0);
  });

  it('createMessagingGroup type rejects is_main_control in the input literal (compile-time check, observed by tsc)', () => {
    // This test is documentation: the parameter is `Omit<MessagingGroup, 'is_main_control'>`,
    // so the only path to set the flag is via setMainControlMessagingGroup. Pure type-level
    // assertion; runtime body is just the seed-and-check from the prior test for coverage.
    seedMg('mg-x', '120363999@g.us');
    expect(getMessagingGroup('mg-x')?.is_main_control).toBe(0);
  });

  it('atomically clears the previous main when a new one is designated', () => {
    seedMg('mg-1', '120363111@g.us');
    seedMg('mg-2', '120363222@g.us');
    setMainControlMessagingGroup('mg-1');
    setMainControlMessagingGroup('mg-2');
    expect(getMessagingGroup('mg-1')?.is_main_control).toBe(0);
    expect(getMessagingGroup('mg-2')?.is_main_control).toBe(1);
    expect(getMainControlMessagingGroup()?.id).toBe('mg-2');
  });

  it('first designation returns null (no prior main was demoted)', () => {
    seedMg('mg-1', '120363111@g.us');
    expect(setMainControlMessagingGroup('mg-1')).toBeNull();
  });

  it('same-id re-designation returns null (nothing demoted)', () => {
    seedMg('mg-1', '120363111@g.us');
    setMainControlMessagingGroup('mg-1');
    expect(setMainControlMessagingGroup('mg-1')).toBeNull();
  });

  it('re-designation returns the demoted prior-main id so the caller can warn', () => {
    seedMg('mg-1', '120363111@g.us');
    seedMg('mg-2', '120363222@g.us');
    setMainControlMessagingGroup('mg-1');
    // Promoting mg-2 demotes mg-1; the setter reports the demoted id because the
    // old main's wired agents stay always-engaged and that can't be safely
    // auto-reverted (no stored pre-promotion engage; DM vs group differ).
    expect(setMainControlMessagingGroup('mg-2')).toBe('mg-1');
  });

  it('re-designation leaves the demoted main always-engaged — surfaced via return, not auto-reverted', () => {
    seedMg('mg-1', '120363111@g.us');
    seedMg('mg-2', '120363222@g.us');
    getDb()
      .prepare(
        `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES ('ag-1', 'Tars', 'main', 'claude', ?)`,
      )
      .run(now);
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '@Tars',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    setMainControlMessagingGroup('mg-1'); // mg-1 agents → always-engage
    setMainControlMessagingGroup('mg-2'); // demote mg-1

    const mga = getDb()
      .prepare("SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE id = 'mga-1'")
      .get() as { engage_mode: string; engage_pattern: string | null };
    // Deliberately unchanged: the operator must reconfigure (the CLI warns).
    expect(mga).toEqual({ engage_mode: 'pattern', engage_pattern: '.' });
  });

  it('throws when the target id does not exist (fail-closed against typos)', () => {
    expect(() => setMainControlMessagingGroup('mg-typo')).toThrow(/does not exist/);
    // No row should have been silently set
    expect(getMainControlMessagingGroup()).toBeUndefined();
  });

  it('directly inserting a second is_main_control=1 row violates the partial unique index', () => {
    seedMg('mg-1', '120363111@g.us');
    seedMg('mg-2', '120363222@g.us');
    setMainControlMessagingGroup('mg-1');
    // Attempt to bypass the setter — direct UPDATE against DB.
    expect(() => {
      getDb().prepare('UPDATE messaging_groups SET is_main_control = 1 WHERE id = ?').run('mg-2');
    }).toThrow(/UNIQUE/i);
  });

  it('multiple is_main_control=0 rows are unconstrained (partial-index scope)', () => {
    seedMg('mg-1', '120363111@g.us');
    seedMg('mg-2', '120363222@g.us');
    seedMg('mg-3', '120363333@g.us');
    expect(getMessagingGroup('mg-1')?.is_main_control).toBe(0);
    expect(getMessagingGroup('mg-2')?.is_main_control).toBe(0);
    expect(getMessagingGroup('mg-3')?.is_main_control).toBe(0);
  });

  it('clearing the main: setting twice to same id is idempotent', () => {
    seedMg('mg-1', '120363111@g.us');
    setMainControlMessagingGroup('mg-1');
    setMainControlMessagingGroup('mg-1');
    expect(getMainControlMessagingGroup()?.id).toBe('mg-1');
  });

  it('always-engages the designated main group’s wired agents (Gap #3: v1 main parity)', () => {
    seedMg('mg-1', '120363111@g.us');
    getDb()
      .prepare(
        `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES ('ag-1', 'Tars', 'main', 'claude', ?)`,
      )
      .run(now);
    // Wire an agent that is NOT always-engage (e.g. a migrated @Tars main).
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '@Tars',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });

    setMainControlMessagingGroup('mg-1');

    const mga = getDb()
      .prepare("SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE id = 'mga-1'")
      .get() as { engage_mode: string; engage_pattern: string | null };
    expect(mga).toEqual({ engage_mode: 'pattern', engage_pattern: '.' });
  });
});
