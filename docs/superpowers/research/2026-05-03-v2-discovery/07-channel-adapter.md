# 07 — v2 ChannelAdapter pattern + add-whatsapp apply procedure

**Date:** 2026-05-03
**Scope:** Codex flagged two correctness gaps in our v2 migration plan: (a) the
`add-whatsapp` apply procedure was a sketch; (b) the `skill/whatsapp-fixes`
test approach assumed an exported factory (`createWhatsAppAdapter()`) which
does not exist — v2's WhatsApp adapter self-registers via
`registerChannelAdapter()` at module-import time and exposes no factory at all.

This document fixes both, by reading the exact upstream sources end-to-end:

- `remotes/upstream/v2:.claude/skills/add-whatsapp/SKILL.md` — claude-driven flow
- `remotes/upstream/v2:setup/add-whatsapp.sh` — canonical idempotent installer
- `remotes/upstream/v2:src/channels/adapter.ts` — the `ChannelAdapter` interface
- `remotes/upstream/v2:src/channels/channel-registry.ts` — registry + lifecycle
- `remotes/upstream/v2:src/channels/index.ts` — self-registration barrel
- `remotes/upstream/v2:src/index.ts` — host startup wiring
- `remotes/upstream/channels:src/channels/whatsapp.ts` — the adapter itself
- `remotes/upstream/channels:src/channels/channel-registry.test.ts` — test pattern

---

## 1. The exact `add-whatsapp` apply procedure

There are two installers in the v2 repo; they do the same thing:

| Driver | Path | When it runs |
|---|---|---|
| Bash (canonical) | `setup/add-whatsapp.sh` | Invoked by `setup:auto`'s `runWhatsAppChannel` (`setup/channels/whatsapp.ts:53`) and re-invokable by hand |
| Claude-skill | `.claude/skills/add-whatsapp/SKILL.md` | Invoked by `/add-whatsapp` |

The bash script is the source of truth. The SKILL.md is hand-written prose that
performs the same steps via Claude. Both check the same idempotent pre-flight
and exit early if nothing to do.

### 1a. Pre-flight (idempotent) — exit successfully if all 5 are true

The script's `need_install()` returns 0 (= work to do) if any of these is **not** true:

```text
1.  src/channels/whatsapp.ts                       exists
2.  setup/groups.ts                                exists
3.  src/channels/index.ts                          contains   import './whatsapp.js';
4.  setup/index.ts                                 contains   'whatsapp-auth':
5.  setup/index.ts                                 contains   ^  groups:
```

If all five are present, `ADAPTER_ALREADY_INSTALLED=true` and the script
emits `STATUS: success` and exits without touching anything else.

**Important:** on `base/v2-fork-anchor`, conditions 4 and 5 are **already
satisfied** — v2 trunk's `setup/index.ts` ships with the `'whatsapp-auth':` and
`groups:` lines already wired (verified: `git show
remotes/upstream/v2:setup/index.ts | grep -E "groups|whatsapp"`). Conditions 1,
2, 3 are unsatisfied (no `src/channels/whatsapp.ts`, no `setup/groups.ts`, and
the channel barrel only contains `import './cli.js';`). So a fresh apply only
needs steps 2, 3 below + dep install + build.

### 1b. Numbered installer (when pre-flight detects work)

```bash
# 1. Make sure the channels branch is fetched.
git fetch origin channels        # ← provides src/channels/whatsapp.ts and setup/groups.ts

# 2. Copy the adapter + the groups setup step from origin/channels.
#    (whatsapp-auth.ts is *already* in v2 trunk — do NOT copy it from channels.)
git show origin/channels:src/channels/whatsapp.ts > src/channels/whatsapp.ts
git show origin/channels:setup/groups.ts          > setup/groups.ts

# 3. Append the self-registration import to the channel barrel (idempotent).
grep -q "^import './whatsapp.js';" src/channels/index.ts \
  || echo "import './whatsapp.js';" >> src/channels/index.ts

# 4. Ensure the STEPS map in setup/index.ts has both 'whatsapp-auth' and 'groups' lines.
#    (Already true on v2 trunk, but the script does this with a node one-liner
#     anchored on the existing `register: () => import('./register.js'),` line.)

# 5. Install pinned deps.
pnpm install \
  @whiskeysockets/baileys@6.17.16 \
  qrcode@1.5.4 \
  @types/qrcode@1.5.6 \
  pino@9.6.0

# 6. Build.
pnpm run build
```

