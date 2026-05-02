# Intent: implement 3 optional ChannelAdapter methods on the WhatsApp adapter

## Base file

`upstream/channels:src/channels/whatsapp.ts` (735 LOC). The native Baileys v6 adapter that `add-whatsapp` (upstream skill) installs. We extend it with 3 method implementations.

## Why we extend

To satisfy `add-taskflow`'s board-provisioning consumers (per `whatsapp-fixes/modify/src/channels/adapter.ts.intent.md`):

1. `createGroup(subject, participants)` — wraps `sock.groupCreate()` + adds: 1024-participant cap check, post-create participant verification with 2s WhatsApp propagation delay, LID-aware participant matching, invite-link fallback when verify fails, dropped-participants reporting.
2. `lookupPhoneJid(phone)` — wraps `sock.onWhatsApp([phone])` and returns canonical JID or null.
3. `resolvePhoneJid(phone)` — synchronous-style resolution: normalize the phone number then construct `<digits>@s.whatsapp.net`. No platform round-trip.

## Source ports

The 3 methods are ported from our v1 fork's `src/channels/whatsapp.ts`:

- `createGroup`: lines 734-820 (verbatim port; adapt logger.* calls to v2's `log.*`).
- `lookupPhoneJid`: lines 705-722 (verbatim port).
- `resolvePhoneJid`: lines 724-732 (verbatim port).

## Why methods on the impl class, not deliver() dispatch

See `adapter.ts.intent.md` — direct method calls are cleaner than async outbound dispatch for synchronous board provisioning.

## Specific change

Inside the WhatsApp adapter implementation (the object/class returned by the module's factory), add 3 methods that close over the live `sock: WASocket` reference. These methods are visible on the interface (since adapter.ts marks them optional on `ChannelAdapter`) AND on the impl object returned to the host.

Implementation sketch (full code in modify/<path>):

```ts
// Inside the adapter setup function, after sock is created:

async function createGroup(subject, participants) {
  if (participants.length > 1023) {
    throw new Error(`Too many participants (${participants.length}): WhatsApp limit is 1024 including creator`);
  }
  const result = await sock.groupCreate(subject, participants);
  if (!result?.id) throw new Error(`groupCreate returned no result for "${subject}"`);
  const groupJid = result.id;
  // ... LID-aware verification + invite-link fallback (port from v1) ...
  return { jid: groupJid, subject, inviteLink, droppedParticipants };
}

async function lookupPhoneJid(phone) {
  const cleaned = normalizePhone(phone);
  if (!cleaned) return null;
  const [exists] = await sock.onWhatsApp(cleaned);
  return exists?.exists ? `${exists.jid}` : null;
}

async function resolvePhoneJid(phone) {
  const cleaned = normalizePhone(phone);
  if (!cleaned) throw new Error(`Cannot resolve phone "${phone}"`);
  return `${cleaned}@s.whatsapp.net`;
}

// Expose them on the returned adapter object:
return {
  name, channelType, supportsThreads,
  setup, teardown, isConnected, deliver,
  setTyping, syncConversations, subscribe,    // existing
  createGroup, lookupPhoneJid, resolvePhoneJid, // NEW
};
```

## Tests (in `whatsapp-fixes/tests/`)

- `createGroup`: mock socket → call createGroup → verify groupCreate called + result-shape returned.
- `createGroup` with 1024 participants: should throw before calling groupCreate.
- `createGroup` with verify-fail: socket disconnects between groupCreate and verify → returns invite-link with all participants in droppedParticipants.
- `lookupPhoneJid` with registered number: mock `sock.onWhatsApp([phone])` → returns canonical JID.
- `lookupPhoneJid` with unregistered: returns null.
- `resolvePhoneJid`: returns `<normalized>@s.whatsapp.net`.

## Removal criterion

When upstream's `ChannelAdapter` includes these methods (interface AND WhatsApp impl), this entire skill becomes redundant — diff against new upstream + delete.

## Compatibility

Base file content matches `upstream/channels:src/channels/whatsapp.ts` byte-for-byte except for the 3 added method definitions and the 3 added entries in the returned adapter object. No existing methods or imports modified.
