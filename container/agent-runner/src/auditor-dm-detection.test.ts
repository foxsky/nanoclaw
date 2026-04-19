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
const TERSE_PATTERN = /^(?:(?:[A-Z]{2,}-)?(?:T|P|M|R)\S+|SEC-\S+)\s*(conclu|feita|feito|pronta|ok|aprovad|✅)/i;

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

// Imperative verb detector — used to disqualify SOFT comma-less reads.
// The first-pass fix treated "Quando concluir T5 avise o João" (no comma,
// no `?`) as a read query because it couldn't tell the subordinator form
// from a real question. Codex second-pass flagged this as a recall gap:
// informal Portuguese often drops the comma. This pattern catches the
// 2nd/3rd person singular/plural imperative forms of TaskFlow task verbs
// so isReadQuery can veto the no-comma branch when any command verb
// appears in the message.
//
// Word-boundary matched (`\b...\b`) to avoid substring false positives
// like "criança" → "cria" or "extremos" → "mov". Verb list curated to
// task-write and send-intent verbs only; generic Portuguese verbs like
// "vai", "faz", "dá" are intentionally out-of-scope.
const IMPERATIVE_VERB_PATTERN = /\b(?:conclu[ai]m?|atribu[aei]m?|cri[ae]m?|cancel[ea]m?|adicion[ea]m?|aprov[ea]m?|descart[ea]m?|mov[ae]m?|adi[ae]m?|alter[ea]m?|remov[ae]m?|renomei[ea]m?|finaliz[ea]m?|process[ea]m?|devolv[ae]m?|retom[ae]m?|delegu[ea]m?|registr[ea]m?|avis[ea]m?|alert[ea]m?|inform[ea]m?|comuniqu[ea]m?|notifiqu[ea]m?|peç[ao]m?|pe[cç]am?)\b/i;

// First-person future-tense declarations. The user is describing THEIR own
// upcoming action, not commanding the bot: "vou concluir T5" means "I will
// conclude T5", not "conclude T5 (imperative)".
//
// Four alternatives, all first-person:
// 1. Periphrastic future — `vou/vamos/pretendo/estou indo/estamos indo`
//    + 0-2 intervening adverbs + infinitive (-ar/-er/-ir). Uses `\S+`/
//    `\S*` (not `\w+`/`\w*`) because JS regex `\w` is ASCII-only and
//    would fail on Portuguese accented adverbs like "já" and "também".
// 2. Synthetic future 1sg — 3+ char stem + (a|e|i) + "rei"
//    (e.g. "concluirei", "atualizarei", "finalizarei", "criarei").
//    `\S{3,}` prevents matching "rei" (king) and "Rei" (name).
// 3. Synthetic future 1pl — 3+ char stem + (a|e|i) + "remos"
//    (e.g. "concluiremos", "atualizaremos", "finalizaremos").
// 4. Future perfect 1sg/1pl — `terei`/`teremos` + 0-2 adverbs + past
//    participle ending in `ado|ido|ído|to|so`. The `ído` variant covers
//    accented forms like "concluído".
//
// Residual known gap: irregular-stem single-char synthetic futures
// ("farei", "serei", "direi", "darei") don't match because the stem is
// only 1-2 chars. These are rare in WhatsApp task contexts; accept.
const INTENT_DECLARATION_PATTERN = /\b(?:vou|vamos|pretendo|estou\s+indo|estamos\s+indo)\s+(?:\S+\s+){0,2}\S*(?:ar|er|ir)\b|\b\S{3,}(?:a|e|i)rei\b|\b\S{3,}(?:a|e|i)remos\b|\b(?:terei|teremos)\s+(?:\S+\s+){0,2}\S+(?:ado|ido|ído|to|so)\b/i;

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
    // Soft interrogative counted as read only when the message is a
    // clear single-clause question:
    //   - ends with `?`, OR
    //   - has no comma AND no imperative verb (not a subordinate
    //     clause wrapping a command — catches "Quando concluir T5
    //     avise o João" where the comma is dropped informally).
    if (/\?\s*$/.test(text)) return true;
    if (text.includes(',')) return false;
    return !IMPERATIVE_VERB_PATTERN.test(text);
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

