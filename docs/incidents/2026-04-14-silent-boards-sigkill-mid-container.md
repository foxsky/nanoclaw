# 2026-04-14 — Silent boards (writes OK, responses dropped) from SIGKILLs mid-container

**Severity:** High on two boards, Medium on ~five others (response-delivery, not mutation).
**Detected:** 2026-04-15 morning, via Kipp's 2026-04-14 daily audit.
**Resolved:** 2026-04-15 12:45 BRT (commit `56702cf` — durable outbound queue + boot recovery + SIGTERM drain). Systemd margin `TimeoutStopSec=120` applied 12:47 BRT on production host.

Distinct from the 2026-04-13 incident: this one was a *delivery-path* failure, not a self-echo/task-hang bug. The agent ran fine, wrote DB mutations fine, produced valid stdout — the host process reading that stdout was SIGKILL'd before it could call `channel.sendMessage`.

## Timeline (all times BRT unless noted)

| When | What |
|---|---|
| 2026-04-14 07:04 | David (EST-SECTI) sends `seci-p15.4 concluir`. Enqueued. |
| 2026-04-14 07:54 | User container spawns for David with the 07:04 message as first prompt; 20+ David messages queued behind it. |
| 2026-04-14 08:03–08:06 | Ana Beatriz (ASSE-SECI/2, board newly provisioned by Giovanni) sends `listar atividades`, `m2`, `M2`, `M1`. Her messages fall inside the instability window. |
| 2026-04-14 08:04 | Daily standups fire across boards; some boards had messages in-flight at the same time. |
| 2026-04-14 08:25 | `systemctl stop nanoclaw` initiated. Service goes to `final-sigterm`. |
| 2026-04-14 08:27 | SIGKILL — `State 'final-sigterm' timed out. Killing.` Five `docker` processes killed; `Unit process remains running after unit stopped` logged for several. Service immediately `Started` again by systemd. |
| 2026-04-14 09:17–09:19 | Second SIGKILL cycle, same fingerprint. |
| 2026-04-14 10:22–10:23 | Third SIGKILL cycle. Orphan container(s) from 07:54 continue processing David's piped IPC messages with nowhere for stdout to go. |
| 2026-04-14 18:36 | Clean restart. |
| 2026-04-14 20:14 | `dist/task-scheduler.js` timestamp — at least one operational deploy that evening. |
| 2026-04-15 morning | Kipp's 2026-04-14 audit posts: **EST-SECTI/David 20 of 20 silent**, **ASSE-SECI/Ana Beatriz 4 of 4 silent**, plus 23 "writes OK, no confirmation" cases across other boards. |
| 2026-04-15 ~09:00 | Investigation begins. Cross-checks David's container log (Duration 2993831ms, 15 `---NANOCLAW_OUTPUT_START---` blocks in stdout) against `messages` table (zero bot rows for that JID in the window). Pattern matches "host-killed-mid-container" exactly. |
| 2026-04-15 12:43 | Commit `56702cf` — durable `outbound_messages` queue, dispatcher, SIGTERM drain, boot recovery. |
| 2026-04-15 12:45 | Deploy. Table created on boot, WhatsApp reconnected, 0 rows pending. |
| 2026-04-15 12:47 | `TimeoutStopSec=120` added to `/home/nanoclaw/.config/systemd/user/nanoclaw.service` and `daemon-reload`'d. Verified via `systemctl --user show nanoclaw -p TimeoutStopUSec` → `2min`. |

## Root cause

**Delivery path had no durability.** Agent results flowed: container stdout → host parser (`container-runner.ts` `onOutput`) → in-process callback → `channel.sendMessage`. Nowhere along that chain did the message persist. If the host process died between parse and send, the result was lost — forever — even though the mutation it reported had already committed in the DB.

On 2026-04-14 three SIGKILL cycles landed exactly during peak activity. Each cycle:

1. `systemctl stop` starts the graceful-shutdown path.
2. Host's handler calls `queue.shutdown(10000)` which only **detaches** active containers (by design, to protect working agents from WhatsApp reconnect restarts — see `src/group-queue.ts:423` comment).
3. `TimeoutStopSec` default 90s elapses with containers still running; systemd issues SIGKILL.
4. `docker` CLI processes die, container daemon leaves the actual Linux containers running as orphans (`Unit process remains running after unit stopped`).
5. Orphan containers continue processing piped IPC messages from the mid-run IPC queue. stdout keeps producing valid `---NANOCLAW_OUTPUT_START---` blocks. Nothing is reading them.
6. New nanoclaw process comes up, has no knowledge of the orphans, spawns new containers on demand.

David's 07:54 container shows this crisply: Duration 2993831ms = 49.9 min (started 07:54, finished ~08:44), but the host reading it was dead from 08:25 onward. 15 well-formed successful results generated; 0 delivered.

**Why writes survived and responses didn't**: MCP tools inside the container committed directly to `data/taskflow/taskflow.db` via the bind-mounted connection. Those writes hit disk independent of the host. Responses went only through stdout → in-memory host state → in-memory WhatsApp-client buffer. Zero disk persistence until the final WhatsApp ack landed.

**Why so many SIGKILLs that day**: Production HEAD was at 9cc1619 (2026-03-10, unchanged since), so this was not bad code. `dist/task-scheduler.js` mtime 20:14 indicates at least one deploy that day; the morning restarts were operational (`systemctl restart`). Shutdowns empirically took >90s because containers in mid-query ignored the indirect shutdown signal, which is the deliberate "detach not kill" policy compounding against a systemd timeout tuned for a simpler process.

