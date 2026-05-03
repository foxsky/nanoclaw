# 15 — End-to-End Inbound Lifecycle (v2)

**Question:** From "WhatsApp message arrives" to "agent reply lands on user's
screen", what exactly happens? Where does each row land, where does TaskFlow
fit, what's serialized vs. parallel, and does the original platform message ID
propagate far enough to use as audit-key?

All paths cite `git show remotes/upstream/v2:<path>:Lnnn` unless otherwise
noted. The WhatsApp adapter lives on `remotes/upstream/channels` (it ships as a
skill, not on v2 trunk).

---

## 1. Sequence diagram (text)

```
USER ──text──▶ WhatsApp servers ──Baileys websocket──▶ HOST PROCESS

[A] BAILEYS messages.upsert
    upstream/channels:src/channels/whatsapp.ts:498
    └─ translateJid (LID → phone)            ch:530
    └─ setupConfig.onMetadata(...)           ch:522
    └─ filter fromMe / empty                 ch:548-562
    └─ slash-command match → setupConfig.onAction(...)
                                             ch:571-580   (no MCP/router path)
    └─ build InboundMessage{ id, kind:'chat', content:JSON, ... }
                                             ch:571
    └─ setupConfig.onInbound(chatJid, null, inbound)
                                             ch:588

[B] CHANNEL-REGISTRY → router
    src/index.ts:75   (initChannelAdapters wires onInbound)
    src/index.ts:78-91 → routeInbound({ channelType, platformId, threadId, message })

[C] ROUTER (router.ts:routeInbound)
    src/router.ts:144
    1. thread-policy collapse (whatsapp not threaded → threadId=null)   :147
    2. lookup messaging_groups by (channel_type, platform_id)            :158
    3. if !found && !isMention → silent return                           :163
    4. if !found && isMention → createMessagingGroup row                 :169-180
    5. if agentCount === 0 →
         - denied_at set → silent drop                                   :194-200
         - record dropped_messages (reason='no_agent_wired')             :202
         - channelRequestGate (permissions module) sends "register
           channel?" approval to owner                                   :213-221
         - return (the user's message stays dropped)
    6. senderResolver = permissions/index.ts:extractAndUpsertUser        :231
       └─ parses content JSON, derives "channel:handle", upserts users
          row.    src/modules/permissions/index.ts:39-74
    7. getMessagingGroupAgents(mg.id) → list of MessagingGroupAgent      :235
    8. fan-out loop, evaluate each wiring:                               :248-302
         - evaluateEngage(...)            :320-374
              pattern  → regex test (default '.' = always)
              mention  → event.message.isMention
              mention-sticky → mention OR session-already-exists
         - accessGate(event, userId, mg, agent_group_id)
              permissions/index.ts:140 → handleUnknownSender if denied
                  policy=strict   → drop + dropped_messages row
                  policy=request_approval → drop + sender-approval card
                  policy=public   → allow
         - senderScopeGate(...)            :167-180
              wiring's sender_scope='known' overrides public
                                                                          :251
       → if all three (engages, accessOk, scopeOk) → deliverToAgent(wake=true)
       → else if ignored_message_policy='accumulate' → deliverToAgent(wake=false)
                                                  (trigger=0, no wake)
       → else                              → drop (logged, no row)
    9. if engagedCount + accumulatedCount === 0 → dropped_messages
                                              reason='no_agent_engaged'   :306

[D] DELIVER-TO-AGENT (router.ts:376)
    1. effectiveSessionMode = (threaded adapter & is_group ≠ 0)
                              ? 'per-thread' : agent.session_mode
                                                                          :385
    2. resolveSession(agent_group_id, mg.id, threadId, effectiveSessionMode)
                                                                          :391
       └─ session-manager.ts:81  → existing or createSession(...)
                                  → initSessionFolder(...) creates two
                                    SQLite files + outbox dir
    3. command-gate: gateCommand(content, userId, agent_group_id)         :404
         /help, /login, /logout, /doctor, /config, /remote-control → filter
         /clear, /compact, /context, /cost, /files →
              isAdmin(userId, agent_group_id)? pass : writeOutboundDirect
              ("Permission denied: …")  → delivery loop sees it like a
              real reply
                                          src/command-gate.ts:23-43
    4. writeSessionMessage(agent_group_id, session.id, {                  :424
         id: messageIdForAgent(event.message.id, agent_group_id), // suffix :agent_group_id
         kind: event.message.kind, // 'chat'
         timestamp, content (raw JSON), trigger: 1
         platformId/channelType/threadId from deliveryAddr
       })
       └─ session-manager.ts:178 → opens inbound.db (DELETE journal),
          extracts attachments to inbox/<msgid>/, INSERT INTO messages_in,
          closes db
    5. startTypingRefresh(...)            modules/typing/index.ts          :443
    6. await wakeContainer(freshSession)
       └─ container-runner.ts:62
            - dedup via wakePromises map (same session → one in-flight wake)
            - spawnContainer(session)            :79
                writeSessionRouting(...) writes default reply addr into
                inbound.db.session_routing       session-manager.ts:140
                buildMounts + spawn 'docker'/'container' with /workspace mounts
                activeContainers.set(...) + markContainerRunning(...)

[E] CONTAINER (cold start or warm continuation)
    container/agent-runner/src/index.ts → loadConfig → createProvider →
        runPollLoop({ provider, cwd:/workspace/agent, systemContext })
                                              container/.../index.ts:91-103

[F] POLL LOOP (container side, session-DB-only IO)
    container/agent-runner/src/poll-loop.ts:54
    Loop @ 1 Hz idle, 0.5 Hz active:
    1. getStoredSessionId() → continuation = prev SDK session-id (resume)  :44
    2. clearStaleProcessingAcks() — wipe leftover 'processing' from a
       crashed prior run                                                   :52
    3. getPendingMessages() — read messages_in WHERE status='pending'
       AND not in processing_ack, ORDER BY seq DESC LIMIT 10
                                              container/.../db/messages-in.ts:52
       (note: trigger=0 rows ride along as context; gating is decided here)
    4. accumulate-only batch (no trigger=1) → sleep, do not call provider  :77
    5. markProcessing(ids) — INSERT INTO outbound.db.processing_ack         :85
    6. extractRouting(messages) — RoutingContext from FIRST msg's
       (channel_type, platform_id, thread_id, id)        formatter.ts:95
       └─ inReplyTo := first.id (the inbound platform message ID)
    7. /clear handling → clear continuation, write "Session cleared." to
       messages_out, mark completed; skip provider call                    :96-115
    8. applyPreTaskScripts(normalMessages) — scheduling module's pre-task
       hook (kind='task' rows with a `script`)                              :126-138
    9. formatMessagesWithCommands(keep, supportsNativeSlashCommands)
       → wraps chat as <message id="..." from="..." sender="..." time="...">
         and prepends <context timezone="..."/>     formatter.ts:117
       Stripped fields: platform_id, channel_type, thread_id NEVER reach
       the agent. Agent sees `from="<destinationName>"`, not the routing
       primitives.
   10. provider.query({prompt, continuation, cwd, systemContext})
                                              poll-loop.ts:153
       Concurrent: setInterval polls every 500 ms for new messages → if
       found, markProcessing + query.push(prompt)                          :245-267

[G] AGENT SDK + MCP TOOLS (in-container)
    The Claude Code SDK runs the prompt with mcpServers={ nanoclaw: ..., ...skill-added }.
    Built-in nanoclaw MCP tools (always-on):
      send_message     → core.ts:97   writeMessageOut → messages_out
      send_file        → core.ts:135  writeMessageOut + outbox/<id>/<file>
      edit_message     → core.ts:...
      add_reaction     → core.ts:...
      ask_user_question (interactive module — skill)
      schedule_task / cancel_task / pause_task / resume_task / update_task
                       (scheduling module — host applies via system action)
    All MCP writes route through container/.../db/messages-out.ts:42:
       writeMessageOut: SELECT MAX(seq) from BOTH messages_out and
                        messages_in, pick next ODD (host uses even),
                        INSERT INTO outbound.db.messages_out

[H] PROVIDER STREAM EVENTS (poll-loop.ts:processQuery)
    poll-loop.ts:184-262
    On 'init'  → setStoredSessionId(continuation) (save SDK session-id)    :209
    On 'result':
       - markCompleted(initialBatchIds) so host-sweep doesn't see stale
         'processing'                                                      :220
       - dispatchResultText(text, routing) — parse <message to="..."> blocks
       - if 0 blocks AND scratchpad text AND routing.channelType set →
         writeMessageOut to the origin channel/thread with inReplyTo=
         routing.inReplyTo (the original inbound msg id)                   :367-380
       - touchHeartbeat() each event → host-sweep liveness signal          :208

[I] DELIVERY (host)
    src/delivery.ts:115 (active poll, every 1 s, getRunningSessions())
    src/delivery.ts:130 (sweep poll, every 60 s, getActiveSessions())
    Per session:
      drainSession(session)                src/delivery.ts:163
      1. open outbound.db (RO) + inbound.db (host owns)
      2. getDueOutboundMessages(outDb): messages_out WHERE deliver_after IS NULL
         OR <= now()
      3. filter against inbound.db.delivered table (already-delivered set)
      4. for each undelivered msg:
         - kind='system' → handleSystemAction → dispatch to module
           (scheduling.actions.ts handleScheduleTask, etc.)                :252
         - channel_type='agent' → routeAgentMessage (a2a module)            :260
              writeSessionMessage on TARGET inbound.db + wakeContainer
         - permission check: source agent must own this destination OR
           target is the session's origin chat                             :270-302
         - ask_question content → createPendingQuestion in central db      :316
         - readOutboxFiles for declared `files`                            :345
         - deliveryAdapter.deliver(channelType, platformId, threadId,
           kind, content, files)
              → adapter resolved by getChannelAdapter(channelType)
              → src/index.ts:130 dispatches to whatsapp adapter
                (channels:src/channels/whatsapp.ts:619 deliver())
                  - ask_question kind → text + slash-command options +
                    pendingQuestions cache
                  - reaction kind     → sock.sendMessage({react:...})
                  - normal text/files → markdown-to-WhatsApp transform
                    + sock.sendMessage(...)
         - markDelivered(inDb, msg.id, platformMsgId)
         - clearOutbox(...)
         - pauseTypingRefreshAfterDelivery(session.id)                     :184

USER receives the reply.
```

