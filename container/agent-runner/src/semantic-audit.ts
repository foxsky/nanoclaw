import fs from 'fs';
import path from 'path';
import type { Database as BetterSqliteDB } from 'better-sqlite3';
import { resolveTimezoneOrUtc } from './tz-util.js';

export const CONFIDENCE_VALUES = ['high', 'med', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_VALUES)[number];

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
  confidence: Confidence;
  rawResponse: string;
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

export function parseOllamaResponse(raw: string): {
  intentMatches: boolean;
  deviation: string | null;
  confidence: Confidence;
} | null {
  if (!raw) return null;

  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.intent_matches !== 'boolean') return null;
  if (!CONFIDENCE_VALUES.includes(p.confidence as Confidence)) return null;
  const deviation = typeof p.deviation === 'string' ? p.deviation : null;

  return {
    intentMatches: p.intent_matches,
    deviation,
    confidence: p.confidence as Confidence,
  };
}

export async function callOllama(
  host: string,
  model: string,
  prompt: string,
  timeoutMs = 30_000,
): Promise<string | null> {
  if (!host) return null;
  try {
    // Note: NO `format: 'json'`. Strict JSON mode prevents chain-of-thought
    // reasoning, which several models (gemma4, qwen3.5) need to correctly
    // derive the stored date's weekday before classifying. The prompt asks
    // for a fenced JSON block; parseOllamaResponse() handles fences.
    const resp = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { response?: string };
    return data.response ?? null;
  } catch {
    return null;
  }
}

export interface RunSemanticAuditArgs {
  msgDb: BetterSqliteDB;
  tfDb: BetterSqliteDB;
  period: { startIso: string; endIso: string };
  ollamaHost: string;
  ollamaModel: string;
}

export interface SemanticAuditCounters {
  examined: number;       // qualifying mutations seen
  noTrigger: number;      // mutation but no triggering user message in window
  boardMapFail: number;   // board_id → group jid resolution failed
  ollamaFail: number;     // callOllama returned null (timeout / non-200 / network)
  parseFail: number;      // Ollama returned text but parseOllamaResponse rejected it
}

export interface SemanticAuditResult {
  deviations: SemanticDeviation[];
  counters: SemanticAuditCounters;
}

