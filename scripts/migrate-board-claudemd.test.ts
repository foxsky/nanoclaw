import { describe, expect, it } from 'vitest';
import { migrateBoardClaudeMd } from './migrate-board-claudemd.js';

describe('migrateBoardClaudeMd — A5 Phase 1 direct substitution', () => {
  it('substitutes taskflow_move( → api_move({ ', () => {
    const input = `Call \`taskflow_move({ task_id: 'TXXX', action: 'start', sender_name: SENDER })\``;
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_move({ task_id:');
    expect(result.output).not.toMatch(/taskflow_move\(/);
    expect(result.substituted).toBeGreaterThan(0);
  });

  it('substitutes all 5 direct-substitute tools with board_id injection', () => {
    const input = [
      "`taskflow_move({ task_id: 'T1', action: 'start', sender_name: 'alice' })`",
      "`taskflow_admin({ action: 'register_person', sender_name: 'alice' })`",
      "`taskflow_reassign({ task_id: 'T1', target_person: 'bob', sender_name: 'alice', confirmed: true })`",
      "`taskflow_undo({ sender_name: 'alice' })`",
      "`taskflow_report({ type: 'standup' })`",
    ].join('\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_move({ ');
    expect(result.output).toContain('api_admin({ ');
    expect(result.output).toContain('api_reassign({ ');
    expect(result.output).toContain('api_undo({ ');
    expect(result.output).toContain('api_report({ ');
    expect(result.substituted).toBe(5);
  });

  it('substitutes bare references (no paren) to v2 names', () => {
    const input = 'When you call taskflow_move, the engine validates.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe('When you call api_move, the engine validates.');
  });

  it('all v1 taskflow_* tools now have a v2 substitute (Phase 2 complete)', () => {
    const result = migrateBoardClaudeMd('');
    // unmigrated dict has no keys — every former v1 tool routes somewhere
    expect(Object.keys(result.unmigrated)).toEqual([]);
  });

  it('taskflow_hierarchy → api_hierarchy with action body preserved', () => {
    const input =
      "`taskflow_hierarchy({ task_id: 'P1', action: 'link', person_name: 'bob', sender_name: SENDER })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_hierarchy({ task_id: 'P1',");
    expect(result.output).toContain("action: 'link'");
  });

  it('taskflow_dependency → api_dependency with action body preserved', () => {
    const input =
      "`taskflow_dependency({ task_id: 'T1', action: 'add_dep', target_task_id: 'T2', sender_name: SENDER })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_dependency({ task_id: 'T1',");
    expect(result.output).toContain("action: 'add_dep'");
  });

  it('bare taskflow_hierarchy / taskflow_dependency mentions → api_*', () => {
    const input = 'Use taskflow_hierarchy or taskflow_dependency for these flows.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe('Use api_hierarchy or api_dependency for these flows.');
  });

  it('adds hierarchy status-sync synonym near command synonyms', () => {
    const input =
      '**Command synonyms:** "consolidado" / "consolidar" = "quadro" (board view). "atividades" = "minhas tarefas" (my tasks). "finalizar" / "concluir" / "fechar" = conclude. "cancelar" (bare, no task ID) = ask which task to cancel or what to cancel. When a user says "concluir tarefa" without specifying an ID and has only one active task, apply it to that task. If multiple are active, list them and ask.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('**Hierarchy status sync synonym:**');
    expect(result.output).toContain("api_hierarchy({ action: 'refresh_rollup'");
    expect(result.output).not.toContain('taskflow_hierarchy');
  });

  it('adds a pre-tool gate for standalone planning goals', () => {
    const input =
      '## Command -> Tool Mapping\n\nWhen the user sends a command, call the matching MCP tool. The tool handles all validation, permission checks, and side effects.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('**Pre-tool command gate.**');
    expect(result.output).toContain('standalone infinitive planning goal is NOT an explicit command');
    expect(result.output).toContain('Do not call `api_query`, `api_create_task`, or any other tool');
  });

  it('removes the first-interaction welcome SQL check', () => {
    const input = [
      '## Welcome Check',
      '',
      'On the FIRST interaction in a new session, check if a welcome message has been sent:',
      "1. Query: `SELECT welcome_sent FROM board_runtime_config WHERE board_id = 'board-seci-taskflow'`",
      "2. If `welcome_sent = 0`: send a brief welcome, then `UPDATE board_runtime_config SET welcome_sent = 1 WHERE board_id = 'board-seci-taskflow'`",
      '',
      '## Security',
    ].join('\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.output).not.toContain('## Welcome Check');
    expect(result.output).not.toContain('welcome_sent');
    expect(result.output).toContain('## Security');
  });

  it('adds an explicit message delivery wrapper reminder', () => {
    const result = migrateBoardClaudeMd('All output in pt-BR.');
    expect(result.output).toContain('**Delivery format is mandatory.**');
    expect(result.output).toContain('<message to="...">');
    expect(result.output).toContain('no-tool replies');
  });

  it('adds pure-greeting scope guidance to preserve v1 no-tool behavior', () => {
    const input =
      'You are a task management assistant ONLY. If the message is NOT about tasks, board, capture, status, scheduling, people, deadlines, or any topic covered in this document, reply with a single short sentence in pt-BR explaining you only handle task management, and suggest `ajuda`, `comandos`, or `help`. Do NOT query the database for off-topic requests.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('Pure greetings with no task intent');
    expect(result.output).toContain('latest `<message>` body');
    expect(result.output).toContain('Aqui só cuido de gestão de tarefas');
    expect(result.output).toContain('"oi"');
    expect(result.output).toContain('Do not ask the open-ended general-assistant question "Como posso ajudar?"');
  });

  it('injects exact-ID and cross-board note-forward parity rules into migrated board prompts', () => {
    const input = [
      "**CRITICAL — NEVER display task details from memory.** When a user mentions a task ID (e.g. \"P1.9\", \"T41\", \"detalhes T3\"), you MUST call `taskflow_query({ query: 'task_details', task_id: '...' })` BEFORE showing any task information (title, assignee, column, dates, notes). NEVER generate task titles, descriptions, or status from memory or conversation history — always read from the database first. Hallucinated task details propagate through session resume and context summaries, causing persistent wrong information. This rule has NO exceptions.",
      "**Cross-board task lookup (fallback).** When `task_details` returns `Task not found` for a task ID that may live on a sibling/parent board (e.g. the user mentions a `T###` you don't recognise on this board), call `taskflow_query({ query: 'find_task_in_organization', task_id: 'TXXX' })`. It scopes to this board's org tree (root + descendants, same scope as `find_person_in_organization`) and returns `[{ task_id, board_id, board_group_folder, type, title, column, assignee, assignee_name, due_date, parent_task_id, requires_close_approval, group_jid }]`. Use the result to show the task with a clear \"Quadro: <board_group_folder>\" label so the user knows it's a cross-board read. This is **read-only** — to mutate the task, the user must act from its owning board. Do NOT fall back to `mcp__sqlite__read_query` for cross-board task lookups.",
    ].join('\n\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('**Exact task-ID scope lock.**');
    expect(result.output).toContain('SEC-T41');
    expect(result.output).toContain('not local `T41`');
    expect(result.output).toContain('do NOT mutate a searched candidate as a substitute');
    expect(result.output).toContain("api_query({ query: 'task_history', task_id: 'P6.7' })");
    expect(result.output).toContain("api_move({ task_id: 'P6.7', action: 'reopen'");
    expect(result.output).toContain('**Cross-board note-forward confirmation.**');
    expect(result.output).toContain('confirmation is for the forward action');
    expect(result.output).not.toContain('taskflow_query');
  });

  it('adds bare activity phrase guidance near intent analysis', () => {
    const input =
      'The user\'s words are clues, not commands. "Me lembre de ligar pro João" is a reminder — the user expects to be notified, not to find an inbox item. "Anotar: comprar café" is a capture. "Tarefa para Giovanni: revisar relatório" is an assigned task. But always consider the full context — the same words can mean different things depending on the situation.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('**Bare goal/activity phrases are not task-creation commands.**');
    expect(result.output).toContain('"Aguardar e acompanhar X"');
    expect(result.output).toContain('"Submeter X"');
    expect(result.output).toContain('"Realizar X"');
    expect(result.output).toContain('do NOT search or create automatically');
    expect(result.output).toContain('**Short follow-up after a missing task lookup.**');
    expect(result.output).toContain("api_query({ query: 'search', search_text: '<phrase>' })");
    expect(result.output).toContain('NOT as a new task proposal');
    expect(result.output).toContain('A bare confirmation ("sim", "pode", "confirma")');
    expect(result.output).toContain('instead of resetting with "como posso ajudar?"');
    expect(result.output).toContain('**Plain-text ambiguity questions.**');
    expect(result.output).toContain('Do NOT call `ask_user_question`');
  });

  it('injects missing-task short follow-up lookup guidance when plain-text ambiguity guidance already exists', () => {
    const input = [
      '**Bare goal/activity phrases are not task-creation commands.** If the user sends a standalone activity/status/goal phrase such as "Aguardar e acompanhar X", "Submeter X", "Realizar X", "Acompanhar X", or "Verificar se X" without explicitly asking to create/register/add/capture a task, do NOT search or create automatically. Treat it as ambiguous context: answer from available context and ask whether to capture/register it.',
      '',
      '**Plain-text ambiguity questions.** In TaskFlow command handling, "ask" means reply with a normal chat message unless a section explicitly says to present a card/buttons. Do NOT call `ask_user_question` just to ask whether an ambiguous phrase should become a task; v1 asked these questions in plain text with no tool call.',
    ].join('\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('**Short follow-up after a missing task lookup.**');
    expect(result.output).toContain("api_query({ query: 'search', search_text: '<phrase>' })");
    expect(result.output).toMatch(/missing task lookup[\s\S]+Plain-text ambiguity questions/);
  });

  it('taskflow_query → api_query with discriminator body preserved', () => {
    const input = "`taskflow_query({ query: 'task_details', task_id: 'T1' })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain(
      "api_query({ query: 'task_details', task_id: 'T1' })",
    );
    expect(result.output).not.toMatch(/taskflow_query/);
  });

  it('taskflow_query with person_name → api_query body preserved', () => {
    const input = "taskflow_query({ query: 'person_tasks', person_name: 'alice' })";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_query({ query: 'person_tasks',");
    expect(result.output).toContain("person_name: 'alice'");
  });

  it('bare taskflow_query mention → api_query', () => {
    const input = 'Use taskflow_query for reads.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe('Use api_query for reads.');
  });

  it('taskflow_update → api_update_task with composite updates body preserved', () => {
    const input = "`taskflow_update({ task_id: 'T1', updates: { add_note: 'X' }, sender_name: SENDER })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain(
      "api_update_task({ task_id: 'T1', updates: { add_note: 'X' }, sender_name: SENDER })",
    );
    expect(result.output).not.toMatch(/taskflow_update/);
  });

  it('taskflow_update with multi-field updates body → preserved verbatim', () => {
    const input = "taskflow_update({ task_id: 'T14', updates: { due_date: '2026-04-30' }, sender_name: SENDER })";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_update_task({ task_id: 'T14',");
    expect(result.output).toContain("updates: { due_date: '2026-04-30' }");
  });

  it('adds project create+reparent synonym rows for acrescentar/adicionar tarefa wording', () => {
    const input = [
      '| "diario/semanal/mensal/anual para Y: X" | `taskflow_create({ type: \'recurring\', title: \'X\', assignee: \'Y\', recurrence: FREQ, sender_name: SENDER })` |',
      '| "adicionar etapa PXXX: titulo" | `taskflow_update({ task_id: \'PXXX\', updates: { add_subtask: \'titulo\' }, sender_name: SENDER })` |',
    ].join('\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('"PXXX acrescentar/adicionar tarefa X"');
    expect(result.output).toContain('"adicionar em PXXX a tarefa X"');
    expect(result.output).toContain('"PXXX acrescentar/adicionar tarefa titulo"');
    expect(result.output).toContain('"adicionar em PXXX a tarefa titulo"');
    expect(result.output).toContain('"[nome do projeto] adicionar/acrescentar tarefa X"');
    expect(result.output).toContain('"[nome do projeto] adicionar/acrescentar tarefa titulo"');
    expect(result.output).toContain("api_create_task({ type: 'simple', title: 'X', assignee: SENDER, sender_name: SENDER })");
    expect(result.output).toContain("api_create_task({ type: 'simple', title: 'titulo', assignee: SENDER, sender_name: SENDER })");
    expect(result.output).toContain("api_admin({ action: 'reparent_task', task_id: '<created_task_id>', target_parent_id: 'PXXX', sender_name: SENDER })");
    expect(result.output).toContain('Do NOT use `api_create_task`');
    expect(result.output).toContain(
      "api_update_task({ task_id: '<matched_project_id>', updates: { add_subtask: 'X' }, sender_name: SENDER })",
    );
    expect(result.output).toContain(
      "api_update_task({ task_id: '<matched_project_id>', updates: { add_subtask: 'titulo' }, sender_name: SENDER })",
    );
    expect(result.output).not.toContain('taskflow_update');
  });

  it('adds negative examples for standalone planning goals before task creation mappings', () => {
    const input = '"tarefa" with "para Y" creates an assigned task. Without "para Y", it goes to inbox (see Quick Capture above).';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('Do NOT treat standalone planning goals as create commands.');
    expect(result.output).toContain('"Submeter ao menos 1 proposta a financiador externo"');
    expect(result.output).toContain('do not call `api_query` or `api_create_task`');
    expect(result.output).toContain('"Realizar 8 edições mensais do Inova Talks (mai-dez/2026)"');
  });

  it('bare taskflow_update mention → api_update_task', () => {
    const input = 'Use taskflow_update to add a note.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe('Use api_update_task to add a note.');
  });

  it('taskflow_create with type:simple → api_create_task with type preserved', () => {
    const input = "`taskflow_create({ type: 'simple', title: 'X', sender_name: 'alice' })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_create_task({ type: 'simple',");
    expect(result.output).not.toMatch(/taskflow_create/);
  });

  it('taskflow_create with type:meeting → api_create_meeting_task (type dropped)', () => {
    const input =
      "`taskflow_create({ type: 'meeting', title: 'SEMA', scheduled_at: '2026-06-15T14:00:00Z', sender_name: 'alice' })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_create_meeting_task({ ');
    expect(result.output).not.toContain("type: 'meeting'");
    expect(result.output).not.toMatch(/taskflow_create/);
  });

  it('taskflow_create with type:project preserved → api_create_task with type:project', () => {
    const input =
      "`taskflow_create({ type: 'project', title: 'Big', subtasks: ['A', 'B'], sender_name: 'alice' })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_create_task({ type: 'project',");
  });

  it('taskflow_create without inline type literal falls back to api_create_task', () => {
    const input = '`taskflow_create({title: VAR, type: VAR2, sender_name: SENDER})`';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_create_task({ ');
  });

  it('bare `taskflow_create` mention (no paren) → api_create_task', () => {
    const input = 'Use taskflow_create to register new tasks.';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe('Use api_create_task to register new tasks.');
  });

  it('taskflow_create with type NOT first field still routes by type (Codex BLOCKER fix)', () => {
    const input =
      "`taskflow_create({ title: 'SEMA', type: 'meeting', scheduled_at: '2026-06-15T14:00:00Z', sender_name: 'alice' })`";
    const result = migrateBoardClaudeMd(input);
    // type is the second field; routing must still detect 'meeting'
    expect(result.output).toContain('api_create_meeting_task({ ');
    expect(result.output).not.toMatch(/taskflow_create/);
  });

  it('taskflow_create with double-quoted type → routes by type (Codex BLOCKER fix)', () => {
    const input = `taskflow_create({ type: "meeting", title: "X", sender_name: "alice" })`;
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_create_meeting_task({ ');
  });

  it('taskflow_create with type buried after multiple fields → still routes correctly', () => {
    const input =
      "`taskflow_create({ title: 'X', assignee: 'bob', priority: 'high', type: 'project', sender_name: 'alice' })`";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_create_task({ ');
    // Body preserves the type literal so engine still routes by it
    expect(result.output).toContain("type: 'project'");
  });

  it('empty body `taskflow_create({})` → empty braces in output', () => {
    const input = 'taskflow_create({})';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe('api_create_task({})');
    expect(result.output).not.toMatch(/,\s*\}/);
  });

  it('taskflow_create with type:meeting as LAST field → no trailing comma after strip', () => {
    const input = "taskflow_create({ title: 'X', type: 'meeting' })";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe("api_create_meeting_task({ title: 'X' })");
    expect(result.output).not.toMatch(/,\s*\}/);
  });

  it('reports counts: substituted (formerly also unmigrated; Phase 2 complete leaves unmigrated empty)', () => {
    const input = [
      "`taskflow_move({ task_id: 'T1', action: 'start', sender_name: 'alice' })`",
      "`taskflow_move({ task_id: 'T2', action: 'wait', sender_name: 'alice' })`",
      "`taskflow_hierarchy({ task_id: 'P1', action: 'unlink', sender_name: 'alice' })`",
    ].join('\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.substituted).toBe(3);
    // After Phase 2, every v1 tool routes somewhere; no unmigrated keys.
    expect(Object.keys(result.unmigrated)).toEqual([]);
  });

  it('output is host-inject-clean: no `board_id:` and no BOARD_ID placeholder anywhere', () => {
    // v2 host-injects board_id at the MCP boundary via NANOCLAW_TASKFLOW_BOARD_ID.
    // The migration must NOT leak BOARD_ID placeholders or `board_id:` literals.
    const input = "taskflow_move({ task_id: 'T1', sender_name: SENDER })";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("api_move({ task_id: 'T1', sender_name: SENDER })");
    expect(result.output).not.toContain('BOARD_ID');
    expect(result.output).not.toContain('board_id:');
  });

  it('default (no boardId arg): backwards-compatible — emits BOARD_ID placeholder for callers that template downstream', () => {
    // Skill tests + existing call sites pass no boardId. Preserve that contract.
    const input = "taskflow_move({ task_id: 'T1', sender_name: SENDER })";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('api_move({ ');
  });

  it('A5 quality finding: literal `taskflow_*` pattern (with asterisk) becomes `api_*`', () => {
    // The v1 CLAUDE.md has 3 generic references like "use `taskflow_*` MCP tools"
    // that the word-boundary bare-rename pass misses (because `*` is not a word char).
    // Post-migration, those should read "use `api_*` MCP tools" so the agent isn't
    // told to call tools that no longer exist.
    const input = [
      'Execute each action via its own `taskflow_*` tool call IN SEQUENCE',
      'always instruct the subagent to use `taskflow_*` MCP tools',
      'operations that have NO `taskflow_*` equivalent',
    ].join('\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('`api_*` tool call');
    expect(result.output).toContain('`api_*` MCP tools');
    expect(result.output).toContain('NO `api_*` equivalent');
    expect(result.output).not.toMatch(/`taskflow_\*`/);
  });

  it('does NOT touch unrelated taskflow_-prefixed identifiers (taskflow_managed, taskflow_max_depth)', () => {
    // These are DB column names referenced in CLAUDE.md, not tool names.
    // The bare-rename pass should leave them alone (no `\b...\b` match because
    // they're not in our explicit tool list).
    const input = '`taskflow_managed = true` and `current level + 1 <= taskflow_max_depth`';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('taskflow_managed = true');
    expect(result.output).toContain('taskflow_max_depth');
  });

  it('A5 follow-up — pending_approval shape: target_chat_jid → destination_name (A12-aligned)', () => {
    const input = '`{ success: false, pending_approval: { request_id, target_chat_jid, message, parent_board_id } }`';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('destination_name');
    expect(result.output).not.toContain('target_chat_jid');
  });

  it('A5 follow-up — send_message object-shorthand call: target_chat_jid → to + destination_name', () => {
    const input = '`send_message({ target_chat_jid, text: message })`';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('send_message({ to: pending_approval.destination_name, text: pending_approval.message })');
    expect(result.output).not.toContain('target_chat_jid');
  });

  it('A5 follow-up — send_message literal-args call (parent_group_jid example) rewrites to named destination', () => {
    const input = "send_message({ target_chat_jid: '<parent_group_jid>', text: '<forward message>' })";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain("send_message({ to: pending_approval.destination_name, text: pending_approval.message })");
    expect(result.output).not.toContain('target_chat_jid');
  });

  it('A5 follow-up — send_message tool-signature doc line: drops sender, JID→destination name placeholder', () => {
    const input = 'send_message(text: "[MESSAGE]", sender: "[OPTIONAL_ROLE_NAME]", target_chat_jid: "[OPTIONAL_JID]")';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('send_message({ text: "[MESSAGE]", to: "[OPTIONAL_DESTINATION_NAME]" })');
    expect(result.output).not.toContain('target_chat_jid');
    expect(result.output).not.toContain('sender:');
  });

  it('A5 follow-up — schedule_task tool signature: v1 schedule_type/value → v2 processAfter/recurrence', () => {
    const input = 'schedule_task(prompt: "[PROMPT]", schedule_type: "[cron|interval|once]", schedule_value: "[CRON_OR_TIMESTAMP]", context_mode: "group")';
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('schedule_task({ prompt: "[PROMPT]", processAfter: "[ISO_TIMESTAMP_OR_NULL]", recurrence: "[OPTIONAL_CRON]" })');
    expect(result.output).not.toContain('schedule_type');
    expect(result.output).not.toContain('schedule_value');
  });

  it('A5 follow-up — prose mention "schedule_task with schedule_type: \'once\'" → "with processAfter"', () => {
    const input = "Use `schedule_task` with `schedule_type: 'once'`. If the user specifies a time, schedule it.";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).not.toContain('schedule_type');
    expect(result.output).toContain('processAfter');
  });

  it('A5 follow-up — duplicate_warning block (force_create flow) is removed (v2 has no such field)', () => {
    const input = [
      'Some preceding text.',
      '',
      'When `taskflow_create` returns `duplicate_warning` (85-94% similar), present it:',
      '> "Já tem uma tarefa parecida: ..."',
      'If the user **explicitly** confirms (e.g. "sim", "criar"), re-call `taskflow_create` with `force_create: true`. If the user repeats the same "Inbox: ..." command without confirming, treat it as NOT a confirmation — remind them the task already exists.',
      '',
      'Following text.',
    ].join('\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.output).not.toContain('duplicate_warning');
    expect(result.output).not.toContain('force_create');
    expect(result.output).toContain('Some preceding text.');
    expect(result.output).toContain('Following text.');
  });

  it('A5 follow-up — Notification Dispatch section collapses to 2-line v2 truth (engine auto-dispatches)', () => {
    // v1 had a multi-paragraph rule telling the agent to relay
    // notifications[*].target_chat_jid via send_message. v2's engine
    // dispatches everything itself; the notification_events array is
    // informational only.
    const input = [
      'Preceding section.',
      '',
      '## Notification Dispatch',
      '',
      'After any successful mutation tool call, inspect `notifications` and `parent_notification` for explicit transport work. Relay only cross-chat deliveries; never create a same-group duplicate.',
      '',
      'For each notification:',
      '',
      '1. If `notification_group_jid` is set and it differs from the current group, call `send_message` with the notification\'s `message` text and pass that JID as `target_chat_jid`',
      '2. If `notification_group_jid` is null, missing, or the current group, do NOT call `send_message` — the normal assistant reply already covers the current chat',
      '3. Do NOT modify the notification text',
      '',
      'Notifications are **bidirectional**: when a manager updates an assignee\'s task, the assignee is notified.',
      '',
      'Also check for `parent_notification` in the result. If present and `parent_notification.parent_group_jid` differs from the current group, call `send_message` with `target_chat_jid` set to `parent_notification.parent_group_jid`.',
      '',
      '## Schema Reference',
    ].join('\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('## Notification Dispatch');
    expect(result.output).toContain('engine dispatches');
    expect(result.output).not.toContain('notification_group_jid');
    expect(result.output).not.toContain('parent_notification');
    expect(result.output).toContain('Preceding section.');
    expect(result.output).toContain('## Schema Reference');
  });

  it('idempotent: running twice on the same input produces the same output', () => {
    const input = "`taskflow_move({ task_id: 'T1', action: 'start', sender_name: 'alice' })`";
    const r1 = migrateBoardClaudeMd(input);
    const r2 = migrateBoardClaudeMd(r1.output);
    expect(r2.output).toBe(r1.output);
    expect(r2.substituted).toBe(0); // nothing left to substitute on 2nd pass
  });

  it('preserves spacing — single space after { with no double-comma', () => {
    const input = "taskflow_move({ task_id: 'T1' })";
    const result = migrateBoardClaudeMd(input);
    // No "{,", no "{ ,", no double-comma. Output must be syntactically valid.
    expect(result.output).not.toMatch(/\{\s*,/);
    expect(result.output).not.toMatch(/,\s*,/);
  });

  it('handles zero whitespace after { — `taskflow_move({task_id:...})`', () => {
    const input = "taskflow_move({task_id:'T1',action:'start'})";
    const result = migrateBoardClaudeMd(input);
    // After dropping board_id injection, the substitution is a pure rename;
    // whitespace is preserved exactly as the v1 source had it.
    expect(result.output).toBe("api_move({task_id:'T1',action:'start'})");
    expect(result.substituted).toBe(1);
  });

  it('handles a real-world block from v1 CLAUDE.md', () => {
    const input =
      "| \"comecando TXXX\" / \"iniciando TXXX\" | `taskflow_move({ task_id: 'TXXX', action: 'start', sender_name: SENDER })` |";
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toBe(
      "| \"comecando TXXX\" / \"iniciando TXXX\" | `api_move({ task_id: 'TXXX', action: 'start', sender_name: SENDER })` |",
    );
  });

  // Codex IMPORTANT 2026-05-11: prompt regression. Generated v2 docs must
  // not teach the agent to pass `board_id` in api_* calls — the host
  // injects it via NANOCLAW_TASKFLOW_BOARD_ID at the MCP boundary.
  it('regression: no `api_*({ board_id:` patterns leak into output (any tool, any whitespace)', () => {
    const inputs = [
      "taskflow_move({ task_id: 'T1', action: 'start', sender_name: SENDER })",
      "taskflow_update({ task_id: 'T1', updates: { add_note: 'X' }, sender_name: SENDER })",
      "taskflow_query({ query: 'task_details', task_id: 'T1' })",
      "taskflow_reassign({ task_id: 'T1', target_person: 'Alice', confirmed: true, sender_name: SENDER })",
      "taskflow_create({ type: 'simple', title: 'X', sender_name: SENDER })",
      "taskflow_create({ type: 'meeting', title: 'M', scheduled_at: '...' })",
      "taskflow_admin({ action: 'register_person', name: 'X', phone: '...', sender_name: SENDER })",
      "taskflow_create({})",
      "taskflow_move({task_id:'T1',action:'start'})", // zero whitespace
    ];
    for (const input of inputs) {
      const result = migrateBoardClaudeMd(input);
      // Any `api_<name>({ board_id:` (with optional whitespace around `:`) is a leak.
      expect(result.output).not.toMatch(/api_[a-z_]+\(\{\s*board_id\s*:/);
      // And explicit BOARD_ID placeholder must never appear (migration cleanup).
      expect(result.output).not.toContain('BOARD_ID');
    }
  });

  // The Phase-3 fallback prose for cross-board task lookup must survive
  // substitution so the deployed CLAUDE.local.md teaches the agent to fall
  // back to find_task_in_organization. If the migration starts dropping
  // prose, the regenerated file becomes silently incomplete and the next
  // paid Phase 3 run sees v2 stop at "Task not found".
  it('preserves the cross-board task lookup fallback rule after substitution', () => {
    const input = `**Cross-board task lookup (fallback).** When \`task_details\` returns \`Task not found\` for a task ID that may live on a sibling/parent board, call \`taskflow_query({ query: 'find_task_in_organization', task_id: 'TXXX' })\`. Do NOT fall back to \`mcp__sqlite__read_query\` for cross-board task lookups.`;
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('find_task_in_organization');
    // taskflow_query → api_query rename must apply here too.
    expect(result.output).toContain('api_query');
    expect(result.output).not.toContain('taskflow_query');
    // The "Cross-board task lookup" heading and surrounding prose stay.
    expect(result.output).toContain('Cross-board task lookup');
  });

  it('preserves exact task-ID and cross-board note-forward rules after substitution', () => {
    const input = [
      "**Exact task-ID scope lock.** When the user names an exact task/subtask ID, keep that exact ID through the whole read/confirm/mutate flow. If you ask _\"Deseja reabrir e exigir aprovação para P6.7?\"_ and the user answers _\"sim\"_, execute exactly: `taskflow_move({ task_id: 'P6.7', action: 'reopen', sender_name: SENDER })` then `taskflow_update({ task_id: 'P6.7', updates: { requires_close_approval: true }, sender_name: SENDER })`.",
      "**Cross-board note-forward confirmation.** If the user tried to add a note/update to an exact task ID and the user identifies the destination board/person, keep the pending note text and ask a concrete forwarding confirmation. If the next user message is a bare confirmation, call `send_message` to the registered destination name.",
    ].join('\n\n');
    const result = migrateBoardClaudeMd(input);
    expect(result.output).toContain('Exact task-ID scope lock');
    expect(result.output).toContain('Cross-board note-forward confirmation');
    expect(result.output).toContain('api_move');
    expect(result.output).toContain('api_update_task');
    expect(result.output).not.toContain('taskflow_move');
    expect(result.output).not.toContain('taskflow_update');
  });
});