## 2. Where each `kind` row appears

| `kind`     | Lives in `messages_in`?  | Lives in `messages_out`? | Notes |
|------------|--------------------------|--------------------------|-------|
| `chat`     | yes — every inbound chat | yes — every outbound chat | The default flow. Both directions stored on disjoint seq parities (host: even, container: odd, see messages-out.ts:48-58). |
| `chat-sdk` | yes — Chat SDK bridge inbound | rare | Same as `chat` but content uses the SDK author shape (`{author:{userId,fullName}}`). permissions/index.ts:53 special-cases author parsing. |
| `task`     | yes — scheduled fires (kind='task' is core schema; scheduling module piggybacks, no migration; see modules/scheduling/index.ts:17) | n/a — tasks land via system actions on `messages_out` and the action handler INSERTs into target session's inbound.db | Container's poll-loop runs `applyPreTaskScripts` on these (poll-loop.ts:126-138). |
| `webhook`  | yes — webhook ingest    | n/a — agent only reads | formatter.ts renders `[WEBHOOK: source/event]\n\n<json>`. |
| `system`   | yes — MCP responses to ask_user_question, system follow-ups (writeSystemResponse session-manager.ts:316) | yes — agent's outbound system actions (schedule_task, edit_destinations, etc.) | Container's poll-loop FILTERS kind='system' from getPendingMessages (poll-loop.ts:55) — system messages are read directly by MCP tool handlers (findQuestionResponse). On the outbound side, kind='system' triggers handleSystemAction (delivery.ts:252) instead of the channel adapter. |

