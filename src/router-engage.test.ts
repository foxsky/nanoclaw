/**
 * evaluateEngage pattern-matching — Gap #2 (case-insensitive @-mention parity).
 *
 * v1 matched mention triggers case-insensitively. The v1→v2 migration writes the
 * bare trigger (e.g. `@Tars`) as engage_pattern, so the router must match it
 * case-insensitively or a migrated board ignores `@tars`/`@TARS`.
 */
import { describe, expect, it } from 'vitest';

import { evaluateEngage } from './router.js';
import type { MessagingGroup, MessagingGroupAgent } from './types.js';

function agent(engage_mode: string, engage_pattern: string | null): MessagingGroupAgent {
  return { engage_mode, engage_pattern, agent_group_id: 'ag-1' } as unknown as MessagingGroupAgent;
}
const mg = { is_group: 1 } as unknown as MessagingGroup;

describe('evaluateEngage — pattern matching', () => {
  it('a migrated @Tars trigger fires case-insensitively (Gap #2)', () => {
    const a = agent('pattern', '@Tars');
    expect(evaluateEngage(a, '@Tars status?', false, mg, null)).toBe(true);
    expect(evaluateEngage(a, '@tars status?', false, mg, null)).toBe(true); // the fix
    expect(evaluateEngage(a, 'grita @TARS agora', false, mg, null)).toBe(true);
    expect(evaluateEngage(a, 'no mention here', false, mg, null)).toBe(false);
  });

  it("engage_pattern '.' always engages", () => {
    expect(evaluateEngage(agent('pattern', '.'), 'anything at all', false, mg, null)).toBe(true);
  });

  it('a deliberate operator regex (with metacharacters) keeps case-sensitivity', () => {
    // Only literal mention/keyword tokens get the case-insensitive treatment;
    // an operator's regex like [A-Z]{3} or \bAPI\b must match case as written.
    const upper = agent('pattern', '[A-Z]{3}');
    expect(evaluateEngage(upper, 'URGENT ticket', false, mg, null)).toBe(true);
    expect(evaluateEngage(upper, 'lowercase only', false, mg, null)).toBe(false);
    const word = agent('pattern', '\\bAPI\\b');
    expect(evaluateEngage(word, 'the API is down', false, mg, null)).toBe(true);
    expect(evaluateEngage(word, 'the api is down', false, mg, null)).toBe(false);
  });

  it("'mention' mode uses the platform isMention flag, not the message text", () => {
    const a = agent('mention', null);
    expect(evaluateEngage(a, '@Tars', false, mg, null)).toBe(false); // text @Tars is NOT a platform mention
    expect(evaluateEngage(a, 'no text mention', true, mg, null)).toBe(true);
  });

  it('a malformed engage_pattern fails open (engages so the admin notices + can fix it)', () => {
    expect(evaluateEngage(agent('pattern', '('), 'anything', false, mg, null)).toBe(true);
  });
});
