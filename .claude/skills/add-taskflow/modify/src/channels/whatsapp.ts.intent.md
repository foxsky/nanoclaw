# whatsapp.ts Modifications

Add `resolvePhoneJid` method to the `WhatsAppChannel` class. This is used by `create-group` and `provision-child-board` IPC plugins to resolve phone numbers to proper WhatsApp JIDs before creating groups.

Add this method after the `isValidJid` method:

```typescript
async resolvePhoneJid(phone: string): Promise<string> {
  const results = await this.sock.onWhatsApp(phone);
  if (results?.length && results[0].exists) {
    return results[0].jid;
  }
  // Fallback: use raw digits
  return phone.replace(/\D/g, '') + '@s.whatsapp.net';
}
```
