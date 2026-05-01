# Migrate-v2.sh fork-private patches

These patches MUST be applied to a fresh clone of `upstream/migrate/v1-to-v2`
before running `migrate-v2.sh` against our v1 production data. They are NOT
upstreamed — our fleet has properties that the upstream seeder does not
account for.

## Apply

```bash
cd /root/nanoclaw-migrate-v2  # or wherever the migrate-branch worktree lives
for p in /root/nanoclaw/scripts/migrate-v2-patches/*.patch; do
  echo "Applying $p"
  git apply "$p"
done
```

## Patches

### `01-engage-pattern-priority-fix.patch`

**Bug:** upstream `seed-v2.ts:375-388` prefers `trigger_pattern` over
`requires_trigger=0` when both are set on a v1 `registered_groups` row. For
our 28 TaskFlow boards, this maps `engage_pattern='@Case'` (only respond
when `@Case` is in the message). But empirically, **ZERO user messages
across the fleet contain `@Case`** — the bot has been running with
`requires_trigger=0` (host gate bypassed at `src/index.ts:575`), responding
to every message regardless of trigger.

Without this patch, fleet cutover to v2 would silently drop 100% of
incoming user messages.

**Fix:** swap the priority — `requires_trigger=0` ALWAYS wins over
`trigger_pattern`, mapping to `engage_pattern='.'` (match-all sentinel).

**Validation:** Phase 0 spike (2026-05-01): re-ran `migrate-v2.sh` against
`/root/prod-snapshot-20260430` after applying. v2.db now has all 29
messaging_group_agents with `engage_mode='pattern'` + `engage_pattern='.'`.

**Should we upstream this?** Probably not — the upstream seeder likely
matches the upstream-author's typical use case. Our fleet's pattern
(`requires_trigger=0` + non-empty trigger_pattern) may be unusual. If we
file a bug, frame it as "priority order ambiguous when both fields are
set in the source row" — let upstream decide their own resolution.

### `02-pt-br-sender-approval.patch`

**Concern:** v2's `src/modules/permissions/sender-approval.ts` hardcodes
the unknown-sender approval card text in English ("Allow" / "Deny" /
"X wants to talk to your agent in Y. Allow?"). Our 28 government IT
TaskFlow boards run in Brazilian Portuguese; English admin prompts are
out of place.

**Fix:** patch the four user-facing strings in `sender-approval.ts`:
- `'Allow'` → `'Permitir'`, `'✅ Allowed'` → `'✅ Permitido'`
- `'Deny'` → `'Negar'`, `'❌ Denied'` → `'❌ Negado'`
- title `'👤 New sender'` → `'👤 Novo remetente'`
- question `${senderDisplay} wants to talk to your agent in ${originName}. Allow?`
  → `${senderDisplay} quer falar com seu agente em ${originName}. Permitir?`
- Default origin name `'an unfamiliar chat'` → `'um quadro desconhecido'`

**Should we upstream this?** No — this is a fleet-specific localization.
Upstream serves an English-default audience. If they ever ship i18n
support for these strings, we can drop this patch. Until then, fork-private.