## 3. Failure modes by stage

| Stage | Failure | Result |
|-------|---------|--------|
| WhatsApp websocket disconnect | Baileys reconnect with 5s delay (whatsapp.ts:RECONNECT_DELAY_MS); inbound queue stalls until socket reopens. |
| Unknown messaging group | `routeInbound` short-circuits if the message isn't a mention/DM (router.ts:163 — silent). Mentions auto-create a row with `unknown_sender_policy='request_approval'`. |
| No agent wired           | `dropped_messages` row + `channelRequestGate` fires owner-approval card (router.ts:202-220). User's message stays dropped. |
| Unknown sender (strict)  | `dropped_messages` + silent (permissions/index.ts:107). |
| Unknown sender (request_approval) | `dropped_messages` + sender-approval card to admin (sender-approval.ts:48). On approve: `addMember` then `routeInbound(originalEvent)` replays. |
| Unknown sender (public)  | gate returns `{allowed:true}` (permissions/index.ts:142). |
| `sender_scope='known'` denial on a public mg | per-wiring drop, even though access gate passed. |
| Engage doesn't match     | accumulate policy → row stored with trigger=0 (no wake); else silent. |
| Filtered slash command   | `gateCommand` returns 'filter' (router.ts:407) — never reaches messages_in or container. |
| Denied admin slash command | `writeOutboundDirect` writes "Permission denied" to messages_out; delivery loop ships it. Container never wakes. |
| Container spawn fails    | `container.on('error')` → markContainerStopped (container-runner.ts:154); next host-sweep tick re-tries via `wakeContainer` if `countDueMessages > 0` (host-sweep.ts:177). |
| Container crashes mid-turn | `clearStaleProcessingAcks` wipes 'processing' on next start (poll-loop.ts:52); `host-sweep.resetStuckProcessingRows` retries with backoff up to MAX_TRIES=5, then `markMessageFailed` (host-sweep.ts:240). |
| Container hangs (heartbeat stale) | absolute ceiling 30 min OR per-claim stuck (>60s + heartbeat older than claim) → `killContainer` + reset (host-sweep.ts:87). |
| Provider session invalid | `provider.isSessionInvalid(err)` → clear continuation, retry (poll-loop.ts:172-175). User gets `"Error: ..."` reply (poll-loop.ts:181). |
| MCP tool throws          | Tool's handler catches and returns `{isError:true}`; the SDK puts that into the LLM's tool_result, agent decides what to do. No host-side row appears. |
| Delivery throws          | retry up to MAX_DELIVERY_ATTEMPTS=3; then `markDeliveryFailed` (delivery.ts:208-219). User sees no reply for that one. |
| Adapter has no `deliver` for content type | adapter returns `undefined`; markDelivered with platformMsgId=null. The outbound row counts as delivered for retry purposes but no platform_message_id is recorded (subsequent edits/reactions can't find it). |

## 4. State persisted at each stage

| After step | Tables/files written |
|------------|--------------------|
| Inbound arrives | (nothing yet) |
| messaging_group lookup miss + isMention | central `messaging_groups` (auto-created) |
| sender resolved (permissions) | central `users` (upsert) |
| no-agent-wired drop | central `dropped_messages` + (optionally) `pending_channel_approvals` |
| unknown sender (request_approval) | central `dropped_messages` + `pending_sender_approvals` |
| accessOk + scopeOk | central `sessions` (find or create) |
| writeSessionMessage | per-session `inbound.db.messages_in`, attachments under `data/v2-sessions/<agent>/<session>/inbox/<msgid>/`. central `sessions.last_active` updated. |
| writeSessionRouting (on wake) | per-session `inbound.db.session_routing` |
| wakeContainer | `sessions.container_status='running'` (markContainerRunning); typing module starts presence refresh |
| container poll markProcessing | per-session `outbound.db.processing_ack` |
| MCP `send_message` | per-session `outbound.db.messages_out` (odd seq) |
| MCP `send_file` | + `data/v2-sessions/<agent>/<session>/outbox/<msgid>/<filename>` |
| MCP `schedule_task` (system action through messages_out) | (delivery handler) per-session `inbound.db.messages_in` (kind='task', process_after=ts) |
| poll-loop 'init' event | per-session `outbound.db.session_state` (continuation = SDK session id) |
| poll-loop 'result' | per-session `outbound.db.processing_ack` (status=completed) |
| Heartbeat | per-session `data/v2-sessions/<agent>/<session>/.heartbeat` mtime |
| Delivery success | per-session `inbound.db.delivered` (id, platform_message_id, ts), outbox dir cleared |
| ask_question delivery | central `pending_questions` |
| Container exits | `sessions.container_status='stopped'` |

## 5. TaskFlow integration points (post-skill, per project_v2_migration_assessment)

TaskFlow on v2 ships as a skill: it adds an MCP server to a single agent
group's `container.json` plus per-board CLAUDE.md. Once the skill is applied,
TaskFlow's MCP tools fire **inside step [G]** — the same place
`send_message` and `schedule_task` execute. They reach the central host **only**
through `messages_out` system actions; everything else (mutations, audit) is
local SQLite in the agent group's mounted folder.

Specifically:

- **TaskFlow MCP tool invocation:** the SDK calls into the MCP server registered
  via `mcpServers` in container.json (agent-runner index.ts:73-86). The tools
  read/write a per-board SQLite at `/workspace/agent/taskflow.db` (mounted RW
  via `agent_groups.folder`).
- **`send_message_log`** is a TaskFlow-internal table; it's written by the tools
  inside the MCP handler — not on the host. It's local to the agent's
  workspace, not central. (Consequence: no v2 host code needs to know about
  it; the central DB never sees it.)
- **Cross-board sends (asse-seci-taskflow → seci-main):** the TaskFlow tool
  writes to `messages_out` with `channel_type='agent'` and
  `platform_id=<target agent group id>`. Delivery loop (delivery.ts:260) sees
  `channel_type='agent'`, dispatches via `routeAgentMessage` (modules/
  agent-to-agent/agent-route.ts:32):
    - permission check: `agent_destinations` row required, OR target equals
      self
    - `resolveSession(targetAgentGroupId, null, null, 'agent-shared')`
    - `writeSessionMessage` on the target's inbound.db (`channel_type='agent'`,
      `platform_id=<source agent group id>` — flipped so the target sees
      "from-source")
    - `wakeContainer(targetSession)` — target container starts polling.
