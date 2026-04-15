export type SemanticField = 'scheduled_at' | 'due_date' | 'assignee';

export interface QualifyingMutation {
  taskId: string;
  boardId: string;
  action: 'updated';
  by: string | null;
  at: string;
  details: string;
  fieldKind: SemanticField;
  extractedValue: string | null;
}

export interface FactCheckContext {
  userMessage: string | null;
  userDisplayName: string | null;
  messageTimestamp: string | null;
  boardTimezone: string;
  headerToday: string;
  headerWeekday: string;
}

export interface SemanticDeviation {
  taskId: string;
  boardId: string;
  fieldKind: SemanticField;
  at: string;
  by: string;
  userMessage: string | null;
  storedValue: string | null;
  intentMatches: boolean;
  deviation: string | null;
  confidence: 'high' | 'med' | 'low';
  rawResponse: string;
}

function resolveTimezoneOrUtc(tz: string): string {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export function deriveContextHeader(
  isoTimestamp: string,
  boardTimezone: string,
): { today: string; weekday: string } {
  const tz = resolveTimezoneOrUtc(boardTimezone);
  const at = new Date(isoTimestamp);
  if (isNaN(at.getTime())) {
    throw new RangeError(`deriveContextHeader: invalid isoTimestamp "${isoTimestamp}"`);
  }
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const wkFmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    weekday: 'long',
  });
  const parts = Object.fromEntries(
    dateFmt.formatToParts(at).map((p) => [p.type, p.value]),
  );
  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: wkFmt.format(at),
  };
}

const REAGENDADA_PATTERN =
  /Reunião reagendada para (\d{1,2})\/(\d{1,2})\/(\d{4}) às (\d{1,2}):(\d{2})/;

export function extractScheduledAtValue(details: string): string | null {
  if (!details) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return null;
  }
  const changes = (parsed as { changes?: unknown })?.changes;
  if (!Array.isArray(changes)) return null;
  for (const change of changes) {
    if (typeof change !== 'string') continue;
    const m = change.match(REAGENDADA_PATTERN);
    if (m) {
      const [, dd, mm, yyyy, hh, mi] = m;
      return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${mi}`;
    }
  }
  return null;
}

export function buildPrompt(
  mutation: QualifyingMutation,
  context: FactCheckContext,
): string {
  const userLine = context.userMessage
    ? `Mensagem do usuário (${context.userDisplayName ?? 'desconhecido'}, ${context.messageTimestamp ?? '?'}):\n${context.userMessage}`
    : '(mensagem do usuário não localizada)';

  return [
    'Você é um auditor que compara a intenção declarada por um usuário com a mutação que o bot armazenou no banco.',
    '',
    'Contexto temporal (como o agente viu no momento da mensagem):',
    `- Data de hoje: ${context.headerToday} (${context.headerWeekday})`,
    `- Fuso horário: ${context.boardTimezone}`,
    '',
    userLine,
    '',
    'Mutação registrada pelo bot:',
    `- Tarefa: ${mutation.taskId}`,
    `- Campo: ${mutation.fieldKind}`,
    `- Valor armazenado: ${mutation.extractedValue ?? '(não extraído)'}`,
    '',
    'Pense passo a passo antes de responder:',
    '1. Que ação o usuário pediu? Que campos ele especificou (data, hora, nome, título)?',
    `2. Que valores o bot armazenou? Para datas, derive o dia da semana no fuso (${context.boardTimezone}) e o horário em formato local.`,
    '3. Os valores armazenados correspondem à intenção do usuário?',
    '',
    'Importante:',
    '- Se o usuário forneceu uma faixa de horário (ex: "9h às 9h30") e o bot armazenou apenas o início, isso é POR DESIGN do TaskFlow (não rastreia horário de fim) — não conta como divergência.',
    '- Se o usuário pediu também algo que vira uma linha SEPARADA no histórico (ex: "me avise um dia antes" → reminder_added), a ausência dessa ação NESTA mutação não é divergência — ela vive em outra linha.',
    '- Se o usuário usou um nome ambíguo mas o bot resolveu corretamente para a única pessoa do quadro com aquele nome, isso é correto.',
    '',
    'Depois do raciocínio, produza JSON em bloco fenced:',
    '',
    '```json',
    '{ "intent_matches": boolean, "deviation": string|null, "confidence": "high"|"med"|"low" }',
    '```',
  ].join('\n');
}
