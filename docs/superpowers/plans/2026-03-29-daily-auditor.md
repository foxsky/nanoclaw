# Daily Interaction Auditor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scheduled task that runs daily at 04:00 BRT, reviews all board interactions from the previous day, and sends a report to the main group with findings about unfulfilled requests, delays, agent refusals, and improvement opportunities.

**Architecture:** A `scheduled_task` row on the main group (`whatsapp_main`) with a bash `script` field that runs inside the container. The script uses `node` (from `/app`) with `better-sqlite3` (from `/app/node_modules`) to query both `store/messages.db` (at `/workspace/project/store/messages.db`) and `data/taskflow/taskflow.db` (at `/workspace/taskflow/taskflow.db`). If issues are found, it outputs `{ wakeAgent: true, data: {...} }` and the agent generates a report. If clean, `{ wakeAgent: false }` — no AI cost.

**Tech Stack:** Bash script → Node.js inline with better-sqlite3, scheduled via `scheduled_tasks` cron

---

### Task 1: Create the auditor data-gathering script

**Files:**
- Create: `container/agent-runner/src/auditor-script.sh`

- [ ] **Step 1: Write the script**

Create `container/agent-runner/src/auditor-script.sh`. This bash script runs inside the container during the script phase. It uses node to query both databases and outputs JSON to stdout.

