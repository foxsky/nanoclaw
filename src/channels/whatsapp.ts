import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  DATA_DIR,
  STORE_DIR,
} from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { processImage } from '../image.js';
import { logger } from '../logger.js';
import { transcribeAudioMessage } from '../transcription.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CONNECT_TIMEOUT_MS = 30_000; // 30s — reject if socket never opens
const TRANSPORT_ERROR_RE =
  /connection|socket|timed?\s*out|ECONNR|EPIPE|stream/i;

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private reconnecting = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private static readonly QUEUE_PATH = path.join(
    DATA_DIR,
    'whatsapp-outgoing-queue.json',
  );

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
    this.loadQueue();
  }

  /** Load persisted outgoing queue from disk (survives restarts). */
  private loadQueue(): void {
    try {
      const data = fs.readFileSync(WhatsAppChannel.QUEUE_PATH, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.outgoingQueue = parsed;
        if (parsed.length > 0) {
          logger.info(
            { count: parsed.length },
            'Restored outgoing queue from disk',
          );
        }
      }
    } catch {
      // File doesn't exist or is invalid — start empty
    }
  }

  /** Persist outgoing queue to disk. */
  private saveQueue(): void {
    try {
      fs.writeFileSync(
        WhatsAppChannel.QUEUE_PATH,
        JSON.stringify(this.outgoingQueue),
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to persist outgoing queue');
    }
  }

  async connect(): Promise<void> {
    // Retry initial connection with backoff — transient failures at startup
    // (e.g. network not ready) should not abort the process.
    for (let i = 1; i <= 5; i++) {
      try {
        await this.connectInternal();
        break;
      } catch (err) {
        if (i === 5) throw err;
        const delay = Math.min(5000 * Math.pow(2, i - 1), 60000);
        logger.warn(
          { err, attempt: i, retryInMs: delay },
          'Initial connection failed, retrying',
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Safety net: periodically check connection health.
    // If WA is disconnected and no reconnect is in progress, trigger one.
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = setInterval(() => {
      if (!this.connected && !this.reconnecting) {
        logger.warn(
          'Health check: WA disconnected with no active reconnect — triggering recovery',
        );
        this.reconnect();
      }
    }, 120_000); // check every 2 minutes
  }

  private async connectInternal(): Promise<void> {
    // Tear down old socket before creating a new one to prevent
    // stacked event listeners from firing on the old emitter
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        /* ignore */
      }
    }

    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    // Register credential and message handlers before waiting for connection
    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
          // editedMessage, etc.) so that conversation, extendedTextMessage,
          // imageMessage, etc. are accessible at the top level.
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          // Translate LID JID to phone JID if applicable
          const chatJid = await this.translateJid(rawJid);

          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();

          // Always notify about chat metadata for group discovery
          const isGroup = chatJid.endsWith('@g.us');
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          // Deliver full message for registered groups and DM chats.
          // DMs (non-group) must also be stored so getDmMessages() can
          // find inbound messages from external meeting participants.
          const groups = this.opts.registeredGroups();
          const isDm = !isGroup;
          if (groups[chatJid] || isDm) {
            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // Image attachment: download, resize, save to group workspace
            if (normalized.imageMessage && groups[chatJid]) {
              try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const groupDir = resolveGroupFolderPath(groups[chatJid].folder);
                const caption = normalized.imageMessage?.caption ?? '';
                const result = await processImage(
                  buffer as Buffer,
                  groupDir,
                  caption,
                );
                if (result) {
                  content = result.content;
                }
              } catch (err) {
                logger.warn({ err, jid: chatJid }, 'Image download failed');
              }
            }

            // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
            // but allow voice messages through for transcription.
            // Check normalized content for ptt since the raw msg.message may
            // wrap audioMessage inside ephemeralMessage/viewOnceMessage.
            const isVoice = normalized.audioMessage?.ptt === true;
            if (!content && !isVoice) continue;

            // Translate LID participant to phone JID for group messages.
            // In LID-mode groups, msg.key.participant is an @lid JID.
            const rawParticipant =
              msg.key.participant || msg.key.remoteJid || '';
            const sender = rawParticipant.endsWith('@lid')
              ? (msg.key as { participantAlt?: string }).participantAlt ||
                (await this.translateJid(rawParticipant))
              : rawParticipant;
            const senderName = msg.pushName || sender.split('@')[0];

            const fromMe = msg.key.fromMe || false;
            // Detect bot messages: with own number, fromMe is reliable
            // since only the bot sends from that number.
            // With shared number, bot messages carry the assistant name prefix
            // (even in DMs/self-chat) so we check for that.
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : content.startsWith(`${ASSISTANT_NAME}:`) ||
                Object.values(groups).some(
                  (g) =>
                    g.trigger &&
                    content.startsWith(`${g.trigger.replace(/^@/, '')}:`),
                );

            // Transcribe voice messages before storing
            let finalContent = content;
            if (isVoice) {
              try {
                const transcript = await transcribeAudioMessage(msg, this.sock);
                if (transcript) {
                  finalContent = `[Voice: ${transcript}]`;
                  logger.info(
                    { chatJid, length: transcript.length },
                    'Transcribed voice message',
                  );
                } else {
                  finalContent = '[Voice Message - transcription unavailable]';
                }
              } catch (err) {
                logger.error({ err }, 'Voice transcription error');
                finalContent = '[Voice Message - transcription failed]';
              }
            }

            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content: finalContent,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
            });
          }
        } catch (err) {
          logger.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Error processing incoming message',
          );
        }
      }
    });

    // Wait for the socket to actually open (or fail).
    // Previous code resolved immediately, causing the reconnect loop to exit
    // before the connection was established — leading to a permanent deadlock.
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let opened = false;

      // Timeout: if the socket never emits open or close, reject so the
      // reconnect loop can retry instead of hanging forever.
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(
            new Error('Connection timeout — socket did not open or close'),
          );
        }
      }, CONNECT_TIMEOUT_MS);

      this.sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          const msg =
            'WhatsApp authentication required. Run /setup in Claude Code.';
          logger.error(msg);
          exec(
            `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
          );
          setTimeout(() => process.exit(1), 1000);
        }

        if (connection === 'close') {
          this.connected = false;
          const reason = (
            lastDisconnect?.error as { output?: { statusCode?: number } }
          )?.output?.statusCode;
          const shouldReconnect = reason !== DisconnectReason.loggedOut;
          logger.info(
            {
              reason,
              shouldReconnect,
              queuedMessages: this.outgoingQueue.length,
            },
            'Connection closed',
          );

          if (!opened) {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            if (!shouldReconnect) {
              logger.info('Logged out. Run /setup to re-authenticate.');
              process.exit(78);
            }
            reject(
              new Error(`Connection closed before open (reason: ${reason})`),
            );
            return;
          }

          // Disconnected after being connected — trigger reconnection
          if (shouldReconnect) {
            this.reconnect();
          } else {
            logger.info('Logged out. Run /setup to re-authenticate.');
            process.exit(78); // EX_CONFIG — systemd RestartPreventExitStatus stops restart loop
          }
        } else if (connection === 'open') {
          // Ignore stale open from a timed-out socket or duplicate open events
          if (settled || opened) return;
          opened = true;
          this.connected = true;
          this.reconnecting = false;
          logger.info('Connected to WhatsApp');

          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }

          // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
          this.sock.sendPresenceUpdate('available').catch((err) => {
            logger.warn({ err }, 'Failed to send presence update');
          });

          // Build LID to phone mapping from auth state for self-chat translation
          if (this.sock.user) {
            const phoneUser = this.sock.user.id.split(':')[0];
            const lidUser = this.sock.user.lid?.split(':')[0];
            if (lidUser && phoneUser) {
              this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
              logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
            }
          }

          // Flush any messages queued while disconnected
          this.flushOutgoingQueue().catch((err) =>
            logger.error({ err }, 'Failed to flush outgoing queue'),
          );

          // Sync group metadata on startup (respects 24h cache)
          this.syncGroupMetadata().catch((err) =>
            logger.error({ err }, 'Initial group sync failed'),
          );
          // Set up daily sync timer (only once)
          if (!this.groupSyncTimerStarted) {
            this.groupSyncTimerStarted = true;
            setInterval(() => {
              this.syncGroupMetadata().catch((err) =>
                logger.error({ err }, 'Periodic group sync failed'),
              );
            }, GROUP_SYNC_INTERVAL_MS);
          }
        }
      });
    });
  }

  /**
   * Trigger reconnection with exponential backoff.
   * Never gives up — after initial burst of 5 fast retries, keeps
   * retrying every 2 minutes indefinitely until reconnected.
   */
  private reconnect(): void {
    if (this.reconnecting) {
      logger.warn('Reconnect already in progress, skipping duplicate');
      return;
    }
    this.reconnecting = true;
    logger.info('Reconnecting...');

    const attemptReconnect = async () => {
      let attempt = 0;
      while (!this.connected) {
        attempt++;
        try {
          await this.connectInternal();
          return; // success — connectInternal resolved on 'open', reconnecting cleared there
        } catch (err) {
          // First 5 attempts: exponential backoff 5s→60s
          // After that: fixed 2-minute intervals
          const delay =
            attempt <= 5
              ? Math.min(5000 * Math.pow(2, attempt - 1), 60000)
              : 120_000;
          logger.error(
            { err, attempt, retryInMs: delay },
            'Reconnection attempt failed',
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    };
    attemptReconnect()
      .catch((err) => {
        logger.error({ err }, 'Unexpected reconnection loop error');
      })
      .finally(() => {
        this.reconnecting = false;
      });
  }

  async sendMessage(jid: string, text: string, sender?: string): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const displayName = sender?.trim() || ASSISTANT_NAME;
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${displayName}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      this.saveQueue();
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      this.saveQueue();
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
      // Half-dead socket: sends fail but connection='close' never fires.
      // Only reconnect on transport errors — not application errors like
      // invalid JIDs or permission issues which would reconnect needlessly.
      const isTransportError =
        err instanceof Error && TRANSPORT_ERROR_RE.test(err.message);
      if (isTransportError && this.connected) {
        this.connected = false;
        this.reconnect();
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();
      const total = Object.keys(groups).length;

      if (total === 0) {
        logger.warn(
          'Group sync returned zero groups — skipping timestamp update to allow retry',
        );
        return;
      }

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count, total }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  async lookupPhoneJid(phone: string): Promise<string | null> {
    const normalizedPhone = phone.replace(/\D/g, '');
    const results = await this.sock.onWhatsApp(normalizedPhone);
    const existingJid = results?.find((result) => result.exists && result.jid)
      ?.jid;
    if (!existingJid) {
      return null;
    }
    // Normalize to @s.whatsapp.net — onWhatsApp may return @c.us (legacy)
    // or other suffixes. Strip any suffix and reconstruct.
    if (!existingJid.endsWith('@s.whatsapp.net')) {
      return existingJid.replace(/@.*$/, '') + '@s.whatsapp.net';
    }
    return existingJid;
  }

  async resolvePhoneJid(phone: string): Promise<string> {
    const jid = await this.lookupPhoneJid(phone);
    if (jid) {
      return jid;
    }
    // Fallback: use raw digits
    return phone.replace(/\D/g, '') + '@s.whatsapp.net';
  }

  async createGroup(
    subject: string,
    participants: string[],
  ): Promise<{
    jid: string;
    subject: string;
    inviteLink?: string;
    droppedParticipants?: string[];
  }> {
    if (participants.length > 1023) {
      throw new Error(
        `Too many participants (${participants.length}): WhatsApp limit is 1024 including creator`,
      );
    }
    const result = await this.sock.groupCreate(subject, participants);
    if (!result?.id) {
      throw new Error(`groupCreate returned no result for "${subject}"`);
    }
    const groupJid = result.id;

    // Verify participants were added; if not, retry with groupParticipantsUpdate
    // If socket disconnected between groupCreate and verify, skip verify and
    // treat all participants as dropped (invite link is the fallback).
    let allAdded = true;
    let droppedParticipants: string[] = [];
    if (!this.connected) {
      logger.warn(
        { groupJid },
        'Socket disconnected after groupCreate — skipping verify, generating invite link',
      );
      allAdded = false;
      droppedParticipants = [...participants];
    }
    if (allAdded)
      try {
        // Brief delay to let WhatsApp propagate participant additions
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const meta = await this.sock.groupMetadata(groupJid);
        // Expected members: requested participants + the bot itself
        const expectedCount = participants.length + 1;

        // First check: does the member count match?
        // WhatsApp may return LID JIDs that we can't translate back to phone
        // JIDs, causing false "missing" detections. If the count matches,
        // all participants were added — skip JID-level verification.
        if (meta.participants.length >= expectedCount) {
          logger.info(
            {
              groupJid,
              expected: expectedCount,
              actual: meta.participants.length,
            },
            'Group participant count matches — all added',
          );
        } else {
          // Count doesn't match — build member set using all available JID formats
          const memberIds = new Set<string>();
          for (const p of meta.participants) {
            memberIds.add(p.id);
            // Use phoneNumber from metadata if available (Baileys exposes it)
            if ((p as any).phoneNumber) {
              memberIds.add(`${(p as any).phoneNumber}@s.whatsapp.net`);
            }
            // Use lid field if available
            if ((p as any).lid) {
              memberIds.add((p as any).lid);
            }
            if (p.id.endsWith('@lid')) {
              const phoneJid = await this.translateJid(p.id);
              if (phoneJid !== p.id) memberIds.add(phoneJid);
            }
          }
          const missing = participants.filter((p) => !memberIds.has(p));
          if (missing.length > 0) {
            logger.info(
              { groupJid, missing },
              'Participants not added at creation, retrying',
            );
            try {
              await this.sock.groupParticipantsUpdate(groupJid, missing, 'add');
            } catch (retryErr) {
              allAdded = false;
              droppedParticipants = missing;
              logger.warn(
                { err: retryErr, groupJid, missing },
                'Failed to add missing participants',
              );
            }
            // Re-verify by count after retry
            if (allAdded) {
              try {
                const meta2 = await this.sock.groupMetadata(groupJid);
                if (meta2.participants.length < expectedCount) {
                  allAdded = false;
                  droppedParticipants = missing;
                  logger.warn(
                    {
                      groupJid,
                      expected: expectedCount,
                      actual: meta2.participants.length,
                    },
                    'Participants still missing after retry (count mismatch)',
                  );
                }
              } catch {
                allAdded = false;
                droppedParticipants = missing;
                logger.warn(
                  { groupJid, missing },
                  'Could not re-verify participants after retry',
                );
              }
            }
          }
        }
      } catch (err) {
        allAdded = false;
        logger.warn({ err, groupJid }, 'Failed to verify group participants');
      }

    // Generate invite link only when participants couldn't be added
    let inviteLink: string | undefined;
    if (!allAdded && this.connected) {
      try {
        const code = await this.sock.groupInviteCode(groupJid);
        inviteLink = `https://chat.whatsapp.com/${code}`;
      } catch (err) {
        logger.warn({ err, groupJid }, 'Failed to generate invite link');
      }
    } else if (!allAdded) {
      logger.warn(
        { groupJid },
        'Cannot generate invite link — socket disconnected',
      );
    }

    return {
      jid: groupJid,
      subject: result.subject,
      inviteLink,
      droppedParticipants:
        droppedParticipants.length > 0 ? droppedParticipants : undefined,
    };
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        try {
          await this.sock.sendMessage(item.jid, { text: item.text });
          this.saveQueue();
          logger.info(
            { jid: item.jid, length: item.text.length },
            'Queued message sent',
          );
        } catch (err) {
          this.outgoingQueue.unshift(item);
          this.saveQueue();
          logger.warn(
            { jid: item.jid, err, queueSize: this.outgoingQueue.length },
            'Failed to send queued message, will retry on reconnect',
          );
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => {
  const authDir = path.join(STORE_DIR, 'auth');
  if (!fs.existsSync(path.join(authDir, 'creds.json'))) {
    logger.warn(
      'WhatsApp: credentials not found. Run /add-whatsapp to authenticate.',
    );
    return null;
  }
  return new WhatsAppChannel(opts);
});
