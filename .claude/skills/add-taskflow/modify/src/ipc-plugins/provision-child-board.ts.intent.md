# provision-child-board.ts Modifications

When creating the WhatsApp group for the child board, resolve the phone JID before passing it as a participant:

Replace:
```typescript
const result = await deps.createGroup(childGroupName, [
  personPhone + '@s.whatsapp.net',
]);
```

With:
```typescript
const participantJid = deps.resolvePhoneJid
  ? await deps.resolvePhoneJid(personPhone)
  : personPhone + '@s.whatsapp.net';
const result = await deps.createGroup(childGroupName, [participantJid]);
```

This ensures the phone number is resolved to the correct WhatsApp JID format before group creation.
