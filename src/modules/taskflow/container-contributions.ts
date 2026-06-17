/**
 * TaskFlow host-side container contributions (ADR 0006 contract #2 consumer).
 *
 * Registers a single container contributor that adds, on every agent-container
 * spawn, the TaskFlow-specific mounts and env that used to live inline in
 * `src/container-runner.ts`:
 *
 *   - the host-owned `taskflow/` directory mount (RW) + `embeddings/` mount (RO)
 *   - the v1↔v2 comparator-harness replay env (`NANOCLAW_*_REPLAY*` etc.)
 *   - operator native-memory knobs (`NANOCLAW_MEMORY_*`, exact allowlist)
 *   - the semantic-search embed config (`NANOCLAW_TASKFLOW_EMBED_*`, from .env)
 *   - the host-injected board id (`NANOCLAW_TASKFLOW_BOARD_ID`)
 *   - the holiday-skip wiring (`NANOCLAW_GROUP_FOLDER` + `TASKFLOW_HOLIDAY_EXEMPT`)
 *
 * The env helpers stay pure (env-injectable) so they remain unit-testable
 * exactly as before. The contributor wires them to the spawn context. Core's
 * `collectContainerContributions` enforces the reserved-path / reserved-env
 * guards on whatever this returns (see container-contributor-registry.ts) — this
 * module never targets `/workspace` or `/workspace/inbound.db`, and none of its
 * env keys are host-critical, so nothing here is dropped in normal operation.
 */
import fs from 'fs';
import path from 'path';

import { registerContainerContributor } from '../../container-contributor-registry.js';
import type { VolumeMount } from '../../providers/provider-container-registry.js';
import { readEnvFile } from '../../env.js';
import { ensureTaskflowDb, taskflowDir } from '../../taskflow-mount.js';
import { resolveTaskflowBoardId } from '../../taskflow-db.js';

export function replayContainerEnvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];
  if (env.NANOCLAW_TOOL_USES_PATH) {
    args.push('-e', `NANOCLAW_TOOL_USES_PATH=${env.NANOCLAW_TOOL_USES_PATH}`);
  }
  if (env.NANOCLAW_PHASE2_RAW_PROMPT === '1') {
    args.push('-e', 'NANOCLAW_PHASE2_RAW_PROMPT=1');
  }
  if (env.NANOCLAW_PHASE_REPLAY_NOW) {
    args.push('-e', `NANOCLAW_PHASE_REPLAY_NOW=${env.NANOCLAW_PHASE_REPLAY_NOW}`);
  }
  return args;
}

// The native-memory feature knobs forwarded from the host into every container so per-board
// memory can be turned on without a per-group env path: hybrid recall (EMBED_*), the
// auto-capture backend (EXTRACT_*), and forgetting (MAX_AGE_DAYS / KEEP_TOP_N). An EXACT
// allowlist (not a prefix) so none of these can be NANOCLAW_TASKFLOW_BOARD_ID (board scope),
// the proxy, or auth, AND an operator who happens to name a secret in the namespace doesn't get
// it forwarded. Add a new knob here when one is read by container/agent-runner/src.
const MEMORY_ENV_KEYS = [
  'NANOCLAW_MEMORY_EXTRACT_BACKEND',
  'NANOCLAW_MEMORY_EXTRACT_MODEL',
  'NANOCLAW_MEMORY_EXTRACT_URL',
  'NANOCLAW_MEMORY_EXTRACT_TIMEOUT_MS',
  'NANOCLAW_MEMORY_EMBED_MODEL',
  'NANOCLAW_MEMORY_EMBED_URL',
  'NANOCLAW_MEMORY_EMBED_TIMEOUT_MS',
  'NANOCLAW_MEMORY_MAX_AGE_DAYS',
  'NANOCLAW_MEMORY_KEEP_TOP_N',
] as const;

export function memoryEnvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];
  for (const key of MEMORY_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) {
      args.push('-e', `${key}=${value}`);
    }
  }
  return args;
}

// TaskFlow holiday-skip wiring for the CONTAINER warm-gate. The warm container's gate
// (container/agent-runner/src/runner-gate-apply.ts isHolidayExempt) needs both forwarded:
//   - NANOCLAW_GROUP_FOLDER  — always; the exempt key matches 'folder' or 'folder:kind'.
//   - TASKFLOW_HOLIDAY_EXEMPT — verbatim, ONLY when set (no empty -e), so an unset operator list
//                              leaves the container's exempt at its default-false (unchanged).
// Folder is a spawn parameter (not env); the exempt list is host env. Pure for unit testing.
export function holidayExemptEnvArgs(folder: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const args = ['-e', `NANOCLAW_GROUP_FOLDER=${folder}`];
  if (env.TASKFLOW_HOLIDAY_EXEMPT) {
    args.push('-e', `TASKFLOW_HOLIDAY_EXEMPT=${env.TASKFLOW_HOLIDAY_EXEMPT}`);
  }
  return args;
}

