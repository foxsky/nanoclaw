/**
 * Container extension registry — the boot-path decoupling that lets index.ts
 * (an upstream file) drain fork hooks instead of importing mcp-tools/memory.js.
 *
 * Intent: prove (a) pristine inertness — nothing registered ⇒ runBootSteps() is
 * a no-op and collectSystemPromptAddenda() === '' (so index.ts behaves exactly
 * like upstream when the overlay is absent); (b) boot steps + addenda run in
 * registration order; (c) the intentional asymmetry — a boot step is best-effort
 * (a throw is caught, never aborts boot; matches the fork's "never aborts boot"
 * prune), but a system-prompt addendum is FAIL-LOUD (a throw propagates rather
 * than ship a silently-degraded prompt; matches the original unwrapped call).
 * The registry is module-level singleton state, so the empty-state checks run first.
 */
import { describe, expect, it } from 'bun:test';

import {
  collectSystemPromptAddenda,
  registerBootStep,
  registerSystemPromptAddendum,
  runBootSteps,
} from './extensions.js';

describe('container extension registry (pristine-inert)', () => {
  it('runBootSteps() is a no-op and collectSystemPromptAddenda() is empty when nothing is registered', () => {
    expect(() => runBootSteps()).not.toThrow();
    expect(collectSystemPromptAddenda()).toBe('');
  });
});

describe('container extension registry (registered)', () => {
  it('boot steps are best-effort (a throw is caught, others still run, in order)', () => {
    const order: string[] = [];
    registerBootStep(() => order.push('boot-a'));
    registerBootStep(() => {
      throw new Error('boom'); // best-effort: must NOT abort the others
    });
    registerBootStep(() => order.push('boot-b'));

    expect(() => runBootSteps()).not.toThrow();
    expect(order).toEqual(['boot-a', 'boot-b']);
  });

  it('addenda concatenate in registration order, then FAIL LOUD on a throw', () => {
    registerSystemPromptAddendum(() => '<recall-1>');
    registerSystemPromptAddendum(() => '<recall-2>');
    expect(collectSystemPromptAddenda()).toBe('<recall-1><recall-2>');

    // A throwing addendum must propagate — a silently-degraded system prompt is
    // a correctness hazard, so the contributor (not the registry) owns graceful
    // degradation. Registered last so it only affects this assertion.
    registerSystemPromptAddendum(() => {
      throw new Error('boom');
    });
    expect(() => collectSystemPromptAddenda()).toThrow('boom');
  });
});
