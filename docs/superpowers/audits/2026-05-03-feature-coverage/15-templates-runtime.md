# 15 — Templates + Runtime Configuration Domain: Feature-Coverage Audit

**Date:** 2026-05-03
**Scope:** TaskFlow's *templates + runtime configuration* domain — 9 features that govern how a per-board agent gets its instructions, guardrails, and runtime context. These features sit between the host (which renders the prompt) and the engine (which enforces).
**Anchor plan:** `/root/nanoclaw/docs/superpowers/plans/2026-05-03-phase-a3-track-a-implementation.md`
**Anchor spec:** `/root/nanoclaw/docs/superpowers/specs/2026-05-02-add-taskflow-v2-native-redesign.md`
**Template (single source):** `/root/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template` — **1316 lines** (NOT 400 as scope suggests; NOT 300 as spec L335 estimates)
**Renderer:** `/root/nanoclaw/src/ipc-plugins/provision-shared.ts:314-353` (variable substitution at provision time)
**Engine support:** `/root/nanoclaw/container/agent-runner/src/taskflow-engine.ts` — `WEEKDAY_ALIASES` (:572), `WEEKDAY_NAMES_PT` (:591), `checkIntendedWeekday()` (:629), `normalizePhone()` (:744), `maskPhoneForDisplay()` (:762)
**Context-header injection:** `/root/nanoclaw/src/router.ts:78` (`<context timezone="…" today="…" weekday="…" />`)

---

## 0. Production validation (queries run 2026-05-03)

### Per-board CLAUDE.md inventory (`192.168.2.63`)

`find /home/nanoclaw/nanoclaw/groups -maxdepth 2 -name 'CLAUDE.md'` → **35 files** total, 28 of which are TaskFlow boards. Line-count distribution:

| Lines | Count | Notes |
|---:|--:|---|
| **1316** | 10 | Current template generation (`@Tars`/`@Case` v2-style) |
| 1317 | 1 | sec-secti (off-by-one — `{{CONTROL_GROUP_HINT}}` produced one extra line) |
| 1314 | 1 | Edge variant |
| 1176 | 6 | Older generation, no Welcome Check / Drive-offer-register-to-completion |
| 1134 | 10 | Older still (early scope-guard era) |
| 1131 | 3 | Older still |
| 309 / 286 / 115 / 48 | 4 | Non-TaskFlow groups (main, eurotrip, global, whatsapp_main) |
| **Skill template (host)** | **1316** | Source of truth; matches the 10 newest renders |
| **Skill template (prod copy)** | **1092** | At `/home/nanoclaw/nanoclaw/.claude/skills/add-taskflow/templates/CLAUDE.md.template` — drift +224 LOC vs deployed renders |

**4 distinct active sizes for TaskFlow board renders** (1316/1176/1134/1131) ⇒ template-version drift across boards. Boards never get re-rendered on template upgrade — each board carries the template snapshot from its provisioning date. This is load-bearing context for v2 migration: a v2 cutover that ships a new template will *not* retro-update the 28 active boards unless explicit re-render runs.

### Per-board variation (sanity check)

`diff seci-taskflow/CLAUDE.md laizys-taskflow/CLAUDE.md` → **23 line-pairs differ**, all of them substituted variables: board ID, group name, parent board, hierarchy level. The body of the prompt is identical. Per-board variation is **purely substitution**; no per-board logic forks. Confirms spec Q5 option (a): "generated at provisioning time and copied into `groups/<folder>/CLAUDE.md`".

### Scope-guard production usage (`store/messages.db`)

| keyword | hits | feature mapping |
|---|--:|---|
| `Fora do escopo` (bot reply, exact) | **2** rows / 2 boards | scope-guard refusal text |
| `não posso` (bot reply) | 1 | (broader refusals; tag-counts low because most off-topic gets routed via `taskflow_query` synonyms instead of refused) |
| `credenciais` / `não exponho` (secret-disclosure refusal) | 0 | secret-disclosure guard not exercised in production |
| `quinta` / `terça` / `terca` / `sexta` / `amanhã` / `amanha` (user input) | many (sample of last 5 returned) | weekday parsing in active use |

