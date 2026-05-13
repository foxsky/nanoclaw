import { describe, expect, it } from 'vitest';

import { formatReport, localDateKey } from './audit-v1-bugs-daily.js';

describe('audit-v1-bugs-daily: localDateKey', () => {
  it('emits ISO YYYY-MM-DD in the requested timezone', () => {
    // 2026-05-13 03:00 UTC → 2026-05-13 00:00 in America/Fortaleza (UTC-3).
    expect(localDateKey(new Date('2026-05-13T03:00:00Z'), 'America/Fortaleza')).toBe('2026-05-13');
  });

  it('rolls over the day boundary correctly when UTC is past midnight but local is not', () => {
    // 2026-05-13 02:00 UTC = 2026-05-12 23:00 in America/Fortaleza.
    expect(localDateKey(new Date('2026-05-13T02:00:00Z'), 'America/Fortaleza')).toBe('2026-05-12');
  });
});

describe('audit-v1-bugs-daily: formatReport', () => {
  it('renders a clean-day report when there are zero findings', () => {
    const out = formatReport(
      { boards: 'all', per_board_counts: { 'board-a': 0, 'board-b': 0 }, findings: [] },
      '2026-05-13',
    );
    expect(out).toContain('# v1-bug audit — 2026-05-13');
    expect(out).toContain('Clean day');
    expect(out).not.toContain('## Per-board counts');
  });

  it('groups findings by board and lists per-board counts only for boards with hits', () => {
    const out = formatReport(
      {
        boards: 'all',
        per_board_counts: {
          'board-seci-taskflow': 1,
          'board-laizys-taskflow': 1,
          'board-quiet': 0,
        },
        findings: [
          {
            pattern: 'date_field_correction',
            board_id: 'board-seci-taskflow',
            task_id: 'M1',
            by: 'giovanni',
            a_at: '2026-04-14T11:04:11Z',
            b_at: '2026-04-14T11:36:29Z',
            dt_min: 32.3,
            a_details: '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}',
            b_details: '{"changes":["Reunião reagendada para 16/04/2026 às 11:00"]}',
          },
          {
            pattern: 'date_field_correction',
            board_id: 'board-laizys-taskflow',
            task_id: 'T11',
            by: 'joao-henrique',
            a_at: '2026-04-17T23:42Z',
            b_at: '2026-04-17T23:43Z',
            dt_min: 1.3,
            a_details: '{"changes":["Prazo definido: 2026-04-21"]}',
            b_details: '{"changes":["Prazo definido: 2026-04-20"]}',
          },
        ],
      },
      '2026-05-13',
    );
    // Per-board counts list only the boards with non-zero hits, ordered by count desc.
    expect(out).toContain('## Per-board counts');
    expect(out).toContain('- board-seci-taskflow: 1');
    expect(out).toContain('- board-laizys-taskflow: 1');
    expect(out).not.toContain('board-quiet');
    // Findings grouped under each board.
    expect(out).toContain('### board-laizys-taskflow');
    expect(out).toContain('### board-seci-taskflow');
    expect(out).toContain('reagendada para 17/04/2026');
  });

  it('escapes literal backticks inside detail payloads so code spans never break', () => {
    const out = formatReport(
      {
        boards: 'all',
        per_board_counts: { 'board-x': 1 },
        findings: [
          {
            pattern: 'date_field_correction',
            board_id: 'board-x',
            task_id: 'T1',
            by: 'u',
            a_at: '2026-05-13T00:00:00Z',
            b_at: '2026-05-13T00:01:00Z',
            dt_min: 1,
            // Detail contains a literal backtick — must be replaced with a
            // single-quote so the surrounding `code span` stays well-formed.
            a_details: '{"changes":["foo `bar` baz"]}',
            b_details: '{"changes":["x"]}',
          },
        ],
      },
      '2026-05-13',
    );
    expect(out).not.toContain('foo `bar`');
    expect(out).toContain("foo 'bar' baz");
  });
});
