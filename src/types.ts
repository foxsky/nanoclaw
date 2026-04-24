/**
 * Where an IPC `send_message` ended up. `'group'` is a registered group
 * JID; `'dm'` is an external contact DM. Shared by the IPC authorization
 * result in src/ipc.ts and by `send_message_log.target_kind` in src/db.ts.
 */
export type SendTargetKind = 'group' | 'dm';

export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  taskflowManaged?: boolean; // Set for groups provisioned by the TaskFlow skill
  taskflowHierarchyLevel?: number; // 0-based depth in the TaskFlow hierarchy
  taskflowMaxDepth?: number; // Inclusive maximum depth allowed for descendants
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

export interface TriggerMessageContext {
  messageId: string;
  chatJid: string;
  sender: string;
  senderName: string;
  timestamp: string;
}

// A turn can carry multiple inbound messages; each ref has the same shape
// as TriggerMessageContext (a turn's "trigger" is just one of its messages).
export type AgentTurnMessageRef = TriggerMessageContext;

export interface AgentTurnContext {
  turnId: string;
}

export interface SentMessageReceipt {
  messageId: string;
  timestamp?: string | null;
}

export interface SendMessageContext {
  outboundMessageId?: number;
}

export const SCHEDULE_TYPES = ['cron', 'interval', 'once'] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: ScheduleType;
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  trigger_message_id?: string | null;
  trigger_chat_jid?: string | null;
  trigger_sender?: string | null;
  trigger_sender_name?: string | null;
  trigger_message_timestamp?: string | null;
  trigger_turn_id?: string | null;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, sender?: string): Promise<void>;
  sendMessageWithReceipt?(
    jid: string,
    text: string,
    sender?: string,
    context?: SendMessageContext,
  ): Promise<SentMessageReceipt | void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: group creation. Channels that support it implement it.
  createGroup?(
    subject: string,
    participants: string[],
  ): Promise<{
    jid: string;
    subject: string;
    inviteLink?: string;
    droppedParticipants?: string[];
  }>;
  // Optional: resolve a phone number to a JID. Channels that support it implement it.
  resolvePhoneJid?(phone: string): Promise<string>;
  // Optional: resolve only existing WhatsApp numbers to a JID.
  lookupPhoneJid?(phone: string): Promise<string | null>;
  // Optional: sync groups from the channel. Channels that support it implement it.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (WhatsApp syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
