# Feature Coverage Audit — 4 Supporting Skills

**Date:** 2026-05-03
**Skills audited:** `whatsapp-fixes`, `add-taskflow-memory`, `add-long-term-context`, `add-embeddings`
**Total features audited:** 37
**Anchors:** plan A.3.1/A.3.3/A.3.4/A.3.5; Discovery 20 (fork divergence); Discovery 07 (channel adapter); v1 SKILL.md files; production validation on `nanoclaw@192.168.2.63`.

---

## Audit framework

For each feature: **status** is one of:

- **TRUNK** — source ships in v1 fork trunk (`src/`, `container/agent-runner/src/`); skill is intent-only. Plan must MOVE to skill branch.
- **SKILL** — source ships under `.claude/skills/<name>/add/` or `tests/`. No relocation needed; just port to v2.
- **GAP** — feature missing or inadequately covered by plan; needs explicit step.
- **INTENT-OK** — covered by `*.intent.md` semantic contract; rewriting at v2 paths captures the change.

Plan-coverage column maps the feature to the explicit A.3.X step, or flags as GAP.

---

## 1. whatsapp-fixes (6 features) — Phase A.3.1

**Discovery 20 finding:** intent-only stub. `modify/src/channels/{adapter,whatsapp}.ts.intent.md` + 1 test. Full `src/channels/whatsapp.ts` (964 LOC) and `whatsapp.test.ts` (1356 LOC) live in v1 trunk.

**Production usage validation (192.168.2.63):**

```
sudo grep -c createGroup /home/nanoclaw/nanoclaw/logs/nanoclaw.log
1
```

`createGroup` referenced once in current logs (low-volume, expected — board provisioning is rare and most prod boards already provisioned). Behavior confirmed live via `lid` translation logs at runtime.

| # | Feature | v1 location | Status | Plan coverage | Notes |
|---|---|---|---|---|---|
| 1 | `createGroup(subject, participants)` | `src/channels/whatsapp.ts` (~lines 734-820, ~90 LOC) | TRUNK | A.3.1 step 1.4 (port adapt `logger.*`→`log.*`) | Includes LID-aware verification + invite-link fallback for hidden contacts |
| 2 | `lookupPhoneJid(phone)` | `src/channels/whatsapp.ts` (lines 705-722, ~20 LOC) | TRUNK | A.3.1 step 1.4 | Calls `sock.onWhatsApp()` |
| 3 | `resolvePhoneJid(phone)` | `src/channels/whatsapp.ts` (lines 724-732, ~5 LOC) | TRUNK | A.3.1 step 1.4 | Composed on top of `lookupPhoneJid` |
| 4 | LID-aware verify + invite-link fallback | inside `createGroup` impl | TRUNK | A.3.1 step 1.4 (port-as-block) | Already factored into the ~90 LOC port |
| 5 | 1024-participant limit guard | inside `createGroup` impl: `Too many participants (...): WhatsApp limit is 1024 including creator` | TRUNK | A.3.1 step 1.4 (port-as-block) | Throws before WA call |
| 6 | `droppedParticipants` tracking | `createGroup` return shape: `{ id, droppedParticipants?: string[] }` | TRUNK | A.3.1 step 1.4 + adapter interface change in 1.3 | Return shape carries to caller (TaskFlow board provisioner) |

**Source-relocation status (Discovery 20 critical):**

Plan A.3.1 step 1.4 says "implement methods in `src/channels/whatsapp.ts` (~115 LOC port from v1 fork's `whatsapp.ts:705-820`)" — this is an explicit MOVE direction. Step 1.3 adds the 3 optional methods to `src/channels/adapter.ts` interface.

Plan **does** address relocation. Verdict: COVERED.

**Status counts:** 6 TRUNK / 0 SKILL / 0 GAP. All 6 covered by A.3.1 step 1.4 (port block) + 1.3 (interface).

---

## 2. add-taskflow-memory (10 features) — Phase A.3.3

