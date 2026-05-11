/**
 * A5 — migrate per-board CLAUDE.md from v1 to v2 tool vocabulary.
 *
 * v1 TaskFlow MCP tools ran in-process per board, so `board_id` was injected
 * from the engine's closure and never appeared in CLAUDE.md call sites. v2's
 * `api_*` tools (shipped in A11) require `board_id` explicitly — this script
 * adds `board_id: BOARD_ID,` to every substitute call site so boards can
 * keep using v1's vocabulary with the new tool names.
 *
 * Phase 1 — direct substitution for 5 tools whose v1→v2 schemas are
 * identical except for the prepended board_id:
 *   taskflow_move      → api_move
 *   taskflow_admin     → api_admin
 *   taskflow_reassign  → api_reassign
 *   taskflow_undo      → api_undo
 *   taskflow_report    → api_report
 *
 * Phase 2 — composite-shape ports:
 *   taskflow_update    → api_update_task     (composite updates: {...})
 *   taskflow_query     → api_query           (composite query: 'X' discriminator)
 *   taskflow_hierarchy → api_hierarchy       (link/unlink/refresh_rollup/tag_parent action)
 *   taskflow_dependency → api_dependency     (add_dep/remove_dep/add_reminder/remove_reminder)
 *   taskflow_create({type:'meeting',...})    → api_create_meeting_task
 *   taskflow_create({type:'simple'|...,...}) → api_create_task
 *   taskflow_create (no inline type literal) → api_create_task fallback
 *   Bare taskflow_create mentions             → api_create_task
 *
 * A5 Phase 2 is complete — all v1 taskflow_* tools now have a v2
 * substitute. Remaining work for full A5 closure is verifying the
 * generated CLAUDE.md content against a live v2 agent on a sample
 * board (qualitative review), then deploying to the 36 prod boards.
 *
 * BOARD_ID is a placeholder the agent resolves from session context, same
 * convention as SENDER (which v1 CLAUDE.md already uses).
 */

// Map v1 tool name → v2 tool name. Most are `taskflow_xxx` → `api_xxx`,
// but `taskflow_update` → `api_update_task` (the v2 name disambiguates
// from `api_update_simple_task` which is a different flat-fields tool).
const DIRECT_SUBSTITUTIONS: Record<string, string> = {
  taskflow_move: 'api_move',
  taskflow_admin: 'api_admin',
  taskflow_reassign: 'api_reassign',
  taskflow_undo: 'api_undo',
  taskflow_report: 'api_report',
  taskflow_update: 'api_update_task',
  taskflow_query: 'api_query',
  taskflow_hierarchy: 'api_hierarchy',
  taskflow_dependency: 'api_dependency',
};

// Phase 2 complete — all v1 taskflow_* tools now have a v2 substitute.
// Empty tuple is preserved for the type-shape of MigrationResult.unmigrated.
const UNMIGRATED_TOOLS = [] as const;

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

  for (const [v1Name, v2Name] of Object.entries(DIRECT_SUBSTITUTIONS)) {
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

  // taskflow_create → api_create_task / api_create_meeting_task.
  // Capture the whole call object literal first, then peek inside the body
  // for `type: '<X>'` to choose the v2 tool. This handles type-anywhere
  // (not just first field) and both single- and double-quoted values.
  // [^()]* in the body is safe for CLAUDE.md call signatures which never
  // contain inner parens — Codex caught the first-field-only regex as a
  // BLOCKER, this is the broader form.
  output = output.replace(
    /\btaskflow_create\(\{([^()]*)\}\)/g,
    (_match, body: string) => {
      substituted++;
      const typeMatch = /\btype:\s*['"]([a-z_]+)['"]/.exec(body);
      const taskType = typeMatch?.[1] ?? null;
      const v2Tool = taskType === 'meeting' ? 'api_create_meeting_task' : 'api_create_task';
      // For api_create_meeting_task the tool name implies type='meeting',
      // so strip the `type: 'meeting'` field from the body. For
      // api_create_task the type is the discriminator and must remain.
      let normalizedBody = body;
      if (v2Tool === 'api_create_meeting_task') {
        normalizedBody = normalizedBody.replace(/\btype:\s*['"][a-z_]+['"]\s*,?\s*/g, '');
      }
      // Clean up leading/trailing commas + whitespace introduced by the
      // strip-and-rebuild. Empty body → emit `{ board_id: BOARD_ID }`
      // with no trailing comma; non-empty → `{ board_id: BOARD_ID, ...body }`.
      const trimmed = normalizedBody.trim().replace(/^,\s*/, '').replace(/,\s*$/, '');
      if (trimmed.length === 0) return `${v2Tool}({ board_id: BOARD_ID })`;
      return `${v2Tool}({ board_id: BOARD_ID, ${trimmed} })`;
    },
  );
  // Bare `taskflow_create` mentions (prose) → api_create_task.
  output = output.replace(/\btaskflow_create\b/g, 'api_create_task');

  const unmigrated = Object.fromEntries(
    UNMIGRATED_TOOLS.map((tool) => [tool, countOccurrences(output, tool)]),
  ) as MigrationResult['unmigrated'];

  return { output, substituted, unmigrated };
}

function countOccurrences(haystack: string, needle: string): number {
  const re = new RegExp(`\\b${needle}\\b`, 'g');
  return (haystack.match(re) ?? []).length;
}
