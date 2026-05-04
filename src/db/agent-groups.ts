import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';

/**
 * `is_main_control` is omitted from the input here because it has a column
 * DEFAULT (0) and is set later via `setMainControlAgentGroup` once an admin
 * (or skill bootstrap step) designates the operator's main agent. Keeping
 * it out of the insert path means existing v2 callers don't carry the v1-
 * private "main" concept into their construction call sites.
 */
export function createAgentGroup(group: Omit<AgentGroup, 'is_main_control'>): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (@id, @name, @folder, @agent_provider, @created_at)`,
    )
    .run(group);
}

export function getAgentGroup(id: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as AgentGroup | undefined;
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as AgentGroup | undefined;
}

export function getAllAgentGroups(): AgentGroup[] {
  return getDb().prepare('SELECT * FROM agent_groups ORDER BY name').all() as AgentGroup[];
}

export function updateAgentGroup(id: string, updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider'>>): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteAgentGroup(id: string): void {
  getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
}

/**
 * Designate `id` as THE main control agent group. Atomically clears any
 * existing main and sets the new one in a single transaction so the
 * partial unique index never sees a transient two-main state.
 *
 * Throws if the target id doesn't exist (fail closed — a typo'd id MUST
 * NOT silently leave the system in a no-main state).
 */
export function setMainControlAgentGroup(id: string): void {
  const db = getDb();
  db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(id);
    if (!exists) {
      throw new Error(`setMainControlAgentGroup: agent group "${id}" does not exist`);
    }
    db.prepare('UPDATE agent_groups SET is_main_control = 0 WHERE is_main_control = 1').run();
    db.prepare('UPDATE agent_groups SET is_main_control = 1 WHERE id = ?').run(id);
  })();
}

/**
 * Returns the current main control agent group, or undefined if none has
 * been designated yet. Privileged-action handlers MUST treat undefined as
 * a fail-closed signal: drop the action with a warn log, do not allow.
 */
export function getMainControlAgentGroup(): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE is_main_control = 1').get() as AgentGroup | undefined;
}
