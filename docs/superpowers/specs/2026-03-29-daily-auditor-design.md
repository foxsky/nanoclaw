# Daily Interaction Auditor — Design Spec (v2)

## Purpose

Automated daily review of all TaskFlow board interactions. Detects unfulfilled requests, silent failures, agent refusals, template gaps, missing features, and UX friction. Sends a report to the main group at 04:00 daily.

## Architecture

**Single scheduled_task** on the main group with a `script` field. The script runs inside the container, gathers data from both databases, then the agent analyzes and reports.

### Why scheduled_task (not systemd timer)

- The main group container mounts `/workspace/project` read-only, which includes `store/messages.db`
- The container also mounts `/workspace/taskflow` read-only, which includes `taskflow.db`
- The `script` field runs inside the container before the agent wakes
- If `wakeAgent: true`, the agent receives the script's JSON data
- No new systemd units, no file ownership issues, no extra infrastructure

### Flow

1. **Task scheduler** fires at 04:00 BRT (07:00 UTC)
2. **Container spawns** for the main group
3. **Script phase** (bash, runs first):
   - Opens both SQLite databases via `sqlite3` CLI
   - Queries non-bot messages for the review period
   - Queries `task_history` for the same period
   - Queries bot responses for timing analysis
   - Detects refusal patterns in bot responses
   - Outputs JSON to stdout: `{ wakeAgent: true, data: { ... } }`
4. **Agent phase** (Claude):
   - Receives structured audit data in the prompt
   - Analyzes each flagged interaction
   - Checks engine capabilities for agent refusals
   - Identifies patterns across boards
   - Classifies findings (data fix / template fix / code fix / missing feature / UX)
   - Sends report to the main group via normal output (no IPC needed — it IS the main group agent)

### Review Period

- Monday: reviews Friday 00:00 → Sunday 23:59 (3 days)
- Other days: reviews previous day 00:00 → 23:59
- Uses `data/auditor-last-run.txt` as state file (written by the script at the end)

## Script Output Format

```json
{
  "wakeAgent": true,
  "data": {
    "period": { "start": "2026-03-28T03:00:00Z", "end": "2026-03-29T03:00:00Z" },
    "boards": [
      {
        "folder": "seci-taskflow",
        "name": "SECI-SECTI",
        "interactions": [
          {
            "timestamp": "2026-03-28T14:48:00Z",
            "sender": "Carlos Giovanni",
            "message": "quais as tarefas estão atrasadas?",
            "responseTimeMs": -1,
            "botResponse": null,
            "isWrite": true,
            "writeKeywords": ["tarefas"],
            "taskHistoryMatch": [],
            "refusal": null
          }
        ]
      }
    ],
    "summary": {
      "totalMessages": 23,
      "writeRequests": 12,
      "noResponse": 1,
      "delayedResponse": 2,
      "refusals": 0,
      "potentialFailures": 1
    }
  }
}
```

## Write Request Classification

Keywords (case-insensitive, with accent variants):

**Action keywords:** concluir, concluída, concluido, finalizar, finalizado, criar, adicionar, atribuir, aprovar, aprovada, descartar, cancelar, mover, adiar, renomear, alterar, remover

**Status keywords:** em andamento, para aguardando, para revisão, processar inbox, para inbox

**Update keywords:** nota, anotar, lembrar, lembrete, prazo, próximo passo, próxima ação, descrição

**Terse patterns:** `T\d+\s+(concluíd|feita|pronta|ok)`, `P\d+\.\d+\s+(concluíd|feita)`, `Done!`, `✅`

**Voice messages:** Check content inside `[Voice: ...]` brackets.

## Refusal Pattern Detection

Patterns from actual bot responses in the database:

```
não consigo|não posso|não tenho como|não pode ser|
bloqueado por limite|apenas o canal principal|
não está cadastrad|o runtime atual|
não oferece suporte|limite do sistema|
recuso essa instrução|deste quadro.*não consigo
```

## Agent Prompt

The scheduled task's `prompt` field contains the review methodology:

