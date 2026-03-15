# TaskFlow Template-to-Engine Boundary Migration

Date: 2026-03-11
Status: Proposed

## Problem

The TaskFlow skill template currently carries a mix of:

- workflow guidance that belongs in prompt space
- deterministic behavior that should be enforced by runtime or engine code

This creates three recurring problems:

1. The agent can pick an invalid or suboptimal path even when the behavior is mechanically decidable.
2. Runtime invariants are duplicated in prompt text and drift over time.
3. Live behavior depends too much on prompt compliance for identity, confirmation, query routing, and notification safety.

Recent examples:

- child-board sessions trying `mcp__sqlite__read_query` before `taskflow_query`
- stale or inconsistent guidance around `devolver`, parent unblockers, and upward reassignment
- duplicate-notification risks when the prompt knows too much about dispatch mechanics

## Goal

Reduce TaskFlow prompt responsibility to:

- command interpretation
- user-facing explanations
- formatting and workflow preference

Move deterministic policy into code when it affects:

- identity resolution
- permissions
- data mutation safety
- routing and query scope
- notifications
- irreversible actions

## Decision Rule

Use this rule for each instruction currently in the template:

- Keep it in the template if it is primarily about wording, guidance, examples, or user interaction style.
- Move it to runtime/engine if it can be decided from current state without model judgment and incorrect handling can corrupt data, permissions, or side effects.

## Classification

### Must Move to Runtime / Engine

1. Sender resolution chain
- Current template defines exact-name, `person_id`, phone, first-name, and single-person fallback matching.
- This is deterministic identity logic and should be implemented in a shared resolver.
- The runtime should provide the resolved actor identity to TaskFlow tools instead of forcing the model to derive it.

2. Display-name auto-sync
- The template still instructs the agent to update `board_people.name` after fallback matching.
- That is deterministic state mutation and belongs in runtime identity reconciliation, not prompt SQL.

3. Welcome-once behavior
- The template tells the model to query and update `board_runtime_config.welcome_sent`.
- Session welcome bookkeeping should be owned by the runtime/session layer.

4. Destructive confirmation workflow
- Cancel person removal, task cancellation, and similar operations should use a code-level confirmation flow.
- The tool layer should return a structured confirmation requirement instead of relying on the prompt to remember when to ask first.

5. Read-path routing
- Normal inspection should go through `taskflow_query`, not SQLite.
- Runtime/tool exposure should make the intended read path obvious and safe; prompt text should only describe it.

6. No-direct-write enforcement
- TaskFlow mutation invariants should be enforced in runtime, not just documented.
- This includes blocking direct SQLite writes and ensuring `taskflow_*` remains the only normal mutation path.

7. Query scoping / board visibility
- The board visibility filter for SQL is deterministic and safety-critical.
- Prefer scoped query tools where possible; if SQL remains available, scoping should be enforced or wrapped, not left to prompt memory.

8. Notification dispatch ownership
- Notification fanout must remain fully internal to the engine/runtime.
- The model should not need to know when `notifications` or `parent_notification` are dispatched beyond “do not manually notify after TaskFlow tools.”

9. Parent-boundary reassignment constraints
- Child-board reassignment to parent-only identities should fail deterministically with a precise runtime error.
- Prompt guidance remains useful, but boundary enforcement belongs in the engine.

### Good Candidates to Move Later

1. Non-business-day due-date handling
- Suggestion generation is deterministic.
- The runtime can own date adjustment plus explicit confirmation requirements.

2. Ambiguous date rejection
- Locale/date ambiguity checks can be centralized in command parsing or tool validation.

3. Batch-operation expansion
- The expansion of plural commands over task IDs can be formalized in parser/tooling rather than described only in text.

4. Cross-group send rate limiting
- Already partially runtime-owned, but the template still carries too much operational guidance.

### Should Stay in the Template

1. WhatsApp formatting rules
2. concise command examples
3. workflow preference guidance
- for example, prefer `next_action` versus `waiting` for parent unblockers
4. explanations of hierarchy concepts
5. help/manual/quick-start wording
6. human-facing summaries, confirmations, and presentation style

## Migration Plan

### Phase 1: Identity and Welcome Ownership

Goal:
- remove deterministic identity and welcome bookkeeping from prompt space

