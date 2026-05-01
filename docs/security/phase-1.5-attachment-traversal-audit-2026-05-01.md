# Phase -1.5 audit — attachment path-traversal in v1.2.53

**Date:** 2026-05-01
**Audit driver:** v2 attachment-safety back-port (plan Phase -1.5)
**Conclusion: NO-OP for v1.2.53.** The v2 vulnerability class does not exist in our codebase. No code changes required; no prod deploy needed.

## v2 vulnerability (what we set out to back-port)

Upstream commits `7e37b13a` (2026-04-XX, channel-inbound), `6e5e568d` + `2a3be9ec` (2026-04-XX, agent-sent attachments), plus `fc3c11b6` + `852009dc` (v2.0.22 outbox path-confinement). The fix introduces `src/attachment-safety.ts:isSafeAttachmentName()`:

```typescript
export function isSafeAttachmentName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/\0]/.test(name)) return false;
  return path.basename(name) === name;
}
```

Wired into v2's `session-manager.ts:272, 282, 431, 454, 486` and `agent-route.ts:73`. The bug was: user-supplied attachment names (from channel adapters and agent-to-agent forwards) flowed unvalidated into `path.join(dir, name)` sinks, allowing `..`-laden names to escape the inbox dir.

## v1.2.53 audit — every file-write sink, classified

Greppped `fs.writeFileSync\|fs.writeFile\|fs.create` across `src/` and `container/agent-runner/src/`. For each sink, traced the filename source.

### Synthesized filenames (safe — no user input)

| Sink | Filename source |
|------|-----------------|
| `src/image.ts:42` (inbound WhatsApp image) | `` `img-${Date.now()}-${Math.random().toString(36).slice(2,6)}.jpg` `` |
| `src/group-queue.ts:243` (IPC message file) | `` `${Date.now()}-${Math.random().toString(36).slice(2,6)}.json` `` |
| `container/agent-runner/src/ipc-mcp-stdio.ts:195` (MCP IPC) | `` `${Date.now()}-${Math.random().toString(36).slice(2,8)}.json` `` |
| `src/container-runner.ts:761,870` (timeout / container logs) | `` `container-${ts}.log` `` (ISO timestamp) |
| `src/whatsapp-auth.ts:70-152` (auth status) | Fixed paths (`STATUS_FILE`, `QR_FILE`) |
| `src/container-runner.ts:236` (settings.json) | Fixed name `settings.json` |

### Sanitized filenames (safe — strict whitelist)

| Sink | Sanitization |
|------|--------------|
| `container/agent-runner/src/index.ts:230` (transcript archive) | `sanitizeFilename(summary)` at line 269: `summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+\|-+$/g, '').slice(0,50)` — output is purely `[a-z0-9-]`, max 50 chars |
| Any code path receiving a `groupFolder` (board provisioning) | `isValidGroupFolder()` in `src/group-folder.ts:8`: whitelist `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, explicit `..` rejection, separator rejection, reserved-name rejection, plus `ensureWithinBase()` canonical-path check (defense in depth) |

### User-supplied filename → `path.join` (the v2 bug class)

**ZERO instances found.** Confirmed via:

```bash
grep -rn "path\.join.*\\b\\(req\\|msg\\|data\\|args\\|input\\|params\\|content\\|body\\|user\\|sender\\)" \
  /root/nanoclaw/src/ /root/nanoclaw/container/agent-runner/src/ \
  | grep -v ".test.ts"
```

Only matches were already-validated `groupFolder` and IPC dirs — none take filename input from chat participants or agents.

### MCP send_file / send_attachment tool

v1 has no `send_file` MCP tool. The MCP tools registered in `container/agent-runner/src/ipc-mcp-stdio.ts` (`schedule_task`, etc.) do not accept user-supplied filenames at all.

## Why v1 is structurally immune

The v2 vulnerability was introduced when v2 added:

1. `session-manager.ts` — a session-level inbox/outbox staging dir abstraction
2. Agent-to-agent attachment forwarding (`agent-route.ts`)
3. SDK `send_file` MCP tool that accepts user-supplied filenames

v1 has **none** of these. Our IPC architecture is single-direction file drops with synthesized names, and our channel-inbound media path produces internally-named files.

## Outcome

- **No code changes.** The v2 sanitizer would be dead code on top of paths that already use stronger guards or synthesized names.
- **No prod deploy.** Nothing to ship.
- **No 48h soak required.** Phase -1.5 closes via audit.

## Future-proofing

If we add code paths that take user-supplied filenames (e.g., a future `send_file` MCP tool, a ChatGPT-style file-upload feature, an attachment-rename feature):

1. **DO** port `isSafeAttachmentName()` from v2 OR use existing `isValidGroupFolder()` (stricter whitelist).
2. **DO** add a test that asserts a `..`-laden name is rejected at the validation boundary.
3. **DO NOT** rely on `path.basename()` alone — Windows separators slip through; use the full guard.

When v2 migration completes (Phase 5 cutover), we automatically inherit v2's `attachment-safety.ts` since it ships in the upstream codebase. No fork-private maintenance burden.

## Sign-off

Audit conducted via systematic grep of all `fs.writeFileSync` / `fs.writeFile` / `fs.createWriteStream` sinks in `src/` and `container/agent-runner/src/`, with each filename source traced to either (a) internal synthesis (`Date.now()` + `Math.random()`), (b) strict-whitelist sanitization, or (c) operator-validated input via `isValidGroupFolder()`. No code path was found where an unvalidated user-supplied filename reaches a `path.join` sink.
