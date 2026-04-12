import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock config before importing the channel module.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>(
    '../config.js',
  );
  return {
    ...actual,
    ASSISTANT_NAME: 'Andy',
    // Global trigger pattern is @Andy; groups can override (e.g. @Case).
    TRIGGER_PATTERN: /^@Andy\b/i,
    DEFAULT_TRIGGER: '@Andy',
  };
});

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Stub grammy so we don't start a real bot.
vi.mock('grammy', () => {
  class FakeBot {
    private handlers: Record<string, (ctx: any) => any> = {};
    public api = { sendMessage: vi.fn() };
    constructor(_token: string, _opts?: unknown) {}
    command(_name: string, _fn: (ctx: any) => any) {}
    on(event: string, fn: (ctx: any) => any) {
      this.handlers[event] = fn;
    }
    catch(_fn: (err: any) => void) {}
    start(opts: { onStart: (info: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 42 });
      return Promise.resolve();
    }
    stop() {}
    // expose for tests
    _emit(event: string, ctx: any) {
      const h = this.handlers[event];
      if (!h) throw new Error(`No handler registered for ${event}`);
      return h(ctx);
    }
  }
  return { Bot: FakeBot, Api: class {} };
});

import { TelegramChannel } from './telegram.js';

function makeTextCtx(overrides: Partial<{
  chatId: number;
  text: string;
  mentionUsername: string | null;
  botUsername: string;
}> = {}) {
  const chatId = overrides.chatId ?? -100123;
  const text = overrides.text ?? 'hello';
  const botUsername = overrides.botUsername ?? 'andy_ai_bot';
  const entities: any[] = [];
  if (overrides.mentionUsername !== null) {
    const mention = `@${overrides.mentionUsername ?? botUsername}`;
    const offset = text.indexOf(mention);
    if (offset >= 0) {
      entities.push({ type: 'mention', offset, length: mention.length });
    }
  }
  return {
    chat: { id: chatId, type: 'supergroup', title: 'Test Group' },
    from: { id: 777, first_name: 'Alice', username: 'alice' },
    me: { username: botUsername },
    message: {
      text,
      date: Math.floor(Date.now() / 1000),
      message_id: 9001,
      entities,
    },
  };
}

describe('TelegramChannel @mention translation', () => {
  let onMessage: ReturnType<typeof vi.fn>;
  let onChatMetadata: ReturnType<typeof vi.fn>;
  let channel: TelegramChannel;
  let bot: any;

  beforeEach(async () => {
    onMessage = vi.fn();
    onChatMetadata = vi.fn();
  });

  async function setup(groups: Record<string, any>) {
    channel = new TelegramChannel('fake-token', {
      onMessage: onMessage as any,
      onChatMetadata: onChatMetadata as any,
      registeredGroups: () => groups,
    });
    await channel.connect();
    // Grab the fake bot via the channel's private field.
    bot = (channel as any).bot;
  }

  it('prepends default trigger (@Andy) when group uses default', async () => {
    const chatJid = 'tg:-100123';
    await setup({
      [chatJid]: {
        name: 'Default Group',
        folder: 'default',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    await bot._emit(
      'message:text',
      makeTextCtx({ chatId: -100123, text: '@andy_ai_bot help me' }),
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    const [, newMsg] = onMessage.mock.calls[0];
    expect(newMsg.content).toBe('@Andy @andy_ai_bot help me');
  });

  it('prepends the GROUP trigger (@Case) when group overrides default', async () => {
    // Regression: previously, the handler always used the global ASSISTANT_NAME
    // ("@Andy"), even for TaskFlow groups whose registered trigger is "@Case".
    // The orchestrator then checked the message against ^@Case\b and rejected it,
    // so @mentioning the bot silently did nothing in those groups.
    const chatJid = 'tg:-200456';
    await setup({
      [chatJid]: {
        name: 'Case Group',
        folder: 'case-group',
        trigger: '@Case',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    await bot._emit(
      'message:text',
      makeTextCtx({ chatId: -200456, text: '@andy_ai_bot schedule standup' }),
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    const [, newMsg] = onMessage.mock.calls[0];
    expect(newMsg.content).toBe('@Case @andy_ai_bot schedule standup');
  });

  it('does not prepend when content already starts with group trigger', async () => {
    const chatJid = 'tg:-200456';
    await setup({
      [chatJid]: {
        name: 'Case Group',
        folder: 'case-group',
        trigger: '@Case',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    await bot._emit(
      'message:text',
      makeTextCtx({
        chatId: -200456,
        text: '@Case ping',
        mentionUsername: null,
      }),
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    const [, newMsg] = onMessage.mock.calls[0];
    expect(newMsg.content).toBe('@Case ping');
  });
});
