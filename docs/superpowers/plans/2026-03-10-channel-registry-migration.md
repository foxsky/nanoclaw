# Channel Registry Migration — Make TaskFlow Channel-Agnostic

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Fully implemented. Core migration, credential proxy, and sender allowlist are all landed. This document records what shipped, the post-migration bug fixes, and how to validate the landed behavior.

**Goal:** Refactor `src/index.ts` to use the upstream channel registry pattern instead of direct WhatsApp imports, so the runtime channel bootstrap and IPC wiring are channel-agnostic. This does **not** make all TaskFlow provisioning and IPC plugins fully channel-agnostic yet.

**Architecture:** Replace the hardcoded `WhatsAppChannel` import and module-level variable with the self-registration barrel import (`channels/index.js`) + registry loop (`getRegisteredChannelNames` / `getChannelFactory`). Keep `createGroup` and `resolvePhoneJid` on IpcDeps but wire them through the channel that supports them, not a hardcoded reference. Rename `syncGroupMetadata` → `syncGroups` in IpcDeps to match the Channel interface.

**Tech Stack:** Node.js, TypeScript, Vitest

**Scope:** All tasks are completed. Tasks 1-3 (core registry migration) and Task 6 (skill sync) landed first, followed by credential proxy (Task 4) and sender allowlist (Task 5) which were initially deferred but have since been implemented and landed.

---

## Codex Review Findings (gpt-5.4, high reasoning)

The following issues were identified by Codex and incorporated into this plan:

| Severity | Finding | Resolution |
|----------|---------|------------|
| HIGH | Task 5's `isTriggerAllowed` call uses wrong args (`group.jid` doesn't exist, missing 3rd `cfg` param) and only covers 1 of 2 trigger check sites | **Resolved** — implemented in `5921c8e`, all trigger check sites covered, args corrected |
| HIGH | Task 4 starting credential proxy server alone doesn't wire containers to use it (`CREDENTIAL_PROXY_PORT` env not passed to containers) | **Resolved** — implemented in `43d6961`, container-runner integration wired end-to-end |
| HIGH | IPC plugins hardcode `@s.whatsapp.net` patterns — plan overstates "channel-agnostic" | **Acknowledged** — noted in Risk Assessment; IPC plugin refactor is a separate effort |
| MEDIUM | Task 2 missing test updates in `create-group.test.ts` and `provision-child-board.test.ts` | **Fixed** — added Step 5a to Task 2 |
| MEDIUM | Type checking should use `npm run build`, not vitest | **Fixed** — Task 1 now uses `npm run build` for verification |
| MEDIUM | Task 6 skill sync list incomplete (missing `channels/registry.ts`, `channels/index.ts`, etc.) | **Fixed** — Task 6 only syncs files that actually changed (index.ts, types.ts, ipc.ts); channels/registry.ts and channels/index.ts are unchanged |

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/index.ts` | MODIFY | Remove direct WhatsApp import; use channel registry loop |
| `src/types.ts` | MODIFY | Add optional `resolvePhoneJid` and `syncGroups` to Channel interface |
| `src/ipc.ts` | MODIFY | Rename `syncGroupMetadata` → `syncGroups` in IpcDeps |
| `src/ipc-plugins/create-group.ts` | NO CHANGE | Already uses `deps.createGroup` (channel-agnostic) |
| `src/ipc-plugins/provision-root-board.ts` | NO CHANGE | Already uses `deps.createGroup` / `deps.resolvePhoneJid` |
| `src/ipc-plugins/provision-child-board.ts` | NO CHANGE | Already uses `deps.createGroup` / `deps.resolvePhoneJid` |
| `src/channels/whatsapp.ts` | NO CHANGE | Already self-registers via `registerChannel()` |
| `src/channels/registry.ts` | NO CHANGE | Already has `getChannelFactory` / `getRegisteredChannelNames` |
| `src/channels/index.ts` | ALREADY EXISTS | Already imports `./whatsapp.js` (from add-whatsapp merge) |
| `.claude/skills/add-taskflow/modify/src/index.ts` | UPDATE | Sync skill copy after refactor |
| `.claude/skills/add-taskflow/modify/src/types.ts` | UPDATE | Sync skill copy after refactor |
| `.claude/skills/add-taskflow/modify/src/ipc.ts` | UPDATE | Sync skill copy after refactor |

---

## Chunk 1: Channel Interface and IpcDeps

### Task 1: Add optional methods to Channel interface

**Files:**
- Modify: `src/types.ts:84-98`

- [x] **Step 1: Write the failing test**

This was implemented by updating mock `Channel` values to include `resolvePhoneJid` and `syncGroups`.

- [x] **Step 2: Run build to verify it fails**

Historical note: this failure happened before `resolvePhoneJid` and `syncGroups` were added to `Channel`.

Current validation:
- `npm run build`
- Expected: PASS — the `Channel` interface already includes both optional methods

- [x] **Step 3: Add optional methods to Channel interface**

Implemented in `src/types.ts`:

```typescript
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, sender?: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  createGroup?(
    subject: string,
    participants: string[],
  ): Promise<{ jid: string; subject: string }>;
  resolvePhoneJid?(phone: string): Promise<string>;
  syncGroups?(force: boolean): Promise<void>;
}
```

- [x] **Step 4: Run build to verify it passes**

Run: `npm run build`
Expected: PASS — TypeScript compiles cleanly

- [x] **Step 5: Commit**

```bash
git add src/types.ts
git commit -m "feat: add resolvePhoneJid and syncGroups to Channel interface"
```

---

### Task 2: Rename syncGroupMetadata → syncGroups in IpcDeps

**Files:**
- Modify: `src/ipc.ts:19-36` (IpcDeps interface)
- Modify: `src/ipc.ts` (all references to syncGroupMetadata)
- Modify: `src/index.ts` (call site)

- [x] **Step 1: Find all references**

```bash
grep -rn 'syncGroupMetadata\|syncGroups' src/ --include='*.ts'
```

- [x] **Step 2: Rename in IpcDeps interface**

In `src/ipc.ts`, change:
```typescript
syncGroupMetadata: (force: boolean) => Promise<void>;
```
to:
```typescript
syncGroups: (force: boolean) => Promise<void>;
```

- [x] **Step 3: Update all call sites in ipc.ts**

Replace `deps.syncGroupMetadata` → `deps.syncGroups` everywhere in `src/ipc.ts`.

- [x] **Step 4: Update index.ts call site**

In `src/index.ts`, change the `startIpcWatcher` call:
```typescript
// Old:
syncGroupMetadata: (force) =>
  whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),

