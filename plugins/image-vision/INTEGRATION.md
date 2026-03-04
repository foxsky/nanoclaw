# Integration Guide: Image Vision Plugin

This guide shows how to integrate the Image Vision Plugin into NanoClaw **without modifying the core code**.

## Step 1: Enable Plugin in Group Config

Edit `/workspace/project/data/registered_groups.json`:

```json
{
  "120363424913709624@g.us": {
    "name": "Eurotrip",
    "folder": "eurotrip",
    "trigger": "@Case",
    "added_at": "2026-02-18T00:00:00Z",
    "plugins": {
      "image-vision": {
        "enabled": true,
        "maxMediaAge": 7,
        "maxFileSize": 10485760
      }
    }
  }
}
```

## Step 2: Hook into Message Processing

In `src/index.ts`, add after line 788 (after `storeMessage` call):

```typescript
// Import at top of file
import { processMessageMedia } from './plugins/image-vision/index.js';

// In messages.upsert handler, after storeMessage():
if (registeredGroups[chatJid]) {
  storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined);

  // NEW: Download media if plugin is enabled
  const mediaPath = await processMessageMedia(msg, chatJid, registeredGroups[chatJid].folder);
  if (mediaPath) {
    logger.info({ chatJid, mediaPath }, 'Media downloaded by plugin');
  }
}
```

## Step 3: Pass Media to Container Agent

Modify `src/db.ts` to store media paths:

```typescript
// Add to NewMessage interface in types.ts
export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  message_type: string;
  media_path?: string;  // NEW
  timestamp: string;
}

// In storeMessage(), add parameter:
export function storeMessage(
  msg: proto.IWebMessageInfo,
  chatJid: string,
  isFromMe: boolean,
  pushName?: string,
  mediaPath?: string,  // NEW
): void {
  // ... existing code ...

  db.prepare(
    `INSERT OR REPLACE INTO messages
     (id, chat_jid, sender, sender_name, content, message_type, media_path, timestamp, is_from_me)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msgId,
    chatJid,
    sender,
    senderName,
    content,
    messageType,
    mediaPath || null,  // NEW
    timestamp,
    isFromMe ? 1 : 0,
  );
}

// Add migration for media_path column:
try {
  db.exec(`ALTER TABLE messages ADD COLUMN media_path TEXT`);
} catch {
  /* column already exists */
}
```

## Step 4: Modify Container Agent to Send Images

In the agent container (not shown in project, but would be in Claude SDK):

```typescript
// When processing messages, read media files and send to Claude
const messages = getMessagesSince(...);

for (const msg of messages) {
  if (msg.media_path && fs.existsSync(msg.media_path)) {
    // Read image file
    const imageData = fs.readFileSync(msg.media_path);
    const base64Image = imageData.toString('base64');
    const mimeType = getMimeType(msg.media_path); // helper function

    // Include in Claude API call
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType,
        data: base64Image,
      }
    });
  }

  content.push({
    type: "text",
    text: `<message sender="${msg.sender_name}" time="${msg.timestamp}" type="${msg.message_type}">${msg.content}</message>`
  });
}
```

## Alternative: Non-Invasive Hook Pattern

Instead of modifying core files, create a plugin loader:

`src/plugin-loader.ts`:
```typescript
import { initImageVisionPlugin } from './plugins/image-vision/index.js';

export function loadPlugins(): void {
  try {
    initImageVisionPlugin();
  } catch (err) {
    console.error('Failed to load plugins:', err);
  }
}
```

Then in `src/index.ts`, just add at startup:
```typescript
import { loadPlugins } from './plugin-loader.js';

async function main() {
  loadPlugins();  // Single line added
  // ... rest of existing code
}
```

## Testing

1. Enable plugin in group config
2. Send an image with caption "@Case what is this?"
3. Check `/workspace/project/groups/eurotrip/media/` for saved file
4. Verify agent receives image in prompt

## Benefits

- ✅ Minimal code changes (3-4 lines in core)
- ✅ Plugin is self-contained
- ✅ Can be disabled per-group
- ✅ Automatic cleanup
- ✅ TypeScript type safety
- ✅ Easy to extend for future plugins
