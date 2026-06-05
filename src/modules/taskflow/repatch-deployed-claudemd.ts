import fs from 'node:fs';
import path from 'node:path';

import { patchRelayProse } from './migrate-board-claudemd.js';

export interface RepatchReport {
  path: string;
  changed: boolean;
}

/**
 * #404 cutover runner — fix the #398 notification-relay prose in every deployed
 * board's `CLAUDE.local.md`.
 *
 * `renderBoardClaudeMd` writes the rendered board instructions to
 * `groups/<folder>/CLAUDE.local.md` only at NEW provision, so boards provisioned
 * before the #398 fix still tell the agent to relay JID/parent-routed notifications
 * the host now delivers → `parent_notification` double-send.
 *
 * SAFE BY CONSTRUCTION: applies ONLY `patchRelayProse` (exact stale-relay-sentence
 * replacements, idempotency-guarded) — NOT the full migrate-board-claudemd patcher,
 * whose blanket `taskflow_*`→`api_*` / `target_chat_jid`→`to` renames could corrupt
 * the agent's free-text memory appended to the same file (Codex xhigh 2026-06-05 —
 * the first full-patcher runner was reverted for exactly this).
 *
 * `write:false` is a dry-run (report only). Run with `write:true` as a cutover step.
 */
export function repatchDeployedClaudeMd(groupsDir: string, opts: { write: boolean }): RepatchReport[] {
  const report: RepatchReport[] = [];
  for (const ent of fs.readdirSync(groupsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const file = path.join(groupsDir, ent.name, 'CLAUDE.local.md');
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const { output, changed } = patchRelayProse(before);
    if (changed && opts.write) fs.writeFileSync(file, output);
    report.push({ path: file, changed });
  }
  return report;
}
