# index.ts Modifications

Two changes:

## 1. Per-group trigger pattern support

Import `buildTriggerPattern` from `./config`:

```typescript
import { ASSISTANT_NAME, buildTriggerPattern, /* ...existing imports... */ } from './config';
```

In both places where `TRIGGER_PATTERN.test(m.content.trim())` is used for non-main groups, replace with per-group pattern when available:

```typescript
const pattern = group.trigger
  ? buildTriggerPattern(group.trigger)
  : TRIGGER_PATTERN;
const hasTrigger = groupMessages.some((m) =>
  pattern.test(m.content.trim()),
);
```

This appears in two locations:
- `processGroupMessages()` — the "check if trigger is present" block
- `startMessageLoop()` — the "needsTrigger" block

## 2. Wire up resolvePhoneJid

In the IPC deps object passed to `setupIpc()`, add `resolvePhoneJid`:

```typescript
resolvePhoneJid: (phone) => {
  if (!whatsapp) throw new Error('WhatsApp not connected');
  return whatsapp.resolvePhoneJid(phone);
},
```
