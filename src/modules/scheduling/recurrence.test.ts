/**
 * Tests for `handleRecurrence` — specifically the timezone-aware cron
 * interpretation ported from v1 (src/v1/task-scheduler.ts).
 *
 * Core invariant: cron expressions are interpreted in the user's TIMEZONE,
 * not UTC. Without this, `"0 9 * * *"` fires at 09:00 UTC instead of 09:00
 * user-local — a recurring scheduling bug users can't diagnose.
 */
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TIMEZONE } from '../../config.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { insertTask } from './db.js';
import { handleRecurrence } from './recurrence.js';
import type { Session } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-recurrence-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: 'mg-test',
    thread_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    container_status: 'stopped',
  } as Session;
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('handleRecurrence', () => {
  it('clones a completed recurring task with a next-run in the future', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *', // every day at 09:00 (user TZ)
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'daily digest' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    await handleRecurrence(db, fakeSession());

    const rows = db
      .prepare(`SELECT id, status, process_after, recurrence, series_id FROM messages_in ORDER BY seq`)
      .all() as Array<{
      id: string;
      status: string;
      process_after: string;
      recurrence: string | null;
      series_id: string;
    }>;
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.id === 'task-1')!;
    const follow = rows.find((r) => r.id !== 'task-1')!;
    expect(original.recurrence).toBeNull();
    expect(follow.status).toBe('pending');
    expect(follow.recurrence).toBe('0 9 * * *');
    expect(follow.series_id).toBe('task-1');
    expect(new Date(follow.process_after).getTime()).toBeGreaterThan(Date.now());
  });

  it('does not clone rows whose recurrence is already cleared', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'one-off' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    await handleRecurrence(db, fakeSession());

    const count = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  // --- per-board TZ (Option A phase 3): handleRecurrence advances each row in the zone its
  // injected tzForRow resolver returns (undefined → global TIMEZONE). The resolver is the ONLY
  // TaskFlow-aware bit; this module stays generic. ---

  function seedCompleted(db: ReturnType<typeof freshDb>, id: string, cron: string, prompt: string) {
    insertTask(db, {
      id,
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: cron,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt, script: null }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id=?`).run(id);
  }
  function followProcessAfter(db: ReturnType<typeof freshDb>, originalId: string): string {
    return (
      db.prepare(`SELECT process_after FROM messages_in WHERE id != ?`).get(originalId) as { process_after: string }
    ).process_after;
  }

  it('advances a TF runner row in the board timezone returned by tzForRow', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    try {
      const db = freshDb();
      seedCompleted(db, 'task-s', '0 8 * * 1-5', '[TF-STANDUP] morning');
      await handleRecurrence(db, fakeSession(), () => 'America/New_York');
      // Next 08:00 in New York — NOT in the global TIMEZONE.
      expect(followProcessAfter(db, 'task-s')).toBe(
        CronExpressionParser.parse('0 8 * * 1-5', { tz: 'America/New_York' }).next().toISOString(),
      );
      expect(followProcessAfter(db, 'task-s')).not.toBe(
        CronExpressionParser.parse('0 8 * * 1-5', { tz: TIMEZONE }).next().toISOString(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances a generic (non-TF) row in the global TIMEZONE when tzForRow returns undefined', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    try {
      const db = freshDb();
      seedCompleted(db, 'task-u', '0 8 * * 1-5', 'user daily standup note'); // no [TF-*] tag
      await handleRecurrence(db, fakeSession(), () => undefined); // resolver says "not a board runner"
      expect(followProcessAfter(db, 'task-u')).toBe(
        CronExpressionParser.parse('0 8 * * 1-5', { tz: TIMEZONE }).next().toISOString(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a weekly review at 14:00 board-local across a US spring-forward (DST regression)', async () => {
    // US DST starts Sun 2026-03-08. Freeze on Tue 2026-03-10 → next Friday review is 2026-03-13,
    // which is EDT (UTC-4), so 14:00 New_York == 18:00Z. A DST-broken parser would yield 19:00Z.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
    try {
      const db = freshDb();
      seedCompleted(db, 'task-r', '0 14 * * 5', '[TF-REVIEW] weekly');
      await handleRecurrence(db, fakeSession(), () => 'America/New_York');
      expect(followProcessAfter(db, 'task-r')).toBe('2026-03-13T18:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});
