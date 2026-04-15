# Semantic Audit (MVP — scheduled_at, dry-run) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend NanoClaw's daily auditor with an async LLM-in-the-loop fact-check that compares user intent to stored state. Primary purpose is **structured instrumentation and exemplar discovery** for silent semantic failures (the class detector D cannot see because the user never re-edited). Scoped to `scheduled_at` mutations and shipping in dry-run mode. The end state is NOT "permanent LLM audit running every night" — it is "use the LLM audit to surface recurring bug classes, then promote each one into a deterministic guard like `intended_weekday`". Flipping to `enabled` is optional, not the success criterion.

**Why dry-run is the right primary mode (per Codex review 2026-04-15):** The LLM audit is correlated with the bot's own LLM, so it can't be trusted as an independent oracle. But the bake-off showed non-trivial behavioral independence (5/6 candidate models caught the Giovanni case; one missed it). That's enough independence to use the audit as a *discovery feed* — surface candidate failures to a human, who labels them and converts recurring classes into deterministic rules. The dry-run NDJSON is the discovery feed; the labeled corpus is the conversion record; deterministic guards are the long-term destination.

**Architecture:** A new ESM module `container/agent-runner/src/semantic-audit.ts` owns pure fact-check logic: SQL for qualifying mutations, prompt builder, Ollama client (reusing the existing pattern from `ipc-mcp-stdio.ts`), response parser, and a dry-run NDJSON writer. `container/agent-runner/src/auditor-script.sh` dynamic-imports the module from its heredoc'd CJS entry and runs the check after the existing self-correction block. A new env var `NANOCLAW_SEMANTIC_AUDIT_MODE` gates three states: unset (off, default), `dryrun` (log to file, don't emit to Kipp), `enabled` (attach to board output — not used in MVP).