**Findings:**

1. **Scope guard does fire** (sample: `"Sou assistente de gerenciamento de tarefas apenas. Não posso planejar integrações técnicas ou arquitetura de sistemas."`) — but only 2 logged refusals. The expected volume is higher; either the scope-guard text varies (many phrasings the LIKE doesn't match) or off-topic queries are rare.
2. **Secret-disclosure guard never invoked** — no production attack attempts logged. Defense is dead-letter (good for security, no validation that the rule is well-formed).
3. **Weekday parsing actively used** — production sample includes "ficou pra quinta", "agendado para amanhã", "para a terça 07-04", "quinta-feira da próxima semana". All four hit the `WEEKDAY_ALIASES` table.

### Engine guardrails

- `WEEKDAY_ALIASES` (engine:572-590): pt-BR (`segunda`, `terça`, `quarta`, `quinta`, `sexta`, `sábado`, `domingo` + accent-stripped + 3-letter abbreviations) **and** English (`monday`–`sunday` + 3-letter abbreviations + `tues`/`thur`/`thurs` variants). 13 pt-BR + 7 English = 20 weekday aliases.
- `checkIntendedWeekday()` (engine:629): when the agent passes `intended_weekday` and the resolved `scheduled_at`/`due_date` lands on a different day, returns `weekday_mismatch` with both Portuguese names. Caller must re-ask the user — see template L1188.
- `normalizePhone()` (engine:744): canonicalizes Brazilian phones to 12/13-digit `55…` form; strips non-digits; preserves invariant `normalize(normalize(p)) == normalize(p)`. Mirrored on host at `src/phone.ts:25` with parity-tested by `taskflow-engine.test.ts:7200`.
- `maskPhoneForDisplay()` (engine:762): renders last-4 prefixed with `•••` for `find_person_in_organization` rows.
- `<context timezone today weekday />` header (router.ts:78): every inbound user batch gets a fresh single-line header. Tested in `formatting.test.ts:187,194`.

---

## 1. Coverage tables (per feature)

### F-15.1 — v2 CLAUDE.md template (~400 lines) with MCP tool routing

| Layer | Status | Evidence |
|---|---|---|
| **Spec** | PARTIAL | Spec L325-336 sketches updates ("Reference TaskFlow MCP tools by name", "Drop instructions about /aprovar", "Add timezone declaration"). L335 estimates "~300 lines (down from v1's ~400)". Estimate is wrong — current template is 1316 lines, not 400. |
| **Plan** | THIN | A.3.2 step 2.3.i says only "CLAUDE.md.template ports — manual review: per-board prompt renders correctly. Keep `/aprovar` `/rejeitar` text protocols." No size target, no diff scope, no acceptance criteria for which sections survive. |
| **v1 implementation** | PRESENT | `templates/CLAUDE.md.template` 1316 LOC; renderer at `provision-shared.ts:314-353`; 22 substitution variables. |
| **v2 implementation** | UNTOUCHED | No v2 branch yet. Plan defers all template work to A.3.2 step 2.3.i. |
| **Production** | DRIFT | 4 active size cohorts (1316/1176/1134/1131) — no retro-render mechanism. Prod skill copy at `.63` is 1092 LOC (224 lines stale). |
| **Tests** | LIGHT | `tests/taskflow.test.ts` exercises rendering shape but not full per-board parity. |

**GAP G-15.1.1 (HIGH):** Spec quotes "~400 lines" and "~300 lines after redesign" — both wrong by ~3-4×. Plan inherits the wrong estimate, so A.3.2 step 2.3.i has no realistic effort scope. **Fix:** correct spec L48 (was "~400 lines, board-specific instructions") and L335 (was "Estimated template size: ~300 lines") to match reality (1316 lines today; reduction targets must be set against that baseline).

**GAP G-15.1.2 (HIGH):** No template re-render strategy on v2 cutover. 28 boards on 4 different snapshots will land on v2 with their existing CLAUDE.md.md files unless the cutover script explicitly re-renders. **Fix:** add to A.3.6 (migration dry-run) an invariant: every board's CLAUDE.md re-rendered from the v2 template at cutover; verify diff is purely substitution.

**GAP G-15.1.3 (MEDIUM):** Plan's A.3.2 step 2.3.i — *per-board variation generation* — gives only "manual review: per-board prompt renders correctly". The current per-board variation works (23 line-pairs differ purely as variable substitutions), but the v2 redesign changes which variables matter (`HIERARCHY_LEVEL`/`MAX_DEPTH` get rephrased into v2's `agent_destinations` ACL-name terminology; `BOARD_ID` may swap to `agent_group_id`). Plan does not enumerate which substitutions change, so the porter has no checklist.

