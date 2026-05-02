# Phase A.1 — Skill Divergence Audit (2026-05-01)

> **Status:** awaiting user sign-off on debt-disposition decisions before Phase A.2 starts.

## Executive summary

| Metric | Count |
|---|---|
| Total fork-divergent files vs `upstream/main` | **143** (114 added + 29 modified + 1 renamed; deletions excluded) |
| Total LOC of divergence | **~65,000** (insertions + deletions) |
| Files covered by our 6 skills | **54 (37.8%)** — 38,561 LOC (59.3%) |
| Files in DEBT (no-skill home) | **89 (62.2%)** — 26,424 LOC (40.7%) |

**Pinned upstream baseline:** `1b08b58f` (`upstream/main` HEAD at 2026-05-01).
**Fork-point:** `eba94b72` (2026-04-15). 603 upstream commits since fork; 915 fork-side commits since fork.

**Headline:** our 6 skills cover the load-bearing 60% of fork code by LOC (the big TaskFlow + audit + memory + context runtimes), but 89 files (~26K LOC) of fork divergence don't fit any of our skills. That's the debt to triage.

## Our 6 skills (confirmed)

| Skill | Files | LOC | Status |
|---|---|---|---|
| `add-taskflow` | 29 | 23,204 | ✅ confirmed; biggest skill — TaskFlow runtime, scheduler, board provisioning, cross-board, migrate-claude-md scripts, sender-allowlist, DM routing, tz-util, session-commands |
| `add-embeddings` | 14 | 7,902 | ✅ confirmed; absorbs auditor heredoc + semantic-audit + Kipp + digest-skip + audit-actor (semantic-audit uses embeddings) |
| `add-long-term-context` | 6 | 6,184 | ✅ confirmed; per-board context DB, DAG/rollup, qwen3-coder summarization, MCP tools |
| `add-taskflow-memory` | 5 | 1,271 | ✅ confirmed; Redis-backed memory layer, agent-memory-server v0.13.2 |
| `whatsapp-fixes` | 9 | 3,264 | ✅ confirmed. **Scope revised** (see "WhatsApp surface" section below): v2's `ChannelAdapter` is intentionally minimal — `createGroup`/`lookupPhoneJid`/`resolvePhoneJid`/`setTyping`/`syncGroups` are NOT in v2; this skill carries them as fork extensions on top of upstream's adapter. ~300-400 LOC modify/ patch (not the "100 LOC" earlier estimate). |
| `add-travel-assistant` | 0 | 0 | ✅ confirmed; entirely skill-internal — no codebase divergence beyond what's already in skill |

**Total: 54 files / 38,561 LOC under skill ownership.**

(Note: file counts assume audit-level classification; some files may belong to multiple skills via different `modify/<path>` patches. Actual skill-extraction work in Phase A.2 will refine these.)

## Debt categories (89 files, 26,424 LOC)

Files that don't cleanly fit our 6 skills. Each row needs a disposition decision before Phase A.2 starts.