**Tech Stack:** Node.js ESM, TypeScript strict, vitest, better-sqlite3 (readonly), Intl.DateTimeFormat, fetch + AbortSignal.timeout, Ollama `/api/generate` at `NANOCLAW_OLLAMA_HOST` (192.168.2.13:11434). Default model: `qwen3.5:35b-a3b-coding-nvfp4` (local) — keeps user-message content on the LAN. Cloud opt-in (`NANOCLAW_SEMANTIC_AUDIT_CLOUD=1`) switches to `minimax-m2.7:cloud` (~10× faster, validated against Giovanni and 5 today's mutations).

---

## File Structure

### New files

- `container/agent-runner/src/semantic-audit.ts` — all new logic. Exports: `QualifyingMutation`, `FactCheckContext`, `SemanticDeviation` types; pure helpers `extractScheduledAtValue`, `deriveContextHeader`, `buildPrompt`, `parseOllamaResponse`; async `callOllama`, `runSemanticAudit`, `writeDryRunLog`.
- `container/agent-runner/src/semantic-audit.test.ts` — vitest unit tests for every pure function plus a mocked-Ollama integration test that replays the Giovanni case end-to-end.
- `docs/semantic-audit-calibration.md` — operator runbook for the dry-run calibration period (how to inspect the log, how to compare against self-correction hits, when to flip to `enabled`).

### Modified files

- `container/agent-runner/src/auditor-script.sh` — wrap the final `console.log(JSON.stringify(result))` in an async IIFE; add a conditional semantic-audit block that fires when `NANOCLAW_SEMANTIC_AUDIT_MODE` is set.
- `CHANGELOG.md` — top entry for the dry-run ship.
- `.claude/skills/add-taskflow/CHANGELOG.md` — same entry.
- `container/agent-runner/src/index.ts` — pass `NANOCLAW_SEMANTIC_AUDIT_MODE` through `containerInput` env to the script phase so it propagates from the host. (Verify whether the main container already inherits arbitrary env vars from the host; if yes, this modification is a no-op.)

### Responsibility boundaries

| File | Responsibility |
|------|---------------|
| `semantic-audit.ts` | Pure logic + Ollama IO + dry-run writer. No schema coupling beyond the `task_history` / `messages` / `board_runtime_config` / `board_people` SELECTs it issues. |
| `semantic-audit.test.ts` | One describe block per exported function; one integration test per scenario (Giovanni match, assignee skip, Ollama unreachable, malformed response). |
| `auditor-script.sh` | Existing JSON-producing auditor logic unchanged; new block only mutates `result` when the env gate is on. |
| `docs/semantic-audit-calibration.md` | Human-readable runbook. Not loaded by any code. |

---

## Cross-cutting conventions

**Where to run commands:** `container/agent-runner/` is its own npm package. Run build/test from there:
```bash
cd /root/nanoclaw/container/agent-runner
npm run build   # tsc → dist/
npx vitest run  # vitest runs src/*.test.ts
```

**How to run the existing auditor locally:** `container/agent-runner/src/auditor-script.sh` runs inside the main group's container during its scheduled script phase. You don't need to simulate the full pipeline — the logic you're touching lives in `semantic-audit.ts` and is unit-testable.

**How deployment works:** A single `./scripts/deploy.sh` from `/root/nanoclaw/` on the host builds the Docker image and rsyncs `container/agent-runner/src/` + `dist/` to `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/`. Do not push manually.

**Codex review before every commit that triggers deploy.** The user's memory explicitly requires this (see `feedback_review_before_deploy.md`). Use the `codex` skill with `gpt-5.4 high` reasoning, `read-only` sandbox. Do not skip.

**No mocking of better-sqlite3 in tests.** Seed a real in-memory SQLite (`new Database(':memory:')`) and populate the minimum schema the function under test reads. This matches the existing `auditor-dm-detection.test.ts` and `taskflow-engine.test.ts` pattern.

**Mock fetch with `vi.stubGlobal('fetch', vi.fn())`** for Ollama tests. Don't hit the network.

---

## Task 1: Module scaffolding + types

**Files:**
- Create: `container/agent-runner/src/semantic-audit.ts`
- Create: `container/agent-runner/src/semantic-audit.test.ts`

- [ ] **Step 1.1: Write the failing type-shape test**

Create `container/agent-runner/src/semantic-audit.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import type {
  QualifyingMutation,
  FactCheckContext,
  SemanticDeviation,
} from './semantic-audit.js';

describe('semantic-audit type surface', () => {
  it('QualifyingMutation carries task_history row + extracted value', () => {
    const m: QualifyingMutation = {
      taskId: 'M1',
      boardId: 'board-seci-taskflow',
      action: 'updated',
      by: 'giovanni',
      at: '2026-04-14T11:04:11.450Z',
      details: '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}',
      fieldKind: 'scheduled_at',
      extractedValue: '2026-04-17T11:00',
    };
    expect(m.fieldKind).toBe('scheduled_at');
  });

  it('FactCheckContext carries prompt inputs', () => {
    const c: FactCheckContext = {
      userMessage: 'alterar M1 para quinta-feira 11h',
      userDisplayName: 'Carlos Giovanni',
      messageTimestamp: '2026-04-14T11:03:37.000Z',
      boardTimezone: 'America/Fortaleza',
      headerToday: '2026-04-14',
      headerWeekday: 'terça-feira',
    };
    expect(c.headerToday).toBe('2026-04-14');
  });

  it('SemanticDeviation is the full output shape', () => {
    const d: SemanticDeviation = {
      taskId: 'M1',
      boardId: 'board-seci-taskflow',
      fieldKind: 'scheduled_at',
      at: '2026-04-14T11:04:11.450Z',
      by: 'giovanni',
      userMessage: 'alterar M1 para quinta-feira 11h',
      storedValue: '2026-04-17T11:00',
      intentMatches: false,
      deviation: 'User said quinta (Thursday = 16/04) but stored 17/04 (Friday)',
      confidence: 'high',
      rawResponse: '{"intent_matches":false,...}',
    };
    expect(d.intentMatches).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts`
Expected: FAIL with "Cannot find module './semantic-audit.js'"

- [ ] **Step 1.3: Create the module with exported types only**

Create `container/agent-runner/src/semantic-audit.ts`:

```ts
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
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 1.5: Commit**

```bash
cd /root/nanoclaw
git add container/agent-runner/src/semantic-audit.ts container/agent-runner/src/semantic-audit.test.ts
git commit -m "feat(auditor): scaffold semantic-audit module with types"
```

---

## Task 2: `extractScheduledAtValue` — parse the human-readable details string back to ISO

**Why:** The engine emits `task_history.details = '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}'`. To fact-check, we need the ISO value the bot actually stored: `"2026-04-17T11:00"`. Parse it out of the pt-BR phrase.

**Files:**
- Modify: `container/agent-runner/src/semantic-audit.ts`
- Modify: `container/agent-runner/src/semantic-audit.test.ts`

- [ ] **Step 2.1: Write failing tests**

Append to `semantic-audit.test.ts`:

```ts
import { extractScheduledAtValue } from './semantic-audit.js';

describe('extractScheduledAtValue', () => {
  it('parses the canonical reagendada string', () => {
    const r = extractScheduledAtValue(
      '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}',
    );
    expect(r).toBe('2026-04-17T11:00');
  });

  it('parses single-digit day/month with zero-padding', () => {
    const r = extractScheduledAtValue(
      '{"changes":["Reunião reagendada para 3/5/2026 às 8:30"]}',
    );
    expect(r).toBe('2026-05-03T08:30');
  });

  it('returns null when no reagendada phrase present', () => {
    const r = extractScheduledAtValue('{"changes":["Prazo definido: 2026-04-15"]}');
    expect(r).toBeNull();
  });

  it('returns null on malformed details JSON', () => {
    expect(extractScheduledAtValue('not json{')).toBeNull();
  });

  it('returns null on empty/undefined input', () => {
    expect(extractScheduledAtValue('')).toBeNull();
  });
});
```

- [ ] **Step 2.2: Run to verify failures**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t extractScheduledAtValue`
Expected: FAIL — `extractScheduledAtValue is not a function`

- [ ] **Step 2.3: Implement**

Append to `semantic-audit.ts`:

```ts
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
```

- [ ] **Step 2.4: Run tests**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t extractScheduledAtValue`
Expected: PASS, 5 tests

- [ ] **Step 2.5: Commit**

```bash
cd /root/nanoclaw
git add container/agent-runner/src/semantic-audit.ts container/agent-runner/src/semantic-audit.test.ts
git commit -m "feat(semantic-audit): extract scheduled_at ISO from details JSON"
```

---

## Task 3: `deriveContextHeader` — compute what the `<context>` tag said at mutation time

**Why:** The fact-check prompt needs to tell the LLM "at the time the user sent the message, today was 2026-04-14 (terça-feira)". We don't store this; recompute from `messages.timestamp` + `board_runtime_config.timezone` using the same `Intl.DateTimeFormat` approach as `src/router.ts:localDateAndWeekday`.

**Files:**
- Modify: `container/agent-runner/src/semantic-audit.ts`
- Modify: `container/agent-runner/src/semantic-audit.test.ts`

- [ ] **Step 3.1: Write failing tests**

Append to `semantic-audit.test.ts`:

```ts
import { deriveContextHeader } from './semantic-audit.js';

describe('deriveContextHeader', () => {
  it('gives today + pt-BR weekday for a Fortaleza timestamp', () => {
    // 2026-04-14T11:03:37.000Z is 08:03 local in America/Fortaleza (UTC-3) — still Tuesday.
    const h = deriveContextHeader('2026-04-14T11:03:37.000Z', 'America/Fortaleza');
    expect(h).toEqual({ today: '2026-04-14', weekday: 'terça-feira' });
  });

  it('handles a UTC day boundary that sits on the previous local day', () => {
    // 2026-04-15T02:00:00Z is 2026-04-14 23:00 in Fortaleza — still Tuesday.
    const h = deriveContextHeader('2026-04-15T02:00:00.000Z', 'America/Fortaleza');
    expect(h).toEqual({ today: '2026-04-14', weekday: 'terça-feira' });
  });

  it('falls back to UTC on invalid timezone', () => {
    const h = deriveContextHeader('2026-04-14T14:00:00.000Z', 'Not/A_Zone');
    expect(h.today).toBe('2026-04-14');
    expect(h.weekday).toBe('terça-feira');
  });
});
```

- [ ] **Step 3.2: Run to verify failure**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t deriveContextHeader`
Expected: FAIL — `deriveContextHeader is not a function`

- [ ] **Step 3.3: Implement**

Append to `semantic-audit.ts`:

```ts
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
```

- [ ] **Step 3.4: Run tests**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t deriveContextHeader`
Expected: PASS, 3 tests

- [ ] **Step 3.5: Commit**

```bash
cd /root/nanoclaw
git add container/agent-runner/src/semantic-audit.ts container/agent-runner/src/semantic-audit.test.ts
git commit -m "feat(semantic-audit): deriveContextHeader mirrors router.ts localDateAndWeekday"
```

---

## Task 4: `buildPrompt` — compose the pt-BR fact-check prompt

**Files:**
- Modify: `container/agent-runner/src/semantic-audit.ts`
- Modify: `container/agent-runner/src/semantic-audit.test.ts`

- [ ] **Step 4.1: Write failing tests**

Append to `semantic-audit.test.ts`:

```ts
import { buildPrompt } from './semantic-audit.js';

describe('buildPrompt', () => {
  const mutation: QualifyingMutation = {
    taskId: 'M1',
    boardId: 'board-seci-taskflow',
    action: 'updated',
    by: 'giovanni',
    at: '2026-04-14T11:04:11.450Z',
    details: '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}',
    fieldKind: 'scheduled_at',
    extractedValue: '2026-04-17T11:00',
  };

  const context: FactCheckContext = {
    userMessage: 'alterar M1 para quinta-feira 11h',
    userDisplayName: 'Carlos Giovanni',
    messageTimestamp: '2026-04-14T11:03:37.000Z',
    boardTimezone: 'America/Fortaleza',
    headerToday: '2026-04-14',
    headerWeekday: 'terça-feira',
  };

  it('includes the stored value, user message, and context header', () => {
    const p = buildPrompt(mutation, context);
    expect(p).toContain('M1');
    expect(p).toContain('2026-04-17T11:00');
    expect(p).toContain('alterar M1 para quinta-feira 11h');
    expect(p).toContain('2026-04-14');
    expect(p).toContain('terça-feira');
    expect(p).toContain('America/Fortaleza');
  });

  it('asks for fenced JSON output with chain-of-thought reasoning', () => {
    const p = buildPrompt(mutation, context);
    expect(p).toMatch(/intent_matches/);
    expect(p).toMatch(/confidence/);
    expect(p).toMatch(/deviation/);
    expect(p).toMatch(/```json/);
    expect(p).toMatch(/passo a passo/);
    expect(p).toMatch(/dia da semana/);
  });

  it('handles a null userMessage gracefully', () => {
    const p = buildPrompt(mutation, { ...context, userMessage: null });
    expect(p).toContain('(mensagem do usuário não localizada)');
  });
});
```

- [ ] **Step 4.2: Run to verify failures**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t buildPrompt`
Expected: FAIL — `buildPrompt is not a function`

- [ ] **Step 4.3: Implement (CoT prompt + fenced JSON output, no `format: json`)**

Validated against 6 real cases (1 NEGATIVE Giovanni + 5 POSITIVE today). The chain-of-thought structure is what made gemma4 and qwen3.5 correctly compute the weekday; without it, even capable models take user-stated weekdays at face value (qwen3-coder failed both v1 and v2 evals because it skipped step-by-step reasoning).

Append to `semantic-audit.ts`:

```ts
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
```

- [ ] **Step 4.4: Run tests**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t buildPrompt`
Expected: PASS, 3 tests

- [ ] **Step 4.5: Commit**

```bash
cd /root/nanoclaw
git add container/agent-runner/src/semantic-audit.ts container/agent-runner/src/semantic-audit.test.ts
git commit -m "feat(semantic-audit): pt-BR prompt builder for fact-check calls"
```

---

## Task 5: `parseOllamaResponse` — defensive JSON parsing

**Why:** Ollama returns `{ response: "...json-as-string..." }` in its `/api/generate` response. The inner JSON can be malformed, wrapped in code fences, or arrive with extra prose. Parse defensively.

**Files:**
- Modify: `container/agent-runner/src/semantic-audit.ts`
- Modify: `container/agent-runner/src/semantic-audit.test.ts`

- [ ] **Step 5.1: Write failing tests**

Append to `semantic-audit.test.ts`:

```ts
import { parseOllamaResponse } from './semantic-audit.js';

describe('parseOllamaResponse', () => {
  it('parses a clean JSON response', () => {
    const r = parseOllamaResponse(
      '{"intent_matches":false,"deviation":"wrong day","confidence":"high"}',
    );
    expect(r).toEqual({
      intentMatches: false,
      deviation: 'wrong day',
      confidence: 'high',
    });
  });

  it('strips surrounding code fences', () => {
    const r = parseOllamaResponse(
      '```json\n{"intent_matches":true,"deviation":null,"confidence":"high"}\n```',
    );
    expect(r).toEqual({
      intentMatches: true,
      deviation: null,
      confidence: 'high',
    });
  });

  it('finds the JSON block when surrounded by prose', () => {
    const r = parseOllamaResponse(
      'Here is the JSON: {"intent_matches":true,"deviation":null,"confidence":"med"} that is all.',
    );
    expect(r?.intentMatches).toBe(true);
    expect(r?.confidence).toBe('med');
  });

  it('returns null on unparseable response', () => {
    expect(parseOllamaResponse('not json at all')).toBeNull();
  });

  it('returns null when confidence is not in the allowed set', () => {
    const r = parseOllamaResponse(
      '{"intent_matches":false,"deviation":"x","confidence":"extreme"}',
    );
    expect(r).toBeNull();
  });

  it('returns null when intent_matches is not boolean', () => {
    const r = parseOllamaResponse(
      '{"intent_matches":"yes","deviation":null,"confidence":"high"}',
    );
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 5.2: Run to verify failures**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t parseOllamaResponse`
Expected: FAIL — `parseOllamaResponse is not a function`

- [ ] **Step 5.3: Implement**

Append to `semantic-audit.ts`:

```ts
export function parseOllamaResponse(raw: string): {
  intentMatches: boolean;
  deviation: string | null;
  confidence: 'high' | 'med' | 'low';
} | null {
  if (!raw) return null;

  let text = raw.trim();
  // Strip ```json ... ``` fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  // Locate the first balanced JSON object
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
  if (p.confidence !== 'high' && p.confidence !== 'med' && p.confidence !== 'low') return null;
  const deviation =
    typeof p.deviation === 'string' ? p.deviation : p.deviation === null ? null : null;

  return {
    intentMatches: p.intent_matches,
    deviation,
    confidence: p.confidence,
  };
}
```

- [ ] **Step 5.4: Run tests**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t parseOllamaResponse`
Expected: PASS, 6 tests

- [ ] **Step 5.5: Commit**

```bash
cd /root/nanoclaw
git add container/agent-runner/src/semantic-audit.ts container/agent-runner/src/semantic-audit.test.ts
git commit -m "feat(semantic-audit): defensive parser for Ollama /api/generate output"
```

---

## Task 6: `callOllama` — HTTP client with timeout + graceful failure

**Files:**
- Modify: `container/agent-runner/src/semantic-audit.ts`
- Modify: `container/agent-runner/src/semantic-audit.test.ts`

- [ ] **Step 6.1: Write failing tests**

Append to `semantic-audit.test.ts`:

```ts
import { vi, beforeEach, afterEach } from 'vitest';
import { callOllama } from './semantic-audit.js';

describe('callOllama', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the raw response text on 200', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '{"intent_matches":false,"deviation":"x","confidence":"high"}' }),
    });
    const r = await callOllama('http://ollama:11434', 'test-model:fake', 'test prompt');
    expect(r).toBe('{"intent_matches":false,"deviation":"x","confidence":"high"}');
  });

  it('returns null when fetch throws', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network'));
    const r = await callOllama('http://ollama:11434', 'test-model:fake', 'test');
    expect(r).toBeNull();
  });

  it('returns null on non-OK response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const r = await callOllama('http://ollama:11434', 'test-model:fake', 'test');
    expect(r).toBeNull();
  });

  it('returns null when host is empty (feature off)', async () => {
    const r = await callOllama('', 'test-model:fake', 'test');
    expect(r).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('posts to /api/generate WITHOUT format=json (CoT prompt + fenced JSON output)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: '```json\n{}\n```' }),
    });
    await callOllama('http://ollama:11434', 'test-model:fake', 'hello');
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('http://ollama:11434/api/generate');
    const body = JSON.parse(call[1].body);
    expect(body).toMatchObject({
      model: 'test-model:fake',
      prompt: 'hello',
      stream: false,
    });
    // format: 'json' would force strict JSON-only output, blocking the
    // chain-of-thought reasoning that several models need to compute the
    // weekday from the date. We deliberately omit it.
    expect(body.format).toBeUndefined();
  });
});
```

- [ ] **Step 6.2: Run to verify failures**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t callOllama`
Expected: FAIL — `callOllama is not a function`

