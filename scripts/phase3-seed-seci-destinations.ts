#!/usr/bin/env tsx
/**
 * Idempotently seeds the dev-only Phase 3 destination rows for the SECI
 * compliance corpus. Production destination registration remains separate.
 *
 * Uses raw INSERT ... ON CONFLICT DO UPDATE because the production helpers
 * (src/db/messaging-groups.ts, src/modules/agent-to-agent/db/agent-destinations.ts)
 * are INSERT-only. Stop the nanoclaw service before running so this
 * better-sqlite3 handle doesn't race with the host's WAL writes on
 * data/v2.db. Skips the agent_destinations → running-session inbound.db
 * projection that writeDestinations() does in prod; the Phase 3 driver
 * spawns fresh sessions after the seed runs, so this is acceptable for
 * test seeding only.
 */
import Database from 'better-sqlite3';

const dbPath = process.argv[2] ?? 'data/v2.db';
const db = new Database(dbPath);

try {
  const now = new Date().toISOString();
  const insertGroup = db.prepare(`
    INSERT INTO messaging_groups
      (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
    VALUES
      (@id, @channel_type, @platform_id, @name, @is_group, @unknown_sender_policy, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      channel_type = excluded.channel_type,
      platform_id = excluded.platform_id,
      name = excluded.name,
      is_group = excluded.is_group,
      unknown_sender_policy = excluded.unknown_sender_policy
  `);
  const insertDestination = db.prepare(`
    INSERT INTO agent_destinations
      (agent_group_id, local_name, target_type, target_id, created_at)
    VALUES
      (@agent_group_id, @local_name, @target_type, @target_id, @created_at)
    ON CONFLICT(agent_group_id, local_name) DO UPDATE SET
      target_type = excluded.target_type,
      target_id = excluded.target_id
  `);

  db.transaction(() => {
    insertGroup.run({
      id: 'mg-phase3-laizys-taskflow',
      channel_type: 'whatsapp',
      platform_id: '120363425774136187@g.us',
      name: 'Laizys - TaskFlow',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    insertGroup.run({
      id: 'mg-phase3-ana-beatriz',
      channel_type: 'whatsapp',
      platform_id: '120363426975449622@g.us',
      name: 'Ana Beatriz',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    insertDestination.run({
      agent_group_id: 'ag-phase2-seci',
      local_name: 'Laizys',
      target_type: 'channel',
      target_id: 'mg-phase3-laizys-taskflow',
      created_at: now,
    });
    insertDestination.run({
      agent_group_id: 'ag-phase2-seci',
      local_name: 'Ana Beatriz',
      target_type: 'channel',
      target_id: 'mg-phase3-ana-beatriz',
      created_at: now,
    });
  })();

  console.log(`Seeded Phase 3 SECI destinations in ${dbPath}`);
} finally {
  db.close();
}
