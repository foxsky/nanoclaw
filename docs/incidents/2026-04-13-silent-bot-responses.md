# 2026-04-13 — Silent bot responses across TaskFlow groups

**Severity:** Medium (audit trail + partial data-loss window).
**Detected:** 2026-04-14 morning, via Kipp's 2026-04-13 daily audit flagging 73/73 interactions as `noResponse=true`.
**Resolved:** 2026-04-14 08:27 BRT (commit `cf93d42` self-echo fix). Task-container-hang half fixed earlier at 2026-04-13 19:21 BRT (commit `00c4753`).
**Two distinct bugs compounded in the incident window.**

## Timeline (all times BRT unless noted)

| When | What |
|---|---|
| 2026-04-12 18:38 | Commit `6ae3d6c` lands — adds `if (type !== 'notify') return` to Baileys `messages.upsert` handler. Intent: drop historical-replay messages. Side-effect: also drops self-echoes, which Baileys delivers with `type !== 'notify'` on shared-number installs. |
| 2026-04-12 evening | `6ae3d6c` deployed as part of 20-bug-hunt batch. Last `is_from_me=1` row in production `messages.db` stops landing — `2026-04-11T07:01:58` is the final record. |
| 2026-04-11 / 04-12 | Weekend silence masks the regression — few real user messages, no visible bug. |
| 2026-04-13 ~08:00 | TF-STANDUP fires across TaskFlow boards. Task-containers hang (separate bug `00c4753` — `scheduleClose` only fired on truthy result; standup agent returns null). |
| 2026-04-13 08:35 | Miguel sends "Anotar: Reparo do boiler, para: Alexandre, prazo: hoje" on sec-secti. Router logs `Container active, message queued`. Message stuck in in-memory `pendingMessages` — task container refuses inbound `sendMessage` IPC via the `isTaskContainer` guard. |
| 2026-04-13 08:00–19:21 | ~9-hour window: users send messages to TaskFlow groups, messages queue behind hung standup containers. Mutations that DID complete during brief non-task windows were written to DB but bot self-echoes never reached `messages.db` (6ae3d6c filter). |
| 2026-04-13 19:21 | Commit `00c4753` deploys — `scheduleClose()` moves into `status === 'success'` branch. Stuck containers close, queue can drain. `_close` sentinel also written manually to sec-secti by operator to recover Miguel's queued message. |
| 2026-04-13 19:21–24:00 | Bot now responds to new messages, but self-echoes still not persisting. User-visible: OK. Audit: still blind. |
| 2026-04-14 morning | Kipp's daily audit runs against `messages.db`, sees zero `is_from_me=1` rows, flags 73/73 interactions as `noResponse=true`. Report escalates to operator. |
| 2026-04-14 07:50 | Investigation begins. Confirms `send_message_log` shows 91 deliveries on 04-13 (bot DID send) but `messages.db` has 0 bot rows — root cause localized to self-echo filter. |
| 2026-04-14 08:05 | Codex gpt-5.4 high review of proposed fix — surfaces observability log recommendation. |
| 2026-04-14 08:27 | Commit `cf93d42` deploys — per-message guard `if (type !== 'notify' && !msg.key?.fromMe) continue`. Self-echoes resume landing in `messages.db`. |
| 2026-04-14 11:28 | First post-fix `is_from_me=1` row. Fix empirically validated by matching `Allowing non-notify self-echo` debug log entries to messages.db writes. |

## Root causes

### Bug 1 — self-echo filter too broad (`6ae3d6c`)

Commit `6ae3d6c` targeted historical message replay on reconnect — a real bug that caused duplicate agent invocations. Fix used `if (type !== 'notify') return` as a blanket early-return.

Empirically, Baileys emits our own `sendMessage` outputs back through the same `messages.upsert` event with `type !== 'notify'` (confirmed post-fix by 3 matching debug log entries for 3 self-echoes). The blanket filter dropped them, so `messages.db` never received `is_from_me=1` rows.

**Blast radius**: audit trail. User-visible behavior OK — WhatsApp still delivered bot replies normally. Any downstream consumer that reads `messages.db` for conversational state was corrupted (primary: the auditor at `container/agent-runner/src/auditor-script.sh:298`).

### Bug 2 — task-container close skipped on null result (`00c4753`)