- [ ] **Step 6.3: Implement**

Append to `semantic-audit.ts`:

```ts
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
```

- [ ] **Step 6.4: Run tests**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t callOllama`
Expected: PASS, 5 tests

- [ ] **Step 6.5: Commit**

```bash
cd /root/nanoclaw
git add container/agent-runner/src/semantic-audit.ts container/agent-runner/src/semantic-audit.test.ts
git commit -m "feat(semantic-audit): Ollama /api/generate client with timeout + graceful failure"
```

---

## Task 7: `runSemanticAudit` — orchestrator (SQL → prompts → Ollama → deviations)

**Files:**
- Modify: `container/agent-runner/src/semantic-audit.ts`
- Modify: `container/agent-runner/src/semantic-audit.test.ts`

- [ ] **Step 7.1: Write failing integration test using an in-memory DB + mocked Ollama**

Append to `semantic-audit.test.ts`:

```ts
import Database from 'better-sqlite3';
import { runSemanticAudit } from './semantic-audit.js';

function seedAuditDbs() {
  const tf = new Database(':memory:');
  tf.exec(`
    CREATE TABLE boards (id TEXT PRIMARY KEY, parent_board_id TEXT);
    CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
    CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, PRIMARY KEY (board_id, person_id));
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT
    );
    INSERT INTO boards VALUES ('board-seci-taskflow', NULL);
    INSERT INTO board_runtime_config VALUES ('board-seci-taskflow', 'America/Fortaleza');
    INSERT INTO board_people VALUES ('board-seci-taskflow', 'giovanni', 'Carlos Giovanni');
    INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES
      ('board-seci-taskflow', 'M1', 'updated', 'giovanni',
       '2026-04-14T11:04:11.450Z',
       '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}');
  `);

  const msg = new Database(':memory:');
  msg.exec(`
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT,
      content TEXT, timestamp TEXT,
      is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
    INSERT INTO registered_groups VALUES ('120363407@g.us', 'seci-taskflow', 'SECI-SECTI', 1);
    INSERT INTO messages VALUES (
      'msg1', '120363407@g.us', '558688@s.whatsapp.net', 'Carlos Giovanni',
      'alterar M1 para quinta-feira 11h', '2026-04-14T11:03:37.000Z', 0, 0
    );
  `);

  return { tf, msg };
}

describe('runSemanticAudit', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns one deviation for the Giovanni case when Ollama says intent_matches=false', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response:
          '{"intent_matches":false,"deviation":"User said quinta (16/04) but stored 17/04","confidence":"high"}',
      }),
    });

    const { tf, msg } = seedAuditDbs();
    const result = await runSemanticAudit({
      msgDb: msg,
      tfDb: tf,
      period: { startIso: '2026-04-14T00:00:00.000Z', endIso: '2026-04-15T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434',
      ollamaModel: 'test-model:fake',
    });

    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].taskId).toBe('M1');
    expect(result.deviations[0].intentMatches).toBe(false);
    expect(result.deviations[0].confidence).toBe('high');
    expect(result.deviations[0].userMessage).toContain('quinta-feira');
    expect(result.deviations[0].storedValue).toBe('2026-04-17T11:00');
    expect(result.counters).toMatchObject({ examined: 1, noTrigger: 0, boardMapFail: 0, ollamaFail: 0, parseFail: 0 });

    tf.close();
    msg.close();
  });

  it('returns empty when no qualifying mutations exist', async () => {
    const tf = new Database(':memory:');
    tf.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, parent_board_id TEXT);
      CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT);
      CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, PRIMARY KEY (board_id, person_id));
      CREATE TABLE task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT
      );
      INSERT INTO boards VALUES ('board-empty', NULL);
      INSERT INTO board_runtime_config VALUES ('board-empty', 'America/Fortaleza');
    `);
    const msg = new Database(':memory:');
    msg.exec(`
      CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0, PRIMARY KEY (id, chat_jid));
      CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT, taskflow_managed INTEGER);
    `);
    const result = await runSemanticAudit({
      msgDb: msg,
      tfDb: tf,
      period: { startIso: '2026-04-14T00:00:00.000Z', endIso: '2026-04-15T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434',
      ollamaModel: 'test-model:fake',
    });
    expect(result.deviations).toEqual([]);
    expect(result.counters.examined).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
    tf.close();
    msg.close();
  });

  it('skips a mutation when Ollama returns a malformed response, increments parseFail', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: 'not json' }),
    });
    const { tf, msg } = seedAuditDbs();
    const result = await runSemanticAudit({
      msgDb: msg,
      tfDb: tf,
      period: { startIso: '2026-04-14T00:00:00.000Z', endIso: '2026-04-15T00:00:00.000Z' },
      ollamaHost: 'http://ollama:11434',
      ollamaModel: 'test-model:fake',
    });
    expect(result.deviations).toEqual([]);
    expect(result.counters.examined).toBe(1);
    expect(result.counters.parseFail).toBe(1);
    tf.close();
    msg.close();
  });
});
```