Notes:

- **No service restart** at apply time. The factory short-circuits to `null`
  when `store/auth/creds.json` is missing (verified — `whatsapp.ts:153-156`),
  so a restart at this stage would no-op. The driver restarts the service
  only **after** `whatsapp-auth` lands creds.
- **No `.env` mutations** at apply time. The optional `ASSISTANT_HAS_OWN_NUMBER=true`
  is written by the *credentials* phase (post-auth) when the user picks
  "dedicated number," not by the adapter installer.
- **No edits to `src/index.ts`**. The host already imports
  `./channels/index.js` and calls `initChannelAdapters()` unconditionally; new
  channels self-register simply by being imported in the barrel.

### 1c. Auth phase (separate from adapter install)

After install, `setup/whatsapp-auth.ts` runs as a separate process:

- `--method qr`              → emits `WHATSAPP_AUTH_QR` status blocks (driver renders)
- `--method pairing-code --phone <digits>` → emits `WHATSAPP_AUTH_PAIRING_CODE`
- terminal status: `WHATSAPP_AUTH { STATUS: success | skipped | failed }`

On success, creds land in `store/auth/`, and the driver kicks the service so
the now-non-null factory creates the adapter.

---

## 2. `registerChannelAdapter()` semantics — when called?

From `src/channels/channel-registry.ts`:

```ts
const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();

export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}
```

Each adapter module ends with a top-level call:

```ts
// channels/cli.ts:276
registerChannelAdapter('cli', { factory: createAdapter });

// channels/whatsapp.ts:149
registerChannelAdapter('whatsapp', {
  factory: () => { /* returns ChannelAdapter or null */ }
});

// channels/discord.ts:21
registerChannelAdapter('discord', { factory: () => createAdapter() });
```

This is a **module-scope side effect**: importing the module runs the top-level
statements, which include `registerChannelAdapter(...)`. The barrel
`src/channels/index.ts` is a chain of bare-import statements:

```ts
// src/channels/index.ts (v2 trunk)
import './cli.js';
// /add-whatsapp appends:  import './whatsapp.js';
// /add-discord appends:   import './discord.js';
// ...
```

`src/index.ts` imports the barrel once, near the top:

```ts
import './channels/index.js';
```

…and **then** later (host phase 3 in startup) invokes the registry:

```ts
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

await initChannelAdapters((adapter): ChannelSetup => ({ /* host callbacks */ }));
```

Lifecycle:

1. Module load → `registerChannelAdapter()` populates `registry`.
2. `initChannelAdapters(setupFn)` → for each registered factory, call it.
   - If the factory returns `null` (missing credentials), skip.
   - Otherwise call `adapter.setup(setupFn(adapter))`. NetworkError gets
     up to 3 retries (2s/5s/10s). Success → cached in `activeAdapters`.
3. `getChannelAdapter(channelType)` → live adapter for delivery.
4. `teardownChannelAdapters()` → calls each `adapter.teardown()` and clears.

**Implication for our skill design:** there is no factory export. There is no
side-effect-free way to instantiate a v2 channel adapter for unit testing.
You either (a) test through the registry or (b) restructure to expose a
factory locally inside the skill, but **both upstream-shipped channels
(`cli.ts`, `whatsapp.ts`, `discord.ts`) only expose the registration call**.

---

## 3. The `ChannelAdapter` contract (full surface)

From `src/channels/adapter.ts`:

### Required

| Member | Type | Purpose |
|---|---|---|
| `name` | `string` | Human-readable channel name (e.g. `'whatsapp'`) |
| `channelType` | `string` | Routing key — matches `messaging_groups.channel_type` |
| `supportsThreads` | `boolean` | true for Discord/Slack/Linear/GitHub; false for WhatsApp/Telegram/iMessage |
| `setup(config: ChannelSetup): Promise<void>` | method | Bootstrap — wire callbacks, connect to platform |
| `teardown(): Promise<void>` | method | Clean shutdown |
| `isConnected(): boolean` | method | Synchronous status |
| `deliver(platformId, threadId, message: OutboundMessage): Promise<string \| undefined>` | method | Send outbound message; returns platform message id when known |

### Optional