Separate bug. `src/task-scheduler.ts` called `scheduleClose()` only when `streamedOutput.result` was truthy. The TF-STANDUP agent emits its board output via `send_message` MCP and returns null as final assistant text → `scheduleClose` never fires → container stays up forever, blocking the group's inbound `sendMessage` IPC.

**Blast radius**: real data loss. Messages sent while a task-container was hung queued in `pendingMessages` (in-memory). On 19:21 restart, the in-memory queue was lost. ~49 user messages from 9 users never reached an agent at all.

## Impact analysis

### User-visible

- **~9 hours of lost messages** (08:00–19:21 BRT, 2026-04-13) on boards whose 08:00 standup had hung a task-container.
- **9 users affected**, 49 messages total. Full list: `scripts/find-dropped-messages.sql`.
- Confirmed data-inconsistency case: Alexandre Godinho (tec-taskflow) announced T87, T88, T94 as complete; only T87 landed as `done`. T88 and T94 stuck in `review`.

### Data integrity

- TaskFlow DB (`data/taskflow/taskflow.db`): intact — every mutation that completed was correct.
- Context/LCM DB (`data/context/context.db`): unaffected — uses JSONL transcripts, not messages.db.
- Credentials/config: no exposure at any point.
- Audit DB (`store/messages.db`): `is_from_me` / `is_bot_message` flags missing from 2026-04-11T07:02 to 2026-04-14T11:28 (~73h). Recoverable by cross-joining `send_message_log`.

### Operational

- Kipp's 2026-04-13 daily audit was a false-positive flood. Discarded.
- Lucas Batista (asse-seci-taskflow) had 29 dropped messages — a full day of notes and process tracking lost. Largest individual impact.

## Remediation

### Shipped

- `cf93d42` (2026-04-14 08:27 BRT) — per-message type filter, lets `fromMe` self-echoes through. Codex-reviewed before deploy.
- `00c4753` (2026-04-13 19:21 BRT) — `scheduleClose` moved into success branch.
- Debug log `Allowing non-notify self-echo for audit trail` added for future regression visibility.
- `scripts/find-dropped-messages.sql` committed for re-running the analysis in future incidents.
- New regression test: `persists fromMe self-echoes even when upsert type=append (audit trail)` in `src/channels/whatsapp.test.ts`.

### Follow-ups

1. **Proactive outreach** to the 9 affected users (draft messages in the PR description / ops channel). Highest priority: Alexandre (T88/T94 state mismatch), Lucas (29 dropped notes).
2. **End-to-end test harness** covering the full `sendMessage → messages.upsert → messages.db` round-trip. Current tests catch unit behavior; neither bug tripped any test. (Open issue — see post-mortem Lessons.)
3. **Audit of `messages.db` flag integrity** as a periodic check, not just when a human notices. Could run as a scheduled task every hour: `SELECT COUNT(*) FROM messages WHERE timestamp > datetime('now','-1 hour') AND (is_from_me=1 OR is_bot_message=1)` — alert if 0 during business hours.
4. **Reconnect-during-message-queue handling** — `pendingMessages` lives in memory, so `systemctl restart` drops it. Consider persisting the queue to disk (similar to `outgoingQueue.saveQueue()` in whatsapp.ts) so messages survive restart.

## Lessons

1. **Filter-at-the-wrong-layer hides regressions.** The `6ae3d6c` filter was at event-ingress. Narrower filter at the agent-invocation layer would have preserved the audit trail while fixing the duplicate-processing bug.
2. **Weekend silence masks weekday bugs.** Both bugs landed on 2026-04-12 (Friday evening) and weren't caught until Monday morning 48+ hours later. Pre-weekend deploys should run a synthetic smoke test that exercises bot-reply persistence, not just "service comes up."
3. **E2E tests with in-prompt markers are broken by the prompt-injection defense.** My own test-harness kept saying "all green" because it never verified the full round-trip. Updated `reference_e2e_scheduled_task_pattern.md` memory to use out-of-band signals only.
4. **Two bugs can compound silently.** The task-container hang would have been an obvious outage (no replies) on its own. Stacked with the self-echo filter suppressing audit data, both looked like one mysterious issue — until we ran `send_message_log` vs `messages.db` count diffs.
5. **Audit-trail divergence from runtime behavior deserves a sanity check at every deploy.** A "bot replies but isn't logged" state is a silent-failure magnet. The debug log `Allowing non-notify self-echo` is a cheap canary for this specific regression; a broader "messages.db bot-row rate" metric would catch the whole class.