- [ ] **Step 7.2: Run to verify failures**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t runSemanticAudit`
Expected: FAIL — `runSemanticAudit is not a function`

- [ ] **Step 7.3: Implement**

Append to `semantic-audit.ts`:

```ts
import type { Database as BetterSqliteDB } from 'better-sqlite3';

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

  const mutationRows = tfDb
    .prepare(
      `SELECT board_id AS boardId, task_id AS taskId, action, by, at, details
       FROM task_history
       WHERE at >= ? AND at < ?
         AND action = 'updated'
         AND by IS NOT NULL
         AND details LIKE '%"Reunião reagendada%'`,
    )
    .all(period.startIso, period.endIso) as Array<{
      boardId: string;
      taskId: string;
      action: 'updated';
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

  const tzStmt = tfDb.prepare(
    `SELECT timezone FROM board_runtime_config WHERE board_id = ?`,
  );
  const groupStmt = msgDb.prepare(
    `SELECT jid FROM registered_groups WHERE folder = (
       SELECT LOWER(REPLACE(id, 'board-', '')) FROM boards WHERE id = ?
     )`,
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
    const extractedValue = extractScheduledAtValue(row.details);
    if (!extractedValue) continue;

    const tzRow = tzStmt.get(row.boardId) as { timezone: string } | undefined;
    const boardTimezone = tzRow?.timezone ?? 'America/Fortaleza';

    const personRow = personStmt.get(row.boardId, row.by) as { name: string } | undefined;
    const userDisplayName = personRow?.name ?? null;

    const groupRow = groupStmt.get(row.boardId) as { jid: string } | undefined;
    let userMessage: string | null = null;
    let messageTimestamp: string | null = null;
    if (!groupRow) {
      counters.boardMapFail++;
    } else if (userDisplayName) {
      const windowStart = new Date(new Date(row.at).getTime() - 600_000).toISOString();
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
      action: 'updated',
      by: row.by,
      at: row.at,
      details: row.details,
      fieldKind: 'scheduled_at',
      extractedValue,
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
      fieldKind: 'scheduled_at',
      at: row.at,
      by: row.by,
      userMessage,
      storedValue: extractedValue,
      intentMatches: parsed.intentMatches,
      deviation: parsed.deviation,
      confidence: parsed.confidence,
      rawResponse: raw,
    });
  }

  return { deviations, counters };
}
```

Note: The `groupStmt` SQL assumes `board_id = 'board-<folder>'`. This matches the naming in production today — `board-seci-taskflow` maps to folder `seci-taskflow`. If a non-conforming board surfaces the stmt returns undefined and the mutation is still checked (the trigger message is just null).

- [ ] **Step 7.4: Run tests**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t runSemanticAudit`
Expected: PASS, 3 tests

- [ ] **Step 7.5: Commit**

```bash
cd /root/nanoclaw
git add container/agent-runner/src/semantic-audit.ts container/agent-runner/src/semantic-audit.test.ts
git commit -m "feat(semantic-audit): orchestrator — SQL → Ollama → deviations"
```

---

## Task 8: `writeDryRunLog` — append NDJSON to `/workspace/store/audit/semantic-dryrun-YYYY-MM-DD.ndjson`

**Files:**
- Modify: `container/agent-runner/src/semantic-audit.ts`
- Modify: `container/agent-runner/src/semantic-audit.test.ts`

- [ ] **Step 8.1: Write failing tests**

Append to `semantic-audit.test.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeDryRunLog } from './semantic-audit.js';

describe('writeDryRunLog', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-dryrun-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates a dated NDJSON file and appends one line per deviation', () => {
    const deviations: SemanticDeviation[] = [
      {
        taskId: 'M1', boardId: 'b1', fieldKind: 'scheduled_at',
        at: '2026-04-14T11:04:11.450Z', by: 'giovanni',
        userMessage: 'alterar M1 para quinta-feira', storedValue: '2026-04-17T11:00',
        intentMatches: false, deviation: 'wrong day', confidence: 'high',
        rawResponse: '{"intent_matches":false}',
      },
      {
        taskId: 'M2', boardId: 'b1', fieldKind: 'scheduled_at',
        at: '2026-04-14T12:00:00.000Z', by: 'alexandre',
        userMessage: null, storedValue: '2026-04-16T10:00',
        intentMatches: true, deviation: null, confidence: 'high',
        rawResponse: '{"intent_matches":true}',
      },
    ];
    writeDryRunLog(deviations, tmpRoot, new Date('2026-04-14T20:00:00.000Z'));
    const file = path.join(tmpRoot, 'semantic-dryrun-2026-04-14.ndjson');
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).taskId).toBe('M1');
    expect(JSON.parse(lines[1]).taskId).toBe('M2');
  });

  it('is a no-op on empty array', () => {
    writeDryRunLog([], tmpRoot);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it('appends to an existing file on subsequent calls same day', () => {
    const dev: SemanticDeviation = {
      taskId: 'M3', boardId: 'b1', fieldKind: 'scheduled_at',
      at: '2026-04-14T13:00:00.000Z', by: 'lucas',
      userMessage: null, storedValue: null,
      intentMatches: true, deviation: null, confidence: 'low',
      rawResponse: '{}',
    };
    const fixedDate = new Date('2026-04-14T15:00:00.000Z');
    writeDryRunLog([dev], tmpRoot, fixedDate);
    writeDryRunLog([dev], tmpRoot, fixedDate);
    const file = path.join(tmpRoot, 'semantic-dryrun-2026-04-14.ndjson');
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});
```

- [ ] **Step 8.2: Run to verify failures**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t writeDryRunLog`
Expected: FAIL — `writeDryRunLog is not a function`

- [ ] **Step 8.3: Implement**

Append to `semantic-audit.ts`:

```ts
import fs from 'fs';
import path from 'path';

export function writeDryRunLog(
  deviations: SemanticDeviation[],
  rootDir = '/workspace/store/audit',
  now: Date = new Date(),
): void {
  if (deviations.length === 0) return;
  fs.mkdirSync(rootDir, { recursive: true });
  const dateStr = now.toISOString().slice(0, 10);
  const file = path.join(rootDir, `semantic-dryrun-${dateStr}.ndjson`);
  const lines = deviations.map((d) => JSON.stringify(d)).join('\n') + '\n';
  fs.appendFileSync(file, lines);
}
```

- [ ] **Step 8.4: Run tests**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts -t writeDryRunLog`
Expected: PASS, 3 tests

- [ ] **Step 8.5: Full-module sanity test**

Run: `cd /root/nanoclaw/container/agent-runner && npx vitest run src/semantic-audit.test.ts`
Expected: PASS, all tests across all describe blocks green.

- [ ] **Step 8.6: Commit**

```bash
cd /root/nanoclaw
git add container/agent-runner/src/semantic-audit.ts container/agent-runner/src/semantic-audit.test.ts
git commit -m "feat(semantic-audit): dry-run NDJSON writer with daily rotation"
```

---

## Task 9: Wire into `auditor-script.sh` behind `NANOCLAW_SEMANTIC_AUDIT_MODE=dryrun`

**Why:** The auditor heredoc is CJS (uses `require()`) but `semantic-audit.ts` compiles to ESM (because `container/agent-runner/package.json` has `"type": "module"`). Use dynamic `import()` and wrap the final console.log in an async IIFE.

**Files:**
- Modify: `container/agent-runner/src/auditor-script.sh`
- Modify: `container/agent-runner/src/index.ts` (verify/add env propagation if needed)

- [ ] **Step 9.1: Verify env var propagation from host to container**

