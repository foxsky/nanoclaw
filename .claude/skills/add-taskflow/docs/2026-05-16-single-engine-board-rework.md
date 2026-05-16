# Design: true single-engine board-config (UI == WhatsApp)

> **⚠ REVISION REQUIRED — Codex review gpt-5.5/xhigh, 2026-05-16: §2 is
> INVALID; do not implement.** Verified against code:
> - **§2 collapses.** Child-board creation is NOT DB-only: parent is
>   resolved from `session.agent_group_id`/folder, `createGroup`
>   produces the real `childGroupJid` written to `boards.group_jid`, v2
>   agent/messaging-group wiring + destination registration +
>   filesystem/runners/onboarding are all **host-only**
>   (`src/modules/taskflow/provision-child-board.ts:75,269,475,525,553,586`,
>   `provision-shared.ts:422`). A FastAPI-subprocess `engine.provisionChildBoard`
>   cannot reproduce this.
> - **"Phase-1 emits no outbound" is FALSE when auto-provision fires** —
>   the provision tool writes a `kind:"system"` `messages_out` row
>   (`mcp-tools/provision-child-board.ts:41`) → host dispatches invite /
>   confirmation / welcome / onboarding (`provision-child-board.ts:494,654,666,673`).
> - **add-person payload/person-id mismatch unresolved** — FastAPI
>   name/phone/role + phone-digits/uuid id vs engine slug-from-name + a
>   hierarchy-board requirement for `phone`+`group_name`+`group_folder`
>   (`main.py:2780`, `taskflow-engine.ts:8206,8222`).
> - §1 footgun: the engine must **not** trust an `owner_prechecked` flag
>   from MCP args — owner auth stays purely FastAPI-side (BLOCKER B), the
>   engine just doesn't do owner auth for `api_service`.
> - §3 factual fix: active-task `remove_person` returns
>   `success:true` + `tasks_to_reassign` (NOT a failure) —
>   `taskflow-engine.ts:8297`.
> - §4: `board_people.role` is a job/UI role and `role==='Gestor'`
>   grants REST edit/delete privilege — distinct from WhatsApp
>   manager/delegate (`board_admins`); name/scope it accordingly.
> - §7: allowlist must filter the **call path** too (`server.ts:42`
>   resolves `tools/call` from `toolMap`, not the listed set) and must
>   include the 6 production task/note tools FastAPI already calls.
> - Independent shipped bug: the 4 board tools call `normalizeAgentIds`
>   which `board-`-prefixes FastAPI's plain-UUID board ids
>   (`taskflow-api-board.ts:35`, `taskflow-helpers.ts:90`) — must use
>   flat args, trust the URL board_id exactly.
>
> Core finding: the engine's rich board behaviors (hierarchy
> auto-provision, manager auth, outbound) are **host/session-coupled**
> and unreachable from the FastAPI MCP subprocess. "Identical behavior"
> for board-config is not achievable without solving host-dispatch
> (the 0h-v2-class problem this doc tried to scope out). Next step is a
> **scoping decision**, not a §2 patch. See memory
> `project_tfmcontrol_mcp_engine_0f_0h`.

**Status:** §0–§9 + R2.3–R2.6-as-originally-written SUPERSEDED. **Authoritative = Revision 2 + Revision 2.1 (Codex-corrected, implementable).** Implementation = fresh multi-session TDD; next Codex = post-implementation.
of doc): pragmatic subset.** No tool code until Revision 2 is reviewed.
**Date:** 2026-05-16. **Owner:** nanoclaw side (`skill/taskflow-v2`).
**Driver:** user requirement — the MCP server is the single gateway so
tf-mcontrol (UI) drives the *same engine path* the in-container WhatsApp
agent uses; identical behavior **and side effects**.
**Evidence base:** Codex review gpt-5.5/xhigh, 2026-05-16 (file:lines below
are its verified citations).

## 0. Problem statement

The 4 shipped Phase-1 tools (`taskflow-api-board.ts`: `api_update_board`,
`api_add_board_person`, `api_remove_board_person`, `api_update_board_person`,
commits `f5f51f02`/`33aa6db1`/`962c776a`/`6d64728f`) are pure-SQL replicas
of the *current FastAPI* handlers → **UI ≠ WhatsApp**, superseded.

"Single engine for *mutation logic*" is coherent. "Identical *behavior +
side effects*" is **not** free — five structural blockers:

| # | Blocker | Evidence |
|---|---|---|
| B1 | Auth models differ: `api_admin` gates manager status pre-switch; FastAPI uses owner auth; UI boards seed no manager row | `taskflow-engine.ts:8148-8170`, `main.py:1646-1666`, `main.py:2731-2739` |
| B2 | Auto-provision is host/session-bound, not engine-bound; subprocess can't reach it; `call_mcp_mutation` discards side effects | `taskflow-engine.ts:8261-8280`, `provision-child-board.ts`, `main.py:1602-1605,1643` |
| B3 | UI add-person payload can't satisfy hierarchy registration (needs `group_name`/`group_folder`; UI boards have null hierarchy fields) | `taskflow-engine.ts:8206-8218`, `main.py:2731-2739`, `:1699-1703` |
| B4 | delete-person semantics differ (REST 204 hard-delete vs engine block-on-active-tasks/force/reassign/admin-cleanup) | `main.py:2825-2835`, `taskflow-engine.ts:8285-8330` |
| B5 | role-update has NO engine equivalent (`set_wip_limit` is WIP-only; `add_manager`/`add_delegate` touch `board_admins`, not `board_people.role`) | `taskflow-engine.ts:8461-8479,8338-8416` |

Plus shipped defect **D1**: `taskflow-server-entry.ts` registers the full
`api_admin`/`api_hierarchy`/etc. surface to the FastAPI subprocess
(`taskflow-api-mutate.ts:1290-1294`); comment + entry test are wrong.

## 1. Auth-context contract (resolves B1)

Decouple *who is authorized* from *where the check ran*. Core engine
mutation methods take an explicit `auth` param:

```ts
type EngineAuth =
  | { kind: 'taskflow_person'; board_id: string; sender_name: string }
  | { kind: 'api_service';     board_id: string; owner_prechecked: true };
```

- **WhatsApp caller** (`api_admin` dispatcher) passes `taskflow_person`;
  the core runs the **existing manager/role gate** unchanged
  (`taskflow-engine.ts:8148-8170` logic moves *into* the core, not the
  wrapper).
- **FastAPI caller** passes `api_service` with `owner_prechecked: true`.
  This is sound because BLOCKER B already committed FastAPI to run
  `require_board_owner` **before** `call_mcp_mutation`, with a
  per-endpoint negative test asserting non-owner → 403 → MCP never
  invoked. The core **trusts** that precheck for `api_service` and skips
  the manager gate. No manager-row migration for UI owners is required.

Authorization predicate per op: `taskflow_person` → manager/role rule as
today; `api_service` → allow (FastAPI owns the gate, contractually +
test-enforced). This is the single rule both callers share; the *source*
of trust differs by `auth.kind`, the *logic* does not fork.

## 2. Side-effect dispatch reachable from the FastAPI subprocess (B2)

Key scoping insight: **Phase-1 board-config emits no outbound
notifications** (only Phase-3 chat/comment do — that is 0h-v2). The only
Phase-1 side effect is **child-board auto-provisioning** from
`register_person` on a delegating board. So Phase-1 single-engine does
**not** need full 0h-v2; it needs auto-provision to be
subprocess-executable.

Today `register_person` only *returns* `auto_provision_request`
(`taskflow-engine.ts:8261-8280`); the child board is created by the
separate `provision_child_board` tool + a host delivery handler that
resolves the parent from the **caller session/agent folder**
(`src/modules/taskflow/provision-child-board.ts:75-91`) — unreachable
from the FastAPI subprocess, and `call_mcp_mutation` discards it anyway.

**Design:** extract `provision_child_board`'s pure DB writes (boards,
board_config, board_people, board_id_counters, destinations rows) into a
synchronous **`engine.provisionChildBoard(parentBoardId, personId,
fields, auth)`** that takes the parent board id **explicitly** (the api
context has it; no session dependency). The shared
`addBoardPerson` core, when it would emit an `auto_provision_request`,
**calls `engine.provisionChildBoard` inline** within the same
transaction. Both WhatsApp and UI then get the same child board created
synchronously. The host-side delivery handler is retained only for the
WhatsApp *welcome/notification* messaging (Phase-3/0h-v2 outbound), which
Phase-1 does not require.

Open risk to verify at impl: `provision_child_board` may carry
host-only concerns (agent group wiring, destination registration that
needs the host CLI). Split into (a) DB-level board creation → engine,
(b) host wiring/outbound → deferred to 0h-v2. Phase-1 parity = (a).

## 3. delete-person semantics (B4) — decision

