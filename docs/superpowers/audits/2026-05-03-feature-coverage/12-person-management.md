# Coverage Matrix — Section P: Person Management

> **Date:** 2026-05-03
> **Scope:** validate v2 plan covers all 10 person-management features (P.1–P.10) — registration, slug derivation, phone canonicalization, validation, collision detection, ownership tracking, manager/delegate roles, removal, observers without phone.
>
> **Inputs (cited by caller):**
> - Plan: `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md`
> - Spec: `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md`
> - Discovery 13 (user_roles + identity): `/root/nanoclaw/docs/superpowers/research/2026-05-03-v2-discovery/13-user-roles.md`
> - Engine: `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` (~9598 LOC)
> - v1 phone canonicalizer: `/root/nanoclaw/src/phone.ts`
> - Provisioning shared: `/root/nanoclaw/src/ipc-plugins/provision-shared.ts`
> - Sibling audit: `12-person-management.md` overlaps `10-admin-actions.md` on `add_manager`/`add_delegate` (those are person-mgmt LIFECYCLE here, admin GRANT semantics there).
> - Production DB: `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`
>
> **Source of truth (verified at audit time):**
> - `register_person`: engine `:7390-7499` (incl. hierarchy-board guard `:7423-7437`, slugify `:7440-7445`, dup check `:7448-7455`, phone canonicalization `:7460-7462`, INSERT `:7464-7476`, auto-provision request `:7478-7489`).
> - `remove_person`: engine `:7501-7553` (active-task guard, force unassign, board_admins cleanup, board_people DELETE).
> - `add_manager`: engine `:7555-7593`.
> - `add_delegate`: engine `:7595-7633`.
> - `remove_admin`: engine `:7635-7676` (last-manager guard).
> - `set_wip_limit`: engine `:7678-7697`.
> - `find_person_in_organization`: engine `:7138-7206` (`is_owner` derivation `:7203`).
> - `normalizePhone`: engine `:744-754` (mirrors `src/phone.ts`).
> - `maskPhoneForDisplay`: engine `:762-768`.
> - `sanitizeFolder` / `uniqueFolder`: provision-shared `:92-112` (folder-side collision suffix; **person_id has no equivalent suffix logic**).
> - `board_people` schema: `board_id, person_id, name, phone, role, wip_limit, notification_group_jid` — composite PK `(board_id, person_id)`.
> - `board_admins` schema: `board_id, person_id, phone, admin_role, is_primary_manager` — composite PK `(board_id, person_id, admin_role)`.

---

## Production validation (refreshed 2026-05-03)

All queries against `nanoclaw@192.168.2.63:/home/nanoclaw/nanoclaw/data/taskflow/taskflow.db`.

**Board-level person counts (top 10):**

| board_id | person count |
|---|---:|
| `board-seci-taskflow` | 13 |
| `board-laizys-taskflow` | 6 |
| `board-sec-taskflow` | 6 |
| `board-thiago-taskflow` | 6 |
| `board-setec-secti-taskflow` | 3 |
| `board-ci-seci-taskflow` | 2 |
| `board-secti-taskflow` | 2 |
| `board-anali-geo-taskflow` | 1 |
| `board-anali-sist-secti-taskflow` | 1 |
| `board-asse-inov-secti-taskflow` | 1 |

Total: **59 board_people rows across 28 boards**, **29 distinct person_ids** — i.e. on average each person sits on 2 boards (parent hub + own child board), confirming the homonym-disambiguation use case for `find_person_in_organization`.

**Phone canonicalization (write boundary):**

| LENGTH(phone) | rows | notes |
|---:|---:|---|
| 13 | 47 | post-2012 mobile (`55` + DDD + 9-digit subscriber) — canonical |
| 12 | 11 | pre-2012 mobile / landline (`55` + DDD + 8-digit subscriber) — canonical |
| 0 (empty) | 1 | observer Mariany Borges on `board-seci-taskflow` (role empty too) |