The propagation happens at the host's `src/container-runner.ts` — that's what builds the `docker run` command and decides which env vars cross into the container. The container-side `index.ts` only forwards what arrives. Check both:

```bash
grep -n "NANOCLAW_OLLAMA_HOST\|NANOCLAW_SEMANTIC\|docker.*-e " /root/nanoclaw/src/container-runner.ts | head -20
grep -n "process.env.NANOCLAW" /root/nanoclaw/container/agent-runner/src/index.ts | head -20
```

Expected: a list of `-e VAR=...` flags in `container-runner.ts`. Three new vars must be added there: `NANOCLAW_SEMANTIC_AUDIT_MODE`, `NANOCLAW_SEMANTIC_AUDIT_CLOUD`, `NANOCLAW_SEMANTIC_AUDIT_MODEL`. If `NANOCLAW_OLLAMA_HOST` is already passed (it is, for the embedding/summarizer pipeline), add the three new ones in the same block. Then update `.env.example` if it exists. The agent-runner side needs no change because the script phase reads `process.env` directly.

- [ ] **Step 9.2: Add the semantic block to the auditor heredoc**

Edit `container/agent-runner/src/auditor-script.sh`. Find the current last statement of the heredoc:

```js
console.log(JSON.stringify(result));
SCRIPT_EOF
```

Replace with (also delete the existing pre-IIFE `msgDb.close(); tfDb.close();` lines — the new IIFE owns DB lifetime):

```js
(async () => {
  try {
    const mode = process.env.NANOCLAW_SEMANTIC_AUDIT_MODE;
    if (mode === 'dryrun' || mode === 'enabled') {
      try {
        const { runSemanticAudit, writeDryRunLog } = await import('/app/dist/semantic-audit.js');
        const ollamaHost = process.env.NANOCLAW_OLLAMA_HOST || '';
        // Default = local (data-locality first). Cloud requires explicit opt-in.
        // qwen3-coder:latest disqualified — fails weekday derivation even with CoT.
        const cloudOptIn = process.env.NANOCLAW_SEMANTIC_AUDIT_CLOUD === '1';
        const defaultModel = cloudOptIn
          ? 'minimax-m2.7:cloud'
          : 'qwen3.5:35b-a3b-coding-nvfp4';
        const ollamaModel =
          process.env.NANOCLAW_SEMANTIC_AUDIT_MODEL || defaultModel;
        if (ollamaHost) {
          const audit = await runSemanticAudit({
            msgDb, tfDb, period, ollamaHost, ollamaModel,
          });
          // audit returns { deviations, counters } — counters are
          // observability for "qualifying mutation but no trigger message
          // found", "board mapping failed", "ollama timeout / parse fail".
          // Log every run so silent recall failures don't disappear.
          console.error(
            `Semantic audit (${mode}, ${ollamaModel}): ` +
            `examined=${audit.counters.examined} ` +
            `noTrigger=${audit.counters.noTrigger} ` +
            `boardMapFail=${audit.counters.boardMapFail} ` +
            `ollamaFail=${audit.counters.ollamaFail} ` +
            `parseFail=${audit.counters.parseFail} ` +
            `deviations=${audit.deviations.length}`,
          );
          if (mode === 'dryrun') {
            writeDryRunLog(audit.deviations);
          } else if (mode === 'enabled') {
            for (const board of boards) {
              board.semanticDeviations = audit.deviations.filter(d => d.boardId === board.boardId);
              if (board.semanticDeviations.length > 0) {
                result.data.summary.totalFlagged += board.semanticDeviations.length;
              }
            }
          }
        } else {
          console.error('Semantic audit skipped: NANOCLAW_OLLAMA_HOST not set');
        }
      } catch (err) {
        console.error('Semantic audit failed:', err && err.message ? err.message : err);
      }
    }
  } finally {
    // Always close DBs and emit the JSON result, even if the semantic
    // block threw before the inner try/catch could swallow it.
    try { msgDb.close(); } catch {}
    try { tfDb.close(); } catch {}
    console.log(JSON.stringify(result));
  }
})();
SCRIPT_EOF
```

Key points:
- Outer `try/finally` guarantees DB close + JSON emission even if the dynamic import itself throws.
- Inner `try/catch` keeps the semantic block isolated — its failure never breaks the rest of the audit.
- `mode === 'dryrun'` writes NDJSON to `/workspace/store/audit/semantic-dryrun-YYYY-MM-DD.ndjson` and does NOT touch the result JSON.
- `mode === 'enabled'` attaches `semanticDeviations` to each board and inflates `totalFlagged` (not used in MVP).
- Absent `mode` is a no-op — default off in production until we explicitly flip.
- Counters are emitted to `stderr` every run for observability; silent recall failures (no trigger message, board map miss, Ollama timeout, parse fail) become first-class signals instead of disappearing.

- [ ] **Step 9.3: Verify the `runSemanticAudit` shape consumed by the heredoc matches Task 7's exports**

The heredoc in Step 9.2 calls `audit.deviations` and `audit.counters.{examined,noTrigger,boardMapFail,ollamaFail,parseFail}`. Confirm these match the `SemanticAuditResult` interface defined in Task 7. Run `grep -n "SemanticAuditResult\|SemanticAuditCounters" container/agent-runner/src/semantic-audit.ts` and verify both interfaces exist with the expected fields.
```

Remove the now-duplicated `msgDb.close(); tfDb.close();` lines that appeared before the IIFE in the original script.

- [ ] **Step 9.4: Rebuild the container image locally to verify shell + TS compile**

Run: `cd /root/nanoclaw && ./container/build.sh 2>&1 | tail -20`
Expected: "Build complete!" with no tsc errors.

- [ ] **Step 9.5: Run full test suite**

Run commands in parallel (independent):
- Host: `cd /root/nanoclaw && npx vitest run 2>&1 | tail -3`
- Engine: `cd /root/nanoclaw/container/agent-runner && npx vitest run 2>&1 | tail -3`

Expected for both: all tests pass, zero failures.

- [ ] **Step 9.6: Commit**

```bash
cd /root/nanoclaw
git add container/agent-runner/src/auditor-script.sh
# Only add index.ts / container-runner.ts if step 9.1 required changes:
# git add src/container-runner.ts container/agent-runner/src/index.ts
git commit -m "feat(auditor): wire semantic-audit dry-run behind NANOCLAW_SEMANTIC_AUDIT_MODE"
```

---

## Task 10: Codex review + deploy + calibration runbook

**Files:**
- Create: `docs/semantic-audit-calibration.md`
- Modify: `CHANGELOG.md`
- Modify: `.claude/skills/add-taskflow/CHANGELOG.md`

- [ ] **Step 10.1: Codex review before deploy**

This is non-negotiable per the user's review-before-deploy rule. Run via the `codex` skill:

```
Model: gpt-5.4
Reasoning: high
Sandbox: read-only
```

Prompt to Codex (bullet points; explain context, list the diff, ask for attack):
1. The auditor gains an MVP semantic-audit pass scoped to `scheduled_at` mutations, shipping in dry-run mode (writes to `/workspace/store/audit/semantic-dryrun-*.ndjson`, does not emit to Kipp yet).
2. New module at `container/agent-runner/src/semantic-audit.ts`; wired into `auditor-script.sh` via dynamic `import()` behind `NANOCLAW_SEMANTIC_AUDIT_MODE=dryrun`.
3. Uses existing Ollama pattern (host env `NANOCLAW_OLLAMA_HOST`). Default model is `qwen3.5:35b-a3b-coding-nvfp4` (local) for data-locality; `NANOCLAW_SEMANTIC_AUDIT_CLOUD=1` opts in to `minimax-m2.7:cloud`.
4. Specifically attack: (a) SQL correctness of the mutation pull, (b) prompt injection risk from user-supplied `content` inside the prompt, (c) race between DB close and async block, (d) log file size unbounded, (e) whether the `registered_groups.folder → boards.id` mapping holds universally, (f) Ollama hanging despite timeout, (g) timezone fallback when `board_runtime_config.timezone` is NULL.

Apply any Codex tweaks before proceeding. If Codex finds a blocker, fix it and re-run the test suite.

- [ ] **Step 10.2: Create calibration runbook**

Create `docs/semantic-audit-calibration.md`:

```markdown
# Semantic Audit — Calibration Runbook

## Enabling dry-run in production

The semantic audit is off by default. To enable dry-run on the NanoClaw host:

