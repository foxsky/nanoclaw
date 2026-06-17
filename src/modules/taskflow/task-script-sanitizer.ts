/**
 * L9 / SEC#11 host leg — TaskFlow board sessions must not persist a task `script`.
 *
 * Defense-in-depth host layer: a TaskFlow board session must not persist a task `script`. The
 * container MCP gate (scheduling.ts) and execution gate (task-script.ts) already refuse scripts on
 * boards, but there was no host-side check — unlike install_packages' two layers. Strip + warn if
 * a script reaches here for a board session.
 *
 * Registered into the core task-script sanitizer contract (ADR 0006 #5). Core's
 * `sanitizeTaskScript` additionally FAILS CLOSED if this function throws.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { registerTaskScriptSanitizer } from '../../task-script-sanitizer.js';
import { resolveTaskflowBoardId } from '../../taskflow-db.js';
import type { Session } from '../../types.js';

function stripBoardScript(session: Session, script: string | null): string | null {
  if (!script) return script;
  const ag = getAgentGroup(session.agent_group_id);
  if (!ag) {
    // Can't resolve the agent group → can't confirm this is a non-board session. Fail CLOSED.
    log.warn('Host scheduling: stripping task script — agent group unresolved (cannot confirm non-board)', {
      agentGroupId: session.agent_group_id,
    });
    return null;
  }
  // Residual fail-open: resolveTaskflowBoardId swallows a taskflow.db open error and returns
  // undefined (indistinguishable from a genuine non-board session), so a board script could slip
  // through if taskflow.db is unreadable at this instant. Narrow + pre-existing — the board's
  // container just used taskflow.db to emit this very system message — and the container MCP gate
  // (scheduling.ts) + execution gate (task-script.ts) are the primary controls.
  const boardId = resolveTaskflowBoardId(ag.folder, true);
  if (boardId) {
    log.warn('Host scheduling: stripped task script for a TaskFlow board session', {
      agentGroupId: session.agent_group_id,
      boardId,
    });
    return null;
  }
  return script;
}

registerTaskScriptSanitizer(stripBoardScript);
