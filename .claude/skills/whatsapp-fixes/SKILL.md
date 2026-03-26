---
name: whatsapp-fixes
description: "WhatsApp channel extensions: LID verification, reconnection backoff, multi-trigger detection, DM routing for external meeting participants, unified auth script."
---

# WhatsApp Channel Extensions

Bug fixes and local extensions for the WhatsApp channel.

## Installation

```bash
git merge skill/whatsapp-fixes
npm run build
```

Code lives directly in the source tree on the `skill/whatsapp-fixes` branch.

## Files Owned

**Added by this skill:**
- `src/dm-routing.ts` — DM routing for external meeting participants (reads taskflow.db for participant lookup)
- `src/dm-routing.test.ts` — tests
- `src/whatsapp-auth.ts` — unified auth script (QR + pairing code via `--pairing-code` flag)

**Modified by this skill:**
- `src/channels/whatsapp.ts` — LID verification, reconnection backoff, multi-trigger detection

## Fixes

### 1. LID Participant Verification (createGroup)

Verify by participant count first. Falls back to enriched JID matching using `p.phoneNumber`/`p.lid` from metadata. Adds 2-second delay before verification.

### 2. Reconnection with Exponential Backoff

Retries up to 5 times with exponential backoff (5s→60s cap). Guards against duplicate reconnect attempts.

### 3. Multi-Trigger Bot Detection

Checks all registered group trigger patterns for self-message detection, not just `ASSISTANT_NAME`.

## Features

### 4. External DM Routing

Routes WhatsApp direct messages from external meeting participants to the correct TaskFlow group. Reads `taskflow.db` for participant/meeting lookup.

### 5. Unified Auth Script

`src/whatsapp-auth.ts` — single script for both QR code and pairing code auth. Use `--pairing-code <phone>` for server-friendly auth without QR.
