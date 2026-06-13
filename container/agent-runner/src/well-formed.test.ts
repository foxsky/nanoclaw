import { describe, it, expect } from 'bun:test';

import { toWellFormedText, wellFormedToolResult } from './well-formed.ts';

// A lone UTF-16 surrogate (e.g. an emoji truncated mid-pair upstream, or
// already-corrupt platform text) makes the Anthropic API reject the whole
// request body with `400 ... no low surrogate in string`. These helpers
// neutralise it at the request boundary so the session can't wedge.
describe('toWellFormedText', () => {
  it('replaces a lone high surrogate with U+FFFD', () => {
    expect(toWellFormedText('hi \uD83D end')).toBe('hi � end');
  });

  it('replaces a lone low surrogate with U+FFFD', () => {
    expect(toWellFormedText('x \uDC00 y')).toBe('x � y');
  });

  it('leaves a valid surrogate pair (emoji) intact', () => {
    const ok = 'wave 👋 done — accents áé ok';
    expect(toWellFormedText(ok)).toBe(ok);
  });

  it('handles a high surrogate at the very end of the string', () => {
    expect(toWellFormedText('trailing \uD83D')).toBe('trailing �');
  });

  it('is a no-op for plain ASCII', () => {
    expect(toWellFormedText('nothing to fix')).toBe('nothing to fix');
  });
});

describe('wellFormedToolResult', () => {
  it('sanitizes text content items and preserves other fields', () => {
    const result = { isError: false, content: [{ type: 'text', text: 'bad \uD83D end' }] };
    expect(wellFormedToolResult(result)).toEqual({
      isError: false,
      content: [{ type: 'text', text: 'bad � end' }],
    });
  });

  it('leaves non-text content items and well-formed text untouched', () => {
    const result = {
      content: [
        { type: 'text', text: 'ok 👋' },
        { type: 'image', data: 'abc', mimeType: 'image/png' },
      ],
    };
    expect(wellFormedToolResult(result)).toEqual(result);
  });

  it('passes through a result with no content array', () => {
    const result = { foo: 'bar' } as unknown;
    expect(wellFormedToolResult(result)).toBe(result);
  });
});
