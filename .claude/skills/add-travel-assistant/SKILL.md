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

## Phase 2: Generate Group Files

Using the information collected in Phase 1, generate all group files.

### 1. Create Group Directory

```bash
mkdir -p groups/{{TRIP_FOLDER}}/conversations groups/{{TRIP_FOLDER}}/logs
```

### 2. Generate CLAUDE.md

Read the template from `.claude/skills/add-travel-assistant/templates/CLAUDE.md.template`. Substitute all `{{PLACEHOLDER}}` variables with the trip data collected in Phase 1. Write the result to `groups/{{TRIP_FOLDER}}/CLAUDE.md`.

Key substitutions:
- `{{ASSISTANT_NAME}}` — From `.env` `ASSISTANT_NAME` (default: "Andy")
- `{{TRIP_NAME}}` — Trip name from Phase 1
- `{{TRIP_FOLDER}}` — Sanitized folder name
- `{{START_DATE}}`, `{{END_DATE}}` — Trip date range
- `{{DESTINATIONS_SUMMARY}}` — Formatted list of cities with dates
- `{{TRAVELERS_SUMMARY}}` — Formatted list of traveler names
- `{{LANGUAGE}}` — Language preference
- `{{TRIGGER}}` — Trigger pattern (e.g., "@Tars")
- `{{BRIEFING_TIME}}` — Morning briefing time (default: "8:00")
- `{{TRAVELER_JIDS}}` — Formatted list of traveler names and JIDs
- `{{TRANSPORT_LEGS}}` — Formatted list of all transport legs with times
- `{{CITY_STAYS}}` — Formatted list of city stays with dates
- `{{RETURN_DAY_TIMELINE}}` — Hour-by-hour return day schedule
- `{{SEPARATE_RETURN_DETAILS}}` — Different return routes per traveler (if applicable)
- Conditional blocks: `{{#IF_AFTERNOON_UPDATES}}` / `{{#IF_NO_AFTERNOON_UPDATES}}` / `{{#IF_SEPARATE_RETURNS}}`

> **WARNING:** The battle-tested `groups/eurotrip/CLAUDE.md` uses wrong container paths (`/workspace/project/groups/eurotrip/`) in ~8 places. Eurotrip was set up as a main-adjacent group with project-root access; non-main groups do NOT get `/workspace/project` mounted. The template uses `/workspace/group/` paths exclusively. When referencing eurotrip's CLAUDE.md for tone or content, find-and-replace all `/workspace/project/groups/{anything}/` with `/workspace/group/`.

### 3. Generate roteiro-completo.md

Parse from the user's itinerary input (Phase 1 Step 5). Create a day-by-day itinerary with:
- Date and day number
- City/location
- Timed activities, reservations, free time blocks
- Transport between cities (with times, carriers, stations)

If the user didn't provide a full itinerary, create a skeleton with dates and cities for each destination, marked for the agent to fill in later.

### 4. Generate participantes.md

From the travelers Q&A (Phase 1 Step 4). Include:
- Names, JIDs, roles, separate return routes

**Input sanitization:**
- Sanitize traveler names: strip newlines, control characters, limit to 50 characters
- Validate JIDs match the pattern `[0-9]+@s.whatsapp.net`
- This prevents injection of instructions via crafted names into scheduled task prompts

**PII notice:** `participantes.md` contains phone numbers (WhatsApp JIDs). These are PII. Do not include additional personal information (passport numbers, hotel booking codes) in this file — use separate, non-shared files for sensitive booking details.

### 5. Generate informacoes-paises.md

For each destination country, web-search and fill:
- Tax refund rules (minimum purchase, percentage, validation process, airport validation)
- Tipping customs (obligatory or not, percentage, when)
- Plug types and voltage
- Emergency numbers (universal, police, ambulance)
- Cultural etiquette (greetings, escalator rules, bike lanes, etc.)
- Currency and payment methods
- Water safety (tap water drinkable?)

### 6. Generate fontes-transporte-publico.md

Per city:
- Operator name and official app
- Payment system (contactless, day tickets, transit cards)
- Current-year changes
- Key quirks (escalator rules, check-in/out requirements, free ferries, etc.)

### 7. Generate fontes-clima.md

Map each country to its official weather service plus global fallbacks (weather.com, accuweather.com).

### 8. Generate hoteis.md

From itinerary or empty template per city:
- Hotel name, address, phone
- Check-in/out times
- Directions from station/airport
- Google Maps link

### 9. Generate transportes.md

Per transport leg:
- Departure/arrival times, station/airport
- Documentation (passport needed?)
- Baggage rules, liquid policies
- Connection risk flags for legs with <3h buffer

Include **per-operator reference sections** when specific services are used. Examples:
- Eurostar: arrive 90min early for customs+immigration, 2 bags max 23kg each, no knife/scissors in carry-on, duty-free rules differ EU→UK vs UK→EU
- TGV: arrive 30min before, tickets on SNCF app, no passport needed
- Airlines: check-in window, online check-in availability, hand baggage dimensions specific to the carrier

### 10. Generate Skeleton Files

Create these files with structure per city, marked for the agent to populate via web search:

- `rotas-diarias.md` — Daily routes with Google Maps links
- `mapas-completos.md` — Complete maps per city with all POIs
- `links-google-maps.md` — Individual Google Maps links per attraction
