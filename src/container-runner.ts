/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { materializeContainerJson } from './container-config.js';
import { readEnvFile } from './env.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars, updateContainerConfigJson } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import { ensureTaskflowDb, taskflowDir } from './taskflow-mount.js';
import { resolveTaskflowBoardId } from './taskflow-db.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

// `<agentId>:<mode>` keys whose secret-mode flip has SUCCEEDED in this host process (→ off the
// per-spawn hot path), and in-flight flips on the same key (→ concurrent first-spawns of the same
// agent group share one PATCH instead of racing). Keyed by id AND mode so a later request for a
// different mode is not falsely skipped. Module-level so they persist across spawns; injectable in
// ensureAgentSecretMode for tests. A failed flip is deliberately NOT recorded as done, so the next
// spawn retries it — a transient gateway/network blip must not permanently strand an agent at 401.
const secretModeFlipped = new Set<string>();
const secretModeInFlight = new Map<string, Promise<void>>();

/**
 * Ensure a newly-spawning agent's OneCLI vault agent is in the operator-requested secret mode, so
 * the gateway injects CLAUDE_CODE_OAUTH_TOKEN=placeholder and the container can emit the
 * `Authorization: Bearer` header the gateway rewrites (a `selective` agent with no secrets gets no
 * placeholder → no Bearer → 401 on every model call; see docs/v2-cutover-runbook.md). No-op unless
 * the operator opted in via NANOCLAW_ONECLI_AUTO_SECRET_MODE (`mode` is null otherwise).
 *
 * Flips via the gateway's `PATCH /api/agents/<id>/secret-mode` using the host's own
 * ONECLI_API_KEY Bearer auth — the same credentials ensureAgent/applyContainerConfig already use —
 * so it does NOT depend on a CLI binary, $PATH, or a per-HOME `~/.onecli` profile. Mirrors what
 * `onecli agents set-secret-mode --id <id> --mode <mode>` does. Idempotent on the gateway.
 *
 * Fail-SOFT: on any error the spawn proceeds (a selective agent still boots, just 401s until the
 * flip lands), and the id is left out of the done-set so the next spawn re-attempts. Awaited before
 * the caller's applyContainerConfig so a successful flip is reflected in the container-config env.
 */