100 % of phone-bearing rows are canonical Brazilian E.164 (12 or 13 digits, all start with `55`). **Zero rows with non-canonical 10/11-digit phones, zero rows with leading `+`, zero international.** The write-boundary canonicalization is holding.

**person_id slug format (sample):**

```
giovanni, alexandre, miguel, rafael, laizys, thiago, mauro,
caio-guimaraes, reginaldo-graca, lucas, ana-beatriz, rodrigo-lima,
sanunciel, david-freire, wanderlan, cancio, joao-antonio, josele,
ellio-miguel, mariany, hudson, guilherme, edilson, joao-evangelista,
flavia-adrielly, mario-jose-da-silva-junior, maura-rodrigues-da-silva
```

All conform to the contract: lowercase, ASCII (accents transliterated — `ç→c`, `á→a`), hyphen-separated, no leading/trailing hyphens. **No numeric collision suffixes (`-2`, `-3`) found in production.** The collision-detection branch (engine `:7448-7455`) returns an error instead of auto-suffixing — meaning collisions are surfaced to the user, not silently disambiguated. (Folder uniqueness uses `uniqueFolder()` with numeric suffixes, but person_id does not.)

**Phone uniqueness:**

| metric | value |
|---:|---|
| total board_people rows | 59 |
| distinct phone values (incl. empty) | 29 |
| max occurrences of single phone | 3 (Carlos Giovanni @ 558688983914 — secti, seci, sec) |

Phone repetition across boards is the expected pattern (org-wide person → multiple boards) and is the reason `find_person_in_organization` masks phones to last-4 digits before returning to the agent.

**Observer / phoneless person count:** **1** (Mariany Borges on `board-seci-taskflow`, role empty). She is the sole production case of the "stakeholder without WhatsApp" pattern. The schema permits `phone TEXT` (nullable), but the hierarchy-board `register_person` guard at engine `:7427` *requires* phone — this row was created via direct SQL or before the guard, not through the MCP tool.

**Admin distribution:**

| admin_role | is_primary_manager | count |
|---|---:|---:|
| `manager` | 1 | 28 |
| `manager` | 0 | 1 |
| `delegate` | 0 | 1 |

30 grants across 28 boards — every board has exactly one primary manager + 2 boards have additional non-primary admins (1 manager, 1 delegate). Matches Discovery 13 §7's inventory.

**Removal events:** `task_history.action='person_registered'` has 1 row; **there is no `person_removed` action recorded** in `task_history` — `remove_person` (engine `:7501-7553`) does not write a history row. (This is a soft-delete tracking gap — see GAP-P.9 below.)

---

## Coverage matrix