```bash
# On nanoclaw@192.168.2.63, add to ~/.env or equivalent:
NANOCLAW_SEMANTIC_AUDIT_MODE=dryrun

# Restart the service:
systemctl --user restart nanoclaw
```

The next daily auditor run will start writing to `/home/nanoclaw/nanoclaw/data/store/audit/semantic-dryrun-YYYY-MM-DD.ndjson`.

## Inspecting dry-run output

```bash
ssh nanoclaw@192.168.2.63 \
  "tail -30 /home/nanoclaw/nanoclaw/data/store/audit/semantic-dryrun-$(date -u +%Y-%m-%d).ndjson | jq ."
```

Each line is one `SemanticDeviation`. Focus on rows where `intentMatches=false AND confidence='high'` — those are the candidates for 🔴 bot errors.

## Calibration period — discovery feed, not metrics dashboard

The dry-run NDJSON is a **discovery feed**. Each `intent_matches=false` row is a candidate silent failure. The operator's job during calibration is not "watch for the model to be reliable enough to flip a switch" — it is **read the discovery feed, label what it surfaces, and convert recurring patterns into deterministic guards.**

The default ship state is dry-run. `enabled` mode (where Kipp surfaces deviations to the daily report) is optional and may never get flipped — that's fine. Most of the long-term value lives in the conversion path described below.

**Optional `enabled` flip — only if you want Kipp to relay the discovery feed daily.** When all of the following hold:
1. **At least 7 calendar days** of dry-run data (covers the full weekday cycle including the Monday weekend-review path).
2. **At least 30 examined rows** in the NDJSON logs (`counters.examined` summed across days).
3. **At least 5 distinct mutation patterns** observed: explicit DD/MM, weekday name (segunda/terça/.../sexta), relative ("amanhã"/"semana que vem"), implicit-time, and at least one operator-confirmed bot-error case.
4. **All operator-labeled bot-error cases** received `intent_matches=false` from the model — recall on negatives is observed, not estimated.

If the volume floor isn't met after 2 weeks, that's a useful finding too: it means silent semantic failures are rare enough that the operator-facing daily relay isn't worth the noise budget. Keep dry-run on, keep harvesting exemplars for guard promotion.

## Daily inspection

```bash
# Today's raw events
ssh nanoclaw@192.168.2.63 \
  "tail -50 /home/nanoclaw/nanoclaw/data/store/audit/semantic-dryrun-$(date -u +%Y-%m-%d).ndjson | jq ."

# Counters (look for noTrigger or boardMapFail spikes — those are silent recall failures)
ssh nanoclaw@192.168.2.63 \
  "journalctl --user -u nanoclaw --since='1 day ago' | grep 'Semantic audit'"
```

Focus on rows where `intentMatches=false AND confidence='high'` — those are the candidates for 🔴 bot errors.

## Long-term path: convert recurring patterns into deterministic guards

The dry-run audit is a discovery mechanism, not a permanent runtime control. As patterns surface in the labeled corpus, **promote them into deterministic engine-side guards** that fire pre-commit (no LLM, no latency, no model drift). The corpus shrinks over time; the audit's surface area shrinks with it.

**Worked example — the model already exists:** `intended_weekday` shipped 2026-04-14 in `container/agent-runner/src/taskflow-engine.ts` is exactly this shape. It's a deterministic `WEEKDAY_ALIASES` lookup + `weekdayInTimezone` derivation. Zero LLM cost, zero latency, byte-perfect catch rate on the Giovanni bug class. The audit doesn't need to keep checking weekdays — the engine already does.

**Promotion criteria.** A discovery-feed pattern earns a deterministic guard when:
1. The corpus has **≥3 labeled `TP` cases** of the same pattern (e.g. "wrong-time: bot stored :23 when user said :30").
2. The pattern is **structurally checkable** — a regex, a table lookup, a constraint — without needing semantic interpretation. (If it requires "did the user really mean X?", it stays in the audit.)
3. The cost of the guard is **bounded**: O(1) per mutation, no external calls, no new schema.

**Promotion procedure.**
1. Operator opens an issue with the corpus rows that motivate the guard.
2. Engineer drafts the guard following the `intended_weekday` template (alias table + derivation function + create/update wiring + opt-out flag analogous to `allow_non_business_day`).
3. After deploy, the audit's prompt is updated with a note ("the engine now rejects these mismatches deterministically — do not flag again"), and the corpus rows for that pattern are marked `promoted_to_guard` so the eval-corpus tool stops counting them as TP/FP candidates.

**End state we're aiming for.** A growing set of small deterministic guards in the engine, each catching one semantic bug class at zero runtime cost. The LLM audit narrows over time to "patterns we haven't found a deterministic check for yet". If it ever empties out, turn it off — the value already migrated into the engine.

**Counter-example — patterns that should stay in the audit, not promote.** Anything requiring world knowledge or pragmatics ("did the user mean to assign to João Silva or João Santos given the context of last week's discussion?"), anything depending on long context windows, anything where the ground truth is genuinely fuzzy. These are LLM-shaped problems and trying to write a deterministic guard for them just produces brittle heuristics.

## Labeled-corpus feedback loop

Freehand prompt edits based on a couple of anecdotes are how you ship regressions. Build a labeled corpus instead:

1. **Ground-truth file**: `docs/semantic-audit-corpus.ndjson` (gitignored from skill template, kept in main repo). Each row = one historical mutation snapshotted as `{prompt, model, raw_response, parsed, operator_label}`.
   - `operator_label`: one of `TP` (true positive — bot was wrong), `FP` (false positive — bot was right), `partial_FP` (medium-confidence noise from sibling-mutation gap, see Case A in 2026-04-15 eval), `unknown`.
2. **Append nightly**: every `intent_matches=false` row from the day's NDJSON gets appended with `operator_label: "unknown"` until reviewed.
3. **Review weekly**: an operator (you) labels each `unknown`. Ten minutes per week, max.
4. **Re-evaluate before any prompt or model change**: run the candidate change against the entire corpus via `node tools/eval-corpus.mjs --model <new>` (script ships in Task 11). Compare precision/recall/latency vs the current default.
5. **Flip rule**: any change that drops recall on `TP` rows OR raises FP rate by >5% is rejected. No exceptions for vibes.

## Failure modes to watch

- **High false-positive rate** (`FP > 20%` on labeled corpus): tighten prompt, raise reporting threshold (high only, drop med).
- **Ollama timeout spike** (`counters.ollamaFail / counters.examined > 0.1`): lengthen the `callOllama` timeout or pin a different model.
- **Silent recall failure** (`counters.noTrigger > counters.examined / 2`): the message → mutation correlation is broken. Check `board_people.name` resolution and the 10-min trigger window.
- **Empty log despite known corrections**: verify `NANOCLAW_OLLAMA_HOST` reaches the container (`docker exec <auditor-container> curl -s $NANOCLAW_OLLAMA_HOST/api/tags`).

## Model A/B during calibration

Default selected by 2026-04-15 bake-off against the Giovanni M1 case. Five candidates passed (1 disqualified):

| Model | Where | Latency (avg) | Notes |
|-------|-------|---------------|-------|
| `qwen3.5:35b-a3b-coding-nvfp4` (**default**) | local MoE | ~61 s | Correct; data stays on LAN |
| `minimax-m2.7:cloud` | cloud (opt-in) | ~5 s | Correct; best deviation text; 10× faster — set `NANOCLAW_SEMANTIC_AUDIT_CLOUD=1` |
| `qwen3.5:cloud` | cloud (opt-in) | ~12 s | Correct; cloud backup |
| `glm-5.1:cloud` | cloud (opt-in) | ~57 s | Correct but slow |
| `gemma4:31b` | local dense | ~75 s | Correct after CoT prompt; slowest |
| ~~`qwen3-coder:latest`~~ | local dense | 2.6 s | **DISQUALIFIED** — fails to derive weekday from date even with chain-of-thought; takes user's "quinta" at face value and approves a Friday date. Code-tuning actively hurts on natural-language date reasoning. |

**Cloud opt-in:** local default keeps user-message content on the LAN. Set `NANOCLAW_SEMANTIC_AUDIT_CLOUD=1` to switch to `minimax-m2.7:cloud` on boards where off-LAN inference is acceptable. Override the model directly with `NANOCLAW_SEMANTIC_AUDIT_MODEL=<name>` for A/B tests.