Adopt the engine behavior (that is the point of single-engine):
`removeBoardPerson` core blocks when active non-done tasks exist unless
`force`, returns `tasks_to_reassign`, clears `board_admins`
(`taskflow-engine.ts:8285-8330`). The `api_remove_board_person` tool
surfaces this as a structured result:

- no active tasks → success (HTTP 204-equivalent: `data: null`).
- active tasks, no force → `{ success:false, error_code:'conflict',
  data:{ tasks_to_reassign:[...] } }` → FastAPI returns **409** (a
  deliberate, documented behavior change from the old 204).
- `force: true` input → unassign + delete + admin cleanup.

tf-mcontrol coordination: the UI must handle 409 + `tasks_to_reassign`
and may pass `force`. Re-baseline the golden with BOTH an empty-tasks
and an active-tasks fixture (a no-active-task-only golden hides B4).

## 4. role-update (B5) — decision

No WhatsApp equivalent exists (legitimate, like `api_update_board` —
not a divergence to reconcile). Add a **new canonical
`engine.setBoardPersonRole(board_id, person_id, role, auth)`** mutating
`board_people.role` (distinct from `add_manager`/`add_delegate` which
mutate `board_admins`). `api_update_board_person` calls
`engine.updateBoardPersonWip` (extracted from `set_wip_limit`) and/or
`setBoardPersonRole`. WhatsApp has no role op today; that is acceptable —
the engine is still the single place, WhatsApp simply lacks the op (a
future `api_admin set_role` action could reuse the same method).

## 5. Extraction shape (Codex #7)

The `api_admin` dispatcher = one shared transaction + a pre-switch
permission gate + case bodies depending on `this.boardId`,
`requirePerson()` throwing, admin-shaped returns
(`taskflow-engine.ts:8148-8170`; finalizer `taskflow-api-mutate.ts:119-123`).

Pattern: **private cores + thin public methods.**
- `private _addBoardPersonCore(params, auth, tx)` / `_removeBoardPersonCore`
  / `_updateBoardPersonWipCore` / `_setBoardPersonRoleCore` /
  `_updateBoardCore` — pure logic + DB, no auth, caller-owned txn.
- `api_admin` cases call the cores inside the dispatcher's existing txn,
  after its existing gate, returning admin-shaped data (unchanged
  WhatsApp behavior).
- Public `engine.addBoardPerson(params, auth)` etc. — own their txn, run
  the auth predicate (§1), call the core, return the api-shaped result.
- The `api_*` MCP tools call the public methods only.

This keeps auth, transaction ownership, and response shaping explicit
per caller while the *mutation logic* is single-sourced.

## 6. Goldens / test sequencing (Codex #8)

Only `update_board`'s golden is on the real MCP path
(`test_golden_mutations.py:178-190`); add/remove/update-people endpoints
still hit direct-SQL FastAPI. Therefore: **wire the FastAPI endpoints to
`call_mcp_mutation` first**, add behavioral tests (active-task removal,
hierarchy add-person + provision, dup, owner-vs-manager auth, response
shape), **then** re-baseline. Re-baselining before wiring would bless
stale direct-SQL output.

## 7. Entrypoint surface fix (D1)

`taskflow-server-entry.ts` must expose only the FastAPI-needed tools, not
the full admin/hierarchy/undo surface. Mechanism: add a name-allowlist
filter in `startMcpServer()` (or the entry) over `server.ts`'s `allTools`
— do not restructure `taskflow-api-mutate.ts`. Allowlist = the migrated
read tools + the 10 `api_*` mutation tools only. Also: correct the false
"taskflow-only" comment and strengthen `taskflow-server-entry.test.ts` to
assert `api_admin`/`api_hierarchy` are **absent** from `tools/list`.
This is independent of the rework and can land first.

## 8. Sequence

1. D1 entrypoint allowlist + comment/test fix (bounded, independent).
2. Auth-context contract §1 (types + predicate; no behavior change yet).
3. Extract `_…Core` helpers §5; repoint `api_admin` cases at them
   (WhatsApp behavior must stay byte-identical — replay-corpus check).
4. `engine.provisionChildBoard` extraction §2 (DB-only, synchronous).
5. Public engine methods + rework the 4 `api_*` tools to call them;
   rewrite their tests to assert engine-behavior parity.
6. tf-mcontrol: wire the 4 endpoints to `call_mcp_mutation`, add
   behavioral tests, re-baseline goldens, handle 409/`force`/`tasks_to_reassign`.