**Discovery 20 finding:** the **only one** of the 5 fork skills that ships meaningful source today. `add/container/agent-runner/src/{memory-client,memory-client.test,index-preambles.test}.ts` are full source files. Modifies are `*.intent.md` semantic contracts.

**Production validation:**

```
curl -s --max-time 5 http://192.168.2.65:8000/v1/health
{"now":1777849710090}      ← server reachable
```

`grep "Memory preamble injected" logs/nanoclaw.log` → 0 hits. `grep "memory_recall|memory_store|memory_list|memory_forget"` → 0 hits.

**Interpretation:** Phase 1 SHIPPED LOCALLY (per memory `project_memory_layer_phase1.md`) but not yet deployed to production. Server is up; container is not yet using it on `.63`. A.3.3 step 3.5 explicitly demands "verify auto-recall preamble injection in container logs" before merge — this step is the prod-deployment gate.

| # | Feature | v1 location | Status | Plan coverage | Notes |
|---|---|---|---|---|---|
| 1 | `memory_store` MCP tool | `container/agent-runner/src/ipc-mcp-stdio.ts:517` (TRUNK; not in `add/`) | TRUNK | A.3.3 step 3.3.d (NEW: register via `mcp-tools/memory.ts` per Discovery 06 pattern, not IPC) | Direct MCP module, no IPC roundtrip in v2 |
| 2 | `memory_recall` MCP tool | `container/agent-runner/src/ipc-mcp-stdio.ts:567` | TRUNK | A.3.3 step 3.3.d | Same as 1 |
| 3 | `memory_list` MCP tool | `container/agent-runner/src/ipc-mcp-stdio.ts:601` | TRUNK | A.3.3 step 3.3.d | Same as 1 |
| 4 | `memory_forget` MCP tool | `container/agent-runner/src/ipc-mcp-stdio.ts:633` | TRUNK | A.3.3 step 3.3.d | Per skill SKILL.md: ownership check via sidecar SQLite closes v0.13.2 unscoped-DELETE TOCTOU |
| 5 | Auto-recall preamble injection | `container/agent-runner/src/index.ts:735-790` (TRUNK) | TRUNK | A.3.3 step 3.3.e | Top-8 facts, 500-token budget, untrusted-context wrap |
| 6 | Per-board shared bucket (`taskflow:<boardId>`) | `memory-client.ts` (in skill's `add/`) | SKILL | A.3.3 step 3.4 (direct copy) | Source already in skill |
| 7 | Sidecar SQLite (`/workspace/group/.nanoclaw/memory/memory.db`) | inside `memory-client.ts` | SKILL | A.3.3 step 3.4 | Per-board ownership tracking + audit attribution |
| 8 | Kill switch env var (`NANOCLAW_MEMORY_PREAMBLE_ENABLED`) | `container/agent-runner/src/index.ts:744-750` (TRUNK) | TRUNK | A.3.3 step 3.3.c (`runtime-config.ts` env-var exposure) | Fail-SAFE on unknown values per intent.md |
| 9 | Max-writes-per-turn quota (`NANOCLAW_MEMORY_MAX_WRITES_PER_TURN=5`) | `ipc-mcp-stdio.ts:85` quota counter | TRUNK | A.3.3 step 3.3.c + 3.3.d | Per-turn quota enforced inside MCP handler |
| 10 | External dep `redislabs/agent-memory-server@0.13.2` | docker-compose YAML in SKILL.md (operational, not in repo) | SKILL | A.3.3 step 3.5 (production deployment validation) | Operational, not code; LiteLLM→Ollama backend |

**Wiring re-target items (Discovery 06):** plan step 3.3 explicitly enumerates 5 sub-steps: (a) `src/types.ts`, (b) `src/index.ts`, (c) `runtime-config.ts`, (d) **NEW v2 path** `mcp-tools/memory.ts`, (e) `container/agent-runner/src/index.ts` preamble injection. The `*.intent.md` files cover the v1 paths; the plan correctly redirects to v2 paths (Discovery 06 says no IPC roundtrip — v2 uses MCP module directly).

**Source-relocation status:** plan A.3.3 step 3.4 explicitly copies `memory-client.ts`, `memory-client.test.ts`, `index-preambles.test.ts` from `add/` directly. Trunk versions of these files (TRUNK rows 1-5, 8-9 above) need MOVE before cutover. Plan implicitly handles this by porting v1 `*.intent.md` semantics into direct branch edits — but the `manifest.yaml` / `add/` / `modify/` shape is dropped (step 3.1).

**Verdict:** COVERED. The 6 sub-steps map cleanly. 10/10.

**Status counts:** 7 TRUNK / 3 SKILL / 0 GAP.

---

## 3. add-long-term-context (10 features) — Phase A.3.4

**Discovery 20 finding:** "pure SKILL.md" stub. 4,524 LOC `src/context-{service,sync}*.ts` + 1,660 LOC `container/agent-runner/src/context-reader*` all in v1 trunk. SKILL.md says "git merge skill/long-term-context" — in v1 fork's skill-branch model — but no source has been moved into the skill directory.

**Production validation (192.168.2.63):**

```
ls -la data/context/
context.db (18.5 MB), context.db-wal (4.1 MB) — ALIVE

sqlite3 context.db "SELECT level, COUNT(*) FROM context_nodes GROUP BY level"
0|2603     ← leaves (turn-level)
1|441      ← daily rollups
2|113      ← weekly rollups
3|21       ← monthly rollups
MAX(created_at) = 2026-05-03T13:40:26Z  ← capture working live
```

DAG hierarchy + retention working. Service is the canary for skill source surviving in v1 trunk.

| # | Feature | v1 location | Status | Plan coverage | Notes |
|---|---|---|---|---|---|
| 1 | `captureAgentTurn(group, sessionId)` host-side hook | `src/context-sync.ts` + invoked at `src/container-runner.ts:751-753` | TRUNK | A.3.4 step 4.4 (FORK-KEEP: patch v2 `container-runner.ts` to fire hook from skill) | v2 has no general-purpose session-end hook |
| 2 | JSONL byte-offset cursor | `context_cursors.last_byte_offset` (DB schema confirmed prod) | TRUNK | A.3.4 step 4.2 (cherry-pick) | Persisted in `context_cursors` |
| 3 | Leaf node creation (level=0, summary=NULL) | `src/context-sync.ts` | TRUNK | A.3.4 step 4.2 | Confirmed: 2603 leaves in prod |
| 4 | Background compaction (60s leaves→daily→weekly→monthly) | `src/context-service.ts` interval | TRUNK | A.3.4 step 4.2 | All 4 levels populated in prod |
| 5 | Ollama summarization (`qwen3-coder:latest` configurable) | `src/context-service.ts` | TRUNK | A.3.4 step 4.3 (`context-service.test.ts`) | env: `CONTEXT_SUMMARIZER_MODEL` |
| 6 | 90-day retention (leaves+dailies soft-deleted; weekly/monthly kept forever) | `src/context-service.ts` | TRUNK | A.3.4 step 4.2 | `CONTEXT_RETAIN_DAYS=90` |
| 7 | `ContextReader` recap preamble (3 most recent summaries, 1024-token budget) | `container/agent-runner/src/context-reader.ts` + invoked at `container/.../index.ts:818-820` | TRUNK | A.3.4 step 4.3 (`context-reader.test.ts`) | Skipped on script-driven scheduled tasks (DEBUG log confirms) |
| 8 | MCP tools (context_search/recall/grep/timeline/topics) | `container/agent-runner/src/context-reader.ts` | TRUNK | A.3.4 step 4.2 (cherry-pick all changes) | Progressive unlock at >50 nodes |
| 9 | Container mount (`/workspace/context/:ro`) | `src/container-runner.ts` mounts list | TRUNK | A.3.4 step 4.4 (`runtime-config.ts` patch) | Read-only |
| 10 | Host-side `captureAgentTurn` hook (post-container-exit invocation) | `src/container-runner.ts:751-753` | TRUNK | A.3.4 step 4.4 (explicit FORK-KEEP marker) | v2 has no session-end hook |

**Source-relocation status:** Plan A.3.4 step 4.1: "branch from `release/taskflow-bundle-v2` (or branch from `upstream/v2` directly)". Step 4.2: "cherry-pick or merge v1's `skill/long-term-context` content; resolve conflicts (likely on `src/index.ts`, `container/agent-runner/src/index.ts`, `runtime-config.ts`)".

**GAP-1 (LOW):** Plan says "merge v1's `skill/long-term-context` content" but discovery 20 found that the v1 `skill/long-term-context` git branch is **5 weeks stale, 630 commits behind v2**. The actual source lives in v1 fork's `main` branch. Step 4.2 needs explicit "merge from v1 main into v2 worktree" instructions OR an upfront move from v1 main into a refreshed `skill/long-term-context` branch. This is a Pattern A vs. branch-from-main ambiguity.

**Recommended plan amendment:** clarify A.3.4 step 4.2 — "Refresh v1 `skill/long-term-context` branch from v1 main first (carry the skill files), THEN cherry-pick into v2 worktree." OR cherry-pick directly from v1 main commit `561ad3cd`.

**Status counts:** 10 TRUNK / 0 SKILL / 1 GAP-LOW (stale-branch-vs-main resolution path).

---

## 4. add-embeddings (11 features) — Phase A.3.5

**Discovery 20 finding:** "pure SKILL.md" stub. ~10,070 LOC under `container/agent-runner/src/{semantic-audit*,auditor-*,embedding-reader*,taskflow-embedding-integration.test,digest-skip-script.sh}` + `src/embedding-service*.ts` + `src/taskflow-embedding-sync.ts` all in v1 trunk. Highest-LOC stub of the 4.

**Production validation (192.168.2.63):**

```
ls data/embeddings/embeddings.db → 1.16 MB
sqlite3 embeddings.db "SELECT collection, COUNT(*) FROM embeddings GROUP BY collection"
tasks:board-asse-seci-taskflow|4
tasks:board-ci-seci-taskflow|5
tasks:board-laizys-taskflow|41
tasks:board-seaf-rh-taskflow|1
tasks:board-sec-taskflow|65
tasks:board-seci-taskflow|82
tasks:board-setec-secti-taskflow|8
tasks:board-tec-taskflow|4
tasks:board-thiago-taskflow|8
                  total: 218 across 9 prod boards

curl -s http://192.168.2.13:11434/api/tags | grep bge-m3
bge-m3       ← model loaded
```

Indexer is alive; collections are board-scoped. Service runs in production today.

| # | Feature | v1 location | Status | Plan coverage | Notes |
|---|---|---|---|---|---|
| 1 | `EmbeddingService` host-side startup | `src/index.ts` import + boot of `src/embedding-service.ts` | TRUNK | A.3.5 (revalidation; same shape as A.3.4) | Plan inherits step structure from A.3.4 |
| 2 | BGE-M3 via Ollama backend | `src/embedding-service.ts` | TRUNK | A.3.5 step 4.2 equiv | env: `EMBEDDING_MODEL=bge-m3` |
| 3 | Named collections (`tasks:board-X`, etc) | DB schema PRIMARY KEY (collection, item_id) | TRUNK | A.3.5 step 4.2 equiv | 9 prod collections confirmed |
| 4 | Indexer cycle (background batch w/ re-entrancy guard, model-change re-embed) | `src/embedding-service.ts:145-246` | TRUNK | A.3.5 step 4.2 equiv | Re-entrancy via `indexerRunning` flag |
| 5 | `embedding-reader.ts` query client (read-only) | `container/agent-runner/src/embedding-reader.ts` | TRUNK | A.3.5 step 4.2 equiv | 92 LOC + 120 LOC test |
| 6 | Container mount `/workspace/embeddings:ro` | `src/container-runner.ts:301-306` | TRUNK | A.3.5 step 4.2 equiv (`container-runner.ts` patch) | Q-CAP confirmed v2 has no vector primitive — fork-keep |
| 7 | `queryVector` host-side hook | `src/container-runner.ts:77` `ContainerInput` field | TRUNK | A.3.5 step 4.2 (explicit "fork-private patch") | Plan explicitly calls out as fork-keep |
| 8 | `EMBEDDING_MODEL` env var | `src/container-runner.ts:387` | TRUNK | A.3.5 step 4.2 | Default `bge-m3` |
| 9 | `OLLAMA_HOST` env var | `.env` config | TRUNK | A.3.5 step 4.2 | Used by both embedding service + memory server backend |
| 10 | Duplicate detection + similarity search | `src/embedding-service.ts` | TRUNK | A.3.5 step 4.2 | Generic "named collections" abstraction |
| 11 | Tests | `src/embedding-service.test.ts` (1840 LOC), `embedding-reader.test.ts` (120 LOC), `taskflow-embedding-integration.test.ts` (333 LOC), `auditor-*.test.ts` (1822 LOC), `semantic-audit.test.ts` (1734 LOC) — all TRUNK | TRUNK | A.3.5 step 4.2 (must port) | The auditor + semantic-audit suite drives Kipp daily audit |

**Source-relocation status:** A.3.5 says "same shape as A.3.4. Q-CAP confirmed v2 has no vector primitive — fork-keep all features. `queryVector` hook on host stays as fork-private patch (Discovery: no v2 equivalent)."

**GAP-2 (MEDIUM):** A.3.5 has only 3 sentences. Same stale-branch-vs-main resolution issue as A.3.4. Worse: `add-embeddings` includes the **auditor stack** (`auditor-script.sh`, `auditor-prompt.txt`, `auditor-dm-detection.test.ts`, `auditor-delivery-health.test.ts`, `digest-skip-script.sh`, `semantic-audit*.ts`) — none of which appear in `add-embeddings`'s SKILL.md scope or the plan text. Yet Discovery 20 attributes them to `add-embeddings` (lines 282-307). The Kipp audit feature is operationally critical (project memories cite multiple Kipp incidents).

**Recommended plan amendment:**
1. Expand A.3.5 with explicit feature list (matches the 11 in this audit).
2. Add an A.3.5 step "auditor stack port" — explicitly relocate `auditor-script.sh`, `auditor-prompt.txt`, `semantic-audit.ts`, `auditor-dm-detection.test.ts`, `auditor-delivery-health.test.ts`, `taskflow-embedding-sync.ts`, `digest-skip-script.sh` from v1 trunk into the skill branch.
3. Cross-reference Discovery 03 + 19 (drop `send_message_log`, auditor reads v2 session DBs directly) — plan's A.3.2 step 2.3.m calls for "~200 LOC auditor change" but the rewrite owner is `add-embeddings`, not `add-taskflow`. Boundary unclear: is auditor rewrite owned by `skill/taskflow-v2` (per 2.3.m) or `skill/embeddings-v2`? Resolve before A.3.2 commits.

**GAP-3 (LOW):** Auditor `OLLAMA_HOST` routing (`NANOCLAW_SEMANTIC_AUDIT_OLLAMA_HOST=http://host.docker.internal:11434`) is a fork-private env var (per memory `reference_audit_ollama_hosts.md`). Not in the plan's env-var matrix. Sub-issue of GAP-2.

**Status counts:** 11 TRUNK / 0 SKILL / 2 GAP (1 MEDIUM scope-explosion + boundary-unclear; 1 LOW env-var omission).

---

## Aggregate roll-up

| Skill | Total | TRUNK | SKILL | GAPs | Plan phase |
|---|---:|---:|---:|---:|---|
| whatsapp-fixes | 6 | 6 | 0 | 0 | A.3.1 (full step list) |
| add-taskflow-memory | 10 | 7 | 3 | 0 | A.3.3 (full step list) |
| add-long-term-context | 10 | 10 | 0 | 1 LOW | A.3.4 (5 short steps) |
| add-embeddings | 11 | 11 | 0 | 2 (1 MED, 1 LOW) | A.3.5 (3 sentences) |
| **TOTAL** | **37** | **34** | **3** | **3** | — |

### Source-relocation summary (Discovery 20 critical finding)

**34 of 37 features (92%) live in v1 trunk** and need MOVE to skill branch. Per skill's plan-step coverage:

- **whatsapp-fixes (6/6 TRUNK):** A.3.1 step 1.4 explicitly says "port from v1 fork's `whatsapp.ts:705-820`" — direction is unambiguous. COVERED.
- **add-taskflow-memory (7/10 TRUNK):** A.3.3 step 3.3 enumerates 5 wiring re-targets (a-e) covering all 7 trunk features. COVERED.
- **add-long-term-context (10/10 TRUNK):** A.3.4 step 4.2 says "cherry-pick or merge v1's `skill/long-term-context`" — but per Discovery 20, that branch is 5 weeks stale, 630 behind v2. The source actually lives in v1 fork's `main`. **Branch-vs-main resolution path is ambiguous** (GAP-1 LOW).
- **add-embeddings (11/11 TRUNK):** A.3.5 is 3 sentences; doesn't enumerate the auditor stack (~10k LOC); doesn't resolve auditor-rewrite ownership boundary with A.3.2 step 2.3.m. **GAP-2 MEDIUM**.

### Production reachability summary

| Skill | Service alive on `.63`? | Evidence |
|---|---|---|
| whatsapp-fixes | yes | `createGroup` referenced in logs once (provisioning is rare, expected) |
| add-taskflow-memory | server alive, container not yet using it | `192.168.2.65:8000/v1/health` returns OK; 0 `Memory preamble injected` log lines (Phase 1 SHIPPED LOCALLY only — A.3.3 step 3.5 is the prod-deploy gate) |
| add-long-term-context | yes, working | `data/context/context.db` 18.5 MB, 3178 nodes across 4 levels, last capture 2026-05-03T13:40Z |
| add-embeddings | yes, working | `data/embeddings/embeddings.db` 1.16 MB, 218 embeddings across 9 prod boards; BGE-M3 loaded on `.13:11434` |

Three of four are live in production today. Memory layer is the only one not yet deployed; the plan correctly gates that deployment in step 3.5.

---

## Recommended plan amendments

**Highest-leverage amendments (in priority order):**

1. **GAP-2 (MEDIUM) — A.3.5 expansion.** Replace 3-sentence A.3.5 with explicit step list mirroring A.3.3/A.3.4 shape. Enumerate the 11 features. Add step "auditor stack port: relocate `auditor-script.sh`, `auditor-prompt.txt`, `semantic-audit*.ts`, `auditor-{dm-detection,delivery-health}.test.ts`, `taskflow-embedding-sync.ts`, `digest-skip-script.sh` from v1 trunk into skill branch." Resolve auditor-rewrite ownership boundary with A.3.2 step 2.3.m — propose: 2.3.m **defers to** A.3.5 (auditor lives in `skill/embeddings-v2`, not `skill/taskflow-v2`).

2. **GAP-1 (LOW) — A.3.4 step 4.2 clarification.** Add: "Source for `skill/long-term-context-v2` lives in v1 fork's `main` branch (commit `561ad3cd` or later), NOT the stale `skill/long-term-context` branch. Cherry-pick directly from `main` or refresh `skill/long-term-context` from `main` first."

3. **GAP-3 (LOW) — env-var matrix completeness.** Add `NANOCLAW_SEMANTIC_AUDIT_OLLAMA_HOST` to A.3.5's env-var list (per memory `reference_audit_ollama_hosts.md`). Cross-reference: prod uses `.63:11434` for cloud, `.13:11434` for local fallback.

**No amendments needed:** A.3.1 (whatsapp-fixes) and A.3.3 (taskflow-memory) are fully specified.

---

## Cross-referenced production memories

- `project_memory_layer_phase1.md` — Phase 1 SHIPPED LOCALLY 2026-04-26; not yet on `.63`. Pending commit + deploy. A.3.3 step 3.5 is the gate.
- `reference_audit_ollama_hosts.md` — `.13:11434` local + `.63:11434` cloud; vLLM-MLX on `.13:8000`; embedding model `bge-m3` confirmed loaded. Audit-side env var `NANOCLAW_SEMANTIC_AUDIT_OLLAMA_HOST`.
- `project_kipp_report_hallucination.md` — Kipp auditor stack is operationally load-bearing; misattribution to `add-embeddings` ownership underscores GAP-2 priority.
- `project_v2_migration_assessment.md` — overall plan v2.6 acknowledges Phase 2 dissolution rolled back; A.3 is downstream.

---

## Appendix A — Test-coverage inventory

### whatsapp-fixes
- Skill ships: `tests/whatsapp-extensions.test.ts` (TDD-RED — fails until impls applied per SKILL.md status checklist)
- Trunk ships: `src/channels/whatsapp.test.ts` (1356 LOC — fork-extended; covers the 3 methods being ported)
- Plan A.3.1 step 1.2 (RED): port v1 test → `src/channels/whatsapp-extensions.test.ts` (host-side, NOT container)
- Test count target per plan: 9+ adapter-extension tests

### add-taskflow-memory
- Skill ships: `add/container/agent-runner/src/{memory-client.test,index-preambles.test}.ts` + `tests/memory.test.ts`
- Trunk ships: `container/agent-runner/src/memory-client.test.ts` (315 LOC), `index-preambles.test.ts` (144 LOC), `recent-turns-recap.test.ts` (346 LOC)
- Plan A.3.3 step 3.4: "3 files port directly: `memory-client.ts`, `memory-client.test.ts`, `index-preambles.test.ts`"
- Discovery 20 line 293: `recent-turns-recap.test.ts` (346 LOC) attributed to `add-taskflow-memory` — **not in plan A.3.3 step 3.4 list**. Possible omission.

### add-long-term-context
- Trunk ships: `src/context-service.test.ts` (1840 LOC), `src/context-sync.test.ts`, `container/agent-runner/src/context-reader.test.ts` (1083 LOC)
- Plan A.3.4 step 4.3 enumerates the 3 test files explicitly. COVERED.

### add-embeddings
- Trunk ships: `src/embedding-service.test.ts`, `container/agent-runner/src/embedding-reader.test.ts` (120 LOC), `taskflow-embedding-integration.test.ts` (333 LOC), `auditor-dm-detection.test.ts` (1587 LOC), `auditor-delivery-health.test.ts` (235 LOC), `semantic-audit.test.ts` (1734 LOC)
- Plan A.3.5: doesn't enumerate test files. **GAP-2 sub-issue.**

---

## Appendix B — Production data summary (snapshotted 2026-05-03)

### context.db
```
context_nodes by level:
  level 0 (leaves):   2603
  level 1 (daily):     441
  level 2 (weekly):    113
  level 3 (monthly):    21
                Total: 3178

DB file size: 18.5 MB (.db) + 4.1 MB (.wal)
Most recent capture: 2026-05-03T13:40:26Z

FTS5 virtual table (context_fts) populated via triggers
Indexes: idx_nodes_group_level, idx_nodes_parent, idx_nodes_pending,
         idx_sessions_group, idx_nodes_pruned, idx_nodes_group_time
```

### embeddings.db
```
Collections (board-scoped):
  tasks:board-asse-seci-taskflow:   4
  tasks:board-ci-seci-taskflow:     5
  tasks:board-laizys-taskflow:     41
  tasks:board-seaf-rh-taskflow:     1
  tasks:board-sec-taskflow:        65
  tasks:board-seci-taskflow:       82
  tasks:board-setec-secti-taskflow: 8
  tasks:board-tec-taskflow:         4
  tasks:board-thiago-taskflow:      8
                            Total: 218

DB file size: 1.16 MB
Schema: PRIMARY KEY (collection, item_id), vector BLOB, source_text TEXT,
        model TEXT, metadata TEXT, updated_at TEXT
Indexes: idx_embeddings_collection, idx_embeddings_pending
Pending index: WHERE vector IS NULL — drives indexer cycle batch
```

### memory server (.65:8000)
```
GET /v1/health → {"now": 1777849710090}      ← reachable
agent-memory-server v0.13.2-standalone (per skill SKILL.md)
LiteLLM → Ollama backend (no OpenAI key required)

Container-side preamble check (.63):
  grep "Memory preamble injected" logs/nanoclaw.log → 0 hits
  → Phase 1 NOT YET DEPLOYED on .63 production
  → A.3.3 step 3.5 remains the gate
```

### Ollama models loaded (`.13:11434`)
```
bge-m3              ← embedding model (add-embeddings)
qwen3-coder:latest  ← summarizer (add-long-term-context)
qwen3.6:27b-coding-mxfp8 + others
```

---

## Appendix C — Discovery cross-reference

For each GAP, the relevant discovery doc:

- **GAP-1 (A.3.4 stale-branch resolution)** ← Discovery 20 §3 ("4 of 5 fork skills are intent stubs"; line 28); Discovery 20 §6 ("`add-long-term-context`: 4,524 LOC in `src/context-{service,sync}*.ts` + 1,660 LOC in `container/agent-runner/src/context-reader*`"; line 326)
- **GAP-2 (A.3.5 auditor stack scope explosion + boundary unclear)** ← Discovery 03/04/19 (drop `send_message_log`, auditor reads v2 session DBs directly); Discovery 20 §3 lines 282-307 (auditor files attributed to `add-embeddings`)
- **GAP-3 (env-var matrix)** ← Memory `reference_audit_ollama_hosts.md`; Discovery 19 (production reality, Kipp incidents)

---

## Conclusions

1. **Source-relocation completeness: 92% TRUNK** (34/37). All 4 skills require source MOVE before cutover. `whatsapp-fixes` and `add-taskflow-memory` plans are fully specified for this; `add-long-term-context` is mostly specified but has a stale-branch resolution gap; `add-embeddings` plan is **substantially under-specified** relative to the ~10k LOC it owns (auditor stack).

2. **Production health: 3/4 alive on `.63`.** Memory layer is the sole exception, gated by A.3.3 step 3.5.

3. **3 GAPs identified, 0 BLOCKERs.** All 3 are addressable by plan amendments without changing the overall A.3 phase order. Highest-priority is GAP-2 (A.3.5 expansion) — the auditor stack's operational criticality (Kipp daily audit) plus its scope footprint (~10k LOC) make a 3-sentence plan inadequate.

4. **Plan boundary issue surfaced (GAP-2 sub-issue):** auditor rewrite (~200 LOC per A.3.2 step 2.3.m) ownership unclear — `skill/taskflow-v2` or `skill/embeddings-v2`. Recommend: defer to `embeddings-v2` since auditor reads embeddings + queries v2 session DBs (read-side semantics) rather than writing taskflow state.

---

**Author:** Claude Opus 4.7 (1M context)
**Verification:** 4 SKILL.md files read, plan A.3.1/A.3.3/A.3.4/A.3.5 read end-to-end, Discovery 20 cross-referenced for stub-vs-source state, production validation (4 services) executed via SSH `nanoclaw@192.168.2.63` and direct curl to `.65:8000` + `.13:11434`.