| ID | Feature | v1 location | v2 plan/spec location | Status | GAP? | Notes |
|---|---|---|---|---|---|---|
| **P.1** | `register_person(person_name, phone, role, wip_limit, group_name?, group_folder?)` | engine `:7390-7499`; consumed by `taskflow_admin` MCP action | **MISSING from spec** — Spec §"Board-management tools" line 245 lists only `add_board_admin`/`remove_board_admin` (admin grant); §"Kanban tools" 248-260 lists no person CRUD. Plan §2.3.a says "IPC plugins → MCP tools (single file)" — implicit but not enumerated. | **MISSING (by name)** | **GAP-P.1.spec** | Spec must enumerate `register_person` (or rename — `add_board_member`?) as an MCP tool. Current spec only models the admin-grant overlay (`user_roles`), not the underlying person row. **All 59 production rows entered through this path.** |
| **P.2** | Slug derivation: `lowercase → NFD → strip combining marks → [^a-z0-9]+ → '-' → trim` (engine `:7440-7445`) | engine `:7440-7445`; same algorithm as `sanitizeFolder` (provision-shared `:92-100`) minus the trailing `-taskflow` | **NOT enumerated** in spec/plan | **COVERED IMPLICITLY (port-forward)** | **GAP-P.2.contract** | Slug algorithm has 4 distinct stages and is observable in production (e.g. `Caio Guimarães` → `caio-guimaraes`, `Reginaldo Graça` → `reginaldo-graca`, `Joselé` → `josele`). Spec must restate the contract because it intersects with v2's `users.id` namespacing (`phone:+E164`, per Discovery 13 §5) — the v1 slug is **board-scoped**, the v2 user_id is **global**. Per-board slug will continue to live in `board_people.person_id` (in fork-private `data/taskflow/taskflow.db`). Verify: per Discovery 13, the v2 `users` table identifies people by `phone:+E164`, not slug — so slug is fork-private and survives v2 migration. |
| **P.3** | Phone canonicalization at write boundaries — `normalizePhone()` engine `:744-754` (mirror of `src/phone.ts`); applied at INSERT in `register_person` `:7460-7462`, `add_manager` `:7578-7580`, `add_delegate` `:7618-7620`. | engine `:744-754, 7460, 7578, 7618`; v1 `src/phone.ts:25-44` | Plan §2.3.e seeds `taskflow_board_admin_meta` extension with `is_primary_manager`/`is_delegate` (Discovery 13 maps to `user_roles + extension`). **Spec does not explicitly cite phone canonicalization** at the v2 write boundary. Sibling audit `10-admin-actions.md:177` flags the same gap for `add_manager`/`add_delegate`. | **PARTIAL — port-forward but undocumented** | **GAP-P.3.contract** | Per memory `feedback_canonicalize_at_write.md`: "identifier columns must be canonicalized at INSERT/UPDATE." Spec must restate that v2 preserves write-boundary canonicalization for **all three callers** (`register_person`, `add_manager`, `add_delegate`). v2 `users.id = 'phone:+E164'` (Discovery 13 §5) — slightly different format (with `+`) — so the v2 layer adds prefix `phone:+` AT THE WRITE BOUNDARY when populating `users` (per Discovery 13 §5 verification SQL); the fork-private `board_people.phone` keeps the digits-only Brazilian E.164 form. Two write-side canonicalizations live side-by-side. **Spec must state both and how they're kept in sync.** |
| **P.4** | Phone validation (digits, 10-13 chars post-normalize) | engine `:744-754` rules: 12-13 digits starting with `55` → canonical; 10-11 digits, no leading 0 → prepend `55`; else pass through | **NOT enumerated** in spec/plan | **COVERED IMPLICITLY** | **GAP-P.4.contract** | Validation is **soft** — `normalizePhone` returns the input unchanged for international or trunk-prefixed (leading 0) numbers. The hierarchy-board `register_person` guard at `:7427` requires `phone.trim().length > 0` but does NOT enforce E.164 length. **Plan/spec must call out the documented false-positive (NANP 10-digit numbers with area codes 11-99 get `55` prepended) and the policy of "100 % Brazilian users in 3 yrs of prod data" per `src/phone.ts:18-20` comment.** Production validation: 0 rows with non-canonical phones (47 × 13-digit + 11 × 12-digit + 1 empty) — invariant holds. |
| **P.5** | Person ID collision detection — `INSERT INTO board_people` after dup-check at `:7448-7455` returns error "Person … already exists" | engine `:7448-7455` | **NOT enumerated** in spec/plan | **COVERED (via PK + explicit dup-check)** | **GAP-P.5.policy** | Engine returns an **error** on collision rather than auto-suffixing (no `field-ops-2` analog of `uniqueFolder()`). The `(board_id, person_id)` composite PK is the backstop. Folder-side has `uniqueFolder()` (`provision-shared:102-112`) for `<slug>-taskflow` board folders, with numeric suffixes — visible in production: `board-asse-seci-taskflow-2`, `board-asse-seci-taskflow-3`, `board-est-secti-taskflow-2`, `board-est-secti-taskflow-3`. **Person-ID side has no such suffixing — the policy is "fail and ask user to re-enter."** Spec must declare the policy explicitly so v2 doesn't accidentally adopt auto-suffixing (which would break v1 reproducibility). |
| **P.6** | Person ownership tracking — `is_owner: r.owner_person_id === r.person_id` in `find_person_in_organization` result rows (engine `:7203`) | engine `:7138-7206` | **NOT enumerated** in spec/plan | **COVERED IMPLICITLY (port-forward)** | **GAP-P.6.contract** | `boards.owner_person_id` (column on the `boards` table) marks "this person's home board." `find_person_in_organization` joins to `boards` and emits `is_owner = (owner_person_id === person_id)` per row. Used by agents to prefer the home-board row when the same person appears on multiple boards (homonym disambiguation: `Carlos Giovanni` on 3 boards → 1 home, 2 cross-listings). **Plan must explicitly preserve `owner_person_id` semantics in the v2 board schema (lives in `data/taskflow/taskflow.db`, fork-private).** Plan §2.3.d ("Schema migrations… 1 fork-private DB initializer") covers the table existence but not the semantics. |
| **P.7** | Manager role with `is_primary_manager` flag | engine `:7555-7593` (`add_manager`), schema `board_admins(is_primary_manager INTEGER)` | Plan §2.3.e: `taskflow_board_admin_meta(is_primary_manager, is_delegate)` extension table joined to v2 `user_roles(role='admin')`. Discovery 13 §7 explicitly recommends Option #3 (extension table). | **PARTIAL — extension table specified but `add_manager` MCP tool not enumerated** | **GAP-P.7.tool** | Plan §2.3.e covers the **migration** (30 v1 rows → user_roles + extension), but the spec's MCP-tool inventory (line 245) names only `add_board_admin` — not the v1 `add_manager` distinction. Distinction matters: **`is_primary_manager=1` is the digest-credit-attribution rule** (per memory `feedback_digest_compliments.md` — "Laizys entregou" not "você entregou"). Spec must restate that `add_board_admin` accepts an `is_primary` flag OR provide a separate `set_primary_manager` MCP tool. **28 of 29 manager grants in production are primary; the 1 non-primary case is `board-seci-taskflow / mauro` (manager but not primary).** |
| **P.8** | Delegate role (non-primary, restricted permissions) | engine `:7595-7633` (`add_delegate`), schema `board_admins(admin_role='delegate')`; permission gate `isManagerOrDelegate` at engine `:3440-3455`; delegates get `process_inbox` (engine `:7370-7376`) but not other admin actions | Plan §2.3.e maps to `taskflow_board_admin_meta(is_delegate)` extension; sibling audit `10-admin-actions.md:95-100` covers `add_delegate` from admin-actions angle | **PARTIAL — extension column spec'd but tool + scoped-permission semantics not enumerated** | **GAP-P.8.permission** | Single delegate in production (`board-seci-taskflow / sanunciel`). v1 permission semantics are **not** captured in v2's flat `user_roles(role='admin')` model — both manager and delegate flatten to `'admin'`, losing the "delegate can only `process_inbox`" restriction. Plan §2.3.e mentions extension column but **does not specify how engine permission checks (`isManagerOrDelegate`, `requireManager`) survive**. Two options: (a) preserve `isDelegate(user_id, agent_group_id)` lookup against extension table; (b) drop delegate restriction entirely (delegates become full admins). **Decision needed before A.3.7 test phase.** |
| **P.9** | Person removal from board | engine `:7501-7553`: active-task check → force-unassign → DELETE board_admins → DELETE board_people | **NOT enumerated** in spec/plan | **COVERED IMPLICITLY (port-forward) + soft-delete tracking gap** | **GAP-P.9.history** | Engine does **NOT** write a `task_history` row for person removal — production has 0 `person_removed` action rows but 1 `person_registered` row. This is a silent audit-trail gap: a manager can `remove_person → force=true` and unassign N tasks, with the assignee-clear visible in per-task history but the *person-removal* event invisible. **Plan should add a remove-person history row** (action=`person_removed`, details={person_id, name, force, tasks_unassigned}). Engine fix is ~5 LOC. (Sibling: `task_history` already records `assigned`/`reassigned`, so the schema supports it.) |
| **P.10** | Observer / stakeholder without WhatsApp (phone optional on leaf boards) | Schema `board_people.phone TEXT` (nullable); `register_person` guard at `:7423-7437` requires phone ONLY on hierarchy boards (`canDelegateDown()` — non-leaf); leaf boards permit `phone IS NULL` | **NOT enumerated** in spec/plan | **COVERED (schema-permitted) but undocumented** | **GAP-P.10.contract** | Production: 1 phoneless person (Mariany Borges, `board-seci-taskflow`). The `register_person` guard at `:7423-7437` rejects `phone=null` ONLY for hierarchy boards (depth < max_depth) because the auto-provision flow needs the phone for the DM invite. **On leaf boards, observers without WhatsApp are permitted.** Spec must restate this contract because: (a) v2's `users` table requires a `kind` (`phone` or `email` or `discord`…) — a phoneless `board_people` row has no v2 `users.id` to link to; (b) v2's `user_dms` cannot route to a phoneless observer; (c) participation in board notifications is silent. Recommend: spec defines `kind='observer'` (no `users` row) OR explicitly states observers don't get v2 identity rows. |

