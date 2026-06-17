/**
 * Container extension registry — the boot-path decoupling that lets index.ts
 * (an upstream file) drain fork hooks instead of importing mcp-tools/memory.js.
 *
 * Intent: prove (a) pristine inertness — nothing registered ⇒ runBootSteps() is
 * a no-op and collectSystemPromptAddenda() === '' (so index.ts behaves exactly
 * like upstream when the overlay is absent); (b) boot steps + addenda run in
 * registration order; (c) best-effort — a throwing hook is caught, never aborts
 * boot (matches the fork's "never aborts boot" memory prune). The registry is
 * module-level singleton state, so the empty-state checks run first.
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
  it('runs boot steps and concatenates addenda in registration order; throwing hooks are best-effort', () => {
    const order: string[] = [];
    registerBootStep(() => order.push('boot-a'));
    registerBootStep(() => {
      throw new Error('boom'); // best-effort: must NOT abort the others
    });
    registerBootStep(() => order.push('boot-b'));

    expect(() => runBootSteps()).not.toThrow();
    expect(order).toEqual(['boot-a', 'boot-b']);

    registerSystemPromptAddendum(() => '<recall-1>');
    registerSystemPromptAddendum(() => {
      throw new Error('boom'); // skipped, not fatal
    });
    registerSystemPromptAddendum(() => '<recall-2>');

    expect(collectSystemPromptAddenda()).toBe('<recall-1><recall-2>');
  });
});
