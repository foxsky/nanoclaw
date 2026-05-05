#!/usr/bin/env tsx
/**
 * Designate which messaging group is the operator's main control chat
 * (the v2 equivalent of v1's `registered_groups.isMain`).
 *
 * Usage:
 *   pnpm tsx scripts/set-main-control.ts                            # list candidates
 *   pnpm tsx scripts/set-main-control.ts <messaging_group_id>       # designate
 *   pnpm tsx scripts/set-main-control.ts --by-platform <ch> <pid>   # designate by (channel, platform_id)
 *
 * Privileged TaskFlow actions (send_otp, provision_root_board, etc.) all
 * gate on this flag. Until designated, those actions silently fail-closed.
 *
 * The setter atomically clears any existing main and sets the new one in
 * a single transaction — the partial unique index never sees two mains.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb, runMigrations } from '../src/db/index.js';
import {
  getMainControlMessagingGroup,
  getMessagingGroup,
  getMessagingGroupByPlatform,
  setMainControlMessagingGroup,
} from '../src/db/messaging-groups.js';
import { getDb } from '../src/db/connection.js';

function usage(): never {
  console.error('Usage:');
  console.error('  set-main-control                              # show current main + list candidates');
  console.error('  set-main-control <messaging_group_id>         # designate by id');
  console.error('  set-main-control --by-platform <ch> <pid>     # designate by (channel_type, platform_id)');
  process.exit(1);
}

async function main() {
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const args = process.argv.slice(2);

  // List current + candidates
  if (args.length === 0) {
    const current = getMainControlMessagingGroup();
    console.log('=== Current main control ===');
    if (current) {
      console.log(`  id=${current.id}  ${current.channel_type}/${current.platform_id}  name="${current.name ?? '(unnamed)'}"`);
    } else {
      console.log('  (none designated)');
    }
    console.log('\n=== Available messaging groups ===');
    const all = getDb()
      .prepare('SELECT id, channel_type, platform_id, name, is_main_control FROM messaging_groups ORDER BY created_at')
      .all() as Array<{ id: string; channel_type: string; platform_id: string; name: string | null; is_main_control: number }>;
    if (all.length === 0) {
      console.log('  (no messaging groups yet — run /setup or wire a channel first)');
      return;
    }
    for (const mg of all) {
      const flag = mg.is_main_control === 1 ? ' [MAIN]' : '';
      console.log(`  id=${mg.id}  ${mg.channel_type}/${mg.platform_id}  name="${mg.name ?? '(unnamed)'}"${flag}`);
    }
    console.log('\nDesignate one with:');
    console.log('  pnpm tsx scripts/set-main-control.ts <id>');
    return;
  }

  // --by-platform <ch> <pid>
  if (args[0] === '--by-platform') {
    if (args.length !== 3) usage();
    const channelType = args[1]!;
    const platformId = args[2]!;
    const mg = getMessagingGroupByPlatform(channelType, platformId);
    if (!mg) {
      console.error(`No messaging group for ${channelType}/${platformId}.`);
      process.exit(2);
    }
    setMainControlMessagingGroup(mg.id);
    console.log(`✅ Main control set: id=${mg.id}  ${channelType}/${platformId}  name="${mg.name ?? '(unnamed)'}"`);
    return;
  }

  // Single positional: designate by id
  if (args.length !== 1) usage();
  const id = args[0]!;
  const mg = getMessagingGroup(id);
  if (!mg) {
    console.error(`No messaging group with id="${id}". Run with no args to list candidates.`);
    process.exit(2);
  }
  setMainControlMessagingGroup(id);
  console.log(`✅ Main control set: id=${id}  ${mg.channel_type}/${mg.platform_id}  name="${mg.name ?? '(unnamed)'}"`);
}

main().catch((err) => {
  console.error('Failed:', err.message ?? err);
  process.exit(1);
});
