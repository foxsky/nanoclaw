# Composed CLAUDE.md for `add-taskflow` — Design Spec (Stub)

> **Status:** Stub. Open for brainstorming. Phase fit revised after Codex review (see "Phase fit" below): TaskFlow-side decomposition can land **before v2 migration** as a v1 deploy-time renderer; v2's runtime composition is a different (narrower) primitive that we layer on top later.
>
> **Predecessor:** v1 stepping stone is the 2026-05-07 PR routine `trig_012bnQzpo2QpgMr7v5kSSDi1` (`ruleBodyFromTemplate({ marker, anchor })` helper consolidating the 4 sister `migrate-claude-md-*.mjs` scripts).
>
> **Author:** Claude (initial draft, 2026-04-30; Codex-corrected, same day). To be refined with user via brainstorming skill before plan-write.

---

## Problem

`add-taskflow` provisions 31 production TaskFlow boards. Each board's `groups/<board>/CLAUDE.md` is ~700 lines, ~90% identical across boards. The remaining ~10% is per-board variables (board ID, group name, hierarchy level, parent reference, board-specific rules).

Today this is maintained as **dual-source duplication**:

1. `template/CLAUDE.md.template` in the skill — the canonical generator template
2. `groups/<board>/CLAUDE.md` — generated copies, but also **mutated in place** by the 4 sister migration scripts (`migrate-claude-md-{cross-board-forward,no-op-rule,multi-action,weekday-contradiction}.mjs`) when new rules ship to existing boards

Each migration script duplicates a `RULE_BODY` string that **also** lives in the template. Two consequences:

