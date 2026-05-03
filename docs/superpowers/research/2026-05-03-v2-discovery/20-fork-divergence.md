# 20 — Fork Divergence Map (v1 fork `main` ↔ `upstream/v2`)

**Date:** 2026-05-03
**Repos compared:** `/root/nanoclaw` `main` (v1 fork, head `561ad3cd`) vs `upstream/v2` (head `5ae66624`)
**Refresh basis:** `docs/superpowers/audits/2026-05-01-skill-divergence-audit.csv` (144 rows, host paths only). This document supersedes it for the v2 cutover plan.

---

## TL;DR

| Bucket | Lines changed (vs v2) | What it is |
|---|---:|---|
| `docs/` | 66,890 | plans, audits, post-mortems — fork-only documentation, not shipped to v2 |
| `src/` | 39,838 | host code — half is files v2 doesn't have (pure ADD), half is heavy mods to shared filenames |
| `container/` | 39,433 | agent-runner code — `taskflow-engine.ts` alone is 9,598 lines |
| `.claude/skills/` | 28,325 | 16 fork-private skills + heavy edits to 4 shared SKILL.md files |
| `groups/` | 14,887 | per-board CLAUDE.md (10 prod boards × ~1,316 lines) — operational data, not migrated |
| `setup/` | 8,985 | shared-name files reshaped + a few v1-only files |
| `package*.lock` | 8,168 | lockfile churn |
| `scripts/` | 3,792 | 22 v1-only ops scripts; 8 v2-only test scripts |
| `plugins/` | 3,599 | `plugins/image-vision/` — fork-only plugin tree (skill ships it via `add/plugins/image-vision/`) |

**Total divergence:** 214,118 lines across 669 files.

**Summary across the 5 fork-private skills** (Track A targets):

- 12 of the 13 highest-LOC ADD files in `src/` and `container/` map cleanly to a fork-private skill.
- 16 fork-private skills already exist on disk; **5 of them ship full source** (`add-image-vision`, `add-pdf-reader`, `add-taskflow-memory`, `add-voice-transcription`, `whatsapp-fixes`-as-intent). The other 11 are SKILL.md-only stubs whose source still lives in trunk.
- Top 5 highest-divergence files (`taskflow-engine.ts`, `taskflow-engine.test.ts`, `add-taskflow/tests/taskflow.test.ts`, `src/index.ts`, `src/container-runner.ts`) account for **27,892 of 214,118 lines** (13%). Three of those five are owned by `add-taskflow`; the other two are heavy modifications shared by `add-image-vision` + `add-taskflow-memory`.
- Skill-only absorption is feasible for **~85% of the divergence by volume** (everything in `docs/`, `groups/`, `plugins/`, `.claude/skills/`, plus `add-*`-attributable files in `src/` and `container/`). The remaining ~15% (`src/index.ts`, `src/container-runner.ts`, `src/router.ts`, `src/types.ts`, root config, setup, scripts) is multi-skill or upstream-overlap and requires either modify-with-intent or upstream PRs.

---

## 1. Top 30 highest-divergence files

Lines = additions + deletions vs `upstream/v2`.

