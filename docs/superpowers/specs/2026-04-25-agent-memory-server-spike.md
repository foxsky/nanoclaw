# `agent-memory-server` Spike — Adoption Evaluation

**Date:** 2026-04-25
**Status:** Spike spec — 1-day timebox
**Decision after:** GREEN (proceed with thin MCP wrapper, drop spec v2.4) or RED (defer per Codex; revisit post-v2)

## Why this spike exists

Spec v2.4 + plan v2.2 took 13 Codex review rounds finding ~50 issues, with a 35% probability of autonomous-execution success per internal reviewers. The user pushed back: **"why not just copy from the openclaw plugin?"**

Codex meta-review confirmed:
- Forking the OpenClaw TypeScript plugin doesn't save substantial time (MemoryAPIClient is inseparable from the server backend)
- BUT: I overstated full-stack adoption cost. `agent-memory-server` (the actual backend) is **same-day Docker compose dev setup**, supports **Ollama via LiteLLM** (not OpenAI-only as I claimed), and is Redis Labs maintained
- A 1-day spike should have been offered before committing to a 4-5 day from-scratch build

This spike answers: **can `agent-memory-server` be adopted as our memory backend with our existing infrastructure (Ollama, Docker, no OpenAI)?**

## Goal

Run `agent-memory-server` locally with our Ollama as the embedding backend, smoke-test the core flows (`memory_store` → `memory_recall`), and evaluate against four go/no-go criteria. Decide whether to drop spec v2.4 + plan v2.2 in favor of a thin MCP wrapper (~3-5 days total to ship) or defer entirely.

## Hard constraints

- **1-day timebox.** If by end of day setup isn't working, that's the answer (= RED, defer).
- **No production touching.** Local dev environment only. Don't deploy. Don't modify any committed nanoclaw files except possibly a `docker-compose.spike.yml` in `scripts/`.
- **No OpenAI key.** If anywhere in the spike we'd need an OpenAI key to proceed, that's a fail criterion.
- **Use existing Ollama.** `.13:11434` (`bge-m3` for embeddings, `qwen3-coder` available for any LLM-side work).

## Phase 1 — Setup (target: 2-3 hours)

### Step 1.1: Get the server image + verify it pulls

```bash
docker pull redislabs/agent-memory-server:0.14.0-standalone
docker images | grep agent-memory
```

Expected: image present, ~1-2 GB size.

If pull fails (rate-limited, image gone, etc.): document and stop. RED.

### Step 1.2: Bring up minimal stack with Ollama backend

Create `scripts/agent-memory-spike-compose.yml` (do NOT commit yet — local-only):

```yaml
version: '3.8'
services:
  agent-memory:
    image: redislabs/agent-memory-server:0.14.0-standalone
    ports:
      - "8000:8000"
    environment:
      # LiteLLM points embedding model at our Ollama instance
      - EMBEDDING_PROVIDER=ollama
      - EMBEDDING_MODEL=bge-m3
      - EMBEDDING_BASE_URL=http://192.168.2.13:11434
      # Generative model also via Ollama (for any extraction/summary)
      - GENERATIVE_PROVIDER=ollama
      - GENERATIVE_MODEL=qwen3-coder
      - GENERATIVE_BASE_URL=http://192.168.2.13:11434
      # No OpenAI — explicitly omit OPENAI_API_KEY
      - REDIS_URL=redis://redis:6379
      - LOG_LEVEL=DEBUG
    depends_on:
      - redis
    networks:
      - spike-net
  redis:
    image: redis:7-alpine
    networks:
      - spike-net
networks:
  spike-net:
    driver: bridge
```

Run:

```bash
docker compose -f scripts/agent-memory-spike-compose.yml up -d
sleep 10
docker logs $(docker ps --filter "ancestor=redislabs/agent-memory-server:0.14.0-standalone" -q) --tail 50
```

**Critical observations to record:**
1. Does the container come up without OpenAI errors?
2. Does it successfully reach Ollama at `192.168.2.13:11434` for embeddings?
3. Does it reject any required-config errors that hint at OpenAI dependency?

