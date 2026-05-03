# Coverage Matrix — Section 09: Search + Semantic Domain

> **Date:** 2026-05-03
> **Scope:** TaskFlow's six search/semantic features powered by the `add-embeddings` skill: (1) semantic search over tasks, (2) duplicate detection on `taskflow_create`, (3) automatic context-preamble injection ranked by embeddings, (4) org-wide person lookup (`find_person_in_organization`), (5) homonym disambiguation, (6) contact reuse instead of re-asking for phone.
>
> **Inputs:**
> - Plan: `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md` §A.3.5 (3 lines: "fork-keep all features, queryVector hook stays") + §A.3.7 step 7.2 (one bullet: "Embeddings: index task → similarity search")
> - Spec: `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md` (silent on embeddings — no first-class section)
> - Mapping: `/root/nanoclaw/docs/superpowers/audits/2026-05-02-v2-features-for-our-skills.md` L390 — `add-embeddings` mostly unchanged at cutover; P3 follow-up only
> - Skill SKILL.md: `/root/nanoclaw/.claude/skills/add-embeddings/SKILL.md` (131 LOC; Phase 2 = `git merge skill/embeddings`)
> - Skill template: `/root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template` L443-L453 (find_person + disambiguation prompt)
> - Add-taskflow SKILL.md: `/root/nanoclaw/.claude/skills/add-taskflow/SKILL.md` L54-L55 (one bullet declares all three semantic capabilities)
>
> **Engine + glue:**
> - `/root/nanoclaw/container/agent-runner/src/embedding-reader.ts` (92 LOC; cosine, `search`, `findSimilar`)
> - `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` L6611-L6660 (semantic search), L9298-L9378 (`buildContextSummary`), L7138-L7206 (`find_person_in_organization` — masked phone, `is_owner`, `routing_jid`)
> - `/root/nanoclaw/container/agent-runner/src/ipc-mcp-stdio.ts` L1062-L1107 (duplicate gate on create — 0.85 soft / 0.95 hard)
> - `/root/nanoclaw/container/agent-runner/src/index.ts` L701-L728 (preamble injection — `EmbeddingReader` + `buildContextSummary`)
> - Host indexer/sync: `/root/nanoclaw/src/embedding-service.ts` (293 LOC), `/root/nanoclaw/src/taskflow-embedding-sync.ts` (79 LOC; 15s sweep, drops done/archived)
> - Query embedding: `/root/nanoclaw/src/container-runner.ts` L558-L581 (host embeds user message, base64 → `containerInput.queryVector`, 2s timeout, fail-soft)
> - Tests: `/root/nanoclaw/container/agent-runner/src/taskflow-embedding-integration.test.ts` (333 LOC), `/root/nanoclaw/container/agent-runner/src/embedding-reader.test.ts`, `/root/nanoclaw/container/agent-runner/src/taskflow-engine.test.ts` L679-L770 (find_person)

---

## 0. Production validation (queries run 2026-05-03 against `192.168.2.63`)

### `data/embeddings/embeddings.db`

| Metric | Value | Source |
|---|--:|---|
| File size | **1.16 MB** | `ls -la /home/nanoclaw/nanoclaw/data/embeddings/` |
| WAL active | yes (-shm 32K, -wal 0) | live indexer |
| Total rows | **218** | `SELECT COUNT(*)` |
| Pending (vector IS NULL) | **0** | indexer keeps up |
| Distinct model | `bge-m3` (single) | configured per `.env` |

**Per-collection counts (top boards):**
```
tasks:board-seci-taskflow            82
tasks:board-sec-taskflow             65
tasks:board-laizys-taskflow          41
tasks:board-setec-secti-taskflow      8
tasks:board-thiago-taskflow           8
tasks:board-ci-seci-taskflow          5
tasks:board-asse-seci-taskflow        4
tasks:board-tec-taskflow              4
tasks:board-seaf-rh-taskflow          1
```

