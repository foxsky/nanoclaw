import { describe, expect, it } from 'vitest';

import { classifyTaskflowResponse } from './internal-api.js';

describe('classifyTaskflowResponse', () => {
  it('2xx → ok with parsed data', () => {
    // WHY: callers (mark-delivered/agent-reply) read the body
    // (`{marked}`, `{board_chat_id,marked_read,duplicate}`).
    expect(classifyTaskflowResponse(200, { marked: true })).toEqual({
      kind: 'ok',
      data: { marked: true },
    });
  });

  it('4xx with detail.error_code → terminal, carries the code', () => {
    // WHY (v3 contract Q3/Q4): a validation reject is a PERMANENT
    // payload bug. The caller must log loud + return normally so
    // delivery.ts does NOT retry (blanket-retry would poison the queue).
    expect(classifyTaskflowResponse(400, { detail: { error_code: 'missing_source_outbound_id' } })).toEqual({
      kind: 'terminal',
      errorCode: 'missing_source_outbound_id',
    });
  });

  it('401 (bad/unset internal token) → terminal, not retried', () => {
    // WHY: a misconfigured TASKFLOW_INTERNAL_TOKEN is permanent until
    // an operator fixes it; retrying forever is wrong. Surface + stop.
    expect(classifyTaskflowResponse(401, { detail: 'Invalid internal token' })).toEqual({
      kind: 'terminal',
      errorCode: 'http_401',
    });
  });

  it('413 (payload too large) → terminal', () => {
    expect(classifyTaskflowResponse(413, {}).kind).toBe('terminal');
  });

  it('503 (tf "Database error") → retry', () => {
    // WHY: transient. The caller must throw so delivery.ts retries →
    // eventually markDeliveryFailed; never silently drop.
    expect(classifyTaskflowResponse(503, { detail: 'Database error' })).toEqual({
      kind: 'retry',
      reason: 'http_503',
    });
  });

  it('500 → retry', () => {
    expect(classifyTaskflowResponse(500, {}).kind).toBe('retry');
  });

  it('4xx without a structured detail.error_code → terminal with http_<status> fallback', () => {
    expect(classifyTaskflowResponse(400, { detail: 'plain string' })).toEqual({
      kind: 'terminal',
      errorCode: 'http_400',
    });
    expect(classifyTaskflowResponse(422, null)).toEqual({
      kind: 'terminal',
      errorCode: 'http_422',
    });
  });
});
