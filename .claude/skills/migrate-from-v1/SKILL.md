---
name: migrate-from-v1
description: Finish migrating a NanoClaw v1 install into v2. Run after `bash migrate-v2.sh` completes. Seeds the owner, cleans up CLAUDE.local.md files, reconciles container configs, and helps port custom v1 code. Triggers on "migrate from v1", "finish migration", "v1 migration".
---

# Finish v1 → v2 migration

`bash migrate-v2.sh` already ran the deterministic migration. It handled:

- .env keys merged
- v2 DB seeded (agent_groups, messaging_groups, wiring)
- Group folders copied (v1 CLAUDE.md → v2 CLAUDE.local.md)
- Session data copied with conversation continuity (incl. Claude Code memory + JSONL transcripts)
- Scheduled tasks ported
- Channel code installed and auth state copied (incl. WhatsApp Baileys keystore)
- WhatsApp LIDs resolved from `store/auth` and aliased into `messaging_groups`
- Container skills review deferred to Phase 4 (script no longer auto-copies; v1 skills with binary or path dependencies would have broken in v2)
- Container image built

Your job is the parts that need human judgment: triage any failed steps, seed the owner, clean up CLAUDE.local.md files, reconcile configs, and port any fork customizations.

Read `logs/setup-migration/handoff.json` first — it has `overall_status`, per-step results in `steps`, and a `followups` list.

## Preflight: was the script run?

Before anything else, check that `logs/setup-migration/handoff.json` exists. If it doesn't, the user is invoking this skill before `migrate-v2.sh` ran. Stop and tell them, verbatim:

> This skill finishes a migration that `migrate-v2.sh` started. Run that first, in your terminal — not from inside Claude:
>
> ```bash
> bash migrate-v2.sh
> ```
>
> It needs interactive prompts (channel selection, service switchover) and runs Node/pnpm bootstrap, Docker, OneCLI setup, and a container build that don't fit inside a Claude session. When it finishes, it'll hand control back to Claude automatically — at which point this skill picks up.

Do not attempt to run the script yourself, simulate its effects, or pick up the migration mid-stream. The deterministic side has dependencies on a real interactive shell.

Once `handoff.json` exists, proceed to Phase 0.

## Phase 0: Get v2 routing real messages

Before any deeper migration work, prove v2 actually answers messages on the user's real channels. v1 is paused, not touched — flipping back is a service restart.

### 0a — Triage migration honesty before any other work

Before walking step status, check `overall_status` and `degraded`:

- **`overall_status: "failed"`** — migration aborted. `aborted_at` names the abort reason. Do not proceed with smoke test or owner seeding. Read `logs/migrate-v2.log` and the matching step log under `logs/migrate-steps/`, fix the underlying cause with the user, then ask them to re-run `bash migrate-v2.sh`.
- **`overall_status: "degraded"`** OR **`degraded: true`** — migration ran to completion but a rollback / sudo-failure / non-fatal-error path fired. Walk `degraded_reasons` with the user verbatim. Each line names a manual remediation. Resolve every reason before Phase 0b — the typical cases:
  - `"v1 service (… , system/user) not restarted — sudo cache expired"` → user needs to run the suggested `systemctl` command, then confirm v1 is up before deciding whether to switch.
  - `"v1 service (… , launchd) not restarted"` → run the suggested `launchctl load` command (the reason quotes the exact plist path).
  - `"v1 (…) was not disabled"` → run the suggested disable command so v1 doesn't auto-restart on reboot and race v2.
  - `"v1 (…) could not be re-stopped at switchover"` → v1 came back between phases and the script's defensive re-stop failed; sudo cache likely expired. Restore sudo (`sudo -v`) or stop v1 manually with the command in the reason, then re-run `bash migrate-v2.sh`.
  - `"<step> reported N non-fatal error(s)"` → open `logs/migrate-steps/<step>.log`, grep for `^ERROR:`, decide per-row whether the skipped data needs hand-migration.
  - `"v2 service install failed"` → diagnose with `pnpm exec tsx setup/index.ts --step service`, then ask user to re-run `bash migrate-v2.sh`.
  - `"migration interrupted after v1 was stopped"` → v1 was auto-restored; ask user to re-run when they're ready.
  - `"stale v2 taskflow.db remains at data/taskflow/taskflow.db"` → remove the file (or move aside) before re-running migrate-v2.sh.