**Spec/plan discrepancy on the *strategy* itself.** Spec Q5 (L355) says: "v2's `init-first-agent` skill uses (a). Likely the right pattern for us." — i.e., generate at provisioning time, copy into `groups/<folder>/CLAUDE.md`. Plan A.3.2 step 2.3.i does NOT confirm this strategy and does NOT name `init-first-agent` as the reference. Without explicit selection in the plan, A.3.2 step 2.3.i could be implemented via runtime preamble injection instead (option b), which would change how every variable site behaves.

---

### F-15.2 — v1 CLAUDE.md template preserved for rollback

| Layer | Status | Evidence |
|---|---|---|
| **Spec** | NOT MENTIONED | Spec does not describe a rollback template at all. |
| **Plan** | NOT MENTIONED | Plan does not provide for v1 template preservation. |
| **v1 implementation** | **MISSING** | Scope says template path `CLAUDE.md.template.v1`; **the file does not exist** anywhere in the repo (`find /root/nanoclaw -name 'CLAUDE.md.template*'` returns 3 files, none with `.v1` suffix). |
| **v2 implementation** | N/A | |
| **Production** | N/A | (preservation strategy is git-tag based, not file based, on this repo) |
| **Tests** | NONE | |

**GAP G-15.2.1 (LOW, but listed as scope):** The scope description references `CLAUDE.md.template.v1` as if it exists. It doesn't. If rollback is desired, the actual mechanism today is "check out the pre-v2 commit". **Recommendation:** drop this from the feature inventory or convert it into an explicit deliverable (snapshot `CLAUDE.md.template.v1` in `add-taskflow/templates/` at the moment of v2 cutover; renderer reads `.v1` when env var `TASKFLOW_USE_V1_TEMPLATE=1`).

---

### F-15.3 — Scope guard for off-topic queries (refuse without DB query)

| Layer | Status | Evidence |
|---|---|---|
| **Spec** | NOT MENTIONED | Spec does not call out scope-guard preservation. |
| **Plan** | NOT MENTIONED | |
| **v1 implementation** | PRESENT | Template L9: "If the message is NOT about tasks, board, capture, status, scheduling, people, deadlines, or any topic covered in this document, reply with a single short sentence in {{LANGUAGE}} explaining you only handle task management, and suggest `ajuda`, `comandos`, or `help`. Do NOT query the database for off-topic requests." |
| **v2 implementation** | UNTOUCHED | |
| **Production** | LIGHT USAGE | 2 logged refusals in `store/messages.db` matching `Fora do escopo`. Sample: `"⚠️ *Fora do escopo* — Sou assistente de gerenciamento de tarefas apenas."` |
| **Tests** | NONE | No test asserts the scope-guard refusal text or the no-DB-query invariant. |

