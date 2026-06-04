# Dashboard-originated notification delivery — tf-mcontrol owns it (#401)

**Audience:** the **tf-mcontrol owner / agent** (owner of `/root/tf-mcontrol/`).
**Author:** the nanoclaw engine agent (owner of `/root/nanoclaw/container/agent-runner/src/`). nanoclaw is the writer here; tf-mcontrol is read-only to nanoclaw, so everything below is a **request/contract for the tf-mcontrol side to implement** — nanoclaw will NOT deliver these.

**Decision (owner, 2026-06-04):** notifications for mutations that originate from the **tf-mcontrol dashboard** (its FastAPI subprocess driving the TaskFlow engine) are **tf-mcontrol's responsibility to deliver**. nanoclaw delivers notifications ONLY for mutations made by the in-container WhatsApp agent. This is **not a v1 regression** — v1 had no dashboard.

---

## Why the dashboard path delivers nothing today (verified at source)

The same TaskFlow engine is driven two ways:

1. **In-container WhatsApp agent** — a mutation's `notification_events` are emitted as one `taskflow_dispatch_notifications` system row on the session `outbound.db`; the nanoclaw host delivers them over WhatsApp.
2. **tf-mcontrol dashboard** — spawns `bun container/agent-runner/src/mcp-tools/taskflow-server-entry.ts --db <taskflow.db>` and calls `api_*` tools over stdio. This subprocess sets a "service" path, so the dispatcher **deliberately no-ops**:

   - `dispatchNotificationEvents()` returns early when `getServiceOutboundDbPath()` is set — `container/agent-runner/src/mcp-tools/taskflow-notify-dispatch.ts:43-44` (gate) + `taskflow-helpers.ts:129` (`getServiceOutboundDbPath`). There is no session `outbound.db` in the subprocess, so there is nowhere for nanoclaw to write a delivery row.
   - Instead, **every mutating tool returns the `notification_events` array in its JSON response** for the caller (you) to act on:
     - `finalizeMutationResult` (reassign / move / admin) → `{ success, data, notification_events }` (`taskflow-api-mutate.ts:385-394`).
     - `finalizeCreatedTaskResult` (create) → `{ success, data, notification_events }` (`taskflow-api-mutate.ts` — as of #397 the create path normalizes + returns these too).
     - The dashboard update path → `{ success, data, notification_events }` (`taskflow-api-update.ts:358`).

So the events are **computed and handed to you** — they are simply not delivered by nanoclaw on the dashboard path. That is the boundary.

## The contract for tf-mcontrol

When the dashboard drives any mutating tool (`api_reassign`, `api_move`, `api_admin`, `api_create_task` / `api_create_simple_task`, `api_update_task` / `api_update_simple_task`), inspect `notification_events` in the JSON response and deliver each entry yourself. The array is a discriminated union on `kind` (`container/agent-runner/src/mcp-tools/taskflow-helpers.ts:22-58`):

| `kind` | Payload fields | How tf-mcontrol should deliver it |
|---|---|---|
| `direct_message` | `target_chat_jid`, `message` | The engine already resolved the recipient's WhatsApp group/DM JID. Deliver `message` to `target_chat_jid` (via whatever WhatsApp send path tf-mcontrol uses, or by handing it to nanoclaw — see note). |
| `parent_notification` | `parent_group_jid`, `message` | Deliver `message` to the parent board's group JID (`parent_group_jid`). |
| `deferred_notification` | `target_person_id`, **no JID** | The recipient's board isn't provisioned yet, so there's no JID. Same status as nanoclaw's WhatsApp path: **hold or drop** — there is no offline re-queue yet (nanoclaw #396 is the multi-session subsystem that will own this). Do NOT fabricate a JID. |
| `destination_message` | `destination_name`, `message` | Routed by symbolic destination name; resolve via the destinations registry. Cross-board approval flows only. |
| `in_chat_notice` | `message` (no target) | A "show in the current chat" card (e.g. "Convite pendente" forwardable invite). Render it in the dashboard's own UI / current conversation; it is not separately addressable. |

**Note on `direct_message`:** if tf-mcontrol prefers nanoclaw to do the actual WhatsApp send, the clean seam is for tf-mcontrol to POST the resolved `{target_chat_jid, message}` back to a nanoclaw delivery endpoint — but that endpoint does **not** exist today and building it is the "Build host-side delivery" option that was explicitly NOT chosen. Under the chosen decision, tf-mcontrol delivers on its side.

## What nanoclaw will NOT do

- nanoclaw will **not** add a host path to deliver dashboard-originated notifications. `dispatchNotificationEvents`'s subprocess no-op stays as-is by design.
- nanoclaw will **not** read taskflow.db host-side to resolve recipients for the dashboard path (the Codex#3 contract: host and the FastAPI subprocess may read different taskflow.db files — `src/modules/taskflow/taskflow-notify.ts:9-23`).

## Cross-reference

- WhatsApp-agent-side deterministic dispatch (the half nanoclaw owns): #389, shipped.
- Create-path assignee dispatch parity: #397, shipped (`taskflow-api-mutate.ts` `finalizeCreatedTaskResult`).
- Offline re-queue for `deferred_notification` (5-min TTL parity): #396, multi-session, container-side — applies to BOTH paths once built.
