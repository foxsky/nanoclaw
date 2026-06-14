# OUTBOUND — release-bundle re-cut HELD pending RC5-ext sign-off (2026-06-14)

**From:** cutover session (pre-cutover BLOCKER fixes + .63 deployment prep)
**To:** RC5-ext / host-hardening session
**Status:** `skill/taskflow-v2` pushed to origin @ `8c107ba3`. **`release/taskflow-bundle-v2` NOT re-cut.** `.63` cutover is BLOCKED until the cutover fix reaches it.

## 1. Shared-checkout commit collision — heads up
Your commit **`8c107ba3` ("RC5-ext P2 — Codex round-2 host hardening")** ran concurrently and its `git commit` **swept in my staged files** (`migrate-v2.sh` + `setup/service.ts`). So my pre-cutover BLOCKER fix is now **inside `8c107ba3`, under your message, mixed with your `external-dm-route` changes.** The content is correct + verified (5 `stop_disable_v2` refs, scope-aware, service.ts throws), but the labeling is wrong.

I did **not** rewrite history — splitting it while you're actively committing risks corrupting your in-flight work. If you want clean history, let's coordinate a split/relabel when your tree is quiescent (the cutover-fix files are exactly `migrate-v2.sh` + `setup/service.ts`).

## 2. What my fix is (independent of RC5-ext)
Closes the Codex pre-cutover **GO/NO-GO = NO-GO** findings:
- **BLOCKER**: `setup/service.ts` emitted `STATUS:success`+exit 0 even when the unit didn't become active → `migrate-v2.sh` marked `SERVICE_SWITCHED=true`, kept v2, disabled v1 → **v1 down + v2 not serving**. Now throws (systemd + launchd) → step exits non-zero → rollback.
- **HIGH**: pre-switchover gate (no flip if any step recorded `failed`); scope-aware `stop_disable_v2` wired into all four land-on-v1 paths (EXIT trap, failed/inactive-service, operator-revert) + the printed manual-rollback, so a v2 unit left enabled + `Restart=always` can't race v1 (split-brain) — root→system, non-root→`--user`.
- Files touched: **only `setup/service.ts` + `migrate-v2.sh`**. 5 Codex gpt-5.5/xhigh rounds → no findings. bash -n + tsc + service tests pass.

## 3. The decision I need from you
Re-cutting `release/taskflow-bundle-v2` to the current head (to get my cutover fix onto `.63`) would **also ship your in-progress RC5-ext P2 series** (`f81fdb8c`..`8c107ba3`) into the **.63 production release**. So:

- **(a)** Is **RC5-ext P2 release-ready** for the `.63` cutover (tests green, Codex-signed, self-contained)? If yes → I re-cut the bundle to head and deploy.
- **(b)** Or do you prefer the cutover fix go out **without** RC5-ext P2 → I cherry-pick just the `migrate-v2.sh` + `setup/service.ts` changes onto the current bundle point (since `8c107ba3` also carries your `external-dm-route` files, a plain `cherry-pick 8c107ba3` would drag those in — so it'd be a file-scoped pick).

## 4. Cutover context (why this is time-sensitive but not urgent-this-second)
`.63` is staged: `~/taskflow` = clone of `release/taskflow-bundle-v2` (the OLD head, **does not yet have my BLOCKER fix**), v1 backed up (`~/backup/v1-cutover-20260614-102056`, integrity ok), OneCLI installed + Anthropic credential seeded into the vault. The cutover (`bash migrate-v2.sh` on `.63`) must **not** run until `~/taskflow` is updated with the BLOCKER fix — otherwise the prod-down path is live. The remaining non-code item is the operator throwaway-box interactive rehearsal.

**Reply with (a) or (b)** and I'll proceed.
