---
name: add-embeddings
description: Generic embedding service via Ollama. Indexes, searches, and deduplicates text in named collections.
---

# Add Embeddings

This skill adds a generic embedding service to NanoClaw powered by BGE-M3 via Ollama. It provides semantic search, duplicate detection, and context retrieval organized into named collections.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/embedding-service.ts` exists. If it does, skip to Phase 3 (Configure).

### Check Ollama is reachable

```bash
curl -s http://$OLLAMA_HOST/api/tags | head -5
```

If Ollama is not reachable, ask the user for the correct `OLLAMA_HOST` URL.

### Verify embedding model is loaded

```bash
curl -s http://$OLLAMA_HOST/api/tags | grep -i bge-m3
```

If the model is not loaded, instruct:
```bash
ollama pull bge-m3
```

## Phase 2: Apply Code Changes

The code changes are already merged into main. Verify the following files exist:

**New files (add-embeddings owned):**
- `src/embedding-service.ts` — generic embedding service (host, read-write)
- `src/embedding-service.test.ts` — tests
- `container/agent-runner/src/embedding-reader.ts` — read-only query client (container)
- `container/agent-runner/src/embedding-reader.test.ts` — baseline tests

**Modified files (add-embeddings owned):**
- `src/container-runner.ts` — ContainerInput fields, embeddings mount, env vars, queryVector hook
- `container/agent-runner/src/runtime-config.ts` — ContainerInput fields, MCP env vars

### Build and deploy

```bash
npm run build
./container/build.sh
```

## Phase 3: Configure

### Add environment variables

Add to `.env`:
```bash
OLLAMA_HOST=http://192.168.2.13:11434
EMBEDDING_MODEL=bge-m3
```

### Start embedding service

The embedding service starts automatically in `src/index.ts` when `OLLAMA_HOST` is configured. Restart the service:

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

### Check service starts

```bash
tail -20 logs/nanoclaw.log | grep -i embed
```

Expected: `Embedding service started` log entry.

### Check embeddings.db is created

```bash
ls -la data/embeddings/
```

Expected: `embeddings.db` file exists.

### Run tests

```bash
npx vitest run src/embedding-service.test.ts
cd container/agent-runner && npx vitest run src/embedding-reader.test.ts
```

## Troubleshooting

### "Ollama unreachable" in logs

1. Verify Ollama is running: `curl http://$OLLAMA_HOST/api/tags`
2. Check `.env` has correct `OLLAMA_HOST`
3. Check container can reach Ollama: `docker run --rm curlimages/curl curl -s http://$OLLAMA_HOST/api/tags`

### Embeddings not being indexed

1. Check indexer is running: `grep "indexer" logs/nanoclaw.log`
2. Verify model is loaded: `curl http://$OLLAMA_HOST/api/tags | grep bge-m3`
3. Check `EMBEDDING_MODEL` in `.env` matches the loaded model name

### Container can't read embeddings.db

1. Verify mount exists: check logs for mount list on container start
2. Verify file exists: `ls data/embeddings/embeddings.db`
3. The host must create the file first — wait for first indexer cycle
