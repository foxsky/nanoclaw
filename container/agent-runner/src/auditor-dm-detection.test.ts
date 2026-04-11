import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Regression tests for the auditor's DM-send intent detection and the
 * task-mutation carve-out. The regex array and keyword list below must
 * stay BYTE-IDENTICAL to the ones in `auditor-script.sh` — the drift
 * guard at the end of this file enforces that.
 */

const DM_SEND_PATTERNS = [
  /\b(?:mand(?:ar|em|e|a)|envi(?:ar|em|e|a)|escrev(?:er|am|e|a))\s+(?:(?:um|uma|o|a|os|as)\s+)?(?:msg|mensagem|recado|aviso|alerta|lembrete|nota|email|e-?mail|notifica[cç][aã]o)\s+(?:a|ao|à|para|pro|pra|com)\s+\S/i,
  /\b(?:avis(?:e|a|ar|em|ando)|notifi(?:que|quem|car|cando)|alert(?:e|a|ar|em|ando)|comuniqu(?:e|em|ar|ando)|inform(?:e|em|ar|ando))\s+(?:o|a|os|as|ao|à|aos|às)(?=[\s.,;!?]|$)/i,
  /\b(?:diga|digam|conte|contem|conta|fale|falem|fala|pergunte|perguntem|pergunta|peç[ao]|peçam|pe[cç]a|pecam)\s+(?:a|ao|à|para|pro|pra|com)(?=[\s.,;!?]|$)/i,
  /\b(?:mand[ae]|mandem|envi[ae]|enviem|avis[ae]|avisem|alert[ae]|alertem|comunic[ae]|comuniquem|inform[ae]|informem|pede|pedem|pergunt[ae]|perguntem|peç[ao]|peçam|pecam|diga|digam|fale|falem|fala|conta|contem|conte)\s+(?:pro|pra|ao|à)\s+\S/i,
];

const TASK_KEYWORDS = [
  'concluir', 'concluída', 'concluido', 'finalizar', 'finalizado',
  'criar', 'adicionar', 'atribuir', 'aprovar', 'aprovada', 'aprovado',
  'descartar', 'cancelar', 'mover', 'adiar', 'renomear', 'alterar',
  'remover', 'em andamento', 'para aguardando', 'para revisão',
  'processar inbox', 'para inbox',
  'começando', 'comecando', 'aguardando', 'retomada', 'devolver',
  'done', 'feita', 'feito', 'pronta',
];
const TERSE_PATTERN = /^(T|P|M|R|SEC-)\S+\s*(conclu|feita|feito|pronta|ok|aprovad|✅)/i;

// Read-query detector — split into HARD and SOFT interrogatives so
// Portuguese subordinate clauses don't exempt real commands.
//
// HARD interrogatives (`qual`, `quais`, `quanto(s)`, `quanta(s)`) are
// never used as subordinators in Portuguese — if they start a message,
// it IS a question. Safe to treat as read-only unconditionally.
//
// SOFT interrogatives (`que`, `quando`, `onde`, `quem`) CAN introduce
// subordinate clauses that wrap imperatives. Example:
//   "Quando concluir T5, avise o João"  ← NOT a read query; `quando`
//                                          is temporal subordinator and
//                                          the real command is `avise`.
// For these, require the message to be a clean single-clause question:
// either ends with `?` OR contains no comma (disqualifier for clause
// splits). This matches "Que tarefas têm prazo?" and "Onde está a P10"
// while rejecting the subordinator forms.
const READ_QUERY_HARD_PATTERN = /^\s*(?:qual|quais|quantos?|quantas?)\b/i;
const READ_QUERY_SOFT_PATTERN = /^\s*(?:que|quando|onde|quem)\b/i;

