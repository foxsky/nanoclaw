---
name: add-taskflow-memory
description: Add long-term memory to TaskFlow boards. Per-board shared bucket via redislabs/agent-memory-server. Four MCP tools (store/recall/list/forget) plus an auto-recall preamble that injects relevant facts into every turn.
---

# TaskFlow Memory Skill

Adds a long-term memory layer for TaskFlow-managed boards backed by [`redislabs/agent-memory-server`](https://github.com/redis/agent-memory-server). Each board gets one shared memory bucket — co-managers on the same board (e.g. Giovanni + Mariany on `board-seci-taskflow`) see each other's stored facts. Cross-board is strictly isolated.

**What it adds:**
- Four MCP tools: `memory_store`, `memory_recall`, `memory_list`, `memory_forget`
- Auto-recall preamble injected into every TaskFlow turn (~500 token budget, top-8 relevant facts, wrapped in untrusted-context framing)
- Local sidecar SQLite at `/workspace/group/.nanoclaw/memory/memory.db` for per-board ownership tracking + audit attribution. Lives in a hidden `.nanoclaw/` subdirectory so it does not collide with files the user or agent might place in `/workspace/group`.

**Prerequisite:** `add-taskflow` must already be installed (this skill only fires on TaskFlow-managed boards).

## Phase 1: Pre-flight

1. Verify `add-taskflow` is installed:
   ```bash
   test -f container/agent-runner/src/taskflow-engine.ts && echo "OK" || echo "MISSING"
   ```
2. Check if memory layer is already applied:
   ```bash
   test -f container/agent-runner/src/memory-client.ts && echo "ALREADY APPLIED — skip to Phase 4" || echo "NEEDS APPLY"
   ```
3. Confirm an `agent-memory-server` instance is reachable. Default URL is `http://192.168.2.65:8000`. If you're running your own:
   ```bash
   curl -s --max-time 5 http://192.168.2.65:8000/v1/health | jq .
   # expect {"now": <ms>}
   ```
   If not reachable, stand one up — see "Server setup" below.

## Phase 2: Apply Code Changes

### Add the new files

Copy from this skill's `add/` directory (mirror the repo layout):

```bash
cp .claude/skills/add-taskflow-memory/add/container/agent-runner/src/memory-client.ts        container/agent-runner/src/memory-client.ts
cp .claude/skills/add-taskflow-memory/add/container/agent-runner/src/memory-client.test.ts   container/agent-runner/src/memory-client.test.ts
cp .claude/skills/add-taskflow-memory/add/container/agent-runner/src/index-preambles.test.ts container/agent-runner/src/index-preambles.test.ts
```

### Modify existing files

For each file in `modify/`, read its `*.intent.md` for what to change and why. The intent files describe the surgical change set; they are NOT diffs and MUST be applied with awareness of the surrounding code at HEAD.

| File | Intent file |
|---|---|
| `src/types.ts` | `modify/src/types.ts.intent.md` |
| `src/index.ts` | `modify/src/index.ts.intent.md` |
| `container/agent-runner/src/runtime-config.ts` | `modify/container/agent-runner/src/runtime-config.ts.intent.md` |
| `container/agent-runner/src/runtime-config.test.ts` | `modify/container/agent-runner/src/runtime-config.test.ts.intent.md` |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | `modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md` |
| `container/agent-runner/src/ipc-mcp-stdio.test.ts` | `modify/container/agent-runner/src/ipc-mcp-stdio.test.ts.intent.md` |
| `container/agent-runner/src/index.ts` | `modify/container/agent-runner/src/index.ts.intent.md` |

### Validate

```bash
cd container/agent-runner && npx tsc --noEmit
cd /root/nanoclaw       && npx tsc --noEmit
cd container/agent-runner && npx vitest run src/memory-client.test.ts src/ipc-mcp-stdio.test.ts src/index-preambles.test.ts src/runtime-config.test.ts
```

All four test files must pass cleanly before proceeding.

## Phase 3: Configure

### Environment variables (set on the agent-runner host or per-container)

| Var | Default | Purpose |
|---|---|---|
| `NANOCLAW_MEMORY_SERVER_URL` | `http://192.168.2.65:8000` | agent-memory-server URL |
| `NANOCLAW_MEMORY_SERVER_TOKEN` | (unset) | Optional Bearer auth token |
| `NANOCLAW_MEMORY_PREAMBLE_ENABLED` | (on) | Kill switch: `0/1`, `false/true`, `off/on`, `no/yes`, `disable/disabled`. Unknown values fail SAFE (disabled + warn) |
| `NANOCLAW_MEMORY_MAX_WRITES_PER_TURN` | `5` | Per-turn `memory_store` quota |

### Server setup (if standing up a new agent-memory-server)

The memory layer assumes an `agent-memory-server` instance running at the configured URL. Quick start with Docker (LiteLLM → Ollama backend, no OpenAI key required):

```yaml
# scripts/agent-memory-compose.yml (NOT committed by this skill)
version: '3.8'
services:
  agent-memory:
    image: redislabs/agent-memory-server:0.13.2-standalone
    ports:
      - "8000:8000"
    environment:
      - GENERATION_MODEL=ollama/glm-5.1:cloud
      - FAST_MODEL=ollama/glm-5.1:cloud
      - EMBEDDING_MODEL=ollama/bge-m3
      - OLLAMA_API_BASE=http://<your-ollama-host>:11434
      - REDISVL_VECTOR_DIMENSIONS=1024
      - DISABLE_AUTH=true
      - LONG_TERM_MEMORY=true
      - REDIS_URL=redis://redis:6379
    depends_on: [redis]
  redis:
    image: redis:7-alpine
```

The wrapper has been validated against `0.13.2`. Newer versions may add a `policy`-style forget endpoint; the skill currently uses `DELETE /v1/long-term-memory?memory_ids=...` which works on `0.13.2` (not in OpenAPI but functional) and on later versions.

## Phase 4: Verify

### Container reachability check

```bash
docker run --rm --entrypoint /bin/sh nanoclaw-agent:latest -c \
  'curl -s --max-time 5 http://${NANOCLAW_MEMORY_SERVER_URL:-192.168.2.65:8000}/v1/health'
```

Should return `{"now": <ms>}`.

### Smoke test against a real TaskFlow board

From a TaskFlow group (e.g. `secti-taskflow`):

```
@Case use the memory_store tool to remember "test fact: P11 é o projeto de licenças TI"
@Case use memory_recall to find anything about "P11"
@Case use memory_list to show me the recent stored facts
@Case use memory_forget on the test memory id
```

Each round-trip should respond cleanly. The auto-recall preamble can be observed in agent logs as `Memory preamble injected (N facts, M chars)`.

### Operational kill switch (incident response)

To disable the auto-recall preamble fleet-wide without redeploying:

```bash
export NANOCLAW_MEMORY_PREAMBLE_ENABLED=0
systemctl restart nanoclaw   # Linux
# or
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

The four MCP tools remain available — only the passive preamble injection is gated. To disable the tools too, agents will simply not see them; you can also remove the `memoryEnabled` block in `ipc-mcp-stdio.ts` and rebuild.

## Known limitations

1. **`.65` is multi-tenant.** The `openclaw` namespace already lives there. Predictable `taskflow:<boardId>` scope strings mean a peer with API access can read or write our records. Today's data is workflow conventions on a friendly LAN. Production deployments should either stand up a dedicated `agent-memory-server` instance OR enable `HTTPBearer` auth on the shared instance and set `NANOCLAW_MEMORY_SERVER_TOKEN` on every agent-runner.
2. **Sidecar audit DB is per-container.** If `/workspace/group/.nanoclaw/memory/memory.db` is wiped (manual cleanup, container rebuild that drops the workspace mount), prior `memory_forget` calls will fail until manual SQL recovery — `memory_recall` and `memory_store` continue to work.
3. **Embedding model consistency.** Recall hits depend on the server's configured embedding model staying the same across store + search. Swapping models requires re-indexing all stored facts.

## Why per-board (not per-(board, sender))

Empirical extraction analysis on 120 prod turns (see `project_memory_layer_deferred.md`) showed ~85% of useful memory-worthy content is **board-domain**: workflow patterns, project IDs, name disambiguations. The remaining ~15% is personal communication style — and can be encoded in the fact text itself ("Mariany prefere primeira pessoa") rather than splitting the bucket.
