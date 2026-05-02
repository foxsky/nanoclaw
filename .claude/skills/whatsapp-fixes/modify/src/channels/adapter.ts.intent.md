# Intent: extend ChannelAdapter with 3 fork-private optional methods

## Base file

`upstream/channels:src/channels/adapter.ts`. v2's `ChannelAdapter` interface is intentionally minimal: lifecycle (setup/teardown/isConnected), inbound callbacks (onInbound/onInboundEvent/onMetadata/onAction), single outbound entry (deliver), plus 2 already-optional helpers (setTyping, syncConversations).

## Why we extend

TaskFlow's board provisioning needs 3 capabilities that v2's adapter doesn't expose:

1. **`createGroup`** — agent-driven WhatsApp group creation. TaskFlow boards auto-create their underlying WhatsApp group at provisioning time (with N participants). v2 has no equivalent — `create_agent` MCP tool creates an agent_group skeleton but does NOT create the platform group. Without this, every TaskFlow board provisioning step regresses.

2. **`lookupPhoneJid`** — phone-to-JID validation. Before adding a participant to a new group, TaskFlow validates the number is on WhatsApp (`sock.onWhatsApp(phone)`). Avoids creating groups with invalid participants.

3. **`resolvePhoneJid`** — phone-to-JID resolution for outbound DM routing. TaskFlow's external-meeting-participant DM feature resolves a phone number to a chat JID before sending.

## Why optional (`?`)

Other channel adapters (Slack, Telegram, Discord, Signal) have different group-creation semantics. Marking these methods optional on the interface lets the WhatsApp adapter implement them without forcing other adapters to. Host-side TaskFlow code calls `adapter.createGroup?.(...)` and falls back if absent.

## Why on the interface, not just the impl

TaskFlow's host-side code accesses the adapter through `getDeliveryAdapter()` which returns `ChannelDeliveryAdapter`. To call our 3 methods on that handle, they need to be on the interface.

## Specific addition

Append 3 optional method declarations to the `ChannelAdapter` interface:

```ts
/**
 * Create a new platform group with the given participants. Optional —
 * Slack/Discord/Telegram have different group-creation semantics and may
 * omit this. WhatsApp implementation lives in our fork-private extension
 * to channels/whatsapp.ts.
 *
 * @returns the new group's platform JID, the resolved subject, optional
 * invite link, and the list of participants the platform refused to add.
 */
createGroup?(
  subject: string,
  participants: string[],
): Promise<{
  jid: string;
  subject: string;
  inviteLink?: string;
  droppedParticipants?: string[];
}>;

/**
 * Verify a phone number is registered on the platform. Returns the
 * canonical platform JID if registered, null if not. WhatsApp uses
 * `sock.onWhatsApp()`. Other channels may omit.
 */
lookupPhoneJid?(phone: string): Promise<string | null>;

/**
 * Resolve a phone number to its platform JID without round-trip to the
 * platform's "is registered" API. WhatsApp constructs `<digits>@s.whatsapp.net`
 * after `normalizePhone()`.
 */
resolvePhoneJid?(phone: string): Promise<string>;
```

## Why we don't extend deliver()

v2's `OutboundMessage.content` is `unknown` and `deliver()` discriminates by content shape (e.g., `content.type === 'ask_question'`). We could route createGroup through a new content type, but that's:
- async (host queues outbound, sweeps deliver, agent gets result via inbound);
- harder to test;
- worse UX for synchronous board provisioning.

Direct method calls are cleaner. The 3 methods are not message-shaped operations.

## Removal criterion

When upstream merges these (or equivalent) into the main `ChannelAdapter` interface, this modify/ file becomes redundant — diff against new upstream + delete.

## Compatibility

The base file content matches `upstream/channels:src/channels/adapter.ts` byte-for-byte except for the 3 method declarations appended inside the `ChannelAdapter` interface. No type re-exports moved. No existing methods touched.