| Member | When to implement |
|---|---|
| `setTyping?(platformId, threadId): Promise<void>` | Show "composing" indicator |
| `syncConversations?(): Promise<ConversationInfo[]>` | Bulk-discover groups (WhatsApp, Discord servers, …) |
| `subscribe?(platformId, threadId): Promise<void>` | Threaded platforms only (Slack/Discord/Linear/GitHub) — bot subscribes to a thread for follow-up routing |
| `openDM?(userHandle): Promise<string>` | Channels where user-id ≠ DM-channel-id (Discord/Slack/Teams/Webex/gChat). WhatsApp/Telegram/iMessage **omit it** — handle = DM id |

### Callback bundle (`ChannelSetup`)

What the host hands to the adapter at `setup()` time:

| Callback | Fired when |
|---|---|
| `onInbound(platformId, threadId, message: InboundMessage)` | Inbound chat message arrives |
| `onInboundEvent(event: InboundEvent)` | Admin-transport (CLI) wants to route to a specific channel and optionally redirect replies via `replyTo` |
| `onMetadata(platformId, name?, isGroup?)` | Adapter discovered a conversation's name/type |
| `onAction(questionId, selectedOption, userId)` | User pressed a button in an `ask_user_question` card |

### What's NOT on the interface (that our 28-board fork needs)

- `createGroup(subject, participants)` — agent-driven group creation (TaskFlow)
- `lookupPhoneJid(phone)` — `sock.onWhatsApp()` validation (TaskFlow participant pre-check)
- `resolvePhoneJid(phone)` — synchronous `<digits>@s.whatsapp.net` for outbound DM

These are precisely the three v1-only surfaces the `whatsapp-fixes-v2` skill
must bolt onto the v2 adapter. v2 deliberately keeps the interface minimal:
the platform-specific group-management surface lives outside `ChannelAdapter`
because most channels can't model it the same way (Discord servers ≠ WhatsApp
groups ≠ Slack workspaces).

---

## 4. Adapter factory pattern — does add-whatsapp produce `createWhatsAppAdapter()`?

**No.** The adapter file from `origin/channels:src/channels/whatsapp.ts` has
**zero exports**. Its entire public surface is the one
`registerChannelAdapter('whatsapp', { factory: () => { … } })` call at line 149.
The factory closure is anonymous and inaccessible from outside the module.

This is by design: v2 wants channel modules to be import-side-effect modules,
not libraries. The host gets adapters only through `getChannelAdapter()` after
`initChannelAdapters()` has run.

For comparison:
- `cli.ts` does `function createAdapter(): ChannelAdapter { … }` (also not exported)
  and passes the function reference: `registerChannelAdapter('cli', { factory: createAdapter });`
- `discord.ts` follows the same pattern.
- All 17 adapters in `origin/channels:src/channels/*.ts` end with the same
  `registerChannelAdapter()` call and export nothing.

**This is exactly the bug Codex flagged in our test file:** line 96 of
`whatsapp-extensions.test.ts` does
`import { createWhatsAppAdapter } from '../modify/src/channels/whatsapp.js';`
— that import will fail because no such export exists upstream and our skill
shouldn't introduce it (introducing it diverges from the file shape upstream
ships, which would block any future cherry-pick).

---

## 5. How `skill/whatsapp-fixes-v2` adds 3 methods correctly

### What the skill must do

1. **Replace the upstream `src/channels/adapter.ts`** to add three optional
   methods to the `ChannelAdapter` interface:

   ```ts
   export interface ChannelAdapter {
     // … existing required + optional …

     /**
      * Create a new group on this channel (subject + initial participants),
      * returning the platform-id and any participants the platform refused
      * to add (with an invite link as a fallback when populated).
      *
      * Channels without a group concept (CLI, email) omit this.
      */
     createGroup?(
       subject: string,
       participants: string[],
     ): Promise<{ jid: string; subject: string; droppedParticipants?: string[]; inviteLink?: string }>;

     /** Validate that a phone is registered on the platform; return its handle or null. */
     lookupPhoneJid?(phone: string): Promise<string | null>;

     /** Construct the outbound DM handle for a phone number without a network round-trip. */
     resolvePhoneJid?(phone: string): Promise<string>;
   }
   ```

2. **Replace the upstream `src/channels/whatsapp.ts`** so that the object the
   factory returns includes all three methods (port the proven v1 implementations).

Both edits are *full-file replacements* (manifest `modify/<path>`). The skill
runner copies them in after `add-whatsapp` has copied the upstream baseline.