// First-person future-tense declarations. The user is describing THEIR own
// upcoming action, not commanding the bot: "vou concluir T5" means "I will
// conclude T5", not "conclude T5 (imperative)". Allows 0-2 intervening
// adverbs between the modal and the infinitive ("vou já concluir",
// "pretendo também atualizar") — Codex flagged these as false negatives
// in the first revision. Uses `\S+`/`\S*` (not `\w+`/`\w*`) because
// `\w` is ASCII-only in JS regex and would fail on Portuguese accented
// adverbs like "já" and "também". Must still end in -ar/-er/-ir to
// avoid matching "vou ali", "vou embora", etc.
const INTENT_DECLARATION_PATTERN = /\b(?:vou|vamos|pretendo|estou\s+indo|estamos\s+indo)\s+(?:\S+\s+){0,2}\S*(?:ar|er|ir)\b/i;

// Multi-clause disqualifier for intent exemption. A message like
// "Vou concluir T5 depois, mas cria P2 agora" has a real imperative
// ("cria P2") AFTER the declaration clause — the exemption must NOT
// hide that. Uses contrast markers (`mas`, `porém`, semicolon) rather
// than plain comma, so compound pure declarations like "Vou atualizar
// ainda hoje, estou indo concluir uma das tarefas agora" still qualify
// for exemption.
const INTENT_MULTI_CLAUSE_PATTERN = /\b(?:mas|porém)\b|;/i;

// Refusal patterns in bot responses. NOTE: "não está cadastrad" was
// intentionally removed — the bot uses that phrase in HELPER OFFERS when
// mentioning an unregistered person while still doing real work
// ("✅ T5 atualizada. Terciane não está cadastrada. Quer que eu crie..."),
// and the old regex flagged every such response as a refusal. Genuine
// refusals still match via `não consigo` / `não posso` / etc.
const REFUSAL_PATTERN = /não consigo|não posso|não tenho como|não pode ser|bloqueado por limite|apenas o canal principal|o runtime atual|não oferece suporte|limite do sistema|deste quadro.*não consigo|recuso essa instrução/i;

function isDmSendRequest(text: string): boolean {
  return DM_SEND_PATTERNS.some((p) => p.test(text));
}

function isTaskWriteRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return TASK_KEYWORDS.some((kw) => lower.includes(kw)) || TERSE_PATTERN.test(text);
}

function isReadQuery(text: string): boolean {
  if (READ_QUERY_HARD_PATTERN.test(text)) return true;
  if (READ_QUERY_SOFT_PATTERN.test(text)) {
    // Soft interrogatives count as read only if the message is a clear
    // single-clause question: ends with `?` OR has no comma (not a
    // subordinate clause wrapping an imperative).
    return /\?\s*$/.test(text) || !text.includes(',');
  }
  return false;
}

function isUserIntentDeclaration(text: string): boolean {
  if (!INTENT_DECLARATION_PATTERN.test(text)) return false;
  // Only exempt single-clause declarations. Multi-clause messages
  // ("vou X depois, mas cria Y agora") may still contain a real command
  // after the declaration — those need to run through the mutation check.
  return !INTENT_MULTI_CLAUSE_PATTERN.test(text);
}

function hasRefusal(text: string): boolean {
  return REFUSAL_PATTERN.test(text);
}