| Category | Files | LOC | Disposition options |
|---|---|---|---|
| **multi-skill core** (`src/types.ts`, `src/index.ts`, `src/container-runner.ts`, `src/db.ts`, `src/config.ts`, `src/env.ts`, `src/log.ts`, `src/db.test.ts`, `src/db-migration.test.ts`) | 9 | 5,831 | These have additions from MANY skills. Each skill that adds something must capture its piece in `modify/<path>` + `.intent.md`. Track A Phase A.3 redistributes. |
| **multi-skill setup** (`setup/*` — register, container, env, mounts, service, verify, groups, timezone) | 12 | 1,720 | Setup orchestration touched by many features. Same redistribution pattern. |
| **multi-skill container** (`container/Dockerfile`, `container/agent-runner/src/index.ts`, `db-util.ts`, `runtime-config.ts`, `ipc-mcp-stdio.ts`, `ipc-tooling.ts`) | 9 | 3,530 | Per-skill `modify/<path>` redistributes. |
| **no-skill: ipc-plugins** (`src/ipc.ts`, 9 `src/ipc-plugins/*.ts`) | 8 | 3,756 | Mostly TaskFlow-supporting plugins (provision-shared, send-otp, create-group, provision-child-board, provision-root-board). **Recommend: absorb into `add-taskflow/modify/`** since TaskFlow is the consumer. |
| **multi-skill router** (`src/router.ts`, `src/routing.test.ts`) | 2 | 741 | Per-skill `modify/<path>` for routing hooks. |
| **multi-skill or upstream-overlap** (`src/timezone.ts`, `src/group-sender.ts`, `src/channels/index.ts`, `src/channels/registry.ts`, `src/container-runtime.ts`, `src/transcription.ts`, etc.) | 9 | 462 | Distribute across skills that touch them. |
| **multi-skill or ops** (`src/agent-runner-ipc-tooling.test.ts`, `src/ipc-auth.test.ts`, `src/ipc-dm-auth.test.ts`) | 3 | 1,117 | TaskFlow uses these; absorb into `add-taskflow/modify/`. |
| **no-skill: session-management** (`src/session-cleanup.ts`, `src/session-commands.ts`, `src/session-commands.test.ts`) | 3 | 435 | Session commands (`/undo`, `/forward`) are TaskFlow features. **Recommend: absorb into `add-taskflow`**. |
| **no-skill: remote-control** (`src/remote-control.ts`, `src/remote-control.test.ts`) | 2 | 621 | What is this? Need to inspect. |
| **no-skill: outbound-resilience** (`src/outbound-dispatcher.ts`, related schema) | 2 | 507 | The 2026-04-14 SIGKILL-resilience fix. Generic NanoClaw improvement, not TaskFlow-specific. **Decision needed: absorb into `add-taskflow` (since TaskFlow drove the need), upstream as PR, or accept loss?** |
| **excluded: add-agent-swarm** | 2 | 1,242 | Confirmed as not-ours. **Skill REMOVED 2026-05-01** (`.claude/skills/add-agent-swarm/` deleted; 26 files). Runtime files (`src/agent-swarm.ts`, `src/agent-swarm-monitor.ts`, `src/group-queue.ts`) remain in codebase as orphaned debt — die at cutover when `src/` is reset to upstream. `SWARM_SSH_TARGET` not set in `.env` → not in active use → no production impact. |
| **upstream: native-credential-proxy** | 2 | 324 | Fork-private divergence in `src/credential-proxy.ts`. v2 cutover replaces this with self-hosted OneCLI. Drop. |
| **upstream: channel-formatting** (`src/text-styles.ts`) | 1 | 337 | upstream has a `channel-formatting` skill branch. Use upstream's instead of fork-private. |
| **ops-tooling** (`scripts/deploy.sh`, `scripts/cleanup-sessions.sh`, etc.) | 3 | 261 | Not skill territory — these are ops scripts. Keep but document outside skills. |
| **migration-time obsolete** (`scripts/migrate-v2-patches/*`) | 2 | 61 | Created during this session's reverted work. Drop. |
| **docs / not skill** | 2 | 281 | `scripts/e2e-live-tests.md`, README files. Move to `docs/` or absorb. |
| **multi-skill deps** (`package.json`) | 1 | 14 | Per-skill manifest declares its own npm_dependencies. |
| **UNCLASSIFIED** | 8 | 1,920 | Need manual review (mostly tests + small utilities). |

## Decisions needed before Phase A.2

### Decision 1: How to absorb the IPC plugins — RESOLVED 2026-05-01

8 files (3,756 LOC) — `src/ipc.ts` + `src/ipc-plugins/{create-group,send-otp,provision-shared,provision-child-board,provision-root-board}.ts` and tests.

**v2 architectural finding (per `https://github.com/qwibitai/nanoclaw` README):** v2 has **NO IPC** as a concept — eliminated by design. The README explicitly states "no cross-mount contention, no IPC, no stdin piping." The two-DB session model (`inbound.db` host-write / `outbound.db` container-write) replaces IPC entirely. Container writes structured action payloads to `outbound.db`; host's delivery sweep picks up and routes to handlers registered via `registerDeliveryAction(action, handler)` in `src/delivery.ts`.

**v2 architectural translation of our 5 plugins:**

