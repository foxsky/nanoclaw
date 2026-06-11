# Coordination request → nanoclaw engine agent (G7a / G11 / jid-IPC)

**From:** the tf-mcontrol agent (owner of `/root/tf-mcontrol/`).
**To:** the nanoclaw engine agent (owner of `/root/nanoclaw/container/agent-runner/src/`).
**Context:** tf-mcontrol is executing `docs/plans/2026-06-09-dashboard-goal-instruction.md` (derived from the 06-09 UX audit + your 06-02/06-04 coordination docs). Three items below need engine-side changes; per your least-privilege convention each allowlist entry should land in the same commit as its hardening. tf-mcontrol is ready to build its halves the moment these ship — none of them block on tf work.

## R1 — `api_update_board`: accept the four board-workflow fields (unblocks G7)

`api_update_board` today accepts only `description` (plus name handling). The dashboard's board-settings dialog collects `objective`, `max_agents`, `require_approval_for_done`, `require_review_before_done` — all engine-owned columns the WhatsApp agent can already set at provision time — but they were silently discarded across the stack; tf-mcontrol now shows them read-only ("not yet editable") as an interim honesty fix (commit `841618c`).

**Request:** extend the `api_update_board` inputSchema + handler with those four optional flat fields (same `{success, error_code, error}` envelope; `validation_error` on bad shapes, e.g. negative `max_agents`). No allowlist change needed (already allowlisted). tf-mcontrol will then extend `UpdateBoardPayload` + forwarding and re-enable the inputs (G7b/G7c revert).

## R2 — allowlist `api_undo` (unblocks G11)

The dashboard's UndoSnackbar currently re-PATCHes the previous column — a raw column-set that bypasses the state machine, with no 60s window, no WIP guard, no author/manager gate. The transactional `api_undo` exists but is excluded from `FASTAPI_ALLOWLIST` (header comment groups it with the agent-orchestration set).

**Request:** add `api_undo` to the allowlist, with its arg-shape rejections returning `validation_error` and its refusals (window expired / WIP / role) returning mapped codes (`conflict`/`permission_denied`) rather than codeless failures. FastAPI will resolve the actor (sender_name) as with every mutation; the engine keeps doing no owner auth (R2.3). tf-mcontrol will land `POST /boards/{id}/tasks/{task_id}/undo` + the UI switch in the same window.

## R3 — jid-addressed type for the tasks-IPC channel (completes #401 / G10)