- **Scheduled standup / digest:** TaskFlow's MCP `schedule_task` writes a system
  message to `messages_out`; the host's `handleScheduleTask` (modules/
  scheduling/actions.ts) translates to a kind='task' row in **the same
  agent's** inbound.db with `process_after=<schedule>`. When time hits,
  `countDueMessages > 0` → host-sweep wakes the container → poll-loop reads
  the kind='task' row → formatter.ts:185 renders it as `[SCHEDULED TASK]\n\n
  Instructions: <prompt>` — the agent decides what to do.

## 6. Concurrency

| Serialized | Parallel |
|-----------|----------|
| One `inflightDeliveries` per session — the active 1s poll and the 60s sweep can't double-deliver the same row (delivery.ts:50). | Multiple sessions deliver in parallel (`for (const session of sessions)` is a sequential `await` inside one tick, but both tick chains run regardless). |
| One container per session — `wakePromises` dedup ensures concurrent `wakeContainer` calls join the same promise (container-runner.ts:62-78). | Multiple agent groups → multiple containers, fully independent. |
| One writer per inbound.db (host); one writer per outbound.db (container). DELETE journal mode + close-after-write enforces this — see session-manager.ts header comment. | Reads from either DB are fine from the other side (container reads inbound, host reads outbound). |
| One MCP tool call at a time per provider stream (the SDK serializes). | Container poll-loop's setInterval pushes new prompts WHILE the LLM is generating — `query.push(prompt)` (poll-loop.ts:266). The provider streams events (`init`, `result`) while the host concurrently writes new `messages_in` rows. |
| `runMigrations` on host startup. | Channel adapters initialize concurrently? No — `initChannelAdapters` is a serial `for (const [name, registration] of registry)` with `await` (channel-registry.ts:54). |

