/**
 * A5 Phase 1 — migrate per-board CLAUDE.md from v1 to v2 tool vocabulary.
 *
 * v1 TaskFlow MCP tools ran in-process per board, so `board_id` was injected
 * from the engine's closure and never appeared in CLAUDE.md call sites. v2's
 * `api_*` tools (shipped in A11) require `board_id` explicitly — this script
 * adds `board_id: BOARD_ID,` to every direct-substitute call site so boards
 * can keep using the same vocabulary with the new tool names.
 *
 * Direct substitution applies to 5 tools whose v1→v2 schemas are identical
 * shape-for-shape (only the name + the prepended board_id change):
 *   taskflow_move      → api_move
 *   taskflow_admin     → api_admin
 *   taskflow_reassign  → api_reassign
 *   taskflow_undo      → api_undo
 *   taskflow_report    → api_report
 *
 * NOT touched here (different param shapes — Phase 2):
 *   taskflow_query      (sub-query model differs — partial overlap with api_filter_board_tasks)
 *   taskflow_create     (split: api_create_simple_task / api_create_meeting_task)
 *   taskflow_update     (refactored: api_update_simple_task + note tools)
 *   taskflow_hierarchy  (partial overlap with api_linked_tasks)
 *   taskflow_dependency (folds into api_update_simple_task or api_admin)
 *
 * BOARD_ID is a placeholder the agent resolves from session context, same
 * convention as SENDER (which v1 CLAUDE.md already uses).
 */

const DIRECT_SUBSTITUTIONS = [
  'taskflow_move',
  'taskflow_admin',
  'taskflow_reassign',
  'taskflow_undo',
  'taskflow_report',
] as const;

const UNMIGRATED_TOOLS = [
  'taskflow_query',
  'taskflow_create',
  'taskflow_update',
  'taskflow_hierarchy',
  'taskflow_dependency',
] as const;

export interface MigrationResult {
  output: string;
  /** Count of call-site board_id injections (`taskflow_xxx({` → `api_xxx({ board_id: BOARD_ID,`).
   *  Bare-name renames (`taskflow_xxx` not followed by `({`) are also performed
   *  but not counted here — they're usually prose mentions, not call sites, and
   *  the migration-progress metric we care about is "how many call signatures
   *  now carry the v2 board_id contract." */
  substituted: number;
  unmigrated: Record<(typeof UNMIGRATED_TOOLS)[number], number>;
}

export function migrateBoardClaudeMd(input: string): MigrationResult {
  let output = input;
  let substituted = 0;

  for (const v1Name of DIRECT_SUBSTITUTIONS) {
    const v2Name = v1Name.replace(/^taskflow/, 'api');

    // 1) `taskflow_xxx({` — opening of a call object. Inject board_id.
    //    `\b` is a word boundary (excludes `[A-Za-z0-9_]` neighbors), so
    //    a hypothetical `taskflow_move_extra(` won't match here. `\s*`
    //    handles `({task_id` (no space) and `({\n  task_id` (newline).
    const withParen = new RegExp(`\\b${v1Name}\\(\\{\\s*`, 'g');
    output = output.replace(withParen, (_match) => {
      substituted++;
      return `${v2Name}({ board_id: BOARD_ID, `;
    });

    // 2) Bare `taskflow_xxx` (no opening paren-brace after). Just rename.
    //    Order matters: this runs after pattern 1 so its already-substituted
    //    `api_xxx({` occurrences won't be re-touched.
    const bare = new RegExp(`\\b${v1Name}\\b`, 'g');
    output = output.replace(bare, v2Name);
  }

  const unmigrated = Object.fromEntries(
    UNMIGRATED_TOOLS.map((tool) => [tool, countOccurrences(output, tool)]),
  ) as MigrationResult['unmigrated'];

  return { output, substituted, unmigrated };
}

function countOccurrences(haystack: string, needle: string): number {
  const re = new RegExp(`\\b${needle}\\b`, 'g');
  return (haystack.match(re) ?? []).length;
}