| v1 plugin | v2 shape |
|---|---|
| `create-group.ts` (155 LOC) | New MCP tool `create_group` in `add-taskflow/add/container/agent-runner/src/mcp-tools/create-group.ts` + delivery action handler in `add-taskflow/add/src/delivery-actions/create-group.ts` (calls `WhatsAppChannel.createGroup()`). |
| `send-otp.ts` (54 LOC) | MCP tool `send_otp` + delivery action handler — same pattern. |
| `provision-root-board.ts` + `provision-child-board.ts` + `provision-shared.ts` (1668 LOC) | 2 MCP tools (`provision_root_board`, `provision_child_board`) + 2 delivery action handlers. The handlers internally call v2's `src/db/agent-groups.ts` + `src/db/messaging-groups.ts` helpers (which already exist in upstream). The bulky logic stays roughly the same; what disappears is the v1 IPC dispatcher boilerplate. |

**Resolved disposition:** absorb into `add-taskflow/modify/` and `add-taskflow/add/`. Result will be ~10-12 small skill files (5 MCP tool definitions + 5 delivery action handlers + 2 register-patch `modify/<index>.ts` files), totaling ~1.5-2K LOC (down from 3.8K LOC) since v2's helpers do the heavy lifting and the IPC dispatcher boilerplate disappears.

**Net win:** v2's "no IPC" design makes this cleaner than v1, not harder.

### Decision 2: outbound-resilience (SIGKILL-recovery) — RESOLVED 2026-05-01

2 files (507 LOC). v1's `src/outbound-dispatcher.ts` (1255 LOC including the `outbound_messages` schema additions) was the 2026-04-14 fix to prevent message loss on SIGKILL.

**v2 architectural finding:** v2 has SIGKILL-recovery NATIVELY:
- **Durable** `outbound.db` — persists across host crashes (the v1 problem was an in-memory queue).
- **Retry logic** in `src/delivery.ts` (`MAX_DELIVERY_ATTEMPTS`, "will retry" path).
- **Auto-reset** of stuck `processing` rows by `host-sweep.ts` when container restarts.

What v1's dispatcher provides that v2 doesn't: an explicit `drain()` window with `DRAIN_QUIET_MS` + per-row `SEND_TIMEOUT_MS` for graceful shutdown. v2 doesn't have this graceful-drain primitive, but v2's retry-on-restart absorbs the failure mode (in-flight messages just retry on next boot).

**Resolved disposition: DROP.** v2's native durability makes our v1 fix unnecessary. 2 files (507 LOC) deleted at cutover, no skill carries them.

### Decision 3: session-cleanup + session-commands — RESOLVED 2026-05-01

3 files (435 LOC):
- `src/session-cleanup.ts` (24-line wrapper that runs `scripts/cleanup-sessions.sh` every 24h)
- `src/session-commands.ts` + `src/session-commands.test.ts` (handles `/compact` slash command)