## 7. Trigger context flow — does the inbound message ID propagate?

Tracing a single inbound platform message ID `wa-12345` through the layers:

1. **Adapter:** `msg.key.id` → `inbound.id` (whatsapp.ts:572). Falls back to
   `wa-${Date.now()}` if Baileys didn't supply one.
2. **Router:** `messageIdForAgent(event.message.id, agent_group_id)` →
   `wa-12345:<agent_group_id>` (router.ts:455-465). The agent_group_id suffix
   prevents collisions across fan-out targets.
3. **inbound.db.messages_in.id:** stored as `wa-12345:<agent_group_id>`.
   Available to the agent via the `<message id="<seq>" ...>` in the formatted
   prompt — though `seq` is the seq column, not the platform id.
4. **Container `extractRouting`:** `routing.inReplyTo := first.id` (formatter.ts
   :101). This is the **per-session** id (with the agent_group_id suffix).
5. **Outbound write:** if the agent doesn't write `<message to="...">` blocks,
   `dispatchResultText` includes `in_reply_to: routing.inReplyTo` in
   `writeMessageOut` (poll-loop.ts:380). MCP tool `send_message` does NOT
   include `in_reply_to` automatically (core.ts:120 doesn't read it).
6. **MCP tools' visibility of trigger context:** TaskFlow MCP can read
   `getSessionRouting()` (core.ts:60) but that only exposes the default reply
   address — `channel_type, platform_id, thread_id`. The original inbound
   `messages_in.id` / `seq` is **not** available to MCP tools through any
   exported helper. To audit per-trigger, TaskFlow would have to:
     - read its own session's inbound.db directly (SQLite path is at a known
       mount point relative to /workspace), filter `messages_in` by
       `status='processing' AND seq = MAX(seq WHERE kind='chat')`, OR
     - have the formatter pass the trigger ID through the system prompt.