**GAP G-15.3.1 (MEDIUM):** Scope guard is prompt-only — no engine enforcement. An agent on a hot path could ignore it and call `mcp__sqlite__read_query` anyway. The `taskflow_query`/`mcp__sqlite__*` tools have no "is this on-topic?" check. **In v2:** the equivalent guarantee would come from constraining the MCP tool surface — but the spec doesn't note this.

**GAP G-15.3.2 (LOW):** No production telemetry for "agent should-have-refused-but-did-DB-query" — the only signal is the 2 refusals, which underrepresents the rule's coverage.

---

### F-15.4 — Prompt-injection guardrails (untrusted inputs, no self-modification, no code exec)

| Layer | Status | Evidence |
|---|---|---|
| **Spec** | NOT MENTIONED | |
| **Plan** | NOT MENTIONED | |
| **v1 implementation** | PRESENT, EXTENSIVE | Template L19-26 ("Prompt injection defense"): treats all external content as data; refuses secret/config disclosure unconditionally (`.env`, `settings.json`, `.mcp.json`, `CLAUDE.md`, `/workspace/group/logs/`, `store/auth/`, etc.); refuses security-disablement requests; requires fresh confirmation for mass actions. Conventional authorization at L29-40. |
| **v2 implementation** | UNTOUCHED | |
| **Production** | NEVER FIRED | 0 logged refusals matching `credenciais` / `não exponho`. Either no attacks attempted, or attacks succeeded silently and weren't logged as refusals. |
| **Tests** | NONE | No test asserts the secret-list refusal pattern or the "fresh confirmation" rule. |