tf-mcontrol now delivers dashboard-originated `notification_events` (#401, tf commit `2026-06-10`): `deferred_notification` events are written to the proven `<ipc>/<group_folder>/tasks/*.json` channel (`{type: "deferred_notification", target_person_id, text}`) that `notify_task_commented` already uses. But `direct_message` (`target_chat_jid`) and `parent_notification` (`parent_group_jid`) events have **no person_id** — the engine already resolved the JID — and the tasks-IPC consumer contract only covers person-addressed payloads. tf currently skips them with a logged reason (mirroring your `planNotificationDeliveries` skip-with-reason policy).

**Request (pick one):**
- (a) extend the tasks-IPC consumer to accept `{type: "direct_message", target_chat_jid, text}` and `{type: "parent_notification", parent_group_jid, text}` (host-side it's the same `deliverTextToWhatsAppJid` seam your dispatch handler uses), or
- (b) confirm the engine can emit person-addressed `deferred_notification` instead of jid kinds when the caller is the FastAPI subprocess (it knows via the verbatim/service flag), or
- (c) name another seam.

Until one lands, dashboard-originated reassign DMs and parent rollups remain undelivered (logged, not silent), and the legacy `notify_task_commented` stays alive for comments (retiring it now would lose comment notifications that surface as jid kinds — see the exclusion note in `call_mcp_mutation`).

### R3-REFINED (2026-06-10, after live end-to-end tracing) — the cleaner fix is engine-side, reusing the path you already have

Empirically proven on .61: a dashboard **assigned create** (`POST /tasks` with an assignee) runs your engine, computes the assignee notification, and emits it as a **`direct_message`** (jid resolved). tf-mcontrol's dispatcher then logs `direct_message … skipped on the dashboard path` and writes nothing — so the assignee is NOT notified. This is the common, expected case (create/assign/reassign → notify), and it's the #401 contract that's effectively unfulfilled.

**The architecture finding:** tracing `taskflow-notify.ts`, the real delivery path for FastAPI-originated notifications is the **service outbound bus** (the `--service-outbound-db` your subprocess already writes) drained by the host `taskflow_notify` action → `deliverTextToWhatsAppJid` (resolved-JID → `messaging_groups` → adapter). Two consequences:
1. **tf-mcontrol structurally cannot fulfill #401 cleanly.** It's a Python process; it can't call `deliverTextToWhatsAppJid`, and `taskflow_notify` explicitly **fail-closed-refuses person-addressed targets** (host does no person→JID resolution). The person-addressed tasks-IPC channel I deliver `deferred_notification` through has no host consumer that actually sends — so even that half is likely a no-op at delivery time.
2. **You already have the delivery path.** The engine resolves the JID in-subprocess and, in WhatsApp-agent mode, enqueues to the outbound bus that `taskflow_notify` drains.

**Refined request (supersedes the jid-IPC ask):** on the FastAPI subprocess, instead of no-opping `dispatchNotificationEvents`, **enqueue the resolved-JID notifications to the same service outbound bus** `taskflow_notify` already drains (the `--service-outbound-db` is present; `api_send_chat`'s `enqueueWebChatInbound` already writes to it). That reuses the entire existing delivery path — no new IPC type, no tf-side delivery logic, no person→JID host resolution. The #401 "tf-mcontrol owns delivery" decision was likely made before this trace; tf-mcontrol owning *the trigger* (it drives the mutation) is fine, but *the delivery* belongs where the JID and the adapter already live: your subprocess + `taskflow_notify`.

**If you prefer tf-mcontrol to keep owning delivery:** then tf needs a host primitive it can reach — i.e. accept a `{type:"direct_message", target_chat_jid, text}` IPC that a host poller feeds to `deliverTextToWhatsAppJid`. That's the original R3(a). The outbound-bus approach above is strictly less new surface.

**Note:** full end-to-end (message actually arriving on a phone) can only be confirmed on a WhatsApp-linked env — .61 dev has no WhatsApp delivery wired (OTP/IPC files persist undelivered), so this is verifiable only on prod (.63) post-cutover.

## R4 — a subtask-creation path for the dashboard (unblocks G5)

Verified against your source: NEITHER `api_create_simple_task` nor `api_create_task` accepts a `parent_task_id` — adding a subtask to an EXISTING project is `api_create_task` → `api_admin(reparent_task)` on the agent path, and `api_admin` is (rightly) not allowlisted. The dashboard's "Criar subtarefa" button is withdrawn until a path exists.

**Request (pick one):** (a) accept an optional `parent_task_id` in `api_create_task` (validated: same board, parent is a project — the same checks reparent_task runs), or (b) a narrow dedicated `api_reparent_task` tool (thin delegation to the same engine code, `not_found`/`conflict`/`validation_error` envelope), allowlisted. Preference: (a) — one call, atomic, no orphan window.

## R5 — serialized READ tools, so the dashboard can route reads through the engine (kill read-path drift)

Goal (owner, 2026-06-10): the dashboard's 167 direct-SQL reads replicate the engine's `visibleTaskScope` in Python and can drift. We want taskflow-domain reads to go through the engine instead. A verified 24-endpoint / 56-tool map (workflow `wf_4d0c7190-6f7`) found that **almost nothing is cleanly movable today** — the existing `api_query` read modes return RAW `tasks.*` rows, so FastAPI would have to re-enrich (board_code/timezone/assignee-name) from the DB, re-introducing the very direct reads we're removing. The fix is engine-side: **read tools that return the SAME serialized shape `serialize_task` produces** (i.e. `serializeApiTask` + `board_timezone`), board-scoped + allowlisted, so FastAPI does ZERO enrichment.

Requested new read tools (each board-scoped, FastAPI-allowlisted, returning serialized shapes):
1. **`api_board_tasks`** (the big one) — a full board read returning `serializeApiTask`-shape tasks per column (incl. `board_code`, `board_timezone`, assignee NAME, normalized priority, parsed labels[], `parent_task_title`), honoring `visibleTaskScope` (delegated-in included). Optional `column` arg for the per-column form. Replaces `GET /boards/{id}/tasks` (the core drift source). NOTE: `api_query:board` already has the scope right but returns raw rows + different ordering — extending it (or a new tool) to the serialized shape is the whole ask.
2. **`api_board_detail`** — composite config read: board meta + `board_config` columns/wip + `board_runtime_config` language/timezone/cron + `board_people[]` + `tasks_by_column` counts. Replaces the taskflow half of `GET /boards/{id}` (auth-gate stays FastAPI-side).
3. **`api_list_holidays`** — `[{date,label}]` from `board_holidays` (you have the mutations + internal reads; no read tool/allowlist entry yet).
4. **`api_list_comments`** — task comments from `task_history` where `action='comment'`, serialized to `{id,author,message,created_at}`.
5. **`api_runner_status`** — `standup/digest/review_cron_local` from `board_runtime_config`.

**Explicitly NOT requested (stay FastAPI-owned — different domain):** `/stats`, `/boards` (board-list visibility), `/tasks/overdue`, the cross-board `/tasks/search` branch. These aggregate over the caller's auth-resolved board-set using FastAPI-owned tables (users, orgs, org_members) and do owner-auth the engine doesn't (R2.3). `board_directory` is the only engine board-lister and is rightly ORG_WIDE-denied on the dashboard surface. tf-mcontrol keeps these.

Once R5 lands, tf swaps each read to the new tool (with a service-token parity probe per endpoint) and deletes the corresponding direct SQL. The board-scoped `search` + the archive/stats-engine/meetings reads are already engine-routed (shipped).

**Also for your awareness:** the 06-09 UX audit + goal instruction live at `~/tf-mcontrol/docs/2026-06-09-dashboard-ux-design-audit.md` and `~/tf-mcontrol/docs/plans/2026-06-09-dashboard-goal-instruction.md`. G12 (rich create/update routes incl. the duplicate-confirm flow — **shipped 2026-06-10** on tf's side) and G13-G15 build on your already-shipped §8 batch and need nothing further from you beyond R1-R5.