| # | Lines | Path | Category | Owner skill |
|---:|---:|---|---|---|
| 1 | 9,598 | `container/agent-runner/src/taskflow-engine.ts` | ADD | `add-taskflow` |
| 2 | 7,572 | `.claude/skills/add-taskflow/tests/taskflow.test.ts` | ADD (skill) | `add-taskflow` |
| 3 | 7,218 | `container/agent-runner/src/taskflow-engine.test.ts` | ADD | `add-taskflow` |
| 4 | 3,447 | `docs/superpowers/plans/2026-04-25-taskflow-memory-layer.md` | DOC | `add-taskflow-memory` |
| 5 | 3,373 | `package-lock.json` | LOCKFILE | DEBT (multi-skill deps) |
| 6 | 2,975 | `pnpm-lock.yaml` | LOCKFILE | DEBT — file removed in v2 cutover |
| 7 | 2,635 | `docs/plans/2026-02-25-agent-swarm-implementation.md` | DOC | (no Track A skill) |
| 8 | 2,518 | `docs/superpowers/plans/2026-03-10-external-meeting-participants.md` | DOC | `add-taskflow` |
| 9 | 2,435 | `docs/plans/2026-03-08-meeting-notes-implementation.md` | DOC | `add-taskflow` |
| 10 | 2,336 | `docs/superpowers/plans/2026-04-21-jurisdictional-holidays.md` | DOC | `add-taskflow` |
| 11 | 1,895 | `docs/superpowers/plans/2026-04-11-taskflow-feature-audit.md` | DOC | `add-taskflow` |
| 12 | 1,840 | `src/context-service.test.ts` | ADD | `add-long-term-context` |
| 13 | 1,791 | `plugins/image-vision/DEVELOPMENT.md` | DOC | `add-image-vision` |
| 14 | 1,777 | `docs/superpowers/plans/2026-04-15-semantic-audit-mvp.md` | DOC | `add-embeddings` |
| 15 | 1,734 | `container/agent-runner/src/semantic-audit.test.ts` | ADD | `add-embeddings` |
| 16 | 1,694 | `docs/plans/2026-02-24-taskflow-implementation.md` | DOC | `add-taskflow` |
| 17 | 1,628 | `docs/plans/2026-03-15-long-term-context-implementation.md` | DOC | `add-long-term-context` |
| 18 | 1,587 | `container/agent-runner/src/auditor-dm-detection.test.ts` | ADD | `add-embeddings` |
| 19 | 1,576 | `container/agent-runner/package-lock.json` | LOCKFILE | DEBT |
| 20 | 1,555 | `src/index.ts` | MOD (heavy) | DEBT (multi-skill core) — modify-with-intent |
| 21 | 1,549 | `container/agent-runner/src/ipc-mcp-stdio.ts` | ADD | DEBT (multi-skill container) |
| 22 | 1,459 | `container/agent-runner/src/auditor-script.sh` | ADD | `add-embeddings` |
| 23 | 1,421 | `docs/plans/2026-04-21-taskflow-api-phase6-task-mutations.md` | DOC | `add-taskflow` |
| 24 | 1,405 | `src/db.ts` | ADD-by-rename (v2 has `src/db/connection.ts`, 48 LOC) | DEBT (multi-skill core) |
| 25 | 1,356 | `src/channels/whatsapp.test.ts` | ADD | `whatsapp-fixes` (+covered by `add-image-vision`, `add-pdf-reader`, `add-voice-transcription`) |
| 26 | 1,350 | `container/agent-runner/src/semantic-audit.ts` | ADD | `add-embeddings` |
| 27 | 1,349 | `src/container-runner.ts` | MOD (heavy) | DEBT (multi-skill core) — modify-with-intent |
| 28 | 1,324 | `docs/plans/2026-04-20-taskflow-mcp-phase1.md` | DOC | `add-taskflow` |
| 29 | 1,317 | `groups/sec-secti/CLAUDE.md` | DATA | OPERATIONAL — not migrated, lives on prod box |
| 30 | 1,316 | `groups/ux-setd-secti-taskflow/CLAUDE.md` | DATA | OPERATIONAL |

---

## 2. v2 surface our v1 fork is missing (must absorb on cutover)

v2 introduces a **modular** layout. We must absorb (or stub) these directories:

### 2.1 New v2 modules under `src/modules/` (not in v1)

- `src/modules/permissions/` — `index.ts` (393 LOC), `access.ts`, `channel-approval.ts`, `sender-approval.ts`, `user-dm.ts`, `db/{users,user-roles,user-dms,agent-group-members,pending-channel-approvals,pending-sender-approvals}.ts`
- `src/modules/agent-to-agent/` — `agent-route.ts`, `create-agent.ts`, `write-destinations.ts`, `db/agent-destinations.ts`
- `src/modules/approvals/` — `index.ts`, `onecli-approvals.ts`, `picks.test.ts`, `primitive.ts`, `response-handler.ts` + `agent.md` / `project.md`
- `src/modules/scheduling/` — `actions.ts`, `db.ts`, `index.ts`, `recurrence.ts` (replaces our `src/task-scheduler.ts` entirely)
- `src/modules/self-mod/` — `apply.ts`, `request.ts`, `index.ts` + `agent.md` / `project.md`
- `src/modules/interactive/` — `index.ts` + agent/project markdown
- `src/modules/typing/` — `index.ts`
- `src/modules/mount-security/` — `index.ts` (we have flat `src/mount-security.ts`)

### 2.2 New v2 db layout (not in v1)

- `src/db/{connection,index,schema,sessions,agent-groups,messaging-groups,session-db,dropped-messages}.ts`
- `src/db/migrations/` — 7 migrations: `001-initial`, `002-chat-sdk-state`, `008-dropped-messages`, `009-drop-pending-credentials`, `010-engage-modes`, `011-pending-sender-approvals`, `012-channel-registration`, plus 3 module-scoped migrations

### 2.3 New v2 channels (not in v1)

- `src/channels/adapter.ts` (174 LOC) — base adapter v2 channels extend
- `src/channels/channel-registry.ts` (107 LOC) — registry contract
- `src/channels/ask-question.ts` — interactive prompt primitive
- `src/channels/cli.ts` — overhauled (in v1 too but very different)
- `src/channels/chat-sdk-bridge.ts` — overhauled