7. **Delivery → adapter:** `messages_out` carries no `in_reply_to` (the
   delivery layer drops it; adapters never see it). The platform reply ID
   the adapter returns lands in `inbound.db.delivered.platform_message_id` —
   so an MCP tool can resolve `seq → platform_message_id` via
   `getMessageIdBySeq(seq)` (messages-out.ts:79-104) ONLY for messages
   already delivered.

**Summary:** the platform inbound id reaches the agent's prompt as the seq
attribute and reaches the outbound row as `in_reply_to` (only via the
single-destination shortcut). MCP tools have no first-class accessor; if
TaskFlow needs the trigger context for audit, it must read its own
inbound.db.

## 8. Production validation — asse-seci-taskflow → seci-main (98 sends)

This walkthrough is reconstructed from the v1+skill production data
(MEMORY.md "Cross-board subtask feature SHIPPED Phase 1 + 2", 2026-04-12).
The same architectural shape will hold under v2 once the skill is ported:

```
[user @asse-seci-taskflow] "/escalar para SECI: bloqueio em VPN"
   ↓ Baileys messages.upsert
[Adapter] InboundMessage{ id:'wa-3FAB...:ABCDEF', kind:'chat',
                          content:{ text, sender, senderName, isGroup:true,
                                    chatJid:'1203...@g.us' }}
   ↓ onInbound('1203...@g.us', null, ...)
[Router] mg = messaging_groups WHERE platform_id='1203...'
         agentCount = 1, agent_group = asse-seci-taskflow
         senderResolver: users row 'whatsapp:5585...' upserted
         evaluateEngage: pattern='@Case' matches → engages=true
         deliverToAgent → resolveSession (per-thread doesn't apply: WA
                          doesn't support threads, so 'shared')
                       → existing session "sess-asse-seci-..."
[Session DB writes]
   inbound.db.messages_in row id='wa-3FAB...:ABCDEF:asse-seci-taskflow'
   trigger=1, kind='chat'
[Container wake]
   asse-seci container already running (active board) → no spawn
[Container poll-loop]
   getPendingMessages → 1 row, prompt = formatter(<message ...>)
   provider.query(...) — agent invokes TaskFlow MCP:
       taskflow.create_task(...)  — writes to local taskflow.db
       send_message(to='SECI Main', text='Subtarefa SECI-... criada...')
                                  — writes messages_out, channel_type='agent',
                                    platform_id='<seci-main agent_group_id>'
       send_message(to='current conversation', text='Escalado para SECI')
                                  — writes messages_out, channel_type='whatsapp',
                                    platform_id='1203...@g.us'
[Delivery] (1s poll picks up the two messages_out rows)
   row 1 (channel_type='agent'):
       delivery.ts:260 → routeAgentMessage
       agent_destinations(asse-seci-taskflow → agent: seci-main) check OK
       resolveSession(seci-main, null, null, 'agent-shared') → existing
       writeSessionMessage on seci-main inbound.db, channel_type='agent',
            platform_id='asse-seci-taskflow' (flipped)
       wakeContainer(seci-main)
       seci-main container's poll-loop reads it:
            formatter.ts:148-156: from="asse-seci-taskflow" (resolved via
            findByRouting in the destinations table)
            agent decides what to do (e.g. add to its inbox column)
   row 2 (channel_type='whatsapp'):
       permission check: mg.id matches session's origin → allowed
       deliveryAdapter.deliver('whatsapp', '1203...@g.us', null, 'chat', ...)
       → whatsapp adapter sendRawMessage → user sees "Escalado para SECI"
   markDelivered + clearOutbox.
```

