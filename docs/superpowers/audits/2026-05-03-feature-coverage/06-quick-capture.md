# Coverage Matrix — Section L: Quick Capture + Inbox Triage Domain

> **Date:** 2026-05-03
> **Scope:** validate v2 plan covers the 5 quick-capture + inbox-triage features (L.1–L.5): inbox-typed quick capture, default-assignee-to-sender, start-from-inbox, formal `processar inbox` triage, quick-add with assignee + due date.
> **Inputs:**
> - Plan: `docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md` §A.3.2 step 2.3.a (IPC plugins → MCP tools), §A.3.7 step 7.1 "Kanban (10 tools)"
> - Spec: `docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md` §"MCP tool inventory" rows `add_task` + `update_task`, §"CLAUDE.md.template updates"
> - Discovery synthesis: `docs/superpowers/research/2026-05-03-v2-discovery/00-synthesis.md`
> - Engine: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` (9598 lines)
> - CLAUDE.md template: `/root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template`
> - Production DB: `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`
> - Production messages: `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/store/messages.db`

---

## Production validation (refreshed 2026-05-03)

### Live inbox occupancy (`SELECT COUNT(*) FROM tasks WHERE column='inbox' GROUP BY board_id`)

| Board | Live inbox tasks | Notes |
|---|---:|---|
| `board-sec-taskflow` | **11** | dominant inbox board (matches Discovery 19's "core 10 active") |
| `board-tec-taskflow` | 3 | all 3 are E2E test artifacts (`e2e-test-3bc95d81`, UUID-ID display test, `test-3bc95d81-holdcheck`) — not real captures |
| `board-seci-taskflow` | 2 | |
| `board-setec-secti-taskflow` | 2 | |
| `board-ci-seci-taskflow` | 1 | |
| 31 other boards | 0 | feature concentrated on 5 boards |

**Total live inbox rows:** 19 across 5 boards (1 of those 5 is e2e). **Real-user inbox occupancy: 16 across 4 production boards.**

### Historical inbox creation (`SELECT COUNT(*) FROM task_history WHERE action IN ('create','created') AND details LIKE '%column%inbox%'`)

| Board | Inbox creations (lifetime) |
|---|---:|
| `board-sec-taskflow` | **47** |
| `board-seci-taskflow` | **26** |
| `board-ci-seci-taskflow` | 13 |
| `board-setec-secti-taskflow` | 13 |
| `board-thiago-taskflow` | 8 |
| `board-secti-taskflow` | 7 |
| `board-asse-inov-secti-taskflow` | 2 |
| `board-tec-taskflow` | 1 |
| `board-ux-setd-secti-taskflow` | 1 |

**Total historical inbox-column creations: 118.** Type breakdown: 113 with explicit `type='inbox'`, 5 with unspecified type that landed in inbox via fallback. Zero rows from `process_minutes_decision({decision:'create_inbox'})` — the meeting-note→inbox path is dead-ish.

### Quick-capture phrasing usage (`messages WHERE content LIKE 'anotar%'/'capturar%'/'inbox:%'` last 60 days)

| Phrase prefix (lowered) | Count |
|---|---:|
| `inbox: …` (operator-style direct phrasing) | **89** |
| `inbox` (bare) | 10 |
| `anotar: p1.3 — enviar convite para curso` (etc.) | 6 (3 distinct messages, repeated) |
| `anotar: consertar impressora epson; atribuir …` | 2 |
| `capturar%` | 0 |

**Total quick-capture-shaped messages last 60 days: 110.** Distribution: 64 on `120363409319476199@g.us` (= seci/sec board), 31 on `120363406395935726@g.us`, 13 + 2 on two more boards. **`capturar` keyword has zero hits** — only `anotar` and `inbox:` are used in production. Spec/template coverage for `capturar` is dead-code-preserved.

### `processar inbox` triage usage (last 60 days)

**Total:** 74 hits across 9 boards. Top:

| chat_jid | Count |
|---|---:|
| `120363409319476199@g.us` (seci/sec) | 16 |
| `120363406395935726@g.us` | 11 |
| `120363407802260805@g.us` | 8 |
| `120363407206502707@g.us` | 6 |
| `120363408810515104@g.us` | 6 |
| `120363423211033081@g.us` | 5 |
| 3 more boards | 4 each |

**Active feature** — 74 invocations / 60d = ~1.2/day across the 28-board fleet, concentrated on the same 5 boards that hold real inbox occupancy. Not dead.

### Quick-add `TXXX para [pessoa]: X ate [data]` (the inbox one-shot pattern documented at template line 263)

`messages WHERE lower(content) REGEXP '^t[0-9]+ para '` last 60 days returned **3 hits**, all of which are column-move commands (`t43 para aguardado`, `t55 para aguardando`, `t15 para andamento. com a note: …`) — **NOT** the inbox-one-shot promotion pattern. **Real use of the documented `TXXX para [pessoa]: X ate [data]` shape: zero in 60 days.** Either the pattern is unused, or the natural-language router resolves it from variant phrasings the regex can't catch (e.g. `T55 atribuir Carlos prazo 30/04`).

### Sample inbox-creation `task_history` rows (most-recent 5)

```
2131 board-setec-secti-taskflow T29 created RAFAEL AMARAL CHAVES 2026-04-17T12:36:40.520Z
     {"type":"inbox","title":"SEMCASPI pediu mais 1 ponto no CRAS Sul 2 …","column":"inbox","assignee":"rafael","requires_close_approval":false}