7. Phase-3 outbound (chat/comment notifications) stays the separate
   0h-v2 problem.

Steps 3 must be regression-guarded by the existing WhatsApp replay
corpus (the in-sync `/tmp/prod-interactions-latest/corpora`) — extraction
must not change WhatsApp output.

## 9. Cross-repo asks (tf-mcontrol)

- Confirm the BLOCKER-B contract (run `require_board_owner` before
  `call_mcp_mutation`, per-endpoint non-owner negative test) — §1 trusts it.
- Accept the delete-person 409/`force` behavior change (§3) + UI handling.
- Re-baseline goldens only after endpoint wiring (§6).

## Open questions for review

- §2: is `provision_child_board` cleanly splittable into DB-only vs
  host-wiring, or does board creation itself need host-side agent-group
  wiring that the subprocess can't do? (Highest-risk unknown.)
- §1: any op where the existing manager gate must ALSO apply to
  `api_service` (i.e., owner-precheck insufficient)? e.g. removing a
  manager/admin person.
- §3: should `force` be a tool input, or should the UI always be
  required to resolve tasks first (never force from UI)?

---

# Revision 2 (2026-05-16) — pragmatic subset (AUTHORITATIVE; supersedes §0–§9)

User scoping decision: single-engine board-config **only for the
non-host-coupled ops**. Host-coupled hierarchy auto-provisioning + UI
outbound are explicitly OUT until host-dispatch (0h-v2-class) lands.
Every Codex gpt-5.5/xhigh correction (2026-05-16) is baked in.

## R2.1 In scope (engine-extractable, no host/session dependency)

| Tool | Engine method | Source |
|---|---|---|
| `api_update_board` | new `engine.updateBoard(boardId, {name?,desc?}, auth)` | no WhatsApp competitor — fresh method, not a divergence |
| `api_add_board_person` | new `engine.addBoardPerson(...)` extracted from `register_person`'s **non-hierarchy** path only | `taskflow-engine.ts:8206-8258` (the pre-auto_provision insert) |
| `api_update_board_person` | `engine.updateBoardPersonWip` (extracted from `set_wip_limit`) + new `engine.setBoardPersonRole` (`board_people.role`) | `:8461-8479`; role has no WhatsApp competitor |
| `api_remove_board_person` | new `engine.removeBoardPerson(...)` extracted from `remove_person` | `:8285-8330` |

## R2.2 Out of scope — explicit, documented behavior gap

**UI add-person on a delegating/hierarchy board does NOT auto-provision
a child board.** `engine.addBoardPerson` with `auth.kind==='api_service'`,
when the board is delegating (`canDelegateDown()` true,
`taskflow-engine.ts:1699-1703`), **rejects** with
`{success:false, error_code:'hierarchy_provision_unsupported',
error:'Add this member via WhatsApp until UI child-board provisioning
lands'}` — explicit, never a silent half-provision. WhatsApp
(`taskflow_person`) keeps full auto-provision unchanged. Revisit when
the host-dispatch problem (≈0h-v2) is solved.

## R2.3 Auth (corrects §1 footgun)

`type EngineAuth = { kind:'taskflow_person'; board_id; sender_name }
| { kind:'api_service'; board_id }`. **No `owner_prechecked` flag — the
engine never trusts auth state from MCP args.** For `api_service` the
engine does **zero** owner/manager auth: owner auth is purely
FastAPI-side (`require_board_owner` before `call_mcp_mutation`, per
BLOCKER B, with the per-endpoint non-owner negative test). For
`taskflow_person` the existing manager/role gate
(`taskflow-engine.ts:8151`) runs inside the core. Logic single-sourced;
auth simply does-not-run for api_service (structurally, not via a
trusted boolean).

## R2.4 remove-person semantics (corrects §3 to engine truth)

Codex: active-task `remove_person` returns **`success:true` +
`tasks_to_reassign`** (NOT a failure) — `taskflow-engine.ts:8297`.
So `api_remove_board_person`:
- no active tasks → delete; `{success:true, data:null}` (HTTP 204-equiv).
- active tasks, no `force` → `{success:true,
  data:{tasks_to_reassign:[...], removed:false}}` — FastAPI returns
  **200 + the list** (NOT 409; engine reports success). UI must handle.
- `force:true` → unassign active tasks + delete `board_admins` + delete
  `board_people` (`:8307-8330`).

## R2.5 role (corrects §4)