function interactionSenderKey(msg: {
  sender: string | null | undefined;
  sender_name: string | null | undefined;
}): string {
  const sender = (msg.sender ?? '').trim();
  if (sender) return `sender:${sender}`;
  return `name:${(msg.sender_name ?? '').trim()}`;
}

function attributedBotResponse(
  messages: Array<{
    sender: string | null | undefined;
    sender_name: string | null | undefined;
    timestamp: string;
    is_bot_message?: boolean;
    is_from_me?: boolean;
  }>,
  headIndex: number,
): { timestamp: string } | null {
  const head = messages[headIndex];
  const tenMinLater = new Date(new Date(head.timestamp).getTime() + 600_000).toISOString();
  const bot = messages.find((m) =>
    !!(m.is_bot_message || m.is_from_me) &&
    m.timestamp > head.timestamp &&
    m.timestamp <= tenMinLater,
  );
  if (!bot) return null;
  const headKey = interactionSenderKey(head);
  for (let i = headIndex + 1; i < messages.length; i++) {
    const next = messages[i];
    if (next.timestamp >= bot.timestamp) break;
    const sender = next.sender ?? '';
    const senderName = next.sender_name ?? '';
    if (sender.startsWith('web:') || senderName.startsWith('web:')) continue;
    if (!next.is_bot_message && !next.is_from_me && interactionSenderKey(next) !== headKey) {
      return null;
    }
  }
  return { timestamp: bot.timestamp };
}

const TASK_REF_PATTERN = /\b(?:[A-Z]{2,}-)?(?:T|P|M|R)\d+(?:\.\d+)*\b|\bSEC-[A-Z0-9]+(?:[.-][A-Z0-9]+)*\b/gi;
const REMINDER_LIKE_PATTERN = /\b(?:lembr(?:ar|e|ete|etes)|me\s+avise|me\s+lembre|avise-me|avisa\s+me|avisar|lembret[ea]|agendar|agenda(?:r)?)\b/i;

