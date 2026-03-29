# Daily Interaction Auditor — Design Spec

## Purpose

Automated daily review of all TaskFlow board interactions. Detects unfulfilled requests, silent failures, agent refusals, template gaps, missing features, and UX friction. Sends a report to the administrator's WhatsApp DM at 04:00 daily.

## Architecture

Two-phase pipeline running on the host:

### Phase 1: Data Gathering (Node.js script)

`src/auditor.ts` runs on the host with direct access to both databases:
- `store/messages.db` — all WhatsApp messages
- `data/taskflow/taskflow.db` — TaskFlow task states and history

**Inputs:**
- All non-bot messages from the review period (previous 24h, or Fri-Sun on Mondays)
- All bot responses within 10min of each user message
- All `task_history` entries from the review period
- All agent refusal patterns in bot responses

**Outputs:**
A structured JSON object:
```typescript
interface AuditData {
  period: { start: string; end: string };
  boards: Array<{
    folder: string;
    name: string;
    interactions: Array<{
      timestamp: string;
      sender: string;
      message: string;        // user's message
      responseTime: number;   // ms to first bot response, -1 if none
      botResponse: string;    // first bot response content (truncated)
      classification: 'write' | 'query' | 'unknown';
      writeKeywords: string[]; // matched keywords (concluir, criar, etc.)
      taskHistory: Array<{    // task_history entries within 10min window
        task_id: string;
        action: string;
        at: string;
      }>;
      refusalDetected: boolean; // bot response contains refusal patterns
      refusalText: string;      // the refusal snippet if detected
    }>;
  }>;
  summary: {
    totalRequests: number;
    writeRequests: number;
    noResponse: number;
    delayedResponse: number;   // >5min
    refusals: number;
    potentialFailures: number; // write request with no matching task_history
  };
}
```

### Phase 2: AI Analysis (container agent)

The script writes the JSON to the main group's IPC input directory, triggering a container agent with a review-focused prompt. The agent:

1. Receives the structured audit data as context
2. Reviews each flagged interaction:
   - **Unfulfilled requests:** Write request with no `task_history` match
   - **Silent failures:** No bot response at all
   - **Delayed responses:** >5min gap
   - **Agent refusals:** Uses MCP tools to check if the refused operation is actually supported
   - **Intent mismatches:** Bot responded but action doesn't match user's intent
3. Identifies cross-board patterns (same issue on multiple boards = systemic)
4. Classifies each finding: data fix / template fix / code fix / missing feature / UX issue
5. Generates a WhatsApp-formatted report in Portuguese
6. Sends to the administrator's DM via `send_message` with `target_chat_jid`

### Agent Prompt (embedded in the scheduled task)

The prompt includes:
- The review methodology from today's session
- The feedback memories (validate at source level, trace intent to outcome)
- Instructions to check engine capabilities before claiming something is missing
- The 10 review categories (unfulfilled, delayed, silent, refusals, intent mismatch, template gap, missing feature, UX friction, data inconsistency, cross-board pattern)
- Output format (WhatsApp markdown, Portuguese, severity-sorted)

## Scheduling

**systemd timer** (`nanoclaw-auditor.timer`):
- Fires at 04:00 BRT (07:00 UTC) daily
- Runs `node dist/auditor.js`

**Review period logic:**
- Monday: reviews Friday 00:00 → Sunday 23:59 (3 days)
- Other days: reviews previous day 00:00 → 23:59
- Tracks last run in `data/auditor-last-run.txt`

## Report Delivery

- **Target:** Administrator's WhatsApp DM (configured in `.env` as `AUDITOR_DM_JID`)
- **Format:** WhatsApp markdown (bold, bullet points, separators)
- **Delivery:** IPC message file to `data/ipc/whatsapp_main/messages/`
- **Always sends:** Brief summary even on clean days ("47 solicitações, todas atendidas")

## Report Format

```
🔍 *Revisão de Interações — 28/03*
━━━━━━━━━━━━━━

⚠️ *Problemas encontrados (3)*

🔴 *Solicitação não atendida*
• CI-SECI (Mauro, 11:49): "adicionar 7 subtarefas em P2"
  → Agente recusou: "não consigo alterar tarefas do quadro superior"
  → Engine suporta: SIM (delegated tasks são operáveis)
  → Classificação: template gap

🟡 *Resposta atrasada (6h)*
• TEC (Alexandre, 14:53): "anotar em T61 que base pronta"
  → Nota adicionada às 21:05

🔵 *Sugestão de UX*
• ASSE-SECI-2 (Ana Beatriz): tentou "concluir tarefa" 3x sem ID
  → Agente poderia inferir tarefa ativa única

━━━━━━━━━━━━━━
📊 *Resumo: 47 solicitações | 44 OK | 3 atenção*
```

## Review Categories

| Category | Severity | Detection method |
|----------|----------|-----------------|
| Unfulfilled request | 🔴 High | Write keywords + no task_history match |
| Silent failure | 🔴 High | No bot response within 10min |
| Agent refusal (engine supports) | 🔴 High | Refusal pattern + MCP verification |
| Delayed response (>5min) | 🟡 Medium | Timestamp comparison |
| Intent mismatch | 🟡 Medium | AI analysis of request vs outcome |
| Template gap | 🟡 Medium | Refusal pattern + engine capability check |
| Missing feature | 🟡 Medium | AI analysis — engine genuinely can't do it |
| UX friction | 🔵 Low | Repeated attempts, confusing errors |
| Data inconsistency | 🔵 Low | DB state vs expected outcome |
| Cross-board pattern | 🔵 Low | Same issue on 2+ boards |

## Configuration

```env
# .env
AUDITOR_DM_JID=558699916064@s.whatsapp.net  # Admin's WhatsApp JID
AUDITOR_RESPONSE_THRESHOLD=300000            # 5 minutes in ms
AUDITOR_REFUSAL_PATTERNS=não consigo|não é possível|limite do sistema|não suportado|não oferece suporte
```

## Files

| File | Purpose |
|------|---------|
| `src/auditor.ts` | Data gathering script (host-side) |
| `src/auditor-prompt.ts` | AI agent prompt template |
| `nanoclaw-auditor.service` | Systemd service unit |
| `nanoclaw-auditor.timer` | Systemd timer (04:00 daily) |
| `data/auditor-last-run.txt` | Last run timestamp |

## Cost

- **Clean day:** ~$0.10 (20K tokens input for data + prompt, 500 tokens output summary)
- **Day with issues:** ~$0.15-0.20 (same input, 2-3K tokens output for detailed report)
- **Monthly estimate:** ~$3-6

## Dependencies

- `better-sqlite3` (already installed)
- `fs`, `path` (Node.js built-in)
- WhatsApp IPC messaging (already working)
- Container agent with MCP tools (existing infrastructure)

## Non-goals

- Real-time monitoring (this is a daily batch review)
- Automatic fixes (report only — human decides what to fix)
- Message content moderation (only reviews task-management interactions)