`engine.setBoardPersonRole` mutates `board_people.role`. ⚠ This is the
**job/UI role**, and `role==='Gestor'` grants REST task edit/delete
privilege (`taskflow-engine.ts:2492`, `taskflow-api-update.ts:165`) —
it is NOT WhatsApp manager/delegate authority (`board_admins`,
`add_manager`/`add_delegate`). Name + document accordingly; no WhatsApp
competitor (legitimate new method, like `updateBoard`).

## R2.6 Extraction shape + parity guard (Codex #4)

Private `_…Core` (logic+DB, caller-owned txn, no auth) + thin public
methods (own txn + the §R2.3 auth fork). `api_admin` cases repoint at
the cores inside its existing transaction/gate, returning admin-shaped
data. **Byte-oracle unit tests** for the repointed `api_admin`
register_person/remove_person/set_wip_limit cases (semantic replay
alone is insufficient — `taskflow-api-mutate.ts:119` finalizer reshapes;
`requirePerson()` throw→`{success:false}` at `:2760,8139`).

## R2.7 Independent fixes — land FIRST, no design dependency

1. **Shipped bug:** drop `normalizeAgentIds` from all 4 board tools
   (`taskflow-api-board.ts:35`) — it `board-`-prefixes FastAPI's
   plain-UUID board ids (`taskflow-helpers.ts:90`; HANDOFF:85). Use
   flat args, trust the URL `board_id` verbatim.
2. **D1 entrypoint allowlist:** must gate the **call path**
   (`server.ts:42` resolves `tools/call` from `toolMap`, not the listed
   set) AND the list; allowlist = the 6 prod task/note tools FastAPI
   already calls + the board-config api_* tools; assert `api_admin`/
   `api_hierarchy` absent in the entry test (both list and call).
3. Fix the false "taskflow-only" comment in `taskflow-server-entry.ts`.

## R2.8 Sequence

1. R2.7 independent fixes (bounded; ship + commit each, TDD).
2. R2.3 `EngineAuth` type + predicate (no behavior change).
3. Extract `_…Core` helpers; repoint `api_admin` cases; byte-oracle
   tests + WhatsApp replay-corpus regression (must stay identical).
4. Public engine methods + rework the 4 `api_*` tools to call them +
   the R2.2 hierarchy guard; rewrite their tests to engine-behavior parity.
5. tf-mcontrol: wire the 4 endpoints to `call_mcp_mutation`, add
   behavioral tests, re-baseline goldens, handle R2.4 responses.

## R2.9 Open questions for the next Codex review

- R2.1: is `register_person`'s non-hierarchy insert cleanly separable
  from the hierarchy/auto_provision branch, or are they entangled
  pre-`canDelegateDown`?
- R2.4: confirm exact `success:true`+`tasks_to_reassign` shape and the
  `force` field name from `taskflow-engine.ts:8285-8330`.
- R2.2: is `canDelegateDown()` the correct + only predicate for "would
  auto-provision", or are there other trigger paths to guard?

---

# Revision 2.1 (2026-05-16) — Codex gpt-5.5/xhigh corrections (AUTHORITATIVE; supersedes R2.3–R2.6 where they conflict)

Codex review of R2.3–R2.6 found 3 BLOCKERs + 4 IMPORTANT (verdict: not
implementable as-is). All code-verified; corrections below are now the
implementation spec. §R2.9 Q1/Q3 + owner-trust safety were *confirmed*.

## R2.1.a Cores take a RESOLVED person; auth lives in WRAPPERS not cores (fixes BLOCKER 1 + 3)

R2.3 ("manager gate inside the core") and R2.6 ("cores have no auth")
**contradicted** — R2.6 wins. Final contract:
- Private `_…Core(db, boardId, resolvedPersonId, params)` = **DB-only**,
  caller-owned transaction, **ZERO auth**, **no person resolution**,
  never calls `normalizeAgentIds`.
- `api_admin` wrapper: keeps its existing pre-switch manager gate
  (`taskflow-engine.ts:8151`) AND resolves the target via the existing
  fuzzy `requirePerson()`/`resolvePerson()` (`:2755`,`:1624`) so
  WhatsApp byte-output is preserved, then calls the core.
- FastAPI/`api_service` wrapper: **no engine auth** (owner-OR-static-agent
  prechecked FastAPI-side — `main.py:1659`; BLOCKER-B test-enforced) and
  resolves the target by **exact `person_id` or `not_found`** (FastAPI
  routes are exact-id: `main.py:2826`,`2939` — must NOT inherit
  `requirePerson()` fuzzy/name matching), then calls the same core.
