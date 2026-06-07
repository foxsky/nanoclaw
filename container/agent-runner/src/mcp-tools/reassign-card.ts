// Side-effect-free reassign-card helpers (Codex NICE: keep poll-loop out of the
// tool-registering mutate module). Two deterministic v2-coherent formats, each
// backed by ≥1 prod-corpus exemplar — v1's reassign confirmations were
// LLM-composed and VARY (e.g. seci turns 36 vs 37 render the SAME task two ways),
// so this is NOT a byte-port; v2 picks one deterministic format per shape.
import { parseIsoCalendarDate } from '../iso-date.js';
import { isTaskflowSubprocess } from './taskflow-helpers.js';

export interface ReassignTaskInfo {
  parent_task_id?: string | null;
  parent_task_title?: string | null;
  due_date?: string | null;
  /** Pre-reassign assignee display name — the poll-loop caller captures it
   *  BEFORE the mutation (getTask post-commit returns the NEW assignee). Enables
   *  the De/Para format for no-parent tasks. */
  from_assignee?: string | null;
}

const SEP = '━━━━━━━━━━━━━━';
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * v2-coherent rich reassign card. Returns null when no exemplar-backed format
 * applies (caller falls back to the short form — no fabrication).
 *   • Format A — parent tree (corpus: seci#37): `✅ *id* reatribuída / ━━━ /
 *     📁 *parent* — ptitle / 📋 *id* — title / 👤 *Para:* X [/ ⏰ Prazo: dd/mm/yyyy]`.
 *   • Format B — De/Para (corpus: laizys#2/#26, seci#36, thiago#8): when there's no
 *     parent but the previous assignee is known: `✅ *id* reatribuída / ━━━ /
 *     👤 *De:* from / 👤 *Para:* X`.
 */
export function buildReassignCard(data: {
  id?: unknown;
  title?: unknown;
  parentId?: unknown;
  parentTitle?: unknown;
  dueDate?: unknown;
  assignee?: unknown;
  fromAssignee?: unknown;
}): string | null {
  const id = str(data.id);
  const title = str(data.title);
  const assignee = str(data.assignee);
  if (!id || !title || !assignee) return null;

  const parentId = str(data.parentId);
  const parentTitle = str(data.parentTitle);
  if (parentId && parentTitle) {
    const lines = [
      `✅ *${id}* reatribuída`,
      SEP,
      '',
      `📁 *${parentId}* — ${parentTitle}`,
      `   📋 *${id}* — ${title}`,
      '',
      `👤 *Para:* ${assignee}`,
    ];
    const due = str(data.dueDate);
    if (due) {
      const iso = parseIsoCalendarDate(due);
      if (iso) lines.push(`⏰ Prazo: ${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`);
    }
    return lines.join('\n');
  }

  // De/Para is the NO-PARENT format only. A task WITH a parent whose title
  // couldn't be resolved (e.g. cross-board) must fall back to the short form,
  // not De/Para (Codex gate) — `parentId` is the "has a parent" signal.
  const from = str(data.fromAssignee);
  if (!parentId && from) {
    return [`✅ *${id}* reatribuída`, SEP, '', `👤 *De:* ${from}`, `👤 *Para:* ${assignee}`].join('\n');
  }

  return null;
}

/**
 * The per-task parent + due_date resolver for the rich card, GATED to the
 * in-session agent. api_reassign is allowlisted in the tf-mcontrol FastAPI
 * subprocess; there we return undefined so the caller keeps the EXACT prior short
 * form (API response contract unchanged — and no WhatsApp card is emitted there).
 * Reads POST-commit state — reassign moves neither the task's parent nor due_date
 * (the from_assignee is supplied separately by the caller, pre-commit).
 */
export function buildReassignLookup(
  engine: { getTask: (id: string) => { parent_task_id?: string | null; due_date?: string | null; title?: string } | null },
): ((taskId: string) => ReassignTaskInfo | null) | undefined {
  if (isTaskflowSubprocess()) return undefined;
  return (taskId: string): ReassignTaskInfo | null => {
    const t = engine.getTask(taskId);
    if (!t) return null;
    const parent = t.parent_task_id ? engine.getTask(t.parent_task_id) : null;
    return { parent_task_id: t.parent_task_id, parent_task_title: parent?.title, due_date: t.due_date };
  };
}

/**
 * Resolve the single-task rich-card info that BOTH reassign emitters need after
 * a committed reassign — the deterministic poll-loop path and the api_reassign
 * MCP tool. Centralizes three concerns so the two callers can't drift:
 *   • subprocess gate — in the tf-mcontrol FastAPI subprocess buildReassignLookup
 *     is undefined, so we return null and the caller keeps the EXACT prior short
 *     form (API contract unchanged; no WhatsApp card emitted there anyway).
 *   • the post-commit parent + due_date lookup (reassign moves neither).
 *   • the pre-captured previous assignee (from_assignee) for the De/Para format.
 * FAIL-SOFT: the mutation has ALREADY committed, so a lookup throw must never
 * bubble up and turn a successful reassign into an error — it degrades to the
 * from_assignee-only card (De/Para) or, lacking that, the short form.
 */
export function buildReassignInfo(
  engine: { getTask: (id: string) => { parent_task_id?: string | null; due_date?: string | null; title?: string } | null },
  taskId: string,
  fromAssignee?: string | null,
): ReassignTaskInfo | null {
  const lookup = buildReassignLookup(engine);
  if (!lookup) return null; // tf-mcontrol subprocess: keep the exact prior short form
  const fallback = fromAssignee ? { from_assignee: fromAssignee } : null;
  try {
    const base = lookup(taskId);
    if (!base) return fallback;
    return { ...base, from_assignee: fromAssignee ?? null };
  } catch {
    return fallback;
  }
}