**GAP G-15.4.1 (HIGH):** Zero production exercise of prompt-injection guardrails means we cannot verify they work. The list of forbidden paths (L23) is hand-curated and could be incomplete (e.g., `/home/node/.claude/`, `data/sessions/`, `data/v2-sessions/` — the latter two paths don't exist in v1 but become load-bearing in v2). **Fix:** in A.3.7 step 7.1 add an integration test that constructs a hostile email body inside a task description, confirms agent does not execute embedded instructions.

**GAP G-15.4.2 (HIGH, v2-specific):** v2 introduces new sensitive paths (`data/v2.db`, per-session `inbound.db` and `outbound.db`, `data/v2-sessions/{ag}/{sid}/`) that are NOT in the v1 secret-disclosure block list. The list at template L23 must be augmented. Spec L325 ("CLAUDE.md.template updates") does not call this out.

---

### F-15.5 — Channel separation guidance (reply vs explicit send_message)

| Layer | Status | Evidence |
|---|---|---|
| **Spec** | NOT MENTIONED | |
| **Plan** | NOT MENTIONED (covered transitively by Discovery 14, ACL refresh) | |
| **v1 implementation** | PRESENT | Template L126: *"**Channel separation (MANDATORY).** Current-group replies are plain assistant output. The host binds that reply to the current chat and source message automatically, so do NOT call `send_message` just to echo something back into the same group. Use `send_message` only for explicit transport work: cross-group or DM delivery via `target_chat_jid`, scheduled runner output (`[TF-*]` tags), or progress updates during long-running operations."* Reinforced at L834, L948, L977-987, L1262-1266. |
| **v2 implementation** | UNTOUCHED | But terminology must change — v2 uses `destinations` named-ACL, not raw `target_chat_jid` (spec L237: `send_message(to: 'audit-board', text: …)`). |
| **Production** | WORKING | Cross-board sends and `[TF-*]` runs deliver via `send_message`; current-group replies are plain text (per visual sample of bot replies starting `Case: …`). |
| **Tests** | NONE specific to channel separation | |

**GAP G-15.5.1 (HIGH, v2-specific):** Template uses `target_chat_jid` (raw JID-passing) 11 times. v2 spec L237 says cross-board uses `send_message(to: 'audit-board', text: …)` — **named-ACL routing via `destinations`**, no JID. Template port (A.3.2 step 2.3.i) must rewrite all 11 sites or v2 agents will pass invalid arguments. Plan does not enumerate this.

**GAP G-15.5.2 (LOW):** "Same-group duplicate reply" rule (L834, L977) cited 6 times in different sections — accidental redundancy; the same constraint stated 6 different ways. Could be consolidated.

---

### F-15.6 — Authorization matrix (descriptive, engine enforces)

| Layer | Status | Evidence |
|---|---|---|
| **Spec** | PRESENT | Spec L84 implies the rule: `user_roles(role='admin', agent_group_id=X)` per memory `project_v2_user_roles_invariant.md`. Spec L23 ("Cross-board approval flow") relies on `pending_questions` lookup; no mention of the descriptive matrix that template ships. |
| **Plan** | PARTIAL | A.3.2 step 2.3.e (`seed-board-admins.ts`) seeds `user_roles` correctly; A.3.6 invariants verify. But the descriptive matrix (template L100-114) is not flagged as a port deliverable — the v1 wording references `board_admins` (table doesn't exist in v2). |
| **v1 implementation** | PRESENT | Template L100-114: 4-row matrix (Everyone / Assignee / Subtask assignee / Delegate / Manager) with engine-enforces note. L102: "**Enforcement:** NEVER pre-filter or refuse based on the matrix above." Engine `admin()` dispatcher at engine:7365 enforces via `board_admins` lookup. |
| **v2 implementation** | UNTOUCHED but BREAKING | `board_admins` table does not exist in v2; `is_primary_manager` / `is_delegate` move to `taskflow_board_admin_meta` per plan A.3.2 step 2.3.e. Template wording at L102, L1009 ("`board_admins`: ...") must be rewritten. |
| **Production** | NORMATIVE | 29 `board_admins` rows with `admin_role='manager'`; 1 with `admin_role='delegate'` (per sibling audit `10-admin-actions.md`). Engine returns permission errors when sender role doesn't match. |
| **Tests** | LIGHT | `taskflow.test.ts` exercises engine permission errors but not the descriptive matrix wording. |

**GAP G-15.6.1 (HIGH, v2-specific):** Template references `board_admins` 4 times (L100, L1009, plus 2 elsewhere); v2 has no such table. Port must rewrite to v2's `user_roles` + `taskflow_board_admin_meta`. Plan does not enumerate.

**GAP G-15.6.2 (LOW):** "Subtask assignee" row in matrix (template L108) is not enforced anywhere in `taskflow_engine.ts` — it's a documentation row only. Either remove it or wire engine enforcement.

---

### F-15.7 — Date parsing context enrichment (today, weekday, timezone)

| Layer | Status | Evidence |
|---|---|---|
| **Spec** | LIGHT | Spec L227 mentions board TZ (`America/Fortaleza`); spec L333 says template should add `<context timezone="…" />`. No mention of `today=` / `weekday=`. |
| **Plan** | NOT MENTIONED | |
| **v1 implementation** | PRESENT | `router.ts:78` injects `<context timezone="…" today="YYYY-MM-DD" weekday="…" />` into every formatted-message batch. Template L1186 declares this contract: *"Every user message carries a `<context timezone="…" today="YYYY-MM-DD" weekday="…" />` header. Use today and weekday as the ground truth when resolving relative dates."* Tests at `formatting.test.ts:187,194` assert header shape. |
| **v2 implementation** | NEEDS PORT | v2's `<context>` header injection lives elsewhere; port must verify the agent SDK still receives the same shape. |
| **Production** | WORKING | Production weekday queries ("ficou pra quinta", "amanhã", "terça 07-04", "quinta-feira da próxima semana") resolve to correct dates per sampled output. |
| **Tests** | PRESENT | `formatting.test.ts:187,194` exercises both formatters (en-US + America/Fortaleza). |

**GAP G-15.7.1 (MEDIUM, v2-specific):** Spec L333 describes only `timezone=` attribute. The actual header carries `timezone today weekday` (3 attributes). v2 port must reproduce all 3 — `today` and `weekday` are load-bearing for relative-date resolution (template L1186). Port (A.3.2 step 2.3.i) needs to pull `router.ts:78` logic into v2 equivalent and verify the agent prompt sees the same 3 attributes.

**GAP G-15.7.2 (LOW):** `<context>` header generation lives on the host (`src/router.ts`), not in the skill or engine. v2's modularity rule (skills-only) means we cannot just port `src/router.ts`. Per plan A.3.2 step 2.3.a, IPC plugins → MCP tools, but the `<context>` injection is *pre-prompt enrichment*, not an MCP tool. Plan does not name where this responsibility lands in v2.

---

### F-15.8 — Phone canonicalization at display + processing boundaries

| Layer | Status | Evidence |
|---|---|---|
| **Spec** | NOT MENTIONED | |
| **Plan** | NOT MENTIONED | |
| **v1 implementation** | PRESENT, RIGOROUS | `normalizePhone()` lives in TWO places (host `src/phone.ts:25` + engine `taskflow-engine.ts:744`) with parity-tested invariants (`taskflow-engine.test.ts:7200`). Idempotent (`normalize(normalize(p)) == normalize(p)`). Brazilian-aware (12/13-digit `55…` form). `maskPhoneForDisplay()` at engine:762 hides last-4 with `•••` prefix. Memory `feedback_canonicalize_at_write.md` codifies the invariant. |
| **v2 implementation** | NEEDS PORT | Both `normalizePhone()` copies must move into v2 — engine port via A.3.2 step 2.3.a, host port unclear (no plan task; might need to live in `whatsapp-fixes-v2` skill since v2 host doesn't ship phone canonicalization). |
| **Production** | WORKING | All `board_people.phone` rows show 12/13-digit `55…` form (sampled). External invite delivery (`add_external_participant`) routes via canonical phone. |
| **Tests** | EXTENSIVE | Host: `phone.test.ts`. Engine: parity tests at `taskflow-engine.test.ts:7200-7220`. |

**GAP G-15.8.1 (HIGH, v2-specific):** Plan does not specify where v2's host-side `normalizePhone` lives. v2 trunk has no equivalent. Two options:
  - (a) live on `skill/whatsapp-fixes-v2` (logical home — phone is whatsapp-domain).
  - (b) live on `skill/taskflow-v2` and engine-only (host has no phone-handling needs in v2's design).
  Plan A.3.1 (`whatsapp-fixes-v2`) ports 3 methods (`createGroup`, `lookupPhoneJid`, `resolvePhoneJid`) but does not list `normalizePhone`. **Fix:** add `normalizePhone` + parity test to the A.3.1 step list.

**GAP G-15.8.2 (LOW):** `maskPhoneForDisplay` is engine-only (1 call site); port is straightforward but plan does not enumerate the sibling export.

---

### F-15.9 — Weekday name support (pt-BR + English, accented + unaccented)

| Layer | Status | Evidence |
|---|---|---|
| **Spec** | NOT MENTIONED | |
| **Plan** | NOT MENTIONED | |
| **v1 implementation** | PRESENT, COMPREHENSIVE | `WEEKDAY_ALIASES` (engine:572-590) — 13 pt-BR aliases (with and without accents/abbreviations: `terça`/`terca`/`ter`, `sábado`/`sabado`/`sab`) + 7 English aliases (`monday`–`sunday` + `mon`/`tue`/`tues`/`wed`/`thu`/`thur`/`thurs`/`fri`/`sat`/`sun`). Total 20 aliases mapped to 7 day-of-week values. `WEEKDAY_NAMES_PT` (:591) maps integers → display strings. `checkIntendedWeekday()` (:629) returns `weekday_mismatch` when the resolved date doesn't match the agent's claim. Template L1188 contracts the agent to pass `intended_weekday`. |
| **v2 implementation** | NEEDS PORT | All-engine code; port via A.3.2 step 2.3.a. |
| **Production** | WORKING | Sampled user inputs include "ficou pra quinta", "amanhã", "terça 07-04", "quinta-feira da próxima semana" — each resolves to the correct date in `America/Fortaleza`. |
| **Tests** | PRESENT (engine) | `taskflow-engine.test.ts` exercises weekday-mismatch path. |

**GAP G-15.9.1 (LOW):** Template L1188 declares `intended_weekday` is REQUIRED when the user mentions a weekday, but the engine treats it as optional (engine:644 `if (intendedDow == null) return null;` — silently skips). If the agent forgets to pass `intended_weekday`, the mismatch check is a no-op. Soft contract; could be tightened by making the engine return `weekday_inference_required` when it can detect a weekday in the user message but didn't get the field.

**GAP G-15.9.2 (LOW):** `WEEKDAY_NAMES_PT` (engine:591) is the only display map — no en-US display map exists. Boards configured with `LANGUAGE=en-US` would still see `weekday_mismatch` errors in pt-BR. Template L1180 says "en-US -> MM/DD" but boards use pt-BR exclusively in production (28/28).

---

## 2. Cross-feature observations

### Drift fingerprint

The 4 active size cohorts (1316/1176/1134/1131) imply at least 4 template revisions deployed across 28 boards without a re-render mechanism. Boards on 1131-line templates are missing 185 lines of newer guidance — including (per quick diff) the prompt-injection block, the Drive-offer-register-to-completion rule, the weekday-mismatch contract, and several sub-task / disambiguation patches. This is silent capability skew across production boards.

### v2 alignment

7 of 9 features in this domain are **prompt-only** with no spec/plan acknowledgment that they need explicit v2 ports. Only F-15.7 (`<context>` header) and F-15.6 (authorization matrix) are mentioned in the spec, and only obliquely. The v2 port could ship without these features and the agents would feel different in production (off-topic queries leak DB calls; weekday parsing breaks; cross-board sends fail because `target_chat_jid` ≠ v2's named-ACL routing).

### Relationship to plan A.3.2 step 2.3.i

The plan's only entry for this domain is one line: *"CLAUDE.md.template ports — manual review: per-board prompt renders correctly. Keep `/aprovar` `/rejeitar` text protocols."* Given the 9 features described above — including the v2-breaking issues in F-15.5 (`target_chat_jid` → `destinations`), F-15.6 (`board_admins` → `user_roles`), F-15.7 (`<context>` reproduction), F-15.4 (new sensitive-path block list) — this is critically under-specified. **Recommendation:** expand A.3.2 step 2.3.i into 4 sub-tasks:

1. **Mechanical port** — substitution-variable parity (22 vars retained, value semantics adapted to v2 IDs).
2. **MCP-tool routing rewrite** — replace `target_chat_jid` (11 sites) with v2's `send_message(to: 'destination-name')`; replace `board_admins` (4 sites) with `user_roles + taskflow_board_admin_meta`.
3. **Sensitive-path block-list refresh** (F-15.4 G-15.4.2) — augment template L23 with v2-specific paths.
4. **Per-board variation generation** — explicitly select option (a) (provision-time generation) per spec Q5; document the variable-substitution map; test that `seci-taskflow` and `laizys-taskflow` v2 renders differ only in substitution variables.

---

## 3. Status counts

| Status | Count | Features |
|---|--:|---|
| **GREEN** (covered, no v2 gap) | 0 | none — every feature has at least a v2-port concern |
| **YELLOW** (works in v1; v2 port is straightforward but unspec'd) | 4 | F-15.3 (scope guard), F-15.7 (`<context>` enrichment), F-15.8 (phone canon), F-15.9 (weekday support) |
| **RED** (v2-breaking changes required, plan/spec under-specified) | 4 | F-15.1 (template), F-15.4 (prompt-injection), F-15.5 (channel separation), F-15.6 (auth matrix) |
| **GREY** (scope item that doesn't exist) | 1 | F-15.2 (v1 template preserved for rollback — file does not exist) |

**Net:** 0 GREEN / 4 YELLOW / 4 RED / 1 GREY. Domain is the most v2-blind area of the audit so far — half its features are RED and zero are GREEN.

---

## 4. GAP register (consolidated)

| ID | Severity | Feature | Summary |
|---|---|---|---|
| **G-15.1.1** | HIGH | template | Spec wrong on size (~400 → 1316 actual; redesign target ~300 unrealistic) |
| **G-15.1.2** | HIGH | template | No retro-render mechanism; 28 boards on 4 cohorts will land on v2 with stale renders |
| **G-15.1.3** | MED | template | Plan's per-board variation generation under-specified (option a vs b not chosen explicitly) |
| **G-15.2.1** | LOW | rollback | Scope references nonexistent `CLAUDE.md.template.v1` |
| **G-15.3.1** | MED | scope guard | No engine enforcement; pure prompt rule |
| **G-15.3.2** | LOW | scope guard | No production telemetry for "should-have-refused" |
| **G-15.4.1** | HIGH | prompt injection | Zero production exercise; cannot verify guardrails fire |
| **G-15.4.2** | HIGH | prompt injection | v2 introduces new sensitive paths (`data/v2.db`, `data/v2-sessions/`) not in v1 block list |
| **G-15.5.1** | HIGH | channel sep | Template uses `target_chat_jid` 11 times; v2 uses `send_message(to:'…')` named-ACL — port required |
| **G-15.5.2** | LOW | channel sep | "Same-group duplicate" rule restated 6× — consolidate |
| **G-15.6.1** | HIGH | auth matrix | Template references `board_admins` 4×; v2 has no such table; port to `user_roles` + `taskflow_board_admin_meta` |
| **G-15.6.2** | LOW | auth matrix | "Subtask assignee" row in matrix is doc-only; engine doesn't enforce |
| **G-15.7.1** | MED | date context | Spec L333 mentions only `timezone=`; actual header has 3 attrs; port must reproduce all 3 |
| **G-15.7.2** | LOW | date context | `<context>` header injection lives on host; v2 module ownership unclear |
| **G-15.8.1** | HIGH | phone canon | Plan A.3.1 ports 3 whatsapp-fixes methods but not `normalizePhone`; host-side ownership unclear |
| **G-15.8.2** | LOW | phone canon | `maskPhoneForDisplay` not enumerated in port list |
| **G-15.9.1** | LOW | weekday | `intended_weekday` is engine-optional; agent forgetfulness silently skips mismatch check |
| **G-15.9.2** | LOW | weekday | No en-US display name map (production-tolerable: 28/28 prod boards on pt-BR) |

**Total GAPs:** 18 (5 HIGH, 4 MEDIUM, 9 LOW). HIGH gaps cluster on the v2 port surface (G-15.1.x, G-15.4.x, G-15.5.1, G-15.6.1, G-15.8.1) — all of which surface only because the plan's A.3.2 step 2.3.i is one line long.

---

## 5. Recommended plan amendments

1. **A.3.2 step 2.3.i** expand to 4 sub-tasks (per §2 above); set acceptance criteria with byte-level diff scope (which sections preserved verbatim, which rewritten).
2. **A.3.6 (migration dry-run)** add invariant: every board's CLAUDE.md re-rendered at cutover; verify diff is purely substitution.
3. **A.3.7 step 7.1** add integration test: hostile content embedded in task description must not cause secret-disclosure or self-modification.
4. **Spec L48 + L335** correct line-count estimates (1316 today; redesign target should be set against this baseline, not the imagined 400/300).
5. **Spec Q5** mark resolved (option a, generation at provisioning time, per `init-first-agent` precedent).
6. **A.3.1 step list** explicitly include `normalizePhone` (host parity) and `maskPhoneForDisplay` (engine-only) per G-15.8.x.