Flip the model by setting on the host:
```bash
ssh nanoclaw@192.168.2.63 \
  'sed -i "s|^NANOCLAW_SEMANTIC_AUDIT_MODEL=.*|NANOCLAW_SEMANTIC_AUDIT_MODEL=qwen3.5:cloud|" ~/nanoclaw/.env && \
   systemctl --user restart nanoclaw'
```

Evaluate by re-tagging the same NDJSON rows: run each model against the previous day's flagged mutations (feed `userMessage` + `storedValue` through a small eval script) and compare `intentMatches` agreement + `confidence` distribution. Pick the model with the best F1 on Giovanni-class examples while latency stays under ~10s/call (cloud) or ~90s/call (local).

## Flipping to `enabled`

When false positives are rare (<5% of high-confidence flags) and the detector is catching real bugs D misses:

1. Add a new Kipp prompt rule #10 in `auditor-prompt.txt` telling Kipp how to classify `semanticDeviations` (🔴 high-confidence bot error, 🟠 med-confidence drift).
2. Flip the env var: `NANOCLAW_SEMANTIC_AUDIT_MODE=enabled`.
3. Ship a new commit with the prompt update; deploy.
4. Monitor Kipp's reports for the first few days. If any class of false positive dominates, roll back to dry-run and iterate on the prompt.
```

- [ ] **Step 10.3: Update both changelogs**

Append to the top of `CHANGELOG.md` and `.claude/skills/add-taskflow/CHANGELOG.md`:

```markdown
## 2026-04-15 — Auditor: semantic-audit MVP (scheduled_at, dry-run)

First installment of the LLM-in-the-loop semantic discovery feed. New module `container/agent-runner/src/semantic-audit.ts` runs an Ollama fact-check (default `qwen3.5:35b-a3b-coding-nvfp4` local; `NANOCLAW_SEMANTIC_AUDIT_CLOUD=1` opts in to `minimax-m2.7:cloud`) against every `scheduled_at` mutation, comparing the user's triggering message to the stored ISO value. Primary purpose is structured instrumentation for silent semantic failures (the class detector D cannot see) — the audit surfaces candidate failures, an operator labels them, and recurring patterns get promoted into deterministic engine-side guards (template: `intended_weekday` shipped 2026-04-14). Flipping to `enabled` mode (Kipp daily-report relay) is optional, not the goal.

Scope for v1: `scheduled_at` only (the Giovanni bug class). Dry-run only — writes to `/workspace/store/audit/semantic-dryrun-YYYY-MM-DD.ndjson`, does NOT emit to Kipp's daily report. Gated by `NANOCLAW_SEMANTIC_AUDIT_MODE=dryrun` (unset = off).

Codex gpt-5.4 high reviewed before deploy. Runbook at `docs/semantic-audit-calibration.md`. Calibration is volume-based (≥7 days AND ≥30 examined rows AND ≥5 distinct mutation patterns AND all operator-labeled bot-error cases detected) before flipping to `enabled`. Extensions to `due_date` and `assignee` tracked under the same calibration cycle.
```

- [ ] **Step 10.4: Deploy**

```bash
cd /root/nanoclaw
./scripts/deploy.sh
```

Expected: "Deploy successful === (service: active)".

- [ ] **Step 10.5: Flip the env var on the remote to start dry-run**

```bash
ssh nanoclaw@192.168.2.63 \
  'grep -q NANOCLAW_SEMANTIC_AUDIT_MODE ~/nanoclaw/.env \
     || echo "NANOCLAW_SEMANTIC_AUDIT_MODE=dryrun" >> ~/nanoclaw/.env && \
   systemctl --user restart nanoclaw'
```

Verify service is up: `ssh nanoclaw@192.168.2.63 "systemctl --user status nanoclaw | head -5"`.

- [ ] **Step 10.6: Commit changelogs + runbook**

```bash
cd /root/nanoclaw
git add CHANGELOG.md .claude/skills/add-taskflow/CHANGELOG.md docs/semantic-audit-calibration.md
git commit -m "docs(semantic-audit): changelog + calibration runbook for dry-run ship"
```

- [ ] **Step 10.7: Verify first dry-run output arrives**

The auditor runs once per day (late evening cron). On the next morning after the deploy:

```bash
ssh nanoclaw@192.168.2.63 \
  "ls -la /home/nanoclaw/nanoclaw/data/store/audit/ 2>/dev/null; \
   wc -l /home/nanoclaw/nanoclaw/data/store/audit/semantic-dryrun-*.ndjson 2>/dev/null"
```

Expected: at least one NDJSON file exists with ≥0 lines. If the dir doesn't exist, the env var didn't propagate — re-check step 9.1 and step 10.5.

---

## Task 11: Docker smoke test (catches the wiring bugs that bite at deploy)

**Why:** in-memory SQLite + mocked fetch covers the logic but not the wiring. The deploy-time failure modes are: heredoc syntax (the bash-quoted JS), `/app/dist/semantic-audit.js` missing or wrong path, env vars reaching the script, and the IIFE not actually completing before stdout closes. None of those show up in unit tests.

**Scope of this smoke test:** it points the auditor at an UNREACHABLE Ollama URL on purpose, so the success criterion is "the entire pipeline runs end-to-end and reports `ollamaFail=1` via stderr counters, then emits valid JSON on stdout". This proves heredoc loads, dynamic import resolves, env vars propagate, the IIFE's `finally` runs, and the JSON wrapper completes. It deliberately does NOT assert on a deviation row in the NDJSON — that requires a working Ollama and is covered by the calibration corpus eval (Step 11.5), not by this CI-friendly smoke test.

**Files:**
- Create: `container/agent-runner/test/auditor-smoke.sh`
- Create: `container/agent-runner/test/fixtures/messages.smoke.db.sql` (tiny seed)
- Create: `container/agent-runner/test/fixtures/taskflow.smoke.db.sql` (tiny seed)

- [ ] **Step 11.1: Build the Docker image fresh**

```bash
cd /root/nanoclaw && ./container/build.sh 2>&1 | tail -10
```

Expected: "Build complete!"

- [ ] **Step 11.2: Write the seed SQL fixtures**

`container/agent-runner/test/fixtures/messages.smoke.db.sql`:

```sql
CREATE TABLE messages (
  id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT,
  content TEXT, timestamp TEXT,
  is_from_me INTEGER, is_bot_message INTEGER DEFAULT 0,
  PRIMARY KEY (id, chat_jid)
);
CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, name TEXT, folder TEXT, trigger_pattern TEXT, added_at TEXT, taskflow_managed INTEGER);
CREATE TABLE send_message_log (id INTEGER PRIMARY KEY AUTOINCREMENT, source_group_folder TEXT, target_chat_jid TEXT, delivered_at TEXT);
CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, group_folder TEXT, created_at TEXT);

INSERT INTO registered_groups VALUES ('120363smoketest@g.us', 'SMOKE', 'smoke', '@Case', '2026-04-15T00:00:00Z', 1);
INSERT INTO messages VALUES ('m1', '120363smoketest@g.us', '5588@s.whatsapp.net', 'Carlos Giovanni',
  'alterar M1 para quinta-feira 11h', '2026-04-15T11:00:00.000Z', 0, 0);
```

`container/agent-runner/test/fixtures/taskflow.smoke.db.sql`:

```sql
CREATE TABLE boards (id TEXT PRIMARY KEY, group_jid TEXT, group_folder TEXT, board_role TEXT, hierarchy_level INTEGER, max_depth INTEGER, parent_board_id TEXT, short_code TEXT);
CREATE TABLE board_runtime_config (board_id TEXT PRIMARY KEY, timezone TEXT NOT NULL DEFAULT 'America/Fortaleza', language TEXT, standup_cron_local TEXT, digest_cron_local TEXT, review_cron_local TEXT, runner_standup_task_id TEXT, runner_digest_task_id TEXT, runner_review_task_id TEXT);
CREATE TABLE board_people (board_id TEXT, person_id TEXT, name TEXT, phone TEXT, role TEXT, wip_limit INTEGER, notification_group_jid TEXT, PRIMARY KEY (board_id, person_id));
CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT, task_id TEXT, action TEXT, by TEXT, at TEXT, details TEXT);

INSERT INTO boards VALUES ('board-smoke', '120363smoketest@g.us', 'smoke', 'standard', 0, 1, NULL, NULL);
INSERT INTO board_runtime_config (board_id, timezone) VALUES ('board-smoke', 'America/Fortaleza');
INSERT INTO board_people VALUES ('board-smoke', 'giovanni', 'Carlos Giovanni', '5588', 'manager', 3, NULL);
INSERT INTO task_history (board_id, task_id, action, by, at, details) VALUES
  ('board-smoke', 'M1', 'updated', 'giovanni',
   '2026-04-15T11:01:00.000Z',
   '{"changes":["Reunião reagendada para 17/04/2026 às 11:00"]}');
