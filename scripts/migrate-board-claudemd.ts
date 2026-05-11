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

export interface MigrationOptions {
  /** When set, replace the BOARD_ID placeholder with the literal value at the
   *  end of substitution. Matches v2's provision-shared {{BOARD_ID}} pattern
   *  (host-side render before the agent sees it). Omit to keep BOARD_ID as
   *  a placeholder for downstream templating. */
  boardId?: string;
}

export function migrateBoardClaudeMd(input: string, options?: MigrationOptions): MigrationResult {
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

  // Wildcard prose references like `taskflow_*` → `api_*`. The bare-rename
  // pass at the top uses `\b...\b` and so misses these (asterisk is not a
  // word character). v1 CLAUDE.md has 3 such mentions ("use `taskflow_*`
  // MCP tools", "operations that have NO `taskflow_*` equivalent", etc.)
  // which would otherwise tell the agent to call tools that no longer exist.
  output = output.replace(/\btaskflow_\*/g, 'api_*');

  // A5 follow-up — v2 send_message + schedule_task schema rewrites.
  // The earlier mechanical pass only handled v1 tool RENAMES (taskflow_* →
  // api_*). v1 prose also encodes the OLD schemas of send_message and
  // schedule_task, which differ in v2. These substitutions rewrite the
  // shapes the agent literally calls.

  // 1. pending_approval envelope — engine now emits `destination_name`
  //    (per A12), not `target_chat_jid`.
  output = output.replace(
    /\bpending_approval:\s*\{\s*request_id,\s*target_chat_jid,\s*message,\s*parent_board_id\s*\}/g,
    'pending_approval: { request_id, destination_name, message, parent_board_id }',
  );

  // 2. Approval-mode forward call — v1 used the raw JID, v2 uses the
  //    symbolic destination_name from the engine's pending_approval.
  //    Object-shorthand variant ({ target_chat_jid, text: message }).
  output = output.replace(
    /\bsend_message\(\{\s*target_chat_jid,\s*text:\s*message\s*\}\)/g,
    'send_message({ to: pending_approval.destination_name, text: pending_approval.message })',
  );
  //    Literal-args variant (target_chat_jid: '<parent_group_jid>', text:'<forward message>').
  output = output.replace(
    /\bsend_message\(\{\s*target_chat_jid:\s*'<parent_group_jid>',\s*text:\s*'<forward message>'\s*\}\)/g,
    "send_message({ to: pending_approval.destination_name, text: pending_approval.message })",
  );

  // 3. send_message tool-signature documentation line — v2 dropped
  //    `sender` and renamed `target_chat_jid` → `to`.
  output = output.replace(
    /send_message\(text:\s*"\[MESSAGE\]",\s*sender:\s*"\[OPTIONAL_ROLE_NAME\]",\s*target_chat_jid:\s*"\[OPTIONAL_JID\]"\)/g,
    'send_message({ text: "[MESSAGE]", to: "[OPTIONAL_DESTINATION_NAME]" })',
  );

  // 4. schedule_task tool signature — v1 had schedule_type/schedule_value;
  //    v2 has processAfter + optional recurrence.
  output = output.replace(
    /schedule_task\(prompt:\s*"\[PROMPT\]",\s*schedule_type:\s*"\[cron\|interval\|once\]",\s*schedule_value:\s*"\[CRON_OR_TIMESTAMP\]",\s*context_mode:\s*"group"\)/g,
    'schedule_task({ prompt: "[PROMPT]", processAfter: "[ISO_TIMESTAMP_OR_NULL]", recurrence: "[OPTIONAL_CRON]" })',
  );

  // 5. Prose "schedule_task with schedule_type: 'X'" — drop the obsolete
  //    field reference. Match common phrasings.
  output = output.replace(
    /`schedule_task`\s+with\s+`schedule_type:\s*'[a-z]+'`/g,
    '`schedule_task` with `processAfter`',
  );

  // 6. duplicate_warning / force_create block — v2 api_create_task has
  //    neither field. The whole paragraph (lead sentence through the
  //    force_create-true rerun instruction) is obsolete. Pattern matches
  //    the post-rename text (taskflow_create → api_create_task already
  //    applied above).
  output = output.replace(
    /\nWhen `api_create_task` returns `duplicate_warning`[\s\S]*?command without confirming, treat it as NOT a confirmation — remind them the task already exists\.\n/g,
    '\n',
  );

  // 6b. Blanket prose mentions: backtick-wrapped v1 identifiers that no
  //     longer exist in v2's schema. Catches lines like "DM delivery via
  //     `target_chat_jid`" — the named code/call references have already
  //     been rewritten by patches 1-5; what remains is documentation
  //     prose that needs the new identifier to stay coherent.
  output = output.replace(/`target_chat_jid`/g, '`to`');
  output = output.replace(/`schedule_value`/g, '`processAfter`');
  output = output.replace(/`schedule_type`/g, '`processAfter`');
  // Backticked example values like `schedule_value: "2026-03-18T07:30:00"`
  // — preserve the literal value, just rename the field.
  output = output.replace(/`schedule_value:\s*"([^"]*)"`/g, '`processAfter: "$1"`');

  // 7. Notification Dispatch section — v1's multi-paragraph rule told
  //    the agent to relay notifications[*].target_chat_jid via
  //    send_message. v2's engine auto-dispatches; tool responses carry
  //    `notification_events` for inspection only.
  output = output.replace(
    /## Notification Dispatch\n[\s\S]*?(?=\n## )/,
    '## Notification Dispatch\n\nThe v2 engine dispatches all cross-chat notifications itself. Tool responses may carry a `notification_events` array — **informational only; do NOT relay**. Your normal assistant reply still covers the current chat.\n\n',
  );

  // When a boardId is supplied, render the BOARD_ID placeholder to the literal
  // value, matching v2's provision-shared {{BOARD_ID}} host-side templating.
  // Without this, the agent would pass the string "BOARD_ID" as board_id and
  // the engine would fail board lookup.
  if (options?.boardId) {
    output = output.replace(/\bBOARD_ID\b/g, `'${options.boardId}'`);
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
