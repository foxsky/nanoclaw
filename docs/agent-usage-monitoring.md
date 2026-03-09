# Agent Usage & Model Monitoring

## Session Transcript Location

Each agent container run produces a session transcript in JSONL format:

```
data/sessions/{group-folder}/.claude/projects/-workspace-group/{session-id}.jsonl
```

Subagents (spawned by the main agent) write to:

```
data/sessions/{group-folder}/.claude/projects/-workspace-group/{session-id}/subagents/agent-{id}.jsonl
```

## JSONL Structure

Each line is a JSON object with top-level keys: `type`, `operation`, `timestamp`, `sessionId`, `content`.

Usage and model data are nested under `message`:

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-6",
    "usage": {
      "input_tokens": 41,
      "output_tokens": 4424,
      "cache_read_input_tokens": 433521,
      "cache_creation_input_tokens": 159290
    }
  }
}
```

## Querying Usage

### Quick check (single session)

```bash
grep '"usage"' data/sessions/sec-secti/.claude/projects/-workspace-group/*.jsonl | head -5
```

### Full usage report (all sessions)

```bash
node -e '
const fs = require("fs");
const path = require("path");

function parseSession(fp) {
  const lines = fs.readFileSync(fp, "utf-8").split("\n").filter(Boolean);
  let inp = 0, out = 0, cRead = 0, cWrite = 0, model = null;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const m = obj.message;
      if (m && m.model && model === null) model = m.model;
      if (m && m.usage) {
        inp += m.usage.input_tokens || 0;
        out += m.usage.output_tokens || 0;
        cRead += m.usage.cache_read_input_tokens || 0;
        cWrite += m.usage.cache_creation_input_tokens || 0;
      }
    } catch {}
  }
  return { inp, out, cRead, cWrite, model };
}

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else if (entry.name.endsWith(".jsonl")) results.push(full);
  }
  return results;
}

const sessionsDir = "data/sessions";
if (!fs.existsSync(sessionsDir)) { console.log("No sessions found."); process.exit(0); }

const files = walk(sessionsDir);
let gI = 0, gO = 0, gCR = 0, gCW = 0;

for (const fp of files) {
  const u = parseSession(fp);
  if (u.inp + u.out + u.cRead + u.cWrite === 0) continue;
  const rel = path.relative(sessionsDir, fp);
  console.log(rel + "  [" + (u.model || "unknown") + "]");
  console.log("  Input:       " + u.inp.toLocaleString());
  console.log("  Output:      " + u.out.toLocaleString());
  console.log("  Cache read:  " + u.cRead.toLocaleString());
  console.log("  Cache write: " + u.cWrite.toLocaleString());
  console.log("  Total:       " + (u.inp + u.out + u.cRead + u.cWrite).toLocaleString());
  console.log();
  gI += u.inp; gO += u.out; gCR += u.cRead; gCW += u.cWrite;
}

console.log("=== GRAND TOTAL ===");
console.log("  Input:       " + gI.toLocaleString());
console.log("  Output:      " + gO.toLocaleString());
console.log("  Cache read:  " + gCR.toLocaleString());
console.log("  Cache write: " + gCW.toLocaleString());
console.log("  Total:       " + (gI + gO + gCR + gCW).toLocaleString());
'
```

## Changing the Model

Each group's agent model is configured in its session settings file:

```
data/sessions/{group-folder}/.claude/settings.json
```

Add a top-level `"model"` key:

```json
{
  "model": "claude-sonnet-4-6",
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
  }
}
```

The change takes effect on the next agent invocation — no service restart needed.

## Notes

- The Agent SDK auto-selects the model if none is configured. Main sessions and subagents may use different models.
- Cache tokens dominate usage — the CLAUDE.md system prompt and tool definitions are cached across turns.
- `<synthetic>` as model name indicates the session failed before reaching the API (e.g., auth error).
- Sessions persist across service restarts when the agent resumes a conversation (`resumeAt: latest`).