```bash
#!/usr/bin/env bash
# Daily Interaction Auditor — data gathering script
# Runs inside the main group container during scheduled task script phase.
# Queries messages DB + TaskFlow DB, outputs JSON for the agent.
set -euo pipefail

cd /app

node -e '
const Database = require("better-sqlite3");

// --- Config ---
const MESSAGES_DB = "/workspace/project/store/messages.db";
const TASKFLOW_DB = "/workspace/taskflow/taskflow.db";
const STATE_FILE = "/workspace/group/auditor-last-run.txt";
const RESPONSE_THRESHOLD_MS = 300000; // 5 minutes

// --- Determine review period ---
const now = new Date();
const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon
let startDate;
if (dayOfWeek === 1) {
  // Monday: review Fri-Sun (3 days)
  startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 3);
} else if (dayOfWeek === 0) {
  // Sunday: review Saturday
  startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 1);
} else {
  // Other days: review yesterday
  startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 1);
}
startDate.setHours(0, 0, 0, 0);
const endDate = new Date(now);
endDate.setHours(0, 0, 0, 0);

const periodStart = startDate.toISOString();
const periodEnd = endDate.toISOString();

// --- Write keywords (case-insensitive match) ---
const WRITE_KEYWORDS = [
  "concluir", "concluída", "concluido", "concluída", "finalizar", "finalizado",
  "criar", "adicionar", "atribuir", "aprovar", "aprovada", "aprovado",
  "descartar", "cancelar", "mover", "adiar", "renomear", "alterar", "remover",
  "em andamento", "para aguardando", "para revisão", "processar inbox", "para inbox",
  "nota", "anotar", "lembrar", "lembrete", "prazo", "próximo passo", "próxima ação",
  "descrição", "começando", "comecando", "aguardando", "retomada", "devolver",
  "done", "feita", "feito", "pronta", "ok", "inbox"
];

const TERSE_PATTERN = /^(T|P|M|R|SEC-)\S+\s*(conclu|feita|feito|pronta|ok|aprovad|✅)/i;

const REFUSAL_PATTERNS = [
  "não consigo", "não posso", "não tenho como", "não pode ser",
  "bloqueado por limite", "apenas o canal principal",
  "não está cadastrad", "o runtime atual",
  "não oferece suporte", "limite do sistema",
  "deste quadro.*não consigo"
];
const REFUSAL_RE = new RegExp(REFUSAL_PATTERNS.join("|"), "i");

// --- Open databases ---
const msgDb = new Database(MESSAGES_DB, { readonly: true, fileMustExist: true });
const tfDb = new Database(TASKFLOW_DB, { readonly: true, fileMustExist: true });

// --- Get registered groups (TaskFlow-managed only) ---
const groups = msgDb.prepare(
  "SELECT jid, name, folder FROM registered_groups WHERE taskflow_managed = 1"
).all();

const results = { period: { start: periodStart, end: periodEnd }, boards: [], summary: {} };
let totalMessages = 0, writeRequests = 0, noResponse = 0, delayedResponse = 0, refusals = 0, potentialFailures = 0;

for (const group of groups) {
  // Get user messages in the period
  const userMessages = msgDb.prepare(
    "SELECT timestamp, sender_name, content FROM messages WHERE chat_jid = ? AND is_bot_message = 0 AND timestamp BETWEEN ? AND ? ORDER BY timestamp"
  ).all(group.jid, periodStart, periodEnd);

  if (userMessages.length === 0) continue;

  const interactions = [];

  for (const msg of userMessages) {
    const content = msg.content || "";
    if (!content.trim()) continue;

    // Find bot response within 10 minutes
    const msgTime = new Date(msg.timestamp).getTime();
    const windowEnd = new Date(msgTime + 600000).toISOString();
    const botResponse = msgDb.prepare(
      "SELECT timestamp, content FROM messages WHERE chat_jid = ? AND is_bot_message = 1 AND timestamp BETWEEN ? AND ? ORDER BY timestamp LIMIT 1"
    ).get(group.jid, msg.timestamp, windowEnd);

    const responseTimeMs = botResponse
      ? new Date(botResponse.timestamp).getTime() - msgTime
      : -1;

    // Classify as write request
    const lowerContent = content.toLowerCase();
    const matchedKeywords = WRITE_KEYWORDS.filter(kw => lowerContent.includes(kw));
    const isTerse = TERSE_PATTERN.test(content);
    const isWrite = matchedKeywords.length > 0 || isTerse;

    // Check for refusal in bot response
    const botText = botResponse ? (botResponse.content || "") : "";
    const refusalMatch = REFUSAL_RE.test(botText);

    // Check task_history for matching mutations
    let taskHistoryMatch = [];
    if (isWrite) {
      // Look for task_history entries from this board within 10 minutes
      const boardId = tfDb.prepare("SELECT id FROM boards WHERE group_folder = ?").get(group.folder);
      if (boardId) {
        taskHistoryMatch = tfDb.prepare(
          "SELECT task_id, action, at FROM task_history WHERE board_id = ? AND at BETWEEN ? AND ? ORDER BY at"
        ).all(boardId.id, msg.timestamp, windowEnd);
      }
    }

    // Track stats
    totalMessages++;
    if (isWrite) writeRequests++;
    if (responseTimeMs === -1) noResponse++;
    else if (responseTimeMs > RESPONSE_THRESHOLD_MS) delayedResponse++;
    if (refusalMatch) refusals++;
    if (isWrite && taskHistoryMatch.length === 0 && responseTimeMs !== -1) potentialFailures++;

    interactions.push({
      timestamp: msg.timestamp,
      sender: msg.sender_name,
      message: content.substring(0, 300),
      responseTimeMs,
      botResponse: botText.substring(0, 300),
      isWrite,
      writeKeywords: matchedKeywords,
      taskHistoryMatch: taskHistoryMatch.slice(0, 5),
      refusal: refusalMatch ? botText.substring(0, 200) : null
    });
  }

  if (interactions.length > 0) {
    results.boards.push({ folder: group.folder, name: group.name, interactions });
  }
}

results.summary = { totalMessages, writeRequests, noResponse, delayedResponse, refusals, potentialFailures };

msgDb.close();
tfDb.close();

// Decide whether to wake agent — only when issues found (zero AI cost on clean days)
const hasIssues = noResponse > 0 || delayedResponse > 0 || refusals > 0 || potentialFailures > 0;
const output = { wakeAgent: hasIssues, data: results };
console.log(JSON.stringify(output));
'
```

- [ ] **Step 2: Test the script locally**

Run on production to verify it works:
```bash
ssh nanoclaw@192.168.2.63 "docker run --rm --entrypoint bash \
  -v /home/nanoclaw/nanoclaw:/workspace/project:ro \
  -v /home/nanoclaw/nanoclaw/data/taskflow:/workspace/taskflow:ro \
  -v /home/nanoclaw/nanoclaw/groups/main:/workspace/group \
  nanoclaw-agent:latest \
  -c 'cd /app && bash /workspace/project/container/agent-runner/src/auditor-script.sh'"
```

Expected: JSON output with `wakeAgent`, `data.boards`, `data.summary`

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/auditor-script.sh
git commit -m "feat: add daily auditor data-gathering script"
```

---

### Task 2: Create the scheduled task

**Files:**
- None created — this is a database INSERT on production

- [ ] **Step 1: Write the auditor prompt**

The prompt for the AI agent phase. Save as a reference file:

Create `container/agent-runner/src/auditor-prompt.txt`:

```
You are the Daily Interaction Auditor for NanoClaw TaskFlow.

You received structured audit data from the script phase. Review each board's interactions and report issues.

## Review Categories