### 2.4 New v2 root host files

- `src/log.ts` (64 LOC) — replaces our `src/logger.ts` (120 LOC, has `child()` / `level` Baileys shims)
- `src/state-sqlite.ts`, `src/session-manager.ts` — host session lifecycle
- `src/webhook-server.ts`, `src/response-registry.ts`, `src/providers/{index,provider-container-registry}.ts`
- `src/claude-md-compose.ts`, `src/command-gate.ts`, `src/group-init.ts`
- `src/host-sweep.ts` (we have it but heavily diverged)

### 2.5 New v2 container/agent-runner

- `container/agent-runner/src/{config,destinations,formatter,integration.test,poll-loop,poll-loop.test,timezone,timezone.test}.ts`
- `container/agent-runner/src/db/{connection,index,messages-in,messages-out,session-routing,session-state}.ts`
- `container/agent-runner/src/mcp-tools/{agents,core,interactive,scheduling,self-mod,server,types,index}.ts` + 5 `*.instructions.md`
- `container/agent-runner/src/providers/{claude,factory,factory.test,index,mock,provider-registry,types}.ts`
- `container/agent-runner/src/scheduling/task-script.ts`

### 2.6 New v2 setup tooling

`setup/auto.ts`, `setup/auth.ts`, `setup/cli-agent.ts`, `setup/onecli.ts`, `setup/logs.ts`, `setup/probe.sh`, `setup/set-env.ts`, `setup/pair-telegram.ts`, `setup/lib/{agent-ping,browser,claude-assist,claude-handoff,diagnostics,role-prompt,runner,teams-manifest,theme,tz-from-claude}.ts` + 16 `setup/install-*.sh` and `setup/add-*.sh` shell helpers, plus `setup/channels/{discord,teams,telegram,whatsapp}.ts`.

---

## 3. Renames v2 did (path-only, ours doesn't track)

| v1 path | v2 path | Behavioral relation |
|---|---|---|
| `src/logger.ts` | `src/log.ts` | semantic shrink (v1 added `child()` / `trace()` / `level`); v2 file is 64 LOC vs our 120 |
| `src/db.ts` (1,415 LOC) | `src/db/connection.ts` (48 LOC) | structural split — v2 broke our monolithic db into `connection`, `schema`, `sessions`, `agent-groups`, `messaging-groups`, `session-db`, `dropped-messages` |
| `src/mount-security.ts` (~93 LOC, our copy) | `src/modules/mount-security/index.ts` | structural move into `modules/`; ~93 add / 94 delete on rename — true behavior diff is small |
| `src/task-scheduler.ts` (428 LOC) | `src/modules/scheduling/{db,actions,recurrence,index}.ts` | full rewrite — v2 has DB-backed scheduler with recurrence module |

We treat these as renames + behavior absorption, not as "deletions".

---

## 4. Categorized divergence — `src/`

### 4.1 Files in BOTH v1 and v2 (true MOD)

| Lines | Path | Category | Note |
|---:|---|---|---|
| 1,555 | `src/index.ts` | MOD heavy | OneCLI-optional require, taskflow imports, group-queue + scheduler wiring. Multi-skill: `add-image-vision`, `add-taskflow-memory`. **Modify-with-intent** is correct strategy. |
| 1,349 | `src/container-runner.ts` | MOD heavy | Image-vision env, taskflow mounts, credential-proxy placeholder. Multi-skill. |
| 542 | `src/router.ts` | MOD heavy | Engagement-pattern priority fix + PT-BR sender approval (see `scripts/migrate-v2-patches/`). Patches should be upstream PRs. |
| 305 | `src/types.ts` | MOD | Taskflow types — `add-taskflow` + `add-taskflow-memory`. |
| 92 | `src/container-runtime.test.ts` | MOD | Trivial drift |
| 90 | `src/container-runtime.ts` | MOD | Trivial drift |
| 85 | `src/config.ts` | MOD | `ASSISTANT_NAME`, group-queue settings. Multi-skill core. |
| 38 | `src/timezone.test.ts` | MOD | Local-TZ rendering. Trivial. |
| 22 | `src/channels/index.ts` | MOD | Telegram/whatsapp exports. Trivial. |
| 16 | `src/timezone.ts` | MOD | Trivial. |
| 14 | `src/group-folder.test.ts` | MOD | Trivial. |
| 7 | `src/env.ts` | MOD | Trivial — one env var. |
| 2 | `src/group-folder.ts` | MOD | Trivial drift. |

### 4.2 Files only in v1 (pure ADD — 62 files)