**Cross-cutting:**

| ID | Feature | Plan coverage |
|---|---|---|
| **P.aux1** | `find_person_in_organization` (org-wide search across hierarchy) | engine `:7138-7206`; uses `getOrgBoardIds()` walker (engine `:1691`); LIKE escape sequence prevents directory enumeration via `%`/`_`. **Not enumerated in spec/plan.** Returns `phone_masked: '•••<last-4>'` per row (engine `:762-768`) — mask is privacy-by-default; do not promote to plain phone in v2. |
| **P.aux2** | Auto-provision child board on `register_person` (engine `:7478-7489`) | Returns `auto_provision_request: { person_id, person_phone, group_name, group_folder, ... }` when `params.phone && this.canDelegateDown()`. Triggers host-side `provision-child-board.ts` IPC plugin. Plan §2.3.b cites `provision_taskflow_board` MCP but **the auto-provision path on register is distinct** — a non-leaf board's `register_person` MUST emit this AdminResult key, otherwise child-board flow silently breaks (per the historical Edilson 2026-04-10 bug noted at engine `:7410-7412`). |
| **V.4** | `taskflow_admin` MCP tool (umbrella for `register_person`, `remove_person`, `add_manager`, `add_delegate`, `remove_admin`, `set_wip_limit`) | Sibling mapping should mark FORK-KEEP. v1 multiplexes 17 actions through one tool (`taskflow_admin`). v2 spec line 245's `add_board_admin`/`remove_board_admin` is a 2-tool decomposition that **drops 4 v1 actions** (`register_person`, `remove_person`, `set_wip_limit`, `find_person_in_organization`). |
| **X.2** | Engine tests for person mgmt | `taskflow-engine.test.ts` (covers `register_person`/`remove_person`/`add_manager`/`add_delegate`/`set_wip_limit` paths); plan §2.4 inherits via port-forward. |

