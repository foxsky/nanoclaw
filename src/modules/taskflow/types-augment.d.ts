// TaskFlow install-overlay — fork-owned type augment (ADR 0006, contract: types.ts AUGMENT).
//
// Re-attaches the fork-only `is_main_control` field to core's `MessagingGroup`
// interface via TypeScript declaration merging, so core `src/types.ts` stays
// pristine upstream while TaskFlow consumers still type-check.
//
// This is a declaration-only file: it has no runtime footprint and emits nothing
// to `dist/`. The host tsconfig auto-includes it via `include: ["src/**/*"]`, so
// no tsconfig edit and no barrel runtime-import is required — the installer simply
// copies this file into the source tree.
//
// SECURITY: `is_main_control` is the per-chat privileged-action gate field
// (`is_main_control === 1` => operator main-control chat). The authorization
// logic itself lives in `src/modules/taskflow/permission.ts` and
// `src/db/messaging-groups.ts` (the partial unique index guaranteeing at most
// one main-control row is enforced by migration module-taskflow-main-control.ts).
// This augment only restores the field's TYPE so those gates continue to
// type-check; it changes no runtime behavior. Keep the shape verbatim
// (`is_main_control?: number;`) — widening or making it required would break the
// `Omit<MessagingGroup, 'is_main_control'>` create-input contract in
// `src/db/messaging-groups.ts` and the gate comparisons in permission.ts.
//
// W1 scope: NON-instance (this type augment) only. The `messaging_groups` table
// instance field / schema / migration handling is DEFERRED to W2 (ADR 0006).

import './types-augment-marker.js';

declare module '../../types.js' {
  interface MessagingGroup {
    /**
     * 1 = this chat is the operator's main control chat. Privileged actions
     * (e.g. send_otp, rename_board_person) require the calling session's
     * `messaging_group_id` to point at the row with value 1. At most one row
     * may have value 1 (enforced by partial unique index — see
     * src/db/migrations/module-taskflow-main-control.ts).
     *
     * Reintroduces v1 `registered_groups.isMain` semantics. Optional on the
     * TS type so pre-migration callers that build MessagingGroup literals
     * (tests, fixtures) don't need to update; the column defaults to 0.
     */
    is_main_control?: number;
  }
}