Grouped by suggested owner skill:

#### `add-taskflow` (host-side glue)

| Lines | Path |
|---:|---|
| 800 | `src/taskflow-db.test.ts` |
| 764 | `src/taskflow-db.ts` |
| 741 | `src/ipc-plugins/provision-child-board.ts` |
| 620 | `src/ipc-plugins/provision-child-board.test.ts` |
| 534 | `src/ipc-plugins/provision-root-board.ts` |
| 428 | `src/task-scheduler.ts` (will be deleted on v2 — replaced by `src/modules/scheduling/`) |
| 384 | `src/ipc-plugins/provision-shared.ts` |
| 282 | `src/ipc-plugins/create-group.test.ts` |
| 216 | `src/sender-allowlist.test.ts` |
| 182 | `src/task-scheduler.test.ts` |
| 170 | `src/routing.test.ts` |
| 155 | `src/ipc-plugins/create-group.ts` |
| 155 | `src/sender-allowlist.ts` |
| 153 | `src/dm-routing.ts` |
| 151 | `src/dm-routing.test.ts` |
| 116 | `src/phone.test.ts` |
| 83 | `src/ipc-plugins/provision-root-board.test.ts` |
| 41 | `src/phone.ts` |

**Subtotal:** ~6,775 LOC in `add-taskflow`-attributable host code that the skill currently does NOT ship.

#### `add-long-term-context`

| Lines | Path |
|---:|---|
| 1,840 | `src/context-service.test.ts` |
| 1,196 | `src/context-sync.test.ts` |
| 840 | `src/context-service.ts` |
| 648 | `src/context-sync.ts` |

**Subtotal:** ~4,524 LOC; skill currently SKILL.md-only.

#### `add-embeddings`

| Lines | Path |
|---:|---|
| 293 | `src/embedding-service.ts` |
| 276 | `src/embedding-service.test.ts` |
| 79 | `src/taskflow-embedding-sync.ts` |

**Subtotal:** ~648 LOC.

#### `whatsapp-fixes`

| Lines | Path |
|---:|---|
| 964 | `src/channels/whatsapp.ts` |
| 1,356 | `src/channels/whatsapp.test.ts` |
| 207 | `src/whatsapp-auth.ts` |
| 43 | `src/whatsapp-auth.test.ts` |

**Subtotal:** ~2,570 LOC. Skill currently has intent files only — full files live in trunk.

#### `add-image-vision` (already a baked skill)

| Lines | Path |
|---:|---|
| 86 | `src/image.test.ts` (mirrored at `.claude/skills/add-image-vision/add/src/image.test.ts`) |
| 66 | `src/image.ts` (mirrored similarly) |

These ARE shipped by the skill — confirmed.

#### `add-telegram` (shared skill — gap: source not shipped)

| Lines | Path |
|---:|---|
| 317 | `src/channels/telegram.ts` |
| 180 | `src/channels/telegram.test.ts` |

#### Multi-skill / DEBT

| Lines | Path | Notes |
|---:|---|---|
| 1,405 | `src/db.ts` | rename of `src/db/connection.ts`+ taskflow tables. Half belongs in `add-taskflow`. |
| 1,228 | `src/ipc.ts` | host IPC coordinator + agent-swarm + dm-auth + outbound-dispatcher hooks. Multi-skill. |
| 988 | `src/ipc-auth.test.ts` | multi-skill IPC auth |
| 888 | `src/db.test.ts` | mirrors `src/db.ts` |
| 764 | `src/group-queue.test.ts` | agent-swarm preemption |
| 680 | `src/formatting.test.ts` | should be `channel-formatting` |
| 478 | `src/group-queue.ts` | agent-swarm |
| 397 | `src/remote-control.test.ts` | no-skill |
| 337 | `src/text-styles.ts` | should be `channel-formatting` |
| 279 | `src/outbound-dispatcher.test.ts` | no-skill |
| 247 | `src/session-commands.test.ts` | no-skill |
| 228 | `src/outbound-dispatcher.ts` | no-skill |
| 224 | `src/remote-control.ts` | no-skill |
| 192 | `src/credential-proxy.test.ts` | upstream/native-credential-proxy |
| 163 | `src/session-commands.ts` | no-skill |
| 132 | `src/credential-proxy.ts` | upstream/native-credential-proxy |
| 120 | `src/logger.ts` | upstream — file should land in `src/log.ts` with our extensions |
| 112 | `src/ipc-plugins/send-otp.test.ts` | DEBT |
| 101 | `src/transcription.ts` | overlap with `src/modules/typing/` & whatsapp |
| 93 | `src/ipc-dm-auth.test.ts` | no-skill |
| 67 | `src/db-migration.test.ts` | DEBT |
| 65 | `src/agent-runner-ipc-tooling.test.ts` | DEBT |
| 55 | `src/logger.test.ts` | DEBT |
| 54 | `src/ipc-plugins/send-otp.ts` | DEBT |
| 42 | `src/channels/registry.test.ts` | trivial host wiring |
| 28 | `src/channels/registry.ts` | trivial host wiring |
| 25 | `src/session-cleanup.ts` | DEBT |
| 13 | `src/group-sender.ts` | DEBT |