```
You are the Daily Interaction Auditor. You review TaskFlow board interactions
and report issues to the administrator.

You will receive structured audit data from the script phase. For each
board's interactions, analyze:

1. UNFULFILLED REQUESTS — write request with no task_history match within
   10 minutes. Check: was the task created/updated/moved as the user intended?

2. SILENT FAILURES — no bot response at all within 10 minutes.

3. DELAYED RESPONSES — bot responded but >5min after the request.

4. AGENT REFUSALS — bot said it couldn't do something. For each refusal,
   check if the engine actually supports the operation. Use sqlite to query
   the TaskFlow schema and verify capabilities. If the engine supports it,
   classify as "template gap."

5. INTENT MISMATCHES — bot did something different from what the user asked.
   Compare the user's message with the task_history action and the resulting
   DB state.

6. UX FRICTION — user had to repeat themselves, unrecognized commands,
   confusing error messages, multiple attempts to complete one action.

7. CROSS-BOARD PATTERNS — same issue affecting 2+ boards = systemic problem.

For each finding, classify as:
- 🔴 Data fix (DB update needed)
- 🟠 Template fix (agent prompt gap)
- 🟡 Code fix (engine limitation)
- 🔵 Missing feature (engine genuinely can't do it)
- ⚪ UX suggestion (improvement opportunity)

IMPORTANT: Before claiming a feature is missing, verify at the engine level.
Check the TaskFlow DB schema, the task_history patterns, and the actual task
state. The agent's refusal is NOT the source of truth — the engine code is.

Output format: WhatsApp markdown, Portuguese, severity-sorted.
Always end with a summary line: total requests | OK | issues found.
```

## Report Format

```
🔍 *Revisão de Interações — 28/03*
━━━━━━━━━━━━━━

🔴 *Solicitação não atendida*
• SECI (Giovanni, 14:48): "quais tarefas atrasadas?"
  → Sem resposta (serviço em crash loop)

🟠 *Gap no template*
• CI-SECI (Mauro, 11:49): "adicionar 7 subtarefas em P2"
  → Agente recusou: "não consigo alterar tarefas do quadro superior"
  → Engine suporta: SIM (tarefas delegadas são operáveis)

🟡 *Resposta atrasada (6h)*
• TEC (Alexandre, 14:53): "anotar em T61 que base pronta"
  → Nota adicionada às 21:05

⚪ *Sugestão de UX*
• CI-SECI (Mauro): "consolidado" não reconhecido (6 tentativas)
  → Mapear para "quadro"

━━━━━━━━━━━━━━
📊 *Resumo: 23 solicitações | 20 OK | 3 atenção*
```

## Configuration

```env
AUDITOR_RESPONSE_THRESHOLD=300000  # 5 minutes in ms
```

The main group JID is already known from the registered_groups table. No separate DM JID config needed.

## Implementation

### Files

| File | Purpose |
|------|---------|
| `container/agent-runner/src/auditor-script.sh` | Bash script for the `script` field — runs inside container, queries both DBs |
| `src/auditor-prompt.ts` | Generates the prompt with review methodology |

### Scheduled Task

One row in `scheduled_tasks`:
```sql
INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, status)
VALUES (
  'auditor-daily',
  'main',
  '<main_group_jid>',
  '<review methodology prompt>',
  '<bash script that queries DBs and outputs JSON>',
  'cron',
  '0 7 * * *',  -- 04:00 BRT = 07:00 UTC
  'active'
);
```

### Script reads both DBs from container mounts

- Messages: `/workspace/project/store/messages.db` (read-only)
- TaskFlow: `/workspace/taskflow/taskflow.db` (read-only)
- State: `/workspace/project/data/auditor-last-run.txt`

Note: `sqlite3` CLI must be available inside the container. If not, the script uses `node -e "require('better-sqlite3')(...)"` inline.

## Cost

- **Daily volume:** ~23 messages/day avg (current), up to ~75 on busy days
- **Script JSON:** ~5-10KB per day (~2-3K tokens)
- **Agent prompt:** ~1.5K tokens
- **Agent output:** ~500 tokens (clean day), ~2K tokens (issues found)
- **Total:** ~4-6K tokens/day = ~$0.02-0.05/day, ~$1/month

## Non-goals

- Real-time monitoring (daily batch only)
- Automatic fixes (report only)
- Message content moderation