function normalizeForCompare(text: string | null | undefined): string {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function extractTaskRefs(text: string): Set<string> {
  return new Set((text.match(TASK_REF_PATTERN) ?? []).map((m) => m.toUpperCase()));
}

function isReminderLikeWrite(text: string): boolean {
  return REMINDER_LIKE_PATTERN.test(text);
}

function buildTaskIdAliases(
  taskId: string | null | undefined,
  shortCode: string | null | undefined,
): string[] {
  const rawId = String(taskId ?? '').toUpperCase();
  if (!rawId) return [];
  const aliases = new Set([rawId]);
  if (shortCode) aliases.add(`${shortCode.toUpperCase()}-${rawId}`);
  return Array.from(aliases);
}

function taskMutationEvidence(
  msg: {
    content: string;
    sender: string | null | undefined;
    sender_name: string | null | undefined;
  },
  mutations: Array<{
    task_id: string | null | undefined;
    by: string | null | undefined;
    short_code?: string | null | undefined;
  }>,
  scheduledTaskCreated: boolean,
): boolean {
  const actorKey = normalizeForCompare(msg.sender_name || msg.sender || '');
  const taskRefs = extractTaskRefs(msg.content);
  const matchingMutations = mutations.filter((mutation) => {
    const sameActor = !actorKey || !mutation.by
      ? true
      : normalizeForCompare(mutation.by) === actorKey;
    if (!sameActor) return false;
    if (taskRefs.size === 0) return true;
    return buildTaskIdAliases(mutation.task_id, mutation.short_code).some((alias) =>
      taskRefs.has(alias),
    );
  });
  const scheduledCounts = isReminderLikeWrite(msg.content) && scheduledTaskCreated;
  return matchingMutations.length > 0 || scheduledCounts;
}

function crossGroupSendEvidence(
  msgId: string,
  sendLogs: Array<{
    trigger_message_id?: string | null | undefined;
    trigger_turn_id?: string | null | undefined;
  }>,
  turnMessageIdsByTurnId: Record<string, string[]>,
): boolean {
  const directMessageMatch = sendLogs.some(
    (row) => row.trigger_message_id === msgId,
  );
  if (directMessageMatch) return true;
  const turnMembershipMatch = sendLogs.some((row) => {
    const turnId = row.trigger_turn_id;
    return !!turnId && (turnMessageIdsByTurnId[turnId] ?? []).includes(msgId);
  });
  if (turnMembershipMatch) return true;
  const hasAnyExactCorrelation = sendLogs.some(
    (row) => !!row.trigger_message_id || !!row.trigger_turn_id,
  );
  return !hasAnyExactCorrelation && sendLogs.length > 0;
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
      // Codex second-pass 2026-04-11: soft + no-comma MUST be vetoed
      // when an imperative verb appears in the message. Informal
      // Portuguese often drops the comma before the command clause.
      'Quando concluir T5 avise o João',
      'Quem concluir T5 avise a equipe',
      'Onde houver prazo atribua pra Rodrigo',
      'Quando puder conclua T5',
      'Onde vir o P10 cancele',
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
      // Codex second-pass 2026-04-11: Portuguese synthetic future (1sg
      // and 1pl) and future perfect. These are more formal than the
      // periphrastic `vou + infinitive` form but DO appear in
      // administrative WhatsApp contexts.
      'Concluirei T5 amanhã',
      'Atualizarei a descrição amanhã',
      'Finalizarei o P10 até sexta',
      'Criaremos as subtarefas hoje',
      'Atualizaremos a descrição depois',
      'Terei finalizado P10 até amanhã',
      'Terei concluído T5 até o fim do dia',
      'Teremos atualizado tudo até sexta',
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
      // Codex second-pass 2026-04-11: false-positive guards for the
      // synthetic-future alternatives.
      // "rei" alone (king) must not match as a verb.
      'O rei do pop',
      // "remos" alone (rowers) must not match as 1pl future.
      'Os remos do barco',
      // "extremos" (adjective/noun) must not match as 1pl future.
      'Esses casos são extremos',
      // "criança" must not match as "cria" imperative.
      'A criança está ansiosa',
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

  describe('web-origin filter', () => {
    // The auditor skips web-origin test/QA messages (sender or sender_name
    // prefixed with `web:`) so SEC-SECTI / secti-taskflow QA harness
    // injections don't pollute the daily audit.
    //
    // The main codebase's `isWebOriginMessage` (src/index.ts) checks
    // BOTH fields via OR: a message counts as web-origin when EITHER
    // `sender` OR `sender_name` starts with `web:`. The auditor MUST
    // match that contract — otherwise QA injections where only one of
    // the two fields carries the prefix (e.g. `sender = 'web:e2e-1'`
    // with a human-readable `sender_name = 'QA Bot'`) leak into the
    // audit and produce false `noResponse`/`unfulfilledWrite` flags.
    //
    // The original shell script only checked whichever field won the
    // `||` fallback — `sender_name || sender || ''` — so a non-empty
    // `sender_name` without the prefix masked a web-prefixed `sender`.
    // This is the regression guard for that gap.
    function isWebOriginSender(msg: {
      sender: string | null | undefined;
      sender_name: string | null | undefined;
    }): boolean {
      return (
        (msg.sender ?? '').startsWith('web:') ||
        (msg.sender_name ?? '').startsWith('web:')
      );
    }

    it('flags web-prefixed sender even when sender_name is a real name', () => {
      // This is the case that used to leak: QA harness sets sender to a
      // `web:...` ID but populates sender_name with a human-readable
      // label ("QA Bot", "E2E Tester") so the message renders nicely
      // in any debug view. Old auditor skipped on sender_name alone.
      expect(
        isWebOriginSender({ sender: 'web:e2e-1', sender_name: 'QA Bot' }),
      ).toBe(true);
      expect(
        isWebOriginSender({
          sender: 'web:secti-qa-harness',
          sender_name: 'Test User',
        }),
      ).toBe(true);
    });

    it('flags web-prefixed sender_name even when sender is a phone JID', () => {
      // Symmetric case: the other field carries the prefix.
      expect(
        isWebOriginSender({
          sender: '5585999999999@s.whatsapp.net',
          sender_name: 'web:injected',
        }),
      ).toBe(true);
    });

    it('flags messages where both fields are web-prefixed', () => {
      expect(
        isWebOriginSender({ sender: 'web:a', sender_name: 'web:b' }),
      ).toBe(true);
    });

    it('does NOT flag real user messages', () => {
      expect(
        isWebOriginSender({
          sender: '5585999999999@s.whatsapp.net',
          sender_name: 'João',
        }),
      ).toBe(false);
      expect(isWebOriginSender({ sender: '', sender_name: '' })).toBe(false);
      expect(
        isWebOriginSender({ sender: null, sender_name: null }),
      ).toBe(false);
    });

    it('auditor-script.sh checks BOTH sender and sender_name for web: prefix', () => {
      const scriptPath = path.join(import.meta.dirname, 'auditor-script.sh');
      const script = fs.readFileSync(scriptPath, 'utf-8');

      // The old bug was `sender_name || sender || ''` followed by a
      // single `.startsWith('web:')` — one field could mask the other.
      // The fix must evaluate the prefix against BOTH fields
      // independently. We guard by requiring at least TWO references
      // to `.startsWith('web:')` in the skip block, OR an explicit
      // OR-of-prefixes check against both `sender` and `sender_name`.
      const skipBlock = script.match(
        /\/\/ Skip web-origin[\s\S]{0,1200}?continue;/,
      );
      expect(skipBlock, 'web-origin skip block not found').not.toBeNull();
      const body = skipBlock![0];

      // Both fields must appear in the skip block.
      expect(body).toMatch(/\bsender\b/);
      expect(body).toMatch(/\bsender_name\b/);

      // And the prefix check must apply to each field, not just the
      // winner of a `||` fallback. The old code did
      //   const senderStr = msg.sender_name || msg.sender || '';
      //   if (senderStr.startsWith('web:')) continue;
      // which only checks ONE field (whichever wins the fallback) — a
      // non-empty `sender_name` masks a `web:`-prefixed `sender`.
      //
      // The fix must apply `.startsWith('web:')` (or an equivalent
      // regex) to BOTH fields independently. Simplest portable guard:
      // require at least two `.startsWith('web:')` calls inside the
      // skip block — one per field.
      const startsWithCount = (body.match(/\.startsWith\(['"]web:['"]\)/g) ?? [])
        .length;
      expect(
        startsWithCount,
        'Auditor web-origin filter must check BOTH sender and sender_name ' +
          'for the `web:` prefix (see src/index.ts isWebOriginMessage). ' +
          'Current block only checks one field via the `||` fallback, which ' +
          'misses QA injections where only one of the two fields carries ' +
          'the prefix. Call `.startsWith("web:")` on each field.',
      ).toBeGreaterThanOrEqual(2);
    });
  });

  describe('response attribution in busy groups', () => {
    it('does not attribute a reply across interleaved different-user messages', () => {
      const messages = [
        {
          sender: 'alice@s.whatsapp.net',
          sender_name: 'Alice',
          timestamp: '2026-04-15T10:00:00.000Z',
          is_bot_message: false,
          is_from_me: false,
        },
        {
          sender: 'bob@s.whatsapp.net',
          sender_name: 'Bob',
          timestamp: '2026-04-15T10:00:20.000Z',
          is_bot_message: false,
          is_from_me: false,
        },
        {
          sender: 'bot',
          sender_name: 'Case',
          timestamp: '2026-04-15T10:00:40.000Z',
          is_bot_message: true,
          is_from_me: true,
        },
      ];

      expect(attributedBotResponse(messages, 0)).toBeNull();
      expect(attributedBotResponse(messages, 1)).toEqual({
        timestamp: '2026-04-15T10:00:40.000Z',
      });
    });

    it('keeps attribution when only the same sender adds detail before the reply', () => {
      const messages = [
        {
          sender: 'alice@s.whatsapp.net',
          sender_name: 'Alice',
          timestamp: '2026-04-15T10:00:00.000Z',
          is_bot_message: false,
          is_from_me: false,
        },
        {
          sender: 'alice@s.whatsapp.net',
          sender_name: 'Alice',
          timestamp: '2026-04-15T10:00:10.000Z',
          is_bot_message: false,
          is_from_me: false,
        },
        {
          sender: 'bot',
          sender_name: 'Case',
          timestamp: '2026-04-15T10:00:40.000Z',
          is_bot_message: true,
          is_from_me: true,
        },
      ];

      expect(attributedBotResponse(messages, 0)).toEqual({
        timestamp: '2026-04-15T10:00:40.000Z',
      });
    });
  });

  describe('mutation attribution precision', () => {
    it('does not count another user’s mutation on a different task as evidence', () => {
      const msg = {
        sender: 'carol@s.whatsapp.net',
        sender_name: 'Carol',
        content: 'Concluir T5 agora',
      };
      const mutations = [
        { task_id: 'P9', by: 'Dave' },
      ];
      expect(taskMutationEvidence(msg, mutations, false)).toBe(false);
    });

    it('counts same-user same-task mutation as evidence', () => {
      const msg = {
        sender: 'carol@s.whatsapp.net',
        sender_name: 'Carol',
        content: 'Concluir T5 agora',
      };
      const mutations = [
        { task_id: 'T5', by: 'Carol' },
      ];
      expect(taskMutationEvidence(msg, mutations, false)).toBe(true);
    });

    it('counts same-user mutation when the user referenced a valid board-prefixed task ID', () => {
      const msg = {
        sender: 'carol@s.whatsapp.net',
        sender_name: 'Carol',
        content: 'Concluir TST-T5 agora',
      };
      const mutations = [
        { task_id: 'T5', by: 'Carol', short_code: 'TST' },
      ];
      expect(taskMutationEvidence(msg, mutations, false)).toBe(true);
    });

    it('does not let unrelated scheduled_tasks satisfy a non-reminder write', () => {
      const msg = {
        sender: 'carol@s.whatsapp.net',
        sender_name: 'Carol',
        content: 'Concluir T5 agora',
      };
      expect(taskMutationEvidence(msg, [], true)).toBe(false);
      expect(isReminderLikeWrite(msg.content)).toBe(false);
    });

    it('does let scheduled_tasks satisfy reminder-like writes', () => {
      const msg = {
        sender: 'carol@s.whatsapp.net',
        sender_name: 'Carol',
        content: 'Me lembre de cobrar o João amanhã às 8h',
      };
      expect(taskMutationEvidence(msg, [], true)).toBe(true);
      expect(isReminderLikeWrite(msg.content)).toBe(true);
    });

    it('prefers exact send_message_log correlation over unrelated sends in the same time window', () => {
      expect(
        crossGroupSendEvidence(
          'msg-1',
          [
            { trigger_message_id: 'msg-2', trigger_turn_id: null },
          ],
          {},
        ),
      ).toBe(false);
      expect(
        crossGroupSendEvidence(
          'msg-1',
          [
            { trigger_message_id: null, trigger_turn_id: 'turn-2' },
          ],
          { 'turn-2': ['msg-2'] },
        ),
      ).toBe(false);
      expect(
        crossGroupSendEvidence(
          'msg-1',
          [
            { trigger_message_id: null, trigger_turn_id: 'turn-1' },
          ],
          { 'turn-1': ['msg-1', 'msg-3'] },
        ),
      ).toBe(true);
    });
  });

  describe('drift detection', () => {
    const scriptPath = path.join(import.meta.dirname, 'auditor-script.sh');
    const script = fs.readFileSync(scriptPath, 'utf-8');
    const promptPath = path.join(import.meta.dirname, 'auditor-prompt.txt');
    const prompt = fs.readFileSync(promptPath, 'utf-8');

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
      // writeNeedsMutation = !isRead && !isIntent && isWrite
      // The `!isDmSend` gate was removed — the authoritative DM-send
      // evidence is now `send_message_log`, not the regex. isDmSend
      // stays as an informational bit in the interaction record for
      // Kipp's narrative layer.
      expect(script).toMatch(
        /writeNeedsMutation\s*=\s*!isRead\s*&&\s*!isIntent\s*&&\s*isWrite\b/,
      );
      // Guard against accidentally re-introducing the !isDmSend gate
      // in writeNeedsMutation. The log-based check supersedes it.
      expect(script).not.toMatch(/writeNeedsMutation[^;]*!isDmSend/);
      expect(script).toMatch(/unfulfilledWrite\s*=\s*writeNeedsMutation\s*&&\s*!mutationFound\s*&&\s*!refusalDetected/);
    });

    it('auditor-script.sh queries task_history, scheduled_tasks, AND send_message_log when isWrite', () => {
      // Mixed-intent messages must still check task mutations; the
      // DM-send exemption belongs in the flagging step, not here.
      // Guard against the regression where `isWrite && !isDmSend`
      // becomes the query gate again.
      expect(script).not.toMatch(/if\s*\(\s*isWrite\s*&&\s*!isDmSend\s*\)/);
      // All three tables must be consulted inside the single
      // `if (isWrite)` block — task_history for direct task mutations,
      // scheduled_tasks for reminders, send_message_log for cross-group
      // DM deliveries.
      expect(script).toMatch(
        /if\s*\(\s*isWrite\s*\)\s*\{[\s\S]*?taskHistoryStmt\.all[\s\S]*?scheduledTasksStmt\.get[\s\S]*?sendMessageLogStmt\.all/,
      );
      // Both scheduledTasksStmt AND sendMessageLogStmt must be prepared
      // against msgDb (messages.db), not tfDb.
      expect(script).toMatch(/const scheduledTasksStmt = msgDb\.prepare\(/);
      expect(script).toMatch(/const sendMessageLogStmt = msgDb\.prepare\(/);
      expect(script).toMatch(/const sendMessageTurnMatchStmt =/);
      // task_history query must include the `by` column so same-user
      // attribution is possible.
      expect(script).toMatch(/SELECT board_id, action, task_id, by, at FROM task_history/);
      // Upper bound must be `<=` to match task_history's boundary
      // convention (Codex LOW, 2026-04-11).
      expect(script).toMatch(/FROM scheduled_tasks\s+WHERE group_folder = \?\s+AND created_at >= \? AND created_at <= \?/);
      expect(script).toMatch(/FROM send_message_log\s+WHERE source_group_folder = \?\s+AND delivered_at >= \? AND delivered_at <= \?/);
      // Split mutationFound: task writes only satisfy via
      // sender/task-matched task_history or reminder-like scheduled_tasks;
      // shared-vocab writes can also be satisfied by send_message_log.
      expect(script).toMatch(
        /const matchingMutations = mutations\.filter/,
      );
      expect(script).toMatch(
        /normalizeForCompare\(mutation\.by\)\s*===\s*actorKey/,
      );
      expect(script).toMatch(
        /buildTaskIdAliases\(/,
      );
      expect(script).toMatch(
        /const scheduledTaskCreated = reminderLikeWrite &&/,
      );
      expect(script).toMatch(
        /taskMutationFound\s*=\s*matchingMutations\.length\s*>\s*0\s*\|\|\s*scheduledTaskCreated/,
      );
      expect(script).toMatch(
        /const sendLogs = sendMessageLogStmt\.all/,
      );
      expect(script).toMatch(
        /const directMessageMatch = hasSendMessageTriggerMessageId &&/,
      );
      expect(script).toMatch(
        /const turnMembershipMatch = !directMessageMatch &&/,
      );
      expect(script).toMatch(
        /const hasAnyExactCorrelation = sendLogs\.some/,
      );
      expect(script).toMatch(
        /mutationFound\s*=\s*isTaskWrite\s*\?\s*taskMutationFound\s*:\s*\(taskMutationFound\s*\|\|\s*crossGroupSendLogged\)/,
      );
    });

    it('auditor-script.sh emits isRead, isIntent, taskMutationFound, and crossGroupSendLogged in each flagged interaction', () => {
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
      expect(body).toMatch(/\btaskRefs\b/);
      expect(body).toMatch(/\breminderLikeWrite\b/);
      expect(body).toMatch(/\btaskMutationFound\b/);
      expect(body).toMatch(/\bcrossGroupSendLogged\b/);
      expect(body).toMatch(/\bsourceMessageId\b/);
      expect(body).toMatch(/\bbotResponseMessageId\b/);
    });

    it('auditor-script.sh nulls bot attribution when another user speaks before the reply', () => {
      const attributionBlock = script.match(
        /\/\/ Find bot response within 10 minutes[\s\S]{0,2200}?const isWrite = isWriteRequest\(msg\.content\);/,
      );
      expect(attributionBlock, 'response attribution block not found').not.toBeNull();
      const body = attributionBlock![0];

      expect(script).toContain('function interactionSenderKey(');
      expect(body).toContain('let interleavedUserBeforeReply = false');
      expect(body).toMatch(/interactionSenderKey\(msg\)/);
      expect(body).toMatch(/interactionSenderKey\(next\)\s*!==\s*headKey/);
      expect(body).toMatch(/botResponse\s*=\s*null/);
    });

    it('auditor-script.sh emits interleavedUserBeforeReply in flagged interactions', () => {
      const pushBlock = script.match(/interactions\.push\(\{[\s\S]*?\}\);/);
      expect(pushBlock, 'interactions.push block not found').not.toBeNull();
      expect(pushBlock![0]).toMatch(/\binterleavedUserBeforeReply\b/);
    });

    it('auditor-script.sh prefers exact trigger_turn_id correlation for self-corrections, with legacy fallback', () => {
      expect(script).toContain("const hasTaskHistoryTriggerTurnId = taskHistoryColumns.has('trigger_turn_id')");
      expect(script).toContain('const exactTurnMessagesStmt = hasAgentTurnMessages');
      expect(script).toContain('FROM agent_turn_messages atm');
      expect(script).toContain('pair.second_trigger_turn_id && exactTurnMessagesStmt');
      expect(script).toContain('resolveExactTurnMessages(');
      expect(script).toContain('if (!exactTrigger && displayName)');
      expect(script).toContain('triggerTurnId: exactTrigger ? exactTrigger.triggerTurnId : null');
      expect(script).toContain('triggerMessageIds: exactTrigger');
    });

    it('auditor-prompt.txt tells the reviewer to emit correlation refs when available', () => {
      expect(prompt).toContain('sourceMessageId');
      expect(prompt).toContain('botResponseMessageId');
      expect(prompt).toContain('triggerTurnId');
      expect(prompt).toContain('triggerMessageIds');
      expect(prompt).toContain('_Refs:');
    });

    for (const [name, pattern] of [
      ['READ_QUERY_HARD_PATTERN', READ_QUERY_HARD_PATTERN],
      ['READ_QUERY_SOFT_PATTERN', READ_QUERY_SOFT_PATTERN],
      ['IMPERATIVE_VERB_PATTERN', IMPERATIVE_VERB_PATTERN],
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
