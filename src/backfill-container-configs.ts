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
import {
  getContainerConfig,
  createContainerConfig,
  updateContainerConfigJson,
} from './db/container-configs.js';
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

/** Read & validate the mcpServers field from a JSON config blob. Returns
 *  an empty record on any shape mismatch and logs a warn so the source
 *  problem is visible. */
function extractMcpServers(
  parsed: unknown,
  source: string,
  folder: string,
): Record<string, McpServerConfig> {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn('Backfill: file root is not an object, ignoring', { source, folder });
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const servers = obj.mcpServers;
  if (servers === undefined) return {};
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    log.warn('Backfill: mcpServers is not a plain object, ignoring', {
      source,
      folder,
      gotType: Array.isArray(servers) ? 'array' : typeof servers,
    });
    return {};
  }
  // Shape-check each server entry. Drop any that aren't plain objects.
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
      log.warn('Backfill: mcpServers entry is not a plain object, skipping', {
        source,
        folder,
        server: name,
      });
      continue;
    }
    out[name] = cfg as McpServerConfig;
  }
  return out;
}

/** Read .mcp.json's mcpServers (validated). Returns null if file
 *  absent, {} if present-but-empty or shape-invalid. */
function readMcpJsonServers(folder: string): Record<string, McpServerConfig> | null {
  const mcpJsonPath = path.join(GROUPS_DIR, folder, '.mcp.json');
  if (!fs.existsSync(mcpJsonPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
  } catch (err) {
    log.warn('Backfill: failed to parse .mcp.json, ignoring', { folder, err: String(err) });
    return {};
  }
  return extractMcpServers(parsed, '.mcp.json', folder);
}

export function backfillContainerConfigs(): void {
  const groups = getAllAgentGroups();
  let backfilled = 0;
  let retrofilled = 0;

  for (const group of groups) {
    const existing = getContainerConfig(group.id);
    if (existing) {
      // Retrofill path: row exists (e.g., from a prior backfill run that
      // didn't read .mcp.json). Merge in any .mcp.json keys that aren't
      // already present in the existing row's mcp_servers. Operator-set
      // keys win — we only fill ABSENT keys, never overwrite.
      const mcpJsonServers = readMcpJsonServers(group.folder);
      if (!mcpJsonServers || Object.keys(mcpJsonServers).length === 0) continue;

      let existingServers: Record<string, McpServerConfig>;
      try {
        const parsed = JSON.parse(existing.mcp_servers as unknown as string);
        existingServers = extractMcpServers({ mcpServers: parsed }, 'container_configs row', group.folder);
      } catch {
        existingServers = {};
      }

      const toAdd: Record<string, McpServerConfig> = {};
      for (const [name, cfg] of Object.entries(mcpJsonServers)) {
        if (!(name in existingServers)) toAdd[name] = cfg;
      }
      if (Object.keys(toAdd).length === 0) continue;

      const merged = { ...existingServers, ...toAdd };
      updateContainerConfigJson(group.id, 'mcp_servers', merged);
      retrofilled++;
      log.info('Backfill: retrofilled mcp_servers from .mcp.json', {
        folder: group.folder,
        added: Object.keys(toAdd),
      });
      continue;
    }

    // Fresh-row path: no config row exists yet. Read both container.json
    // and .mcp.json, merge, create row.
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

    // Carry forward MCP servers from .mcp.json. container.json wins on
    // any shared key (operator who explicitly moved MCP config to
    // container.json shouldn't be overridden by stale .mcp.json).
    const mcpJsonServers = readMcpJsonServers(group.folder);
    if (mcpJsonServers && Object.keys(mcpJsonServers).length > 0) {
      const containerServers = legacy.mcpServers ?? {};
      // Warn on shared-key conflicts so stale .mcp.json vs deliberate
      // operator config is visible.
      for (const name of Object.keys(mcpJsonServers)) {
        if (
          name in containerServers &&
          JSON.stringify(containerServers[name]) !== JSON.stringify(mcpJsonServers[name])
        ) {
          log.warn('Backfill: container.json and .mcp.json both define mcpServers entry; container.json wins', {
            folder: group.folder,
            server: name,
          });
        }
      }
      legacy.mcpServers = { ...mcpJsonServers, ...containerServers };
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
  if (retrofilled > 0) {
    log.info('Retrofilled mcp_servers in existing container_configs from .mcp.json', { count: retrofilled });
  }
}
