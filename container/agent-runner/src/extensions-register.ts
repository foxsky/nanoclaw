/**
 * Install-overlay append point for container boot-path extensions (ADR 0006).
 *
 * Core ships this EMPTY. `index.ts` imports it for side effects (mirroring its
 * `import './providers/index.js';`). The `/add-taskflow` installer appends:
 *   import './memory-boot.js';
 * which registers the board-memory prune (boot step) + recall addendum into the
 * extension registry. Pristine core boots with zero registered hooks, so
 * `index.ts`'s `runBootSteps()` / `collectSystemPromptAddenda()` drains are
 * no-ops — identical to upstream.
 */
export {};