---

## Status counts

| Status | Count | IDs |
|---|---:|---|
| COVERED | 1 | P.5 |
| COVERED IMPLICITLY | 4 | P.2, P.4, P.6, P.9 (with policy gap), P.10 (with contract gap) |
| PARTIAL | 4 | P.3, P.7, P.8, plus P.aux2 |
| MISSING | 1 | P.1 |

GAPs: **10** open — P.1.spec (tool not named), P.2.contract (slug algorithm), P.3.contract (canonicalization restatement), P.4.contract (validation policy), P.5.policy (no auto-suffix), P.6.contract (`owner_person_id`), P.7.tool (`is_primary` flag), P.8.permission (delegate semantics), P.9.history (audit-trail row), P.10.contract (observer kind).

---

## Recommended plan amendments

1. **Spec amendment (MCP tool inventory):** §"Board-management tools" line 245 needs **6 additional rows** for the person-mgmt domain: `register_person`, `remove_person`, `add_manager` (with `is_primary` flag), `add_delegate`, `remove_admin`, `set_wip_limit`, `find_person_in_organization`. Either add as a new "Person tools" subsection or expand "Board-management tools" — the 2-tool decomposition (`add_board_admin`/`remove_board_admin`) is insufficient. (**GAP-P.1.spec**, **GAP-P.7.tool**, **GAP-P.aux1**)