**Subtotal — DEBT in `src/`:** ~9,395 LOC (24 files) that don't map cleanly to one of the 5 Track A skills.

---

## 5. Categorized divergence — `container/agent-runner/src/`

### 5.1 In BOTH (true MOD)

Only `container/agent-runner/src/index.ts` (1,128 LOC) is shared — it's modified heavily for taskflow + image-vision + memory. **Modify-with-intent**, owners: `add-taskflow`, `add-image-vision`, `add-taskflow-memory` (multi-skill).

### 5.2 v1-only (pure ADD)

| Lines | Path | Owner |
|---:|---|---|
| 9,598 | `taskflow-engine.ts` | `add-taskflow` |
| 7,218 | `taskflow-engine.test.ts` | `add-taskflow` |
| 1,734 | `semantic-audit.test.ts` | `add-embeddings` |
| 1,587 | `auditor-dm-detection.test.ts` | `add-embeddings` |
| 1,549 | `ipc-mcp-stdio.ts` | DEBT (multi-skill: agent-swarm + memory) |
| 1,459 | `auditor-script.sh` | `add-embeddings` |
| 1,350 | `semantic-audit.ts` | `add-embeddings` |
| 1,083 | `context-reader.test.ts` | `add-long-term-context` |
| 893 | `taskflow-mcp-server.test.ts` | `add-taskflow` |
| 611 | `taskflow-mcp-server.ts` | `add-taskflow` |
| 577 | `context-reader.ts` | `add-long-term-context` |
| 365 | `memory-client.ts` | `add-taskflow-memory` |
| 346 | `recent-turns-recap.test.ts` | `add-taskflow-memory` |
| 333 | `taskflow-embedding-integration.test.ts` | `add-embeddings` |
| 315 | `memory-client.test.ts` | `add-taskflow-memory` |
| 235 | `auditor-delivery-health.test.ts` | `add-embeddings` |
| 213 | `ipc-mcp-stdio.test.ts` | DEBT |
| 144 | `index-preambles.test.ts` | `add-taskflow-memory` |
| 129 | `runtime-config.ts` | DEBT |
| 123 | `runtime-config.test.ts` | DEBT |
| 120 | `embedding-reader.test.ts` | `add-embeddings` |
| 110 | `db-util.ts` | DEBT |
| 101 | `recent-turns-recap.ts` | `add-taskflow-memory` |
| 96 | `mcp-plugins/create-group.ts` | `add-taskflow` |
| 92 | `embedding-reader.ts` | `add-embeddings` |
| 74 | `auditor-prompt.txt` | `add-embeddings` |
| 62 | `ipc-tooling.ts` | DEBT |
| 59 | `digest-skip-script.sh` | `add-embeddings` |
| 8 | `tz-util.ts` | `add-taskflow` |

### 5.3 v2-only (must absorb)

`config.ts`, `destinations.ts`, `formatter.ts` (+test), `integration.test.ts`, `poll-loop.ts` (+test), `timezone.ts` (+test), `db/{connection,index,messages-in,messages-out,session-routing,session-state}.ts`, `mcp-tools/*` (8 files + 5 instructions.md), `providers/*` (7 files), `scheduling/task-script.ts`. **The agent-runner has been almost entirely restructured.**

---

## 6. Skills already on disk — what each ships vs what's still in trunk