If the LiteLLM Ollama config doesn't work as documented:
- Check `agent-memory-server` GitHub issues for "ollama" or "litellm"
- Try alternate env var names (some projects use `LLM_PROVIDER` instead of `EMBEDDING_PROVIDER`)
- Hard timebox: 1 hour on this. If still broken, document and stop. **RED.**

### Step 1.3: Verify health endpoint

```bash
curl -s http://localhost:8000/v1/health | jq .
```

Expected: `{"status": "ok"}` or similar. Record actual response.

### Step 1.4: Verify backend dependencies are satisfied

```bash
# Check it can actually embed via Ollama
curl -s -X POST http://localhost:8000/v1/long-term-memory/ \
  -H "Content-Type: application/json" \
  -d '{
    "memories": [{
      "text": "Spike test fact",
      "namespace": "spike-test",
      "user_id": "test-user"
    }]
  }' | jq .
```

Expected: 200 with a memory ID. If it errors with "OpenAI key required" or similar, the LiteLLM Ollama config didn't take. **RED.**

## Phase 2 — Smoke tests (target: 2-3 hours)

### Test 2.1: Store + recall round-trip

```bash
NS="spike-board-a"
USER="user-maria"

# Store
curl -s -X POST http://localhost:8000/v1/long-term-memory/ \
  -H "Content-Type: application/json" \
  -d "{
    \"memories\": [{
      \"text\": \"Maria prefers concise replies, no emojis\",
      \"namespace\": \"$NS\",
      \"user_id\": \"$USER\",
      \"memory_type\": \"semantic\"
    }]
  }" | jq .

sleep 2  # let any background indexing settle

# Recall
curl -s -X POST http://localhost:8000/v1/long-term-memory/search \
  -H "Content-Type: application/json" \
  -d "{
    \"text\": \"how does Maria like to be addressed\",
    \"namespace\": \"$NS\",
    \"user_id\": \"$USER\",
    \"limit\": 5
  }" | jq .
```

**Pass criterion:** the recall returns the stored fact with score >0.5.

### Test 2.2: Cross-board isolation (security boundary)

```bash
# Store under board A
curl -s -X POST http://localhost:8000/v1/long-term-memory/ \
  -d '{"memories":[{"text":"Board A secret","namespace":"board-a"}]}' | jq .

# Try to recall from board B with the same query
curl -s -X POST http://localhost:8000/v1/long-term-memory/search \
  -d '{"text":"Board A secret","namespace":"board-b","limit":5}' | jq .
```

**Pass criterion:** board-b query returns ZERO matches for the board-a memory.

If memories leak across namespaces: **RED on security**. We can't deploy this without a separate per-board access layer.

### Test 2.3: Docker container reachability

The real test: can a container running our agent-runner image reach the server?

```bash
docker run --rm --network host curlimages/curl \
  curl -s http://localhost:8000/v1/health
```

If this fails with `--network host`:

```bash
# Try via host gateway (Docker Desktop convention)
docker run --rm curlimages/curl \
  curl -s http://host.docker.internal:8000/v1/health
```

