import { describe, expect, it } from 'bun:test';
import { formatMeetingWhenColon } from './poll-loop.ts';

// V1 meeting card uses "weekday, DD/MM às HH:MM" (colon), including half-hours.
// formatFortalezaMeetingWhen emits "…às HHh" / "…às HHhMM"; formatMeetingWhenColon
// normalizes both to HH:MM (the half-hour case is the bug Codex caught).
describe('formatMeetingWhenColon', () => {
  it('top of hour → HH:00 (Fortaleza = UTC-3, so 12:00Z → 09:00)', () => {
    expect(formatMeetingWhenColon('2026-04-09T12:00:00.000Z')).toMatch(/, \d{2}\/\d{2} às 09:00$/);
  });
  it('half hour → HH:30', () => {
    expect(formatMeetingWhenColon('2026-04-09T12:30:00.000Z')).toMatch(/, \d{2}\/\d{2} às 09:30$/);
  });
  it('quarter past → HH:15 (never leaves an "h")', () => {
    expect(formatMeetingWhenColon('2026-04-09T12:15:00.000Z')).toMatch(/ às 09:15$/);
    expect(formatMeetingWhenColon('2026-04-09T12:15:00.000Z')).not.toContain('h');
  });
});