export async function runSemanticAudit(
  args: RunSemanticAuditArgs,
): Promise<SemanticAuditResult> {
  const { msgDb, tfDb, period, ollamaHost, ollamaModel } = args;

  // Qualifying mutations: any action where the bot interpreted user intent and
  // stored a value that could be semantically wrong. Excludes note-only updates
  // (the note text IS the user's message — no interpretation gap), label/priority
  // changes (explicit commands), and column moves (handled by taskflow_move with
  // no ambiguity). Includes:
  //   - 'updated' with date/time changes (Reunião reagendada, Prazo definido)
  //   - 'updated' with title changes (Título alterado)
  //   - 'reassigned' (from_assignee → to_assignee resolution)
  //   - 'created' with scheduled_at or assignee (initial task creation)
  const mutationRows = tfDb
    .prepare(
      `SELECT board_id AS boardId, task_id AS taskId, action, by, at, details
       FROM task_history
       WHERE at >= ? AND at < ?
         AND by IS NOT NULL
         AND (
           (action = 'updated' AND (
             details LIKE '%"Reunião reagendada%'
             OR details LIKE '%"Prazo definido:%'
             OR details LIKE '%"Título alterado%'
           ))
           OR action = 'reassigned'
           OR (action = 'created' AND (
             details LIKE '%scheduled_at%'
             OR details LIKE '%assignee%'
           ))
         )`,
    )
    .all(period.startIso, period.endIso) as Array<{
      boardId: string;
      taskId: string;
      action: string;
      by: string;
      at: string;
      details: string;
    }>;

  const counters: SemanticAuditCounters = {
    examined: mutationRows.length,
    noTrigger: 0,
    boardMapFail: 0,
    ollamaFail: 0,
    parseFail: 0,
  };

  if (mutationRows.length === 0) return { deviations: [], counters };

  // Board → group jid resolution is two-step: `boards` lives in tfDb and
  // `registered_groups` lives in msgDb. SQLite prepared statements cannot
  // span two database connections, so we derive the folder from tfDb first,
  // then look up the jid in msgDb. Do NOT collapse these into a single JOIN.
  const tzStmt = tfDb.prepare(
    `SELECT timezone FROM board_runtime_config WHERE board_id = ?`,
  );
  const folderStmt = tfDb.prepare(
    `SELECT LOWER(REPLACE(id, 'board-', '')) AS folder FROM boards WHERE id = ?`,
  );
  const groupStmt = msgDb.prepare(
    `SELECT jid FROM registered_groups WHERE folder = ?`,
  );
  const personStmt = tfDb.prepare(
    `SELECT name FROM board_people WHERE board_id = ? AND person_id = ? LIMIT 1`,
  );
  const triggerStmt = msgDb.prepare(
    `SELECT content, timestamp, sender_name FROM messages
     WHERE chat_jid = ? AND timestamp <= ? AND timestamp >= ?
       AND is_bot_message = 0 AND is_from_me = 0
       AND content IS NOT NULL AND content != ''
       AND sender_name LIKE ? ESCAPE '\\'
     ORDER BY timestamp DESC LIMIT 1`,
  );

  const deviations: SemanticDeviation[] = [];

  for (const row of mutationRows) {
    // Classify the mutation and extract a human-readable stored value.
    // For scheduled_at: try the regex extractor (precise ISO). For everything
    // else: pass the raw details JSON to the LLM — it proved capable of reading
    // {"changes":["Prazo definido: 2026-04-17"]} and {"from_assignee":"X","to_assignee":"Y"}
    // in the 2026-04-15 e2e eval.
    let fieldKind: SemanticField;
    let storedValue: string | null;

    if (row.details.includes('"Reunião reagendada')) {
      fieldKind = 'scheduled_at';
      storedValue = extractScheduledAtValue(row.details) ?? row.details;
    } else if (row.details.includes('"Prazo definido:')) {
      fieldKind = 'due_date';
      storedValue = row.details;
    } else if (row.action === 'reassigned') {
      fieldKind = 'assignee';
      storedValue = row.details;
    } else if (row.action === 'created') {
      // Created rows: classify by what's interesting (scheduled_at > assignee)
      fieldKind = row.details.includes('scheduled_at') ? 'scheduled_at' : 'assignee';
      storedValue = row.details;
    } else {
      // Title changes and other update types
      fieldKind = 'due_date'; // generic "field update" bucket
      storedValue = row.details;
    }

    const tzRow = tzStmt.get(row.boardId) as { timezone: string } | undefined;
    const boardTimezone = tzRow?.timezone ?? 'America/Fortaleza';

    const personRow = personStmt.get(row.boardId, row.by) as { name: string } | undefined;
    const userDisplayName = personRow?.name ?? null;

    const folderRow = folderStmt.get(row.boardId) as { folder: string } | undefined;
    const groupRow = folderRow
      ? (groupStmt.get(folderRow.folder) as { jid: string } | undefined)
      : undefined;
    let userMessage: string | null = null;
    let messageTimestamp: string | null = null;
    if (!groupRow) {
      counters.boardMapFail++;
    } else if (userDisplayName) {
      const windowStart = new Date(new Date(row.at).getTime() - 600_000).toISOString();
      // LIKE-wildcard escape + triggerStmt query shape must stay in sync with
      // the self-correction detector in auditor-script.sh (~L420, L552).
      const escaped = userDisplayName.replace(/[\\%_]/g, (c) => '\\' + c);
      const likeName = `%${escaped}%`;
      const tr = triggerStmt.get(groupRow.jid, row.at, windowStart, likeName) as
        | { content: string; timestamp: string; sender_name: string }
        | undefined;
      if (tr) {
        userMessage = tr.content;
        messageTimestamp = tr.timestamp;
      } else {
        counters.noTrigger++;
      }
    }

    const header = messageTimestamp
      ? deriveContextHeader(messageTimestamp, boardTimezone)
      : deriveContextHeader(row.at, boardTimezone);

    const mutation: QualifyingMutation = {
      taskId: row.taskId,
      boardId: row.boardId,
      action: row.action as 'updated',
      by: row.by,
      at: row.at,
      details: row.details,
      fieldKind,
      extractedValue: storedValue,
    };

    const context: FactCheckContext = {
      userMessage,
      userDisplayName,
      messageTimestamp,
      boardTimezone,
      headerToday: header.today,
      headerWeekday: header.weekday,
    };

    const prompt = buildPrompt(mutation, context);
    const raw = await callOllama(ollamaHost, ollamaModel, prompt);
    if (!raw) {
      counters.ollamaFail++;
      continue;
    }
    const parsed = parseOllamaResponse(raw);
    if (!parsed) {
      counters.parseFail++;
      continue;
    }

    deviations.push({
      taskId: row.taskId,
      boardId: row.boardId,
      fieldKind,
      at: row.at,
      by: row.by,
      userMessage,
      storedValue,
      intentMatches: parsed.intentMatches,
      deviation: parsed.deviation,
      confidence: parsed.confidence,
      rawResponse: raw,
    });
  }

  return { deviations, counters };
}

export function writeDryRunLog(
  deviations: SemanticDeviation[],
  rootDir = '/workspace/audit',
  now: Date = new Date(),
): void {
  if (deviations.length === 0) return;
  fs.mkdirSync(rootDir, { recursive: true });
  const dateStr = now.toISOString().slice(0, 10);
  const file = path.join(rootDir, `semantic-dryrun-${dateStr}.ndjson`);
  const lines = deviations.map((d) => JSON.stringify(d)).join('\n') + '\n';
  fs.appendFileSync(file, lines);
}