### What the skill must NOT do

- Do **not** introduce a new export `createWhatsAppAdapter`. Keep the file
  shape byte-for-byte close to upstream's `origin/channels:src/channels/whatsapp.ts`,
  so the only diff is the three new methods inside the existing closure.
- Do **not** subclass — there is no class to extend. The adapter is a plain
  object literal returned from the factory.
- Do **not** decorate via wrapping — `registerChannelAdapter()` doesn't
  permit a "post-registration patch" hook (the registry only stores the
  factory; the adapter object is created inside the closure).

### How tests must reach the adapter

Three options, in order of preference:

#### Option A — drive the registry (matches `channel-registry.test.ts`)

```ts
import { registerChannelAdapter, initChannelAdapters, getChannelAdapter } from 'src/channels/channel-registry.js';
import 'src/channels/whatsapp.js';   // triggers self-registration

beforeEach(async () => {
  // mock store/auth/creds.json so the factory doesn't return null
  fs.mkdirSync('store/auth', { recursive: true });
  fs.writeFileSync('store/auth/creds.json', '{"me":{"id":"1234567890:1@s.whatsapp.net"}}');

  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
});

it('exposes createGroup', () => {
  const adapter = getChannelAdapter('whatsapp');
  expect(adapter).toBeDefined();
  expect(typeof adapter!.createGroup).toBe('function');
});
```

Pros: tests the **same code path the host uses**. Catches registration bugs.
Cons: requires fully mocking Baileys' constructor + signal repository.

#### Option B — direct import + access via the registry (no `init`)

The registry exposes `getRegisteredChannelNames()` but does **not** expose the
underlying factory. So you can't call the factory directly from tests
without modifying `channel-registry.ts` to export a test-only accessor (which
would be a fork-private change to upstream code — disallowed by our
"never-touch-codebase" rule).

#### Option C — refactor `whatsapp.ts` to also export `createAdapter()` for tests

This is what our current TDD-RED file assumes. **It diverges from upstream
file shape** and makes future cherry-picks harder. Not recommended unless
upstream itself adopts the pattern.

**Recommendation: use Option A.** Mock Baileys at the module level (the
existing test already does this), populate a fake creds.json before
`initChannelAdapters`, then pull the adapter back from the registry.

### The exact mock-Baileys wiring

The current test already mocks `@whiskeysockets/baileys` correctly (lines
72-87 of `whatsapp-extensions.test.ts`). The only changes needed:

```diff
- import { createWhatsAppAdapter } from '../modify/src/channels/whatsapp.js';
+ import { initChannelAdapters, getChannelAdapter } from '../../../../src/channels/channel-registry.js';
+ // Side-effect import — populates the registry with 'whatsapp'.
+ import '../../../../src/channels/whatsapp.js';

  beforeEach(async () => {
    fakeSocket = createFakeSocket();
+   fs.mkdirSync('/tmp/wa-fixes-test-store/auth', { recursive: true });
+   fs.writeFileSync('/tmp/wa-fixes-test-store/auth/creds.json',
+     '{"me":{"id":"1234567890:1@s.whatsapp.net"}}');
+   await initChannelAdapters(() => ({
+     onInbound: () => {},
+     onInboundEvent: () => {},
+     onMetadata: () => {},
+     onAction: () => {},
+   }));
  });

  it('exposes createGroup', () => {
-   const adapter = createWhatsAppAdapter();
+   const adapter = getChannelAdapter('whatsapp')!;
    expect(typeof adapter.createGroup).toBe('function');
  });
```

