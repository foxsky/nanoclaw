/**
 * Shared engine for the migrate-claude-md-*.mjs one-shot scripts. Each
 * caller supplies a rule marker, anchor, and rule body; this module
 * handles the per-script boilerplate (groups-dir scan, idempotency
 * check, single-anchor uniqueness guard, write, accounting).
 *
 * Optional hooks support the variations across existing scripts:
 *   - taskflowSentinel: which substring marks a TaskFlow board
 *     (default 'taskflow_update'; no-op-rule uses 'taskflow_move')
 *   - extraReplacements: best-effort additional anchor swaps that fire
 *     only when the extra anchor appears exactly once (no-op-rule)
 *   - deriveSubstitutions: per-file mustache substitution map for the
 *     rule body (cross-board-forward uses this for {{BOARD_ID}} etc.)
 */
import fs from 'fs';
import path from 'path';

export function migrateClaudeMd({
  groupsDir,
  ruleMarker,
  anchor,
  ruleBody,
  taskflowSentinel = 'taskflow_update',
  extraReplacements = [],
  deriveSubstitutions = null,
}) {
  if (!fs.existsSync(groupsDir)) {
    console.error(`Groups dir not found: ${groupsDir}`);
    process.exit(1);
  }

  let touched = 0;
  let skipped = 0;
  let warned = 0;

  for (const entry of fs.readdirSync(groupsDir)) {
    const claudeMd = path.join(groupsDir, entry, 'CLAUDE.md');
    if (!fs.existsSync(claudeMd)) continue;
    const content = fs.readFileSync(claudeMd, 'utf8');
    if (!content.includes(taskflowSentinel)) continue;
    if (content.includes(ruleMarker)) {
      skipped += 1;
      continue;
    }
    const anchorCount = content.split(anchor).length - 1;
    if (anchorCount === 0) {
      console.warn(`WARN: anchor not found in ${claudeMd} — skipping`);
      warned += 1;
      continue;
    }
    if (anchorCount > 1) {
      console.warn(
        `WARN: anchor appears ${anchorCount}x in ${claudeMd} — skipping (manual fix required)`,
      );
      warned += 1;
      continue;
    }

    let body = ruleBody;
    if (deriveSubstitutions) {
      const subs = deriveSubstitutions(entry, content);
      if (!subs) {
        console.warn(
          `WARN: substitutions could not be derived for ${claudeMd} — skipping`,
        );
        warned += 1;
        continue;
      }
      for (const [key, value] of Object.entries(subs)) {
        body = body.replaceAll(`{{${key}}}`, value);
      }
    }

    let next = content.replace(anchor, anchor + body);
    for (const { anchor: extraAnchor, replacement } of extraReplacements) {
      if (next.split(extraAnchor).length - 1 === 1) {
        next = next.replace(extraAnchor, replacement);
      }
    }

    fs.writeFileSync(claudeMd, next, 'utf8');
    console.log(`Updated: ${claudeMd}`);
    touched += 1;
  }

  console.log(
    `\nDone. Updated ${touched} files. Skipped ${skipped} already-current files. Warned ${warned} customized files.`,
  );
}
