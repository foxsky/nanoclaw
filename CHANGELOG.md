# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Unreleased]

- **fix:** Require approval by default before delegated assignees can close tasks; delegated `conclude` now moves to `review` instead of `done`
- **fix:** Suppress duplicate parent-board notifications when creator and parent notification targets resolve to the same group
- **fix:** Self-heal stale TaskFlow `board_id_counters` during task creation so `taskflow_create` can recover from counter drift without SQLite write fallbacks
- **fix:** Harden custom trigger bot-message detection and external DM routing safety
- **feat:** Add TaskFlow schema support for external meeting participants

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
