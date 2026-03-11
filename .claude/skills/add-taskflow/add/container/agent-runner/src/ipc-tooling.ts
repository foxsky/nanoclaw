/**
 * Shared IPC tooling helpers for create_group authorization and validation.
 */

interface CreateGroupContext {
  isMain: boolean;
  isTaskflowManaged: boolean;
  taskflowHierarchyLevel?: number;
  taskflowMaxDepth?: number;
}

/**
 * Check whether the current group is allowed to create new WhatsApp groups.
 * - Main can always create groups.
 * - TaskFlow groups can create child groups if their next level fits under max depth.
 * - Other groups cannot create groups.
 */
export function canUseCreateGroup(ctx: CreateGroupContext): boolean {
  if (ctx.isMain) return true;
  if (!ctx.isTaskflowManaged) return false;

  // TaskFlow groups can create child groups only when next level fits within max depth
  if (
    ctx.taskflowHierarchyLevel !== undefined &&
    ctx.taskflowMaxDepth !== undefined &&
    !Number.isNaN(ctx.taskflowHierarchyLevel) &&
    !Number.isNaN(ctx.taskflowMaxDepth) &&
    ctx.taskflowHierarchyLevel >= 0 &&
    ctx.taskflowMaxDepth >= 0
  ) {
    return ctx.taskflowHierarchyLevel + 1 <= ctx.taskflowMaxDepth;
  }

  return false;
}

/**
 * Validate and normalize a create_group request.
 * Returns null if the request is invalid.
 */
export function normalizeCreateGroupRequest(
  subject: string,
  participants: string[],
): { subject: string; participants: string[] } | null {
  const trimmed = subject.trim();
  if (!trimmed || trimmed.length > 100) return null;

  // Deduplicate and filter valid WhatsApp user JIDs
  const uniqueParticipants = [
    ...new Set(
      participants
        .map((p) => p.trim())
        .filter((p) => p.endsWith('@s.whatsapp.net') && p.length > 16),
    ),
  ];

  if (uniqueParticipants.length === 0 || uniqueParticipants.length > 256) {
    return null;
  }

  return { subject: trimmed, participants: uniqueParticipants };
}