For the 98 forwarded sends, each one creates one `messages_out` row in
asse-seci's outbound.db and one `messages_in` row in seci-main's inbound.db.
Audit visibility:

- `messages_out` records the source agent (the source session's
  agent_group_id is implicit from the file path, not in the row).
- The target's `messages_in` row keeps `platform_id='asse-seci-taskflow'`
  — this IS the trigger-source for the target.
- The original WhatsApp inbound id (`wa-3FAB...:asse-seci-taskflow`) is NOT
  carried across into seci-main's row — the a2a write generates a fresh id
  `a2a-<ts>-<rand>` (agent-route.ts:48). To trace "this seci-main
  message was originally caused by WA inbound `wa-3FAB...`", TaskFlow would
  need to embed the trigger id in the agent-to-agent payload itself
  (e.g. inside content JSON), since the routing layer doesn't propagate it.

This is the v2 boundary that the cross-board mutation forwarding plan
(2026-04-27 phase 1a, on `feat/v2-migration`) is grappling with: the
trigger-source attribution requires either a TaskFlow-side audit log entry on
both ends, or a content-embedded trigger id, because the central DB is
deliberately uninvolved in cross-board content.

---

## File pointers (absolute upstream paths)

- `remotes/upstream/v2:src/index.ts:75-128` — `routeInbound` wiring
- `remotes/upstream/channels:src/channels/whatsapp.ts:498-602` — Baileys → InboundMessage
- `remotes/upstream/v2:src/channels/channel-registry.ts` — adapter dispatch
- `remotes/upstream/v2:src/router.ts:144-317` — engage logic + fan-out
- `remotes/upstream/v2:src/router.ts:376-448` — `deliverToAgent` (sessions, command-gate, writeSessionMessage, wakeContainer)
- `remotes/upstream/v2:src/command-gate.ts:23-43` — admin/filter classifier
- `remotes/upstream/v2:src/modules/permissions/index.ts:39-180` — sender resolver, access gate, scope gate
- `remotes/upstream/v2:src/modules/permissions/sender-approval.ts:48-150` — unknown-sender card
- `remotes/upstream/v2:src/session-manager.ts:81-148` — resolveSession + initSessionFolder + writeSessionRouting
- `remotes/upstream/v2:src/session-manager.ts:178-225` — writeSessionMessage (host writes inbound.db)
- `remotes/upstream/v2:src/container-runner.ts:62-156` — wakeContainer + spawnContainer
- `remotes/upstream/v2:src/db/session-db.ts:71-128` — messages_in writer + countDueMessages (trigger gate)
- `remotes/upstream/v2:container/agent-runner/src/poll-loop.ts:38-310` — container poll loop + processQuery + dispatchResultText
- `remotes/upstream/v2:container/agent-runner/src/db/messages-in.ts:48-77` — getPendingMessages (DESC LIMIT 10, processing_ack filter)
- `remotes/upstream/v2:container/agent-runner/src/db/messages-out.ts:42-72` — writeMessageOut (odd seq picker)
- `remotes/upstream/v2:container/agent-runner/src/formatter.ts:84-260` — extractRouting + formatMessages (XML render, kind dispatch)
- `remotes/upstream/v2:container/agent-runner/src/mcp-tools/core.ts:97-130` — send_message MCP tool
- `remotes/upstream/v2:src/delivery.ts:115-220` — drainSession + deliverMessage
- `remotes/upstream/v2:src/delivery.ts:252-298` — handleSystemAction + agent-to-agent routing
- `remotes/upstream/v2:src/modules/agent-to-agent/agent-route.ts:32-65` — routeAgentMessage
- `remotes/upstream/v2:src/host-sweep.ts:60-220` — heartbeat-based stuck detection + retry-with-backoff
- `remotes/upstream/channels:src/channels/whatsapp.ts:619-700` — adapter.deliver (text + ask_question + reaction + files)