…etc. The test config also needs `STORE_DIR` (the adapter resolves
`AUTH_DIR = path.join(process.cwd(), 'store', 'auth')`, so either run tests
with `process.cwd()` set to `/tmp/wa-fixes-test-store` or change the mock to
make the adapter use a configurable path — the latter is a behaviour change
upstream wouldn't accept, so use the cwd approach in tests).

---

## 6. How v2 itself tests channel adapters

`origin/channels:src/channels/channel-registry.test.ts` is the canonical
example. It does exactly what Option A above describes:

- `registerChannelAdapter()` with a `createMockAdapter()` factory
- `initChannelAdapters()` to wire it up
- `getChannelAdapter()` to retrieve the live instance
- `setDeliveryAdapter()` to test the outbound bridge

There is no v2 test that calls a real channel module's factory directly.
There is no factory-level test for `whatsapp.ts` upstream — only the registry
contract is tested. (Channel-specific behaviour like LID translation has
no upstream test coverage at all; we'd be the first to add WhatsApp-specific
tests, which is fine but means we set the testing pattern.)

---

## 7. Skill ordering — `whatsapp-fixes-v2` ↔ `add-whatsapp`

`base/v2-fork-anchor` is **clean v2 trunk** — no channels installed except
`cli`. `add-whatsapp` must apply on top of fork-anchor first; only then can
`whatsapp-fixes-v2` overwrite the two files.

Two viable models:

### Model A — both skills on top of fork-anchor, sequential apply

```text
base/v2-fork-anchor
   └─ apply add-whatsapp           (runs setup/add-whatsapp.sh; copies upstream/channels:whatsapp.ts)
      └─ apply skill/whatsapp-fixes-v2   (manifest replaces adapter.ts + whatsapp.ts)
```

In this model, the skill's `manifest.yaml` declares `depends: [add-whatsapp]`
and the runner refuses to apply if `src/channels/whatsapp.ts` is absent.

### Model B — `whatsapp-fixes-v2` branches FROM a `+add-whatsapp` baseline

A separate test branch `base/v2-fork-anchor + add-whatsapp` exists; the skill
branch sits on top of that. CI can apply `add-whatsapp` programmatically as
the first step of the skill's test pipeline.

**Recommendation: Model A.** It matches how all other multi-skill stacks work
(e.g. `add-taskflow` depends on `add-whatsapp`; `add-image-vision` does not
depend on anything). Codex's concern is purely about not assuming
`createWhatsAppAdapter` exists; ordering is independent of that concern. The
manifest's `depends:` list is enough.

---

## 8. Shared-number echo detection in v2

There is **no per-board agent prefix** in v2 trunk — only the global
`ASSISTANT_NAME` (default `Andy`) plus the `ASSISTANT_HAS_OWN_NUMBER` flag.
From `src/config.ts:8-12, 42`:

```ts
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', ...]);
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;
```

The WhatsApp adapter does echo detection in two layers
(`origin/channels:src/channels/whatsapp.ts`):

```ts
// Layer 1 — drop platform-confirmed echoes from this device (line 544-548)
const fromMe = msg.key.fromMe || false;
// fromMe is always true for messages sent from this linked device,
// regardless of ASSISTANT_HAS_OWN_NUMBER mode.
if (fromMe) continue;

// Layer 2 — flag bot-prefixed messages from a *different* device sharing the number (line 550)
const isBotMessage = ASSISTANT_HAS_OWN_NUMBER ? false : content.startsWith(`${ASSISTANT_NAME}:`);
```

Then on outbound (line 693):

```ts
const prefixed = ASSISTANT_HAS_OWN_NUMBER ? formatted : `${ASSISTANT_NAME}: ${formatted}`;
return sendRawMessage(platformId, prefixed);
```

So:

- **Dedicated number** (`ASSISTANT_HAS_OWN_NUMBER=true`): no prefix on outbound,
  no `isBotMessage` flag on inbound. `fromMe` filtering catches own-device
  echoes; loops aren't possible because the dedicated number is never a
  human participant.
- **Shared number** (`ASSISTANT_HAS_OWN_NUMBER=false`, the default): every
  outbound is prefixed `Andy: …`, and inbound matching that prefix is flagged
  `isBotMessage=true`. The router uses this to drop the message before
  spawning a session.

Implications for our 28-board fork:

- v2 has **one global agent name** for echo detection. v1 had per-group
  trigger patterns (we use `@Case` for TaskFlow groups vs `@Tars` global) —
  v2 keeps `@<ASSISTANT_NAME>` global and lets routing happen via
  `messaging_group_agents.engage_pattern` per board.
- Per-board agent display name (e.g. each TaskFlow board has its own bot
  identity) is the agent_group's `name`, surfaced in the router prompt-prep
  layer, not in `whatsapp.ts`. Echo detection is still the single
  `ASSISTANT_NAME` prefix.
- For the 28-board shared-number setup we run, `ASSISTANT_HAS_OWN_NUMBER=false`
  is correct and the existing prefix-based loop guard works as long as every
  agent emits `Andy: ` (or whatever single value lives in `.env`) as its
  outbound prefix. **The skill must NOT add per-board prefix logic to
  `whatsapp.ts`**; that's a routing/agent concern, not a channel one.

---

## 9. Summary — concrete actions for `skill/whatsapp-fixes-v2`

1. **Branching:** branch from `base/v2-fork-anchor`. Manifest
   `depends: [add-whatsapp]`. The runner applies `add-whatsapp.sh` first to
   land the upstream baseline, then overwrites `src/channels/adapter.ts`
   and `src/channels/whatsapp.ts` with the skill's `modify/` versions.

2. **Adapter interface change** (`modify/src/channels/adapter.ts`): add three
   optional methods to `ChannelAdapter` (`createGroup`, `lookupPhoneJid`,
   `resolvePhoneJid`) with full JSDoc explaining when each can be omitted.
   Everything else byte-identical to upstream.

3. **WhatsApp impl change** (`modify/src/channels/whatsapp.ts`): add the three
   methods inside the existing factory closure on the returned `adapter`
   object. Do NOT add any export. Keep the closing
   `registerChannelAdapter('whatsapp', { factory: () => { … } });` shape.

4. **Tests** (`tests/whatsapp-extensions.test.ts`): rewrite to use the
   registry pattern (Option A in §5). Mock Baileys at the module level (kept
   from current test). Reach the adapter via `getChannelAdapter('whatsapp')`
   after `initChannelAdapters()`, **not** a non-existent
   `createWhatsAppAdapter()`. Set `process.cwd()` (or chdir) to a temp
   directory before the test and seed a fake `store/auth/creds.json` so the
   factory doesn't return null.

5. **No fork-private LOGIC duplication**: per the user's "use v2 natives"
   feedback, anything v2 already exposes (e.g. `setTyping?`,
   `syncConversations?`) stays as-is — the skill only adds the three
   capabilities v2 genuinely doesn't have.

6. **Removal criterion**: when upstream merges any of the three methods (or
   their equivalents) onto `ChannelAdapter`, diff the skill's `modify/<path>`
   against upstream and delete the now-redundant content. Skill retired when
   all three land.

7. **Echo detection**: leave alone. Use the global `ASSISTANT_NAME` /
   `ASSISTANT_HAS_OWN_NUMBER` model. Per-board identity is router-layer, not
   channel-layer.

---

## Appendix A — pinned dependency versions

From `setup/add-whatsapp.sh:21-25`:

| Package | Version |
|---|---|
| `@whiskeysockets/baileys` | `6.17.16` |
| `qrcode` | `1.5.4` |
| `@types/qrcode` | `1.5.6` |
| `pino` | `9.6.0` |

These are the only deps `add-whatsapp` adds to `package.json`. Any extra
deps the skill needs (e.g. test-only) go in `package.json` only via the skill
manifest, never in the `add-whatsapp` install path.

## Appendix B — file shapes after a clean apply

Starting from `base/v2-fork-anchor`, after `add-whatsapp` then `whatsapp-fixes-v2`:

```text
src/channels/
├── adapter.ts                       ← OVERWRITTEN by whatsapp-fixes-v2 (adds 3 optional methods)
├── ask-question.ts                  ← (already in trunk)
├── channel-registry.ts              ← (already in trunk)
├── cli.ts                           ← (already in trunk)
├── index.ts                         ← APPENDED:  import './whatsapp.js';
└── whatsapp.ts                      ← COPIED from origin/channels, then OVERWRITTEN by whatsapp-fixes-v2

setup/
├── add-whatsapp.sh                  ← (already in trunk)
├── groups.ts                        ← COPIED from origin/channels by add-whatsapp.sh
├── whatsapp-auth.ts                 ← (already in trunk — fork of channels-branch version)
├── index.ts                         ← (already in trunk; STEPS map already has the two lines)
└── channels/whatsapp.ts             ← (already in trunk — setup:auto driver)

.claude/skills/
├── add-whatsapp/SKILL.md            ← (already in trunk; describes the same flow)
└── whatsapp-fixes/                  ← OUR fork-private skill
    ├── manifest.yaml                (depends: [add-whatsapp])
    ├── SKILL.md
    ├── modify/src/channels/adapter.ts
    ├── modify/src/channels/whatsapp.ts
    └── tests/whatsapp-extensions.test.ts  (rewritten to use registry, NOT a factory import)
```

No edits to `src/index.ts`, `package.json` outside the four pinned deps,
or any of the host files.
