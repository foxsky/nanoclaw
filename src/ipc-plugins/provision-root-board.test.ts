import { CronExpressionParser } from 'cron-parser';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DIGEST_LOCAL,
  DEFAULT_DIGEST_UTC,
  DEFAULT_REVIEW_LOCAL,
  DEFAULT_REVIEW_UTC,
  DEFAULT_STANDUP_LOCAL,
  DEFAULT_STANDUP_UTC,
} from './provision-root-board.js';

/**
 * Parse a cron expression in its *source* timezone, then format the
 * next fire instant as a wall-clock "HH:MM" in the *viewer* timezone.
 * E.g. `nextWallClock('0 14 * * 5', 'UTC', 'America/Fortaleza')` returns
 * "11:00" — 14:00 UTC viewed from Fortaleza (UTC-3).
 *
 * Anchored to a fixed date (far from DST boundaries) so the result
 * doesn't drift with the test's clock.
 */
function nextWallClock(
  cron: string,
  cronTz: string,
  viewerTz: string,
): string {
  const anchor = new Date('2026-06-15T00:00:00.000Z');
  const it = CronExpressionParser.parse(cron, {
    tz: cronTz,
    currentDate: anchor,
  });
  const d = it.next().toDate();
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerTz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

describe('provision_root_board default cron schedules', () => {
  const TZ = 'America/Fortaleza';

  it('standup UTC default fires at 08:00 local (Fortaleza)', () => {
    expect(nextWallClock(DEFAULT_STANDUP_UTC, 'UTC', TZ)).toBe('08:00');
  });

  it('standup LOCAL default fires at 08:00 local (Fortaleza)', () => {
    expect(nextWallClock(DEFAULT_STANDUP_LOCAL, TZ, TZ)).toBe('08:00');
  });

  it('digest UTC default fires at 18:00 local (Fortaleza)', () => {
    expect(nextWallClock(DEFAULT_DIGEST_UTC, 'UTC', TZ)).toBe('18:00');
  });

  it('digest LOCAL default fires at 18:00 local (Fortaleza)', () => {
    expect(nextWallClock(DEFAULT_DIGEST_LOCAL, TZ, TZ)).toBe('18:00');
  });

  // Regression: DEFAULT_REVIEW_UTC was '0 17 * * 5', which is 14:00 local
  // Fortaleza (UTC-3). The intended review schedule is 11:00 Friday local
  // (= 14:00 UTC). This test guards against the review drifting back to
  // 17:00 UTC = 14:00 local.
  it('review UTC default fires at 11:00 local Friday (Fortaleza), not 14:00', () => {
    expect(nextWallClock(DEFAULT_REVIEW_UTC, 'UTC', TZ)).toBe('11:00');
  });

  it('review LOCAL default fires at 11:00 local Friday (Fortaleza)', () => {
    expect(nextWallClock(DEFAULT_REVIEW_LOCAL, TZ, TZ)).toBe('11:00');
  });

  it('UTC defaults match their LOCAL counterparts wall-clock (Fortaleza)', () => {
    expect(nextWallClock(DEFAULT_STANDUP_UTC, 'UTC', TZ)).toBe(
      nextWallClock(DEFAULT_STANDUP_LOCAL, TZ, TZ),
    );
    expect(nextWallClock(DEFAULT_DIGEST_UTC, 'UTC', TZ)).toBe(
      nextWallClock(DEFAULT_DIGEST_LOCAL, TZ, TZ),
    );
    expect(nextWallClock(DEFAULT_REVIEW_UTC, 'UTC', TZ)).toBe(
      nextWallClock(DEFAULT_REVIEW_LOCAL, TZ, TZ),
    );
  });
});