⇒ The genuinely shared single-engine cores are **add-person
(non-hierarchy) and remove-person only**. `update_board` (name/desc),
`setBoardPersonRole`, and the FastAPI wip path have **no byte-matching
WhatsApp competitor** → dedicated FastAPI-only engine methods, not
shared cores (parallels the already-accepted `update_board` case).

## R2.4 corrected to engine truth (fixes BLOCKER 2)

`remove_person` actual shapes (`taskflow-engine.ts:8297`,`8300`,`8332`):
- active tasks, no force → `success:true`, **top-level
  `tasks_to_reassign:[…]`**, `data:{message:…}` (NOT
  `data:{tasks_to_reassign,removed:false}` as R2.4 said).
- force / no blocking tasks → `success:true`,
  `data:{ removed:<name>, tasks_unassigned:<n> }` (NOT `data:null`).
- not found → `requirePerson()` throws → `{success:false,error}`.
`api_remove_board_person` maps from THIS truth: no-active → HTTP 204;
active+no-force → 200 + top-level `tasks_to_reassign`; force → 200 with
`{removed,tasks_unassigned}`. Verify the exact `force` field name at
impl from `:8285-8330` (R2.9 Q2).

## R2.5 corrected — role grant + WIP coherence (fixes IMPORTANT 5,6)

- **Gestor is a privilege grant.** REST edit/delete gate on
  `board_people.role==='Gestor'` (`taskflow-api-update.ts:171`,
  `taskflow-engine.ts:2492`). **Decision: ALLOW** a board owner to set
  any `board_people.role` incl. `Gestor` (owner authority over their
  board's roles is the product intent; FastAPI owner-precheck gates it).
  `setBoardPersonRole` must: validate role is a known value, and a test
  must assert the `Gestor`→edit/delete implication is intentional + the
  change is history/audit-logged. Not a silent plain-field write.
- **WIP semantics diverge** — engine `set_wip_limit` rejects `null`,
  accepts `0` (`:8465`); FastAPI rejects `<1`, allows `null`-clear
  (`main.py:2928`). The FastAPI `api_update_board_person` wip path is
  **its own dedicated method** keeping the FastAPI contract
  (null→clear, reject `<1` incl. 0); the WhatsApp `api_admin
  set_wip_limit` keeps its semantics unchanged (byte parity). WIP is
  NOT a shared core.

## R2.6 — mandatory byte-oracle fixtures (fixes IMPORTANT 7)

Semantic replay corpus is candidate/insufficient. Repointed `api_admin`
cases require **raw-MCP-JSON byte-oracle unit tests** (capture
pre-extraction output, assert identical post-extraction) for ALL of:
register success-leaf; register hierarchy success w/
`auto_provision_request`; register hierarchy missing-fields; duplicate
register; remove not-found; remove active-no-force; remove force; remove
no-active; set WIP success; set WIP `0`; set WIP `null`/negative;
non-manager permission denial. The `finalizeMutationResult()` reshape
(`taskflow-api-mutate.ts:119`) and the throw→`{success:false,error}`
catch (`taskflow-engine.ts:8139`) are where parity breaks — fixtures
must cover both success and thrown-error paths.

## R2.9 — answered (Codex-confirmed)

- **Q1 (separability): YES, but the reusable slice is AFTER hierarchy
  validation** — slug → dup-check → phone-normalize → insert
  (`taskflow-engine.ts:8222`,`8243`). `api_service` add-person must
  reject delegating boards (`hierarchy_provision_unsupported`) BEFORE
  that slice, not at the doc's earlier-claimed cut point.
- **Q3 (guard completeness): CONFIRMED.** The only
  `auto_provision_request` construction is gated by
  `params.phone && this.canDelegateDown()` (`taskflow-engine.ts:8262`);
  hierarchy validation forces phone/group fields when
  `canDelegateDown()` is true (`:8206`). `provision_child_board` is a
  separate tool, not a `register_person` path. The R2.2 guard
  (`canDelegateDown()` → reject) is complete.
- Q2: exact `force` field name → verify at impl (`:8285-8330`).

## Net

Design is converged and implementable. Shared cores: add-person
(non-hierarchy) + remove-person, taking a resolved person_id, auth in
wrappers. Dedicated FastAPI methods: update_board, setBoardPersonRole,
wip. Implementation is TDD against the R2.6 byte-oracle fixture list +
the per-tool behavioral tests; the NEXT Codex pass is post-implementation
(no further design round needed). Multi-session — start fresh.
