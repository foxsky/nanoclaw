#!/usr/bin/env tsx
/**
 * Phase 2 end-to-end test: seed v2.db with a SINGLE target board so a
 * running container can receive Phase 1 curated WhatsApp turns.
 *
 * Uses board=seci-taskflow with its real v1 prod group_jid so the agent
 * sees a recognizable identity. The board is treated as a STANDALONE root
 * (no parent) for the test — cross-board queries will fail but the
 * majority of turns (move/admin/update/query for own-board tasks) work.
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
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
  getMessagingGroupAgentByPair,
} from '../src/db/messaging-groups.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { grantRole, getUserRoles } from '../src/modules/permissions/db/user-roles.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';

const FOLDER = 'seci-taskflow';
const AGENT_GROUP_ID = 'ag-phase2-seci';
const GROUP_JID = '120363406395935726@g.us'; // SECI - TaskFlow prod
const GROUP_NAME = 'SECI - TaskFlow';
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

  // 2. Messaging group
  let mg = getMessagingGroupByPlatform('whatsapp', GROUP_JID);
  if (!mg) {
    const mgId = 'mg-phase2-seci';
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
      id: 'mga-phase2-seci',
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