- **`overall_status: "partial"`** — at least one step failed without aborting. Continue to step-status triage below to determine whether the failure blocks the smoke test.

### 0a.1 — Fix step blockers

Walk `handoff.steps` for any `status: "failed"` or `status: "partial"` entries. Failed = step exited non-zero; partial = step exited 0 but emitted `ERROR:` lines for individual rows. Fix only the failures that would stop the bot from routing one message; defer the rest to its later phase.

**Absent ≠ success.** Several `migrate-v2.sh` steps only fire on certain branches (`2b-channel-auth`, `3a-docker`, `3b-onecli`, `3c-auth`, `3e-build`). When a step skips its `record_step` call, it's missing from `handoff.steps` entirely — silently. Don't assume "no entry = healthy." Run these explicit probes before Phase 0b:

- **Channels installed.** Read `handoff.channels_installed`. A literal `[""]` means headless re-run with no channel selection — `2b-channel-auth` and `2c-install-*` did not run. Confirm with the user which channels they expected, then run `setup/index.ts --step channels` (or the relevant `/add-*` skill) before continuing.
- **WhatsApp auth keystore.** If WhatsApp is in the installed channels (or `src/channels/whatsapp.ts` exists), check `store/auth/creds.json` is present. If it is not, copy `<handoff.v1_path>/store/auth/` to `./store/auth/` — without it the Baileys adapter never connects. Mention this to the user before doing the copy.
- **Docker daemon.** `docker info >/dev/null 2>&1` — required for container spawn even if `3a-docker` wasn't recorded.
- **OneCLI health.** `onecli health 2>/dev/null || onecli agents list 2>/dev/null` — confirms the gateway is running. Required if any channel uses OneCLI-injected secrets.
- **Anthropic credential.** `onecli secrets list 2>/dev/null | grep -i anthropic` — at least one credential must exist or the container can't call the model.
- **Container image.** `docker images nanoclaw-agent:latest --format '{{.ID}}'` returns non-empty.
- **TaskFlow main-control row.** `pnpm exec tsx scripts/q.ts data/v2.db "SELECT COUNT(*) FROM messaging_groups WHERE is_main_control=1;"` must return `1`. If it returns `0`, the main-control privileged tools (`provision_root_board`, `add_destination`, `send_otp`) fail-closed at `src/modules/taskflow/permission.ts:57` from any session. `create_group` and `provision_child_board` still work when invoked from a TaskFlow-board agent (they have a board-based auth path) but lose their main-control alternative. The typical bootstrap case — provisioning the first root board after migration — is blocked outright. Cause: v1 had no `registered_groups.is_main=1` row, OR `1b-db` errored on the main row mid-create. Remediation: list candidates with `pnpm exec tsx scripts/set-main-control.ts`, confirm with the user which messaging group is their primary control DM, then designate it: `pnpm exec tsx scripts/set-main-control.ts <mg-id>` (or `--by-platform <channel> <platform_id>`).
- **TaskFlow board reachability.** For each v2 agent_group, the folder must resolve to a board via `resolveTaskflowBoardId` (direct `boards.group_folder` match OR `board_groups.group_folder` fallback). Count unresolved folders: open both DBs (`data/v2.db` + `data/taskflow/taskflow.db`) and compute `agent_groups.folder \ (boards.group_folder ∪ board_groups.group_folder)`. Any non-zero result means those agent containers can't operate on a board (all `api_*`/`taskflow_*` MCP tools return "no board for this group"). Two legitimate causes: (a) the agent is the main control DM and intentionally has no board (e.g., `whatsapp_main`), (b) v1-level folder drift between `registered_groups.folder` (carried into agent_groups) and `boards.group_folder` (preserved in taskflow.db). Reconcile in Phase 1b below.

For each probe that fails, run the matching `setup/index.ts --step <name>` (table at bottom of this skill) or guide the user to install/start the missing component. Only then proceed to Phase 0b.

### 0b — Smoke test, then continue

Tell the user the switch is non-destructive (v1 is paused, not modified; reverting is one command). Help them stop v1's service unit and start v2's, tail the host log for a clean boot, and have them send a real test message. Use `AskUserQuestion` to confirm the bot responded.