// New:
syncGroups: async (force: boolean) => {
  await Promise.all(
    channels
      .filter((ch): ch is Channel & { syncGroups: NonNullable<Channel['syncGroups']> } => !!ch.syncGroups)
      .map((ch) => ch.syncGroups(force)),
  );
},
```

- [x] **Step 5: Update test mocks**

Rename `syncGroupMetadata` → `syncGroups` in mock IpcDeps in **all three** test files:
- `src/ipc-auth.test.ts` (line 61)
- `src/ipc-plugins/create-group.test.ts` (line 65)
- `src/ipc-plugins/provision-child-board.test.ts` (line 71)

- [x] **Step 5a: Update comment in types.ts**

In `src/types.ts`, update the comment referencing `syncGroupMetadata`:
```typescript
// Old: channels that sync names separately (WhatsApp syncGroupMetadata) omit it.
// New: channels that sync names separately (WhatsApp syncGroups) omit it.
```

- [x] **Step 6: Build and run tests**

Run: `npm run build && npx vitest run -v`
Expected: Build clean, all tests pass.

- [x] **Step 7: Commit**

```bash
git add src/ipc.ts src/index.ts src/types.ts \
       src/ipc-auth.test.ts \
       src/ipc-plugins/create-group.test.ts \
       src/ipc-plugins/provision-child-board.test.ts
