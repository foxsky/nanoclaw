/**
 * One-time backfill: seed `container_configs` rows from existing
 * `groups/<folder>/container.json` files and `agent_groups.agent_provider`.
 *
 * Runs after migrations, before channel adapters start. Idempotent — skips
 * groups that already have a config row.
 *
 * Also reads legacy `.mcp.json` (v1 placed per-board MCP servers there
 * rather than in container.json). When both files exist, container.json's
 * mcpServers wins on any shared key; .mcp.json fills in keys container.json
 * doesn't have. This brings forward the sqlite MCP server that v1 TaskFlow
 * boards rely on for the standup / digest / review runner prompts —
 * without this carry-forward, those runners crash on first fire after
 * migration with "Unknown tool: mcp__sqlite__read_query".
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import type { McpServerConfig, AdditionalMountConfig } from './container-config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getContainerConfig, createContainerConfig } from './db/container-configs.js';
import { log } from './log.js';
import type { ContainerConfigRow } from './types.js';

interface LegacyContainerJson {
  mcpServers?: Record<string, McpServerConfig>;
  packages?: { apt?: string[]; npm?: string[] };
  imageTag?: string;
  additionalMounts?: AdditionalMountConfig[];
  skills?: string[] | 'all';
  provider?: string;
  assistantName?: string;
  maxMessagesPerPrompt?: number;
}

export function backfillContainerConfigs(): void {
  const groups = getAllAgentGroups();
  let backfilled = 0;

  for (const group of groups) {
    // Skip if already has a config row
    if (getContainerConfig(group.id)) continue;

    // Read legacy container.json from disk
    const filePath = path.join(GROUPS_DIR, group.folder, 'container.json');
    let legacy: LegacyContainerJson = {};
    if (fs.existsSync(filePath)) {
      try {
        legacy = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LegacyContainerJson;
      } catch (err) {
        log.warn('Backfill: failed to parse container.json, using defaults', {
          folder: group.folder,
          err: String(err),
        });
      }
    }

    // Carry forward MCP servers from .mcp.json (v1 stored per-board MCP
    // config there instead of container.json). container.json wins for
    // any shared key.
    const mcpJsonPath = path.join(GROUPS_DIR, group.folder, '.mcp.json');
    if (fs.existsSync(mcpJsonPath)) {
      try {
        const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) as {
          mcpServers?: Record<string, McpServerConfig>;
        };
        if (mcpJson.mcpServers && Object.keys(mcpJson.mcpServers).length > 0) {
          legacy.mcpServers = { ...mcpJson.mcpServers, ...(legacy.mcpServers ?? {}) };
        }
      } catch (err) {
        log.warn('Backfill: failed to parse .mcp.json, ignoring', {
          folder: group.folder,
          err: String(err),
        });
      }
    }

    // DB agent_provider wins over file provider (matches old cascade)
    const provider = group.agent_provider || legacy.provider || null;

    const row: ContainerConfigRow = {
      agent_group_id: group.id,
      provider,
      model: null,
      effort: null,
      image_tag: legacy.imageTag ?? null,
      assistant_name: legacy.assistantName ?? null,
      max_messages_per_prompt: legacy.maxMessagesPerPrompt ?? null,
      skills: JSON.stringify(legacy.skills ?? 'all'),
      mcp_servers: JSON.stringify(legacy.mcpServers ?? {}),
      packages_apt: JSON.stringify(legacy.packages?.apt ?? []),
      packages_npm: JSON.stringify(legacy.packages?.npm ?? []),
      additional_mounts: JSON.stringify(legacy.additionalMounts ?? []),
      cli_scope: 'group',
      updated_at: new Date().toISOString(),
    };

    createContainerConfig(row);
    backfilled++;
  }

  if (backfilled > 0) {
    log.info('Backfilled container_configs from disk', { count: backfilled });
  }
}