## Impact analysis

### User-visible

- **David (EST-SECTI), 20 of 20 messages silent** between 07:04 and 08:13 BRT. Every mutation he requested landed correctly in the TaskFlow DB; zero confirmations reached WhatsApp. Two of those silent interactions were `quadro` / `quadros` reads that have no mutation — pure response-path failures with nothing to fall back on.
- **Ana Beatriz (ASSE-SECI/2), 4 of 4 messages silent** between 08:03 and 08:06 BRT on a freshly-provisioned board. Fell exactly in the instability window after the 08:25 SIGKILL.
- **Lucas (ASSE-SECI), 3 delayed responses** (~9 min each) with the holiday-announcement prompt threaded through his replies — orphan container absorbed his IPC messages.
- **~12 "successful write, no confirmation" cases** scattered across SECI-SECTI, SETEC-SECTI, Tec-TaskFlow, and others. Users saw their changes happen (board state updated when they checked) but got no bot acknowledgment, which eroded trust in the bot's responsiveness.

### Data integrity

- TaskFlow DB: intact. Every mutation that the agent issued committed correctly.
- `messages.db`: the bot-reply rows are missing for the lost responses, but the user-message rows are all present.
- Audit DB (`send_message_log`): shows no deliveries for the lost responses — the host never got to the `channel.sendMessage` call, so no log entry.
- Credentials/config: no exposure.

### Operational

- Kipp's audit surfaced the full signature correctly ("silêncio total em dois boards, escritas OK sem confirmação em vários") — the existing auditor pipeline worked. The human read was needed to distinguish delivery failure from template gap.

## Remediation

### Shipped

- **`56702cf` (2026-04-15 12:43 BRT)** — `feat(delivery): durable outbound queue + boot recovery + SIGTERM drain`. Inverts the delivery path: `onOutput` → `enqueueOutbound(...)` → SQLite `outbound_messages` table → `OutboundDispatcher` → `channel.sendMessage`. Boot-recovery is automatic (any row with `sent_at IS NULL AND abandoned_at IS NULL` from a previous run is delivered on the next dispatcher poll). Per-row 5s timeout, per-drain deadline (20s), `DRAIN_QUIET_MS = 2000` tail, FIFO on `(enqueued_at, id)`, abandon-after-10. SIGTERM drains before channels disconnect. 8 new tests (`src/outbound-dispatcher.test.ts`), 986 total pass.
- **Codex gpt-5.4 high reviewed twice before deploy.** Round 1 flagged overclaimed delivery certainty, authoritative-drain phrasing, unbounded single-send blocking. Round 2 flagged batch-overrun (25 hung rows × 5s = 125s beats the 20s drain). Both rounds' findings applied. Round 2 approved ship.
- **`TimeoutStopSec=120`** on `/home/nanoclaw/.config/systemd/user/nanoclaw.service` (applied via `daemon-reload`, no restart needed). Backup kept at `nanoclaw.service.bak.20260415-124720`.

### Follow-ups

1. **At-least-once → true delivery receipts.** Channel contracts today swallow transport errors (`channels/whatsapp.ts:482`, `channels/telegram.ts:253`), so `markOutboundSent` fires on Promise-resolve, not on actual delivery ack. Tightening this would require each channel to surface a real delivery signal. Design work, not a blocker.
2. **Detach policy review.** `src/group-queue.ts:423` deliberately does NOT kill active containers on shutdown, so a restart-happy deploy day can leave orphans. Either (a) keep current policy, accept orphans, and rely on outbound queue to recover (today's posture), or (b) add a real drain with SIGTERM→wait→SIGKILL escalation so orphans stop producing. (a) is simpler and aligned with "working-agent protection"; (b) gives deterministic shutdowns at the cost of complexity.
3. **Proactive outreach to affected users**: David (20 confirmations missing), Ana Beatriz (4), Lucas (3 delayed). Their board states are correct; only confirmations were lost.

## Lessons

1. **In-memory is not a delivery path.** The pre-fix architecture treated the stdout→callback→sendMessage pipeline as reliable because it always worked in local tests. A single host death exposed that nothing persisted between "result produced" and "result delivered." Any asynchronous-result step that matters should pass through disk before it can be lost.
2. **"Writes OK, confirmation missing" is a delivery-failure fingerprint.** The 2026-04-14 audit report classified several as "template gap" or "UX suggestion" — they were actually the same bug as David's silence, lower-dose. When triaging, cross-check `send_message_log` count against user-message count per board per day: a large gap on a specific board and window is a delivery hole, not a language-coverage hole.
3. **Detach semantics interact with systemd timeouts.** A graceful-shutdown handler that detaches (doesn't wait for) docker containers will eat the full systemd `TimeoutStopSec` every time on any day with real activity. 90s was fine in isolation and routinely fine in practice; three times in one morning it wasn't. Either wait on producers or set the timeout with the worst-case shutdown length in mind — don't assume the accounting.
4. **Post-mortem hypothesis is not deploy-ready.** Going straight from "I think this is the bug" to a fix works until it doesn't. Making Codex review a hard gate before the commit that triggers deploy caught two separate blocker-class issues in this change alone (overclaimed delivery, batch-overrun). Non-negotiable rule now.
5. **The bot kept doing work with nobody watching.** Orphan containers processed David's messages for 17 minutes after the host that spawned them was dead. The MCP mutations in that window committed correctly — which sounds good but is actually a silent consistency hazard: state can change with no user-visible signal. The durable outbound queue removes the silent half; a logged "outbound-detected-from-orphan" metric would be a cheap future canary.