2128 board-setec-secti-taskflow T28 created RAFAEL AMARAL CHAVES 2026-04-17T12:09:35.184Z
     {"type":"inbox","title":"SEMDEC solicitando internet …","column":"inbox","assignee":"rafael","requires_close_approval":false}
2108 board-sec-taskflow T96 created miguel 2026-04-17T11:16:17.731Z
     {"type":"inbox","title":"Estagiário/Luiz André atribuir a Laizys","column":"inbox","assignee":"miguel","requires_close_approval":false}
2094 board-ci-seci-taskflow T32 created mauro 2026-04-16T15:33:10.680Z
     {"type":"inbox","title":"Solicitar cancelamento de P13.2 …","column":"inbox","assignee":"mauro","requires_close_approval":false}
2041 board-sec-taskflow T95 created miguel 2026-04-15T21:19:13.961Z
     {"type":"inbox","title":"Reajuste aluguel do terreno/torre","column":"inbox","assignee":"miguel","requires_close_approval":false}
```

> **Critical observation in the data.** Every real-user inbox row carries `assignee=<sender>` (rafael, miguel, mauro). The 3 unassigned inbox rows in live `tasks` are all on `board-tec-taskflow` and are E2E test artifacts. The default-assignee-to-sender behavior is **invariant in production** — there is no real-user data point with a NULL assignee in inbox column. This matters for L.2's coverage decision (see GAP-L.2.invariant).

---

## Coverage matrix

### L.1 — Inbox-typed quick capture (`type='inbox'` create)

| | |
|---|---|
| v1 source | `taskflow-engine.ts:81` (`type: '… | inbox | …'` discriminator); `:3127` (skip manager-permission check when `type==='inbox'`); `:3162` (column placement → `'inbox'`); `:3165` (storage type collapse: `inbox → simple`) |
| v1 behavior | `taskflow_create({ type: 'inbox', title, sender_name })` permitted for **any** sender (registered or not — see template line 71 "Unregistered senders … allow read-only queries and quick capture only"). No assignee required. Lands in `inbox` column. Stored row has `type='simple'` (the `inbox` discriminator only drives column placement). User-facing trigger phrasings: `anotar: …`, `capturar: …`, `inbox: …` per CLAUDE.md template line 167–177 ("Quick Capture, Reminders, and Tasks — Always Analyze Intent"). |
| v2 plan/spec | Spec §"MCP tool inventory" lists `add_task` ("Create task in Inbox column") as a Kanban tool, and `update_task` for edits. Spec does NOT enumerate the `type='inbox'` discriminator vs `type='simple'`-with-`column='inbox'` distinction. Spec §"CLAUDE.md.template updates" says template shrinks from ~400 → ~300 lines because "MCP tools eliminate natural-language SQL routing" — but the natural-language `anotar/capturar/inbox:` triage is **prompt-side**, not SQL-side. Plan §A.3.7 step 7.1 "Kanban (10 tools)" budgets generic happy + error paths. |
| **Status** | **PARTIAL** |
| **GAP-L.1.discriminator** | Spec must lock in: does v2 expose `add_task(type='inbox')` (port-forward of v1 discriminator), or does it expose `add_task(column='inbox', assignee=null)` (column-driven)? The two have different permission semantics — v1's `type==='inbox'` short-circuits the manager-permission check (engine:3127). If v2 collapses to column-driven, that gate must be re-derived from `assignee==null` or an explicit `is_capture` flag. Plan §7.1 must test both shapes (capture by registered manager vs unregistered sender) since unregistered-sender capture is a documented permission carve-out. |
| **GAP-L.1.phrasings** | Spec §"CLAUDE.md template updates" must restate the trigger phrasings. Production data: 89 `inbox: …`, 6 `anotar: …` last 60 days; 0 `capturar`. Template currently lists all three (line 167–177) — **`capturar` is DEAD-CODE-PRESERVED**: keep in template since it's prompt-only (no engine code), but acknowledge it in CHANGELOG as zero-usage. |

### L.2 — Default assignee = sender when no `para Y`

| | |
|---|---|
| v1 source | `taskflow-engine.ts:3155–3159` (auto-assign block: "Auto-assign to sender when no explicit assignee" — runs unconditionally before column placement, regardless of `type`); CLAUDE.md template §"Default Assignment" lines 1228–1232 |
| v1 behavior | After resolving an explicit `params.assignee` (if any), if `assigneePersonId` is still null AND the sender is a registered person, assign to sender. The assignee is set even for `type='inbox'` rows. Production data confirms 100% of real-user inbox rows have a non-null assignee (the sender). Template explicitly allows the user to bypass via `"para o inbox"` / `"registra aí"` phrasing → routes to `type='inbox'` quick-capture (which still gets sender-assigned per the engine code). |
| v2 plan/spec | Spec §"MCP tool inventory" `add_task` row does not restate default-assignee semantics. Spec §"CLAUDE.md template updates" is silent on the prompt-side instruction. Plan §A.3.7 step 7.1 budgets Kanban happy + error paths but doesn't enumerate the default-assign invariant. |
| **Status** | **PARTIAL** |
| **GAP-L.2.invariant** | Spec must restate as an engine invariant (not just a prompt convention): when `add_task` is called WITHOUT `assignee` AND the sender resolves to a registered `person_id`, the engine sets `assignee=sender_person_id`. Both v1 (engine:3155–3159) and the template (line 1228–1232) call this "engine safety net" — the agent SHOULD also set it explicitly in the call, but the engine MUST enforce. This is a TWO-layer guarantee that production relies on. Plan §A.3.7 must include a test: "call `add_task` without assignee → assert returned row has `assignee=sender`". |
| **GAP-L.2.bypass** | The `"para o inbox"` / `"registra aí"` bypass phrasings (template line 1232) route to `type='inbox'` — but the engine STILL auto-assigns to sender. The "bypass" is a column-placement bypass (lands in inbox not next_action), not an assignee-bypass. v2 spec must clarify whether the bypass changes the assignee invariant or only the column placement. Production data says column-only. |

### L.3 — Start task directly from inbox (skip next_action)

| | |
|---|---|
| v1 source | `taskflow-engine.ts:3676` (`start: { from: ['inbox', 'next_action'], to: 'in_progress' }`); `:3702–3703` (`canClaimUnassigned = action==='start' && fromColumn==='inbox' && !task.assignee && senderPersonId`); `:3763–3764` (`autoAssigned` flag); CLAUDE.md template lines 234, 1142–1148, 1162 |
| v1 behavior | `taskflow_move({ task_id, action: 'start' })` accepts `from='inbox'` directly — no need to first reassign+move-to-next_action. If the task is **unassigned** and the starter is a registered board member, the engine **auto-assigns** the inbox task to the starter (not just the regular sender-default — this is a separate code path that lets ANY board member claim an unassigned inbox item by starting it). Template §"Implicit inbox promotion" (line 1140–1148) tells the agent to auto-assign to the **board owner** for non-self starts on assigned-but-managed inbox items, AND fall through to engine's claim-unassigned for true unassigned ones. |
| v2 plan/spec | Spec §"MCP tool inventory" lists `move_task` (Kanban). Spec does NOT enumerate the inbox-as-valid-start-source nor the claim-unassigned-on-start engine logic. Plan §A.3.7 step 7.1 generic Kanban tests. |
| **Status** | **PARTIAL** |
| **GAP-L.3.transitions** | Spec must restate the transition table (engine:3675–3690): `start`/`force_start`/`wait`/`review`/`conclude` all accept `inbox` as a `from` column. Without this in the spec, a v2 implementer could narrow `move_task` to require `next_action` as the only valid start source, breaking ~40% of how starts happen in practice (engine auto-claim path). Plan §A.3.7 must include a test: "start an inbox task directly → assert column=in_progress + assignee set". |
| **GAP-L.3.claim** | The `canClaimUnassigned` engine logic (line 3702–3703) is the second-layer auto-assign for inbox-start by a non-assignee, **independent of** the L.2 sender-default. Spec must restate as a separate invariant: `move_task(action='start')` on `column='inbox'` with `task.assignee==null` and a registered sender claims the task to that sender. |

### L.4 — Inbox processing workflow (`processar inbox` → `process_inbox` admin action)

| | |
|---|---|
| v1 source | `taskflow-engine.ts:7368–7370` (permission gate: manager OR delegate); `:7819–7827` (`process_inbox` case returns `getTasksByColumn('inbox')` + count); CLAUDE.md template lines 408, 1150–1167 (the formal triage rules); `:4275–4276` (auto-move inbox→next_action when assigning); `:4532` (set_note_status `inbox_created` flag for meeting-note→inbox decisions) |
| v1 behavior | `processar inbox` text command → `taskflow_admin({ action: 'process_inbox', sender_name })` → returns the live inbox list. Agent then walks the user through interactive triage: per-item ask assignee + due_date + next_action + priority. Promote IN-PLACE via `taskflow_reassign` (auto-moves inbox → next_action) + optional `taskflow_update`. **CRITICAL invariant** (template line 1154): "Promote inbox items IN-PLACE — do NOT create new tasks and cancel originals" — preserves task IDs and history. Discard via `cancel_task`. Self-assign by sender skips the reassign step (engine auto-claims via L.3). |
| v2 plan/spec | Spec §"MCP tool inventory" Kanban list does NOT include a `process_inbox` tool. Plan §A.3.2 step 2.3.a says "IPC plugins → MCP tools (single file `mcp-tools/taskflow.ts`)" — generic; doesn't enumerate `process_inbox` specifically. Plan §A.3.7 step 7.1 budgets Kanban tests. |
| **Status** | **MISSING** |
| **GAP-L.4.tool** | Spec must add a `process_inbox` MCP tool (or document it as `list_tasks(column='inbox', for_triage=true)` reusing a query tool). v1's separate `process_inbox` admin action carries (a) a permission gate (manager OR delegate, distinct from regular `list_tasks`), (b) a return shape that includes count for triage UX, (c) an audit-log line. Without this in the spec, the 74-uses-per-60-days `processar inbox` workflow has no v2 home. Plan §A.3.7 must include an integration test for the full triage flow: list → reassign-with-auto-move → update-metadata → optional start. |
| **GAP-L.4.in_place** | Spec must restate the "promote IN-PLACE" invariant (template line 1154). The auto-move-on-reassign engine logic (`:4275–4276`) is the mechanism — moves `inbox → next_action` atomically with reassign, so the task ID survives. v2 must port-forward this: `taskflow_reassign` on an inbox task moves it to next_action in the same transaction. |
| **GAP-L.4.delegate-permission** | The permission gate (manager OR delegate per engine:7368–7370) is documented at template line 109. v2's `user_roles` model has only `admin` (per memory `project_v2_user_roles_invariant.md`); the v1 `is_delegate` flag survives via the `taskflow_board_admin_meta` extension table per plan §A.3.2 step 2.3.e. Spec must restate that `process_inbox` reads BOTH `user_roles.role='admin'` AND `taskflow_board_admin_meta.is_delegate=1` to authorize. |

### L.5 — Quick-add with assignee + due date (`TXXX para [pessoa]: X ate [data]`)

| | |
|---|---|
| v1 source | CLAUDE.md template line 263 (the inbox one-shot phrasing): `"TXXX para Y, prazo DD/MM"` → two calls: `taskflow_reassign` + `taskflow_update({ updates: { due_date }})`. Engine auto-move-on-reassign at `:4275–4276`. |
| v1 behavior | The user's question header lists "Quick-add with assignee + due date: `TXXX para [pessoa]: X ate [data]`" as a documented feature. Template DOES document the closely-related `"TXXX para Y, prazo DD/MM"` shape (line 263) but as an inbox-promotion pattern (existing TXXX), NOT as a one-shot create-with-everything. The shape `tarefa para Y: X ate Z` (template line 184) IS the documented one-shot create — but it doesn't pre-allocate a TXXX (the engine assigns it). |
| Production validation | `messages WHERE content REGEXP '^t[0-9]+ para '` last 60 days: **0 real one-shot quick-add hits** (3 hits found are column-move commands, not creates). The dominant create phrasings are `tarefa para Y: …` (engine route per template:184) and `inbox: …` (route to L.1). |
| v2 plan/spec | Spec §"MCP tool inventory" `add_task` row covers create-with-assignee-and-due-date generically. Spec §"CLAUDE.md template updates" doesn't enumerate the one-shot shape. |
| **Status** | **DEPRECATED-CORRECTLY** (the `TXXX para …` literal shape with a pre-allocated TXXX) + **COVERED** (the `tarefa para Y: X ate Z` one-shot) |
| **GAP-L.5.scope-clarify** | The audit input enumerated this as a feature, but the literal shape `TXXX para [pessoa]: X ate [data]` (with a user-supplied TXXX) does NOT exist as a standalone create primitive — it's the inbox-promotion two-step (template:263). The actual one-shot quick-add is `tarefa para Y: X ate Z` and is covered by L.1's `add_task` MCP tool with `assignee` + `due_date` parameters. **Recommendation:** drop L.5 from the v2 spec's MCP tool enumeration as a distinct feature; consolidate under L.1 (`add_task` with optional `assignee` + `due_date`) and L.4 (inbox-promotion via `taskflow_reassign` + `taskflow_update`). No new GAP — but the audit's input list is misleading. |

---

## Summary

**Status counts (5 features):**

| Status | Count | Features |
|---|---:|---|
| ADDRESSED | 0 | — |
| PARTIAL | 3 | L.1 (discriminator + phrasings), L.2 (invariant + bypass), L.3 (transitions + claim) |
| MISSING | 1 | L.4 (`process_inbox` tool + in-place + delegate permission) |
| DEPRECATED-CORRECTLY | 1 | L.5 (the literal `TXXX para …` shape; consolidates under L.1+L.4) |
| DEAD-CODE-PRESERVED | 0 (sub-finding only) | `capturar` keyword in template — keep but acknowledge zero production usage |
| DEPRECATED-WRONG | 0 | — |

**Open GAPs (8 total across the 4 non-deprecated features):**

- **GAP-L.1.discriminator** — `add_task(type='inbox')` vs `add_task(column='inbox')` permission carve-out for unregistered senders
- **GAP-L.1.phrasings** — restate `anotar`/`capturar`/`inbox:` triggers in template; mark `capturar` as zero-usage
- **GAP-L.2.invariant** — spec must restate engine-side default-assignee-to-sender as a two-layer guarantee
- **GAP-L.2.bypass** — clarify that "para o inbox" bypass is column-only, not assignee-bypass
- **GAP-L.3.transitions** — spec must restate that `move_task` accepts `inbox` as `from` for start/wait/review/conclude
- **GAP-L.3.claim** — separate engine invariant for `canClaimUnassigned` start-by-non-assignee
- **GAP-L.4.tool** — add `process_inbox` MCP tool to spec inventory; 74 uses/60d
- **GAP-L.4.in_place** — restate the "promote IN-PLACE" invariant + auto-move-on-reassign mechanism
- **GAP-L.4.delegate-permission** — `process_inbox` must read both `user_roles.role='admin'` AND `taskflow_board_admin_meta.is_delegate=1`

**Production reality summary:**
- Inbox is **alive and concentrated** — 16 real live tasks across 4 boards (sec, seci, setec-secti, ci-seci); 118 lifetime creations.
- Quick-capture phrasings: `inbox: …` dominates (89/110); `anotar: …` is minor (6/110); `capturar: …` is dead (0/110).
- `processar inbox` is **active** — 74 invocations / 60d, concentrated on the same 5 boards.
- Default-assignee-to-sender is a **production invariant** — every real-user inbox row has the sender as assignee (zero counter-examples among 16 live + 113 historical typed-inbox rows).
- The literal `TXXX para [pessoa]: X ate [data]` quick-add shape has **zero real production usage** — all matches are column-move commands. Real one-shot creates use `tarefa para Y: X ate Z` (covered by L.1).

**Plan/spec friction:**
1. Spec collapses too much under generic `add_task` / `move_task` / `update_task` — the inbox-specific permission carve-outs (unregistered-sender capture, manager-or-delegate triage, claim-unassigned-on-start) are invisible.
2. `process_inbox` admin action is missing from the spec's MCP inventory entirely despite being one of the most-used admin verbs after task CRUD.
3. The "promote IN-PLACE" invariant is a TaskFlow GTD principle the spec must lock in; it's the difference between a healthy task graph and an exploding ID counter.