- Every new TaskFlow rule = template edit + new migration script + risk of drift between them (caught the v1→v2 cross-board-forward upgrade on 2026-04-30 — the standard migration's idempotency check blocked re-running for prod-only boards, requiring a one-shot `upgrade-cross-board-forward-v1-to-v2.mjs`)
- 31 board CLAUDE.md files diverge silently as scripts run partial sweeps

V2 ships a **composed CLAUDE.md** model, but the actual primitive is narrower than the CHANGELOG suggests — Codex review confirmed:

- **Composition site:** v2 regenerates `groups/<folder>/CLAUDE.md` on every **container spawn** via `src/claude-md-compose.ts:37-124` called from `src/container-runner.ts:259-261`. NOT every session wake; NOT a runtime template engine in the agent's prompt path.
- **Composition mechanism:** the output is an **import file** using `@./.claude-shared.md` and `@./.claude-fragments/...` directives, not literal concatenation. Claude Code's loader resolves the imports at session start.
- **Fragment sources:** (a) `container/skills/*/instructions.md`, (b) built-in MCP `*.instructions.md`, (c) inline `container.json` MCP instructions. **No** manifest, **no** role-based fragment selection logic, **no** variable substitution engine.

**Implication:** TaskFlow's manifest-driven, role-keyed, variable-templated composition is **fork-private tooling layered on top of v2's import compositor**, not a use of v2's native primitive. We benefit from v2's regenerate-on-spawn + import resolution; everything else is ours to build.

## Goal

Refactor `add-taskflow` so:

1. The shared body (cross-board forward rule, no-op rule, multi-action rule, weekday-contradiction rule, holiday rule, future rules) lives **once** in the skill, not duplicated across N migration scripts
2. New rules ship via a single template edit + a single board re-composition pass — no per-rule migration script
3. Per-board variables (board ID, group name, parent JID, hierarchy level, board-specific overrides) compose at deploy time
4. Drift between template and deployed boards is impossible (deployed boards regenerate from template + fragments + per-board vars; no in-place mutation)

## Non-goals

- Changing the **content** of any current TaskFlow rule. This is a refactor of how rules ship, not a rewrite of behavior.
- Replacing `provision-shared.ts` board provisioning. The provisioner still creates the board row + initial CLAUDE.md; composition just becomes the rendering step.
- Composing CLAUDE.md at every container wake (v2 supports this; we'd opt in only if it helps with hot-rule-updates).

## Architecture sketch

### Skill structure (proposed)

```
.claude/skills/add-taskflow/
  templates/
    base.md                          # Shared body — 90% of current template
    fragments/
      cross-board-forward.md         # The rule body, sole source of truth
      no-op-prevention.md
      multi-action-engine.md
      weekday-contradiction.md
      holiday-handling.md
      meeting-creation.md
      cross-board-subtask-mode.md
      auditor-rules.md
    per-board.md.template            # Per-board header (variables)
    fragment-manifest.json           # Which fragments apply to which board roles
  scripts/
    compose-claude-md.mjs            # New — replaces generate + 4 migration scripts
  manifest.yaml                      # Add claude_md_composition field
```

### Composition rule (v1 phase, pre-v2)

```
groups/<board>/CLAUDE.md =
  per-board.md.template (with variables substituted by our renderer)
+ base.md
+ each fragments/<name>.md WHERE fragment-manifest.json["<board-role>"].includes("<name>")
+ optional groups/<board>/CLAUDE.md.local-overrides (operator escape hatch)
```

The renderer is `scripts/compose-claude-md.mjs` (fork-private). Output is a flat file that drops in alongside today's `groups/<board>/CLAUDE.md`. No runtime change in v1.

### Composition rule (v2 phase, post-cutover)

After v2 cutover, two options for layering on top of v2's import compositor:

1. **Stay flat (simplest).** Our renderer keeps producing flat output; v2's `claude-md-compose.ts` writes the file at spawn but our content has already been resolved. We pay no cost from v2's import resolution (idempotent on a flat file). Benefit: no behavior change.
2. **Adopt imports.** Our renderer emits `@./.claude-fragments/<name>.md` lines instead of inlining. v2's loader resolves at session start. Benefit: bytewise smaller `groups/<board>/CLAUDE.md`; debuggable per-fragment via filesystem. Cost: per-fragment file proliferation; harder to inspect by `cat`.

Decision deferred until v2 cutover. Either way, our manifest + variable substitution + role selection logic stays fork-private; v2 doesn't natively support them.

`fragment-manifest.json` keys fragments by board role (`leaf`, `intermediate`, `root`, `manager`, `cross-board-shared`). New rules land as new fragment files and a manifest entry. No script per rule.

### Migration from current state

One-shot `scripts/decompose-existing-claude-md.mjs`:
- Read each of the 31 production CLAUDE.md files
- Diff against `template/CLAUDE.md.template`
- Extract genuine per-board overrides (if any) into `<board>/CLAUDE.md.local-overrides`
- Discard the rest (it's all reproducible from template + fragments)
- Re-run `compose-claude-md.mjs` — output should match input modulo formatting

Run **before** v2 migration begins so the flat-output renderer is the single source of truth across the v1→v2 cutover. The "v2 cutover" CLAUDE.md regeneration step then becomes a no-op for content (only filesystem layout changes).

## Open questions (for brainstorming)

1. **Decompose now (v1) or wait for v2?** The 2026-05-07 `ruleBodyFromTemplate` PR is a partial step. Could either be a stepping stone or be skipped if we go straight to full composition. Tradeoff: v1 composition is "free" (no runtime change), but every week of delay = more drift to clean up.
2. **Fragment granularity.** Per-rule fragments (8 fragments today) or per-section fragments (~3 fragments: routing, mutations, audit)? Granularity affects how easy it is to A/B-test rules across boards.
3. **Variable substitution syntax.** Today: `{{BOARD_ID}}`, `{{GROUP_NAME}}`. Adopt v2's templating (if any), or keep ours?
4. **Local overrides escape hatch.** Allow `<board>/CLAUDE.md.local-overrides` for board-specific tweaks the operator wants to preserve through regeneration? Or treat all per-board content as composed-from-fragments only, no mutations allowed?
5. **Compose at deploy vs. at container wake.** v2 supports per-wake composition (changes propagate without redeploy). Worth it for TaskFlow, or unnecessary complexity?
6. **Auditor regression.** The auditor today greps the deployed CLAUDE.md for rule presence. After composition, what does it grep against — the deployed file (still a flat copy) or the manifest?

## Phase fit (revised v2.2)

- **v1 stepping stone (already scheduled):** 2026-05-07 PR `ruleBodyFromTemplate` helper (one source of truth across the 4 migration scripts; doesn't yet decompose the template itself).
- **v1 main implementation (recommended landing point — Codex's #2 priority):** Full decomposition of `add-taskflow` template into `base.md + fragments/ + manifest.json`. Renderer produces flat output, identical in shape to today's `groups/<board>/CLAUDE.md`. **Eliminates the 4 migration scripts.** Lands BEFORE v2 migration begins so v1→v2 doesn't have to chase rule drift on top of everything else. Per Codex: "the leverage is your fork-private TaskFlow decomposition, not upstream composition."
- **v2 migration Phase 6 (Weeks 16-18) — fallback if not done pre-v2:** Same decomposition work, just later. Then optionally adopt `@./.claude-fragments/...` import syntax to lean on v2's regenerate-on-spawn compositor. Decision deferred until v2 cutover.
  - **Not** a "compose at session wake" change — v2 composes at container spawn, not session wake. Codex flagged this misconception.

## Risks

- **Big-bang re-composition.** First time we run the full composer on all 31 boards, the diff against today's hand-merged content will be substantial. Need a careful diff review per board before deploy.
- **Drift in per-board overrides.** If operators have hand-edited any board's CLAUDE.md beyond the script-applied rules, decomposition will lose those edits unless captured in `local-overrides`.
- **Auditor grep brittleness.** The auditor's content checks (rule-presence, forbidden-phrase) need to be re-anchored against the manifest or against guaranteed-rendered text in the composed output.

## Out-of-scope (deferred)

- Composing per-board memory (`add-taskflow-memory`) into the composition. Memory rules block is small and stable.
- Migrating other skill templates (`add-long-term-context`, channel skills) to composition. Those are single-file templates with no migration-script class.

---

**Next steps:** Brainstorm with user to resolve open questions 1-6, then write the implementation plan via writing-plans skill.