**Findings:**
- `session-cleanup.ts` is a generic disk-cleanup cron. v2's `session-manager.ts:clearOutbox` cleans outboxes per-message automatically. Periodic deletion of OLD session directories is a separate concern that v2 may not handle natively, but it's a low-risk gap (a few MB/year of stale session dirs).
- `session-commands.ts` is owned by the **`add-compact` skill** (which came from upstream PR #817 per git history) — it's an upstream-derived feature, NOT one of our 6 ours-skills. The runtime is in our codebase but the skill itself is upstream.

**Resolved disposition:**
- `session-cleanup.ts` → DROP at cutover. Acceptable disk-management gap; revisit if it becomes a problem.
- `session-commands.ts` → owned by upstream's `add-compact` skill. v2 cutover replays `add-compact` from upstream; no fork-private work needed. **CAVEAT:** verify `add-compact` skill's `manifest.yaml` declares `session-commands.ts` ownership at Phase A.5 gate. Currently `add-compact` only has `SKILL.md` — no manifest yet. If the skill doesn't declare it, file an upstream PR or carry it as fork-private documentation in a `tracking/` doc.

### Decision 4: remote-control — RESOLVED 2026-05-01

2 files (621 LOC). `src/remote-control.ts` implements `/remote-control` slash command: from a WhatsApp message in the main group, the operator can spawn a Claude Code instance on the host's working directory and get back a `https://claude.ai/code/...` URL to access it remotely. State persists in `data/remote-control.json`; stdout/stderr captured to log files.

**Use case:** operator can debug/fix the running NanoClaw from anywhere via a chat message instead of SSH-ing to the host.

**Disposition options:**
- (a) Absorb into one of our 6 skills — but it doesn't fit any of them (not TaskFlow-specific, not channel-specific, not memory/context/embeddings).
- (b) Create a 7th ours-skill `add-remote-control` — violates the 4-6 cap.
- (c) DROP — operator loses the convenience but can still SSH manually.

**Resolved disposition: DROP.** Operator convenience feature; SSH replaces it. 2 files (621 LOC) deleted at cutover. No skill needed.

### Decision 5: agent-swarm — RESOLVED 2026-05-01

Confirmed not-ours; **skill REMOVED** (commit `324445ed`, 26 files deleted). Runtime files (`src/agent-swarm.ts`, `src/agent-swarm-monitor.ts`, `src/group-queue.ts`) remain in codebase as orphaned debt — die at cutover when `src/` is reset to upstream. `SWARM_SSH_TARGET` not in `.env` → no production impact.

### Decision 6: the multi-skill files — RESOLVED (methodology)

29 files across `multi-skill core / setup / container / router / overlap`. These have additions from MANY skills.

**Resolved methodology:** during Phase A.2/A.3, for each shared file (e.g., `src/types.ts`), every skill that adds something captures ITS piece in `modify/<path>` + `.intent.md`. The file in `src/` becomes a downstream artifact; each skill's `modify/<path>` records the skill-specific deltas. When the skill replays at cutover, all skills' modifications layer onto the upstream-shape file in dependency order.

**Practical pattern (per `add-image-vision/manifest.yaml`):**
```yaml
modifies:
  - src/types.ts                # add-image-vision adds ImageContentBlock type
  - src/index.ts                # add-image-vision wires processImage hook
  - container/agent-runner/src/index.ts  # add-image-vision adds image MCP tool
```

Each `modify/<path>` is the file's content AS IT SHOULD BE after this skill applies. Skill replay merges them via the migrate-nanoclaw skill's process (re-apply each skill in order on a fresh upstream worktree).

**Phase A.2 starts with `add-taskflow`** — the largest skill (29 files / 23K LOC) AND it touches the most multi-skill files. Once `add-taskflow` is well-formed, the pattern is established for the other 5 skills.

---

## WhatsApp surface (cross-skill investigation)

WhatsApp is more deeply integrated than just `whatsapp-fixes`. Several of our 6 skills consume WhatsApp methods that v2's deliberately-minimal adapter doesn't ship.

### v2 architecture: how WhatsApp lives

```
upstream/main           ← stable trunk; NO src/channels/whatsapp.ts
upstream/channels       ← feature branch; HAS src/channels/whatsapp.ts (735 LOC)
upstream/main:.claude/skills/add-whatsapp/SKILL.md
                        ← official mechanism: at install time, copies whatsapp.ts
                          FROM channels branch INTO local src/. No Chat SDK bridge.
```

At cutover the chain is: `git reset --hard upstream/main` → apply `add-whatsapp` (upstream's; pulls whatsapp.ts from channels branch) → apply our `whatsapp-fixes` ON TOP (modify/ patches + extensions).

### v2 `ChannelAdapter` interface (minimal by design)

```ts
interface ChannelAdapter {
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;
  // Inbound callbacks (channel calls these on host)
  onInbound(platformId, threadId, message: InboundMessage): void | Promise<void>;
  onInboundEvent(event: InboundEvent): void | Promise<void>;
  onMetadata(platformId, name?, isGroup?): void;
  onAction(questionId, selectedOption, userId): void;
  // SINGLE outbound entry — content.type discriminates
  deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined>;
}
```

`OutboundMessage.content.type` discriminates between `'send_message'`, `'send_file'`, `'ask_question'`, `'reaction'`, `'edit_message'`. NO `'create_group'`, NO `'lookup_phone'`, NO `'resolve_phone'`.

### What v2 already ships (verified in `upstream/channels:src/channels/whatsapp.ts`)

✅ LID mapping (full `lidToPhoneMap`, `setLidPhoneMapping`, `getPNForLID` + LID→assistant-name normalization)
✅ Reconnection with backoff
✅ Outgoing queue
✅ Group metadata cache
✅ getMessage fallback
✅ Pairing code auth (`setup/whatsapp-auth.ts:--method pairing-code --phone <X>`)
✅ ask_question outbound rendering (`pendingQuestions` map + `optionToCommand`)
✅ Reactions outbound (`content.operation === 'reaction'`)
✅ File outbound

### What v2 is MISSING (verified by grep — zero matches)

❌ `createGroup` / `groupCreate` — no agent-driven WhatsApp group creation
❌ `lookupPhoneJid` / `onWhatsApp` — no phone-number-to-JID validation
❌ `resolvePhoneJid` — no phone-to-JID resolution for outbound routing
❌ `setTyping` — no typing indicator API (presence updates exist internally but not exposed)
❌ `syncGroups(force)` — internal sync runs, but no force-API
❌ Per-group trigger pattern check (`isBotMessage` only checks global `ASSISTANT_NAME`, not per-group `engage_pattern`)

### Consumers across our skills

| v1 method | Files calling | Skill that needs it |
|---|---|---|
| `createGroup` | 4 files | `add-taskflow` (board provisioning auto-creates WhatsApp group) |
| `lookupPhoneJid` | 3 files | `add-taskflow` (validates participant phones before adding) |
| `resolvePhoneJid` | 3 files | `add-taskflow` + IPC routing |
| `setTyping` | 2 files | core (not skill-specific; UX) |
| `syncGroups` | 1 file | core (periodic refresh) |
| Per-org `engage_pattern` (`@Case` etc.) | board seed scripts (data, not code) | `add-taskflow` — writes `messaging_group_agents.engage_pattern` per board. v2's router consults this natively. NOT a `whatsapp-fixes` concern. |

### Resolved disposition

`whatsapp-fixes` skill **does NOT shrink to ~100 LOC** as I estimated earlier. It carries the FORK CAPABILITY LAYER on top of upstream's minimal adapter:

```
.claude/skills/whatsapp-fixes/
├── manifest.yaml
│   modifies:
│     - src/channels/whatsapp.ts   # extend with createGroup, lookupPhoneJid,
│                                   # resolvePhoneJid, setTyping, syncGroups
├── modify/src/channels/whatsapp.ts          (~300-400 LOC of fork additions)
├── modify/src/channels/whatsapp.ts.intent.md (semantic contract for replay)
└── tests/whatsapp-extensions.test.ts
```

Plus extends `OutboundMessage.content.type` with new variants (`'create_group'`, `'lookup_phone'`, `'resolve_phone'`, `'sync_groups'`). The matching delivery-action handlers live in `add-taskflow/add/src/delivery-actions/` (since `add-taskflow` is the consumer).

### DM routing relocation

`src/dm-routing.ts` + tests (currently in `whatsapp-fixes`) move to `add-taskflow`. Reason: it reads `taskflow.db` for meeting participant lookup — purely TaskFlow-specific, not WhatsApp-generic.

### Path forward (architectural recommendation)

The 5 missing methods (`createGroup`, `lookupPhoneJid`, `resolvePhoneJid`, `setTyping`, `syncGroups`) are **generic capabilities, not fork-private**. Upstream may have intentionally kept them out of `ChannelAdapter` to allow heterogeneous channels (Slack/Discord don't have WhatsApp's group-creation semantics), but agent-driven group creation is a feature any multi-channel deployment would want.

**Recommendation: hybrid approach**
- **Now (Track A):** carry these as fork-private extensions in `whatsapp-fixes`. Ship cutover.
- **Post-cutover:** submit upstream PR proposing these as ChannelAdapter additions (or a sibling `ChannelAdapterExtras` interface that channels opt into). When upstream merges, our `whatsapp-fixes` skill shrinks accordingly.

This eliminates fork divergence over time without blocking the migration.

### Implications for Phase A.2

`add-taskflow` extraction (Phase A.2 start) consumes `whatsapp-fixes`'s extended adapter. Order:

1. `whatsapp-fixes` skill authored FIRST (extends `Channel` + delivery types)
2. `add-taskflow` extraction depends on the extended interface
3. Sequencing: Phase A.2 = whatsapp-fixes (~1 week — substantial modify/ + tests). Phase A.3 = add-taskflow (~3 weeks; consumes whatsapp-fixes outputs).

Original v3.0 plan said "Phase A.2 = add-taskflow first." Re-prioritizing: **Phase A.2 = whatsapp-fixes** (small, foundational, unblocks add-taskflow). Phase A.3 = add-taskflow.

---

## Decisions summary table

| # | Disposition | Files | LOC | Net |
|---|---|---|---|---|
| 1 | Absorb into `add-taskflow` (as v2 MCP tools + delivery actions) | 8 → ~12 | 3756 → ~1700 | -2K LOC, cleaner architecture |
| 2 | DROP (v2 has native durable outbound + retry) | 2 | 507 | -507 LOC |
| 3a | DROP `session-cleanup.ts` (acceptable gap) | 1 | 24 | -24 LOC |
| 3b | `session-commands.ts` owned by upstream `add-compact` (verify at A.5) | 2 | 411 | 0 (carries through upstream) |
| 4 | DROP `remote-control` (operator uses SSH) | 2 | 621 | -621 LOC |
| 5 | `add-agent-swarm` REMOVED (skill deleted; runtime dies at cutover) | 2 | 1242 | -1242 LOC |
| 6 | Methodology: each skill captures its piece in `modify/<path>` + `.intent.md` | 29 | varies | distributed across skills |

**Net debt reduction:** ~5K LOC of fork code drops cleanly at cutover (decisions 2, 3a, 4, 5). Decision 1 absorbs 3.8K LOC into `add-taskflow` (with ~2K savings via v2 helpers). Decision 6 distributes 29 multi-skill files across our 6 skills' `modify/` trees. Decision 3b is upstream-tracked.

**Final ours-skill scope after all decisions resolved:** still 6 skills (no new ones added). `add-taskflow` grows from 29 files to ~41 files (29 + ~12 absorbed IPC). The other 5 skills stay roughly the same size.

## Coverage gaps in our 6 skills

Of our 54 ours-files, only 27 are currently captured in any skill's `manifest.yaml`-declared `add/`/`modify/` (per the existing `add-image-vision` template). The other ~27 files are physically in `src/` but the skills don't yet declare ownership.

Per-skill manifest gaps:
- **add-taskflow** — currently has NO `manifest.yaml` (skill is "natural-language only"; SKILL.md describes the runtime but doesn't declare files). Phase A.2 authors the manifest from scratch.
- **add-embeddings** — no manifest yet; needs one declaring auditor + semantic-audit + Kipp adoption.
- **add-long-term-context** — has SKILL.md only; needs full add/+modify/ tree.
- **add-taskflow-memory** — already has well-formed manifest + add/ + modify/ (per earlier inspection). Light work needed.
- **whatsapp-fixes** — needs manifest + add/+modify/ tree.
- **add-travel-assistant** — currently no codebase divergence; verify nothing's leaking.

## What Phase A.2 produces

For each of our 6 skills:
1. `manifest.yaml` declaring all `add:` files and `modify:` paths.
2. `add/<path>` containing each net-new file.
3. `modify/<path>` containing the modified version of each existing file.
4. `modify/<path>.intent.md` describing WHAT the modification does and WHY (semantic contract for replay across upstream evolution).
5. `tests/` for skill-replay validation.

When complete, applying the skill against a fresh `upstream/main` clone produces a working clone of the feature.

## Pinned upstream baseline

Track A starts against:
- **`upstream/main` = `1b08b58f`** (2026-05-01)
- Re-pin between Track A completion and Track B cutover (drift trajectory ~25 commits/day).

## Audit artifact

Full per-file CSV at: `/root/nanoclaw/docs/superpowers/audits/2026-05-01-skill-divergence-audit.csv` (143 rows, columns: `path, status, loc, owner-skill, coverage, effort`).

Sortable by skill, by LOC, by coverage status. Use this to drive Phase A.2 task planning.

## Next step

Once you sign off on Decisions 1-6 above, I can:
- Re-run the classification with your final dispositions
- Estimate per-skill extraction effort with the agreed scope
- Hand off Phase A.1 → Phase A.2 (start with `add-taskflow` — biggest skill, ~3 weeks)