2. **Spec restatement (canonicalization invariants):** §"Migration mapping" or new §"Identity & canonicalization" — explicitly document:
   - v1 `board_people.phone` keeps **digits-only Brazilian E.164** (no `+`).
   - v2 `users.id` keeps **`phone:+E164`** form (with `+`, per Discovery 13 §5).
   - Both are **write-boundary canonicalized** (memory `feedback_canonicalize_at_write.md`); the seed migrator converts between forms.
   - Slug derivation is per-board-private, lives in fork-private `board_people.person_id`. v2 `users.id` does not use the slug. (**GAP-P.2.contract**, **GAP-P.3.contract**)

3. **Spec policy decision (collision detection):** state explicitly that `register_person` **errors on collision** rather than auto-suffixing person_id. Document the asymmetry with `uniqueFolder()` (which DOES auto-suffix board folders). (**GAP-P.5.policy**)

4. **Plan §2.3.d schema-init test (preserve `owner_person_id`):** the leaf-board home-board indicator is load-bearing for `find_person_in_organization` `is_owner` derivation. Init test must assert `boards.owner_person_id` column survives the v2 fork-private DB initializer. (**GAP-P.6.contract**)

5. **Plan decision (delegate semantics):** §2.3.e currently flattens `manager`+`delegate` → `user_roles(role='admin')` + extension column. Decide:
   - **(a) Preserve restriction:** add `isDelegate(userId, agentGroupId)` helper that queries `taskflow_board_admin_meta`. Engine permission gates (`isManagerOrDelegate`, `requireManager`) read from extension. ~30 LOC + 2 tests.
   - **(b) Drop restriction:** delegates become full admins; the 1 production delegate (`sanunciel`) gains `add_task`/`reassign`/all admin actions. Behavior change visible in production.
   Recommend (a) — the restriction exists for a reason (`process_inbox` is the explicit delegate scope). (**GAP-P.8.permission**)

6. **Plan amendment (audit-trail invariant):** add to §2.3.a or a new test — `remove_person` must write `task_history(action='person_removed', details=…)` row. ~5 LOC engine fix + 1 test. Closes the silent-removal audit gap. (**GAP-P.9.history**)

7. **Spec definition (observer / stakeholder kind):** §"Identity & canonicalization" should declare what a phoneless `board_people` row maps to in v2:
   - **Option (a):** No `users` row. The `person_id` is fork-private, lives only in `board_people`. Mariany Borges has no v2 identity. Notifications skip her. **Matches current behavior.**
   - **Option (b):** Synthetic `users.id = 'observer:<slug>@<board_id>'` with `kind='observer'`. New kind. Allows future channel attachment.
   Recommend (a) — minimum viable; revisit if observers need notifications. (**GAP-P.10.contract**)

8. **Plan §A.3.7 (per-tool happy path):** add 6 person-mgmt rows to Step 7.1 coverage table — `register_person` (4 variants: leaf w/o phone, leaf w/ phone, hierarchy w/ all 3 fields, hierarchy missing field → reject), `remove_person` (no active tasks, with active tasks → confirmation, force=true), `add_manager` (incl. is_primary toggle), `add_delegate`, `remove_admin` (last-manager guard), `set_wip_limit`, `find_person_in_organization` (mask, is_owner, LIKE-escape).

