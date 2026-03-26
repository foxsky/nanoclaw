---
name: whatsapp-fixes
description: "Bug fixes for the WhatsApp channel: LID participant verification, reconnection with exponential backoff, multi-trigger bot detection. Fixes group creation always generating invite links, tight reconnection loops, and bot responding to its own messages in custom-trigger groups."
---

# WhatsApp Channel Fixes

Bug fixes for `src/channels/whatsapp.ts` that benefit all WhatsApp users. These are improvements to the upstream WhatsApp skill, not new features.

## Installation

```bash
git fetch upstream skill/whatsapp-fixes
git merge upstream/skill/whatsapp-fixes --no-edit
npm run build
```

## Fixes Included

### 1. LID Participant Verification (createGroup)

**Problem:** When creating WhatsApp groups, the bot verifies participants were added by fetching group metadata and matching JIDs. WhatsApp returns LID JIDs for newly added participants that the bot can't translate back to phone JIDs (not cached). This caused ALL participants to appear as "missing", triggering unnecessary invite links on every group creation.

**Fix:** Verify by participant count first — if `meta.participants.length >= expectedCount`, all were added. Falls back to enriched JID matching using `p.phoneNumber`/`p.lid` from metadata. Adds 2-second delay before verification to let WhatsApp propagate additions.

**File:** `src/channels/whatsapp.ts` — `createGroup` method

### 2. Reconnection with Exponential Backoff

**Problem:** On transient connection errors, the bot could enter tight reconnection loops, hammering the WhatsApp servers and potentially getting rate-limited or banned. No guard against duplicate reconnection attempts.

**Fix:** `attemptReconnect` retries up to 5 times with exponential backoff (5s, 10s, 20s, 40s, 60s cap). Guards against duplicate reconnect attempts with a `reconnecting` flag. Only clears the flag on successful reconnection (connection='open' handler), not in finally blocks.

**File:** `src/channels/whatsapp.ts` — connection error handler

### 3. Multi-Trigger Bot Detection

**Problem:** Bot message detection only checked `ASSISTANT_NAME` (e.g., "Kipp"). Groups with custom trigger names (e.g., "Case") would cause the bot to process its own messages as user input, creating echo loops.

**Fix:** Bot message detection now checks all registered group trigger patterns, not just `ASSISTANT_NAME`. A message prefixed with any registered trigger is correctly identified as a bot message and skipped.

**File:** `src/channels/whatsapp.ts` — `messages.upsert` handler
