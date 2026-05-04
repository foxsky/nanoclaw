/**
 * Fork-private types quarantined here while skill/taskflow-v2 lands its
 * v2-shape port. Each type below has a v2 equivalent that will replace it
 * as its owning module is ported. When the last importer of a given type
 * is migrated, delete the type from this file. When this file is empty,
 * delete it.
 *
 * Migration map:
 *   v1 AgentTurnContext  → Phase 3 (agent turn modeling) — TODO
 */

export interface AgentTurnContext {
  turnId: string;
  /** Sender JID of the trigger message, used by the memory layer for attribution. */
  senderJid?: string;
}
