/**
 * A5 — migrate per-board CLAUDE.md from v1 to v2 tool vocabulary.
 *
 * Pure rename of v1 `taskflow_*` MCP tool names to their v2 `api_*`
 * equivalents. v1's `board_id` was host-injected from the engine's closure
 * and never appeared in CLAUDE.md call sites; v2 preserves that contract
 * by host-injecting from the NANOCLAW_TASKFLOW_BOARD_ID env var at the
 * MCP handler boundary (see `normalizeAgentIds` in
 * container/agent-runner/src/mcp-tools/taskflow-helpers.ts). This script
 * therefore does NOT touch arg lists — the v1 examples already omit
 * board_id, and v2 reads it from env.
 *
 * Phase 1 — direct rename for 5 simple tools:
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
  /** Count of call-site renames (`taskflow_xxx({` → `api_xxx({`). Bare-name
   *  renames (`taskflow_xxx` not followed by `({`) are also performed but
   *  not counted here — they're usually prose mentions, not call signatures,
   *  and the migration-progress metric is "how many call signatures got
   *  retargeted to the v2 tool surface." */
  substituted: number;
  unmigrated: Record<(typeof UNMIGRATED_TOOLS)[number], number>;
}

export function migrateBoardClaudeMd(input: string): MigrationResult {
  let output = input;
  let substituted = 0;

  for (const [v1Name, v2Name] of Object.entries(DIRECT_SUBSTITUTIONS)) {
    // 1) `taskflow_xxx({` — opening of a call object. Pure rename — v2
    //    host-injects board_id at the MCP boundary (see `normalizeAgentIds`
    //    in container/agent-runner/src/mcp-tools/taskflow-helpers.ts), so
    //    examples don't need to teach the agent to pass it. `\b` excludes
    //    word-suffix matches like `taskflow_move_extra`.
    const withParen = new RegExp(`\\b${v1Name}\\(\\{`, 'g');
    output = output.replace(withParen, (_match) => {
      substituted++;
      return `${v2Name}({`;
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
      // strip-and-rebuild. No board_id injection — see pattern 1 above.
      const trimmed = normalizedBody.trim().replace(/^,\s*/, '').replace(/,\s*$/, '');
      if (trimmed.length === 0) return `${v2Tool}({})`;
      return `${v2Tool}({ ${trimmed} })`;
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

  if (!output.includes('Pure greetings with no task intent')) {
    output = output.replace(
      /You are a task management assistant ONLY\. If the message is NOT about tasks, board, capture, status, scheduling, people, deadlines, or any topic covered in this document, reply with a single short sentence in ([^.]+?) explaining you only handle task management, and suggest `ajuda`, `comandos`, or `help`\. Do NOT query the database for off-topic requests\./,
      (match) =>
        [
          match,
          '',
          'Pure greetings with no task intent (for example, "oi", "olá", "bom dia") are off-topic for TaskFlow. Classify this by the latest `<message>` body, even if the prompt also includes recent history or board context. Reply in this scope-guard shape: "Oi, [nome]! Aqui só cuido de gestão de tarefas. Use `ajuda` ou `quadro` para começar." Do not ask the open-ended general-assistant question "Como posso ajudar?".',
        ].join('\n'),
    );
  }

  if (!output.includes('**Delivery format is mandatory.**')) {
    output = output.replace(
      /All output in [^.]+?\./,
      (match) =>
        [
          match,
          '',
          '**Delivery format is mandatory.** Every user-visible reply must be wrapped in a `<message to="...">...</message>` block using the incoming message\'s `from` destination. Text outside `<message>` blocks is scratchpad only and will not be sent. This applies even to short greetings, ambiguity questions, and no-tool replies.',
        ].join('\n'),
    );
  }

  if (!output.includes('**Exact task-ID scope lock.**')) {
    output = output.replace(
      /\*\*CRITICAL — NEVER display task details from memory\.\*\* When a user mentions a task ID \(e\.g\. "P1\.9", "T41", "detalhes T3"\), you MUST call `api_query\(\{ query: 'task_details', task_id: '\.\.\.' \}\)` BEFORE showing any task information \(title, assignee, column, dates, notes\)\. NEVER generate task titles, descriptions, or status from memory or conversation history — always read from the database first\. Hallucinated task details propagate through session resume and context summaries, causing persistent wrong information\. This rule has NO exceptions\./,
      (match) =>
        [
          match,
          '',
          '**Exact task-ID scope lock.** When the user names an exact task/subtask ID, keep that exact ID through the whole read/confirm/mutate flow. `P6.7` means `P6.7`, not parent project `P6` and not sibling subtasks under `P6`. For review-bypass diagnostics like _"por que P6.7 não passou pela revisão?"_, read `api_query({ query: \'task_history\', task_id: \'P6.7\' })` and `api_query({ query: \'task_details\', task_id: \'P6.7\' })`. If you ask _"Deseja reabrir e exigir aprovação para P6.7?"_ and the user answers _"sim"_, execute exactly: `api_move({ task_id: \'P6.7\', action: \'reopen\', sender_name: SENDER })` then `api_update_task({ task_id: \'P6.7\', updates: { requires_close_approval: true }, sender_name: SENDER })`. Do NOT apply approval-policy changes to other active `P6.*` tasks unless the user explicitly says "todas", "as atividades", or names those IDs.',
        ].join('\n'),
    );
  }

  if (!output.includes('**Cross-board note-forward confirmation.**')) {
    const before = output;
    output = output.replace(
      /\*\*Cross-board task lookup \(fallback\)\.\*\* When `task_details` returns `Task not found` for a task ID that may live on a sibling\/parent board \(e\.g\. the user mentions a `T###` you don't recognise on this board\), call `api_query\(\{ query: 'find_task_in_organization', task_id: 'TXXX' \}\)`\. It scopes to this board's org tree \(root \+ descendants, same scope as `find_person_in_organization`\) and returns `\[\{ task_id, board_id, board_group_folder, type, title, column, assignee, assignee_name, due_date, parent_task_id, requires_close_approval, group_jid \}\]`\. Use the result to show the task with a clear "Quadro: <board_group_folder>" label so the user knows it's a cross-board read\. This is \*\*read-only\*\* — to mutate the task, the user must act from its owning board\. Do NOT fall back to `mcp__sqlite__read_query` for cross-board task lookups\./,
      (match) =>
        [
          match,
          '',
          '**Cross-board note-forward confirmation.** If the user tried to add a note/update to an exact task ID, `task_details`/`find_task_in_organization` shows it belongs to a sibling board, and the user identifies the destination board/person (e.g. _"esta tarefa é do quadro da Laizys"_), keep the pending note text and ask a concrete forwarding confirmation: _"Posso encaminhar a nota \'<texto>\' para o quadro da Laizys?"_. If the next user message is a bare confirmation ("sim", "pode", "confirma"), call `send_message` to the registered destination name for that board/person with the note text and task title. Do NOT answer with "aguardando confirmação do quadro"; the confirmation is for the forward action, not for validating the board identity.',
        ].join('\n'),
    );
    if (output === before) {
      output = output.replace(
        /(\*\*Exact task-ID scope lock\.\*\* [^\n]+)/,
        [
          '$1',
          '',
          '**Cross-board note-forward confirmation.** If the user tried to add a note/update to an exact task ID, `task_details`/`find_task_in_organization` shows it belongs to a sibling board, and the user identifies the destination board/person (e.g. _"esta tarefa é do quadro da Laizys"_), keep the pending note text and ask a concrete forwarding confirmation: _"Posso encaminhar a nota \'<texto>\' para o quadro da Laizys?"_. If the next user message is a bare confirmation ("sim", "pode", "confirma"), call `send_message` to the registered destination name for that board/person with the note text and task title. Do NOT answer with "aguardando confirmação do quadro"; the confirmation is for the forward action, not for validating the board identity.',
        ].join('\n'),
      );
    }
  }

  output = output.replace(
    /(^|\n)## Welcome Check\n\nOn the FIRST interaction in a new session, check if a welcome message has been sent:\n1\. Query: `SELECT welcome_sent FROM board_runtime_config WHERE board_id = '[^']+'`\n2\. If `welcome_sent = 0`: send a brief welcome, then `UPDATE board_runtime_config SET welcome_sent = 1 WHERE board_id = '[^']+'`\n/g,
    '$1',
  );

  if (!output.includes('**Hierarchy status sync synonym:**')) {
    output = output.replace(
      /\*\*Command synonyms:\*\* "consolidado" \/ "consolidar" = "quadro" \(board view\)\. "atividades" = "minhas tarefas" \(my tasks\)\. "finalizar" \/ "concluir" \/ "fechar" = conclude\. "cancelar" \(bare, no task ID\) = ask which task to cancel or what to cancel\. When a user says "concluir tarefa" without specifying an ID and has only one active task, apply it to that task\. If multiple are active, list them and ask\./,
      [
        '**Command synonyms:** "consolidado" / "consolidar" = "quadro" (board view). "atividades" = "minhas tarefas" (my tasks). "finalizar" / "concluir" / "fechar" = conclude. "cancelar" (bare, no task ID) = ask which task to cancel or what to cancel. When a user says "concluir tarefa" without specifying an ID and has only one active task, apply it to that task. If multiple are active, list them and ask.',
        '',
        "**Hierarchy status sync synonym:** \"atualizar status TXXX/PXXX.N\" or \"sincronizar TXXX/PXXX.N\" means pull the linked child-board rollup: `api_hierarchy({ action: 'refresh_rollup', task_id: 'TXXX/PXXX.N', sender_name: SENDER })`. It is NOT a request to choose a new status or ask what status to set.",
      ].join('\n'),
    );
  }

  if (!output.includes('**Pre-tool command gate.**')) {
    output = output.replace(
      /## Command -> Tool Mapping\n\nWhen the user sends a command, call the matching MCP tool\. The tool handles all validation, permission checks, and side effects\./,
      [
        '## Command -> Tool Mapping',
        '',
        '**Pre-tool command gate.** Before calling any TaskFlow tool, first decide whether the user gave an explicit command. A standalone infinitive planning goal is NOT an explicit command, even if it describes actionable work. For messages like "Submeter ao menos 1 proposta a financiador externo", "Realizar 8 edições mensais do Inova Talks (mai-dez/2026)", or "Aguardar e acompanhar licitação...", reply in plain text asking whether to register/capture it, then stop. Do not call `api_query`, `api_create_task`, or any other tool for that turn.',
        '',
        'When the user sends a command, call the matching MCP tool. The tool handles all validation, permission checks, and side effects.',
      ].join('\n'),
    );
  }

  if (!output.includes('**Bare goal/activity phrases are not task-creation commands.**')) {
    output = output.replace(
      /The user's words are clues, not commands\. "Me lembre de ligar pro João" is a reminder — the user expects to be notified, not to find an inbox item\. "Anotar: comprar café" is a capture\. "Tarefa para Giovanni: revisar relatório" is an assigned task\. But always consider the full context — the same words can mean different things depending on the situation\./,
      [
        'The user\'s words are clues, not commands. "Me lembre de ligar pro João" is a reminder — the user expects to be notified, not to find an inbox item. "Anotar: comprar café" is a capture. "Tarefa para Giovanni: revisar relatório" is an assigned task. But always consider the full context — the same words can mean different things depending on the situation.',
        '',
        '**Bare goal/activity phrases are not task-creation commands.** If the user sends a standalone activity/status/goal phrase such as "Aguardar e acompanhar X", "Submeter X", "Realizar X", "Acompanhar X", or "Verificar se X" without explicitly asking to create/register/add/capture a task, do NOT search or create automatically. Treat it as ambiguous context: answer from available context and ask whether to capture/register it.',
      ].join('\n'),
    );
  }
  if (!output.includes('**Plain-text ambiguity questions.**')) {
    output = output.replace(
      /\*\*Bare goal\/activity phrases are not task-creation commands\.\*\* If the user sends a standalone activity\/status\/goal phrase such as "Aguardar e acompanhar X", "Submeter X", "Realizar X", "Acompanhar X", or "Verificar se X" without explicitly asking to create\/register\/add\/capture a task, do NOT search or create automatically\. Treat it as ambiguous context: answer from available context and ask whether to capture\/register it\./,
      [
        '**Bare goal/activity phrases are not task-creation commands.** If the user sends a standalone activity/status/goal phrase such as "Aguardar e acompanhar X", "Submeter X", "Realizar X", "Acompanhar X", or "Verificar se X" without explicitly asking to create/register/add/capture a task, do NOT search or create automatically. Treat it as ambiguous context: answer from available context and ask whether to capture/register it.',
        '',
        '**Plain-text ambiguity questions.** In TaskFlow command handling, "ask" means reply with a normal chat message unless a section explicitly says to present a card/buttons. Do NOT call `ask_user_question` just to ask whether an ambiguous phrase should become a task; v1 asked these questions in plain text with no tool call.',
      ].join('\n'),
    );
  }
  if (!output.includes('Do NOT treat standalone planning goals as create commands.')) {
    output = output.replace(
      /"tarefa" with "para Y" creates an assigned task\. Without "para Y", it goes to inbox \(see Quick Capture above\)\./,
      [
        '"tarefa" with "para Y" creates an assigned task. Without "para Y", it goes to inbox (see Quick Capture above).',
        '',
        'Do NOT treat standalone planning goals as create commands. These are ambiguity questions, not tool calls:',
        '',
        '| User says | Correct behavior |',
        '|-----------|------------------|',
        '| "Submeter ao menos 1 proposta a financiador externo" | Ask in plain text whether to register/capture it; do not call `api_query` or `api_create_task` |',
        '| "Realizar 8 edições mensais do Inova Talks (mai-dez/2026)" | Ask in plain text whether to register/capture it; do not create a project or subtasks |',
        '| "Aguardar e acompanhar licitação para reforma do prédio" | Ask in plain text whether to register/capture it; do not create a task |',
      ].join('\n'),
    );
  }

  // Phase 2 replay gap: v1 handled "P11 acrescentar/adicionar tarefa X" by
  // creating a simple task, then reparenting that task under the project via
  // taskflow_admin({ action: 'reparent_task' }). The mechanical v2 prompt
  // only documented the narrower "adicionar etapa" wording. Add synonym rows
  // idempotently so corpus-derived board prompts preserve the v1 two-call
  // behavior without hand-editing every per-board CLAUDE.md.
  if (!output.includes('"PXXX acrescentar/adicionar tarefa X"')) {
    output = output.replace(
      /\| "diario\/semanal\/mensal\/anual para Y: X" \| `api_create_task\(\{ type: 'recurring', title: 'X', assignee: 'Y', recurrence: FREQ, sender_name: SENDER \}\)` \|/,
      [
        '| "diario/semanal/mensal/anual para Y: X" | `api_create_task({ type: \'recurring\', title: \'X\', assignee: \'Y\', recurrence: FREQ, sender_name: SENDER })` |',
        '| "PXXX acrescentar/adicionar tarefa X" | Two calls in sequence: (1) `api_create_task({ type: \'simple\', title: \'X\', assignee: SENDER, sender_name: SENDER })`; (2) `api_admin({ action: \'reparent_task\', task_id: \'<created_task_id>\', target_parent_id: \'PXXX\', sender_name: SENDER })` |',
        '| "adicionar em PXXX a tarefa X" | Two calls in sequence: (1) `api_create_task({ type: \'simple\', title: \'X\', assignee: SENDER, sender_name: SENDER })`; (2) `api_admin({ action: \'reparent_task\', task_id: \'<created_task_id>\', target_parent_id: \'PXXX\', sender_name: SENDER })` |',
        '| "[nome do projeto] adicionar/acrescentar tarefa X" | Do NOT use `api_create_task`. Use `api_update_task({ task_id: \'<matched_project_id>\', updates: { add_subtask: \'X\' }, sender_name: SENDER })` when the project is identifiable from board context; if multiple projects match, ask which one |',
      ].join('\n'),
    );
  }
  if (!output.includes('"[nome do projeto] adicionar/acrescentar tarefa X"')) {
    output = output.replace(
      /\| "PXXX acrescentar\/adicionar tarefa X" \| Two calls in sequence: \(1\) `api_create_task\(\{ type: 'simple', title: 'X', assignee: SENDER, sender_name: SENDER \}\)`; \(2\) `api_admin\(\{ action: 'reparent_task', task_id: '<created_task_id>', target_parent_id: 'PXXX', sender_name: SENDER \}\)` \|/,
      [
        '| "PXXX acrescentar/adicionar tarefa X" | Two calls in sequence: (1) `api_create_task({ type: \'simple\', title: \'X\', assignee: SENDER, sender_name: SENDER })`; (2) `api_admin({ action: \'reparent_task\', task_id: \'<created_task_id>\', target_parent_id: \'PXXX\', sender_name: SENDER })` |',
        '| "adicionar em PXXX a tarefa X" | Two calls in sequence: (1) `api_create_task({ type: \'simple\', title: \'X\', assignee: SENDER, sender_name: SENDER })`; (2) `api_admin({ action: \'reparent_task\', task_id: \'<created_task_id>\', target_parent_id: \'PXXX\', sender_name: SENDER })` |',
        '| "[nome do projeto] adicionar/acrescentar tarefa X" | Do NOT use `api_create_task`. Use `api_update_task({ task_id: \'<matched_project_id>\', updates: { add_subtask: \'X\' }, sender_name: SENDER })` when the project is identifiable from board context; if multiple projects match, ask which one |',
      ].join('\n'),
    );
  }
  if (!output.includes('"adicionar em PXXX a tarefa X"')) {
    output = output.replace(
      /\| "PXXX acrescentar\/adicionar tarefa X" \| Two calls in sequence: \(1\) `api_create_task\(\{ type: 'simple', title: 'X', assignee: SENDER, sender_name: SENDER \}\)`; \(2\) `api_admin\(\{ action: 'reparent_task', task_id: '<created_task_id>', target_parent_id: 'PXXX', sender_name: SENDER \}\)` \|/,
      [
        '| "PXXX acrescentar/adicionar tarefa X" | Two calls in sequence: (1) `api_create_task({ type: \'simple\', title: \'X\', assignee: SENDER, sender_name: SENDER })`; (2) `api_admin({ action: \'reparent_task\', task_id: \'<created_task_id>\', target_parent_id: \'PXXX\', sender_name: SENDER })` |',
        '| "adicionar em PXXX a tarefa X" | Two calls in sequence: (1) `api_create_task({ type: \'simple\', title: \'X\', assignee: SENDER, sender_name: SENDER })`; (2) `api_admin({ action: \'reparent_task\', task_id: \'<created_task_id>\', target_parent_id: \'PXXX\', sender_name: SENDER })` |',
      ].join('\n'),
    );
  }
  if (!output.includes('"PXXX acrescentar/adicionar tarefa titulo"')) {
    output = output.replace(
      /\| "adicionar etapa PXXX: titulo" \| `api_update_task\(\{ task_id: 'PXXX', updates: \{ add_subtask: 'titulo' \}, sender_name: SENDER \}\)` \|/,
      [
        '| "adicionar etapa PXXX: titulo" | `api_update_task({ task_id: \'PXXX\', updates: { add_subtask: \'titulo\' }, sender_name: SENDER })` |',
        '| "PXXX acrescentar/adicionar tarefa titulo" | Two calls in sequence: (1) `api_create_task({ type: \'simple\', title: \'titulo\', assignee: SENDER, sender_name: SENDER })`; (2) `api_admin({ action: \'reparent_task\', task_id: \'<created_task_id>\', target_parent_id: \'PXXX\', sender_name: SENDER })` |',
        '| "adicionar em PXXX a tarefa titulo" | Two calls in sequence: (1) `api_create_task({ type: \'simple\', title: \'titulo\', assignee: SENDER, sender_name: SENDER })`; (2) `api_admin({ action: \'reparent_task\', task_id: \'<created_task_id>\', target_parent_id: \'PXXX\', sender_name: SENDER })` |',
        '| "[nome do projeto] adicionar/acrescentar tarefa titulo" | Do NOT use `api_create_task`. Use `api_update_task({ task_id: \'<matched_project_id>\', updates: { add_subtask: \'titulo\' }, sender_name: SENDER })` when the project is identifiable from board context; if multiple projects match, ask which one |',
      ].join('\n'),
    );
  }
  if (!output.includes('"adicionar em PXXX a tarefa titulo"')) {
    output = output.replace(
      /\| "PXXX acrescentar\/adicionar tarefa titulo" \| Two calls in sequence: \(1\) `api_create_task\(\{ type: 'simple', title: 'titulo', assignee: SENDER, sender_name: SENDER \}\)`; \(2\) `api_admin\(\{ action: 'reparent_task', task_id: '<created_task_id>', target_parent_id: 'PXXX', sender_name: SENDER \}\)` \|/,
      [
        '| "PXXX acrescentar/adicionar tarefa titulo" | Two calls in sequence: (1) `api_create_task({ type: \'simple\', title: \'titulo\', assignee: SENDER, sender_name: SENDER })`; (2) `api_admin({ action: \'reparent_task\', task_id: \'<created_task_id>\', target_parent_id: \'PXXX\', sender_name: SENDER })` |',
        '| "adicionar em PXXX a tarefa titulo" | Two calls in sequence: (1) `api_create_task({ type: \'simple\', title: \'titulo\', assignee: SENDER, sender_name: SENDER })`; (2) `api_admin({ action: \'reparent_task\', task_id: \'<created_task_id>\', target_parent_id: \'PXXX\', sender_name: SENDER })` |',
      ].join('\n'),
    );
  }

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

  const unmigrated = Object.fromEntries(
    UNMIGRATED_TOOLS.map((tool) => [tool, countOccurrences(output, tool)]),
  ) as MigrationResult['unmigrated'];

  return { output, substituted, unmigrated };
}

function countOccurrences(haystack: string, needle: string): number {
  const re = new RegExp(`\\b${needle}\\b`, 'g');
  return (haystack.match(re) ?? []).length;
}