For each flagged interaction, classify as:
- 🔴 Solicitação não atendida — user asked, nothing happened
- 🟠 Gap no template — agent refused something the engine supports
- 🟡 Resposta atrasada — bot responded but >5min after request
- 🔵 Feature ausente — engine genuinely can't do what user needs
- ⚪ Sugestão de UX — friction, confusing errors, unrecognized commands

## Analysis Rules

1. For each write request with no task_history match: verify if the bot response indicates the action was taken (it might have been done without history, e.g., a query response).
2. For each agent refusal: check if the operation is supported. Delegated tasks (child_exec_enabled=1) ARE modifiable from child boards. Subtasks CAN have individual due_dates.
3. For responses >5min: note the delay but don't flag scheduled digests/standups as delays.
4. Look for cross-board patterns: same issue on 2+ boards = systemic.
5. NEVER claim a feature is missing without evidence. If unsure, classify as ⚪ suggestion.

## Output Format

WhatsApp markdown, Portuguese. Severity-sorted (🔴 first, ⚪ last).
Always end with: 📊 *Resumo: N solicitações | M OK | K atenção*
If zero issues: 📊 *Resumo: N solicitações, todas atendidas. Nenhum problema identificado.*
```

- [ ] **Step 2: Insert the scheduled task on production**

The `script` field is a tiny wrapper that calls the real script file (avoids fragile SQL escaping):

```bash
ssh nanoclaw@192.168.2.63 "sqlite3 /home/nanoclaw/nanoclaw/store/messages.db \"
INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, status, created_at)
VALUES (
  'auditor-daily',
  'main',
  '120363408855255405@g.us',
  '<prompt from auditor-prompt.txt>',
  '#!/usr/bin/env bash
set -euo pipefail
bash /workspace/project/container/agent-runner/src/auditor-script.sh',
  'cron',
  '0 4 * * *',
  'isolated',
  'active',
  datetime('now')
);
\""
```

Note: The `schedule_value` is `0 4 * * *` (04:00 local — cron is parsed in configured timezone `America/Fortaleza`). The `script` field is a tiny wrapper that calls the real script from `/workspace/project/`. The `prompt` field contains the analysis instructions.

- [ ] **Step 3: Verify the task was created**

```bash
ssh nanoclaw@192.168.2.63 "sqlite3 /home/nanoclaw/nanoclaw/store/messages.db \"SELECT id, group_folder, schedule_value, status FROM scheduled_tasks WHERE id='auditor-daily'\""
```

Expected: `auditor-daily|main|0 4 * * *|active`

- [ ] **Step 4: Commit reference files**

```bash
git add container/agent-runner/src/auditor-prompt.txt
git commit -m "docs: add auditor prompt reference"
```

---

### Task 3: Verify E2E on production

- [ ] **Step 1: Trigger a manual test run**

Force the scheduled task to run now by setting `next_run` to the past:

```bash
ssh nanoclaw@192.168.2.63 "sqlite3 /home/nanoclaw/nanoclaw/store/messages.db \"UPDATE scheduled_tasks SET next_run = datetime('now', '-1 minute') WHERE id = 'auditor-daily'\""
```

Wait 60 seconds (poll interval), then check:

```bash
ssh nanoclaw@192.168.2.63 "sqlite3 /home/nanoclaw/nanoclaw/store/messages.db \"SELECT last_run, substr(last_result, 1, 200) FROM scheduled_tasks WHERE id='auditor-daily'\""
```

- [ ] **Step 2: Verify the report was sent**

Check the main group for the auditor message:

```bash
ssh nanoclaw@192.168.2.63 "sqlite3 /home/nanoclaw/nanoclaw/store/messages.db \"SELECT timestamp, substr(content, 1, 300) FROM messages WHERE chat_jid='120363408855255405@g.us' AND is_bot_message=1 ORDER BY timestamp DESC LIMIT 1\""
```

Expected: A message containing "Revisão de Interações" or "Resumo" with the audit findings.

- [ ] **Step 3: Check container logs**

```bash
ssh nanoclaw@192.168.2.63 "ls -t /home/nanoclaw/nanoclaw/groups/main/logs/ | head -1 | xargs -I{} tail -30 /home/nanoclaw/nanoclaw/groups/main/logs/{}"
```

Look for: "Running task script...", "Script wakeAgent=true", and the agent's output.

- [ ] **Step 4: Commit and deploy**

```bash
git add container/agent-runner/src/auditor-script.sh container/agent-runner/src/auditor-prompt.txt
./scripts/deploy.sh
git push origin main
```