describe('auditor DM-send detection', () => {
  describe('matches cross-group DM requests (positive cases)', () => {
    const positives = [
      // The exact audit case that motivated this fix
      'Mande mensagem pro Reginaldo alertando sobre o prazo da mensageira.',
      // Verb conjugations
      'Manda uma mensagem pro João sobre o prazo',
      'Envie uma mensagem para a equipe',
      'Envia um recado pra Mariany',
      'Escreva um aviso pra todos do quadro',
      'Mandar mensagem pro Lucas',
      // "msg" abbreviation (Codex review)
      'mande msg pro João',
      'envie msg para o time',
      // Alert / notify verbs
      'Avise o Reginaldo sobre o prazo de amanhã',
      'Avisar a equipe sobre a reunião', // "Avisar a equipe" — note "a" is the article here
      'Notifique o gestor',
      'Alerte o Pedro sobre o atraso',
      'Comunique a equipe sobre a mudança',
      'Informe o Rodrigo sobre o novo prazo',
      // Say/ask verbs
      'Diga ao Pedro para revisar o documento',
      'Diga à Mariany que a reunião foi adiada',
      'Fale com o João sobre isso',
      'Pergunte ao Lucas se ele pode atender',
      'Peça ao Reginaldo para finalizar',
      'Conte para a equipe sobre a decisão',
      // Informal shorthand (pattern 4 — Codex review)
      'avisa pro João que o prazo venceu',
      'pede pro Lucas revisar',
      'mande pro Reginaldo',
      'conta pro time que vamos adiar',
      'fala pro gestor',
      // Plural imperative forms (Codex review 2026-04-11). These were the
      // recall gap that escaped the first fix: group-addressed messages
      // like "Mandem mensagem pro João sobre o prazo" kept the auditor
      // false-positive alive because `mand[ea]r?` missed `mandem`.
      'Mandem mensagem pro João sobre o prazo',
      'Enviem msg pra equipe sobre o prazo',
      'Escrevam um aviso pro time sobre o prazo',
      'Notifiquem o gestor sobre o prazo',
      'Comuniquem a equipe sobre a mudança',
      'Informem o Rodrigo sobre o novo prazo',
      'Falem com o João sobre isso',
      'Peçam ao João para revisar',
      'Digam à equipe que a reunião mudou',
      'Perguntem ao Lucas se ele pode atender',
    ];

    for (const text of positives) {
      it(`matches: "${text.slice(0, 60)}"`, () => {
        expect(isDmSendRequest(text)).toBe(true);
      });
    }
  });

  describe('does not match pure task mutations (negative cases)', () => {
    const negatives = [
      // The kind of write requests the auditor SHOULD still flag
      'T5 concluir',
      'P11.19 adicionar nota: falar com o Lucas',
      'Criar tarefa Revisar documento até amanhã',
      'P9 adicionar subtarefa Enviar ofício',
      'Atribuir T8 para Rodrigo com prazo até amanhã',
      'Mover P3.2 para em andamento',
      'Cancelar T17',
      'Definir prazo da T5 para sexta-feira',
      'Alterar a descrição da P10',
      // Casual / non-action messages
      'olá',
      'bom dia',
      'qual o status do P11',
      'atividades josele',
      // "nota" as a task action, not as "mande uma nota"
      'T12 adicionar nota sobre o cliente',
      // "mande" without a message noun
      'Mandaram a tarefa pra mim',
      // Past-tense (perfect) forms must not match the plural-imperative
      // slots — e.g. `mand(?:ar|em|e|a)` must reject "mandaram" cleanly.
      'Enviaram o documento ontem',
      'Escreveram o relatório da T5',
      'Notificaram sobre o prazo de amanhã',
      // Locative "na/no" must NOT false-match as DM-send — these are
      // legitimate task-write operations, not cross-group sends.
      'Escreva uma nota na T5',
      'Mande um lembrete na tarefa T3',
      'Escreva um aviso na descrição da P4',
      'Adicionar nota no projeto P2',
    ];

    for (const text of negatives) {
      it(`does NOT match: "${text.slice(0, 60)}"`, () => {
        expect(isDmSendRequest(text)).toBe(false);
      });
    }
  });

  describe('mixed-intent messages still demand task_history (isTaskWrite)', () => {
    // Messages that are BOTH a DM-send and a task write must still run
    // the mutation check — otherwise "avise a equipe e concluir T5" would
    // silently hide a failed task mutation under the DM-send exemption.
    const mixedCases = [
      { text: 'Avise a equipe e concluir T5', isTaskWrite: true, isDmSend: true },
      { text: 'Mande mensagem pro João e atribuir T5 para Rodrigo', isTaskWrite: true, isDmSend: true },
      { text: 'Notifique o gestor e cancelar o projeto P10', isTaskWrite: true, isDmSend: true },
    ];

    for (const { text, isTaskWrite, isDmSend } of mixedCases) {
      it(`"${text.slice(0, 60)}": isTaskWrite=${isTaskWrite}, isDmSend=${isDmSend}`, () => {
        expect(isTaskWriteRequest(text)).toBe(isTaskWrite);
        expect(isDmSendRequest(text)).toBe(isDmSend);
      });
    }

    // The original motivating case should NOT be a task write — it's a
    // pure DM-send request with only "shared vocabulary" ("prazo").
    it('pure DM-send ("Mande mensagem pro Reginaldo ... prazo ...") is NOT isTaskWrite', () => {
      const text = 'Mande mensagem pro Reginaldo alertando sobre o prazo da mensageira.';
      expect(isTaskWriteRequest(text)).toBe(false);
      expect(isDmSendRequest(text)).toBe(true);
    });

    // Task-write keywords must NOT include shared vocabulary that also
    // appears in legitimate DM-send requests.
    it('shared vocabulary ("prazo", "lembrete", "nota") is NOT in TASK_KEYWORDS', () => {
      for (const kw of ['prazo', 'lembrete', 'lembrar', 'nota', 'anotar', 'próximo passo', 'próxima ação', 'descrição']) {
        expect(TASK_KEYWORDS).not.toContain(kw);
      }
    });
  });

  describe('read-query exemption', () => {
    // Pure information requests must not trip `unfulfilledWrite`, even
    // when they contain write-keyword nouns like "prazo" or "status".
    // Kipp's 2026-04-10 audit flagged "quais tarefas tem o prazo pra essa
    // semana?" because "prazo" is in WRITE_KEYWORDS — the message is
    // asking FOR the deadline list, not asking to SET one.
    const positives = [
      // Hard interrogatives (never subordinators) — always read-query
      'quais tarefas tem o prazo pra essa semana?',
      'qual o status do P11',
      'quantos projetos estão em andamento',
      'quantas tarefas o Rodrigo tem em Review',
      'Quais projetos tem prazo amanhã?',
      'Qual a descrição do P10',
      // Soft interrogatives — require `?` at end OR no comma
      'quando vence o T5?',
      'onde está a documentação do projeto P10',
      'quem fez a conclusão da T5',
      // Codex review 2026-04-11: "que" as interrogative pronoun
      // ("que tarefas têm prazo?") was missing from the first fix.
      'Que tarefas têm prazo hoje?',
      'Que projetos estão em andamento?',
    ];
    for (const text of positives) {
      it(`is read query: "${text.slice(0, 60)}"`, () => {
        expect(isReadQuery(text)).toBe(true);
      });
    }

    const negatives = [
      // Imperatives that happen to contain an interrogative later in the sentence
      'Atribua o T5 para quem estiver disponível',
      'Concluir T5 quando for possível',
      // Declarative statements
      'O P11 está aguardando revisão',
      'T5 concluir',
      // DM-send requests
      'Avise o João sobre o prazo',
      // "como" is intentionally NOT treated as read-only because "como
      // concluir X" can be either a how-to question or the start of an
      // imperative clarification — we prefer the mutation check to run.
      'como concluir o T5?',
      // "Pode" at start is polite imperative, not interrogative
      'Pode atribuir o T8 para Rodrigo?',
      // Codex review 2026-04-11: soft interrogatives introducing
      // subordinate clauses that wrap imperatives MUST NOT be exempted.
      // These are structurally commands with a temporal/relative prefix.
      'Quando concluir T5, avise o João',
      'Quem concluir T5, avise a equipe',
      'Onde houver prazo, atribua pra Rodrigo',
      'Que tarefa você quiser, concluir depois',
    ];
    for (const text of negatives) {
      it(`NOT read query: "${text.slice(0, 60)}"`, () => {
        expect(isReadQuery(text)).toBe(false);
      });
    }
  });

  describe('user-intent declaration exemption', () => {
    // First-person future-tense declarations — the user is describing
    // their OWN upcoming action, not commanding the bot. Kipp flagged
    // "Vou atualizar ainda hoje, estou indo concluir uma das tarefas
    // agora" as `unfulfilledWrite` because "concluir" matched
    // TASK_KEYWORDS, even though the bot correctly just waited for the
    // task ID.
    const positives = [
      // The original Kipp-flagged case — compound declaration, comma
      // separates two pure declarations, no imperative anywhere.
      'Vou atualizar ainda hoje, estou indo concluir uma das tarefas agora',
      'Vou concluir o T5 depois do almoço',
      'Vamos finalizar o P10 hoje',
      'Pretendo atualizar a descrição amanhã',
      'estou indo adicionar as subtarefas agora',
      'estamos indo cancelar o projeto P20',
      'vou aprovar o pedido',
      // Codex review 2026-04-11: adverbs between modal and infinitive
      // ("vou já concluir", "pretendo também atualizar") must NOT block
      // the exemption.
      'Vou já concluir T5',
      'Pretendo também atualizar a descrição amanhã',
      'Vou logo adicionar os subtarefas',
      // "vou estar + gerund" is also a valid future-tense construction
      'Vou estar concluindo T5 no fim do dia',
      // Compound declarations (both clauses declarations, no imperative)
      'Vou concluir T5 e criar P2',
      'Se eu não conseguir, vou concluir T5 amanhã',
    ];
    for (const text of positives) {
      it(`is intent declaration: "${text.slice(0, 60)}"`, () => {
        expect(isUserIntentDeclaration(text)).toBe(true);
      });
    }

    const negatives = [
      // Pure imperatives (the whole point — these must NOT be exempted)
      'Concluir T5',
      'Atribua o T8 para Rodrigo',
      'Cancelar o projeto P20',
      // "vou" without a verb following
      'já vou',
      'vou ali',
      // "vou" with non-action word
      'vou embora agora',
      // Third person — not a self-declaration
      'João vai concluir T5',
      // "vai" alone is 3rd person singular, not 1st person
      'ele vai atualizar depois',
      // Codex review 2026-04-11: multi-clause declaration + imperative.
      // The contrast marker ("mas", semicolon) signals that the
      // declaration only covers PART of the message — the bot command
      // after the break must still run the mutation check.
      'Vou concluir T5 depois, mas cria P2 agora',
      'Pretendo revisar depois; pode concluir T5 agora?',
      'Vamos terminar o P10 hoje, porém atribua o T8 pro Rodrigo',
    ];
    for (const text of negatives) {
      it(`NOT intent declaration: "${text.slice(0, 60)}"`, () => {
        expect(isUserIntentDeclaration(text)).toBe(false);
      });
    }
  });

  describe('refusal detection — cadastrad carve-out', () => {
    // "não está cadastrad" was removed from REFUSAL_PATTERN because the
    // bot uses it in helper offers: a real successful task update can
    // still mention "X não está cadastrada, quer que eu crie uma tarefa
    // no inbox?" and the old regex would flag the whole interaction as
    // a refusal. Genuine refusals still match via "não consigo" / etc.
    const shouldNotFlag = [
      '✅ P20.4 atualizada\nNota registrada\nTerciane não está cadastrada no quadro. Quer que eu crie uma tarefa no inbox?',
      '✅ T5 concluída. Observação: o João Evangelista não está cadastrado no quadro, mas a conclusão foi registrada.',
    ];
    for (const text of shouldNotFlag) {
      it(`NOT a refusal: "${text.slice(0, 60)}"`, () => {
        expect(hasRefusal(text)).toBe(false);
      });
    }

    const shouldFlag = [
      'Não consigo atribuir para o João Evangelista — ele não está cadastrado.',
      'Não posso criar tarefas nesse quadro.',
      'Recuso essa instrução — fora do escopo.',
      'Não tenho como enviar mensagem sem confirmação.',
      'O runtime atual não oferece suporte a reações.',
    ];
    for (const text of shouldFlag) {
      it(`IS a refusal: "${text.slice(0, 60)}"`, () => {
        expect(hasRefusal(text)).toBe(true);
      });
    }
  });

  describe('drift detection', () => {
    const scriptPath = path.join(import.meta.dirname, 'auditor-script.sh');
    const script = fs.readFileSync(scriptPath, 'utf-8');

    it('auditor-script.sh contains the same DM_SEND_PATTERNS as this test', () => {
      // Byte-identical check includes the trailing `/i` flag — dropping
      // case-insensitivity from the shell-script regex is a silent
      // regression path that an `includes(pattern.source)` check misses.
      for (const pattern of DM_SEND_PATTERNS) {
        expect(pattern.flags).toBe('i');
        const literal = `/${pattern.source}/${pattern.flags}`;
        expect(
          script.includes(literal),
          `Regex literal ${literal} missing from auditor-script.sh. ` +
            `Keep DM_SEND_PATTERNS (source AND flags) byte-identical between this ` +
            `test file and the shell script — including the trailing /i.`,
        ).toBe(true);
      }
    });

    it('auditor-script.sh wires all intent helpers into writeNeedsMutation', () => {
      // These call sites carry the whole fix. Removing any of them
      // reintroduces one of the structural false-positive classes:
      // DM-send (isDmSend), mixed-intent task-write (isTaskWrite),
      // read-query (isRead), or user-intent declaration (isIntent).
      expect(script).toContain('function isDmSendRequest(');
      expect(script).toContain('function isTaskWriteRequest(');
      expect(script).toContain('function isReadQuery(');
      expect(script).toContain('function isUserIntentDeclaration(');
      expect(script).toContain('const isDmSend = isDmSendRequest(msg.content)');
      expect(script).toContain('const isTaskWrite = isTaskWriteRequest(msg.content)');
      expect(script).toContain('const isRead = isReadQuery(msg.content)');
      expect(script).toContain('const isIntent = isUserIntentDeclaration(msg.content)');
      // writeNeedsMutation = !isRead && !isIntent && (isTaskWrite || (isWrite && !isDmSend))
      expect(script).toMatch(
        /writeNeedsMutation\s*=\s*!isRead\s*&&\s*!isIntent\s*&&\s*\(isTaskWrite\s*\|\|\s*\(isWrite\s*&&\s*!isDmSend\)\)/,
      );
      expect(script).toMatch(/unfulfilledWrite\s*=\s*writeNeedsMutation\s*&&\s*!mutationFound\s*&&\s*!refusalDetected/);
    });

    it('auditor-script.sh queries both task_history AND scheduled_tasks when isWrite', () => {
      // Mixed-intent messages must still check task mutations; the
      // DM-send exemption belongs in the flagging step, not here.
      // Guard against the regression where `isWrite && !isDmSend`
      // becomes the query gate again.
      expect(script).not.toMatch(/if\s*\(\s*isWrite\s*&&\s*!isDmSend\s*\)/);
      // Both tables must be consulted inside the single `if (isWrite)`
      // block — reminders go to scheduled_tasks (in messages.db), task
      // mutations go to task_history (in taskflow.db). Missing the
      // scheduled_tasks check reintroduces the 2026-04-10 SECI-SECTI
      // lembrete false positive.
      expect(script).toMatch(/if\s*\(\s*isWrite\s*\)\s*\{[\s\S]*?taskHistoryStmt\.all[\s\S]*?scheduledTasksStmt\.get/);
      // scheduledTasksStmt must be prepared against msgDb (messages.db),
      // not tfDb — scheduled_tasks lives in the host store database.
      expect(script).toMatch(/const scheduledTasksStmt = msgDb\.prepare\(/);
      // Upper bound must be `<=` to match task_history's boundary
      // convention — a reminder created exactly at the 10-minute mark
      // must still count (Codex LOW, 2026-04-11).
      expect(script).toMatch(/FROM scheduled_tasks\s+WHERE group_folder = \?\s+AND created_at >= \? AND created_at <= \?/);
      // Both mutation signals must be OR-combined into mutationFound;
      // missing the `|| scheduledTaskCreated` term silently drops the
      // reminder coverage even if the query runs.
      expect(script).toMatch(/mutationFound\s*=\s*mutations\.length\s*>\s*0\s*\|\|\s*scheduledTaskCreated/);
    });

    it('auditor-script.sh emits isRead and isIntent in each flagged interaction', () => {
      // Kipp's narrative layer uses these bits to classify false
      // positives it still encounters. Removing them from the payload
      // breaks the auditor-prompt.txt rule-4 reasoning path even if
      // the script-level exemption logic is intact.
      const pushBlock = script.match(/interactions\.push\(\{[\s\S]*?\}\);/);
      expect(pushBlock, 'interactions.push block not found').not.toBeNull();
      const body = pushBlock![0];
      expect(body).toMatch(/\bisRead\b/);
      expect(body).toMatch(/\bisIntent\b/);
      expect(body).toMatch(/\bisDmSend\b/);
    });

    for (const [name, pattern] of [
      ['READ_QUERY_HARD_PATTERN', READ_QUERY_HARD_PATTERN],
      ['READ_QUERY_SOFT_PATTERN', READ_QUERY_SOFT_PATTERN],
      ['INTENT_DECLARATION_PATTERN', INTENT_DECLARATION_PATTERN],
      ['INTENT_MULTI_CLAUSE_PATTERN', INTENT_MULTI_CLAUSE_PATTERN],
      ['REFUSAL_PATTERN', REFUSAL_PATTERN],
    ] as const) {
      it(`auditor-script.sh contains the same ${name} as this test`, () => {
        expect(pattern.flags).toBe('i');
        const literal = `/${pattern.source}/${pattern.flags}`;
        expect(
          script.includes(literal),
          `Regex literal ${literal} missing from auditor-script.sh. ` +
            `Keep ${name} (source AND flags) byte-identical between this ` +
            `test file and the shell script — including the trailing /i.`,
        ).toBe(true);
      });
    }

    it('auditor-script.sh REFUSAL_PATTERN no longer matches "não está cadastrad"', () => {
      // Bot helper offers like "Terciane não está cadastrada no quadro.
      // Quer que eu crie uma tarefa?" used to trip this as a refusal
      // even when the bot had successfully done real work. Removing the
      // alternative eliminates the 2026-04-10 ASSE-INOV-SECTI false
      // positive. Real refusals still match via "não consigo" / etc.
      const match = script.match(/const REFUSAL_PATTERN = \/(.*?)\/i;/);
      expect(match, 'REFUSAL_PATTERN not found in auditor-script.sh').not.toBeNull();
      expect(match![1]).not.toContain('não está cadastrad');
    });

    it('auditor-script.sh does not include shared vocabulary in TASK_KEYWORDS', () => {
      // Adding "prazo" / "nota" / etc. to TASK_KEYWORDS breaks the
      // DM-send exemption on messages containing them.
      const match = script.match(/const TASK_KEYWORDS = \[([\s\S]*?)\];/);
      expect(match, 'TASK_KEYWORDS array not found in auditor-script.sh').not.toBeNull();
      const body = match![1];
      for (const forbidden of ['"prazo"', '"lembrete"', '"lembrar"', '"nota"', '"anotar"', '"descrição"']) {
        expect(
          body.includes(forbidden),
          `TASK_KEYWORDS must not contain ${forbidden} — it's shared vocabulary used in DM-send requests`,
        ).toBe(false);
      }
    });
  });
});
