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
  const findGroupByPlatform = db.prepare(`
    SELECT id FROM messaging_groups WHERE channel_type = @channel_type AND platform_id = @platform_id
  `);

  function ensureGroup(destination: { id: string; name: string; platformId: string }): string {
    const existing = findGroupByPlatform.get({ channel_type: 'whatsapp', platform_id: destination.platformId }) as { id: string } | undefined;
    if (existing?.id) return existing.id;
    insertGroup.run({
      id: destination.id,
      channel_type: 'whatsapp',
      platform_id: destination.platformId,
      name: destination.name,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    return destination.id;
  }

  const destinations = [
    { id: 'mg-phase3-laizys-taskflow', localName: 'Laizys', name: 'Laizys - TaskFlow', platformId: '120363425774136187@g.us' },
    { id: 'mg-phase3-ana-beatriz', localName: 'Ana Beatriz', name: 'Ana Beatriz', platformId: '120363426975449622@g.us' },
    { id: 'mg-phase3-mauro', localName: 'Mauro Cesar', name: 'Mauro Cesar', platformId: '120363407206502707@g.us' },
    { id: 'mg-phase3-rodrigo-lima', localName: 'Rodrigo Lima', name: 'Rodrigo Lima', platformId: '120363423592620469@g.us' },
    { id: 'mg-phase3-rafael', localName: 'Rafael', name: 'Rafael', platformId: '120363408810515104@g.us' },
    { id: 'mg-phase3-thiago', localName: 'Thiago', name: 'Thiago', platformId: '120363423211033081@g.us' },
  ];

  db.transaction(() => {
    for (const destination of destinations) {
      const targetId = ensureGroup(destination);
      insertDestination.run({
        agent_group_id: 'ag-phase2-seci',
        local_name: destination.localName,
        target_type: 'channel',
        target_id: targetId,
        created_at: now,
      });
    }
  })();

  console.log(`Seeded Phase 3 SECI destinations in ${dbPath}`);
} finally {
  db.close();
}