export async function ensureAgentSecretMode(
  agentIdentifier: string,
  mode: 'all' | 'selective' | null,
  deps: {
    fetchImpl?: typeof fetch;
    onecliUrl?: string;
    apiKey?: string;
    flipped?: Set<string>;
    inflight?: Map<string, Promise<void>>;
  } = {},
): Promise<void> {
  if (!mode || !agentIdentifier) return;
  const flipped = deps.flipped ?? secretModeFlipped;
  const inflight = deps.inflight ?? secretModeInFlight;
  const key = `${agentIdentifier}:${mode}`;
  if (flipped.has(key)) return;
  const baseUrl = (deps.onecliUrl ?? ONECLI_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    // No gateway URL ⇒ no valid endpoint to PATCH. Skip rather than retry-spin on a relative URL.
    log.warn('OneCLI secret-mode auto-flip skipped: no gateway URL (ONECLI_URL unset)', { agentIdentifier, mode });
    return;
  }
  let pending = inflight.get(key);
  if (!pending) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const apiKey = deps.apiKey ?? ONECLI_API_KEY;
    const url = `${baseUrl}/api/agents/${encodeURIComponent(agentIdentifier)}/secret-mode`;
    // Mirror the SDK: only send Authorization when a key is configured (a keyless local gateway
    // must not receive `Bearer undefined`, which would 401 the flip forever).
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    // Promise.resolve().then(...) so even a SYNCHRONOUS throw from fetchImpl is funneled into the
    // catch (fail-soft), never out of this function where it could abort the spawn.
    pending = Promise.resolve()
      .then(() =>
        fetchImpl(url, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ id: agentIdentifier, mode }),
          signal: AbortSignal.timeout(15000),
        }),
      )
      .then((res) => {
        if (!res.ok) throw new Error(`secret-mode PATCH returned ${res.status}`);
        flipped.add(key);
        log.info('OneCLI agent secret-mode auto-flipped', { agentIdentifier, mode });
      })
      .catch((err: unknown) => {
        // Fail-soft + retry-on-next-spawn: do NOT add to `flipped`, so the next spawn re-attempts.
        log.warn('OneCLI secret-mode auto-flip failed; will retry on next spawn (agent may 401 until then)', {
          agentIdentifier,
          mode,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, pending);
  }
  await pending;
}

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

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
// allowlist (not a prefix) — mirroring replayContainerEnvArgs above — so none of these can be
// NANOCLAW_TASKFLOW_BOARD_ID (board scope), the proxy, or auth, AND an operator who happens to
// name a secret in the namespace doesn't get it forwarded. Add a new knob here when one is read
// by container/agent-runner/src (grep NANOCLAW_MEMORY_).
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

// TaskFlow holiday-skip wiring for the CONTAINER warm-gate. The host sweep gate reads
// agentGroup.folder + TASKFLOW_HOLIDAY_EXEMPT in-process, but the warm container's gate
// (container/agent-runner/src/runner-gate-apply.ts isHolidayExempt) needs both forwarded:
//   - NANOCLAW_GROUP_FOLDER  — always; the exempt key matches 'folder' or 'folder:kind'.
//                              Read by poll-loop.ts and passed as agentGroupFolder into the gate.
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

// Resolve the opt-in NANOCLAW_ONECLI_AUTO_SECRET_MODE knob to a valid gateway secret mode, or
// null when the feature is off. Fail-closed on a malformed value (only the two real modes pass),
// so a typo never reaches the gateway as a bad mode. Unset => null => current behavior unchanged.
// Pure for unit testing. The caller warns on a set-but-invalid value (this stays log-free).
export function resolveFlipMode(env: NodeJS.ProcessEnv = process.env): 'all' | 'selective' | null {
  const mode = env.NANOCLAW_ONECLI_AUTO_SECRET_MODE;
  return mode === 'all' || mode === 'selective' ? mode : null;
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(claudeDir, containerConfig);

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. See `claude-md-compose.ts`.
  composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // #414 (defense-in-depth): inbound.db is host-written, container-read — the container must NEVER
  // write it (a forged messages_in row could self-approve a gated action; see taskflow-approval.ts).
  // The container already opens it read-only at the app level (db/connection.ts), but a full container
  // ESCAPE (arbitrary code exec — which the SEC#2 denylist otherwise prevents) could re-open it RW
  // through the RW /workspace mount. Pin it read-only at the FILESYSTEM level with a nested RO mount
  // ON TOP of the RW session dir (mirrors the container.json pattern below). CRITICAL: this is a
  // file-on-top-of-dir overlay, NOT a file-only mount — the `inbound.db-journal` sidecar still lives in
  // the parent RW /workspace mount, so SQLite's journal_mode=DELETE crash-recovery/visibility across the
  // host↔container boundary is preserved (the load-bearing message-delivery invariant). inbound.db is
  // created (by the waking writeSessionMessage) before this runs; guard anyway, matching container.json.
  const inboundDbPath = path.join(sessDir, 'inbound.db');
  if (fs.existsSync(inboundDbPath)) {
    mounts.push({ hostPath: inboundDbPath, containerPath: '/workspace/inbound.db', readonly: true });
  }

  // Single host-owned TaskFlow DB shared by every container. The DIRECTORY
  // (not just the file) is mounted so SQLite's `-journal` sidecar can live
  // beside the main DB on either side of the mount — file-only mounts
  // would put the container's journal inside the session dir, breaking
  // crash recovery. Heavy schema migration runs once at host startup
  // (bootstrapTaskflowDb in src/index.ts); this guard only confirms the
  // file exists (and falls back to bootstrap if a test/CLI bypassed init).
  ensureTaskflowDb(DATA_DIR);
  mounts.push({ hostPath: taskflowDir(DATA_DIR), containerPath: '/workspace/taskflow', readonly: false });

  // Embeddings DB (#385) — read-only mount of the embeddings DIRECTORY (not the
  // file) so SQLite's `-journal` sidecar can live beside the DB. embeddings.db
  // is journal_mode=DELETE (host writes, container reads — WAL's -shm isn't
  // VirtioFS-coherent). Always mounted: empty when the host feeder is off
  // (OLLAMA_HOST unset) → reader finds no DB → lexical fallback.
  const embeddingsDir = path.join(DATA_DIR, 'embeddings');
  fs.mkdirSync(embeddingsDir, { recursive: true });
  mounts.push({ hostPath: embeddingsDir, containerPath: '/workspace/embeddings', readonly: true });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set
  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  let desired: string[];
  if (containerConfig.skills === 'all') {
    // Recompute from shared dir — newly-added upstream skills appear automatically
    desired = fs.existsSync(sharedSkillsDir)
      ? fs.readdirSync(sharedSkillsDir).filter((e) => {
          try {
            return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
  } else {
    desired = containerConfig.skills;
  }

  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Opt-in tool_use capture for the v1↔v2 comparator harness. Off in prod.
  args.push(...replayContainerEnvArgs());

  // Operator-set native-memory knobs (NANOCLAW_MEMORY_*). Injected before the host-critical
  // vars below (board id, provider, gateway) so those always win on any conflict — though the
  // prefix can't collide with them anyway.
  args.push(...memoryEnvArgs());

  // TaskFlow semantic-search embed config (#385) — forwards OLLAMA_HOST/
  // EMBEDDING_MODEL so the in-container api_query 'search' embeds the query with
  // the host feeder's model. [] when OLLAMA_HOST unset (search stays lexical).
  args.push(...taskflowEmbedEnvArgs());

  // v1 parity: MCP handlers host-inject board_id from this env so the agent
  // never has to construct it. Resolve via the boards table — folder→id is
  // NOT always `board-<folder>` (historical renames, board_groups mapping).
  // Phase 3 production-snapshot replays can intentionally run a local fixture
  // folder against a historical DB snapshot where the board's production
  // folder name differs. Keep normal production resolution folder-driven, but
  // allow the explicit replay-only board id to pin the restored snapshot board.
  const taskflowBoardId = resolveTaskflowBoardId(
    agentGroup.folder,
    true,
    process.env.NANOCLAW_PHASE_REPLAY_TASKFLOW_BOARD_ID,
  );
  if (taskflowBoardId) {
    args.push('-e', `NANOCLAW_TASKFLOW_BOARD_ID=${taskflowBoardId}`);
  }

  // TaskFlow holiday-skip: forward the group folder (always) + operator exempt list (only when
  // set) so the container warm-gate's isHolidayExempt can match. See holidayExemptEnvArgs.
  args.push(...holidayExemptEnvArgs(agentGroup.folder));

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection. Treated as
  // a transient hard failure: if we can't wire the gateway, we don't spawn.
  // The caller (router or host-sweep) catches the throw, leaves the inbound
  // message pending, and the next sweep tick retries.
  if (agentIdentifier) {
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    const rawFlipMode = process.env.NANOCLAW_ONECLI_AUTO_SECRET_MODE;
    const flipMode = resolveFlipMode();
    if (rawFlipMode && !flipMode) {
      log.warn('NANOCLAW_ONECLI_AUTO_SECRET_MODE has an invalid value — ignoring (expected "all" or "selective")', {
        value: rawFlipMode,
      });
    }
    // Awaited before applyContainerConfig so a successful flip is reflected in the gateway's
    // container-config env (the placeholder that lets the container emit Authorization: Bearer).
    await ensureAgentSecretMode(agentIdentifier, flipMode);
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  log.info('OneCLI gateway applied', { containerName });

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
