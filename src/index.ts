import fs from 'fs';
import path from 'path';

// OneCLI is optional — only used if ONECLI_URL is configured and @onecli-sh/sdk is installed
// eslint-disable-next-line @typescript-eslint/no-require-imports
const OneCLI: any = (() => {
  try {
    return require('@onecli-sh/sdk').OneCLI;
  } catch {
    return null;
  }
})();

import {
  ASSISTANT_NAME,
  buildTriggerPattern,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  deleteRegisteredGroup,
  deleteSession,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getDmMessages,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import { getGroupSenderName } from './group-sender.js';
import { parseImageReferences } from './image.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { resolveExternalDm, getTaskflowDb } from './dm-routing.js';
import { resolveTaskflowBoardId } from './taskflow-db.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startSessionCleanup } from './session-cleanup.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

function isWebOriginMessage(message: NewMessage): boolean {
  return (
    message.sender.startsWith('web:') || message.sender_name.startsWith('web:')
  );
}

function appendAgentOutputToBoardChat(
  taskflowDb: ReturnType<typeof getTaskflowDb>,
  group: RegisteredGroup,
  content: string,
): boolean {
  if (!taskflowDb || !content.trim()) return false;

  const boardId = resolveTaskflowBoardId(
    group.folder,
    group.taskflowManaged === true,
  );
  if (!boardId) return false;

  try {
    taskflowDb
      .prepare(
        `INSERT INTO board_chat (board_id, sender_name, sender_type, content, created_at)
         VALUES (?, ?, 'agent', ?, datetime('now'))`,
      )
      .run(boardId, getGroupSenderName(group.trigger), content);
    return true;
  } catch (err) {
    logger.warn(
      { err, boardId, group: group.name },
      'Failed to append agent output to board_chat',
    );
    return false;
  }
}

/** Check if any message in the batch contains a trigger from an allowed sender. */
function hasTriggerMessage(
  messages: NewMessage[],
  chatJid: string,
  group: RegisteredGroup,
): boolean {
  const pattern = group.trigger
    ? buildTriggerPattern(group.trigger)
    : TRIGGER_PATTERN;
  const cfg = loadSenderAllowlist();
  return messages.some(
    (m) =>
      pattern.test(m.content.trim()) &&
      (m.is_from_me || isTriggerAllowed(chatJid, m.sender, cfg)),
  );
}

let lastTimestamp = '';
let lastDmTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
const pendingExternalDmPrompts = new Map<
  string,
  Array<{ timestamp: string; prompt: string }>
>();
/** Highest DM timestamp that is staged but not yet consumed. */
let stagedDmMaxTimestamp = '';

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = OneCLI ? new OneCLI({ url: ONECLI_URL }) : null;

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  if (!onecli) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res: any) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err: any) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  lastDmTimestamp = getRouterState('last_dm_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_dm_timestamp', lastDmTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  const previousGroup = registeredGroups[jid];
  let persisted = false;

  try {
    setRegisteredGroup(jid, group);
    persisted = true;

    // Create group folder
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    // Copy CLAUDE.md template into the new group folder so agents have
    // identity and instructions from the first run.  (Fixes #1391)
    const groupMdFile = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(groupMdFile)) {
      const templateFile = path.join(
        GROUPS_DIR,
        group.isMain ? 'main' : 'global',
        'CLAUDE.md',
      );
      if (fs.existsSync(templateFile)) {
        let content = fs.readFileSync(templateFile, 'utf-8');
        if (ASSISTANT_NAME !== 'Andy') {
          content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
          content = content.replace(
            /You are Andy/g,
            `You are ${ASSISTANT_NAME}`,
          );
        }
        fs.writeFileSync(groupMdFile, content);
        logger.info(
          { folder: group.folder },
          'Created CLAUDE.md from template',
        );
      }
    }

    registeredGroups[jid] = group;

    // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
    ensureOneCLIAgent(jid, group);
  } catch (err) {
    if (persisted) {
      try {
        if (previousGroup) {
          setRegisteredGroup(jid, previousGroup);
        } else {
          deleteRegisteredGroup(jid);
        }
      } catch (rollbackErr) {
        logger.error(
          { jid, folder: group.folder, rollbackErr },
          'Failed to roll back group registration after provisioning error',
        );
      }
    }

    logger.error(
      { jid, name: group.name, folder: group.folder, err },
      'Failed to register group',
    );
    return;
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

// Per-group response rate limit: minimum seconds between new container starts.
// The first message is always processed immediately. Subsequent messages that
// arrive while the container is idle accumulate and are batched on the next run.
// Message noise patterns — pre-compiled for hot-path efficiency
const NOISE_VOICE_PROCESSING = /^⏳\s*_?Processando\.{0,3}_?\s*$/;
const NOISE_TYPING_INDICATOR = /^(Gravando|Digitando|Recording|Typing)\.{0,3}$/;

const MIN_RESPONSE_INTERVAL_MS = 5_000; // 5 seconds between new agent invocations
const lastResponseTime = new Map<string, number>();
const pendingRateLimitTimers = new Set<string>(); // prevents timer stacking

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  // Rate limit: if we responded very recently, defer to let messages accumulate.
  // Uses pendingRateLimitTimers to prevent timer stacking from drain loops.
  const lastResponse = lastResponseTime.get(chatJid) ?? 0;
  const elapsed = Date.now() - lastResponse;
  if (elapsed < MIN_RESPONSE_INTERVAL_MS && lastResponse > 0) {
    if (!pendingRateLimitTimers.has(chatJid)) {
      pendingRateLimitTimers.add(chatJid);
      setTimeout(() => {
        pendingRateLimitTimers.delete(chatJid);
        queue.enqueueMessageCheck(chatJid);
      }, MIN_RESPONSE_INTERVAL_MS - elapsed);
    }
    return true;
  }

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, will retry');
    return false;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    getGroupSenderName(group.trigger),
    MAX_MESSAGES_PER_PROMPT,
  );

  // Check for pending external DM prompts (trigger-bypassed path)
  const pendingDms = pendingExternalDmPrompts.get(chatJid);
  if (pendingDms && pendingDms.length > 0) {
    const dmPrompt = pendingDms.map((p) => p.prompt).join('\n\n');
    pendingExternalDmPrompts.delete(chatJid);

    // NOTE: Do NOT advance lastAgentTimestamp here. That cursor tracks
    // group-chat messages (filtered by chat_jid in getMessagesSince).
    // DM timestamps live in a different chat and are already tracked by
    // lastDmTimestamp. Advancing the group cursor to a DM timestamp
    // would skip unprocessed group messages whose timestamps fall
    // between the old cursor and the (unrelated) DM timestamp.

    logger.info(
      { group: group.name, dmCount: pendingDms.length },
      'Processing external DM prompts (trigger-bypassed)',
    );

    const channel = findChannel(channels, chatJid);
    if (channel) await channel.setTyping?.(chatJid, true);

    const output = await runAgent(
      group,
      dmPrompt,
      chatJid,
      [],
      async (result) => {
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = stripInternalTags(raw);
          if (text && channel) {
            await channel.sendMessage(
              chatJid,
              text,
              getGroupSenderName(group.trigger),
            );
          }
        }
      },
    );

    if (channel) await channel.setTyping?.(chatJid, false);

    if (output === 'error') {
      // Rollback: restore pending DMs for retry.
      // New DMs may have arrived while the agent was running — merge
      // them with the original batch so nothing is silently dropped.
      const arrivedDuringRun = pendingExternalDmPrompts.get(chatJid);
      if (arrivedDuringRun && arrivedDuringRun.length > 0) {
        pendingExternalDmPrompts.set(chatJid, [
          ...pendingDms,
          ...arrivedDuringRun,
        ]);
      } else {
        pendingExternalDmPrompts.set(chatJid, pendingDms);
      }
      return false;
    }
    // Staged DMs consumed — advance cursor if no other groups still pending
    if (pendingExternalDmPrompts.size === 0 && stagedDmMaxTimestamp) {
      lastDmTimestamp = stagedDmMaxTimestamp;
      stagedDmMaxTimestamp = '';
      saveState();
    }
    return true;
  }

  if (missedMessages.length === 0) return true;

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: TRIGGER_PATTERN,
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, [], onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  const isWebOrigin = missedMessages.some((msg) => isWebOriginMessage(msg));

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false && !isWebOrigin) {
    if (!hasTriggerMessage(missedMessages, chatJid, group)) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const imageAttachments = parseImageReferences(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  // Mark response time BEFORE agent runs (blocks concurrent enqueues during processing)
  lastResponseTime.set(chatJid, Date.now());

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  const taskflowDb = isWebOrigin ? getTaskflowDb(DATA_DIR) : null;

  // Derive group-specific sender name from trigger (e.g. "@Case" → "Case").
  // Falls back to global ASSISTANT_NAME for groups without a custom trigger.
  const groupSender = getGroupSenderName(group.trigger);

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    imageAttachments,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = stripInternalTags(raw);
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          const routedToBoardChat =
            isWebOrigin &&
            appendAgentOutputToBoardChat(taskflowDb, group, text);
          if (!routedToBoardChat) {
            await channel.sendMessage(chatJid, text, groupSender);
          }
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        // Pause typing after each result so the user doesn't see
        // "typing..." indefinitely when the next result is internal-only.
        await channel.setTyping?.(chatJid, false);
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  imageAttachments: Array<{ relativePath: string; mediaType: string }>,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const persistedSessionId = sessions[group.folder];
  const shouldResumeSession = group.taskflowManaged !== true;
  const sessionId = shouldResumeSession ? persistedSessionId : undefined;

  if (!shouldResumeSession && persistedSessionId) {
    delete sessions[group.folder];
    deleteSession(group.folder);
    logger.info(
      { group: group.name, staleSessionId: persistedSessionId },
      'Discarded persisted TaskFlow session to force fresh tool registration',
    );
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId && shouldResumeSession) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        isTaskflowManaged: group.taskflowManaged === true,
        taskflowHierarchyLevel: group.taskflowHierarchyLevel,
        taskflowMaxDepth: group.taskflowMaxDepth,
        assistantName: getGroupSenderName(group.trigger),
        ...(imageAttachments.length > 0 && { imageAttachments }),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId && shouldResumeSession) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Filter out non-content noise (typing indicators, processing markers, empty)
        const substantiveMessages = messages.filter((msg) => {
          const text = msg.content.trim();
          if (!text) return false;
          if (NOISE_VOICE_PROCESSING.test(text)) return false;
          if (NOISE_TYPING_INDICATOR.test(text)) return false;
          return true;
        });

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of substantiveMessages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) => extractSessionCommand(m.content, TRIGGER_PATTERN) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const hasWebOrigin = groupMessages.some((msg) =>
            isWebOriginMessage(msg),
          );
          const needsTrigger =
            !isMainGroup && group.requiresTrigger !== false && !hasWebOrigin;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          // Web-originated messages (sender starts with 'web:') bypass the trigger requirement.
          if (needsTrigger) {
            if (!hasTriggerMessage(groupMessages, chatJid, group)) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            getGroupSenderName(group.trigger),
            MAX_MESSAGES_PER_PROMPT,
          );

          // If allPending is empty, the agent has already processed all
          // messages up to (or past) this point — skip piping to avoid
          // re-sending already-processed messages and rolling the cursor back.
          if (allPending.length === 0) continue;

          const formatted = formatMessages(allPending, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: allPending.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              allPending[allPending.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }

      // Check for DM messages from external contacts (only if TaskFlow is active)
      const taskflowDb = getTaskflowDb(DATA_DIR);
      if (taskflowDb) {
        const dmMessages = getDmMessages(lastDmTimestamp, ASSISTANT_NAME);
        if (dmMessages.length > 0) {
          // Cache route lookups by JID to avoid redundant DB queries for same sender
          const routeCache = new Map<
            string,
            ReturnType<typeof resolveExternalDm>
          >();
          let safeDmCursor = lastDmTimestamp;
          let hitStagedDm = false;
          for (const msg of dmMessages) {
            let route = routeCache.get(msg.chat_jid);
            if (route === undefined) {
              route = resolveExternalDm(taskflowDb, msg.chat_jid);
              routeCache.set(msg.chat_jid, route);
            }
            if (!route) {
              if (!hitStagedDm) safeDmCursor = msg.timestamp;
              continue;
            }

            if (route.needsDisambiguation) {
              // More than one active grant: send disambiguation prompt via DM
              const meetingList = route.grants
                .map((g) => g.meetingTaskId)
                .join(', ');
              const channel = findChannel(channels, msg.chat_jid);
              if (channel) {
                channel.sendMessage(
                  msg.chat_jid,
                  `Você participa de várias reuniões (${meetingList}). Inclua o ID da reunião no comando, ex: "pauta M1".`,
                );
              }
              if (!hitStagedDm) safeDmCursor = msg.timestamp;
              continue;
            }

            const groupJid = route.groupJid;
            const group = registeredGroups[groupJid];
            if (!group) {
              if (!hitStagedDm) safeDmCursor = msg.timestamp;
              logger.warn(
                { dmJid: msg.chat_jid, groupJid },
                'DM route target group not registered',
              );
              continue;
            }

            // Format as external participant message with metadata
            const formatted = formatMessages([msg], TIMEZONE);
            const externalContext = `[External participant: ${route.displayName} (${route.externalId}), active grants: ${route.grants.map((g) => g.meetingTaskId).join(', ')}]\n${formatted}`;

            // Try piping to active container first.
            if (queue.sendMessage(groupJid, externalContext)) {
              if (!hitStagedDm) safeDmCursor = msg.timestamp;
              logger.info(
                { dmJid: msg.chat_jid, groupJid },
                'DM piped to active container',
              );
            } else {
              // No active container — stage prompt and enqueue for trigger-bypassed processing
              const staged = pendingExternalDmPrompts.get(groupJid) ?? [];
              staged.push({
                timestamp: msg.timestamp,
                prompt: externalContext,
              });
              pendingExternalDmPrompts.set(groupJid, staged);
              hitStagedDm = true;
              if (msg.timestamp > stagedDmMaxTimestamp) {
                stagedDmMaxTimestamp = msg.timestamp;
              }
              queue.enqueueMessageCheck(groupJid);
              logger.info(
                { dmJid: msg.chat_jid, groupJid },
                'DM staged for trigger-bypassed processing and enqueued',
              );
            }
            // Track max timestamp of ALL messages after a staged DM,
            // not just staged ones — prevents re-delivery of piped DMs
            if (hitStagedDm && msg.timestamp > stagedDmMaxTimestamp) {
              stagedDmMaxTimestamp = msg.timestamp;
            }
          }
          // Advance DM cursor to the last safely-processed message.
          // Don't advance past staged DMs (in-memory only — lost on restart).
          if (safeDmCursor !== lastDmTimestamp) {
            lastDmTimestamp = safeDmCursor;
            saveState();
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      getGroupSenderName(group.trigger),
      MAX_MESSAGES_PER_PROMPT,
    );
    // Apply the same noise filter used in the message loop so that
    // stale processing indicators / typing markers don't trigger a
    // spurious container start on restart.
    const substantive = pending.filter((msg) => {
      const text = msg.content.trim();
      if (!text) return false;
      if (NOISE_VOICE_PROCESSING.test(text)) return false;
      if (NOISE_TYPING_INDICATOR.test(text)) return false;
      return true;
    });
    if (substantive.length > 0) {
      logger.info(
        { group: group.name, pendingCount: substantive.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  // Apply pending TaskFlow schema migrations before containers open the DB.
  try {
    const { initTaskflowDb } = await import('./taskflow-db.js');
    initTaskflowDb().close();
    logger.info('TaskFlow DB schema checked');
  } catch (err) {
    logger.warn({ err }, 'TaskFlow DB schema init skipped');
  }
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // --- Shared env for embeddings + long-term context (single .env parse) ---
  const { readEnvFile: readEnv } = await import('./env.js');
  const skillEnv = readEnv([
    'OLLAMA_HOST',
    'EMBEDDING_MODEL',
    'ANTHROPIC_API_KEY',
    'CONTEXT_SUMMARIZER',
    'CONTEXT_SUMMARIZER_MODEL',
    'CONTEXT_OLLAMA_HOST',
    'CONTEXT_FALLBACK_MODEL',
    'CONTEXT_FALLBACK_OLLAMA_HOST',
    'CONTEXT_RETAIN_DAYS',
  ]);

  // --- add-embeddings skill: generic embedding service ---
  let embeddingService:
    | import('./embedding-service.js').EmbeddingService
    | null = null;
  if (skillEnv.OLLAMA_HOST) {
    const { EmbeddingService } = await import('./embedding-service.js');
    embeddingService = new EmbeddingService(
      path.join(DATA_DIR, 'embeddings', 'embeddings.db'),
      skillEnv.OLLAMA_HOST,
      skillEnv.EMBEDDING_MODEL || 'bge-m3',
      skillEnv.CONTEXT_FALLBACK_OLLAMA_HOST,
    );
    embeddingService.startIndexer();
    logger.info(
      { ollamaHost: skillEnv.OLLAMA_HOST, model: skillEnv.EMBEDDING_MODEL },
      'Embedding service started',
    );
  }

  // --- add-taskflow skill: embedding sync adapter ---
  let embeddingSyncTimer: ReturnType<typeof setInterval> | null = null;
  if (embeddingService) {
    const { startTaskflowEmbeddingSync } =
      await import('./taskflow-embedding-sync.js');
    embeddingSyncTimer = startTaskflowEmbeddingSync(
      embeddingService,
      getTaskflowDb(DATA_DIR),
    );
  }

  // --- add-long-term-context skill ---
  let contextSyncTimer: ReturnType<typeof setInterval> | null = null;
  let contextService: import('./context-service.js').ContextService | null =
    null;
  {
    const { ContextService } = await import('./context-service.js');
    const { startContextSync } = await import('./context-sync.js');
    const { setContextService } = await import('./container-runner.js');

    contextService = new ContextService(
      path.join(DATA_DIR, 'context', 'context.db'),
      {
        summarizer:
          (skillEnv.CONTEXT_SUMMARIZER as 'ollama' | 'claude') || 'ollama',
        summarizerModel: skillEnv.CONTEXT_SUMMARIZER_MODEL,
        fallbackModel: skillEnv.CONTEXT_FALLBACK_MODEL,
        ollamaHost: skillEnv.CONTEXT_OLLAMA_HOST || skillEnv.OLLAMA_HOST,
        fallbackOllamaHost: skillEnv.CONTEXT_FALLBACK_OLLAMA_HOST,
        anthropicApiKey: skillEnv.ANTHROPIC_API_KEY,
        retainDays: parseInt(skillEnv.CONTEXT_RETAIN_DAYS || '90'),
      },
    );
    setContextService(contextService);
    contextSyncTimer = startContextSync(contextService);
    logger.info('Long-term context service started');
  }

  // Start credential proxy
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers (after proxy so proxyServer is in scope)
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');
    try {
      if (contextSyncTimer) {
        clearInterval(contextSyncTimer);
        clearTimeout((contextSyncTimer as any).__initialTimeout); // clear the 5s initial delay too
      }
      if (embeddingSyncTimer) clearInterval(embeddingSyncTimer); // add-taskflow
      embeddingService?.close(); // add-embeddings
      await queue.shutdown(10000); // drain active containers — their close hooks may still capture turns
      // Close context service AFTER queue drain so capture hooks complete first
      if (contextService) {
        try {
          const { setContextService } = await import('./container-runner.js');
          setContextService(null);
        } catch {}
        contextService.close();
      }
      for (const ch of channels) await ch.disconnect();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    }
    proxyServer.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels from registry
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing, skipping',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
    logger.info({ channel: channelName }, 'Channel connected');
  }
  if (channels.length === 0) {
    throw new Error(
      'No channels connected — at least one channel must be configured',
    );
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  await startIpcWatcher({
    sendMessage: (jid, text, sender) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text, sender);
    },
    clearTyping: async (jid) => {
      const channel = findChannel(channels, jid);
      await channel?.setTyping?.(jid, false);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels.map((ch) => ch.syncGroups?.(force)).filter(Boolean),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    createGroup: (subject, participants) => {
      const ch = channels.find((c) => c.createGroup);
      if (!ch?.createGroup)
        throw new Error('No channel supports group creation');
      return ch.createGroup(subject, participants);
    },
    resolvePhoneJid: (phone) => {
      const ch = channels.find((c) => c.resolvePhoneJid);
      if (!ch?.resolvePhoneJid)
        throw new Error('No channel supports phone JID resolution');
      return ch.resolvePhoneJid(phone);
    },
    lookupPhoneJid: (phone) => {
      const ch = channels.find((c) => c.lookupPhoneJid);
      if (!ch?.lookupPhoneJid)
        throw new Error('No channel supports strict phone JID lookup');
      return ch.lookupPhoneJid(phone);
    },
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
