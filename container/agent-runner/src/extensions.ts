/**
 * Container agent-runner extension registry (ADR 0006, container leg).
 *
 * The container ENTRY (`index.ts`) is an upstream file. The fork needs two
 * things hung off the boot path that upstream does not have: a board-memory
 * prune at startup and a once-per-session memory-recall addendum on the system
 * prompt. Rather than `index.ts` importing the fork `mcp-tools/memory.js`
 * directly (a fork-feature boot wired into the core entry — the exact coupling
 * the split removes), the overlay registers into this core registry and
 * `index.ts` drains it. Pristine core registers nothing, so both drains are
 * no-ops and boot behaviour is identical to upstream.
 *
 * Mirrors the `providers/index.js` side-effect-import pattern `index.ts` already
 * uses: the installer appends an overlay registration import to
 * `extensions-register.ts`, which `index.ts` imports for its side effects.
 */

/** A boot-time side effect (e.g. memory forgetting-policy prune). Run once, in
 *  registration order, BEFORE the system prompt is built. Best-effort: a thrown
 *  hook must not abort boot. */
type BootStep = () => void;

/** Contributes a string appended (in registration order) to the runtime
 *  system-prompt addendum. Built once at boot so it stays prompt-cache stable. */
type SystemPromptAddendum = () => string;

const bootSteps: BootStep[] = [];
const promptAddenda: SystemPromptAddendum[] = [];

export function registerBootStep(fn: BootStep): void {
  bootSteps.push(fn);
}

export function registerSystemPromptAddendum(fn: SystemPromptAddendum): void {
  promptAddenda.push(fn);
}

/** Run every registered boot step. Best-effort — a throwing step is logged to
 *  stderr and does not abort boot (matches the fork's "never aborts boot" prune). */
export function runBootSteps(): void {
  for (const step of bootSteps) {
    try {
      step();
    } catch (err) {
      console.error(`[agent-runner] boot step failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Concatenate every registered addendum (registration order). Empty string in
 *  pristine core. A throwing contributor is skipped (best-effort), not fatal. */
export function collectSystemPromptAddenda(): string {
  let out = '';
  for (const fn of promptAddenda) {
    try {
      out += fn();
    } catch (err) {
      console.error(`[agent-runner] prompt addendum failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