Changes:
- add a shared sender resolver in runtime
- preserve `sender_name` compatibility at the MCP boundary while centralizing canonical person resolution behind it, or explicitly introduce a new canonical actor field and migrate all TaskFlow tool surfaces together
- move display-name sync into runtime
- move welcome-once handling into runtime-owned board onboarding logic instead of model-managed SQL

Template changes:
- replace detailed sender-resolution SQL with a short explanation of the resolved actor contract
- remove `welcome_sent` query/update instructions

Validation:
- sender aliases, first-name matches, and any added fallback modes resolve identically without prompt SQL
- welcome behavior is consistent with the chosen product rule:
  - once ever per board, or
  - once after provisioning/reset
  - but not unintentionally once per fresh TaskFlow session

### Phase 2: Safe Read Path and SQL De-emphasis

Goal:
- make `taskflow_query` the default and safe path for normal reads

Changes:
- keep `taskflow_query` as the first-class inspection surface
- first remove SQLite-as-default guidance for normal inspection
- add helper `taskflow_query` variants where normal workflows still depend on ad hoc SQL
- only after those helpers exist, restrict or more strongly scope SQLite reads for TaskFlow sessions

Template changes:
- keep only ad hoc reporting/debugging cases for SQLite reads
- describe `taskflow_query` as the default inspection path

Validation:
- no normal task inspection flow attempts SQLite first in live sessions
- generated prompts and tests fail if they reintroduce “SQLite read by default”
- legitimate read-only reporting/debugging flows still have a supported path

### Phase 3: Confirmation and Mutation Policy

Goal:
- move irreversible-action discipline from chat convention into tool semantics

Changes:
- normalize confirmation behavior across TaskFlow tools
- keep the existing structured confirmation model already used by reassignment
- extend machine-readable confirmation requirements to destructive admin actions
- keep fail-closed behavior for unsupported or unsafe mutations

Template changes:
- explain confirmation UX, but stop carrying the authoritative policy details

Validation:
- destructive actions require confirmation even if the prompt wording drifts
- cancellation/removal/reassignment flows are consistent across groups

### Phase 4: Reassignment Boundary Enforcement

Goal:
- formalize the missing reassignment-boundary behavior across parent/child boards

Changes:
- keep existing hierarchy enforcement already present in the engine
- add explicit engine errors for upward reassignment targets that are not resolvable on the current board
- keep prompt guidance for parent unblockers
- optionally add a future explicit “return to parent” action if needed

Template changes:
- retain workflow preference guidance
- remove any implied behavior that the engine does not actually support

Validation:
- child-board upward reassignment either succeeds through supported paths or fails with a precise explanation
- parent-unblocker flows continue to prefer `next_action` / `waiting`

### Phase 5: Prompt Simplification

Goal:
- shrink the template to workflow guidance and presentation

Changes:
- remove logic that became runtime-owned in earlier phases
- keep examples, formatting rules, and high-level operational guidance
- add drift tests that assert the template does not reintroduce engine-owned rules

Validation:
- template becomes shorter and less stateful
- runtime behavior remains stable under prompt variation

## Implementation Order

Recommended order:

1. Phase 2
- smallest behavior win with the least runtime churn
- directly addresses the recent live SQLite-read misstep

2. Phase 1
- highest long-term leverage
- identity resolution and welcome ownership are deterministic and repeatedly reused

3. Phase 3
- strong safety improvement with lower cost because part of the confirmation model already exists

4. Phase 4
- useful, but narrower than general hierarchy enforcement
- should come after the core identity/query/confirmation surfaces are stabilized

5. Phase 5
- cleanup pass after the runtime owns the right responsibilities

## Risks

1. Partial migration can increase confusion
- If a rule is half in prompt and half in code, ownership stays ambiguous.

2. Over-correcting can make the engine too rigid
- Not every workflow preference should become a hard invariant.

3. Identity migration can affect legacy boards
- Existing sender matching may rely on display-name quirks; rollout needs compatibility tests.

4. SQL restriction can block operational debugging
- Keep read-only ad hoc inspection available where it remains genuinely useful.

5. Welcome ownership can regress user experience if the product rule is not fixed first
- Moving welcome logic without defining whether it is board-scoped or session-scoped can create repeated or missing welcomes.

## Recommendation

Start with Phase 2 and Phase 1.

They address the most error-prone deterministic prompt behavior without changing core TaskFlow workflow semantics. After that, normalize destructive confirmation into tool semantics, then tighten reassignment-boundary enforcement.