If yes, continue to Phase 1. If no, diagnose from `logs/nanoclaw.log` and re-test — don't proceed to deeper work on a broken router.

### Deferred failures

Re-visit anything you skipped in 0a before declaring the migration done. Most surface naturally in later phases (`1c-groups` ↔ Phase 2, `1e-tasks` ↔ task verification).

## Phase 1: Owner and access

v2 auto-creates a `users` row for every sender it sees (via `extractAndUpsertUser` in `src/modules/permissions/index.ts`). By the time this skill runs, the owner's row likely already exists — it just needs the `owner` role granted.

**User ID format**: always `<channel_type>:<platform_handle>`. Each channel populates this differently:
- **Telegram**: `telegram:<numeric_user_id>` (e.g. `telegram:6037840640`)
- **Discord**: `discord:<snowflake_user_id>` (e.g. `discord:123456789012345678`)
- **WhatsApp**: `whatsapp:<phone>@s.whatsapp.net` (e.g. `whatsapp:14155551234@s.whatsapp.net`)
- **Slack**: `slack:<user_id>` (e.g. `slack:U04ABCDEF`)
- **Others**: `<channel_type>:<platform_id>`

**Steps:**

1. Query `users` table: `SELECT id, kind, display_name FROM users`.
2. If exactly one user exists, confirm: `AskUserQuestion`: "Is `<display_name>` (`<id>`) you?" — Yes / No, let me type it.
3. If multiple users exist, present them as options in `AskUserQuestion`.
4. If no users exist yet (v2 hasn't received traffic — e.g., the service was not switched during Phase 0b), **pre-seed from v1's message history instead of blocking on a test message**. v1's `registered_groups.is_main=1` is the user's primary DM/channel; the sender(s) there are owner candidates. Read `<handoff.v1_path>/store/messages.db`:
   ```sql
   -- v1: find the main group's jid
   SELECT jid FROM registered_groups WHERE is_main = 1;
   -- v1: top non-bot senders in that chat
   SELECT sender, sender_name, COUNT(*) AS n
   FROM messages
   WHERE chat_jid = '<main_jid>' AND is_from_me = 0 AND sender IS NOT NULL
   GROUP BY sender ORDER BY n DESC LIMIT 5;
   ```
   Use `parseJid` + `v2PlatformId` from `setup/migrate-v2/shared.ts` to convert each `sender` to a v2 user ID (`<channel_type>:<platform_id>`). Present the top 5 via `AskUserQuestion`: "Which of these is you?" with a "let me type it" escape. Once confirmed, upsert into `users(id, kind, display_name)` and proceed to step 5 to grant the owner role. If v1's `messages` table is also empty (fresh v1 install with zero traffic), only then fall back to "ask the user to send a test message first."
5. Once confirmed, check `user_roles` — if the owner role already exists, skip. Otherwise insert:
   ```sql
   INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
   VALUES ('<user_id>', 'owner', NULL, NULL, datetime('now'))
   ```

Use the DB helpers in `src/db/user-roles.ts` — they keep indexes correct. Init the DB first:

```ts
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { DATA_DIR } from '../src/config.js';
import path from 'path';
const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);
```

### Access policy

After seeding the owner, discuss the access policy. v2's `messaging_groups.unknown_sender_policy` controls who can interact with the bot. `migrate-v2.sh` set it to `public` so the bot would respond during the switchover test, but the user may want to tighten it.

Present the options via `AskUserQuestion`:

1. **Public** (current) — anyone can message the bot. Good for personal DM bots.
2. **Known users only** — only users in `agent_group_members` can trigger the bot. Others are silently dropped.
3. **Approval required** — unknown senders trigger an approval request to the owner. Good for group chats where you want to vet new members.

If the user picks option 2 or 3, seed the known users from v1's message history. The v1 database is at `<handoff.v1_path>/store/messages.db`. It has a `messages` table with `sender` and `sender_name` columns. For each group:

```sql
-- v1: unique senders per chat (excluding bot messages)
SELECT DISTINCT sender, sender_name
FROM messages
WHERE chat_jid = '<v1_jid>' AND is_from_me = 0 AND sender IS NOT NULL
```

The `sender` value is a platform handle (e.g. `6037840640` for Telegram). Build the v2 user ID by inferring the channel type from the chat JID prefix (use `parseJid` from `setup/migrate-v2/shared.ts`) and combining: `<channel_type>:<sender>`.

For each sender:
1. Upsert into `users(id, kind, display_name)` if not already present.
2. Insert into `agent_group_members(user_id, agent_group_id)` for each agent group wired to that messaging group.

Show the user the list of senders being imported and let them deselect any they don't want.

Then update the messaging groups:
```sql
UPDATE messaging_groups SET unknown_sender_policy = '<chosen_policy>'
WHERE id IN (SELECT id FROM messaging_groups WHERE channel_type IN (<migrated_channels>))
```

## Phase 1b: TaskFlow board reconciliation

If the Phase 0a "TaskFlow board reachability" probe surfaced unresolved folders, walk them with the user. Each represents an agent_group with no TaskFlow board attached.

**Step 1 — enumerate unresolved folders.** Open both DBs:

```ts
import Database from 'better-sqlite3';
const v2 = new Database('data/v2.db', { readonly: true });
const tf = new Database('data/taskflow/taskflow.db', { readonly: true });

const folders = v2.prepare('SELECT folder FROM agent_groups ORDER BY folder').all() as { folder: string }[];
const direct = new Set(tf.prepare('SELECT DISTINCT group_folder FROM boards').all().map((r: any) => r.group_folder));
const mapped = new Set(tf.prepare('SELECT DISTINCT group_folder FROM board_groups').all().map((r: any) => r.group_folder));
const unresolved = folders.map(f => f.folder).filter(f => !direct.has(f) && !mapped.has(f));
```

**Step 2 — categorize each unresolved folder.** For each one, ask via `AskUserQuestion`:

- **No board needed** — main control DM, or a non-taskflow group. No action; the agent will operate without TaskFlow MCP tools. (Recommended default for the messaging group that has `is_main_control=1`.)
- **Map to an existing v1 board** — v1-level folder drift. Show the user a candidate list: `SELECT id, name, group_folder FROM boards`. Filter to plausible matches (substring of folder, similar tokens). On selection, insert into `board_groups(board_id, group_jid, group_folder, group_role)` — the `group_jid` is from `messaging_groups.platform_id` for the agent's wired messaging_group, `group_folder` is the agent_group's folder, `group_role` is typically `team` (or `control` for the main control DM).
- **Provision a new board** — defer. Tell the user to send `provision_root_board` from the **operator-designated main control chat** (the one with `is_main_control=1`) after cutover, naming the target group as a parameter. `provision_root_board` is gated to main-control sessions (`src/modules/taskflow/provision-root-board.ts:214` → `checkMainControlSession`); it CANNOT be invoked from inside the unresolved agent's own chat.

**Step 3 — verify post-reconciliation.** Re-run the Phase 0a probe; the only legitimately-unresolved folder should be the main-control group (if the user chose "no board needed" for it).

This phase is purely additive — no v1 data is modified, no boards renamed. The reconciliation goes through `board_groups`, which is the canonical many-to-many table for "this folder belongs to this board". Boards' own `group_folder` field is left alone (preserves v1 history).

## Phase 2: Clean up CLAUDE.local.md

The migration copied v1's entire CLAUDE.md into CLAUDE.local.md for each group. This file now contains v1 boilerplate that v2 handles through its own composed fragments (`container/CLAUDE.md` + `.claude-fragments/module-*.md`). The user's customizations are buried inside.

A real v1 install has 30-50 of these files. Per-file review for each one does not scale and burns an entire session on what is mostly mechanical work. Instead, classify first, then act in batches:

### Step 0 — Classify all CLAUDE.local.md files in one pass

Read all **three** v1 templates **once** at the start — most files in a TaskFlow-heavy install derive from `add-taskflow`'s template, not main/global:

```ts
const handoff = JSON.parse(fs.readFileSync('logs/setup-migration/handoff.json', 'utf8'));
const mainTpl = fs.readFileSync(path.join(handoff.v1_path, 'groups', 'main', 'CLAUDE.md'), 'utf8');
const globalTpl = fs.readFileSync(path.join(handoff.v1_path, 'groups', 'global', 'CLAUDE.md'), 'utf8');
const taskflowTplPath = path.join(handoff.v1_path, '.claude/skills/add-taskflow/templates/CLAUDE.md.template');
const taskflowTpl = fs.existsSync(taskflowTplPath) ? fs.readFileSync(taskflowTplPath, 'utf8') : null;
```

For each `groups/<folder>/CLAUDE.local.md`:

1. Strip the leading identity block (`# Name` heading + first paragraph) and normalize whitespace + template tokens (`{{ASSISTANT_NAME}}` etc.).
2. Pick the closest-matching template by content (not by line count alone — TaskFlow templates can balloon to 1300+ lines after population). Folders ending in `-taskflow` almost always derive from the taskflow template; `is_main=1` in v1's `registered_groups` indicates main; everything else is usually global.
3. Bucket against that template:

- **identity-only** — stripped-and-normalized file equals the stripped-and-normalized template.
- **trivial-drift** — file shares the template's section structure but adds small content (extra bullet points, a customized prompt, board-specific names). Use judgement; a "small" diff might still be ~200 lines for a TaskFlow-derived file because the template itself is large.
- **substantively-customized** — entirely new sections, the file is clearly not derived from any of the three templates (e.g. line counts far outside the known template families), or the customization is large enough that mechanical batch processing would destroy meaning.

Compute the actual counts on THIS corpus and report them to the user, naming the substantive files: "I found N files — X identity-only, Y trivial-drift, Z substantively-customized: \[list]. I'll batch-process the first two buckets and walk the substantive ones with you individually." Get a single confirmation to proceed.

> **Historical reference** — on the 2026-05 dry-run corpus (42 files, 38 of them TaskFlow-derived), the bucket distribution settled around 2 / 21 / 19, with the substantives concentrated in files that had been hand-edited post-template-instantiation. Use this only as a rough sanity check — every corpus is different.

### Step 1 — Batch-process identity-only files

For each identity-only file, write a minimal replacement: the original `# Name` heading + identity paragraph (this is the agent's personality and MUST be preserved), nothing else. v2's composed fragments cover all the boilerplate. No `AskUserQuestion` per file — they all get the same treatment.

### Step 2 — Batch-process trivial-drift files

Compute the proposed output for each trivial-drift file IN MEMORY (don't write yet): apply the section-removal list and path-rewrites from Step 3 (sub-steps 4 and 5 below) — both are purely mechanical. Then show the user the proposed file list with line-count deltas as a SINGLE confirmation ("Here are the N files I'd clean, line counts L1→L2 — any objections?"). On approval, write them all. Never write before the batch confirmation.

### Step 3 — Per-file review (substantively-customized only)

For each file in this bucket:

1. Read the file.
2. Use the closest-matching template you already selected for this file in Step 0 — including the `add-taskflow` template if that's what the file derives from. Don't re-derive: a TaskFlow-derived file diffed against `groups/main/CLAUDE.md` will look entirely custom because the templates have nothing in common. The valid sources are:
   - `<v1_path>/.claude/skills/add-taskflow/templates/CLAUDE.md.template` (most likely for `-taskflow` folders)
   - `<v1_path>/groups/main/CLAUDE.md` (if `is_main=1` in v1's `registered_groups`)
   - `<v1_path>/groups/global/CLAUDE.md` (otherwise)
3. Diff the file against the template. Identify sections that are:
   - **Stock boilerplate** (identical to template) — remove. v2's fragments cover this.
   - **User customizations** (added sections, modified sections) — keep.
4. The following v1 sections are now handled by v2 fragments and should be removed even if slightly modified:
   - "What You Can Do" → v2 runtime system prompt
   - "Communication" / "Internal thoughts" / "Sub-agents" → `container/CLAUDE.md` + `module-core.md`
   - "Your Workspace" / workspace path references → `container/CLAUDE.md`
   - "Memory" (the stock version) → `container/CLAUDE.md`
   - "Message Formatting" → `container/CLAUDE.md`
   - "Admin Context" → v2 uses `user_roles`, not is_main
   - "Authentication" → v2 uses OneCLI
   - "Container Mounts" → v2 mounts are different
   - "Managing Groups" / "Finding Available Groups" / "Registered Groups Config" → v2 entity model, no IPC
   - "Global Memory" → v2 has `.claude-shared.md` symlink
   - "Scheduling for Other Groups" → `module-scheduling.md`
   - "Task Scripts" → `module-scheduling.md`
   - "Sender Allowlist" → v2 uses `unknown_sender_policy` + `user_roles`
5. Fix path references in kept sections:
   - `/workspace/group/` → `/workspace/agent/`
   - `/workspace/global/` → gone; v1's global memory is replaced by `.claude-shared.md` symlink. Remove references.
   - `/workspace/project/` → these paths don't exist in v2; discuss with the user
   - `/workspace/ipc/` → gone; remove references
   - `/workspace/extra/` → v2 uses `container.json` `additionalMounts`; keep but note the path may change
   - `/workspace/taskflow/taskflow.db` → **preserve as-is**; this path is valid in v2 (host mounts taskflow.db at this exact location, see `src/container-runner.ts` taskflow mount). TaskFlow-derived CLAUDE.local.md files reference it heavily.
6. Keep the `# Name` heading and first paragraph (identity) — this is the user's agent personality.
7. Show the user the proposed new CLAUDE.local.md before writing it. Use `AskUserQuestion`: "Here's what I'd keep — look right?" with options to approve, edit, or keep the original.

If a CLAUDE.local.md has no user customizations (pure template copy), write a minimal file with just the identity heading.

## Phase 3: Container config

`migrate-v2.sh` writes `container.json` directly from v1's `container_config` (the `additionalMounts` shape is identical). If the v1 config was unparseable, it falls back to a `.v1-container-config.json` sidecar.

For each group, check:

1. If `container.json` exists, read it and verify the `additionalMounts` host paths are still valid on this machine. Flag any that don't exist.
2. If `.v1-container-config.json` exists (parse failure fallback), read it, discuss with the user, and write a proper `container.json`. Then delete the sidecar.
3. Check for `env` or `packages` fields — `env` may overlap with OneCLI vault, `packages` (apt/npm) are portable.

## Phase 4: Fork customizations

Check whether the user's v1 install was a customized fork.

```bash
cd <v1_path>
git remote -v
git log --oneline <upstream>/main..HEAD 2>/dev/null
```

If v1 is not a git checkout (e.g., tarball, snapshot directory) — `git -C <v1_path> remote -v` hard-fails. Don't treat that as "no customizations." Skip the commit-list step and proceed to the skill-by-skill walk in step 2 below; use file content (not git history) as the source of truth.

If git is available and there are no commits ahead of upstream: still walk the skill inventory below, because `.claude/skills/` may have unstaged or never-committed local additions.

### Step 1 — Categorize v1's `.claude/skills/`

A v1 install accumulates skills. Don't blindly copy them — some are upstream-known with reimplemented v2 versions, some are obsolete (reference v1 IPC, removed primitives), and some are genuinely portable. Categorize first:

```ts
const v1Skills = fs.readdirSync(path.join(handoff.v1_path, '.claude/skills'), { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name);
const v2Skills = new Set(fs.readdirSync('.claude/skills', { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name));

const overlapping = v1Skills.filter(s => v2Skills.has(s));   // exists in BOTH — danger zone
const v1Only = v1Skills.filter(s => !v2Skills.has(s));        // only in v1 — review needed
```

For each bucket:

- **Overlapping** (e.g., `add-discord`, `add-slack`, `add-taskflow`, `add-whatsapp`, `customize`, `setup`) — DO NOT copy v1's version. v2 has reimplemented these against the channel-adapter / container contracts; v1's version would clobber a working install. If the user customized v1's version, surface the v1-vs-v2 SKILL.md diff and walk the user through reapplying their customizations on top of v2's version — don't lift-and-drop.

- **V1-only** — read each one's `SKILL.md` and classify in this precedence order (each skill lands in exactly one bucket):

  1. **Already in v2 under a different name** — first-pass mapping. Examples: `add-gmail` → `add-gmail-tool`, `add-long-term-context` → `add-mnemon` (or `add-karpathy-llm-wiki`). Skip with a note pointing the user at the v2 equivalent.

  2. **Architecture-incompatible** — the skill's `SKILL.md` describes patches to `src/`, `container/agent-runner/src/`, or `container/Dockerfile`, OR references v1-only primitives. Concrete markers to grep for (no helper function exists; check inline):
     - paths: `/workspace/group/`, `/workspace/ipc/`, `/workspace/global/`
     - tables: `registered_groups`, mentions of `is_main` on a registered_groups row (v2 uses `is_main_control` on messaging_groups)
     - file refs: `src/channels/whatsapp.ts`, `src/index.ts`, `src/container-runner.ts`, `container/agent-runner/src/index.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`, `container/Dockerfile`
     - module names: `ipc-plugins/`, mentions of v1 IPC compaction or v1 swarm modules

     Examples from a typical v1 install: `add-compact` (v1 IPC compaction), `add-agent-swarm` / `add-telegram-swarm` (v1 swarm patterns), `add-image-vision` / `add-pdf-reader` / `add-reactions` / `add-voice-transcription` (all patch v1 channel + container source). Stash to `docs/v1-fork-reference/skills-incompatible/` with a one-line "why" per skill. Don't port — they'd reapply v1 source patches to v2 code that's been rewritten.

  3. **Portable** — none of the above markers; the skill is purely about agent behavior (prompts, CLAUDE.md additions, MCP tool configs) or installs an external integration without patching the codebase. Copy to `.claude/skills/` and verify it loads by checking the SKILL.md's frontmatter is valid.

Show the user the three sub-buckets as a single confirmation list. Don't ask per skill unless the classification is ambiguous (e.g., the SKILL.md mixes pure-behavior guidance with a small patch hint).

### Step 2 — Other fork content

For `<handoff.v1_path>/container/skills/*`, `<handoff.v1_path>/docs/*`, and other top-level fork files in the v1 path (NOT v2's own `container/skills/*`): same approach. Open each file, apply the same inline marker scan from Step 1's incompatible-bucket criteria, bucket as portable / incompatible / superseded. Show the user; batch-confirm. In a typical v1 install, `container/skills/pdf-reader` is incompatible (needs `pdftotext` binary not in v2's Dockerfile); `status` and `capabilities` reference `/workspace/project` (not mounted in v2) and are also incompatible.

**Destinations for portable items:**
- v1 `container/skills/<name>/` → v2 `container/skills/<name>/` (NOT `.claude/skills/`; agent-runner mounts container skills from this exact path at session spawn)
- v1 `docs/<file>` → v2 `docs/<file>` (verify path references in the file are still valid in v2's docs/ layout)

For incompatible items, stash to `docs/v1-fork-reference/skills-incompatible/<name>/` (mirroring Step 1's stash convention) with a one-line "why" per skill.

For `src/*` and `container/agent-runner/src/*`: NOT portable — v2's architecture is fundamentally different. Stash to `docs/v1-fork-reference/src/` with a README explaining what each file did. Don't translate.

Skip stray non-skill files (e.g., `.claude/skills/vitest.config.ts` if present) — those aren't skills and shouldn't be moved as if they were.

## Principles

- **v1 checkout is read-only.** Never modify files under `handoff.v1_path`.
- **Show before writing.** Show diffs/proposed content before modifying CLAUDE.local.md or container.json.
- **Mask credentials** when displaying (first 4 + `...` + last 4 characters).
- **`handoff.json` is the recovery point.** If context gets compacted, re-read it and `git status` to recover state.

## Setup steps you can run

The setup flow at `setup/index.ts` has individual steps you can invoke if something is missing or failed:

```bash
pnpm exec tsx setup/index.ts --step <name>
```

| Step | When to use |
|------|-------------|
| `onecli` | OneCLI not installed or not healthy |
| `auth` | No Anthropic credential in vault |
| `container` | Container image needs rebuild |
| `service` | Service not installed or not running |
| `mounts` | Mount allowlist missing |
| `verify` | End-to-end health check (run after everything else) |
| `environment` | System check (Node, dirs) |

## When done

1. Run the verify step to confirm everything works:
   ```bash
   pnpm exec tsx setup/index.ts --step verify
   ```
2. Delete `logs/setup-migration/handoff.json` — offer to save as `docs/migration-<date>.md` first.
3. Restart the service if running so changes take effect:
   ```bash
   # Linux
   systemctl --user restart nanoclaw-v2-*
   # macOS
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-*
   ```
