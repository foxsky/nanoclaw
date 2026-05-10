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
import { getContainerConfig, createContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Read & validate the mcpServers field from a JSON config blob. Returns
 *  an empty record on any shape mismatch and logs a warn so the source
 *  problem is visible. */
function extractMcpServers(parsed: unknown, folder: string): Record<string, McpServerConfig> {
  if (!isPlainObject(parsed)) {
    log.warn('Backfill: file root is not an object, ignoring', { folder });
    return {};
  }
  const servers = parsed.mcpServers;
  if (servers === undefined) return {};
  if (!isPlainObject(servers)) {
    log.warn('Backfill: mcpServers is not a plain object, ignoring', {
      folder,
      gotType: Array.isArray(servers) ? 'array' : typeof servers,
    });
    return {};
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (!isPlainObject(cfg)) {
      log.warn('Backfill: mcpServers entry is not a plain object, skipping', { folder, server: name });
      continue;
    }
    out[name] = cfg as unknown as McpServerConfig;
  }
  return out;
}

/** Read .mcp.json's mcpServers. Returns null if file absent, {} if
 *  present-but-empty or shape-invalid. Drops the existsSync — relies on
 *  readFileSync's ENOENT for absence, which is a single syscall instead
 *  of two and removes a small TOCTOU window. */
function readMcpJsonServers(folder: string): Record<string, McpServerConfig> | null {
  const mcpJsonPath = path.join(GROUPS_DIR, folder, '.mcp.json');
  let raw: string;
  try {
    raw = fs.readFileSync(mcpJsonPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    log.warn('Backfill: failed to read .mcp.json, ignoring', { folder, err: String(err) });
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('Backfill: failed to parse .mcp.json, ignoring', { folder, err: String(err) });
    return {};
  }
  return extractMcpServers(parsed, folder);
}

/** Read container.json. Returns {} if absent or malformed (caller's
 *  defaults kick in via `??` chains). */
function readContainerJson(folder: string): LegacyContainerJson {
  const filePath = path.join(GROUPS_DIR, folder, 'container.json');
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {};
    log.warn('Backfill: failed to read container.json, using defaults', { folder, err: String(err) });
    return {};
  }
  try {
    return JSON.parse(raw) as LegacyContainerJson;
  } catch (err) {
    log.warn('Backfill: failed to parse container.json, using defaults', { folder, err: String(err) });
    return {};
  }
}

export function backfillContainerConfigs(): void {
  const groups = getAllAgentGroups();
  let backfilled = 0;
  let retrofilled = 0;

  for (const group of groups) {
    const existing = getContainerConfig(group.id);

    // Both code paths first read .mcp.json — guard early on absent/empty
    // to avoid a JSON.parse on existing.mcp_servers we won't use.
    const mcpJsonServers = readMcpJsonServers(group.folder);
    const hasMcpJson = mcpJsonServers !== null && Object.keys(mcpJsonServers).length > 0;

    if (existing) {
      // Retrofill: row exists (likely from a prior backfill that didn't
      // read .mcp.json). Add only keys absent from existing — operator
      // overrides are preserved.
      if (!hasMcpJson) continue;

      let existingServers: Record<string, McpServerConfig>;
      try {
        const parsed = JSON.parse(existing.mcp_servers as unknown as string);
        existingServers = extractMcpServers({ mcpServers: parsed }, group.folder);
      } catch {
        existingServers = {};
      }

      const toAdd: Record<string, McpServerConfig> = {};
      for (const [name, cfg] of Object.entries(mcpJsonServers!)) {
        if (!(name in existingServers)) toAdd[name] = cfg;
      }
      const addedKeys = Object.keys(toAdd);
      if (addedKeys.length === 0) continue;

      updateContainerConfigJson(group.id, 'mcp_servers', { ...existingServers, ...toAdd });
      retrofilled++;
      log.info('Backfill: retrofilled mcp_servers from .mcp.json', {
        folder: group.folder,
        added: addedKeys,
      });
      continue;
    }

    // Fresh row: read container.json, merge in .mcp.json absent keys,
    // create row. container.json wins on shared keys.
    const legacy = readContainerJson(group.folder);
    if (hasMcpJson) {
      const containerServers = legacy.mcpServers ?? {};
      for (const name of Object.keys(mcpJsonServers!)) {
        if (
          name in containerServers &&
          JSON.stringify(containerServers[name]) !== JSON.stringify(mcpJsonServers![name])
        ) {
          log.warn('Backfill: container.json and .mcp.json both define mcpServers entry; container.json wins', {
            folder: group.folder,
            server: name,
          });
        }
      }
      legacy.mcpServers = { ...mcpJsonServers, ...containerServers };
    }

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

  if (backfilled > 0) log.info('Backfilled container_configs from disk', { count: backfilled });
  if (retrofilled > 0) log.info('Retrofilled mcp_servers from .mcp.json', { count: retrofilled });
}
