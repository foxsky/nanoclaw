/**
 * migrate-v2 step: groups
 *
 * Copy v1 group folders into v2.
 *   - v1 CLAUDE.md → migrated v2 CLAUDE.local.md (v2 composes CLAUDE.md at spawn)
 *   - v1 container_config → .v1-container-config.json sidecar
 *   - All other files copied (no overwrite)
 *   - Also copies global/ if it exists
 *
 * Idempotent — does not overwrite files that already exist in v2.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/groups.ts <v1-path>
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { migrateBoardClaudeMd } from '../../src/modules/taskflow/migrate-board-claudemd.js';
import { personaFromTrigger, readV1AgentModel } from './shared.js';

const SKIP_NAMES = new Set(['CLAUDE.md', 'logs', '.git', '.DS_Store', 'node_modules']);
const LEGACY_PROMPT_PATTERN =
  /\btaskflow_(query|report|move|reassign|update|admin|create|dependency|hierarchy|undo)\b|mcp__sqlite__|target_chat_jid|target_group_jid|schedule_type|schedule_value/;

/**
 * Copy a directory tree, skipping SKIP_NAMES. Never overwrites existing files.
 *
 * Symlinks are skipped, not followed: v1 group folders sometimes contain
 * container-side paths like `.claude-shared.md → /app/CLAUDE.md` that
 * don't resolve on the host. Following them with `fs.copyFileSync` would
 * crash ENOENT on a broken target and abort the rest of the traversal.
 * v2 uses composed CLAUDE.md fragments anyway — these v1 symlinks have no
 * v2 meaning and don't need to be carried forward.
 */
function copyTree(src: string, dst: string): number {
  let written = 0;
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);

    if (entry.isSymbolicLink()) {
      console.log(`SKIP:symlink ${path.relative(process.cwd(), s)}`);
      continue;
    }
    if (entry.isDirectory()) {
      written += copyTree(s, d);
      continue;
    }
    if (fs.existsSync(d)) continue;
    fs.copyFileSync(s, d);
    written += 1;
  }
  return written;
}

function main(): void {
  const v1Path = process.argv[2];
  if (!v1Path) {
    console.error('Usage: tsx setup/migrate-v2/groups.ts <v1-path>');
    process.exit(1);
  }

  const v1GroupsDir = path.join(v1Path, 'groups');
  const v2GroupsDir = path.join(process.cwd(), 'groups');

  if (!fs.existsSync(v1GroupsDir)) {
    // Non-zero so run_step routes to the skipped branch, not silent "success".
    console.log('SKIPPED:no v1 groups/ directory');
    process.exit(1);
  }

  // Get all folders from v1 DB to know which groups are registered
  const v1DbPath = path.join(v1Path, 'store', 'messages.db');
  const registeredFolders = new Set<string>();
  let configsWritten = 0;
  if (fs.existsSync(v1DbPath)) {
    const v1Db = new Database(v1DbPath, { readonly: true, fileMustExist: true });
    const rows = v1Db
      .prepare('SELECT folder, container_config, trigger_pattern FROM registered_groups')
      .all() as Array<{ folder: string; container_config: string | null; trigger_pattern: string | null }>;
    const groupMeta = new Map<string, { config: string | null; trigger: string | null }>();
    for (const r of rows) {
      registeredFolders.add(r.folder);
      groupMeta.set(r.folder, { config: r.container_config, trigger: r.trigger_pattern });
    }
    v1Db.close();

    // Write container.json carrying forward, for each registered group:
    //   - v1 container_config (mounts/timeout — identical shape in v2),
    //   - F4: assistantName = persona from trigger_pattern ('@Case' → 'Case'),
    //   - F3: model = v1 per-agent ANTHROPIC_MODEL from the session settings.json.
    // backfill-container-configs.ts imports all three into container_configs at
    // first boot. v1 stored model/persona OUTSIDE container_config (settings.json
    // / trigger_pattern), and v2 ignores settings.json (settingSources:[]), so
    // without this carry a migrated board loses its model + presents under its
    // display name instead of its persona.
    for (const [folder, { config, trigger }] of groupMeta) {
      const v2Folder = path.join(v2GroupsDir, folder);
      const containerJson = path.join(v2Folder, 'container.json');

      // Base, in precedence order: an existing container.json (a prior/partial
      // migration — merge into it so a re-run still adds F3/F4 keys), else the
      // parsed v1 container_config, else {}. We only ADD missing assistantName/
      // model below, so an operator's existing value is never clobbered.
      let base: Record<string, unknown> = {};
      const existed = fs.existsSync(containerJson);
      if (existed) {
        try {
          base = JSON.parse(fs.readFileSync(containerJson, 'utf8')) as Record<string, unknown>;
        } catch {
          continue; // malformed operator file — leave it untouched
        }
      } else if (config) {
        try {
          base = JSON.parse(config) as Record<string, unknown>;
        } catch {
          // Unparseable config — preserve verbatim as a sidecar for the skill;
          // still carry the (independent) model/persona into container.json below.
          fs.mkdirSync(v2Folder, { recursive: true });
          fs.writeFileSync(path.join(v2Folder, '.v1-container-config.json'), config);
          base = {};
        }
      }

      let changed = false;
      if (base.assistantName === undefined) {
        const persona = personaFromTrigger(trigger);
        if (persona) {
          base.assistantName = persona;
          changed = true;
        }
      }
      if (base.model === undefined) {
        const model = readV1AgentModel(v1Path, folder);
        if (model) {
          base.model = model;
          changed = true;
        }
      }

      // Existing file: write only if we added something. Fresh file: write when
      // there's anything to carry (config and/or persona/model).
      const shouldWrite = existed ? changed : Object.keys(base).length > 0;
      if (!shouldWrite) continue;
      fs.mkdirSync(v2Folder, { recursive: true });
      fs.writeFileSync(containerJson, JSON.stringify(base, null, 2));
      configsWritten++;
    }
  }

  // Copy all v1 group folders (registered + global + any extras)
  let foldersCopied = 0;
  let claudesMigrated = 0;
  let filesCopied = 0;

  for (const entry of fs.readdirSync(v1GroupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = entry.name;
    const v1Folder = path.join(v1GroupsDir, folder);
    const v2Folder = path.join(v2GroupsDir, folder);

    fs.mkdirSync(v2Folder, { recursive: true });

    // CLAUDE.md → migrated CLAUDE.local.md. If a previous partial run copied
    // raw v1 instructions, replace them; otherwise preserve an existing local
    // file so reruns do not wipe operator edits.
    const v1Claude = path.join(v1Folder, 'CLAUDE.md');
    const v2Local = path.join(v2Folder, 'CLAUDE.local.md');
    if (fs.existsSync(v1Claude)) {
      const migrated = migrateBoardClaudeMd(fs.readFileSync(v1Claude, 'utf8')).output;
      const shouldWrite = !fs.existsSync(v2Local) || LEGACY_PROMPT_PATTERN.test(fs.readFileSync(v2Local, 'utf8'));
      if (shouldWrite) {
        fs.writeFileSync(v2Local, migrated);
        claudesMigrated++;
      }
    }

    // Copy everything else
    filesCopied += copyTree(v1Folder, v2Folder);
    foldersCopied++;
  }

  console.log(`OK:folders=${foldersCopied},claudes=${claudesMigrated},files=${filesCopied},configs=${configsWritten}`);
}

main();