| Skill | SKILL.md | manifest | Source files shipped? | Trunk paths still owned |
|---|:---:|:---:|---|---|
| `add-taskflow` | yes | no | tests + CLAUDE.md template only | `container/agent-runner/src/taskflow-{engine,engine.test,mcp-server,mcp-server.test}.ts` (18,320 LOC) + 11 `src/taskflow-db*` / `src/ipc-plugins/*` / `src/sender-allowlist*` / `src/dm-routing*` / `src/phone*` / `src/task-scheduler*` files (~6,775 LOC) |
| `add-image-vision` | yes | yes | `add/plugins/image-vision/`, `add/src/image*`, `modify/{src/channels/whatsapp*,src/container-runner.ts,src/index.ts,container/agent-runner/src/index.ts}` with `.intent.md` siblings + tests | mostly self-contained — DOES ship full source |
| `add-pdf-reader` | yes | yes | `add/container/skills/pdf-reader/`, `modify/{container/Dockerfile,src/channels/whatsapp*}` + intents + tests | mostly self-contained |
| `add-taskflow-memory` | yes | yes | `add/container/agent-runner/src/{index-preambles.test,memory-client,memory-client.test}.ts`, 6 `modify/.../*.intent.md` files, tests | source files ship; intent-only for shared host files |
| `add-voice-transcription` | yes | no | `add/src/transcription.ts`, `modify/src/channels/whatsapp.test.ts` | self-contained |
| `whatsapp-fixes` | yes | yes | `modify/src/channels/{adapter,whatsapp}.ts.intent.md` only + 1 test | full `src/channels/whatsapp.ts` (964) and `whatsapp.test.ts` (1356) and `src/whatsapp-auth*.ts` (250) still in trunk |
| `add-long-term-context` | yes | no | none — pure SKILL.md | 4,524 LOC in `src/context-{service,sync}*.ts` + 1,660 LOC in `container/agent-runner/src/context-reader*` |
| `add-embeddings` | yes | no | none | ~10,070 LOC in `container/agent-runner/src/{semantic-audit*,auditor-*,embedding-reader*,taskflow-embedding-integration.test,digest-skip-script.sh}` + `src/embedding-service*.ts` + `src/taskflow-embedding-sync.ts` |
| `add-telegram-swarm` | yes | no | none | overlaps `src/group-queue*.ts`, `src/ipc.ts` portions |
| `add-travel-assistant` | yes | no | template + tests | self-contained (template-only skill) |
| `add-gmail` | yes | no | none | (does not currently exist in trunk; SKILL.md is forward-looking) |
| `add-reactions` | yes | no | none | trunk paths TBD |
| `add-compact` | yes | no | none | trunk paths TBD |
| `channel-formatting` | yes | no | none | `src/text-styles.ts` (337), `src/formatting.test.ts` (680) |
| `use-local-whisper` | yes | no | none | overlaps `src/transcription.ts` |
| `add-emacs` | yes | (shared) | shared with v2 | — |

**Critical finding:** of the 5 fork-private skills targeted for Track A — `add-taskflow`, `add-taskflow-memory`, `add-long-term-context`, `add-embeddings`, `whatsapp-fixes` — only `add-taskflow-memory` ships meaningful source today. The others are SKILL.md stubs whose code lives in trunk under feedback rule "[NEVER touch the NanoClaw codebase — only edit skills]" — i.e., **the rule has been violated for all four**.

---

## 7. Hidden divergence (looks similar, differs semantically)

| File | What looks the same | What's actually different |
|---|---|---|
| `src/container-runner.ts` | name | v2 wraps `src/container-runtime.ts`; v1 inlines docker/apple-container split + cred-proxy placeholder + image-vision env + taskflow mounts. **+1,386 / -29.** |
| `src/index.ts` | bootstrap structure | v2 self-mod module wiring + permissions + scheduling are absent in v1; v1 has `OneCLI` optional require + group-queue + taskflow scheduler bootstrap. **+1,402 / -153.** |
| `src/router.ts` | engagement-pattern logic | v1 reorders priority (engage_pattern beats trigger_pattern when both match) and adds PT-BR approval phrases — see `scripts/migrate-v2-patches/01-engage-pattern-priority-fix.patch` and `02-pt-br-sender-approval.patch`. **Should land as upstream PRs.** |
| `src/logger.ts` ↔ `src/log.ts` | same role | v1 adds `child()`, `level`, `trace()` for Baileys ILogger compat (post pino → built-in migration). Renamed in v2; behavior absorption needed. |
| `src/types.ts` | type registry | +305 LOC of taskflow & memory types. |
| `container/agent-runner/src/index.ts` | bootstrap | `+982 / -146`; multi-skill wiring lives here. |
| `setup/whatsapp-auth.ts` | auth flow | +521 LOC pairing-code path (server-friendly). Belongs to `whatsapp-fixes`. |

---

## 8. Setup / scripts divergence

### 8.1 `setup/` — files in BOTH (with non-zero diff)

| Lines | Path | Note |
|---:|---|---|
| 521 | `setup/whatsapp-auth.ts` | pairing-code → `whatsapp-fixes` |
| 224 | `setup/register.ts` | multi-skill setup |
| 170 | `setup/container.ts` | multi-skill setup |
| 168 | `setup/verify.ts` | multi-skill setup |
| 99 | `setup/service.ts` | platform tweaks |
| 25 | `setup/environment.ts` | trivial |
| 20 | `setup/mounts.ts` | trivial |
| 16 | `setup/index.ts` | trivial |
| 4 | `setup/timezone.ts` | trivial |