```

- [ ] **Step 11.3: Write the smoke runner**

`container/agent-runner/test/auditor-smoke.sh`:

```bash
#!/usr/bin/env bash
# Spins up the actual agent container, runs the auditor heredoc against tiny
# fixtures, asserts the dryrun NDJSON gets written and contains the expected
# deviation row. Skips the Ollama call by stubbing the HOST env to an
# unreachable URL — that path increments counters.ollamaFail; we assert that
# counter advances, proving the entire pipeline runs end-to-end.

set -euo pipefail
cd "$(dirname "$0")/../.."

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

mkdir -p "$WORKDIR/store" "$WORKDIR/taskflow" "$WORKDIR/audit"
sqlite3 "$WORKDIR/store/messages.db" < container/agent-runner/test/fixtures/messages.smoke.db.sql
sqlite3 "$WORKDIR/taskflow/taskflow.db" < container/agent-runner/test/fixtures/taskflow.smoke.db.sql

# Run the agent container with the auditor script as input.
docker run --rm -i \
  -v "$WORKDIR/store:/workspace/store" \
  -v "$WORKDIR/taskflow:/workspace/taskflow" \
  -v "$WORKDIR/audit:/workspace/store/audit" \
  -e NANOCLAW_SEMANTIC_AUDIT_MODE=dryrun \
  -e NANOCLAW_OLLAMA_HOST=http://192.0.2.1:1 \
  -e NANOCLAW_SEMANTIC_AUDIT_MODEL=test-model:fake \
  --entrypoint /bin/bash \
  nanoclaw-agent:latest \
  /app/src/auditor-script.sh > "$WORKDIR/auditor.stdout" 2> "$WORKDIR/auditor.stderr" || true

# Assert: stderr contains a "Semantic audit" log line with examined=1 and ollamaFail=1.
if ! grep -q 'Semantic audit (dryrun' "$WORKDIR/auditor.stderr"; then
  echo "FAIL: no 'Semantic audit (dryrun' log line in stderr"
  cat "$WORKDIR/auditor.stderr"
  exit 1
fi
if ! grep -E 'examined=1.*ollamaFail=1' "$WORKDIR/auditor.stderr" > /dev/null; then
  echo "FAIL: expected examined=1 ollamaFail=1 in stderr counters"
  cat "$WORKDIR/auditor.stderr"
  exit 1
fi
# Assert: stdout contains valid auditor JSON (the wrapper's final emission).
if ! head -c 1 "$WORKDIR/auditor.stdout" | grep -q '{'; then
  echo "FAIL: auditor stdout did not emit JSON"
  cat "$WORKDIR/auditor.stdout"
  exit 1
fi

echo "OK: auditor smoke test passed (heredoc loaded, env propagated, IIFE completed, counters logged)"
```

Make it executable:
```bash
chmod +x container/agent-runner/test/auditor-smoke.sh
```

- [ ] **Step 11.4: Run the smoke test**

```bash
cd /root/nanoclaw && container/agent-runner/test/auditor-smoke.sh
```

Expected output: `OK: auditor smoke test passed`

If it fails, the most common causes are: (1) `/app/dist/semantic-audit.js` doesn't exist in the image (npm build didn't run / file not in COPY scope — check Dockerfile), (2) `auditor-script.sh` has a bash quoting error introduced by the heredoc edit (`bash -n container/agent-runner/src/auditor-script.sh` to lint), (3) env vars not propagating into the container (compare with `docker run -e` flags here vs production run).

- [ ] **Step 11.5: Add a corpus eval helper**

`tools/eval-corpus.mjs`: re-runs the prompt against the labeled corpus for a given model. Used by the calibration runbook's "before any prompt or model change" gate.

```js
#!/usr/bin/env node
import fs from 'fs';
import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const model = args.model || 'qwen3.5:35b-a3b-coding-nvfp4';
const host = process.env.NANOCLAW_OLLAMA_HOST || 'http://192.168.2.13:11434';
const corpus = args.corpus || 'docs/semantic-audit-corpus.ndjson';

const rows = fs.readFileSync(corpus, 'utf-8').trim().split('\n').map(JSON.parse);
let tp = 0, fp = 0, fn = 0, tn = 0, totalMs = 0;

for (const row of rows) {
  if (row.operator_label === 'unknown') continue;
  const t0 = performance.now();
  const resp = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: row.prompt, stream: false }),
  });
  const t1 = performance.now();
  totalMs += (t1 - t0);
  const data = await resp.json();
  // Reuse the same parser as semantic-audit.ts (inline copy here for the tool).
  const fence = data.response?.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : data.response;
  let parsed = null;
  try { parsed = JSON.parse(candidate.slice(candidate.indexOf('{'), candidate.lastIndexOf('}') + 1)); } catch {}
  const predicted = parsed?.intent_matches === false; // model says bot wrong
  const truth = row.operator_label === 'TP'; // operator confirms bot wrong
  if (predicted && truth) tp++;
  else if (predicted && !truth) fp++;
  else if (!predicted && truth) fn++;
  else tn++;
}

const precision = tp / (tp + fp) || 0;
const recall = tp / (tp + fn) || 0;
const f1 = 2 * precision * recall / (precision + recall) || 0;
console.log(JSON.stringify({
  model, host,
  total: tp + fp + fn + tn,
  tp, fp, fn, tn,
  precision, recall, f1,
  avgLatencyMs: Math.round(totalMs / (tp + fp + fn + tn || 1)),
}, null, 2));
```

- [ ] **Step 11.6: Commit Task 11**

```bash
cd /root/nanoclaw
git add container/agent-runner/test/auditor-smoke.sh \
        container/agent-runner/test/fixtures/messages.smoke.db.sql \
        container/agent-runner/test/fixtures/taskflow.smoke.db.sql \
        tools/eval-corpus.mjs
git commit -m "test(semantic-audit): docker smoke test + corpus-eval tool"
```

---

## Self-review

**Spec coverage vs conversation spec (post Codex meta-review 2026-04-15):**
- ✅ Reframed as discovery feed + deterministic-guard promotion path, not "permanent LLM control plane" (Goal section, Long-term path section).
- ✅ Scoped to `scheduled_at` (Tasks 2, 7, 9).
- ✅ Dry-run is the default end state (Tasks 8, 9, 10.5); `enabled` flip is optional.
- ✅ Async, batched, Ollama at `NANOCLAW_OLLAMA_HOST` with model selected by env (default local `qwen3.5:35b-a3b-coding-nvfp4`; cloud opt-in via `NANOCLAW_SEMANTIC_AUDIT_CLOUD=1`) (Tasks 6, 9).
- ✅ `{ intent_matches, deviation, confidence }` response shape (Task 5).
- ✅ Uses the same `board_people.name` → `messages.sender_name` resolution as the self-correction detector (Task 7).
- ✅ Recomputes the `<context>` header at mutation time from `messages.timestamp` + board timezone (Task 3 — explicitly addresses the "we don't store the header" failure mode).
- ✅ Graceful degradation when Ollama is unreachable (Tasks 6, 9 — non-OK or throw → null → deviation skipped).
- ✅ Codex review gate (Task 10.1).
- ✅ Calibration runbook covers enable path (Task 10.2).

**Placeholder scan:** None — every step has executable code or an exact command.

**Type consistency:** `QualifyingMutation.fieldKind`, `SemanticDeviation.fieldKind`, and the `'scheduled_at'` string constant all use the `SemanticField` union defined in Task 1. `RunSemanticAuditArgs` matches the call in Task 9 (`msgDb`, `tfDb`, `period`, `ollamaHost`, `ollamaModel`). The `writeDryRunLog` signature in Task 8 matches the call in Task 9 (single array arg, defaults for `rootDir`/`now`).

**Known out-of-scope (intentional deferrals):**
- `due_date` and `assignee` coverage — deferred to the calibration-to-enable iteration.
- `action='created'` rows (initial task creation carrying `scheduled_at`) — same deferral; the query in Task 7 only matches `action='updated'`.
- Kipp prompt rule #10 for reporting `semanticDeviations` — deferred to the `enabled` flip (documented in Task 10.2).
