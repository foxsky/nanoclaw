# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Unreleased]

- **fix:** Require approval by default before delegated assignees can close tasks; delegated `conclude` now moves to `review` instead of `done`
- **fix:** Suppress duplicate parent-board notifications when creator and parent notification targets resolve to the same group
- **fix:** Self-heal stale TaskFlow `board_id_counters` during task creation so `taskflow_create` can recover from counter drift without SQLite write fallbacks
- **fix:** Harden custom trigger bot-message detection and external DM routing safety
- **feat:** Add TaskFlow schema support for external meeting participants
- **feat:** BGE-M3 embedding service via Ollama — generic host service + container reader for semantic indexing
- **feat:** TaskFlow embeddings integration — semantic search, duplicate detection (0.85 threshold), context preamble injection
- **fix:** Inbox processing promotes tasks in-place via `taskflow_reassign` instead of create-new + cancel-original
- **fix:** Implicit inbox promotion — auto-assign to board owner when user reports progress on unassigned inbox task
- **fix:** 61+ bugs fixed across 14 files (3 rounds of 20 subagents)
- **fix:** WhatsApp group plugin — 7 bugs from 37-bug audit (null guard, participant cap, LID verify, stale socket, JID normalization, droppedParticipants tracking, re-verify catch)
- **fix:** WhatsApp message queue re-queues on send failure instead of losing messages
- **fix:** WhatsApp LID translation for group message senders with `participantAlt` fallback
- **fix:** Sender allowlist device suffix normalization (`:N@s.whatsapp.net` → `@s.whatsapp.net`)
- **feat:** Hierarchical long-term context skill — DAG summarization, FTS5 search, incremental byte-offset cursor, conversation recap preamble, context_search/recall MCP tools
- **fix:** Cron idempotency guard — `cronSlotAlreadyRan()` prevents re-execution on process restart
- **fix:** IPC transient error retry (5 attempts) + error directory eviction (7 days / 1000 files cap)
- **fix:** 18 bugs fixed across 4 rounds of 20 subagents — subtask ID collision, counter seeding regression, WhatsApp reconnection race, DM duplicate delivery, FTS5 MATCH injection, Docker option injection, cleanupOrphans command injection, SDK errors as success, stripInternalTags regex, embedding indexer re-entrancy, DM routing WAL mismatch, delegated task duplication, group name dedup, shutdown retry timer leak, monthly rollup orphans, NFD Unicode in topics, scheduler infinite loop, outputChain hang

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
