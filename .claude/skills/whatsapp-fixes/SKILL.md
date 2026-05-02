---
name: whatsapp-fixes
description: Use when our 28-board fork needs WhatsApp adapter capabilities that v2's intentionally-minimal ChannelAdapter does not ship — specifically createGroup, lookupPhoneJid, resolvePhoneJid. Layers on top of upstream's add-whatsapp.
---

# WhatsApp Channel Extensions (v2-aligned)

Our fork's WhatsApp capability layer on top of upstream's `add-whatsapp` skill. Adds 3 optional methods to the `ChannelAdapter` interface and their WhatsApp implementations, all needed by `add-taskflow`'s board-provisioning consumers.

## Why this skill exists

v2's `ChannelAdapter` is intentionally minimal — only `setup`/`teardown`/`isConnected`/inbound callbacks/`deliver`/optional `setTyping`+`syncConversations`. It does NOT expose:

- `createGroup(subject, participants)` — agent-driven WhatsApp group creation. Required for TaskFlow board provisioning.
- `lookupPhoneJid(phone)` — phone-to-JID validation via `sock.onWhatsApp()`. Required to validate participants before adding to a new group.
- `resolvePhoneJid(phone)` — synchronous phone-to-JID for outbound DM routing. Required for TaskFlow's external-meeting-participant DM feature.

This skill is the **fork capability layer** that closes those gaps until upstream merges them (post-cutover PR opportunity).

## Dependencies

- `add-whatsapp` (upstream skill) — must be applied first; installs the base `src/channels/whatsapp.ts` from `upstream/channels`.

## Files

```
.claude/skills/whatsapp-fixes/
├── manifest.yaml                                  # core_version, modifies, depends, test
├── SKILL.md                                       # this file
├── modify/src/channels/adapter.ts                 # extends ChannelAdapter with 3 optional methods
├── modify/src/channels/adapter.ts.intent.md       # semantic contract for the interface change
├── modify/src/channels/whatsapp.ts                # adds 3 method impls on the WhatsApp adapter
├── modify/src/channels/whatsapp.ts.intent.md      # semantic contract for the impl change
└── tests/whatsapp-extensions.test.ts              # vitest contract tests
```

## How to apply (manifest-driven)

Follow the standard `apply-skill.ts` flow used by all NanoClaw skills with manifests (see `add-image-vision/manifest.yaml` for reference). The runner:

1. Verifies `add-whatsapp` is applied (per `depends:`).
2. Copies `modify/src/channels/adapter.ts` → `src/channels/adapter.ts` (overwrites).
3. Copies `modify/src/channels/whatsapp.ts` → `src/channels/whatsapp.ts` (overwrites).
4. Runs the test suite from `manifest.yaml::test`.

## Validation

```bash
npx vitest run --config .claude/skills/vitest.config.ts \
  .claude/skills/whatsapp-fixes/tests/
```

All 9 tests should pass after applying the skill (TDD-RED until `modify/<path>` impls land — see "Status" below).

## Removal criterion (when this skill becomes obsolete)

When upstream's `ChannelAdapter` interface adds these 3 methods (or equivalents), and the WhatsApp adapter implements them upstream — diff our `modify/<path>` against the new upstream and delete the redundant content. If the API matches exactly, the skill can be retired entirely.

## What this skill does NOT do (corrected from earlier scope)

Per Codex review #5 (2026-05-02):

- **Does NOT include per-org `engage_pattern`** — that's TaskFlow's responsibility (`add-taskflow` writes `messaging_group_agents.engage_pattern` per board; v2's router consults it natively).
- **Does NOT include DM routing for external meeting participants** — that's TaskFlow-specific (`dm-routing.ts` reads `taskflow.db`); moves to `add-taskflow`.
- **Does NOT include LID verification, reconnection backoff, pairing-code auth** — already in `upstream/channels:src/channels/whatsapp.ts` natively.
- **Does NOT include `setTyping` / `syncGroups` extensions** — `setTyping?` is already optional on v2's `ChannelAdapter` (different signature: `(platformId, threadId)` vs v1's `(jid, isTyping)`); `syncConversations?` replaces `syncGroups`. Consumer-side signature migration only.

## Status (2026-05-02)

- [x] Phase A.2 Step 1: `manifest.yaml` authored (this commit).
- [x] Phase A.2 Step 2-3 (intent.md): semantic contracts for both modify/ files authored.
- [x] Phase A.2 Step 4 (tests): vitest contract tests authored — currently TDD-RED (fail because impls don't exist yet).
- [ ] Phase A.2 Step 5 (impls): write `modify/src/channels/adapter.ts` (interface) + `modify/src/channels/whatsapp.ts` (impl with 3 methods). NEXT SESSION.
- [ ] Phase A.2 Step 6 (gate): apply skill against clean upstream worktree, verify all 9 tests pass.

## Source ports (for the next session)

- `createGroup` → port from v1 fork's `src/channels/whatsapp.ts:734-820` (~90 LOC including LID-aware verification + invite-link fallback). Adapt `logger.*` calls to v2's `log.*`.
- `lookupPhoneJid` → port from v1 lines 705-722 (~20 LOC).
- `resolvePhoneJid` → port from v1 lines 724-732 (~5 LOC).

Total fork addition: ~115 LOC on top of upstream/channels' 735-LOC adapter (15.6% surface increase). Plus 3 method declarations on the interface (~30 LOC).

## Post-cutover follow-up

Submit upstream PR proposing `createGroup` / `lookupPhoneJid` / `resolvePhoneJid` as ChannelAdapter additions. When merged, retire this skill.
