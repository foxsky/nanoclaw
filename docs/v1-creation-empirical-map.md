# V1 TaskFlow board/user creation — empirical map (success + failure)

**Snapshot:** `/tmp/nanoclaw-v1-snapshot-cutover-20260529/` (`store/messages.db` 12,737 msgs +
35 `registered_groups`; `data/taskflow/taskflow.db` 34 boards / 70 `board_people` rows).
**Method:** 8 per-chat classifiers over the creation-active chats, cross-referenced to the
taskflow.db end-state, reconciled against the 34-board ground truth. **Surfaced:** 2026-05-30.

> **Verification.** The four headline defects below were re-queried directly against
> `taskflow.db` (not taken on the classifier's word): Sanunciel has a `board_people` row but
> owns **zero** boards; Hudson owns **three** boards (`hudson`, `po-setd-secti`,
> `po-setd-secti-2`, all parent=thiago); Jefferson's `person_id`
> `jefferson-marcilio-daniel-correia` reads `Jefferson Marcílio Daniel Correia` on the parent
> but **`Marcilio Daniel`** on the child; Mariany has **two distinct person_ids** (`mariany`
> stub + `mariany-borges` full) on `board-seci-taskflow`. All confirmed.

## Headline verdict

The earlier loose claim **"v1 creation always worked" is FALSE and is retired.** Every board/person
a human *affirmed* wanting ended up as **at least a person row** — **zero total registration
omissions, zero stalls of an affirmed request** — but **Sanunciel is a partial creation failure**
(person created, child board silently absent), and the **async child-board path carried 6 defects in
all**.

Honest framing: **"V1 creation never lost an affirmed person, but the hierarchy child-board step had
6 defects (1 silently-skipped board, 2 wrong-name, 1 duplicate, 1 announce≠persist, 1 dual-identity)."**

**Creation/registration episodes (per-episode table below): 49** table rows. (Excludes the 6 level-1
boards bulk-provisioned in the 2026-03-07 bootstrap batch — no chat episode — and the MAIN-CONTROL
no-op placeholder row.)

| Outcome | Count | Notes |
|---|---|---|
| success | 29 | 27 single-pass + 2 retry-then-success |
| success_with_defect | 6 | genuine product bugs (see taxonomy) |
| duplicate_or_linked | 6 | pre-existing person surfaced by per-board identity; correctly NOT duplicated |
| declined_by_user | 6 | operator chose the external-participant path; correct UX |
| stalled_incomplete | 2 | operator never supplied data; NOT product bugs |
| **Total** | **49** | + 6 bootstrap-batch level-1 boards (no chat episode) accounted for separately |

**Defect rate:** 6 defective episodes / 49 traced (~12%). Of the 33 child boards, **4 carry a
board-level defect** (Sanunciel missing, Hudson duplicate, Edilson + Jefferson wrong-name); Mariany
(dual `person_id`) and Reginaldo (announce ≠ persist) are person-level.

`offer_register` (50×) and ambiguity (3×) prompts are **normal UX, not failures** — they are counted
by whether the operator's intent was ultimately fulfilled, not by prompt volume.

## The 6 defects (all DB-verified)

| # | Case | Defect | Class | v2 status |
|---|---|---|---|---|
| 1 | **Sanunciel** (SECI) | Person registered; **child board never provisioned**, no error surfaced. Person-create and board-provision are not atomic. | Silent skip — most serious | **⚠️ persists** (engine, non-atomic) → EX-014 |
| 2 | **Edilson** (SETD) | `provision_child_board` fired *before* the division sigla arrived → personal `board-edilson` instead of an SM board. Bot self-admitted the race. | Name-too-late race | Mitigated (name-heal) |
| 3 | **Jefferson** (SEAF) | Child `board_people` stores `Marcilio Daniel`; parent has full `Jefferson Marcílio Daniel Correia` (same `person_id`). | Name truncation | **Fixed** (init name-heal, same person_id) |
| 4 | **Hudson** (SETD) | `provision_child_board` double-fired ~95s → `po-setd` **and** `po-setd-2`; no idempotency guard. Plus an orphan `board-hudson` → owns 3. | Duplicate board | Race fixed; **dup data persists** |
| 5 | **Reginaldo** (SETEC) | Bot announced board id `board-setd-secti-2` that **doesn't exist**; real board is elsewhere. Confirmation lied. | Announce ≠ persist | Reduced (canonicalize-at-write) |
| 6 | **Mariany** (SECI) | 30/03 delegate stub `mariany` never cleaned up; 15/05 full register made `mariany-borges`. **Two person_ids, one human.** | Orphan/dup identity | **⚠️ persists** (name-heal keys on person_id; needs canonical-people, v2.1) → EX-015 |

## Per-episode table (38 episodes)

| Chat (board) | Type | Subject | Outcome | Reason | In taskflow.db |
|---|---|---|---|---|---|
| SEC (root) | root_board | SEC-SECTI board | success | Provisioned before window (reg 03-07 13:33) | ✅ |
| SEC | add_person | Alexandra (typo) | success | Typo→existing Alexandre; T14 assigned | ✅ |
| SEC | add_person | Katia | declined_by_user | External meeting participant | ❌ (correct) |
| SEC | add_person | Ismael | declined_by_user | External meeting participant | ❌ (correct) |
| SECI | child_board | Mauro Cesar | success | offer→sigla→register→board-ci-seci | ✅ |
| SECI | add_person | Miguel | duplicate_or_linked | Already on parent board-sec; correct dedup | ✅ (parent) |
| SECI | child_board | Lucas + Ana Beatriz | success (retry) | Multi-turn data gather; 2 child boards | ✅ |
| SECI | child_board | Rodrigo Lima | success | board-asse-seci-3 | ✅ |
| **SECI** | **child_board** | **Sanunciel** | **success_with_defect** | **Person registered, child board NEVER provisioned** | ✅ person / ❌ board |
| SECI | child_board | David Freire | success | board-est-secti-2 | ✅ |
| SECI | child_board | Wanderlan | success | board-geo-secti | ✅ |
| SECI | child_board | Câncio | success | board-anali-sist-secti | ✅ |
| SECI | child_board | João Antonio | success | board-est-secti-3 | ✅ |
| SECI | child_board | Joselé | success | board-asse-inov-secti | ✅ |
| SECI | child_board | Ellio Miguel | success | board-anali-geo | ✅ |
| **SECI** | **add_person** | **Mariany (stub)** | **success_with_defect** | **30/03 delegate stub never cleaned up → dup row** | ✅ (orphan) |
| SECI | add_person | beatriz (lowercase) | duplicate_or_linked | Name-match miss; no dup created | ✅ (one row) |
| SECI | other | Cleonildo/Rafael/Thiago/Gabriel/Raimundo | success | Meeting externals; M3/M6/M7 created | ❌ (correct) |
| SECI | child_board | Araci | success | board-seci-plan | ✅ |
| SECI | child_board | Mariany Borges | success | board-semcaspi (compounds 30/03 dup) | ✅ |
| SETD (thiago) | add_person | Miguel Oliveira | duplicate_or_linked | On parent board-sec; bot wrongly contradicted user | ✅ (parent) |
| SETD | add_person | Caio Guimarães | success | board-ux-setd-secti | ✅ |
| SETD | add_person | Reginaldo Graça | success | board-setd-secti | ✅ |
| SETD | add_person | Edmilson | declined_by_user | External; correct branch | ❌ (correct) |
| SETD | add_person | Cancio | declined_by_user | External; M9/M10 created | ❌ (correct) |
| SETD | add_person | Hudson | success | board-hudson; M17 created | ✅ |
| SETD | add_person | Guilherme | success | board-sm-setd-secti | ✅ |
| **SETD** | **child_board** | **Edilson** | **success_with_defect** | **Provisioned before sigla → wrong name (board-edilson)** | ✅ (wrong name) |
| SETD | add_person | Wendel Magulas | success | Person only (no board promised) | ✅ |
| SETD | add_person | Herdeson Monte | success | board-infra-setd-secti | ✅ |
| SETD | add_person | Laizys | duplicate_or_linked | Already in org (2 boards); cross-board link | ✅ |
| SETD | add_person | Edilson Viana | duplicate_or_linked | Redundant prompt; already=edilson | ✅ (one row) |
| **SETD** | **child_board** | **Hudson (PO-SETD)** | **success_with_defect** | **provision double-fired ~95s → po-setd + po-setd-2 dup** | ✅ (dup board) |
| SETEC | add_person | miguel | stalled_incomplete | Operator pivoted; never registered here | ❌ (parent only) |
| **SETEC** | **add_person** | **Reginaldo Graça** | **success_with_defect** | **Announced board-setd-secti-2 (nonexistent); real board under Thiago** | ✅ person / id-drift |
| SETEC | child_board | João Evangelista | success (retry) | sigla-conflict resolved; board-ge-sup-secti | ✅ |
| SETEC | add_person | Laizys | stalled_incomplete | Operator never supplied phone/cargo | ❌ (parent only) |
| SEAF (laizys) | child_board | Flavia (GEADMIN) | success | board-seaf-geadmin | ✅ |
| SEAF | child_board | Joao Henrique (GEFIN) | success | board-seaf-gefin | ✅ |
| SEAF | child_board | Mario Jose (ASTEC) | success | board-seaf-astec | ✅ |
| SEAF | child_board | Maura (RH) | success | board-seaf-rh | ✅ |
| SEAF | child_board | Francisco (CONTABILIDADE) | success | board-seaf-contabilidade | ✅ |
| SEAF | add_person | Rafael | duplicate_or_linked | Already in sibling SETEC; dup avoided | ✅ (sibling) |
| **SEAF** | **child_board** | **Jefferson (PATRIMONIO)** | **success_with_defect** | **Child stores "Marcilio Daniel" — first name dropped** | ✅ (name defect) |
| CI-SECI | root_board | CI-SECI board | success | Level-3 board, owner mauro | ✅ |
| CI-SECI | add_person | Lucas Batista | declined_by_user | VIEW query, not create; pivoted away | ❌ (correct) |
| CI-SECI | add_person | João Neto/Antonio | success | Disambiguated to existing João Antonio | ✅ |
| ASSE-INOV | root_board | ASSE-INOV board | success | Owner josele; welcome 03-24 | ✅ |
| ASSE-INOV | add_person | Terciane | declined_by_user | Offer ignored; pivoted away | ❌ (correct) |
| MAIN-CONTROL (DM) | — | (none) | — | All "cadastr" hits are audit prose; 0 real episodes | n/a |

> The 6 silently-provisioned level-1 boards (SECTI, SECI, TEC, SETEC, SEAF/laizys, SETD/thiago) are
> counted as 6 successes via their root/parent rows; they have **no individual chat trace** — see
> Reconciliation.

## Failure taxonomy (non-success episodes)

- **A. Silently-skipped child board — 1, PRODUCT BUG (most serious).** Sanunciel: person row exists,
  no board with `owner_person_id='sanunciel'`. Person-create + board-provision not atomic; failure
  surfaced only as a *missing* confirmation. → **EX-014**.
- **B. Wrong/mangled name — 2, PRODUCT BUGS (Jefferson-class).** Edilson (provision before sigla →
  `board-edilson`); Jefferson (`Marcilio Daniel` vs full name on parent).
- **C. Duplicate child board — 1, PRODUCT BUG.** Hudson PO-SETD double-fired ~95s → `po-setd` +
  `po-setd-2`; plus orphan `board-hudson` (owns 3).
- **D. Announce ≠ persist — 1, PRODUCT BUG.** Reginaldo: confirmation cited a board id that doesn't
  exist.
- **E. Orphan/dup identity — 1, PRODUCT BUG.** Mariany: stub `mariany` + full `mariany-borges` =
  two person_ids for one human. → **EX-015**.
- **F. Operator abandonment — 2, NOT bugs.** miguel/Laizys (SETEC): offer fired correctly, operator
  never supplied data.
- **G. Per-board identity as register prompt — 6, NOT bugs.** Miguel/Laizys/Edilson-Viana/Rafael/
  beatriz: pre-existing people correctly surfaced + dedup'd by the per-board identity model. (Nit:
  SETD's bot wrongly contradicted Thiago that Miguel "wasn't registered.")
- **H. External-participant declines — 5, NOT bugs.** Correct UX.

## Reconciliation

`boards.created_at` is **NULL for all 34 rows** — V1 never populated it. Creation timing is recovered
from `registered_groups.added_at` (35 rows = 1 DM + 34 boards; span 2026-03-07 11:46 → 2026-05-15
11:54), which **aligns to provisioning timestamps to the second** (e.g. `board-ux-setd-secti` reg
03-11T17:17:04 = Caio's "quadro provisionado" 17:17:04; `seaf-patrimonio` reg 05-12T13:54:07 =
Jefferson 13:54:07; `po-setd-secti-2` reg 05-11T13:41:41 = the duplicate).

- **Boards with NO chat-creation episode (silent/direct):** the 6 level-1 SEC children + root, all
  registered in one **2026-03-07T13:33** bootstrap batch. `board-secti-taskflow` is the ownerless
  board (2 people: alexandre, giovanni), its dedicated chat was **not in the analyzed set** — the one
  board whose creation+population is unexplained by the analyzed corpus (recon gap, not a defect).
  `board-tec-taskflow` similarly.
- **Chat attempts with NO board outcome:** Sanunciel (the §A bug — only case where an *affirmed*
  creation is partly absent); miguel/Laizys SETEC (operator abandonment); all declined externals
  (correctly absent).
- **Net:** 33 child boards reconcile to classified successes + the 03-07 bootstrap, **except**
  Sanunciel's missing board and the `po-setd-2` board that shouldn't exist. 70 `board_people` rows =
  34 distinct people + owner double-listings + the 1 Mariany orphan.

## What we cannot see (limitations)

1. **No tool layer.** `agent_turn_messages` maps turn→message only — V1 `provision_*`/`register_person`
   calls and their internal error returns are **not** stored. A failure that errored *silently without
   chat text* is invisible. Sanunciel was catchable only because the confirmation was *missing*.
2. **`boards.created_at` NULL** — timing reconstructed from `registered_groups.added_at` + chat
   timestamps (which align), but the canonical column is empty.
3. **2 of 34 boards** (`secti`, `tec`) had no analyzed chat — verified by DB end-state only.
4. Meeting (`M`-prefixed) rows aren't retained under queryable titles — meeting successes confirmed
   via transcript only.

## v2 relevance — verified against v2 source (per-defect sweep 2026-05-30)

Two axes: does v2 **prevent** a new occurrence, and does v2/migration **repair** the existing
migrated rows. (This supersedes the earlier "mitigated/likely fixed" labels — which were
unverified inferences; the sweep corrected them in both directions.)

| Failure class | Prevents new? | Repairs existing? | Verdict + evidence |
|---|:---:|:---:|---|
| Person-named board too early (Edilson) | **Yes** | n/a | **FIXED** — hierarchy `register_person` rejects a missing `group_name`/`group_folder`/`phone` before slug + before `auto_provision_request` (`taskflow-engine.ts:9416-9430`); MCP tool has no person-name fallback (`mcp-tools/provision-child-board.ts:56-59`). |
| Name truncation, same `person_id` (Jefferson) | No (write-time) | **Yes** (boot heal) | **PARTIAL → effectively closed** — `canonicalizeBoardPersonNames` longest-name-wins UPDATE at `initTaskflowDb` (`taskflow-db.ts:743-783`); inserts still copy the name verbatim, but each boot re-heals. |
| Duplicate child board (Hudson) | **Yes** | **No** | **FIXED (creation path)** — `alreadyOnThisParent` guard before createGroup/seed (`provision-child-board.ts:361-370`) + serialized delivery + `(parent_board_id, person_id)` PK backstop. BUT the existing `board-po-setd-secti-taskflow-2` row migrates verbatim → needs a one-time data cleanup. |
| Announce ≠ persist (Reginaldo) | **Partial** | n/a | **PARTIAL** — the HOST confirmation reuses the persisted/deduped `childBoardId` (`provision-child-board.ts:431,617`), but the CONTAINER optimistic ack announces un-deduped `board-${groupFolder}` (`poll-loop.ts:2838`) → still diverges on a folder collision. Cheap fix: drop the concrete id from the container ack. |
| **Silently-skipped board (Sanunciel)** | **No** | **No** | **NOT-FIXED** — non-atomic person+board; optimistic reply + log-and-return is marked delivered with no retry (`poll-loop.ts:2832`; `delivery.ts:190-227`). → EX-014. |
| **Dual `person_id` (Mariany)** | **No** | **No** | **NOT-FIXED** — name-heal keys on `person_id`, can't merge two ids; canonical-people deferred to v2.1. → EX-015. |
| Per-board identity prompts / externals / abandonment | — | — | Unchanged (by design / correct UX). |

**Net (of the 6 defects):** **2 fully prevented going forward** (Edilson, Hudson) · **1 auto-repaired
on boot** (Jefferson) · **1 host-fixed / container-residual** (Reginaldo) · **2 not fixed** (Sanunciel,
Mariany). **Migration repairs NOTHING** — it is a verbatim `copyFileSync` (`setup/migrate-v2/taskflow.ts`)
— so **3 existing-data populations need a one-time repair:** orphaned persons (Sanunciel-class, EX-014),
the `mariany`/`mariany-borges` dup-id (EX-015), and the `…-2` duplicate board (Hudson residual).