`setup/groups.ts` and `setup/register.test.ts` are pure-ADD in v1.

### 8.2 `scripts/`

- **v1-only (22 files):** `audit-actor-match-diagnostic.mjs`, `create-group.mjs`, `deploy.sh`, `e2e-live-tests.md`, `generate-claude-md.mjs`, `lib/migrate-claude-md.mjs`, `magnetism-backfill.mjs`, 4 `migrate-claude-md-*.mjs`, `migrate-taskflow-{destinations,policies,users}.{ts,sql,ts}`, `migrate-v2-patches/{01,02}.patch + README`, `rollback-to-v1.sh`, `update-group-subject.mjs`, `upgrade-cross-board-forward-v1-to-v2.mjs`, `verify-taskflow-permissions.ts`, `find-dropped-messages.sql`. **Most are `add-taskflow` ops; deploy/rollback are ops-tooling DEBT.**
- **v2-only (8 files):** `chat.ts`, `init-cli-agent.ts`, `init-first-agent.ts`, `sanity-live-poll.ts`, `seed-discord.ts`, `test-v2-{agent,channel-e2e,host}.ts` — must absorb.
- **Shared:** `cleanup-sessions.sh` (+30 LOC drift), `run-migrations.ts` (no diff).

---

## 9. Test files divergence

Every host ADD file ships `*.test.ts` alongside in our v1 fork. None of them currently live in their owner skill's `tests/` directory:

| Skill | Test files in trunk that should migrate | Total test LOC |
|---|---|---:|
| `add-taskflow` | `taskflow-db.test.ts`, `task-scheduler.test.ts`, `provision-{root,child}-board.test.ts`, `create-group.test.ts`, `dm-routing.test.ts`, `sender-allowlist.test.ts`, `routing.test.ts`, `phone.test.ts`, `taskflow-engine.test.ts`, `taskflow-mcp-server.test.ts` | 18,180 |
| `add-long-term-context` | `context-service.test.ts`, `context-sync.test.ts`, `context-reader.test.ts` | 4,119 |
| `add-embeddings` | `semantic-audit.test.ts`, `auditor-dm-detection.test.ts`, `auditor-delivery-health.test.ts`, `taskflow-embedding-integration.test.ts`, `embedding-service.test.ts`, `embedding-reader.test.ts` | 4,285 |
| `whatsapp-fixes` | `channels/whatsapp.test.ts` (overlaps with `add-image-vision`/`add-pdf-reader`/`add-voice-transcription`!), `whatsapp-auth.test.ts`, `phone.test.ts` | 1,515 |
| `add-taskflow-memory` | `memory-client.test.ts`, `recent-turns-recap.test.ts`, `index-preambles.test.ts` | 805 |

The `whatsapp.test.ts` overlap is the single biggest test-migration headache — three different skills modify the same file in their `modify/` trees today.

---

## 10. Comparison vs `audits/2026-05-01-skill-divergence-audit.csv`

### What's confirmed

- The 144-row audit's owner-skill mapping for `src/` and `container/agent-runner/src/` is still accurate. None of those files have been added/removed/renamed in the 2 days since the audit.
- The "DEBT (multi-skill core)" classification on `src/{index,db,container-runner,router,types,ipc}.ts` is correct.
- LOC numbers are within 1% of today's `git diff --numstat` (audit was using a slightly older base; today's `taskflow-engine.ts` is 9,598 vs the audit's implied 9,598 — identical).

### What's new since the audit

