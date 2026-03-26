---
name: add-long-term-context
description: Hierarchical long-term context for NanoClaw agents — DAG summarization, FTS5 search, incremental turn capture
---

# Long-Term Context

Gives every NanoClaw agent access to compressed, searchable conversation history via hierarchical DAG summarization. Recent interactions are preserved in full detail; older ones are progressively compressed into daily, weekly, and monthly summaries.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/context-service.ts` exists. If it does, skip to Phase 3 (Configure).

### Check Ollama is reachable

```bash
curl -s http://$OLLAMA_HOST/api/tags | head -5
```

If Ollama is not reachable, ask the user for the correct `OLLAMA_HOST` URL.

## Phase 2: Apply Code Changes

Merge the skill branch:

```bash
git merge skill/long-term-context
npm run build
./container/build.sh
```

Code lives directly in the source tree on the `skill/long-term-context` branch — no separate file copies needed.

## Phase 3: Configure

### Add environment variables

Add to `.env`:
```bash
# Long-Term Context
CONTEXT_SUMMARIZER=ollama
CONTEXT_SUMMARIZER_MODEL=llama3.1
CONTEXT_RETAIN_DAYS=90
```

Uses existing `OLLAMA_HOST` and `ANTHROPIC_API_KEY` from `.env` — no new connection settings needed.

### Start the service

The context service starts automatically in `src/index.ts`. Restart the service:

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

### Check service starts

```bash
tail -20 logs/nanoclaw.log | grep -i context
```

Expected: `Long-term context service started` log entry.

### Check context.db is created

```bash
ls -la data/context/
```

Expected: `context.db` file exists.

### Run tests

```bash
npx vitest run src/context-service.test.ts
npx vitest run src/context-sync.test.ts
cd container/agent-runner && npx vitest run src/context-reader.test.ts
```

## Architecture

```
Agent container exits
  -> Host calls captureAgentTurn(groupFolder, sessionId)
  -> Reads JSONL transcript from stored cursor
  -> Extracts new turns, creates leaf nodes (summary=NULL)
  -> Background compaction (60s):
     1. Summarize pending leaves via Ollama/Claude
     2. Roll up completed days -> daily nodes
     3. Roll up completed weeks -> weekly nodes
     4. Roll up completed months -> monthly nodes
     5. Apply retention (soft-delete old leaves/dailies)

Agent container starts
  -> context.db mounted read-only at /workspace/context/
  -> ContextReader assembles recap preamble (3 most recent summaries)
  -> MCP tools registered for context_search, context_recall
  -> Progressive unlock at >50 nodes: context_timeline, context_topics
```

## Troubleshooting

### "Context recap skipped" in container logs

1. Verify `data/context/context.db` exists on host
2. Check the context service started: `grep "context" logs/nanoclaw.log`
3. The DB is created on first host startup — if no agent has run yet, no summaries exist

### Summaries not being generated

1. Verify Ollama is reachable: `curl http://$OLLAMA_HOST/api/generate -d '{"model":"llama3.1","prompt":"hi","stream":false}'`
2. Check `CONTEXT_SUMMARIZER_MODEL` matches a loaded Ollama model
3. Check context sync logs: `grep "context sync" logs/nanoclaw.log`

### MCP tools not available in agent

1. Verify `context-reader.ts` is in `CORE_AGENT_RUNNER_FILES`
2. Rebuild container: `./container/build.sh`
3. Check container logs for context reader errors
