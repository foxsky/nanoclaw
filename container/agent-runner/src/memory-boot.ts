/**
 * TaskFlow overlay: wires the board-memory boot hooks into the container entry's
 * extension registry (ADR 0006, container leg). The `/add-taskflow` installer
 * appends this module's import to `extensions-register.ts`. Pristine core never
 * imports it, so `index.ts` runs no memory prune/recall (upstream behaviour).
 *
 * - `pruneBoardMemory`: forgetting-policy prune, run at boot BEFORE the system
 *   prompt is built so the recall reflects the pruned set.
 * - `buildMemoryRecallAddendum`: once-per-session recall appended to the system
 *   prompt (stable for the container's life — prompt-cache safe).
 * Both are env-gated no-ops when memory is unconfigured.
 */
import { registerBootStep, registerSystemPromptAddendum } from './extensions.js';
import { buildMemoryRecallAddendum, pruneBoardMemory } from './mcp-tools/memory.js';

registerBootStep(pruneBoardMemory);
registerSystemPromptAddendum(buildMemoryRecallAddendum);
