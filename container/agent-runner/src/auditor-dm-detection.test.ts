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

function isDmSendRequest(text: string): boolean {
  return DM_SEND_PATTERNS.some((p) => p.test(text));
}

function isTaskWriteRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return TASK_KEYWORDS.some((kw) => lower.includes(kw)) || TERSE_PATTERN.test(text);
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

    it('auditor-script.sh wires isDmSendRequest and isTaskWriteRequest into writeNeedsMutation', () => {
      // These call sites carry the whole fix: removing any of them
      // either reintroduces the structural false positive (DM-send
      // exemption), the mixed-intent regression (isTaskWrite fallback),
      // or the shared-vocabulary carve-out.
      expect(script).toContain('function isDmSendRequest(');
      expect(script).toContain('function isTaskWriteRequest(');
      expect(script).toContain('const isDmSend = isDmSendRequest(msg.content)');
      expect(script).toContain('const isTaskWrite = isTaskWriteRequest(msg.content)');
      expect(script).toMatch(/writeNeedsMutation\s*=\s*isTaskWrite\s*\|\|\s*\(isWrite\s*&&\s*!isDmSend\)/);
      expect(script).toMatch(/unfulfilledWrite\s*=\s*writeNeedsMutation\s*&&\s*!mutationFound\s*&&\s*!refusalDetected/);
    });

    it('auditor-script.sh always runs the mutation query when isWrite', () => {
      // Mixed-intent messages must still check task mutations; the
      // DM-send exemption belongs in the flagging step, not here.
      // Guard against the regression where `isWrite && !isDmSend`
      // becomes the query gate again.
      expect(script).not.toMatch(/if\s*\(\s*isWrite\s*&&\s*!isDmSend\s*\)/);
      expect(script).toMatch(/if\s*\(\s*isWrite\s*\)\s*\{[\s\S]*?taskHistoryStmt\.all/);
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
