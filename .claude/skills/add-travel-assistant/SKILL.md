---
name: add-travel-assistant
description: Set up a travel group with itinerary management, scheduled reminders, emergency handling, and multi-participant coordination. Interactive setup — no source code changes.
---

# Add Travel Assistant

This skill sets up a dedicated travel assistant group in NanoClaw. It creates a group directory with a comprehensive CLAUDE.md, itinerary files, and scheduled tasks for daily briefings, transport reminders, and emergency handling.

No source code changes — this is a SKILL.md-only skill that guides Claude Code through interactive setup.

## Phase 1: Pre-flight & Information Gathering

### 1. Pre-flight Checks

#### Initialize skills system (if needed)

Check if `.nanoclaw/state.yaml` exists. If it does NOT exist, initialize the skills system first (run from the NanoClaw project root):

```bash
npx tsx -e "import { initNanoclawDir } from './skills-engine/index.js'; initNanoclawDir();"
```

(Note: `scripts/apply-skill.ts` does NOT support `--init` — use the inline import above. The relative import path requires cwd to be the project root.)

#### Check recommended dependencies

Read `.nanoclaw/state.yaml`:

- If `voice-transcription` is NOT in `applied_skills`, inform the user:
  > Voice transcription (`/add-voice-transcription`) is recommended — travelers often send voice messages during trips. You can add it later.

- If `media-support` is NOT in `applied_skills`, inform the user:
  > Media support (`/add-media-support`) is recommended — enables receiving itinerary files (PDFs, images) via WhatsApp. You can provide files via CLI instead.

Neither dependency is blocking — proceed regardless.

### 2. Trip Basics

Use `AskUserQuestion` to collect:

- **Trip name** — Used for the group folder name. Must be lowercase with hyphens, no spaces or special characters (e.g., "italy-2026", "eurotrip-summer"). If the user provides an invalid name, sanitize it (lowercase, replace spaces/special chars with hyphens) and confirm with them.
- **Start and end dates** — Full trip date range.
- **Language preference** — Ask explicitly which language to use for all agent output. If the user pastes itinerary content later, auto-detect the language from it and confirm it matches their preference.

### 3. Destinations

Ask for cities with date ranges. Accept free-form text — parse naturally. For each destination, note:
- City name and country
- Arrival and departure dates/times
- Timezone (detect from city, confirm with user if ambiguous)

### 4. Travelers

Ask for traveler details:
- Names (sanitize: strip newlines, control characters, limit to 50 characters)
- Optional WhatsApp JIDs for @mentions (validate format: `[0-9]+@s.whatsapp.net`)
- Roles (e.g., trip organizer, photographer)
- Any separate return routes (different flights home, etc.)

### 5. Itinerary Input

Offer three options:

1. **Paste itinerary text in chat** — Parse directly from the conversation.
2. **Provide a local file path** (PDF/DOCX/image) — Read with the `Read` tool.
   > **Security note:** This runs in the SKILL.md context (Claude Code on the host), not inside a container. Only read files the user explicitly provides — never glob or search for files.
3. **Skip** — Create a skeleton itinerary with dates and cities for each destination, to be filled in later.

### 6. WhatsApp Group

Ask which WhatsApp group to register:
- If they have an existing group, they'll need the JID from `available_groups.json`
- If creating a new group, instruct them to create it in WhatsApp first, then we'll register it

### 7. Optional Settings

- **Morning briefing time** — Default: 8:00 local time. Ask if they want a different time.
- **Afternoon updates** — Ask if they want optional afternoon updates (default: no).
- **Web access** — The travel group benefits from web search for weather and real-time info. Ask if they want to enable `allowWeb` for this group (recommended: yes).