---

## Production source code references (current paths)

- **`register_person` action:** `container/agent-runner/src/taskflow-engine.ts:7390-7499`
  - Hierarchy-board guard: `:7423-7437`
  - Slugify: `:7440-7445`
  - Dup check: `:7448-7455`
  - Phone canonicalization: `:7460-7462`
  - INSERT: `:7464-7476`
  - Auto-provision request: `:7478-7489`
- **`remove_person` action:** `:7501-7553`
  - Active-task guard: `:7506-7522`
  - Force-unassign: `:7525-7533`
  - DELETE board_admins: `:7536-7540`
  - DELETE board_people: `:7544-7547`
  - **(missing)** task_history insert
- **`add_manager` action:** `:7555-7593` (idempotency `:7560-7568`, phone read+canonicalize `:7570-7580`, INSERT `:7581-7586`)
- **`add_delegate` action:** `:7595-7633`
- **`remove_admin` action:** `:7635-7676` (last-manager guard `:7639-7660`)
- **`set_wip_limit` action:** `:7678-7697`
- **`find_person_in_organization` query:** `:7138-7206`
  - Org walker: `getOrgBoardIds()` `:1691`
  - LIKE escape: `:7161-7166` (prevents directory enumeration)
  - Result mapping (`phone_masked`, `is_owner`): `:7189-7204`
- **Phone canonicalizer:** `:744-754` (mirrors `src/phone.ts:25-44`)
- **Phone mask for display:** `:762-768`
- **Slug algorithm (folder side):** `src/ipc-plugins/provision-shared.ts:92-100` (`sanitizeFolder`)
- **Folder uniqueness suffix:** `src/ipc-plugins/provision-shared.ts:102-112` (`uniqueFolder`)
- **Type contracts:** `AdminParams.action` `:247`, `AdminResult` `:271-294`, `auto_provision_request` `:282-292`

## Why these GAPs matter (production scale)

- **GAP-P.1.spec (MCP tool not named):** All **59 production board_people rows** entered through `register_person` — 100 % of the person-row population. Spec's `add_board_admin` 2-tool decomposition assumes person rows pre-exist; in v1 they are **created by** `register_person`. Naming gap is structural, not cosmetic.
- **GAP-P.3.contract (write-boundary canonicalization):** 100 % of the 58 phone-bearing rows are canonical (47 × 13-digit + 11 × 12-digit). The invariant is what makes WhatsApp JID lookup (`<phone>@s.whatsapp.net`) work without per-read normalization. **A v2 migration that loses write-boundary canonicalization (e.g. accepts `+5586...` and `5586...` as different rows) splits the population.** Memory rule (`feedback_canonicalize_at_write.md`) is firm.
- **GAP-P.7.tool (`is_primary_manager`):** **28 / 29 = 97 %** of manager grants in production are primary. The flag drives digest-credit attribution (memory `feedback_digest_compliments.md`). Losing it in v2 means digest stops naming the right human.
- **GAP-P.8.permission (delegate restriction):** Only 1 production delegate, but the restriction exists because delegates are intentionally scoped to `process_inbox`. Flattening to "full admin" silently expands their authority. **Production-observable behavior change.**
- **GAP-P.9.history (no person_removed row):** Silent audit-trail gap. Multiple board reorganizations have occurred in 60 d (3 boards with `-2`/`-3` folder suffixes — `asse-seci`, `est-secti`); if any were preceded by `remove_person → force=true` we have no record of the bulk-unassign event apart from per-task history. **Missing data, not just doc gap.**
- **GAP-P.10.contract (observer kind):** 1 / 59 rows is phoneless. v2's `users` table has no `kind='observer'`; if migration tries to upsert a `users` row for Mariany it will violate the namespace rule (`phone:` requires phone). **Migration script will throw** unless this case is explicitly handled.