// TaskFlow semantic-search embed config (#385). The in-container api_query
// 'search' handler embeds the search text itself, and MUST use the same model
// the host EmbeddingService indexed tasks with (else query/task vectors are
// incomparable). Forward OLLAMA_HOST/EMBEDDING_MODEL from .env, renamed into
// the NANOCLAW_TASKFLOW_EMBED_* allowlist namespace (an explicit allowlist —
// can't be board scope, the proxy, or auth). Gated on OLLAMA_HOST: unset =>
// [] => no embed env => search falls back to lexical (matches the feeder-off
// host side). Reads .env, so `env` is injectable for tests.
export function taskflowEmbedEnvArgs(
  env: Record<string, string> = readEnvFile(['OLLAMA_HOST', 'EMBEDDING_MODEL']),
): string[] {
  if (!env.OLLAMA_HOST) return [];
  return [
    '-e',
    `NANOCLAW_TASKFLOW_EMBED_URL=${env.OLLAMA_HOST}`,
    '-e',
    `NANOCLAW_TASKFLOW_EMBED_MODEL=${env.EMBEDDING_MODEL || 'bge-m3'}`,
  ];
}

/**
 * Convert a flat `['-e', 'K=V', '-e', 'K2=V2']` arg list (the legacy inline shape that the env
 * helpers still return, so their unit tests are unchanged) into the contributor's
 * `Record<string, string>` env shape. Splits on the FIRST `=` only so values containing `=`
 * survive. Ignores anything that isn't a `-e KEY=VALUE` pair.
 */
function envArgsToRecord(args: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-e') continue;
    const pair = args[i + 1];
    if (typeof pair !== 'string') continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
    i++;
  }
  return env;
}

registerContainerContributor('taskflow', (ctx) => {
  const mounts: VolumeMount[] = [];

  // Single host-owned TaskFlow DB shared by every container. The DIRECTORY (not just the file) is
  // mounted so SQLite's `-journal` sidecar can live beside the main DB on either side of the mount.
  // Heavy schema migration runs once at host startup (bootstrapTaskflowDb in src/index.ts); this
  // guard only confirms the file exists (and falls back to bootstrap if a test/CLI bypassed init).
  ensureTaskflowDb(ctx.dataDir);
  mounts.push({ hostPath: taskflowDir(ctx.dataDir), containerPath: '/workspace/taskflow', readonly: false });

  // Embeddings DB (#385) — read-only mount of the embeddings DIRECTORY (not the file) so SQLite's
  // `-journal` sidecar can live beside the DB. embeddings.db is journal_mode=DELETE (host writes,
  // container reads). Always mounted: empty when the host feeder is off (OLLAMA_HOST unset) →
  // reader finds no DB → lexical fallback.
  const embeddingsDir = path.join(ctx.dataDir, 'embeddings');
  fs.mkdirSync(embeddingsDir, { recursive: true });
  mounts.push({ hostPath: embeddingsDir, containerPath: '/workspace/embeddings', readonly: true });

  const env: Record<string, string> = {
    // Opt-in tool_use capture for the v1↔v2 comparator harness. Off in prod.
    ...envArgsToRecord(replayContainerEnvArgs(ctx.hostEnv)),
    // Operator-set native-memory knobs (NANOCLAW_MEMORY_*).
    ...envArgsToRecord(memoryEnvArgs(ctx.hostEnv)),
    // TaskFlow semantic-search embed config (#385) — [] when OLLAMA_HOST unset (search stays lexical).
    ...envArgsToRecord(taskflowEmbedEnvArgs()),
    // Holiday-skip: group folder (always) + operator exempt list (only when set).
    ...envArgsToRecord(holidayExemptEnvArgs(ctx.agentGroupFolder, ctx.hostEnv)),
  };

  // v1 parity: MCP handlers host-inject board_id from this env so the agent never has to construct
  // it. Resolve via the boards table — folder→id is NOT always `board-<folder>` (historical renames,
  // board_groups mapping). The explicit replay-only board id pins a restored snapshot board.
  const taskflowBoardId = resolveTaskflowBoardId(
    ctx.agentGroupFolder,
    true,
    ctx.hostEnv.NANOCLAW_PHASE_REPLAY_TASKFLOW_BOARD_ID,
  );
  if (taskflowBoardId) {
    env.NANOCLAW_TASKFLOW_BOARD_ID = taskflowBoardId;
  }

  return { mounts, env };
});