**Pass criterion:** at least ONE of these returns the health response. Record which one works (we'll use that pattern in the MCP wrapper).

### Test 2.4: Latency measurement

```bash
# Measure store latency (avg over 10 calls)
for i in $(seq 1 10); do
  time curl -s -X POST http://localhost:8000/v1/long-term-memory/ \
    -d "{\"memories\":[{\"text\":\"Latency test fact $i\",\"namespace\":\"latency-test\"}]}" \
    > /dev/null
done 2>&1 | grep real | awk '{print $2}'

# Measure recall latency (avg over 10 calls with 50 stored memories)
for i in $(seq 1 50); do
  curl -s -X POST http://localhost:8000/v1/long-term-memory/ \
    -d "{\"memories\":[{\"text\":\"Bulk memory fact $i for latency\",\"namespace\":\"latency-test\"}]}" \
    > /dev/null
done

for i in $(seq 1 10); do
  time curl -s -X POST http://localhost:8000/v1/long-term-memory/search \
    -d '{"text":"latency","namespace":"latency-test","limit":10}' > /dev/null
done 2>&1 | grep real | awk '{print $2}'
```

**Pass criterion:**
- Store p95 < 500ms
- Recall p95 < 200ms

If latencies are 2x worse: not a hard fail, but a yellow flag. Note: these include Ollama embedding round-trip to `.13`, which adds network hop.

### Test 2.5: Disk + memory footprint

```bash
docker stats --no-stream $(docker ps --filter "ancestor=redislabs/agent-memory-server:0.14.0-standalone" -q)
docker stats --no-stream $(docker ps --filter "ancestor=redis:7-alpine" -q)
df -h /var/lib/docker  # if Docker storage is on this volume
```

**Record:**
- Memory: agent-memory-server + Redis steady-state RSS
- Disk: any unexpected growth after 60 stored memories

**Yellow flag:** if combined RSS > 500MB at idle (we're tight on prod RAM).

## Phase 3 — Decision (target: 30 min)

### Go / no-go criteria

**GREEN (proceed with adoption — drop spec v2.4 + plan v2.2):**
- Phase 1 setup completed cleanly (no OpenAI key required, Ollama backend works)
- Test 2.1 store/recall round-trip passes
- Test 2.2 cross-namespace isolation works (no leaks)
- Test 2.3 Docker container can reach the server (one of the two networking patterns works)
- Test 2.4 latencies within 2x of budget (or honest documentation of why slower is acceptable)
- Test 2.5 footprint reasonable (<500MB combined RSS)

**RED (defer per Codex's prior verdict):**
- ANY of the above fails
- OR: subjective sense that adoption adds more operational risk than from-scratch build despite passing tests

### If GREEN: next steps (~3-5 days follow-on work)

1. New skill `add-memory-server` (replaces add-memory):
   - SKILL.md with install steps for Redis + agent-memory-server
   - `docker-compose.yml` for production deployment (Redis persistence, agent-memory-server with Ollama)
2. Thin MCP wrapper in `container/agent-runner/src/ipc-mcp-stdio.ts`:
   - `memory_store` → POST to `http://host.docker.internal:8000/v1/long-term-memory/`
   - `memory_recall` → POST to `/v1/long-term-memory/search`
   - `memory_forget` → DELETE to `/v1/long-term-memory/{id}`
3. Auto-recall preamble in `container/agent-runner/src/index.ts`:
   - Same call sites as plan v2.2 Tasks 12 + 13
   - HTTP call instead of EmbeddingReader
4. Cross-board scoping: namespace = `boardId`, user_id = sender JID
5. NO server-side senderJid validation needed — we control namespace at the MCP wrapper layer
6. Tests against the running server (no SQLite mocking; test via HTTP)
7. Drop spec v2.4 + plan v2.2 entirely (or archive with note "superseded by adoption")

### If RED: next steps

1. Document spike findings in `docs/superpowers/specs/2026-04-25-agent-memory-server-spike-findings.md`
2. Defer memory layer per Codex's prior verdict (revisit post-v2 migration)
3. Update project memory with the decision

## Deliverables (regardless of outcome)

- `docs/superpowers/specs/2026-04-25-agent-memory-server-spike-findings.md` — concrete numbers from each test, GREEN/RED verdict, raw command outputs
- Either: a follow-up plan for `add-memory-server` skill (GREEN) OR a deferral note in project memory (RED)

## Cleanup

After the spike (regardless of outcome):

```bash
docker compose -f scripts/agent-memory-spike-compose.yml down -v
docker rmi redislabs/agent-memory-server:0.14.0-standalone redis:7-alpine
rm scripts/agent-memory-spike-compose.yml  # don't commit the dev-only file
```

If GREEN: re-create the compose file as a proper, committed `scripts/memory-server-compose.yml` as part of the follow-on work.

## What this spike does NOT cover

- Production hardening (auth, TLS, backup) — out of scope for the 1-day spike
- Multi-instance Redis sentinel/cluster — single Redis is fine for spike
- Real fleet-scale load testing — single-user smoke tests only
- Migration from any existing data in `data/embeddings/` — we don't have any memory data yet

These are all cheap to add later if GREEN, expensive to plan for in the spike.