git commit -m "refactor: rename syncGroupMetadata to syncGroups in IpcDeps"
```

---

## Chunk 2: Refactor index.ts to Use Channel Registry

### Task 3: Replace direct WhatsApp import with channel registry

**Files:**
- Modify: `src/index.ts:1-70` (imports and module-level vars)

- [x] **Step 1: Remove direct WhatsApp imports**

Delete these lines from `src/index.ts`:
```typescript
import { WhatsAppChannel } from './channels/whatsapp.js';
```
and:
```typescript
let whatsapp: WhatsAppChannel;
```

- [x] **Step 2: Add channel registry imports**

Add to `src/index.ts`:
```typescript
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
```

- [x] **Step 3: Refactor channel initialization in main()**

Replace the hardcoded WhatsApp instantiation block:
```typescript
// Old:
whatsapp = new WhatsAppChannel(channelOpts);
channels.push(whatsapp);
await whatsapp.connect();
```

With the registry loop:
```typescript
// New:
for (const channelName of getRegisteredChannelNames()) {
  const factory = getChannelFactory(channelName)!;
  const channel = factory(channelOpts);
  if (!channel) {
    logger.warn({ channel: channelName }, 'Channel installed but credentials missing, skipping');
    continue;
  }
  channels.push(channel);
  await channel.connect();
  logger.info({ channel: channelName }, 'Channel connected');
}
if (channels.length === 0) {
  throw new Error('No channels connected — at least one channel must be configured');
}
```

- [x] **Step 4: Wire createGroup and resolvePhoneJid through channels array**

Replace the IPC watcher bindings:
```typescript
// Old:
createGroup: (subject, participants) => {
  if (!whatsapp) throw new Error('WhatsApp not connected');
  return whatsapp.createGroup(subject, participants);
},
resolvePhoneJid: (phone) => {
  if (!whatsapp) throw new Error('WhatsApp not connected');
  return whatsapp.resolvePhoneJid(phone);
},

// New:
createGroup: (subject, participants) => {
  const ch = channels.find((c) => c.createGroup);
  if (!ch?.createGroup) throw new Error('No channel supports group creation');
  return ch.createGroup(subject, participants);
},
resolvePhoneJid: (phone) => {
  const ch = channels.find((c): c is Channel & { resolvePhoneJid: NonNullable<Channel['resolvePhoneJid']> } => !!c.resolvePhoneJid);
  if (!ch) throw new Error('No channel supports phone JID resolution');
  return ch.resolvePhoneJid(phone);
},
```

- [x] **Step 5: Build and run tests**

```bash
npm run build
npx vitest run
```

Expected: Build clean, all tests pass.

- [x] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "refactor: use channel registry instead of direct WhatsApp import"
```

---

## Previously Deferred Tasks (Now Completed)

### Task 4: Re-enable credential proxy — COMPLETED

**Originally deferred because:** Starting `startCredentialProxy()` in `index.ts` alone does not wire containers to use it. `CREDENTIAL_PROXY_PORT` must be passed as an environment variable to containers via `container-runner.ts`, and containers must be configured to route API traffic through the proxy.

**Resolution:** Implemented end-to-end in `43d6961 feat: wire credential proxy end-to-end`. Container-runner integration, environment variable passing, and proxy wiring are all landed. Skill copies synced in `ddae8c2 chore: sync skill copies after credential proxy and sender allowlist`.

### Task 5: Integrate sender allowlist — COMPLETED

**Originally deferred because:** The original plan's code had multiple bugs:
1. `group.jid` does not exist on `RegisteredGroup` — should use `chatJid`
2. `isTriggerAllowed()` requires 3 args (chatJid, sender, cfg) — plan omitted `cfg`
3. Only covered 1 of 2 trigger check sites (`processGroupMessages` but not `startMessageLoop`)

**Resolution:** All issues addressed in `5921c8e feat: integrate sender allowlist in all trigger check sites`. All trigger check sites covered with correct arguments. Further refined in `b89d7e4 refactor: simplify trigger checks, cache sender allowlist, clean up syncGroups`. Skill copies synced in `ddae8c2 chore: sync skill copies after credential proxy and sender allowlist`.

---

## Chunk 3: Sync Skill Copies and Validate

### Task 6: Update TaskFlow skill modify copies

