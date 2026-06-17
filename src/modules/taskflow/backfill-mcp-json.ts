/**
 * TaskFlow backfill overlay (ADR 0006 contract #10 registrant).
 *
 * v1 placed per-board MCP servers in a legacy `groups/<folder>/.mcp.json`
 * rather than in container.json. After core's `backfillContainerConfigs()`
 * seeds each `container_configs` row from container.json, this step carries
 * forward any `.mcp.json` server entries that the row doesn't already have.
 * Without this, migrated TaskFlow boards crash on the first standup / digest /
 * review runner fire with "Unknown tool: mcp__sqlite__read_query".
 *
 * Runs after the core backfill, so every group already has a config row. We
 * add only keys ABSENT from the existing row — operator overrides and the
 * container.json-wins-on-shared-keys precedence are both preserved verbatim
 * (a differing shared key keeps the existing/container.json value and only
 * logs a warn). Idempotent: re-running adds nothing once the keys are present.
 */
import fs from 'fs';
import path from 'path';

import { registerBackfillStep } from '../../backfill-container-configs.js';
import { GROUPS_DIR } from '../../config.js';
import type { McpServerConfig } from '../../container-config.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { log } from '../../log.js';

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

/** Carry forward legacy `.mcp.json` server entries into each board's
 *  `container_configs.mcp_servers`, adding only absent keys. */
export function backfillMcpJsonServers(): void {
  const groups = getAllAgentGroups();
  let retrofilled = 0;

  for (const group of groups) {
    const mcpJsonServers = readMcpJsonServers(group.folder);
    if (mcpJsonServers === null || Object.keys(mcpJsonServers).length === 0) continue;

    const existing = getContainerConfig(group.id);
    // Core's backfillContainerConfigs() runs first, so every group has a row.
    // If one is somehow missing, there's nothing to retrofill — skip.
    if (!existing) continue;

    let existingServers: Record<string, McpServerConfig>;
    try {
      const parsed = JSON.parse(existing.mcp_servers as unknown as string);
      existingServers = extractMcpServers({ mcpServers: parsed }, group.folder);
    } catch {
      existingServers = {};
    }

    const toAdd: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(mcpJsonServers)) {
      if (name in existingServers) {
        // Existing (container.json-sourced) value wins on a shared key; only
        // surface a warn if the .mcp.json definition differs.
        if (JSON.stringify(existingServers[name]) !== JSON.stringify(cfg)) {
          log.warn('Backfill: container.json and .mcp.json both define mcpServers entry; container.json wins', {
            folder: group.folder,
            server: name,
          });
        }
        continue;
      }
      toAdd[name] = cfg;
    }

    const addedKeys = Object.keys(toAdd);
    if (addedKeys.length === 0) continue;

    updateContainerConfigJson(group.id, 'mcp_servers', { ...existingServers, ...toAdd });
    retrofilled++;
    log.info('Backfill: retrofilled mcp_servers from .mcp.json', {
      folder: group.folder,
      added: addedKeys,
    });
  }

  if (retrofilled > 0) log.info('Retrofilled mcp_servers from .mcp.json', { count: retrofilled });
}

registerBackfillStep(backfillMcpJsonServers);