1. **Skill-tree (`.claude/skills/`) is NOT included in the audit.** The audit only scans host paths. 28,325 lines of skill content (16 fork-private skills, 4 heavily-modified shared skills) are absent. Adding them changes the skill-coverage picture: 5 skills already ship full source on disk; the others are intent-only stubs.
2. **`docs/` and `groups/` are NOT included** — together 81,777 lines. Excluding them is correct for a code-divergence audit (they're not migrated to v2), but the v2 cutover plan must explicitly note "operational data: stays on prod box; not migrated".
3. **The `plugins/image-vision/` tree (3,599 lines)** is missing from the audit. It's already shipped via `add-image-vision/add/plugins/image-vision/`, so audit-wise it's COVERED.
4. **Renames:** the audit doesn't track v2's structural moves (`src/db.ts` → `src/db/connection.ts`, `src/logger.ts` → `src/log.ts`, `src/mount-security.ts` → `src/modules/mount-security/index.ts`, `src/task-scheduler.ts` → `src/modules/scheduling/`). On absorb, these become "delete v1 file, port behavior into v2 module" — the audit's `M` flag understates the work.
5. **Container/agent-runner restructuring missed:** v2 introduces `container/agent-runner/src/{config,destinations,formatter,poll-loop,db/*,mcp-tools/*,providers/*,scheduling/*}.ts` — ~30 new files we must absorb. The audit only flagged what we ADDED, not what v2 ADDED.

### Coverage delta for Track A

| Skill | Audit-assigned ADD/MOD lines | Skill ships those source files today? |
|---|---:|---|
| `add-taskflow` | 23,400 (engine + mcp-server + tests + host glue + scripts + provision) | NO — only tests/template ship |
| `add-long-term-context` | 6,184 | NO — only SKILL.md |
| `add-embeddings` | 9,180 | NO — only SKILL.md |
| `add-taskflow-memory` | 1,365 | YES (mostly) — memory-client + recent-turns-recap + intents |
| `whatsapp-fixes` | 3,200+ (whatsapp.ts/test + auth + phone + group-folder) | NO — intent files only |

Net: **Track A still has ~43,000 LOC of skill-private code physically located in trunk that needs to move into skill `add/` or `modify/` trees** before v2 cutover can proceed cleanly. The audit's "UNCOVERED" flag captures this; this document quantifies the volume.

---

## 11. Structured divergence table (master)

For brevity, only files >100 LOC. Full ~250-row table available via:

```
git diff --numstat upstream/v2..main | awk '$1+$2 >= 100 {print $1+$2"\t"$3}' | sort -rn
```

Key categorical totals (lines, files):

| Category | Lines | Files |
|---|---:|---:|
| ADD-skill-attributable (`src/` + `container/`) | 53,170 | 87 |
| ADD-DEBT (multi-skill or upstream-overlap) | 9,395 | 24 |
| MOD-skill-attributable | 1,485 | 3 |
| MOD-DEBT (multi-skill core) | 4,963 | 8 |
| Shared SKILL.md drift (5 channels: whatsapp, telegram, slack, discord, emacs) | 1,194 | 5 |
| Fork-private skill files (`.claude/skills/add-*`) | 28,325 | 117 |
| `docs/` (research/plans/audits) | 66,890 | 70+ |
| `groups/` (operational CLAUDE.md) | 14,887 | 11 |
| `plugins/image-vision/` (covered by skill) | 3,599 | 14 |
| Lockfiles | 8,168 | 4 |
| `setup/` (mostly DEBT multi-skill) | 8,985 | 22 |
| `scripts/` (mix: `add-taskflow` + ops DEBT) | 3,792 | 30 |
| Root config / CHANGELOG / README | 1,477 | 10 |

---

## 12. Verdict

- **Top 5 highest-divergence files:** `taskflow-engine.ts` (9,598), `add-taskflow/tests/taskflow.test.ts` (7,572), `taskflow-engine.test.ts` (7,218), `src/index.ts` (1,555), `src/container-runner.ts` (1,349). 4/5 owned by `add-taskflow` (file #4 and #5 are multi-skill).
- **Can skills absorb everything?** No. Of 214,118 line-changes:
  - **~85% can be skill-owned** once the four "intent-only" skills (`add-taskflow`, `add-long-term-context`, `add-embeddings`, `whatsapp-fixes`) physically move ~43k LOC from trunk into their `add/` and `modify/` trees.
  - **~15% is genuine DEBT or upstream overlap:** `src/{index,container-runner,router,types,ipc}.ts` modifications, `src/{group-queue,outbound-dispatcher,remote-control,session-commands,credential-proxy,logger,formatting,text-styles}*` files, multi-skill `setup/` mods, ops scripts, lockfiles. These need either:
    - **modify-with-intent** (skill ships an `.intent.md` and v2-cutover-time it patches the v2 file), or
    - **upstream PR** (especially the 2 `migrate-v2-patches/` items in `src/router.ts`, the `text-styles.ts` / formatting work which belongs in `channel-formatting`, and the credential-proxy code which overlaps with `use-native-credential-proxy`).
- **The 2026-05-01 audit is structurally sound but incomplete.** This document supersedes it for v2 cutover planning by adding skill-tree, docs, groups, plugins, renames, and v2-side absorption surface.

---

## 13. Where this document lives

`/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/20-fork-divergence.md`

Sibling docs in the same v2-discovery research bundle (01–19) cover migrations, central DB, session DBs, taskflow table placement, lifecycles, MCP, channels, kinds, send-message E2E, interactive prompts, router engagement, sender approval, user roles, destinations ACL, inbound lifecycle, schedule_task, skill apply, CI branches, production usage. This document (20) is the cross-cutting code-divergence baseline that informs the Track A migration plan.