**Files:**
- Copy: `src/index.ts` → `.claude/skills/add-taskflow/modify/src/index.ts`
- Copy: `src/types.ts` → `.claude/skills/add-taskflow/modify/src/types.ts`
- Copy: `src/ipc.ts` → `.claude/skills/add-taskflow/modify/src/ipc.ts`

- [x] **Step 1: Copy modified runtime files to skill**

```bash
cp src/index.ts .claude/skills/add-taskflow/modify/src/index.ts
cp src/types.ts .claude/skills/add-taskflow/modify/src/types.ts
cp src/ipc.ts .claude/skills/add-taskflow/modify/src/ipc.ts
```

- [x] **Step 2: Run full test suite**

```bash
npm test
```

Expected: 313+ tests pass (1 pre-existing flaky timing test allowed).

- [ ] **Step 3: Restart service and run live E2E test**

Status note: code sync is already present in `.claude/skills/add-taskflow/modify/src/`. This live validation remains optional operational follow-up, not a prerequisite for the migration code itself.

```bash
npm run build
systemctl restart nanoclaw
sleep 5
# Drop test IPC message
cat > data/ipc/e2e-taskflow/messages/e2e-$(date +%s).json << 'EOF'
{
  "type": "message",
  "chatJid": "120363406927955265@g.us",
  "text": "[E2E-TEST] Channel registry migration validated ✅",
  "sender": "Case"
}
EOF
chown nanoclaw:nanoclaw data/ipc/e2e-taskflow/messages/e2e-*.json
sleep 3
grep "IPC message sent" logs/nanoclaw.log | tail -1
```

Expected: IPC message delivered to WhatsApp group.

- [ ] **Step 4: Verify service logs show channel registry pattern**

Status note: this is an operational verification step that may be run when validating a deployment, but the migration code is already landed.

```bash
grep -i "channel\|connected\|registry" logs/nanoclaw.log | tail -10
```

Expected: Logs show "Channel connected" with channel name, not direct WhatsApp instantiation.

- [x] **Step 5: Commit**

```bash
git add .claude/skills/add-taskflow/modify/src/index.ts \
       .claude/skills/add-taskflow/modify/src/types.ts \
       .claude/skills/add-taskflow/modify/src/ipc.ts
git commit -m "chore: sync TaskFlow skill copies after channel registry migration"
```

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| `createGroup`/`resolvePhoneJid` not found in channels array | Already optional on IpcDeps — plugins check for null and warn gracefully |
| WhatsApp self-registration not triggered | `channels/index.ts` already imports `./whatsapp.js` |
| Duplicate channel registration (index.ts + channels/index.ts) | After refactor, only channels/index.ts triggers registration — index.ts no longer imports WhatsApp directly |
| `channels.find(c => c.createGroup)` picks first capable channel arbitrarily | Acceptable for single-channel setups; multi-channel disambiguation deferred to when a second channel supports provisioning |
| IPC plugins still hardcode `@s.whatsapp.net` patterns | Known limitation — `provision-root-board.ts`, `provision-child-board.ts`, and `provision-shared.ts` still contain WhatsApp-specific JID assumptions. The registry migration does not remove these; plugin channel-agnostic refactoring is a separate effort. |

## Current Outcome

The following are already true in the repo:

- `src/index.ts` uses `./channels/index.js` plus the channel registry loop for bootstrap
- `src/types.ts` exposes optional `resolvePhoneJid` and `syncGroups` on `Channel`
- `src/ipc.ts` uses `syncGroups` in `IpcDeps`
- TaskFlow skill modify copies already mirror the migrated runtime files

The following are still not true:

- TaskFlow provisioning is not fully channel-agnostic end to end
- IPC plugins that manipulate WhatsApp-style participant JIDs are still WhatsApp-specific
- credential proxy and sender allowlist changes are not part of this landed migration

## What NOT to Change

- `src/channels/whatsapp.ts` — already self-registers, has TaskFlow methods
- `src/ipc-plugins/*` — channel-agnostic via IpcDeps dependency injection (note: some contain WhatsApp-specific JID patterns — acceptable, see risk above)
- `src/router.ts` — `findChannel()` already works with any Channel[]
- `src/group-queue.ts` — completely channel-independent
- `src/container-runner.ts` — no channel awareness needed
