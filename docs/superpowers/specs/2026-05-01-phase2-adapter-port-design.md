# Phase 2 WhatsApp Adapter Port — Design (Task 2.2 Deliverable)

> **Status:** scoped. Restored from v2.5's "dissolved" claim after Codex EOD review #2 (B1 + B2). Estimated work: **~100 LOC + integration tests, 1-2 days** (not Codex's worst-case 1-2 weeks).

## What v1 fork has

`src/channels/whatsapp.ts` (973 lines) implements a `Channel` interface with:
- `connect()` / `disconnect()` / `reconnect()` lifecycle
- `sendMessage(jid, text, sender?)` / `sendMessageWithReceipt()`
- `setTyping(jid, isTyping)`
- `syncGroupMetadata()` (v2's equivalent: syncConversations)
- `lookupPhoneJid()` / `resolvePhoneJid()` / `createGroup()`
- A single `onMessage` callback fired on inbound text/voice/image messages

What it lacks: any concept of structured outbound (button cards) or inbound action replies.

## What v2 expects (`upstream/main:src/channels/adapter.ts`)

`ChannelSetup` interface:

```ts
interface ChannelSetup {
  onInbound(platformId, threadId, message: InboundMessage): void | Promise<void>;
  onInboundEvent(event: InboundEvent): void | Promise<void>;
  onMetadata(platformId, name?, isGroup?): void;
  onAction(questionId: string, selectedOption: string, userId: string): void;
}
```

Key new surface:
- **`onAction(questionId, selectedOption, userId)`** — fired when a user picks an option in an `ask_question` card.
- **`OutboundMessage.content.type === 'ask_question'`** — adapter must render as text + track `pendingQuestions` map for matching inbound replies.
- `replyTo: DeliveryAddress` on `InboundEvent` — admin-transport routing override (rarely used outside CLI).
- `isMention` / `isGroup` flags on `InboundMessage` — platform-confirmed mention signals.

## What `upstream/channels:src/channels/whatsapp.ts` adds (~735 lines, 1504-line diff vs v1)

The v2 adapter handles `ask_question` outbound at lines 627-655:

```ts
if (content.type === 'ask_question' && content.questionId && content.options) {
  const optionLines = options.map(o => `  ${optionToCommand(o.label)}`).join('\n');
  const text = `*${title}*\n\n${question}\n\nReply with:\n${optionLines}`;
  const msgId = await sendRawMessage(platformId, text);
  if (msgId) {
    pendingQuestions.set(platformId, { questionId, options });
    // ... bounded cache eviction
  }
}
```

And the inbound match at line 559:
```ts
if (matchedOption) {
  setupConfig.onAction(pending.questionId, matched.value, sender);
}
```

Plus: `reaction` handling (operation === 'reaction'), `file` outbound, `getMessage` fallback. These are nice-to-haves, **not** MVP for permissions/approval-card flow.

## Recommended path: Path A (surgical addition)

Add the `ask_question` handler to our existing `WhatsAppChannel`. Don't repoint to upstream/channels' adapter. Reasoning:
- Our adapter has TaskFlow-specific hooks (logger ILogger compat, group-sender, timezone) that would need re-porting if we switched bases. Each is 5-50 LOC of fork-private logic.
- Path B (wholesale repoint) is ~3-5 days and creates merge conflicts on every future upstream pull.
- The MVP gap for permissions/approval-cards is **just `ask_question`** + the matching inbound flow. Maybe `reaction` if we want bot ✅/❌ feedback. ~100-150 LOC total.

### Concrete tasks (~100 LOC)

1. **Outbound `ask_question` rendering** in `sendMessageWithReceipt` (or a new `sendStructured()` method). Render the card as `*title*\n\nquestion\n\nReply with:\n  /allow\n  /deny`. Track `pendingQuestions: Map<platformId, {questionId, options}>` with a 100-entry LRU eviction.
2. **Inbound option matching** in the `messages.upsert` handler. After existing transcription/image processing, check if the message is text and matches a pending option. If yes, fire `onAction(questionId, optionValue, senderJid)` and don't forward to `onMessage`.
3. **Wire `onAction` in `WhatsAppChannelOpts`** — caller passes the host's `handleSenderApprovalAction`/`handleChannelApprovalAction` callbacks.
4. **Optional: reaction outbound** — if `content.operation === 'reaction'`, send a Baileys `react` message. ~10 LOC.

### Tests (TDD, ~150 LOC)

- Outbound: emit ask_question event → adapter sends text with options → pendingQuestions map has the entry.
- Inbound: pendingQuestions has entry → user sends `/permitir` → onAction fires with 'approve' → entry cleared.
- Eviction: 101st pending → first one drops.
- Negative: user replies non-matching text → onMessage gets it (not onAction).

## Why not Path B (repoint to upstream/channels)

Pros:
- Get all v2 features at once: file outbound, getMessage, syncConversations, reactions, action replies.
- Less long-term divergence — every upstream/channels improvement reaches us via merge.

Cons:
- Have to re-port our 5+ fork-private hooks: logger ILogger compat (`src/logger.ts` extensions for Baileys), `group-sender.ts` (sender-name extraction), `phone.ts` (normalization), `transcription.ts` (voice-to-text), `image.ts` (resize/save).
- Larger diff to absorb at every upstream pull.
- More test surface to validate (every method, not just ask_question).

For Phase 2 MVP, Path A wins. Path B can happen as a Phase 6 cleanup if/when we want full v2 feature parity.

## Phase 2 timeline

- Task 2.2 (this doc): DONE.
- Task 2.3 (adapter port): see scope-realization below — channel-side is **only one third** of Task 2.3.
- Task 2.4 (E2E test): blocked on Phase 0.5 operator phone.
- Task 2.5 (gate): structural diff resolved + approval card runtime-verified locally.

### Scope realization (2026-05-01 EOD, before implementation)

The "~100 LOC channel-side ask_question rendering" estimate is correct in isolation but produces **dead code** without three other ports landing in the same phase:

1. **Channel-side adapter port (~100 LOC):** the ask_question outbound rendering + pendingQuestions map + inbound option-match → onAction callback. ESTIMATE: 1 day.
2. **`ChannelOpts` interface extension:** add `onAction?: (questionId, optionValue, senderUserId) => void` to `src/channels/registry.ts:ChannelOpts`. Touches every channel registration site (whatsapp.ts:955, telegram.ts, etc.). ESTIMATE: half a day.
3. **Host-side permissions module port:** `requestSenderApproval()` from `upstream/main:src/modules/permissions/sender-approval.ts` plus the supporting `pickApprover` + `pickApprovalDelivery` + `pending_sender_approvals` schema migration + `getApprovalStrategy` router hook. This is what GENERATES the `ask_question` outbound; without it, nothing on the host side fires. ESTIMATE: 2-3 days.
4. **Wire host-side approval handler to channel `onAction`:** when admin replies "Permitir", the channel calls `onAction` → router.ts looks up the pending row → calls `addAgentGroupMember` + replays the original message via `routeInbound`. ESTIMATE: half a day.

**Real Task 2.3 budget: 4-5 days, not 1 day.** The channel-side alone is well-bounded but isolated; the full vertical slice that delivers a working approval card requires all four pieces.

**Why the original estimate was wrong:** I scoped only the diff against `upstream/channels`'s WhatsApp adapter, ignoring that v2's permissions module is **also** missing from feat/v2-migration. Phase 1 only ported `container/agent-runner/` to Bun; the host-side `src/modules/` directory wasn't touched. Phase 2 must include the host-side permissions port, OR the channel-side work is dead until Phase 3 / 2.5 ports it later.

### Recommendation: bundle host-side into Task 2.3

Don't ship channel-side in isolation. The vertical slice (4 components above, ~5 days) is the smallest unit that delivers a working approval-card flow. Phase 2 was already restored in plan v2.6; the budget should reflect this scope, not the under-scoped 1-day estimate.

Plan: Phase 2 budget moves from "3-5 days" → "**1 week**" full-time, or 2 weeks if interleaved with Phase 3 isMain prep work.

Net plan timeline: stays at ~10-13 weeks (Phase 2 longer; Phase 3 partial overlap).

## Open questions

1. **Slash-command matching:** v2's `optionToCommand('Allow')` becomes `/allow`. We're translating to PT-BR (`Permitir` → `/permitir`). Need to verify `optionToCommand` accents-handling for Portuguese — does `Negar` cleanly become `/negar`? Test before relying.
2. **DM vs group context for cards:** approval cards are sent to the admin's DM (per `pickApprovalDelivery` flow). Confirm our adapter can DM the operator's phone JID, not just the group JID.
3. **Action reply attribution:** when admin replies `/permitir` in their DM with the bot, the `sender` is the admin's JID. Verify it matches the user_id we seeded (`whatsapp:558699916064@s.whatsapp.net`). Codex F6 said yes (LID translation + `participantAlt` already handles this in our adapter at `whatsapp.ts:292`).
