# create-group.ts Modifications

Before calling `deps.createGroup(subject, participants)`, resolve participant JIDs via WhatsApp lookup when `resolvePhoneJid` is available:

```typescript
// Resolve participant JIDs via WhatsApp lookup when available
let resolvedParticipants = participants;
if (deps.resolvePhoneJid) {
  resolvedParticipants = await Promise.all(
    participants.map(async (jid) => {
      const phone = jid.replace(/@s\.whatsapp\.net$/, '');
      return deps.resolvePhoneJid!(phone);
    }),
  );
}

const result = await deps.createGroup(subject, resolvedParticipants);
```

This ensures phone numbers are resolved to correct WhatsApp JIDs (handling country code variations) before creating groups.
