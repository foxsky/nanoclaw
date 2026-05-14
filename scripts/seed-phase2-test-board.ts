#!/usr/bin/env tsx
/**
 * Phase 2 end-to-end test: seed v2.db with a SINGLE target board so a
 * running container can receive Phase 1 curated WhatsApp turns.
 *
 * Defaults to board=seci-taskflow with its real v1 prod group_jid so the
 * agent sees a recognizable identity. Override the constants via
 * NANOCLAW_PHASE_REPLAY_* env vars to seed another Taskflow board for
 * Phase 2/3 validation.
 *
 * Idempotent: skips when entities already exist.
 *
 * Usage:
 *   pnpm exec tsx scripts/seed-phase2-test-board.ts
 */

import path from 'node:path';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { ensureContainerConfig } from '../src/db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
  getMessagingGroupAgentByPair,
} from '../src/db/messaging-groups.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { grantRole, getUserRoles } from '../src/modules/permissions/db/user-roles.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';

const FOLDER = process.env.NANOCLAW_PHASE_REPLAY_FOLDER ?? 'seci-taskflow';
const AGENT_GROUP_ID = process.env.NANOCLAW_PHASE_REPLAY_AGENT_GROUP_ID ?? 'ag-phase2-seci';
const MESSAGING_GROUP_ID = process.env.NANOCLAW_PHASE_REPLAY_MESSAGING_GROUP_ID ?? 'mg-phase2-seci';
const GROUP_JID = process.env.NANOCLAW_PHASE_REPLAY_GROUP_JID ?? '120363406395935726@g.us'; // SECI - TaskFlow prod
const GROUP_NAME = process.env.NANOCLAW_PHASE_REPLAY_GROUP_NAME ?? 'SECI - TaskFlow';
const TEST_USER_ID = 'whatsapp:5585999000001'; // synthetic test user
const TEST_USER_NAME = 'Phase2 Tester';

function main() {
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());
  const now = new Date().toISOString();

  // 1. Agent group
  let ag = getAgentGroupByFolder(FOLDER);
  if (!ag) {
    createAgentGroup({
      id: AGENT_GROUP_ID,
      name: 'Case',
      folder: FOLDER,
      agent_provider: 'claude',
      created_at: now,
    });
    ag = getAgentGroupByFolder(FOLDER);
    console.log(`Created agent_group ${ag!.id} (folder=${FOLDER})`);
  } else {
    console.log(`Reusing agent_group ${ag.id} (folder=${FOLDER})`);
  }
  ensureContainerConfig(ag!.id);
  console.log(`Ensured container_config for ${ag!.id}`);

  // 2. Messaging group
  let mg = getMessagingGroupByPlatform('whatsapp', GROUP_JID);
  if (!mg) {
    const mgId = MESSAGING_GROUP_ID;
    createMessagingGroup({
      id: mgId,
      channel_type: 'whatsapp',
      platform_id: GROUP_JID,
      name: GROUP_NAME,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    mg = getMessagingGroupByPlatform('whatsapp', GROUP_JID);
    console.log(`Created messaging_group ${mg!.id} (jid=${GROUP_JID})`);
  } else {
    console.log(`Reusing messaging_group ${mg.id} (jid=${GROUP_JID})`);
  }

  // 3. Wiring
  const existingMga = getMessagingGroupAgentByPair(mg!.id, ag!.id);
  if (!existingMga) {
    createMessagingGroupAgent({
      id: `mga-${AGENT_GROUP_ID}`,
      messaging_group_id: mg!.id,
      agent_group_id: ag!.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired messaging_group → agent_group via messaging_group_agents`);
  } else {
    console.log(`Wiring already exists`);
  }

  // 4. Test user + member of the agent group
  upsertUser({
    id: TEST_USER_ID,
    kind: 'human',
    display_name: TEST_USER_NAME,
    created_at: now,
  });
  console.log(`Upserted user ${TEST_USER_ID}`);

  const roles = getUserRoles(TEST_USER_ID);
  if (!roles.find((r) => r.role === 'owner')) {
    grantRole({
      user_id: TEST_USER_ID,
      role: 'owner',
      agent_group_id: null,
      granted_at: now,
      granted_by: null,
    });
    console.log(`Granted owner role to ${TEST_USER_ID}`);
  }

  addMember({
    user_id: TEST_USER_ID,
    agent_group_id: ag!.id,
    added_at: now,
    added_by: null,
  });
  console.log(`Added member ${TEST_USER_ID} → ${ag!.id}`);

  console.log(`\nSeed complete. Test board ready:`);
  console.log(`  agent_group_id: ${ag!.id}`);
  console.log(`  messaging_group_id: ${mg!.id}`);
  console.log(`  folder: ${FOLDER}`);
  console.log(`  test user: ${TEST_USER_ID} (owner role + group member)`);
}

main();
