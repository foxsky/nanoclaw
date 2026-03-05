# ipc.ts Modifications

Add `resolvePhoneJid` to the `IpcDeps` interface:

```typescript
export interface IpcDeps {
  // ...existing fields...
  resolvePhoneJid?: (phone: string) => Promise<string>;
}
```

This is an optional method used by `create-group` and `provision-child-board` plugins to resolve phone numbers to WhatsApp JIDs before creating groups.
