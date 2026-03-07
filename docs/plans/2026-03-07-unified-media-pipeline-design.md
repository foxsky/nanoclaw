# Unified Media Pipeline

**Date:** 2026-03-07
**Status:** Implemented

## Problem

The original `add-media-support` skill downloaded media files and made them available as file paths, but agents couldn't actually see images or extract text from PDFs. The upstream `add-image-vision` and `add-pdf-reader` skills solved these individually but conflicted with each other and with our existing media pipeline since all three modified `whatsapp.ts`.

## Design

Unify all three capabilities into a single media pipeline with specialized handling per type:

### Image Pipeline (Vision)
- Download via Baileys `downloadMediaMessage`
- Resize with `sharp` (max 1024px, JPEG, quality 85)
- Save to `groups/{folder}/attachments/`
- Produce `[Image: attachments/filename.jpg]` annotation
- Host parses `[Image: ...]` references via `parseImageReferences()` in `src/index.ts`
- Pass as `imageAttachments` through `ContainerInput`
- Container agent-runner loads files, base64-encodes, injects as multimodal content blocks into Claude API

### PDF Pipeline (Text Extraction)
- Download via `downloadAndSaveMedia` from `media.ts`
- Save to `groups/{folder}/attachments/`
- Produce `[PDF: attachments/filename.pdf (SIZE KB)]` with `pdf-reader extract` usage hint
- Container has `poppler-utils` (pdftotext/pdfinfo) + `pdf-reader` CLI wrapper
- Agent calls `pdf-reader extract attachments/file.pdf --layout` to read PDF content

### Document Pipeline (Download Only)
- Download via `downloadAndSaveMedia` from `media.ts`
- Save to `groups/{folder}/attachments/`
- Produce `[Document: attachments/filename.ext (SIZE KB)]` annotation
- DOCX/XLSX available for agent Read tool access

### Files Changed
- `src/image.ts` — New: sharp processing, image ref parsing
- `src/channels/whatsapp.ts` — Split image/PDF/document handling
- `src/container-runner.ts` — Added `imageAttachments` to `ContainerInput`
- `container/agent-runner/src/runtime-config.ts` — Added `imageAttachments` to `ContainerInput`
- `src/index.ts` — Parse image refs, pass to `runAgent`
- `container/agent-runner/src/index.ts` — Multimodal content block injection
- `container/Dockerfile` — Added `poppler-utils`, `pdf-reader` CLI
- `container/skills/pdf-reader/` — New: CLI wrapper + agent docs

### Dependencies
- `sharp` (host-side, for image resize)
- `poppler-utils` (container-side, for PDF text extraction)

### Scope
- Host-side media pipeline changes + container Dockerfile
- No CLAUDE.md template changes needed
- Applied to all groups automatically