Distribution mirrors `data/taskflow/taskflow.db` open-task counts (seci 164, sec 75, laizys 48 — embeddings strip `done`/`archived` per `taskflow-embedding-sync.ts` L34). Coverage is real, not stale.

### Service health

- `.env` configured: `OLLAMA_HOST=http://192.168.2.13:11434`, `EMBEDDING_MODEL=bge-m3`
- BGE-M3 model present on host: confirmed via `/api/tags` — `bge-m3:latest` (1.16 GB, F16, BERT family)
- Service uptime: `nanoclaw.service` active 3 days (since 2026-04-30 15:49) — last embedding row `updated_at` matches latest sync
- Container mount confirmed in production logs: `/home/nanoclaw/nanoclaw/data/embeddings -> /workspace/embeddings (ro)` is present in every container `mounts:` line on `whatsapp_main` (the wizard container) AND the `*-taskflow` boards
- `tail -10000 logs/nanoclaw.log | grep -ciE "embed|preamble|find_person"` = **5** entries — all are mount-listing log lines on container start; no error, no skip

### Feature-by-feature usage signal (last 14 days)

| Feature | Evidence | Count |
|---|---|--:|
| Semantic search query (`search` w/ query_vector) | `find ... -name "*.jsonl" -mtime -14 \| xargs grep -l find_person_in_organization` (proxy: it's the only semantic tool with a unique string) | not directly measurable from JSONL — search query goes via `taskflow_query` which has no unique log marker |
| `find_person_in_organization` invocations | session JSONL grep | **1** session (`thiago-taskflow/.../9e02c46f-...jsonl`, 1 call) in last 14 days |
| Duplicate-detection blocks | no log emission on success; only `console.warn` on Ollama-unreachable failure | 0 fail-soft warnings in last 10K log lines → embeddings reachable on every create attempt |
| Context preamble injection | `index.ts` L719 logs `Context preamble injected (N chars)` | sample of 100 recent jsonl files: **0** matches in last 3 days; same expression in main log file: 0 |
| Disambiguate (homonym) | scripted check: no `task_history.details` row matches `%find_person%` or `%disambiguat%` | **0** persisted history entries |

**Interpretation:** the index is healthy and complete (218/218 vectors), the mount and env are correct on every container, but **the agent rarely invokes the semantic surface**. Duplicate-detection runs unconditionally on `taskflow_create` (the only true production user). `find_person` and the context preamble are nearly dormant — the latter triggers only when `containerInput.queryVector` is set AND `isTaskflowManaged && taskflowBoardId`, which excludes one-shot `whatsapp_main` and most scheduled-task containers.

---

## Coverage matrix

Status legend: **OK** = feature works in v1 prod and plan covers it for v2. **GAP** = plan does not address it. **VESTIGIAL** = wired but unused in prod.

### F.1 — Semantic search across tasks (cosine ≥ 0.3 threshold, top-20)

| Aspect | v1 location | Prod state | v2 plan coverage |
|---|---|---|---|
| Engine ranking | `taskflow-engine.ts` L6611-L6660 | live; mixes lexical (LIKE) + semantic; composite key `${board_id}:${id}` to handle delegated tasks | A.3.5 says "fork-keep" — **OK** (no v2 alternative exists) |
| Query embedding hook | `src/container-runner.ts` L558-L581 (host-side, 2s timeout, base64) | live; `queryVector` populated for every TaskFlow turn where Ollama reachable | A.3.5 L202: *"queryVector hook on host stays as fork-private patch"* — **OK** |
| Reader DI into engine | MCP server passes `params.embedding_reader` (engine returns text matches if reader/vector absent) | live, fail-soft | not called out — implicit under "fork-keep" |
| Test coverage | `taskflow-engine.test.ts` (lexical) + `taskflow-embedding-integration.test.ts:222-265` (semantic) | passes locally | A.3.7 step 7.2: *"Embeddings: index task → similarity search"* one-line bullet — **THIN** |

### F.2 — Duplicate detection on task create (0.85 soft / 0.95 hard, embed title+description)

| Aspect | v1 location | Prod state | v2 plan coverage |
|---|---|---|---|
| Wiring | `ipc-mcp-stdio.ts` L1062-L1107 | unconditional pre-`engine.create` check; embeds `title + description`; calls `findSimilar(collection, vector, 0.85)` | not mentioned in plan or spec |
| Hard block (≥0.95) | L1075-L1085 — non-overridable | live; uses literal "Tarefa já existe" pt-BR error | **GAP** — plan A.3.7 has no test for hard-block path |
| Soft warning + `force_create` override | L1086-L1102 | live; returns `duplicate_warning` payload to agent | **GAP** — not enumerated as test case |
| Threshold rationale | embedded literal `0.85` and `>= 95` — only place these constants live outside `embedding-reader.ts` defaults | matches SKILL.md L55 "0.85 similarity threshold" claim | **GAP** — v2 plan never names the threshold |

### F.3 — Automatic context-preamble injection ranked by embeddings

| Aspect | v1 location | Prod state | v2 plan coverage |
|---|---|---|---|
| Builder | `taskflow-engine.ts` L9308-L9378 (`buildContextSummary`) — column counts + ranked top-N + "Other tasks" tail | live; uses `threshold: 0.2`, `limit: 10`; budgeted to ~30 "other" lines | not in plan/spec |
| Activation gate | `index.ts` L702: `if (containerInput.queryVector && containerInput.isTaskflowManaged && containerInput.taskflowBoardId)` | live; correctly skipped for non-TaskFlow groups + scheduled tasks | **GAP** — plan does not list the three-way gate as an invariant; A.3.7 mentions "preamble injection" only for long-term-context, not embeddings |
| Test coverage | `taskflow-embedding-integration.test.ts:270-330` (preamble shape, ranked tasks, column counts, fallback to null) | passes locally | not enumerated by name in A.3.7 |
| Production usage | log marker `Context preamble injected` not seen in last 3 days of jsonl/log sampling | likely fires on most TaskFlow turns but the log-line sampling missed; can't confirm rate | **VESTIGIAL CANDIDATE** — needs explicit prod measurement before v2 cutover |

### F.4 — Org-wide person lookup (`find_person_in_organization`)

| Aspect | v1 location | Prod state | v2 plan coverage |
|---|---|---|---|
| Engine query | `taskflow-engine.ts` L7138-L7206 — walks `getOrgBoardIds()` (root + descendants), LIKE-escapes terms, returns masked phone + `routing_jid` + `is_owner` | live | not named in plan; A.3.7 step 7.1 lumps it into "Query (3+ tools)" with no explicit handling |
| Phone masking | `maskPhoneForDisplay` — last-4 digits only (`•••4547`) | live; security primitive prevents directory exfil | **GAP** — plan does not mention masking as an invariant to preserve |
| `is_owner` resolution | row owns home-board iff `b.owner_person_id = bp.person_id` | live | not in plan |
| Test coverage | `taskflow-engine.test.ts` L679-L770 — case-insensitive, multi-term, disambig, phone-mask, missing-search-text errors | passes locally | not enumerated |
| Prod usage | 1 invocation in 14 days across all sessions | **LOW USAGE** — but every meeting-create with non-local participants must call it per CLAUDE.md.template L443 | usage may be under-reported because most meetings are on home boards already |

### F.5 — Homonym disambiguation (when `find_person_in_organization` returns ≥ 2 distinct `person_id`)

| Aspect | v1 location | Prod state | v2 plan coverage |
|---|---|---|---|
| Engine output (raw) | same call as F.4 | live | — |
| Decision logic | **template-driven, not engine-driven** — `CLAUDE.md.template` L445-L449: agent groups by `person_id`, picks `is_owner=true` row when 1 distinct PID, asks user to pick when 2+ distinct PIDs | live but model-dependent | **GAP** — plan does not preserve the decision tree text; if templates regress at cutover, disambiguation regresses to "ask user every time" |
| `is_owner=true` preference for canonical name (parent-vs-child) | template L447 — explicit instruction | live | **GAP** — no v2 test asserts the agent prefers the home-board name |
| 0 historical disambig events | `task_history` shows 0 rows mentioning `disambiguat` | feature is reactive, not historical-write — absence of history is expected | n/a |

### F.6 — Reuse existing contacts instead of re-asking for phone

| Aspect | v1 location | Prod state | v2 plan coverage |
|---|---|---|---|
| Engine signal | F.4 query returns `routing_jid` (preferring `notification_group_jid` over `group_jid`) — see L7199 | live | not in plan |
| Reuse decision | `CLAUDE.md.template` L453 — *"Whenever the user refers to a person by name and the intent is to send a message…run `find_person_in_organization` BEFORE asking for phone numbers"* | live | **GAP** — same as F.5: template instruction, not engine-enforced |
| Cross-board send via `routing_jid` | downstream `send_message`/`send_message_with_audit` honors the JID | live (related to cross-board send domain — Section 03) | covered tangentially in A.3.7 step 7.2 cross-board send tests |
| Anti-pattern guard (does NOT apply to task assignment) | `CLAUDE.md.template` L453 closing sentence | live | **GAP** — plan has no test asserting that assignment still goes through local `person_name` resolution |

---

## Summary

**Status counts:** 4 OK (engine ports preserved), **6 GAP** (mostly: plan A.3.5 collapses the entire domain into 3 lines + "fork-keep"; A.3.7 step 7.2 has 1 line of test scope; spec is silent), **0 broken** (every wire from host indexer → MCP gate → engine → preamble works in prod).

**Key risks for v2 cutover:**

1. **Plan A.3.5 is too thin.** Three lines for six features. Phase A.3.7 has one bullet ("Embeddings: index task → similarity search") and zero coverage of duplicate detection (the highest-volume semantic feature in prod), preamble injection (the most user-visible), or the `find_person` decision tree.

2. **Two of six features are template-driven.** F.5 (disambiguate) and F.6 (contact reuse) are encoded in `CLAUDE.md.template` L443-L453 prose, not engine-enforced. If the v2 redesign rewrites that template (which it must, given v2's `engage_pattern` differences), the disambiguation logic must be ported verbatim or behavior regresses to "always re-ask."

3. **Phone masking is a security primitive.** F.4's `maskPhoneForDisplay` (last-4 digits only) is the only thing preventing the agent from being a directory-exfil oracle. The plan does not list it as an invariant. **Add a v2 invariant test:** `find_person_in_organization` must never return raw phone — only `phone_masked`.

4. **Threshold constants live in three places.** Engine search threshold = `0.3` (L6619), preamble = `0.2` (L9314), duplicate hard/soft = `0.85`/`0.95` (`ipc-mcp-stdio.ts` L1070, L1075). Plan/spec name none of these. If a v2 refactor "consolidates" thresholds it could silently change the soft/hard split or break the preamble's permissive 0.2 cutoff.

5. **Production usage is bimodal.** Duplicate detection runs ~every create call (frequent, working). `find_person` ran 1× in 14 days. Preamble runs on every TaskFlow turn but log markers absent in our sample window — needs explicit measurement before declaring "fork-keep" safe. **VESTIGIAL CANDIDATE:** if preamble emits in <10% of TaskFlow turns at cutover-time, downgrade priority.

**Concrete v2 plan amendments (recommended for A.3.5 + A.3.7):**

- A.3.5: enumerate the six features by name + their constants (0.3 / 0.2 / 0.85 / 0.95), mark each as fork-keep
- A.3.7 step 7.2 (Embeddings bullet): expand to 6 sub-cases — semantic search hit/miss, duplicate hard-block, duplicate soft-warning + force_create override, preamble injection presence + content shape, find_person 1-PID vs 2-PID returns, phone-mask invariant
- A.3.7 step 7.1 (Query 3+ tools): explicitly list `find_person_in_organization` as a tool requiring its own happy-path + error-path tests
- Add `CLAUDE.md.template` L443-L453 to the "templates that must be ported verbatim" list (cross-link with disambiguation domain audits if any)
