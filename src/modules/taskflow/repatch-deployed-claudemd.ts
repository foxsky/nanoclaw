import fs from 'node:fs';
import path from 'node:path';

import { migrateBoardClaudeMd } from './migrate-board-claudemd.js';

export interface RepatchReport {
  path: string;
  changed: boolean;
}

/**
 * #404 cutover runner — re-apply the migrate-board-claudemd patcher to every
 * deployed board's `CLAUDE.local.md`.
 *
 * `renderBoardClaudeMd` writes the rendered board instructions to
 * `groups/<folder>/CLAUDE.local.md` (provision-shared.ts:489), but only at NEW
 * provision — there is no re-render path for already-deployed boards. Boards
 * provisioned before the #398 relay-rule fix carry stale v1 relay prose ("Engine
 * notifications are delivery instructions… Relay them only when they target a
 * different chat/JID"), which now causes a `parent_notification` double-send
 * against the host's deterministic delivery. The patcher rewrites that prose in
 * place.
 *
 * Safe to run over the whole file: the patcher does TARGETED string replacements,
 * so any agent-appended memory in the same file is preserved, and it is
 * idempotent (the `!output.includes(...)` guards make a re-run a no-op on
 * already-fixed prose). With `write:false` this is a dry-run (report only) —
 * inspect the report, then re-run with `write:true` as a cutover step (#386).
 */
export function repatchDeployedClaudeMd(groupsDir: string, opts: { write: boolean }): RepatchReport[] {
  const report: RepatchReport[] = [];
  for (const ent of fs.readdirSync(groupsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const file = path.join(groupsDir, ent.name, 'CLAUDE.local.md');
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = migrateBoardClaudeMd(before).output;
    const changed = after !== before;
    if (changed && opts.write) fs.writeFileSync(file, after);
    report.push({ path: file, changed });
  }
  return report;
}
